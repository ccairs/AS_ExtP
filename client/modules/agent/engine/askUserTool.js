(function (global) {
    'use strict';
    // askUser：面板内 Agent 的阻塞式提问工具。

    //
    // 分层：
    //   · 交互面 = view.appendAskUser 的**输入区问答面板**：问答期间整块
    //     替换底部输入框，结算后面板收起、输入框恢复；提问不落消息流，消息流只留一行结果记录；
    //   · 等待结束条件 = 用户回答 / 取消 / 超时（settings.askUserTimeoutMs）/ 当前轮停止 /
    //     会话或模式切换；任一出口都必须结算面板，否则面板会永远停在问答态；
    //   · 通道判据 _askSupported() 只判**本 runtime 的身份**，不读调用方 ctx——工具注册表
    //     last-wins，handler 由执行者自己的绑定表解析（见 shared/toolRegistry.js 的
    //     createRuntimeToolRegistry 头注），闭包里的 deps 就是执行者那一份。
    //
    // 生效范围：单 Agent 三档（Agent/Script/Shader）+ 团队导演 lane。
    // 执行 lane / 团队主通道 / 子 Agent 看不到它（收窄判据见 team/lanes.js、
    // engine/bootstrap.js 的 _mkSubagentToolFilter、controller._buildRoundTools 的黑名单），
    // handler 里再判一次通道——两层都在，防「模型按名直调」与「装配顺序变了」两种漏法。

    var NAME = 'askUser';
    // 与 controller.js 注册处、team/lanes.js 与 engine/bootstrap.js 的剔除名单同源

    var MAX_QUESTION_CHARS = 500;
    var MAX_OPTIONS = 6;
    var MAX_OPTION_CHARS = 120;
    // 设置项缺席/非法时的兜底（engine/settings.js 的 DEFAULTS 是生产来源，这里只防
    // 「设置有洞」的调用方把它变成永久等待）。
    var DEFAULT_TIMEOUT_MS = 300000;

    var SCOPE = { type: 'module', moduleIds: ['agent', 'script', 'shader', 'team'] };

    var DESCRIPTION = '向用户提问并等待回答。当需求存在歧义、需要在多个方案中选择，或缺少只有用户能提供的信息时调用；能自行合理判断的不询问，不要替用户做选择。'
        + '参数：question=要问的问题（一句话，最多 500 字）；options=2–6 个候选项（可选，用户也可直接输入）；'
        + 'multi=是否多选（可选，true 时用户可勾选多个选项后提交；默认单选，点选项即回答）。'
        + '返回 JSON：status=answered 时 answer 是用户的回答（多选为拼接串，如「A、B」），'
        + 'answers 是全部回答项（勾选项在前、自由输入在后）；单选另带 optionIndex/optionText，多选另带 optionIndexes；'
        + 'status=timeout 表示用户在限定时间内没有回答；status=cancelled 表示用户取消或本轮停止、会话切换；'
        + 'status=unavailable 表示当前身份没有提问通道。非 answered 时不要原样重复提问。';
    var SHORT_DESCRIPTION = '向用户提问并等待回答（歧义/方案选择/缺信息时用，可单选或多选）';

    var INPUT_SCHEMA = {
        type: 'object',
        properties: {
            question: {
                type: 'string',
                description: '要问的问题（一句话，最多 500 字）。必须能独立读懂，不带指代'
            },
            options: {
                type: 'array',
                items: { type: 'string' },
                description: '候选项（可选，2–6 项，每项最多 120 字）。用户可点选，也可在输入框自由回答'
            },
            multi: {
                type: 'boolean',
                description: '是否多选（可选，默认 false）。true 时用户可勾选多个选项后点「回答」提交；'
                    + 'false/不传时点选项即回答。多选必须同时传 options'
            }
        },
        required: ['question']
    };

    function _trimText(v) {
        return (typeof v === 'string') ? v.replace(/^\s+|\s+$/g, '') : '';
    }

    function _toolText(payload) {
        var failed = !(payload && payload.status === 'answered');
        return {
            success: !failed,
            isError: failed,
            content: [{ type: 'text', text: JSON.stringify(payload) }]
        };
    }

    // 入参校验（单一实现；handler 与单测共用）。错误文案直接回给模型，故写成可执行的修正动作。
    function normalizeArgs(args) {
        var a = (args && typeof args === 'object') ? args : {};
        var question = _trimText(a.question);
        if (!question) {
            return { ok: false, message: 'question 不能为空：写一句要用户回答的问题。' };
        }
        if (question.length > MAX_QUESTION_CHARS) {
            return { ok: false, message: 'question 超过 ' + MAX_QUESTION_CHARS + ' 字：缩短为一句话再问。' };
        }
        var options = null;
        if (a.options !== undefined && a.options !== null) {
            if (!Array.isArray(a.options)) {
                return { ok: false, message: 'options 必须是字符串数组（2–6 项）；只问是非题时不要传 options。' };
            }
            var raw = [];
            for (var i = 0; i < a.options.length; i++) {
                var it = a.options[i];
                // 只收字符串/有限数字（模型偶发把 "1"/1 当选项传）；对象/数组/null 视为无文案，
                // 报文说清「不是可用文案」，不要把「类型不对」写成「为空」。
                var t = (typeof it === 'string') ? _trimText(it)
                    : ((typeof it === 'number' && isFinite(it)) ? String(it) : '');
                if (!t) {
                    return { ok: false, message: 'options 第 ' + (i + 1) + ' 项不是可用文案（每项须为非空字符串）。' };
                }
                if (t.length > MAX_OPTION_CHARS) {
                    return { ok: false, message: 'options 第 ' + (i + 1) + ' 项超过 ' + MAX_OPTION_CHARS + ' 字：缩短候选项文案。' };
                }
                raw.push(t);
            }
            if (raw.length < 2 || raw.length > MAX_OPTIONS) {
                return { ok: false, message: 'options 需要 2–' + MAX_OPTIONS + ' 项（当前 ' + raw.length + ' 项）；只问是非题时不要传 options。' };
            }
            options = raw;
        }
        // 多选开关：默认单选（点选项即答）；true 时面板显示勾选态、需点「回答」提交。
        // 多选没有候选项无法勾选 ⇒ 直接拒绝，别让面板落成一个只能自由输入的单选。
        var multi = false;
        if (a.multi !== undefined && a.multi !== null) {
            if (typeof a.multi !== 'boolean') {
                return { ok: false, message: 'multi 必须是布尔值：多选时传 true，单选不传或传 false。' };
            }
            multi = a.multi;
        }
        if (multi && !options) {
            return { ok: false, message: 'multi=true 需要同时传 options（2–' + MAX_OPTIONS + ' 项）：多选从候选项里勾选。' };
        }
        return { ok: true, question: question, options: options, multi: multi };
    }

    function _timeoutOf(settings) {
        var n = Number(settings && settings.askUserTimeoutMs);
        if (!isFinite(n) || n < 0) return DEFAULT_TIMEOUT_MS;
        return n;
    }

    function _cancelPayload(reason, timeoutSeconds) {
        if (reason === 'timeout') {
            return {
                status: 'timeout',
                reason: 'timeout',
                message: '用户在 ' + (timeoutSeconds || 0) + ' 秒内没有回答。可以换一种更具体的问法再问一次，'
                    + '或按合理假设继续并在结论里注明假设；不要原样重复同一个问题。'
            };
        }
        if (reason === 'stop') {
            return {
                status: 'cancelled',
                reason: 'stop',
                message: '本轮被中止，提问没有回答。'
            };
        }
        if (reason === 'session_changed') {
            return {
                status: 'cancelled',
                reason: 'session_changed',
                message: '会话或模式已切换，提问没有回答。'
            };
        }
        return {
            status: 'cancelled',
            reason: 'user',
            message: '用户取消了提问（没有回答）。不要原样重复提问；先完成已明确的部分，'
                + '把待确认项写进结论，或换一种更具体的问法。'
        };
    }

    // 工厂：deps.getView/getState/getSettings 必填，isTeamMode/isSubagent/getLaneId 可选
    //（缺省按单 Agent 路径处理）。返回可直接交给 toolRegistry.register 的完整定义。
    function createAskUserTool(deps) {
        var d = deps || {};
        var getView = (typeof d.getView === 'function') ? d.getView : function () { return null; };
        var getState = (typeof d.getState === 'function') ? d.getState : function () { return null; };
        var getSettings = (typeof d.getSettings === 'function') ? d.getSettings : function () { return null; };
        var isTeamMode = (typeof d.isTeamMode === 'function') ? d.isTeamMode : function () { return false; };
        var isSubagent = (typeof d.isSubagent === 'function') ? d.isSubagent : function () { return d.isSubagent === true; };
        var getLaneId = (typeof d.getLaneId === 'function') ? d.getLaneId : function () { return ''; };
        // 会话/停止轮询周期：只影响「切会话/切模式/停止」被发现的延迟（超时是独立定时器）。
        // 可注入是给单测缩短等待用的；生产不传即 500ms。
        var pollMs = (typeof d.pollIntervalMs === 'number' && d.pollIntervalMs > 0) ? d.pollIntervalMs : 500;

        // 通道判据（生效范围唯一的实现）：子 Agent 无用户；团队档只给导演。
        // 任一读法抛错都按「没有通道」收口（fail-closed，不弹任何东西）。
        function supports() {
            try {
                if (isSubagent()) return false;
                if (isTeamMode()) return getLaneId() === 'director';
            } catch (_) {
                return false;
            }
            return true;
        }

        // 提问面：身份与 UI 面都就绪才算有通道。缺一即 fail-closed（回 unavailable，
        // 不弹任何东西——把面板画到别的 lane 的输入区比拒绝更糟）。
        function channel() {
            if (!supports()) return null;
            var view = null;
            try { view = getView(); } catch (_) { view = null; }
            if (!view || typeof view.appendAskUser !== 'function') return null;
            return view;
        }

        function _sessionIdOf(execCtx) {
            try {
                if (execCtx && typeof execCtx.getActiveSessionId === 'function') return execCtx.getActiveSessionId() || '';
            } catch (_) { /* 回落空串：无会话判据时不做切换取消（超时仍兜底） */ }
            return '';
        }

        function _activeCmOf(execCtx) {
            try {
                if (execCtx && typeof execCtx.getActiveCm === 'function') return execCtx.getActiveCm() || null;
            } catch (_) { /* 同上 */ }
            return null;
        }

        function _stopOf(execCtx) {
            try {
                if (execCtx && typeof execCtx.getStopRequested === 'function') return !!execCtx.getStopRequested();
            } catch (_) { /* 读不到按未停止 */ }
            return false;
        }

        function handler(args, execCtx) {
            var na = normalizeArgs(args);
            if (!na.ok) {
                return Promise.resolve(_toolText({ status: 'invalid_args', message: na.message }));
            }
            var view = channel();
            if (!view) {
                return Promise.resolve(_toolText({
                    status: 'unavailable',
                    message: '当前身份没有向用户提问的通道（团队执行成员、团队主 Agent、子 Agent、外接客户端都不可用）。'
                        + '请自己做出合理假设并在结论里注明，或把待确认项写进结论。'
                }));
            }
            var card = null;
            try {
                card = view.appendAskUser({ question: na.question, options: na.options, multi: na.multi });
            } catch (e) {
                return Promise.resolve(_toolText({
                    status: 'unavailable',
                    message: '提问面板渲染失败: ' + String((e && e.message) || e)
                }));
            }
            if (!card || !card.decision || typeof card.decision.then !== 'function') {
                return Promise.resolve(_toolText({
                    status: 'unavailable',
                    message: '提问面板不可用（当前视图没有交互面）。请自己做出合理假设并在结论里注明。'
                }));
            }

            var state = null;
            try { state = getState(); } catch (_) { state = null; }
            var settings = null;
            try { settings = getSettings(); } catch (_) { settings = null; }
            var timeoutMs = _timeoutOf(settings);
            var timeoutSeconds = (timeoutMs > 0) ? Math.round(timeoutMs / 1000) : 0;
            var sid0 = _sessionIdOf(execCtx);
            var cm0 = _activeCmOf(execCtx);
            var signal = null;
            try { signal = (execCtx && typeof execCtx.getAbortSignal === 'function') ? execCtx.getAbortSignal() : null; } catch (_) { signal = null; }

            // 团队任务板按既有「等待确认」显示这条 lane 卡在用户处（orchestrator 的判据
            // 是 state.pendingConfirm；提问与权限确认都是「等用户」，共用一个位）。
            if (state) state.pendingConfirm = true;

            return new Promise(function (resolve) {
                var settled = false;
                var timer = null;
                var poll = null;

                function finish(outcome) {
                    if (settled) return;
                    settled = true;
                    if (timer) { clearTimeout(timer); timer = null; }
                    if (poll) { clearInterval(poll); poll = null; }
                    if (signal && typeof signal.removeEventListener === 'function') {
                        try { signal.removeEventListener('abort', onAbort); } catch (_) { /* 旧宿主无 removeEventListener 时忽略 */ }
                    }
                    if (state) {
                        state.pendingConfirm = false;
                    }
                    try {
                        // 无论哪条出口都先让面板结算：关面板、恢复输入区（面板自身点答/取消时
                        // 它已 settled，invalidate 是空操作）。不关的话面板会永远停在问答态。
                        if (typeof card.invalidate === 'function') {
                            card.invalidate(outcome.answered ? 'settled' : outcome.reason);
                        }
                    } catch (_) { /* 面板清理失败不影响回执：工具结果必须回喂模型 */ }
                    resolve(_toolText(outcome.payload));
                }

                function onAbort() {
                    finish({ answered: false, reason: 'stop', payload: _cancelPayload('stop') });
                }

                // 用户点选项/「回答」→ 面板 decision 结算
                card.decision.then(function (d) {
                    if (d && d.answered === true) {
                        var answers = Array.isArray(d.answers) ? d.answers.slice() : [];
                        var text = _trimText(d.text);
                        if (!text && answers.length) text = answers.join('、');
                        if (!text) {
                            // 空回答不该出现（面板对空提交不结算）；按取消收口，不回喂空回答
                            finish({ answered: false, reason: 'user', payload: _cancelPayload('user') });
                            return;
                        }
                        if (!answers.length) answers = [text];
                        var payload = { status: 'answered', question: na.question, answer: text, answers: answers };
                        if (na.multi) {
                            payload.multi = true;
                            payload.optionIndexes = Array.isArray(d.optionIndexes) ? d.optionIndexes.slice() : [];
                        } else {
                            payload.optionIndex = (typeof d.optionIndex === 'number') ? d.optionIndex : null;
                            payload.optionText = (typeof d.optionText === 'string' && d.optionText) ? d.optionText : null;
                        }
                        finish({ answered: true, payload: payload });
                        return;
                    }
                    var reason = (d && typeof d.reason === 'string' && d.reason) ? d.reason : 'user';
                    finish({ answered: false, reason: reason, payload: _cancelPayload(reason) });
                }, function () {
                    finish({ answered: false, reason: 'user', payload: _cancelPayload('user') });
                });

                if (signal && typeof signal.addEventListener === 'function') {
                    try { signal.addEventListener('abort', onAbort); } catch (_) { /* 见 removeEventListener 注释 */ }
                }
                if (signal && signal.aborted === true) { onAbort(); return; }

                if (timeoutMs > 0) {
                    timer = setTimeout(function () {
                        finish({ answered: false, reason: 'timeout', payload: _cancelPayload('timeout', timeoutSeconds) });
                    }, timeoutMs);
                }

                // 停止 / 切会话 / 切模式：管线用 Promise.race 先返回 stopped 时不会再调这里，
                // 故 handler 必须自己看见这些信号并结算面板（否则面板永远停在问答态）。
                poll = setInterval(function () {
                    if (settled) return;
                    if (_stopOf(execCtx)) { onAbort(); return; }
                    var sid = _sessionIdOf(execCtx);
                    if (sid0 && sid && sid !== sid0) {
                        finish({ answered: false, reason: 'session_changed', payload: _cancelPayload('session_changed') });
                        return;
                    }
                    var cm = _activeCmOf(execCtx);
                    if (cm0 && cm && cm !== cm0) {
                        finish({ answered: false, reason: 'session_changed', payload: _cancelPayload('session_changed') });
                    }
                }, pollMs);
            });
        }

        return {
            name: NAME,
            description: DESCRIPTION,
            shortDescription: SHORT_DESCRIPTION,
            input_schema: INPUT_SCHEMA,
            handler: handler,
            scope: SCOPE,
            stub: false,
            category: 'utility',
            source: 'agent'
        };
    }

    global.AEEngine = global.AEEngine || {};
    // 顶层面：与 goalTools 的 AEEngine.createGoalTools 同款（controller 构造期直接取工厂）。
    global.AEEngine.createAskUserTool = createAskUserTool;
    // 名字与默认值单独挂命名空间：team/lanes.js 与 engine/bootstrap.js 的收窄名单按名剔除
    //（跨文件唯一来源）。
    global.AEEngine.askUserTool = {
        NAME: NAME,
        SCOPE: SCOPE,
        DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
        normalizeArgs: normalizeArgs,
        createAskUserTool: createAskUserTool
    };
})(typeof window !== 'undefined' ? window : globalThis);
