(function(global) {

    if (typeof window !== 'undefined' && !window.__ext_root) {
        var href = window.location.href;
        var clientIdx = href.indexOf('/client/');
        if (clientIdx >= 0) {
            var raw = decodeURIComponent(href.substring(0, clientIdx));
            raw = raw.replace(/^file:\/\/\//, '').replace(/\//g, '\\');
            window.__ext_root = raw;
        }
    }

    async function initMCP(config) {
        var bridge = config.bridge;
        var settingsStore = config.settingsStore;

        var toolRegistry = config.toolRegistry;
        if (!toolRegistry) {
            console.error('[MCP Bootstrap] initMCP called without toolRegistry');
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }

        var toolExecutor = config.toolExecutor;
        if (!toolExecutor) {
            console.error('[MCP Bootstrap] initMCP called without toolExecutor');
            return { ok: false, error: 'MISSING_TOOL_EXECUTOR' };
        }

        var communicationProvider = null;
        if (typeof global.AE_LLM.createCommunicationProvider === 'function') {
            communicationProvider = global.AE_LLM.createCommunicationProvider();
        }

        var serverManager = global.AE_LLM.createServerManager({
            toolRegistry: toolRegistry,
            communicationProvider: communicationProvider,
            settingsStore: settingsStore,
            onShortDescGenerated: function(serverId, success, errMsg) {
                if (success) {
                    // 成功时静默更新，不打扰用户
                    console.log('[MCP] shortDescription ready for ' + serverId);
                } else {
                    // 失败时弹提示，告知用户可重启重试
                    if (global.AEToast) {
                        global.AEToast.show(AEI18n.t('{server} 工具描述生成失败，重启服务器可重试', { server: serverId }), 'error');
                    }
                }
            }
        });
        global.AE_LLM.serverManager = serverManager;

        var mcpSettings = await settingsStore.getModuleSettings('mcp-manager', { servers: {} });
        // settings 文件损坏时 servers 可能为 null，防御初始化避免下方键访问抛 TypeError 中断 initMCP
        if (!mcpSettings.servers) mcpSettings.servers = {};

        // 存量明文容器兼容：读到非空明文 servers 结构时，加密层可用则按当前内存配置写回一次
        // 转密文（写失败保留标记、下次启动重试）；加密层不可用时不写——降级写入会剔除 servers。
        // 放在其它迁移之前，避免后续步骤抛错时明文一直留盘。
        if (typeof settingsStore.needsContainerEncryption === 'function' && settingsStore.needsContainerEncryption()) {
            if (global.AEShared && typeof global.AEShared.encryptSensitive === 'function') {
                try {
                    var encryptedAtRestOk = await settingsStore.setModuleSettings('mcp-manager', { servers: mcpSettings.servers });
                    if (encryptedAtRestOk === false) {
                        console.warn('[MCP Bootstrap] container encryption not persisted (settingsStore write failed)');
                    } else if (typeof settingsStore.clearContainerEncryptionNeed === 'function') {
                        settingsStore.clearContainerEncryptionNeed();
                    }
                } catch (encErr) {
                    console.warn('[MCP Bootstrap] container encryption failed:', encErr);
                }
            } else {
                console.warn('[MCP Bootstrap] MCP config still stored in plaintext: encryption layer unavailable');
            }
        }

        // 恢复工具启用/禁用状态
        if (serverManager && typeof serverManager.setDisabledTools === 'function') {
            serverManager.setDisabledTools(mcpSettings._disabledTools || []);
        }
        // 恢复 autoGenShortDesc 设置（默认开启）
        if (serverManager && typeof serverManager.setAutoGenShortDesc === 'function') {
            serverManager.setAutoGenShortDesc(mcpSettings.autoGenShortDesc !== false);
        }
        // 旧 key 名迁移：open-websearch → open-webSearch
        // 迁移结果须落盘——只在内存生效时（本次会话 configure 用迁移后
        // 的内存副本，settings 文件仍存旧 key），每次启动都重复迁移。仅在真正发生
        // 迁移时写盘，避免正常启动多余 IO
        var migratedWebSearchKey = false;
        if (mcpSettings.servers['open-websearch'] && mcpSettings.servers['open-webSearch']) {
            delete mcpSettings.servers['open-websearch'];
            migratedWebSearchKey = true;
        }
        if (!mcpSettings.servers['open-webSearch'] && mcpSettings.servers['open-websearch']) {
            mcpSettings.servers['open-webSearch'] = mcpSettings.servers['open-websearch'];
            delete mcpSettings.servers['open-websearch'];
            migratedWebSearchKey = true;
        }
        // enabled 字段移除迁移（删字段，停用语义改为
        // stop + setAutoStart(false)）：旧配置 enabled=false 的本意是「不再自启」，
        // 由 autoStart=false 承接（断开由显式 stop 完成），随后删除 enabled 键。
        // 幂等：迁移后配置不再含 enabled，下次启动 changed=false 不写盘
        // （只按缺失承接 autoStart，不无限改写——对齐上方旧 key 迁移的按需写盘模式）
        var migratedEnabledFlag = false;
        (function () {
            var srvIds = Object.keys(mcpSettings.servers);
            for (var si = 0; si < srvIds.length; si++) {
                var srvCfg = mcpSettings.servers[srvIds[si]];
                if (!srvCfg || typeof srvCfg !== 'object' || Array.isArray(srvCfg)) continue;
                if (!Object.prototype.hasOwnProperty.call(srvCfg, 'enabled')) continue;
                if (srvCfg.enabled === false && srvCfg.autoStart !== false) srvCfg.autoStart = false;
                delete srvCfg.enabled;
                migratedEnabledFlag = true;
            }
        })();
        if (migratedWebSearchKey || migratedEnabledFlag) {
            try {
                // setModuleSettings 为读-改-写合并语义（spread 覆盖同名键），整对象
                // 写回安全；写失败（resolve false）仅告警——下次启动会再迁移
                var migratedOk = await settingsStore.setModuleSettings('mcp-manager', mcpSettings);
                if (migratedOk === false) {
                    console.warn('[MCP Bootstrap] settings migration not persisted (settingsStore write failed)');
                }
            } catch (e) {
                console.warn('[MCP Bootstrap] settings migration not persisted:', e);
            }
        }

        if (mcpSettings && mcpSettings.servers && Object.keys(mcpSettings.servers).length > 0) {
            // 桥接就绪应以 node 桥接（ws 通道）能否握手为准，而非 CEP CSInterface 存在与否。
            // config.bridge 是 cepBridge，其 isAvailable() 只判 CSInterface（CEP 环境恒 true），
            // 会让 MCP server 在 ae-bridge 进程就绪前抢跑握手失败，卡在 disconnected 需手动重连。
            // 改用全局 Bridge（shared/bridge.js）的真实探测；非 CEP/无全局 Bridge 时回退原判断。
            var bridgeReady = (typeof Bridge !== 'undefined' && typeof Bridge.isAvailable === 'function')
                ? Bridge.isAvailable()
                : bridge.isAvailable();

            if (!bridgeReady) {
                serverManager.configureServers(mcpSettings.servers, { skipAutoStart: true });
                console.log('[AE] MCP servers loaded (auto-start skipped: bridge not ready)');

                var autoStartRetries = 0;
                var autoStartMaxRetries = 20;
                var autoStartTimer = setInterval(function() {
                    autoStartRetries++;
                    try {
                        var diag = communicationProvider && communicationProvider.getDiagnostics ? communicationProvider.getDiagnostics() : null;
                        // direct 模式（Node 可用，provider 创建时未切 bridge）本地即可 spawn，
                        // 无需等 bridge WS 握手；原条件只认 bridgeConnected，direct 模式自启动
                        // 永不触发、60s 后放弃（审计）
                        var directReady = !!(diag && diag.mode === 'direct' && diag.requireAvailable);
                        if ((diag && diag.bridgeConnected) || directReady) {
                            clearInterval(autoStartTimer);
                            var started = serverManager.autoStartAllServers();
                            if (started > 0) {
                                console.log('[AE] ' + (directReady ? 'Direct mode ready' : 'Bridge connected') + ', auto-started ' + started + ' MCP server(s)');
                            }
                        } else if (autoStartRetries >= autoStartMaxRetries) {
                            clearInterval(autoStartTimer);
                            console.warn('[AE] Bridge not connected after ' + (autoStartMaxRetries * 3) + 's, giving up auto-start');
                        }
                    } catch (e) {}
                }, 3000);
            } else {
                serverManager.configureServers(mcpSettings.servers);

                // 冷启动 WS 握手存在固定延迟窗口（H1 token 首连被拒 + 退避重连 1s→2s→4s），
                // 3s 一次性检查会把「稍后才连上」误报为断连（实测 4s 连上）。
                // 改为 3s 首查 + 每秒复查，8s 仍断开才告警
                setTimeout(function() {
                    var retries = 0;
                    var maxRetries = 5;
                    (function recheck() {
                        try {
                            var diag = communicationProvider && communicationProvider.getDiagnostics ? communicationProvider.getDiagnostics() : null;
                            if (diag && diag.bridgeConnected) return;
                            if (retries < maxRetries) {
                                retries++;
                                setTimeout(recheck, 1000);
                                return;
                            }
                            console.warn('[AE] Bridge not connected after 8s. ' +
                                'URL: ' + (diag ? (diag.bridgeUrl || 'unknown') : 'unknown') + '. ' +
                                'Start it manually: node client\\shared\\ae-bridge.js');
                        } catch (e) {}
                    })();
                }, 3000);
            }
        }

        return { toolRegistry, toolExecutor, serverManager, communicationProvider };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.initMCP = initMCP;

})(window);
