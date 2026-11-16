(function(global) {

    // serverId 白名单：仅允许字母、数字、连字符、下划线，长度 1-64。
    // 仅在 add() 入口校验；configure()（持久化恢复/存量配置）不受影响。
    // 保留名（__proto__/constructor 等）额外拒绝：serverConfigs 是普通对象，
    // 这些键经 [[Set]] 走原型链——__proto__ 赋值污染原型、其余键 Object.keys 不可见，
    // 会产生 UI 不可见/不持久化但可启动注册工具的"隐形服务器"
    //（与 toolRegistry 的 RESERVED_TOOL_NAMES 防护对齐，双重防线）。
    var RESERVED_SERVER_IDS = Object.create(null);
    (function() {
        var names = ['__proto__', 'prototype', 'constructor', 'hasOwnProperty',
            'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf'];
        for (var i = 0; i < names.length; i++) RESERVED_SERVER_IDS[names[i]] = true;
    })();

    function isValidServerId(serverId) {
        return typeof serverId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(serverId)
            && !RESERVED_SERVER_IDS[serverId];
    }

    // 连接代数（connection generation）：按 serverId 计数"握手成功置 connected"的次数。
    // 崩溃自动重连后状态会回到 'connected'，仅凭状态复查挡不住旧连接的跨 await 回调
    // "洗白"回写；回调方在 await 前后核对本代数即可发现"连接已换代"而放弃回写
    var connectionGen = Object.create(null);

    function createServerLifecycle(config) {
        config = config || {};
        var protocol = config.protocol || null;
        var communicationProvider = config.communicationProvider || null;
        var settingsStore = config.settingsStore || null;
        var onBeforeCleanup = config.onBeforeCleanup || null;

        // null-prototype：堵住读取路径的原型链真值问题（如 getStatus('__proto__')
        // 在普通对象上会命中 Object.prototype 返回垃圾数据）；配合入口保留名拒绝双保险
        var serverConfigs = Object.create(null);
        var serverStates = Object.create(null);
        var serverErrors = Object.create(null);
        var statusListeners = [];

        // 落盘当前配置并返回写盘结果：settingsStore 写失败 resolve false
        //（配额满/加密异常）或抛异常都不得只 console.warn 就吞掉——调用点（add/update/
        // remove）把结果透传进回执，UI/LLM 据此提示「本次会话已生效，重启后回退」。
        // 无 settingsStore（单测/降级）视为无需落盘 = 成功，保持既有语义。
        async function persistConfigs() {
            if (!settingsStore) return { ok: true };
            try {
                var ok = await settingsStore.setModuleSettings('mcp-manager', { servers: getAllConfigs() });
                if (ok === false) {
                    console.warn('[MCP] Failed to persist configs: settingsStore write failed (changes lost on restart)');
                    return { ok: false, error: 'PERSIST_FAILED' };
                }
                return { ok: true };
            } catch (e) {
                console.warn('[MCP] Failed to persist configs:', e);
                return { ok: false, error: 'PERSIST_FAILED' };
            }
        }

        // 写盘结果合并进回执：写失败 → ok:false + persisted:false + error（配置本次
        // 会话已生效，重启后回退；调用方据 persisted===false 区分「运行时已应用」与
        // 「配置非法」）。写成功 → 保留原回执并标记 persisted:true（旧调用方读 .ok 不变）。
        function _receipt(base, persist) {
            base = base || {};
            if (persist && persist.ok === false) {
                base.ok = false;
                base.persisted = false;
                base.error = persist.error || 'PERSIST_FAILED';
                return base;
            }
            base.persisted = true;
            return base;
        }

        function notifyStatusChange(serverId, state) {
            for (var i = 0; i < statusListeners.length; i++) {
                try {
                    statusListeners[i](serverId, state);
                } catch (e) {}
            }
        }

        function validateServerConfig(cfg) {
            if (!cfg) return false;
            var hasUrl = !!(cfg.url && typeof cfg.url === 'string' && cfg.url.trim().length > 0);
            var hasCommand = !!(cfg.command && typeof cfg.command === 'string' && cfg.command.trim().length > 0);
            // url 与 command 互斥（对齐手动填写路径的 XOR 约束）——粘贴导入
            // 两者并存时 lifecycle 记 transport=http 而 provider 按 stdio spawn
            //（isHttpConfig 见 command 即判否），状态字段与实际传输相悖，直接拒绝
            if (hasUrl && hasCommand) return false;
            // HTTP/SSE transport: requires url
            if (hasUrl) return true;
            // stdio transport: requires command
            if (!hasCommand) return false;
            if (cfg.args && !Array.isArray(cfg.args)) return false;
            return true;
        }

        function parseServerScope(scope) {
            if (!scope) return { type: 'global' };
            if (typeof scope === 'string' && scope === 'global') return { type: 'global' };
            if (typeof scope === 'string') return { type: 'module', moduleIds: [scope], moduleId: scope };
            if (typeof scope === 'object' && scope.type === 'module') {
                var out = { type: 'module' };
                // 模块多选；兼容旧单一 moduleId
                if (Array.isArray(scope.moduleIds) && scope.moduleIds.length) {
                    out.moduleIds = scope.moduleIds.slice();
                } else if (scope.moduleId) {
                    out.moduleIds = [scope.moduleId];
                } else {
                    return { type: 'global' };
                }
                // 保留 moduleId 便捷引用（= 首项），兼容旧代码只读 scope.moduleId
                out.moduleId = out.moduleIds[0];
                // agent 模式多选；兼容旧单一 mode。
                // 白名单含 'external-mcp'（外接）：它是 Agent 模块的模式之一（面板第四个运行
                // 模式），展开时与 agent/script/shader 一样直接当 moduleId 用；漏了它会把用户
                // 勾的外接静默丢掉（配置里写了也等于没写）。
                if (Array.isArray(scope.agentModes) && scope.agentModes.length) {
                    var modes = scope.agentModes.filter(function(m) {
                        return m === 'agent' || m === 'script' || m === 'shader' || m === 'external-mcp';
                    });
                    if (modes.length) out.agentModes = modes;
                } else if (scope.mode && (scope.mode === 'agent' || scope.mode === 'script' || scope.mode === 'shader' || scope.mode === 'external-mcp')) {
                    out.agentModes = [scope.mode];
                }
                return out;
            }
            return { type: 'global' };
        }

        // headers 规范化：必须是 plain object（非数组、非 null），否则降级为 null
        // add/configure/update 三处共用，确保行为一致
        function _normalizeHeaders(h) {
            return (h && typeof h === 'object' && !Array.isArray(h)) ? h : null;
        }

        // autoStart 规范化（enabled 字段删除，停用语义改为
        // stop + setAutoStart(false)）。旧 schema 的 enabled=false ≡「立即断开 +
        // 不参与自启动」，字段级等效为 autoStart=false（不再自启；断开由显式 stop
        // 完成）——存量配置读入（configure/粘贴导入 add）时在此承接一次性迁移语义。
        // 归一化输出不含 enabled 键：新写入配置永不携带该字段（settings 落盘侧另有
        // bootstrap 的按需迁移，删除存量文件里的 enabled 键）。
        function _normalizeAutoStart(cfg) {
            if (cfg.enabled === false) return false;
            return cfg.autoStart !== false;
        }

        // MCP registry 标准用 "type" 字段表示 transport（streamable-http/stdio/sse）
        // 这里做兼容映射：type -> transport，同时保留 transport 字段直接指定的优先级
        function _resolveTransport(cfg) {
            if (cfg.transport) return cfg.transport;
            if (cfg.type) {
                var t = cfg.type;
                if (t === 'streamable-http' || t === 'remote') return 'http';
                if (t === 'stdio') return 'stdio';
                if (t === 'sse') return 'sse';
            }
            return cfg.url ? 'http' : 'stdio';
        }

        function syncProviderConfig(serverId, cfg) {
            if (communicationProvider && typeof communicationProvider.configureServer === 'function') {
                communicationProvider.configureServer(serverId, cfg);
            }
        }

        function unsyncProviderConfig(serverId) {
            if (communicationProvider && typeof communicationProvider.stopServer === 'function') {
                communicationProvider.stopServer(serverId);
            }
            if (communicationProvider && typeof communicationProvider.removeConfig === 'function') {
                communicationProvider.removeConfig(serverId);
            }
        }

        function performInitializeHandshake(serverId, callback) {
            if (!communicationProvider || typeof communicationProvider.send !== 'function') {
                callback(new Error('No communication provider available'));
                return;
            }
            if (!protocol || typeof protocol.buildInitializeRequest !== 'function') {
                callback(new Error('No protocol available'));
                return;
            }

            var done = false;
            var timeout = setTimeout(function() {
                if (done) return;
                done = true;
                console.warn('[MCP] Initialize timeout for ' + serverId + ' after 30s');
                callback(new Error('Initialize timeout - server did not respond within 30s'));
            }, 30000);

            var initReq = protocol.buildInitializeRequest();

            communicationProvider.send(serverId, JSON.stringify(initReq), function(err, rawResp) {
                if (done) return;
                done = true;
                clearTimeout(timeout);
                if (err) {
                    callback(err);
                    return;
                }
                try {
                    var resp = JSON.parse(rawResp);
                    protocol.validateInitializeResponse(resp);
                    callback(null, resp.result);
                } catch (e) {
                    callback(new Error('Failed to parse initialize response: ' + e.message));
                }
            });
        }

        function startServer(serverId) {
            if (!serverConfigs[serverId]) return false;
            // 停用语义（字段删除——停用 = stop + setAutoStart(false)）：
            // 停用服务器已断开（stop）且不参与自启动（autoStart=false），但显式
            // start/restart（UI 启动按钮 / LLM mcp_control start|restart）不是自启，
            // 本函数照常拉起。自启路径不经过这里兜底，各自要求 cfg.autoStart：
            // autoStartAll、handleCrash、recoverAllOnBridgeReconnect、configure/add 自启、
            // 面板启动恢复（bootstrap）。
            // 幂等：connected/connecting 期间重复调用（LLM start 工具、bridge 重连恢复与
            // 崩溃自动重启竞争等）直接返回，避免二次握手 → onConnected 双触发 →
            // fetchAndRegister 双注册把工具改名（foo → foo_2）污染注册表
            var prevState = serverStates[serverId];
            if (prevState === 'connected' || prevState === 'connecting') return true;

            syncProviderConfig(serverId, serverConfigs[serverId]);
            serverStates[serverId] = 'connecting';
            notifyStatusChange(serverId, 'connecting');
            // 新一轮握手开始——清除断流标记（握手失败置的 disconnected
            // 不属于 handleSseDisconnected，自愈回调不得把它误恢复为 connected）
            delete sseDown[serverId];

            performInitializeHandshake(serverId, function(err) {
                // 握手在途期间服务器可能已被 stop/remove/restart（stopServer 会同步 reject
                // 在途握手）。迟到的回调不得把 'stopped' 覆盖成 'connected'/'disconnected'，
                // 也不得触发 onConnected 对已停止的服务器做 fetchAndRegister 幽灵注册
                if (serverStates[serverId] !== 'connecting') return;
                if (err) {
                    console.warn('[MCP] Handshake failed for ' + serverId + ': ' + err.message);
                    serverErrors[serverId] = err.message;
                    serverStates[serverId] = 'disconnected';
                    notifyStatusChange(serverId, 'disconnected');
                    return;
                }
                // MCP 规范：initialize 响应后客户端 MUST 发送 initialized 通知再进入正常操作。
                // fire-and-forget：通知无 id，三种 transport 均不挂 pending，空回调忽略即可。
                try {
                    var initializedNote = protocol.buildInitializedNotification();
                    communicationProvider.send(serverId, JSON.stringify(initializedNote), function() {});
                } catch (e) {
                    console.warn('[MCP] Failed to send initialized notification for ' + serverId + ': ' + e.message);
                }
                serverErrors[serverId] = null;
                // 连接代数递增：所有连接路径的唯一汇聚点——手动启动/崩溃自动重启
                //（handleCrash → setTimeout → startServer）/bridge 重连恢复
                //（recoverAllOnBridgeReconnect → restart → startServer）都经此处握手成功
                connectionGen[serverId] = (connectionGen[serverId] || 0) + 1;
                serverStates[serverId] = 'connected';
                notifyStatusChange(serverId, 'connected');

                if (onBeforeCleanup && typeof onBeforeCleanup.onConnected === 'function') {
                    onBeforeCleanup.onConnected(serverId);
                }
            });

            return true;
        }

        function stopServer(serverId) {
            // 存在性守卫（对齐 startServer/stopSync）——stop 不存在的 server
            // 直接跳过，不再往 serverStates 写入残留 'stopped' 条目（残留会让后续
            // 同名 add 的 getStatus 误报 stopped；restart 对不存在 server 亦经此拦住）
            if (!serverConfigs[serverId]) return false;
            if (onBeforeCleanup && typeof onBeforeCleanup.onStopping === 'function') {
                onBeforeCleanup.onStopping(serverId);
            }
            unsyncProviderConfig(serverId);
            serverStates[serverId] = 'stopped';
            notifyStatusChange(serverId, 'stopped');
            return true;
        }

        function restartServer(serverId) {
            stopServer(serverId);
            return startServer(serverId);
        }

        // bridge 断线重连后恢复所有"本应运行"的 server：统一走 stop+start 完整重建，
        // 使客户端状态与 bridge 侧子进程一致（bridge 进程重启会丢失全部子进程/配置）。
        // 跳过用户手动停止的 server；autoStart 的 server 无论运行前状态（connected/disconnected）
        // 都重建，避免 bridge 重启后客户端状态残留 'connected' 而实际进程已不存在。
        function recoverAllOnBridgeReconnect() {
            var ids = Object.keys(serverConfigs);
            var recovered = 0;
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var cfg = serverConfigs[id];
                if (!cfg || !cfg.autoStart) continue;
                if (serverStates[id] && serverStates[id] === 'stopped') continue;
                restartServer(id);
                recovered++;
            }
            if (recovered > 0) {
                console.log('[MCP] bridge reconnected, recovered ' + recovered + ' server(s)');
            }
            return recovered;
        }

        // 进程崩溃/意外退出回调（由 communicationProvider 触发）：
        // 同步状态为 disconnected + 通知 UI；非主动停止且配置 autoStart 时自动重启。
        // 防循环重启：30s 窗口内崩溃超过 3 次则放弃自动重启。
        var crashTimes = Object.create(null);
        // 标记「disconnected 是 handleSseDisconnected 置的」——自愈重连
        // （handleSseReconnected）只恢复自己置的状态，握手失败等其他来源的
        // disconnected（须走 startServer 全链重建）不被误恢复为 connected。
        var sseDown = Object.create(null);

        // SSE 断流轻量状态同步——只把「已连接」置为 disconnected 供 UI
        // 感知。不注销工具、不触发自动重启：断流是可自愈的传输层故障，
        // scheduleReconnect 重连成功后 transport 与会话照常（基线语义），工具注册表
        // 全程有效。connecting 态留给握手超时路径善后（迟到的握手回调按
        // state!=='connecting' 守卫忽略）。
        function handleSseDisconnected(serverId, info) {
            if (!serverConfigs[serverId]) return;
            if (serverStates[serverId] !== 'connected') return;
            sseDown[serverId] = true;
            serverErrors[serverId] = (info && info.error) || 'SSE connection lost';
            serverStates[serverId] = 'disconnected';
            notifyStatusChange(serverId, 'disconnected');
        }

        // SSE 自愈重连成功（endpoint 重新送达）——恢复自己置的
        // disconnected 为 connected；工具注册表全程未动，无需 re-register。
        // 停用（autoStart=false + stop）不构成拦截：stopServer 已把状态置 stopped，
        // 本函数（sseDown + disconnected）的状态守卫足以挡住已停止服务器的幽灵恢复。
        function handleSseReconnected(serverId) {
            if (!serverConfigs[serverId]) return;
            if (!sseDown[serverId] || serverStates[serverId] !== 'disconnected') return;
            delete sseDown[serverId];
            serverErrors[serverId] = null;
            serverStates[serverId] = 'connected';
            notifyStatusChange(serverId, 'connected');
        }

        function handleCrash(serverId, info) {
            if (!serverConfigs[serverId]) return;
            info = info || {};
            // 用户主动停止（stopServer）不重启、也不覆盖状态——stopServer 已置 'stopped'，
            // 迟到的 close 事件若在此强制改 'disconnected'，会让 UI 状态与事实脱节
            if (info.intentional) return;
            serverErrors[serverId] = info.error || ('Process exited unexpectedly (code ' + info.code + ')');
            serverStates[serverId] = 'disconnected';
            notifyStatusChange(serverId, 'disconnected');
            // 无论是否 autoStart/熔断，崩溃后先注销该 server 已注册的工具：
            // 崩溃不经过 stopServer → onStopping，若不清理，陈旧同名工具残留在注册表，
            // 下次启动 fetchAndRegister 会因 hasTool 冲突改名（foo → foo_2 → foo_3…）
            if (onBeforeCleanup && typeof onBeforeCleanup.onStopping === 'function') {
                try { onBeforeCleanup.onStopping(serverId); } catch (_) {}
            }
            var cfg = serverConfigs[serverId];
            if (!cfg || !cfg.autoStart) return;
            var now = Date.now();
            var recent = (crashTimes[serverId] || []).filter(function (t) { return now - t < 30000; });
            recent.push(now);
            crashTimes[serverId] = recent;
            if (recent.length > 3) {
                console.warn('[MCP] ' + serverId + ' crashed ' + recent.length + ' times in 30s, auto-restart disabled');
                return;
            }
            console.warn('[MCP] Auto-restarting ' + serverId + ' after unexpected exit');
            setTimeout(function () {
                // 调度期间用户/LLM 已主动 stop（状态离开 'disconnected'）则不再拉起：
                // 迟到的自动重启不得覆盖停止意图（remove 场景由 serverConfigs
                // 存在性守卫兜底，stop 场景需同样守卫）
                if (serverStates[serverId] !== 'disconnected') return;
                startServer(serverId);
            }, 1000);
        }

        function configure(servers, options) {
            if (!servers || typeof servers !== 'object') return;
            options = options || {};
            var skipAutoStart = options.skipAutoStart === true;

            var serverIds = Object.keys(servers);
            for (var i = 0; i < serverIds.length; i++) {
                var serverId = serverIds[i];
                var serverConfig = servers[serverId];

                // 保留名跳过：configure 恢复持久化数据不走 isValidServerId，
                // 历史版本/手工编辑的 settings 可能带 __proto__ 等键，
                // 直接赋值会污染 serverConfigs 原型（其余存量非常规 id 仍放行）
                if (RESERVED_SERVER_IDS[serverId]) continue;

                if (!validateServerConfig(serverConfig)) {
                    if (onBeforeCleanup && typeof onBeforeCleanup.onStopping === 'function') {
                        onBeforeCleanup.onStopping(serverId);
                    }
                    continue;
                }

                serverConfigs[serverId] = {
                    command: serverConfig.command || '',
                    args: serverConfig.args || [],
                    env: serverConfig.env || null,
                    url: serverConfig.url || '',
                    transport: _resolveTransport(serverConfig),
                    autoStart: _normalizeAutoStart(serverConfig),
                    scope: parseServerScope(serverConfig.scope),
                    headers: _normalizeHeaders(serverConfig.headers),
                    toolDescriptions: serverConfig.toolDescriptions || null,
                    toolStubs: serverConfig.toolStubs || null
                };

                if (!skipAutoStart && serverConfigs[serverId].autoStart) {
                    syncProviderConfig(serverId, serverConfigs[serverId]);
                    startServer(serverId);
                }
            }
        }

        // add 的规范化建配置：缓存字段（toolDescriptions/toolStubs）由调用方传入——
        // 全新 server 置 null；同名已存在则保留原值
        function _buildServerConfig(serverConfig, toolDescriptions, toolStubs) {
            return {
                command: serverConfig.command || '',
                args: serverConfig.args || [],
                env: serverConfig.env || null,
                url: serverConfig.url || '',
                transport: _resolveTransport(serverConfig),
                autoStart: _normalizeAutoStart(serverConfig),
                scope: parseServerScope(serverConfig.scope),
                headers: _normalizeHeaders(serverConfig.headers),
                toolDescriptions: toolDescriptions || null,
                toolStubs: toolStubs || null
            };
        }

        async function add(serverId, serverConfig) {
            if (!isValidServerId(serverId)) {
                // 拒绝非法 serverId（含粘贴导入的恶意键名），错误中带被拒绝的 id 便于展示
                var rejectedId = String(serverId);
                if (rejectedId.length > 80) rejectedId = rejectedId.substring(0, 80) + '...';
                return { ok: false, error: 'INVALID_SERVER_ID: ' + rejectedId };
            }
            if (!validateServerConfig(serverConfig)) return { ok: false, error: 'INVALID_CONFIG' };
            // 同名 add 不做覆盖式"半更新"。无存在性检查直接赋值时：
            // ① 硬编码 toolDescriptions/toolStubs 为 null 并立即 persistConfigs 落盘，
            //    LLM 生成+用户手编的短描述与逐工具 Stub 缓存被清空且不可恢复；
            // ② 运行中（connected/connecting）的 server 因 startServer 幂等守卫直接
            //    return true，不重启不重握手不 fetch 工具，direct 模式旧进程继续跑
            //    旧 command/args/env——UI 显示"已连接"但新配置未生效、工具列表不刷新。
            // 粘贴导入与 LLM add 两条入口均无查重（UI 编辑路径走 update 规避），
            // 统一在此拦截：
            //   - 运行过且非 stopped（含 disconnected：bridge 侧旧进程可能仍存活，
            //     spawn 帧对存活进程是 no-op，仅换配置不重启同样是半更新）→ 复用
            //     update(restart:true)：停旧进程+应用新配置+重启重握手；缓存字段由
            //     update 的 merge 白名单天然保留。patch 含全部合并键 → 全量替换语义
            //     （与新建 add 一致，不残留旧 url/transport 等字段）
            //   - stopped/unknown（未在跑）→ 整体替换为新配置但保留缓存字段
            var existing = serverConfigs[serverId];
            if (existing) {
                var runState = serverStates[serverId];
                if (runState && runState !== 'stopped') {
                    return update(serverId, _buildServerConfig(serverConfig, null, null), { restart: true });
                }
                serverConfigs[serverId] = _buildServerConfig(serverConfig,
                    existing.toolDescriptions, existing.toolStubs);
            } else {
                serverConfigs[serverId] = _buildServerConfig(serverConfig, null, null);
            }
            // 落盘改为在回执中透传（见 persistConfigs/_receipt）。先同步
            // 启动写盘（不阻塞下方运行时副作用），副作用照旧同步执行，最后 await 结果。
            // 调用方（view.js/llmTools）须 await，据 persisted===false 提示「本次会话
            // 已生效，重启后回退」——写失败不再返回假 ok:true。
            var persistPromise = persistConfigs();
            if (serverConfigs[serverId].autoStart) {
                syncProviderConfig(serverId, serverConfigs[serverId]);
                startServer(serverId);
            }
            return _receipt({ ok: true }, await persistPromise);
        }

        async function remove(serverId) {
            stopServer(serverId);
            delete serverConfigs[serverId];
            delete serverStates[serverId];
            // 同步清崩溃计数——remove 后同名 server 重新加入时，残留的
            // crashTimes 会让旧崩溃继续计入 30s 熔断窗口（新进程被旧计数误熔断）
            delete crashTimes[serverId];
            return _receipt({ ok: true }, await persistConfigs());
        }

        // update：智能合并 patch 到现有配置（不删除重建）。
        // - patch 顶层字段直接覆盖（command/args/env/url/autoStart/scope/transport）
        // - transport/scope 重新解析，保持与 add 一致的规范化
        // - options.restart=true 且当前 connected 时触发 restart 使配置生效；
        //   否则仅 syncProviderConfig 让 provider 感知新配置（已连接的服务器不会断开）
        async function update(serverId, patch, options) {
            if (!serverConfigs[serverId]) return { ok: false, error: 'SERVER_NOT_FOUND' };
            if (!patch || typeof patch !== 'object') return { ok: false, error: 'INVALID_PATCH' };
            options = options || {};
            var merged = JSON.parse(JSON.stringify(serverConfigs[serverId]));
            var keys = ['command','args','env','url','autoStart','scope','transport','headers'];
            for (var i = 0; i < keys.length; i++) {
                if (patch.hasOwnProperty(keys[i])) merged[keys[i]] = patch[keys[i]];
            }
            merged.transport = _resolveTransport(merged);
            merged.scope = parseServerScope(merged.scope);
            // headers 类型规范化（与 add/configure 一致：非对象/数组降级为 null）
            merged.headers = _normalizeHeaders(merged.headers);
            if (!validateServerConfig(merged)) return { ok: false, error: 'INVALID_CONFIG' };
            serverConfigs[serverId] = merged;
            // 先同步启动写盘，运行时副作用（restart/sync）照旧同步执行，
            // 最后 await 写盘结果并入回执（写失败 ok:false + persisted:false）
            var persistPromise = persistConfigs();
            // 仅当 provider 相关键（连接参数）变化时才 sync：autoStart/scope 是
            // 纯客户端字段，无差别 sync 会让已连接的 HTTP/SSE 服务器经历一次连接断开重连
            var providerKeys = ['command', 'args', 'env', 'url', 'transport', 'headers'];
            var providerChanged = false;
            for (var pi = 0; pi < providerKeys.length; pi++) {
                if (patch.hasOwnProperty(providerKeys[pi])) { providerChanged = true; break; }
            }
            // restart 在"运行过"的非 stopped 状态都执行完整 stop+start：只覆盖 connected 状态时
            // restart，connecting/disconnected 时只 sync 配置——bridge 侧旧进程存活时
            // spawn 帧是 no-op（ae-bridge handleSpawn 对存活进程直接回 spawned），
            // 旧 command/env 继续生效，用户以为保存已生效。
            // stopped 不重启：保持用户手动停止的意图，配置下次启动时生效；
            // undefined（从未启动）同样不拉起：restart 语义是"重启已运行的"，
            // 不是"启动"，否则编辑保存一个从未启动的服务器会意外拉起进程
            if (options.restart && serverStates[serverId] && serverStates[serverId] !== 'stopped') {
                restartServer(serverId);
            } else if (providerChanged) {
                // 仅运行中（connected/connecting）才 sync。configureServer 并非纯配置
                // 更新——bridge 模式发 spawn 帧（ae-bridge handleSpawn 对无进程的 server 会
                // 真实拉起）、HTTP/SSE 模式直接建立连接。stopped/unknown（从未启动）的
                // server 被 sync 等于隐式启动：lifecycle 状态不跟进（无握手、无工具注册），
                // bridge 侧进程成无主干跑（资源泄漏，UI 显示已停止与事实脱节）。配置留存
                // lifecycle，下次 startServer 的无条件 syncProviderConfig 生效，不丢配置。
                var runState = serverStates[serverId];
                if (runState === 'connected' || runState === 'connecting') {
                    syncProviderConfig(serverId, merged);
                }
            }
            return _receipt({ ok: true }, await persistPromise);
        }

        // 仅更新 toolDescriptions 字段并持久化，不影响连接状态。
        // 供 shortDescGenerator 生成后回写缓存使用。
        // 对齐 add/update/remove 的 _receipt 机制——不 await persist 且恒
        // 返回 {ok:true}，写盘失败静默丢失（重启后缓存回退）。现返回 Promise 回执，
        // 调用方（serverManager/view）须消费 persisted===false 提示「本次会话已生效，
        // 重启后回退」。内存字段在 await 前同步写入（调用方即时可见，时序不变）。
        async function updateToolDescriptions(serverId, descriptions) {
            if (!serverConfigs[serverId]) return { ok: false, error: 'SERVER_NOT_FOUND' };
            serverConfigs[serverId].toolDescriptions = descriptions || null;
            return _receipt({ ok: true }, await persistConfigs());
        }

        // 仅更新 toolStubs 字段并持久化，不影响连接状态。
        // 供编辑面板逐工具切换 stub 模式使用。同 updateToolDescriptions。
        async function updateToolStubs(serverId, stubs) {
            if (!serverConfigs[serverId]) return { ok: false, error: 'SERVER_NOT_FOUND' };
            serverConfigs[serverId].toolStubs = stubs || null;
            return _receipt({ ok: true }, await persistConfigs());
        }

        function getConfig(serverId) {
            return serverConfigs[serverId] || null;
        }

        function getAllConfigs() {
            var configs = {};
            var ids = Object.keys(serverConfigs);
            for (var i = 0; i < ids.length; i++) {
                configs[ids[i]] = serverConfigs[ids[i]];
            }
            return configs;
        }

        function getStatus(serverId) {
            if (!serverConfigs[serverId]) return null;
            return {
                id: serverId,
                state: serverStates[serverId] || 'unknown',
                config: serverConfigs[serverId],
                lastError: serverErrors[serverId] || null
            };
        }

        // 当前连接代数：从未连接过返回 0。供跨 await 的回调核对接连接是否已换代
        //（remove/shutdown 不复位：代数只增不减，陈旧回调永远比不出"相等"）
        function getConnectionGen(serverId) {
            return connectionGen[serverId] || 0;
        }

        function getAllStatuses() {
            var statuses = [];
            var ids = Object.keys(serverConfigs);
            for (var i = 0; i < ids.length; i++) {
                statuses.push(getStatus(ids[i]));
            }
            return statuses;
        }

        function startSync(serverId) {
            if (!serverConfigs[serverId]) return { ok: false, error: 'SERVER_NOT_FOUND' };
            // 停用 = stop + setAutoStart(false)，只表示
            // 「已断开 + 不参与自启动」——显式 start 是用户/LLM 的主动动作，放行
            if (serverStates[serverId] === 'connected') return { ok: true, status: 'already_connected' };
            var started = startServer(serverId);
            return { ok: started, status: serverStates[serverId] || 'unknown' };
        }

        function stopSync(serverId) {
            if (!serverConfigs[serverId]) return { ok: false, error: 'SERVER_NOT_FOUND' };
            stopServer(serverId);
            return { ok: true, status: 'stopped' };
        }

        // 自启路径（停用 = stop + setAutoStart(false)）：
        // autoStart=false 的服务器不参与自启（显式 start 不受影响，见 startServer 头注释）
        function autoStartAll() {
            var ids = Object.keys(serverConfigs);
            var count = 0;
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var cfg = serverConfigs[id];
                if (cfg.autoStart) {
                    startServer(id);
                    count++;
                }
            }
            return count;
        }

        function shutdown() {
            var ids = Object.keys(serverConfigs);
            for (var i = 0; i < ids.length; i++) {
                stopServer(ids[i]);
            }
            if (communicationProvider && typeof communicationProvider.stopAll === 'function') {
                communicationProvider.stopAll();
            }
            serverConfigs = Object.create(null);
            serverStates = Object.create(null);
            serverErrors = Object.create(null);
        }

        return {
            configure: configure,
            add: add,
            remove: remove,
            update: update,
            updateToolDescriptions: updateToolDescriptions,
            updateToolStubs: updateToolStubs,
            start: startServer,
            stop: stopServer,
            restart: restartServer,
            autoStartAll: autoStartAll,
            shutdown: shutdown,
            getConfig: getConfig,
            getAllConfigs: getAllConfigs,
            getStatus: getStatus,
            getAllStatuses: getAllStatuses,
            getConnectionGen: getConnectionGen,
            startSync: startSync,
            stopSync: stopSync,
            handleCrash: handleCrash,
            handleSseDisconnected: handleSseDisconnected,
            handleSseReconnected: handleSseReconnected,
            recoverAllOnBridgeReconnect: recoverAllOnBridgeReconnect,
            onStatusChange: function(fn) { statusListeners.push(fn); },
            offStatusChange: function(fn) {
                var idx = statusListeners.indexOf(fn);
                if (idx !== -1) statusListeners.splice(idx, 1);
            }
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createServerLifecycle = createServerLifecycle;

})(window);
