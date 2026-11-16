(function (global) {
    var mounted = false;
    var _view = null;
    var _controller = null;

    var AE_TOOLS_SETTINGS_CONTAINER = 'aeToolsSettingsContainer';
    // 旧「系统命令」开关已收割（语义迁移 AST 门能力配置弹窗的
    // 通道信任/域矩阵；旧系统命令键由 ast-gate/config.js 载入时自动迁移收割，
    // mirror 单点归 config 维护）

    // 缓存状态显示文案：st 取自 AEEffectsCache.getState()，pct 为生成进度百分比。
    function cacheStateText(st, pct) {
        if (st === 'generating') return AEI18n.t('生成中 {pct}%', { pct: pct });
        if (st === 'absent') return AEI18n.t('未生成');
        if (st === 'ready') return AEI18n.t('已就绪');
        if (st === 'skipped') return AEI18n.t('已跳过');
        return AEI18n.t('未知');
    }

    function showAeToolsSettingsModal() {
        var modalBody = document.querySelector('#settingsModal .modal-body');
        if (!modalBody) return;

        // 效果列表缓存状态（显示层文案，按状态取字面量 key）
        var cacheStateLabel = AEI18n.t('未检测');
        var cacheStateCls = '';
        try {
            if (global.AEEffectsCache) {
                var st = global.AEEffectsCache.getState();
                cacheStateLabel = cacheStateText(st, global.AEEffectsCache.getProgress());
                cacheStateCls = st === 'ready' ? 'cache-ready' : st === 'generating' ? 'cache-generating' : 'cache-missing';
            }
        } catch (_) {}

        var html = '<div id="' + AE_TOOLS_SETTINGS_CONTAINER + '" class="ae-settings-root">';

        // ── 效果列表缓存 ──
        var cacheSkipped = false;
        try { cacheSkipped = localStorage.getItem('as_extp_effects_cache_skipped') === '1'; } catch (_) {}

        html += '<div class="ae-settings-card">';
        html += '<div class="ae-settings-card-head">';
        html += '<span class="ae-settings-card-icon">📦</span>';
        html += AEI18n.html('<div class="ae-settings-card-title">效果列表缓存</div>');
        html += '</div>';
        html += '<div class="ae-settings-card-body">';
        html += AEI18n.html('<p class="ae-settings-card-desc"><code>queryEnvironment</code> 工具查询可用效果时从缓存读取。装了大量插件时首次生成需分批遍历（AE 间歇卡顿），之后秒回。无缓存时 LLM 调用该工具会收到提示而非数据。</p>');
        html += '<div class="ae-cache-status-row">';
        html += AEI18n.html('<span class="ae-cache-status-label">当前状态</span>');
        html += '<span class="ae-cache-status-badge ' + cacheStateCls + '">' + cacheStateLabel + '</span>';
        html += '</div>';
        html += '<div class="ae-settings-toggle-row">';
        html += '<div class="ae-settings-toggle-info">';
        html += AEI18n.html('<span class="ae-settings-toggle-label">启动时不再提示</span>');
        html += AEI18n.html('<span class="ae-settings-toggle-hint">关闭后每次开面板会重新询问</span>');
        html += '</div>';
        html += '<label class="toggle-wrap">';
        html += '<input type="checkbox" id="aeToolsCacheSuppress" class="switch-input"' + (cacheSkipped ? ' checked' : '') + '>';
        html += '<span class="switch-slider" aria-hidden="true"></span>';
        html += '</label>';
        html += '</div>';
        html += '<div class="ae-settings-actions">';
        html += AEI18n.html('<button class="btn" id="aeToolsEffectsCacheGenBtn">生成 / 重新生成</button>');
        html += '</div>';
        html += '</div>';
        html += '</div>';

        // ── 底部操作 ──
        // 保存按钮已随旧「系统命令」开关收割——余下设置项均即时生效
        html += '<div class="ae-settings-footer">';
        html += AEI18n.html('<button class="btn secondary" id="aeToolsSettingsAboutBtn">关于模块</button>');
        html += '</div>';

        html += '</div>';

        modalBody.innerHTML = html;

        // 启动时不再提示 — 即时生效，无需保存
        var cacheSuppressCb = document.getElementById('aeToolsCacheSuppress');
        if (cacheSuppressCb) cacheSuppressCb.addEventListener('change', function () {
            try {
                if (cacheSuppressCb.checked) {
                    localStorage.setItem('as_extp_effects_cache_skipped', '1');
                } else {
                    localStorage.removeItem('as_extp_effects_cache_skipped');
                }
            } catch (_) {}
        });

        var aboutBtn = document.getElementById('aeToolsSettingsAboutBtn');
        if (aboutBtn) aboutBtn.addEventListener('click', function () {
            if (typeof global.showAboutModal === 'function') {
                global.showAboutModal('module', { name: AEI18n.t('AE 工具'), desc: AEI18n.t('管理 After Effects 自动化工具定义，支持增删改查、AI 创建、ExtendScript 编辑、热重载。Tool Registry 全局中枢。') });
            }
        });

        // 效果缓存：生成/重新生成 — 走主面板共享的进度卡片流程（force=true）
        var cacheGenBtn = document.getElementById('aeToolsEffectsCacheGenBtn');
        if (cacheGenBtn) cacheGenBtn.addEventListener('click', function () {
            if (!global.AEEffectsCache) {
                if (global.AEToast) global.AEToast.show(AEI18n.t('效果缓存模块未加载'), 'warn');
                return;
            }
            if (global.AEApp && typeof global.AEApp.startEffectsCacheGeneration === 'function') {
                global.AEApp.startEffectsCacheGeneration(true);
            } else {
                // AEEffectsCache 已加载但主流程入口不可用时明确提示，避免用户误以为生成已开始
                if (global.AEToast) global.AEToast.show(AEI18n.t('无法触发生成（主流程入口不可用）'), 'warn');
                return;
            }
            if (typeof global.closeModal === 'function') global.closeModal('settingsModal');
        });

        // 打开弹窗
        if (typeof global.openModal === 'function') {
            global.openModal('settingsModal');
        }
    }

    var aeToolsModule = {
        id: 'ae-tools',
        // getter：模块对象在文件加载时求值，翻译推迟到读取时
        get title() { return AEI18n.t('AE 工具'); },
        get description() { return AEI18n.t('管理 AE 自动化工具，支持增删改查、AI 创建、ExtendScript 编辑与热重载'); },
        panelId: 'aeToolsPanel',

        mount: function(containerContext) {
            if (mounted) return;

            var panel = document.getElementById('aeToolsPanel');
            if (panel) panel.classList.remove('hidden');

            _controller = global.AE_LLM.createAEToolsController(containerContext);

            var body = document.getElementById('aeToolsBody');
            if (body) {
                _view = global.AE_LLM.createAEToolsView(_controller, body);
                _view.render();
            }
            // 全部成功后才置位；
            // 先置后挂，createXxx 抛错时 mounted 残留 true，再次进入被守卫静默空跑
            mounted = true;
        },

        showSettings: function () { showAeToolsSettingsModal(); },

        unmount: function() {
            if (!mounted) return;
            mounted = false;

            var panel = document.getElementById('aeToolsPanel');
            if (panel) panel.classList.add('hidden');

            if (_view && typeof _view.destroy === 'function') {
                _view.destroy();
            }
            _view = null;
            _controller = null;
        }
    };

    global.AEModules = global.AEModules || {};
    global.AEModules.aeToolsModule = aeToolsModule;
})(window);
