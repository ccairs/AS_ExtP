// quickBarIndex.js — 全局快速执行栏入口
(function (global) {
    'use strict';

    var _triggerEl = null;
    var _overlayEl = null;
    var _state = null;  // Task 4 中初始化
    var _focusTimer = null;
    var _contextMenuEl = null;
    var _dimTimer = null;  // 面板半透明延迟定时器
    var _entranceTimer = null;  // 入场动画清理定时器
    // 执行锁：覆盖 _executeItems 入口到 _doExecute 置位 batch.running 之间的异步窗口
    // （scripts tab 的 _readSkipRunConfirm 是异步的，期间 running 仍为 false，连点会触发多次执行）
    var _executeLock = false;

    var _STATE_KEY = 'ae_quickbar_last_tab';
    var _VALID_TABS = ['scripts', 'presets', 'projects', 'refs'];
    var VIRTUAL_THRESHOLD = 200;  // 超过 200 项启用虚拟滚动
    var VIRTUAL_BUFFER = 50;     // 上下缓冲 px

    function _initState() {
        var lastTab = 'scripts';
        try {
            var saved = localStorage.getItem(_STATE_KEY);
            if (saved && _VALID_TABS.indexOf(saved) !== -1) lastTab = saved;
        } catch (_) {}

        _state = {
            isOpen: false,
            activeTab: lastTab,
            tabs: {
                scripts:  { items: null, loading: false, lastScanTs: 0, query: '', selectedSet: {}, selectedOrder: [], lastClickedId: '', collapsedSet: {}, scanGen: 0 },
                presets:  { items: null, loading: false, lastScanTs: 0, query: '', selectedSet: {}, selectedOrder: [], lastClickedId: '', collapsedSet: {}, scanGen: 0 },
                projects: { items: null, loading: false, lastScanTs: 0, query: '', selectedSet: {}, selectedOrder: [], lastClickedId: '', collapsedSet: {}, scanGen: 0 },
                refs:     { items: null, loading: false, lastScanTs: 0, query: '', selectedSet: {}, selectedOrder: [], lastClickedId: '', collapsedSet: {}, scanGen: 0 }
            },
            batch: { running: false, current: 0, total: 0, cancelled: false, layerDone: 0, layerTotal: 0 }
        };
    }

    function bootstrap() {
        try {
            if (!global.AEFS) {
                console.error('[QuickBar] AEFS not ready, abort');
                return;
            }
            _initState();
            _injectTrigger();
            _injectPanel();
            console.log('[QuickBar] bootstrap complete');
        } catch (e) {
            console.error('[QuickBar] bootstrap failed: ' + e);
        }
    }

    function _injectTrigger() {
        if (_triggerEl) return;
        _triggerEl = document.createElement('div');
        _triggerEl.id = 'quickBarTrigger';
        _triggerEl.innerHTML =
            AEI18n.html('<button type="button" class="qb-trigger-button" title="快速执行栏" aria-label="打开快速执行栏">⌄</button>');
        document.body.appendChild(_triggerEl);

        _triggerEl.querySelector('.qb-trigger-button').addEventListener('click', _onTriggerClick);
    }

    function _onTriggerClick() {
        toggle();
    }

    function open() {
        if (!_overlayEl || !_state) return;
        _state.isOpen = true;
        // 清除退场残留的 inline 样式，恢复 CSS transition 控制
        var panel = _overlayEl.querySelector('.qb-panel');
        if (panel) {
            panel.style.opacity = '';
            panel.style.transition = '';
        }
        _overlayEl.classList.add('qb-overlay-visible');
        _renderActiveTab();
        _animateEntrance();
        if (_focusTimer) { clearTimeout(_focusTimer); _focusTimer = null; }
        _focusTimer = setTimeout(function () {
            _focusTimer = null;
            if (!_state || !_state.isOpen) return;
            var search = _overlayEl.querySelector('.qb-search');
            if (search) {
                var tab = _state.tabs[_state.activeTab];
                search.value = tab ? tab.query : '';
                search.focus();
            }
        }, 200);
    }

    function close() {
        if (!_overlayEl || !_state) return;
        _state.isOpen = false;
        if (_focusTimer) { clearTimeout(_focusTimer); _focusTimer = null; }
        if (_entranceTimer) { clearTimeout(_entranceTimer); _entranceTimer = null; }
        _hideContextMenu();
        // _hideContextMenu 在鼠标不在面板上时会重启半透明延迟 timer；面板即将关闭，
        // 需在其后再清一次并复位 qb-dimmed，否则残留到下次 open() 后面板呈半透明
        if (_dimTimer) { clearTimeout(_dimTimer); _dimTimer = null; }
        var closingPanel = _overlayEl.querySelector('.qb-panel');
        if (closingPanel) closingPanel.classList.remove('qb-dimmed');
        _clearEntranceClasses();
        // 冻结当前透明度，退场只做上移，不闪
        var panel = _overlayEl.querySelector('.qb-panel');
        if (panel) {
            panel.style.opacity = window.getComputedStyle(panel).opacity;
            panel.style.transition = 'transform 180ms cubic-bezier(0.4, 0, 0.6, 1)';
        }
        _overlayEl.classList.remove('qb-overlay-visible');
    }

    // -> 按钮：根据当前 tab 跳转到对应模块（脚本->Agent，其余->素材库对应卡片）
    function _gotoModule() {
        var tab = _state.activeTab;
        // 优先用 AEApp.navigateToModule（处理切换动画/HUD 更新），fallback 到 AEAppContainer.activate
        var navTo = (global.AEApp && typeof global.AEApp.navigateToModule === 'function') ? global.AEApp.navigateToModule : null;
        var appContainer = global.AEAppContainer;
        if (!navTo && (!appContainer || typeof appContainer.activate !== 'function')) {
            if (global.AEToast) AEToast.warn(AEI18n.t('无法跳转：应用容器未就绪'));
            return;
        }
        // 先关闭 QuickBar，再跳转，避免动画遮挡
        close();
        var targetTab = (tab === 'projects') ? 'proj' : tab;
        if (tab === 'scripts') {
            if (navTo) navTo('agent'); else appContainer.activate('agent');
        } else {
            if (navTo) navTo('assets'); else appContainer.activate('assets');
            // 素材库 mount 后 _cardStack 才存在；用 requestAnimationFrame 等待 mount 完成
            requestAnimationFrame(function () {
                requestAnimationFrame(function () {
                    var m = global.AEModules && global.AEModules.assetsModule;
                    if (m && typeof m.switchTo === 'function') {
                        m.switchTo(targetTab);
                    }
                });
            });
        }
    }

    function toggle() {
        if (_state && _state.isOpen) {
            close();
        } else {
            open();
        }
    }

    // ── 入场动画：面板打开时条目交错淡入 ──
    function _animateEntrance() {
        _clearEntranceClasses();
        if (!_overlayEl) return;

        // 头部 tab 入场
        var tabs = _overlayEl.querySelectorAll('.qb-tab');
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.add('qb-entrance');
            tabs[i].style.animationDelay = (80 + i * 50) + 'ms';
        }

        // 列表条目入场（仅首屏可见项，避免大量 DOM 操作）
        var items = _overlayEl.querySelectorAll('.qb-item');
        var folders = _overlayEl.querySelectorAll('.qb-folder-row');
        var maxDelay = 0;
        var staggerMs = 25;  // 每条目间隔

        for (var j = 0; j < folders.length; j++) {
            var fd = (j < 12 ? 60 + j * staggerMs : 360);
            folders[j].classList.add('qb-entrance');
            folders[j].style.animationDelay = fd + 'ms';
            if (fd > maxDelay) maxDelay = fd;
        }
        for (var k = 0; k < items.length; k++) {
            var id = (k < 20 ? 60 + k * staggerMs : 560);
            items[k].classList.add('qb-entrance');
            items[k].style.animationDelay = id + 'ms';
            if (id > maxDelay) maxDelay = id;
        }

        // 动画结束后清理 class（取 maxDelay + 动画时长 + 容差）
        if (_entranceTimer) clearTimeout(_entranceTimer);
        _entranceTimer = setTimeout(function () {
            _entranceTimer = null;
            _clearEntranceClasses();
        }, maxDelay + 350);
    }

    function _clearEntranceClasses() {
        if (!_overlayEl) return;
        var all = _overlayEl.querySelectorAll('.qb-entrance');
        for (var i = 0; i < all.length; i++) {
            all[i].classList.remove('qb-entrance');
            all[i].style.animationDelay = '';
        }
    }

    function _injectPanel() {
        if (_overlayEl) return;
        _overlayEl = document.createElement('div');
        _overlayEl.id = 'quickBarOverlay';
        _overlayEl.className = 'qb-overlay';
        _overlayEl.innerHTML =
            '<div class="qb-panel">' +
                '<div class="qb-panel-header">' +
                    '<div class="qb-tabs">' +
                        AEI18n.html('<div class="qb-tab" data-tab="scripts">脚本</div>') +
                        AEI18n.html('<div class="qb-tab" data-tab="presets">预设</div>') +
                        AEI18n.html('<div class="qb-tab" data-tab="projects">工程素材</div>') +
                        AEI18n.html('<div class="qb-tab" data-tab="refs">素材</div>') +
                    '</div>' +
                    AEI18n.html('<button type="button" class="qb-refresh" title="刷新">↻</button>') +
                    AEI18n.html('<input class="qb-search" type="text" placeholder="搜索…" maxlength="100">') +
                    AEI18n.html('<button type="button" class="qb-goto" title="跳转到对应模块" aria-label="跳转到对应模块">→</button>') +
                    AEI18n.html('<button type="button" class="qb-close" title="关闭" aria-label="关闭快速执行栏">×</button>') +
                '</div>' +
                '<div class="qb-panel-body">' +
                    '<div class="qb-list ae-scrollbar"></div>' +
                    '<div class="qb-empty" style="display:none;"></div>' +
                    AEI18n.html('<div class="qb-loading" style="display:none;">扫描中…</div>') +
                '</div>' +
                '<div class="qb-panel-footer">' +
                    AEI18n.html('<div class="qb-status">就绪</div>') +
                    '<div class="qb-progress" style="display:none;">' +
                        '<div class="qb-progress-bar"><div class="qb-progress-fill"></div></div>' +
                        AEI18n.html('<button type="button" class="qb-cancel-btn">取消剩余</button>') +
                    '</div>' +
                    AEI18n.html('<div class="qb-hint">点击 ↗ 执行 · Ctrl+多选 · 右键菜单</div>') +
                '</div>' +
            '</div>';
        document.body.appendChild(_overlayEl);

        _overlayEl.querySelector('.qb-close').addEventListener('click', close);
        _overlayEl.querySelector('.qb-goto').addEventListener('click', _gotoModule);
        var tabs = _overlayEl.querySelectorAll('.qb-tab');
        for (var i = 0; i < tabs.length; i++) {
            (function (tab) {
                tab.addEventListener('click', function () { _switchTab(tab.getAttribute('data-tab')); });
            })(tabs[i]);
        }
        var listEl = _overlayEl.querySelector('.qb-list');
        listEl.addEventListener('click', _onListClick);
        listEl.addEventListener('contextmenu', _onListContextMenu);
        _overlayEl.querySelector('.qb-search').addEventListener('input', _onSearchInput);
        _overlayEl.addEventListener('mousedown', _onOverlayMouseDown);
        document.addEventListener('mousedown', _onDocumentMouseDown, true);
        document.addEventListener('keydown', _onKeyDown);
        var cancelBtn = _overlayEl.querySelector('.qb-cancel-btn');
        if (cancelBtn) cancelBtn.addEventListener('click', function () {
            if (!_state) return;
            _state.batch.cancelled = true;
            _updateStatus(AEI18n.t('正在取消…'));
        });
        var refreshBtn = _overlayEl.querySelector('.qb-refresh');
        if (refreshBtn) refreshBtn.addEventListener('click', function () {
            if (!_state) return;
            // 批量执行中禁止刷新，避免列表与执行状态脱节
            if (_state.batch.running) {
                if (global.AEToast) global.AEToast.warn(AEI18n.t('批量执行中，请等待完成后再刷新'));
                return;
            }
            var tab = _state.tabs[_state.activeTab];
            if (!tab) return;
            // 旋转动画反馈
            refreshBtn.classList.add('spinning');
            setTimeout(function () { refreshBtn.classList.remove('spinning'); }, 600);
            tab.items = null;
            tab.lastScanTs = 0;
            // 扫描进行中点刷新：清 loading 放行新一轮扫描，
            // 在途扫描的回调由 _ensureScanned 的 scanGen 代次检查丢弃，不会回写旧数据
            tab.loading = false;
            _renderList();
            _ensureScanned(_state.activeTab);
        });

        // 面板半透明延迟：鼠标离开 300ms 后变半透明，进入时立即恢复
        var panel = _overlayEl.querySelector('.qb-panel');
        if (panel) {
            panel.addEventListener('mouseenter', function () {
                if (_dimTimer) { clearTimeout(_dimTimer); _dimTimer = null; }
                panel.classList.remove('qb-dimmed');
            });
            panel.addEventListener('mouseleave', function () {
                if (_dimTimer) clearTimeout(_dimTimer);
                _dimTimer = setTimeout(function () {
                    _dimTimer = null;
                    // 右键菜单可见时不半透明
                    if (_contextMenuEl && _contextMenuEl.style.display !== 'none') return;
                    if (panel) panel.classList.add('qb-dimmed');
                }, 300);
            });
        }
    }

    function _onOverlayMouseDown(e) {
        // 点击 panel 外部（overlay 自身）关闭
        if (e.target === _overlayEl) close();
    }

    function _onDocumentMouseDown(e) {
        // 面板未打开时不处理（capture phase，常驻监听）
        if (!_state || !_state.isOpen) return;
        // 点击在 panel 内、trigger 内或右键菜单内，不处理
        if (_overlayEl && _overlayEl.contains(e.target)) return;
        if (_triggerEl && _triggerEl.contains(e.target)) return;
        if (_contextMenuEl && _contextMenuEl.contains(e.target)) return;
        // 模态对话框（.modal-mask：#confirmModal/#promptModal 等共用单例与动态模态）
        // 打开时不关面板——快捷栏脚本执行弹的确认框不属于旧白名单，
        // 点「确定/取消」会被判为"点面板外部"把快捷栏关掉，执行进度/失败汇总看不见
        var t = e.target;
        if (t && typeof t.closest === 'function' && t.closest('.modal-mask')) return;
        // 点击在 overlay 外（底部 65% 或其他区域），关闭面板
        // 不阻止传播，底层 UI 仍可交互
        close();
    }

    function _onKeyDown(e) {
        if (e.key === 'Escape' && _state && _state.isOpen) {
            // 优先关闭右键菜单：context menu 可见时 Escape 应先关菜单
            if (_contextMenuEl && _contextMenuEl.style.display !== 'none') {
                _hideContextMenu();
                return;
            }
            // 其次清空搜索；搜索为空时关闭面板
            var tab = _state.tabs[_state.activeTab];
            if (tab && tab.query) {
                tab.query = '';
                if (_overlayEl) _overlayEl.querySelector('.qb-search').value = '';
                // 清空搜索后数据集变化，重置滚动位置到顶部
                var listEl = _overlayEl.querySelector('.qb-list');
                if (listEl) listEl.scrollTop = 0;
                if (typeof _renderList === 'function') _renderList();
            } else {
                close();
            }
        }
    }

    function _renderActiveTab() {
        if (!_overlayEl || !_state) return;
        // 更新 Tab 高亮
        var tabs = _overlayEl.querySelectorAll('.qb-tab');
        for (var i = 0; i < tabs.length; i++) {
            if (tabs[i].getAttribute('data-tab') === _state.activeTab) {
                tabs[i].classList.add('qb-tab-active');
            } else {
                tabs[i].classList.remove('qb-tab-active');
            }
        }
        // 恢复搜索框值
        var search = _overlayEl.querySelector('.qb-search');
        var tab = _state.tabs[_state.activeTab];
        if (search && tab) search.value = tab.query;
        // 触发扫描（Task 5 中实现 _ensureScanned）
        if (typeof _ensureScanned === 'function') _ensureScanned(_state.activeTab);
        // 同步 loading 指示器与状态栏到当前 tab：_ensureScanned 在 items 已就绪时 early return，
        // 不会重置其他 tab scan 残留的 loading 指示器，需在此显式同步
        var activeTab = _state.tabs[_state.activeTab];
        _showLoading(!!activeTab && !!activeTab.loading);
        if (!_state.batch.running && activeTab && !activeTab.loading && activeTab.items) {
            _updateSelectionStatus();
        }
        // 渲染列表（Task 7 中实现 _renderList）
        if (typeof _renderList === 'function') _renderList();
    }

    function _switchTab(tabId) {
        if (_VALID_TABS.indexOf(tabId) === -1) return;
        if (tabId === _state.activeTab) return;

        _state.activeTab = tabId;
        try { localStorage.setItem(_STATE_KEY, tabId); } catch (_) {}
        _renderActiveTab();
    }

    function _onSearchInput(e) {
        if (!_state) return;
        var tab = _state.tabs[_state.activeTab];
        if (!tab) return;
        tab.query = e.target.value.slice(0, 100);
        // 搜索时收敛选中：被过滤隐藏的选中项自动取消选中，
        // 保证选中集合始终 ⊆ 可见列表——避免"看不见但会被批量执行"的误伤
        if (tab.query) {
            var filteredIds = {};
            var vis = _getFilteredItems(tab);
            for (var i = 0; i < vis.length; i++) filteredIds[vis[i].id] = true;
            var selIds = (tab.selectedOrder || Object.keys(tab.selectedSet)).slice();
            for (var j = 0; j < selIds.length; j++) {
                if (!filteredIds[selIds[j]]) _qbRemoveSelection(tab, selIds[j]);
            }
        }
        // 搜索后数据集变化，重置滚动位置到顶部，避免恢复旧 scrollTop 导致看到列表底部
        var listEl = _overlayEl.querySelector('.qb-list');
        if (listEl) listEl.scrollTop = 0;
        if (typeof _renderList === 'function') _renderList();
        if (!_state.batch.running) _updateSelectionStatus();
    }

    function _ensureScanned(tabId) {
        var tab = _state.tabs[tabId];
        if (!tab || tab.items !== null || tab.loading) return;

        // 依赖检查
        if (!global.AEFS) {
            _updateStatus(AEI18n.t('AEFS 未就绪'));
            return;
        }
        if (!global.AEShared || !global.AEShared.getDataDir) {
            _updateStatus(AEI18n.t('数据目录未就绪'));
            return;
        }

        tab.loading = true;
        // 扫描代次：刷新会作废在途扫描（见 _injectPanel 刷新按钮），旧回调按代次丢弃
        var gen = ++tab.scanGen;
        if (!_state.batch.running) _updateStatus(AEI18n.t('扫描中…'));
        _showLoading(true);
        global.AEQuickBarScanner.scan(tabId).then(function (result) {
            if (tab.scanGen !== gen) return;   // 已被刷新作废，丢弃过期结果
            tab.loading = false;
            tab.items = result.items || [];
            tab.lastScanTs = Date.now();

            // 过滤 selectedSet 中已不存在的 id（防悬挂选中）——对 tab 本身操作，安全
            var validIds = {};
            for (var i = 0; i < tab.items.length; i++) validIds[tab.items[i].id] = true;
            Object.keys(tab.selectedSet).forEach(function (id) {
                if (!validIds[id]) _qbRemoveSelection(tab, id);
            });

            // 仅当扫描的 tab 仍是 active tab 时才更新 UI，避免切换 tab 后旧 scan 误改新 tab 状态
            if (_state.activeTab !== tabId) {
                // 扫描完成时 active tab 已切换：按 active tab 的 loading 态同步指示器，
                // 否则切换到已扫描 tab 时旧 scan 完成会让 loading 指示器永久残留
                var activeTab = _state.tabs[_state.activeTab];
                _showLoading(!!activeTab && !!activeTab.loading);
                return;
            }
            _showLoading(false);
            if (!_state.batch.running) {
                if (result.error === 'no-dir') {
                    _updateStatus(AEI18n.t('未配置脚本目录'));
                } else if (result.error === 'dangerous') {
                    _updateStatus(AEI18n.t('脚本目录被安全策略拒绝'));
                } else if (result.error === 'timeout') {
                    _updateStatus(AEI18n.t('扫描未完成，部分条目可能缺失'));
                } else if (result.error === 'parse-error') {
                    _updateStatus(AEI18n.t('索引损坏，请到素材库模块修复'));
                } else if (result.error) {
                    _updateStatus(AEI18n.t('扫描异常: {detail}', { detail: result.error }));
                } else {
                    _updateSelectionStatus();
                }
            }
            _renderList();
        }).catch(function (e) {
            if (tab.scanGen !== gen) return;   // 已被刷新作废，丢弃过期结果
            tab.loading = false;
            tab.items = [];
            if (_state.activeTab === tabId) {
                _showLoading(false);
                if (!_state.batch.running) _updateStatus(AEI18n.t('扫描失败: {detail}', { detail: e && e.message ? e.message : e }));
            } else {
                var activeTab = _state.tabs[_state.activeTab];
                _showLoading(!!activeTab && !!activeTab.loading);
            }
        });
    }

    function _showLoading(show) {
        if (!_overlayEl) return;
        var loading = _overlayEl.querySelector('.qb-loading');
        if (loading) loading.style.display = show ? '' : 'none';
    }

    function _updateStatus(text) {
        if (!_overlayEl) return;
        var status = _overlayEl.querySelector('.qb-status');
        if (status) status.textContent = text;
    }

    function _renderList() {
        if (!_overlayEl) return;
        var listEl = _overlayEl.querySelector('.qb-list');
        var emptyEl = _overlayEl.querySelector('.qb-empty');
        if (!listEl) return;
        var tab = _state.tabs[_state.activeTab];
        if (!tab) return;

        // loading 态
        if (tab.loading) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = 'none';
            return;
        }

        // items 未扫描
        if (tab.items === null) {
            listEl.innerHTML = '';
            if (emptyEl) emptyEl.style.display = 'none';
            return;
        }

        // 搜索过滤（复用 _getFilteredItems 保持 DRY）
        var filtered = _getFilteredItems(tab);

        // 空态
        if (filtered.length === 0) {
            listEl.innerHTML = '';
            if (emptyEl) {
                emptyEl.style.display = '';
                if (tab.query) {
                    emptyEl.textContent = AEI18n.t('无匹配项');
                } else if (tab.items.length === 0) {
                    if (_state.activeTab === 'scripts') {
                        emptyEl.innerHTML = AEI18n.html('无脚本<br><a href="#" class="qb-empty-link">打开 Agent 模块配置</a>');
                        var link = emptyEl.querySelector('.qb-empty-link');
                        if (link) link.addEventListener('click', function (e) {
                            e.preventDefault();
                            close();
                            if (global.AEApp && typeof global.AEApp.navigateToModule === 'function') {
                                global.AEApp.navigateToModule('agent');
                            }
                        });
                    } else {
                        emptyEl.textContent = AEI18n.t('无内容，请到素材库模块添加');
                    }
                } else {
                    emptyEl.textContent = AEI18n.t('无匹配项');
                }
            }
            return;
        }
        if (emptyEl) emptyEl.style.display = 'none';

        // 虚拟滚动判断
        if (filtered.length > VIRTUAL_THRESHOLD) {
            _renderVirtualList(listEl, filtered, tab);
        } else {
            _renderFullList(listEl, filtered, tab);
        }
    }

    function _renderFullList(listEl, filtered, tab) {
        var savedScrollTop = listEl.scrollTop;
        var tree = _buildFolderTree(filtered);
        var displayItems = [];
        _flattenTree(tree, 0, tab.collapsedSet, displayItems);
        var html = '';
        for (var i = 0; i < displayItems.length; i++) {
            var d = displayItems[i];
            html += d.type === 'folder' ? _buildFolderRowHtml(d.folder, d.depth, d.collapsed)
                : _buildItemHtml(d.item, tab, d.depth);
        }
        listEl.innerHTML = html;
        // innerHTML 会重置 scrollTop，需恢复以避免点击列表项后滚动跳回顶部
        listEl.scrollTop = savedScrollTop;
        // 移除虚拟滚动 listener
        listEl.onscroll = null;
    }

    function _renderVirtualList(listEl, filtered, tab) {
        var ITEM_HEIGHT = 22;
        // folder 行与 item 行均按 22px 计高，displayItems.length 即总行数
        var tree = _buildFolderTree(filtered);
        var displayItems = [];
        _flattenTree(tree, 0, tab.collapsedSet, displayItems);
        var totalHeight = displayItems.length * ITEM_HEIGHT;
        var savedScrollTop = listEl.scrollTop;

        // 设置 spacer（box-sizing:border-box 确保 paddingTop 含在 height 内，
        // 否则 content-box 下总高 = height + paddingTop 会随滚动增长，导致可滚出末项外的空白区）
        listEl.innerHTML = '<div class="qb-virtual-spacer" style="height:' + totalHeight + 'px;position:relative;box-sizing:border-box;"></div>';
        var spacer = listEl.querySelector('.qb-virtual-spacer');
        // innerHTML 会重置 scrollTop，需在 render() 前恢复，否则可见区间计算从 0 开始
        listEl.scrollTop = savedScrollTop;

        function render() {
            // 每次实时读取 viewportH，防止面板尺寸变化后 endIdx 计算过期
            var viewportH = listEl.clientHeight;
            var scrollTop = listEl.scrollTop;
            var startIdx = Math.max(0, Math.floor((scrollTop - VIRTUAL_BUFFER) / ITEM_HEIGHT));
            var endIdx = Math.min(displayItems.length, Math.ceil((scrollTop + viewportH + VIRTUAL_BUFFER) / ITEM_HEIGHT));

            var html = '';
            for (var i = startIdx; i < endIdx; i++) {
                var d = displayItems[i];
                html += d.type === 'folder' ? _buildFolderRowHtml(d.folder, d.depth, d.collapsed)
                    : _buildItemHtml(d.item, tab, d.depth);
            }
            spacer.innerHTML = html;
            spacer.style.paddingTop = (startIdx * ITEM_HEIGHT) + 'px';
        }
        render();
        listEl.onscroll = render;
    }

    function _buildItemHtml(it, tab, depth) {
        var pad = depth * 14 + 4;
        var selected = tab.selectedSet[it.id] === true;
        var missing = it.meta && it.meta.missing;
        var metaHtml = '';
        if (missing) metaHtml = '<span class="qb-item-missing">' + AEI18n.t('[丢失]') + '</span>';
        else if (it.meta && it.meta.sourceType) metaHtml = '<span class="qb-item-meta-src">' + _escapeHtml(it.meta.sourceType) + '</span>';

        // 虚拟滚动下移除 data-index（Shift 范围选基于 id 查找，不依赖 index）
        // 选中行注入 --qb-sel-left：选中背景从缩进位置起铺（与金色竖条对齐），见 quickBar.css
        return '<div class="qb-item' + (selected ? ' qb-item-selected' : '') + (missing ? ' qb-item-missing-row' : '') + '" ' +
            'data-id="' + _escapeAttr(it.id) + '" style="padding-left:' + pad + 'px;' + (selected ? '--qb-sel-left:' + pad + 'px;' : '') + '">' +
            '<div class="qb-item-selected-indicator"></div>' +
            '<div class="qb-item-icon">' + _iconForType(it.type) + '</div>' +
            '<div class="qb-item-name">' + _escapeHtml(it.name) + '</div>' +
            metaHtml +
            '<span class="qb-item-act" data-act="exec" title="' + AEI18n.t('执行') + '">↗</span>' +
            '</div>';
    }

    // 将扁平 items 按 folder 路径构建树形结构（参考素材库 treeView.buildFolderTree）
    function _buildFolderTree(filtered) {
        var root = { folders: [], items: [] };
        function _ensureFolders(fp) {
            var segs = String(fp || '').replace(/^\/+|\/+$/g, '').split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
            var node = root;
            var acc = '';
            segs.forEach(function (seg) {
                acc = acc ? acc + '/' + seg : seg;
                var found = null;
                for (var i = 0; i < node.folders.length; i++) {
                    if (node.folders[i].name === seg) { found = node.folders[i]; break; }
                }
                if (!found) { found = { name: seg, path: acc, folders: [], items: [] }; node.folders.push(found); }
                node = found;
            });
        }
        filtered.forEach(function (it) {
            _ensureFolders(it.folder || '');
            var segs = String(it.folder || '').replace(/^\/+|\/+$/g, '').split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
            var node = root;
            segs.forEach(function (seg) {
                for (var i = 0; i < node.folders.length; i++) {
                    if (node.folders[i].name === seg) { node = node.folders[i]; break; }
                }
            });
            node.items.push(it);
        });
        // 文件夹按名排序
        function _sortFolders(node) {
            node.folders.sort(function (a, b) { return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()); });
            node.items.sort(function (a, b) { return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase()); });
            for (var i = 0; i < node.folders.length; i++) _sortFolders(node.folders[i]);
        }
        _sortFolders(root);
        return root;
    }

    // 深度优先扁平化树形结构：folder 行在前，items 在后；折叠时跳过子节点
    function _flattenTree(node, depth, collapsedSet, result) {
        for (var i = 0; i < node.folders.length; i++) {
            var f = node.folders[i];
            var collapsed = !!collapsedSet[f.path];
            result.push({ type: 'folder', folder: f, depth: depth, collapsed: collapsed });
            if (!collapsed) _flattenTree(f, depth + 1, collapsedSet, result);
        }
        for (var j = 0; j < node.items.length; j++) {
            result.push({ type: 'item', item: node.items[j], depth: depth });
        }
    }

    function _buildFolderRowHtml(folder, depth, collapsed) {
        var pad = depth * 14 + 6;
        var childCount = _countFolderChildren(folder);
        var countHtml = childCount > 0 ? '<span class="qb-folder-count">' + childCount + '</span>' : '';
        return '<div class="qb-folder-row" data-folder="' + _escapeAttr(folder.path) + '" style="padding-left:' + pad + 'px;">' +
            '<span class="qb-folder-arrow">' + (collapsed ? '▶' : '▼') + '</span>' +
            '<span class="qb-folder-icon">' + AEI18n.t('文件夹') + '</span>' +
            '<span class="qb-folder-name">' + _escapeHtml(folder.name) + '</span>' +
            countHtml +
            '</div>';
    }

    function _countFolderChildren(f) {
        var count = f.items.length;
        for (var i = 0; i < f.folders.length; i++) {
            count += _countFolderChildren(f.folders[i]);
        }
        return count;
    }

    function _escapeHtml(s) {
        if (!s) return '';
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function _escapeAttr(s) {
        if (!s) return '';
        return String(s).replace(/["'&<>]/g, function (c) {
            return { '"': '&quot;', "'": '&#39;', '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c];
        });
    }

    function _iconForType(type) {
        // 用 Unicode 字符做轻量图标，避免引入资源
        if (type === 'script') return '◇';
        if (type === 'preset') return '◈';
        if (type === 'project') return '◻';
        if (type === 'ref') return '○';
        return '·';
    }

    function _getItemFromEvent(e) {
        var el = e.target.closest('.qb-item');
        if (!el) return null;
        var id = el.getAttribute('data-id');
        var tab = _state.tabs[_state.activeTab];
        if (!tab || !tab.items) return null;
        for (var i = 0; i < tab.items.length; i++) {
            if (tab.items[i].id === id) return tab.items[i];
        }
        return null;
    }

    function _onListClick(e) {
        // 执行按钮优先处理（避免冒泡到 folder-row 触发折叠）
        // item 执行按钮
        var actBtn = e.target.closest('[data-act="exec"]');
        if (actBtn) {
            var actItem = _getItemFromEvent(e);
            if (!actItem) return;
            if (_state.batch.running) {
                if (global.AEToast) global.AEToast.warn(AEI18n.t('正在执行中，请等待'));
                return;
            }
            _executeItems([actItem]);
            return;
        }

        // 文件夹行点击（非执行按钮区域）：切换折叠/展开
        var folderEl = e.target.closest('.qb-folder-row');
        if (folderEl) {
            var folderPath = folderEl.getAttribute('data-folder');
            if (!folderPath) return;
            var fTab = _state.tabs[_state.activeTab];
            if (!fTab) return;
            if (fTab.collapsedSet[folderPath]) delete fTab.collapsedSet[folderPath];
            else fTab.collapsedSet[folderPath] = true;
            _renderList();
            return;
        }

        var item = _getItemFromEvent(e);
        if (!item) {
            // 点击列表空白处：取消所有选中
            var blankTab = _state.tabs[_state.activeTab];
            if (blankTab && Object.keys(blankTab.selectedSet).length > 0) {
                _qbClearSelection(blankTab);
                blankTab.lastClickedId = '';
                _renderList();
                if (!_state.batch.running) _updateSelectionStatus();
            }
            return;
        }

        // 双击执行（连续第二击 click 的 detail=2）。不用 dblclick 事件：
        // 普通单击末尾 _renderList() 会 innerHTML 重建列表，第二击落在
        // 新节点上，浏览器判定两次点击目标不同而不派发 dblclick
        if (e.detail >= 2) {
            if (_state.batch.running || _executeLock) {
                if (global.AEToast) global.AEToast.warn(AEI18n.t('正在执行中，请等待'));
                return;
            }
            _executeItems([item]);
            return;
        }

        var tab = _state.tabs[_state.activeTab];
        if (!tab) return;
        var id = item.id;

        if (e.ctrlKey || e.metaKey) {
            // Ctrl+单击：切换该项选中态
            if (tab.selectedSet[id]) _qbRemoveSelection(tab, id);
            else _qbAddSelection(tab, id);
            tab.lastClickedId = id;
        } else if (e.shiftKey && tab.lastClickedId) {
            // Shift+单击：从 lastClickedId 到当前项范围选中（基于视觉顺序的 displayItems）
            var visualItems = _getVisualItems(tab);
            var startIdx = -1, endIdx = -1;
            for (var i = 0; i < visualItems.length; i++) {
                if (visualItems[i].id === tab.lastClickedId) startIdx = i;
                if (visualItems[i].id === id) endIdx = i;
            }
            if (startIdx >= 0 && endIdx >= 0) {
                _qbClearSelection(tab);
                // 按范围方向入序：从锚点（startIdx=上次点击）遍历到本次点击（endIdx），
                // 向下选视觉升序、向上选视觉降序——顺序=点击先后，锚点最先、本次点击最后
                if (endIdx >= startIdx) {
                    for (var j = startIdx; j <= endIdx; j++) _qbAddSelection(tab, visualItems[j].id);
                } else {
                    for (var j = startIdx; j >= endIdx; j--) _qbAddSelection(tab, visualItems[j].id);
                }
            }
        } else {
            // 普通单击
            if (tab.selectedSet[id] && Object.keys(tab.selectedSet).length === 1) {
                // 唯一选中项再次单击 → 取消
                _qbRemoveSelection(tab, id);
                tab.lastClickedId = '';
            } else {
                // 替换选中
                _qbClearSelection(tab);
                _qbAddSelection(tab, id);
                tab.lastClickedId = id;
            }
        }
        _renderList();
        if (!_state.batch.running) _updateSelectionStatus();
    }

    // —— 选中态维护（同步 selectedSet 与 selectedOrder，order 记录选中先后）——
    // 批量执行（多预设叠加等）按 selectedOrder 顺序进行
    function _qbClearSelection(tab) {
        tab.selectedSet = {};
        tab.selectedOrder = [];
    }
    function _qbAddSelection(tab, id) {
        if (tab.selectedSet[id]) return;
        tab.selectedSet[id] = true;
        tab.selectedOrder.push(id);
    }
    function _qbRemoveSelection(tab, id) {
        delete tab.selectedSet[id];
        var k = tab.selectedOrder.indexOf(id);
        if (k >= 0) tab.selectedOrder.splice(k, 1);
    }

    function _getFilteredItems(tab) {
        if (!tab.items) return [];
        if (!tab.query) return tab.items;
        if (!global.AEQuickBarScanner || typeof global.AEQuickBarScanner.fuzzyMatch !== 'function') {
            return tab.items;
        }
        return tab.items.filter(function (it) {
            return global.AEQuickBarScanner.fuzzyMatch(tab.query, it.name);
        });
    }

    // 获取视觉顺序的 items（树形扁平化后，跳过折叠文件夹下的 items）
    // 用于 Shift 范围选：范围基于用户实际看到的 item 顺序
    function _getVisualItems(tab) {
        var filtered = _getFilteredItems(tab);
        var tree = _buildFolderTree(filtered);
        var displayItems = [];
        _flattenTree(tree, 0, tab.collapsedSet, displayItems);
        var items = [];
        for (var i = 0; i < displayItems.length; i++) {
            if (displayItems[i].type === 'item') items.push(displayItems[i].item);
        }
        return items;
    }

    function _updateSelectionStatus() {
        var tab = _state.tabs[_state.activeTab];
        if (!tab) return;
        var count = Object.keys(tab.selectedSet).length;
        var total = tab.items ? tab.items.length : 0;
        _updateStatus(count > 0
            ? AEI18n.t('已选中 {selected} 项 / 共 {total} 项', { selected: count, total: total })
            : AEI18n.t('共 {total} 项', { total: total }));
    }

    function _collectFolderItems(folderPath) {
        var tab = _state.tabs[_state.activeTab];
        if (!tab || !tab.items) return [];
        var fp = folderPath;
        var prefix = fp + '/';
        var slashIdx = fp.lastIndexOf('/');
        var rootName = slashIdx >= 0 ? fp.slice(slashIdx + 1) : fp;
        var prefixLen = fp.length;
        var items = [];
        for (var i = 0; i < tab.items.length; i++) {
            var it = tab.items[i];
            var f = it.folder || '';
            if (f === fp || f.indexOf(prefix) === 0) {
                var rel = f;
                if (f === fp) rel = rootName;
                else if (f.indexOf(prefix) === 0) rel = rootName + '/' + f.slice(prefixLen + 1);
                items.push({
                    id: it.id,
                    name: it.name,
                    path: it.path,
                    folder: rel,
                    type: it.type,
                    meta: it.meta,
                    _keepFolder: true
                });
            }
        }
        return items;
    }

    function _onListContextMenu(e) {
        e.preventDefault();

        // 素材/工程素材文件夹右键：显示"导入此文件夹"
        var folderEl = e.target.closest('.qb-folder-row');
        if (folderEl) {
            var tabId = _state.activeTab;
            if (tabId === 'refs' || tabId === 'projects') {
                var fp = folderEl.getAttribute('data-folder');
                if (fp) _showContextMenu(e.clientX, e.clientY, fp);
                return;
            }
        }

        var item = _getItemFromEvent(e);
        if (!item) return;
        var tab = _state.tabs[_state.activeTab];
        if (!tab) return;
        var id = item.id;

        // 右键未选中项 → 重置 selectedSet 为仅该项
        if (!tab.selectedSet[id]) {
            _qbClearSelection(tab);
            _qbAddSelection(tab, id);
            tab.lastClickedId = id;
            _renderList();
            if (!_state.batch.running) _updateSelectionStatus();
        }

        _showContextMenu(e.clientX, e.clientY);
    }

    function _hideContextMenu() {
        if (!_contextMenuEl) return;
        _contextMenuEl.style.display = 'none';
        _contextMenuEl._folderCtx = null;
        if (_overlayEl) {
            var panel = _overlayEl.querySelector('.qb-panel');
            if (panel) {
                panel.classList.remove('qb-context-active');
                // 右键菜单关闭后，若鼠标不在 panel 上，重新启动半透明延迟
                if (!panel.matches(':hover')) {
                    if (_dimTimer) clearTimeout(_dimTimer);
                    _dimTimer = setTimeout(function () {
                        _dimTimer = null;
                        var p = _overlayEl.querySelector('.qb-panel');
                        if (p) p.classList.add('qb-dimmed');
                    }, 300);
                }
            }
        }
    }

    function _showContextMenu(x, y, folderCtx) {
        if (!_contextMenuEl) {
            _contextMenuEl = document.createElement('div');
            _contextMenuEl.id = 'quickBarContextMenu';
            _contextMenuEl.className = 'qb-context-menu';
            document.body.appendChild(_contextMenuEl);
            _contextMenuEl.addEventListener('click', _onContextMenuClick);
            document.addEventListener('mousedown', function (e) {
                if (_contextMenuEl && _contextMenuEl.style.display !== 'none' && !_contextMenuEl.contains(e.target)) {
                    _hideContextMenu();
                }
            });
        }
        if (folderCtx) {
            _contextMenuEl.innerHTML = AEI18n.html('<div class="qb-ctx-item" data-action="execute-folder">导入此文件夹</div>');
            _contextMenuEl._folderCtx = folderCtx;
        } else {
            // 多选时菜单明确标注批量语义与项数（执行仍走 _executeSelected，按选中顺序）
            var selCount = 0;
            var curTab = _state.tabs[_state.activeTab];
            if (curTab) selCount = Object.keys(curTab.selectedSet).length;
            var execLabel = selCount > 1 ? AEI18n.t('批量执行 ({n})', { n: selCount }) : AEI18n.t('执行');
            _contextMenuEl.innerHTML = '<div class="qb-ctx-item" data-action="execute">' + execLabel + '</div>';
            _contextMenuEl._folderCtx = null;
        }
        _contextMenuEl.style.left = x + 'px';
        _contextMenuEl.style.top = y + 'px';
        _contextMenuEl.style.display = 'block';
        if (_overlayEl) {
            if (_dimTimer) { clearTimeout(_dimTimer); _dimTimer = null; }
            var panel = _overlayEl.querySelector('.qb-panel');
            if (panel) {
                panel.classList.remove('qb-dimmed');
                panel.classList.add('qb-context-active');
            }
        }
    }

    function _onContextMenuClick(e) {
        var el = e.target.closest('.qb-ctx-item');
        if (!el) return;
        var action = el.getAttribute('data-action');
        var folderCtx = _contextMenuEl._folderCtx;
        _hideContextMenu();
        if (action === 'execute') {
            _executeSelected();
        } else if (action === 'execute-folder' && folderCtx) {
            if (_state.batch.running) {
                if (global.AEToast) global.AEToast.warn(AEI18n.t('正在执行中，请等待'));
                return;
            }
            var fItems = _collectFolderItems(folderCtx);
            if (fItems.length === 0) {
                if (global.AEToast) global.AEToast.info(AEI18n.t('该文件夹下无可执行项'));
                return;
            }
            _executeItems(fItems);
        }
    }

    function _executeSelected() {
        var tab = _state.tabs[_state.activeTab];
        if (!tab) return;
        var ids = Object.keys(tab.selectedSet);
        if (ids.length === 0) return;
        if (_state.batch.running) {
            if (global.AEToast) global.AEToast.warn(AEI18n.t('正在执行中，请等待'));
            return;
        }
        // 按 selectedOrder（选中先后）排序执行：多预设叠加顺序 = 用户点击顺序
        var byId = {};
        for (var q = 0; q < tab.items.length; q++) byId[tab.items[q].id] = tab.items[q];
        var items = [];
        var order = tab.selectedOrder || Object.keys(tab.selectedSet);
        for (var w = 0; w < order.length; w++) {
            if (tab.selectedSet[order[w]] && byId[order[w]]) items.push(byId[order[w]]);
        }
        if (items.length === 0) return;

        // 超过 50 项时提示
        if (items.length > 50) {
            if (global.AEToast) global.AEToast.warn(AEI18n.t('将执行 {n} 项，可能耗时较长', { n: items.length }));
        }
        _executeItems(items);
    }

    // 读取 Agent 模块的 skipRunConfirm 设置（运行免确认）
    function _readSkipRunConfirm() {
        try {
            var ctx = global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function' ? global.AEAppContainer.getContext() : null;
            var store = ctx && ctx.settingsStore;
            if (store && typeof store.getModuleSettings === 'function') {
                return store.getModuleSettings('agent').then(function (s) {
                    return !!(s && s.skipRunConfirm);
                });
            }
        } catch (_) {}
        return Promise.resolve(false);
    }

    function _executeItems(items) {
        if (!items || items.length === 0) return;
        // 防连点：覆盖 _readSkipRunConfirm 异步窗口（running 标志置位前连点会触发多次执行）
        if (_executeLock) {
            if (global.AEToast) global.AEToast.warn(AEI18n.t('正在执行中，请等待'));
            return;
        }
        _executeLock = true;

        // 脚本执行前检查 Agent 模块的 skipRunConfirm 设置（运行免确认）
        if (_state.activeTab === 'scripts') {
            _readSkipRunConfirm().then(function (skip) {
                if (skip) {
                    _doExecute(items);
                } else {
                    var msg = items.length === 1
                        ? AEI18n.t('确定要运行脚本「{name}」吗？\n\n请注意：运行脚本可能会修改 After Effects 项目。', { name: items[0].name || '' })
                        : AEI18n.t('确定要运行 {n} 个脚本吗？\n\n请注意：运行脚本可能会修改 After Effects 项目。', { n: items.length });
                    var confirmRun = function () {
                        if (typeof global.showConfirm === 'function') {
                            // 确认 promise 挂 catch——悬挂链 reject 时
                            // _executeLock 永久停留 true，全部执行入口此后恒报
                            // 「正在执行中」（QuickBar 执行锁死直至重开面板）
                            global.showConfirm(AEI18n.t('运行脚本'), msg).then(function (ok) {
                                if (ok) _doExecute(items);
                                else _executeLock = false;  // 用户取消，释放锁
                            }).catch(function () {
                                _executeLock = false;  // 确认组件异常，释放锁
                            });
                        } else {
                            if (confirm(msg)) _doExecute(items);
                            else _executeLock = false;  // 用户取消，释放锁
                        }
                    };
                    confirmRun();
                }
            }).catch(function () {
                _executeLock = false;  // 读取设置异常，释放锁
            });
        } else {
            _doExecute(items);
        }
    }

    function _doExecute(items) {
        _state.batch.running = true;
        _state.batch.cancelled = false;
        _state.batch.current = 0;
        _state.batch.total = items.length;
        _state.batch.layerDone = 0;
        _state.batch.layerTotal = 0;
        _showBatchProgress(true);

        // executor 同步异常（未注入/execute 同步抛出/返回非 promise）——
        // 同步抛出点位于批量态半初始化之后（running=true、进度条已显示），异常逃逸到
        // 调用方则 _finishBatch 的 promise 收尾永不执行：_executeLock 与 batch.running
        // 双双残留，全部执行入口（执行按钮/双击/右键菜单/刷新）恒弹「正在执行中」
        // 直至重开面板。包裹在 _doExecute 内部而非调用点：① 覆盖 scripts/非 scripts
        // 全部调用路径（scripts 路径的链式 .catch 只释放锁，不复位 running）；
        // ② 就近复位批量态；③ 同步 throw 时 promise 链从未建立，.then/.catch 不会
        // 执行——路径互斥，与 _finishBatch 的释放不叠加
        try {
            global.AEQuickBarExecutor.execute(_state.activeTab, items, {
                onProgress: function (idx, item) {
                    _state.batch.current = idx;
                    // 新条目开始：重置图层进度（上一条的 layerTotal 不再适用）
                    _state.batch.layerDone = 0;
                    _state.batch.layerTotal = 0;
                    _updateBatchProgress(item);
                },
                onLayerProgress: function (itemIdx, item, done, total) {
                    _state.batch.layerDone = done;
                    _state.batch.layerTotal = total;
                    _updateBatchProgress(item);
                },
                isCancelled: function () {
                    return _state.batch.cancelled;
                }
            }).then(function (results) {
                _finishBatch(results);
            }).catch(function (e) {
                _finishBatch({ ok: 0, fail: 0, errors: [AEI18n.t('执行异常: {detail}', { detail: e && e.message ? e.message : e })] });
            });
        } catch (e) {
            _state.batch.running = false;
            _showBatchProgress(false);
            _executeLock = false;
            if (global.AEToast) global.AEToast.error(AEI18n.t('执行失败: {detail}', { detail: e && e.message ? e.message : e }));
        }
    }

    function _showBatchProgress(show) {
        if (!_overlayEl) return;
        var progress = _overlayEl.querySelector('.qb-progress');
        var hint = _overlayEl.querySelector('.qb-hint');
        if (progress) progress.style.display = show ? '' : 'none';
        if (hint) hint.style.display = show ? 'none' : '';
        // 重置进度条
        if (show) {
            var fill = _overlayEl.querySelector('.qb-progress-fill');
            if (fill) fill.style.width = '0%';
        }
    }

    function _updateBatchProgress(item) {
        if (!_overlayEl) return;
        var b = _state.batch;
        var frac = 0;
        if (b.total > 0) {
            // 预设分层应用时条目内按图层进度细分，进度条平滑推进；
            // 非预设类（无图层进度）保持按条目计
            if (b.layerTotal > 0) frac = (b.current - 1 + b.layerDone / b.layerTotal) / b.total;
            else frac = b.current / b.total;
        }
        if (frac < 0) frac = 0;
        if (frac > 1) frac = 1;
        var fill = _overlayEl.querySelector('.qb-progress-fill');
        if (fill) fill.style.width = (frac * 100) + '%';
        var name = item && item.name ? item.name : '';
        _updateStatus(b.layerTotal > 1
            ? AEI18n.t('正在执行 ({current}/{total}): {name}（图层 {done}/{layerTotal}）',
                { current: b.current, total: b.total, name: name, done: b.layerDone, layerTotal: b.layerTotal })
            : AEI18n.t('正在执行 ({current}/{total}): {name}', { current: b.current, total: b.total, name: name }));
    }

    function _finishBatch(results) {
        _executeLock = false;   // 释放执行锁：批量完成（成功/失败/取消）
        _state.batch.running = false;
        _showBatchProgress(false);
        // 取消时单独处理：判据改为**执行器的显式标记**
    // `results.cancelled`，不再用「ok 与 fail 均为 0」反推——后者在「中途取消且已有成功项」时
    // 不成立，于是走成功分支报「完成: 成功 N 项」，**被跳过的项对用户完全不可见**
    //（用户可能据此以为整批已生效：漏挂效果、漏导入素材）。纯取消（0 成功 0 失败）也走这里。
    if (results.cancelled) {
        var _doneN = results.ok || 0;
        var _skipN = (typeof results.skipped === 'number') ? results.skipped : null;
        var _cancelText = _doneN > 0
            ? (_skipN
                ? AEI18n.t('已取消：已完成 {done} 项，剩余 {skip} 项未执行', { done: _doneN, skip: _skipN })
                : AEI18n.t('已取消：已完成 {done} 项，其余未执行', { done: _doneN }))
            : AEI18n.t('已取消');
        _updateStatus(_cancelText);
        if (_doneN > 0 && global.AEToast && global.AEToast.info) global.AEToast.info(_cancelText);
        return;
    }
    if (results.ok === 0 && results.fail === 0) {
        // 走到这里 = 既无成功/失败，也**没有** `cancelled` 标记 ⇒ 只可能是异常收尾：
        // `_finishBatch({ok:0,fail:0,errors:['执行异常: …']})`（async 拒绝分支）或执行器的
        // unknown-category 出口。若一律报「已取消」，就把真实失败吞成「用户自己取消的」
        //（`执行异常:` 文案从不展示，用户只看到静默的「已取消」）。
        var _errs0 = (results.errors && results.errors.length) ? results.errors.slice(0, 3).join('; ') : '';
        var _msg0 = _errs0 || AEI18n.t('执行未开始（无结果返回）');
        if (global.AENotice) global.AENotice.show({
            id: 'quickbar-batch-fail',
            title: AEI18n.t('执行失败'),
            message: _msg0,
            tone: 'error',
            dismissible: true
        });
        _updateStatus(AEI18n.t('失败: {detail}', { detail: _msg0.slice(0, 120) }));
        return;
    }
        // 汇总反馈（预设类带 layers 字段：按实际应用图层数提示；其他类按条目数）
        var hasLayers = results.layers > 0;
        var okText = hasLayers
            ? AEI18n.t('成功应用 {n} 个图层', { n: results.layers })
            : AEI18n.t('成功 {n} 项', { n: results.ok });
        if (results.fail === 0) {
            if (global.AEToast) global.AEToast.success(okText);
            _updateStatus(AEI18n.t('完成: {summary}', { summary: okText }));
        } else if (results.ok === 0) {
            if (global.AENotice) global.AENotice.show({
                id: 'quickbar-batch-fail',
                title: AEI18n.t('执行失败'),
                message: AEI18n.t('全部 {n} 项失败。{detail}', { n: results.fail, detail: results.errors.slice(0, 3).join('; ') }),
                tone: 'error',
                dismissible: true
            });
            _updateStatus(AEI18n.t('完成: 失败 {n} 项', { n: results.fail }));
        } else {
            if (global.AENotice) global.AENotice.show({
                id: 'quickbar-batch-partial',
                title: AEI18n.t('部分执行失败'),
                message: AEI18n.t('{summary} / 失败 {failed}。{detail}', { summary: okText, failed: results.fail, detail: results.errors.slice(0, 3).join('; ') }),
                tone: 'warn',
                dismissible: true
            });
            _updateStatus(AEI18n.t('完成: {summary} / 失败 {failed}', { summary: okText, failed: results.fail }));
        }
    }

    global.AEQuickBar = global.AEQuickBar || {};
    global.AEQuickBar.bootstrap = bootstrap;
    global.AEQuickBar.open = open;
    global.AEQuickBar.close = close;
    global.AEQuickBar.toggle = toggle;
})(window);
