(function (global) {
    'use strict';
    // 团队模式 orchestrator：三条常驻 lane（director / ae-exec / glsl）的
    // 登记面 + 「当前 lane」唯一真相源 + 停止 / 任务板快照 / AE 队列开关 / 团队会话薄封装。
    //
    // 职责边界（越界就会与引擎装配面打架，四条都是设计与审查钉死的）：
    //   · 只**登记与转发**：state / cm / store / view / controller 由 opts.createLaneRuntime(def)
    //     建好交进来，orchestrator 不 new 它们（装配归 engine/bootstrap）。
    //   · **不读 settings.runtimeMode 判「现在是哪条 lane」**。定死：view / 权限确认 /
    //     任务板 / toast 一律经 isCurrentLane(id) 判断——两处判据必然漂移（例如用户在 GLSL lane
    //     说话，而别处按 runtimeMode 把消息算到 shader 单 Agent 头上）。
    //   · **不直接摸 document**：容器显隐经 opts.hideContainers(ids)，未注入时交给各 lane view 的
    //     可见性能力；两者都没有就什么都不做（orchestrator 不是 DOM 层）。
    //   · **不自造会话 id 规则**：id 一律由 opts.sessions 生成/广播（
    //     team_<时间戳>_<随机段> 是 binder 的规则，不是这里的）。
    //   · **派单不自建第二套投递链**：投递一律走目标 lane controller 的
    //     injectSystemMessage（唯一落点），工作项表 / state 机 / 投递文本全在 team/dispatch.js
    //     那一份里；本文件只提供团队会话 id 与投递通道，并且**不开定时器**（懒推进）。
    //
    // opts 契约（全部可选；缺能力一律显式失败或跳过，不抛。注入项按**调用时**读取——队列与
    // 会话 broadcaster 都可能晚于 orchestrator 创建）：
    //   lanes               — lane 定义访问器，须有 list()（返回副本）/ listIds() / domFor()；
    //                         缺省回落 global.AEAgentTeam.lanes（本文件不重复定义 lane 定义）
    //   createLaneRuntime   — (def) => { cm, store, state, view, controller }；同一 lane 只调一次
    //                         （start 幂等的判据就是「这个表里已经有它了」）
    //   execQueue           — AE 串行队列，须有 enable(on) / isEnabled()；缺省回落 global.AEExecQueue
    //   sessions            — 团队会话广播器（sessionBinder），须有 bind(sid) / create() /
    //                         switch(sid) / rename(sid,title) / delete(sid)，返回 { ok, reason?, … }
    //                         （busy / partial / rolledBack 这类业务失败由 binder 判定，这里原样透出）
    //   getSettings         — () => 已归一设置（只透传；lane 判据不走它）
    //   onCurrentLaneChange — (nextId, prevId) => void，仅 lane 真的变了才通知
    //   hideContainers      — (containerIds) => void，dispose 时隐藏三条 lane 容器
    //   now                 — () => ms，状态推导的时钟（缺省 Date.now；单测注入固定钟可精确断言 elapsedMs）
    //   createDispatch      — (deps) => 派单纯逻辑实例（team/dispatch.js 工厂）。
    //                         缺省回落 global.AEAgentTeam.createDispatch，且**懒解析**：装配期不校验，
    //                         真派单时才取（载序由 manifest 保证，创建期硬取会让「先建后载」直接废掉）
    //   subagents           — 子 Agent 池**实例**（AEAgentTeam.createSubagentPool 产出）。
    //                         **只接注入的单例**（bootstrap 装配期建），本文件不建池、也不回落全局：
    //                         并发闸是面板级单例，两处各建一个就是两个闸（各自以为还有名额）。
    //                         缺席 ⇒ 子 Agent 段恒空数组、停止级联的 subagentsStopped 恒 0，
    //                         且**不假装停过了**（没有池就是没有子 Agent 可停）。
    //
    // 会话方法的口径：**薄封装**，只做三件事——
    // 转发、记录团队会话 id、把失败显式化。未注入 sessions 时返回 { ok:false, reason:'not_wired' }，
    // 不静默假装成功：静默成功会让 UI 以为会话已切换，实际三条 lane 还在旧会话上继续跑。
    //
    // 单 Agent 路径不创建本对象（团队关闭时 orchestrator 不装配），故本文件的所有行为只作用于
    // 团队模式；它不改变任何既有链路的语义。

    // 状态取值即契约（getBoardSnapshot 字段与运行态取值）：
    //   idle 空闲 / thinking 思考中 / tool 工具执行中 / confirm 等待确认 / error 出错
    // 优先级：**等待确认 > 忙（工具 > 思考）> 出错 > 空闲**。
    //   · 等待确认最高：那条 lane 正卡在用户的决策上，任务板必须一眼看到（显示「待确认」）；
    //   · 忙优先于 error：lastError 是上一轮的残留标记，正在跑的轮次不能被它盖成「出错」；
    //   · error 只在不忙时显示，直到被清。
    // 「等待确认」的判据只能读 state 上的两个可选字段：确认卡片的 await 目前活在
    // toolExecutionPipeline 的闭包里（toolExecutionPipeline.js:397-427），没有可观测字段
    // ⇒ 当前恒不命中；pendingConfirm 写进 state 后本分支自动生效（不改这里的判定顺序）。
    function _awaitingConfirm(state) {
        if (!state) return false;
        if (state.pendingConfirm === true) return true;
        var t = state.toolCallInProgress;
        return !!(t && t.awaitingConfirm === true);
    }

    // 工具名：state.toolCallInProgress 允许是字符串（工具名）或对象（带 name/toolName）。
    function _toolName(tool) {
        if (!tool) return '';
        if (typeof tool === 'string') return tool;
        if (typeof tool.name === 'string' && tool.name) return tool.name;
        if (typeof tool.toolName === 'string' && tool.toolName) return tool.toolName;
        return '';
    }

    // 取正数时间戳，非正/非数一律视为「没记」：0（或负数）不是合法的开始时刻，
    // 把它当有效值会让 elapsedMs 恒等于当前钟值（年份级别的毫秒数）。
    function _positiveOr(v, fallback) {
        return (typeof v === 'number' && isFinite(v) && v > 0) ? v : fallback;
    }

    // 缺省动作文案。**不含秒数**：elapsedMs 是单独字段，由 UI 与它拼（两处格式化必然不同步）。
    var STATUS_TEXT = { idle: '空闲', thinking: '思考中', confirm: '等待确认', error: '出错' };

    function _defaultText(status, toolName) {
        if (status === 'tool') return toolName ? ('工具 `' + toolName + '` 执行中') : '工具执行中';
        return STATUS_TEXT[status] || status;
    }

    // 状态推导的**纯函数**（除入参外不读任何东西，clock 由调用方给）：runtime → 任务板的一行。
    // 为什么抽出来：这是任务板唯一的判定处，做成纯函数后才能被单测直驱（构造三种假态即可断言），
    // 也让 taskBoard.js 可以复用同一条判据而不是各写一份。
    // 返回：{ status, busyText, toolName, elapsedMs, subagentCount }
    function deriveLaneStatus(runtime, now) {
        var state = (runtime && runtime.state) || null;
        var clock = (typeof now === 'number') ? now : Date.now();
        var tool = state ? state.toolCallInProgress : null;
        var toolName = _toolName(tool);
        var busy = !!(state && state.busy);
        var status = 'idle';
        if (_awaitingConfirm(state)) status = 'confirm';
        else if (busy) status = toolName ? 'tool' : 'thinking';
        else if (state && state.lastError) status = 'error';

        // 计时起点：state.busySince（当前轮开始）优先，其次 toolCallInProgress.startedAt（当前轮工具）。
        // 两者都没记 ⇒ 0（不编造耗时——任务板上「正在跑 0s」比「没时间」更容易被误读）。
        var since = _positiveOr(state && state.busySince, _positiveOr(tool && tool.startedAt, 0));
        var counting = (status === 'tool' || status === 'thinking' || status === 'confirm');
        var elapsedMs = (counting && since > 0) ? Math.max(0, clock - since) : 0;

        // 文案：「等待确认」**必须盖过 state.busyText**。
        // 真机取证：确认卡在场时 board=confirm、pendingConfirm=true，但行文本仍是
        // `调用工具: executeExtendScript...`——引擎在工具调用期间一直写着 busyText，照原样透出的话
        // 「卡在等你点允许」与「工具正在跑」在板上一模一样（只有 6px 状态点的脉冲有差别）。
        // 设计口径本来就是「等待确认最高：任务板必须一眼看到」（见上方状态优先级注释），文案跟着走。
        // 其余状态**照旧透传** state.busyText（②-13：引擎可以给更准的文案，如「渲染中（AE 队列）」）。
        var busyText = (status === 'confirm')
            ? _defaultText('confirm', toolName)
            : ((state && typeof state.busyText === 'string' && state.busyText)
                ? state.busyText : _defaultText(status, toolName));

        return {
            status: status,
            busyText: busyText,
            toolName: toolName,
            elapsedMs: elapsedMs,
            // 注意：**这里不再现算 subagentCount**。
            // `(runtime.subagents && runtime.subagents.length) || 0` 里的 runtime.subagents
            // **全仓没有任何赋值点** ⇒ 恒 0；而 UI 的计数格走的是 taskBoard.buildBoardSnapshot 那条
            // 路（入参 subs 现算）。留着这个恒 0 字段只会让后来人继续读它。
            // lane 行的 subagentCount 由 taskBoard 按池行现算（判据复用 isSubagentActive）。
            subagentCount: 0
        };
    }

    function createOrchestrator(opts) {
        var o = opts || {};
        var runtimes = {};        // id -> { def, cm, store, state, view, controller }
        var runtimeOrder = [];    // 已登记的 lane 顺序（定义源异常时的兜底遍历序）
        var currentLane = '';     // 当前 lane：isCurrentLane 的唯一真相源（首次读取时落第一条）
        var teamSessionId = null; // 团队会话 id：只由 opts.sessions 产出（派单要用它定位工作区）

        // ── 依赖解析（缺省回落全局命名空间，与 lanes.js / settings.js 同一套口径）──────
        function _lanesApi() {
            if (o.lanes) return o.lanes;
            return (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
        }

        function _queue() {
            if (o.execQueue) return o.execQueue;
            return (global.AEExecQueue && typeof global.AEExecQueue.enable === 'function') ? global.AEExecQueue : null;
        }

        function _sessions() {
            return (o.sessions && typeof o.sessions === 'object') ? o.sessions : null;
        }

        function _now() {
            if (typeof o.now === 'function') {
                try {
                    var v = o.now();
                    if (typeof v === 'number' && isFinite(v)) return v;
                } catch (_) { /* 时钟抛错 → 回落系统钟（状态推导不该让任务板整块不渲染） */ }
            }
            return Date.now();
        }

        // lane 定义源：唯一来源是 lanes 访问器，list() 已返回副本（lanes.js 保证），这里不再拷一层。
        // 定义源缺席/抛错 ⇒ 空数组（调用方据此显式失败，而不是凭空造三条 lane）。
        function _laneDefs() {
            var api = _lanesApi();
            if (!api || typeof api.list !== 'function') return [];
            try {
                var list = api.list();
                return (list && list.length) ? list : [];
            } catch (_) { return []; }
        }

        // 遍历序：定义顺序优先（= UI 展示顺序），再补上「已在跑但定义源里没有」的 lane。
        // 两个消费点（stopAll / getBoardSnapshot）都必须遍历到**所有在跑的 lane**——
        // 定义源异常时漏掉一条，「全部停止」就变成了「停了一部分」。
        function _laneIds() {
            var defs = _laneDefs();
            var ids = [];
            var seen = {};
            for (var i = 0; i < defs.length; i++) {
                var id = defs[i] && defs[i].id;
                if (!id || seen[id]) continue;
                seen[id] = true;
                ids.push(id);
            }
            for (var j = 0; j < runtimeOrder.length; j++) {
                if (!seen[runtimeOrder[j]]) {
                    seen[runtimeOrder[j]] = true;
                    ids.push(runtimeOrder[j]);
                }
            }
            return ids;
        }

        function _hasLane(id) {
            if (!id) return false;
            if (runtimes[id]) return true;
            var defs = _laneDefs();
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].id === id) return true;
            }
            return false;
        }

        // ── 队列状态（只读）──────────────────────────────────────────
        // AE 串行队列是**面板常开**资源，不再由团队模式
        // 开关拨动。编排面只读它的当前状态（返回值里如实报告），**不得** enable/disable——
        // 一关就会把外接与面板单 Agent 的逐调用串行一起关掉，回到双跑无闸的旧状态。
        function _queueIsEnabled() {
            var q = _queue();
            if (!q) return false;
            if (typeof q.isEnabled === 'function') {
                try { return !!q.isEnabled(); } catch (_) { return false; }
            }
            return true;   // 只读不可判的假体：按常开口径如实报告
        }

        // ── 会话薄封装 ────────────────────────────────────────────
        function _isOk(res) { return !!(res && res.ok === true); }

        // 统一出口：未注入 / 注入方抛错都返回显式失败体（不向上抛——binder 的异常不该打穿 UI）。
        // 返回体原样透出（对象即 binder 的自报，含 reason / rolledBack / sid 等）。
        function _sessionCall(method, args) {
            var s = _sessions();
            if (!s || typeof s[method] !== 'function') {
                return { ok: false, reason: 'not_wired', method: method };
            }
            var res;
            try {
                res = s[method].apply(s, args);
            } catch (e) {
                return { ok: false, reason: 'error', method: method, error: String((e && e.message) || e) };
            }
            if (res && typeof res === 'object') {
                // binder 自报（含 { ok:false, reason:'busy', rolledBack:[…] }）。ok 必须是布尔——
                // 少了它说明返回形态接错了（例如直接把 sid 返回），这种「没说成功也没说失败」一律
                // 按失败处理：会话没切却当成功，用户会以为切了（真机表现为消息继续写进旧会话）。
                if (typeof res.ok === 'boolean') return res;
                return { ok: false, reason: 'no_result', method: method, result: res };
            }
            if (res === true) return { ok: true };
            // undefined / null / 数字 / 字符串：既没自报成功也没给理由 ⇒ 显式失败。
            // （不把「返回了个 sid 字符串」当成成功——id 规则归 binder，orchestrator 不猜它的返回形态。）
            return { ok: false, reason: 'no_result', method: method };
        }

        function bindSession(sid) {
            var res = _sessionCall('bind', [sid]);
            if (_isOk(res) && typeof sid === 'string' && sid) teamSessionId = sid;
            return res;
        }

        function createTeamSession() {
            var res = _sessionCall('create', []);
            // 会话 id 只从 binder 的返回体里取（本文件不生成 id）
            if (_isOk(res) && res && typeof res.sid === 'string' && res.sid) teamSessionId = res.sid;
            return res;
        }

        function switchTeamSession(sid) {
            var res = _sessionCall('switch', [sid]);
            if (_isOk(res) && typeof sid === 'string' && sid) teamSessionId = sid;
            return res;
        }

        function renameTeamSession(sid, title) {
            // 改名不动绑定关系（只换标题）
            return _sessionCall('rename', [sid, title]);
        }

        function deleteTeamSession(sid) {
            var res = _sessionCall('delete', [sid]);
            // 删掉的是当前绑定的那条 ⇒ binder 会**先把三条 lane 整队切走**再删（见
            // team/sessionBinder.js 的 deleteTeamSession），镜像要跟着落到它的新绑定上；
            // binder 没切（删的不是当前那条 / 通道未装配 / 拒绝删除）时才置空——
            // 置空会让 read_workspace 报 no_team_session，而三条 lane 其实停在另一条会话上。
            if (_isOk(res) && teamSessionId && teamSessionId === sid) {
                teamSessionId = (res && typeof res.switchedTo === 'string' && res.switchedTo) ? res.switchedTo : null;
            }
            return res;
        }

        // 团队会话镜像的**显式落值口**：只改镜像，不下发任何动作、不做 IO。
        // 为什么必须有：binder 的绑定通知（onBoundChange）要同步宿主镜像，而 `bindSession` 会
        // 反向回调 binder（bind 正是它的注入面）——拿它当镜像 setter 会**无限递归**
        //（真机表现：删一次当前会话就栈溢出）。命名与 noteRestoredSession 同族：只认领既成事实。
        // 它不参与「谁该绑哪条会话」的判定（那是 binder 的事），只把 binder 已确认的事实记下来。
        function noteTeamSessionId(sid) {
            teamSessionId = (typeof sid === 'string' && sid) ? sid : null;
            return { ok: true, sid: teamSessionId, noted: true };
        }

        // ── lane runtime 登记 ─────────────────────────────────────
        // 同一 lane 只建一次：start 幂等的判据就是这个表（二次 start 走「复用」分支，引用相等）。
        // createLaneRuntime 抛错 ⇒ 记为该 lane 失败，不阻断另外两条（单条 lane 装配失败不该让
        // 整个团队起不来——另两条仍可用，任务板会如实显示缺的那条没有实例）。
        function _registerLane(def) {
            if (runtimes[def.id]) return runtimes[def.id];
            if (typeof o.createLaneRuntime !== 'function') return null;
            var rt = null;
            try {
                rt = o.createLaneRuntime(def);
            } catch (_) { rt = null; }
            if (!rt || typeof rt !== 'object') return null;
            // **就地**补 def：不替换对象——注入方拿到的引用必须与 getLane(id) 返回的是同一个
            //（单测与 bootstrap 都按引用相等判「有没有被重建」）。
            if (!rt.def) rt.def = def;
            runtimes[def.id] = rt;
            runtimeOrder.push(def.id);
            return rt;
        }

        function getLane(id) {
            return (id && runtimes[id]) ? runtimes[id] : null;
        }

        // 三条 lane 定义（经 lanes 访问器的副本）。dispose 后仍可读：定义不随实例销毁。
        function lanes() { return _laneDefs(); }

        // ── 当前 lane（唯一真相源）────────────────────────────────
        // 缺省落「定义顺序里**已装配**的第一条」；全都没装配（装配期早期/全失败）才退回定义首条
        // （partial 且 director 失败时，落 defs[0] 会让 bootstrap 的 `_currentRuntime()`
        // 指向一条不存在的 runtime ⇒ 单例槽为 null；落首个装配成功的那条才能继续工作）。
        function _firstAssembledLaneId() {
            var defs = _laneDefs();
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].id && runtimes[defs[i].id]) return defs[i].id;
            }
            return '';
        }
        function getCurrentLane() {
            if (!currentLane) {
                var defs = _laneDefs();
                // 顺序的唯一事实源在 lanes.js，两处写死迟早不一致。
                currentLane = _firstAssembledLaneId()
                    || ((defs.length && defs[0] && defs[0].id) ? defs[0].id : '');
            }
            return currentLane;
        }

        function setCurrentLane(id) {
            if (typeof id !== 'string' || !id) return { ok: false, reason: 'bad_lane' };
            if (!_hasLane(id)) return { ok: false, reason: 'unknown_lane' };
            var prev = getCurrentLane();
            if (prev === id) return { ok: true, lane: id, previous: prev, changed: false };
            currentLane = id;
            // 通知失败不得让切 lane 半途失败（UI 刷新是消费方的事，真相源已经改好了）
            if (typeof o.onCurrentLaneChange === 'function') {
                try { o.onCurrentLaneChange(id, prev); } catch (_) { /* 忽略：见上 */ }
            }
            return { ok: true, lane: id, previous: prev, changed: true };
        }

        // view / 权限确认 / 任务板 / toast 一律经它判断。
        function isCurrentLane(id) { return !!id && getCurrentLane() === id; }

        // ── 启动 / 关闭 ───────────────────────────────────────────
        // start：装配三条 runtime（已建即复用）→ 绑定团队会话。AE 串行队列是面板常开资源
        // 装配不动它；返回值里的 queueEnabled 只如实报告当前状态。
        // 幂等口径（**钉死**）：① 二次 start 不重建 runtime（引用相等）；② 传了非空 sid 才
        // bindSession——空 sid 只装配，不假装绑了会话。
        // 重复 start(同一 sid) 会重复下发 bind：绑定幂等（busy 预检、回滚）是 binder 的职责，
        // orchestrator 不替它判重（否则「上次 bind 失败了、这次重试」会被本地判重挡掉）。
        function start(teamSessionIdArg) {
            var defs = _laneDefs();
            if (!defs.length) {
                return { ok: false, reason: 'no_lanes', started: [], reused: [], failed: [], currentLane: getCurrentLane() };
            }
            var built = [];
            var reused = [];
            var failed = [];
            for (var i = 0; i < defs.length; i++) {
                var def = defs[i];
                if (!def || !def.id) continue;
                if (runtimes[def.id]) { reused.push(def.id); continue; }
                if (_registerLane(def)) built.push(def.id);
                else failed.push(def.id);
            }
            // 当前 lane 失效（定义源换过/首次启动/上一条装配失败）⇒ 落**首个装配成功**的 lane（S3，
            // 落 defs[0] 在「partial 且 director 装配失败」时会指向一条不存在的 runtime，
            // bootstrap 的 `_currentRuntime()`/单例槽会变 null（面板空白、发送键锁死）。全失败时才
            // 退回定义首条（此刻本来就没有可用 runtime，保持「真相源非空」的既有诊断口径）。
            if (!currentLane || !_hasLane(currentLane) || !runtimes[currentLane]) {
                currentLane = _firstAssembledLaneId() || (defs[0] ? defs[0].id : '');
            }
            var queueOn = _queueIsEnabled();
            var session = null;
            if (typeof teamSessionIdArg === 'string' && teamSessionIdArg) session = bindSession(teamSessionIdArg);
            var ok = failed.length === 0 && runtimeOrder.length > 0;
            var reason = '';
            if (!ok) reason = (typeof o.createLaneRuntime !== 'function') ? 'not_wired' : 'runtime_failed';
            return {
                ok: ok,
                reason: reason,
                started: built,
                reused: reused,
                failed: failed,
                currentLane: currentLane,
                queueEnabled: queueOn,   // 当前状态（面板常开；start 不再拨动它）
                session: session
            };
        }

        function stopLane(id) {
            var rt = getLane(id);
            if (!rt) return { ok: false, reason: 'unknown_lane', lane: id };
            var c = rt.controller;
            if (!c || typeof c.requestStop !== 'function') return { ok: false, reason: 'no_controller', lane: id };
            try {
                c.requestStop();
            } catch (e) {
                return { ok: false, reason: 'error', lane: id, error: String((e && e.message) || e) };
            }
            // 派单不再有 queued 状态（一次投递，投不出去就如实报错）⇒ 停止时**没有**
            // 「还没投出去的工作项」需要改判；已经投出去的那一轮由上面那句 requestStop 停。
            // 子 Agent 级联：父 lane 一停，它派生的子 Agent **全部**停（
            // 「父停 → 后代全停」）。同样只在停止真的发生之后级联——失败体说明这条 lane 没被停，
            // 顺手把它的子 Agent 停掉就是「点了个不存在的 lane，别处的活被砍了」。
            var subagentsStopped = _stopSubagentsForLane(id);
            // 排队中的 AE 调用：requestStop 只停本轮，已入 AE 串行队列的调用
            // 仍会按 FIFO 依次下发——用户点了「停止」，那条 lane 排着的脚本仍会改工程。这里把
            // 它**尚未下发**的等待项取消（工具面当场失败）；队头已下发、evalScript 不可取消，
            // 由队列契约保证不碰。
            var queueCancelled = _cancelQueueForLane(id);
            // 清理在**停止之后**发生（顺序要紧）：级联停子 Agent 与 requestStop 复位 busy 都会同步
            // 触发「状态卡片」的注入，那些条目正是在这条已停的 lane 上入队的（见下面那个函数）。
            _dropQueuedSystemResults(rt);
            return { ok: true, lane: id, subagentsStopped: subagentsStopped, queueCancelled: queueCancelled };
        }

        // 停止 lane 时取消它**尚未下发**的 AE 队列项。队列能力缺席（旧装配 /
        // 假体没有 cancelQueuedForLane）⇒ 返回 0，不假装取消过（停止主的语义不受影响）。
        function _cancelQueueForLane(laneId) {
            var q = _queue();
            if (!q || typeof q.cancelQueuedForLane !== 'function') return 0;
            try {
                return q.cancelQueuedForLane(laneId, 'lane_stopped') || 0;
            } catch (e) {
                console.warn('[Agent] 停止 lane 时取消 AE 队列项失败（lane=' + laneId + '）: '
                    + String((e && e.message) || e));
                return 0;
            }
        }

        // stopLane 的注入队列清理：requestStop **有意**保留 _injectQueue（停后起轮让 Agent 看到用户
        // 刚输入的话，controller.js:395 的注释），所以这条队列不能整条清（stopAll/dispose 才整条清，
        // 见 _clearInjectQueue）。但队列里混着另一类条目——**系统结果卡片**
        //（injectSystemResult 在 restoring/busy/stopping/switching 窗口入队的形态，见
        // controller/apiActions.js 的入队分支：{ systemResult:true, title, visible, detail, llmRole,
        // sessionId }）。lane 已经停了，这类条目不会被当前轮读到，只会等这条 lane **下次**起轮时 drain
        // 出来 —— 那时它就是一张过期卡片：用户刚停掉这条 Agent，聊天区却冒出「子 Agent「X」已停止」
        // / 「消息…回复」之类的卡片，内容回的是停止前那一轮的事（时序上早已作废）。
        // 故这里只丢这一类（用户排队的输入原样保留），且只在这条 lane 上丢（别的 lane 的队列不碰）。
        // 能力缺席（老 controller / 假体没有 getInjectQueue）⇒ 跳过，不假装清过了。返回值不对外
        // 暴露：stopLane 的返回体是既有契约（ok/lane/subagentsStopped），不为一次内部清理加字段。
        function _dropQueuedSystemResults(rt) {
            var c = rt && rt.controller;
            if (!c || typeof c.getInjectQueue !== 'function') return 0;
            var q = null;
            try { q = c.getInjectQueue(); } catch (_) { return 0; }
            if (!q || typeof q.splice !== 'function' || typeof q.length !== 'number') return 0;
            var dropped = 0;
            for (var i = q.length - 1; i >= 0; i--) {
                var e = q[i];
                if (e && e.systemResult === true) { q.splice(i, 1); dropped++; }
            }
            return dropped;
        }

        // 全停时清队列：requestStop 是**有意**保留 _injectQueue 的（停后重置循环、让 Agent 立刻看到
        // 用户刚输入的话，见 controller.js:395 的注释），而「全部停止」是更强的用户意图——设计
        // 全停后要求三条 lane 的 _injectQueue 为空。能力缺席（老 controller / 假体）时跳过，
        // 不假装清过了。
        function _clearInjectQueue(rt) {
            var c = rt && rt.controller;
            if (!c || typeof c.clearInjectQueue !== 'function') return false;
            try { c.clearInjectQueue(); return true; } catch (_) { return false; }
        }

        function stopAll() {
            var ids = _laneIds();
            var stopped = [];
            var cleared = [];
            var failed = [];
            var subagentsStopped = 0;
            var queueCancelled = 0;
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var res = stopLane(id);
                if (res.ok) {
                    stopped.push(id);
                    // 子 Agent 级联在 stopLane 里已按 lane 停过一轮
                    subagentsStopped += res.subagentsStopped || 0;
                    queueCancelled += res.queueCancelled || 0;
                } else {
                    failed.push({ lane: id, reason: res.reason });
                }
                if (_clearInjectQueue(runtimes[id])) cleared.push(id);
            }
            // 子 Agent 同款兜底：定义源异常时碰不到的父 lane 派生的子 Agent 也在
            // 「全部停止」的范围内。幂等，故这里不会把上面已停的重复计数。
            // 派单那一面没有 queued 状态可停了（一次投递），故这里只剩子 Agent 兜底。
            subagentsStopped += _stopAllSubagents();
            return {
                ok: failed.length === 0, stopped: stopped, cleared: cleared, failed: failed,
                subagentsStopped: subagentsStopped,
                // 全停时被取消的 AE 队列等待项总数（排队项随停止一起清，不再往下发）
                queueCancelled: queueCancelled
            };
        }

        // 容器 id 的来源顺序：lanes.listIds()（权威，容器壳）→ 定义里的 containerId →
        // domFor(id).listId（消息列表容器，最后的兜底）。全部经注入的 lanes 访问器取，不摸 document。
        function _containerIds() {
            var api = _lanesApi();
            if (api && typeof api.listIds === 'function') {
                try {
                    var ids = api.listIds();
                    if (ids && ids.length) return ids;
                } catch (_) { /* 回落下面的定义来源 */ }
            }
            var defs = _laneDefs();
            var out = [];
            for (var i = 0; i < defs.length; i++) {
                var d = defs[i];
                if (!d) continue;
                if (d.containerId) { out.push(d.containerId); continue; }
                if (api && typeof api.domFor === 'function') {
                    try {
                        var dom = api.domFor(d.id);
                        if (dom && dom.listId) out.push(dom.listId);
                    } catch (_) { /* 该 lane 拿不到容器 id：跳过（不猜 id 名） */ }
                }
            }
            return out;
        }

        function _hideContainers() {
            var ids = _containerIds();
            if (typeof o.hideContainers === 'function') {
                try { o.hideContainers(ids); return true; } catch (_) { return false; }
            }
            // 未注入隐藏通道：交给各 lane view 的可见性能力（存在才调，方法名两种都认）。
            // 都没有 ⇒ 什么都不做：orchestrator 不直接摸 document（装配风格要求）。
            var done = false;
            for (var i = 0; i < runtimeOrder.length; i++) {
                var rt = runtimes[runtimeOrder[i]];
                var v = rt && rt.view;
                if (!v) continue;
                try {
                    if (typeof v.setVisible === 'function') { v.setVisible(false); done = true; }
                    else if (typeof v.hide === 'function') { v.hide(); done = true; }
                } catch (_) { /* 某条 view 隐藏失败不影响其余 */ }
            }
            return done;
        }

        // dispose：先全停（隐藏前必须停——否则隐藏的 lane 还在后台烧 token / 占 AE 引擎），
        // 再隐藏容器。**队列不关**（面板常开资源，编排面无权拨动），
        // **实例保留**：三条 runtime 与会话绑定都不销毁（关开关 = 隐藏 + 全停，重开即
        // 恢复），故 dispose 后 lanes()/getLane() 仍可读，再次 start() 复用同一批实例。
        // 停止语义走 stopAll 那一份（派单侧已无状态机，它只剩
        // 「requestStop + 子 Agent 级联」两件事），重开后不会再有「旧派单诈尸」的问题。
        function dispose() {
            var res = stopAll();
            var queueState = _queueIsEnabled();
            var hidden = _hideContainers();
            return {
                ok: res.ok,
                stopped: res.stopped,
                cleared: res.cleared,
                failed: res.failed,
                // 子 Agent 级联停的条数：dispose 经 stopAll 继承，**不另起一套停链**
                //（关团队 = 全停 + 隐藏容器，子 Agent 由全停那一份覆盖）
                subagentsStopped: res.subagentsStopped,
                // 关团队时被取消的 AE 队列等待项总数（全停的语义包含「排着的也不再下发」）
                queueCancelled: res.queueCancelled,
                queueEnabled: queueState,   // 当前状态（常开；dispose 不再关闭）
                hidden: hidden
            };
        }

        // ── 派单（冻结契约）──────────────────────────────
        // 纯逻辑（工作项表 + state 迁移 + 投递文本）住在 team/dispatch.js，这里只做三件事：
        //   ① **懒解析**工厂：dispatch.js 晚于 orchestrator.js 落地也照样接得上（装配期不查，
        //      真派单时才查一次并缓存）——载序在 manifest 里，创建期硬取会让「先建后载」直接废掉；
        //   ② 提供两样只有这里才有的东西：团队会话 id 与投递通道（deliver）；
        //   ③ 把停止语义接到 stopLane/stopAll/dispose 上。
        // 判据唯一：工作项表、state、投递文本都只有 dispatch.js 那一份，本文件一条都不复制。
        var dispatchTable = null;         // 懒建一次（建失败也只在下次调用时重试，不留半成品）
        var dispatchBroken = '';          // 工厂抛错的原因（诊断用；正常为空）
        var dispatchWarned = false;       // 「模块缺席」只告警一次（任务板每秒刷新会反复问）

        function _dispatchApi() {
            if (typeof o.createDispatch === 'function') return o.createDispatch;
            var api = global.AEAgentTeam;
            return (api && typeof api.createDispatch === 'function') ? api.createDispatch : null;
        }

        function _dispatchTable() {
            if (dispatchTable) return dispatchTable;
            var factory = _dispatchApi();
            if (!factory) {
                if (!dispatchWarned && typeof console !== 'undefined' && console && typeof console.warn === 'function') {
                    dispatchWarned = true;   // 只报一次：调用点里有每秒刷新一次的任务板
                    console.warn('[Agent] team/dispatch.js 未加载（AEAgentTeam.createDispatch 缺席）：'
                        + '派单不可用，任务板工作项段保持为空');
                }
                return null;
            }
            try {
                dispatchTable = factory({
                    lanes: o.lanes,
                    getLaneRuntime: getLane,
                    // `'main'` 也合法（主 Agent 没有 lane 身份，但同样该被 send_message 找到）
                    allowMain: true,
                    // 团队会话 id 的**唯一来源**就是本文件记录的绑定值（由 bind/create/switch 写入，
                    // 用途一致）；拿不到时 dispatch 显式失败 not_team，不猜当前会话。
                    getTeamSessionId: function () { return teamSessionId; },
                    deliver: _deliver
                });
                dispatchBroken = '';
            } catch (e) {
                dispatchBroken = String((e && e.message) || e);
                dispatchTable = null;
            }
            return dispatchTable;
        }

        // 投递（**唯一落点**）：调目标 lane controller 既有的 injectSystemMessage(text, null,
        // sessionId, detail)——它自己处理「忙 ⇒ 入队 / 闲 ⇒ 直接跑」与切换守卫（apiActions.js:767
        // 起），这里**不另造入队链**，也不碰 lane 的 _injectQueue / state。
        // 团队主通道移除后 `'main'` **不再作为投递目标**——
        // 直接返回 `main_removed`（历史会话里的旧调用得到同一条错误，不假装送达）。
        // `allowMain` 仍为 true：from/to 共用同一份名单，关掉会连带废掉来源侧 `'main'`
        //（`askDirector` 一类只读兼容调用）。
        // 返回体只表达「有没有被接受」；同步抛错才算失败。
        //
        // 投递的**异步拒绝留痕**：投递通道的返回值是 promise（真实现里
        // 目标那一轮 LLM 报错会走 reject）。挂空处理器能避免 unhandled rejection，但**零痕迹**——
        // 单条投递失败时调用方只看到「已发出」，查不出是哪条没送到。故统一走这一个口：**带消息 id
        // 与目标名**的 console.warn。返回值语义不变（成功仍按「投递调用已发出」计）。
        function _noteDeliverFailure(p, msgId, who) {
            if (!p || typeof p.then !== 'function') return;
            p.then(null, function (e) {
                console.warn('[Agent] 团队投递失败（消息 ' + msgId + ' → ' + who + '）: '
                    + String((e && e.message) || e));
            });
        }

        function _deliver(req) {
            if (typeof teamSessionId !== 'string' || !teamSessionId) {
                return { ok: false, reason: 'not_team', message: '团队会话未建立（发消息需要它定位工作区）。' };
            }
            var item = req && req.item;
            var targetId = (item && item.to) || '';
            if (targetId === 'main') {
                // 主通道已移除：不静默改投、不回落任何 lane。
                return {
                    ok: false, reason: 'main_removed',
                    message: '团队主通道已移除：没有名为 main 的收件人。可用目标：'
                        + _laneLabelList() + '（主 Agent 通道已不存在，历史调用不会送达）。'
                };
            }
            var rt = targetId ? getLane(targetId) : null;
            if (!rt) return { ok: false, reason: 'no_controller', message: '目标 Agent 的 runtime 不在了。' };
            var c = rt.controller;
            if (!c || typeof c.injectSystemMessage !== 'function') {
                return { ok: false, reason: 'no_controller', message: '目标 Agent 的 injectSystemMessage 通道不存在。' };
            }
            try {
                var p = c.injectSystemMessage(req.text, null, teamSessionId, req.detail);
                // 被接受之后的失败（目标 lane 当前轮 LLM 报错等）**不回退成 queued**：消息已经进了
                // 目标 lane 的上下文（injectSystemMessage 先 addMessage 再跑轮次），重投就是重复注入。
                // 拒绝处理与 main 那条腿**同源**（低-8）：不静默、不留 unhandled rejection。
                _noteDeliverFailure(p, item.id, targetId);
                return { ok: true };
            } catch (e) {
                return { ok: false, reason: 'error', message: String((e && e.message) || e) };
            }
        }

        // ── 团队消息（统一入口）──────────────────────────────
        // **一条通道**：`sendMessage({from, to, message})` —— 谁能给谁发消息只有这一个答案。
        // `from`/`to` 都是**名字**：三条 lane 的 id、或 `'main'`（面板上的主 Agent）。
        // 旧的三件工具（dispatch_task / ask_director）只是它的别名，各差一次字段改名：
        //   dispatch_task(from,to,summary) → sendMessage({from,to,message:summary})
        //   ask_director(message)         → sendMessage({from:'main', to:'director', message})
        // 校验/建记录/投递一次全在 team/dispatch.js（纯逻辑、依赖全注入）；这里只把工厂缺席翻译成
        // 可判定的失败体，并把 `'main'` 并进合法的来源与目标。
        function sendMessage(req) {
            var table = _dispatchTable();
            if (!table) {
                return {
                    ok: false,
                    reason: 'error',
                    message: '团队消息逻辑未装配：team/dispatch.js 未加载或创建失败'
                        + (dispatchBroken ? ('（' + dispatchBroken + '）') : '（AEAgentTeam.createDispatch 缺席）')
                };
            }
            var r = req || {};
            return table.dispatch({
                from: r.from,
                to: r.to,
                // 兼容两种调用名：message 是正名，summary 是派单时代的旧名
                summary: (typeof r.message === 'string') ? r.message : r.summary
            });
        }

        function dispatchTask(req) {
            var r = req || {};
            return sendMessage({ from: r.from, to: r.to, message: r.summary });
        }

        // ── 完成回投：**已下线**──────────────────────────
        // 目标 lane 忙→闲时**不再**把它的「最后一条 assistant 文本」回投给发起方：
        //   · 回投让每条消息都长出一条自动答复，两条 Agent 互相派单时会自动往返，白烧 token；
        //   · 目标 lane 忙成一串时，全部在途记录会在一次忙→闲里批量结算，每条都拿同一条文本，
        //     一段结论被复制 N 份（真机会话实证：7 + 3 张同文卡）。
        // 现在的闭环：派单文本要求目标**完成后自己 send_message 回报发起方**（见 dispatch.js 的
        // buildDispatchText）；结论不再经过编排面。故本文件不再持有在途表，也不再暴露
        // noteLaneIdle / pendingDispatches 两个口。
        // 仍保留 _laneLabelOf：拒绝 main_removed 时的「可用目标」列表要用「名（id）」的人话。
        function _laneLabelOf(id) {
            var defs = null;
            try { defs = _laneDefs(); } catch (_) { defs = null; }
            if (defs && defs.length) {
                for (var i = 0; i < defs.length; i++) {
                    if (defs[i] && defs[i].id === id) return defs[i].label || id;
                }
            }
            return String(id || '');
        }
        // 可用目标列表（main_removed 的文案要列出真实可用的 lane，模型据此改参数重试）。
        function _laneLabelList() {
            var defs = null;
            try { defs = _laneDefs(); } catch (_) { defs = null; }
            if (!defs || !defs.length) return '（团队定义未加载）';
            var out = [];
            for (var i = 0; i < defs.length; i++) {
                var d = defs[i] || {};
                if (!d.id) continue;
                out.push(d.label ? (d.label + '（' + d.id + '）') : String(d.id));
            }
            return out.join('、') || '（团队定义未加载）';
        }

        // 主 Agent → 导演：`sendMessage` 的别名（已并入统一通道）。
        // 保留这个名字是因为工具层与测试都按它取值；实现一条都不重复。
        function askDirector(req) {
            var r = req || {};
            return sendMessage({ from: 'main', to: 'director', message: r.message });
        }

        // ── 子 Agent ────────────────────────────────────
        // 本文件**只有两个消费点**（公开面一个方法都不加）：
        //   ① 任务板快照的 subagents 段 = pool.list()（**一份数据**，不在这里再算一份）；
        //   ② 停止级联 stopLane → stopForParent / stopAll → stopAll。
        // 池的状态机、并发闸、保活、id 规则全在 team/subagent.js 那一份里；这里一条都不复制
        //（复制 = 两处判据，任务板显示「在跑」而池里已经回收了之类）。
        // 三处调用全部 try/catch：任务板/停止链不能因为池的一个异常整块失败（那是把子 Agent 的
        // 缺陷放大成「团队面板白屏」或「全停失效」）。失败经 warn 显式留痕，不静默。
        function _subagents() {
            return (o.subagents && typeof o.subagents === 'object') ? o.subagents : null;
        }

        // 保活回收的**懒触发点**（releaseExpired 由调用方在快照读取时触发，池不自建定时器）。
        // 幂等：池内部若已在 list()/ask() 里回收过，这里再调一次不会重复计数。
        function _releaseSubagents() {
            var pool = _subagents();
            if (!pool || typeof pool.releaseExpired !== 'function') return;
            try { pool.releaseExpired(); } catch (e) {
                console.warn('[Agent] 子 Agent 保活回收失败（任务板继续读状态）: ' + String((e && e.message) || e));
            }
        }

        function _subagentList() {
            var pool = _subagents();
            if (!pool || typeof pool.list !== 'function') return [];
            _releaseSubagents();
            try {
                var rows = pool.list();
                return (rows && rows.length) ? rows : [];
            } catch (e) {
                console.warn('[Agent] 子 Agent 列表读取失败（本帧按空段渲染）: ' + String((e && e.message) || e));
                return [];
            }
        }

        // 停止返回体的计数口径：契约是 `{ ok, stopped:[id], released:n }`，故按**数组长度**计；
        // 同时认数字形态（池若自报条数就不必为了本文件把数组补出来）——两种形态都是「本次新停的
        // 条数」，取不到一律 0（宁可少报，不编一个数：谎报会让「父停 → 子全停」在任务板上看不出漏）。
        function _stoppedCount(res) {
            if (!res) return 0;
            var st = res.stopped;
            if (typeof st === 'number' && isFinite(st)) return st;
            if (st && typeof st.length === 'number') return st.length;
            return 0;
        }

        // 父 lane 停止 → 它派生的子 Agent 全停（含 queued）。返回**本次新停的条数**（池自报）。
        // 池缺席 / 没有这个能力 ⇒ 0：没有池就是没有子 Agent，如实报 0 而不是编一个数。
        function _stopSubagentsForLane(laneId) {
            var pool = _subagents();
            if (!pool || typeof pool.stopForParent !== 'function') return 0;
            try {
                return _stoppedCount(pool.stopForParent(laneId));
            } catch (e) {
                console.warn('[Agent] 子 Agent 级联停止失败（lane=' + laneId + '）: ' + String((e && e.message) || e));
                return 0;
            }
        }

        // 全停时**再补一次** stopAll：stopLane 的遍历只覆盖 _laneIds()，定义源异常时碰不到的 lane
        // 派生的子 Agent 会漏掉（「全部停止」是更强的用户意图）。
        // 幂等：上面已停的不会被重复计数，返回值即本次真正新停的条数。
        function _stopAllSubagents() {
            var pool = _subagents();
            if (!pool || typeof pool.stopAll !== 'function') return 0;
            try {
                return _stoppedCount(pool.stopAll());
            } catch (e) {
                console.warn('[Agent] 子 Agent 全停失败: ' + String((e && e.message) || e));
                return 0;
            }
        }

        // 任务板快照（字段即契约）。
        // items 段已**下线**：派单不再有状态机，工作项表没有消费者
        //（派单退化成一次投递，结论由对方自己 send_message 回来），所以快照里只剩 lanes 与 subagents 两段。
        // subagents 段：**接 pool.list()**，同款「一份数据」——状态机、并发闸、
        // 保活回收全在池里，这里只做转发（顺带触发一次保活回收的懒推进）。
        // 池缺席 ⇒ 空数组（不是 undefined）：渲染侧不必写「字段有没有」的防御分支。
        // lanes 段在 start 之前也可读（只装配未启动时三条都是 idle）——任务板 tab
        // 会在装配完成前就被点开。
        // 「本 lane 在跑的子 Agent 数」——快照要求的字段。
        // **判据只有一份**：`taskBoard.SUBAGENT_ACTIVE_STATES`（由 taskBoard.js 导出，与状态文案、
        // `isSubagentActive` 同处）。本文件**不再写第三份 state 名单**（
        // 硬编码 queued/running/waiting 三态白名单会与
        // `isSubagentActive` 的 `String()` 归一语义分叉）。
        // 注：**UI 的计数格读的是 taskBoard 那条路**（见其 `_countSubagentsForLane`），本函数产出的
        // `lanes[].subagentCount` 只服务直接读编排面快照的调用方；两处同源同判据。
        function _activeSubagentCounts() {
            var out = {};
            var rows = _subagentList();
            var teamApi = global.AEAgentTeam || {};
            var isActive = (typeof teamApi.isSubagentActive === 'function') ? teamApi.isSubagentActive : null;
            var table = (teamApi.SUBAGENT_ACTIVE_STATES && typeof teamApi.SUBAGENT_ACTIVE_STATES === 'object')
                ? teamApi.SUBAGENT_ACTIVE_STATES : null;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i] || {};
                var lane = r.parentLane;
                if (!lane) continue;
                var active = false;
                try {
                    if (isActive) active = !!isActive(r);
                    // 判据面缺席（taskBoard 未加载）：**复用同一张表的导出**，绝不自己再列一遍
                    else if (table) active = table[String(r.state)] === true;
                } catch (_) { active = false; }
                if (active) out[lane] = (out[lane] || 0) + 1;
            }
            return out;
        }

        function getBoardSnapshot() {
            var defs = _laneDefs();
            var byId = {};
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].id) byId[defs[i].id] = defs[i];
            }
            var ids = _laneIds();
            var clock = _now();
            var subCounts = _activeSubagentCounts();   // 一份判据：池的行 + taskBoard.isSubagentActive
            var rows = [];
            for (var j = 0; j < ids.length; j++) {
                var id = ids[j];
                var rt = runtimes[id] || null;
                var def = byId[id] || (rt && rt.def) || null;
                var s = deriveLaneStatus(rt, clock);
                rows.push({
                    id: id,
                    label: (def && def.label) || id,   // 定义缺席时用 id 兜底：宁可显示 id，不可缺口
                    status: s.status,
                    busyText: s.busyText,
                    toolName: s.toolName,
                    elapsedMs: s.elapsedMs,
                    // 在跑子 Agent 数：**按 pool 现算**（runtime.subagents 恒 0）
                    subagentCount: subCounts[id] || 0
                });
            }
            return { lanes: rows, subagents: _subagentList() };
        }

        // 公开面 = 冻结契约（15 个：方法名、签名与相对顺序一字不动）+ 两处扩展：
        // dispatchTask 与 noteTeamSessionId。
        // **只加不动**要能被一眼核对——已有的 15 行一个字符都没挪。
        // 一次**有意收缩**：listDispatchItems 随任务板 items 段一起下线
        //（派单不再有状态机，那张表没有消费者）——这是对「只加不动」的显式修订，不是漂移。
        // 第二次收缩：noteLaneIdle 与 pendingDispatches 随**完成回投下线**一起删除
        //（结论改由发起方在派单文本里要求对方完成后自己 send_message 回来；在途表没有消费者了）。
        return {
            start: start,
            dispose: dispose,
            getLane: getLane,
            lanes: lanes,
            getCurrentLane: getCurrentLane,
            setCurrentLane: setCurrentLane,
            isCurrentLane: isCurrentLane,
            stopLane: stopLane,
            stopAll: stopAll,
            getBoardSnapshot: getBoardSnapshot,
            bindSession: bindSession,
            createTeamSession: createTeamSession,
            switchTeamSession: switchTeamSession,
            renameTeamSession: renameTeamSession,
            deleteTeamSession: deleteTeamSession,
            dispatchTask: dispatchTask,
            // 绑定镜像的显式落值口（binder 的 onBoundChange 用；见实现处注释）
            noteTeamSessionId: noteTeamSessionId,
            // 主 Agent → 导演通道
            askDirector: askDirector,
            // 团队消息统一入口（send_message 的落点；上面两个是它的别名）
            sendMessage: sendMessage
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createOrchestrator = createOrchestrator;
    // 状态推导单列导出：任务板（taskBoard.js）与单测直驱同一条判据，避免各写一份后漂移。
    global.AEAgentTeam.deriveLaneStatus = deriveLaneStatus;
})(typeof window !== 'undefined' ? window : globalThis);
