// AE 引擎调用的 FIFO 串行队列（**面板常开**）。
//
// 存在理由：ExtendScript 的 evalScript 落进**同一个** AE 脚本引擎，而 ae-tools 的每次
// 调用都统一包 undo group，并且会碰 beginSuppressDialogs / 渲染在途门这类全局态。面板内
// Agent（单 Agent、团队三条 lane、子 Agent）、外接 MCP 派发、QuickBar 快速命令与手动运行
// 可能同时发起调用，不加队列会出现两件真事：
//   ① 两个 undo group 交叠 → AE 弹「撤消组不匹配」并卡住脚本引擎；
//   ② 前一个脚本还没跑完，后一个脚本插进来改项目状态。
//
// 边界（旁路清单，不纳入本队列）：
//   · 只串行真正落到 AE 引擎的调用 —— ae-tools/bootstrap.js 的 createHandler → cs.evalScript；
//   · 只走 AEFS/Bridge 的工具（读写文件、读图、联网、createAETool/deleteAETool 的落盘）不触
//     ExtendScript，本就不在咽喉上；
//   · injectCodeToAE（仅启动期）、effectsCache 的独立包装、quickBarExecutor 的第二条 AE
//     执行路径不纳入本队列（后者自开撤销组，另有归属）。
//
// 四条硬约束（改代码前先读）：
//   ① **默认启用（面板常开）**：面板内所有 AE 调用共用这一条 FIFO，外接与面板 Agent 双跑
//      时也是逐调用串行。只在团队档启用时，非团队档双跑的面板层完全没有串行
//      （超时归因会误报成「AE 弹模态 / 操作慢」）。enable(false) 仅供测试/诊断回退直通，
//      生产代码不得用它当开关。
//   ② **队头保持到 fn 返回**（含迟到回执）：**不做超时放行**。渲染在途时 AE 侧脚本引擎被独占、
//      _renderInFlight 不复位；「超时即放行队头」会让后续调用被派发到仍在渲染的引擎上
//      烧满 executionTimeoutMs（默认 30s）并拿到错误归因。等待方按自身超时失败，文案用
//      occupancyText()（标明占用来由）。
//   ③ 单次项的 rejection 不得阻断队列：队头失败只影响它自己的返回 Promise。
//   ④ **排队等待与执行超时是两段**（计时在 createHandler，本文件只管顺序）：本文件不挂计时器；
//      等待项没有「执行超时」，只有 createHandler 的排队等待预算；下发后由 createHandler 另起
//      执行超时。因此排队久不会挤占执行预算。
//
// 关闭时（enable(false)）队列**继续排空**已入队的项：那些调用方还在 await，丢掉会让 Promise
// 永不 settle（表现为工具调用挂死）。关闭只影响此后新到的调用（直通）。
//
// **不可成环**（集成方必读）：队头的 fn 不得 await（或 return）它自己在执行体内入队的项。
// 「fn 的返回 Promise 结算」就是交班条件，而内层项要等交班后才跑 —— 两者互等则永久挂起，
// 且队头占着引擎不放（等待方按自身超时失败、文案会指向该队头）。队列不做超时放行（见②），
// 因此不拆这个环：队头内入队的项请勿在队头内等待。
(function (global) {
    'use strict';

    var _enabled = true;        // 面板常开；enable(false) 仅供测试/诊断回退直通
    var _queue = [];            // 等待项 {laneId, owner, label, fn, deferred}（不含正在执行的那一项）
    var _running = null;        // 当前占用 AE 引擎的项 {laneId, owner, label, startedAt}
    var _maxDepth = 0;          // 历史高水位：等待项数 + 正在执行数

    function _now() { return Date.now(); }

    function _defer() {
        var d = {};
        d.promise = new Promise(function (resolve, reject) {
            d.resolve = resolve;
            d.reject = reject;
        });
        return d;
    }

    // 未启用：同步直调 fn，返回 fn 的原 Promise（不加 Promise.resolve 包一层，
    // 以免给既有链路引入额外 microtask 延迟）。fn 同步抛错时原样向外抛 ——
    // 这与改动前直接调用 fn 的行为逐字节相同。
    function _passthrough(fn) {
        var r = fn();
        return (r && typeof r.then === 'function') ? r : Promise.resolve(r);
    }

    // 取出队头并执行。只在没有在跑项时取（_running 即互斥锁），由此保证同时只有一项占引擎。
    function _pump() {
        if (_running || !_queue.length) return;
        var item = _queue.shift();
        // owner = 展示归属（lane id / 'single' / 'external'），与 laneId 分离：外接调用入队用
        // laneId='single'（保持取消/统计语义不变），展示上要写成「外接」而不是「single」。
        _running = {
            laneId: item.laneId,
            owner: item.owner || item.laneId,
            label: item.label,
            startedAt: _now()
        };
        var result;
        try {
            result = item.fn();
        } catch (e) {
            _finish(item, e, true);
            return;
        }
        Promise.resolve(result).then(function (v) {
            _finish(item, v, false);
        }, function (e) {
            _finish(item, e, true);
        });
    }

    // 队头结束（成功或失败都走这里）→ 结算它自己的 Promise → 交班给下一项。
    function _finish(item, value, isError) {
        _running = null;
        if (isError) item.deferred.reject(value);
        else item.deferred.resolve(value);
        _pump();
    }

    // run(laneId, label, fn, opts)：入队执行，返回 fn 结果的 Promise。
    //   laneId —— lane 标识（'director' / 'ae-exec' / 'glsl'），用于诊断、等待文案与**按 lane 取消**；
    //   label  —— 工具名（如 'executeExtendScript'），同上；
    //   fn     —— 无参函数，返回 Promise（返回值原样透传给调用方）；
    //   opts   —— 可选。
    //            `onCancel(payload)`：该等待项被 cancelQueuedForLane 取消时回调
    //            （没人接 run() 返回值的调用方靠它把「未下发」翻译成自己的失败回执）；
    //            `owner`：展示归属（'single' / 'external' / lane id，缺省 = laneId）。外接调用
    //            的 laneId 是 'single'（保持取消/统计语义不变），展示靠 owner 区分为「外接」。
    // 未启用（enable(false)，仅测试/诊断）时直通：fn 同步执行，返回它自己的 Promise。启用时严格 FIFO。
    function run(laneId, label, fn, opts) {
        if (typeof fn !== 'function') {
            return Promise.reject(new Error('AEExecQueue.run: fn required'));
        }
        if (!_enabled) return _passthrough(fn);

        var item = {
            laneId: (laneId === undefined || laneId === null || laneId === '') ? 'unknown' : String(laneId),
            owner: (opts && typeof opts.owner === 'string' && opts.owner) ? opts.owner : null,
            label: (label === undefined || label === null || label === '') ? 'ae-tool' : String(label),
            fn: fn,
            onCancel: (opts && typeof opts.onCancel === 'function') ? opts.onCancel : null,
            deferred: _defer()
        };
        _queue.push(item);
        var outstanding = _queue.length + 1;   // 等待项 + 即将开始/正在执行的队头
        if (outstanding > _maxDepth) _maxDepth = outstanding;
        _pump();
        return item.deferred.promise;
    }

    // cancelQueuedForLane(laneId, reason)：取消该 lane **尚未下发**的排队项。
    // 语义边界（与文件头的队列契约一致，改前先读）：
    //   · 只清**等待项**——它们从未执行，AE 侧零副作用；
    //   · **不取消队头**（已下发）：evalScript 没有取消机制，队头必须保持到回执（见文件头②），
    //     否则「取消」会变成「面板以为停了、AE 侧其实正在改工程」；
    //   · 逐项结算：先调 onCancel（createHandler 据此让工具面立刻失败——项被移走后回执永远
    //     不会来，不 reject 就是调用方挂到自身超时），再以 {cancelled:true} resolve run() 的
    //     Promise（没人 await 时也不会产生 unhandled rejection）；
    //   · 返回本次取消条数（0 = 该 lane 没有等待项；空/非法 laneId 不猜）。
    // 为什么需要它：停止 lane 只 requestStop（只停当前这轮）时，排队中的 AE 调用仍会按 FIFO 依次
    // 下发——用户点了「停止」，那条 lane 排着的脚本仍会改工程。
    function cancelQueuedForLane(laneId, reason) {
        var id = (typeof laneId === 'string' && laneId) ? laneId : '';
        if (!id) return 0;
        var kept = [];
        var cancelled = 0;
        for (var i = 0; i < _queue.length; i++) {
            var item = _queue[i];
            if (item.laneId !== id) { kept.push(item); continue; }
            cancelled++;
            var payload = { cancelled: true, laneId: id, reason: reason || 'lane_stopped' };
            if (typeof item.onCancel === 'function') {
                try { item.onCancel(payload); } catch (_) { /* 单个回调异常不阻断其余项的取消 */ }
            }
            item.deferred.resolve(payload);
        }
        _queue = kept;
        return cancelled;
    }

    // enable(on)：生产代码**不再调用**（队列面板常开）。保留给测试/诊断：
    // enable(false) 回退直通，enable(true) 恢复串行；已入队项在任何情况下都会继续排空。
    function enable(on) {
        var next = !!on;
        if (next === _enabled) return _enabled;
        _enabled = next;
        try {
            console.log('[AEExecQueue] ' + (_enabled ? '启用串行队列（面板常开）' : '关闭串行队列，恢复直通（测试/诊断）'));
        } catch (_) {}
        if (_enabled) _pump();
        return _enabled;
    }

    function isEnabled() { return _enabled; }

    // stats()：供任务板与诊断读的即时快照（字段与顺序即契约，勿改名）。
    //   depth     —— 当前等待项数（不含正在执行的那一项）
    //   running   —— 正在占用 AE 引擎的项数（0/1；恒 ≤1 即「栈深 ≤1」的直接证据）
    //   headLane  —— 队头所属 lane（空闲为 null；外接/手动通道为 'single'——身份字段，
    //                展示名走 occupancyText 的 owner）
    //   headLabel —— 队头工具名（空闲为 null）
    //   waitedMs  —— 队头已占用毫秒数（空闲为 0）
    //   maxDepth  —— 历史最大（等待项数 + 正在执行数）
    function stats() {
        return {
            depth: _queue.length,
            running: _running ? 1 : 0,
            headLane: _running ? _running.laneId : null,
            headLabel: _running ? _running.label : null,
            waitedMs: _running ? (_now() - _running.startedAt) : 0,
            maxDepth: _maxDepth
        };
    }

    // lane 显示名（导演 / AE 执行 / Shader 执行 / 单 Agent / 外接）：文案面向用户，不暴露
    // 内部术语 lane 与裸 id（同一口径把界面/
    // 工具文案也一起收干净）。'single' / 'external' 是常开队列新增的两种非 lane
    // 归属，必须在这里收成显示名，否则等待方会看到「被「single」占用」。
    // 定义源缺席时退回 id：诊断文案里 id 也是有效信息，不静默留空。
    function _laneName(id) {
        if (id === 'single') return '单 Agent';
        if (id === 'external') return '外接';
        try {
            var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var def = (api && typeof api.get === 'function') ? api.get(id) : null;
            if (def && def.label) return def.label;
        } catch (_) { /* 见上：退回 id */ }
        return (id === undefined || id === null || id === '') ? '未知 Agent' : String(id);
    }

    // occupancyText(waitedMs)：等待/失败文案，标明「等 AE 引擎（被「导演」的 X 占用 Ns）」。
    // 面板所有通道的超时提示都取这一句，不要另写「AE 正弹模态框 / 操作慢」那类旧文案（会把
    // 「被别的 Agent / 外接占着」误报成 AE 卡了）。展示归属用 owner（非 lane 的 'single' /
    // 'external' 也各有显示名），身份仍用 laneId。省略入参时取当前队头的实际占用时长。
    function occupancyText(waitedMs) {
        if (!_running) return 'AE 引擎空闲';
        var ms = (typeof waitedMs === 'number' && waitedMs >= 0) ? waitedMs : (_now() - _running.startedAt);
        return '等待 AE 引擎（被「' + _laneName(_running.owner || _running.laneId) + '」的 `' + _running.label
            + '` 占用 ' + Math.round(ms / 1000) + 's）';
    }

    global.AEExecQueue = {
        run: run,
        enable: enable,
        isEnabled: isEnabled,
        cancelQueuedForLane: cancelQueuedForLane,
        stats: stats,
        occupancyText: occupancyText
    };
})(typeof global !== 'undefined' ? global : window);
