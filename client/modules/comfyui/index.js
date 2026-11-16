(function (global) {
    var mounted = false;
    var _controller = null;
    var _view = null;
    var _hostApi = null;
    var _dataDir = '';
    var _canvasIndex = null;
    var _activeTab = 'form';
    var _readyCheckInterval = null;  // _showTab 等 controller 就绪的轮询句柄（unmount 时清理）
    var _initFailed = false;  // controller.init() 失败标记：isReady() 恒 false，切画布 tab 不再空轮询

    var comfyuiModule = {
        id: 'comfyui',
        title: 'ComfyUI',
        // 读取时才翻译：本文件会整份加载进无 AEI18n 的沙箱，顶层求值会抛 ReferenceError
        get description() { return AEI18n.t('AI 图像与视频生成，内置模板与官方模板库按需检索，支持本地及云端服务'); },
        panelId: 'comfyuiPanel',

        mount: function (containerContext) {
            if (mounted) return;
            // 开头置位 + 失败回滚（catch 中 mounted=false 后 re-throw，让
            // moduleManager 的失败处理继续生效）——同步抛错不重置 mounted 时，
            // 再次进入被 if(mounted) 静默空跑，面板永久空白无自愈路径。早退路径
            //（init 失败重试）与正常路径都在 try 内完成，mounted 保持 true
            mounted = true;
            try {

                var panel = document.getElementById('comfyuiPanel');
                if (panel) {
                    panel.classList.remove('hidden');
                }

                // 首次挂载才创建 controller 和 view，但每次都要重新 bind
                if (!_controller) {
                    // 检查是否有 bootstrap 预初始化的 controller（LLM 工具可能已创建）
                    if (global.AEComfyUI && global.AEComfyUI._preinitController) {
                        _controller = global.AEComfyUI._preinitController;
                        global.AEComfyUI._preinitController = null;
                    }
                }
                if (!_controller) {
                    var ctx = containerContext || {};
                    _hostApi = ctx.hostApi || _hostApi;
                    _dataDir = ctx.dataDir || _dataDir;

                    _controller = global.AEComfyUI.createComfyUIController(ctx);
                    _view = global.AEComfyUI.createComfyUIView(_controller);
                    global.AEComfyUI._view = _view;

                    _startInit();
                } else {
                    // controller 已存在（可能由 LLM 工具 bootstrap 预初始化），需要补建 view
                    var ctx2 = containerContext || {};
                    _hostApi = ctx2.hostApi || _hostApi;
                    _dataDir = ctx2.dataDir || _dataDir;
                    if (!_view) {
                        _view = global.AEComfyUI.createComfyUIView(_controller);
                        global.AEComfyUI._view = _view;
                    }
                    // 上次 init 失败的 controller 重新挂载时重试：不重试则
                    // isReady() 恒 false 且重新 mount 永不重试（面板永久僵死），而
                    // bootstrap 侧会另建新实例（UI/LLM 双 controller 状态机）。init
                    // 失败可重试（controller 内部不缓存 rejected promise）。
                    if (_initFailed && typeof _controller.init === 'function') {
                        _initFailed = false;
                        _startInit();
                        return;
                    }
                    _view.bind();
                    var templates2 = _controller.getEngine().getAllTemplates();
                    renderTemplateCards(templates2);
                    var defaultTpl2 = _controller.getCurrentTemplate();
                    if (defaultTpl2) {
                        _view.renderParams(defaultTpl2);
                        var select2 = document.querySelector('.comfyui-template-select');
                        if (select2) select2.value = defaultTpl2.id;
                    }
                    _renderTabs();
                    _showTab('form');
                }
            } catch (e) {
                // 回滚置位并原样上抛（不吞错，moduleManager 失败处理继续生效）
                mounted = false;
                throw e;
            }
        },

        getController: function () { return _controller; },

        showSettings: function () {
            var v = _view || (global.AEComfyUI && global.AEComfyUI._view);
            if (v && typeof v.showSettings === 'function') v.showSettings();
        },

        unmount: function () {
            if (!mounted) return;
            mounted = false;

            // 等 controller 就绪的轮询清理：等待期间卸载则停止轮询，就绪后不在隐藏面板上挂载画布
            _clearReadyCheck();

            // 不销毁 controller/view，保留表单缓存和生成结果
            if (_view && typeof _view.unbind === 'function') _view.unbind();

            if (_canvasIndex) {
                _canvasIndex.unmount();
                _canvasIndex = null;
            }

            var panel = document.getElementById('comfyuiPanel');
            if (panel) panel.classList.add('hidden');
        }
    };

    // controller.init() 的挂载期收尾（首次挂载与失败重挂载
    // 的重试共用同一路径）。init 内部在途去重、失败可重试（不缓存 rejected promise）。
    function _startInit() {
        _controller.init().then(function () {
            if (!mounted) return;
            _view.bind();
            var templates = _controller.getEngine().getAllTemplates();
            renderTemplateCards(templates);
            var defaultTpl = _controller.getCurrentTemplate();
            if (defaultTpl) {
                _view.renderParams(defaultTpl);
                var select = document.querySelector('.comfyui-template-select');
                if (select) select.value = defaultTpl.id;
            }
            _renderTabs();
            _showTab('form');
        }).catch(function (e) {
            // init 失败后 isReady() 恒 false：若用户点画布 tab，_showTab 的就绪
            // 轮询会 200ms 空转到 unmount——置失败标记让轮询分支不再启动
            _initFailed = true;
            _clearReadyCheck();
            console.error('[ComfyUI] 初始化失败:', e);
            if (mounted && _view) {
                var resultsPanel = document.querySelector('.comfyui-results');
                if (resultsPanel) resultsPanel.innerHTML = AEI18n.html('<div class="comfyui-error">初始化失败: ') + e.message + '</div>';
                // 失败重挂载走 _startInit 重试（不经 else 分支），
                // tabs 的渲染义务移到此处——失败也渲染 tabs + 错误提示，用户可见
                // 可操作；_initFailed=true 使画布 tab 不启动空轮询（空轮询守卫不变）
                _renderTabs();
                _showTab('form');
            }
        });
    }

    function _renderTabs() {
        var panel = document.getElementById('comfyuiPanel');
        if (!panel) return;
        var existingTabs = panel.querySelector('.comfyui-tabs');
        if (existingTabs) existingTabs.remove();

        var tabs = document.createElement('div');
        tabs.className = 'comfyui-tabs';
        tabs.style.cssText = 'display:flex;gap:2px;padding:4px 10px 0;background:var(--surface-1);';

        var formTab = document.createElement('button');
        formTab.className = 'btn btn-slice comfyui-tab-btn';
        formTab.textContent = AEI18n.t('表单');
        formTab.setAttribute('data-tab', 'form');

        var canvasTab = document.createElement('button');
        canvasTab.className = 'btn btn-slice comfyui-tab-btn';
        canvasTab.textContent = AEI18n.t('画布');
        canvasTab.setAttribute('data-tab', 'canvas');

        formTab.addEventListener('click', function () { _showTab('form'); });
        canvasTab.addEventListener('click', function () { _showTab('canvas'); });

        tabs.appendChild(formTab);
        tabs.appendChild(canvasTab);

        // 插入到 #comfyuiPanel 直接子级，位于 .comfyui-form-view 之前
        var formView = panel.querySelector('.comfyui-form-view');
        if (formView) {
            panel.insertBefore(tabs, formView);
        } else {
            panel.insertBefore(tabs, panel.firstChild);
        }
    }

    // 清理 _showTab 等待 controller 就绪的轮询句柄
    function _clearReadyCheck() {
        if (_readyCheckInterval) {
            clearInterval(_readyCheckInterval);
            _readyCheckInterval = null;
        }
    }

    function _showTab(tab) {
        _activeTab = tab;
        var panel = document.getElementById('comfyuiPanel');
        if (!panel) return;

        var formView = panel.querySelector('.comfyui-form-view');
        var canvasView = panel.querySelector('.comfyui-canvas-view');
        var topbar = panel.querySelector('.comfyui-topbar');

        // 更新 tab 按钮 active 状态
        var tabBtns = panel.querySelectorAll('.comfyui-tab-btn');
        for (var i = 0; i < tabBtns.length; i++) {
            if (tabBtns[i].getAttribute('data-tab') === tab) {
                tabBtns[i].classList.add('active');
            } else {
                tabBtns[i].classList.remove('active');
            }
        }

        if (tab === 'form') {
            if (formView) formView.style.display = '';
            if (canvasView) canvasView.style.display = 'none';
            if (topbar) topbar.style.display = '';
        } else {
            if (formView) formView.style.display = 'none';
            if (canvasView) canvasView.style.display = '';
            if (topbar) topbar.style.display = 'none';

            // 首次切画布 → mount
            if (!_canvasIndex && _controller && _controller.isReady()) {
                _canvasIndex = global.AEComfyUI.createCanvasIndex();
                _canvasIndex.mount({
                    controller: _controller,
                    hostApi: _hostApi,
                    dataDir: _dataDir || ''
                });
            } else if (!_canvasIndex && _controller && !_controller.isReady() && !_initFailed) {
                // 等 controller 就绪（句柄存模块级，unmount 清理：controller 初始化失败时不
                // 永久轮询；等待期间卸载则就绪后不在隐藏面板上挂载画布——僵尸 DOM/定时器）
                _clearReadyCheck();
                _readyCheckInterval = setInterval(function () {
                    if (!_controller || !_controller.isReady()) return;
                    _clearReadyCheck();
                    if (!mounted || _activeTab !== 'canvas') return;
                    _canvasIndex = global.AEComfyUI.createCanvasIndex();
                    _canvasIndex.mount({
                        controller: _controller,
                        hostApi: _hostApi,
                        dataDir: _dataDir || ''
                    });
                }, 200);
            }
        }
    }

    // 模板名/ID 过 escapeHtml——自定义工作流的 name 取自原始文件名（去 .json 后缀，
    // templateEngine.js 直接入注册表），拼 innerHTML 未转义可注入 option 标签（XSS）。
    // 对齐 view.js showSettingsModal 对同一数据源的现有做法。
    function escapeHtml(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function renderTemplateCards(templates) {
        var select = document.querySelector('.comfyui-template-select');
        if (!select) return;

        if (!templates || templates.length === 0) {
            select.innerHTML = AEI18n.html('<option value="">模板加载失败</option>');
            return;
        }

        var html = '';
        templates.forEach(function (tpl) {
            var cloudBadge = tpl.cloud ? ' ☁' : '';
            // 模板名是模板 JSON / 工作流文件名的显示名（中文源文），显示前经 t()。
            html += '<option value="' + escapeHtml(tpl.id) + '">' + escapeHtml(AEI18n.t(tpl.name)) + cloudBadge + '</option>';
        });
        select.innerHTML = html;
    }

    // 伙伴节点发现：连接后发现新模型时，controller 经此重渲 select 并恢复选中。
    // 挂全局与 _view 同模式（controller 无法直达本闭包的 renderTemplateCards）。
    global.AEComfyUI._renderTemplateCards = function (templates, selectedId) {
        renderTemplateCards(templates);
        if (selectedId) {
            var select = document.querySelector('.comfyui-template-select');
            if (select) select.value = selectedId;
        }
    };

    global.AEModules = global.AEModules || {};
    global.AEModules.comfyuiModule = comfyuiModule;
})(window);
