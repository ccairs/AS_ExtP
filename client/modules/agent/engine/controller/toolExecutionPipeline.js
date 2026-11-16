(function (global) {
    'use strict';
    // Agent 工具调用执行管线拆分。由 controller.js 组装区经 AEEngine.createToolExecutionPipeline() 创建。
    // 纯迁移自 controller.js 内联的 executeToolCall
    // （stub 闸门 → 视觉能力闸门 → 门控不可用/当前轮投放清单闸门 → 静态校验 → 模型审查 →
    //   用户确认 → toolExecutor 执行）。
    // opts 注入（对应 controller.js createController 作用域闭包变量）：
    //   getModuleId / getStubToolNames / getVisionModelName / getVisionPlatform / getHasVisionProxy /
    //   getCurrentUserText / getActiveAbortController / getStopRequested / getSettings：
    //     可变或后定义闭包变量，经惰性 getter 注入，运行时取值以保持原逻辑。
    //   setStopPromiseResolve：stopPromiseResolve 为双向共享（本函数写入、requestStop 读取），经 setter 注入。
    //   argParsing / validator / view / permissionPolicy / toolExecutor / state：
    // 引擎已拆或注入的依赖。
    //   agentContextManager / scriptContextManager / shaderContextManager：三个模式的
    // contextManager，LLM 安全审查上下文按 execMode 在调用时惰性选取。

    // 视觉不可用提示（两处共用同一文案：调用期能力直查 + 门控原因表兜底）
    function visionUnavailableText(toolName) {
        return '当前模型不支持视觉分析，无法使用 ' + toolName
            + '。请切换至 Kimi K2.5 / Gemini / Claude 等视觉模型，或在模型管理面板配置视觉代理模型。';
    }

    // 「门控不可用」闸门的回喂文案（按投放侧 toolGating.gateReasonFor 的原因码取）：
    // 每条都给出「为什么不可用 + 下一步怎么办」，让 LLM 能如实向用户解释而不是反复重试。
    var GATE_REASON_MESSAGES = {
        WEB_SEARCH_DISABLED: function (name) {
            return '工具 "' + name + '" 当前不可用：模块设置里的「联网搜索」已关闭。'
                + '请如实告知用户可在 Agent 模块设置中开启「联网搜索」后再试；不要重复调用本工具。';
        },
        MODEL_NO_VISION: function (name) {
            return visionUnavailableText(name);
        },
        MODEL_NO_VIDEO: function (name) {
            return '当前模型不支持视频分析，无法使用 ' + name
                + '。请切换至支持视频的模型，或在模型管理面板配置视觉代理模型。';
        },
        MODE_BLACKLIST: function (name) {
            return '工具 "' + name + '" 在当前运行模式下不可用。请改用该模式下开放的工具，或如实告知用户需要切换模式。';
        },
        // lane 收窄（团队模式）：该工具不属于本 lane 的工具身份集合——导演不得
        // 直接执行 ExtendScript / 渲染 / 增删工具 / 撤销。文案要让 LLM 明确**转交**，而不是换名重试：
        // 这条判据只在投放侧过滤也能被 tool_search 绕开，故必须作为闸门（本表由投放侧同一份报告驱动）。
        // 「效果实现交给『GLSL 设计师』」这句话对
        // Shader lane 自己而言等于叫它交给自己（它现在也会被拒 AE 写工具），故只保留 AE 侧的转交指路。
        LANE_TOOL_DENIED: function (name) {
            return '工具 "' + name + '" 不属于当前 Agent 的职责范围，本次调用被拒绝。'
                + '需要修改 AE 工程的写操作请整理成任务交给「AE 执行」Agent；'
                + '不要重复调用本工具，也不要尝试用其它工具绕过。';
        },
        // ── 工具可见性闸口的原因码 ────────────────────────────
        // 这些码来自 gate.allReasons（唯一来源），与语义门控码分区：闸口原因优先。
        VIEW_LOCKED: function (name) {
            return '工具 "' + name + '" 属于特殊工具，只能在指定的 Agent 视图使用（当前视图不可用）。'
                + '请改用当前视图开放的工具，或如实告知用户需要切换视图；不要重复调用本工具。';
        },
        USER_DISABLED: function (name) {
            return '工具 "' + name + '" 已被用户在 Agent 模块设置的工具可见性里关闭（当前视图）。'
                + '请改用其它工具，或如实告知用户可在模块设置中重新开启；不要重复调用本工具。';
        },
        NOT_IN_VIEW: function (name) {
            return '工具 "' + name + '" 不在当前 Agent 视图的工具范围内，本次调用被拒绝。'
                + '请改用当前视图可用的工具；若确实需要它，请如实告知用户需要切换视图。';
        },
        DEPENDENCY_HIDDEN: function (name) {
            return '工具 "' + name + '" 依赖 tool_search，而当前视图已关闭 tool_search，故本次不可用。'
                + '请改用已注入完整定义的工具，或如实告知用户在 Agent 模块设置中重新开启 tool_search。';
        }
    };

    // 审查警告（valid=true 时的轻微问题）→ 确认卡片/结果回喂的统一形状。
    // 与 aeToolCreator._llmReview 的警告前缀一致（卡片里逐条渲染成「⚠️ …」）。
    // 无警告返回 null，调用方据此不建 reviewInfo（卡片上的「按审查意见修改」按钮
    // 也只在有警告时才渲染——没有内容可发）。
    function reviewWarningsInfo(warnings) {
        var list = Array.isArray(warnings) ? warnings : [];
        var out = [];
        for (var i = 0; i < list.length; i++) {
            var w = list[i];
            var text = (w && (w.message || w.code)) ? String(w.message || w.code) : '';
            if (text) out.push('⚠️ ' + text);
        }
        return out.length ? { ok: true, warnings: out } : null;
    }

    function createToolExecutionPipeline(opts) {
        // LLM 安全审查的上下文 cm 按当前运行模式在调用时惰性解析。
        // 固定用 agentContextManager（controller 组装时固化）时：Script/Shader 模式下
        // 审查请求把 agent 会话全部历史当上下文发给审查 LLM——当前模式会话上下文缺失
        // （审查质量退化），agent 会话很大时还浪费大量 token（跨模式污染；对照同族正确
        // 实现 scriptTools.js 用 scriptContextManager）。分发口径与 chatViewHelpers.
        // getActiveCm 同族：'script'→scriptContextManager、'shader'→shaderContextManager、
        // 其余（agent / 未传 execMode 的直调路径，见 toolGating.executeToolCallForLlm 的
        // agent 默认语义）→agentContextManager。execMode 是每次调用的运行时参数，
        // 必须在调用时解析，不得在组装时固化为单一 cm。
        function resolveReviewCm(execMode) {
            if (execMode === 'script' && opts.scriptContextManager) return opts.scriptContextManager;
            if (execMode === 'shader' && opts.shaderContextManager) return opts.shaderContextManager;
            return opts.agentContextManager;
        }

        // executeExtendScript 的「没有可执行代码」拒绝（code 缺失/空白/非字符串，或代码经编译门后
        // 只剩空白/分号）：同一族的假成功——AST 门对空串判 ok，宿主执行空脚本后回「执行成功，
        // 未返回结果」，卡片是绿的、LLM 以为脚本已生效并在其上叠加后续操作。
        // result 里带 code 字段：错误码只在 execResult.error 上，而落库/渲染取的是 result，
        // 不带进去用户在工具卡片的「返回」栏里看不到自己碰到的是哪一类。
        function _noExecutableCodeResult(message) {
            var parsed = { status: 'error', code: 'EMPTY_CODE', message: message };
            return { success: false, result: JSON.stringify(parsed, null, 2), error: 'EMPTY_CODE', parsed: parsed };
        }

        async function executeToolCall(toolCall, execMode) {
            const toolName = toolCall.function.name;
            // args 在 AST 门通过后会被替换为重发射产物（code 字段），故用 let
            var _argsRes = opts.argParsing.parseArgsResult(toolCall.function.arguments);
            let args = _argsRes.args;
            // 执行侧的工具身份：团队 lane 是**集合**（并联身份下 scope 校验按集合放行，
            // toolExecutor 已支持数组），单 Agent 路径仍是单串 ⇒ 行为逐字不变。
            // script 槽位恒用单串 'script'：script 模式的二级防线（scope 校验）依赖它，换集合会放行
            // module:agent 工具（与 `_buildRoundTools` 的 script 例外同源）。
            // **其余槽位 lane 集合优先**（实测缺陷）：glsl lane 的 slot 是 shader，
            // 若按 execMode 走单串，执行侧会退化成 'shader' 而投放侧用的是 ['shader','team']
            // ⇒ 投放侧投了 `team` 域工具（read_workspace）、执行侧却被 scope 拒（模型看得见、调用被拒）。
            var _laneIds = (typeof opts.getModuleIds === 'function') ? opts.getModuleIds() : null;
            if (!Array.isArray(_laneIds) || !_laneIds.length) _laneIds = null;
            var execModuleId = (execMode === 'script') ? 'script'
                : (_laneIds || ((execMode === 'shader') ? 'shader' : opts.getModuleId()));

            // stub 工具前置闸门：未通过 tool_search 获取参数定义的 stub 工具直接拒绝，
            // 回喂错误引导 LLM 先调 tool_search。解决 LLM 忽视提示词、盲猜参数的问题。
            // Agent 和 Script 模式均可能含 stub 工具（由工具定义的 stub 字段控制）。
            if (opts.getStubToolNames() && opts.getStubToolNames().has(toolName)) {
                if (!opts.state.searchedTools || !opts.state.searchedTools.has(toolName)) {
                    var _stubErrParsed = {
                        status: 'error',
                        message: '工具 "' + toolName + '" 是 stub 工具，参数 schema 未提供。' +
                            '必须先调用 tool_search(names: ["' + toolName + '"]) 获取参数定义后再调用。' +
                            '当前直接调用被拒绝，请勿猜测参数。'
                    };
                    return {
                        success: false,
                        result: JSON.stringify(_stubErrParsed, null, 2),
                        error: 'TOOL_NOT_SEARCHED',
                        parsed: _stubErrParsed
                    };
                }
            }

            var VISION_ONLY = { getPreviewFrame: true, read_image: true, getShaderPreview: true };
            // 视觉工具放行条件：主模型支持视觉，或配置了视觉代理模型（三个工具都走视觉代理路径）
            var _mainModelCanVision = !!(opts.getVisionModelName() && global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(opts.getVisionModelName(), opts.getVisionPlatform()));
            if (VISION_ONLY[toolName] && !(_mainModelCanVision || opts.getHasVisionProxy())) {
                return { success: false, result: JSON.stringify({ status: "error", message: visionUnavailableText(toolName) }, null, 2), error: 'MODEL_NO_VISION', parsed: { status: "error", message: "当前模型不支持视觉分析" } };
            }

            // ──「门控不可用」闸门（门控语义 = 不可用，不只是不可见）──
            // 投放侧 toolGating.buildLlmTools 收起的工具，执行侧同样拒绝。关掉开关只是
            // 降低可见性：模型凭历史轮次记住的名字按名直调照常执行（真机发现）。原因码来自
            // 投放侧同一判据（gateReasonFor）的报告，两处不会漂。
            // 顺序说明：视觉三件的 MODEL_NO_VISION 正常路径由上方检查先拦（提示更具体），
            // 此处是其兜底（构建期与调用期能力判定不一致时不漏网）。
            var _roundGateReasons = opts.state.roundGateReasons;
            if (_roundGateReasons && _roundGateReasons[toolName]) {
                var _gateMsg = GATE_REASON_MESSAGES[_roundGateReasons[toolName]]
                    ? GATE_REASON_MESSAGES[_roundGateReasons[toolName]](toolName)
                    : ('工具 "' + toolName + '" 当前不可用（原因: ' + _roundGateReasons[toolName] + '）。');
                var _gatedParsed = { status: 'error', message: _gateMsg };
                return { success: false, result: JSON.stringify(_gatedParsed, null, 2), error: _roundGateReasons[toolName], parsed: _gatedParsed };
            }

            // ──「当前轮投放清单」闸门：不在当前轮清单、且未经 tool_search 补全的工具拒绝 ──
            // 覆盖「被工具数量上限裁剪等情形下凭历史记忆直调」。searchedTools（tool_search 成功
            // 时写入、每轮从历史重建 ⇒ 跨轮有效）是"经 tool_search 补全"的既有唯一凭据，故
            // 补全过的照常放行（现有 stub 流程不受影响）。门控闸门在前 ⇒ tool_search 不能
            // 解锁被关闭的开关。两个集合为 null（未跑过工具循环的直调路径/测试桩）时放行（fail-open）。
            var _roundNames = opts.state.roundToolNames;
            if (_roundNames && !_roundNames.has(toolName)
                && !(opts.state.searchedTools && opts.state.searchedTools.has(toolName))) {
                var _nrMsg = '工具 "' + toolName + '" 不在本轮可用工具清单中。如确需使用，请先调用 '
                    + 'tool_search(names: ["' + toolName + '"]) 获取参数定义后再调用；'
                    + '若 tool_search 查不到该工具，说明它在当前模式下不可用，请改用其他方案或如实告知用户。';
                var _nrParsed = { status: 'error', message: _nrMsg };
                return { success: false, result: JSON.stringify(_nrParsed, null, 2), error: 'TOOL_NOT_IN_ROUND', parsed: _nrParsed };
            }

            // ── 入参解析失败：拒绝执行，不再静默降级成空参数 ──
            // safeParseArgs 对非法 JSON（截断 / 裸引号等 fixJsonStringControlChars 也修不了的）
            // 返回 {}，工具照常以空参数执行：executeExtendScript 的空代码能过 AST 门、宿主执行空脚本后
            // 回「执行成功，未返回结果」，于是卡片是绿的、LLM 也以为脚本已生效并在其上叠加后续操作
            // ——整段代码被丢弃却全程无人知晓。
            // 放在各可用性闸门之后：那些闸门有更具体的引导（先 tool_search / 换工具），
            // 此处只接管"本来会以空参数执行"的调用。空/缺省串不算失败（部分 provider 对无参工具发空串）。
            if (!_argsRes.ok) {
                var _argsErrParsed = {
                    status: 'error',
                    // code 透进 result：错误码只在 execResult.error 上，而落库/渲染取的是 result
                    //（用户在工具卡片的「返回」栏里要能看出碰到的是哪一类失败）
                    code: 'ARGS_PARSE_FAILED',
                    message: '工具入参不是合法 JSON，本次未执行。原始参数（最多截断展示 300 字符）：\n'
                        + _argsRes.raw.slice(0, 300)
                        + '\n请以上述结构为模板，用合法 JSON 重新调用该工具。'
                };
                return {
                    success: false,
                    result: JSON.stringify(_argsErrParsed, null, 2),
                    error: 'ARGS_PARSE_FAILED',
                    parsed: _argsErrParsed
                };
            }

            // AST 编译门（并入 staticValidate）：
            // executeExtendScript 的代码经 _runSandboxedScript 过门（source=agent-tool，
            // 三张表 fail-closed）。ES6 由 ES3 parser 精确行列拒绝（优于 staticValidate
            // 的 warning 级报错——两条通道的 ES6 处理在此合流）。拒绝理由结构化
            // 回喂 LLM 自改写（拒绝回路）；通过则 args.code 替换为重发射产物——自此刻起
            // LLM 审查、确认卡、执行所见即所执行（TOCTOU 消失：校验与执行同一份）。
            // AST 门产物行→原文行映射表（只有 executeExtendScript 过门，
            // 门通过后在块内赋值；其它工具/未过门恒 null）。toResult 用它把运行时错误行号映射
            // 回用户原文行（否则 resp.line 是 reemit 产物行，被直接透出）。
            var _gateLineMap = null;
            if (toolName === 'executeExtendScript' && global.AE_LLM
                && typeof global.AE_LLM._runSandboxedScript === 'function') {
                var _codeVal = (args && typeof args === 'object') ? args.code : undefined;
                // 空代码/非字符串代码不放行（与上面的解析失败同源：AST 门对空串判 ok，宿主执行空脚本后
                // 回「执行成功，未返回结果」→「代码缺失/为空」也成了绿色成功，LLM 据此以为脚本已生效）。
                // schema 里 action/code 都必填、code 是字符串：缺失/空白/非字符串（如 code:0）都是参数错误，
                // 回结构化原因让 LLM 补齐重发。args 可能是 null（arguments 字面量 "null" 解析而来）——按缺失处理。
                if (typeof _codeVal !== 'string' || !_codeVal.trim()) {
                    return _noExecutableCodeResult((args !== null && args !== undefined && typeof args !== 'object')
                        ? 'executeExtendScript 的 arguments 不是 JSON 对象（实际收到 ' + typeof args + '），本次未执行。请以 {"action":"…","code":"…"} 形式重新调用。'
                        : (_codeVal != null && typeof _codeVal !== 'string'
                            ? 'executeExtendScript 的 code 必须是字符串（实际收到 ' + typeof _codeVal + '），本次未执行。请把代码放进字符串后重新调用。'
                            : 'executeExtendScript 缺少可执行代码（code 缺失或为空），本次未执行。请补齐 code 参数后重新调用。'));
                }
                var _gateCode = String(_codeVal);
                var _gate = global.AE_LLM._runSandboxedScript(_gateCode, { source: 'agent-tool' });
                if (!_gate.ok) {
                    var _gateParsed = { status: 'rejected', message: _gate.llmText };
                    // 域拒绝附 error.domain（system/socket/file/menu）——
                    // LLM 可判知是能力域未开（而非逃逸形态），改写方向明确
                    if (_gate.error && _gate.error.domain) _gateParsed.domain = _gate.error.domain;
                    return {
                        success: false,
                        result: JSON.stringify(_gateParsed, null, 2),
                        error: 'AST_GATE: ' + _gate.displayText,
                        parsed: _gateParsed
                    };
                }
                // 门侧 AST 判据：产物里没有可执行语句（空块/空循环/只有注释或分号）时执行它等于
                // 什么都不做，而宿主同样回「执行成功」——按同一族假成功拦下。
                // 注意必须在 !_gate.ok 之后：门拒绝时返回体没有 emitted（也没有本字段）。
                if (_gate.noExecutableStatement === true) {
                    return _noExecutableCodeResult('executeExtendScript 的代码没有可执行语句（空块、空循环，或只含注释/分号），本次未执行。请给出实际要执行的语句后重新调用。');
                }
                // 产物替换（浅拷贝 args——不污染调用方对象）：downstream 审查/确认/执行
                // 全部面向重发射产物
                args = Object.assign({}, args, { code: _gate.emitted });
                // 产物行→原文行映射表：门通过后的替换产物即下游执行体，运行时 Error.line 以它为
                // 基准，故必须用同一份 lineMap 才能映射回原文。无锚点/旧门返回体没有该字段 → null。
                _gateLineMap = (_gate.lineMap && _gate.lineMap.length) ? _gate.lineMap : null;
                // bypass['agent-tool'] ON → 确认层停用（门照跑——
                // emitted=门产物、逃逸形态/成员白名单保持；核侧全开经注册端点
                // bootstrap bypassSource 接线）
                var _gateBypassed = _gate.bypassed === true;
            }

            // 审查警告的统一去向（_reviewInfo）：审查**通过但带 warnings**（轻微问题）时
            // 既随确认卡片展示给用户（可「按审查意见修改」退回 LLM），也随工具结果回喂。
            // 三个审查源就地填充（executeExtendScript / shader JS / createAETool 预审查），
            // 权限闸门与 toResult 两处读取——三者按工具名互斥，不会串味。
            // 缺口：只处理 !valid 分支，valid=true 的 warnings 整段丢弃
            // （既不显示也不回喂），而审查 prompt 明确要求轻微问题走 valid=true+warnings。
            var _reviewInfo = null;

            // LLM 安全审查（agentScriptReview，默认关）：仅 executeExtendScript，
            // 在 AST 门通过之后、权限确认之前。审查是一次性 LLM 调用
            // （validator.review → service.reviewScript → sendJson，无工具），不走工具循环，防递归。
            // 审查未通过：意见作为该工具的错误结果回喂 LLM 改写重试，不打断主循环；
            // 返回体带 reviewRejected 标记，工具调用记录里与普通执行失败区分显示。
            if (toolName === 'executeExtendScript' && opts.validator && typeof opts.validator.review === 'function') {
                var _rvSettings = typeof opts.getSettings === 'function' ? (opts.getSettings() || {}) : {};
                if (_rvSettings.agentScriptReview) {
                    var _rvCode = args && args.code != null ? String(args.code) : '';
                    // 审查前插入"正在审查"气泡，让用户看到执行态，避免误以为卡住。
                    // 审查结束后无论通过/失败都移除：通过则进入原流程（confirm/progress），失败由 state.messages 渲染 🛡 标记。
                    var _rvProgressEl = (opts.view && typeof opts.view.appendToolProgress === 'function')
                        ? opts.view.appendToolProgress(toolName, '正在安全审查', (args && args.action) ? args.action : '')
                        : null;
                    var _rvResult;
                    try {
                        _rvResult = await opts.validator.review(_rvCode, {
                            userMessage: opts.getCurrentUserText() || '',
                            contextMessages: opts.argParsing.filterContextForReview(resolveReviewCm(execMode).toLlmMessages()),
                            signal: opts.getActiveAbortController() && opts.getActiveAbortController().signal
                        });
                    } finally {
                        if (_rvProgressEl && opts.view && typeof opts.view.removeToolProgress === 'function') {
                            opts.view.removeToolProgress(_rvProgressEl);
                        }
                    }
                    // signal abort 导致的 MODEL_REVIEW_FAILED 不应诱导 LLM 重试：
                    // 区分"用户停止"与"审查调用失败"，避免 LLM 误判为临时错误去重试。
                    if (opts.getStopRequested() || (opts.getActiveAbortController() && opts.getActiveAbortController().signal.aborted)) {
                        return { success: false, result: JSON.stringify({ status: 'stopped', message: '已停止。' }) };
                    }
                    if (_rvResult && !_rvResult.valid) {
                        var _rvErrs = Array.isArray(_rvResult.errors) ? _rvResult.errors : [];
                        var _rvIsCallFailure = _rvErrs.some(function (e) { return e && e.code === 'MODEL_REVIEW_FAILED'; });
                        var _rvMsgText = _rvErrs.map(function (e) { return e && e.message ? e.message : ''; }).filter(Boolean).join('；') || '未给出具体原因';
                        var _rvFeedback = _rvIsCallFailure
                            ? 'LLM 安全审查调用失败（' + _rvMsgText + '），代码未执行。可稍后重试；如持续失败，请在模块设置中关闭「工具代码审查」。'
                            : 'LLM 安全审查未通过：' + _rvMsgText + '。请根据审查意见修正代码后重新调用 executeExtendScript，不要原样重试。';
                        var _rvParsed = {
                            status: 'error',
                            message: _rvFeedback,
                            reviewRejected: true,
                            riskLevel: _rvResult.riskLevel || ''
                        };
                        return { success: false, result: JSON.stringify(_rvParsed, null, 2), error: 'MODEL_REVIEW_REJECTED: ' + _rvMsgText, parsed: _rvParsed, reviewRejected: true };
                    }
                    // 审查通过但带警告（轻微问题）：进确认卡片 + 随结果回喂（见 _reviewInfo 注释）
                    _reviewInfo = reviewWarningsInfo(_rvResult && _rvResult.warnings);
                }
            }

            // shader 模式 JS 效果：静态危险代码预检（始终开启）在 LLM 审查之前确定性拦截，
            // 明显危险代码（eval/网络/命令执行/沙箱逃逸等）直接拒绝，不浪费 LLM 审查调用。
            // 与脚本模式 executeExtendScript 的门预检→review 顺序一致。
            var _isShaderJsTool = toolName === 'submit_js_effect'
                || (toolName === 'shader_library' && args && args.mode === 'save' && args.type === 'js');
            if (_isShaderJsTool && global.AEJsExecutor && typeof global.AEJsExecutor.precheckJsEffect === 'function') {
                var _shStaticCode = args && args.code != null ? String(args.code) : '';
                var _shStatic = global.AEJsExecutor.precheckJsEffect(_shStaticCode);
                if (!_shStatic.valid) {
                    var _shStaticMsg = (_shStatic.errors || []).map(function (e) { return e.message; }).join('；');
                    var _shStaticParsed = { status: 'error', message: 'shader JS 效果预检未通过，已拒绝: ' + _shStaticMsg };
                    return { success: false, result: JSON.stringify(_shStaticParsed, null, 2), error: 'STATIC_VALIDATION: ' + _shStaticMsg, parsed: _shStaticParsed };
                }
            }

            // shader 模式 JS 效果安全审查（shaderJsReview，默认开）：submit_js_effect /
            // shader_library 写 .js 在静态预检通过之后、执行/写入之前。审查是一次性 LLM 调用
            // （validator.reviewShaderJs → service.reviewScript mode='shader' → 专用 prompt），
            // 不走工具循环，防递归。拦截静态黑名单绕不过的混淆/拼接绕过。
            if (_isShaderJsTool && opts.validator && typeof opts.validator.reviewShaderJs === 'function') {
                var _shSettings = typeof opts.getSettings === 'function' ? (opts.getSettings() || {}) : {};
                if (_shSettings.shaderJsReview) {
                    var _shCode = args && args.code != null ? String(args.code) : '';
                    var _shProgressEl = (opts.view && typeof opts.view.appendToolProgress === 'function')
                        ? opts.view.appendToolProgress(toolName, '正在安全审查', '')
                        : null;
                    var _shResult;
                    try {
                        _shResult = await opts.validator.reviewShaderJs(_shCode, {
                            userMessage: opts.getCurrentUserText() || '',
                            contextMessages: opts.argParsing.filterContextForReview(resolveReviewCm(execMode).toLlmMessages()),
                            signal: opts.getActiveAbortController() && opts.getActiveAbortController().signal
                        });
                    } finally {
                        if (_shProgressEl && opts.view && typeof opts.view.removeToolProgress === 'function') {
                            opts.view.removeToolProgress(_shProgressEl);
                        }
                    }
                    if (opts.getStopRequested() || (opts.getActiveAbortController() && opts.getActiveAbortController().signal.aborted)) {
                        return { success: false, result: JSON.stringify({ status: 'stopped', message: '已停止。' }) };
                    }
                    if (_shResult && !_shResult.valid) {
                        var _shErrs = Array.isArray(_shResult.errors) ? _shResult.errors : [];
                        var _shIsCallFailure = _shErrs.some(function (e) { return e && e.code === 'MODEL_REVIEW_FAILED'; });
                        var _shMsgText = _shErrs.map(function (e) { return e && e.message ? e.message : ''; }).filter(Boolean).join('；') || '未给出具体原因';
                        var _shFeedback = _shIsCallFailure
                            ? 'shader JS 效果安全审查调用失败（' + _shMsgText + '），代码未执行。可稍后重试；如持续失败，请在模块设置中关闭「Shader JS 审查」。'
                            : 'shader JS 效果安全审查未通过：' + _shMsgText + '。请根据审查意见修正代码后重新调用，不要原样重试。';
                        var _shParsed = {
                            status: 'error',
                            message: _shFeedback,
                            reviewRejected: true,
                            riskLevel: _shResult.riskLevel || ''
                        };
                        return { success: false, result: JSON.stringify(_shParsed, null, 2), error: 'MODEL_REVIEW_REJECTED: ' + _shMsgText, parsed: _shParsed, reviewRejected: true };
                    }
                    // 审查通过但带警告（轻微问题）：进确认卡片 + 随结果回喂（见 _reviewInfo 注释）。
                    // submit_js_effect 仅在带 name（落库写盘）时登记了确认策略（permissions.js
                    // CONFIRM_COND）才会走到卡片；无 name（只预览）路径没有确认卡片，
                    // 警告靠结果注入这一条通路。
                    _reviewInfo = reviewWarningsInfo(_shResult && _shResult.warnings);
                }
            }

            // 权限闸门：balanced/conservative 档下危险工具在聊天流内等用户确认（非弹窗）。
            // 确认卡片即"工具执行条目"的待确认形态：批准后原地变形为进度条目，拒绝则变形为
            // 🚫 一行记录；全程只占一个条目位。被拒时把**拒绝原因**作为工具结果回喂 LLM，不打断
            // 循环——原因是"用户拒绝"还是"本通道没有确认面"（子 Agent 等无 UI 调用方）由下面
            // _noConfirmChannel 分派，不许一律写成前者。
            // bypass['agent-tool'] ON → executeExtendScript 确认层停用
            //（通道信任=免打扰；门照跑，硬拒核侧照拦）
            var _gateEl = null;
            if (opts.permissionPolicy && !_gateBypassed) {
                var _permSettings = typeof opts.getSettings === 'function' ? (opts.getSettings() || {}) : {};
                if (opts.permissionPolicy.needsConfirmation(_permSettings.permissionMode, toolName, args)) {
                    // createAETool 预审查：在确认弹窗前执行 LLM 审查，结果展示在确认弹窗中
                    // （_reviewInfo 声明在审查块之前——与 executeExtendScript / shader 两条共用）
                    if (toolName === 'createAETool' && global.AE_LLM && global.AE_LLM.aeToolCreator
                        && typeof global.AE_LLM.aeToolCreator.reviewToolCreation === 'function') {
                        // 审查前插入"正在审查"气泡，让用户看到执行态，避免误以为卡住。
                        // 审查结束后无论通过/失败都移除：通过则进入 appendToolConfirm 显示，失败由 return 触发 state.messages 渲染。
                        var _toolReviewProgressEl = (opts.view && typeof opts.view.appendToolProgress === 'function')
                            ? opts.view.appendToolProgress(toolName, '正在审查工具定义')
                            : null;
                        try {
                            _reviewInfo = await global.AE_LLM.aeToolCreator.reviewToolCreation(args);
                        } catch (reviewErr) {
                            _reviewInfo = { ok: false, errors: ['审查请求异常: ' + (reviewErr && reviewErr.message ? reviewErr.message : String(reviewErr))] };
                        } finally {
                            if (_toolReviewProgressEl && opts.view && typeof opts.view.removeToolProgress === 'function') {
                                opts.view.removeToolProgress(_toolReviewProgressEl);
                            }
                        }
                        // 审查失败直接拒绝，不弹确认
                        if (!_reviewInfo || !_reviewInfo.ok) {
                            var _reviewErrors = (_reviewInfo && _reviewInfo.errors) ? _reviewInfo.errors : ['未知审查错误'];
                            var _reviewErrParsed = { status: 'error', message: '工具审查未通过：\n' + _reviewErrors.join('\n') };
                            return { success: false, result: JSON.stringify(_reviewErrParsed, null, 2), error: 'REVIEW_REJECTED', parsed: _reviewErrParsed };
                        }
                        // 审查通过状态由 aeToolCreator 内部 _preReviewed 闭包变量记录，
                        // createAETool 据此跳过重复审查，无需通过 args 传递（防 LLM 注入绕过）
                    }

                    // 确认通道的有无是本轮文案的判据：
                    //   有确认面  → appendToolConfirm 在场并返回句柄（真 UI），批准/否决/超时才有意义；
                    //   没有确认面 → 函数缺席（无 UI 上下文的调用方）**或**函数返回空
                    //     （子 Agent 的 view 桩 appendToolConfirm 恒返回 null——见
                    //     engine/bootstrap.js 的 _mkSubagentViewStub，有意 fail-closed）。
                    // 后一种情形下 "默认拒" 不是 "用户否决"：那里根本没有用户在跟这条对话交互，
                    // 回执写「用户拒绝…请与用户确认后再试」会把模型送进等一个永远不来的用户的重试环。
                    var _hasConfirmChannel = !!(opts.view && typeof opts.view.appendToolConfirm === 'function');
                    var _pending = _hasConfirmChannel
                        ? opts.view.appendToolConfirm(toolName, args, _reviewInfo,
                            opts.permissionPolicy && typeof opts.permissionPolicy.allowSessionSkip === 'function'
                                ? opts.permissionPolicy.allowSessionSkip(toolName, args)
                                : true)
                        : null;
                    var _noConfirmChannel = !_pending;   // 真拿到确认句柄才算有确认面
                    // 确认等待不无限阻塞——超时默认拒绝 + 停止可中断。
                    // 复用 stopPromiseResolve 槽位让「停止」按钮能打断确认；超时由
                    // permissionConfirmTimeoutMs 控制（0 表示禁用超时）。
                    var _decision = { approved: false };
                    if (_pending) {
                        // 任务板「等待确认」：orchestrator 的 _awaitingConfirm 只认
                        // `state.pendingConfirm === true` / `state.toolCallInProgress.awaitingConfirm`，
                        // 而**全仓没有写入点**时 ⇒ 板上的 lane 状态永远是 tool/thinking：确认卡在场时
                        // 实测 board=tool、pendingConfirm=undefined，用户在别的 lane 界面里根本看不出
                        // 有一条 Agent 卡在等他点「允许」（30s 窗口一到就默认拒绝——真机连撞五轮）。
                        // 这里写/清这一位，让既有 UI（.team-board-dot.is-confirm + 「等待确认」文案）活起来。
                        if (opts.state) opts.state.pendingConfirm = true;
                        var _confirmTimeoutMs = Number(_permSettings && _permSettings.permissionConfirmTimeoutMs) || 0;
                        var _confirmTimer = null;
                        var _stopAwait = new Promise(function (resolve) {
                            // 停止时 requestStop 会调用 stopPromiseResolve，据此中断确认
                            opts.setStopPromiseResolve(function () {
                                resolve({ approved: false, stopped: true });
                            });
                            if (_confirmTimeoutMs > 0) {
                                _confirmTimer = setTimeout(function () {
                                    resolve({ approved: false, timedOut: true });
                                }, _confirmTimeoutMs);
                            }
                        });
                        try {
                            _decision = await Promise.race([_pending.decision, _stopAwait]);
                        } finally {
                            if (_confirmTimer) clearTimeout(_confirmTimer);
                            if (opts.state) opts.state.pendingConfirm = false;   // 与写入成对：任何出口都清
                            opts.setStopPromiseResolve(null);
                        }
                    }
                    // 兜底：即使 UI 异常仍提交 skip，强制确认/不可逆操作（删除/创建/写盘）不记录
                    if (_decision && _decision.skipSession
                        && (!opts.permissionPolicy || typeof opts.permissionPolicy.allowSessionSkip !== 'function'
                            || opts.permissionPolicy.allowSessionSkip(toolName, args))) {
                        opts.permissionPolicy.skipForSession(toolName, args);
                    }
                    // 按审查意见退回修改（确认卡片第三选项，审查有警告时才渲染）：
                    // 既不执行也不创建，把审查问题原样交回 LLM，用户不必手动复述。
                    // 与拒绝分成两个错误码：拒绝只回「用户拒绝」，LLM 无从知道要改什么。
                    // 可达性：卡片第三选项只在审查警告时渲染，故 createAETool（预审查）、
                    // executeExtendScript（agentScriptReview）、shader_library save（shaderJsReview）
                    // 三条审查路径都可能走到这里——文案按工具口径分派。
                    if (_decision && _decision.revise) {
                        if (_pending && _pending.el && opts.view && typeof opts.view.markToolRevisionRequested === 'function') {
                            // 第三参数同拒绝路径（优先 action）；createAETool 回落到 args.name——
                            // 该工具名恒定，只有被创建工具的名字能说明哪个定义被退回（回看审计痕迹）
                            var _revLabel = (args && args.action) ? args.action
                                : ((toolName === 'createAETool' && args && args.name) ? String(args.name) : '');
                            opts.view.markToolRevisionRequested(_pending.el, toolName, _revLabel);
                        }
                        // 结算 pending 的确认 decision（与拒绝路径同款：避免超时/退回后闭包长期挂起）
                        if (_pending && typeof _pending.invalidate === 'function') {
                            _pending.invalidate();
                        }
                        var _revWarnings = (_reviewInfo && _reviewInfo.warnings && _reviewInfo.warnings.length)
                            ? _reviewInfo.warnings
                            : [];
                        // 「没做什么」按工具口径：createAETool 不落盘、executeExtendScript 不执行
                        var _revNoOp = toolName === 'createAETool' ? '，未创建任何工具'
                            : (toolName === 'executeExtendScript' ? '，代码未执行' : '');
                        var _revMsg = '用户要求按审查意见修改后重试：' + toolName + ' 未执行' + _revNoOp + '。\n'
                            + 'LLM 审查发现的问题：\n'
                            + (_revWarnings.length
                                ? _revWarnings.map(function (w) { return '  - ' + w; }).join('\n')
                                : '  - （本次未记录到具体问题条目）')
                            + '\n请逐条针对上述问题修改后重新调用 '
                            + toolName + '。不要原样重试。';
                        var _revParsed = { status: 'error', message: _revMsg };
                        return { success: false, result: JSON.stringify(_revParsed, null, 2), error: 'USER_REQUESTED_REVISION', parsed: _revParsed };
                    }
                    if (!_decision || !_decision.approved) {
                        if (_pending && _pending.el && opts.view && typeof opts.view.markToolRejected === 'function') {
                            opts.view.markToolRejected(_pending.el, toolName, (args && args.action) ? args.action : '');
                        }
                        // 结算 pending 的确认 decision，避免超时/拒绝/停止后闭包长期挂起、迟到点击被忽略
                        if (_pending && typeof _pending.invalidate === 'function') {
                            _pending.invalidate();
                        }
                        // 归因按**通道的有无**分派：没有确认面时如实说没有确认面，
                        // 不把「本通道无法产生用户确认」写成「用户拒绝」（子 Agent 那里没有用户）。
                        var _rejReason = _decision && _decision.stopped
                            ? '已停止'
                            : (_decision && _decision.timedOut ? '等待确认超时（限定时间内未确认）'
                                : (_noConfirmChannel
                                    ? (_hasConfirmChannel
                                        ? '本次调用没有确认通道（确认请求未能呈现，确认面不可用），需用户确认的调用一律拒绝'
                                        : '当前身份没有确认通道，需用户确认的调用一律拒绝')
                                    : '用户拒绝'));
                        // 带 name 的 submit_js_effect 被拒时额外如实说明「零写盘」：该调用的确认点
                        // 正是效果库归档（permissions.js _submitJsEffectNeedsConfirm），只说「未执行」
                        // 不够直白——模型/用户要能确定效果库没有被写入任何文件。
                        var _rejNoWrite = (toolName === 'submit_js_effect' && args && args.name)
                            ? '效果库未写入任何文件；'
                            : '';
                        // 自纠建议也按通道分派：没有确认面时「与用户确认后再试」是无路可走的建议
                        //（这条对话里没有用户），只会换来原样重试。
                        var _rejTail = _noConfirmChannel
                            ? '本通道没有用户确认面，原样重试不会有不同结果：'
                                + '请改用只读工具核对，或把「需要用户确认后才能继续」写进结论交回上级。'
                            : '请与用户确认后再试，或改用其他方案。';
                        var _rejParsed = { status: 'error', message: _rejReason + '，' + _rejNoWrite + toolName + ' 未执行。' + _rejTail };
                        return { success: false, result: JSON.stringify(_rejParsed, null, 2), error: 'USER_REJECTED', parsed: _rejParsed };
                    }
                    _gateEl = _pending ? _pending.el : null;
                    if (_gateEl && opts.view && typeof opts.view.markToolProgressRunning === 'function') {
                        opts.view.markToolProgressRunning(_gateEl, toolName, (args && args.action) ? args.action : '');
                    }
                }
            }

            // 工具结果兜底截断：防异常大结果一次性撑爆上下文/内存。截断时保留头尾并显式标注。
            // 上限按 **token 预算**定（中文 1 字符 ≈ 1 token）：32K 字符在最小推荐档（128K）
            // 占约 25%，单条结果不可能独自清空历史。
            // 上限不取 128K/头 96K/尾 16K：单条顶格中文结果在 128K 档
            // 约占 90%，同轮再来一条 3 万字结果就把历史清空（压缩只在每轮开头检查，同轮连续
            // 落库的结果无人过问）。
            // **作用面**：这条兜底只在面板 agent/script/shader 三个
            // 工具循环里生效（管线才是它的调用方）。**外接 MCP 通道不经过本管线**
            // （extBridgeClient 直调 toolExecutor.execute，回包直接转发），它只受外部客户端
            // 自己的预算约束——不要按"这条兜底管着外接"来做判断。
            // 与之配套的**跨层不等式**（分页工具必须保证"一页"进不了这道兜底）：
            //   ① 单页**原始字符**上限低于本阈值（readFile 20000、read_tool_result 20000）；
            //   ② 单页**序列化后**长度也自守一道预算（两者各 24K）——JSON 转义会放大体积
            //      （引号/反斜杠/换行 ×2、控制字符 \uXXXX ×6），实测 20000 字符的满页在转义密集
            //      内容里到 40085，①单独挡不住。
            // 两者都有断言钉住（分页工具侧与平台写工具侧），
            // 改动时必须一起改。
            var MAX_TOOL_RESULT_CHARS = 32 * 1024;
            var TOOL_RESULT_HEAD = 24 * 1024;
            var TOOL_RESULT_TAIL = 8 * 1024;
            // 强制扁平拷贝：V8 的
            // `String.prototype.slice` 产出 **SlicedString**——它保留**父串**，于是「截断到 32K」
            // 并不释放内存：实测 20 条 1.95M 字符结果截断后常驻 **37.3MB**（可见文本仅 640K 字符），
            // 而扁平拷贝同规模仅 **0.1MB**（305×）。这些字符串会进 `state.messages` 的 UI 历史
            // （头部被 prune 也保留原条目），故常驻 ≈ Σ 每条结果**原始**字符数（每轮 4 条×200K → 500 轮≈400MB）。
            // split('')/join('') 一趟即产出新的扁平字符串；只作用于已截断的 ≤32K 结果，开销可忽略。
            // （另三种手法 split/join、JSON 往返、charAt 拼接、Buffer 往返实测同样有效，取无环境依赖者。）
            var _flattenStr = function (s) { return s.split('').join(''); };
            var toResult = function (resp, gateLineMap) {
                var resultStr = '';
                if (resp.content) {
                    var parts = [];
                    var content = resp.content;
                    if (Array.isArray(content)) {
                        for (var ci = 0; ci < content.length; ci++) {
                            if (content[ci] && content[ci].type === 'text') {
                                var txt = content[ci].text;
                                if (txt && typeof txt !== 'string') {
                                    try { txt = JSON.stringify(txt); } catch (_) { txt = String(txt); }
                                }
                                parts.push(txt);
                            }
                        }
                    }
                    resultStr = parts.join('\n');
                } else {
                    resultStr = resp.result || '';
                }
                if (resultStr.length > MAX_TOOL_RESULT_CHARS) {
                    // 豁免：getShaderPreview 超限部分仅来自合法 imageDataUrl 的结果（截图 base64 内嵌
                    // 工具结果）。该字段从不进入发给 LLM 的文本（controller 仅对 getShaderPreview 剔除
                    // imageDataUrl 后才推入 messages），仅由 vision hook 消费注入图片——截断它只会破坏
                    // JSON 结构，使 controller 剔除逻辑与 vision hook 双双解析失败（图片不注入 + 半截
                    // base64 文本灌给 LLM）。豁免按工具名限定：其他工具（如 MCP）返回同形态大 JSON 时
                    // 无人剔除字段，完整 base64 会直接灌进 messages（token 爆炸），须照常截断；
                    // 剥离该字段后仍超限（混合巨量其他载荷）也照常截断，防借字段绕过兜底防线。
                    var _exemptImage = false;
                    if (toolName === 'getShaderPreview') {
                        try {
                            var _over = JSON.parse(resultStr);
                            if (_over && typeof _over.imageDataUrl === 'string'
                                && _over.imageDataUrl.indexOf('data:image/') === 0
                                && (resultStr.length - _over.imageDataUrl.length) < MAX_TOOL_RESULT_CHARS) {
                                _exemptImage = true;
                            }
                        } catch (_) {}
                    }
                    if (!_exemptImage) {
                        var _origLen = resultStr.length;
                        // 暂存完整结果再截断：执行类工具（executeExtendScript）与外部 MCP 工具**不能重跑**
                        // 去取下一页（重跑会二次产生副作用），故给模型一个只读副本 + read_tool_result 翻页。
                        // 暂存失败（超单条上限/不可用）→ 回退老提示（改用分页参数），不让模型以为能读全。
                        var _storedId = null;
                        if (opts.toolResultStore && typeof opts.toolResultStore.put === 'function') {
                            try {
                                _storedId = opts.toolResultStore.put(resultStr, {
                                    toolName: toolName,
                                    sessionId: typeof opts.getActiveSessionId === 'function' ? opts.getActiveSessionId() : ''
                                });
                            } catch (_) {}
                        }
                        resultStr = _flattenStr(resultStr.slice(0, TOOL_RESULT_HEAD)
                            + '\n\n[工具结果过大已截断：原始 ' + _origLen + ' 字符，此处保留头部 ' + TOOL_RESULT_HEAD + ' + 尾部 ' + TOOL_RESULT_TAIL + ' 字符，中间省略]\n'
                            + (_storedId
                                ? '[完整内容已暂存为 resultId=' + _storedId + '（共 ' + _origLen + ' 字符）：用 read_tool_result 分页读取，不会重新执行该工具]\n'
                                : '[该工具单次返回数据量异常，请改用分页参数（offset/limit/startLine/endLine 等）精确读取所需部分]\n')
                            + '\n'
                            + resultStr.slice(_origLen - TOOL_RESULT_TAIL));
                    }
                }
                var parsed;
                try { parsed = JSON.parse(resultStr || '{}'); } catch (_) {
                    // 非 JSON 纯文本：仅当存在明确失败信号（success=false / isError / error 字段）才标 error。
                    // 一律包装成 status:error 时，导致 queryAeApi/memory/素材库等返回纯文本的成功
                    // 结果被误报为错误（"查到数据却报 error"），误导 LLM 判断。
                    parsed = (resp.success === false || resp.isError === true || !!resp.error)
                        ? { status: "error", message: resultStr }
                        : { status: "success", message: resultStr };
                }
                // 执行核的宿主拒绝文案（[AE_LLM] executeExtendScript 拒绝/…）经 AEHostErrors 映射：
                // zh 逐字节不变，en 变英文。只改 message 文案，结果结构、状态与数值不动；
                // 该串同时回喂模型，口径与其它宿主消息一致（模型侧接受英文）。
                if (toolName === 'executeExtendScript' && parsed && typeof parsed === 'object'
                    && !Array.isArray(parsed) && typeof parsed.message === 'string'
                    && global.AEHostErrors && typeof global.AEHostErrors.localize === 'function') {
                    parsed.message = global.AEHostErrors.localize(parsed.message);
                }
                // 审查警告随结果回喂 LLM：审查通过但带轻微问题的路径，用户若直接批准，
                // 警告只有这一条通路能到达 LLM（submit_js_effect 等无确认卡片的工具连
                // 展示机会都没有）。只注入解析后的普通对象——数组/标量/纯文本保持原语义，
                // 不包装不改写（executeExtendScript 的返回值是脚本自己的数据，形态不动）。
                if (_reviewInfo && _reviewInfo.warnings && _reviewInfo.warnings.length
                    && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    parsed.reviewWarnings = _reviewInfo.warnings.slice();
                }
                // 运行时错误行号透传 + 口径标注。handler 的 resp.line 是已减去 new Function
                // 包装偏移的 AST 门 reemit 产物行（1-based）。有 gateLineMap 时先映射回原文行
                //（mapProductLine 无锚点返回 0），映射成功才采用，否则保留产物行；回喂 LLM 的
                // result 串同时带 lineBasis 标明口径：
                //   'source' = 已映射回用户原文行；'emitted' = 未映射（无 lineMap/映射失败）的产物行。
                // parsed 自带 line 一般不覆盖（基准由该工具定义）；executeExtendScript 例外——
                // 核 catch 恒在回执自带产物行，有 gateLineMap 时该自带行就是产物行，照映射。
                // 其它错误分支（EMPTY_CODE / 各类门拒绝 / 审查拒绝）是管线自己生成的对象，不经
                // handler，没有 resp.line，不补假值。
                if (resp && typeof resp.line === 'number' && isFinite(resp.line)
                    && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                    var _execSelfLine = (toolName === 'executeExtendScript' && gateLineMap
                        && typeof parsed.line === 'number' && isFinite(parsed.line)) ? parsed.line : null;
                    if (parsed.line === undefined || _execSelfLine !== null) {
                        var _productLine = (_execSelfLine !== null) ? _execSelfLine : resp.line;
                        var _sourceLine = 0;
                        if (gateLineMap && global.AEGate
                            && typeof global.AEGate.mapProductLine === 'function') {
                            try { _sourceLine = global.AEGate.mapProductLine(gateLineMap, _productLine); } catch (_) { _sourceLine = 0; }
                            if (typeof _sourceLine !== 'number' || !isFinite(_sourceLine)) _sourceLine = 0;
                        }
                        if (_sourceLine > 0) {
                            parsed.line = _sourceLine;
                            parsed.lineBasis = 'source';
                        } else {
                            parsed.line = _productLine;
                            parsed.lineBasis = 'emitted';
                        }
                    }
                }
                return { success: resp.success, result: JSON.stringify(parsed, null, 2), error: (resp.error || (resp.isError ? resultStr : '')), parsed: parsed };
            };

            if (opts.toolExecutor && typeof opts.toolExecutor.call === 'function') {
                // 延迟显示 progress 气泡：只在工具执行超过 150ms 时才插入 DOM。
                // 快速完成的工具（<150ms）不插入气泡，避免闪现后立即移除造成视觉闪烁。
                // 经确认放行的调用复用确认条目（已原地变形为进度形态），不再另起气泡。
                var progressEl = _gateEl || null;
                var progressTimer = null;
                if (!_gateEl && opts.view.appendToolProgress) {
                    var _progAction = (args && args.action) ? args.action : '';
                    progressTimer = setTimeout(function () {
                        progressEl = opts.view.appendToolProgress(toolName, null, _progAction);
                    }, 150);
                }

                var stopPromise = new Promise(function (resolve) {
                    opts.setStopPromiseResolve(resolve);
                });

                // lane 收窄判据与 laneId 随 execCtx 下发给 handler（使用方：tool_search 按判据过滤定义；
                // AE 工具的队列文案按 laneId 标注占用者）。单 Agent 路径两者皆缺 ⇒ ctx 不含这两个键。
                // 本轮闸口上下文（gate 实例 + viewId + extraFilter + moduleLabel）同样
                // 显式下发——handler 只注册一次，子 Agent 必须用派生时冻结的那份闸口。
                var _toolFilterForCtx = (typeof opts.getToolFilter === 'function') ? opts.getToolFilter() : null;
                var _visibilityForCtx = (typeof opts.getVisibility === 'function') ? opts.getVisibility() : null;
                var _laneIdForCtx = (typeof opts.getLaneId === 'function') ? opts.getLaneId() : '';
                var _execCtxOpts;
                if (typeof _toolFilterForCtx === 'function' || (typeof _laneIdForCtx === 'string' && _laneIdForCtx)
                    || _visibilityForCtx) {
                    _execCtxOpts = {};
                    if (typeof _toolFilterForCtx === 'function') _execCtxOpts.toolFilter = _toolFilterForCtx;
                    if (typeof _laneIdForCtx === 'string' && _laneIdForCtx) _execCtxOpts.laneId = _laneIdForCtx;
                    if (_visibilityForCtx) _execCtxOpts.visibility = _visibilityForCtx;
                }
                // 停止态判据随执行上下文**无条件**下发（真机「团队→shader 后
                // submit_shader 恒 stopped」的修法）：工具注册表只有一份、last-wins ⇒ 本次执行的
                // handler 可能是另一条 runtime（团队 lane / 子 Agent）注册的那一份，它闭包里的
                // stopRequested 不是本执行者的。handler 侧一律经 execCtx 判停止（见
                // engine/controller.js 的 stopRequestedForCtx），故单 Agent 路径也必须下发。
                if (!_execCtxOpts) _execCtxOpts = {};
                _execCtxOpts.getStopRequested = function () {
                    try { return !!(opts.getStopRequested && opts.getStopRequested()); } catch (_) { return false; }
                };
                _execCtxOpts.getAbortSignal = function () {
                    try {
                        var _ac = (typeof opts.getActiveAbortController === 'function') ? opts.getActiveAbortController() : null;
                        return _ac ? (_ac.signal || null) : null;
                    } catch (_) { return null; }
                };
                // 执行侧**运行事实**（同类「共享注册表 last-wins」收口）：凡 handler
                // 需要「本 runtime 的」可变/身份状态（不只是停止态），都必须由执行者随调用下发——
                //   · execLane         执行者所属 lane（单 Agent/外接为 ''）：预览快照分槽等；
                //   · getActiveCm/Store 执行者当前档位的 cm / 会话 store（read_early_history、
                //                       submit_script 的 LLM 审查上下文）；
                //   · getPlanApi        执行者的计划处理器（trackSteps/getPlanStatus/updatePlan）；
                //   · toolResultStore   执行者的大工具结果暂存（read_tool_result 翻页）；
                //   · getActiveSessionId 执行者的会话 id（暂存按会话失效，必须与写入侧同源）。
                // 不提供这些的旧装配/测试沙箱下，各 handler 回落到自己闭包里那一份（行为同接入前）。
                _execCtxOpts.execLane = (typeof _laneIdForCtx === 'string') ? _laneIdForCtx : '';
                // 执行者是不是被派生的子 Agent（AS_ExtP 子 Agent 对团队任务清单
                // 只能读）。只有 true 时才下发该键——单 Agent / 三条 lane 的 execCtx 形状逐字不变；
                // handler 侧据它拒绝写操作（updateTeamTasks 的 read 分支仍放行）。
                if (opts.isSubagent === true) _execCtxOpts.isSubagent = true;
                _execCtxOpts.getActiveCm = function () {
                    try { return (typeof opts.getActiveCm === 'function') ? opts.getActiveCm() : null; } catch (_) { return null; }
                };
                _execCtxOpts.getActiveStore = function () {
                    try { return (typeof opts.getActiveStore === 'function') ? opts.getActiveStore() : null; } catch (_) { return null; }
                };
                _execCtxOpts.getPlanApi = function () {
                    try { return (typeof opts.getPlanApi === 'function') ? opts.getPlanApi() : null; } catch (_) { return null; }
                };
                _execCtxOpts.toolResultStore = opts.toolResultStore || null;
                _execCtxOpts.getActiveSessionId = function () {
                    try { return (typeof opts.getActiveSessionId === 'function') ? (opts.getActiveSessionId() || '') : ''; } catch (_) { return ''; }
                };
                // 执行者的 handler 绑定表：执行器优先用执行者自己注册
                // 的那份 handler，而不是全局表里 last-wins 留下的（可能是另一条 runtime 的）。
                // 见 shared/toolRegistry.js 的 createRuntimeToolRegistry 头注。
                _execCtxOpts.handlerOverlay = (typeof opts.getRuntimeHandlers === 'function') ? opts.getRuntimeHandlers() : null;

                var raceResult;
                try {
                    raceResult = await Promise.race([
                        opts.toolExecutor.call(toolName, args, execModuleId, undefined, _execCtxOpts),
                        stopPromise
                    ]);
                } finally {
                    opts.setStopPromiseResolve(null);
                    if (progressTimer) {
                        clearTimeout(progressTimer);
                    }
                }

                if (raceResult && raceResult.error === 'stopped') {
                    if (progressEl && opts.view.removeToolProgress) opts.view.removeToolProgress(progressEl);
                    // 停止分支的结果载荷必须**如实说明结局未知**。原写法回 `'{}'`——与「脚本跑了、
                    // 返回空对象」**不可区分**；
                    // 而 `Promise.race` 输掉的只是**回执**，底层 `toolExecutor.call` 仍在跑
                    //（本文件 :318-321/:540-543 的注释自述「面板超时只说明等不到回执，AE 侧仍在跑」，
                    //  `ae-tools/bootstrap.js` 亦自述「超时后 AE 侧代码继续运行（无法从 CEF 杀掉）」）。
                    // 后果：模型在下一轮看到 `{}`，极可能**原样重做** ⇒ 建层/写盘/入渲染队列等
                    // 副作用翻倍。外接通道的超时回执早已明写「可能仍在执行、勿盲目重试」
                    //（extBridgeClient.js:552-558），面板内这条一直没有对齐。
                    var _stoppedMsg = JSON.stringify({
                        status: 'stopped',
                        message: '已停止等待该调用。注意：本次调用结果未知——AE 侧可能仍在执行'
                            + '（面板无法中断已下发的脚本/渲染），请勿原样重试；'
                            + '如需确认请查看 AE 界面或用只读工具核对工程状态。'
                    });
                    return { success: false, result: _stoppedMsg, error: 'stopped', parsed: { status: 'stopped' } };
                }

                var normalizedResult = toResult(raceResult, _gateLineMap);
                if (progressEl && opts.view.removeToolProgress) {
                    opts.view.removeToolProgress(progressEl);
                }
                // tool_search 成功后记录已搜工具名：从返回体 tools[].name 提取。
                // 同时覆盖 names 与 category 两种调用方式，仅成功时记录（失败不解锁）。
                if (toolName === 'tool_search' && normalizedResult && normalizedResult.success !== false) {
                    try {
                        var _sr = JSON.parse(normalizedResult.result || '{}');
                        if (_sr && Array.isArray(_sr.tools)) {
                            if (!opts.state.searchedTools) opts.state.searchedTools = new Set();
                            for (var _sri = 0; _sri < _sr.tools.length; _sri++) {
                                if (_sr.tools[_sri] && _sr.tools[_sri].name) {
                                    opts.state.searchedTools.add(_sr.tools[_sri].name);
                                }
                            }
                        }
                    } catch (_) {}
                }
                return normalizedResult;
            }
            return { success: false, result: '', error: 'TOOL_EXECUTOR_UNAVAILABLE', parsed: {} };
        }

        return { executeToolCall: executeToolCall };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createToolExecutionPipeline = createToolExecutionPipeline;
})(typeof global !== 'undefined' ? global : window);