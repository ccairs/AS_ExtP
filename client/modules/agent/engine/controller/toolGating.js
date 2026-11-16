(function (global) {
    'use strict';
    // 工具门控与统一工具集组装拆分。由 controller.js 组装区经 AEEngine.createToolGating() 创建。
    // 纯迁移自 controller.js 内联的 executeToolCallForLlm + _buildLlmTools。
    //
    // 工具可见性闸口：**可见性判定已收口到 shared/toolVisibility.js**
    // （gate.defsFor / gate.allReasons）。本模块只保留**语义门控**：
    //   · 视觉 / 视频 / 联网开关 / 模式黑名单（gateReasonFor，唯一实现）；
    //   · gateReasons 合成的「补空位」：闸口原因优先，语义码只填空位（改造前是无条件赋值，
    //     会把 USER_DISABLED 盖成 WEB_SEARCH_DISABLED——原因码优先级）。
    // 生产路径：controller._buildRoundTools → gate.defsFor + applySemanticGating。
    // buildLlmTools 仅保留给直驱单测/旧调用方（自身仍带旧的 scope+filter 组装，生产不经过）。
    //
    // opts 注入（对应 controller.js 作用域闭包变量）：
    //   getToolRegistry：返回 createController opts.toolRegistry（工具注册表，可能为 undefined）
    //   getSettings：controller 注入的回调（视觉/联网门控与 stub 上限同步读它）
    //   executeToolCall：来自 toolExecutionPipeline 的 executeToolCall（executeToolCallForLlm 调用它）
    // 视觉三件：能力门控中"随模型能力"收起的三件（有视觉代理时照常投放——代理路径可读图）
    var VISION_TOOL_NAMES = { getPreviewFrame: true, read_image: true, getShaderPreview: true };
    // 联网搜索三件：同受 webSearchEnabled 开关控制（无条件注册，每轮按最新设置过滤）
    var WEB_SEARCH_TOOL_NAMES = { search_web: true, read_url: true, search_skill_store: true };

    // 语义门控判据（单一事实源，模块级纯函数）：null=放行，否则返回原因码。
    // 投放侧（applySemanticGating 的过滤，并经出参 gateReasons 报告）与执行侧
    // （toolExecutionPipeline 的「门控不可用」闸门读同一份报告）共用此判据——
    // 各写一份就是两个真相源，开关一改必然出现「投放拦了、执行没拦」
    //（成因形态：关掉联网搜索后模型仍能凭记忆按名直调）。
    function gateReasonFor(toolName, gateCtx) {
        if (!toolName) return null;
        if (gateCtx.blacklistSet && gateCtx.blacklistSet[toolName]) return 'MODE_BLACKLIST';
        // 视觉/视频门控：仅"无视觉代理"时因模型能力收起（有代理时由代理模型承担读图/读视频）
        if (!gateCtx.hasVisionProxy) {
            if (!gateCtx.canVision && VISION_TOOL_NAMES[toolName]) return 'MODEL_NO_VISION';
            if (!gateCtx.canVideo && toolName === 'read_video') return 'MODEL_NO_VIDEO';
        }
        if (!gateCtx.webEnabled && WEB_SEARCH_TOOL_NAMES[toolName]) return 'WEB_SEARCH_DISABLED';
        return null;
    }

    function createToolGating(opts) {
        // 直接驱动工具执行（测试/直接调用用）。不传 execMode，默认使用 agent moduleId，
        // 不可在 Script 模式上下文调用（否则 scope 校验会用错误的 moduleId）。
        function executeToolCallForLlm(toolName, args) {
            var argsStr = typeof args === 'string' ? args : JSON.stringify(args);
            var toolCall = { function: { name: toolName, arguments: argsStr } };
            return opts.executeToolCall(toolCall);
        }

        // 门控上下文（视觉 / 视频 / 联网开关 / 模式黑名单）：两处共用同一构造，判据不漂。
        function _gateCtxOf(tOpts) {
            var _blSet = null;
            if (tOpts.blacklist && tOpts.blacklist.length) {
                _blSet = Object.create(null);
                for (var _bi = 0; _bi < tOpts.blacklist.length; _bi++) _blSet[tOpts.blacklist[_bi]] = true;
            }
            var _wsEnabled = true;
            try {
                _wsEnabled = !!opts.getSettings().webSearchEnabled;
            } catch (_) {}
            return {
                blacklistSet: _blSet,
                canVision: !!tOpts.canVision,
                canVideo: !!tOpts.canVideo,
                hasVisionProxy: !!tOpts.hasVisionProxy,
                webEnabled: _wsEnabled
            };
        }

        // ── 生产路径：可见性已由闸口定案，本函数只做语义门控与原因补空位 ──
        // 入参 defs = gate.defsFor(viewId, extraFilter) 的产物（含 stub 装配与上限裁剪）。
        // 出参 = 语义门控后的最终投放清单；tOpts.gateReasons 已由调用方用 gate.allReasons 预填
        // （闸口原因），这里**只填空位**：语义码不得覆盖 VIEW_LOCKED / USER_DISABLED / …。
        function applySemanticGating(defs, tOpts) {
            tOpts = tOpts || {};
            var list = Array.isArray(defs) ? defs : [];
            var reasons = tOpts.gateReasons || null;
            var gateCtx = _gateCtxOf(tOpts);
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var _fn = list[i] && list[i].function && list[i].function.name;
                var _reason = gateReasonFor(_fn, gateCtx);
                if (_reason) {
                    if (reasons && _fn && !reasons[_fn]) reasons[_fn] = _reason;
                    continue;
                }
                out.push(list[i]);
            }
            return out;
        }

        // ── 兼容路径：直驱单测 / 旧调用方（生产不经过；scope+filter 组装逻辑保持原语义）──
        // 统一工具集组装：agent/shader/script 三个模式共用同一套逻辑。
        // ① 作用域过滤：按 moduleId（单身份）或 moduleIds（**lane 的并联身份**）过滤
        // ② 收窄：lane 的 deny 判据（filter）——与执行侧读同一份原因报告，防 tool_search 绕行
        // ③ 语义门控：视觉/视频/联网搜索/模式黑名单，判据唯一实现在 gateReasonFor
        //
        // 入参两种形态（向后兼容）：
        //   buildLlmTools('agent', tOpts)                        —— 单身份（单 Agent 路径，行为零变化）
        //   buildLlmTools({ moduleIds: ['agent','team'], filter }, tOpts) —— 并联身份 + 收窄
        function buildLlmTools(moduleIdOrOpts, tOpts) {
            tOpts = tOpts || {};
            var _isOpts = !!moduleIdOrOpts && typeof moduleIdOrOpts === 'object';
            var _rawIds = _isOpts
                ? (Array.isArray(moduleIdOrOpts.moduleIds) ? moduleIdOrOpts.moduleIds : [moduleIdOrOpts.moduleIds])
                : [moduleIdOrOpts];
            var _ids = [];
            for (var _mi = 0; _mi < _rawIds.length; _mi++) {
                if (typeof _rawIds[_mi] === 'string' && _rawIds[_mi]) _ids.push(_rawIds[_mi]);
            }
            if (!_ids.length) _ids = [''];
            var _moduleId = _ids[0];
            // 收窄判据（lane）：入参是注册表条目（含 name/source/readOnly），返回假值即剔除。
            var _laneFilter = (_isOpts && typeof moduleIdOrOpts.filter === 'function') ? moduleIdOrOpts.filter : null;
            var llmToolReg = opts.getToolRegistry() || (global.AE_LLM && global.AE_LLM.toolRegistry);
            var tools = [];
            var _candidates = null;   // 未收窄候选：只用于 gateReasons 报告
            if (llmToolReg && typeof llmToolReg.getLlmToolDefsFor === 'function') {
                // 同步 Agent 模块设置的 stub 工具上限到注册表（防加载顺序导致上限未生效）。
                try {
                    var _bt = Number(opts.getSettings().maxLlmStubTools);
                    if (typeof llmToolReg.setMaxLlmStubTools === 'function') llmToolReg.setMaxLlmStubTools(_bt > 0 ? _bt : 0);
                } catch (_) {}
                // ① 候选全集（**未收窄**）：只喂 gateReasons
                _candidates = llmToolReg.getLlmToolDefsFor(_ids, null);
                // ② 投放清单按收窄判据**在装配之前**求
                tools = _laneFilter ? llmToolReg.getLlmToolDefsFor(_ids, _laneFilter) : _candidates;
            } else if (llmToolReg && typeof llmToolReg.getLlmToolStubs === 'function') {
                tools = llmToolReg.getLlmToolStubs(_moduleId);
            } else if (llmToolReg && typeof llmToolReg.getLlmToolDefinitions === 'function') {
                tools = llmToolReg.getLlmToolDefinitions(_moduleId);
            } else if (global.AEEngine && global.AEEngine.AE_TOOLS) {
                tools = global.AEEngine.AE_TOOLS;
            }
            // 收窄判定表（逐名；拿注册表条目以支持 source/readOnly 元数据判据）。
            var _laneDenied = null;
            if (_laneFilter) {
                _laneDenied = Object.create(null);
                var _denySrc = _candidates || tools;
                for (var _li = 0; _li < _denySrc.length; _li++) {
                    var _ln = _denySrc[_li] && _denySrc[_li].function && _denySrc[_li].function.name;
                    if (!_ln) continue;
                    var _lEntry = (llmToolReg && typeof llmToolReg.get === 'function' && llmToolReg.get(_ln)) || { name: _ln };
                    if (!_laneFilter(_lEntry)) _laneDenied[_ln] = true;
                }
            }
            var _gateCtx = _gateCtxOf(tOpts);
            // 门控报告（出参）：对**未收窄候选全集**逐名求值——执行侧据同一份报告把
            // 「关掉开关」「不属于本 lane」落成「不可用」。
            // **只填空位**（闸口原因优先），改造前是无条件赋值。
            var _reportSrc = _candidates || tools;
            if (tOpts.gateReasons) {
                for (var _gri = 0; _gri < _reportSrc.length; _gri++) {
                    var _grName = _reportSrc[_gri] && _reportSrc[_gri].function && _reportSrc[_gri].function.name;
                    if (!_grName) continue;
                    if (_laneDenied && _laneDenied[_grName]) {
                        if (!tOpts.gateReasons[_grName]) tOpts.gateReasons[_grName] = 'LANE_TOOL_DENIED';
                        continue;
                    }
                    var _grReason = gateReasonFor(_grName, _gateCtx);
                    if (_grReason && !tOpts.gateReasons[_grName]) tOpts.gateReasons[_grName] = _grReason;
                }
            }
            // ③ 语义门控过滤（与报告同判据）。收窄在并联路径已于装配前完成；这里的 laneDenied
            // 对兜底路径（无并联接口）才起过滤作用，对已收窄清单幂等。
            tools = tools.filter(function (t) {
                var _fn = t.function && t.function.name;
                if (_laneDenied && _laneDenied[_fn]) return false;
                return !gateReasonFor(_fn, _gateCtx);
            });
            return tools;
        }

        return {
            executeToolCallForLlm: executeToolCallForLlm,
            applySemanticGating: applySemanticGating,
            buildLlmTools: buildLlmTools,
            gateReasonFor: gateReasonFor
        };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createToolGating = createToolGating;
})(typeof global !== 'undefined' ? global : window);
