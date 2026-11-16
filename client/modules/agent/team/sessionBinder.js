(function (global) {
    'use strict';
    // 团队模式的**团队会话绑定器**：三条常驻 lane
    // （director / ae-exec / glsl）共用**一个**团队会话——「整队切换」的唯一下发口。
    //
    // 职责边界（越界就会与引擎装配面打架，每条都与同目录 orchestrator.js 的口径一致）：
    //   · **本文件不做 IO、不摸 DOM、不建 cm / controller / store**。会话文件与索引全在
    //     各 lane 的 sessionStore 里；切换动作经注入的 lane controller（即
    //     controller.adoptSession 的六步）完成，改名 / 删除经注入的 lane store 完成。
    //   · **不自造 id 规则之外的东西**：唯一的 id 规则是 team_<时间戳>_<随机段>（
    //     与 store.createSession() 的 sess_ 同族——id 唯一是 _deletedIds 防复写的前提，
    //     见 sessionStore.js 内 _deletedIds 的注释）。
    //   · **六个方法全部同步返回普通对象**（不是 Promise）：orchestrator 的 _sessionCall
    //     （orchestrator.js:203-225）按 `typeof res.ok === 'boolean'` 判成败，返回 Promise 会被
    //     判成 no_result（于是每次会话操作在 UI 上都显示失败）。因此注入的 lane 动作也必须是
    //     **同步**的：返回 thenable 视为接线错误（reason:'async_unsupported'，并吞掉它的
    //     rejection 防未处理拒绝）。改名 / 删除本身是异步 IO（store.renameSession /
    //     store.deleteSession 返回 promise）：**同步判据**（缺能力 / 会话不存在）先判并立即返回，
    //     异步完成结果挂在返回体的 done 上，失败经 _warn 留痕（不静默）。
    //
    // DI 契约（全部可选；缺能力一律显式失败，不抛。注入项按**调用时**读取）：
    //   lanes             — lane 定义访问器，须有 list()（返回 [{ id, … }]）；有 get(id) 时用它校验存在性。
    //                       **注意**：lanes.js 的 listIds() 返回的是**容器 DOM id**（lanes.js:138-142），
    //                       不是 lane id——本文件只用 list() 的 id 字段（用错会让每条 lane 都被归因 unknown_lane）。
    //                       缺省回落 global.AEAgentTeam.lanes。
    //   getLaneController — (id) => controller；或 controllers: { id: controller }
    //   getLaneStore      — (id) => store；或 stores: { id: store }（缺省还会试 controller.getActiveStore()）
    //   getLaneFlags      — (id) => { busy, restoring, switching }（可选；不注入时从 controller 的
    //                       **真实公开面**读：isBusy() / getState() 的 busy 与 restoring /
    //                       真的暴露了 isSwitching()|getSwitching() 时才读它）
    //   getLaneState      — (id) => state（可选；缺省 controller.getState()）
    //   stopAll           — () => …，团队全停（orchestrator.stopAll 的注入；缺省逐 lane 调
    //                       controller.requestStop()）。返回体里有 stopped / failed 时如实透出。
    //   getActiveAbort    — (id) => AbortController|null（可选；缺省读 controller.activeAbortController）。
    //                       只用于「下发停止后仍有在途未 abort」的如实上报（不阻断切换，见 _stopPhase）。
    //   switchLane        — (id, sid, rt) => { ok, reason? }，单 lane 的切换动作（可选；缺省用
    //                       controller.adoptSession(sid)）。真机两条指同一条链，测试用假 controller 即可。
    //   removeWorkspace   — (sid) => …（可选）：删除会话时同步工作区目录（计划 Task 9 的
    //                       removeDirRecursive 既有**确认语义在 UI 层**；本文件只下发，结果进 done）。
    //                       未注入 = 不删（workspace 目前只读，写面接上时注入即可）。
    //   onBoundChange     — (sid|null) => void（可选）：**绑定变化的唯一通知口**。
    //                       每个公开动作返回之前调一次（bind/create/switch/delete/noteRestored）；
    //                       宿主据此同步自己的会话镜像（orchestrator 的 teamSessionId 与
    //                       bootstrap 的 _teamSessionId）。为什么必须由 binder 通知：真机 UI 的
    //                       会话删除是 `binder.deleteTeamSession` **直调**（不经过 orchestrator），
    //                       把镜像跟随挂在 orchestrator 包装层上是死代码 ⇒ 删当前会话后派单会拿
    //                       已删 id 投递并被 apiContext 静默丢弃。回调抛错只告警，不打穿会话操作。
    //   onWarn / log      — 告警通道（缺省 console.warn；注入方抛错被吞掉，告警不打穿调用链）
    //   now               — () => ms（id 时间戳；单测注入固定钟可精确断言）
    //
    // 失败归因（**全部显式返回 { ok:false, reason:… }，不抛、不静默假装成功**）：
    //   bad_sid      sid 不是合法 id（空串 / 含路径分隔符 / 含 ..——store 用 sid 直接拼文件名，
    //                越界 id 会写到 sessions/<mode>/ 之外）
    //   no_lanes     拿不到任何 lane（lanes 未注入且全局命名空间里也没有）
    //   unknown_lane lanes.get(id) 认不出这个 id
    //   no_controller / no_store   该 lane 没有可用的 controller / store
    //   not_wired    该 lane 既没有注入 switchLane，controller 上也没有 adoptSession
    //                （detail:'no_stop' 表示：它还有在途 AbortController，却没有停止能力——
    //                 此时切走必然违反「旧 lane 已 abort」，故**在动手前**就拒绝）
    //   busy         预检命中：任一 lane busy / 正在跑启动恢复链（state.restoring，bootstrap 的
    //                `_setRestoringAll` 写进每条 runtime）/ 自报在切会话，
    //                或**本 binder 自己**有一次整队切换没收尾 —— **零副作用**返回
    //                （不停止、不 adopt、不写 store；测试用调用计数钉住）
    //                对外出口：binder.isSwitching() / getSwitching()（供 teamUI.anyLaneLocked 用）
    //   async_unsupported 注入的 lane 动作返回 thenable（无法据返回值判定成败，也就无法回滚）
    //   partial      逐 lane 执行中途失败：已切成功的 lane 已回切到**它自己**切换前的 sid，
    //                返回体带 rolledBack / rollbackFailed / failed / switched
    //   unknown_session / bad_title   改名 / 删除的同步判据（改名要求三条 lane 都有这条会话）
    //   not_adopted  noteRestoredSession 的同步判据：三条 lane **并不都**在这条会话上
    //                （cm 的 sessionId 对不上，或某条 lane 的 store 索引里没有它）——零副作用返回
    //
    // 语义：
    //   · newTeamSessionId()   team_<时间戳>_<随机段>；同实例内不自撞（_issued 兜底重掷，见实现）。
    //   · 切换  预检（结构缺能力 > busy）→ 停止（stopAll / 逐 lane requestStop）→ 逐 lane 执行
    //          → **按每条返回值**判定；任一条失败即回滚已切成功的 lane，整体 reason:'partial'。
    //   · 绑定  = 同一个切换动作，但幂等：已绑定且三条 lane 都真的在这个会话上（cm 的 sessionId
    //          与 store 索引都能确认）时直接返回 { ok:true, changed:false }，不做任何 IO——
    //          orchestrator 明确不替 binder 判重（orchestrator.js:313-317），重复 start(同一 sid)
    //          是正常路径；只比「记住的 sid」会把「上次绑成功、某条 lane 后来漂走」一起跳过。
    //   · 认领  noteRestoredSession(sid) = **只认领既成事实**，与「绑定」的分工：
    //          绑定是「下发切换再 adopt」，认领是「三条 lane 已经在它上面了，记住它」。
    //          面板重载后各 lane 各自消费自己的 lastActiveId（bootstrap 的 _restoreTeamLanes），
    //          currentSid 却随进程清空 ⇒ 认领是重载后的**首选**出口；认领不可用（首启/三条分叉/
    //          复核不通过）时由 bootstrap 恢复链链尾的 _ensureTeamSessionBound 兜底建立/绑回

    //          adoptSession 自带 updateLastActive 外，本文件在每条 lane 切成功后
    //          adoptSession 自带 updateLastActive 外，本文件在每条 lane 切成功后
    //          **再兜底调一次** store.updateLastActive(sid)（幂等）——契约守卫放在 binder 层，
    //          不依赖各 lane 的实现细节。
    //   · 删除  **统一判定**：直接调各 lane 的 store.deleteSession，绕开 controller.deleteSession
    //          里的 per-store last_one 判据（实测 controller.js:2849-2851，位于 deleteSession:2837）——
    //          那对「三条 lane 同时删」是错的判据（整队删空仍是合法态），不绕开则「三条各只剩
    //          一个会话」时删除永远被第一条 lane 拦下。返回体如实透出每条 lane 的失败原因。
    //          删的是**当前绑定**的那条 ⇒ **先整队切走**（或新建一条）**再删**，切换失败
    //          （busy / partial）即拒绝删除、零删除返回——顺序反了会让三条 lane 搁浅在已删 id 上，
    //          之后的消息被 store 的防复写静默丢弃（真机数据丢失路径，见 deleteTeamSession）。
    //          成功体多一个 switchedTo（= 整队落到的那条；没切则不带这个字段）。
    //   · 停当前 lane 的对话不被本文件破坏：预检为零副作用、回滚不碰「没做任何事」的失败 lane。

    function _errText(e) {
        return String((e && e.message) || e);
    }

    // 告警通道：opts.onWarn → opts.log → console.warn（缺省）。注入方抛错吞掉（同 sessionStore 口径）。
    function _mkWarn(opts) {
        var sink = (typeof opts.onWarn === 'function') ? opts.onWarn
            : ((typeof opts.log === 'function') ? opts.log : null);
        if (!sink) return function (msg) { console.warn(msg); };
        return function (msg) { try { sink(msg); } catch (_) {} };
    }

    // 合法 sid：store 用 sid 拼文件名（sessions/<mode>/<sid>.json），越界 id 会写出目录之外。
    // 团队 id 由 newTeamSessionId() 产出（[A-Za-z0-9_]），这条白名单对它零影响。
    function _validSid(sid) {
        return typeof sid === 'string' && /^[A-Za-z0-9_-]+$/.test(sid);
    }

    // 逐个方法读「是不是开着」：方法优先（isBusy/isSwitching…），其次 state 字段，其次 controller 字段。
    // **只认真实存在的信号**：真 controller 的公开面（controller.js 的 api）只有
    // `isBusy()` 与 `getState()`，而 `getState()` 给的是 state 本体（含 `busy` / `restoring`）。
    // `stopping` 与 `switching` 是 controller 的**闭包内私有态**（只注入给 inputDispatch / apiActions），
    // 公开面上**没有** `isStopping/getStopping/isSwitching/getSwitching` ⇒ 早先按它们判等于判一条
    // 恒 false 的腿，「切换期间上锁」那条防线在真机上根本不存在。现在改用：
    //   · busy      — 真 `state.busy` / `isBusy()`；
    //   · restoring — 真 `state.restoring`（启动恢复链在跑，bootstrap 的 _setRestoringAll 写它）；
    //   · switching — 仅当 controller **真的**暴露了 `isSwitching()/getSwitching()` 时才读
    //                 （可选能力：注入方/将来的 controller 给了就生效，没有就不编造）。
    // 本 binder 自己的在途位见 _switchAll 的 `switching`（对外可查，见 isSwitching）。
    function _flagOf(ctl, st, methods, fields) {
        for (var i = 0; i < methods.length; i++) {
            if (ctl && typeof ctl[methods[i]] === 'function') {
                try { return !!ctl[methods[i]](); } catch (_) { break; }
            }
        }
        for (var j = 0; j < fields.length; j++) {
            if (st && st[fields[j]] !== undefined) return !!st[fields[j]];
            if (ctl && ctl[fields[j]] !== undefined) return !!ctl[fields[j]];
        }
        return false;
    }

    function _idsOf(items) {
        var out = [];
        for (var i = 0; i < items.length; i++) out.push(items[i].id);
        return out;
    }

    // lanes.list() 的两种形态都认：字符串数组 / 定义对象数组（lanes.js 的 list() 是后者）
    function _idsOfDefs(defs) {
        var out = [];
        if (!Array.isArray(defs)) return out;
        for (var i = 0; i < defs.length; i++) {
            var d = defs[i];
            if (typeof d === 'string' && d) out.push(d);
            else if (d && typeof d.id === 'string' && d.id) out.push(d.id);
        }
        return out;
    }

    function createSessionBinder(opts) {
        var o = opts || {};
        var warn = _mkWarn(o);
        var clock = (typeof o.now === 'function') ? o.now : function () { return Date.now(); };
        var currentSid = null;   // 当前绑定的团队会话 id（只在切换/绑定**成功后**落值）
        var issued = {};         // 本实例已发出的 id（防同实例内自撞；见 newTeamSessionId）
        var issuedSeq = 0;       // 随机段落耗尽时的确定性兜底序号
        // 整队切换**在途位**（重入守卫 + 对外可查的「正在切换」判据）：
        //   · 内部：注入的 lane 动作/停止钩子在执行中若回调本对象的任何公开动作，直接被拒 busy；
        //   · 对外：`isSwitching()` / `getSwitching()`（teamUI.anyLaneLocked 用它把「切换窗口」算进锁态
        //     ——真 controller 的 `_switching` 没有公开出口，唯一真相在本文件）。
        // 诚实说明**窗口的长度**：_switchAll 本身是同步的（契约要求），所以这个位只在
        // 「同步调用栈内部」为真——可被 re-entrant 的调用方观测（注入的 stopAll / switchLane 钩子、
        // 同一次调用里回调本对象的宿主代码），跨事件循环的观察者读到的总是 false。
        var switching = false;

        // ── 依赖解析（缺省回落全局命名空间，与 orchestrator.js / lanes.js 同一套口径）──────
        function _lanesApi() {
            if (o.lanes) return o.lanes;
            return (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
        }

        function _laneIds() {
            var api = _lanesApi();
            if (!api) return o.controllers ? Object.keys(o.controllers) : [];
            if (Array.isArray(api)) return _idsOfDefs(api);
            if (typeof api.list === 'function') {
                try { return _idsOfDefs(api.list()); } catch (e) {
                    warn('[SessionBinder] lanes.list() 抛错，无法枚举 lane: ' + _errText(e));
                    return [];
                }
            }
            return o.controllers ? Object.keys(o.controllers) : [];
        }

        function _laneDef(id) {
            var api = _lanesApi();
            if (api && !Array.isArray(api) && typeof api.get === 'function') {
                try { return api.get(id) || null; } catch (_) { return null; }
            }
            return null;
        }

        function _controllerOf(id) {
            if (typeof o.getLaneController === 'function') {
                try { var c = o.getLaneController(id); if (c) return c; } catch (_) { /* 回落下面的来源 */ }
            }
            if (o.controllers && o.controllers[id]) return o.controllers[id];
            var d = _laneDef(id);
            if (d && d.controller) return d.controller;
            return null;
        }

        function _storeOf(id) {
            if (typeof o.getLaneStore === 'function') {
                try { var s = o.getLaneStore(id); if (s) return s; } catch (_) { /* 回落下面的来源 */ }
            }
            if (o.stores && o.stores[id]) return o.stores[id];
            var c = _controllerOf(id);
            // 真 controller 的会话 store 出口（controller.js:3660 getActiveStore）
            if (c && typeof c.getActiveStore === 'function') {
                try { var st = c.getActiveStore(); if (st) return st; } catch (_) { /* 继续回落 */ }
            }
            var d = _laneDef(id);
            if (d && d.store) return d.store;
            return null;
        }

        function _stateOf(id, c) {
            if (typeof o.getLaneState === 'function') {
                try { var s0 = o.getLaneState(id); if (s0) return s0; } catch (_) { /* 回落 */ }
            }
            var ctl = c || _controllerOf(id);
            if (!ctl) return null;
            if (typeof ctl.getState === 'function') {
                try { var s1 = ctl.getState(); if (s1) return s1; } catch (_) { /* 回落 */ }
            }
            return ctl.state || null;
        }

        function _flagsOf(id, c) {
            var f = { busy: false, restoring: false, switching: false };
            if (typeof o.getLaneFlags === 'function') {
                var injected = null;
                try { injected = o.getLaneFlags(id); } catch (_) { injected = null; }
                if (injected && typeof injected === 'object') {
                    f.busy = !!injected.busy;
                    f.restoring = !!injected.restoring;
                    f.switching = !!(injected.switching || injected._switching);
                    return f;
                }
            }
            var ctl = c || _controllerOf(id);
            var st = _stateOf(id, ctl);
            // 真 controller 的公开面：isBusy / getState().busy+restoring /（真有的话）isSwitching|getSwitching。
            // `switching` **不**读 state/controller 的同名字段：真机没有这个字段，读它等于判一条恒 false
            // 的腿（假绿）。真值是本 binder 的在途位（见 _busyLanes）。
            f.busy = _flagOf(ctl, st, ['isBusy'], ['busy']);
            f.restoring = _flagOf(ctl, st, [], ['restoring']);
            f.switching = _flagOf(ctl, st, ['isSwitching', 'getSwitching'], []);
            return f;
        }

        function _activeAbortOf(id, c) {
            if (typeof o.getActiveAbort === 'function') {
                try { var a = o.getActiveAbort(id); if (a) return a; } catch (_) { /* 回落 */ }
            }
            var ctl = c || _controllerOf(id);
            return (ctl && ctl.activeAbortController) ? ctl.activeAbortController : null;
        }

        function _laneSessionId(id, c) {
            var ctl = c || _controllerOf(id);
            if (!ctl) return null;
            if (typeof ctl.getSessionId === 'function') {
                try { var v = ctl.getSessionId(); if (typeof v === 'string' && v) return v; } catch (_) { /* 回落 */ }
            }
            if (typeof ctl.getActiveCm === 'function') {
                try {
                    var cm = ctl.getActiveCm();
                    if (cm && typeof cm.getSessionId === 'function') {
                        var s = cm.getSessionId();
                        if (typeof s === 'string' && s) return s;
                    }
                } catch (_) { /* 回落 */ }
            }
            return null;
        }

        // 单 lane 的切换动作：注入的 switchLane 优先，其次 controller.adoptSession（真机形态）。
        // 两者都没有 ⇒ null（归因 not_wired）。返回的是闭包，调用时才知道具体 lane。
        function _actionOf(id, c) {
            if (typeof o.switchLane === 'function') {
                return function (sid) { return o.switchLane(id, sid, { lane: id, controller: c }); };
            }
            if (c && typeof c.adoptSession === 'function') {
                return function (sid) { return c.adoptSession(sid); };
            }
            return null;
        }

        function _canStop(c) {
            return typeof o.stopAll === 'function' || !!(c && typeof c.requestStop === 'function');
        }

        function _swallowThenable(res) {
            if (res && typeof res.then === 'function') {
                try { res.then(null, function () {}); } catch (_) { /* 与本次调用无关 */ }
            }
        }

        // 注入动作的返回值归一（口径同 orchestrator._sessionCall：必须自报布尔 ok；
        // 「什么都没说」（undefined / 非对象 / 没有 ok 字段）一律按失败——会话没切却当成功，
        // 真机表现为消息继续写进旧会话）
        function _normalizeAction(res) {
            if (res === true) return { ok: true, reason: '' };
            if (!res || typeof res !== 'object') return { ok: false, reason: 'no_result' };
            if (typeof res.ok !== 'boolean') return { ok: false, reason: 'no_result' };
            return { ok: res.ok, reason: res.reason || (res.ok ? '' : 'error') };
        }

        function _callAction(item, sid) {
            var res;
            try { res = item.action(sid); } catch (e) {
                return { ok: false, reason: 'error', error: _errText(e) };
            }
            if (res && typeof res.then === 'function') {
                // 同步契约下无法据它判成败（也就无法回滚）：如实归因，并吞掉 rejection
                _swallowThenable(res);
                return { ok: false, reason: 'async_unsupported' };
            }
            return _normalizeAction(res);
        }

        // ── 预检：结构缺能力（unknown_lane / no_controller / not_wired）──────────────
        // 一律**在动手之前**判定：任一条不满足就零副作用返回（不停止、不 adopt、不写 store）。
        // 结构问题优先于 busy：controller 都没有的 lane，判它忙不忙没有意义。
        function _buildPlan() {
            var ids = _laneIds();
            if (!ids.length) return { error: { ok: false, reason: 'no_lanes' } };
            var api = _lanesApi();
            var canCheckDef = !!(api && !Array.isArray(api) && typeof api.get === 'function');
            var plan = [];
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                if (canCheckDef && !_laneDef(id)) {
                    return { error: { ok: false, reason: 'unknown_lane', lane: id, lanes: ids } };
                }
                var c = _controllerOf(id);
                if (!c) return { error: { ok: false, reason: 'no_controller', lane: id, lanes: ids } };
                var action = _actionOf(id, c);
                if (!action) return { error: { ok: false, reason: 'not_wired', lane: id, lanes: ids } };
                // 有在途 AbortController 却没有停止能力：切走后旧 lane 无法 abort
                if (!_canStop(c) && _activeAbortOf(id, c)) {
                    return { error: { ok: false, reason: 'not_wired', lane: id, detail: 'no_stop', lanes: ids } };
                }
                plan.push({ id: id, controller: c, store: _storeOf(id), action: action });
            }
            return { plan: plan, ids: ids };
        }

        function _busyLanes(plan) {
            var out = [];
            // **本 binder 自己的在途位**先算：整队切换没收尾时，任何再进来的会话动作都必须被拒
            //（真 controller 侧的 `_switching` 没有公开出口，「切换期间上锁」的唯一真相在这里）。
            if (switching) out.push('binder');
            for (var i = 0; i < plan.length; i++) {
                var f = _flagsOf(plan[i].id, plan[i].controller);
                if (f.busy || f.restoring || f.switching) out.push(plan[i].id);
            }
            return out;
        }

        function _prevSidOf(item) {
            var s = _laneSessionId(item.id, item.controller);
            if (s) return s;
            var st = item.store;
            if (st && typeof st.getLastActiveId === 'function') {
                try { var v = st.getLastActiveId(); if (typeof v === 'string' && v) return v; } catch (_) { /* 拿不到就是拿不到 */ }
            }
            return null;
        }

        // ── 停止阶段（切走前把旧会话上在跑的轮次停掉）────────────────────────────
        // 注入的 stopAll 优先（orchestrator.stopAll：全停 + 清注入队列），否则逐 lane
        // controller.requestStop()。**尽力而为但不静默**：下发后仍活着（signal 未 abort）的
        // 在途 controller 如实记进 live 并由调用方告警——真机上 requestStop 的 abort 是异步
        // 收尾（等当前轮让出），此处不据此判失败（否则每次切换都会误报失败）。
        function _stopPhase(plan) {
            var out = { dispatched: [], failed: [], live: [] };
            if (typeof o.stopAll === 'function') {
                var res;
                try { res = o.stopAll(); } catch (e) {
                    out.failed.push({ lane: '*', reason: 'error', error: _errText(e) });
                    _collectLive(plan, out);
                    warn('[SessionBinder] stopAll() 抛错，停止可能未下发: ' + _errText(e));
                    return out;
                }
                _swallowThenable(res);
                if (res && typeof res === 'object') {
                    if (Array.isArray(res.stopped)) out.dispatched = res.stopped.slice();
                    if (Array.isArray(res.failed) && res.failed.length) out.failed = res.failed.slice();
                }
                if (!out.dispatched.length) out.dispatched = _idsOf(plan);
                _collectLive(plan, out);
                return out;
            }
            for (var i = 0; i < plan.length; i++) {
                var it = plan[i];
                if (!it.controller || typeof it.controller.requestStop !== 'function') {
                    out.failed.push({ lane: it.id, reason: 'no_controller' });
                    continue;
                }
                try { it.controller.requestStop(); out.dispatched.push(it.id); } catch (e) {
                    out.failed.push({ lane: it.id, reason: 'error', error: _errText(e) });
                }
            }
            _collectLive(plan, out);
            return out;
        }

        function _collectLive(plan, out) {
            for (var i = 0; i < plan.length; i++) {
                var a = _activeAbortOf(plan[i].id, plan[i].controller);
                if (a && a.signal && a.signal.aborted !== true) out.live.push(plan[i].id);
            }
        }

        // ── 回滚：把已切成功的 lane 回切到**它自己**切换前的 sid ──────────────────
        // 为什么按 lane 记 prevIds 而不是统一回 prevBound：bind/create 之前可能还没有绑定的
        // 团队会话（prevBound = null），各 lane 各自停在自己的旧会话上——统一回 null 会把它们
        // 切到一个不存在的会话。
        // 失败的 lane 默认**不碰**（busy / not_wired / no_result 都是「它没做任何事」，碰它
        // 反而会打断它正在跑的轮次）；只有 reason === 'error'（动作抛错，可能半途生效）才补一次。
        // 回滚本身失败不静默：记进 rollbackFailed 并告警（此时三条 lane 可能分叉，是必须让
        // 用户/排障看得见的状态）。
        function _rollback(doneItems, prevIds, failedItem) {
            var rolledBack = [];
            var rollbackFailed = [];
            var targets = doneItems.slice();
            if (failedItem && failedItem.reason === 'error') targets.push(failedItem);
            for (var i = 0; i < targets.length; i++) {
                var it = targets[i];
                var prev = prevIds[it.id];
                if (!prev) { rollbackFailed.push({ lane: it.id, reason: 'no_prev_sid' }); continue; }
                var r = _callAction(it, prev);
                if (!r.ok) { rollbackFailed.push({ lane: it.id, reason: r.reason }); continue; }
                _syncLastActive(it, prev);
                rolledBack.push(it.id);
            }
            if (rollbackFailed.length) {
                warn('[SessionBinder] 部分失败回滚未完成，部分 Agent 可能停在不同会话上: '
                    + JSON.stringify(rollbackFailed));
            }
            return { rolledBack: rolledBack, rollbackFailed: rollbackFailed };
        }

        // 契约守卫（幂等）：见文件头「三份索引同步」
        function _syncLastActive(item, sid) {
            var st = item.store;
            if (!st || typeof st.updateLastActive !== 'function') return;
            try { st.updateLastActive(sid); } catch (e) {
                warn('[SessionBinder] store.updateLastActive 抛错（' + item.id + ' → ' + sid + '）: ' + _errText(e));
            }
        }

        // ── 整队切换（唯一的执行体）──────────────────────────────────────────────
        function _switchAll(sid) {
            var built = _buildPlan();
            if (built.error) return built.error;
            var plan = built.plan;
            // ① busy 预检：**零副作用**返回（不停止、不 adopt、不写 store）。
            // 命中面 = 各 lane 的真 busy/restoring/（真暴露时的）switching + 本 binder 的在途位。
            var busy = _busyLanes(plan);
            if (busy.length) return { ok: false, reason: 'busy', lane: busy[0], lanes: busy };
            switching = true;   // 在途位：对 re-entrant 调用方可见（isSwitching/getSwitching）
            try {
                var prevBound = currentSid;
                var prevIds = {};
                for (var p = 0; p < plan.length; p++) prevIds[plan[p].id] = _prevSidOf(plan[p]);
                // ② 停止（旧会话上在跑的轮次先停；busy 预检已经挡掉了「正在忙」的 lane）
                var stop = _stopPhase(plan);
                if (stop.live.length) {
                    warn('[SessionBinder] 已下发停止，但以下 lane 的在途 controller 尚未 abort（不阻断切换，仅留痕）: '
                        + stop.live.join(', '));
                }
                if (stop.failed.length) {
                    warn('[SessionBinder] 停止阶段有 lane 未成功下发: ' + JSON.stringify(stop.failed));
                }
                // ③ 逐 lane 执行，**按每条返回值**判定
                var doneItems = [];
                for (var i = 0; i < plan.length; i++) {
                    var it = plan[i];
                    var r = _callAction(it, sid);
                    if (r.ok) {
                        _syncLastActive(it, sid);
                        doneItems.push(it);
                        continue;
                    }
                    // ④ 失败 ⇒ 回滚已切成功的 lane，整体归因 partial（不吞失败原因）
                    var rb = _rollback(doneItems, prevIds, it);
                    return {
                        ok: false,
                        reason: 'partial',
                        sid: sid,
                        previous: prevBound,
                        failed: [{ lane: it.id, reason: r.reason, error: r.error }],
                        switched: _idsOf(doneItems),
                        rolledBack: rb.rolledBack,
                        rollbackFailed: rb.rollbackFailed,
                        stopped: stop.dispatched,
                        stopFailed: stop.failed
                    };
                }
                // ⑤ 三条 lane 全绿才改绑定
                currentSid = sid;
                return {
                    ok: true,
                    sid: sid,
                    previous: prevBound,
                    changed: prevBound !== sid,
                    lanes: built.ids,
                    stopped: stop.dispatched,
                    stopFailed: stop.failed
                };
            } finally {
                switching = false;
            }
        }

        // ── store 侧动作（改名 / 删除）的公共部分 ────────────────────────────────
        // 与切换不同：这两件事只动索引/文件，不经 controller（删除尤其要**绕开** controller 的
        // per-store last_one 判据，见文件头）。
        function _storePlan() {
            var ids = _laneIds();
            if (!ids.length) return { error: { ok: false, reason: 'no_lanes' } };
            var api = _lanesApi();
            var canCheckDef = !!(api && !Array.isArray(api) && typeof api.get === 'function');
            var items = [];
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                if (canCheckDef && !_laneDef(id)) {
                    return { error: { ok: false, reason: 'unknown_lane', lane: id, lanes: ids } };
                }
                var s = _storeOf(id);
                if (!s) return { error: { ok: false, reason: 'no_store', lane: id, lanes: ids } };
                items.push({ id: id, store: s });
            }
            return { plan: items, ids: ids };
        }

        // 会话在哪些 lane 的索引里不存在（同步判据；能力缺席的 store 跳过——不假装知道）
        function _missingSessions(items, sid) {
            var missing = [];
            for (var i = 0; i < items.length; i++) {
                var s = items[i].store;
                if (!s || typeof s.getSession !== 'function') continue;
                var found = null;
                try { found = s.getSession(sid); } catch (_) { found = null; }
                if (!found) missing.push(items[i].id);
            }
            return missing;
        }

        // 统一的 store 调用：抛错 / reject / 显式 false 都折叠成结果行（不静默、不打穿 UI）
        function _callStore(item, method, args, failReason) {
            var s = item.store;
            if (!s || typeof s[method] !== 'function') {
                return Promise.resolve({ lane: item.id, ok: false, reason: 'no_store' });
            }
            try {
                var r = s[method].apply(s, args);
                if (r && typeof r.then === 'function') {
                    return r.then(function (v) {
                        // store 层约定：显式 false = 失败；其余（true/undefined）按既有语义算成功
                        if (v === false) return { lane: item.id, ok: false, reason: failReason };
                        return { lane: item.id, ok: true };
                    }, function (e) {
                        return { lane: item.id, ok: false, reason: 'error', error: _errText(e) };
                    });
                }
                if (r === false) return Promise.resolve({ lane: item.id, ok: false, reason: failReason });
                return Promise.resolve({ lane: item.id, ok: true });
            } catch (e) {
                return Promise.resolve({ lane: item.id, ok: false, reason: 'error', error: _errText(e) });
            }
        }

        function _settle(calls, op, sid) {
            return Promise.all(calls).then(function (rows) {
                var okLanes = [];
                var failed = [];
                for (var i = 0; i < rows.length; i++) {
                    var row = rows[i] || {};
                    if (row.ok) okLanes.push(row.lane);
                    else failed.push({ lane: row.lane, reason: row.reason || 'error', error: row.error });
                }
                if (failed.length) {
                    warn('[SessionBinder] ' + op + ' 未在全部 lane 落地（sid=' + sid + '）: ' + JSON.stringify(failed));
                }
                return { ok: failed.length === 0, sid: sid, op: op, lanes: okLanes, failed: failed };
            });
        }

        // ── 公开面 ────────────────────────────────────────────────────────────
        // id 规则：team_<时间戳>_<随机段>，与 store.createSession() 的
        // sess_<时间戳>_<随机段> 同族。**同实例内保证不重复**：随机段撞了就重掷（最多 16 次），
        // 极端情况下（Math.random 被替换成常量等）退化为确定性序号段——不挂死、不返回重复 id。
        // 为什么必须唯一：sessionStore 用 id 做 _deletedIds 的防复写判据（删除过的 id 不再直写），
        // 复用旧 id 会让新会话的消息被自己的防复写拦截静默丢掉。
        function newTeamSessionId() {
            var ts = clock();
            var sid = '';
            var attempts = 0;
            do {
                attempts++;
                var tail = Math.random().toString(36).slice(2, 8);
                if (tail.length < 6) tail = (tail + '000000').slice(0, 6);
                sid = 'team_' + ts + '_' + tail;
            } while (issued[sid] && attempts < 16);
            while (issued[sid]) {
                issuedSeq++;
                sid = 'team_' + ts + '_' + issuedSeq.toString(36);
            }
            issued[sid] = true;
            return sid;
        }

        // 已绑定且三条 lane 都真的在这个会话上（cm 的 sessionId + store 索引都能确认）⇒ true。
        // 任何一个确认不了（能力缺席 / 拿不到）都返回 false——宁可多做一次幂等切换，
        // 也不把「没法确认」当成「已经好了」。
        function _isAdopted(sid) {
            var ids = _laneIds();
            if (!ids.length) return false;
            for (var i = 0; i < ids.length; i++) {
                var c = _controllerOf(ids[i]);
                if (!c) return false;
                if (_laneSessionId(ids[i], c) !== sid) return false;
                var s = _storeOf(ids[i]);
                if (s && typeof s.getSession === 'function') {
                    var found = null;
                    try { found = s.getSession(sid); } catch (_) { found = null; }
                    if (!found) return false;
                }
            }
            return true;
        }

        function bindSession(sid) {
            if (!_validSid(sid)) return { ok: false, reason: 'bad_sid', sid: sid };
            // 幂等：见文件头「绑定」——重复 start(同一 sid) 是正常路径，不能每次都重跑 adopt
            if (currentSid === sid && _isAdopted(sid)) {
                _notifyBound(sid);
                return { ok: true, sid: sid, changed: false, bound: true, lanes: _laneIds() };
            }
            var res = _switchAll(sid);
            if (!res.ok) return res;
            _notifyBound(sid);
            return {
                ok: true, sid: sid, changed: res.changed, bound: true, previous: res.previous,
                lanes: res.lanes, stopped: res.stopped, stopFailed: res.stopFailed
            };
        }

        function createTeamSession() {
            var sid = newTeamSessionId();
            var res = _switchAll(sid);
            if (!res.ok) {
                // 未建成：id 已发出但不绑定（返回体如实带 sid，方便排障与后续复用）
                res.sid = sid;
                res.created = false;
                return res;
            }
            _notifyBound(sid);
            return {
                ok: true, sid: sid, created: true, changed: res.changed, previous: res.previous,
                lanes: res.lanes, stopped: res.stopped, stopFailed: res.stopFailed
            };
        }

        function switchTeamSession(sid) {
            if (!_validSid(sid)) return { ok: false, reason: 'bad_sid', sid: sid };
            var res = _switchAll(sid);
            if (!res.ok) return res;
            _notifyBound(sid);
            return {
                ok: true, sid: sid, changed: res.changed, previous: res.previous,
                lanes: res.lanes, stopped: res.stopped, stopFailed: res.stopFailed
            };
        }

        // 改名：同步判据 = 三条 lane 的索引里都得有这条会话（缺一条说明整队已分叉——
        // 如实报 missing，不做「改得到的就改」的静默半成功）；逐 lane 的落盘结果进 done。
        function renameTeamSession(sid, title) {
            if (!_validSid(sid)) return { ok: false, reason: 'bad_sid', sid: sid };
            if (typeof title !== 'string' || !title) return { ok: false, reason: 'bad_title', sid: sid };
            var built = _storePlan();
            if (built.error) return built.error;
            var items = built.plan;
            var missing = _missingSessions(items, sid);
            if (missing.length) return { ok: false, reason: 'unknown_session', sid: sid, missing: missing };
            var calls = [];
            for (var i = 0; i < items.length; i++) {
                calls.push(_callStore(items[i], 'renameSession', [sid, title], 'rename_failed'));
            }
            return { ok: true, sid: sid, title: title, lanes: _idsOf(items), done: _settle(calls, 'rename', sid) };
        }

        // 删当前会话时挑「接下来停在哪条」：**只在三条 lane 索引里都有**的候选里挑——
        // 那才是「团队会话」的定义（binder 的整队切换要求三条 lane 同时可落）。若把三份索引
        // 合并后取 updatedAt 最大者，可能选中某条 lane 的**本地单 Agent 会话**（sess_*），
        // 整队切过去后另两条 lane 由 ensureSession 新建同名空条目 ⇒ 团队落到了非团队会话上。
        // 都没有（整队只剩这一条 / 索引读不到）⇒ 返回 ''，调用方新建一条。
        function _nextSessionIdAfter(sid, items) {
            var seen = {};
            for (var i = 0; i < items.length; i++) {
                var st = items[i].store;
                if (!st || typeof st.listSessions !== 'function') return '';   // 有一份索引读不到：不猜
                var list = null;
                try { list = st.listSessions() || []; } catch (_) { list = []; }
                for (var j = 0; j < list.length; j++) {
                    var s = list[j];
                    if (!s || !s.id || s.id === sid) continue;
                    var t = (s.updatedAt || s.createdAt || 0);
                    var rec = seen[s.id] || (seen[s.id] = { id: s.id, t: t, n: 0 });
                    rec.n++;
                    if (t > rec.t) rec.t = t;
                }
            }
            var best = null;
            for (var k in seen) {
                if (!Object.prototype.hasOwnProperty.call(seen, k)) continue;
                if (seen[k].n !== items.length) continue;   // 只在部分 lane 里存在 ⇒ 不是团队会话
                if (!best || seen[k].t > best.t) best = { id: seen[k].id, t: seen[k].t };
            }
            return best ? best.id : '';
        }

        // 删除：**不受** per-store last_one 阻断（见文件头「删除」）。缺失的 lane 如实报
        // missing 但仍继续（清理是幂等的），每条 lane 的删除结果进 done。
        // 删的是**当前绑定**的那条时，先把三条 lane 整队切走（或新建一条）再删——顺序不能反：
        //   · 反着做的真机后果（数据丢失）：三条 lane 的 cm 停在已删 id 上，
        //     面板仍显示「新会话」、用户继续聊；而 store 的 `_deletedIds` 防复写把之后所有
        //     消息落盘**静默**丢弃（save → false，无告警）⇒ 那两轮对话一条都没上盘，
        //     下次切会话把内存态一清，历史彻底消失（只剩 .tokens.json 孤儿文件为证）。
        //   · 切换失败（busy / partial）⇒ **拒绝删除**并如实透出原因：宁可这次不删，
        //     也不能把三条 lane 丢在一个已删的会话上（单 Agent 路径的 controller.deleteSession
        //     早就是这个取舍——删完自动切到下一条，切不动就不删）。
        // 绑定变化的**唯一通知口**：注入 onBoundChange(sid|null)。
        // 为什么必须有：真机 UI 的会话删除走的是 `binder.deleteTeamSession` **直调**
        //（engine/sessionSwitcher.js:421），不经过 orchestrator 的薄封装 ⇒ 只把「镜像跟随
        // switchedTo」挂在 orchestrator.deleteTeamSession 上是**死代码**：删掉当前会话后
        // orchestrator 的 teamSessionId 仍停在已删 id，之后派单拿它投递 → apiActions 的
        // 会话一致性检查查不到该会话、只 console.warn 一句就 return（派单静默丢失）。
        // 通知点在**每个公开动作返回之前**（不放进 _switchAll 内部：那里在途位 `switching` 还开着，
        // 宿主回调再进来会被判 busy）；回调抛错只告警，不打穿会话操作本身。
        function _notifyBound(sid) {
            if (typeof o.onBoundChange !== 'function') return;
            try { o.onBoundChange(sid || null); } catch (e) {
                warn('[SessionBinder] onBoundChange 回调抛错（宿主镜像可能滞后）: ' + _errText(e));
            }
        }

        function deleteTeamSession(sid) {
            if (!_validSid(sid)) return { ok: false, reason: 'bad_sid', sid: sid };
            var built = _storePlan();
            if (built.error) return built.error;
            var items = built.plan;
            var missing = _missingSessions(items, sid);
            var moved = '';
            // 「删的是不是三条 lane 正在用的那条」**按状态判**，不按自己的记忆判：
            // currentSid 是内存态，可能为 null 而三条 lane 确实停在这条会话上（重载后三条
            // lastActiveId 分叉 / noteRestoredSession 认领失败 ⇒ currentSid 保持 null）。
            // 那种形态下按 currentSid 判会「直接删」，三条 lane 立刻搁浅在已删 id 上——
            // 数据丢失路径原样复现。_isAdopted 就是现成的可复核判据（三条 cm + 三份索引）。
            var onIt = (currentSid === sid) || _isAdopted(sid);
            if (onIt) {
                var nextSid = _nextSessionIdAfter(sid, items) || newTeamSessionId();
                var sw = _switchAll(nextSid);
                if (!sw.ok) {
                    // 零删除：三条 lane 还在这条会话上，删除整体未执行
                    sw.op = 'delete';
                    sw.sid = sid;
                    sw.reason = sw.reason || 'error';
                    return sw;
                }
                moved = nextSid;
            }
            var calls = [];
            for (var i = 0; i < items.length; i++) {
                calls.push(_callStore(items[i], 'deleteSession', [sid], 'delete_failed'));
            }
            // 工作区目录（可选注入；未注入 = 不删，workspace 只读，见文件头）
            var ws = null;
            if (typeof o.removeWorkspace === 'function') {
                try {
                    var w = o.removeWorkspace(sid);
                    if (w && typeof w.then === 'function') {
                        ws = w.then(function () { return { ok: true }; },
                            function (e) { return { ok: false, error: _errText(e) }; });
                    } else if (w === false) {
                        ws = Promise.resolve({ ok: false });
                    }
                } catch (e) {
                    warn('[SessionBinder] 工作区目录删除下发失败（会话文件仍照常删）: ' + _errText(e));
                }
            }
            // 删掉的是三条 lane 正在用的那条 ⇒ 绑定已在上面的整队切换里落到 moved 上（依据：
            // 三条 lane 必须始终停在一条**存在**的会话上，这正是本函数先切后删的理由）。
            if (!moved && onIt) currentSid = null;
            var done = _settle(calls, 'delete', sid).then(function (res) {
                if (!ws) return res;
                return ws.then(function (wr) {
                    res.workspace = wr;
                    return res;
                });
            });
            var out = { ok: true, sid: sid, lanes: _idsOf(items), missing: missing, done: done };
            if (moved) out.switchedTo = moved;
            // 绑定通知（H1）：宿主镜像跟着落点走（菜单删除也走这条路，不经过 orchestrator）
            _notifyBound(currentSid);
            return out;
        }

        function getCurrentSessionId() { return currentSid; }

        // 绑定一致性快照：团队会话在数据上是**三条独立 store/cm 上的
        // 同一条 sid**，而整队切换是手工两阶段（预检 → 停 → 逐条 adopt → 失败回滚），失败被允许
        // 分叉（rollbackFailed 只告警）。没有可查询的不变量判据时，分叉只能靠「某条 lane
        // 的历史/工作区不对」间接发现。本出口给出**可复核快照**，供引擎出口 / 诊断 / 任务板使用：
        //   sid        —— 当前绑定的团队会话（null = 还没有团队会话）
        //   lanes[id]  —— { sid（该 lane cm 的实际会话）, inStore（store 索引复核；能力缺席为 null）}
        //   divergent  —— 与 currentSid 不一致的 lane（**未绑定时是全部 lane**：空 ≠ 一致）
        //   consistent —— 非空且零分歧。判据只用「currentSid + 三条 cm 会话」，store 索引只作辅助
        //                 （能力差异下允许 null；真 controller 的 adoptSession 会 ensureSession 建索引）
        // 只读、同步、永不抛：调用方是诊断/自检，不该被它的异常打穿。
        function getBindingState() {
            var ids = _laneIds();
            var lanes = {};
            var divergent = [];
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var c = _controllerOf(id);
                var sid = '';
                try { sid = _laneSessionId(id, c) || ''; } catch (_) { sid = ''; }
                var inStore = null;
                var st = _storeOf(id);
                if (st && typeof st.getSession === 'function' && currentSid) {
                    try { inStore = !!st.getSession(currentSid); } catch (_) { inStore = null; }
                }
                lanes[id] = { sid: sid, inStore: inStore };
                if (!currentSid || sid !== currentSid) divergent.push(id);
            }
            return {
                sid: currentSid,
                lanes: lanes,
                divergent: divergent,
                consistent: !!currentSid && divergent.length === 0
            };
        }

        // 整队切换是否在途（**对外可查的在途判据**）：teamUI.anyLaneLocked 用它把
        // 「切换窗口」算进会话切换器与「全部停止」的禁用态——真 controller 的 `_switching` 是闭包内
        // 私有态、公开面没有出口，而「正在整队切换」这件事的唯一真相就在本文件。
        // 两个名字都给（isSwitching 是本体，getSwitching 与 controller 侧的旧命名同款，免得调用方
        // 为了一个 getter 名再去写一层适配）。窗口长度见 `switching` 的声明处（同步窗口）。
        function isSwitching() { return switching; }
        function getSwitching() { return switching; }

        // ── 重载后**认领**既成事实 ────────────────────────────────
        // 与 bindSession 的区别（**本出口存在的全部理由**，改这里前先读这段）：
        //   · bindSession = 「**下发**整队切换」：走 _switchAll —— 停 lane、逐条 adopt、失败回滚、
        //     写 store.updateLastActive，三条全绿后才改 currentSid；
        //   · noteRestoredSession = 「**只认领**」：三条 lane 已经在同一条团队会话上了
        //     （面板重载时各 lane 各自消费自己 store 的 lastActiveId），本函数不下发任何动作，
        //     只把 currentSid 落成这个既成事实的 sid。
        // 为什么需要它：currentSid 是纯内存态，随面板重载清空；三条 lane 的会话其实都在，
        // 而 binder 不知道 ⇒ read_workspace（teamTools 经 getTeamSessionId 读它）在重载后一律
        // 报 no_team_session。该路径由 bootstrap 恢复链链尾的
        // _ensureTeamSessionBound 兜底（首启/分叉自动新建）：用户无需手动新建。
        // 为什么不在启动期直接调 bindSession：bind 会在启动期下发一遍停止 + adopt（多余 IO），
        // 且它的 busy 预检会把「面板刚挂载、某条 lane 恰好在忙」整队判失败——currentSid 反而
        // 落不上值（认领要的只是「记住」，不该被 lane 的瞬时忙碌拦住）。
        // 判据（**只信可复核的状态，不信调用方口述**）：_isAdopted(sid) —— 三条 lane 的 controller
        // 会话 id 与三份 store 索引**都得**对上；对不上就如实返回 not_adopted 且**零副作用**：
        // 不猜、不静默认领一条只有一半 lane 在的会话（那正是「整队已分叉」的形态，比 null 更难查）。
        // 同步、永不抛：调用方是启动恢复链，抛错会打断整条链。
        function noteRestoredSession(sid) {
            if (!_validSid(sid)) return { ok: false, reason: 'bad_sid' };
            if (!_isAdopted(sid)) return { ok: false, reason: 'not_adopted' };
            currentSid = sid;
            _notifyBound(sid);   // 认领也要通知：宿主镜像在重载后同样需要落值（否则派单报 not_team）
            return { ok: true, sid: sid, noted: true };
        }

        return {
            // 公开面（导出形状固定）
            newTeamSessionId: newTeamSessionId,
            bindSession: bindSession,
            createTeamSession: createTeamSession,
            switchTeamSession: switchTeamSession,
            renameTeamSession: renameTeamSession,
            deleteTeamSession: deleteTeamSession,
            getCurrentSessionId: getCurrentSessionId,
            // 绑定一致性快照：三条 lane 是否真的在同一条团队会话上（见实现处注释）
            getBindingState: getBindingState,
            // 整队切换在途（对外可查；见 isSwitching 的注释）——teamUI.anyLaneLocked 的第三个信号
            isSwitching: isSwitching,
            getSwitching: getSwitching,
            // 重载后认领既成事实（见上；**不是** bindSession 的别名——它不下发任何动作）
            noteRestoredSession: noteRestoredSession,
            // orchestrator 的 sessions 契约用短名（orchestrator.js:24-26 的 bind / create / switch /
            // rename / delete，经 _sessionCall 逐个方法调用并读 ok）：两套名字指向同一批函数，
            // 免得宿主再包一层转接——包装层正是「转发漏参数」的高发处。
            bind: bindSession,
            create: createTeamSession,
            switch: switchTeamSession,
            rename: renameTeamSession,
            delete: deleteTeamSession
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createSessionBinder = createSessionBinder;
})(typeof window !== 'undefined' ? window : globalThis);
