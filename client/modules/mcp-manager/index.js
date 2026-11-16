(function (global) {
    var mounted = false;
    var _mcpView = null;
    var _controller = null;
    // 挂载期间注册的状态监听：unmount 时注销，防止反复挂载在 lifecycle 的
    // statusListeners 数组里累积监听器（每次状态变更触发 N 次冗余重渲染）
    var _statusListener = null;

    var mcpManagerModule = {
        id: 'mcp-manager',
        // getter：模块对象在文件加载时求值，翻译推迟到读取时
        get title() { return AEI18n.t('MCP 管理'); },
        get description() { return AEI18n.t('外部 MCP 服务器集成管理，支持 stdio/SSE/HTTP 协议，服务器启停与工具发现'); },
        panelId: 'mcpManagerPanel',

        mount(containerContext) {
            if (mounted) {
                return;
            }

            var panel = document.getElementById('mcpManagerPanel');
            if (panel) {
                panel.classList.remove('hidden');
            }

            _controller = global.AEMcpManager.createMcpManagerController(containerContext);

            _mcpView = global.AE_LLM.createMcpView({
                toolRegistry: _controller.getToolRegistry(),
                serverManager: _controller.getServerManager(),
                settingsStore: containerContext.settingsStore,
                moduleId: this.id
            });

            var serverMgr = _controller.getServerManager();
            if (serverMgr && typeof serverMgr.onStatusChange === 'function') {
                _statusListener = function() {
                    if (_mcpView && typeof _mcpView.renderServerList === 'function') {
                        _mcpView.renderServerList();
                    }
                };
                serverMgr.onStatusChange(_statusListener);
            }

            var body = document.getElementById('mcpMgmtBody');
            if (_mcpView && body) {
                _mcpView.render(body);
            }
            // 全部成功后才置位（对齐 agent/index.js 的模式）——否则
            // 先置后挂，createXxx 抛错时 mounted 残留 true，再次进入被守卫静默空跑
            mounted = true;
        },

        showSettings: function () { showMcpSettingsModal(); },

        unmount() {
            if (!mounted) {
                return;
            }
            mounted = false;

            var panel = document.getElementById('mcpManagerPanel');
            if (panel) {
                panel.classList.add('hidden');
            }

            // 先于 _controller 置空取 serverManager 注销监听
            var serverMgr = _controller ? _controller.getServerManager() : null;
            if (serverMgr && typeof serverMgr.offStatusChange === 'function' && _statusListener) {
                serverMgr.offStatusChange(_statusListener);
            }
            _statusListener = null;

            if (_mcpView && typeof _mcpView.destroy === 'function') {
                _mcpView.destroy();
            }
            _mcpView = null;
            _controller = null;
        },

        getToolRegistry: function () {
            return _controller ? _controller.getToolRegistry() : null;
        },

        getToolExecutor: function () {
            return _controller ? _controller.getToolExecutor() : null;
        },

        getServerManager: function () {
            return _controller ? _controller.getServerManager() : null;
        },

        refresh: function () {
            if (_mcpView) {
                if (typeof _mcpView.renderToolList === 'function') _mcpView.renderToolList();
                if (typeof _mcpView.renderServerList === 'function') _mcpView.renderServerList();
            }
        }
    };

    var MCP_SETTINGS_CONTAINER = 'mcpSettingsContainer';

    // 读取 MCP 模块设置（autoGenShortDesc 默认 true）
    async function _loadMcpSettings(settingsStore) {
        if (!settingsStore || typeof settingsStore.getModuleSettings !== 'function') return { autoGenShortDesc: true };
        try {
            var s = await settingsStore.getModuleSettings('mcp-manager', { autoGenShortDesc: true });
            return {
                autoGenShortDesc: s.autoGenShortDesc !== false
            };
        } catch (e) {
            return { autoGenShortDesc: true };
        }
    }

    function showMcpSettingsModal() {
        var modalBody = document.querySelector('#settingsModal .modal-body');
        if (!modalBody) return;

        // 异步加载设置后渲染
        var settingsStore = null;
        try {
            if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                var ctx = global.AEAppContainer.getContext();
                if (ctx && ctx.settingsStore) settingsStore = ctx.settingsStore;
            }
        } catch (e) {}

        _loadMcpSettings(settingsStore).then(function(settings) {
            _renderMcpSettings(modalBody, settings, settingsStore);
        }).catch(function() {
            _renderMcpSettings(modalBody, { autoGenShortDesc: true }, settingsStore);
        });
    }

    function _renderMcpSettings(modalBody, settings, settingsStore) {
        var autoGenChecked = settings.autoGenShortDesc !== false;

        var html = '<div id="' + MCP_SETTINGS_CONTAINER + '" class="ae-settings-root">';

        // 卡片 1：短描述自动生成
        html += '<div class="ae-settings-card">';
        html += '<div class="ae-settings-card-head">';
        html += '<span class="ae-settings-card-icon">✨</span>';
        html += AEI18n.html('<div class="ae-settings-card-title">短描述自动生成</div>');
        html += '</div>';
        html += '<div class="ae-settings-card-body">';
        html += AEI18n.html('<p class="ae-settings-card-desc">MCP 服务器连接成功后，自动调用 LLM 为每个工具生成简短中文描述，用于 LLM 快速识别工具用途。配合 Stub 模式可显著节省 Token——LLM 仅看到短描述与空参数表，调用前通过 <code>tool_search</code> 解锁完整定义。关闭后不再调用 LLM，工具走完整描述与参数注入，Token 消耗更大但无需 search 步骤。</p>');
        html += '<div class="ae-settings-toggle-row">';
        html += '<div class="ae-settings-toggle-info">';
        html += AEI18n.html('<span class="ae-settings-toggle-label">自动生成短描述</span>');
        html += AEI18n.html('<span class="ae-settings-toggle-hint">仅对缺短描述的新工具触发</span>');
        html += '</div>';
        html += '<label class="toggle-wrap">';
        html += '<input type="checkbox" id="mcpAutoGenShortDesc" class="switch-input"' + (autoGenChecked ? ' checked' : '') + '>';
        html += '<span class="switch-slider" aria-hidden="true"></span>';
        html += '</label>';
        html += '</div>';
        html += '</div>';
        html += '</div>';

        // 底部操作区
        html += '<div class="ae-settings-footer">';
        html += AEI18n.html('<button class="btn secondary" id="mcpSettingsAboutBtn">关于模块</button>');
        html += AEI18n.html('<button class="btn" id="mcpSettingsSaveBtn">保存模块设置</button>');
        html += '</div>';

        html += '</div>';

        modalBody.innerHTML = html;

        var aboutBtn = document.getElementById('mcpSettingsAboutBtn');
        if (aboutBtn) aboutBtn.addEventListener('click', function () {
            showAboutModal('module', { name: AEI18n.t('MCP 管理'), desc: AEI18n.t('外部 MCP 服务器集成管理，支持 stdio/SSE/HTTP 协议') });
        });

        var saveBtn = document.getElementById('mcpSettingsSaveBtn');
        if (saveBtn) saveBtn.addEventListener('click', function () {
            var checkbox = document.getElementById('mcpAutoGenShortDesc');
            var enabled = checkbox ? !!checkbox.checked : true;
            _saveMcpSettings(settingsStore, enabled).then(function(result) {
                // 写盘失败 resolve false（配额满/加密异常）被
                // 当成功——弹「模块设置已保存」假成功 + 静默丢配置。false 时如实
                // 报错且不关弹窗（用户可重试，对齐 main.js saveGlobalSettings 口径）
                if (result === false) {
                    if (global.AEToast) global.AEToast.show(AEI18n.t('模块设置保存失败，请重试'), 'error');
                    return;
                }
                // 实时应用到 serverManager
                var sm = global.AE_LLM && global.AE_LLM.serverManager;
                if (sm && typeof sm.setAutoGenShortDesc === 'function') {
                    sm.setAutoGenShortDesc(enabled);
                }
                if (global.AEToast) global.AEToast.show(AEI18n.t('模块设置已保存'), 'success');
                if (typeof global.closeModal === 'function') global.closeModal('settingsModal');
            }).catch(function() {
                if (global.AEToast) global.AEToast.show(AEI18n.t('保存失败，请重试'), 'error');
            });
        });

        // 打开弹窗
        if (typeof global.openModal === 'function') {
            global.openModal('settingsModal');
        }
    }

    async function _saveMcpSettings(settingsStore, autoGenShortDesc) {
        // 只写变更键（setModuleSettings 按键合并）：整包读-改-写回会拿读取时的
        // stale servers 键覆盖 lifecycle persistConfigs 的并发写入（审计）
        if (!settingsStore || typeof settingsStore.setModuleSettings !== 'function') return;
        // 透传写盘结果（false = 配额满/加密异常），调用方据此
        // 如实提示，不再无视返回值假「已保存」
        return await settingsStore.setModuleSettings('mcp-manager', { autoGenShortDesc: !!autoGenShortDesc });
    }

    global.AEModules = global.AEModules || {};
    global.AEModules.mcpManagerModule = mcpManagerModule;
})(window);
