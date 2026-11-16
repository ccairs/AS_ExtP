(function(global) {

    function createToolExecutor(config) {
        config = config || {};
        var toolRegistry = config.toolRegistry || null;

        function setToolRegistry(reg) {
            toolRegistry = reg;
        }

        function mcpResult(success, error, text) {
            // 确保 text 始终是字符串，防止对象被隐式 toString 为 "[object Object]"
            var safeText = text;
            if (safeText && typeof safeText !== 'string') {
                try { safeText = JSON.stringify(safeText); } catch (_) { safeText = String(safeText); }
            }
            return {
                success: success,
                isError: !success,
                content: [{ type: 'text', text: error || safeText || (success ? 'OK' : 'Unknown Error') }]
            };
        }

        // 执行侧启用/作用域校验——广告过滤（getEnabledForModule）之外的最后防线，
        // 拦截会话残留/提示注入/幻觉产生的对已禁用或越权工具的调用。
        // 返回 null 表示放行；否则返回 mcpResult 错误形态（不抛异常，与现有错误形态一致）。
        function accessDenied(message) {
            var result = mcpResult(false, message, null);
            result.code = (toolRegistry && toolRegistry.JSON_RPC_ERRORS)
                ? toolRegistry.JSON_RPC_ERRORS.ACCESS_DENIED
                : -32003;
            return result;
        }

        // 模块身份归一：单串（单 Agent 路径）与数组（团队 lane 的并联身份）统一成数组。
        function _moduleIdsOf(moduleId) {
            if (Array.isArray(moduleId)) {
                var out = [];
                for (var i = 0; i < moduleId.length; i++) {
                    if (typeof moduleId[i] === 'string' && moduleId[i]) out.push(moduleId[i]);
                }
                return out;
            }
            return (typeof moduleId === 'string' && moduleId) ? [moduleId] : [];
        }

        // handler 侧的 moduleId 契约仍是**单串**（大量 handler 按模块做行为区分，喂数组会静默走错分支）；
        // 并联身份以 moduleIds 额外下发，需要的 handler 自己取。
        function _primaryModuleId(moduleId) {
            if (Array.isArray(moduleId)) {
                var ids = _moduleIdsOf(moduleId);
                return ids.length ? ids[0] : '';
            }
            return moduleId || '';
        }

        // 可选的闸口授权 visibility。
        // 存在授权（{ gate, viewId, extraFilter }，由 pipeline 随 execOpts 下发）时**只替代 scope 分支**：
        // 可见性的唯一判定改为 gate.allows（与投放/执行闸/tool_search 同源，支持用户放宽到 scope 之外）；
        // enabled 与模块级停用（isModuleDisabledAnywhere）仍由本函数检查、不得跳过。
        // 无授权（外接通道 / comfyui panelChat / aeContext 等直调）保持现状 scope 校验。
        function _authOf(visibility) {
            if (!visibility || !visibility.gate) return null;
            if (typeof visibility.gate.allows !== 'function') return null;
            if (typeof visibility.viewId !== 'string' || !visibility.viewId) return null;
            return visibility;
        }

        function _authDenied(auth, tool, toolName) {
            var why = '';
            try {
                if (typeof auth.gate.reason === 'function') {
                    why = auth.gate.reason(auth.viewId, tool, auth.extraFilter) || '';
                }
            } catch (_) { why = ''; }
            return accessDenied('ACCESS_DENIED: Tool "' + toolName + '" is not visible in the current agent view'
                + (why ? ' (' + why + ')' : '') + '.');
        }

        function checkAccess(tool, toolName, moduleId, visibility) {
            if (tool.enabled === false) {
                return accessDenied('ACCESS_DENIED: Tool "' + toolName + '" is disabled.');
            }
            var auth = _authOf(visibility);
            // moduleId 未传时不做 scope/模块禁用检查（只强制 enabled），避免误伤未知上下文调用方；
            // 带闸口授权时同理按授权判（授权自带视图身份，不依赖 moduleId）。
            if (!moduleId) {
                if (auth && !auth.gate.allows(auth.viewId, tool, auth.extraFilter)) {
                    return _authDenied(auth, tool, toolName);
                }
                return null;
            }
            var ids = _moduleIdsOf(moduleId);
            // 模块级禁用：并联身份下**任一成员模块禁用即拒绝**（fail-closed，与投放侧
            // toolRegistry.isModuleDisabledAnywhere 同口径）——否则用户在某模块抽屉里关掉的
            // 工具可以借另一个成员模块被"捞回来"。单身份时与旧行为逐字相同。
            var disabled = false;
            if (typeof toolRegistry.isModuleDisabledAnywhere === 'function') {
                disabled = toolRegistry.isModuleDisabledAnywhere(toolName, ids);
            } else if (typeof toolRegistry.isModuleDisabled === 'function') {
                for (var di = 0; di < ids.length; di++) {
                    if (toolRegistry.isModuleDisabled(toolName, ids[di])) { disabled = true; break; }
                }
            }
            if (disabled) {
                return accessDenied('ACCESS_DENIED: Tool "' + toolName + '" is disabled for module "' + ids.join('|') + '".');
            }
            if (auth) {
                // 闸口授权只替代 scope 分支：可见性判定 = 投放侧同一份
                if (!auth.gate.allows(auth.viewId, tool, auth.extraFilter)) {
                    return _authDenied(auth, tool, toolName);
                }
                return null;
            }
            var denied = null;
            if (tool.scope && tool.scope.type === 'module') {
                var scopedIds = (Array.isArray(tool.scope.moduleIds) && tool.scope.moduleIds.length)
                    ? tool.scope.moduleIds
                    : (tool.scope.moduleId ? [tool.scope.moduleId] : []);
                var accessible = false;
                for (var si = 0; si < ids.length; si++) {
                    if (scopedIds.indexOf(ids[si]) >= 0) { accessible = true; break; }
                }
                if (!accessible) {
                    denied = accessDenied('ACCESS_DENIED: Tool "' + toolName + '" is not accessible by module "' + ids.join('|') + '".');
                }
            }
            if (denied) return denied;
            return null;
        }

        function execute(toolName, args, moduleId, callerId, execOpts) {
            if (toolRegistry) {
                var tool = toolRegistry.get(toolName);
                if (tool) {
                    var denied = checkAccess(tool, toolName, moduleId, execOpts && execOpts.visibility);
                    if (denied) return Promise.resolve(denied);
                    // 执行者自己的 handler 优先（见 toolRegistry.js 的
                    // createRuntimeToolRegistry 头注）：全局表 last-wins，只保留最后装配那条 runtime
                    // 的 handler；直接用它会让所有 runtime 的行为/数据串到同一条（停止态、会话域、
                    // 计划树、预览账本槽……）。执行侧（toolExecutionPipeline）随 execOpts 下发执行者
                    // 的 handler 绑定表 handlerOverlay，这里按**执行者**取；没有 overlay 的调用方
                    // （外接通道 / 一次性注册的全局工具 / 动态注册的 AE、MCP 工具）回落全局表。
                    var _overlay = (execOpts && execOpts.handlerOverlay && typeof execOpts.handlerOverlay === 'object')
                        ? execOpts.handlerOverlay : null;
                    var _runner = (_overlay && typeof _overlay[toolName] === 'function') ? _overlay[toolName] : tool.handler;
                    if (typeof _runner === 'function') {
                        try {
                            // 第二参传执行上下文（moduleId + moduleIds + callerId + toolFilter），
                            // 供需要按调用方区分行为的 handler 使用（如 Skill 工具按模块校验 skill
                            // 作用域；预览区快照守卫按调用方分账——面板内 Agent 与外接客户端各自的
                            // 「读到什么」互不顶替；tool_search 按 lane 的收窄判据过滤定义——
                            // 缺这一环，被收窄的工具仍能经 tool_search 取回 schema 再按名直调）。
                            // callerId 由调用方显式传入（外接 dispatch 传 'ext:<clientId>'），
                            // 缺省为空串＝面板内调用方。旧 handler 单参签名不受影响（多出的实参被忽略）。
                            var ctx = { moduleId: _primaryModuleId(moduleId), callerId: callerId || '' };
                            var idsForCtx = _moduleIdsOf(moduleId);
                            if (idsForCtx.length > 1) ctx.moduleIds = idsForCtx;
                            if (execOpts && typeof execOpts.toolFilter === 'function') ctx.toolFilter = execOpts.toolFilter;
                            // 本轮闸口上下文：tool_search 等 handler 用
                            // ctx.visibility.{gate,viewId,extraFilter,moduleLabel} 查同一份可见性判定
                            //（gate 实例随上下文下发：子 Agent 用的是派生时冻结的那份闸口）。
                            if (execOpts && execOpts.visibility && typeof execOpts.visibility === 'object') {
                                ctx.visibility = execOpts.visibility;
                            }
                            // laneId：团队 lane 的标识，供 handler 标注占用者（AE 队列的等待/失败文案
                            // 要写明"被哪条 lane 的哪个工具占着"，见 ae-tools/bootstrap.js 的 ctx.laneId）。
                            // 单 Agent / 外接 / 手动通道不传 ⇒ handler 侧缺省 'single'。
                            if (execOpts && typeof execOpts.laneId === 'string' && execOpts.laneId) ctx.laneId = execOpts.laneId;
                            // 执行侧运行轮判据（停止态/signal）：注册表 last-wins ⇒
                            // 本 handler 可能由另一条 runtime（团队 lane / 子 Agent）注册，它闭包里
                            // 的停止 getter 不是本次执行者的。需要的 handler（submit_script /
                            // submit_shader 等提交类）一律经 ctx 取判据，见 engine/controller.js
                            // 的 stopRequestedForCtx 与其注册处注释。
                            // 外接通道（extBridgeClient）显式下发恒假判据——外部调用没有面板停止语义，
                            // 不能继承可能残留的 lane/子 Agent 停止态。
                            if (execOpts && typeof execOpts.getStopRequested === 'function') ctx.getStopRequested = execOpts.getStopRequested;
                            if (execOpts && typeof execOpts.getAbortSignal === 'function') ctx.getAbortSignal = execOpts.getAbortSignal;
                            // 执行侧**运行事实**：除了停止态，凡「本 runtime 的」
                            // 可变/身份状态都随执行上下文下发，供 handler 按执行者取用（而不是按注册者）：
                            //   execLane / getActiveCm / getActiveStore / getPlanApi / toolResultStore /
                            //   getActiveSessionId。消费方与回落语义见
                            //   agent/engine/controller/toolExecutionPipeline.js 的 _execCtxOpts 注释。
                            if (execOpts && typeof execOpts.execLane === 'string') ctx.execLane = execOpts.execLane;
                            if (execOpts && typeof execOpts.getActiveCm === 'function') ctx.getActiveCm = execOpts.getActiveCm;
                            if (execOpts && typeof execOpts.getActiveStore === 'function') ctx.getActiveStore = execOpts.getActiveStore;
                            if (execOpts && typeof execOpts.getPlanApi === 'function') ctx.getPlanApi = execOpts.getPlanApi;
                            if (execOpts && execOpts.toolResultStore) ctx.toolResultStore = execOpts.toolResultStore;
                            if (execOpts && typeof execOpts.getActiveSessionId === 'function') ctx.getActiveSessionId = execOpts.getActiveSessionId;
                            var result = _runner(args, ctx);
                            if (result && typeof result.then === 'function') {
                                return result.then(function(r) {
                                    if (r && r.content) return r;
                                    var rSuccess = r ? r.success !== false : true;
                                    return mcpResult(rSuccess, (r && r.error) || '', (r && r.result) || '');
                                }).catch(function(e) {
                                    return mcpResult(false, String(e && e.message ? e.message : e));
                                });
                            }
                            if (result && result.content) return Promise.resolve(result);
                            var success = result ? result.success !== false : true;
                            return Promise.resolve(mcpResult(success, (result && result.error) || '', (result && result.result) || ''));
                        } catch (e) {
                            return Promise.resolve(mcpResult(false, String(e && e.message ? e.message : e)));
                        }
                    }
                    // 工具存在但 handler 缺失/非函数：明确报错，避免落到下方"未初始化 registry"误导消息
                    return Promise.resolve(mcpResult(false, 'Tool "' + toolName + '" has no valid handler.', null));
                } else {
                    // 原文案只说「Check MCP Server Manager」——对
                    // **被删的内置工具**（历史会话回放里的 listAeFunctions 等，见真机会话文件）是
                    // 误导：内置工具不归 MCP 管理器管，用户去那儿查不到任何东西。补一句可判别的
                    // 可能性，保持 fail-closed 不变。
                    return Promise.resolve(mcpResult(false, 'Tool "' + toolName + '" is not registered. Ensure it has been registered with the tool registry. Check MCP Server Manager for available tools. If it was a built-in tool, it may have been removed in a version update (restart the panel to refresh the tool list).', null));
                }
            }

            return Promise.resolve(mcpResult(false, 'Tool executor not initialized with a tool registry.', null));
        }

        function call(toolName, args, moduleId, callerId, execOpts) {
            return execute(toolName, args, moduleId, callerId, execOpts);
        }

        return {
            execute: execute,
            call: call,
            setToolRegistry: setToolRegistry
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createToolExecutor = createToolExecutor;

})(window);
