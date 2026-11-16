(function (global) {
    'use strict';
    // 子 Agent 池：**纯逻辑** —— 状态机 + 并发闸 + 保活回收 + 停止语义。

    //
    // 为什么单独成文件、依赖全部注入：池是「谁在跑、谁在排队、还能追问多久」的**唯一判据源**
    //（状态/并发数/工具集都只能有一个判据源）。只有能被直驱才可验证——时钟（now）、
    // 跑一轮（runTurn）、状态回调（onStateChange）、abort 工厂（createAbort）全当参数传进来，
    // 单测就能用假 runTurn 的 resolve 边沿逐跳断言；反过来，这里一旦碰 DOM / 定时器 / 全局单例，
    // 状态机就只能靠真机复现，「保活过期没回收」「stopped 被迟到的结果掀回去」这类缺陷在单测里
    // 也就看不见了。
    //
    // 分工（谁也别越界）：
    //   · 本文件：记录表、状态迁移、并发闸、保活回收、停止语义、快照行（list 行形状的唯一一份）；
    //   · 运行器：runTurn 的真正执行（模型循环 / AE 队列 / 产出落盘）与 tokens 的写入；
    //   · UI：onStateChange 里刷新卡片与任务板（本文件不碰 DOM、不知道卡片长什么样）。
    //
    // opts 契约（缺项回落缺省；结构性缺项**显式失败**，不猜）：
    //   maxConcurrent  并发名额（缺省 3；0 ⇒ spawn 显式失败 limit_zero，**不排队**）
    //   keepAliveMs    保活窗口（缺省 600000；0 ⇒ 跑完直接 done，不产生 waiting）
    //   maxLoops       轮数上限（缺省 30；池只**透传** ctx.maxLoops 给运行器，自己不用它跑循环）
    //   三个闸都能在**运行期**经公开口 setLimits 改值（复核修：池是模块级单例，设置只在首次装配时
    //   进池 ⇒ 改了 team.subagent 不生效、重挂也不生效，只能整页重载）。口径见 setLimits 的注释：
    //   只影响之后起跑/回收的轮次，已在跑的不打断、已在 waiting 的不追溯改写。
    //   now            () => ms（注入时钟；缺省系统钟——单测注入固定钟才能精确断言耗时/保活）
    //   runTurn        (ctx) => Promise<{ ok:true, summary, tokens? } | { ok:false, reason, message, tokens? }>
    //   onStateChange  (snapshot) => void（缺省 no-op；**每次状态变化后**调用）
    //   createAbort    () => { signal, abort() }（可选；缺省用环境 AbortController，都没有时用最小句柄）
    //
    // 不变量：id 单调自增、**不重复使用**（clear() 也不重置序号）；stopped 是终态，迟到的 runTurn
    //         结果不得回退它；定时器一个都没有——保活回收只挂在 releaseExpired()（调用点：list()/ask()）上；
    //         并发判据**只有一条**「running 数 < 名额」，spawn 与 ask 共用它：满额一律显式排队，
    //         谁都不得绕开（ask 曾无条件 _startTurn ⇒ 面板追问一次就把 running 顶过 limit）。

    // state 取值即契约：queued 已排队未起跑 / running 正在跑 / waiting 跑完且保活窗口内可追问 /
    // done 生命周期正常结束（含保活到期回收）/ failed 运行器报错 / stopped 被停止语义终止。
    var ST = {
        QUEUED: 'queued',
        RUNNING: 'running',
        WAITING: 'waiting',
        DONE: 'done',
        FAILED: 'failed',
        STOPPED: 'stopped'
    };

    // 终态集合：这三个状态不再迁移、不回退、不复活（stopped 是终态）。
    var TERMINAL = { done: 1, failed: 1, stopped: 1 };

    var DEF = { maxConcurrent: 3, keepAliveMs: 600000, maxLoops: 30 };

    // 层深：**派生值，不是常量**。无父（根层，今天唯一可达的一层）⇒ ROOT_DEPTH；给了 parentId 且
    // 父记录在册 ⇒ 父.depth + 1。恒取 DEF.depth 会让从子 Agent 内部再派生也报 depth:1，
    // 「一层边界」只剩「工具名剔除」单点支撑，深度上完全不可观测。
    // 注意：深度**不是**安全边界（边界由剔除名单守），故父 id 对不上时退回根层而不失败。
    var ROOT_DEPTH = 1;

    function _fail(reason, message) { return { ok: false, reason: reason, message: message }; }

    // 数值归一：非数字/NaN/∞ 一律回落缺省；越下界夹到下界（不是回落缺省）——
    // 并发闸用得着这条：-1 夹成 0 会让 spawn 显式 limit_zero（最安全的失败面），
    // 而"回落到 3"会把一个配置错误悄悄变成"照样跑 3 个"。
    function _num(v, dft, min) {
        if (typeof v !== 'number' || !isFinite(v)) return dft;
        var n = Math.floor(v);
        return n < min ? min : n;
    }

    function createSubagentPool(opts) {
        var d = opts || {};
        var limit = _num(d.maxConcurrent, DEF.maxConcurrent, 0);
        var keepAliveMs = _num(d.keepAliveMs, DEF.keepAliveMs, 0);
        var maxLoops = _num(d.maxLoops, DEF.maxLoops, 1);
        var runTurn = (typeof d.runTurn === 'function') ? d.runTurn : null;
        var onChange = (typeof d.onStateChange === 'function') ? d.onStateChange : null;

        var recs = [];        // 记录表（内存；面板重载即清空——不做会话持久化，不假装恢复）
        var seq = 0;          // id 自增序号：**只增不减、不重复使用**（clear() 也不重置）
        var qseq = 0;         // 入队序号：排队次序的判据（见 _drain——表内位置不等于入队时刻）
        var notifying = false;   // 通知重入闸：回调里再触发的状态变化不产生嵌套通知（防回调风暴）

        // ── 时钟 / abort ───────────────────────────────────────────────
        function _nowMs() {
            if (typeof d.now === 'function') {
                try {
                    var v = d.now();
                    if (typeof v === 'number' && isFinite(v)) return v;
                } catch (_) { /* 时钟抛错 → 回落系统钟（接错时钟不该让整条子 Agent 链失败） */ }
            }
            return Date.now();
        }

        // abort 句柄：优先注入的 createAbort（单测/宿主可控），其次环境的 AbortController，
        // 都没有时用**等价的最小句柄**——子 Agent 的 abort 不该因为宿主缺一个构造器就整个不可用。
        // 惰性解析（每次 spawn 取一次）：环境里 AbortController 缺席时能如实回落到最小句柄。
        function _newAbort() {
            var h = null;
            try {
                if (typeof d.createAbort === 'function') h = d.createAbort();
                else if (global && typeof global.AbortController === 'function') h = new global.AbortController();
            } catch (_) { h = null; }
            if (h && h.signal && typeof h.abort === 'function') return h;
            var sig = { aborted: false };
            return {
                signal: sig,
                abort: function () { sig.aborted = true; }
            };
        }

        function _abort(rec) {
            var h = rec.abortHandle;
            if (!h || typeof h.abort !== 'function') return;
            // abort 句柄自己抛错不阻断停止语义：状态才是判据（真 AbortController 由 abort() 自己翻 signal）
            try { h.abort(); } catch (_) { /* 见上 */ }
        }

        // ── 记录表读 ───────────────────────────────────────────────────
        function _find(id) {
            for (var i = 0; i < recs.length; i++) if (recs[i].id === id) return recs[i];
            return null;
        }

        function _count(state) {
            var n = 0;
            for (var i = 0; i < recs.length; i++) if (recs[i].state === state) n++;
            return n;
        }

        // 耗时口径：**累计运行耗时**（不含排队等待与保活等待）。running 时用注入钟实时累加，
        // 跑完/停掉就冻结在那一刻——"跑了多久"与"闲了多久"是两件事，混在一起会让任务板上的
        // 耗时在保活窗口里一直涨，用户以为它还在干活。
        function _elapsed(rec, t) {
            var ms = rec.totalMs;
            if (rec.state === ST.RUNNING && rec.turnStart) {
                var live = t - rec.turnStart;
                if (live > 0) ms += live;
            }
            return ms > 0 ? ms : 0;
        }

        // list 行（契约字段 + turns/summary/wait/error）：
        // 每次返回**新对象**——渲染侧误改一个字段不该改到状态机的表里。
        // tokens 原样带出（池只存不改：运行器写 { prompt, completion } 或总数都行）。
        // error：失败的记录若只有内部 rec.error 有原因、行里读不到 ⇒ 回投正文只能给
        // 「（这一轮没有产出结论）」。形状 { reason, message }，非失败恒为 null（不编造失败原因）。
        function _rows(t) {
            var out = [];
            for (var i = 0; i < recs.length; i++) {
                var r = recs[i];
                out.push({
                    id: r.id,
                    title: r.title,
                    parentLane: r.parentLane,
                    state: r.state,
                    elapsedMs: _elapsed(r, t),
                    tokens: r.tokens,
                    depth: r.depth,
                    // 完成回投与「子 Agent 会话」面板要用这几项——
                    //   turns   —— 第几轮（追问会再跑一轮：完成回投按 id|turns 去重）；
                    //   summary —— 该轮结论（异步派遣不必等回执即可拿到）；
                    //   wait    —— 这条是**阻塞调用**派出去的（结论已经在回执里 ⇒ 完成回投跳过它，
                    //              不再投一次卡片 + 白唤醒一轮）。
                    turns: r.turns || 0,
                    summary: (typeof r.summary === 'string') ? r.summary : '',
                    error: r.error || null,
                    wait: r.wait === true,
                    // 当前轮追问的来源（agent / user）：**从 ctx.askOrigin 现派生**（唯一存储点），
                    // 回投与调试都读它（见 bootstrap._deliverSubagentResult）。
                    turnOrigin: (r.ctx && r.ctx.askOrigin === 'user') ? 'user' : 'agent'
                });
            }
            return out;
        }

        function _stats() {
            // total = 池内记录总数（含终态）：与 list() 行数同源——任务板显示多少行就是多少，
            // 两处各算一份必然漂移（「谁在跑」的判据只留一个来源的同一条理由）。
            return {
                running: _count(ST.RUNNING),
                waiting: _count(ST.WAITING),
                total: recs.length,
                limit: limit
            };
        }

        // ── 状态迁移与通知 ─────────────────────────────────────────────
        function _snapshot(rec) {
            // 快照供 UI/任务板一次刷新到位：谁变了（id/state）+ 全量行 + 计数。
            // 这里**不做保活回收**（回收只在 list()/ask() 的懒触发点上）：否则回调里读一次快照
            // 又会推进状态、又发一次通知，通知风暴就是这么来的。
            return {
                id: rec.id,
                state: rec.state,
                subagents: _rows(_nowMs()),
                stats: _stats()
            };
        }

        function _notify(rec) {
            if (!onChange || notifying) return;
            notifying = true;
            try {
                onChange(_snapshot(rec));
            } catch (e) {
                // 回调是 UI 刷新，抛错不该让状态机失败；但也不静默——照本仓习惯留一行 warn
                if (typeof console !== 'undefined' && console && typeof console.warn === 'function') {
                    console.warn('[team/subagent] onStateChange 回调抛错（状态机已继续）：'
                        + String((e && e.message) || e));
                }
            }
            notifying = false;
        }

        function _setState(rec, next, t) {
            if (rec.state === next) return false;
            rec.state = next;
            rec.updatedAt = t;
            _notify(rec);
            return true;
        }

        // ── 一轮的执行 ─────────────────────────────────────────────────
        function _waitTurn(rec) {
            return new Promise(function (resolve) { rec.waiters.push(resolve); });
        }

        function _flushWaiters(rec, result) {
            var ws = rec.waiters;
            rec.waiters = [];
            for (var i = 0; i < ws.length; i++) {
                try { ws[i](result); } catch (_) { /* 调用方回调错不该影响状态机 */ }
            }
        }

        function _stoppedResult(rec) {
            return {
                ok: false,
                id: rec.id,
                state: ST.STOPPED,
                reason: ST.STOPPED,
                message: '子 Agent ' + rec.id + ' 已被停止（stopped 是终态，不会复活）。'
            };
        }

        function _startTurn(rec, t) {
            rec.turnStart = t;
            // 这一轮的保活窗口在**起跑时**快照进记录（与 maxLoops 进 ctx 同一时刻、同一口径：一轮的
            // 判据由它起跑那一刻的设置决定）⇒ setLimits 改 keepAliveMs 只影响之后起跑的轮次，
            // 正在跑的那一轮不被追溯改写（"已在跑的不打断"逐字落地）。
            rec.turnKeepAliveMs = keepAliveMs;
            // 轮次计数：完成回投的去重键要用它——追问会让同一个 id 再次进入 waiting，
            // 只按 id 去重会把追问的结论吞掉。计数在**起跑**时加：一次起跑恰好对应一次完成。
            rec.turns = (rec.turns || 0) + 1;
            _setState(rec, ST.RUNNING, t);
            var p = null;
            try {
                p = runTurn(rec.ctx);
            } catch (e) {
                _settle(rec, { ok: false, reason: 'error', message: 'runTurn 同步抛错：' + String((e && e.message) || e) });
                return;
            }
            Promise.resolve(p).then(function (res) {
                _settle(rec, res);
            }, function (e) {
                _settle(rec, { ok: false, reason: 'error', message: 'runTurn 拒绝：' + String((e && e.message) || e) });
            });
        }

        function _endTurn(rec, t) {
            if (rec.turnStart) {
                var used = t - rec.turnStart;
                if (used > 0) rec.totalMs += used;   // 时钟回拨不倒扣（累计耗时只增不减）
                rec.turnStart = 0;
            }
            rec.finishedAt = t;
        }

        // 一轮的归宿：成功 ⇒ waiting（保活 >0）或 done（保活 =0）；失败 ⇒ failed。
        // 唯一的例外是 stopped：**终态短路**——abort 之后 runTurn 仍可能 resolve，那条迟到的结果
        // 不得把已停的子 Agent 掀回 waiting/done（stopped 不回退、不复活）。
        function _settle(rec, res) {
            var t = _nowMs();
            if (rec.state === ST.STOPPED) {
                _flushWaiters(rec, _stoppedResult(rec));
                return;
            }
            _endTurn(rec, t);
            var r = res || {};
            if (r.tokens !== undefined) rec.tokens = r.tokens;   // 池只存不改（运行器写什么就是什么）
            if (r.ok === true) {
                rec.summary = (typeof r.summary === 'string') ? r.summary : '';
                // 每轮的保活窗口取**起跑时**的快照（见 _startTurn；非数字理论上不可达——只有起跑过的
                // 轮次才会结算——回落当前值，不静默变成 0）。已在 waiting 的记录保留自己的 deadline：
                // 改 keepAliveMs 不追溯改写它们的回收时刻。
                var ka = (typeof rec.turnKeepAliveMs === 'number') ? rec.turnKeepAliveMs : keepAliveMs;
                if (ka > 0) {
                    rec.deadline = t + ka;               // 保活窗口：只有 releaseExpired() 会收它
                    _setState(rec, ST.WAITING, t);
                } else {
                    rec.deadline = 0;
                    _setState(rec, ST.DONE, t);          // keepAliveMs=0 ⇒ 跑完直接终态，不产生 waiting
                }
                _flushWaiters(rec, {
                    ok: true, id: rec.id, state: rec.state, summary: rec.summary, tokens: rec.tokens
                });
            } else {
                var reason = (typeof r.reason === 'string' && r.reason) ? r.reason : 'error';
                var message = (typeof r.message === 'string') ? r.message : '';
                rec.error = { reason: reason, message: message };
                _setState(rec, ST.FAILED, t);
                _flushWaiters(rec, { ok: false, id: rec.id, state: rec.state, reason: reason, message: message });
            }
            _drain();   // 这一轮让出了并发名额 ⇒ 排队者按序补位
        }

        // 入队（spawn 满额与 ask 满额**共用这一处**，与 _drain 的起跑判据同源）：
        // 标 state=queued 并记入队序号；顺手清掉保活期限（queued 不在保活窗口里，回收只收 waiting）。
        function _enqueue(rec, t) {
            qseq++;
            rec.queueSeq = qseq;
            rec.deadline = 0;
            _setState(rec, ST.QUEUED, t);
        }

        // 出队补位：**只有这里**把 queued 变成 running（spawn 满额、追问满额、跑完、停止都会走到这一步）。
        // 并发判据只有一个：running 数 < 名额。queued 是名额外的**显式溢出**（见 spawn 注释）。
        function _drain() {
            var guard = 0;
            while (_count(ST.RUNNING) < limit && guard <= recs.length) {
                guard++;
                var next = null;
                for (var i = 0; i < recs.length; i++) {
                    var r = recs[i];
                    if (r.state !== ST.QUEUED) continue;
                    // 次序按**入队时刻**（queueSeq），不是表内位置：追问补队的记录表里可能很靠前，
                    // 按位置取会让它插到早就在排队的人前面——FIFO 就只剩个名义。
                    if (!next || r.queueSeq < next.queueSeq) next = r;
                }
                if (!next) return;
                _startTurn(next, _nowMs());
            }
        }

        // ── 保活回收（懒触发，**不自建定时器**）─────────────────────────
        function _isExpired(rec, t) {
            return rec.state === ST.WAITING && rec.deadline > 0 && t >= rec.deadline;
        }

        function _reapAll(t) {
            var released = [];
            for (var i = 0; i < recs.length; i++) {
                var r = recs[i];
                // 只收 waiting 且到期的：running（还在跑）与未到期的 waiting（还能追问）一律不动。
                if (!_isExpired(r, t)) continue;
                r.deadline = 0;
                _setState(r, ST.DONE, t);    // 保活到期 ⇒ 生命周期正常结束（done，不是 failed/stopped）
                released.push(r.id);
            }
            return released;
        }

        // ── 公开面（不多不少）───────────────────────────────────────
        function spawn(req) {
            try {
                if (!runTurn) {
                    return _fail('error', 'runTurn 未注入：池没有可执行的运行器（C2 还没接线），'
                        + '不能凭空造一个"在跑"的子 Agent。');
                }
                // 闸门先判：0 名额 ⇒ **不建记录、也不排队**（排队会让模型以为派上了）。
                if (limit === 0) {
                    return _fail('limit_zero', '子 Agent 并发上限是 0（团队设置里被关掉了）：'
                        + '把设置里的「子 Agent 并发」调到 1 以上再派发。');
                }
                var r = req || {};
                var task = (typeof r.task === 'string') ? r.task.replace(/^\s+|\s+$/g, '') : '';
                if (!task) {
                    return _fail('bad_task', 'task 必须是非空字符串（子 Agent 拿它当任务说明）。');
                }
                seq++;
                var t = _nowMs();
                var id = 'sub_' + seq;
                var title = (typeof r.title === 'string' && r.title.replace(/^\s+|\s+$/g, ''))
                    ? r.title : ('子 Agent ' + seq);   // 缺标题时给个可辨认的回落值：任务板不留空行
                var parentLane = (typeof r.parentLane === 'string') ? r.parentLane : '';
                var tools = (r.tools === undefined) ? null : r.tools;
                // 层深派生（复核修）：父记录在册 ⇒ 父.depth + 1，否则根层。父 id 由调用方在
                // 「从某个子 Agent 内部再派生」时给出（ctx.id）；今天这条链不可达（三件 subagent
                // 工具已从子 Agent 的工具集里剔除），故可见行为仍是 depth 1，但深度不再是常量。
                var parentId = (typeof r.parentId === 'string') ? r.parentId.replace(/^\s+|\s+$/g, '') : '';
                var parentRec = parentId ? _find(parentId) : null;
                var depth = parentRec ? (parentRec.depth + 1) : ROOT_DEPTH;
                var handle = _newAbort();
                var rec = {
                    id: id,
                    title: title,
                    task: task,
                    parentLane: parentLane,
                    tools: tools,
                    depth: depth,
                    // wait 只是调用方的取数方式（阻塞等摘要），不改变池的生命周期：跑完照进保活窗口
                    wait: r.wait === true,
                    // 追问来源**不落记录字段**：唯一来源是 ctx.askOrigin（spawn 时为 agent，ask 按轮覆盖），
                    // 行里的 turnOrigin 由 _rows 现派生——存两份会漂（运行器读一份、回投读另一份）。
                    state: '',
                    createdAt: t,
                    updatedAt: t,
                    turnStart: 0,
                    finishedAt: 0,
                    totalMs: 0,
                    deadline: 0,
                    tokens: null,
                    summary: '',
                    error: null,
                    abortHandle: handle,
                    waiters: [],
                    // ctx 是**一个**对象、追问复用：运行器据此知道这是追问而不是新任务。
                    // maxLoops 由池透传给运行器（池只透传）；depth 由父记录派生（见上）。
                    ctx: {
                        id: id,
                        title: title,
                        task: task,
                        parentLane: parentLane,
                        tools: tools,
                        signal: handle.signal,
                        depth: depth,
                        maxLoops: maxLoops,
                        // 追问来源（ask 写入，运行器据此写清「谁在问」；首轮 = agent）
                        askOrigin: 'agent'
                    }
                };
                recs.push(rec);
                // 并发闸：running 数 < 名额 ⇒ 起跑；否则**显式排队**（state=queued，任务板/卡片显示
                // 「排队中」）。注意 queued 是名额外的溢出——那句「running+queued ≤ maxConcurrent」
                // 与同段的「满额 ⇒ queued」互斥（3 名额 + 第 4 个排队就必然超出该式），本实现按
                // 「满额排队」落地，实际守住的不变量是 running ≤ limit（见报告）。
                if (_count(ST.RUNNING) < limit) _startTurn(rec, t);
                else _enqueue(rec, t);
                var out = { ok: true, id: rec.id, state: rec.state };
                // wait:true ⇒ 额外给一个"跑完这一轮"的句柄（池自己不阻塞：调用方 await 它拿摘要）。
                // wait 缺省时不带这个字段（返回体形状与 { ok, id, state } 逐字相同）。
                if (rec.wait) out.done = _waitTurn(rec);
                return out;
            } catch (e) {
                // spawn 是模型的工具调用入口：**绝不向上抛**（抛出去就是一次工具执行失败 + 栈信息），
                // 一律收敛成可判定的失败体。
                return _fail('error', 'spawn 内部错误：' + String((e && e.message) || e));
            }
        }

        function ask(id, message, opts) {
            try {
                var askOpts = opts || {};
                // 追问来源：agent = 上级 Agent 经 send_message 追问；user = 面板弹窗里的**用户直接追问**。
                // 用途有两处：①运行器据此写清「这条追问是谁发的」（否则子 Agent 会把用户说的话当成父 Agent 的指令）；
                // ②回投侧按来源决定是否投给父 Agent（用户与子 Agent 的私下对话不回投）。
                var origin = (askOpts.origin === 'user') ? 'user' : 'agent';
                var t = _nowMs();
                var rec = (typeof id === 'string' && id) ? _find(id) : null;
                // 先记下"目标是不是刚好到期"：懒回收会把它推成 done，届时再判就只剩 not_waiting，
                // 调用方拿不到「过期」这个可纠正的原因。
                var targetExpired = !!rec && _isExpired(rec, t);
                _reapAll(t);   // 保活的两个懒触发点之一（另一个是 list()）
                if (!rec) {
                    return Promise.resolve(_fail('unknown_id', '没有这个子 Agent（id=' + String(id)
                        + '）：用 list_agents 看当前在册的 id。'));
                }
                if (targetExpired) {
                    return Promise.resolve(_fail('expired', '子 Agent ' + rec.id + ' 的保活窗口已过：'
                        + '它已被回收，需要就重新 spawn 一个。'));
                }
                if (rec.state !== ST.WAITING) {
                    return Promise.resolve(_fail('not_waiting', '子 Agent ' + rec.id + ' 当前是 ' + rec.state
                        + '：只有 waiting（跑完且还在保活窗口内）能追问。'));
                }
                var msg = (typeof message === 'string') ? message.replace(/^\s+|\s+$/g, '') : '';
                if (!msg) {
                    return Promise.resolve(_fail('bad_message', 'message 必须是非空字符串（追问内容）。'));
                }
                // 三闸的运行期改值同样管到这里（与 spawn 的闸门逐字同源）：名额被改成 0 之后追问
                // **显式失败**，不进队列——排队的追问会永远等不到名额（_drain 的判据是
                // "running 数 < 名额"，0 名额下恒假），而调用方拿到的是一个永不放下的 promise，
                // 回执上却看不出原因（0 名额不排队，这条对 spawn 与 ask 一视同仁）。
                if (limit === 0) {
                    return Promise.resolve(_fail('limit_zero', '子 Agent 并发上限是 0（团队设置里被关掉了）：'
                        + '把设置里的「子 Agent 并发」调到 1 以上再追问。'));
                }
                // 追问 = 同一 ctx 再跑一轮：ctx.message 带追问内容，运行器据此区分「追问」与「新任务」。
                // **来源只落在 ctx.askOrigin 一份**（行里的 turnOrigin 由 _rows 现派生）：运行器写谁在问、
                // 回投按来源分流，两处读的是同一个值——存两份必然有一天一处改、另一处漂。
                // 这些写入放在全部校验之后：limit_zero 等失败返回时不得把上一轮的来源残留到 ctx 上。
                rec.ctx.message = msg;
                rec.ctx.askOrigin = origin;
                var p = _waitTurn(rec);
                // 并发闸对追问**同样成立**：无条件 _startTurn 会让满额追问把
                // running 顶到 limit 之上（面板追问一次即复现）。现在与 spawn 逐字同源：
                // 有名额就起跑，满额就显式排队（state=queued），名额一松由 _drain 按入队次序补位。
                // 返回的 promise 仍在**这一轮落地**后 resolve（形状不变：{ ok, state }），排队只让
                // 调用方多等一段排队时间，不会拿不到终态——stop()/stopAll()/clear() 都会唤醒 waiters。
                var t2 = _nowMs();
                if (_count(ST.RUNNING) < limit) _startTurn(rec, t2);
                else _enqueue(rec, t2);
                // 追问期间被停止/保活等极端路径下，_settle 不会来；此时由 stop 用 stopped 结果唤醒 ⇒
                // 返回的 state 如实是那个终态（调用方按 state 判，不靠 ok 猜）。
                return p.then(function () { return { ok: true, state: rec.state }; });
            } catch (e) {
                return Promise.resolve(_fail('error', 'ask 内部错误：' + String((e && e.message) || e)));
            }
        }

        function list() {
            var t = _nowMs();
            _reapAll(t);        // 保活到期在这里懒回收（不加定时器：用户对面板 CPU 占用敏感）
            return _rows(t);
        }

        // 停止一条：**stop 是"标 stopped + abort"**，不改判终态、不删记录（历史要留痕）。
        function _stopOne(rec, t) {
            if (TERMINAL[rec.state]) return 0;            // 已终态（含已 stopped）：不回退、不复活
            var heldSlot = (rec.state === ST.RUNNING) ? 1 : 0;   // 只有 running 占着并发名额
            if (rec.turnStart) _endTurn(rec, t);          // 正在跑的那一轮也如实计入累计耗时
            rec.deadline = 0;
            _setState(rec, ST.STOPPED, t);
            _abort(rec);
            _flushWaiters(rec, _stoppedResult(rec));      // 挂着 wait:true 的调用方不该永远等下去
            return heldSlot;
        }

        function _stopWhere(pred) {
            var t = _nowMs();
            var ids = [];
            var slots = 0;
            for (var i = 0; i < recs.length; i++) {
                var r = recs[i];
                if (!pred(r)) continue;
                if (TERMINAL[r.state]) continue;
                slots += _stopOne(r, t);
                ids.push(r.id);
            }
            if (ids.length) _drain();   // 停掉 running 的会让出名额 ⇒ 别的排队者补位
            return { ids: ids, slots: slots };
        }

        function stop(id) {
            try {
                if (typeof id !== 'string' || !id) {
                    return _fail('unknown_id', 'stop 需要子 Agent id（形如 sub_1）。');
                }
                if (!_find(id)) {
                    return _fail('unknown_id', '没有这个子 Agent（id=' + id + '）：'
                        + '用 list_agents 看当前在册的 id。');
                }
                // released 口径：本次真正**让出的并发名额**数（停止前 state=running 的条数）。
                // 停 queued/waiting 的条目不占名额，计 0——这样 released>0 恰好意味着"有排队者会补位"，
                // 而不是 stopped.length 的同义重复。
                var out = _stopWhere(function (rec) { return rec.id === id; });
                return { ok: true, stopped: out.ids, released: out.slots };
            } catch (e) {
                return _fail('error', 'stop 内部错误：' + String((e && e.message) || e));
            }
        }

        function stopForParent(laneId) {
            // 空 lane id 什么都不停（同 dispatch.stopQueuedForLane('') 的口径）：父 lane 未知时
            // 「全停」是更危险的默认——停错会连别的 lane 的子 Agent 一起带走。
            if (typeof laneId !== 'string' || !laneId) return { ok: true, stopped: [], released: 0 };
            var out = _stopWhere(function (rec) { return rec.parentLane === laneId; });
            return { ok: true, stopped: out.ids, released: out.slots };
        }

        function stopAll() {
            var out = _stopWhere(function () { return true; });   // 含 queued 与 waiting：它们都还活着
            return { ok: true, stopped: out.ids, released: out.slots };
        }

        function releaseExpired() {
            return { released: _reapAll(_nowMs()) };
        }

        // 清理口（复核修）：停掉并**移除**全部记录——名册与统计归零。团队关闭路径调它（关团队后
        // `list_agents` 直接透传 pool.list()，只标 stopped 的话旧会话的子 Agent 还挂在名册上；
        // teamUI 的「池随团队关闭被 dispose」由此兑现）。
        // 为什么叫 clear 而不是 dispose：池本身**继续可用**（面板重挂/重开团队后还是这同一个实例，
        // 工具面也握着它的引用），dispose 会让人以为之后不可再 spawn。id 序号**不重置**（
        // id 单调自增、不重复使用）⇒ 清理后新派的是 sub_<下一个序号>，旧回执里的 id 不会指向新人。
        function clear() {
            try {
                // 全停：在跑的 abort、排队的不残留、挂着的 wait:true/ask 调用方一并唤醒（stopped 结果）。
                var out = _stopWhere(function () { return true; });
                var n = recs.length;
                recs.length = 0;
                // 通知一次「名册归零」：这次变化不属于某一条记录而属于整张表，故载体用空 id/state
                //（渲染侧按快照行全量重画 ⇒ 残留行当帧被收回；bootstrap 的回投按空 id 早退，不误投）。
                _notify({ id: '', state: '' });
                return { ok: true, cleared: n, stopped: out.ids };
            } catch (e) {
                return _fail('error', 'clear 内部错误：' + String((e && e.message) || e));
            }
        }

        // 三闸的运行期改值口（复核修）。**为什么必须有它**：池是模块级单例（bootstrap 只建一次），
        // 而 team.subagent 的三个闸若在 createSubagentPool 的入参里冻结成闭包常量 ⇒ 用户在设置里
        // 改「子 Agent 上限 / 保活 / 轮数」不生效，重挂面板也不生效，只能整页重载（两位审查独立复现）。
        // 归一口径与 createSubagentPool **逐字同源**（同一个 _num：非数字/NaN/∞ 回落缺省，越下界夹到
        // 下界；缺字段 = 回落缺省 ⇒ setLimits({}) 与"恢复到三档缺省"同义），不新增判据、不新增失败码。
        // 影响面（"只影响之后起跑/回收的轮次，已在跑的不打断"）：
        //   · maxConcurrent ⇒ 之后 spawn/ask 的闸门；0 走既有的 limit_zero（spawn 不建记录、ask 不排队）；
        //   · keepAliveMs   ⇒ 之后**起跑**的轮次（窗口在 _startTurn 快照）；已在 waiting 的记录保留
        //                     自己的 deadline，不被追溯改写（回收只认 rec.deadline）；
        //   · maxLoops      ⇒ 之后 spawn 出的记录（在 ctx 里透传给运行器）；已在册记录的 ctx 不动。
        // 名额被**放宽**时按既有 _drain 让排队者补位；收紧/清零时 _drain 自己什么都不做（判据仍是
        // "running 数 < 名额"这一条，不新增第二种起跑路径，也不去动已经在跑的）。
        function setLimits(next) {
            try {
                var o = next || {};
                var l = _num(o.maxConcurrent, DEF.maxConcurrent, 0);
                var k = _num(o.keepAliveMs, DEF.keepAliveMs, 0);
                var m = _num(o.maxLoops, DEF.maxLoops, 1);
                var changed = (l !== limit || k !== keepAliveMs || m !== maxLoops);
                limit = l;
                keepAliveMs = k;
                maxLoops = m;
                if (changed) {
                    _drain();   // 名额放宽 ⇒ 排队者补位（收紧时它是空转，不改任何状态）
                    // 通知一次：stats.limit 是快照的一部分，不通知则面板一直显示旧名额。载体与 clear()
                    // 同形——这次变化不属于某一条记录而属于整张表（空 id/state ⇒ 回投侧按空 id 早退）。
                    _notify({ id: '', state: '' });
                }
                // 回执给**归一后**的三个值（调用方不必自己再归一一次；同值回灌时 changed=false 且不通知）
                return {
                    maxConcurrent: limit, keepAliveMs: keepAliveMs, maxLoops: maxLoops, changed: changed
                };
            } catch (e) {
                return _fail('error', 'setLimits 内部错误：' + String((e && e.message) || e));
            }
        }

        // 公开面，次序与契约一致（不多不少）+ clear（停止语义的收尾档）与
        // setLimits（三闸的运行期改值口；池是模块级单例，重挂装配靠它回灌，不再整页重载才生效）。
        return {
            spawn: spawn,
            ask: ask,
            list: list,
            stop: stop,
            stopForParent: stopForParent,
            stopAll: stopAll,
            clear: clear,
            setLimits: setLimits,
            releaseExpired: releaseExpired,
            stats: _stats
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createSubagentPool = createSubagentPool;
})(typeof window !== 'undefined' ? window : globalThis);
