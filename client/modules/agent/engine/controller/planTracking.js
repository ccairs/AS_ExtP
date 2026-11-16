(function (global) {
    'use strict';
    // 任务计划（plan）跟踪与持久化层拆分。由 controller.js 组装区经 AEEngine.createPlanTracking() 创建。
    // 纯迁移自 controller.js 内联的 persistPlan / flushPlan / handleTrackSteps /
    // handleGetPlanStatus / handleUpdatePlan。
    // opts 注入（对应 controller.js createController 作用域闭包变量）：
    //   agentSessionStore：plan 是 agent 专属功能，始终用 agentSessionStore（不用 getActiveStore）
    //   agentContextManager：getSessionId() 取当前会话 id
    //   getActivePlan / setPendingPlanSave / getPendingPlanSave：
    //     activePlan/_pendingPlanSave 为 createController 作用域共享可变状态（restorePlan/switchSession/
    //     beforeunload 等仍直接访问），经惰性 getter/setter 注入，运行时取值以保持原逻辑。
    function createPlanTracking(opts) {
        function persistPlan() {
            try {
                if (!opts.agentSessionStore || typeof opts.agentSessionStore.savePlan !== 'function') return;
                var sid = opts.agentContextManager.getSessionId();
                if (!sid) return;
                opts.setPendingPlanSave(opts.agentSessionStore.savePlan(sid, { steps: opts.getActivePlan().steps })
                    .catch(function (e) {
                        console.warn('[Agent] persistPlan failed: ' + (e && e.message || e));
                        return false;
                    }));
            } catch (e) {
                console.warn('[Agent] persistPlan error: ' + (e && e.message || e));
            }
        }

        async function flushPlan() {
            try {
                await opts.getPendingPlanSave();
            } catch (_) {}
            opts.setPendingPlanSave(Promise.resolve(false));
        }

        function handleTrackSteps(args) {
            return new Promise(function(resolve) {
                var steps = (args && args.steps && typeof args.steps === 'object' && typeof args.steps.length === 'number') ? args.steps : [];
                if (steps.length === 0) {
                    resolve({ success: false, isError: true, content: [{ type: 'text', text: 'trackSteps: steps is empty' }] });
                    return;
                }
                opts.getActivePlan().steps = steps;
                persistPlan();
                if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                    try { global.AEAgent.refreshList(); } catch (e) {}
                }
                resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'created', message: '任务清单已创建', steps: steps }) }] });
            });
        }

        function handleGetPlanStatus() {
            return new Promise(function(resolve) {
                var plan = opts.getActivePlan();
                if (!plan || !plan.steps || plan.steps.length === 0) {
                    resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'no_plan', message: '当前没有活跃的任务清单' }) }] });
                    return;
                }
                var summary = plan.steps.map(function(s) {
                    return { number: s.number, description: s.description, done: !!s._done, running: !!s._running, success: s._done ? !!s._success : null };
                });
                resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'active', steps: summary }) }] });
            });
        }

        function handleUpdatePlan(args) {
            return new Promise(function(resolve) {
                var plan = opts.getActivePlan();
                if (!plan || !plan.steps || plan.steps.length === 0) {
                    resolve({ success: false, isError: true, content: [{ type: 'text', text: 'No active plan to update' }] });
                    return;
                }

                var action = (args && args.action) || 'replace';
                var newSteps = (args && args.steps && typeof args.steps === 'object' && typeof args.steps.length === 'number') ? args.steps : [];
                var reason = (args && args.reason) || '';
                // mark_done/remove 容错：numbers 缺失时接受单值 number 回退。LLM 标记单个
                // 步骤常误传 number（与 mark_running 的参数形态混淆），无回退时空数组导致
                // 零步骤被标记却返回「已完成步骤已标记」的静默成功，LLM 无从纠错。
                var normNums = (args && args.numbers && typeof args.numbers === 'object' && typeof args.numbers.length === 'number')
                    ? args.numbers
                    : (args && typeof args.number === 'number' ? [args.number] : []);

                var draft = [];
                for (var si = 0; si < plan.steps.length; si++) {
                    var src = plan.steps[si];
                    draft.push({ number: src.number, description: src.description, tool: src.tool || '', args: src.args || null, _done: src._done, _success: src._success, _running: !!src._running });
                }

                if (action === 'replace' && newSteps.length > 0) {
                    var oldStepMap = {};
                    for (var oi = 0; oi < draft.length; oi++) {
                        oldStepMap[draft[oi].number] = draft[oi];
                    }
                    draft = [];
                    for (var rp = 0; rp < newSteps.length; rp++) {
                        var ns = newSteps[rp];
                        var num = ns.number || (rp + 1);
                        var old = oldStepMap[num];
                        draft.push({ number: num, description: ns.description || '', tool: ns.tool || '', args: ns.args || null,
                            _done: old ? old._done : false, _success: old ? old._success : false, _running: false });
                    }
                } else if (action === 'add' && newSteps.length > 0) {
                    for (var ad = 0; ad < newSteps.length; ad++) {
                        var an = newSteps[ad];
                        draft.push({ number: an.number || (draft.length + 1), description: an.description || '', tool: an.tool || '', args: an.args || null });
                    }
                } else if (action === 'remove') {
                    var removeIndices = normNums;
                    var removeSet = {};
                    for (var ri = 0; ri < removeIndices.length; ri++) { removeSet[Number(removeIndices[ri])] = true; }
                    draft = draft.filter(function(s) { return !removeSet[s.number]; });
                } else if (action === 'mark_done') {
                    var doneNums = normNums;
                    // 空列表直接报错（而非静默成功）：漏传序号时让 LLM 当轮拿到纠错反馈
                    if (doneNums.length === 0) {
                        resolve({ success: false, isError: true, content: [{ type: 'text', text: 'mark_done: 未指定步骤号（numbers 数组或单个 number），无步骤被标记' }] });
                        return;
                    }
                    var validNums = {};
                    for (var vi = 0; vi < draft.length; vi++) { validNums[draft[vi].number] = true; }
                    var doneSet = {};
                    var skipped = [];
                    for (var dn = 0; dn < doneNums.length; dn++) {
                        var dn2 = Number(doneNums[dn]);
                        if (validNums[dn2]) { doneSet[dn2] = true; }
                        else { skipped.push(dn2); }
                    }
                    var _markSuccess = args && typeof args.success === 'boolean' ? args.success : true;
                    for (var md = 0; md < draft.length; md++) {
                        if (doneSet[draft[md].number]) { draft[md]._done = true; draft[md]._success = _markSuccess; draft[md]._running = false; }
                    }
                    plan.steps = draft;
                    persistPlan();
                    if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                        try { global.AEAgent.refreshList(); } catch (e) {}
                    }
                    var doneSummary = draft.map(function(s) {
                        return { number: s.number, description: s.description, done: !!s._done, running: !!s._running, success: s._done ? !!s._success : null };
                    });
                    var msg = skipped.length > 0
                        ? '已完成步骤已标记。警告：步骤号 ' + skipped.join(',') + ' 不存在，已忽略。请调用 getPlanStatus 确认实际步骤编号。'
                        : '已完成步骤已标记';
                    resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'updated', message: msg, steps: doneSummary }) }] });
                    return;
                } else if (action === 'mark_running') {
                    var runNum = args && typeof args.number === 'number' ? args.number : null;
                    var runFound = false;
                    for (var ri2 = 0; ri2 < draft.length; ri2++) {
                        if (draft[ri2].number === runNum && !draft[ri2]._done) {
                            draft[ri2]._running = true;
                            runFound = true;
                        } else {
                            draft[ri2]._running = false;
                        }
                    }
                    plan.steps = draft;
                    persistPlan();
                    if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                        try { global.AEAgent.refreshList(); } catch (e) {}
                    }
                    resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'running', message: runFound ? '步骤 ' + runNum + ' 已标记为执行中' : '步骤号不存在或已完成', number: runNum }) }] });
                    return;
                } else if (action === 'clear') {
                    plan.steps = [];
                    persistPlan();
                    if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                        try { global.AEAgent.refreshList(); } catch (e) {}
                    }
                    resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'cleared', message: '计划已清空' }) }] });
                    return;
                }

                plan.steps = draft;
                persistPlan();
                if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                    try { global.AEAgent.refreshList(); } catch (e) {}
                }
                var summary = draft.map(function(s) {
                    return { number: s.number, description: s.description, done: !!s._done, success: s._done ? !!s._success : null };
                });
                resolve({ success: true, isError: false, content: [{ type: 'text', text: JSON.stringify({ status: 'updated', message: (reason || '计划已更新'), steps: summary }) }] });
            });
        }

        return { persistPlan: persistPlan, flushPlan: flushPlan, handleTrackSteps: handleTrackSteps, handleGetPlanStatus: handleGetPlanStatus, handleUpdatePlan: handleUpdatePlan };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createPlanTracking = createPlanTracking;
})(typeof global !== 'undefined' ? global : window);