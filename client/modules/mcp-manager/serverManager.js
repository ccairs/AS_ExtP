(function(global) {

    function createServerManager(config) {
        config = config || {};
        var toolRegistry = config.toolRegistry || null;
        var communicationProvider = config.communicationProvider || null;
        var settingsStore = config.settingsStore || null;
        var onShortDescGenerated = config.onShortDescGenerated || null;

        // bootstrap 完成标志：启动期间 onConnected 不触发生成，
        // 由 main.js bootstrap 完成后调用 generateMissingShortDescsForAll 统一触发。
        // 这避免了 initMCP 早于 llmChannel/AEAppContainer 创建导致的 401 时序问题。
        var _bootstrapReady = false;
        // 记录启动期间已连接的服务器，供 bootstrap 完成后统一扫描
        var _pendingServers = [];

        // 是否自动生成 shortDescription。读取 MCP 模块设置 autoGenShortDesc 字段，默认开启。
        // 关闭后不再调用 LLM 生成描述，工具走完整 description 注入（非 stub 模式 token 消耗更大）。
        var _autoGenShortDesc = true;

        // 短描述生成的失败次数上限——LLM 键名幻觉/接口失败等导致某工具始终
        // 拿不到描述时，若无上限，每次重连 onConnected 都会再次调用 LLM 重试（重复
        // 烧 token）。同一工具连续失败 SHORT_DESC_MAX_FAILS 次后不再重试生成；
        // 成功拿到描述即清零计数（"连续"失败语义）
        var SHORT_DESC_MAX_FAILS = 3;
        var _shortDescFails = Object.create(null);

        function _shortDescFailKey(serverId, toolName) {
            return serverId + '\n' + toolName;
        }

        var proto = global.AE_LLM.createMCPProtocol();

        // ── MCP 长调用转后台 ──
        // 面板内 MCP 工具调用超过同步等待窗未返回：不再报 90s 超时错——登记任务、回执
        // taskId，响应继续在后台等（send 的超时放大到硬上限），结果到达后经
        // injectSystemResult 注入对话（system-result → LLM 文本 = visible + detail，
        // 空闲自动起一轮、忙则并入当前轮注入队列，均复用既有后台结果机制）。
        // 等待窗取旧的 send 超时同值（90s），不改变短工具既有行为；外接调用与非 Agent
        // 轮次（如 ComfyUI 画布助手）都不走此路——详见 toolDiscovery 的 LONG_CALL_MODULES 注释。
        var MCP_LONG_CALL_WAIT_MS = 90 * 1000;
        var MCP_LONG_CALL_HARD_MS = 30 * 60 * 1000;   // 后台硬上限（对齐外接侧绝对墙钟上限）
        var mcpTasks = (global.AE_LLM && typeof global.AE_LLM.createMcpTaskStore === 'function')
            ? global.AE_LLM.createMcpTaskStore() : null;

        // 任务发起时的会话快照：结果迟到时用户可能已切走会话，注入按原会话写回
        // （injectSystemResult 的 sessionId 语义，与 ComfyUI 后台轮询同款）
        function _mcpTaskSessionId() {
            try {
                if (global.AEEngine && global.AEEngine.bridge
                    && typeof global.AEEngine.bridge.getSessionId === 'function') {
                    return global.AEEngine.bridge.getSessionId() || null;
                }
            } catch (_) {}
            return null;
        }

        // 任务发起时所在 lane 的快照（团队模式，与上面的 sessionId 同一刻取）：
        // 结果迟到时用户可能已切到别条 lane，注入按**发起 lane** 写回。
        // 未开启团队 / 未装配 → ''（injectSystemResult 的缺省 = 当前 lane）。
        function _mcpTaskLaneId() {
            try {
                if (global.AEEngine && typeof global.AEEngine.getCurrentLaneId === 'function') {
                    return global.AEEngine.getCurrentLaneId() || '';
                }
            } catch (_) {}
            return '';
        }

        // taskId → 发起时 lane 的旁挂表。为什么不放进任务表：mcpTaskStore.create 只收白名单
        // 字段（id/status/serverId/toolName/sessionId/…），laneId 会被丢掉；而该文件不在本期
        // 改动范围内 ⇒ 在**调用方这一侧**旁挂（beginTask 拿到 taskId 的同一刻记下 lane）。
        // 条目随 settle 删除；未 settle 的条目随面板生命周期结束（内存量级 = 在途长调用数）。
        var _taskLane = Object.create(null);

        function _settleMcpTask(taskId, errText, text) {
            var task = mcpTasks ? mcpTasks.settle(taskId, errText, text) : null;
            var laneId = _taskLane[taskId] || null;
            delete _taskLane[taskId];
            if (!task) return;   // 未知/已被淘汰的任务：无消费方，静默
            var payload = null;
            try {
                payload = global.AE_LLM.formatMcpTaskResultPayload(task, errText, text);
            } catch (e) {}
            var bridge = (global.AEEngine && global.AEEngine.bridge) || null;
            if (payload && bridge && typeof bridge.injectSystemResult === 'function') {
                try {
                    bridge.injectSystemResult(payload.title, payload.visible, payload.detail,
                        'user', task.sessionId || null, laneId);
                    console.log('[MCP] 长调用任务结果已注入对话: ' + taskId + (errText ? '（失败）' : ''));
                    return;
                } catch (e) {
                    console.warn('[MCP] 长调用任务注入对话失败（' + taskId + '）: ' + (e && e.message ? e.message : e));
                }
            }
            // 兜底（回执诚实）：Agent 引擎不可用或注入抛出时结果没有去处，如实提示，
            // 不让"后台结果静默消失"（ComfyUI 后台结果对已删会话的处理同思路）
            console.warn('[MCP] 长调用任务 ' + taskId + ' 结果无对话可注入（Agent 引擎不可用）');
            if (global.AEToast && typeof global.AEToast.show === 'function') {
                try {
                    global.AEToast.show(errText
                        ? AEI18n.t('MCP 工具「{tool}」后台执行失败，但结果未能写入对话（Agent 面板不可用）', { tool: task.toolName || AEI18n.t('未知') })
                        : AEI18n.t('MCP 工具「{tool}」后台执行完成，但结果未能写入对话（Agent 面板不可用）', { tool: task.toolName || AEI18n.t('未知') }), 'error');
                } catch (_) {}
            }
        }

        var discovery = global.AE_LLM.createToolDiscovery({
            protocol: proto,
            communicationProvider: communicationProvider,
            toolRegistry: toolRegistry,
            longCall: mcpTasks ? {
                waitMs: MCP_LONG_CALL_WAIT_MS,
                hardMs: MCP_LONG_CALL_HARD_MS,
                beginTask: function(info) {
                    // lane 在**这一刻**快照（toolDiscovery 紧接着 getSessionId 调它）：
                    // 结果注入时才知道该写回哪条 lane（见 _taskLane）
                    var taskId = mcpTasks.create(info);
                    if (taskId) _taskLane[taskId] = _mcpTaskLaneId();
                    return taskId;
                },
                settleTask: function(taskId, errText, text) { _settleMcpTask(taskId, errText, text); },
                getSessionId: _mcpTaskSessionId
            } : null
        });

        var shortDescGen = null;
        if (global.AE_LLM && typeof global.AE_LLM.createShortDescGenerator === 'function') {
            shortDescGen = global.AE_LLM.createShortDescGenerator();
        }

        var lifecycle = global.AE_LLM.createServerLifecycle({
            protocol: proto,
            communicationProvider: communicationProvider,
            settingsStore: settingsStore,
            onBeforeCleanup: {
                onStopping: function(serverId) {
                    discovery.unregisterByServer(serverId);
                },
                onConnected: function(serverId) {
                    var cfg = lifecycle.getConfig(serverId);
                    var scope = (cfg && cfg.scope) ? cfg.scope : null;
                    var cachedDescs = (cfg && cfg.toolDescriptions) ? cfg.toolDescriptions : null;
                    var cachedStubs = (cfg && cfg.toolStubs) ? cfg.toolStubs : null;
                    // 本连接的代数：fetch 工具列表是异步的，期间服务器可能崩溃并自动重连，
                    // 回调返回后核对代数，拦截旧连接的 tools 快照进入注册/生成流程
                    var gen0 = lifecycle.getConnectionGen(serverId);
                    discovery.fetchAndRegister(serverId, scope, cachedDescs, cachedStubs, function(err, tools) {
                        if (err) {
                            // 拉取失败明细已由 fetchAndRegister 记入 _lastRegisterErrors
                            // （含错误消息与时间），面板经 getLastRegisterErrors 在
                            // Server 列表「重启/重试」旁、工具 tab 空态、编辑弹窗展示；
                            // 连接状态机语义不变（仍为 connected）
                            console.warn('[MCP] tools/list failed for ' + serverId + ': ' + err.message);
                            return;
                        }
                        // fetch 期间连接已换代（崩溃+重连/手动重启）：新连接自己的
                        // onConnected → fetchAndRegister 流程已在跑，旧快照直接丢弃
                        if (lifecycle.getConnectionGen(serverId) !== gen0) {
                            console.log('[MCP] tools/list skip for ' + serverId + ' (connection generation changed during fetch)');
                            return;
                        }
                        console.log('[MCP] Registered ' + tools.length + ' tool(s) from ' + serverId);
                        // bootstrap 未完成时暂不生成，记录到待处理队列
                        // bootstrap 完成后由 generateMissingShortDescsForAll 统一扫描
                        //（gen 随快照入队，消费时再次核对，防入队后崩溃+重连的陈旧条目）
                        if (!_bootstrapReady) {
                            _pendingServers.push({ serverId: serverId, tools: tools, cachedDescs: cachedDescs, cachedStubs: cachedStubs, scope: scope, gen: gen0 });
                            return;
                        }
                        _generateMissingShortDescs(serverId, tools, cachedDescs, cachedStubs, scope);
                    });
                }
            }
        });

        // 进程崩溃/意外退出 → 同步 lifecycle 状态 + 自动重启（防循环重启见 lifecycle.handleCrash）
        if (communicationProvider && typeof communicationProvider.setOnProcessExit === 'function') {
            communicationProvider.setOnProcessExit(function(serverId, info) {
                if (lifecycle && typeof lifecycle.handleCrash === 'function') {
                    lifecycle.handleCrash(serverId, info || {});
                }
            });
        }

        // SSE 断流/自愈重连走轻量通道——只同步 lifecycle 状态，不注销工具、
        // 不触发崩溃自动重启（断流可自愈：scheduleReconnect 重连成功后 transport 恢复、
        // 工具注册表全程有效；复用 onProcessExit→handleCrash 全语义会导致断流一次
        // 工具即被注销、自愈后无人 re-register，工具静默永久消失）
        if (communicationProvider && typeof communicationProvider.setOnSseDisconnected === 'function') {
            communicationProvider.setOnSseDisconnected(function(serverId, info) {
                if (lifecycle && typeof lifecycle.handleSseDisconnected === 'function') {
                    lifecycle.handleSseDisconnected(serverId, info || {});
                }
            });
            communicationProvider.setOnSseReconnected(function(serverId) {
                if (lifecycle && typeof lifecycle.handleSseReconnected === 'function') {
                    lifecycle.handleSseReconnected(serverId);
                }
            });
        }

        // bridge 断线重连成功 → 自动恢复所有本应运行的 MCP server
        // （bridge 进程重启会丢失全部子进程/配置；启动竞态下可能从未连接过）
        if (communicationProvider && typeof communicationProvider.setOnBridgeReconnect === 'function') {
            communicationProvider.setOnBridgeReconnect(function() {
                if (lifecycle && typeof lifecycle.recoverAllOnBridgeReconnect === 'function') {
                    lifecycle.recoverAllOnBridgeReconnect();
                }
            });
        }

        // 对比缓存，找出无 shortDescription 的新工具，调用 LLM 批量生成。
        // 生成成功后更新缓存 + 重新注册工具。失败弹提示，工具仍可用（回退到 description 截断）。
        // 若 _autoGenShortDesc=false 则跳过生成，由 LLM 直接使用完整 description。
        async function _generateMissingShortDescs(serverId, tools, cachedDescs, cachedStubs, scope) {
            if (!shortDescGen || !tools || tools.length === 0) return;
            console.log('[MCP] shortDesc check ' + serverId + ': ' + tools.length + ' tool(s), autoGen=' + _autoGenShortDesc);
            if (!_autoGenShortDesc) {
                // 自动生成已关闭：不调用 LLM，工具走完整 description 注入
                console.log('[MCP] shortDescription auto-gen disabled, skip for ' + serverId);
                return;
            }

            var descMap = cachedDescs || {};
            var needGen = [];
            for (var i = 0; i < tools.length; i++) {
                var t = tools[i];
                // 缓存 key 兼容原始名与带 mcp_ 前缀的注册名（面板编辑存注册名，自动生成存原始名）
                var cachedKey = (t.name && t.name.indexOf('mcp_') !== 0) ? 'mcp_' + t.name : t.name;
                if (t && t.name && !descMap[t.name] && !descMap[cachedKey]) {
                    // 连续失败超限的工具不再重试（键名幻觉下每次重连重复调 LLM）
                    if ((_shortDescFails[_shortDescFailKey(serverId, t.name)] || 0) >= SHORT_DESC_MAX_FAILS) continue;
                    needGen.push({ name: t.name, description: t.description || '' });
                }
            }
            if (needGen.length === 0) {
                console.log('[MCP] shortDesc none missing for ' + serverId + ' (all cached)');
                return;
            }

            console.log('[MCP] Generating shortDescription for ' + needGen.length + ' tool(s) from ' + serverId);
            try {
                // LLM 生成前的连接代数：await 期间服务器可能崩溃并自动重连
                //（handleCrash → 1s 后 startServer），状态回到 'connected'，
                // 仅凭下方状态复查挡不住旧回调"重连洗白"，须以代数核对
                var gen0 = lifecycle.getConnectionGen(serverId);
                var generated = await shortDescGen.generate(needGen);
                // 拿到描述的工具清零失败计数；仍缺描述的（LLM 键名幻觉对不上）
                // 计一次失败——连续失败达上限后不再重试，防每次重连重复调用 LLM
                for (var fi = 0; fi < needGen.length; fi++) {
                    var failKey = _shortDescFailKey(serverId, needGen[fi].name);
                    if (generated[needGen[fi].name]) {
                        delete _shortDescFails[failKey];
                    } else {
                        _shortDescFails[failKey] = (_shortDescFails[failKey] || 0) + 1;
                    }
                }
                // generate 最长 60s，期间用户可能在编辑面板保存手动描述/Stub
                //（view._collectAndSaveToolEditor 基于当时最新 cfg 合并写入）。
                // merged 若基于入参快照 descMap 整体覆盖 toolDescriptions，会静默
                // 丢弃用户刚保存的输入——此处重新读取当前最新配置合并：只对用户仍未
                // 设置描述的工具应用生成值，已有值（用户手动保存）一律以用户为准
                var cfgNow = lifecycle.getConfig(serverId);
                var latestDescs = (cfgNow && cfgNow.toolDescriptions) ? cfgNow.toolDescriptions : null;
                var latestStubs = (cfgNow && cfgNow.toolStubs) ? cfgNow.toolStubs : null;
                var latestScope = (cfgNow && cfgNow.scope) ? cfgNow.scope : scope;
                var merged = Object.assign({}, latestDescs);
                for (var gk in generated) {
                    if (!Object.prototype.hasOwnProperty.call(generated, gk)) continue;
                    // 双 key 兼容（与上方 needGen 判定一致）：自动生成落原始名，面板编辑
                    // 落 mcp_ 前缀注册名；生成期间用户以任一 key 保存过描述的工具不再写入
                    var userKey = (gk.indexOf('mcp_') === 0) ? gk : 'mcp_' + gk;
                    if (!merged[gk] && !merged[userKey]) merged[gk] = generated[gk];
                }
                // 缓存落盘不依赖代数（缓存与新老连接通用），照旧执行。
                // 消费回执——写盘失败时缓存本次会话仍生效但重启后回退，至少在
                // 日志如实记录 persistConfigs 的失败回执。
                // Promise.resolve().then(...) 兼容旧 mock/旧 lifecycle 的同步返回值
                Promise.resolve().then(function () {
                    return lifecycle.updateToolDescriptions(serverId, merged);
                }).then(function (r) {
                    if (r && r.persisted === false) {
                        console.warn('[MCP] shortDescription 缓存落盘失败（本次会话已生效，重启后回退）: ' + serverId);
                    }
                }).catch(function (e) {
                    console.warn('[MCP] shortDescription 缓存落盘异常: ' + (e && e.message ? e.message : e));
                });
                // await 期间连接已换代（崩溃+重连/手动重启）：新连接自己的
                // onConnected → fetchAndRegister → 生成流程已在跑，旧 tools 快照的
                // unregister/register 回写会把注册表变回陈旧列表（幽灵工具残留），直接放弃
                if (lifecycle.getConnectionGen(serverId) !== gen0) {
                    console.log('[MCP] shortDesc skip register for ' + serverId + ' (connection generation changed during generate)');
                    return;
                }
                // await 期间服务器可能已断开（onStopping → unregisterByServer），
                // 重新检查状态避免对已断开服务器 registerTools 注册幽灵工具
                var stAfter = lifecycle.getStatus(serverId);
                if (!stAfter || stAfter.state !== 'connected') {
                    console.log('[MCP] shortDesc skip register for ' + serverId + ' (state after generate: ' + (stAfter ? stAfter.state : 'unknown') + ')');
                    return;
                }
                // 重新注册工具以应用新的 shortDescription
                //（stub/scope 同样取 await 后重读的最新配置，避免旧快照回滚注册表）
                discovery.unregisterByServer(serverId);
                discovery.registerTools(serverId, tools, latestScope, merged, latestStubs);
                console.log('[MCP] shortDescription generated for ' + serverId);
                if (typeof onShortDescGenerated === 'function') {
                    onShortDescGenerated(serverId, true);
                }
            } catch (e) {
                // 整批失败——每个待生成工具计一次失败（连续达上限后不再重试）
                for (var ei = 0; ei < needGen.length; ei++) {
                    var errKey = _shortDescFailKey(serverId, needGen[ei].name);
                    _shortDescFails[errKey] = (_shortDescFails[errKey] || 0) + 1;
                }
                console.warn('[MCP] shortDescription generation failed for ' + serverId + ': ' + e.message);
                if (typeof onShortDescGenerated === 'function') {
                    onShortDescGenerated(serverId, false, e.message);
                }
            }
        }

        // bootstrap 完成后由 main.js 调用：扫描所有已连接服务器的待处理队列，
        // 以及当前已注册但缺 shortDescription 的工具，统一生成。
        // 此时 llmChannel、settingsStore、AEAppContainer 均已就绪，不再有 401 时序问题。
        function generateMissingShortDescsForAll() {
            _bootstrapReady = true;
            var pending = _pendingServers;
            _pendingServers = [];
            for (var i = 0; i < pending.length; i++) {
                var item = pending[i];
                // 服务器可能在 bootstrap 期间已断开，跳过已断开的服务器避免对幽灵工具生成描述
                // 并避免 registerTools 把已 unregister 的工具重新注册回去污染注册表
                var st = lifecycle.getStatus(item.serverId);
                if (!st || st.state !== 'connected') {
                    console.log('[MCP] shortDesc skip for ' + item.serverId + ' (state: ' + (st ? st.state : 'unknown') + ')');
                    continue;
                }
                // 入队后连接已换代（bootstrap 期间崩溃+重连）：该条目的 tools 是旧连接
                // 快照，新连接自己的流程已在跑，跳过避免旧快照回写污染注册表
                if (lifecycle.getConnectionGen(item.serverId) !== item.gen) {
                    console.log('[MCP] shortDesc skip for ' + item.serverId + ' (stale connection generation)');
                    continue;
                }
                _generateMissingShortDescs(item.serverId, item.tools, item.cachedDescs, item.cachedStubs, item.scope);
            }
        }

        return {
            configureServers: lifecycle.configure,
            startServer: lifecycle.start,
            autoStartAllServers: lifecycle.autoStartAll,
            stopServer: lifecycle.stop,
            restartServer: lifecycle.restart,
            addServer: lifecycle.add,
            removeServer: lifecycle.remove,
            updateServer: lifecycle.update,
            updateToolDescriptions: lifecycle.updateToolDescriptions,
            updateToolStubs: lifecycle.updateToolStubs,
            getServerStatus: lifecycle.getStatus,
            getAllServerStatuses: lifecycle.getAllStatuses,
            getServerConfig: lifecycle.getConfig,
            getAllServerConfigs: lifecycle.getAllConfigs,
            startServerSync: lifecycle.startSync,
            stopServerSync: lifecycle.stopSync,
            callServerTool: discovery.callTool,
            setAutoGenShortDesc: function(enabled) {
                _autoGenShortDesc = !!enabled;
                console.log('[MCP] autoGenShortDesc = ' + _autoGenShortDesc);
            },
            notifyToolsChanged: function(serverId) {
                var cfg = lifecycle.getConfig(serverId);
                var scope = (cfg && cfg.scope) ? cfg.scope : null;
                var cachedDescs = (cfg && cfg.toolDescriptions) ? cfg.toolDescriptions : null;
                var cachedStubs = (cfg && cfg.toolStubs) ? cfg.toolStubs : null;
                discovery.notifyChanged(serverId, scope, cachedDescs, cachedStubs);
            },
            setToolRegistry: function(reg) { toolRegistry = reg; },
            setCommunicationProvider: function(prov) { communicationProvider = prov; },
            setDisabledTools: function(list) {
                if (discovery && typeof discovery.setDisabledTools === 'function') {
                    discovery.setDisabledTools(list);
                }
            },
            // 最近一轮工具可用性失败明细（面板展示「已连接但工具不可用」；
            // 含注册失败与 tools/list 拉取失败两类条目）
            getLastRegisterErrors: function(serverId) {
                return (discovery && typeof discovery.getLastRegisterErrors === 'function')
                    ? discovery.getLastRegisterErrors(serverId) : [];
            },
            // 注册名 → 原始名（面板编辑器的稳定缓存键）
            getOriginalToolName: function(serverId, regName) {
                return (discovery && typeof discovery.getOriginalToolName === 'function')
                    ? discovery.getOriginalToolName(serverId, regName) : null;
            },
            onStatusChange: lifecycle.onStatusChange,
            offStatusChange: lifecycle.offStatusChange,
            shutdown: lifecycle.shutdown,
            generateMissingShortDescsForAll: generateMissingShortDescsForAll,
            createJsonRpcRequest: proto.createRequest,
            createJsonRpcError: proto.createError,
            isValidJsonRpcResponse: proto.isValidResponse,
            isJsonRpcSuccess: proto.isSuccess,
            isJsonRpcError: proto.isError,
            formatToolResult: proto.formatToolResult,
            JSON_RPC_ERRORS: proto.JSON_RPC_ERRORS,
            PROTOCOL_VERSION: proto.PROTOCOL_VERSION
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createServerManager = createServerManager;

})(window);
