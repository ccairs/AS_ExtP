(function (global) {
    const ns = global.AEEngine || {};
    ns.apiReference = null;

    (function preloadApiReference() {
        var extRoot = (typeof window !== 'undefined' && window.__ext_root) || '';
        console.log('[Engine] apiReference 预加载 — extRoot=' + (extRoot || '(empty)') + ' AEFS=' + (typeof AEFS !== 'undefined' ? 'yes' : 'no'));
        function onLoaded(content) {
            ns.apiReference = content;
            // 交给解析器建索引，供 queryAeApi 工具查询
            if (ns.apiReferenceModule && typeof ns.apiReferenceModule.init === 'function') {
                try {
                    ns.apiReferenceModule.init(content);
                } catch (e) {
                    console.warn('[Engine] apiReference 解析失败: ' + (e && e.message ? e.message : e));
                }
            }
        }
        function onMatchNamesLoaded(content) {
            // 加载效果/属性 matchName 词典（client/shared/aeMatchName.json），供 queryAeApi 查 matchName
            if (ns.apiReferenceModule && typeof ns.apiReferenceModule.initMatchNames === 'function') {
                try {
                    ns.apiReferenceModule.initMatchNames(content);
                } catch (e) {
                    console.warn('[Engine] matchName 词典解析失败: ' + (e && e.message ? e.message : e));
                }
            }
        }
        function loadFile(path, onText) {
            if (extRoot && typeof AEFS !== 'undefined' && AEFS.readFile) {
                AEFS.readFile(path).then(function (content) {
                    if (content) onText(content);
                    else console.log('[Engine] AEFS 返回空: ' + path);
                });
            } else {
                fetch(path)
                    .then(function (res) {
                        if (res.ok) return res.text();
                        throw new Error('HTTP ' + res.status);
                    })
                    .then(onText)
                    .catch(function (e) {
                        console.warn('[Engine] fetch 失败 ' + path + ': ' + (e && e.message ? e.message : e));
                    });
            }
        }
        if (extRoot && typeof AEFS !== 'undefined' && AEFS.readFile) {
            var apiPath = extRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/client/shared/aeApiReference.txt';
            console.log('[Engine] apiReference 尝试 AEFS 加载: ' + apiPath);
            AEFS.readFile(apiPath).then(function (content) {
                if (content) {
                    onLoaded(content);
                    console.log('[Engine] apiReference AEFS 加载成功 (' + content.length + ' chars)');
                } else {
                    console.log('[Engine] apiReference AEFS 返回空');
                }
            });
        } else {
            console.log('[Engine] apiReference 走 fetch 兜底');
            fetch('../../../shared/aeApiReference.txt')
                .then(function (res) {
                    if (res.ok) return res.text();
                    throw new Error('HTTP ' + res.status);
                })
                .then(function (text) {
                    onLoaded(text);
                    console.log('[Engine] apiReference fetch 成功 (' + text.length + ' chars)');
                })
                .catch(function (e) {
                    console.warn('[Engine] apiReference fetch 失败: ' + (e && e.message ? e.message : e));
                });
        }
        // matchName 词典独立加载（JSON，双路径对齐 aeApiReference.txt）
        if (extRoot && typeof AEFS !== 'undefined' && AEFS.readFile) {
            var mnPath = extRoot.replace(/\\/g, '/').replace(/\/$/, '') + '/client/shared/aeMatchName.json';
            loadFile(mnPath, function (text) {
                try {
                    onMatchNamesLoaded(JSON.parse(text));
                    console.log('[Engine] aeMatchName AEFS 加载成功 (' + text.length + ' chars)');
                } catch (e) {
                    console.warn('[Engine] aeMatchName 解析失败: ' + (e && e.message ? e.message : e));
                }
            });
        } else {
            fetch('../../../shared/aeMatchName.json')
                .then(function (res) { if (res.ok) return res.json(); throw new Error('HTTP ' + res.status); })
                .then(function (data) {
                    onMatchNamesLoaded(data);
                    console.log('[Engine] aeMatchName fetch 加载成功 (' + Object.keys(data).length + ' 条)');
                })
                .catch(function (e) {
                    console.warn('[Engine] aeMatchName fetch 失败: ' + (e && e.message ? e.message : e));
                });
        }
    })();

    let mounted = false;
    let controller = null;
    let listeners = [];
    let state = null;

    // ── 团队模式 lane runtime 的单例槽 ──────────────
    // controller / state / AEEngine.view 三个单例槽全部指向「当前 lane」的那条 runtime：
    // 团队关闭时「当前 lane」恒为 _singleRuntime（= 改动前唯一那条），故单 Agent 路径语义不变；
    // 团队开启时切 lane 只换槽的指向，模块级既有读取点（updateSendButton / updateContextRing /
    // 启动恢复链 / 「当前选中」浮层 / bridge 门面）不必各自再写一遍 lane 判据。
    var _singleRuntime = null;      // 团队关闭时唯一那条 runtime（slot 按现有 runtimeMode）
    var _orchestrator = null;       // 团队编排面；团队关闭路径**不创建**（orchestrator.js 头注 :36-37）
    var _teamEnabled = false;       // 团队开关当前态：判「当前 lane」只看它 + orchestrator 的真相源
    // ── 团队态状态机 ──────────────────────────────
    // 为什么布尔不够：`_teamEnabled` 表达不了「正在开 / 部分装配失败 / 正在关」三种态，于是
    // `start()` 失败后旗标可以停在 true（装饰性 true）——UI 按它切团队布局，而 `_currentRuntime()`
    // 因 `getLane()` 为 null 回落到单 Agent（用户发的消息在隐藏容器里跑）。状态机 + 唯一写点
    // `_setTeamState` 让「引擎态」与「视图态」同源；`_teamEnabled` 退化为派生布尔，禁止再直写。
    var _teamState = 'off';         // off | starting | on | partial | stopping
    var _lastTeamFailure = null;    // 最近一次 start 的失败面 { reason, failed[], at }（诊断出口用）
    var _viewFallback = null;       // AEEngine.view 访问器的兜底槽（运行时缺席时的读值 / 旧写点）
    var _laneContextManagers = {};  // laneId -> cm：窗口上限同步必须覆盖三条 lane 的 cm
    // ── 团队装配面的模块级单例 ──────────────────────────────────────────────
    // 放模块级而不是 mount 局部：① 「六条 store」的收集口径（恢复链 / 落盘 / chat_img 引用集 /
    // 体积预算）在 mount 之外也要读得到（unmount 是模块级函数）；② mount 中途抛错后重挂时
    // 工作区与 binder 复用同一份（重建会让 orchestrator 里已注入的 sessions 指向旧 binder）。
    var _laneSessionStores = {};    // laneId -> sessionStore（团队 lane 的会话命名空间）
    var _laneStoreIds = [];         // 已装配 lane store 的登记顺序（收集顺序稳定，不依赖对象键序）
    var _teamWorkspace = null;      // 团队工作区（team/workspace.js 实例，只读面）
    var _teamTaskList = null;       // 团队任务清单（team/taskList.js 实例；**三条 lane 共用一份**）
    var _sessionBinder = null;      // 团队会话 binder（orchestrator 的 sessions 注入项）
    var _teamToolsInited = false;   // team 域工具是否已注册（注册表是全局单例，重复注册会失败告警）
    // 启动恢复链是否在跑（**模块级事实**）。
    // 为什么不能只写 `state.restoring`：`state` 是**可变单例槽**，`_syncSlots()` 在切 lane 时把它
    // 指到另一条 runtime。恢复链没跑完就开团队（或切 lane）时，链尾的复位会落到**新的当前 lane**
    // 的 state 上，单 Agent 那条永久停在 `restoring = true`。真机实测（本机复现，
    // 确定性）：团队开着时旋钮（逃生出口 switchGlobalMode）恒 `{ok:false,reason:'busy'}` 切不动；
    // 关掉团队后单 Agent 发消息被拒「会话恢复中，请稍候再发送」——两条都是用户级死锁。
    // 故置位/复位都遍历**所有** runtime（单 Agent + 已登记的 lane），恢复窗口内才建出来的 lane
    // 由 createLaneRuntime 继承本标志（它也要在恢复期拒绝提交，见孤儿会话语义）。
    var _restoreInFlight = false;
    // 「当前选中」入口：工具注册表 + 可见性工厂实例的模块级引用。
    // 为什么放模块级：可见性判据要「当前轮身份能不能读到工程」（查注册表里 queryProject 的 scope），
    // 而写点有三个（挂载 / _syncSlots 的切 lane 与开关团队 / app 层模式 chrome）——两处局部各存一份
    // 必然漂移。_aeStateChip 为 null 时（模块未挂载 / 旧部署）写点静默跳过。
    var _llmToolReg = null;
    var _aeStateChip = null;

    // 恢复标志的落点集合：单 Agent 那条 runtime + 已登记的三条 lane（团队未开 / 未装配时只有前者）。
    function _restoringTargets() {
        var out = [];
        if (_singleRuntime && _singleRuntime.state) out.push(_singleRuntime.state);
        if (_orchestrator && typeof _orchestrator.lanes === 'function' && typeof _orchestrator.getLane === 'function') {
            var defs = _orchestrator.lanes();
            for (var i = 0; i < defs.length; i++) {
                var rt = _orchestrator.getLane(defs[i] && defs[i].id);
                if (rt && rt.state) out.push(rt.state);
            }
        }
        return out;
    }

    // 置位 / 复位恢复标志：**所有** runtime 一次写齐（幂等）。返回值 = 落到的 runtime 数（测试可断言）。
    function _setRestoringAll(flag) {
        _restoreInFlight = !!flag;
        var targets = _restoringTargets();
        for (var i = 0; i < targets.length; i++) targets[i].restoring = _restoreInFlight;
        // restoring 是团队锁判据之一（teamUI.anyLaneLocked），但它既不走 lane 忙闲回调、
        // 也不进忙碌上报的去重键：不在这里补一次刷新，恢复链跑完（或看门狗强制复位）后
        // 会话切换器会一直停在恢复期置上的禁用态。
        try { _refreshTeamLockFromLane('restoring'); } catch (_) { /* 装配未就绪：静默 */ }
        return targets.length;
    }

    // ── store 就绪等待：**一律有界**────────────────
    // 为什么必须有界：AEFS 的索引读走裸 fetch（bridge.js）且无超时，`aefs.js` 自己写明
    // 「端口被 accept 后不响应的进程占用时 fetch 会无限挂起」。无界等待会把**恢复链**（连同
    // `_restoreInFlight` 标志）一起挂死 ⇒ 所有 runtime 永久拒发消息（用户级死锁）。
    // 超时按「未就绪」继续：调用方（恢复链 / 模式切换）走既有的显式失败体，不假装成功。
    // 有界先例：controller.js 的 `_adoptRestoring` 8s 保险（同一取舍：宁可放行，不可锁死）。
    var _STORE_READY_TIMEOUT_MS = 8000;
    // 实际生效值：默认同上，挂载时可经 `opts.storeReadyTimeoutMs` 覆盖（单测用短值验证「有界」）。
    var _storeReadyTimeoutMs = _STORE_READY_TIMEOUT_MS;
    function _whenStoreReady(store, timeoutMs) {
        if (!store || typeof store.whenReady !== 'function') return Promise.resolve(false);
        var ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : _storeReadyTimeoutMs;
        return new Promise(function (resolve) {
            var done = false;
            var timer = setTimeout(function () {
                if (done) return;
                done = true;
                resolve(false);   // 超时 = 未就绪（调用方据此显式失败，不挂死）
            }, ms);
            Promise.resolve().then(function () { return store.whenReady(); }).then(function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(true);
            }, function () {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(false);
            });
        });
    }

    // 恢复标志的**看门狗**：链可能挂在任一 await 上（store init / migrate /
    // 会话 load 都经 AEFS fetch）。挂在链上意味着 `restoring` 永久 true ⇒ 全部 runtime 拒发。
    // 到点强制放行并如实告警——宁可放过一次「恢复期提交」，也不能让面板永久发不出消息；
    // 链尾 finally 仍会再清一次（幂等），故这里只是「最坏情况的上限」。
    var _RESTORE_WATCHDOG_MS = 20000;
    var _restoreWatchdogTimer = null;

    // 团队态的**唯一写点**：状态与派生布尔 `_teamEnabled` 在这一处同步，禁止再直写
    // `_teamEnabled`——两处各写必然漂移，那正是本次要修的那类缺陷的形态。
    // `stopping` 映射为「已关闭」：dispose 期间各 lane 收尾的 setBusy 要被共用栏闸门挡下
    //（V46④ 的既有语义：先置 false 再 dispose，最后由 clearStatusChrome 清干净）。
    // `starting` 映射为「已开启」：lane runtime 在这一窗口里装配，其 controller/view 的
    // `isTeamMode` / 闸门判据必须看到「团队已开」，否则装配期语义与稳态不一致。
    function _setTeamState(next) {
        _teamState = next;
        _teamEnabled = (next === 'on' || next === 'partial' || next === 'starting');
    }

    // 团队态的只读视图（getTeamState 的实现）：UI / 诊断 / 单测读同一份，不再各自拼
    // 「当前 lane 非空」「orchestrator 非 null」这类派生判据（两处判据必然漂移）。
    function _teamStateView() {
        var lanes = [];
        try {
            if (_orchestrator && typeof _orchestrator.lanes === 'function') {
                var defs = _orchestrator.lanes() || [];
                for (var i = 0; i < defs.length; i++) {
                    var id = defs[i] && defs[i].id;
                    if (id) lanes.push(id);
                }
            }
        } catch (_) { lanes = []; }
        var lf = _lastTeamFailure;
        // 团队会话绑定一致性：与 getTeamSessionState 同源，UI/诊断不必再去
        // 找 binder。**只带摘要**（sid/consistent/divergent）——逐 lane 明细在专用出口里。
        var session = null;
        try {
            if (_sessionBinder && typeof _sessionBinder.getBindingState === 'function') {
                var bs = _sessionBinder.getBindingState();
                session = { sid: bs.sid, consistent: bs.consistent, divergent: bs.divergent.slice() };
            }
        } catch (_) { session = null; }
        return {
            state: _teamState,                 // off | starting | on | partial | stopping
            enabled: _teamEnabled,             // 派生布尔（兼容既有判据：on/partial/starting 为 true）
            currentLane: _currentLaneId(),     // 团队外的语义不变：off/stopping 恒 ''
            laneCount: lanes.length,
            lanes: lanes,
            failed: lf ? lf.failed.slice() : [],   // 最近一次 start 里没装配成功的 lane id
            reason: lf ? lf.reason : '',
            at: lf ? lf.at : 0,
            lastFailure: lf ? { reason: lf.reason, failed: lf.failed.slice(), at: lf.at } : null,
            // 团队会话绑定摘要：null = binder 未装配；consistent=false 表示三条 lane 已分叉
            session: session
        };
    }

    // 绑定变化后的**不变量自检**：整队会话要求三条 lane 的 cm 会话与 binder 的 currentSid
    // 完全一致。不一致 = 已经分叉（部分 adopt 失败 / 回滚失败 / 外部改了单 lane / 重载认领失败）——
    // 如实告警，不静默；返回快照供调用方诊断（能力缺席返回 null）。
    function _checkTeamSessionConsistency(where) {
        if (!_sessionBinder || typeof _sessionBinder.getBindingState !== 'function') return null;
        var st = null;
        try { st = _sessionBinder.getBindingState(); } catch (_) { return null; }
        if (st && !st.consistent) {
            console.warn('[Agent] 团队会话绑定分叉（' + (where || 'bound-change') + '）：current='
                + JSON.stringify(st.sid) + ' divergent=' + JSON.stringify(st.divergent));
        }
        return st;
    }

    // 当前 lane 的那条 runtime：团队开启且 orchestrator 已装配 ⇒ 取它的当前 lane；否则单 Agent。
    function _currentRuntime() {
        if (_teamEnabled && _orchestrator) {
            var cur = _orchestrator.getCurrentLane();
            var rt = cur ? _orchestrator.getLane(cur) : null;
            if (rt) return rt;
        }
        return _singleRuntime;
    }

    // 顶栏用量行/明细浮层的**迁移监听**（顶栏 token 行/浮层）：
    // 团队档内没有 single view，而顶栏 #aeAgentTokenStats 是**当前 lane** 的镜像。浮层只绑在
    // 单 Agent view 上 ⇒ 团队档下悬停无人响应或显示旧快照。现在由「当前 runtime 的 view」绑定，
    // 换 lane / 进出团队时把监听迁过去（同一时刻只由一条 view 绑定这个共享元素）。
    // 单 Agent 路径行为不变：它的 view 绑的就是这个元素（自己写自己读）。
    function _bindTopTokenPopover(rt) {
        var topEl = null;
        try { topEl = byId('aeAgentTokenStats'); } catch (_) { topEl = null; }
        if (!topEl) return;
        var curView = (rt && rt.view) ? rt.view : null;
        function release(v) {
            if (!v || v === curView || typeof v.unbindTokenPopover !== 'function') return;
            try { v.unbindTokenPopover(topEl); } catch (_) { /* 旧 view 已拆：忽略 */ }
        }
        if (_singleRuntime) release(_singleRuntime.view);
        if (_orchestrator && typeof _orchestrator.lanes === 'function' && typeof _orchestrator.getLane === 'function') {
            var defs = [];
            try { defs = _orchestrator.lanes() || []; } catch (_) { defs = []; }
            for (var i = 0; i < defs.length; i++) {
                var laneRt = _orchestrator.getLane(defs[i] && defs[i].id);
                if (laneRt) release(laneRt.view);
            }
        }
        if (curView && typeof curView.bindTokenPopover === 'function') {
            try { curView.bindTokenPopover(topEl); } catch (_) { /* 绑定失败：浮层缺席，不阻断槽切换 */ }
        }
    }

    // laneId 的**严格解析**：显式身份面的唯一解析器。与 `_runtimeForLane` 的
    // 区别是**永不回落**——`bad_lane` / `unknown_lane` / `not_team` / `not_ready` 如实返回。
    // 为什么需要它：回落等于「把数据写进用户此刻正在看的那条 lane」（数据归属错），而入口侧
    // 一旦有回落兜底，新调用方就会默认依赖它——身份就永远显式不起来。
    function _runtimeForLaneStrict(laneId) {
        if (typeof laneId !== 'string' || !laneId) return { ok: false, reason: 'bad_lane' };
        if (laneId === 'single') {
            // 团队档内**没有**单 Agent runtime：'single' 只在团队关闭时有效。
            // 显式 not_team（原为 not_ready / 命中被 park 的那条）——不再给出一个团队档下
            // 还可能被写入/唤醒的通道，否则「主通道已移除」只是 UI 层面的说法。
            if (_teamEnabled) return { ok: false, reason: 'not_team' };
            return _singleRuntime ? { ok: true, rt: _singleRuntime, kind: 'single' } : { ok: false, reason: 'not_ready' };
        }
        if (!_orchestrator) return { ok: false, reason: 'not_team' };
        var rt = null;
        try { rt = _orchestrator.getLane(laneId); } catch (_) { rt = null; }
        if (!rt) return { ok: false, reason: 'unknown_lane' };
        return { ok: true, rt: rt, kind: 'lane' };
    }

    // laneId 指定的 runtime：未传/空 = **当前 lane**；'single' = 单 Agent 通道（团队模式下外接与
    // 面板手动通道的落点，见 index.html 的 lane 骨架注释）。指定的 lane 不存在时不静默丢结果
    //（后台结果注入是图像/视频产物唯一的回写通道）——回落当前 lane 并如实告警。
    // 注：**入口侧新代码不要用它**——它按「当前视图」兜底，是 UI 动作面的通道。需要显式
    // 身份的调用方用 `_runtimeForLaneStrict`（或宿主出口 `AEEngine.forLane(laneId)`）。
    function _runtimeForLane(laneId) {
        if (!laneId) return _currentRuntime();
        if (laneId === 'single') return _singleRuntime;
        var rt = _orchestrator ? _orchestrator.getLane(laneId) : null;
        if (rt) return rt;
        console.warn('[AEEngine] 指定的 lane 不存在，结果回落到当前 lane: ' + laneId);
        return _currentRuntime();
    }

    // 计划处理器（trackSteps / getPlanStatus / updatePlan）的**按 lane 现解析**。
    // 为什么必须有它：三条 lane 各注册一次同名计划工具，而工具注册表是 **last-wins**（同名后者
    // 覆盖前者）⇒ 三条 lane 的 controller 注册的 handler 必须语义等价——每次调用按 `ctx.laneId`
    // 解析到调用方那条 lane 的真实处理器；解析不到时返回 null，由调用方（controller 的
    // `_laneAwarePlanHandlers`）回落它自己那一份。
    // 两个注入点用**同一个函数对象**：lane 的 ctrlOpts（每条 lane 注册时就要带）与 initTeamTools
    // 的 opts（三条 lane 共用同一个注册表的装配面）。**不写第二套判据**。
    //
    // 未知/空 laneId 一律 null（**不**回落当前 lane）：`_runtimeForLane` 对不存在的 lane 会回落
    // 当前 lane（那是后台结果回写通道的正确语义，见它上面的注释），但计划处理器借用它会造出
    // 静默错路由——导演 lane 传一个不存在的 id（或空 id）时把条目写进**当前 lane**的 plan 里，
    // 也就是「A 的 todo 进了 B 的 plan」。故这里与 lanes 的定义表对照，只认真实存在的 lane id。
    function _lanePlanHandlersFor(laneId) {
        if (!laneId || typeof laneId !== 'string') return null;
        if (!_orchestrator) return null;   // 没有编排面就没有 lane runtime（团队未装配）
        // 与 lane 定义表对照：只认**真实存在的 lane id**（`lanes.get(id)` 未命中 ⇒ null）。
        // 注意**不能**拿 `lanes.listIds()` 当白名单——那个 API 给的是三条 lane 的**容器 DOM id**
        //（lanes.js:189-193），lane id 一个都不在里面，用它当判据会让所有 lane 都解析不到。
        var def = null;
        try {
            var lanesApi = (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
            def = (lanesApi && typeof lanesApi.get === 'function') ? lanesApi.get(laneId) : null;
        } catch (_) { def = null; }
        if (!def) return null;
        // 到这里 laneId 是**已知 lane**，可以安全取它自己的 runtime（不走 _runtimeForLane 的回落）。
        var rt = _orchestrator.getLane(laneId);
        var c = (rt && rt.controller) ? rt.controller : null;
        return (c && c.planApi) ? c.planApi : null;
    }

    function _currentController() {
        var rt = _currentRuntime();
        return (rt && rt.controller) ? rt.controller : null;
    }

    // 当前 lane id（团队模式）；单 Agent 路径为 ''（调用方据此走「无 lane 语义」分支）。
    function _currentLaneId() {
        if (!_teamEnabled || !_orchestrator) return '';
        return _orchestrator.getCurrentLane() || '';
    }

    // 某 lane 是否是当前 lane：view / 权限确认 / 任务板 / toast 的**唯一判据**（
    // 不得各自读 settings.runtimeMode，两处判据必然漂移）。
    function _isCurrentLane(laneId) {
        if (!_teamEnabled || !_orchestrator) return false;
        return _orchestrator.isCurrentLane(laneId);
    }

    // 单例槽同步：把 controller / state 指到当前 lane 的那条 runtime。
    // 三个调用点：装配单 Agent runtime 后、团队开关开/关后、orchestrator 的切 lane 通知里。
    function _syncSlots() {
        var rt = _currentRuntime();
        controller = (rt && rt.controller) ? rt.controller : null;
        state = (rt && rt.state) ? rt.state : null;
        // 「当前选中」入口的可见性跟着**当前轮次身份**走：切 lane / 开关团队 / 装配单 Agent
        // 都会改身份，而这三件事全都经 _syncSlots —— 这是「团队档按当前 lane 判定」的唯一同步点。
        try { applyAeStateChipVisibility(); } catch (_) { /* 入口缺席（未挂载）：静默 */ }
        // 槽位换人后，依赖「当前 controller/state」的模块级 UI 必须立刻重绘一次——否则会停在
        // 上一个模式/lane 的快照上（团队与独立模式的上下文用量条混在一起、
        // 切过去还是旧的；点条压缩的却是**新**槽的上下文，显示与作用对象错位）。
        // 三件与 onStateChange 的刷新集合同源，不新增判据：发送按钮（忙态）/
        // 上下文用量条（读取的是当前槽 controller 的 active cm）/ 待发送队列 chips。
        try { updateSendButton(); } catch (_) { /* UI 未挂载：静默 */ }
        try { updateContextRing(); } catch (_) { /* 同上 */ }
        try { renderInjectChips(); } catch (_) { /* 同上 */ }
        // 顶栏用量行（团队模式切到别的模式不更新）：团队档那行是当前 lane
        // 的镜像，切走 / 切 lane 后 view 自己的记录往往没变 ⇒ updateTokenStats 的「值未变化」
        // 短路不会重画，行上留的是上一条 lane 的数字。这里按**当前槽的 view** 强制重画一次
        //（团队档刷的是各 lane 自己的隐藏行，随后由 index.js 的镜像搬上顶栏；单 Agent 档直接刷顶栏）。
        try {
            var tsView = (rt && rt.view) ? rt.view : null;
            if (tsView && typeof tsView.refreshTokenStats === 'function') tsView.refreshTokenStats();
        } catch (_) { /* 同上 */ }
        // 顶栏「当前模型」在团队档是**当前 Agent** 的模型：切 lane / 开关团队
        // 都经这里，故这里是唯一通知点（app/index.js 监听后重绘，单 Agent 档行为不变）。
        _notifyLaneModelChanged();
        // 顶栏 token 浮层的绑定跟着当前 runtime 迁移（见 _bindTopTokenPopover 注释）。
        // 放在最后：上面的 refreshTokenStats 可能刚把本 view 的旧监听绑到自己的行上，
        // 迁移只保证「当前 runtime 的 view 绑顶栏共享元素」这一条。
        try { _bindTopTokenPopover(rt); } catch (_) { /* 浮层迁移失败不影响槽切换 */ }
    }

    // ── 「当前选中」入口：本轮身份 + 可行判据──────────────────────────
    // 当前轮身份 = 发消息 / 工具作用域用的那一份：团队档 = 当前 lane 的**身份集合** + laneKey
    //（快照分槽键）；单 Agent 档 = 当前档位映射出的单模块 id（external → agent，与 roundModuleId 同一映射）。
    // **每次现取**（两次调用之间可能切过 lane / 进出过团队），返回值只读不缓存。
    // 为什么需要它：按 `settings.runtimeMode` 判身份时，团队档是**派生档**（settings 保持
    // 「切进团队之前那一档」）⇒ 从 shader 档切进团队后，director lane 上悬浮恒写「当前轮不注入 AE
    // 上下文」、显隐也按上一个模式的规则走（真机复现：当前选中仍是切之前的那个模式）。
    function roundIdentity() {
        var rt = _currentRuntime();
        var laneKey = _currentLaneId() || '';
        var c = (rt && rt.controller) ? rt.controller : controller;
        if (c && typeof c.getModuleIds === 'function') {
            var ids = null;
            try { ids = c.getModuleIds(); } catch (_) { ids = null; }
            if (ids && ids.length) {
                return { ids: (Array.isArray(ids) ? ids.slice() : [ids]), laneKey: laneKey, source: 'lane' };
            }
        }
        var mode = '';
        try {
            var s = (rt && typeof rt.getSettings === 'function') ? rt.getSettings() : null;
            mode = (s && s.runtimeMode) || '';
        } catch (_) { mode = ''; }
        if (!mode) mode = 'script';
        var one = (c && typeof c.roundModuleId === 'function') ? c.roundModuleId(mode) : mode;
        return { ids: one ? [one] : [], laneKey: '', source: 'mode' };
    }

    // 当前轮身份能不能读到工程：判据与发消息时**同一份数据**——注册表里 queryProject 的
    // enabled / 模块禁用 / scope.moduleIds 成员匹配（即 toolExecutor.checkAccess 的 scope 分支）。
    // **不另维护模式名单**（`!isShader` 口径就是一份会漂移的名单）：AE Tools UI 里改
    // queryProject 的 scope 或按模块禁用它，会立刻影响「当前轮快照真的能不能注入」，入口可见性必须跟它同步。
    // 返回 true / false；**判不出来**（注册表或该工具缺席：旧部署 / 尚未注册）返回 null，调用方按模式口径回落。
    function chipVerdictFromRegistry(toolRegistry, ids) {
        if (!toolRegistry || typeof toolRegistry.get !== 'function') return null;
        var tool = null;
        try { tool = toolRegistry.get('queryProject'); } catch (_) { tool = null; }
        if (!tool) return null;
        if (tool.enabled === false) return false;
        var list = [];
        if (Array.isArray(ids)) list = ids.slice();
        else if (typeof ids === 'string' && ids) list = [ids];
        if (list.length) {
            var disabled = false;
            try {
                if (typeof toolRegistry.isModuleDisabledAnywhere === 'function') {
                    disabled = !!toolRegistry.isModuleDisabledAnywhere('queryProject', list);
                } else if (typeof toolRegistry.isModuleDisabled === 'function') {
                    for (var i = 0; i < list.length; i++) {
                        if (toolRegistry.isModuleDisabled('queryProject', list[i])) { disabled = true; break; }
                    }
                }
            } catch (_) { disabled = false; }
            if (disabled) return false;
            var scope = tool.scope;
            if (scope && scope.type === 'module') {
                var scoped = (Array.isArray(scope.moduleIds) && scope.moduleIds.length)
                    ? scope.moduleIds : (scope.moduleId ? [scope.moduleId] : []);
                var hit = false;
                for (var j = 0; j < list.length; j++) {
                    if (scoped.indexOf(list[j]) >= 0) { hit = true; break; }
                }
                if (!hit) return false;
            }
        }
        return true;
    }

    // 入口可见性的**唯一写点**：可见 ⇔ 本轮身份真能读到工程；判不出来时回落「不是 shader 档」
    //（与改动前 `runtimeMode !== 'shader'` 逐字同义）。三个触发点：挂载收尾、_syncSlots、app 层
    // refreshList（模式 chrome 的落点）。返回上下文供单测/诊断；工厂实例缺席时返回 null（不改 DOM）。
    function applyAeStateChipVisibility() {
        if (!_aeStateChip) return null;
        var ri = roundIdentity();
        var v = null;
        try { v = chipVerdictFromRegistry(_llmToolReg, ri.ids); } catch (_) { v = null; }
        var byMode = false;
        if (v === null) {
            var mode = '';
            try {
                var s = (_singleRuntime && typeof _singleRuntime.getSettings === 'function')
                    ? _singleRuntime.getSettings() : null;
                mode = (s && s.runtimeMode) || '';
            } catch (_) { mode = ''; }
            v = (mode !== 'shader');
            byMode = true;
        }
        _aeStateChip.setVisible(!!v);
        return { visible: !!v, ids: ri.ids, laneKey: ri.laneKey, identity: ri.source, by: byMode ? 'mode' : 'registry' };
    }

    // 切 lane 后的 UI 落点（状态栏复用一条）：
    //   · 共用状态栏：把新当前 lane 的忙态重放到那条唯一的栏上（否则栏上留着上一条 lane 的
    //     文案与脉冲）。三条 lane 的 status/panel 节点都指向单例，写闸门只放当前 lane 过
    //     ——重放就是「换人之后把栏刷成新人的样子」这一步。
    //   · **切 lane 提示**（切过去时短暂弹一条「已切到 XXX」，2.5s 自动收）：
    //     空闲 lane 重放出来是「隐藏」，点完胶囊没有任何可见反馈；忙的 lane 有执行文案。
    //     这条提示把两种情况的「换人了」都给足，到点由 view.flashStatus 回到真实状态。
    //     只在**真的换了**（next 与 prev 都有值且不等）时弹——装配期/首次进团队不弹。
    //   · lane 容器显隐与顶栏：程序化切 lane（AEEngine.setCurrentLane、编排面内部切换、外部
    //     派单）不经过 teamUI 的点击入口，UI 没有别的机会知道「当前 lane 换了」——容器会
    //     停在旧 lane 上（真源与界面不一致）。
    // 三段都各自兜错：UI 缺席（未挂载/加载失败）或重放抛错都不该让切 lane 本身失败。
    function _syncLaneChrome(nextId, prevId) {
        var cur = '';
        try {
            var orch = _orchestrator;
            cur = (orch && typeof orch.getCurrentLane === 'function') ? (orch.getCurrentLane() || '') : '';
            var rt = (cur && orch && typeof orch.getLane === 'function') ? orch.getLane(cur) : null;
            if (rt && rt.view && typeof rt.view.replayBusy === 'function') rt.view.replayBusy();
            // 提示条：lane 显示名取定义里的 label（导演 / AE 执行 / Shader 执行），拿不到就退回 id
            // **只在空闲 lane 上弹**（否则切 Agent 会激活状态栏的运行态动画）：
            //   · 忙 lane 重放出来就是「调用工具: x…」这类真状态，它本身就是「换人了」的可见反馈，
            //     再叠一条提示只会把真状态盖掉 2.5s（用户更看不懂）；
            //   · 提示本身按**非忙态**写入（view._writeHint：不挂 is-generating，见那里的注释）。
            var busy = !!(rt && rt.state && rt.state.busy);
            var changed = !!nextId && !!prevId && nextId !== prevId && cur === nextId;
            if (changed && !busy && rt && rt.view && typeof rt.view.flashStatus === 'function') {
                rt.view.flashStatus(AEI18n.t('已切到 ') + _laneLabelOf(cur));
            }
        } catch (_) { /* 重放/提示失败：栏上文案可能旧一拍，但不该打穿切 lane */ }
        try {
            var ui = global.AEAgentTeamUI;
            if (ui && typeof ui.syncLaneVisibility === 'function') ui.syncLaneVisibility();
            if (ui && typeof ui.syncTopBar === 'function') ui.syncTopBar();
        } catch (_) { /* UI 缺席：保持引擎侧状态 */ }
    }

    // lane 显示名（提示条文案用）：lanes.list() 的 label 是唯一事实源，拿不到就退回 id。
    function _laneLabelOf(id) {
        try {
            var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
            if (api && typeof api.list === 'function') {
                var defs = api.list() || [];
                for (var i = 0; i < defs.length; i++) {
                    if (defs[i] && defs[i].id === id) return defs[i].label || id;
                }
            }
        } catch (_) { /* 定义拿不到：用 id 兜底（宁可显示 id，不可缺口） */ }
        return id;
    }

    // 隐藏三条 lane 容器（orchestrator.dispose 经注入的 hideContainers 调）。用 hidden 属性：
    // 与 index.html 骨架的初始态（<div class="ae-agent-lane" … hidden>）及 main.js 的显隐口径一致。
    function hideLaneContainers(ids) {
        if (!ids || !ids.length) return;
        for (var i = 0; i < ids.length; i++) {
            var el = byId(ids[i]);
            if (el) el.hidden = true;
        }
    }

    // lane cm 清单：三条 lane 的 cm 不在 _scriptContextManager 那三个模块级槽里，漏了它们
    // ⇒ 团队 lane 的用量分母恒为手填兜底值，不随模型自报窗口更新。
    function _laneContextManagerList() {
        var out = [];
        for (var k in _laneContextManagers) {
            if (Object.prototype.hasOwnProperty.call(_laneContextManagers, k) && _laneContextManagers[k]) {
                out.push(_laneContextManagers[k]);
            }
        }
        return out;
    }

    // 已装配 lane store 的清单（{ id, store }）：团队从未开启 / lane 尚未装配 ⇒ 空数组。
    // 登记顺序 = lane 定义顺序（createLaneRuntime 按 orchestrator 的定义序被调用）。
    function _laneStoreList() {
        var out = [];
        for (var i = 0; i < _laneStoreIds.length; i++) {
            var id = _laneStoreIds[i];
            var st = _laneSessionStores[id];
            if (st) out.push({ id: id, store: st });
        }
        return out;
    }

    // 七条会话 store 的**唯一收集点**：单 Agent 三档
    // （script / agent / shader）+ 四条 lane（team-director / team-ae / team-glsl / team-asset）。
    // 四个消费方（启动恢复链 / beforeunload 与 unmount 的落盘 / chat_img 引用集 /
    // temp 体积预算）一律从这里取，不各自手写数组——散点收集就是漏改的温床：
    //   · 落盘漏一条 → 切 lane 后那条 lane 的最后一次防抖写丢失；
    //   · chat_img 引用集漏一条 → 那条 lane 会话里仍在用的附件被当孤儿清掉（死链，不可恢复）；
    //   · 体积预算漏一条 → 同上（预算路径的删除判据也是这个引用集）。
    // 团队关闭 / 从未开启时恰是改动前那三条、同顺序 ⇒ 未启动态行为逐字不变。
    function _allSessionStores() {
        var out = [];
        var base = [_scriptSessionStore, _agentSessionStore, _shaderSessionStore];
        for (var i = 0; i < base.length; i++) {
            if (base[i]) out.push(base[i]);
        }
        var lanes = _laneStoreList();
        for (var j = 0; j < lanes.length; j++) out.push(lanes[j].store);
        return out;
    }

    // 团队工作区目录预建（面板侧 AEFS 预建）：幂等，失败/异常都**显式告警**
    // 但不打穿调用链（工作区不可建不该让会话切换失败——只有只读工具，缺目录时读取会
    // 自己报 not_found）。sid 为空（还没绑定团队会话）时什么都不做。
    function _ensureTeamWorkspace(sid) {
        if (!_teamWorkspace || typeof _teamWorkspace.ensureDir !== 'function') return null;
        if (typeof sid !== 'string' || !sid) return null;
        var p = null;
        try {
            p = _teamWorkspace.ensureDir(sid);
        } catch (e) {
            console.warn('[Agent] 团队工作区预建异常（' + sid + '）: ' + ((e && e.message) || e));
            return null;
        }
        return Promise.resolve(p).then(function (r) {
            if (!r || r.ok !== true) {
                console.warn('[Agent] 团队工作区预建失败（' + sid + '）: ' + ((r && r.reason) || 'unknown'));
            }
            return r;
        }, function (e) {
            console.warn('[Agent] 团队工作区预建异常（' + sid + '）: ' + ((e && e.message) || e));
            return null;
        });
    }

    // ── 团队会话的「开箱即用」建立/恢复──────────────────────
    // 缺陷形态（真机活体取证）：运行时开启团队模式时 `_enableTeam` 只建三条 lane runtime，
    // 三条 controller 全停在初始 'default' 会话；若从未建过团队会话（binder currentSid
    // 为空），团队域工具从一开始就失效 —— `write_workspace` 如实报 no_team_session、
    // `send_message` 如实报 not_team，用户在面板上没有任何补救提示；lane 的对话还会写进
    // 索引外的 `default` 孤儿文件（重载后列表里不可达）。
    // 判据（只信可复核状态，不猜）：
    //   · 三条 lane store 的 lastActiveId **全等且非空** ⇒ 上一次运行整队停在这条团队会话上，
    //     整队绑回它（switchTeamSession，与「整队切换」同一条通道）；
    //   · 其余（首启 / 分叉 / 索引读不到）⇒ 新建一条团队会话（createTeamSession）。
    // 为什么不复用 noteRestoredSession：它只「认领」不下发，且要求三条 controller **已经**
    // 在这条会话上；开团队这一刻 controller 还停在 'default'，认领必失败。
    // 同步、幂等、永不抛：团队关着 / binder 缺席 / 已绑定 / lane 未装配 ⇒ null（什么都不做）。
    function _laneLastActiveIds() {
        var list = _laneStoreList();
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var sid = '';
            try { sid = list[i].store.getLastActiveId() || ''; } catch (_) { sid = ''; }
            out.push({ id: list[i].id, sid: sid });
        }
        return out;
    }

    function _ensureTeamSessionBound(where) {
        if (!_teamEnabled || !_orchestrator || !_sessionBinder) return null;
        if (typeof _sessionBinder.getCurrentSessionId !== 'function') return null;
        var cur = '';
        try { cur = _sessionBinder.getCurrentSessionId() || ''; } catch (_) { cur = ''; }
        if (cur) return { ok: true, sid: cur, bound: true, reused: true };
        var lanes = _laneLastActiveIds();
        if (!lanes.length) return null;
        var agreed = lanes[0].sid;
        for (var i = 1; i < lanes.length; i++) {
            if (lanes[i].sid !== agreed) { agreed = ''; break; }
        }
        var res = null;
        try {
            res = agreed ? _sessionBinder.switchTeamSession(agreed) : _sessionBinder.createTeamSession();
        } catch (e) {
            res = { ok: false, reason: 'throw', detail: String((e && e.message) || e) };
        }
        if (!res || res.ok !== true || typeof res.sid !== 'string' || !res.sid) {
            // 如实告警、不静默：工具层下次调用仍会如实失败，用户可在会话菜单手动新建。
            console.warn('[Agent] 团队会话自动建立失败（' + (where || '') + '）: '
                + JSON.stringify(res) + '；lane lastActiveId='
                + JSON.stringify(lanes.map(function (x) { return x.sid; })));
            return res || { ok: false, reason: 'no_result' };
        }
        console.log('[Agent] 团队会话已就绪（' + (where || '') + '）: ' + res.sid
            + (agreed ? '（绑回上次会话）' : '（新建）'));
        // UI 刷新（**窄接口**）：两处调用点都在各自收尾段（恢复链 finally / 开关返回之后），
        // 而绑定是异步（等 lane store 就绪）发生的 ⇒ 不补这一下，工具面已可用但顶栏会话名与
        // 会话菜单可能停在空态/旧标题，直到下一次 ae:team-state-changed。**不回落宽接口**
        // （refreshSessionSwitcher = 团队 UI 全量重挂载，300–600ms/次，见 agent/index.js:401-413）；
        // 旧部署没有窄接口时留给下一次状态事件自愈。
        try {
            if (global.AEEngine && typeof global.AEEngine.refreshSessionTitle === 'function') {
                global.AEEngine.refreshSessionTitle();
            }
        } catch (e) {
            console.warn('[Agent] 团队会话绑定后刷新标题失败（不影响工具面）: ' + ((e && e.message) || e));
        }
        return res;
    }

    // 运行时开关路径的调度：lane store 可能还没读完索引（getLastActiveId 为空 ⇒ 会被误判
    // 「分叉」而新建），故等三条 store 就绪再落。启动恢复窗口内直接跳过 —— 链尾
    // （restore finally）是那段时间的唯一落点，避免两条路径同时下发切换。
    var _teamSessionEnsureInFlight = false;
    function _scheduleTeamSessionEnsure(where) {
        if (_teamSessionEnsureInFlight) return;
        if (!_teamEnabled || !_orchestrator || !_sessionBinder) return;
        if (_restoreInFlight) return;
        var cur = '';
        try { cur = _sessionBinder.getCurrentSessionId() || ''; } catch (_) { cur = ''; }
        if (cur) return;
        var list = _laneStoreList();
        if (!list.length) return;
        _teamSessionEnsureInFlight = true;
        Promise.all(list.map(function (e) { return _whenStoreReady(e.store); })).then(function (readies) {
            _teamSessionEnsureInFlight = false;
            if (!_teamEnabled) return;   // 期间被关团队：不动作
            // 超时**如实告警**（与恢复链同口径，不静默）：store 未就绪时 adoptSession 会
            // not_ready，自动建立可能失败；工具层仍会如实报 no_team_session，不假装可用。
            if (readies && readies.some(function (r) { return r === false; })) {
                console.warn('[Agent] 部分 lane store 在 ' + _storeReadyTimeoutMs
                    + 'ms 内未就绪，团队会话自动建立按「未就绪」继续（可能失败）');
            }
            _ensureTeamSessionBound(where);
        }, function () { _teamSessionEnsureInFlight = false; });
    }

    // ── lane 忙碌态 → 团队锁的**事件驱动**刷新 ────────────────────────────────────
    // 背景：switcher 的禁用态判据是「任一 lane busy ‖ stopping ‖ switching」（teamUI.anyLaneLocked），
    // 而刷新时机只有三条：main.js 三 view 的渲染钩子 notifyLaneActivity / teamUI 动作后的
    // ae:team-state-changed / 「团队任务」tab 可见时的 1Hz 轮询。用户停在别的 tab、某条 lane 在
    // 后台起一轮时，锁态要等下一次渲染或轮询才对上——UI 与真相源之间存在可观测的滞后窗口
    //（此时点它会被 binder 以 busy 拒并提示，不静默，但锁本该已经是灰的）。
    // 这里把 controller **已有**的 onBusyChange 钩子（chatViewHelpers.syncView 的团队分支调它）
    // 接到 index.js 的两个公开刷新口上：状态本来就在变的那条链自己把刷新带出来，**不新增轮询**。
    //
    // 去重（必做）：钩子的调用方在**每次** state 变化时都调它（含流式输出每帧的部分回复），
    // 不去重就会每帧刷一次 DOM。判据按 lane 记 **(busy, stopping, switching) 三元组**，变化才转发。
    // 三元组的实现、以及为什么必须有第三项 _switching 见下方 _mkBusyChangeDeduper。
    // 为什么状态放在 per-lane 闭包而不是模块级表：runtime 重建（关团队再开）时新 controller 的
    // 初始态必然是「不忙、没在切」，闭包跟着重建 ⇒ 首次真实变化不会被上一代 runtime 的陈旧记录吃掉。
    // getController 是**惰性**取值函数：reporter 在 createLaneRuntime 里、controller 建出来之前就注入，
    // 调用时才解析（那时 rt.controller 一定已就位）。
    // 去重核（lane 与主 Agent **共用这一份**，见下面两个薄封装）：判据按 **(busy, stopping, switching)**
    // 三元组**按 lane 各自记忆**，变化才转发。为什么必须有第三项 _switching：锁判据
    // 本身是「busy ‖ stopping ‖ switching」（teamUI.anyLaneLocked，见 teamUI.js:162-171），而钩子只带
    // busy/stopping —— `_switching` 单独跳变（busy=false、stopping=false、switching=true，即一次纯会话
    // 切换的窗口）在二元组里**看不见**，团队锁只能等下一次渲染/事件/轮询才对上，点下去被 binder 以
    // busy/switching 拒。故这里在收到上报时补读本 lane 的 controller.getSwitching()（controller.js:3665/
    // 3738 的真实出口；与 teamUI 的同名读法同源），把它并进去重键。
    // 为什么状态放在闭包而不是模块级表：runtime 重建（关团队再开）时新 reporter 跟着重建 ⇒ 初始态
    // 必然是「不忙、没在切」，上一代 runtime 的陈旧记录不会吃掉首次真实变化。
    // getController 是**惰性**取值函数：reporter 在 createLaneRuntime 里、controller 建出来之前就注入，
    // 调用时才解析（那时 rt.controller 一定已就位）。
    // gate（可选）：返回假时**直接返回**——不上报、也不推进去重记录（团队关闭时主 Agent 那条的口径）。
    function _mkBusyChangeDeduper(getController, gate, onChanged) {
        var lastBusy = false;
        var lastStopping = false;
        var lastSwitching = false;
        return function (busy, stopping) {
            if (typeof gate === 'function' && !gate()) return;
            var b = !!busy;
            var s = !!stopping;
            var w = _laneSwitchingOf(getController);
            if (b === lastBusy && s === lastStopping && w === lastSwitching) return;
            lastBusy = b;
            lastStopping = s;
            lastSwitching = w;
            onChanged(b, s);
        };
    }

    function _mkLaneBusyChangeReporter(laneId, getController) {
        return _mkBusyChangeDeduper(getController, null, function (b, s) {
            // 忙闲变化只做一件事：刷团队锁（切 lane / 开关团队 / 全部停止的可用性按它判）。
            // 完成回投下线——忙→闲不再给发起方投任何结论；结论由
            // 目标 Agent 完成后自己 send_message 回来。故这里不再调 _notifyLaneIdle。
            _refreshTeamLockFromLane(laneId);
            // goal：执行 lane 干完停手 → 叫醒导演的 goal 评估，
            // 这就是「执行方忘了回报也会被叫去验收」的兜底。导演自己的忙闲不触发（它收尾自评）。
            if (!b && !s && laneId !== 'director') _wakeDirectorGoalForLaneIdle(laneId);
        });
    }

    // 其它 lane 忙→闲时触发导演的 goal 评估（只在团队档、且导演目标 armed 时 driver 会真的开轮）。
    function _wakeDirectorGoalForLaneIdle(laneId) {
        if (!_teamEnabled || !_orchestrator) return;
        var rt = null;
        try { rt = _orchestrator.getLane('director'); } catch (_e) { rt = null; }
        var c = rt && rt.controller;
        if (!c || typeof c.goalEvaluate !== 'function') return;
        try { c.goalEvaluate('lane-idle:' + laneId); } catch (e) {
            console.warn('[Agent] 导演 goal 评估失败（lane-idle）: ' + ((e && e.message) || e));
        }
    }

    // ── goal 续轮的装配层判据 ────────────────────────
    // 让行：除本 lane 外，任何 lane（含团队主 Agent 通道）忙/停/切中都算「在干活」。
    // 判不出来时按「在忙」处理：宁可少唤一轮，不在别人干活时插队。
    function _goalOtherLanesBusy(exceptLaneId) {
        try {
            var entries = [];
            if (_singleRuntime) entries.push({ id: '', rt: _singleRuntime });
            var lanesApi = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var defs = (lanesApi && typeof lanesApi.list === 'function') ? (lanesApi.list() || []) : [];
            for (var i = 0; i < defs.length; i++) {
                var lid = defs[i] && defs[i].id;
                if (!lid) continue;
                entries.push({ id: lid, rt: _orchestrator ? _orchestrator.getLane(lid) : null });
            }
            for (var j = 0; j < entries.length; j++) {
                if (entries[j].id === exceptLaneId) continue;
                var rt = entries[j].rt;
                var c = rt && rt.controller;
                if (!c) continue;
                if (typeof c.isBusy === 'function' && c.isBusy()) return true;
                if (typeof c.isStopping === 'function' && c.isStopping()) return true;
                if (typeof c.getSwitching === 'function' && c.getSwitching()) return true;
            }
        } catch (e) {
            console.warn('[Agent] goal 让行判据失败（按在忙处理）: ' + ((e && e.message) || e));
            return true;
        }
        return false;
    }

    // goal 三工具在共享注册表里是 last-wins：通道形态变化（开关团队）后，让**当前该有的那条**
    // controller 再注册一次，保证 handler 绑定到它自己的门面。laneId 为空 = 单 Agent 通道。
    function _reclaimGoalTools(laneId) {
        var rt = null;
        try {
            rt = laneId
                ? (_orchestrator ? _orchestrator.getLane(laneId) : null)
                : _singleRuntime;
        } catch (_e) { rt = null; }
        var c = rt && rt.controller;
        if (!c || typeof c.goalRegisterTools !== 'function') return;
        try { c.goalRegisterTools(); } catch (e) {
            console.warn('[Agent] goal 工具归属回收失败（lane=' + (laneId || 'single') + '）: '
                + ((e && e.message) || e));
        }
    }

    // 让行：该 lane 名下活跃子 Agent 数（queued/running/waiting 都算，判据唯一来源是 taskBoard）。
    function _goalActiveSubagents(laneId) {
        var pool = _subagentPool;
        if (!pool || typeof pool.list !== 'function') return 0;
        var isActive = (global.AEAgentTeam && typeof global.AEAgentTeam.isSubagentActive === 'function')
            ? global.AEAgentTeam.isSubagentActive : null;
        try {
            var rows = pool.list() || [];
            var n = 0;
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i] || {};
                if (r.parentLane !== laneId) continue;
                if (isActive ? isActive(r)
                    : (r.state === 'queued' || r.state === 'running' || r.state === 'waiting')) n++;
            }
            return n;
        } catch (_e) { return 0; }
    }

    // _notifyLaneIdle 随「完成回投下线」一起删除（原职责：把 lane 忙→闲翻译成
    // 『single' → 'main'』并调编排面的 noteLaneIdle 把结论回投给发起方；现在结论由目标 Agent
    // 完成后自己 send_message 回来，引擎不再做任何自动转交）。
    // _mkMainBusyChangeReporter 随团队主通道移除——团队档内不再有
    // 单 Agent runtime，单 Agent 的忙闲锁由 chatViewHelpers 的 non-team 分支直接置
    // setSessionSwitcherDisabled，不需要第二条「主 Agent 上报」腿（两条腿互相顶掉正是 N7 的形态）。

    // 本 lane 是否正在切换会话（fail-safe）：`_switching` 是 controller 的闭包内私有态。
    // controller 公开面提供 `isSwitching/getSwitching/isStopping/getStopping`
    //（真值 = `_switching || _adoptRestoring > 0` / `_stopping`），本函数由恒 false 变真；
    // sessionBinder 的 `_flagsOf` 读同两个出口 ⇒ 回读窗口内的整队会话动作会被拒 `busy`。
    // 取不到（能力缺席 / getController 抛错 / getSwitching 抛错 / 返回值非真）**一律当 false**——
    // 本函数跑在 controller 的状态回调链上，绝不能反过来把异常抛回去（读不到就当没在切，
    // 宁可少一次刷新），也不能默认 true（那会让「读不到」变成每次都触发的刷新风暴）。
    function _laneSwitchingOf(getController) {
        var ctl = null;
        try {
            ctl = (typeof getController === 'function') ? getController() : null;
        } catch (_) { return false; }
        if (!ctl || typeof ctl.getSwitching !== 'function') return false;
        try { return !!ctl.getSwitching(); } catch (_) { return false; }
    }

    // 一次**汇总**刷新：index.js 的两个公开刷新口（在 modules/agent/index.js:404-405）。
    // 缺席（模块未加载 / 单测环境）时静默跳过；抛错**不得**冒泡回 controller 的状态回调
    //（那会让一次 UI 刷新失败表现成「这一轮状态没同步」），故逐个 try/catch + 告警留痕。
    function _refreshTeamLockFromLane(laneId) {
        var eng = global.AEEngine;
        if (!eng) return;
        var names = ['refreshTeamSwitcherLock', 'refreshTeamChrome'];
        for (var i = 0; i < names.length; i++) {
            if (typeof eng[names[i]] !== 'function') continue;
            try {
                eng[names[i]]();
            } catch (e) {
                console.warn('[Agent] 团队锁刷新失败（' + names[i] + '，lane=' + laneId + '）: ' + ((e && e.message) || e));
            }
        }
    }

    // ── 子 Agent 的模块级装配面 ───────────────────────────────
    // 池是**模块级单例**（与 binder 同款，V40① 的处置）：team 域工具在**装配期**注册，池必须
    // 在那之前就位（注册点唯一，不做二次注册）；面板重挂（模块切换）时池不重建——注册表里那三件
    // 工具持有的就是它，故 runTurn 走**晚绑定**间接层：重挂后解析到新挂载的运行器闭包，否则子
    // Agent 会用上一代挂载的工作区/设置跑（真机表现：切走模块再回来，子 Agent 还在写旧工作区）。
    var _subagentPool = null;          // 子 Agent 池实例（AEAgentTeam.createSubagentPool 产出）
    var _subagentLimits = null;        // team.subagent 的归一值快照（池与运行器**共用这一份**）
    var _subagentRunTurnImpl = null;   // 当前挂载的运行器实现（晚绑定；未挂载时为 null）
    var _subagentNamesWarned = false;  // 「剔除名单走兜底」只告警一次（装配期 + 每次 spawn 都会问）
    var _subagentSetLimitsWarned = false;  // 「池缺 setLimits（旧部署）」只告警一次（每次回灌都会问）
    // id → 运行器实例。**为什么要有这张表**：追问（ask）是「同一 ctx 再跑一轮」——池复用同一个
    // ctx 对象（rec.ctx），运行器必须复用**同一个 cm/state/controller**，否则追问会变成"另起一个
    // 什么都不记得的子 Agent"，而回执上完全看不出（它会一本正经地重新开始）。释放时机见
    // _notifySubagentStateChange：池的状态是唯一判据（只有 running/waiting 才可能再跑一轮）。
    var _subagentRuntimes = {};

    // 被剔除的三件工具名（**一层边界**：不做嵌套）。名字的定义源在 team/teamTools.js
    //（它注册这三件并导出 AEAgentTeam.SUBAGENT_TOOL_NAMES）；缺席时用同名字面量兜底——那种情况下
    // 这三件本来也没注册，兜底只为不让「收窄判据」退化成一个空集合（空集合是静默失效，不是安全）。
    var SUBAGENT_TOOL_NAMES_FALLBACK = ['spawn_subagent', 'send_message', 'list_agents'];

    function _subagentToolNames() {
        var api = global.AEAgentTeam;
        var list = (api && api.SUBAGENT_TOOL_NAMES);
        if (list && list.length) return list;
        if (!_subagentNamesWarned) {
            _subagentNamesWarned = true;
            console.warn('[Agent] teamTools 未导出 SUBAGENT_TOOL_NAMES：子 Agent 的剔除名单走兜底字面量');
        }
        return SUBAGENT_TOOL_NAMES_FALLBACK;
    }

    // team.subagent 的归一值：**唯一来源**是 engine/settings.js 的 normalizeTeam（V39 的
    // 「不许第二份归一」口径；默认值也在那里，这里不抄字面量）。归一实现缺席（未加载 settings.js
    // 的宿主/测试桩）⇒ 返回 null，装配侧据此**不建池、不注册三件工具**：缺的就是缺的，不拿一份
    // 手抄的默认值假装归一还在。
    // 读设置的入口是**参数**（不是闭包里的 getSettings）：模块级函数，重挂路径（mount 已被
    // mounted 守卫吞掉时）也要能拿本次挂载的那一份读法。
    function _subagentGate(getSettingsFn) {
        var s = ns.settings || {};
        if (typeof s.normalizeTeam !== 'function') return null;
        if (typeof getSettingsFn !== 'function') return null;
        var team = null;
        try {
            team = s.normalizeTeam((getSettingsFn() || {}).team);
        } catch (_) { return null; }
        var sa = team && team.subagent;
        if (!sa) return null;
        return { maxConcurrent: sa.maxConcurrent, keepAliveMs: sa.keepAliveMs, maxLoops: sa.maxLoops };
    }

    // 三闸**回灌**（复核修）：把当前 _subagentLimits 写进池。**为什么需要**：池是模块级单例（重挂
    // 不重建——在册子 Agent 与 id 序号语义都挂在它身上），而 team.subagent 是**运行期可改**的设置；
    // 不回灌就出现「改了设置不生效、重挂也不生效，只能整页重载」（两位审查独立复现，见报告）。
    // 能力探测 + try/catch 留痕（与 clear 那类能力调用同风格）：池不存在或池缺 setLimits（旧部署的
    // subagent.js）时**如实告警**，不假装写过了；单例池的判据始终在池自己手里（这里只是把值送进去）。
    function _pushSubagentLimitsToPool() {
        if (!_subagentPool || !_subagentLimits) return null;
        if (typeof _subagentPool.setLimits !== 'function') {
            if (!_subagentSetLimitsWarned) {
                _subagentSetLimitsWarned = true;
                console.warn('[Agent] 子 Agent 池没有 setLimits（subagent.js 版本偏旧）：'
                    + 'team.subagent 的运行期改动不会生效，需整页重载');
            }
            return null;
        }
        try {
            return _subagentPool.setLimits({
                maxConcurrent: _subagentLimits.maxConcurrent,
                keepAliveMs: _subagentLimits.keepAliveMs,
                maxLoops: _subagentLimits.maxLoops
            });
        } catch (e) {
            console.warn('[Agent] 子 Agent 三闸回灌池失败（沿用池里的旧判据）: ' + ((e && e.message) || e));
            return null;
        }
    }

    // 重挂路径的三闸重读+回灌（mount 在已挂载时会早退，见那里的注释）：读**本次**挂载给的
    // getSettings ⇒ 归一 ⇒ 回灌。归一值取不到（settings.js 未加载/抛错）时**保持池里现有判据**，
    // 不拿手抄默认值覆盖（缺的就是缺的）。返回归一值供诊断/单测断言。
    function _resyncSubagentLimits(getSettingsFn) {
        var limits = _subagentGate(getSettingsFn);
        if (!limits) return null;
        _subagentLimits = limits;
        _pushSubagentLimitsToPool();
        return limits;
    }

    // ── 子 Agent 名册的**会话归属**─────────────────────
    // 名册与团队任务清单同属一个团队会话：清单经 `_teamTaskList.bindSession` 随会话换文件，而子
    // Agent 池是**模块级单例**（重挂不重建——在册记录与 id 序号语义都挂在它身上）⇒ 旧会话的记录会
    // 一直挂在名册上：
    //   · 跨会话可见：探针会话里派的 4 条，切回用户会话后仍在 `getBoardSnapshot().subagents` 与
    //     `list_agents` 里（池是单例、工具直透 pool.list()）；
    //   · 跨**已删**会话残留：删掉探针会话后那条记录仍挂在名册上（state=stopped）。
    // 修法：**绑定换了一条会话**的那一刻清池。binder 切会话前已 `stopAll` 过一遍（在跑的都停了）
    // ⇒ clear 只是把名册与统计归零，不会打断任何还在跑的东西。
    // 三条边界都**不清**（否则会伤既有的「重挂不重建」契约，那是池的单例语义）：
    //   · 首次绑定（本模块还没记过 sid：整页重载后 mount 的第一次 bind）——池本来就是空的；
    //   · 同 id 重绑（面板重挂 / mount 再绑一次）——池特意保留在册记录与 id 序号；
    //   · sid 为空（解绑）——团队关闭路径自己会 clear（见 _disableTeam）。
    var _subagentRosterSid = null;
    function _syncSubagentRoster(sid) {
        var prev = _subagentRosterSid;
        _subagentRosterSid = sid || null;
        if (!sid || !prev || prev === sid) return 'kept';
        if (!_subagentPool || typeof _subagentPool.clear !== 'function') return 'unavailable';
        try {
            _subagentPool.clear();
            // 回投去重表与名册同寿命（旧 id|turns 的键留着只会涨，且名册已归零）
            _subagentDelivered = {};
            return 'cleared';
        } catch (e) {
            console.warn('[Agent] 换会话时子 Agent 名册清理失败（旧会话的子 Agent 可能仍挂在名册上）: '
                + ((e && e.message) || e));
            return 'error';
        }
    }

    // runTurn 的晚绑定入口（模块级，见 _subagentPool 注释）。**绝不向上抛**：池的 spawn 链把
    // runTurn 的返回体当子 Agent 的终态，抛出去会变成池内部的一个未捕获拒绝（子 Agent 卡在
    // running，用户看到的是「一直在跑」而没有任何原因）。
    function _subagentRunTurn(ctx) {
        if (typeof _subagentRunTurnImpl !== 'function') {
            return Promise.resolve({
                ok: false, reason: 'not_wired',
                message: '子 Agent 运行器未装配（Agent 模块未挂载或装配失败）：本次不启动。'
            });
        }
        try {
            return Promise.resolve(_subagentRunTurnImpl(ctx));
        } catch (e) {
            return Promise.resolve({
                ok: false, reason: 'error',
                message: '子 Agent 运行器异常：' + String((e && e.message) || e)
            });
        }
    }

    // 运行器的回收：**判据只有一个** —— 池自己的 list() 行状态。只有 running/waiting 的子 Agent
    // 还可能再跑一轮（追问 = 同一 ctx 再跑一轮）；终态（done/failed/stopped）的运行器立刻释放
    //（它的 cm/state/controller 再也用不到了，留着就是每个子 Agent 一份常驻上下文）。
    // 为什么不在本文件写一份终态名单：那是把池的状态机抄第二遍（池的 TERMINAL 才是判据源），
    // 池将来加一个状态，抄来的那份必然漂移。
    function _pruneSubagentRuntimes(rows) {
        var keep = {};
        var list = (rows && rows.length) ? rows : [];
        for (var i = 0; i < list.length; i++) {
            var r = list[i] || {};
            if (r.id && (r.state === 'running' || r.state === 'waiting')) keep[r.id] = true;
        }
        for (var id in _subagentRuntimes) {
            if (!Object.prototype.hasOwnProperty.call(_subagentRuntimes, id)) continue;
            if (!keep[id]) delete _subagentRuntimes[id];
        }
    }

    // 池的状态变化 → 团队 UI 的**事件面**（唯一通道）+ 运行器回收（见 _pruneSubagentRuntimes）
    // + **完成回投**（派遣是异步的）。
    // teamUI.js 头注写明「派单、子 Agent 完成等也可派发同一事件」⇒ 这里派发同一个
    // ae:team-state-changed，不新造第二个通知通道（UI 的刷新节奏、卡片渲染都归它自己）。
    function _notifySubagentStateChange(snapshot) {
        try {
            _pruneSubagentRuntimes(snapshot && snapshot.subagents);
        } catch (_) { /* 回收失败不影响状态机（最坏是多留一份上下文到面板重载） */ }
        try {
            _deliverSubagentResult(snapshot);
        } catch (_) { /* 回投失败不影响状态机（结论仍在面板/工作区里可查） */ }
        try {
            var d = (typeof document !== 'undefined') ? document : null;
            if (!d || typeof d.dispatchEvent !== 'function') return;
            var CE = (typeof CustomEvent === 'function') ? CustomEvent : null;
            if (typeof CE !== 'function') return;   // 事件通道可选：没有就什么都不做（不抛）
            d.dispatchEvent(new CE('ae:team-state-changed', { detail: snapshot || null }));
        } catch (_) { /* 派发失败不得回打到池的状态机（状态已更新，UI 下一次轮询会自愈） */ }
    }

    // 完成回投：子 Agent **跑完一轮** ⇒ 把结论投给它的上级 Agent（发起那条 lane 的 controller），
    // 让异步派遣真正闭环（仅 wait:true 的阻塞调用方拿得到结论；异步派出去的结论只躺在池里，
    // 模型只能靠轮询/追问去猜——这是异步派遣无法闭环的根因）。
    //   · 投递点：池的终态（waiting=成功保活 / done=保活到期 / failed / stopped）；**每个 (id, 轮次)
    //     只投一次**（追问会再跑一轮，那时 turns 变了，应该再投一次）。
    //   · **用户直接追问的轮次只记录、不唤醒**（现象：用户追问之后子 Agent 的消息也会
    //     发给父 Agent，故定为「记录不投递」）：面板弹窗里的追问是用户与子 Agent 的私下对话，
    //     结论卡照进父 lane 的对话与上下文（父 Agent 下次开口能读到），但 injectSystemResult 走
    //     silent 分支 ⇒ 不排 bg-wake，父 Agent 不会被它叫醒去接着干。来源判据 = 池行 turnOrigin。
    //   · 投递方式：`injectSystemResult`（卡片 + 唤醒一轮）——它是既有的「后台结果回流」通道：
    //     结论进上下文，上级 Agent 下一轮能读到并接着干；跨会话/忙碌窗口由那条链自己入队（不用另写守卫）。
    //   · 上级 lane 找不到（团队已关/装配失败）⇒ 只告警，不重试（结论仍在面板与工作区里可查）。
    var _subagentDelivered = {};
    function _deliverSubagentResult(snapshot) {
        var snap = snapshot || {};
        var id = (typeof snap.id === 'string') ? snap.id : '';
        if (!id) return;                                  // 只处理「这一次变化的那一条」
        var rows = (snap.subagents && snap.subagents.length) ? snap.subagents : [];
        var row = null;
        for (var i = 0; i < rows.length; i++) if (rows[i] && rows[i].id === id) row = rows[i];
        if (!row) return;
        var st = String(row.state || '');
        if (st !== 'waiting' && st !== 'done' && st !== 'failed' && st !== 'stopped') return;
        var turns = (typeof row.turns === 'number' && row.turns > 0) ? row.turns : 1;
        // 阻塞调用（wait:true）的**首轮**不投：结论已经在它的工具回执里（同一轮就拿到了），再投一次
        // 就是重复信息 + 白唤醒一轮（两条路径都在，回投只服务异步那条）。
        // 抑制的作用域是**那一轮**，不是整条记录：wait 标记记的是
        // 「这条是怎么派出去的」，而"调用方同步拿到了结论"只对**首轮**成立。追问（send_message =
        // 同一 ctx 再跑一轮）时结论**只**在回投里，按记录级压掉就是结论凭空消失——追问回执承诺
        // 「这一轮的结论会作为消息回投给它的上级 Agent」，实际 systemResults 恒为空（独立复现）。
        // 轮次级判据：turns 由池在**起跑**时自增（subagent.js `_startTurn`），故首轮完成时 turns=1、
        // 追问完成时 turns≥2；turns 读不到时按 1 处理（宁可不重复投，也不猜成追问）。
        if (row.wait === true && turns <= 1) return;
        var key = id + '|' + turns;
        if (_subagentDelivered[key]) return;
        _subagentDelivered[key] = true;
        // 用户直接追问的轮次：**只记录、不唤醒**。
        // 卡片照常落进父 lane 的对话与 LLM 上下文（父 Agent 下次开口时能读到），但 injectSystemResult
        // 走 silent 分支 ⇒ 不排 bg-wake、父 Agent 不会被用户与子 Agent 的私下追问叫醒。
        // 键照样记上：之后 state 变 done 时同一 (id,轮次) 不会再被当成新事件投一次。
        var userTurn = (String(row.turnOrigin || '') === 'user');
        var parentLane = String(row.parentLane || '');
        var ctl = (_orchestrator && parentLane && typeof _orchestrator.getLane === 'function')
            ? (_orchestrator.getLane(parentLane) || null) : null;
        ctl = ctl && ctl.controller ? ctl.controller : null;
        if (!ctl || typeof ctl.injectSystemResult !== 'function') {
            console.warn('[Agent] 子 Agent 结论无法写入上级 Agent（上级 Agent 不在）: ' + id
                + '（结论仍可在团队面板「子 AGENT」段点开查看）');
            return;
        }
        var titleText = (typeof row.title === 'string' && row.title) ? row.title : id;
        var stateText = (st === 'failed') ? '失败' : (st === 'stopped' ? '已停止' : '已完成');
        var summary = (typeof row.summary === 'string') ? row.summary : '';
        // 失败/停止时**必须**把原因带出来：失败原因一直只写在池内部的 rec.error 里
        // （subagent.js 的行结构带 error: { reason, message }），回投正文于是恒为「（这一轮没有
        // 产出结论）」——用户只看到「失败」而读不到为什么。有 summary 时 summary 优先（那是它的结论
        // 本身），没有才用原因兜底。
        var failText = _subagentErrorText(row.error);
        var bodyText = summary || failText || '（这一轮没有产出结论）';
        var head = userTurn
            ? ('子 Agent「' + titleText + '」用户直接追问记录（第 ' + turns + ' 轮 · 不唤醒上级）')
            : ('子 Agent「' + titleText + '」' + stateText + (turns > 1 ? '（第 ' + turns + ' 轮）' : ''));
        var detailText = userTurn
            ? ('这是用户在面板里直接追问子 Agent 得到的结论：只记录、不唤醒上级 Agent；'
                + '需要它继续做事时用 send_message（target 填它的 id）。')
            : ('子 Agent 的完整对话：左侧团队面板「子 AGENT」段点它的那一行进入。'
                + '需要它继续做事时用 send_message（target 填它的 id）。');
        try {
            ctl.injectSystemResult(
                head,
                { text: bodyText },
                { text: detailText },
                'user',
                undefined,
                undefined,
                userTurn                 // silent：用户追问的结论只记录，不排唤醒
            );
        } catch (e) {
            console.warn('[Agent] 子 Agent 结论写入失败（' + id + '）: ' + ((e && e.message) || e));
        }
    }

    // 池行里的失败原因 → 回投正文（⑥）。形状以 subagent.js 的 `_rows()` 为准：`{ reason, message }`
    // （非失败恒为 null）。两个字段都可能缺（旧池 / 桩）：一个都取不到时返回空串，调用方走既有兜底
    // 文案——**不编造原因**。reason 是机器判据（如 turn_failed / empty_result），message 才是给人看的。
    function _subagentErrorText(err) {
        if (!err || typeof err !== 'object') return '';
        var msg = (typeof err.message === 'string') ? err.message.replace(/^\s+|\s+$/g, '') : '';
        var reason = (typeof err.reason === 'string') ? err.reason : '';
        if (!msg && !reason) return '';
        return (reason && msg) ? (reason + '：' + msg) : (msg || reason);
    }

    // AEEngine.view —— **读访问器**：当前 lane 的 view。app/main.js:3484 与 :3810
    // 两处既有读取点因此不因团队模式断裂：拿到的是「用户正在看的那条 lane」的 view；团队关闭时
    // 它与改动前是同一个对象引用。保留 setter：旧写点（若有）仍能读回，不因访问器化而在非严格
    // 模式下静默丢掉赋值。
    Object.defineProperty(ns, 'view', {
        configurable: true,
        enumerable: true,
        get: function () {
            var rt = _currentRuntime();
            return (rt && rt.view) ? rt.view : _viewFallback;
        },
        set: function (v) { _viewFallback = v || null; }
    });

    // 面板关闭/卸载前保存当前会话的 token 统计到独立文件。
    // 经 controller.flushTokenStats 走 tokenStats 的统一规则（取消待触发的防抖保存 +
    // 空记录不写盘 + 归属校验）。无条件写 stats.records||[] 时 —— 卸载时刻
    // records 常已被清空，等于把该会话磁盘上的好统计覆盖成 []（'--' 的直接成因）。
    function _persistActiveTokenStats() {
        try {
            if (!controller || typeof controller.flushTokenStats !== 'function') return;
            controller.flushTokenStats();
        } catch (_) {}
    }

    function byId(id) {
        return document.getElementById(id);
    }

    function on(el, event, handler) {
        if (!el) return;
        el.addEventListener(event, handler);
        listeners.push({ el, event, handler });
    }

    function updateSendButton() {
        const sendBtn = byId('aeAgentSendBtn');
        if (!sendBtn) return;
        const busy = !!(state && state.busy);
        const input = byId('aeAgentInput');
        const hasText = !!(input && input.value && String(input.value).trim());
        // 执行中：输入框有字→发送（追加消息），空→停止。非执行中：恒为发送。
        const showStop = busy && !hasText;
        sendBtn.textContent = showStop ? AEI18n.t('停止') : AEI18n.t('发送');
        sendBtn.classList.toggle('stop-mode', showStop);
    }

    // ── 执行中追加消息底部弹出框（待发送，贴输入区上方）──
    // ── debug 纯预览待发送框（临时弹出，不污染真实队列）──
    var _previewInjectMode = false;
    var _previewInjectQueue = [];
    var _injectCollapsed = false;
    // 团队档「lane 宿主节点缺失」的告警只报一次（renderInjectChips 每次状态变化都会跑）。
    var _injectChipsLaneWarned = false;

    function renderInjectChips() {
        // 浮层宿主：团队档取当前 lane 的那一份（单 Agent 那份随单 Agent 消息区一起隐藏，画进去等于
        // 不可见）；非团队档或取不到 lane 节点时回落单 Agent 节点。宿主解析全程兜错——它的唯一新增
        // 外部调用是 lanes.domFor，抛错只该让浮层回落，不该打断 onStateChange。
        var laneId = '';
        var wrap = null;
        try {
            laneId = _currentLaneId();
            if (laneId) {
                var lanesApi = global.AEAgentTeam && global.AEAgentTeam.lanes;
                var laneDom = (lanesApi && typeof lanesApi.domFor === 'function') ? lanesApi.domFor(laneId) : null;
                if (laneDom && laneDom.injectChipsId) wrap = byId(laneDom.injectChipsId);
            }
        } catch (_) { wrap = null; }
        if (!wrap) {
            // 团队档回落单 Agent 节点 = 画进隐藏容器，界面上看不到；面板骨架未更新时给一次可见线索。
            if (laneId && !_injectChipsLaneWarned) {
                _injectChipsLaneWarned = true;
                console.warn('[AEEngine] 待发送浮层：当前 lane「' + laneId
                    + '」的宿主节点缺失（index.html 骨架未更新？），已回落到单 Agent 节点');
            }
            wrap = byId('aeAgentInjectChips');
        }
        if (!wrap) return;
        var realQueue = (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.getInjectQueue === 'function')
            ? global.AEEngine.bridge.getInjectQueue() : [];
        // 真实队列一旦有内容，自动退出纯预览态，避免预览数据干扰真实待发（预览数据不发送）
        if (_previewInjectMode && realQueue.length > 0) {
            _previewInjectMode = false;
            _previewInjectQueue = [];
        }
        var preview = _previewInjectMode;
        var queue = preview ? _previewInjectQueue : realQueue;
        wrap.innerHTML = '';
        // 队列里可能只有后台系统结果（systemResult）占位：它们不进用户消息、drain 时直接落卡，
        // 不渲染成待发行。若整队都是这种占位，抽屉要整条隐藏——否则出现「有待发送抽屉、
        // 里面什么都没有」的空白条（真机：goal 续轮卡被错误入队后，
        // 独立模式一直显示一条空的「待发送」抽屉）。
        var userCount = 0;
        for (var qi = 0; qi < queue.length; qi++) {
            if (queue[qi] && !queue[qi].systemResult) userCount++;
        }
        if (userCount === 0) {
            wrap.style.display = 'none';
            return;
        }
        wrap.style.display = 'flex';
        wrap.classList.toggle('collapsed', _injectCollapsed);
        // 顶部折叠手柄：点击收起/展开待发送内容（内容为一条横线，状态仅影响待发送区显隐）
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'ae-agent-inject-toggle';
        toggle.title = _injectCollapsed ? AEI18n.t('展开待发送') : AEI18n.t('收起待发送');
        toggle.addEventListener('click', function (e) {
            e.stopPropagation();
            _injectCollapsed = !_injectCollapsed;
            wrap.classList.toggle('collapsed', _injectCollapsed);
            toggle.title = _injectCollapsed ? AEI18n.t('展开待发送') : AEI18n.t('收起待发送');
        });
        wrap.appendChild(toggle);
        // 消息行容器：折叠时整体隐藏，仅保留顶部手柄
        var list = document.createElement('div');
        list.className = 'ae-agent-inject-list';
        for (var i = 0; i < queue.length; i++) {
            // 后台系统结果（system-result）在队列里只是占位等 drain 入历史，无用户文本，
            // 不渲染成可操作的"待发送"行，避免出现空白行。
            if (queue[i] && queue[i].systemResult) continue;
            (function (historyIdx, item) {
                var text = item && item.text ? item.text : '';
                var row = document.createElement('div');
                row.className = 'ae-agent-inject-chip';
                var label = document.createElement('span');
                label.className = 'ae-agent-inject-chip-text';
                label.textContent = text;
                label.title = text; // 超长截断时 hover 显示完整消息
                row.appendChild(label);
                var actions = document.createElement('div');
                actions.className = 'ae-agent-inject-chip-actions';
                // 删除：从队列移除该条
                var delBtn = document.createElement('button');
                delBtn.type = 'button';
                delBtn.className = 'ae-agent-inject-chip-btn delete';
                delBtn.textContent = '✕';
                delBtn.title = AEI18n.t('删除');
                delBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (preview) {
                        _previewInjectQueue.splice(historyIdx, 1);
                    } else if (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.removeInjectItem === 'function') {
                        global.AEEngine.bridge.removeInjectItem(historyIdx);
                    }
                    renderInjectChips();
                });
                actions.appendChild(delBtn);
                // 编辑：从队列移除并回填输入框
                var editBtn = document.createElement('button');
                editBtn.type = 'button';
                editBtn.className = 'ae-agent-inject-chip-btn';
                editBtn.textContent = '✎';
                editBtn.title = AEI18n.t('编辑');
                editBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var target = preview
                        ? _previewInjectQueue.splice(historyIdx, 1)[0]
                        : (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.editInjectItem === 'function'
                            ? global.AEEngine.bridge.editInjectItem(historyIdx) : null);
                    var input = byId('aeAgentInput');
                    if (input && target) {
                        input.value = target.displayText || target.text || '';
                        input.focus();
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    renderInjectChips();
                });
                actions.appendChild(editBtn);
                // 立刻发送：纯预览模式下禁用，不发送
                var sendBtn = document.createElement('button');
                sendBtn.type = 'button';
                sendBtn.className = 'ae-agent-inject-chip-btn send';
                sendBtn.textContent = '➤';
                sendBtn.title = preview ? AEI18n.t('纯预览模式不发送') : AEI18n.t('立刻发送');
                sendBtn.disabled = preview;
                sendBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.sendInjectItem === 'function') {
                        global.AEEngine.bridge.sendInjectItem(historyIdx);
                    }
                });
                actions.appendChild(sendBtn);
                row.appendChild(actions);
                list.appendChild(row);
            })(i, queue[i]);
        }
        wrap.appendChild(list);
    }

    // ── Context usage bar ──
    var _ctxRingInited = false;
    var _compressing = false;
    var _scriptContextManager = null;
    var _agentContextManager = null;
    var _shaderContextManager = null;
    var _scriptSessionStore = null;
    var _agentSessionStore = null;
    var _shaderSessionStore = null;
    var _beforeUnloadBound = false;
    var _shaderContractState = null;

    function updateContextRing() {
        var bar = byId('ctxBar');
        var wrap = byId('ctxRingWrap');
        if (!bar || !wrap || !controller) return;
        try {
            var stats = controller.getContextTokenStats();
            // 配色/宽度按**未取整**的 percentUsedRaw 算（与三处闸门同口径）；
            // 文本仍取整显示。maxTokens 是 min(设置, 模型窗口) 的生效值。
            var pctRaw = (typeof stats.percentUsedRaw === 'number') ? stats.percentUsedRaw : (stats.percentUsed || 0);
            var pct = Math.min(100, Math.max(0, Math.round(pctRaw)));
            bar.style.width = Math.min(100, Math.max(0, pctRaw)) + '%';
            bar.classList.remove('warn', 'danger');
            // 危险色 = 已达自动压缩触发线（阈值从 cm 取，唯一一份；缺字段的桩回退 85）。
            // 为什么不再写死 90：阈值下调为 85 后，写死会让「已达阈值」的视觉信号
            // 滞后于实际压缩行为（85%~90% 之间已经压缩过，条子却还是黄灯）。
            var _dangerPct = (typeof stats.compactTriggerPct === 'number') ? stats.compactTriggerPct : 85;
            if (pctRaw >= _dangerPct) bar.classList.add('danger');
            else if (pctRaw >= 70) bar.classList.add('warn');
            var usedK = (stats.totalTokens / 1000).toFixed(1);
            var maxK = (stats.maxTokens / 1000).toFixed(0);
            // 用量条 tooltip 只留「用量 + 动作」两行（不写括号里的来源说明）。
            // 来源透明化（生效上限来自模型自报窗口还是手填兜底值）由设置面板的常显提示行
            // #maxContextTokensHint 承担（见下方 _updateCtxWindowHint）——同一件事不说两遍。
            var ovK = (Number(stats.overheadTokens) || 0) / 1000;
            // 固定开销 = 系统提示 + 工具定义（请求固定成本，非历史消息）：空对话也占上下文，
            // 提示里带上它，避免「什么都没聊却显示已用十几 K」被当成脏数据。
            wrap.title = ovK > 0
                ? AEI18n.t('上下文: {used}K / {max}K ({pct}%) · 固定开销 {ov}K\n点击压缩上下文',
                    { used: usedK, max: maxK, pct: pct, ov: ovK.toFixed(1) })
                : AEI18n.t('上下文: {used}K / {max}K ({pct}%)\n点击压缩上下文',
                    { used: usedK, max: maxK, pct: pct });
            // 底部状态栏的 CTX 文本是这一条的另一处镜像（client/main.js 的 _updateHudCtx）：
            // 它只随 10s 心跳刷新时，切模式/lane 后会与这里差一拍。广播一次让镜像同源刷新
            //（文档事件，main.js 侧注册；两处读的都是当前槽 controller 的同一份统计）。
            try {
                if (typeof document !== 'undefined' && typeof document.dispatchEvent === 'function'
                    && typeof CustomEvent === 'function') {
                    document.dispatchEvent(new CustomEvent('ae:ctx-usage-changed'));
                }
            } catch (_) { /* 无 DOM/事件环境（单测桩）：只更新条本身 */ }
        } catch (_) {}
    }

    // ── 生效上限来源的**可见**提示（失真面修复）──────────
    // 设置项已从「上限」降级为「仅在服务商未上报窗口时生效的兜底值」：用户填了 128K、
    // 而模型报 200K 时，生效的是 200K。必须让用户一眼看出**生效值是多少、来自谁**，
    // 否则就是本仓定义的失真面（填了没起作用却毫无反馈）。
    // 渲染位置见 app/settings.js 的 `#maxContextTokensHint`；元素不存在时静默跳过。
    function _updateCtxWindowHint() {
        var el = byId('maxContextTokensHint');
        if (!el) return;
        try {
            var cm = _agentContextManager || _scriptContextManager;
            if (!cm || typeof cm.getTokenStats !== 'function') { el.textContent = ''; return; }
            var st = cm.getTokenStats();
            var effK = Math.round((Number(st.maxTokens) || 0) / 1000);
            var cfgK = Math.round((Number(st.configuredMaxTokens) || 0) / 1000);
            if (st.maxTokensSource === 'model') {
                el.textContent = AEI18n.t('当前生效上限 {eff}K · 来自模型自报窗口（下面填的 {cfg}K 只在服务商未上报窗口时生效）',
                    { eff: effK, cfg: cfgK });
            } else {
                el.textContent = AEI18n.t('当前生效上限 {eff}K · 模型未上报窗口，取手填兜底值', { eff: effK });
            }
        } catch (_) { /* DOM/统计不可用：不影响设置保存 */ }
    }

    // ── 把「模型自报窗口」同步进三个 contextManager ──
    // 生效分母 = 模型窗口（可信则用）；未上报（0）⇒ 用设置项兜底值。**不再取 min**。
    // 位置在模块顶层：`syncMaxContextTokens`（设置项保存/切模型）与 `_mountInner`（启动）
    // 都要调它；contextManager 的读取实现只有 context.js 的 readModelContextWindow 一份。
    var _ctxModelSel = { providerId: '', modelId: '' };

    // ── 团队 lane 的模型 / 平台解析（**唯一实现**，纯函数）──────────────
    // 消费方：lane runtime 的 getModel/getPlatform、子 Agent 的继承、上下文窗口同步、顶栏展示。
    // 不在各调用点各写一份回落链（那份链会有「平台/模型不成对」的坑）。输入：
    //   laneCfg      = team.lanes[id]（设置页存的 { model, platform, reasoningEffort }）
    //   globals      = { providerId, modelId }（模型管理的全局默认缓存）
    //   providers    = [{ id, models: [模型 id] }]（注册表快照；停用/空模型平台已剔除）
    //   getSelectedModel(providerId) = 该平台在「模型管理」里选中的模型
    // 回落规则（模型 ID 只在所属平台内唯一 ⇒ 结果必须成对自洽）：
    //   ① 有平台：平台照用；模型在该平台内才用，否则换成该平台在模型管理里选中的模型
    //      （再不行用首个）。平台已不在注册表里 ⇒ 平台/模型按用户配置原样下发——不静默换平台：
    //      请求时的显式报错比「悄悄用了别的平台」可诊断（与模型管理对已删平台的口径一致）。
    //   ② 只有模型：反查注册表找它所属平台（找不到回落全局平台）。
    //   ③ 两者都空：跟随全局默认（inherited=true，顶栏/诊断据此区分「配置」与「继承」）。
    // 任何非法输入都收敛到「至少等于全局默认」，不抛、不写盘。
    function resolveLaneModelSelection(laneCfg, globals, providers, getSelectedModel) {
        var g = (globals && typeof globals === 'object') ? globals : {};
        var gProviderId = (typeof g.providerId === 'string') ? g.providerId : '';
        var gModelId = (typeof g.modelId === 'string') ? g.modelId : '';
        var lane = (laneCfg && typeof laneCfg === 'object') ? laneCfg : {};
        var laneModel = (typeof lane.model === 'string') ? lane.model : '';
        var lanePlatform = (typeof lane.platform === 'string') ? lane.platform : '';
        var list = Array.isArray(providers) ? providers : [];
        var providerId = gProviderId;
        var modelId = gModelId;
        var inherited = !laneModel && !lanePlatform;
        function _prov(id) {
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].id === id) return list[i];
            }
            return null;
        }
        function _has(prov, mid) {
            if (!prov || !mid || !Array.isArray(prov.models)) return false;
            for (var i = 0; i < prov.models.length; i++) {
                if (prov.models[i] === mid) return true;
            }
            return false;
        }
        function _selected(id) {
            try {
                return (typeof getSelectedModel === 'function') ? String(getSelectedModel(id) || '') : '';
            } catch (_) { return ''; }
        }
        if (lanePlatform) {
            var prov = _prov(lanePlatform);
            providerId = lanePlatform;
            if (prov) {
                if (_has(prov, laneModel)) {
                    modelId = laneModel;
                } else {
                    var sel = _selected(lanePlatform);
                    modelId = _has(prov, sel) ? sel : (prov.models.length ? prov.models[0] : '');
                    // 平台候选为空（注册表条目没模型）⇒ 保留用户写的模型，不抹成空串
                    if (!modelId && laneModel) modelId = laneModel;
                }
            } else {
                modelId = laneModel || gModelId;
            }
        } else if (laneModel) {
            var owner = null;
            for (var k = 0; k < list.length; k++) {
                if (_has(list[k], laneModel)) { owner = list[k]; break; }
            }
            providerId = owner ? owner.id : gProviderId;
            modelId = laneModel;
        }
        return {
            providerId: providerId,
            modelId: modelId,
            platform: providerId,
            model: modelId,
            inherited: inherited
        };
    }

    // lane 的思考等级覆盖（纯函数）：设置页每条 Agent 一项；非法/缺省一律保持归一后的全局值。
    // 消费点 = _laneGetSettings（controller 的请求按 settings.reasoningEffort 下发）。
    function resolveLaneReasoningEffort(laneCfg, fallback) {
        var levels = ['low', 'medium', 'high', 'xhigh'];
        var effort = (laneCfg && typeof laneCfg === 'object') ? laneCfg.reasoningEffort : '';
        return (levels.indexOf(effort) >= 0) ? effort : fallback;
    }

    // 模块级钩子：_mountInner 挂上「读当前 team 设置 + 全局默认缓存」的实现。模块级持有是因为
    // _applyModelWindowToAll 在 mount 之外（启动/设置保存都要按**各 lane 自己的模型**同步窗口）。
    // 未挂载（测试桩 / 旧装配）时为 null ⇒ 调用方回落全局窗口（行为同接线前）。
    var _laneModelSelectionHook = null;

    // 顶栏「当前模型」的重绘信号：团队档显示的是**当前 Agent** 的模型，lane 切换 / 开关团队 /
    // 设置保存都要让它换值。事件通道与 ae:default-llm-changed 同款（window 上的 CustomEvent），
    // 监听方只有 app/index.js；派发失败不影响任何状态。
    function _notifyLaneModelChanged() {
        try {
            if (typeof window === 'undefined' || typeof window.dispatchEvent !== 'function') return;
            var CE = (typeof window.CustomEvent === 'function') ? window.CustomEvent
                : (typeof CustomEvent === 'function' ? CustomEvent : null);
            if (typeof CE !== 'function') return;
            window.dispatchEvent(new CE('ae:lane-model-changed'));
        } catch (_) { /* 事件通道可选 */ }
    }

    function _applyModelWindowToAll() {
        try {
            if (typeof global.AEEngine.readModelContextWindow !== 'function') return;
            var win = global.AEEngine.readModelContextWindow(_ctxModelSel.providerId, _ctxModelSel.modelId);
            if (_scriptContextManager && typeof _scriptContextManager.setModelWindowLimit === 'function') {
                _scriptContextManager.setModelWindowLimit(win);
            }
            if (_agentContextManager && typeof _agentContextManager.setModelWindowLimit === 'function') {
                _agentContextManager.setModelWindowLimit(win);
            }
            if (_shaderContextManager && typeof _shaderContextManager.setModelWindowLimit === 'function') {
                _shaderContextManager.setModelWindowLimit(win);
            }
            // 团队 lane 的 cm 不在上面三个模块级槽里（每条 lane 各持一份）。
            // 窗口按**各 lane 自己的模型**取：有 lane 覆盖时全局模型的窗口
            // 不适用；钩子缺席（未挂载 / 旧装配）才回落全局窗口。
            for (var laneId in _laneContextManagers) {
                if (!Object.prototype.hasOwnProperty.call(_laneContextManagers, laneId)) continue;
                var laneCm = _laneContextManagers[laneId];
                if (!laneCm || typeof laneCm.setModelWindowLimit !== 'function') continue;
                var laneWin = win;
                if (typeof _laneModelSelectionHook === 'function') {
                    try {
                        var laneSel = _laneModelSelectionHook(laneId);
                        if (laneSel && (laneSel.providerId || laneSel.modelId)) {
                            laneWin = global.AEEngine.readModelContextWindow(laneSel.providerId, laneSel.modelId);
                        }
                    } catch (_) { laneWin = win; }
                }
                laneCm.setModelWindowLimit(laneWin);
            }
            // 工具集/骨架没变时值稳定，但设置与模型变化会影响提示词与工具可见性。
            _refreshAllLaneOverheads();
        } catch (_) { /* 窗口读不到：回落手填兜底值，行为不变 */ }
        _updateCtxWindowHint();
        // 窗口可能在挂载后才学到（模型目录异步加载 / 切模型 / 团队 lane 各自的模型）：
        // 分母变了必须立即重绘，否则条上留着挂载时的兜底值（256K）直到下一次状态变化。
        try { updateContextRing(); } catch (_) { /* UI 未挂载：静默 */ }
    }

    // lane 的固定开销：按 lane 落盘 + 现算写回（键格式与 controller 的 _overheadStoreKey 一致）。
    // 不同 lane 的工具集/提示词骨架不同，共用一个存档键会让一个 lane 的测量值被所有 lane 读走。
    var LANE_OVERHEAD_STORE_KEY = 'ae_agent_ctx_overhead_v1';
    function _rememberLaneOverhead(laneKey, ovh) {
        try {
            if (!global.localStorage || !laneKey) return;
            var raw = global.localStorage.getItem(LANE_OVERHEAD_STORE_KEY);
            var map = raw ? JSON.parse(raw) : {};
            if (!map || typeof map !== 'object') map = {};
            map['lane:' + laneKey] = Math.max(0, Math.floor(Number(ovh) || 0));
            global.localStorage.setItem(LANE_OVERHEAD_STORE_KEY, JSON.stringify(map));
        } catch (_) { /* 存储不可用：不影响启动 */ }
    }
    // lane 的固定开销现算并写进它自己的 cm（覆盖跨 lane 的陈旧预热值）。
    function _applyLaneOverheadEstimate(rt, laneKey) {
        if (!rt || !rt.cm || !rt.controller) return;
        try {
            if (typeof rt.controller.estimateFixedOverhead !== 'function') return;
            var ovh = rt.controller.estimateFixedOverhead();
            if (!(ovh > 0)) return;
            if (typeof rt.cm.setOverheadTokens === 'function') rt.cm.setOverheadTokens(ovh);
            _rememberLaneOverhead(laneKey, ovh);
        } catch (_) { /* 估算失败：保留预热值，下次请求重算 */ }
    }
    // 设置/模型/恢复链变化后重算全部 lane 的固定开销。
    function _refreshAllLaneOverheads() {
        if (!_orchestrator || typeof _orchestrator.lanes !== 'function' || typeof _orchestrator.getLane !== 'function') return;
        var defs = null;
        try { defs = _orchestrator.lanes() || []; } catch (_) { return; }
        for (var i = 0; i < defs.length; i++) {
            var def = defs[i] || {};
            if (!def.id) continue;
            var rt = null;
            try { rt = _orchestrator.getLane(def.id); } catch (_) { rt = null; }
            _applyLaneOverheadEstimate(rt, def.laneKey || def.id);
        }
    }
    function syncMaxContextTokens(maxTokens) {
        if (!_scriptContextManager || !_agentContextManager) return;
        try {
            if (maxTokens === undefined || maxTokens === null) {
                // 先从 DOM 读取，DOM 不存在时从 settings 缓存读取。
                // 该输入框是「下拉 + 可输入」的组合框，值可能是 128K / 0.5M 这种写法——
                // 解析必须走 settingsPanel.parseTokenValue（直接 Number() 会得 NaN，
                // 被下面那行当非法值兜底成默认值，用户填的兜底值静默失效）
                var maxTokensEl = byId('maxContextTokens');
                var _parseTok = global.AEAgentApp && global.AEAgentApp.settingsPanel
                    && global.AEAgentApp.settingsPanel.parseTokenValue;
                var _fallbackTok = Number(getSettings().maxContextTokens) || 256000;
                if (maxTokensEl && maxTokensEl.value && typeof _parseTok === 'function') {
                    maxTokens = _parseTok(maxTokensEl.value, _fallbackTok);
                } else if (maxTokensEl && maxTokensEl.value) {
                    maxTokens = Number(maxTokensEl.value) || _fallbackTok;
                } else {
                    maxTokens = _fallbackTok;
                }
            }
            if (!maxTokens || maxTokens < 2000) maxTokens = 256000;
            _scriptContextManager.setMaxContextTokens(maxTokens);
            _agentContextManager.setMaxContextTokens(maxTokens);
            if (_shaderContextManager) _shaderContextManager.setMaxContextTokens(maxTokens);
            // 团队 lane 的 cm 同款：设置面板改了兜底值，三条 lane 的用量分母要跟着走
            var laneCms = _laneContextManagerList();
            for (var i = 0; i < laneCms.length; i++) {
                if (typeof laneCms[i].setMaxContextTokens === 'function') laneCms[i].setMaxContextTokens(maxTokens);
            }
            // 设置值只改「兜底值」，生效上限仍优先取模型自报窗口；
            // 重新同步窗口（切模型后同样走这里——用量条/闸门/提示文案都不依赖发消息才更新）
            _applyModelWindowToAll();
            updateContextRing();
        } catch (_) {}
    }

    function initContextRing(showStatus) {
        if (_ctxRingInited) return;
        _ctxRingInited = true;
        var wrap = byId('ctxRingWrap');
        if (!wrap) return;
        var notify = typeof showStatus === 'function' ? showStatus : function () {};
        wrap.addEventListener('click', async function () {
            if (_compressing) return;
            if (!controller) return;
            var stats = controller.getContextTokenStats();
            var pct = stats.percentUsed || 0;
            if (pct < 10) {
                notify(AEI18n.t('当前上下文用量仅 {pct}%（{used}K / {max}K），无需压缩',
                    { pct: pct, used: (stats.totalTokens / 1000).toFixed(1), max: (stats.maxTokens / 1000).toFixed(0) }), 'info', { autoHideMs: 3000 });
                return;
            }
            var msg = AEI18n.t('当前上下文已使用 {pct}%（{used}K / {max}K）。\n\n压缩将让 AI 总结对话历史，释放上下文空间。是否继续？',
                { pct: pct, used: (stats.totalTokens / 1000).toFixed(1), max: (stats.maxTokens / 1000).toFixed(0) });
            var ok = await showConfirm(AEI18n.t('上下文压缩'), msg);
            if (!ok) return;
            compressContext();
        });
        updateContextRing();
    }

    async function compressContext() {
        if (_compressing || !controller) return;
        _compressing = true;
        try {
            var result = await controller.compressContext({ manual: true });
            if (result && result.success) {
                updateContextRing();
            } else if (result && result.error) {
                console.warn('[compressContext]', result.error);
                // 失败一律给可见反馈：用户已点过确认弹窗，只 console.warn 会表现为「点了没反应」
                // （只覆盖了 busy，其余原因仍静默）。文案取 apiActions 的唯一一份
                // ——与 /compress、发送前的自动压缩三处同口径。
                if (typeof controller.addLocalMessage === 'function') {
                    var _failText = typeof controller.describeCompressFailure === 'function'
                        ? controller.describeCompressFailure(result.error)
                        : AEI18n.t('压缩失败，请稍后再试。');
                    controller.addLocalMessage('assistant', _failText);
                }
            }
        } catch (e) {
            console.warn('[compressContext] failed:', e);
            // 异常路径同样给可见反馈（不只 console.warn）
            if (typeof controller.addLocalMessage === 'function') {
                controller.addLocalMessage('assistant', AEI18n.t('压缩失败，请稍后再试。'));
            }
        } finally {
            _compressing = false;
            updateContextRing();
        }
    }

    function syncModeButtons(settings) {
        const mode = (settings && settings.runtimeMode) || 'script';
        const sw = byId('runtimeModeSwitch');
        if (sw) {
            // 与 app/main.js syncRuntimeMode **同源**：档位表与显示名都引用
            // engine/settings.js 的 MODES / MODE_LABELS，不再各写一份字面量。
            // 只列四槽的第二份表：团队档下 indexOf 返回 -1 ⇒ data-mode-index="-1"、
            // 标签显示原始串（真机观察到「Script」）——L-1 的成因。
            const st = (ns && ns.settings) || null;
            const modes = (st && st.MODES) || ['script', 'agent', 'shader', 'external', 'team'];
            const labels = (st && st.MODE_LABELS) || { script: 'Script', agent: 'Agent', shader: 'Shader', external: AEI18n.t('外接'), team: AEI18n.t('团队') };
            const idx = modes.indexOf(mode);
            sw.dataset.modeIndex = String(idx < 0 ? 0 : idx);
            var label = sw.querySelector('.mode-current-label');
            // 显示名表是源文（engine/settings.js 的 MODE_LABELS）：此处按当前语言翻译一次
            //（与 app/main.js syncRuntimeMode 同款）；Script/Agent/Shader 三档值等于 id，跳过查表。
            if (label) {
                var _lab = labels[mode] || mode;
                label.textContent = (_lab === mode) ? _lab : AEI18n.t(_lab);
            }
        }
    }

    // 「当前选中」入口的可见性与浮层收拾（模块级工厂：_mountInner 挂载点深处不可触达，
    // 抽出供单测直接驱动）。隐藏走类而**不是内联 display**：该入口的 margin-left:auto 是
    // 右侧控件组（权限/思考）推到 toolbar 右边的唯一推动力，隐藏时须由 CSS 的相邻选择器
    // 把推动力交给权限滑块（agent.css 的 .ae-agent-ae-state.is-hidden 规则），否则该组左贴。
    // setVisible(false) 一并收拾浮层——元素不显示后浏览器不保证补发 mouseleave，开着的
    // 浮层会作为无主瞬态节点停在屏幕上；在途 gather 的结果也一并作废（不再回写浮层）。
    // deps：el 入口元素 / invalidateInFlight 作废在途 gather 与关闭计时 / removePopover 摘浮层节点。
    function createAeStateChipVisibility(deps) {
        deps = deps || {};
        var el = deps.el || null;
        var invalidateInFlight = typeof deps.invalidateInFlight === 'function' ? deps.invalidateInFlight : function () {};
        var removePopover = typeof deps.removePopover === 'function' ? deps.removePopover : function () {};
        function setVisible(visible) {
            if (el && el.classList) el.classList.toggle('is-hidden', !visible);
            if (visible) return;
            invalidateInFlight();
            removePopover();
        }
        return { setVisible: setVisible };
    }

    // 「当前选中」悬停取数的短 TTL 缓存（工厂：挂载点深处不可触达，抽出供单测直驱，
    // 与 createAeStateChipVisibility 同款先例）。背景：mouseenter 的 200ms 去抖只挡
    // 「同一次移入」的重复；用户来回悬停（间隔 >200ms）仍会每次重跑两路查询——大工程里
    // gather 要遍历整个工程，数秒级卡顿且这段时间内结果不会有新信息。TTL 内直接复用上次
    // 结果：浮层只是「当前轮会注入什么」的展示，1.8s 内的陈旧无实害。点击建引用**不走本缓存**
    //（引用要稳定键，必须现读）。键 = 当前轮模块身份：切模式（agent/script/shader）必重取，
    // 不会把上一模式"拿得到工具"的结果喂给新模式的浮层。
    // deps：ttlMs 有效期（缺省 1800）；now 时钟（单测注入假时钟）；fetch(key) 返回 Promise。
    function createAeHoverGatherCache(deps) {
        deps = deps || {};
        var ttlMs = (typeof deps.ttlMs === 'number' && deps.ttlMs >= 0) ? deps.ttlMs : 1800;
        var now = typeof deps.now === 'function' ? deps.now : function () { return Date.now(); };
        var fetchFn = typeof deps.fetch === 'function' ? deps.fetch : null;
        var at = 0;
        var cachedKey = null;
        var cached = null;
        var pendingKey = null;
        var pending = null;
        function get(k) {
            if (!fetchFn) return Promise.resolve(null);
            if (cached && cachedKey === k && (now() - at) < ttlMs) return Promise.resolve(cached);
            if (pending && pendingKey === k) return pending;   // 同键在途：复用，不重复发起
            var p = fetchFn(k);
            pendingKey = k;
            pending = p;
            return p.then(function (r) {
                if (pending === p) { pending = null; pendingKey = null; }
                // 缓存结果必须与**发起它的键**绑定：并发不同键且乱序返回时，
                // 旧结果不得以新键的名义命中（否则浮层显示上一模式的注入状态）
                cached = r;
                cachedKey = k;
                at = now();
                return r;
            }, function (e) {
                if (pending === p) { pending = null; pendingKey = null; }
                throw e;   // 失败不进缓存：下次悬停/移入重试
            });
        }
        function clear() {
            at = 0;
            cachedKey = null;
            cached = null;
            pendingKey = null;
            pending = null;
        }
        return { get: get, clear: clear };
    }

    // 「当前选中」点击的结果文案（纯函数，模块作用域定义 + 挂 global.AEEngine 供单测直调，
    // 与 createAeStateChipVisibility / formatAeContext* 同款先例）。输入：两侧取数结果 + 两侧
    // 建 chip 结果 → { text, level }。语义：能建就报建了几条；建不成的按因说明
    //（无 id / 只有文件夹 / 无选中 / 模式读不到工具 / 真失败）。真失败（error）优先报原文——
    // 用户要看真原因，不能被"未选中"之类的话盖掉。
    function refClickStatusText(layerRes, itemRes, layerAdded, itemAdded) {
        layerRes = layerRes || {}; itemRes = itemRes || {};
        layerAdded = layerAdded || {}; itemAdded = itemAdded || {};
        var nL = layerAdded.refs || 0;
        var nI = itemAdded.refs || 0;
        // 一侧读失败、另一侧没有引用可报时才把失败当主句；另一侧建成了 chip 时失败降为附加说明
        // （chip 已插进输入框，只报错误会让用户以为什么都没发生）
        var layerErr = (nL === 0 && layerRes.status === 'error') ? (layerRes.message || AEI18n.t('未知原因')) : '';
        var itemErr = (nI === 0 && itemRes.status === 'error') ? (itemRes.message || AEI18n.t('未知原因')) : '';
        if (nL > 0 || nI > 0) {
            var main;
            if (nL > 0 && nI > 0) {
                main = AEI18n.t('已引用 {layers} 个图层、{items} 个项目对象（插入在输入框光标处）', { layers: nL, items: nI });
            } else if (nL > 0) {
                main = AEI18n.t('已引用 {layers} 个图层（插入在输入框光标处）', { layers: nL });
            } else {
                main = AEI18n.t('已引用 {items} 个项目对象（插入在输入框光标处）', { items: nI });
            }
            var extras = [];
            if (layerAdded.dropped > 0) extras.push(AEI18n.t('另有 {n} 个图层无 id，未能引用', { n: layerAdded.dropped }));
            if (itemAdded.dropped > 0) extras.push(AEI18n.t('另有 {n} 个对象无 id，未能引用', { n: itemAdded.dropped }));
            if (itemAdded.skipped > 0) extras.push(AEI18n.t('另有 {n} 个文件夹不能引用', { n: itemAdded.skipped }));
            if (layerAdded.chips > 1 || itemAdded.chips > 1) extras.push(AEI18n.t('超一行宽，已分成多条'));
            if (layerErr) extras.push(AEI18n.t('时间轴选中读取失败：{why}', { why: layerErr }));
            if (itemErr) extras.push(AEI18n.t('项目面板选中读取失败：{why}', { why: itemErr }));
            if (extras.length) return { text: main + AEI18n.punct('；', '; ', '、') + extras.join(AEI18n.punct('；', '; ', '、')), level: (layerErr || itemErr) ? 'error' : 'warn' };
            return { text: main, level: 'info' };
        }
        if (layerErr) return { text: AEI18n.t('读取时间轴选中失败：{why}', { why: layerErr }), level: 'error' };
        if (itemErr) return { text: AEI18n.t('读取项目面板选中失败：{why}', { why: itemErr }), level: 'error' };
        if (layerRes.status === 'no-access' && itemRes.status === 'no-access') {
            return { text: AEI18n.t('本模式拿不到工程读取工具，无法引用选中对象'), level: 'warn' };
        }
        var dropL = layerAdded.dropped || 0;
        var dropI = itemAdded.dropped || 0;
        var skipI = itemAdded.skipped || 0;
        if (dropL > 0) return { text: AEI18n.t('当前 AE 版本无图层 id（Layer.id / Item.id），无法建立稳定引用'), level: 'warn' };
        if (dropI > 0) return { text: AEI18n.t('当前 AE 版本无对象 id（Item.id），无法建立稳定引用'), level: 'warn' };
        if (skipI > 0) return { text: AEI18n.t('项目面板选中的只有文件夹，无法引用：请选合成或素材'), level: 'warn' };
        if (layerRes.status === 'empty' && itemRes.status === 'empty') {
            return { text: AEI18n.t('未选中任何图层或项目对象：在时间轴选图层，或在项目面板选合成/素材后再点引用'), level: 'warn' };
        }
        return { text: AEI18n.t('没有可引用的选中对象'), level: 'warn' };
    }

    // tool_search handler 工厂：按需加载任意工具的完整参数定义（tools 参数只发
    // stub，模型用本工具获取完整 schema 后才能调用）。抽为模块级纯函数供
    // _mountInner 注册复用，同时可被单测直接驱动（注册点在 mount 深处无法触达）。
    // 零命中/部分命中不再静默返回空（原为唯一无提示的失败查询类工具）：
    // 列出未找到的名与当前模块可用工具/分组，LLM 可据此纠正拼写——对齐
    // queryAeApi / memory_search 的零命中提示口径。
    //
    // 改**filter-only** 查询。具名/分组返回的
    // 定义一律来自 execCtx.visibility（闸口实例随上下文下发）——scope 只是闸口的默认输入，
    // 用户 enabled 放宽到 scope 之外的工具也要能搜到；锁定/关闭/默认不可见的工具搜不到。
    // 闸口实例必须随上下文下发：handler 只注册一次，子 Agent 用的是派生时冻结的那份闸口。
    // 无 visibility（外接/直调路径、旧装配）时回落旧的 scope 查询语义——生产 pipeline 恒下发。
    function createToolSearchHandler(llmToolReg) {
        return function (args, execCtx) {
            var moduleId = (execCtx && execCtx.moduleId) || 'agent';
            var vis = (execCtx && execCtx.visibility && execCtx.visibility.gate) ? execCtx.visibility : null;
            var gate = vis ? vis.gate : null;
            var viewId = vis ? vis.viewId : '';
            var extraFilter = vis ? (vis.extraFilter || null) : null;
            // ── 闸口通道（生产）─────────────────────────────────────────────
            function gateEntries() {
                try {
                    var list = gate.entriesFor(viewId, extraFilter);
                    return Array.isArray(list) ? list : [];
                } catch (_) { return []; }
            }
            // ── 兜底通道（无闸口上下文：外接 / 旧装配 / 直驱单测）────────────────
            var moduleIds = (execCtx && Array.isArray(execCtx.moduleIds) && execCtx.moduleIds.length)
                ? execCtx.moduleIds : null;
            var toolFilter = (execCtx && typeof execCtx.toolFilter === 'function') ? execCtx.toolFilter : null;
            function legacyFullDefOf(name) {
                if (moduleIds && typeof llmToolReg.getToolFullDefFor === 'function') {
                    return llmToolReg.getToolFullDefFor(name, moduleIds, toolFilter);
                }
                var def = llmToolReg.getToolFullDef(name, moduleId);
                if (def && toolFilter) {
                    var entry = (typeof llmToolReg.get === 'function') ? llmToolReg.get(name) : null;
                    if (!toolFilter(entry || { name: name })) return null;
                }
                return def;
            }
            function legacyEnabledOf() {
                if (moduleIds && typeof llmToolReg.getEnabledForModules === 'function') {
                    return llmToolReg.getEnabledForModules(moduleIds);
                }
                return llmToolReg.getEnabledForModule(moduleId);
            }
            function legacyNamesText() {
                if (moduleIds && typeof llmToolReg.getToolNamesForModules === 'function') {
                    return llmToolReg.getToolNamesForModules(moduleIds, toolFilter).join(', ');
                }
                return llmToolReg.getToolNamesForModule(moduleId).join(', ');
            }
            function fullDefOf(name) {
                if (gate) {
                    try { return gate.fullDef(viewId, name, extraFilter); } catch (_) { return null; }
                }
                return legacyFullDefOf(name);
            }
            function namesText() {
                if (gate) {
                    try { return gate.names(viewId, extraFilter).join(', '); } catch (_) { return ''; }
                }
                return legacyNamesText();
            }
            function visibleEntries() {
                if (gate) {
                    // 闸口条目：可见 = 无原因码且非全局停用（entriesFor 已含四态）
                    var all = gateEntries();
                    var out = [];
                    for (var i = 0; i < all.length; i++) {
                        if (all[i].reason === null && all[i].disabled !== true) out.push(all[i]);
                    }
                    return out;
                }
                var legacy = legacyEnabledOf() || [];
                var kept = [];
                for (var j = 0; j < legacy.length; j++) {
                    if (toolFilter && !toolFilter(legacy[j])) continue;
                    kept.push(legacy[j]);
                }
                return kept;
            }
            var results = [];
            var hint = '';
            if (args.names && args.names.length) {
                var missing = [];
                for (var i = 0; i < args.names.length; i++) {
                    var def = fullDefOf(args.names[i]);
                    if (def) results.push(def);
                    else missing.push(args.names[i]);
                }
                if (missing.length) {
                    hint = '未找到工具: ' + missing.join(', ')
                        + '。当前可用工具: ' + namesText();
                }
            } else if (args.category) {
                var all = visibleEntries();
                for (var j = 0; j < all.length; j++) {
                    if (all[j].category === args.category) {
                        var fullDef = fullDefOf(all[j].name);
                        if (fullDef) results.push(fullDef);
                    }
                }
                if (!results.length) {
                    var cats = {};
                    for (var cj = 0; cj < all.length; cj++) {
                        cats[all[cj].category] = true;
                    }
                    hint = '分组 "' + args.category + '" 下无工具。可用分组: ' + Object.keys(cats).join(', ');
                }
            } else {
                hint = '缺少参数：需提供 names（工具名列表）或 category（分组名）之一。'
                    + '当前可用工具: ' + namesText();
            }
            var payload = {
                count: results.length,
                tools: results.map(function (d) {
                    return {
                        name: d.function.name,
                        description: d.function.description,
                        parameters: d.function.parameters
                    };
                })
            };
            if (hint) payload.hint = hint;
            return {
                success: true,
                content: [{
                    type: 'text',
                    text: JSON.stringify(payload, null, 2)
                }]
            };
        };
    }

    // 运行时闸口工厂：每条 runtime 一份实例；getSettings 指向该 runtime 的设置闭包
    //（主 runtime = 已保存设置，子 Agent = 派生时冻结快照）。getLaneFilter 按视图给 lane 收窄判据
    //（生产 = team/lanes.js 里的同一个函数对象，lane 定义是单一事实源）。
    function _mkRuntimeToolVisibility(getSettingsFn) {
        if (!global.AE_LLM || typeof global.AE_LLM.createToolVisibility !== 'function') return null;
        return global.AE_LLM.createToolVisibility({
            getRegistry: function () { return _llmToolReg; },
            getSettings: getSettingsFn,
            getLanes: function () { return (global.AEAgentTeam && global.AEAgentTeam.lanes) || null; },
            getLaneFilter: function (viewId) {
                var lanes = (global.AEAgentTeam && global.AEAgentTeam.lanes) || null;
                var def = (lanes && typeof lanes.get === 'function') ? lanes.get(viewId) : null;
                return (def && typeof def.filter === 'function') ? def.filter : null;
            },
            isTeamMode: function () { return _teamEnabled; }
        });
    }

    // mount 包装器——挂载段中途抛错（controller.render/syncModeButtons 等
    // 同步段异常）时回滚已注册的 DOM 监听器再抛出。on() 登记簿本就为 unmount 建立，
    // 此处复用其回滚能力：不清理则重挂（允许 mounted=false 二次进入）后监听器
    // 双份执行——点击一次触发两次 handler（含清空对话等破坏性操作）。半初始化的
    // 全局引用（controller 等）由二次重挂自然覆盖重建，无需在此回滚。
    // 已经挂载时（mounted=true）挂载段不重跑，但子 Agent 三闸仍按本次挂载的设置回灌池
    //（team.subagent 是运行期可改的设置，池是模块级单例——不回灌就得整页重载才生效）。
    function mount(options) {
        if (mounted) {
            // 已经挂载（模块切换/面板重挂会再调一次 mount；unmount 是「后台运行」语义、不清位）：
            // 挂载段一律不重跑（重跑 = 重复绑监听 + 重建 runtime/store），但**子 Agent 的三闸不能
            // 一起被守卫吞掉**——team.subagent（maxConcurrent / keepAliveMs / maxLoops）是运行期
            // 可改的设置，而池是模块级单例：不回灌就出现「改了设置不生效、重挂也不生效，只能整页
            // 重载」（两位审查独立复现）。故这里只做一件事：按**本次**挂载给的 getSettings 重读
            // 归一值并回灌池（池不重建 ⇒ 在册子 Agent 与 id 序号语义不丢；只影响之后起跑/回收的
            // 轮次，已在跑的不打断）。
            var ro = options || {};
            _resyncSubagentLimits(ro.getSettings);
            return;
        }
        try {
            _mountInner(options);
        } catch (e) {
            for (var i = 0; i < listeners.length; i++) {
                try { listeners[i].el.removeEventListener(listeners[i].event, listeners[i].handler); } catch (_) {}
            }
            listeners.length = 0;
            throw e;   // 保留外层（moduleManager）的错误上报路径
        }
    }

    function _mountInner(options) {
        if (mounted) return;
        // mounted 在挂载段全部成功后置位（见函数末尾）——开头先置时，
        // 中途抛错时残留 true，再次进入被守卫静默空跑，引擎面板永久空白无自愈路径
        const opts = options || {};
        const context = opts.context || {};
        const getSettings = typeof opts.getSettings === 'function' ? opts.getSettings : function () { return {}; };
        const saveSettings = typeof opts.saveSettings === 'function' ? opts.saveSettings : function () {};
        const getDebugMode = typeof opts.getDebugMode === 'function' ? opts.getDebugMode : function () { return false; };
        // store 就绪等待上限：默认 8s；挂载选项可覆盖（可用短值验证「有界」这一条，
        // 否则那条判据要真等 8s）。见 _whenStoreReady 注释。
        _storeReadyTimeoutMs = (typeof opts.storeReadyTimeoutMs === 'number' && opts.storeReadyTimeoutMs > 0)
            ? opts.storeReadyTimeoutMs : _STORE_READY_TIMEOUT_MS;
        const updatePreviewScript = typeof opts.updatePreviewScript === 'function' ? opts.updatePreviewScript : function () {};
        const showConfirm = typeof opts.showConfirm === 'function' ? opts.showConfirm : function (title, msg) { return Promise.resolve(confirm(msg)); };
        const showStatus = typeof opts.showStatus === 'function' ? opts.showStatus : function () {};
        const getGlobalSettings = async () => {
            const store = context && context.settingsStore;
            return store && typeof store.getGlobalSettings === 'function' ? await store.getGlobalSettings({}) : {};
        };
        // 当前默认模型/平台缓存：模型选择已迁移到「模型管理」面板（全局设置 defaultProviderId/defaultModelId）。
        // 从 #model/#modelPlatform/#customModel 等 DOM 元素读取"跟随全局"不可行（元素已不存在），
        // 统一改为读取全局设置并缓存，能力判断/请求路由据此拿到真实模型与平台。
        let _defaultCache = { providerId: '', modelId: '' };
        const _withDefaultCache = async (fn) => {
            const globals = await getGlobalSettings();
            _defaultCache.providerId = globals.defaultProviderId || globals.defaultPlatform || '';
            _defaultCache.modelId = globals.defaultModelId || globals.defaultModel || '';
            // 模型选择变化后立刻把窗口同步进三个 cm（否则要等下一次请求构建才生效）
            _ctxModelSel.providerId = _defaultCache.providerId;
            _ctxModelSel.modelId = _defaultCache.modelId;
            _applyModelWindowToAll();
            return fn ? fn(globals) : null;
        };
        const _refreshDefaultCache = (globals) => {
            if (globals) {
                _defaultCache.providerId = globals.defaultProviderId || globals.defaultPlatform || _defaultCache.providerId;
                _defaultCache.modelId = globals.defaultModelId || globals.defaultModel || _defaultCache.modelId;
                _ctxModelSel.providerId = _defaultCache.providerId;
                _ctxModelSel.modelId = _defaultCache.modelId;
                _applyModelWindowToAll();
                return;
            }
            _withDefaultCache();
        };
        const resolveApiKeyByPlatform = (platformOrProviderId, globals) => {
            const g = globals || {};
            const providerId = platformOrProviderId || g.defaultProviderId || g.defaultPlatform || '';
            const registry = global.AE_LLM && global.AE_LLM.providerRegistry;
            // Get the API key field name from registry
            let apiKeyField = null;
            if (registry && typeof registry.getApiKeyField === 'function') {
                apiKeyField = registry.getApiKeyField(providerId);
            }
            // Legacy fallback: if registry returns null or we're on siliconflow, use apiKey field
            if (!apiKeyField || providerId === 'siliconflow') {
                return (g.apiKey || g.siliconflowApiKey || '').trim();
            }
            // Return the registry-derived field, with apiKey fallback
            return (g[apiKeyField] || g.apiKey || '').trim();
        };

        // ── 团队 lane 的模型 / 平台解析 ──────────────────────────
        // 取数三样都在装配期才有：当前 team 设置、全局默认缓存、模型管理注册表；解析本身是
        // 模块级纯函数 resolveLaneModelSelection（唯一实现，单测直驱它）。本段只负责组输入。
        function _providerModelSnapshot() {
            var out = [];
            try {
                var reg = global.AE_LLM && global.AE_LLM.providerRegistry;
                var list = (reg && typeof reg.listProviders === 'function') ? (reg.listProviders() || []) : [];
                for (var i = 0; i < list.length; i++) {
                    var p = list[i];
                    if (!p || !p.id || p.enabled === false) continue;
                    var ids = [];
                    var src = Array.isArray(p.models) ? p.models : [];
                    for (var j = 0; j < src.length; j++) {
                        if (src[j] && src[j].id) ids.push(String(src[j].id));
                    }
                    if (!ids.length) continue;
                    out.push({ id: String(p.id), models: ids });
                }
            } catch (_) { out = []; }
            return out;
        }
        function _laneSelectedModel(providerId) {
            try {
                var reg = global.AE_LLM && global.AE_LLM.providerRegistry;
                return (reg && typeof reg.getProviderSelectedModel === 'function')
                    ? (reg.getProviderSelectedModel(providerId) || '') : '';
            } catch (_) { return ''; }
        }
        function _resolveLaneSelection(laneId) {
            var laneCfg = null;
            try {
                var s = getSettings() || {};
                laneCfg = (s.team && s.team.lanes && laneId) ? s.team.lanes[laneId] : null;
            } catch (_) { laneCfg = null; }
            // 快照只在真有 lane 配置时才建：`listProviders()` 是深拷贝，而三条 Agent 默认
            // 「跟随全局」时每轮请求会多次取 getModel/getPlatform——无配置的常见路径不付这份成本。
            var laneConfigured = !!(laneCfg && ((typeof laneCfg.model === 'string' && laneCfg.model)
                || (typeof laneCfg.platform === 'string' && laneCfg.platform)));
            var sel = resolveLaneModelSelection(laneCfg, _defaultCache,
                laneConfigured ? _providerModelSnapshot() : [], _laneSelectedModel);
            sel.laneId = laneId;
            return sel;
        }
        // 模块级同步钩子（_applyModelWindowToAll 在 mount 之外，见那里的注释）
        _laneModelSelectionHook = function (laneId) { return _resolveLaneSelection(laneId); };

        // state / view / controller 的创建在 createLaneRuntime(def)（下方装配段），
        // 单 Agent 路径与团队三条 lane 走同一个工厂 ⇒ 这里不再直接建 state / view。
        const service = ns.createService({ llmChannel: context.llmChannel, promptBuilder: context.promptBuilder });
        // 三个审查 fn（reviewScript / reviewAeTool / reviewTableProposal）共用独立性口径：
        // 审查上下文不携带人格字段（评审独立性——缘由见 prompts.js 审查段头注释）。
        const reviewScriptFn = async (reviewOptions) => {
                const settings = ns.settings.normalize(getSettings());
                const globals = await getGlobalSettings();
                _refreshDefaultCache(globals);
                const platformName = _defaultCache.providerId || settings.providerId || settings.platform || '';
                const model = _defaultCache.modelId || settings.modelId || settings.model || '';
                return service.reviewScript({
                    apiKey: resolveApiKeyByPlatform(platformName, globals),
                    model,
                    platform: platformName,
                    script: reviewOptions && reviewOptions.script ? reviewOptions.script : '',
                    userMessage: reviewOptions && reviewOptions.userMessage ? reviewOptions.userMessage : '',
                    contextMessages: reviewOptions && reviewOptions.contextMessages ? reviewOptions.contextMessages : [],
                    signal: reviewOptions && reviewOptions.signal ? reviewOptions.signal : null,
                    reasoningEffort: settings.reasoningEffort || 'high',
                    timeoutMs: settings && settings.requestTimeoutMs ? settings.requestTimeoutMs : 120000,
                    mode: reviewOptions && reviewOptions.mode ? reviewOptions.mode : ''
                });
            };
        const reviewAeToolFn = async (reviewOptions) => {
                const settings = ns.settings.normalize(getSettings());
                const globals = await getGlobalSettings();
                _refreshDefaultCache(globals);
                const platformName = _defaultCache.providerId || settings.providerId || settings.platform || '';
                const model = _defaultCache.modelId || settings.modelId || settings.model || '';
                return service.reviewAeTool({
                    apiKey: resolveApiKeyByPlatform(platformName, globals),
                    model,
                    platform: platformName,
                    script: reviewOptions && reviewOptions.script ? reviewOptions.script : '',
                    toolName: reviewOptions && reviewOptions.toolName ? reviewOptions.toolName : '',
                    toolDescription: reviewOptions && reviewOptions.toolDescription ? reviewOptions.toolDescription : '',
                    signal: reviewOptions && reviewOptions.signal ? reviewOptions.signal : null,
                    reasoningEffort: settings.reasoningEffort || 'high',
                    timeoutMs: settings && settings.requestTimeoutMs ? settings.requestTimeoutMs : 120000,
                    allowAEToolsSystemCall: !!(window.AE_LLM && window.AE_LLM.allowAEToolsSystemCall)
                });
            };
        // 暴露到全局供 aeToolCreator 调用（createAETool 强制审查）
        global.AEEngine.reviewAeTool = reviewAeToolFn;
        // 补表提议审核员（reviewAeTool 同款 settings/apiKey 解析管道——
        // 共用配置；审查对象是类型表条目而非代码）。暴露全局供 tableTools 运行时
        // 解析（propose_table_entry handler 的 fail-closed 回退位）。
        const reviewTableProposalFn = async (reviewOptions) => {
                const settings = ns.settings.normalize(getSettings());
                const globals = await getGlobalSettings();
                _refreshDefaultCache(globals);
                const platformName = _defaultCache.providerId || settings.providerId || settings.platform || '';
                const model = _defaultCache.modelId || settings.modelId || settings.model || '';
                return service.reviewTableProposal({
                    apiKey: resolveApiKeyByPlatform(platformName, globals),
                    model,
                    platform: platformName,
                    typeName: reviewOptions && reviewOptions.typeName ? reviewOptions.typeName : '',
                    memberName: reviewOptions && reviewOptions.memberName ? reviewOptions.memberName : '',
                    returnType: reviewOptions && reviewOptions.returnType ? reviewOptions.returnType : '',
                    isMethod: !!(reviewOptions && reviewOptions.isMethod),
                    writable: !!(reviewOptions && reviewOptions.writable),
                    // 新增类型/改写既有条目——审核员需要区分提议种类
                    newType: !!(reviewOptions && reviewOptions.newType),
                    override: !!(reviewOptions && reviewOptions.override),
                    sourceUrl: reviewOptions && reviewOptions.sourceUrl ? reviewOptions.sourceUrl : '',
                    reason: reviewOptions && reviewOptions.reason ? reviewOptions.reason : '',
                    signal: reviewOptions && reviewOptions.signal ? reviewOptions.signal : null,
                    reasoningEffort: settings.reasoningEffort || 'high',
                    timeoutMs: settings && settings.requestTimeoutMs ? settings.requestTimeoutMs : 120000
                });
            };
        global.AEEngine.reviewTableProposal = reviewTableProposalFn;
        const validator = ns.createScriptValidator({
            hostApi: context.hostApi,
            timeoutMs: 30000,
            // getSettings 注入随 validator 静态放行死分支收割（能力面由 AST 门承载）
            reviewScript: reviewScriptFn,
            reviewAeTool: reviewAeToolFn
        });
        // 暴露到全局供 script_manager 等模块复用（create/write 写盘前与 submit_script 同款校验）
        global.AEEngine.scriptValidator = validator;
        var llmToolReg = context.toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry);
        // 「当前选中」入口可见性判据要读它（本轮身份能不能真的调到 queryProject）——
        // 记到模块级，供 _syncSlots / app 层两个写点共用同一份注册表（各存一份必然漂移）。
        _llmToolReg = llmToolReg;
        var tcToolExec = context.toolExecutor || (global.AE_LLM && global.AE_LLM.toolExecutor);

        // tool_search：按需加载任意工具的参数定义。tools 参数只发 stub（name+短desc），
        // 模型用本工具获取完整 schema 后即可调用。tools 参数全程不变，缓存前缀稳定。
        if (llmToolReg && typeof llmToolReg.register === 'function' && !llmToolReg.hasTool('tool_search')) {
            llmToolReg.register({
                name: 'tool_search',
                description: '获取任意工具的完整参数定义（stub 工具仅含名称，需先调本工具获取 parameters 后才能正确调用）。支持按 name 列表批量获取或按 category 批量获取。',
                input_schema: {
                    type: 'object',
                    properties: {
                        names: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '工具名列表，如 ["getLayerInfo", "memory_create", "comfyui_generate"]。返回这些工具的完整定义'
                        },
                        category: {
                            type: 'string',
                            description: '按分组获取：project/composition/layer/animation/effect/render/utility/custom。返回该分组所有工具的完整定义（仅 AE 工具有 category 分组）'
                        }
                    }
                },
                handler: createToolSearchHandler(llmToolReg),
                scope: 'global',
                stub: false,
                source: 'agent',
                category: 'utility'
            });
        }

        // queryAeApi：查询 AE ExtendScript API 文档（按需获取 API 签名/参数/返回值）
        // 替代 Script 模式全量注入 2000 行 API 参考，LLM 按需查询节省 token
        if (llmToolReg && typeof llmToolReg.register === 'function' && !llmToolReg.hasTool('queryAeApi')) {
            llmToolReg.register({
                name: 'queryAeApi',
                description: '查询 After Effects ExtendScript API 文档。输入对象名、方法名或属性名，返回签名、参数、描述和返回值；输入效果/属性名（中英文均可，如"高斯模糊"或"Color Balance"）返回 matchName（ADBE 匹配名）。编写 ExtendScript 代码前用它确认 API 用法。',
                input_schema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: '查询关键词。支持对象名(如 "Property")、成员名(如 "setValueAtTime")、完整路径(如 "Property.setValueAtTime")或多个关键词(如 "keyframe time")'
                        },
                        mode: {
                            type: 'string',
                            enum: ['exact', 'fuzzy', 'object'],
                            description: 'exact=精确匹配成员名或完整路径；fuzzy=关键词分词匹配（默认，支持多关键词）；object=返回整个对象的所有属性和方法'
                        }
                    },
                    required: ['query']
                },
                handler: function (args) {
                    var mod = global.AEEngine && global.AEEngine.apiReferenceModule;
                    if (!mod || !mod.isReady()) {
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: 'API 参考文档尚未加载完成，请稍后重试。' }]
                        };
                    }
                    var q = args.query || '';
                    var mode = args.mode || 'fuzzy';
                    var result = mod.query(q, mode);
                    if (!result.success) {
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: result.error || '查询失败' }]
                        };
                    }
                    if (result.count === 0) {
                        // 给出可用对象列表帮助 LLM 调整查询
                        var objs = mod.listObjects();
                        var hint = '未找到匹配的 API。可用对象：' + objs.map(function (o) {
                            return o.name + '(' + (o.propertyCount + o.methodCount) + ')';
                        }).join(', ');
                        return {
                            success: true,
                            content: [{ type: 'text', text: hint }]
                        };
                    }
                    return {
                        success: true,
                        content: [{
                            type: 'text',
                            text: '找到 ' + result.count + ' 个匹配项：\n\n' + result.content.join('\n\n')
                        }]
                    };
                },
                scope: { type: 'module', moduleIds: ['agent', 'script', 'external-mcp'] },
                stub: false,
                source: 'agent',
                category: 'utility'
            });
        }

        // guide：创作指导 playbook 拉取工具（自主出片 MVP）。内容源随版本分发。
        // scope 限 external-mcp——外接专用知识工具：面板三模式的契约已在各自系统提示词/
        // 工具描述里，面板轮次不含它（面板侧零改动）。面板 shader 轮那份"按需取契约分节"
        // 的需求走**另一个工具**（shader_contract，见下），不动本工具。
        if (llmToolReg && typeof llmToolReg.register === 'function') {
            if (global.AEGuideTool && typeof global.AEGuideTool.registerGuideTool === 'function') {
                var guideReg = global.AEGuideTool.registerGuideTool(llmToolReg);
                if (!guideReg || !guideReg.ok) {
                    console.warn('[Engine] guide 工具注册失败: ' + (guideReg && guideReg.error));
                }
            } else {
                // 装载故障（manifest 载序/加载失败）：外接 instructions 已路由 guide，
                // 此处静默会让「有指路、无工具」无声成立——显式告警
                console.warn('[Engine] AEGuideTool 未加载，guide 工具未注册（instructions 路由将指向不可用工具）');
            }
        }

        // shader_contract：GLSL 契约分节拉取（**面板 shader 轮专用**）。
        // shader 轮系统提示词只常驻"核心契约 + 能力索引"，索引里的取用入口就是本工具——
        // 不给实装就是让模型指向一个调不到的工具。外接侧不给（它有 guide + submit_shader
        // 描述承载契约，保持原样不动）。
        if (llmToolReg && typeof llmToolReg.register === 'function') {
            if (global.AEShaderContractTool && typeof global.AEShaderContractTool.registerShaderContractTool === 'function') {
                var scReg = global.AEShaderContractTool.registerShaderContractTool(llmToolReg);
                if (!scReg || !scReg.ok) {
                    console.warn('[Engine] shader_contract 工具注册失败: ' + (scReg && scReg.error)
                        + '（shader 轮索引会指向不可用工具）');   // 同上：不许静默
                }
            } else {
                console.warn('[Engine] AEShaderContractTool 未加载，shader_contract 工具未注册'
                    + '（shader 轮能力索引的取用入口将不可用）');
            }
        }

        // sleep：让 LLM 主动等待指定时长（用于节流退避、等待外部进程落定、给用户留观察时间等）。
        // 单次最多等待 max_seconds（默认 60 秒），超出则截断并提示 LLM 再次调用，
        // 避免长时间阻塞工具循环（与 crewAI WaitTool 的 max_seconds 封顶设计一致）。
        if (llmToolReg && typeof llmToolReg.register === 'function' && !llmToolReg.hasTool('sleep')) {
            llmToolReg.register({
                name: 'sleep',
                description: '等待指定的秒数后返回。用于：API 限流退避、等待外部进程/后台任务落定、给用户留出观察时间。单次最多等待 60 秒，需要更久请多次调用。',
                input_schema: {
                    type: 'object',
                    properties: {
                        seconds: {
                            type: 'number',
                            description: '等待的秒数（0-60），单次最多 60 秒',
                            minimum: 0,
                            maximum: 60
                        },
                        reason: {
                            type: 'string',
                            description: '等待原因（可选），用于说明为何等待'
                        }
                    },
                    required: ['seconds']
                },
                handler: function (args) {
                    var seconds = Number(args.seconds);
                    if (!isFinite(seconds) || seconds < 0) seconds = 0;
                    var maxSeconds = 60;
                    var requested = seconds;
                    if (seconds > maxSeconds) seconds = maxSeconds;
                    // 同步 sleep 会阻塞主线程；用异步等待避免卡住 UI/工具循环
                    return new Promise(function (resolve) {
                        setTimeout(function () {
                            var msg = '已等待 ' + seconds + ' 秒';
                            if (args.reason) msg += '（原因：' + args.reason + '）';
                            if (requested > maxSeconds) {
                                msg += '。请求的 ' + requested + ' 秒超过单次上限，已截断为 ' + maxSeconds + ' 秒，如需继续等待请再次调用 sleep。';
                            }
                            resolve({
                                success: true,
                                content: [{ type: 'text', text: msg }]
                            });
                        }, seconds * 1000);
                    });
                },
                scope: 'global',
                stub: false,
                source: 'agent',
                category: 'utility'
            });
        }

        // 会话恢复时用**上次已知的请求固定开销**（system prompt + tools）
        // 预热 cm —— 真实值仍由 controller 在每轮构建请求时写入。修的是「重载面板后 overhead=0」
        // 这段窗口：此时用量条与「发送前的自动压缩闸」都按不含开销的低值判断，长会话会出现
        // 「该压不压」（实测 128K+300 条：19% vs 实写 6000 后 23%；32K 窗口差 18 个点）。
        // 用 primeOverheadTokens（只记值不裁剪），避免在归档回调就绪前就删消息。
        var OVERHEAD_STORE_KEY = 'ae_agent_ctx_overhead_v1';
        function _primeOverheadFromStore(cm, modeKey) {
            if (!cm || typeof cm.primeOverheadTokens !== 'function') return;
            try {
                if (!global.localStorage) return;
                var raw = global.localStorage.getItem(OVERHEAD_STORE_KEY);
                if (!raw) return;
                var map = JSON.parse(raw);
                var v = map && typeof map === 'object' ? Number(map[modeKey]) : 0;
                if (isFinite(v) && v > 0) cm.primeOverheadTokens(v);
            } catch (_) { /* 存储不可用/损坏：保持 0（旧行为） */ }
        }

        // 兜底值语义：maxContextTokens 只在**服务商未上报窗口**时
        // 生效；默认 256K（`|| 256000` 仅兜「从未设置过」的情形，已存盘的值一律原样透传，
        // 不在这里或 normalize 里重置）。生效上限由下面的 _applyModelWindowToAll 决定。
        const scriptContextManager = ns.createContextManager({
            storageKey: 'agent_session_v1',
            maxContextTokens: getSettings().maxContextTokens || 256000
        });
        const agentContextManager = ns.createContextManager({
            storageKey: 'ae_agent_tool_session_v2',
            maxContextTokens: getSettings().maxContextTokens || 256000
        });
        _scriptContextManager = scriptContextManager;
        _agentContextManager = agentContextManager;
        const shaderContextManager = ns.createContextManager({
            storageKey: 'ae_shader_session_v1',
            maxContextTokens: getSettings().maxContextTokens || 256000
        });
        _shaderContextManager = shaderContextManager;
        // 恢复即预热：key 与 controller 的 _rememberOverhead 同源
        _primeOverheadFromStore(scriptContextManager, 'script');
        _primeOverheadFromStore(agentContextManager, 'agent');
        _primeOverheadFromStore(shaderContextManager, 'shader');
        // 模型窗口：启动时先按当前模型同步一次——服务商上报了窗口
        // 就用它（优先），没上报才用上面的手填兜底值。用量条/闸门/设置面板提示在首个请求
        // 构建前就有正确口径。模型来源与 createController 注入的 getModel/getPlatform 同源
        // （_ctxModelSel 由 _withDefaultCache 刷新）。
        _applyModelWindowToAll();

        // 新增：两模式独立 sessionStore（文件持久化）
        var agentDataDir = 'agent';
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var dd = global.AEShared.getDataDir().dir;
                if (dd) {
                    // 归一化为正斜杠，与 sessionStore.js 内部拼接一致
                    agentDataDir = (dd + '/agent').replace(/\\/g, '/');
                }
            }
        } catch (_) {}
        const scriptSessionStore = ns.createSessionStore({
            fs: global.AEFS,
            dataDir: agentDataDir,
            mode: 'script'
        });
        const agentSessionStore = ns.createSessionStore({
            fs: global.AEFS,
            dataDir: agentDataDir,
            mode: 'agent'
        });
        _scriptSessionStore = scriptSessionStore;
        _agentSessionStore = agentSessionStore;
        const shaderSessionStore = ns.createSessionStore({
            fs: global.AEFS,
            dataDir: agentDataDir,
            mode: 'shader'
        });
        _shaderSessionStore = shaderSessionStore;

        // pruneByTokens 删除的早期消息归档（与 compressContext 的 saveArchive 同链路）：
        // 不归档则 toLlmMessages 的「已归档保存」提示指向空归档，且超预算旧会话载入后
        // 首条消息触发的 prune 删史会被防抖保存覆盖，早期历史永久丢失。
        // saveArchive 为 fire-and-forget（读-改-写），失败仅告警不影响主流程。
        function _bindPruneArchive(cm, store) {
            if (!cm || !store || typeof cm.setOnPrune !== 'function') return;
            cm.setOnPrune(function (removed) {
                var sid = cm.getSessionId();
                if (!sid) return;
                store.saveArchive(sid, removed).catch(function (e) {
                    console.warn('[Agent] prune saveArchive failed: ' + ((e && e.message) || e));
                });
            });
        }
        _bindPruneArchive(scriptContextManager, scriptSessionStore);
        _bindPruneArchive(agentContextManager, agentSessionStore);
        _bindPruneArchive(shaderContextManager, shaderSessionStore);

        // GLSL 契约：供 shader 模式 system prompt 使用；失败时降级为默认文案。
        // 注意 AEFS._checkPath 仅接受绝对路径（对齐下方 aeApiReference.txt 的 extRoot 拼接加载），
        // 直接用相对路径会被静默拒绝，故此处用 __ext_root 拼接后读取。
        if (global.AEFS && typeof global.AEFS.readFile === 'function' && !_shaderContractState) {
            var shaderContractRoot = (typeof window !== 'undefined' && window.__ext_root) || '';
            var shaderContractPath = shaderContractRoot
                ? String(shaderContractRoot).replace(/\\/g, '/').replace(/\/$/, '') + '/client/shared/glslApiReference.txt'
                : 'client/shared/glslApiReference.txt';
            global.AEFS.readFile(shaderContractPath)
                .then(function (t) {
                    if (typeof t === 'string' && t.trim()) _shaderContractState = t;
                })
                .catch(function () {});
        }

        // 面板关闭前强制落盘挂起的防抖写入（模块切换场景的落盘由 unmount() 负责）
        // 卸载窗口的会话消息写改走同步入口（对齐画布 与桌宠的
        // 同步通道）——只调异步 flush()：其写链（writeFile→Bridge fetch）在页面
        // 销毁窗口内会被中止，防抖窗口内最后一次落盘仍可能丢失。flushSyncNow 消费
        // 挂起的防抖快照并用 writeFileSync 直接落盘；无挂起快照/同步通道不可用
        //（降级 fs/旧 store）时退回异步 flush（在途异步链本就不受卸载窗口保证，
        // 属既有边界）。token 统计/plan 的写仍为异步「已发起」口径（不在本次收口范围）。
        function _flushSessionStoresOnUnload() {
            // 七条 store（单 Agent 三档 + 四条 lane；团队关闭时 = 改动前那三条）
            var stores = _allSessionStores();
            for (var i = 0; i < stores.length; i++) {
                var st = stores[i];
                if (!st) continue;
                var synced = false;
                if (typeof st.flushSyncNow === 'function') {
                    try { synced = st.flushSyncNow() === true; } catch (_) { synced = false; }
                }
                if (!synced && typeof st.flush === 'function') st.flush();
            }
        }
        if (typeof window !== 'undefined' && window.addEventListener && !_beforeUnloadBound) {
            _beforeUnloadBound = true;
            window.addEventListener('beforeunload', function () {
                // 关面板耗时埋点（只测量）：分段写 localStorage，下次启动转存
                // temp/logs/unload-timing.log；ut 缺失/异常不影响下面三步的既有行为。
                var ut = global.AEUnloadTrace;
                if (ut) ut.begin('engine');
                _flushSessionStoresOnUnload();
                if (ut) ut.mark('engine.sessionStores');
                // 同步保存当前会话的 token 统计，否则下次打开时归零
                _persistActiveTokenStats();
                if (ut) ut.mark('engine.tokenStats');
                // 确保 plan 的 pending save 已发起（AEFS 底层同步 XHR 在 beforeunload 内可完成）
                if (controller && typeof controller.flushPlan === 'function') controller.flushPlan();
                if (ut) { ut.mark('engine.flushPlan'); ut.commit(); }
            });
        }

        // pending 交接存储单例：controller 与 app/main.js 写端共享
        if (global.AEEngine && typeof global.AEEngine.createPendingInputStore === 'function' && !global.AEEngine.pendingInput) {
            global.AEEngine.pendingInput = global.AEEngine.createPendingInputStore();
        }

        // ── lane runtime 工厂 ───────────────────────────
        // 每条 runtime 自持 state / view / cm / store / controller。def 的两种形态：
        //   · 团队 lane（def.id 非空，定义来自 team/lanes.js）：cm / store **按 lane 建**并填进
        //     controller 的三个槽位（解析逻辑不改，该实例无论走哪槽都解析到自己）；
        //   · 单 Agent 路径（def.id 为空，见 _singleLaneDef）：cm / store 沿用装配期那三份，
        //     controller 收到的 opts 与改动前逐字节一致（不带任何 lane 身份）。
        // state 必须**每 lane 一份**：共享会让 busy / 消息 / 会话 id 三条互相覆盖。
        function createLaneRuntime(def) {
            var d = def || {};
            var isLane = !!d.id;
            var rt = { def: d, cm: null, store: null, state: ns.state.createAgentState(), view: null, controller: null };
            // 恢复窗口内才建出来的 runtime 也要继承恢复标志（见 _restoreInFlight 注释）：
            // 团队开关在启动恢复链跑完之前被打开时，三条 lane 是**这一刻**才建的——
            // 不继承就会留下「单 Agent 拒提交、lane 放行」的不对称窗口（lane 的会话恢复
            // 排在同一个链尾，放行的提交会落进初始孤儿会话）。
            rt.state.restoring = _restoreInFlight;
            var cmSlots = { script: scriptContextManager, agent: agentContextManager, shader: shaderContextManager };
            var storeSlots = { script: scriptSessionStore, agent: agentSessionStore, shader: shaderSessionStore };
            if (isLane) {
                rt.store = ns.createSessionStore({ fs: global.AEFS, dataDir: agentDataDir, mode: _laneStoreMode(d) });
                rt.cm = ns.createContextManager({
                    storageKey: _laneCmStorageKey(d),
                    maxContextTokens: getSettings().maxContextTokens || 256000
                });
                // 与三档单 Agent cm 同款的两件装配：恢复即预热与 prune 归档落盘
                _primeOverheadFromStore(rt.cm, _laneOverheadKey(d));
                _bindPruneArchive(rt.cm, rt.store);
                _laneContextManagers[d.id] = rt.cm;
                // 本 lane 的模型窗口：网络/用量分母在**首轮请求之前**就应按
                // 该 lane 自己的模型窗口计（controller 的 _applyModelWindowLimit 只在发请求前跑；
                // 团队刚开启时用量条不该先显示手填兜底值再跳）。
                try {
                    var _initSel = _resolveLaneSelection(d.id);
                    if (typeof global.AEEngine.readModelContextWindow === 'function'
                        && typeof rt.cm.setModelWindowLimit === 'function') {
                        rt.cm.setModelWindowLimit(global.AEEngine.readModelContextWindow(
                            _initSel.providerId, _initSel.modelId));
                    }
                } catch (_) { /* 窗口读不到：回落手填兜底值（接线前行为） */ }
                // lane store 登记：六条 store 的收集点（_allSessionStores）按此取，
                // 落盘 / chat_img 引用集 / 体积预算 / 启动恢复链都靠它覆盖到这一条 lane。
                // 同一 lane 只登记一次（orchestrator 保证 runtime 不重建；这里再兜一道，
                // 免得登记表里出现两条同 id 的 store 把同一份记录 flush 两遍）。
                if (!_laneSessionStores[d.id]) _laneStoreIds.push(d.id);
                _laneSessionStores[d.id] = rt.store;
                // lane store 立即 init：init() 幂等（返回同一个
                // _readyPromise），挂载期开团队时这次与启动恢复链那次是同一个 Promise、不重复读盘；
                // 但**运行时才开团队开关**时新建的 lane store 不在恢复链的 init 集里，不 init 则
                // controller.adoptSession 第 1 步的能力探测落到 ensure_failed / ensure_noop
                //（真机表现：设置里一开团队，整队「新建会话」直接失败，要重启面板才好）。
                // init 同步抛不阻断装配：store 保持未就绪，调用方按 not_ready 如实失败。
                if (rt.store && typeof rt.store.init === 'function') {
                    try {
                        var _laneInitP = rt.store.init();
                        if (_laneInitP && typeof _laneInitP.catch === 'function') _laneInitP.catch(function () {});
                    } catch (_) { /* 见上：不阻断装配 */ }
                }
                cmSlots = { script: rt.cm, agent: rt.cm, shader: rt.cm };
                storeSlots = { script: rt.store, agent: rt.store, shader: rt.store };
            }
            // 单 Agent 路径的 cm / store 不在这里：controller 按**运行时** runtimeMode 在三个槽位间
            // 解析（chatViewHelpers.getActiveCm/getActiveStore 是唯一权威），不存在「一条 runtime
            // 一个 cm」的静态归属 ⇒ 如实留 null，不复制第二份模式映射（复制必然漂移）。
            var lanesApi = (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
            rt.view = ns.createView({
                getDebugMode: getDebugMode,
                // 本 runtime 的 controller（惰性取：view 建在 controller 之前）。单 Agent 路径与
                // 改动前同义——那时读的是模块级 controller，指向的正是同一个对象。
                getActiveCm: function () { return rt.controller ? rt.controller.getActiveCm() : null; },
                dom: (isLane && lanesApi && typeof lanesApi.domFor === 'function') ? lanesApi.domFor(d.id) : undefined,
                // 团队 lane 的状态栏是**共用单例**：
                // sharedStatus 打开写闸门（只有当前 lane 能写这条栏），isCurrentLane 就是闸门判据
                //（与 ctrlOpts.isCurrentLane 同源——「本 lane 是否当前 lane」的唯一判据）。
                // 单 Agent 路径两个都不传：闸门恒开，行为逐字不变。
                sharedStatus: !!isLane,
                isCurrentLane: isLane ? function () { return _isCurrentLane(d.id); } : null
                // 顶栏用量行的浮层绑定：单 Agent view 自己绑顶栏（_byId('tokenStatsId') 就是它）；
                // 团队档没有 single view，由 _syncSlots 把当前 lane 的 view 迁绑到顶栏共享元素
                //（见 _bindTopTokenPopover）。不再注入 resolveTokenStatsSnapshot（它原本是给
                // 单 Agent view 兜「读当前 lane 快照」的；迁移后数据源就是当前 lane view 自己）。
            });
            var ctrlOpts = {
                state: rt.state,
                view: rt.view,
                service,
                validator,
                toolExecutor: tcToolExec,
                scriptContextManager: cmSlots.script,
                agentContextManager: cmSlots.agent,
                shaderContextManager: cmSlots.shader,
                scriptSessionStore: storeSlots.script,
                agentSessionStore: storeSlots.agent,
                shaderSessionStore: storeSlots.shader,
                saveSettings,
                llmChannel: context.llmChannel,
                toolRegistry: context.toolRegistry,
                moduleId: 'agent',
                getSettings: isLane ? _laneGetSettings(d) : () => ns.settings.normalize(getSettings()),
                showStatus: showStatus,
                showConfirm: showConfirm,
                onStateChange: function(s) { updateSendButton(); updateContextRing(); renderInjectChips(); },
                getGlobalSettings,
                // 请求目标：团队 lane 取**自己**的模型/平台（设置页三条 Agent
                // 各一份，经 resolveLaneModelSelection 成对解析；未配置则回落全局默认）；
                // 单 Agent 路径与改动前逐字一致（同一个全局缓存）。
                getModel: isLane ? function () { return _resolveLaneSelection(d.id).modelId; } : () => _defaultCache.modelId || '',
                getPlatform: isLane ? function () { return _resolveLaneSelection(d.id).providerId; } : () => _defaultCache.providerId || '',
                onScriptReady: updatePreviewScript,
                getCurrentScript: function () {
                    // 预览区代码读取：script 工具（get_current_script）与面板内 script 流程用本回调。
                    // **恒定读 #scriptPreview**，不再按 runtimeMode 判定
                    // ——写入侧按提交工具族路由（service.js opts.area），script 族的写入恒落
                    // script 区，读侧按模式分支只会造出不对称：外接在 shader 档调 get_current_script
                    // 会读回 GLSL。getCurrentShader 早已是恒定读法，两回调现在对称。
                    var preview = byId('scriptPreview');
                    return preview ? (preview.value || '') : '';
                },
                // shader 工具集专用读回调——恒定指向 GLSL 编辑区，
                // 不参与任何模式判定。外接模式下 shader/script 双预览区同显、两套工具同时在线，
                // 而 submit_shader 的写入侧（service.js 的 isShaderPreview；当时按 runtimeMode +
                // 外接 isPendingShaderSubmit 提示判定，现改由提交工具族声明 { area }）
                // 已按提示正确路由到 #shaderCodePreview——写分流、读不分流，
                // 于是 get_current_shader 读回的是 #scriptPreview 的脚本内容（读回链断裂：
                // 无法确认当前 GLSL——提交与局部编辑都以「先读回」为前提，读错区等于盲改）。
                // 单一按模式切换的回调无法同时
                // 服务两个工具，故读侧拆开。
                getCurrentShader: function () {
                    var preview = byId('shaderCodePreview');
                    return preview ? (preview.value || '') : '';
                },
                promptBuilder: context.promptBuilder
            };
            // 每条 runtime 一份可见性闸口：getSettings 指向本 runtime 的设置闭包，
            // lane 的可见性配置随本 lane 的设置现算；「保存后下一轮生效」由设置闭包天然满足。
            ctrlOpts.toolVisibility = _mkRuntimeToolVisibility(ctrlOpts.getSettings);
            // 会话 store 的**全量提供者**：后台结果按 sessionId 写回
            // 原会话时需要跨到别的 store（单 Agent ↔ lane）；三档 + 已装配 lane 一律从唯一收集点取。
            ctrlOpts.getSessionStores = function () { return _allSessionStores(); };
            if (isLane) {
                // lane 身份：laneId 是 AE 队列文案/快照分槽/统计分槽的身份，
                // lane 对象带 label/slot/laneKey/toolSet 供提示词骨架与工具投放使用。
                // toolSet 是**集合**（moduleIds）+ 收窄判据（filter，与投放侧同一个函数对象）。
                ctrlOpts.laneId = d.id;
                ctrlOpts.lane = {
                    id: d.id,
                    label: d.label || d.id,
                    slot: d.slot || '',
                    // 提示词骨架选择器：导演不套执行者骨架。选择器住 lanes.js，
                    // 这里只是原样下发；controller 据此选骨架，**不在 controller 里写 lane id 字面量**。
                    promptKind: d.promptKind || '',
                    laneKey: d.laneKey || d.id,
                    toolSet: { moduleIds: d.moduleIds.slice(), filter: d.filter }
                };
                ctrlOpts.dom = rt.view.getDom();
                ctrlOpts.toolSet = { moduleIds: d.moduleIds.slice(), filter: d.filter };
                // 本 lane 的 token 统计实例（与 controller 内部 _statsStore() 的
                // getLaneId → tokenStatsFor 同源——三条 lane 的 laneKey 与 id 同值）
                ctrlOpts.tokenStats = ns.tokenStatsFor(d.laneKey);
                // 团队任务清单：三条 lane 共用一份 ⇒ 工具 handler 经**同一个实例**读写
                //（每 lane 各建一份就是回到「三条各记各的」）。注入 getter 而不是实例：
                // 装配顺序上 lane runtime 可能早于 taskList 就绪（本函数在 _initTeamAssembly 之后
                // 才被 start 调用，但 getter 让这条依赖不靠顺序保证）。
                ctrlOpts.getTeamTaskList = function () { return _teamTaskList; };
                // goal：让行判据的数据源由装配层提供，controller/driver
                // 不重算「别的 lane 是否在忙」「名下子 Agent 还剩几个」。
                ctrlOpts.getOtherLanesBusy = function () { return _goalOtherLanesBusy(d.id); };
                ctrlOpts.getActiveSubagentCount = function () { return _goalActiveSubagents(d.id); };
                // 提示词注入器读目标（懒取：controller 在本函数返回后才赋值）
                ctrlOpts.getGoal = function () {
                    var c = rt.controller;
                    return (c && c.goal) ? c.goal.get() : null;
                };
                // 团队任务清单变化**不再**通知/唤醒导演（唤醒后常不知道
                // 该干什么）；执行进度由执行方自己 send_message 回报，验收由 goal 在
                // 「执行 lane 忙→闲」时兜底。故这里不再注入 notifyTeamTaskChange。
                // 计划处理器的 lane 解析：三条 lane 的工具身份里都含计划工具（trackSteps /
                // getPlanStatus / updatePlan），三条 lane 各注册一次同名工具，而注册表是 **last-wins**
                // ⇒ 每条 lane 注册的 handler 必须**按 ctx.laneId 现解析**到调用方那条 lane 的真实
                // 处理器；少了这一项，三条 lane 注册的都是各自本地那一份，模型在导演 lane 调
                // trackSteps，条目会写进**最后注册那条 lane** 的 plan（真机表现：导演列的步骤出现在
                // Shader 执行那条 lane 上）。与 initTeamTools 的 opts 同源（同一个函数对象）。
                ctrlOpts.getLanePlanHandlers = _lanePlanHandlersFor;
                ctrlOpts.isTeamMode = function () { return _teamEnabled; };
                // 本 lane 是否当前 lane（view / 权限确认 / 任务板 / toast 的唯一判据）
                ctrlOpts.isCurrentLane = function () { return !_teamEnabled || _isCurrentLane(d.id); };
                // 忙碌态上报钩子（见 _mkLaneBusyChangeReporter）：团队模式下
                // chatViewHelpers.syncView 的团队分支调它，本回调按 lane 去重后刷新团队锁；
                // 去重键含 controller.getSwitching()（惰性解析 —— 此处 controller 尚未建出来）。
                ctrlOpts.onBusyChange = _mkLaneBusyChangeReporter(d.id, function () { return rt.controller; });
            } else {
                // ── 单 Agent runtime（**只在团队关闭时存在**）──────────────
                // 团队档内不存在这条 runtime：进入团队即销毁（_disposeSingleRuntime），退出团队
                // 按 baseMode 重建。故这里不再注入「主 Agent 在团队档的忙锁上报」通道
                //（_mkMainBusyChangeReporter 已删）：单 Agent 的锁由 chatViewHelpers 的 non-team
                // 分支直接置 setSessionSwitcherDisabled，isTeamMode 恒 false 让它永远走那条分支。
                ctrlOpts.isTeamMode = function () { return false; };
                ctrlOpts.getGoal = function () {
                    var c = rt.controller;
                    return (c && c.goal) ? c.goal.get() : null;
                };
            }
            rt.controller = ns.createController(ctrlOpts);
            // lane 的固定开销按本 lane 身份现算（工具集与提示词骨架各不相同）：
            // 不能沿用 agent 键上的历史测量值，否则导演 lane 会显示执行 lane 的开销。
            if (isLane) _applyLaneOverheadEstimate(rt, d.laneKey || d.id);
            // runtime 带上**自己的**设置访问器（真机实测的回归）：
            // 模块级的 `roundIdentity()`（「当前选中」入口与当前轮 AE 快照的身份来源）按
            // `_currentRuntime().getSettings().runtimeMode` 取「当前档位」，而 runtime 对象
            // **没有**这个字段——它只进了 ctrlOpts ⇒ 挂在 controller 上，且 controller 的公开面
            // 不暴露 getSettings（真机实测 `Object.keys(getController())` 里没有它）。
            // 后果（单 Agent 四档全部中招，真机取证）：
            //   · agent 档与 shader 档实测 `roundIdentity()` 都是 `{ids:['script'], source:'mode'}`；
            //   · 于是 `applyAeStateChipVisibility()` 按 `['script']` 查注册表 ⇒ 判定「读得到工程」
            //     ⇒ **shader 档的「当前选中」入口本该隐藏却一直可见**（agent.css 与 applyAeStateChip-
            //     Visibility 的注释都写明 shader 档隐藏）；
            //   · hover / click 建引用也按错身份取快照（external 应映射 agent）。
            // 与 ctrlOpts **同一个函数对象**：lane 走 slot 钉死的 `_laneGetSettings`，单 Agent 走
            // 全局归一 —— 不新增第二份取值实现（identity 与发消息用的是同一份设置）。
            rt.getSettings = ctrlOpts.getSettings;
            // 消息操作（编辑用户消息）：**每个 view 各挂一次**，回调解到本条 runtime 的 controller
            //（单 Agent 路径与改动前是同一个对象、同一次调用；团队模式下每条 lane 编辑自己的消息）。
            if (rt.view && typeof rt.view.setMessageActionHandlers === 'function') {
                rt.view.setMessageActionHandlers({
                    onEdit: function (idx, text) { return rt.controller.editUserMessage(idx, text); },
                    // 编辑窗口结束（取消）时同步一次视图：编辑框是整表重建的「活元素」之一，它消失没有
                    // 别的事件通知——调试开关的延迟重建（state.debugRebuildPending）被闸门挡下后需要
                    // 这个信号才能立刻补做，否则要等下一次无关的 syncView（发消息/切会话）。
                    onEditCancel: function () {
                        if (rt.controller && typeof rt.controller.syncView === 'function') rt.controller.syncView();
                    }
                });
            }
            return rt;
        }

        // 4 档 dispatch 的唯一入口的薄转发：真源是 ns.settings.effectiveMode。
        // 为什么 bootstrap 也要有：这里的「单 Agent runtime 的 slot」「恢复链选哪份 store」都是
        // 4 档表的消费者，而 runtimeMode 现在可能是 'team'。引擎未加载/旧包时用本地同义兜底。
        function _effMode(s) {
            try {
                var fn = ns && ns.settings && ns.settings.effectiveMode;
                if (typeof fn === 'function') return fn(s);
            } catch (_) { /* 走下面的本地兜底 */ }
            var r = (s && s.runtimeMode) || 'script';
            if (r === 'team') return ((s.team && s.team.baseMode) || 'script');
            return r;
        }

        // 单 Agent 路径的 runtime 定义（团队关闭）：id 为空 ⇒ 工厂走「无 lane 身份」分支。
        // slot 只记录装配时的 runtimeMode（诊断用，不参与任何判定）。
        // 取 _effMode 而不是裸 runtimeMode —— 团队档下裸读会得到 'team'，它不在
        // 4 档表内，任何按 slot 判族的地方（_laneOverheadKey 等）都会落到兜底分支；被 park 的
        // 单 Agent runtime 应当保持一个真实的 4 档 slot（= baseMode）。
        function _singleLaneDef() {
            var mode = _effMode(getSettings() || {});
            return { id: '', label: '', slot: mode, laneKey: '', moduleIds: [], filter: null, containerId: '' };
        }

        // lane 的 sessionStore mode：**显式四档映射**。
        // 为什么不能写 'team-' + def.id（实测是坑）：
        // sessionStore 的白名单是 sessionStore.js 的
        // {'script','agent','shader','comfyui','team-director','team-ae','team-glsl','team-asset'}，
        // 而 'ae-' + 'exec' 拼出来是 **team-ae-exec**（不在白名单）⇒ 工厂在构造期就
        // assertSupportedMode 抛 INVALID_SESSION_MODE，团队模式在 lane runtime 构造处
        // 直接起不来（不是「落到别家命名空间」那种软故障，是硬失败）。lane id 与人读的
        // mode 不是同一套拼法（asset-gen → team-asset 尤其不能拼），故对照表写死在这里
        //（四条 lane 的 id 唯一来源是 lanes.js）。
        var LANE_STORE_MODES = { director: 'team-director', 'ae-exec': 'team-ae', glsl: 'team-glsl', 'asset-gen': 'team-asset' };
        function _laneStoreMode(d) {
            var mode = (d && LANE_STORE_MODES[d.id]) || '';
            // 未登记的 lane id 不猜、也不回落单 Agent 档（回落 = 团队会话与单 Agent 会话共用
            // 命名空间，用户会在 Agent/Script 列表里看到团队会话且无任何报错信号）。
            // 抛错是**刻意**的：orchestrator._registerLane 会把它记进 start().failed 并
            // 如实上报（单条 lane 装配失败不阻断另外两条），比静默串台好定位得多。
            if (!mode) throw new Error('[Agent] 未知团队 lane id，无法确定 sessionStore mode: ' + (d && d.id));
            return mode;
        }

        // lane 的 cm 存储键：per-lane 一份。共用一个 localStorage 键会让两条 lane 的兜底值与
        // 序列化快照互相覆盖；键名带 team 前缀，不与单 Agent 三档的历史键混用。
        function _laneCmStorageKey(d) {
            return 'ae_team_lane_' + (d.laneKey || d.id) + '_v1';
        }

        // 请求固定开销的预热键：与 controller 的 `_overheadStoreKey` 同源，team lane 用 'lane:<id>'。
        // 不同 lane 的工具集/提示词骨架不同，共用一个键会让一个 lane 的测量值被其它 lane 读走。
        function _laneOverheadKey(d) {
            return 'lane:' + (d.laneKey || d.id);
        }

        // lane 的 getSettings = 「全局设置 + lane 覆盖」：runtimeMode 取 lane 的 slot
        //（否则 GLSL lane 会拿到 Agent 骨架与 agent 工具族）。其余字段原样透传全局设置。
        // **思考等级**在这里按 lane 覆盖（设置页每条 Agent 一项，controller 的请求按
        // settings.reasoningEffort 下发）；模型/平台不在这里覆盖——它们是成对的请求目标，由
        // controller 的 getModel/getPlatform 经 resolveLaneModelSelection 提供（见 createLaneRuntime）。
        function _laneGetSettings(laneDef) {
            return function () {
                var base = getSettings() || {};
                var merged = {};
                for (var k in base) {
                    if (Object.prototype.hasOwnProperty.call(base, k)) merged[k] = base[k];
                }
                merged.runtimeMode = laneDef.slot || merged.runtimeMode || 'script';
                // slotOverride：lane 的 runtimeMode 是**槽位**，不是面板档位 ⇒ 跳过
                // applyModeConsistency（含老盘迁移）——否则会看到「runtimeMode='agent' +
                // team.enabled=true」而把 lane 的 team.enabled 改成 false、baseMode 抹成 slot，
                // 抹掉全局团队态与来处。lane 要的是「全局 team 段原样透传 + slot 覆盖档位」。
                var out = ns.settings.normalize(merged, { slotOverride: true });
                try {
                    var laneCfg = (out.team && out.team.lanes) ? out.team.lanes[laneDef.id] : null;
                    out.reasoningEffort = resolveLaneReasoningEffort(laneCfg, out.reasoningEffort);
                } catch (_) { /* 取不到 lane 配置：保持全局思考等级 */ }
                return out;
            };
        }

        // ── 子 Agent 运行器 ────────────────────────────────────
        // 与 lane runtime 的分工（本段只做这四件事，多一件都是越界）：
        //   · lane runtime = 常驻的三条 Agent（各有会话/视图/统计）；
        //   · 子 Agent = 父 lane 派生的一次性 Agent。它**必须**有自己的 cm/state/controller
        //     （共用会让子 Agent 与父 lane 互写历史），但**绝不能**有自己的 LLM 轮循环——
        //     第二份循环就是第二份收窄判据、第二份停止语义、第二份轮数上限的源头。
        //     故这里复用 ns.createController（投放侧收窄/执行侧闸门/停止链/轮数上限全在它里面），
        //     本段只负责：① 组「父 lane 的工具身份 + 同一份收窄判据 + 剔除三件 subagent 工具」的
        //     toolSet；② 建全新内存态 cm/state（不落会话文件、不继承父历史）；③ 跑完把摘要交回池
        //     （runTurn 返回体）——产物不落盘，由引擎在池的终态回投给发起者。
        // 公开面：**不进**任何公开面——池只认 runTurn，UI 只认池的 list()。

        // team.subagent 的归一值读取口 `_subagentGate(getSettingsFn)` 已提到**模块级**（见它上面的
        // 注释）：重挂路径（mount 被 mounted 守卫早退时）也要能把三闸回灌进模块级单例池。

        // 名字清单 → 集合（去空、去重）。空数组/非法值一律 null =「这一侧没有约束」，
        // 与「给了空清单 ⇒ 全部拒绝」区分开：后者会让 tools:{allow:[]} 变成一件工具都没有的
        // 子 Agent（模型只会反复重试同一件工具，而原因在回执里看不出来）。
        function _toolNameSet(v) {
            if (!Array.isArray(v) || !v.length) return null;
            var out = {};
            var any = false;
            for (var i = 0; i < v.length; i++) {
                if (typeof v[i] !== 'string' || !v[i]) continue;
                out[v[i]] = true;
                any = true;
            }
            return any ? out : null;
        }

        // ⑤ 空集告警：上面那句「空集合是静默失效，不是安全」不能只是注释 —— 收窄后一件工具都不剩时
        // （`tools.allow` 撞上父 lane 的 filter 黑名单是最常见的形态），子 Agent 会**零工具**起跑，
        // 模型只能空口作答，而回执上完全看不出原因。故这里把注释落成一次告警：带上是谁（子 Agent id /
        // 父 lane）与三个收窄面（allow / deny / 剔除名单）。判不出来时**不告警**（不造假信号）：
        // 注册表缺席 / 取不到工具清单 / 清单为空（装配还没完成）三种都直接返回。
        function _warnIfSubagentToolSetEmpty(filter, spec, info) {
            var reg = (context && context.toolRegistry) ? context.toolRegistry : null;
            if (!reg || typeof reg.getAll !== 'function') return;
            var all = [];
            try { all = reg.getAll() || []; } catch (_) { return; }
            if (!all.length) return;
            var kept = 0;
            for (var i = 0; i < all.length; i++) {
                var hit = false;
                try { hit = !!filter(all[i]); } catch (_) { hit = false; }
                if (hit) { kept++; break; }
            }
            if (kept) return;
            var who = (info && info.id) ? ('子 Agent ' + info.id) : '子 Agent';
            var parent = (info && info.parentLane) ? String(info.parentLane) : '(未知)';
            var allow = (spec && Array.isArray(spec.allow) && spec.allow.length) ? spec.allow.join(',') : '（未限）';
            var deny = (spec && Array.isArray(spec.deny) && spec.deny.length) ? spec.deny.join(',') : '（未限）';
            console.warn('[Agent] ' + who + '（父 lane=' + parent + '）的工具收窄结果为空集：'
                + 'allow=' + allow + ' / deny=' + deny + ' / 剔除名单=' + _subagentToolNames().join(',')
                + ' —— 注册表里 ' + all.length + ' 件工具一件都不剩，它这一轮没有任何工具可调。'
                + '常见原因：tools.allow 里的名字撞上了父 lane 的收窄判据（或大小写/拼写不符）。');
        }

        // 子 Agent 的工具收窄判据：**父 lane 的同一份判据**（从父 lane 的 controller 取，即
        // opts.toolSet.filter 那一个函数对象——投放侧/执行侧/tool_search 三处共用，V8/V37）
        // 叠加 tools.allow/deny，最后剔除三件 subagent 工具（一层边界）。
        // **只此一份**：子 Agent 的 toolSet.filter 就是它，这里不另写「哪些工具危险」的判断
        //（另写一份 = 两处判据必然漂移，而漂移的表现是「导演子 Agent 拿到了渲染工具」）。
        function _mkSubagentToolFilter(parentFilter, spec, info) {
            var names = _subagentToolNames();
            var excluded = {};
            for (var i = 0; i < names.length; i++) excluded[names[i]] = true;
            // 提问工具 askUser 一并剔除：子 Agent 没有用户，提问卡落在父 lane 的
            // 视图上——放进来只有两种结局：一调就回 unavailable 的死工具，或把卡片画进
            // 父 lane 的会话。子 Agent 的待确认项应写进结论交回上级。
            var _askName = (global.AEEngine && global.AEEngine.askUserTool)
                ? global.AEEngine.askUserTool.NAME : 'askUser';
            excluded[_askName] = true;
            var allow = _toolNameSet(spec && spec.allow);
            var deny = _toolNameSet(spec && spec.deny);
            var filter = function (entry) {
                if (!entry || !entry.name) return false;
                if (excluded[entry.name] === true) return false;         // 一层边界（不嵌套）
                if (allow && allow[entry.name] !== true) return false;   // 给了 allow ⇒ 只放行名单内
                if (deny && deny[entry.name] === true) return false;     // deny 优先于 allow
                return parentFilter ? !!parentFilter(entry) : true;
            };
            _warnIfSubagentToolSetEmpty(filter, spec, info);
            return filter;
        }

        // 轮数上限的执行点：子 Agent 用 team.subagent.maxLoops（默认 30），父沿用 controller
        // 内部的 MAX_TOOL_LOOPS（500）。
        // **判据唯一**：轮数由 LLM 通道观察器数（带 tools 的 sendStream 调用 = 工具循环的一轮，
        // 1:1；自动压缩发的是 tools: []，不计入），到顶后由**执行器**拒发工具——回执是一条面向
        // 模型的正常工具结果（"已达上限，请直接给结论"），而不是把通道伪造成报错（那会让父层看到
        // 一句假的网络错误，用户去查网络永远查不出原因）。
        // 为什么落在执行器而不是通道：controller 的 MAX_TOOL_LOOPS 是**函数内部常量**（controller.js:35），
        // 没有注入通道，只能在运行器
        // 侧设卡，`maxToolLoops` 同时按契约注入 ctrlOpts（controller.js 接上该 opt 后，原生上限
        // 先于本桥触发，本桥自动失效，两者同值故不会双重设卡）。
        // 父路径完全不经过本包装器（见 createLaneRuntime 的 toolExecutor: tcToolExec）⇒ 逐字不变。
        function _mkSubagentToolExecutor(baseExec, getRounds, maxLoops) {
            if (!baseExec || typeof baseExec.call !== 'function') return baseExec;   // 无执行器 ⇒ 原样（由既有链显式失败）
            // 走**原型链**包装：只覆盖 call，其余面（execute / setToolRegistry …）
            // 原样透传。若返回一个字面量对象、只暴露 call ⇒ 将来任何 `.execute(...)` 调用都会
            // TypeError（今天无消费者，但那是雷不是设计）。
            var wrapped = (typeof Object.create === 'function') ? Object.create(baseExec) : {};
            wrapped.call = function (toolName, args, moduleId, callerId, execOpts) {
                var used = 0;
                try { used = Number(getRounds()) || 0; } catch (_) { used = 0; }
                if (used > maxLoops) {
                    return Promise.resolve({
                        success: false,
                        result: JSON.stringify({
                            status: 'error',
                            code: 'subagent_loop_limit',
                            message: '子 Agent 已达轮数上限（' + maxLoops + ' 轮），本次不再执行 ' + toolName
                                + '。请基于已有信息直接给出结论（做了什么、产物在哪、有哪些存疑），不要再调用工具。'
                        })
                    });
                }
                return baseExec.call(toolName, args, moduleId, callerId, execOpts);
            };
            return wrapped;
        }

        // LLM 通道观察器：**只观察、不改变行为**（累计 usage 供池的 tokens 字段用真值，数工具轮数
        // 供上限桥用）。用 Object.create 走原型链——通道的其它方法原样可用，既不复制也不枚举
        //（逐方法转发漏一个就是一条断链，且只会在真机上炸）。
        function _mkSubagentChannel(baseChannel, counts) {
            if (!baseChannel || typeof baseChannel.sendStream !== 'function') return baseChannel;
            if (typeof Object.create !== 'function') return baseChannel;   // 理论不可达（CEP 是 Chromium）
            var shim = Object.create(baseChannel);
            shim.sendStream = function (req, handlers) {
                var r = req || {};
                if (Array.isArray(r.tools) && r.tools.length) counts.rounds++;
                var p = baseChannel.sendStream(r, handlers);
                if (!p || typeof p.then !== 'function') return p;
                return p.then(function (res) {
                    var u = res && res.usage;
                    if (u) {
                        counts.prompt += Number(u.prompt_tokens) || 0;
                        counts.completion += Number(u.completion_tokens) || 0;
                    }
                    return res;
                });
            };
            return shim;
        }

        // 子 Agent 的 view 桩（**无 DOM**，不经 view 的消息流——子 Agent 的进度由卡片
        // 渲染）。方法清单 = controller 及其拆分文件真实调用过的**全集**（照 view.js 的公开面抄，
        // 一个都不能少：少一个就是一条真机 TypeError，而单测只跑「创建」路径时看不见）。
        // appendToolConfirm **有意返回 null**：子 Agent 没有用户确认通道 ⇒ 权限闸的决策停在
        // approved:false，该调用被拒（fail-closed）。绝不在这里自动放行——那等于绕开父 lane 的
        // 权限档（父是 conservative 时子 Agent 反而畅通无阻，是权限升级而不是继承）。
        function _mkSubagentViewStub() {
            var noop = function () {};
            return {
                appendToken: noop,
                appendReasoningToken: noop,
                finalizeReasoningStream: noop,
                appendLocalMessage: noop,
                appendToolProgress: function () { return null; },
                removeToolProgress: noop,
                markToolProgressRunning: noop,
                markToolRejected: noop,
                markToolRevisionRequested: noop,
                appendToolConfirm: function () { return null; },
                // 提问工具（askUser）：子 Agent 没有用户，恒返回 null ⇒ handler 按
                // 「提问面板不可用」fail-closed，不落任何 DOM（与 appendToolConfirm 同款口径）。
                appendAskUser: function () { return null; },
                renderMessages: noop,
                renderStatusCard: noop,
                resetRenderedCount: noop,
                setBusy: noop,
                setMode: noop,
                updateTokenStats: noop,
                scrollToBottom: noop,
                clearStreaming: noop,
                clearInput: noop,
                getInput: function () { return ''; },
                getDom: function () { return {}; }
            };
        }

        // 子 Agent 的首轮消息文本（它唯一的任务输入：不继承父历史，只拿任务描述 + 可读工作区）。
        // 文案口径：**不出现内部术语 lane**，且上级用**显示名**（导演 / AE 执行 / Shader 执行）
        // 而不是 id——这段文本是模型直接读的，写 id 会让它在回复里说「我是 director」。
        function _subagentTaskText(id, title, task, parentLane) {
            return [
                '【子 Agent 任务 ' + id + '】你由「' + _laneLabelOf(parentLane) + '」派生，任务如下：',
                (title ? ('标题：' + title) : ''),
                '',
                task,
                '',
                '工作方式：先 read_workspace(\'brief.md\') 读团队计划书；文字分镜在 storyboard.md。再动手；'
                    + '看不到上级 Agent 的对话历史，只能读团队工作区。',
                '你只有一层：不能派生新的子 Agent（派生、发消息、查名册这几件工具不在你的工具集里，'
                    + '需要更多人手时把这件事写进结论，由上级 Agent 决定）。',
                '完成后**直接给出结论**：做了什么、产物在哪、怎么验证、有哪些存疑或偏离。'
                    + '这段结论会作为消息回给派它的 Agent。'
            ].join('\n');
        }

        // 子 Agent 的追问文本（追问 = 同一 ctx 再跑一轮，池把追问内容放在 ctx.message 上）。
        // **来源要写清**：用户从面板弹窗直接追问时，子 Agent 容易把这条
        // user 消息当成上级 Agent 的指令（它的对话里唯一的「上级」就是派单人）——它会回答「收到上级追问」，
        // 而实际上这是用户本人问的。来源由池的 ctx.askOrigin 带到运行器，两种口径分开写。
        function _subagentFollowUpText(id, message, origin) {
            var fromUser = (origin === 'user');
            return [
                fromUser
                    ? ('【用户直接追问 ' + id + '】这条追问来自面板上的**用户本人**，不是派你的上级 Agent。')
                    : ('【上级 Agent 追问 ' + id + '】'),
                message,
                '',
                '这是**同一段对话的续跑**：你之前已经跑过一轮，上下文与工作区都还在。',
                fromUser
                    ? '直接回答用户；本轮结论只回给用户（**不会回投给上级 Agent**）。'
                    : '补完以后请**直接给出结论**（改了什么/补了什么、产物在哪、还有哪些存疑）；'
                        + '这段结论会作为消息回给派它的 Agent。'
            ].join('\n');
        }

        // 子 Agent 的结论摘要 = 它自己的最后一条 assistant 消息（**不是**父 lane 的，也不是
        // cm 估算）。上限 4000 字符（与 context 层 summarizeDetail 同一约定）：这段摘要就是回给
        // 发起者的**全部产物**（产物只走回投，不落文件），截断只防把父 lane 的上下文撑爆。
        function _subagentSummaryOf(state) {
            var msgs = (state && Array.isArray(state.messages)) ? state.messages : [];
            for (var i = msgs.length - 1; i >= 0; i--) {
                var m = msgs[i];
                if (!m || m.role !== 'assistant') continue;
                var text = (typeof m.text === 'string') ? m.text.replace(/^\s+|\s+$/g, '') : '';
                if (!text) continue;
                return (text.length > 4000) ? (text.slice(0, 4000) + '\n…（结论过长已截断）') : text;
            }
            return '';
        }

        // 团队会话 id：**唯一来源**是 binder（与 read_workspace/write_workspace 的 getTeamSessionId
        // 同源）——不读 _teamSessionId 镜像，也不猜当前会话。
        function _teamCurrentSessionId() {
            try {
                return (_sessionBinder && typeof _sessionBinder.getCurrentSessionId === 'function')
                    ? (_sessionBinder.getCurrentSessionId() || '') : '';
            } catch (_) { return ''; }
        }

        // 运行器工厂（不进公开面，只喂池的 runTurn）。失败一律**返回**显式失败体，绝不抛：
        // 池把 runTurn 的返回体当子 Agent 的终态，抛出去就是一个没有原因的 running。
        function createSubagentRuntime(ctx) {
            var c = ctx || {};
            var id = (typeof c.id === 'string') ? c.id : '';
            var title = (typeof c.title === 'string') ? c.title : '';
            var task = (typeof c.task === 'string') ? c.task : '';
            var parentLane = (typeof c.parentLane === 'string') ? c.parentLane : '';
            var toolsSpec = c.tools || null;
            var signal = c.signal || null;
            var counts = { prompt: 0, completion: 0, rounds: 0, turns: 0 };
            var built = null;      // 惰性：run() 才建（团队关闭/父 lane 缺席/已停止 ⇒ 零副作用）
            var aborted = false;

            function tokens() {
                return { prompt: counts.prompt, completion: counts.completion, total: counts.prompt + counts.completion };
            }

            // 停止：两条来源（池 abort 信号 / 池直接调 abort()）都收敛到 controller.requestStop()
            // ——既有停链（abort 在途请求 + 循环出口复位）不另造一份。
            function abort() {
                aborted = true;
                if (built && built.controller && typeof built.controller.requestStop === 'function') {
                    try { built.controller.requestStop(); } catch (_) { /* 停失败不改终态：aborted 已置位 */ }
                }
            }

            function _bindSignal(b) {
                if (!signal) return;
                if (signal.aborted === true) { abort(); return; }
                if (typeof signal.addEventListener !== 'function') return;   // 桩 signal：只认 aborted
                signal.addEventListener('abort', function () { abort(); });
            }

            // 装配：父 lane 身份 + 工具身份 + 设置快照 + cm/state/view 桩/执行器/通道 → controller。
            function _build() {
                if (!_teamEnabled || !_orchestrator) {
                    return { ok: false, reason: 'not_team', message: '团队模式当前未开启：子 Agent 不启动。' };
                }
                if (!id) return { ok: false, reason: 'bad_id', message: '子 Agent id 缺失：产出路径与停止语义都要用它。' };
                var parentRt = _orchestrator.getLane(parentLane);
                if (!parentRt || !parentRt.controller) {
                    return {
                        ok: false, reason: 'no_parent_lane',
                        message: '上级 Agent「' + _laneLabelOf(parentLane) + '」未装配（没有 runtime/controller）：'
                            + '子 Agent 无法继承它的工具集与权限档。'
                    };
                }
                // 父 lane 的定义：lanes.get 优先（原始定义，含 slot），回落 runtime 上的 def。
                var def = null;
                var lanesApi = (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
                if (lanesApi && typeof lanesApi.get === 'function') {
                    try { def = lanesApi.get(parentLane); } catch (_) { def = null; }
                }
                if (!def) def = parentRt.def || null;
                if (!def) {
                    return {
                        ok: false, reason: 'no_parent_lane',
                        message: '上级 Agent「' + _laneLabelOf(parentLane) + '」的定义取不到（lanes.get 与 runtime.def 都缺席）：'
                            + '子 Agent 拿不到执行槽位（runtimeMode）与工具身份。'
                    };
                }
                // 工具身份：**父 lane 的 controller** 是投放/执行两侧共用的那一份（V37），
                // 定义源只作回落（两者按构造是同一个函数对象与同一批 moduleIds）。
                var pc = parentRt.controller;
                var moduleIds = null;
                var parentFilter = null;
                if (typeof pc.getModuleIds === 'function') {
                    try { moduleIds = pc.getModuleIds(); } catch (_) { moduleIds = null; }
                }
                // base 判据必须是 lanes.js 的**纯函数**（def.filter），不能用父 controller 的
                // getToolFilter()：它就是依赖父 runtime **实时设置**的闸口 filter，若当 base
                // 会把父的实时配置透进「派生时冻结」的子 Agent（后果：
                // 用户保存一次可见性配置 → 已在跑的子 Agent 下一轮静默失去工具）。
                // 父视图的可见性配置由子 Agent 自己的冻结设置快照（baseSettings，见下）继承。
                if (def && typeof def.filter === 'function') parentFilter = def.filter;
                else if (typeof pc.getToolFilter === 'function') {
                    // 回落：def 不带 filter 的旧/测试装配形状（生产四条 lane 定义恒带 filter）。
                    try { parentFilter = pc.getToolFilter(); } catch (_) { parentFilter = null; }
                }
                if (!Array.isArray(moduleIds) || !moduleIds.length) moduleIds = (def.moduleIds || []).slice();
                if (typeof parentFilter !== 'function') parentFilter = (typeof def.filter === 'function') ? def.filter : null;
                if (!moduleIds.length) {
                    return {
                        ok: false, reason: 'no_tool_identity',
                        message: '上级 Agent「' + _laneLabelOf(parentLane) + '」的工具身份为空（moduleIds 取不到）：'
                            + '子 Agent 若回落成单模块身份就会拿到与上级 Agent 不同的工具面，故不启动。'
                    };
                }
                // 设置快照：父 lane 那一份（runtimeMode = 父的 slot ⇒ 与父同族的轮次语义），
                // 权限档在**派生那一刻冻结**——用户中途改档不影响已在跑的子 Agent
                //（避免「跑一半权限被放开」：子 Agent 的调用没有确认界面，档位一变就是静默放宽）。
                var baseSettings = null;
                try {
                    baseSettings = _laneGetSettings(def)();
                } catch (_) { baseSettings = null; }
                if (!baseSettings || typeof baseSettings !== 'object') {
                    return {
                        ok: false, reason: 'settings_unavailable',
                        message: '上级 Agent 的设置快照取不到（engine/settings.js 的归一缺席或抛错）：'
                            + '子 Agent 的权限档与执行槽位无从继承，故不启动。'
                    };
                }
                var snap = {};
                for (var k in baseSettings) {
                    if (Object.prototype.hasOwnProperty.call(baseSettings, k)) snap[k] = baseSettings[k];
                }
                var tier = (typeof snap.permissionMode === 'string' && snap.permissionMode) ? snap.permissionMode : 'balanced';
                snap.permissionMode = tier;
                var getSubSettings = function () { return snap; };

                var maxLoops = (_subagentLimits && _subagentLimits.maxLoops) ? _subagentLimits.maxLoops : 30;
                // 池透传的 ctx.maxLoops 优先（maxLoops 由池透传、池自己不用它跑循环）。
                // 它与 _subagentLimits.maxLoops **同源**（池就是拿那份归一值建的），这里认池给的那一份。
                if (typeof c.maxLoops === 'number' && isFinite(c.maxLoops) && c.maxLoops > 0) {
                    maxLoops = Math.floor(c.maxLoops);
                }
                var cm = ns.createContextManager({ maxContextTokens: snap.maxContextTokens || 256000 });
                // 子 Agent 继承父 lane 的模型窗口：它现在按父 lane 的模型发请求，
                // 不先写窗口的话首轮会按手填兜底值裁剪（父 lane 的 cm 有窗口、子 Agent 没有）。
                try {
                    var _subLaneSel = _resolveLaneSelection(parentLane);
                    if (typeof global.AEEngine.readModelContextWindow === 'function'
                        && typeof cm.setModelWindowLimit === 'function') {
                        cm.setModelWindowLimit(global.AEEngine.readModelContextWindow(
                            _subLaneSel.providerId, _subLaneSel.modelId));
                    }
                } catch (_) { /* 窗口读不到：回落手填兜底值（与接线前一致） */ }
                var st = ns.state.createAgentState();
                // 子 Agent 的 AE 调用**过既有队列**：执行器仍是 tcToolExec 那一条链（AE 队列开关由
                // orchestrator 在团队开启时打开），这里只包一层轮数上限；laneId 传父 lane ⇒ AE
                // 队列的等待/失败文案标明占用者，且 tokenStats/previewSnapshot 的账落在父 lane 上
                //（子 Agent 的开销就是父 lane 的开销，不为每次 spawn 造一个无人消费的统计实例）。
                var exec = _mkSubagentToolExecutor(tcToolExec, function () { return counts.rounds; }, maxLoops);
                var channel = _mkSubagentChannel(context.llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel), counts);
                var ctrlOpts = {
                    state: st,
                    view: _mkSubagentViewStub(),
                    service: service,
                    validator: validator,
                    toolExecutor: exec,
                    // 三个槽位都是**这一份**新 cm：子 Agent 不落会话文件、不继承父历史
                    scriptContextManager: cm,
                    agentContextManager: cm,
                    shaderContextManager: cm,
                    // 会话 store 一律 null：子 Agent 不写任何会话文件（读回现有内容/落盘都是父 lane 的事）。
                    // 下游对 null 都有守卫（chatViewHelpers.getActiveStore 的调用点全部判空）。
                    scriptSessionStore: null,
                    agentSessionStore: null,
                    shaderSessionStore: null,
                    // saveSettings 传 no-op：子 Agent 的 getSettings 是**冻结快照**，
                    // 而 controller 的 switchMode 路径会把当前设置写回（controller.js:3077/3111/3153）。
                    // 真机今天走不到那条路（只由 UI 事件触发），但一旦走到就是把冻结快照写回全局设置——
                    // 传给 no-op 把这条雷拆掉，行为面零变化。
                    saveSettings: function () { },
                    llmChannel: channel,
                    toolRegistry: context.toolRegistry,
                    moduleId: 'agent',
                    getSettings: getSubSettings,
                    // 子 Agent 的一切 UI 副作用都**必须**关掉：状态栏是共用单例、toast 是全局栈，
                    // 子 Agent 的进度由子 Agent 卡片渲染——写进去就是「导演 lane 的状态栏在报
                    // 子 Agent 的进度」这类张冠李戴。
                    showStatus: function () {},
                    onStateChange: function () {},
                    // 子 Agent 没有预览区写入通道：返回 false 让提交类工具如实报写入失败。
                    onScriptReady: function () { return false; },
                    getGlobalSettings: getGlobalSettings,
                    getModel: function () { return _resolveLaneSelection(parentLane).modelId; },
                    getPlatform: function () { return _resolveLaneSelection(parentLane).providerId; },
                    // 预览区读取与 lane 同口径（恒定读法，不按模式分流）；写入侧由工具族路由，
                    // 子 Agent 的提交落哪个区由它拿到的工具决定。
                    getCurrentScript: function () {
                        var preview = byId('scriptPreview');
                        return preview ? (preview.value || '') : '';
                    },
                    getCurrentShader: function () {
                        var preview = byId('shaderCodePreview');
                        return preview ? (preview.value || '') : '';
                    },
                    promptBuilder: context.promptBuilder,
                    // laneId = 父 lane（见上面 exec 的注释）：AE 队列文案/tokenStats/previewSnapshot
                    // 三处身份都指向真正付账的那条 lane；子 Agent 自己的 id 只归池与卡片。
                    laneId: parentLane,
                    // 子 Agent 身份：团队任务清单只能读，写操作由 handler 拒绝。
                    // 随 execCtx 下发给工具 handler（toolExecutionPipeline 的 isSubagent），不是靠 lane 判。
                    isSubagent: true,
                    // 提示词骨架随**上级 lane** 继承：子 Agent 的工具集本就是父 lane 的
                    // 收窄版，骨架不跟父走就会出现「导演的子 Agent 被教去调 executeExtendScript」。
                    // 只带骨架选择器与身份字段——工具面走下面的 opts.toolSet（收窄后的那一份）。
                    lane: {
                        id: parentLane,
                        label: (def && def.label) || parentLane,
                        slot: (def && def.slot) || '',
                        promptKind: (def && def.promptKind) || '',
                        laneKey: (def && def.laneKey) || parentLane
                    },
                    toolSet: {
                        moduleIds: moduleIds.slice(),
                        // info 只喂 ⑤ 的空集告警（谁、哪条父 lane）——收窄判据本身与它无关。
                        filter: _mkSubagentToolFilter(parentFilter, toolsSpec, { id: id, parentLane: parentLane })
                    },
                    tokenStats: ns.tokenStatsFor(parentLane),
                    // 团队任务清单：子 Agent 的工具身份继承父 lane（moduleIds 含 'team'）⇒ 它的
                    // 工具清单里**有** `updateTeamTasks`；不注入 getter 会让这件工具变成「点了就报
                    // no_task_list」的死工具。注入同一个实例 ⇒ 子 Agent 能用 add/set_status 记自己的
                    // 进度（工具描述已写明协作规则：整表替换会覆盖别人的）。
                    getTeamTaskList: function () { return _teamTaskList; },
                    // 任务清单变化不再唤醒导演（子 Agent 也一样）。
                    isTeamMode: function () { return _teamEnabled; },
                    // 计划处理器的 lane 解析（**第三个注入点**）：子 Agent 的
                    // laneId = 父 lane ⇒ controller 判它是 lane controller（controller.js:597）⇒ 它也把
                    // planHandlers 注册进**共享注册表**（last-wins）。不注解析器时，spawn 过一次就用
                    // 「子 Agent 自己的本地 planApi」顶掉三条 lane 的 lane-aware 包装器 —— 此后按
                    // ctx.laneId 的路由再次失效（真机表现：派过一次子 Agent，导演列的步骤又跑到别的
                    // lane 上去）。注**同一个函数对象**（唯一实现在 _lanePlanHandlersFor，禁第二套判据）：
                    // 注册的包装器语义等价（不再顶掉），且子 Agent 的计划工具按 ctx.laneId=父 lane 解析
                    // ⇒ 它的 todo 落在**父 lane 的计划树**上。
                    getLanePlanHandlers: _lanePlanHandlersFor,
                    // 子 Agent **永远不是当前 lane**：任务板/锁/toast 的判据不许把它算进来。
                    isCurrentLane: function () { return false; },
                    // 声明式注入（controller.js 尚未消费，见 _mkSubagentToolExecutor 的注释）：
                    // 这两个键是「原生通道」的位置，接线落地后桥自动失效，语义一字不变。
                    maxToolLoops: maxLoops,
                    permissionTier: tier,
                    // 消息列表 id 指向一个**不存在**的节点：controller 的 _laneListEl() 是 DOM 的
                    // 兜底取值点（停止/报错分支的思考气泡定形），不指开就会落到单 Agent 的
                    // #aeAgentMessageList 上——子 Agent 的收尾动作会去改用户正在看的聊天区。
                    dom: { listId: 'aeAgentSubagent_' + id }
                };
                // 子 Agent 的闸口：getSettings 指向**派生时冻结的设置快照**（与权限档同口径）——
                // 用户中途改可见性配置不影响已在跑的子 Agent；保存后新派生的子 Agent 用新配置。
                // getLaneFilter 由工厂按 lanes.js 的 lane 定义取（= 父 lane 的同一函数对象）。
                ctrlOpts.toolVisibility = _mkRuntimeToolVisibility(getSubSettings);
                var controller = null;
                try {
                    controller = ns.createController(ctrlOpts);
                } catch (e) {
                    return {
                        ok: false, reason: 'controller_failed',
                        message: '子 Agent 的 controller 装配失败：' + String((e && e.message) || e)
                    };
                }
                if (!controller || typeof controller.injectSystemMessage !== 'function') {
                    return {
                        ok: false, reason: 'controller_failed',
                        message: '子 Agent 的 controller 没有 injectSystemMessage 通道（装配失败）。'
                    };
                }
                return {
                    ok: true, controller: controller, state: st, cm: cm,
                    maxLoops: maxLoops, tier: tier
                };
            }

            // 跑一轮（首轮 = 任务；再跑 = 追问，同一 cm/state/controller 续跑，见 _subagentRuntimes）。
            function _runTurn(b, text) {
                counts.turns++;
                var pending = null;
                try {
                    // 走 controller 既有的系统消息注入 = addMessage + _runUserRequest（**既有循环**）。
                    // sessionId 传 null：子 Agent 不落会话文件，也就没有「会话一致性」可判。
                    pending = b.controller.injectSystemMessage(text, null, null, {
                        team: 'subagent', id: id, title: title, parentLane: parentLane, turn: counts.turns
                    });
                } catch (e) {
                    return Promise.resolve({ ok: false, reason: 'error', message: '子 Agent 启动失败：' + String((e && e.message) || e) });
                }
                return Promise.resolve(pending).then(function () {
                    if (aborted || (signal && signal.aborted === true)) {
                        return { ok: false, reason: 'stopped', message: '子 Agent 已被停止（本轮中止）。' };
                    }
                    var summary = _subagentSummaryOf(b.state);
                    if (!summary) {
                        return {
                            ok: false, reason: 'empty_result',
                            message: '子 Agent 跑完了但没有任何结论产出（没有 assistant 消息）：'
                                + '检查模型/密钥配置后重试。'
                        };
                    }
                    // 产物只经回投送达（不再写 subtasks/<id>.md —— 落盘与回投是两份重复，
                    // 父 lane 拿到的是下面这个 summary，引擎在池的终态把它作为消息投给发起者）。
                    return {
                        ok: true,
                        summary: summary,
                        tokens: tokens(),
                        capped: counts.rounds > b.maxLoops
                    };
                }, function (e) {
                    return { ok: false, reason: 'turn_failed', message: '子 Agent 本轮失败：' + String((e && e.message) || e) };
                });
            }

            function run() {
                if (aborted) {
                    return Promise.resolve({ ok: false, reason: 'stopped', message: '子 Agent 已被停止，未开始执行。' });
                }
                // 追问：池复用同一个 ctx，把追问内容放在 ctx.message 上并再调一次 runTurn。
                // 判据是**运行器是否已建**（不是 ctx.message 在不在：ctx 是同一个对象，上一轮的值
                // 会残留，用残留值判会把「首轮」误判成「追问」）。
                var followUp = (typeof c.message === 'string') ? c.message.replace(/^\s+|\s+$/g, '') : '';
                if (built) {
                    if (!followUp) {
                        return Promise.resolve({
                            ok: false, reason: 'bad_message',
                            message: '追问内容为空（ctx.message 不在）：追问必须是「要它补什么」的一句话。'
                        });
                    }
                    return _runTurn(built, _subagentFollowUpText(id, followUp,
                        (c.askOrigin === 'user') ? 'user' : 'agent'));
                }
                var b = _build();
                if (!b || b.ok !== true) return Promise.resolve(b);
                built = b;
                _bindSignal(b);
                if (aborted) {
                    return Promise.resolve({ ok: false, reason: 'stopped', message: '子 Agent 已被停止（装配后立即中止）。' });
                }
                return _runTurn(b, _subagentTaskText(id, title, task, parentLane));
            }

            return {
                run: run, tokens: tokens, abort: abort,
                // 会话弹窗（`getSubagentSession`）按 `rt.cm.list()` 取对话，而装配是**惰性**的
                // （首轮 run 才 _build）。建好之前运行器记录里没有 cm 也没有 controller ⇒ 弹窗永远
                // 落进「还没有消息」分支（真机实测：子 Agent 已跑 2 轮、tokens 在涨，弹窗仍是空的）。
                // 这里给一个 getter：建之前返回 null，建之后返回那一份（含 cm/state/controller）。
                getBuilt: function () { return built; }
            };
        }

        // runTurn 的落点（挂载期实现）：**按 id 复用运行器**——追问是「同一 ctx 再跑一轮」，
        // 复用同一个 cm/state/controller 才叫追问（另起一个就是"什么都不记得的子 Agent"，
        // 而回执上看不出来）。释放时机由池的状态通知决定（见 _pruneSubagentRuntimes）。
        function _subagentRunTurnForMount(ctx) {
            var id = (ctx && typeof ctx.id === 'string') ? ctx.id : '';
            if (!id) return createSubagentRuntime(ctx).run();   // 无 id：运行器工厂会显式失败（bad_id）
            var rt = _subagentRuntimes[id];
            if (!rt) {
                rt = createSubagentRuntime(ctx);
                _subagentRuntimes[id] = rt;
            }
            return rt.run();
        }

        // ── 团队装配收口：工作区 + team 域工具 + 会话 binder ────────
        // 三件东西的依赖是有向的，顺序不能换：
        //   workspace  → teamTools（注册期就要 workspace 实例，缺它就整件工具不注册）
        //              → binder（orchestrator 的 sessions 注入项：orchestrator 创建时**读一次**
        //                 opts.sessions 存进闭包，晚于它创建就永远拿不到）
        //              → orchestrator（_enableTeam 里创建，团队关闭时**不创建**）。
        // 工作区数据根与 sessionStore 同源同口径：AEShared.getDataDir().dir，反斜杠归一为 '/'。
        // 用**函数**注入而不是当场取值：用户可以在面板里换数据目录，缓存住就会写到旧根。
        function _teamDataDir() {
            try {
                if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                    var dd = global.AEShared.getDataDir().dir;
                    if (dd) return String(dd).replace(/\\/g, '/');
                }
            } catch (_) { /* 数据目录拿不到：工作区层据此显式失败（not_found/no_data_dir），不猜 */ }
            return '';
        }

        // 消息入口（统一入口 `send_message`）：注入给 team 域工具的 `dispatch`。
        // 形状按工具 handler 的调用惯例 (args, ctx)——args 是工具入参，ctx 是 toolExecutor 透传的
        // 执行上下文（{ moduleId, moduleIds, callerId, laneId }，见 shared/toolExecutor.js:115-118）。
        //
        // **来源 lane 只认执行上下文里的 laneId**（ctx.laneId 是执行侧给的本次调用身份；args 里若
        // 带了同名字段/from，那是调用方显式带入的同一件事，两者都没有 ⇒ 显式失败 not_team）。
        // 为什么不回落「当前 lane」：团队开着时用户可能正停在导演 lane 看，而这次调用其实来自外接
        // 通道或脚本区（toolExecutor 对它们不下发 laneId）⇒ 猜出来的 from 会把别处的活记到导演头上，
        // 而且没有任何报错信号。宁可不派单，也不猜。
        function _teamDispatch(args, ctx) {
            var a = args || {};
            var ctxLane = (ctx && typeof ctx.laneId === 'string') ? ctx.laneId : '';
            var argLane = (typeof a.from === 'string' && a.from) ? a.from
                : ((typeof a.laneId === 'string') ? a.laneId : '');
            var laneId = ctxLane || argLane;      // ctx 优先：执行侧身份比调用方自报更靠得住
            if (!laneId) {
                return {
                    ok: false, reason: 'not_team',
                    message: '派单需要来源 Agent 身份（本次工具执行的上下文里没有 Agent 身份）：'
                        + '只有团队 Agent 的工具循环能派单，外接 / 脚本区 / 单 Agent 路径不派单。'
                };
            }
            // 团队关着时不做任何事：`_disableTeam()` 只 dispose 不置空 _orchestrator（装配期单例），
            // 少了这道闸，关掉团队后主线程仍能派出工作项（编排面的 lane runtime 还在）。
            if (!_teamEnabled || !_orchestrator) {
                return { ok: false, reason: 'not_team', message: '团队模式当前未开启：派单不可用。' };
            }
            return _orchestrator.dispatchTask({
                from: laneId, to: a.to, summary: a.summary
            });
        }

        // 团队名册：`list_agents` 的数据源。**不持有任何状态**——每次都问编排面要：
        //   · lanes 段 = getBoardSnapshot().lanes（与任务板 UI 同一条链、同一份判据）。
        // 无 dispatches 段——消息不再有「等结论回来」的在途态。
        // 团队关着 ⇒ not_team（与 _teamDispatch 同款：关了就是不提供，不返回一份「三条都空闲」的
        // 假状态——那会让模型以为团队还在跑）。snapshot 抛错 ⇒ 如实 error，不吞。
        function _teamRuntimeStatus() {
            if (!_teamEnabled || !_orchestrator) {
                return { ok: false, reason: 'not_team', message: '团队模式当前未开启：名册不可用。' };
            }
            var snap = null;
            try {
                snap = _orchestrator.getBoardSnapshot();
            } catch (e) {
                return { ok: false, reason: 'error', message: '任务板快照读取失败：' + String((e && e.message) || e) };
            }
            return {
                ok: true,
                lanes: (snap && snap.lanes) || []
            };
        }

        // 团队 lane 的**名字**名册（lane id：director / ae-exec / glsl / asset-gen），来源是 `lanes.list()` 的 id 字段。
        // 为什么**不能**用 `lanes.listIds()`：它返回的是各条 lane 的**容器 DOM id**
        //（lanes.js 的 `l.containerId`，UI 依赖它 ⇒ 不许改 lanes.js），lane id 一个都不在里面
        // —— 拿它当白名单，任何 lane 身份都判不中（`from` 恒落 main / 或恒 not_team），身份判定的结果
        // 与真相无关（同 _lanePlanHandlersFor 的注记：那里也踩过同一个坑）。
        function _teamLaneNames() {
            var out = [];
            try {
                var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
                var list = (api && typeof api.list === 'function') ? (api.list() || []) : [];
                for (var i = 0; i < list.length; i++) {
                    var id = list[i] && list[i].id;
                    if (typeof id === 'string' && id) out.push(id);
                }
            } catch (_) { out = []; }
            return out;
        }

        // 团队消息（统一入口）：`send_message` 的落点。
        // **来源**（`from`）在这里判定，且只判一次：三条 lane 的执行上下文带 ctx.laneId ⇒ 用它。
        // 团队档内**不再造 `from:'main'` 的投递**——主通道已移除，
        // 拿不到 laneId 就显式失败 `no_source`（单 Agent 路径没有团队消息语义，外接/脚本区同理；
        // 猜一个来源会把别处的活记到某个 lane 头上）。来源侧 `'main'` 仍被编排面接受，供历史
        // `askDirector` 一类只读兼容调用使用。
        // 身份**非空但不在名册里** ⇒ 显式失败（不静默当 main）：fail-open 会把别处的活记到主 Agent
        // 头上，也没有任何报错信号（见 _teamDispatch 的同款注释）。
        function _teamSendMessage(target, message, ctx) {
            if (!_teamEnabled || !_orchestrator) {
                return { ok: false, reason: 'not_team', message: '团队模式当前未开启：没有可收消息的 Agent。' };
            }
            var laneId = (ctx && typeof ctx.laneId === 'string') ? ctx.laneId : '';
            if (!laneId) {
                return {
                    ok: false, reason: 'no_source',
                    message: '消息来源身份缺失（本次工具执行的上下文里没有团队 Agent 身份）：'
                        + '只有团队 Agent 的工具循环能发消息；团队主通道已移除，单 Agent / 外接 / 脚本区没有收件落点。'
                };
            }
            var names = _teamLaneNames();
            if (names.indexOf(laneId) < 0) {
                return {
                    ok: false, reason: 'not_team',
                    message: '消息来源身份「' + laneId + '」不是当前团队的 Agent（合法的 id：'
                        + (names.length ? names.join('、') : '（名册为空：团队定义未加载）') + '）：'
                        + '消息未投递（身份不明时不能按 main 记账——否则发送方会被记错）。'
                };
            }
            return _orchestrator.sendMessage({ from: laneId, to: target, message: message });
        }

        // `_deliverToMain` 随团队主通道移除——团队档内没有
        // 单 Agent runtime，`send_message(target:'main')` 由编排面直接返回 `main_removed`
        //（dispatch.js 的目标校验 + orchestrator._deliver 的 main 分支），不再有「送进单 Agent」
        // 的投递落点；后台结果只按发起时快照的 sessionId 写回原会话（见 facade injectSystemResult）。

        function _initTeamAssembly() {
            var teamApi = global.AEAgentTeam;
            if (!teamApi) return;   // 装配面缺席：_enableTeam 已有同款告警，这里不重复刷屏
            if (!_teamWorkspace && typeof teamApi.createWorkspace === 'function') {
                _teamWorkspace = teamApi.createWorkspace({
                    aefs: global.AEFS,
                    getDataDir: _teamDataDir
                });
            }
            // 团队任务清单：**一份清单属于团队会话，三条 Agent 共用**。
            // 装配期建、模块级单例（与 workspace/binder 同款）：工具在 lane 侧注册时就要能拿到它，
            // 且 onChange 必须一次接到任务板刷新上（接两次会让一次写入刷两遍面板）。
            // 依赖 workspace（读/写 + 路径安全 + 串行写队列）——workspace 缺席时不建实例：
            // 工具会如实报 no_team_session 之外的原因（taskList 侧显式 no_workspace），不假装能记。
            if (!_teamTaskList && typeof teamApi.createTaskList === 'function') {
                _teamTaskList = teamApi.createTaskList({
                    workspace: _teamWorkspace,
                    onChange: function () {
                        // 清单变化 ⇒ 刷任务板（「团队任务清单」段）。UI 缺席不影响工具成功。
                        try {
                            var ui = global.AEAgentTeamUI;
                            if (ui && typeof ui.renderBoard === 'function') ui.renderBoard();
                        } catch (_) { /* 见上 */ }
                    },
                    onWarn: function (m) { console.warn(m); }
                });
            }
            // 子 Agent 池：**装配期**建、模块级单例（与 binder 同款，见 _subagentPool 的
            // 注释）。为什么必须在这里：三件 subagent 工具在**装配期**注册（下面的 initTeamTools），
            // 池得先就位；注册点唯一，不做事后二次注册。池本身是惰性的（不 spawn 就不建 cm/controller），
            // 故「团队关闭」路径上它只是一个空壳（团队关闭时 spawn 一律显式 not_team）。
            // 归一值缺席（engine/settings.js 未加载）/池工厂缺席（team/subagent.js 未加载）⇒ 不建池，
            // 三件工具随之不注册——缺的就是缺的，不拿手抄默认值假装装配齐了。
            if (!_subagentPool && _subagentLimits && typeof teamApi.createSubagentPool === 'function') {
                _subagentPool = teamApi.createSubagentPool({
                    maxConcurrent: _subagentLimits.maxConcurrent,
                    keepAliveMs: _subagentLimits.keepAliveMs,
                    maxLoops: _subagentLimits.maxLoops,
                    // 注入时钟：生产就是系统钟（保活/耗时的判据），单测可换固定钟
                    now: function () { return Date.now(); },
                    runTurn: function (ctx) { return _subagentRunTurn(ctx); },
                    onStateChange: _notifySubagentStateChange
                });
                if (!_subagentPool) console.warn('[Agent] createSubagentPool 未返回实例：子 Agent 三件工具不会注册');
            }
            // 三闸回灌（复核修）：**每次装配都做**。首次装配时池刚按 _subagentLimits 建出来（回灌是
            // 同值幂等、不产生通知）；重挂装配时池是既有单例（`!_subagentPool` 守卫跳过建池）——
            // 正是这里把这次读到的归一值送进池，改了 team.subagent 不必再整页重载。
            _pushSubagentLimitsToPool();
            // team 域工具：read_workspace（scope moduleIds:['team']、readOnly）。
            // 为什么在**装配期**注册而不是「开团队时」注册：三条 lane 的工具身份里都带 'team'
            // （lanes.js），工具晚于 lane runtime 落地就会出现「这一轮的工具清单里没有它」的窗口；
            // 单 Agent 三档的身份（script/agent/shader）不含 'team'，注册它对单 Agent 路径零影响。
            if (!_teamToolsInited && typeof teamApi.initTeamTools === 'function') {
                _teamToolsInited = true;
                var toolsRes = teamApi.initTeamTools({
                    toolRegistry: llmToolReg,
                    workspace: _teamWorkspace,
                    // 团队是否开着：spawn 用它做**预检**——异步派遣之后，runner 的失败不再能从
                    // 回执里看见（回执先返回），故「团队没开」这类可预判的错误必须在工具层当场拒。
                    isTeamMode: function () { return _teamEnabled; },
                    // 计划处理器的 lane 解析：三条 lane 各注册一次同名计划工具，而注册表是
                    // **last-wins** ⇒ 注册的 handler 必须按 ctx.laneId 现解析到调用方那条 lane 的
                    // 真实处理器（否则三条 lane 的 todo 全写进最后注册那条 lane 的 plan）。
                    // 每条 lane 的 controller 暴露 `planApi`（那一条自己的三个处理器）。
                    // **同一个函数对象**：lane 的 ctrlOpts 注的也是它（唯一实现在 _lanePlanHandlersFor；
                    // 未知/空 laneId ⇒ null）。
                    getLanePlanHandlers: _lanePlanHandlersFor,
                    // 团队会话 id 的**唯一来源**是 binder（id 规则 team_<时间戳>_<随机段>
                    // 也归它）；闭包读取 ⇒ binder 晚于注册建立也能取到最新值。
                    getTeamSessionId: function () {
                        return _sessionBinder ? _sessionBinder.getCurrentSessionId() : null;
                    },
                    // 消息（第四个 opts）：`send_message` 的落点。形状与失败口径
                    // 见 _teamDispatch——来源 lane 取 ctx.laneId，拿不到就 not_team，不猜当前 lane。
                    dispatch: _teamDispatch,
                    // 子 Agent（第五个 opts）：三件工具的落点。**同一个池实例**——
                    // 编排面（快照/停止级联）与工具面必须看同一份状态，两处各建一个池就是两个并发闸。
                    subagents: _subagentPool,
                    // 名册读取口：`list_agents` 的落点。数据源是编排面**既有**的
                    // getBoardSnapshot()（任务板 UI 也在读它，一份判据）；本文件不重算忙闲、
                    // 不碰 lane runtime。在途派单段随完成回投下线一起删除。
                    roster: _teamRuntimeStatus,
                    // 团队消息：`send_message` 的落点。来源在这里判定
                    //（lane 的执行上下文带 laneId，其余是 'main'），目标校验与投递在编排面。
                    sendMessage: _teamSendMessage
                });
                // initTeamTools 的失败是**装配级**故障（团队各条 lane 一起失去 read_workspace）：
                // 显式告警、不吞（no_workspace / no_registry / register_failed 都带 reason）。
                if (!toolsRes || toolsRes.ok !== true) {
                    console.warn('[Agent] 团队工具装配失败（read_workspace 对团队 lane 不可用）: '
                        + JSON.stringify(toolsRes));
                }
            }
            if (!_sessionBinder && typeof teamApi.createSessionBinder === 'function') {
                _sessionBinder = teamApi.createSessionBinder({
                    lanes: teamApi.lanes,
                    getLaneController: function (id) {
                        var rt = _orchestrator ? _orchestrator.getLane(id) : null;
                        return rt ? rt.controller : null;
                    },
                    getLaneStore: function (id) { return _laneSessionStores[id] || null; },
                    // **晚绑定**：binder 必须先于 orchestrator 建（orchestrator 的 sessions 注入项
                    // 就是它，创建时就取），此处直接写 _orchestrator.stopAll() 会在创建期捕获
                    // undefined；转发发生在调用时，那时 orchestrator 一定已就位。
                    stopAll: function () { return _orchestrator ? _orchestrator.stopAll() : null; },
                    // 绑定变化的唯一通知口：会话镜像跟着 binder 的**实际**绑定走。
                    // 为什么不能只在 orchestrator.deleteTeamSession 里跟：真机 UI 的删除是 binder
                    // 直调（sessionSwitcher.js:421），那条路根本不经过 orchestrator ⇒ 删掉当前会话后
                    // 镜像停在已删 id，派单会被 apiActions 静默丢弃（任务板上却显示已投递）。
                    // 两个镜像一起同步：orchestrator 的 teamSessionId（派单/工作区定位用）与
                    // bootstrap 的 _teamSessionId（关团队再开时重新绑的那份）。
                    onBoundChange: function (sid) {
                        _teamSessionId = sid || null;
                        // 不变量自检：绑定通知到达时，三条 lane 应已全部 adopt 到这条 sid。
                        // 不一致 = 整队已分叉（部分失败回滚未完成 / 外部改了单 lane）——如实告警；
                        // sid 为空（解绑）不是分叉，跳过。
                        if (sid) _checkTeamSessionConsistency('onBoundChange');
                        // 子 Agent 名册跟着会话走：**换了一条会话**
                        // 就把旧会话的名册清掉（池的单例语义与三条边界见 _syncSubagentRoster 头注）。
                        // 位置在 taskList 之前：两件事互不依赖，但都必须在 `if (!sid) return;` 之前
                        //（解绑那一路也要把归属镜像落到 null）。
                        _syncSubagentRoster(sid);
                        // 团队任务清单跟着会话走：一份清单属于**团队会话**，切会话即换文件。
                        // 幂等 bind（同一 sid 重复通知）由 taskList 自己判重——它不重载内存，
                        // 免得把「刚写进内存还没落盘」的改动闪回旧值。
                        if (_teamTaskList) {
                            if (sid) {
                                try { _teamTaskList.bindSession(sid); } catch (e) {
                                    console.warn('[Agent] 团队任务清单绑定会话失败（' + sid + '）: '
                                        + ((e && e.message) || e));
                                }
                            } else {
                                try { _teamTaskList.reset(); } catch (_) { /* 见上 */ }
                            }
                        }
                        if (!sid) return;
                        _ensureTeamWorkspace(sid);
                        if (_orchestrator && typeof _orchestrator.noteTeamSessionId === 'function') {
                            // **纯镜像落值**（不做 IO、不回调 binder）：拿 bindSession 当镜像 setter
                            // 会无限递归（bind 正是 binder 的注入面，它会再发一次 onBoundChange）。
                            try { _orchestrator.noteTeamSessionId(sid); } catch (_) {
                                /* 镜像同步失败：派单会如实报 not_team，不阻断会话操作本身 */
                            }
                        }
                    }
                });
            }
        }

        // 团队会话的「建立 / 切换」落点：预建工作区目录（面板侧 AEFS 预建）。
        // 三条 lane 的会话切换**只有 binder 一个下发口**，而它经 orchestrator 的三个方法暴露
        // ⇒ 直接在这三个方法外挂一层：任何调用方（团队开关 / 会话列表 / 派单）
        // 都会命中，不必要求每个调用点各写一次 ensureDir（散点必漏，且漏了没有报错信号——
        // 真机表现为「团队会话建立了但工作区目录不存在」）。
        function _wrapTeamSessionEntry(orch) {
            if (!orch) return orch;
            var names = ['bindSession', 'createTeamSession', 'switchTeamSession'];
            for (var i = 0; i < names.length; i++) {
                (function (name) {
                    var orig = orch[name];
                    if (typeof orig !== 'function') return;
                    orch[name] = function () {
                        var res = orig.apply(orch, arguments);
                        // 只有真的落到某个 sid 上才预建：失败体（busy / partial / not_wired）不建，
                        // 免得给一个并不存在的会话留下空工作区目录。
                        // **去重**：binder 的 onBoundChange 已经在同一次调用里预建过（它先于
                        // 本包装层执行），这里只在「镜像还没跟上这个 sid」时补一次——否则 bind/create/
                        // switch 每次都会建两遍（幂等，但会让「一次操作一次预建」的门禁断言失去判别力）。
                        if (res && res.ok === true && typeof res.sid === 'string' && res.sid && _teamSessionId !== res.sid) {
                            _teamSessionId = res.sid;
                            _ensureTeamWorkspace(res.sid);
                        }
                        return res;
                    };
                })(names[i]);
            }
            // 删除也挂一层：删的是当前绑定的那条时，binder 会**先整队切走
            // 再删**（返回体带 switchedTo）。镜像必须落到新落点上——留旧值会让「关团队再开」
            // 把三条 lane 绑回一条已删的会话（_enableTeam(_teamSessionId)）；删掉的不是当前
            // 那条时才置空。工作区只给**新落点**预建，绝不给已删会话建目录。
            var origDelete = orch.deleteTeamSession;
            if (typeof origDelete === 'function') {
                orch.deleteTeamSession = function (sid) {
                    var res = origDelete.apply(orch, arguments);
                    if (res && res.ok === true) {
                        if (typeof res.switchedTo === 'string' && res.switchedTo) {
                            _teamSessionId = res.switchedTo;
                            _ensureTeamWorkspace(res.switchedTo);
                        } else if (_teamSessionId === sid) {
                            _teamSessionId = null;
                        }
                    }
                    return res;
                };
            }
            return orch;
        }

        // ── 团队模式的装配与开关 ──────────────────────
        // 启用点 = settings.team.enabled（归一的唯一实现在 engine/settings.js 的 normalizeTeam，
        // 读取访问器是 AEAgentTeam.settings.isEnabled）。**关闭路径不创建 orchestrator**
        //（orchestrator.js 头注 :36-37）。AEExecQueue 的开关**只经 orchestrator**——这里不在别处
        // 再 enable 一次，否则「谁负责关队列」就没有唯一落点。
        // 团队会话 id 的镜像（binder 是真相源，见 _wrapTeamSessionEntry / setTeamMode）：
        // 关开关再开回来时用它把同一个团队会话重新绑上（重开即恢复）。
        var _teamSessionId = null;

        // 单 Agent runtime 的**入口空闲判据**：
        // busy / restoring / switching / 消息动作窗口内拒绝开始团队装配（fail-fast）。
        // 为什么必须同步拒绝而不是排队：这个窗口里销毁单 Agent runtime 会截断在跑的轮次/编辑动作，
        // 而 `_orchestrator.start()` 是同步建 lane 的，没有「等空闲再开」的落点。
        // 取不到能力时按「不忙」处理（老装配），但不能默认忙——那会让团队永远开不起来。
        function _singleRuntimeBusy() {
            var rt = _singleRuntime;
            if (!rt) return false;
            var st = rt.state || {};
            if (st.busy === true || st.restoring === true) return true;
            var c = rt.controller;
            if (!c) return false;
            function probe(name) {
                try { return (typeof c[name] === 'function') && !!c[name](); } catch (_) { return false; }
            }
            // getDispatching：输入派发的 await 窗口（submitUserInput 持派发锁）里
            // busy 可能还没翻真——此时拆 runtime 会掐掉刚提交的那一轮（用户点开团队，消息凭空消失）。
            return probe('isBusy') || probe('getSwitching') || probe('getStopping')
                || probe('getMsgActionBusy') || probe('getDispatching');
        }

        function _enableTeam(teamSessionIdArg) {
            var teamApi = global.AEAgentTeam;
            if (!teamApi || typeof teamApi.createOrchestrator !== 'function') {
                // 装配面缺席（manifest 载序/脚本加载失败）：如实告警并**保持单 Agent 路径**，
                // 不静默开一个没有编排面的团队（三条 lane 容器亮着却没人跑）。
                console.warn('[Agent] 团队模式已开启但 orchestrator 未加载，保持单 Agent 路径');
                return null;
            }
            // 状态机守卫：starting/stopping 是同步窗口，外部正常不可达；显式拒绝而不是重入
            //（重入会把「正在关」的编排面重新 start，得到半开态；busy 是调用方看得见的失败）。
            // 回执契约：引擎拒绝「开始团队」时必须带 rolledBack:true ——
            // teamUI._setTeamEnabled 在调引擎前已把 runtimeMode='team'/team.enabled 落盘，它只认
            // `res===null` 或 `res.rolledBack===true` 才回滚设置。少了这个标记：单 Agent 忙时点
            // 第 5 档，引擎拒绝、UI 无提示、设置写死，重载后团队「自行开启」。
            // 引擎侧统一给（不只改 UI）：所有「没有开始团队」的拒绝都是同一种契约。
            if (_teamState === 'starting' || _teamState === 'stopping') {
                return {
                    ok: false, reason: 'busy', rolledBack: true, teamState: 'off',
                    failed: [], currentLane: '', queueEnabled: true, session: null,
                    message: '团队模式正在切换中（启动/关闭窗口）：等这次切换完成后再试。'
                };
            }
            // 入口空闲守卫：单 Agent 在 busy/restoring/switching/消息动作/
            // 派发窗口（getDispatching）⇒ `single_busy`，**不启动** orchestrator。调用方
            //（teamUI.setTeamEnabled）走既有「失败回滚设置」分支（rolledBack:true），单 Agent 原样继续跑。
            if (_singleRuntimeBusy()) {
                return {
                    ok: false, reason: 'single_busy', rolledBack: true, teamState: 'off',
                    failed: [], currentLane: '', queueEnabled: true, session: null,
                    message: '单 Agent 通道忙（在跑 / 在恢复 / 在切会话 / 消息操作 / 派发中）：等它空闲后再开团队。'
                };
            }
            if (!_orchestrator) {
                _orchestrator = teamApi.createOrchestrator({
                    lanes: teamApi.lanes,
                    createLaneRuntime: createLaneRuntime,
                    execQueue: global.AEExecQueue,
                    getSettings: getSettings,
                    // 团队会话广播器（binder）：orchestrator 的 bind/create/switch/rename/delete
                    // 五个薄封装全部转发到它。未装配（team/sessionBinder.js 缺席）时注入 null ⇒
                    // orchestrator 如实返回 { ok:false, reason:'not_wired' }，不假装切过了。
                    sessions: _sessionBinder,
                    // 切 lane 只搬单例槽（真相源已在 orchestrator 内部改好；这里抛错会被它吞掉，
                    // 不会让切 lane 半途失败）。除槽位外，共用状态栏、切 lane 提示条与 lane 容器
                    // 显隐也必须跟着走——见 _syncLaneChrome。
                    // next/prev 透传下去：提示条只在「真的换了」时弹（装配期 prev 为空不弹）。
                    onCurrentLaneChange: function (next, prev) { _syncSlots(); _syncLaneChrome(next, prev); },
                    hideContainers: hideLaneContainers,
                    // 子 Agent 池：**同一个实例**（装配期建，见 _initTeamAssembly）。
                    // orchestrator 只有两个消费点（快照的 subagents 段、停止级联），它不自己建池——
                    // 并发闸是面板级单例，两处各建一个就是两个闸。
                    subagents: _subagentPool
                    // `deliverToMain` 注入已删——主通道不存在，
                    // 编排面的 `_deliver` 对 target==='main' 直接返回 main_removed。
                });
                _wrapTeamSessionEntry(_orchestrator);
            }
            _setTeamState('starting');
            var res = _orchestrator.start(teamSessionIdArg);
            var startedList = (res && Array.isArray(res.started)) ? res.started.slice() : [];
            var reusedList = (res && Array.isArray(res.reused)) ? res.reused.slice() : [];
            var failedList = (res && Array.isArray(res.failed)) ? res.failed.slice() : [];
            var startOk = !!(res && res.ok === true);
            var anyRuntime = (startedList.length + reusedList.length) > 0;
            _lastTeamFailure = startOk ? null
                : { reason: (res && res.reason) || 'runtime_failed', failed: failedList.slice(), at: Date.now() };
            if (!startOk && !anyRuntime) {
                // ── 全失败：引擎态**回滚** ──────────────────────────────────────────
                // 回滚走编排面自己的 dispose（全停 + 隐藏容器）——与「关团队」同一份收尾语义，
                // 不另写第二条清理链。队列是面板常开资源，dispose 不会关它，
                // 故回滚后 queueEnabled 仍为 true（如实报告状态，不代表「团队开着」）。
                // 回滚后必须把单例槽指回单 Agent：不指回去，UI 按 `getCurrentLaneId()` 渲染团队
                // 布局，而 `_currentRuntime()` 因 getLane() 为 null 回落单 Agent——消息会跑进隐藏
                // 容器（这正是本次要根治的分裂形态）。
                try { _orchestrator.dispose(); } catch (e) {
                    console.warn('[Agent] 团队态回滚：dispose 异常（继续收口单例槽）: ' + ((e && e.message) || e));
                }
                _setTeamState('off');
                _syncSlots();
                try {
                    var uiRollback = global.AEAgentTeamUI;
                    if (uiRollback && typeof uiRollback.syncLaneVisibility === 'function') uiRollback.syncLaneVisibility();
                } catch (_) { /* UI 缺席：引擎态已正确，下次挂载自己对齐 */ }
                console.warn('[Agent] 团队模式启动失败（无可用 lane），已回滚到单 Agent：'
                    + JSON.stringify(failedList));
                return {
                    ok: false,
                    reason: _lastTeamFailure.reason,
                    started: startedList,
                    reused: reusedList,
                    failed: failedList,
                    currentLane: '',
                    queueEnabled: true,   // 队列面板常开（回滚不关它）
                    session: null,
                    teamState: 'off',
                    rolledBack: true
                };
            }
            // 部分成功：保持开（既有设计：单条 lane 失败不阻断另外两条），状态标记 partial。
            _setTeamState(startOk ? 'on' : 'partial');
            // ── 团队档内不再存在单 Agent runtime ────────────────
            // ok/partial 都要销毁：partial 时不销毁会出现「单 Agent 与 lane 并存」——正是本次要
            // 移除的形态（主通道）。全失败/早退在上面已 return，那时 single 还在（回滚天然有可用
            // runtime）。销毁必须在 _syncSlots 之前：之后单例槽只能指向 lane。
            _disposeSingleRuntime();
            // goal 三工具的 last-wins 抢回归属：团队档里只有导演该有目标，而刚才三条 lane 的
            // controller 依次注册会把 handler 盖成最后一条（glsl）那一份。让导演再注册一次，
            // 保证共享注册表里的 handler 是导演的门面（单 Agent 主通道已移除）。
            _reclaimGoalTools('director');
            // start(sid) 内部调的是 orchestrator 自己的 bindSession（**不经**被包过的公开方法），
            // 故「启动即绑定」这条路径要在这里补一次工作区预建——但 binder 的 onBoundChange 现在
            // 也会预建，镜像已跟上就不重复建（同 _wrapTeamSessionEntry 的去重口径）。
            if (typeof teamSessionIdArg === 'string' && teamSessionIdArg && _teamSessionId !== teamSessionIdArg) {
                _teamSessionId = teamSessionIdArg;
                _ensureTeamWorkspace(teamSessionIdArg);
            }
            _syncSlots();
            if (res && typeof res === 'object') {
                res.teamState = _teamState;
                res.rolledBack = false;
            }
            if (!startOk) {
                console.warn('[Agent] 团队模式部分启动失败（未装配：' + failedList.join('/')
                    + '），其余 lane 继续：' + JSON.stringify(_lastTeamFailure));
            }
            return res;
        }

        // ── 单 Agent runtime 的拆除 / 重建 ──────────────────────
        // 团队档内不再保留单 Agent runtime（主通道移除），但**挂载顺序**仍是先建 single 再
        // _applyTeamMode（保住 state.restoring 与回滚可用）⇒ 「拆除」「重建」必须是两个可复用动作。
        function _disposeSingleRuntime() {
            var rt = _singleRuntime;
            if (!rt) return null;
            _singleRuntime = null;   // 先摘槽：销毁期任何 _currentRuntime() 都读不到它
            var ctl = rt.controller;
            if (ctl) {
                try { if (typeof ctl.requestStop === 'function') ctl.requestStop(); } catch (_) { /* 已停/无轮次 */ }
                // 末轮 token 统计的 1s 防抖必须在销毁前落盘：不 flush 时进团队后
                // 那条 runtime 的 flushTokenStats 再也没人调，下一次读统计（restoreTokenStats）
                // 会用磁盘旧记录整表覆盖 ⇒ 进团队前一轮的用量丢失。
                try { if (typeof ctl.flushTokenStats === 'function') ctl.flushTokenStats(); } catch (_) { /* 统计落盘失败不阻断销毁 */ }
                try { if (typeof ctl.clearInjectQueue === 'function') ctl.clearInjectQueue(); } catch (_) { /* 队列缺席 */ }
            }
            var st = rt.state;
            if (st) { st.busy = false; st.restoring = false; st.busyText = ''; }
            // 视图拆除（view.destroy）：解绑 scroll / 媒体事件 / ResizeObserver / 挂载窗口 /
            // 消息动作 / token 浮层。**不销毁** index.html 的静态共享元素（模块 unmount 规则），
            // 只摘事件与观察者——否则重建 view 时 _bindMountWindow 的 __mountObs 守卫会让新
            // view 静默失效（风险 12/14）。
            try { if (rt.view && typeof rt.view.destroy === 'function') rt.view.destroy(); } catch (_) { /* 旧包无 destroy：事件泄漏但功能可用 */ }
            rt.controller = null;
            return rt;
        }

        // 临时 runtime 的销毁（switchGlobalMode 失败分支）：它从未进单例槽，不能走
        // _disposeSingleRuntime（那会把 _singleRuntime 置 null；团队还开着时虽无影响，但语义是
        // 「销毁当前单 Agent runtime」，不是「销毁一个临时对象」）。
        function _disposeTempRuntime(rt) {
            if (!rt) return null;
            var ctl = rt.controller;
            if (ctl) {
                try { if (typeof ctl.requestStop === 'function') ctl.requestStop(); } catch (_) { /* 无轮次 */ }
                try { if (typeof ctl.clearInjectQueue === 'function') ctl.clearInjectQueue(); } catch (_) { /* 队列缺席 */ }
            }
            if (rt.state) { rt.state.busy = false; rt.state.restoring = false; }
            try { if (rt.view && typeof rt.view.destroy === 'function') rt.view.destroy(); } catch (_) { /* 旧包无 destroy */ }
            rt.controller = null;
            return rt;
        }

        // 建房但不加载会话（同步段）：single 已存在时**复用**——switchGlobalMode 的临时 runtime
        // 成功接管后由 _disableTeam 走这条分支（须接受 single 已存在的复用分支），
        // 避免二次拆卸/二次创建。
        function _mountSingleRuntime() {
            if (_singleRuntime) return _singleRuntime;
            _singleRuntime = createLaneRuntime(_singleLaneDef());
            return _singleRuntime;
        }

        // 单 Agent 三档的会话 store（与挂载恢复链 / _restoreSingleSession 同一映射）。
        function _singleSessionStoreForMode(mode) {
            if (mode === 'shader') return _shaderSessionStore;
            if (mode === 'agent') return _agentSessionStore;
            return _scriptSessionStore;   // script 正常；external 兜底（无会话域，见挂载恢复链注释）
        }

        // 恢复单 Agent 的 lastActive 会话（退出团队第 2 步）。placeholder = 置
        // `state.restoring` 占位（防消息写进 default 孤儿会话）：退出团队必须置；switchGlobalMode
        // 的临时 runtime **不置**（团队 lanes 正在跑，不该被一条隐藏 runtime 的恢复挡住）。
        var _singleRestoreToken = 0;
        function _restoreSingleSession(rt, opts) {
            var o = opts || {};
            var ctl = rt && rt.controller;
            if (!ctl || typeof ctl.switchSession !== 'function' || typeof ctl.createSession !== 'function') {
                return Promise.resolve({ ok: false, reason: 'no_controller' });
            }
            var token = ++_singleRestoreToken;
            var mode = _effMode(getSettings() || {});
            var store = _singleSessionStoreForMode(mode);
            var lastId = '';
            try {
                lastId = (store && typeof store.getLastActiveId === 'function') ? (store.getLastActiveId() || '') : '';
            } catch (_) { lastId = ''; }
            if (o.placeholder) _setRestoringAll(true);
            var whenIdle = function () { return Promise.resolve(); };
            if (global.AEAgentApp && typeof global.AEAgentApp.whenEnterAnimIdle === 'function') {
                whenIdle = function () {
                    return new Promise(function (resolve) { global.AEAgentApp.whenEnterAnimIdle(resolve); });
                };
            }
            return whenIdle().then(function () {
                if (token !== _singleRestoreToken) return { ok: false, reason: 'superseded' };
                return lastId ? ctl.switchSession(lastId) : ctl.createSession();
            }).then(function (result) {
                if (token !== _singleRestoreToken) return result;
                if (result && result.ok === false) {
                    // 目标会话已是当前会话：恢复目标已达成，不当失败处理
                    if (result.reason === 'same') return result;
                    // read_failed 兜底与挂载恢复链同源：原会话文件已受保护（零写盘），
                    // 切入索引内新会话；其他失败原因照常抛（由下方 catch 如实告警）。
                    if (result.reason === 'read_failed') {
                        return ctl.createSession().then(function (r) {
                            if (!r || !r.ok) {
                                throw new Error('Session restore failed: read_failed (fallback createSession failed: '
                                    + ((r && r.reason) || 'unknown') + ')');
                            }
                            showStatus(AEI18n.t('上次会话读取失败，已保留原文件并切换到新会话'), 'error');
                            return r;
                        });
                    }
                    throw new Error('Session restore failed: ' + (result.reason || 'unknown'));
                }
                return result;
            }).catch(function (e) {
                console.error('[Agent] 单 Agent 会话恢复失败:', e);
            }).then(function (out) {
                if (token === _singleRestoreToken && o.placeholder) {
                    _setRestoringAll(false);
                    try {
                        var eng = global.AEEngine;
                        if (eng && typeof eng.refreshSessionSwitcher === 'function') eng.refreshSessionSwitcher();
                    } catch (_) { /* 刷新失败不影响会话已恢复 */ }
                }
                return out;
            });
        }

        function _disableTeam() {
            // 先落 'stopping'（派生布尔同步为 false）：dispose 期间各 lane 收尾的 setBusy 必须被
            // 共用栏闸门挡下（V46④ 的既有语义），dispose 完再落 off。
            // wasTeamOn：只有真的从 on/partial 退出才需要恢复单 Agent 会话；装配期按设置落「关闭」
            // 时（_applyTeamMode）single 刚建好、由挂载恢复链负责，这里不重复恢复。
            // hadSingle：single 已存在 = switchGlobalMode 的临时 runtime 成功接管 ⇒ 复用分支，
            // 不重建也不二次恢复。
            var wasTeamOn = (_teamState === 'on' || _teamState === 'partial');
            var hadSingle = !!_singleRuntime;
            _setTeamState('stopping');
            var res = _orchestrator ? _orchestrator.dispose() : null;
            // 池的清空（子 Agent 名册归零）：dispose 经 stopAll 只把记录标 stopped，记录仍留在池里，
            // 而 list_agents 直接透传 pool.list() ⇒ 重开团队后旧会话的子 Agent 还挂在名册上。
            // clear() 停掉并移除全部记录（在跑的 abort、排队的不残留、挂着的 wait 一并唤醒，stats 归零），
            // 池本身仍可用（面板重挂/重开团队还是这同一个实例，故不叫 dispose）。
            if (_subagentPool && typeof _subagentPool.clear === 'function') {
                try {
                    _subagentPool.clear();
                    _subagentDelivered = {};
                } catch (e) {
                    console.warn('[Agent] 子 Agent 池清理失败（关团队后旧名册可能残留）: ' + ((e && e.message) || e));
                }
            }
            _setTeamState('off');
            // ── 同步段（退出团队第 1 步）────────────────────────────────
            // 先建 runtime（复用分支不重建）→ _syncSlots（单例槽指向 single）→ goal 工具回收 →
            // 清共享状态栏（此时 single view 已存在）→ 通知 UI 显示单 Agent 容器。
            var rt = _mountSingleRuntime();
            _syncSlots();
            // goal 三工具抢回归属：团队关了之后，共享注册表里的 handler 还停在导演那份门面，
            // 让单 Agent runtime 再注册一次，last-wins 落回它自己。
            _reclaimGoalTools('');
            // 清共用状态栏：上面已把 _teamEnabled 置 false，而写闸门判据
            // `_isCurrentLane` 在团队关闭时恒 false ⇒ 各 lane 收尾的 setBusy(false,…) 全被挡下，
            // 栏上会残留「上一条 lane 还在跑」的文案与脉冲（一句假事实，直到单 Agent 通道下次写才自愈）。
            // 这里无条件清干净——单 Agent view 与三条 lane 共用同一批节点，清一次即可。
            try {
                var v = (rt && rt.view) ? rt.view : null;
                if (!v) {
                    var cur = _currentRuntime();
                    v = cur && cur.view;
                }
                if (v && typeof v.clearStatusChrome === 'function') v.clearStatusChrome();
            } catch (_) { /* 清栏失败不该让关团队失败（下次写入会覆盖） */ }
            // 单 Agent 消息区的还原（真机 bug：「从团队切过去 shader / script /
            // Agent 这三个模式，聊天历史记录栏没了，要刷新才有」）。
            // 团队档把 `#aeAgentMessageList` 的父节点 `.ae-agent-message-wrap` 写成 hidden
            //（写点唯一：teamUI.syncLaneVisibility，见其 `if (single) single.hidden = on;`），
            // 而退出团队是**一步式**（旋钮 → switchGlobalMode → 本函数）
            // 之后，这条路径不再经过 teamUI 的 `_setTeamEnabled(false)` 分支——而那个分支里写着
            // 还原步（syncLaneVisibility）⇒ hidden 停在 true，中心列只剩顶栏与输入框；重载面板
            // 之所以「好了」，是因为 hidden 是运行时属性、骨架缺省态本来就是显示。外接档看不出来：
            // `.ext-mode-active .ae-agent-message-wrap` 按设计本来就 display:none。
            // 真机取证（部署包与工作区 SHA256 一致）：team→script/agent/shader 三步 wrapHidden 恒 true、
            // 手动调一次 syncLaneVisibility 立刻 display=block / 列表高 260px。
            // 本函数是引擎侧**所有**关团队路径的唯一收尾（旋钮一步式 / 设置段开关 / 装配期按设置落态），
            // 故还原步挂在这里才与上面的「lane 容器隐藏（dispose→hideContainers）+ 单例槽 + 状态栏」
            // 同属一套；写点仍唯一（幂等），这里只负责把「团队已关」这件事通知界面。
            // 判空 + 能力探测 + 吞错：UI 未挂载 / 旧混合包 / 同步抛错都不该让关团队失败
            //（与 _syncLaneChrome 的兜错口径一致）。
            try {
                var ui = global.AEAgentTeamUI;
                if (ui && typeof ui.syncLaneVisibility === 'function') ui.syncLaneVisibility();
            } catch (_) { /* 还原失败不该让关团队失败（最坏是重载面板恢复） */ }
            // 团队任务清单解绑：团队关了就没有「共用的那份清单」——解绑后工具读写会显式报
            // no_team_session（而不是继续写上一个团队会话的文件）。磁盘上的清单**不删**：
            // 重新开团队并绑回同一会话时它还在（与工作区同口径）。
            if (_teamTaskList) {
                try { _teamTaskList.reset(); } catch (_) { /* 解绑失败不该让关团队失败 */ }
            }
            // ── 异步段（退出团队第 2 步）────────────────────────────────
            // restoring 占位 + whenEnterAnimIdle + switchSession(lastActiveId)/createSession，
            // 失败经看门狗（_setRestoringAll 的既有上限）兜底；复用分支不重复恢复（见上）。
            if (wasTeamOn && !hadSingle && rt) _restoreSingleSession(rt, { placeholder: true });
            if (res && typeof res === 'object') res.teamState = 'off';
            return res;
        }

        function _applyTeamMode(settings) {
            var s = settings || {};
            // **真相 = runtimeMode**（'team' 即开），`team.enabled` 是 normalize
            // 强制保持的派生镜像，两者恒一致。这里优先读真相；仅当 runtimeMode 缺席（旧包形状
            // /测试桩）时回落镜像访问器。
            // 为什么不能继续以镜像为判据：本函数是装配期与设置变更后的**唯一**开/关落点，
            // 一旦镜像与真相漂移（例如某次部分保存没带上 team 段），团队就会按一个陈旧字段
            // 开着或关着，而面板其余部分全按 runtimeMode 走 —— 又回到「两个真相」的老病。
            var on;
            if (typeof s.runtimeMode === 'string') {
                on = (s.runtimeMode === 'team');
            } else {
                var teamSettings = (global.AEAgentTeam && global.AEAgentTeam.settings) ? global.AEAgentTeam.settings : null;
                on = !!(teamSettings && typeof teamSettings.isEnabled === 'function' && teamSettings.isEnabled(s));
            }
            if (on) return _enableTeam(_teamSessionId);
            return _disableTeam();
        }

        // 团队开关落点（设置页/顶栏开关调它）：开 → orchestrator.start(团队会话 id)；
        // 关 → orchestrator.dispose()（全停 + 关 AE 串行队列 + 隐藏三条 lane 容器）。
        window.AEEngine.setTeamMode = function (enabled, teamSessionIdArg) {
            if (typeof teamSessionIdArg === 'string' && teamSessionIdArg) _teamSessionId = teamSessionIdArg;
            if (!enabled) return _disableTeam();
            var res = _enableTeam(_teamSessionId);
            // 开团队即成团队会话：没有它，团队域工具从第一轮起就
            // 报 no_team_session / not_team（见 _ensureTeamSessionBound 头注）。全失败已回滚
            // 与 partial（缺 lane controller 时 binder 必然 no_controller，只会多一条噪音告警）
            // 都不调度；启动期（`_applyTeamMode` 走同名函数但不经本出口）由恢复链链尾兜底。
            if (res && res.rolledBack !== true && res.teamState === 'on') _scheduleTeamSessionEnsure('enable');
            return res;
        };
        // 团队态的**唯一只读出口**：UI 判据、诊断、单测都读这一份。
        // 为什么不让 UI 继续用 `getCurrentLaneId()` 判「团队开着」：那个判据只说明「有当前 lane」，
        // 对「全失败已回滚」「部分装配失败（partial）」都给不出答案（真机形态：UI 切成团队布局而
        // 引擎已回滚单 Agent）。state 是唯一真相，enabled 只是它的派生布尔。
        window.AEEngine.getTeamState = function () { return _teamStateView(); };
        // 团队会话**绑定一致性**的只读出口：三条 lane 是否真的在同一条团队会话上。
        // 为什么需要：整队切换是手工两阶段（预检 → 停 → 逐条 adopt → 失败回滚），失败时允许分叉，
        // 而分叉在数据层的表现很隐蔽（某条 lane 的历史不对 / 工作区为空 / 任务清单串味）。
        // 诊断与 UI 读这一份可复核快照，不各自猜。同步、永不抛；binder 未装配时 wired:false。
        window.AEEngine.getTeamSessionState = function () {
            if (!_sessionBinder || typeof _sessionBinder.getBindingState !== 'function') {
                return { wired: false, sid: null, consistent: false, divergent: [], lanes: {} };
            }
            var st;
            try { st = _sessionBinder.getBindingState(); } catch (e) {
                return {
                    wired: true, sid: null, consistent: false, divergent: [], lanes: {},
                    error: String((e && e.message) || e)
                };
            }
            st.wired = true;
            return st;
        };
        // 当前 lane 的 view：与 AEEngine.view 读访问器同源，团队关闭时两者都是唯一
        // 那条 view。reflect 钩子按它把三条 view 逐个挂上。
        window.AEEngine.getView = function () {
            var rt = _currentRuntime();
            return (rt && rt.view) ? rt.view : null;
        };
        // 当前 lane id（团队模式）；单 Agent 路径为 ''。后台结果回流的调用方（comfyui /
        // mcp-manager）据此在发起调用的同一刻快照 lane，与 getSessionId 同源同时刻。
        window.AEEngine.getCurrentLaneId = function () { return _currentLaneId(); };
        // 切当前 lane（lane 切换条调它）：真相源在 orchestrator
        // （`setCurrentLane` 内部改 currentLane 再通知 onCurrentLaneChange → _syncSlots 搬单例槽）。
        // 团队关闭 / 未装配时如实返回 not_team，不静默成功、不自己造一份「当前 lane」缓存
        //（缓存必然与引擎漂移：别处切了 lane，UI 还高亮旧的）。返回体透传 orchestrator 的
        // { ok, lane, previous, changed } / { ok:false, reason:'bad_lane'|'unknown_lane' }。
        window.AEEngine.setCurrentLane = function (id) {
            if (!_teamEnabled || !_orchestrator) return { ok: false, reason: 'not_team' };
            return _orchestrator.setCurrentLane(id);
        };
        // 团队会话 binder 出口：binder 与 lane store 都住在 bootstrap 闭包里，
        // sessionSwitcher 的团队通道按 `opts.getBinder()` → `AEAgentTeam.sessionBinder` →
        // `getSessionBinder()` → `AEEngine.getSessionBinder()` 的解析顺序取；缺这个出口时
        // 真机团队会话菜单会退化成「空列表 + 通道未装配」，不误走单 Agent 路径但功能不可用。
        // 团队未装配时返回 null（调用方据 null 如实报 not_wired，不假装切过了）。
        window.AEEngine.getSessionBinder = function () { return _sessionBinder; };
        // 团队任务清单出口：三条 lane **共用**的那一份清单
        //（「团队任务清单」段读它）。未装配时为 null——调用方据 null 如实显示空态，
        // 不假装有一份空清单（「没装」与「装了但为空」是两件事）。
        window.AEEngine.getTeamTaskList = function () { return _teamTaskList; };
        // 团队工作区出口：左抽屉的「工作区文件」段读计划书 / 文字分镜用。
        // 只暴露 workspace 实例，路径安全/数据目录/会话 id 全部走它自己的 read/root（唯一真相源），
        // UI 不自己拼 `<数据Dir>/agent/team/<sid>/`——那会是第二份路径实现。
        // 未装配时为 null（团队未开启 / 引擎未挂载）：调用方如实显示「工作区未装配」，不猜路径。
        window.AEEngine.getTeamWorkspace = function () { return _teamWorkspace; };

        // 子 Agent 会话出口（团队面板的子 Agent 行要能点进去看它的会话）。
        // 数据源：池的行（状态/标题/结论/轮次）+ **运行器实例**的 cm（对话本体）。
        // 运行器只在 running/waiting 期间保留（终态即回收，见 _pruneSubagentRuntimes）⇒ 已回收的
        // 子 Agent 返回 `recycled:true` 并带上池里最后那行（结论摘要仍可读），不假装有对话。
        window.AEEngine.getSubagentSession = function (id) {
            var sid = (typeof id === 'string' && id) ? id : '';
            if (!sid) return { ok: false, reason: 'bad_id' };
            var rows = (_subagentPool && typeof _subagentPool.list === 'function') ? _subagentPool.list() : [];
            var row = null;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].id === sid) { row = rows[i]; break; }
            }
            var rt = _subagentRuntimes[sid] || null;
            if (!row && !rt) return { ok: false, reason: 'unknown_id', id: sid };
            // 会话本体：运行器记录本身不带 cm（装配惰性），从 getBuilt() 取那一份
            // ——只认 rt.cm 永远拿不到消息（真机实测：子 Agent 跑了 2 轮、弹窗还是空的）。
            var builtRef = (rt && typeof rt.getBuilt === 'function') ? rt.getBuilt() : null;
            var cmRef = (rt && rt.cm) ? rt.cm : ((builtRef && builtRef.cm) ? builtRef.cm : null);
            var raw = (cmRef && typeof cmRef.list === 'function') ? (cmRef.list() || []) : [];
            var msgs = [];
            for (var m = 0; m < raw.length; m++) {
                var msg = raw[m] || {};
                var text = (typeof msg.text === 'string' && msg.text) ? msg.text
                    : ((typeof msg.visibleText === 'string') ? msg.visibleText : '');
                if (!text && !msg.title) continue;
                msgs.push({
                    role: String(msg.role || ''),
                    title: (typeof msg.title === 'string') ? msg.title : '',
                    text: text,
                    tool: (typeof msg.toolName === 'string') ? msg.toolName : ''
                });
            }
            return {
                ok: true,
                id: sid,
                title: (row && row.title) || (rt && rt.def && rt.def.title) || sid,
                state: (row && row.state) || (rt && rt.state && rt.state.mode ? '' : '') || '',
                parentLane: (row && row.parentLane) || '',
                elapsedMs: (row && typeof row.elapsedMs === 'number') ? row.elapsedMs : 0,
                tokens: (row && row.tokens) || null,
                turns: (row && typeof row.turns === 'number') ? row.turns : 0,
                summary: (row && typeof row.summary === 'string') ? row.summary : '',
                // 失败原因（池行的 error）：会话出口也读得到，面板/调试不必再靠摘要猜。
                error: (row && row.error) ? row.error : null,
                recycled: !rt,
                messages: msgs
            };
        };

        // 子 Agent 追问出口：团队面板「子 Agent 会话」里的输入框走它。
        // 与 send_message 的子 Agent 分支**同一条链**（池的 ask：保活窗口内复用同一个 cm/state/controller 再跑一轮），
        // 故追问后运行器的 cm 会带上新的一轮，重新 getSubagentSession 就能看到。
        window.AEEngine.askSubagent = function (id, text) {
            var sid = (typeof id === 'string' && id) ? id : '';
            var msg = (typeof text === 'string') ? text.replace(/^\s+|\s+$/g, '') : '';
            if (!sid || !msg) return Promise.resolve({ ok: false, reason: 'bad_args' });
            if (!_subagentPool || typeof _subagentPool.ask !== 'function') {
                return Promise.resolve({ ok: false, reason: 'not_wired' });
            }
            var p = null;
            try {
                // 来源 = user：这条追问是**用户在面板弹窗里直接发的**，不是上级 Agent 的 send_message。
                // 运行器据此在子 Agent 对话里写明来源；回投侧据此**不把这一轮结论投给父 Agent**。
                p = _subagentPool.ask(sid, msg, { origin: 'user' });
            } catch (e) {
                return Promise.resolve({ ok: false, reason: 'error', detail: String((e && e.message) || e) });
            }
            return Promise.resolve(p).then(function (r) {
                return (r && typeof r === 'object') ? r : { ok: false, reason: 'no_result' };
            }, function (e) {
                return { ok: false, reason: 'error', detail: String((e && e.message) || e) };
            });
        };
        // 三条 lane 的 store 出口：给 sessionSwitcher 的团队列表取
        // 「三条 lane 索引按 id 去重合并」用。返回**登记序**数组（与 _allSessionStores 的
        // lane 段同序）；未装配时为 []（不是 null——调用方直接遍历，少一次判空分叉）。
        window.AEEngine.getLaneStores = function () {
            return _laneStoreIds.map(function (id) { return _laneSessionStores[id]; });
        };

        // 团队装配面（工作区 / team 域工具 / 会话 binder）先于 orchestrator：binder 是它的
        // sessions 注入项，创建时就取；工具在装配期注册（见 _initTeamAssembly 注释）。
        // 团队关闭时这里同样跑一次：它不创建 orchestrator、不下发任何队列开关，单 Agent 路径
        // 的唯一差别是注册表里多了一件 scope 只有 'team' 的只读工具（三档身份都取不到它）。
        // 子 Agent 运行器也在这一步接线：归一值**取一次**（池与运行器共用同一份，
        // 不许两处各取——两处各取就是两个上限）；运行器实现**晚绑定**到本次挂载的闭包（池是模块级
        // 单例，面板重挂后必须解析到新闭包，否则子 Agent 会用上一代的工作区/设置跑）。
        _subagentLimits = _subagentGate(getSettings);
        _subagentRunTurnImpl = _subagentRunTurnForMount;
        _initTeamAssembly();

        // 单 Agent 路径先装配：团队关闭时它就是当前 lane（= 改动前唯一那条 runtime）
        _singleRuntime = createLaneRuntime(_singleLaneDef());
        _syncSlots();
        // 启用点：装配完成即按设置落一次（团队关闭 ⇒ 不创建 orchestrator，一次 enable 都不下发）
        _applyTeamMode(getSettings());

        // 公共访问门面：外部统一经 getController()，取代 _controller 私有直读。
        // 团队模式下返回**当前 lane** 的 controller（单例槽 _syncSlots 的指向）。
        window.AEEngine.getController = function () { return controller; };
        // `AEEngine.getMainRuntime` 随团队主通道移除——团队档内
        // 没有单 Agent runtime，不再提供这个读口；它的两个消费方（teamUI.anyLaneLocked /
        // _stopAllDisabled 的「主 Agent 在途」腿）已同步删除。
        // **全局**运行模式切换出口（修真机 bug「团队开着 + 非 Agent 模式时
        // 点旋钮切不回 Agent」）：
        // 为什么不能再用 getController()：团队模式下它是**当前 lane** 的 controller，而 lane 的
        // `getSettings().runtimeMode` 被 `_laneGetSettings` 钉死为该 lane 的 slot（director /
        // ae-exec = agent、glsl = shader）⇒ `switchMode('agent')` 在 director/ae-exec 上判 same、
        // 什么都不做（真机实测：lane=director 点 agent 象限无反应，换 lane=glsl 同一次点击即成功）。
        // 旋钮要切的是**全局模式**，故本出口固定用单 Agent 那条 runtime 的 controller（它的
        // getSettings 是全局设置，不受 lane slot 影响）。
        // 团队档内没有常驻单 Agent runtime ⇒ 本出口走**临时 runtime**：
        //   ① 建临时 single（不接管单例槽、不显示）并恢复 baseMode 会话；
        //   ② 调它的 controller.switchMode(target)（写设置 + 模式钩子 + 会话切换）；
        //   ③ 成功 ⇒ 临时 runtime 接管为 _singleRuntime 并调 _disableTeam()（复用分支，只 dispose
        //      lane 与 UI 收尾，不重建、不二次恢复）；
        //   ④ 失败 ⇒ 销毁临时 runtime、团队保持开着（switchMode 自行回滚设置）。
        // 不再有「先退团队再切档」的中间态 ⇒ 不会二次拆卸、也不会出现半不半的档位。
        window.AEEngine.switchGlobalMode = function (mode) {
            if (_teamEnabled && _orchestrator) {
                var temp = createLaneRuntime(_singleLaneDef());
                var tc = temp && temp.controller;
                if (!tc || typeof tc.switchMode !== 'function') {
                    _disposeTempRuntime(temp);
                    return Promise.resolve({ ok: false, reason: 'not_wired' });
                }
                return _restoreSingleSession(temp, { placeholder: false }).then(function () {
                    return tc.switchMode(mode);
                }).then(function (res) {
                    if (!res || res.ok !== true) {
                        // 失败：临时 runtime 是独立对象（从未进单例槽），直接销毁；团队保持开着。
                        _disposeTempRuntime(temp);
                        return res || { ok: false, reason: 'error' };
                    }
                    // 成功：接管为单 Agent runtime，再由 _disableTeam 走「single 已存在」复用分支
                    //（只 dispose lane + UI 收尾，不重建、不重复恢复 baseMode 会话）。
                    _singleRuntime = temp;
                    try { _disableTeam(); } catch (_) { /* 收尾失败不该把一次成功的切档变成失败 */ }
                    try { _syncSlots(); } catch (_) { /* UI 同步失败不影响切档结果 */ }
                    return res;
                }, function (e) {
                    _disposeTempRuntime(temp);
                    return { ok: false, reason: 'error', message: String((e && e.message) || e) };
                });
            }
            // 团队关闭：单 Agent runtime 就是唯一那条 runtime ⇒ 旧行为逐字不变。
            var rt = _singleRuntime;
            var c = (rt && rt.controller) ? rt.controller : null;
            if (!c || typeof c.switchMode !== 'function') {
                // 装配缺席：显式失败（与其它宿主出口同口径，不假装切过了）
                return Promise.resolve({ ok: false, reason: 'not_wired' });
            }
            var p = c.switchMode(mode);
            if (!p || typeof p.then !== 'function') return p;
            return p.then(function (res) {
                // 切档成功：当前 runtime 的活动 cm 已换（三档各自的会话域）⇒ 重走一次单例槽同步，
                // 让依赖「当前 controller/state」的模块级 UI（用量条 / 发送按钮 / 待发送 chips）
                // 立刻按新档重绘。缺这一步，独立档之间切换后用量条仍显示上一个档的数值
                //（「切过去还是旧的」属同族）。
                if (res && res.ok) {
                    try { _syncSlots(); } catch (_) { /* UI 同步失败不影响切档结果 */ }
                }
                return res;
            });
        };
        // 编排面访问器（团队 UI 用它取当前 lane 切换 / 任务板快照 / 单停与全停）。
        // 返回值语义（「团队关闭 / 未装配时为 null」与实现不符）：
        //   · **未装配**（从未开启过团队）⇒ null，调用方据 null 走单 Agent 分支，不猜空壳对象；
        //   · **开启后再关闭** ⇒ 仍是那个已 `dispose()` 的编排面引用——`_disableTeam()` 只 dispose
        //     不置 null（装配期单例，与 V40① 对 binder 的处置同款）。所以「团队是否关着」的判据是
        //     **行为面**（`isTeamModeOn()===false` / `getCurrentLaneId()===''` / `setCurrentLane`
        //     返回 `not_team`），**不是**拿本访问器判 null。
        window.AEEngine.getOrchestrator = function () { return _orchestrator; };

        // 团队 lane 的模型/平台选择：顶栏「当前模型」与诊断读它。解析实现
        // 只有模块级 resolveLaneModelSelection 一份，本函数只补「读当前 team 设置 + 全局缓存」。
        window.AEEngine.getLaneModelSelection = function (laneId) {
            if (!laneId) return null;
            try { return _resolveLaneSelection(laneId); } catch (_) { return null; }
        };
        // 设置保存后即时生效：按新配置重同步三条 lane 的上下文窗口，并通知顶栏重绘
        //（不必等下一轮请求或重开面板；返回 true 只表示"刷新动作已执行"）。
        window.AEEngine.refreshLaneModelConfig = function () {
            try { _applyModelWindowToAll(); } catch (_) { /* 窗口同步失败不影响设置已保存 */ }
            _notifyLaneModelChanged();
            return true;
        };

        // shaderContract 数据访问器（prompts.js 经此读取 GLSL 契约）
        window.AEEngine.getShaderContract = function () { return _shaderContractState; };
        window.AEEngine.setShaderContract = function (v) { _shaderContractState = v; };

// 初始化默认模型/平台缓存：启动时读取全局设置，并监听「模型管理」面板的变更事件保持同步。
        // 模型选择已迁移到模型管理，getModel/getPlatform 全部走此缓存，不再依赖废弃 DOM。
        _withDefaultCache();
        if (typeof window.addEventListener === 'function') {
            window.addEventListener('ae:default-llm-changed', function (e) {
                var d = e && e.detail;
                if (d) _refreshDefaultCache({ defaultProviderId: d.providerId, defaultModelId: d.modelId });
                else _withDefaultCache();
            });
        }

        // ── temp/agent 全局清理（mark-and-sweep）──
        // temp/agent 下的 chat_img_*.png 是用户上传图片缓存，被会话历史消息的 images 引用。
        // 仅"清空会话"会删本会话引用文件；此处周期 + 启动时兜底清理：
        // 收集所有会话（agent/script/shader 三 store）引用的 chat_img_ 文件名，
        // 删除「未被任何会话引用 且 mtime 超 24h」的孤儿缓存，防异常残留无限累积。
        // 保留集必须补扫归档（<id>.archive.json）——上下文压缩/裁剪丢弃的旧消息
        // 副本（apiActions compressContext 写入）仍被 read_early_history 以图片路径喂给 LLM，
        // 只扫主消息文件会把归档里仍在用的图当孤儿清掉（7 天后死链、面板内不可恢复）。
        // 归档读取走 sessionStore 既有 loadArchive 入口（上限 500 条/会话）。
        // fail-closed——任一会话/归档读取失败（load/loadArchive 抛错或返回
        // __readFailed 哨兵）即整轮返回 null（引用集不完整），两个消费方在 null 时
        // 放弃删除；任一失败若被折叠成「该会话零引用」，清扫就会删掉仍被引用的附件。
        // 索引读失败保护态（store.isIndexReadFailed()）同样整轮 fail-closed
        // ——哨兵态 listSessions() 为空，枚举不到会话等于把旧会话引用全判成孤儿。
        function _collectChatImgRefs(stores) {
            var allStores = Array.isArray(stores) ? stores : [stores];
            return Promise.all(allStores.map(function (s) {
                return (s && typeof s.whenReady === 'function') ? s.whenReady().catch(function () {}) : Promise.resolve();
            })).then(function () {
                var refs = {};
                var readFailed = false;
                // 单条消息 → 引用文件名。附件路径数组字段按持久化口径取全：user 消息
                // images；system-result 卡 visibleImages/detailImages（context.js 落库形态）。
                // dataURL 内嵌图不落盘缓存，不参与引用。
                function addMsgRefs(m) {
                    if (!m) return;
                    var fields = [m.images, m.visibleImages, m.detailImages];
                    for (var f = 0; f < fields.length; f++) {
                        var arr = fields[f];
                        if (!Array.isArray(arr)) continue;
                        for (var j = 0; j < arr.length; j++) {
                            var p = arr[j];
                            if (typeof p === 'string' && p.indexOf('data:') !== 0 && p.indexOf('chat_img_') >= 0) {
                                refs[p.replace(/\\/g, '/').split('/').pop()] = true;
                            }
                        }
                    }
                }
                var tasks = [];
                allStores.forEach(function (store) {
                    if (!store || typeof store.listSessions !== 'function' || typeof store.load !== 'function') return;
                    // 索引读失败保护态下 listSessions() 返回空表，枚举不到任何
                    // 会话（零 task）→ 引用集空 → 清扫会删掉仍被旧会话引用的图。先查 store
                    // 暴露的索引哨兵标志，为真即整轮 fail-closed（readFailed → 返回 null，
                    // 消费方放弃删除）。
                    if (typeof store.isIndexReadFailed === 'function' && store.isIndexReadFailed()) {
                        readFailed = true;
                        return;
                    }
                    var sessions = [];
                    try { sessions = store.listSessions() || []; } catch (_) { return; }
                    sessions.forEach(function (s) {
                        if (!s || !s.id) return;
                        tasks.push(
                            store.load(s.id).then(function (msgs) {
                                if (msgs && msgs.__readFailed) { readFailed = true; return; }
                                if (!Array.isArray(msgs)) return;
                                for (var i = 0; i < msgs.length; i++) addMsgRefs(msgs[i]);
                            }).catch(function () { readFailed = true; })
                        );
                        // 归档同扫：每会话多一次归档文件读（无档时读空即返 null）。
                        // 本函数只在 dryRun 探出超龄候选后才被调用（见 _cleanAgentTemp），
                        // 30 分钟周期的常态轮次不触发，遍历成本不升量级。
                        if (typeof store.loadArchive === 'function') {
                            tasks.push(
                                store.loadArchive(s.id).then(function (archived) {
                                    if (archived && archived.__readFailed) { readFailed = true; return; }
                                    if (!Array.isArray(archived)) return;
                                    for (var i = 0; i < archived.length; i++) addMsgRefs(archived[i]);
                                }).catch(function () { readFailed = true; })
                            );
                        }
                    });
                });
                return Promise.all(tasks).then(function () { return readFailed ? null : refs; });
            });
        }

        async function _cleanAgentTemp() {
            try {
                var dataDir = '';
                try {
                    dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir : '';
                } catch (_) {}
                if (!dataDir) return;
                if (!global.AETempSweep || typeof global.AETempSweep.sweep !== 'function') return;
                var base = dataDir.replace(/\\+$/, '');
                // 新目录 temp/agent + 旧目录 agent/temp（历史遗留，仅清不写）一并兜底清理
                var dirs = [
                    base + '\\temp\\agent',
                    base + '\\agent\\temp'
                ];
                // 四个缓存目标统一 7 天（原 24h），阈值唯一来源在清扫器
                var AGE = global.AETempSweep.MIN_AGE_MS;
                var reportPath = base + '\\temp\\_sweep_agent.json';
                // 第一遍 dryRun：只出计划不删。「无超期候选」就直接返回，不触发
                // 全量会话遍历（本函数每 30 分钟一次，读所有会话文件的成本必须避免）。
                // 自己判 mtime（AEFS.stat）会漏掉零引用孤儿，
                // 且全程吞异常无从定位 → 现统一走 AETempSweep（年龄取文件名内嵌时间戳，
                // 不依赖 stat），两遍都落覆盖式报告，下次"没生效"先读报告。
                var dry = await global.AETempSweep.sweep({
                    dirs: dirs, match: /^chat_img_/i, maxAgeMs: AGE,
                    dryRun: true, reportPath: reportPath
                });
                var candidates = 0;
                for (var i = 0; i < dry.dirs.length; i++) candidates += (dry.dirs[i].candidates || 0);
                if (candidates === 0) return;
                // 存在超期候选才收集所有会话引用，删除未被引用的孤儿。
                // 引用集必须覆盖**全部六条 store**（含三条 lane）：漏一条 lane，那条 lane 会话里
                // 仍在用的附件就会被当孤儿清掉（7 天后死链，面板内不可恢复）。
                var refs = await _collectChatImgRefs(_allSessionStores());
                // 引用收集失败（任一会话/归档读不出）→ 放弃删除，等下轮重试
                //（按不完整引用集清扫会误删仍被引用的附件）
                if (!refs) {
                    console.warn('[Agent] chat_img 引用收集失败（会话/归档读取异常），本轮跳过清扫（不删除任何文件）');
                    return;
                }
                await global.AETempSweep.sweep({
                    dirs: dirs, match: /^chat_img_/i, maxAgeMs: AGE, refs: refs,
                    reportPath: reportPath
                });
            } catch (_) {}
        }

        // MCP 服务器产物目录清单：<数据目录>/temp/mcp/<serverId>（每个服务器一个子目录）。
        // 面板只清不建——目录由服务器按自己的 --output-dir 自建（mcp_servers 工具描述要求
        // 输出目录指到 temp\mcp\<serverId>）。listDirs 拿不到（没装过会写文件的 MCP／目录
        // 未建／通道失败）一律按空清单跳过：不清、不报错。
        async function _mcpOutputDirs(base) {
            try {
                if (typeof AEFS === 'undefined' || typeof AEFS.listDirs !== 'function') return [];
                var names = await AEFS.listDirs(base + '\\temp\\mcp');
                if (!Array.isArray(names)) return [];
                var out = [];
                for (var i = 0; i < names.length; i++) {
                    if (typeof names[i] === 'string' && names[i]) out.push(base + '\\temp\\mcp\\' + names[i]);
                }
                return out;
            } catch (_) { return []; }
        }

        // MCP 产物清扫：文件名由各服务器自定（playwright 是 page-<ISO 时间戳>.png，没有本仓库
        // 的 `_<毫秒>` 内嵌时间戳惯例），故用通吃正则 + AEFS.stat 取龄。产物是纯缓存（截图/
        // 快照/下载），按龄回收不影响任何引用。
        async function _cleanMcpTemp() {
            try {
                var dataDir = '';
                try {
                    dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir : '';
                } catch (_) {}
                if (!dataDir) return;
                if (!global.AETempSweep || typeof global.AETempSweep.sweep !== 'function') return;
                var base = dataDir.replace(/\\+$/, '');
                var mcpDirs = await _mcpOutputDirs(base);
                if (!mcpDirs.length) return;
                await global.AETempSweep.sweep({
                    dirs: mcpDirs, match: /./, maxAgeMs: global.AETempSweep.MIN_AGE_MS,
                    reportPath: base + '\\temp\\_sweep_mcp.json'
                });
            } catch (_) {}
        }

        // temp 缓存**体积预算**：四个缓存目标合计上限（2GB，非各 2GB）。
        // 与龄清扫的分工：龄清扫按「多久没动」回收，预算按「总共占多少」兜底——7 天阈值遇上
        // 大产物（预览图单张实测可达 84MB）能堆到几个 GB，需要这条兜住。
        // 目标清单由清扫器的 budgetTargets 给（单一真相源，含 ae_preview 的 temp 根回退目录）；
        // 刻意不含 temp 下的 logs/bridge/handoff/bg-overlay——那不是缓存，被预算挤掉等于丢用户数据。
        // 与 _cleanAgentTemp 同款两遍式：先 dryRun 量总量，未超限直接返回（绝大多数轮次走这条，
        // 不触发全量会话遍历）；超了才收集引用，按最旧优先删到阈值下（引用者与无龄者不删）。
        async function _enforceTempBudget() {
            try {
                var dataDir = '';
                try {
                    dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir : '';
                } catch (_) {}
                if (!dataDir) return;
                if (!global.AETempSweep || typeof global.AETempSweep.enforceBudget !== 'function') return;
                var base = dataDir.replace(/\\+$/, '');
                var mcpDirs = await _mcpOutputDirs(base);
                var targets = global.AETempSweep.budgetTargets(base, mcpDirs);
                var maxBytes = global.AETempSweep.DEFAULT_MAX_BYTES;
                var reportPath = base + '\\temp\\_sweep_budget.json';
                var probe = await global.AETempSweep.enforceBudget({
                    targets: targets, maxBytes: maxBytes, dryRun: true, reportPath: reportPath
                });
                if (!probe.over) return;
                // 预算路径的引用集与龄清扫同源：同样必须覆盖六条 store（见 _cleanAgentTemp）
                var refs = await _collectChatImgRefs(_allSessionStores());
                // 引用收集失败 → 放弃预算删除（按不完整引用集会误删仍被引用的附件）
                if (!refs) {
                    console.warn('[Agent] chat_img 引用收集失败（会话/归档读取异常），本轮跳过预算清理（不删除任何文件）');
                    return;
                }
                await global.AETempSweep.enforceBudget({
                    targets: targets, maxBytes: maxBytes, refs: refs, reportPath: reportPath
                });
            } catch (_) {}
        }

        // 视频转码缓存清扫：<数据目录>/temp/transcoded 是 agent 视频预览与素材库转码回退
        // 的共用缓存目录（文件名 tc_<哈希>_w<限宽>.webm，无内嵌时间戳 → 走 AEFS.stat 取龄）。
        // 产物按需重建（删了下次再看同一视频会自动重转），故按统一龄阈值回收；不需要引用检查。
        // 手动清理入口另有素材库的「清缓存」按钮（扫同一目录的 tc_*.webm）。
        async function _cleanTranscodedCache() {
            try {
                var dataDir = '';
                try {
                    dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir : '';
                } catch (_) {}
                if (!dataDir) return;
                if (!global.AETempSweep || typeof global.AETempSweep.sweep !== 'function') return;
                var base = dataDir.replace(/\\+$/, '');
                await global.AETempSweep.sweep({
                    dir: base + '\\temp\\transcoded',
                    // 含失败残留的 <名>.<taskId>.part.webm（bridge 异常退出时留下的半截文件）；
                    // 转码进行中的文件 mtime 新鲜，不会命中龄阈值
                    match: /^tc_.*\.webm$/i,
                    maxAgeMs: global.AETempSweep.MIN_AGE_MS,
                    reportPath: base + '\\temp\\_sweep_transcoded.json'
                });
            } catch (_) {}
        }

        // 启动后立即清一次 + 每 30 分钟兜底清理。
        // 必须**顺序**执行：四趟动的目录三处重叠（chat_img / ae_preview / MCP 产物），并发跑会
        // 两个删除者抢同一文件——后到的 deleteFile 拿不到文件返 false，被记成 failed（报告噪音）；
        // 更要紧的是预算「先量总量再删」，排在龄清扫之后才不会把本该按龄回收的文件算进超限额度、
        // 进而多删年轻文件。
        // 逐趟独立兜底：收成顺序执行后，「一趟卡住/抛错不拖累其余几趟」这个并发时天然成立的
        // 性质要显式补回来（各函数内部虽有 try/catch，但 await 卡住时后几趟就整轮不跑了）。
        async function _runTempHousekeeping() {
            try { await _cleanAgentTemp(); } catch (_) {}
            try { await _cleanTranscodedCache(); } catch (_) {}
            try { await _cleanMcpTemp(); } catch (_) {}
            try { await _enforceTempBudget(); } catch (_) {}
        }
        _runTempHousekeeping();
        setInterval(_runTempHousekeeping, 30 * 60 * 1000);

        // 消息操作（编辑用户消息）的 view 按钮回调已随 view 装配进 createLaneRuntime——
        // 每条 lane 的 view 各自挂一次，回调解到本 lane 的 controller（单 Agent 路径同前）。

        // 聊天区本地路径点击：文件 → 打开所在目录并选中；目录 → 直接打开。
        // 调用出口是 shared/revealPath.js（Bridge 优先，ExtendScript 目录回退），
        // 是否存在由它校验——渲染期不读盘。确认开关见设置「路径打开确认」
        //（confirmPathOpen，默认开；关闭 = 单击直接打开）。
        function _openChatLocalPath(el) {
            var raw = el && el.getAttribute ? (el.getAttribute('data-path') || '') : '';
            if (!raw) return;
            var reveal = (global.AEShared && typeof global.AEShared.revealPath === 'function')
                ? global.AEShared.revealPath : null;
            if (!reveal) {
                showStatus(AEI18n.t('本地路径打开能力未加载（shared/revealPath.js 缺席）'), 'warn', { autoHideMs: 5000 });
                return;
            }
            function doOpen() {
                Promise.resolve(reveal(raw)).then(function (r) {
                    if (r && r.ok) return;
                    var reason = (r && r.reason) || 'failed';
                    var msg;
                    if (reason === 'not_found') msg = AEI18n.t('路径不存在：{path}', { path: (r && r.path) || raw });
                    else if (reason === 'unresolved') msg = AEI18n.t('相对路径无法解析（数据目录不可用）：{path}', { path: raw });
                    else if (reason === 'no_channel') msg = AEI18n.t('无法打开：Bridge 与 AE 均不可用');
                    else msg = AEI18n.t('打开失败：{path}', { path: (r && r.path) || raw });
                    showStatus(msg, 'warn', { autoHideMs: 6000 });
                }).catch(function () {
                    showStatus(AEI18n.t('打开失败：{path}', { path: raw }), 'warn', { autoHideMs: 6000 });
                });
            }
            var needConfirm = true;
            try {
                var s = getSettings() || {};
                needConfirm = s.confirmPathOpen !== false;
            } catch (_) {}
            if (!needConfirm) { doOpen(); return; }
            // 弹窗展示解析后的绝对路径：相对路径（agent\temp\…）用户看不出会打开到哪里
            var shown = raw;
            try {
                if (global.AEShared && typeof global.AEShared.toAbsolutePath === 'function') {
                    var abs = global.AEShared.toAbsolutePath(raw);
                    if (abs) shown = abs;
                }
            } catch (_) {}
            showConfirm(AEI18n.t('打开本地路径'), AEI18n.t('将在文件管理器中打开以下位置：\n\n{path}\n\n是否继续？', { path: shown }))
                .then(function (ok) { if (ok) doOpen(); });
        }

        // 拦截聊天框中的链接点击，防止 CEF 面板内导航导致扩展重启，改用系统浏览器打开。
        // 团队模式：三条 lane 各有消息列表 ⇒ 同一份委托逐个挂上；
        // 单 Agent 路径只有一份，行为不变（缺省 id 列表来自 lanes）。
        var _linkHandler = function (e) {
                // 本地路径（view.js 的 _linkifyLocalPaths 包出的 .ae-agent-path）优先：
                // 它不是 <a>，也不能交给浏览器（CEF 内导航 = 扩展重启）。
                var pathEl = (e.target && e.target.closest) ? e.target.closest('.ae-agent-path') : null;
                if (pathEl) {
                    e.preventDefault();
                    e.stopPropagation();
                    _openChatLocalPath(pathEl);
                    return;
                }
                // 聊天区 markdown 本地图片（localPaths.unmaskImages 还原）：点击开 lightbox。
                // 图片不是 <a>，不拦截则 CEF 会按默认行为处理；在 <a> 内嵌套的图片也先命中这里。
                var mdImg = (e.target && e.target.closest) ? e.target.closest('img.ae-agent-md-img') : null;
                if (mdImg) {
                    e.preventDefault();
                    e.stopPropagation();
                    var _mdImgSrc = mdImg.getAttribute('src');
                    if (_mdImgSrc && global._openImageLightbox) global._openImageLightbox(_mdImgSrc);
                    return;
                }
                var anchor = e.target.closest('a');
                if (!anchor) return;
                var href = anchor.getAttribute('href');
                if (href === null || href === undefined) return;  // 无 href 属性：非导航语义，放行
                // 面板内锚点（#xxx）放行；其余非 http/https 一律拦截——
                // 相对/空 href（如 [说明](readme.md)）直接放行时，CEF 88 面板内
                // 导航即扩展重启（target=_blank 行为不确定，不能依赖默认行为兜底）
                if (href.charAt(0) !== '#' && !/^https?:\/\//i.test(href)) {
                    e.preventDefault();
                    e.stopPropagation();
                    return;
                }
                if (!/^https?:\/\//i.test(href)) return;  // 锚点：放行（无面板内导航风险）
                e.preventDefault();
                e.stopPropagation();
                console.log('[Agent] link click intercepted: ' + href);

                // 打开浏览器的核心逻辑（三级 fallback），抽成函数以便复用
                function openInBrowser(url) {
                    var opened = false;
                    try {
                        if (window.cep && window.cep.util && typeof window.cep.util.openURLInDefaultBrowser === 'function') {
                            window.cep.util.openURLInDefaultBrowser(url);
                            opened = true;
                            console.log('[Agent] cep.util.openURLInDefaultBrowser dispatched');
                        }
                    } catch (e1) { console.error('[Agent] cep.util failed:', e1); }
                    if (!opened) {
                        try {
                            if (typeof CSInterface !== 'undefined' && window.__adobe_cep__) {
                                new CSInterface().openURLInDefaultBrowser(url);
                                opened = true;
                                console.log('[Agent] CSInterface.openURLInDefaultBrowser dispatched');
                            }
                        } catch (e2) { console.error('[Agent] CSInterface failed:', e2); }
                    }
                    if (!opened) {
                        try {
                            var win = window.open(url, '_blank');
                            if (win) opened = true;
                            console.log('[Agent] window.open dispatched');
                        } catch (e3) { console.error('[Agent] window.open failed:', e3); }
                    }
                    if (!opened) {
                        showStatus(AEI18n.t('请手动访问: {url}', { url: url }), 'info', { autoHideMs: 5000 });
                    }
                }

                // 根据设置决定是否弹确认框
                var needConfirm = true;
                try {
                    var s = getSettings() || {};
                    needConfirm = s.confirmExternalLink !== false;
                } catch (_) {}
                if (!needConfirm) {
                    openInBrowser(href);
                    return;
                }
                showConfirm(AEI18n.t('即将打开外部链接'), AEI18n.t('即将使用系统默认浏览器打开以下网址：\n\n{url}\n\n是否继续？', { url: href }))
                    .then(function (ok) {
                        if (!ok) return;
                        openInBrowser(href);
                    });
        };
        // 委托必须挂到**所有实际承载消息的列表**：单 Agent 路径是 #aeAgentMessageList，
        // 团队模式是三条 lane 各自的列表。两个路径的容器在 index.html 里同时静态存在，
        // 而 team/*.js 一律先于 engine/bootstrap.js 装载（见 scripts.manifest.js），
        // 故「AEAgentTeam 是否存在」恒为真、不能当团队开关判据——据此只挂三条
        // lane 列表，单 Agent 路径下 #aeAgentMessageList 没有任何 click 委托，聊天区的
        // 本地路径与外链点击**静默失效**（无弹窗、无日志、无请求）。一律全绑：
        // 事件只在所属列表内冒泡，不会重复触发。
        var _linkListIds = ['aeAgentMessageList'];
        if (global.AEAgentTeam && global.AEAgentTeam.lanes && typeof global.AEAgentTeam.lanes.listMessageIds === 'function') {
            var _laneLinkIds = global.AEAgentTeam.lanes.listMessageIds();
            for (var _laneLinkIdx = 0; _laneLinkIdx < _laneLinkIds.length; _laneLinkIdx++) {
                if (_linkListIds.indexOf(_laneLinkIds[_laneLinkIdx]) < 0) {
                    _linkListIds.push(_laneLinkIds[_laneLinkIdx]);
                }
            }
        }
        var _linkBound = 0;
        for (var _linkIdx = 0; _linkIdx < _linkListIds.length; _linkIdx++) {
            var _linkEl = byId(_linkListIds[_linkIdx]);
            if (_linkEl) {
                on(_linkEl, 'click', _linkHandler);
                _linkBound++;
            }
        }
        console.log('[Agent] link-click delegate: lists=' + _linkBound);

        if (context.promptBuilder) {
            // 仅注入静态 aeInfo。动态信息（模型/时间）由 controller 注入到 user message 前缀，
            // 避免 system prompt 变化导致前缀缓存失效（DeepSeek 前缀缓存逐 token 比对）。
            context.promptBuilder.register(function(prompt, ctx) {
                // 子任务上下文（安全审查 / ComfyUI 画布等）经 ctx.noAeInfo 显式声明不注入：
                // 这行是主对话的环境事实，灌进独立上下文的审查员/画布助手只是无关噪声
                // （审查员的提示词保持干净，画布助手不被 AE 信息影响）。
                if (ctx && ctx.noAeInfo === true) return prompt;
                var aeInfo = '用户使用 After Effects 2023 中文版（图层/合成默认名称为中文，如"合成1""纯色1""空 1"）。';
                return prompt + '\n' + aeInfo;
            }, 10);

            // goal 策略段（priority 40：memory=30 与 lane=45 之间）。
            // 固定文本，不随目标状态变化——保 system prompt 前缀缓存；目标内容由工具与
            // <goal_round> 提示承载。子任务上下文按 prompt-assembly.md 显式声明跳过。
            // 本段点名 create_goal / update_goal，必须随**当前视图可见性**
            // 裁剪——四条 lane 与 Script 档都注入了 getGoal（本段会出现），而 goal 三件只在导演 lane
            // （团队档）/ agent·script·shader 档（单 Agent，含 Script）投放；不裁就会
            // 点名工具面里没有的工具（关闭 create_goal 后提示词不得再点名该工具）。
            // 谓词缺席（audit/画布助手/测试）⇒ 原文逐字，保持默认等价。
            context.promptBuilder.register(function (prompt, ctx) {
                if (!ctx) return prompt;
                if (ctx.noGoal === true || ctx.isSubagent === true) return prompt;
                if (typeof ctx.getGoal !== 'function') return prompt;
                function _goalToolVisible(name) {
                    return (typeof ctx.isToolVisible === 'function')
                        ? (ctx.isToolVisible(name) !== false)
                        : true;
                }
                var canCreate = _goalToolVisible('create_goal');
                var canResume = _goalToolVisible('update_goal');
                // 两件都不可见：目标语义与本视图无关，整段跳过（sleep 句也不灌，避免教不存在的流程）
                if (!canCreate && !canResume) return prompt;
                var lines = [];
                if (canCreate) lines.push('- 用户请求是跨多轮才能完成的目标时，用 create_goal 建目标（用户不必说「目标」二字）；单轮任务不建。');
                if (canResume) {
                    lines.push('- 会话重载后目标会停用续轮：用户说「继续」时用 update_goal action=resume 重新启用。');
                    lines.push('- 只有目标确实达成才 complete；被人或外部条件卡住时用 update_goal action=blocked 写清具体条件。');
                }
                lines.push('- 当前轮只是要等一下就用 sleep 工具；模型不能 pause 或 resume 目标。');
                return prompt + '\n\n## 长期目标\n' + lines.join('\n');
            }, 40);

            // 团队模式：lane 角色段（priority 45）。
            // 团队关闭或本次请求没有 lane 身份时，注入器原样返回 prompt ⇒ 单 Agent 路径零变化。
            if (global.AEAgentTeam && global.AEAgentTeam.settings && typeof global.AEAgentTeam.settings.setProvider === 'function') {
                global.AEAgentTeam.settings.setProvider(function() { return getSettings(); });
            }
            if (global.AEAgentTeam && typeof global.AEAgentTeam.registerPromptInjector === 'function') {
                global.AEAgentTeam.registerPromptInjector(context.promptBuilder, {});
            }
        }

        // AE 上下文自动感知
        var aeContext = ns.createAeContext({
            toolExecutor: tcToolExec
        });
        global.AEEngine.aeContext = aeContext;

        controller.render();
        syncModeButtons(getSettings());
        updateSendButton();
        renderInjectChips();
        initContextRing(showStatus);
        // 调试态取应用层（statusState，来自持久化的全局设置）——不再读勾选框：
        // 勾选框是全局设置弹窗里的表单字段，弹窗没打开时它的 checked 不反映当前调试态。
        controller.setModeByDebug(!!getDebugMode());

        on(byId('clearConversationBtn'), 'click', () => controller.clearConversation());

        // 「当前选择」hover 状态条：悬停时 gather 并弹出 AI 当前感知到的 AE 上下文。
        // gather 每次发消息前自动执行，此处仅在悬停时读取最新快照。
        // 用去抖（避免快速移入移出频繁 gather）+ 延迟关闭（允许鼠标移到浮层上滚动查看）。
        var aeStateEl = byId('aeAgentAeState');
        if (aeStateEl && global.AEEngine && global.AEEngine.aeContext) {
            var _aeCtx = global.AEEngine.aeContext;
            // hover 两路取数（gather 快照 + 项目面板选中）经短 TTL 缓存：反复移入移出
            // 不再每次重跑 AE 查询（大工程里那是数秒级卡顿）。点击建引用用 _aeCtx 现读，不经此缓存。
            // 两路都按**本轮身份**下发：身份在 fetch 里**现取**（fetch 由 get() 同步调起，
            // 与触发它的那次 hover 同一次调用 ⇒ 必是同一份）；缓存键只作标识，'ids|@|laneKey'
            // 保证切模式 / 切 lane 都会换键，不会把上一个身份的「拿得到工具」结果喂给新身份。
            var _hoverGather = createAeHoverGatherCache({
                fetch: function () {
                    var ri = null;
                    try { ri = roundIdentity(); } catch (_) { ri = null; }
                    var ids = (ri && ri.ids && ri.ids.length) ? ri.ids : undefined;
                    var laneKey = ri ? (ri.laneKey || undefined) : undefined;
                    var pItems = (typeof _aeCtx.gatherSelectedItemRefs === 'function')
                        ? _aeCtx.gatherSelectedItemRefs(ids)
                        : Promise.resolve({ status: 'error', refs: [] });
                    return Promise.all([_aeCtx.gather(ids, laneKey), pItems]);
                }
            });
            var _statePop = null;
            var _statePopTimer = null;
            var _stateGatherTimer = null;
            var _stateGen = 0;  // hover 版本号：防旧的异步 gather 结果覆盖新浮层（显示上一次选中信息）
            // 浮层定位：锚点（「当前选择」入口）上方水平居中，不遮挡入口本身
            function _positionPopover(pop, anchor) {
                var r = anchor.getBoundingClientRect();
                var pw = pop.offsetWidth || 320;
                var left = r.left + (r.width - pw) / 2;
                if (left < 8) left = 8;
                if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
                pop.style.left = left + 'px';
                var top = r.top - (pop.offsetHeight || 40) - 6;
                if (top < 8) top = 8;
                pop.style.top = top + 'px';
            }
            function _removeStatePop() {
                if (_statePop) {
                    _statePop.remove();
                    _statePop = null;
                }
            }
            // 「当前选中」入口的模式可见性。**shader 模式隐藏**：该模式没有工程读取工具
            //（queryProject 的 scope 限 agent/script），AE 快照不进当前轮上下文（见 aeContext.gather），
            // 入口留着只会误导——悬停也只会得到"当前轮不注入"。
            // 由 app 层在模式切换处调用（app/main.js refreshList 的 shader 分支，与顶栏按钮
            // 同一处按 isShader 判定；挂载时本函数自己先落一次）。
            var aeStateChip = global.AEEngine.createAeStateChipVisibility({
                el: aeStateEl,
                invalidateInFlight: function () {
                    _stateGen++;
                    clearTimeout(_stateGatherTimer);
                    clearTimeout(_statePopTimer);
                    // 入口隐藏 = 当前轮上下文不可用：hover 缓存一并清掉，重显后必重新取数
                    _hoverGather.clear();
                },
                removePopover: _removeStatePop
            });
            global.AEEngine.setAeStateChipVisible = aeStateChip.setVisible;
            // 挂载时按当前**本轮身份**先落一次（启动即处于 shader 档、或团队档且当前 lane 是
            // glsl 时，不能等 app 层的 refreshList）——判据与切 lane / 模式切换同一条（写点唯一）。
            _aeStateChip = aeStateChip;
            applyAeStateChipVisibility();
            on(aeStateEl, 'mouseenter', function () {
                clearTimeout(_statePopTimer);
                clearTimeout(_stateGatherTimer);
                var gen = ++_stateGen;
                _stateGatherTimer = setTimeout(function () {
                    _removeStatePop();
                    var pop = document.createElement('div');
                    pop.className = 'ae-agent-popover';
                    pop.textContent = AEI18n.t('正在读取 AE 状态…');
                    document.body.appendChild(pop);
                    _positionPopover(pop, aeStateEl);
                    // 鼠标移到浮层上时取消关闭，移出后延迟关闭（浮层内容可滚动查看）
                    // 浮层是每次 hover 新建、300ms 后 remove 的瞬态节点，监听改直接
                    // addEventListener 挂节点（不进 on() 的 listeners 登记簿）——登记簿条目
                    // 对已 detach 的 DOM 子树强引用，每次 hover 泄漏 1 个子树 + 2 个监听器；
                    // 节点 remove 后监听随节点一并回收。
                    pop.addEventListener('mouseenter', function () { clearTimeout(_statePopTimer); });
                    pop.addEventListener('mouseleave', function () { _statePopTimer = setTimeout(_removeStatePop, 300); });
                    _statePop = pop;
                    // 浮层展示"当前轮真的会注入什么"：gather 按当前轮身份（与发消息时同一个来源）
                    // 走作用域校验，故 no-access（当前轮身份拿不到 queryProject，如该工具在该模块
                    // 下被禁用）时不能沿用"无活动合成"的空文案——那句话是假的：工程照常有，
                    // 只是当前轮不注入。
                    // 身份**每次 hover 现取**：团队档取当前 lane 的身份集合 + laneKey，
                    // 单 Agent 档取当前档位映射出的单 id。读 `settings.runtimeMode`（单 Agent
                    // 底层档）——团队档是派生档，底层档还是「切进团队之前那一档」，于是从 shader 档
                    // 切进团队后 director lane 上恒判 shader（真机：浮层恒写「本轮不注入」，即
                    //「当前选中还是切之前的那个模式」）。shader / glsl 档到不了这里：入口整体隐藏。
                    var _ri = null;
                    try { _ri = roundIdentity(); } catch (_) { _ri = null; }
                    var _hoverRoundId = (_ri && _ri.ids && _ri.ids.length) ? _ri.ids.join('|') + '@' + (_ri.laneKey || '') : '';
                    // 并行取两路：快照（浮层正文=当前轮会注入什么）+ 项目面板选中（只用于决定提示行）。
                    // 项目面板选中不进浮层正文——它不是注入内容，进正文就成了"看似会注入"的假信号；
                    // 但「点击引用」现在也覆盖它，提示行必须如实说清（否则用户在项目面板选中后
                    // hover 看不到任何可点击的迹象，点了却能建引用，发现性靠碰运气）。
                    // 取数经短 TTL 缓存（_hoverGather）：短时间内的再次移入直接复用，不再重跑 AE 查询。
                    _hoverGather.get(_hoverRoundId).then(function (both) {
                        var status = both[0];
                        var itemRes = both[1] || {};
                        // 期间又 hover/移出过（gen 过期）或浮层已移除 → 丢弃本次结果，防旧数据覆盖
                        if (gen !== _stateGen || !_statePop) return;
                        // 快照按**同一身份 + 同一 laneKey**取：团队档的快照落在该 lane 的槽里
                        //（aeContext 的分槽语义），不传 laneKey 会读到缺省槽（恒空）——真机表现为
                        //「读到了却什么都不显示」。
                        var snap = _aeCtx.getSnapshot(_ri ? _ri.ids : undefined, _ri ? (_ri.laneKey || undefined) : undefined);
                        // 去掉内部标记首行，其余原样展示
                        var body = snap ? snap.replace(/^\[AE Context\]\s*/m, '') : '';
                        // 提示行按两边选中给（N 只数可引用的合成/素材——文件夹点了也不建引用，
                        // 报进 N 会让用户以为点了会多一条）
                        var hasLayers = /Selected layers: (?!none)/.test(body);
                        var itemCount = 0;
                        if (itemRes.status === 'ok' && itemRes.refs) {
                            for (var _hi = 0; _hi < itemRes.refs.length; _hi++) {
                                var _ht = itemRes.refs[_hi] && itemRes.refs[_hi].itemType;
                                if (_ht === 'comp' || _ht === 'footage') itemCount++;
                            }
                        }
                        var hint = '';
                        if (hasLayers && itemCount > 0) hint = AEI18n.t('\n（点击引用：时间轴图层 + 项目面板 {n} 个对象）', { n: itemCount });
                        else if (hasLayers) hint = AEI18n.t('\n（点击引用当前选中图层）');
                        else if (itemCount > 0) hint = AEI18n.t('\n（点击引用项目面板选中的 {n} 个对象）', { n: itemCount });
                        if (body) {
                            _statePop.textContent = body + hint;
                        } else if (status === 'no-access') {
                            _statePop.textContent = AEI18n.t('（本轮不注入 AE 上下文：工程读取工具在本模式不可用）');
                        } else {
                            _statePop.textContent = AEI18n.t('（当前无活动合成 / 未选中任何对象）');
                        }
                        // 内容高度可能变化，重新定位保持锚点上方居中
                        _positionPopover(_statePop, aeStateEl);
                    });
                }, 200);
            });
            on(aeStateEl, 'mouseleave', function () {
                _stateGen++;  // 使在途 gather 结果失效
                clearTimeout(_stateGatherTimer);
                _statePopTimer = setTimeout(_removeStatePop, 300);
            });
            // 「当前选中」点击的结果文案见模块作用域的 refClickStatusText（纯函数，单测直调）
            // 点击 = 引用当前选中：时间轴选中的图层、项目面板选中的合成/素材，各建一条 chip
            //（选中的 N 层合成一条「引用 N 个图层」、N 个对象合成一条「引用 N 个对象」，与代码行号 chip
            // 同一套内联 token 机制，插入实现见 app/main.js 的 _addLayerRefChips / _addItemRefChips），
            // 发送时原位解析成「引用图层N：layerId=.., compositionId=..」「引用对象N：合成 compositionId=..；
            // 素材 footageId=..」交给 LLM。
            // 为什么两路都取：项目面板与时间轴的选中互相独立，只挑一边会在"另一边的残留选中"时给出
            // 反直觉结果（用户刚在项目面板选了素材，时间轴里还留着上次选的层）。取数与悬停浮层分开：
            // 浮层要的是给人看的文本快照，引用要的是**稳定键 id**（layerId+compositionId / Item.id）——
            // 共用快照文本只能拿到索引与名字，跨「点击」到「工具执行」的时间窗会因增删/重排/改名指到别的对象。
            // 本轮身份与发消息同一来源：团队档 = 当前 lane 的集合，单 Agent 档 = 当前档位。
            // 读 `settings.runtimeMode`（单 Agent 底层档）⇒ 团队档下按上一个模式校验引用：
            // glsl lane 会被按 agent 放行、director lane 会被按 shader 拒掉，两条都不如实。
            on(aeStateEl, 'click', function () {
                var roundId = '';
                try {
                    var _riClick = roundIdentity();
                    roundId = (_riClick && _riClick.ids && _riClick.ids.length) ? _riClick.ids : '';
                } catch (_) { roundId = ''; }
                var pLayers = _aeCtx.gatherSelectedRefs(roundId || undefined);
                var pItems = (typeof _aeCtx.gatherSelectedItemRefs === 'function')
                    ? _aeCtx.gatherSelectedItemRefs(roundId || undefined)
                    : Promise.resolve({ status: 'error', refs: [], message: AEI18n.t('当前版本不支持项目面板引用') });
                Promise.all([pLayers, pItems]).then(function (both) {
                    var layerRes = both[0] || {};
                    var itemRes = both[1] || {};
                    var addLayerRefChips = global.AEAgentApp && global.AEAgentApp.addLayerRefChips;
                    var addItemRefChips = global.AEAgentApp && global.AEAgentApp.addItemRefChips;
                    // 插入顺序：图层 chip 在前、项目项 chip 在后（同一次点击落在同一光标处，顺序固定）
                    var layerAdded = (layerRes.status === 'ok' && typeof addLayerRefChips === 'function')
                        ? (addLayerRefChips(layerRes.refs) || {}) : {};
                    var itemAdded = (itemRes.status === 'ok' && typeof addItemRefChips === 'function')
                        ? (addItemRefChips(itemRes.refs) || {}) : {};
                    var st = refClickStatusText(layerRes, itemRes, layerAdded, itemAdded);
                    showStatus(st.text, st.level, { autoHideMs: st.level === 'info' ? 3000 : 5000 });
                });
            });
        }
        // #globalDebugToggleBtn 不在此挂 change：拨动开关不产生运行时副作用（它只是全局设置
        // 弹窗里的表单字段）。调试模式在点「保存全局设置」后由主壳 → AEAgent.setDebugMode →
        // AEEngine.bridge.setDebugMode 应用（见下方 bridge 门面）。

        // 三条 lane 的会话恢复（单条执行体）：一条 lane 一份 store 的 lastActiveId。
        // 失败（返回值显式 ok:false / 抛错 / reject）只告警，不 reject——恢复链的其余一步
        // 与另外两条 lane 照常继续（单 lane 错误隔离）。
        // **无 lastActiveId 时什么都不做**：团队会话由链尾
        // `_ensureTeamSessionBound` 统一建立/绑回并整队 adopt。旧的「给每条 lane 各建一条空会话」
        // 只会在会话菜单留下 3 条马上失效的「新会话」（把数据目录的 agent 清空后重开即可见：
        // 3 条空会话 + 1 条团队会话）。跳过时 controller 停在初始 'default'（尚未落盘）；
        // 万一链尾兜底也失败，工具层仍如实报 no_team_session，与旧失败口径一致。
        function _restoreOneLane(item) {
            if (!item.sid) return Promise.resolve();
            var p;
            try {
                p = item.controller.switchSession(item.sid);
            } catch (e) {
                p = Promise.reject(e);
            }
            return Promise.resolve(p).then(function (res) {
                if (res && res.ok === false) {
                    console.warn('[Agent] 团队 lane 会话恢复失败（' + item.lane + '）: ' + (res.reason || 'unknown'));
                }
            }, function (e) {
                console.warn('[Agent] 团队 lane 会话恢复异常（' + item.lane + '）: ' + ((e && e.message) || e));
            });
        }

        // 团队三条 lane 的恢复：各自消费**自己**那份 store 的 lastActiveId。
        //   · 有 lastActiveId → switchSession（把该 lane 命名空间里上次那条会话载回来）；
        //   · 无 → **跳过**（不再各建空会话，见 _restoreOneLane 头注）；链尾统一建立/绑回团队会话。
        // 逐条**串行**：三条各自读索引 + 落盘，并发只是把 IO 挤在一起，没有收益。
        // 返回：三条 lane 的 lastActiveId 完全一致且非空时给那个 sid；任何一条缺席/分叉给 ''。
        function _restoreTeamLanes() {
            var list = _laneStoreList();
            if (!list.length) return Promise.resolve('');   // 团队关闭 / 从未装配：一次都不多跑
            // **读 lastActiveId 之前必须等各 lane store 就绪**：
            // 恢复窗口内开团队时，三条 lane 是这一刻才建的，**不在**链首那份 init 快照里——
            // 未就绪时 `getLastActiveId()` 恒 null ⇒ 会被当成「首启」而由链尾新建团队会话，
            // 把上次的团队会话丢掉（用户观感「团队会话没了」）。
            // 有界等待：超时按未就绪继续（链尾兜底会新建一条；不挂死）。
            return Promise.all(list.map(function (e) { return _whenStoreReady(e.store); }))
                .then(function (readies) {
                    // 超时**如实告警**（不静默）：这一刻起该 lane 按「没有 lastActive」处理，
                    // 链尾会新建团队会话（旧团队会话不会被恢复）——用户/排障必须看得见。
                    if (readies && readies.some(function (r) { return r === false; })) {
                        console.warn('[Agent] 部分 lane store 在 ' + _storeReadyTimeoutMs
                            + 'ms 内未就绪，lane 会话恢复按未就绪继续（链尾将新建团队会话）');
                    }
                    return _restoreTeamLanesAfterReady(list);
                });
        }

        // 就绪后的实际恢复体：原 `_restoreTeamLanes` 主体（一字未改，只是把「等就绪」提到调用前）。
        // 单独成函数而不内联进 `.then` 闭包：主体里有大段注释与循环，内联会让整段缩进漂一层。
        function _restoreTeamLanesAfterReady(list) {
            var runs = [];
            var sids = [];
            for (var i = 0; i < list.length; i++) {
                var rt = _orchestrator ? _orchestrator.getLane(list[i].id) : null;
                var ctl = rt ? rt.controller : null;
                var sid = '';
                try { sid = list[i].store.getLastActiveId() || ''; } catch (_) { sid = ''; }
                if (!ctl) {
                    // runtime 缺席（该 lane 装配失败）：如实告警，不静默跳过
                    console.warn('[Agent] 团队 lane 会话未恢复（runtime 缺席）: ' + list[i].id);
                    continue;
                }
                sids.push(sid);
                runs.push({ lane: list[i].id, sid: sid, controller: ctl });
            }
            var agreed = '';
            if (sids.length === list.length && runs.length === list.length && sids.length > 0) {
                agreed = sids[0];
                for (var k = 1; k < sids.length; k++) {
                    if (sids[k] !== agreed) { agreed = ''; break; }
                }
            }
            var chain = Promise.resolve();
            runs.forEach(function (item) {
                chain = chain.then(function () { return _restoreOneLane(item); });
            });
            // ── 认领既成事实 ───────────────────────────────────────────────────
            // 判据来源：上面三条 lane 各自 store 的 `getLastActiveId()`（`agreed` = 三条全等且非空）。
            // 三方一致 ⇒ 上一次运行整队就停在这条团队会话上，本次恢复只是把各自的旧会话载回来
            //（_restoreOneLane 的 switchSession），**没有**任何切换下发。
            // 为什么不用 bindSession：它走 _switchAll（停 lane + 逐条 adopt + 写 store），启动期对
            // 「三条已经在这条会话上」的既成事实再下发一遍是多余 IO；且 _switchAll 的 busy 预检会
            // 把「面板刚挂载、某条 lane 恰好在忙」整队判失败 ⇒ currentSid 反而不落值（这正是它要
            // 修的东西）。noteRestoredSession 只做一件事：复核 _isAdopted(sid) 通过后落 currentSid。
            // 不相等或为空（首启没有 lastActiveId / 三条分叉）⇒ 什么都不做：不猜该绑哪一条，
            // 交给链尾 `_ensureTeamSessionBound` 统一收敛（三条全等⇒绑回，否则新建）。
            // 复核不通过（某条 lane 恢复失败，cm 会话 id 或索引对不上）⇒ 只告警、不阻断恢复链：
            // 此时 read_workspace 仍报 no_team_session，是如实失败，好过认领一条只有一半 lane 在的会话。
            return chain.then(function () {
                if (agreed && _sessionBinder && typeof _sessionBinder.noteRestoredSession === 'function') {
                    var noted = null;
                    try {
                        noted = _sessionBinder.noteRestoredSession(agreed);
                    } catch (e) {
                        noted = { ok: false, reason: 'throw', detail: (e && e.message) || String(e) };
                    }
                    if (!noted || noted.ok !== true) {
                        // 认领失败不等于团队会话不可用：链尾 _ensureTeamSessionBound 会按
                        // 「三条 lastActiveId 全等」整队绑回（或对分叉/首启新建），故文案只说
                        // 兜底方向，不再断言「read_workspace 仍会报 no_team_session」。
                        console.warn('[Agent] 团队会话认领失败（链尾将兜底整队绑回/新建）: '
                            + agreed + ' → ' + JSON.stringify(noted));
                    }
                }
                return agreed;
            });
        }

        // 启动恢复：异步初始化 sessionStore + 迁移旧 localStorage 数据 + 恢复上次会话
        var _restoreT0 = (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
        function _restoreT(label) { console.log('[恢复耗时] ' + label + ' +' + Math.round(((typeof performance === 'object' && performance.now) ? performance.now() : Date.now()) - _restoreT0) + 'ms'); }
        _restoreT('start');
        // 恢复链异步期间 submitUserInput 守卫全 false，消息会写进 'default'
        // 孤儿会话并被恢复流程覆盖。入口据 state.restoring 拒绝；链尾 finally 复位。
        // 复位**不再**只写这一处单例槽——见 _restoreInFlight 注释（切 lane 会让槽漂走）。
        state.restoring = true;   // 单 Agent 那条
        _setRestoringAll(true);   // 同一事实一次写齐所有 runtime（含此后才建的 lane 的继承源）
        // 看门狗：链挂在任一 await 上时到点强制放行，避免「永久拒发」。
        // 先清旧表（重挂场景）再置新的；链尾 finally 会清掉它。
        if (_restoreWatchdogTimer) { clearTimeout(_restoreWatchdogTimer); _restoreWatchdogTimer = null; }
        _restoreWatchdogTimer = setTimeout(function () {
            _restoreWatchdogTimer = null;
            if (!_restoreInFlight) return;   // 链已正常收尾（幂等）
            console.warn('[Agent] 启动恢复链超时（' + _RESTORE_WATCHDOG_MS
                + 'ms）仍未落地，强制解除恢复标志（否则全部 runtime 永久拒发消息）');
            _setRestoringAll(false);
        }, _RESTORE_WATCHDOG_MS);
        // 单 Agent 那条 runtime 的 controller 就是恢复链的「单 Agent 目标」。**不走模块级
        // controller 槽**：团队开启时该槽被 _syncSlots 指向**当前 lane**（缺省 director），
        // 旧链读它会把单 Agent 的 lastActive 会话切进 director lane——三条 lane 的队形从启动
        // 第一刻就错位，而单 Agent 那条 runtime 反而停在初始会话上。
        // 团队档内不存在单 Agent runtime ⇒ 捕获点只在团队关闭时存在；
        // 团队档下单 Agent 段**跳过**并返回成功占位（退出团队由 _disableTeam 的异步段恢复）。
        var _restoreSingleController = (_singleRuntime && _singleRuntime.controller) ? _singleRuntime.controller : null;
        // 三条 lane 的 store 与单 Agent 三档**同批**初始化：索引没读，getLastActiveId() 就是空的，
        // 恢复链无从消费。团队关闭 / 从未开启时这个数组为空 ⇒ 仍是原有的三次 init、
        // 同一顺序、同一参数。
        var _restoreInitStores = [_scriptSessionStore, _agentSessionStore, _shaderSessionStore];
        var _restoreLaneStores = _laneStoreList();
        for (var _rs = 0; _rs < _restoreLaneStores.length; _rs++) _restoreInitStores.push(_restoreLaneStores[_rs].store);
        // 先发起各 store 的 init（幂等，返回同一个 Promise——既有语义），再用**有界**就绪等待
        // 覆盖「init 落地」这一步（无界等待会把整条链连同 restoring 一起挂死）。
        Promise.all(_restoreInitStores.map(function (s) {
            try { if (s && typeof s.init === 'function') s.init(); } catch (_) { /* 见下：按未就绪继续 */ }
            return _whenStoreReady(s);
        })).then(function (readies) {
            if (readies && readies.some(function (r) { return r === false; })) {
                console.warn('[Agent] 部分 store 在 ' + _STORE_READY_TIMEOUT_MS
                    + 'ms 内未就绪，恢复链按未就绪继续（后续会走显式失败，不静默成功）');
            }
            _restoreT('store init 完成');
            return migrateLegacyData();
        }).then(function () {
            _restoreT('migrate 完成');
            // 团队档下没有单 Agent runtime ⇒ 单 Agent 段跳过并返回成功占位。
            // 不在这里惰性建 single（视图/槽位会在团队档里造出第二条聊天面），退出团队时由
            // _disableTeam 的同步+异步段重建并恢复 baseMode 会话。
            if (!_restoreSingleController) {
                _restoreT('单 Agent 段跳过（团队档）');
                return { ok: true, skipped: true };
            }
            var settings = getSettings();
            // 取 _effMode —— 团队档下要恢复的是**被 park 的那条单 Agent 会话**
            // （baseMode 的域）：退出团队立刻要用它，重载后它就是「上次那条会话」。
            // 裸读 runtimeMode 会得到 'team' ⇒ 落到下面的 script 兜底，用户看到的是「开过团队
            // 之后重启，Agent 会话没了」（团队档没有独立会话域）。
            var runtimeMode = _effMode(settings);
            // 活动 store 按模式分发。**external 无会话域**（其 UI 只有管理台，无聊天/会话）——
            // 设计意图另见 switchMode 的「外接模式快路径」注释，以及 chatViewHelpers.getActiveStore
            // （运行时那份同口径映射）。回落到 script store 只是兜底：外接模式下唯一会走到本判据的
            // 是「后台结果注入时探测当前会话」（injectSystemResult），那条路径按 sessionId 走跨会话
            // 分支写回目标会话，不依赖本映射，故兜底选择不影响结果正确性。
            // 显式写出而不并入 else，是让「external 在此没有正确语义」在代码里可见：将来若给外接
            // 加会话域，须先在此补真实分支（它与哪个模式同族亦是设计决定）。
            var store;
            if (runtimeMode === 'shader') {
                store = _shaderSessionStore;
            } else if (runtimeMode === 'agent') {
                store = _agentSessionStore;
            } else {
                store = _scriptSessionStore;   // script 正常；external 兜底（见上）
            }
            var lastId = store.getLastActiveId();
            // 先播动画再分批加载：switchSession/createSession 的 syncView 是同步重渲染，
            // 与面板入场动画重叠会掉帧。经 main.js 暴露的 whenEnterAnimIdle 等动画播完
            // 再执行（动画未运行/已结束时立即放行，不影响二次进入等无动画场景）。
            var _runRestoreSession = function () {
                if (lastId) {
                    return _restoreSingleController.switchSession(lastId);
                } else {
                    return _restoreSingleController.createSession();
                }
            };
            if (global.AEAgentApp && typeof global.AEAgentApp.whenEnterAnimIdle === 'function') {
                return new Promise(function (resolve) {
                    global.AEAgentApp.whenEnterAnimIdle(resolve);
                }).then(_runRestoreSession);
            }
            return _runRestoreSession();
        }).then(function (result) {
            _restoreT('switchSession/create 完成');
            // 检查恢复是否成功（单 Agent 那条 runtime；same 视为已达成、其余口径与改动前一致）
            if (result && result.ok === false) {
                // 目标会话已是当前会话：恢复目标已达成，不按失败中断恢复链
                if (result.reason === 'same') return;
                // read_failed 中止切换后不能 throw 了之——恢复链中断会让面板
                // 停留初始 'default' 会话（不在 store 索引），后续新消息落索引外孤儿
                // 文件（重启后不可达）。原会话文件已受保护（零写盘），此处兜底
                // 切入索引内新会话；原会话保留在切换器中待用户处置。
                if (result.reason === 'read_failed') {
                    return _restoreSingleController.createSession().then(function (r) {
                        if (!r || !r.ok) {
                            throw new Error('Session restore failed: read_failed (fallback createSession failed: ' + ((r && r.reason) || 'unknown') + ')');
                        }
                        showStatus(AEI18n.t('上次会话读取失败，已保留原文件并切换到新会话'), 'error');
                    });
                }
                throw new Error('Session restore failed: ' + (result.reason || 'unknown'));
            }
        }).then(function () {
            // ── 三条 lane：各自消费**自己**那份 store 的 lastActiveId ──
            // 排在单 Agent 之后：单 Agent 那条的失败语义（throw → 整链中断）保持与改动前
            // 一致，不因 lane 的成败被改写；lane 的失败只告警（单 lane 错误隔离）。
            return _restoreTeamLanes();
        }).then(function (laneSid) {
            // 三条 lane 的 lastActiveId **完全一致且非空**（= 上一次运行绑定的同一个团队会话）
            // ⇒ 预建它的工作区目录：面板重载后团队会话即刻可达（「面板侧预建」在
            // 恢复路径上的落点）。三条分叉时什么都不建（不猜该建哪一个）。
            if (laneSid) _ensureTeamWorkspace(laneSid);
            if (global.AEEngine && global.AEEngine.refreshSessionSwitcher) {
                global.AEEngine.refreshSessionSwitcher();
            }
            // 标记初始恢复完成（入场动画现由 main.js 立即播放，不再消费此信号；
            // 保留广播供诊断/未来消费者使用）
            window.__aeAgentRestoreReady = true;
            if (typeof window.dispatchEvent === 'function') {
                window.dispatchEvent(new window.CustomEvent('ae:agent-restore-ready'));
            }
        }).catch(function (e) {
            console.error('[Agent] 启动恢复失败:', e);
        }).finally(function () {
            // 恢复完成（含失败/异常路径）后复位，此后提交放行。
            // **必须遍历所有 runtime**（不能只写单例槽）：链跑完前开团队 / 切 lane 时槽已漂到
            // 别的 runtime，只写它会留下单 Agent 那条永久 restoring=true（见 _restoreInFlight 注释）。
            // 看门狗同批撤掉（链已落地，它不再有用武之地）。
            if (_restoreWatchdogTimer) { clearTimeout(_restoreWatchdogTimer); _restoreWatchdogTimer = null; }
            _setRestoringAll(false);
            // 提示词注入器（技能/记忆）在恢复链之后才齐全，这里再按最终注入面估算一次。
            try { _refreshAllLaneOverheads(); } catch (_) { /* 装配未就绪：静默 */ }
            // 团队会话「开箱即用」兜底（见 _ensureTeamSessionBound 头注）：恢复链是启动期唯一
            // 能保证「三条 lane 已恢复完 + 团队开关已按设置落定」两个前提都成立的时机。
            // 三条 lane 已全等且认领成功时它是幂等空操作；分叉/首启才真正落地（绑回或新建）。
            // 运行时开关路径由 setTeamMode 的调度覆盖。失败只告警，不阻断恢复链收尾。
            try { _ensureTeamSessionBound('restore'); } catch (_) { /* helper 内部已如实告警 */ }
        });
        // 挂载段全部成功后才置位（对齐 agent/index.js 的模式）。
        // unmount 为「后台运行」语义不清位，此处置位后跨模块切换保持常驻（既有
        // 语义不变）；挂载中途抛错则 mounted 保持 false，再次进入可完整重挂
        mounted = true;
    }

    async function migrateLegacyData() {
        if (localStorage.getItem('ae_agent_sessions_migrated') === '1') return;

        var scriptMigrated = false;
        var agentMigrated = false;

        var legacyScript = localStorage.getItem('agent_session_v1');
        if (legacyScript) {
            try {
                // 旧值是 {messages:[...]} 对象（外层 persist）或 {conversationId,messages,...}（内层 cm save），
                // 必须经 parseLegacySessionMessages 提取数组并归一化形态——直接 JSON.parse 传对象给 save()
                // 会被 Array.isArray 判否、静默存成空数组，旧历史全丢。
                var msgs = (typeof ns.parseLegacySessionMessages === 'function') ? ns.parseLegacySessionMessages(legacyScript) : null;
                if (msgs === null) throw new Error('旧数据形态无法识别');
                var session = _scriptSessionStore.createSession();
                await _scriptSessionStore.save(session.id, msgs);
                await _scriptSessionStore.flush();  // 强制落盘
                _scriptSessionStore.updateLastActive(session.id);
                localStorage.removeItem('agent_session_v1');
                scriptMigrated = true;
            } catch (e) {
                console.warn('[Agent] 迁移 script 旧数据失败:', e);
            }
        } else {
            scriptMigrated = true;  // 无旧数据，视为已迁移
        }

        var legacyAgent = localStorage.getItem('ae_agent_tool_session_v2');
        if (legacyAgent) {
            try {
                var msgs = (typeof ns.parseLegacySessionMessages === 'function') ? ns.parseLegacySessionMessages(legacyAgent) : null;
                if (msgs === null) throw new Error('旧数据形态无法识别');
                var session = _agentSessionStore.createSession();
                await _agentSessionStore.save(session.id, msgs);
                await _agentSessionStore.flush();  // 强制落盘
                _agentSessionStore.updateLastActive(session.id);
                localStorage.removeItem('ae_agent_tool_session_v2');
                agentMigrated = true;
            } catch (e) {
                console.warn('[Agent] 迁移 agent 旧数据失败:', e);
            }
        } else {
            agentMigrated = true;  // 无旧数据，视为已迁移
        }

        // 仅当两边都迁移成功才打标记，失败时下次启动重试
        if (scriptMigrated && agentMigrated) {
            localStorage.setItem('ae_agent_sessions_migrated', '1');
        }
    }

    function unmount() {
        // 强制落盘挂起的防抖写入（六条 store：单 Agent 三档 + 三条 lane——团队开启时三条 lane
        // 各自有防抖窗口，漏了它们 = 切 lane 后最后一条消息丢失。团队关闭时恰是改动前那三条）
        var _stores = _allSessionStores();
        for (var _i = 0; _i < _stores.length; _i++) {
            if (_stores[_i] && typeof _stores[_i].flush === 'function') _stores[_i].flush();
        }
        // 同步保存当前会话的 token 统计
        _persistActiveTokenStats();
        // 引擎不随模块切换销毁--切走时后台继续运行，
        // controller / contextManager / DOM 事件保持存活。
        // 粒子动画等UI开销由 main.js 的 stopParticleEngine 单独关停。
        console.log('[Engine] unmount: 后台运行，不销毁引擎');
    }

    global.AEEngine = global.AEEngine || {};
    // ── 后台结果的「精确会话」解析 ───────────────────────
    // 规则：只写发起时快照的 sessionId **精确命中且归属校验通过**的会话；没有 sessionId 或
    // 校验不过就报错（lane_unavailable / session_mismatch），不猜最近会话、不写当前会话、
    // 不写其它 lane 的会话——错写会污染别的会话的 LLM 上下文，比丢卡更糟。
    // 存储归属表：三条单 Agent store（script/agent/shader）+ 已装配的 lane store（模块级登记）。
    function _singleSessionStoreList() {
        var out = [];
        var base = [_scriptSessionStore, _agentSessionStore, _shaderSessionStore];
        for (var i = 0; i < base.length; i++) if (base[i]) out.push(base[i]);
        return out;
    }
    function _storeOwnsSession(store, sessionId) {
        if (!store || !sessionId || typeof store.listSessions !== 'function') return false;
        var sessions = [];
        try { sessions = store.listSessions() || []; } catch (_) { return false; }
        for (var i = 0; i < sessions.length; i++) {
            if (sessions[i] && sessions[i].id === sessionId) return true;
        }
        return false;
    }
    // 目标 lane 对应的 store：'single' = 三条单 Agent store（返回数组）；lane = 该条 lane 的 store；
    // 未装配/未知 ⇒ null。**不猜**（不存在就由调用方报 lane_unavailable/session_mismatch）。
    function _targetSessionStores(laneId) {
        if (laneId === 'single') return _singleSessionStoreList();
        var st = _laneSessionStores[laneId] || null;
        return st ? [st] : null;
    }
    // 可见警告：调用方（ComfyUI / MCP / 外接）失败时不能静默丢结果。
    function _warnSystemResult(message) {
        console.warn('[AEEngine] ' + message);
        try {
            if (global.AEToast && typeof global.AEToast.show === 'function') global.AEToast.show(message, 'warn');
        } catch (_) { /* toast 缺席：已留 console.warn */ }
    }
    // 团队 lane 的模型/平台解析与思考等级覆盖（纯函数，唯一实现）：挂公开面供单测直驱与诊断读数
    //（mount 内的 getLaneModelSelection 只是它 +「读当前 team 设置/全局缓存」的薄封装）。
    global.AEEngine.resolveLaneModelSelection = resolveLaneModelSelection;
    global.AEEngine.resolveLaneReasoningEffort = resolveLaneReasoningEffort;
    // 门面**全部方法**按「当前 lane」工作（团队关闭时当前 lane = 唯一那条 runtime，
    // 与改动前同一个对象）。取用统一经 _currentController() / _currentRuntime()（两者都解析到
    // 当前 lane）；editInjectItem / sendInjectItem / setDebugMode 三个方法仍按模块级 controller
    // 槽读——该槽由 _syncSlots 维护成当前 lane 的 controller，与 _currentController() 是同一个
    // 对象；这三处委托文本保持不变。
    global.AEEngine.bridge = {
        mount,
        unmount,
        submitUserInput() {
            var c = _currentController();
            if (!c) {
                console.warn('[AEEngine] submitUserInput: controller 尚未初始化，请等待模块加载完成');
                return;
            }
            c.submitUserInput();
        },
        requestStop() {
            var c = _currentController();
            if (!c) return;
            c.requestStop();
        },
        // 当前 lane 的忙态（团队模式下 = 用户正在看的那条 lane 的 state；
        // 「任一 lane busy」锁判据由全局宿主 index.js 汇总，不在这里）
        isBusy() {
            var rt = _currentRuntime();
            return !!(rt && rt.state && rt.state.busy);
        },
        getInjectQueue() {
            var c = _currentController();
            return c && typeof c.getInjectQueue === 'function' ? c.getInjectQueue() : [];
        },
        removeInjectItem(index) {
            var c = _currentController();
            if (c && typeof c.removeInjectItem === 'function') c.removeInjectItem(index);
        },
        // 待发送 chip 的「编辑/立刻发送」按钮经 bridge 门面调用这两个方法，
        // renderInjectChips 按 typeof === 'function' 判空——门面缺失委托时点击静默
        // 空转（消息滞留队列、输入框不回填）。对齐 removeInjectItem 的委托风格补齐。
        // 委托目标读模块级 controller 槽 = 当前 lane 的 controller（_syncSlots 维护），
        // 与 _currentController() 同一个对象。
        editInjectItem(index) {
            if (controller && typeof controller.editInjectItem === 'function') return controller.editInjectItem(index);
            return null;
        },
        sendInjectItem(index) {
            if (controller && typeof controller.sendInjectItem === 'function') return controller.sendInjectItem(index);
        },
        debugPreviewInject() {
            // 纯预览：只临时填充渲染层数据，不写入 controller 真实队列，点按钮不发送、也不影响后续正常发送
            _previewInjectMode = true;
            _previewInjectQueue = [
                { text: '测试待发送消息 1：新建红色固态层', displayText: '测试待发送消息 1：新建红色固态层' },
                { text: '测试待发送消息 2：添加文字图层「标题」', displayText: '测试待发送消息 2：添加文字图层「标题」' },
                { text: '测试待发送消息 3：为图层创建位移动画', displayText: '测试待发送消息 3：为图层创建位移动画' }
            ];
            renderInjectChips();
        },
        getActivePlan() {
            var c = _currentController();
            if (!c || typeof c.getActivePlan !== 'function') return null;
            return c.getActivePlan();
        },
        clearReflectDrafts() {
            var c = _currentController();
            if (!c || typeof c.clearReflectDrafts !== 'function') return false;
            return c.clearReflectDrafts();
        },
        injectSystemMessage(text, images, sessionId, detail) {
            var c = _currentController();
            if (c && typeof c.injectSystemMessage === 'function') {
                c.injectSystemMessage(text, images, sessionId, detail);
            }
        },
        // laneId（可选）：后台结果回流的**目标 lane**，缺省 = 当前 lane。
        // 调用方在发起调用的同一刻快照 lane（comfyui 取执行上下文 ctx.laneId、mcp-manager 在
        // beginTask 时取当前 lane）：结果迟到时用户可能已切走 lane，按发起 lane 写回才对。
        // **给了 laneId 就按 laneId 精确投递，不再回落当前 lane**。
        // 目标 lane 的 runtime 不在时（团队关闭 /
        // lane 未装配 / 'single' 在团队档），**只写确定的发起会话**：
        //   · 有 sessionId 且归属校验通过（命中目标 lane 的 store / 'single' 命中三条单 Agent
        //     store）⇒ 用发起会话的 store.appendTo 写回原会话（经当前 controller 的
        //     appendToSession，卡片形状与跨会话分支同源）；
        //   · 无 sessionId ⇒ lane_unavailable；sessionId 归属不符/找不到 ⇒ session_mismatch；
        //   · **任何会话都不新增卡片**，并留一条可见警告（宁报错不猜；错写会污染别的会话上下文）。
        // 未给 laneId 的旧调用保持旧语义（当前 lane = UI 动作面）。
        injectSystemResult(title, visible, detail, llmRole, sessionId, laneId) {
            if (typeof laneId === 'string' && laneId) {
                var sid = (typeof sessionId === 'string' && sessionId) ? sessionId : '';
                // ① 归属校验（有 sessionId 就必须过；目标 store 解析不出来 = 无法校验 = 拒绝写）
                // 命中**多个**目标 store 也算校验不过——同一 id 落在多个 store 里时
                // 归属本身是歧义，按 session_mismatch 拒绝（零写入），不在下游按存储顺序猜。
                if (sid) {
                    var stores = _targetSessionStores(laneId);
                    var ownedCount = 0;
                    if (stores) {
                        for (var si = 0; si < stores.length; si++) {
                            if (_storeOwnsSession(stores[si], sid)) ownedCount++;
                        }
                    }
                    if (ownedCount !== 1) {
                        _warnSystemResult(AEI18n.t('后台结果未写入：会话 {sid} 不属于目标 Agent「{agent}」或归属歧义（命中 {n} 个 store；不跨 Agent / 不猜会话，避免污染其它会话的 LLM 上下文）。',
                            { sid: sid, agent: laneId, n: ownedCount }));
                        return { ok: false, lane: laneId, reason: 'session_mismatch' };
                    }
                }
                // ② 目标 lane runtime 在 ⇒ 既有精确投递（同一条 lane 内的跨会话写回由它自己处理）
                var pick = _runtimeForLaneStrict(laneId);
                if (pick.ok) {
                    var targetC = pick.rt ? pick.rt.controller : null;
                    if (targetC && typeof targetC.injectSystemResult === 'function') {
                        targetC.injectSystemResult(title, visible, detail, llmRole, sessionId);
                        return { ok: true, lane: laneId };
                    }
                    return { ok: false, lane: laneId, reason: 'no_controller' };
                }
                // ③ runtime 不在：没有确定的发起会话就报错，不写当前会话/不猜最近会话
                if (!sid) {
                    _warnSystemResult(AEI18n.t('后台结果未写入：目标 Agent「{agent}」的通道不可用（{reason}），且调用方没有传发起时的 sessionId。',
                        { agent: laneId, reason: pick.reason }));
                    return { ok: false, lane: laneId, reason: 'lane_unavailable' };
                }
                var appendC = _currentController();
                if (!appendC || typeof appendC.appendToSession !== 'function') {
                    _warnSystemResult(AEI18n.t('后台结果未写入：没有可用的会话写入通道（controller.appendToSession 缺席）。'));
                    return { ok: false, lane: laneId, reason: 'lane_unavailable' };
                }
                try {
                    var wrote = appendC.appendToSession(sid, {
                        systemResult: true, title: title || '',
                        visible: visible || {}, detail: detail || {},
                        llmRole: llmRole || 'user'
                    });
                } catch (e) {
                    _warnSystemResult(AEI18n.t('后台结果写入原会话失败（{sid}）：{why}', { sid: sid, why: ((e && e.message) || e) }));
                    return { ok: false, lane: laneId, reason: 'write_failed' };
                }
                // appendToSession 返回 Result（Promise）。同步契约保留（调用方
                // fire-and-forget 不等于忽略失败）：写失败时返回 rejected 语义的 Promise 结果并把
                // 原因透出（resolve 为 {ok:false,...} + 可见警告），不再「恒 ok:true」。
                if (wrote && typeof wrote.then === 'function') {
                    return wrote.then(function (wr) {
                        if (wr && wr.ok === false) {
                            var why = (wr.reason === 'session_not_found') ? 'session_mismatch' : 'write_failed';
                            _warnSystemResult(AEI18n.t('后台结果写入原会话失败（{sid}）：{why}', { sid: sid, why: (wr.reason || 'unknown') }));
                            return { ok: false, lane: laneId, reason: why };
                        }
                        return { ok: true, lane: laneId, redirected: true, reason: pick.reason };
                    }, function (e) {
                        _warnSystemResult(AEI18n.t('后台结果写入原会话异常（{sid}）：{why}', { sid: sid, why: ((e && e.message) || e) }));
                        return { ok: false, lane: laneId, reason: 'write_failed' };
                    });
                }
                return { ok: true, lane: laneId, redirected: true, reason: pick.reason };
            }
            var rt = _currentRuntime();
            var c = rt ? rt.controller : null;
            if (c && typeof c.injectSystemResult === 'function') {
                c.injectSystemResult(title, visible, detail, llmRole, sessionId);
                return { ok: true, lane: _currentLaneId() || 'single' };
            }
            return { ok: false, lane: '', reason: 'no_controller' };
        },
        getSessionId() {
            var c = _currentController();
            if (c && typeof c.getActiveCm === 'function') {
                var cm = c.getActiveCm();
                return cm ? cm.getSessionId() : null;
            }
            return null;
        },
        setDebugMode(enabled) {
            // 调试模式变更（全局设置保存后由应用层调用）：登记已渲染消息的「待重建」，
            // 让工具卡片「查看详情」按新调试态重渲染。controller 未挂载时无事可做
            // ——首屏渲染本就按当时的调试态走。委托目标 = 当前 lane 的 controller
            //（模块级槽由 _syncSlots 维护）。
            if (!controller || typeof controller.setModeByDebug !== 'function') return;
            controller.setModeByDebug(!!enabled);
        },
        syncMaxContextTokens,
        // 只刷「生效上限来源」提示（不改 cm、不落盘）：设置面板每次打开时调一次，
        // 避免为了刷新一行提示就走 setMaxContextTokens（那会触发 prune + persist）
        refreshCtxWindowHint: _updateCtxWindowHint
    };
    // ── 显式身份面 ────────────────────────────────────────────────────────────
    // 背景：`AEEngine.bridge` 是**当前 lane 的 UI 动作面**（用户点的是当前这条，语义正确）；
    // 非 UI 调用方（后台任务回写、外接桥、自动化脚本）需要的是「明确这条 lane」的数据面。
    // 过去它们只能借 bridge + 可选 laneId，而 laneId 落空时静默回落当前 lane ⇒ 数据写进错的
    // lane。forLane 把身份固化在门面上：非法/未知 lane 每个方法显式失败，不猜、不回落。
    // laneId 取值 = 三条 lane 的 id 或 `'single'`（主 Agent 通道，团队模式下外接/手动通道的落点）。
    window.AEEngine.forLane = function (laneId) {
        var lid = (typeof laneId === 'string') ? laneId : '';
        var pick = _runtimeForLaneStrict(laneId);
        function _fail() { return { ok: false, lane: lid, reason: pick.ok ? 'no_controller' : (pick.reason || 'unknown_lane') }; }
        function _ctl() { return (pick.ok && pick.rt && pick.rt.controller) ? pick.rt.controller : null; }
        function _call(method, args) {
            var c = _ctl();
            if (!c || typeof c[method] !== 'function') return _fail();
            try {
                return { ok: true, lane: lid, result: c[method].apply(c, args) };
            } catch (e) {
                return { ok: false, lane: lid, reason: 'error', error: String((e && e.message) || e) };
            }
        }
        return {
            laneId: lid,
            ok: !!pick.ok,
            reason: pick.ok ? '' : pick.reason,
            isSingle: lid === 'single',
            // 数据面
            injectSystemResult: function (title, visible, detail, llmRole, sessionId) {
                var c = _ctl();
                if (!c || typeof c.injectSystemResult !== 'function') return _fail();
                try {
                    c.injectSystemResult(title, visible, detail, llmRole, sessionId);
                    return { ok: true, lane: lid };
                } catch (e) { return { ok: false, lane: lid, reason: 'error', error: String((e && e.message) || e) }; }
            },
            injectSystemMessage: function (text, images, sessionId, detail) {
                var c = _ctl();
                if (!c || typeof c.injectSystemMessage !== 'function') return _fail();
                try {
                    c.injectSystemMessage(text, images, sessionId, detail);
                    return { ok: true, lane: lid };
                } catch (e) { return { ok: false, lane: lid, reason: 'error', error: String((e && e.message) || e) }; }
            },
            getSessionId: function () {
                var c = _ctl();
                if (!c || typeof c.getActiveCm !== 'function') return null;
                try {
                    var cm = c.getActiveCm();
                    return (cm && typeof cm.getSessionId === 'function') ? (cm.getSessionId() || null) : null;
                } catch (_) { return null; }
            },
            getActivePlan: function () {
                var c = _ctl();
                return (c && typeof c.getActivePlan === 'function') ? c.getActivePlan() : null;
            },
            getController: function () { return _ctl(); },
            getState: function () { return (pick.ok && pick.rt) ? pick.rt.state : null; },
            // 动作面（同样严格：后台想停/驱动某条 lane 时用，不靠「当前」）
            submitUserInput: function () { return _call('submitUserInput', []); },
            requestStop: function () { return _call('requestStop', []); },
            isBusy: function () {
                var rt = (pick.ok && pick.rt) ? pick.rt : null;
                return !!(rt && rt.state && rt.state.busy);
            },
            getInjectQueue: function () {
                var c = _ctl();
                return (c && typeof c.getInjectQueue === 'function') ? (c.getInjectQueue() || []) : [];
            }
        };
    };
    // tool_search handler 工厂暴露：_mountInner 注册与单测共用同一实现
    global.AEEngine.createToolSearchHandler = createToolSearchHandler;
    // 「当前选中」入口可见性工厂暴露：同上（挂载点深处不可触达，单测直驱）
    global.AEEngine.createAeStateChipVisibility = createAeStateChipVisibility;
    // 「当前选中」悬停取数短 TTL 缓存工厂暴露：同上（单测注入假时钟验证"短时重复触发只查一次"）
    global.AEEngine.createAeHoverGatherCache = createAeHoverGatherCache;
    // 「当前选中」点击结果文案（纯函数）：单测直调（与 aeContext 的 formatAeContext* 同款先例）
    global.AEEngine.refClickStatusText = refClickStatusText;
    // 「当前选中」入口的本轮身份 / 可行判据 / 写点：挂载点深处不可触达，抽到模块作用域供
    // 单测直驱（同 createAeStateChipVisibility 先例）；applyAeStateChipVisibility 另供 app 层模式
    // chrome（main.js refreshList）调用——模式切换要在同一处把入口显隐落到新身份上。
    global.AEEngine.roundIdentity = roundIdentity;
    global.AEEngine.chipVerdictFromRegistry = chipVerdictFromRegistry;
    global.AEEngine.applyAeStateChipVisibility = applyAeStateChipVisibility;
})(window);
