(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    // 视图模式偏好的 localStorage 键（面板级单一值，三个库共享——见 createTreeView 内注释）
    var VIEW_MODE_KEY = 'as_extp.assets.viewMode';
    // 网格格子尺寸偏好的 localStorage 键（同上，面板级共享）
    var GRID_CELL_KEY = 'as_extp.assets.gridCell';

    // ── 纯函数：扁平 items → 虚拟文件夹树 ──
    function buildFolderTree(items, extraFolders) {
        var root = { folders: [], items: [] };

        function _ensureFolders(fp) {
            var segs = String(fp || '').replace(/^\/+|\/+$/g, '').split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
            var node = root;
            var acc = '';
            segs.forEach(function (seg) {
                acc = acc ? acc + '/' + seg : '/' + seg;
                var found = null;
                for (var i = 0; i < node.folders.length; i++) {
                    if (node.folders[i].name === seg) { found = node.folders[i]; break; }
                }
                if (!found) { found = { name: seg, path: acc, folders: [], items: [] }; node.folders.push(found); }
                node = found;
            });
        }

        if (extraFolders && extraFolders.length) {
            extraFolders.forEach(function (fp) { _ensureFolders(fp); });
        }

        function _cmpName(a, b) {
            return String(a || '').toLowerCase().localeCompare(String(b || '').toLowerCase());
        }
        function _sortNode(node) {
            node.folders.sort(function (a, b) { return _cmpName(a.name, b.name); });
            node.items.sort(function (a, b) { return _cmpName(a.name, b.name); });
            for (var i = 0; i < node.folders.length; i++) _sortNode(node.folders[i]);
        }
        // 后代条目数一次算好挂在每个文件夹节点上（根节点不挂）：_countFolderChildren 若
        // 对每条文件夹行各递归一遍完整子树（O(文件夹 × 子树)），万级条目下是白跑的重复遍历。
        function _stampCounts(node) {
            var total = node.items.length;
            for (var i = 0; i < node.folders.length; i++) {
                node.folders[i].count = _stampCounts(node.folders[i]);
                total += node.folders[i].count;
            }
            return total;
        }

        if (!items || !items.length) {
            _sortNode(root);
            _stampCounts(root);
            return root;
        }

        items.forEach(function (it) {
            _ensureFolders(it.folder || '');
            var folder = it.folder || '';
            var segs = String(folder).replace(/^\/+|\/+$/g, '').split('/').filter(function (s) { return s && s !== '.' && s !== '..'; });
            var node = root;
            segs.forEach(function (seg) {
                for (var i = 0; i < node.folders.length; i++) {
                    if (node.folders[i].name === seg) { node = node.folders[i]; break; }
                }
            });
            node.items.push(it);
        });

        _sortNode(root);
        _stampCounts(root);
        return root;
    }

    // ── UI 骨架 ──
    // opts: {
    //   container, onSelect(id), itemLabel(it), itemIconClass(it)|itemIcon(it),
    //   renderDetail(it), isEditing(), onDragStart, onDragOver, onDrop,
    //   onContextmenu, onFolderDragStart, extraFolders, onBlankContextmenu,
    //   onRename(id, newBaseName),     // NEW: 行内重命名回调，返回 Promise
    //   nameForEdit(it),               // NEW: 行内编辑时显示的名称（默认 itemLabel 去扩展名）
    //   onNewItem(type, parentPath, name), // NEW: 行内新建回调，返回 Promise
    //   canRename(it),                 // NEW: 是否允许重命名此项（默认 true）
    //   onPreviewActivate(it),         // NEW: 大图标模式下双击预览区触发的主操作（可选）
    //   previewActionLabel,            // NEW: 底栏提示里的动作名（'导入' / '应用'，默认 '导入'）
    // }
    function createTreeView(opts) {
        var container = opts.container;
        var _selectedId = null;
        var _selectedSet = {};   // 多选素材：{ [id]: true }
        var _selectedOrder = []; // 多选素材的选中顺序（批量应用等按此序执行）
        var _selectedFolderSet = {};   // 多选文件夹：{ [folderPath]: true }
        var _lastClickKey = '';  // shift 范围选起点（'it|id' 或 'fd|path'）
        var _items = [];
        var _searchQuery = '';
        var _editingId = null;
        var _inlineNew = null;
        var _collapsedSet = {};
        var _onLeftClick = null;
        var _onLeftContextmenu = null;
        var _handlers = {
            onSelect: opts.onSelect || function () {},
            itemLabel: opts.itemLabel || function (it) { return it.name; },
            itemIconClass: opts.itemIconClass || null,
            itemIcon: opts.itemIcon || null,
            renderDetail: opts.renderDetail || function () { return AEI18n.html('<div class="assets-empty assets-empty-center">未选中</div>'); },
            isEditing: opts.isEditing || function () { return false; },
            onDragStart: opts.onDragStart || null,
            onDragOver: opts.onDragOver || null,
            onDrop: opts.onDrop || null,
            onContextmenu: opts.onContextmenu || null,
            onFolderDragStart: opts.onFolderDragStart || null,
            extraFolders: opts.extraFolders || null,
            onBlankContextmenu: opts.onBlankContextmenu || null,
            onRename: opts.onRename || null,
            nameForEdit: opts.nameForEdit || null,
            onNewItem: opts.onNewItem || null,
            onRenameFolder: opts.onRenameFolder || null,
            canRename: opts.canRename || function () { return true; },
            // 大图标模式下双击**预览区**（缩略图 / hover 播放层 / 无图时的图标位）触发的主操作：
            // 三库各自映射到与格子右上角 ↗ 相同的那个动作（素材/工程素材 = 导入AE，预设 = 应用）。
            // 双击名字（.tree-row-label）仍是行内重命名；未提供本钩子时预览区回落重命名，不留死区。
            onPreviewActivate: opts.onPreviewActivate || null,
            // 底栏提示里那个动作名（'导入' / '应用'）——与 onPreviewActivate 同源，只用于文案
            previewActionLabel: opts.previewActionLabel || AEI18n.t('导入'),
            onDetailAction: opts.onDetailAction || null,
            rowActions: opts.rowActions || null,
            // 网格模式缩略图钩子：返回 { url }（图片）、{ videoUrl, movPath }（视频，hover 播放）
            // 或 null（null → 格子回落 itemIcon）。
            // 三库各自提供（预设/工程素材取 previewFrame，素材引用取原文件）。
            itemThumb: opts.itemThumb || null,
            // 网格视频格子解码失败时的兜底（可选，视图提供）：素材引用库用它走转码，
            // 预设/工程素材不提供（它们的缩略图是已落盘的静态图）。
            // 回调收到 (v, it, thumb, hint)：hint 是本层提供的转码文案句柄
            // （show(text)/hide()，覆盖层、不位移格子）——视图只在**真在转码**时 show，
            // 缓存命中那种几十毫秒的等待不要上文案（上去一下就是闪，见 _attachGridVideoHover）
            onThumbVideoUnplayable: opts.onThumbVideoUnplayable || null,
            // 网格视频格子的静态封面（可选，视图提供）：返回 Promise<URL|null>。视频格子
            // 平时要出图而不是图标，而图得由能解码的一侧产出（Bridge ffmpeg 抽帧），
            // 故这里只问一句「封面在哪」，产出与缓存全在视图侧（见 refView.videoCover）。
            // 不提供则视频格子保持图标态（预设/工程素材库无视频，不接这条线）。
            videoCover: opts.videoCover || null
        };

        // ── 视图模式（列表树 / 大图标网格）──
        // 模式是**面板级单一偏好**（三个库共享同一值），持久化在面板 localStorage；
        // 读取失败（localStorage 不可用）回落 'tree'，不抛错。
        // 格子沿用与树行完全相同的类名与 data-id/data-folder 属性（见 _renderCell），
        // 故多选 / 框选 / 右键 / 拖拽 / 搜索 / 分块 这些既有能力在网格模式下全部照旧可用。
        var _viewMode = (opts.viewMode === 'grid') ? 'grid' : 'tree';
        if (opts.viewMode == null) {
            try {
                var _savedMode = global.localStorage && global.localStorage.getItem(VIEW_MODE_KEY);
                if (_savedMode === 'grid' || _savedMode === 'tree') _viewMode = _savedMode;
            } catch (_) {}
        }
        // 两模式各自记录拖拽后的宽度（树模式 = 左栏宽，网格模式 = 右栏宽）
        var _savedW = { tree: null, grid: null };

        // 网格格子尺寸（px）：Ctrl+滚轮可调（见 _attachGridZoom），持久化在面板 localStorage。
        // 只驱动一个 CSS 变量 --assets-grid-cell（列宽 minmax 下限 + 缩略图高度按比例算），
        // 故调整不需要重建任何 DOM。
        var GRID_CELL_MIN = 72, GRID_CELL_MAX = 200, GRID_CELL_STEP = 8;
        function _clampCellSize(v) {
            var n = parseInt(v, 10);
            if (!isFinite(n)) return 96;
            if (n < GRID_CELL_MIN) return GRID_CELL_MIN;
            if (n > GRID_CELL_MAX) return GRID_CELL_MAX;
            return n;
        }
        var _gridCellSize = 96;
        try {
            var _savedCell = global.localStorage && global.localStorage.getItem(GRID_CELL_KEY);
            if (_savedCell != null) _gridCellSize = _clampCellSize(_savedCell);
        } catch (_) {}
        var _footerEl = null;

        // ── 选择键：素材用 id，文件夹用 path，统一支持 Ctrl/Shift 多选 ──
        function _itemKey(id) { return 'it|' + id; }
        function _folderKey(path) { return 'fd|' + path; }
        // 视觉顺序（DOM 顺序 = 树遍历顺序），跨素材/文件夹统一
        function _getVisualKeys() {
            var out = [];
            var rows = _treeContent.querySelectorAll('.tree-row[data-id], .tree-row[data-folder]');
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                if (r.getAttribute('data-folder') != null) out.push({ key: _folderKey(r.getAttribute('data-folder')), type: 'folder' });
                else out.push({ key: _itemKey(r.getAttribute('data-id')), type: 'item' });
            }
            return out;
        }
        function _countSelectedTotal() { return Object.keys(_selectedSet).length + Object.keys(_selectedFolderSet).length; }
        // —— 素材选中态维护（同步 _selectedSet 与 _selectedOrder，order 记录选中先后）——
        function _clearItemSelection() { _selectedSet = {}; _selectedOrder = []; }
        function _addItemSelection(id, toFront) {
            if (_selectedSet[id]) {
                if (toFront) {  // 重复选中视为"最后点击"，移到队尾（执行顺序=点击顺序）
                    var k = _selectedOrder.indexOf(id);
                    if (k >= 0) _selectedOrder.splice(k, 1);
                    _selectedOrder.push(id);
                }
                return;
            }
            _selectedSet[id] = true;
            _selectedOrder.push(id);
        }
        function _removeItemSelection(id) {
            delete _selectedSet[id];
            var k = _selectedOrder.indexOf(id);
            if (k >= 0) _selectedOrder.splice(k, 1);
        }
        // —— 选中互斥：冲突时父文件夹优先 —— 后选子级无效；后选父级吃掉后代 ——
        // 注意 key 形态：文件夹选中集的 key 是 data-folder 原始值（节点 path，
        // 带前导斜杠如 '/A'），素材 folder 是不带斜杠的 'A'。
        // 存储一律原始形（与渲染/取消选中一致），所有比较经 _normPath 双侧规范化。
        function _normPath(p) { return String(p || '').replace(/^\/+|\/+$/g, ''); }
        function _findItem(id) {
            for (var i = 0; i < _items.length; i++) {
                if (String(_items[i].id) === String(id)) return _items[i];
            }
            return null;
        }
        // 素材是否位于 folderPath（其内或其后代目录内）。folderPath 为规范形
        function _itemInsideFolder(it, fp) {
            if (!fp) return false;
            var f = _normPath(it.folder || '');
            return f === fp || f.indexOf(fp + '/') === 0;
        }
        // 选中文件夹（父优先互斥）：
        //   祖先已选中 → 拒绝；否则吃掉已选中的后代文件夹与后代素材，再入选
        function _selectFolderMutex(folderPath) {
            var fp = _normPath(folderPath);
            if (!fp) return;
            var keys = Object.keys(_selectedFolderSet);
            for (var i = 0; i < keys.length; i++) {
                var ak = _normPath(keys[i]);
                if (ak === fp) return;                       // 已选中
                if (fp.indexOf(ak + '/') === 0) return;      // 祖先已选中，父优先拒绝
            }
            for (var i2 = keys.length - 1; i2 >= 0; i2--) {  // 吃掉后代文件夹
                if (_normPath(keys[i2]).indexOf(fp + '/') === 0) delete _selectedFolderSet[keys[i2]];
            }
            var itemIds = _getSelectedIds();                 // 吃掉后代素材
            for (var j = 0; j < itemIds.length; j++) {
                var it = _findItem(itemIds[j]);
                if (it && _itemInsideFolder(it, fp)) _removeItemSelection(itemIds[j]);
            }
            _selectedFolderSet[folderPath] = true;           // 原始 key 存储
        }
        // 选中素材（父优先互斥）：所在文件夹（自身或祖先）已选中 → 拒绝
        function _selectItemMutex(id) {
            if (_selectedSet[id]) return;
            var it = _findItem(id);
            if (it) {
                var keys = Object.keys(_selectedFolderSet);
                for (var i = 0; i < keys.length; i++) {
                    if (_itemInsideFolder(it, _normPath(keys[i]))) return;
                }
            }
            _addItemSelection(id, false);
        }
        function _selectKey(key, type, isCtrl, isShift) {
            var id = String(key).slice(3);  // 去掉 'it|' / 'fd|' 前缀
            if (isShift && _lastClickKey) {
                var keys = _getVisualKeys();
                var from = -1, to = -1;
                for (var i = 0; i < keys.length; i++) {
                    if (keys[i].key === _lastClickKey) from = i;
                    if (keys[i].key === key) to = i;
                }
                if (from !== -1 && to !== -1) {
                    if (!isCtrl) { _clearItemSelection(); _selectedFolderSet = {}; }
                    // 按范围方向入序：从锚点（from=上次点击）遍历到本次点击（to），
                    // 向下选视觉升序、向上选视觉降序——顺序=点击先后，锚点最先、本次点击最后
                    if (to >= from) {
                        for (var r = from; r <= to; r++) {
                            var k = keys[r];
                            if (k.type === 'folder') _selectFolderMutex(k.key.slice(3));
                            else _selectItemMutex(k.key.slice(3));
                        }
                    } else {
                        for (var r = from; r >= to; r--) {
                            var k2 = keys[r];
                            if (k2.type === 'folder') _selectFolderMutex(k2.key.slice(3));
                            else _selectItemMutex(k2.key.slice(3));
                        }
                    }
                }
            } else if (isCtrl) {
                if (type === 'folder') {
                    if (_selectedFolderSet[id]) { if (_countSelectedTotal() <= 1) return; delete _selectedFolderSet[id]; }
                    else _selectFolderMutex(id);
                } else {
                    if (_selectedSet[id]) { if (_countSelectedTotal() <= 1) return; _removeItemSelection(id); }
                    else _selectItemMutex(id);
                }
            } else {
                _clearItemSelection();
                _selectedFolderSet = {};
                if (type === 'folder') _selectedFolderSet[id] = true;
                else _addItemSelection(id, false);
            }
            _lastClickKey = key;
        }

        // ── DOM 骨架 ──
        container.innerHTML = '';
        var wrap = document.createElement('div');
        wrap.className = 'assets-treeview';
        wrap.style.cssText = 'display:flex;flex:1 1 auto;min-height:0;';

        var left = document.createElement('div');
        left.className = 'assets-tree-left';

        var splitter = document.createElement('div');
        splitter.className = 'assets-tree-splitter';

        var right = document.createElement('div');
        right.className = 'assets-tree-right';
        // 右面板按钮点击：就地处理，不冒泡
        right.addEventListener('click', function (e) {
            var btn = e.target.closest('[data-act]');
            if (btn && _handlers.onDetailAction) {
                e.stopPropagation();
                _handlers.onDetailAction(btn.getAttribute('data-act'), btn.getAttribute('data-id'), btn);
            }
        });

        wrap.appendChild(left);
        wrap.appendChild(splitter);
        wrap.appendChild(right);
        container.appendChild(wrap);

        // ── 分隔条拖拽：调整「有定宽的那一栏」──
        // 树模式定宽的是左栏，网格模式定宽的是右栏（左栏铺满）——故起始宽度与写入目标
        // 都按当前模式选，两个模式的宽度各自记录在 _savedW 里。
        // 树模式左栏写 '0 1'（拖出的宽度是首选宽，面板拖窄时仍可压缩，不把详情栏挤出卡片）；
        // 网格模式右栏保持 '0 0' 定宽（详情栏宽度不随网格内容变化）。
        // 树模式左栏在窄面板下按比例压缩：渲染宽小于首选宽，拖拽起点取首选宽
        // （_savedW 或 CSS 的 flex-basis）。
        function _preferredLeftWidth() {
            if (_savedW.tree) return _savedW.tree;
            var basis = '';
            try {
                basis = (global.getComputedStyle ? global.getComputedStyle(left).flexBasis : '') || '';
            } catch (_) {}
            var n = parseFloat(basis);
            // 230 与 CSS 的 .assets-tree-left 默认 basis 一致（无计算样式环境下的回落）
            return (isFinite(n) && n > 0) ? n : (left.offsetWidth || 230);
        }
        var _splitDragMove = null, _splitDragUp = null;
        splitter.addEventListener('mousedown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            var startX = e.clientX;
            var dragGrid = (_viewMode === 'grid');
            var startWidth = dragGrid ? right.offsetWidth : _preferredLeftWidth();
            document.body.style.cursor = 'col-resize';
            document.body.style.userSelect = 'none';
            _splitDragMove = function (ev) {
                var dx = ev.clientX - startX;
                // 网格模式拖的是右栏，方向相反（向右拖 = 右栏变窄）
                var newW = dragGrid ? (startWidth - dx) : (startWidth + dx);
                var minW = 150;
                // 上限 = 为另一栏保留 200px 后的可用宽，且不小于当前首选宽
                // （窄面板下首选宽可超过可用宽）。
                var maxW = Math.max(minW, wrap.offsetWidth - 200, startWidth);
                if (newW < minW) newW = minW;
                if (newW > maxW) newW = maxW;
                if (dragGrid) { right.style.flex = '0 0 ' + newW + 'px'; _savedW.grid = newW; }
                else { left.style.flex = '0 1 ' + newW + 'px'; _savedW.tree = newW; }
            };
            _splitDragUp = function () {
                document.removeEventListener('mousemove', _splitDragMove);
                document.removeEventListener('mouseup', _splitDragUp);
                _splitDragMove = null; _splitDragUp = null;
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            };
            document.addEventListener('mousemove', _splitDragMove);
            document.addEventListener('mouseup', _splitDragUp);
        });

        // 按当前模式套布局：树模式左栏默认 230px + 右栏占剩余宽度；网格模式左栏铺满 +
        // 右栏按 clamp(180px, 30%, 260px) 定宽。两种模式的**默认**布局由 CSS 提供
        // （见 assets.css）——这里只叠加分隔条拖出的宽度（动态值只能走行内；未拖过则清空
        // 行内让 CSS 默认值生效），并切换模式标记类。两个模式拖出的宽度各自保留（_savedW），
        // 切回时恢复。树模式左栏行内宽度保留收缩能力（'0 1'），窄面板下不撑破容器。
        function _applyMode() {
            var isGrid = (_viewMode === 'grid');
            if (wrap.classList) {
                if (isGrid) wrap.classList.add('assets-mode-grid');
                else wrap.classList.remove('assets-mode-grid');
            }
            // 格子尺寸走 CSS 变量：列宽下限与缩略图高度都从它算，故改尺寸不用重建 DOM
            if (wrap.style && typeof wrap.style.setProperty === 'function') {
                wrap.style.setProperty('--assets-grid-cell', _gridCellSize + 'px');
            }
            // flex 简写会同时写 grow/shrink/basis 三个长属性；行内宽度只经它写入，
            // 不能再单独清 flexBasis（清掉后首选宽回落到 CSS 默认值）。
            if (isGrid) {
                left.style.flex = '';
                right.style.flex = _savedW.grid ? ('0 0 ' + _savedW.grid + 'px') : '';
            } else {
                left.style.flex = _savedW.tree ? ('0 1 ' + _savedW.tree + 'px') : '';
                right.style.flex = '';
            }
        }

        // 网格格子尺寸调整：Ctrl+滚轮（与 Finder/资源管理器的大图标视图同一手势）。
        // 只改 CSS 变量 + 持久化，不重建 DOM；非网格模式不拦滚轮（列表照常滚）。
        function _attachGridZoom() {
            _treeContent.addEventListener('wheel', function (e) {
                if (_viewMode !== 'grid' || !e.ctrlKey) return;
                e.preventDefault();
                var dir = (e.deltaY > 0) ? -1 : 1;   // 向下滚 = 变小
                _applyGridCellSize(_gridCellSize + dir * GRID_CELL_STEP);
            }, { passive: false });
        }

        // 尺寸唯一写入口（Ctrl+滚轮 与底栏滑块共用）：夹取 → 持久化 → 写 CSS 变量 → 回同步滑块刻度。
        // 值没变就不落盘（撞到上下限时滚轮继续滚不该反复写 localStorage）。
        function _applyGridCellSize(next) {
            var v = _clampCellSize(next);
            if (v === _gridCellSize) return;
            _gridCellSize = v;
            try {
                if (global.localStorage) global.localStorage.setItem(GRID_CELL_KEY, String(_gridCellSize));
            } catch (_) {}
            if (wrap.style && typeof wrap.style.setProperty === 'function') {
                wrap.style.setProperty('--assets-grid-cell', _gridCellSize + 'px');
            }
            _syncZoomRange();
        }

        // 滑块刻度跟随尺寸（列表模式下 footer 里没有滑块 → 静默）。Ctrl+滚轮 改的尺寸也要
        // 在滑块上看得见，否则两个入口会各说各话。
        function _syncZoomRange() {
            if (!_footerEl || typeof _footerEl.querySelector !== 'function') return;
            var r = _footerEl.querySelector('.assets-grid-zoom-range');
            if (r) r.value = String(_gridCellSize);
        }

        // 树内容区（搜索栏和 footer 外，独立重建）
        var _treeContent = document.createElement('div');
        _treeContent.className = 'assets-tree-content';
        // 轻量分页：滚动接近底部时触发生成下一批（见 _renderNextChunk）
        // rAF 里校验渲染代数：重建（_renderLeftOnly 开头 _renderSeq++）会让重建前排队的
        // 这一批作废——否则它会拿**重建后的新 plan** 再追加 400 行，scrollHeight 一帧内
        // 二次增长，CEF 88 的滚动锚定把视口推走（深滚动折叠时实测 +396～+4825px，
        // 同步看似正确、一帧后才跳）。
        _treeContent.addEventListener('scroll', function () {
            if (!_plan) return;
            var c = _treeContent;
            if (c.clientHeight > 0 && c.scrollTop + c.clientHeight >= c.scrollHeight - 200) {
                if (window.requestAnimationFrame) {
                    var gen = _renderSeq;
                    window.requestAnimationFrame(function () {
                        if (gen === _renderSeq) _renderNextChunk();
                    });
                } else _renderNextChunk();
            }
        });
        _attachGridZoom();

        // ── 搜索栏 + 视图模式开关（只建一次，不随搜索重建）──
        var _modeBtn = null;
        var _searchWrap = null;
        (function _buildSearchBar() {
            var wrap2 = document.createElement('div');
            wrap2.className = 'assets-search-wrap';
            _searchWrap = wrap2;
            var row = document.createElement('div');
            row.className = 'assets-search-row';
            var input = document.createElement('input');
            input.className = 'assets-search-input';
            input.type = 'text';
            input.placeholder = AEI18n.t('搜索素材…');
            var clearBtn = document.createElement('button');
            clearBtn.className = 'assets-search-clear';
            clearBtn.textContent = '✕';
            clearBtn.style.display = 'none';
            // 视图模式开关：置于搜索行右侧，三个库共用这一处实现
            var modeBtn = document.createElement('button');
            modeBtn.className = 'assets-mode-toggle';
            modeBtn.type = 'button';
            _modeBtn = modeBtn;
            row.appendChild(input);
            row.appendChild(clearBtn);
            row.appendChild(modeBtn);
            wrap2.appendChild(row);
            left.appendChild(wrap2);

            input.addEventListener('input', function () {
                _searchQuery = this.value;
                clearBtn.style.display = _searchQuery ? '' : 'none';
                _applySearch();
            });
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { _searchQuery = ''; this.value = ''; clearBtn.style.display = 'none'; _applySearch(); }
            });
            clearBtn.addEventListener('click', function () {
                _searchQuery = ''; input.value = ''; clearBtn.style.display = 'none'; _applySearch(); input.focus();
            });
            modeBtn.addEventListener('click', function () {
                setViewMode(_viewMode === 'grid' ? 'tree' : 'grid');
            });
        })();

        // 切换视图模式：不重置选中集（保持 _selectedSet/_selectedFolderSet/_selectedId/
        // _selectedOrder），只重建左栏并重打选中态；模式值持久化到面板 localStorage。
        function setViewMode(mode) {
            var next = (mode === 'grid') ? 'grid' : 'tree';
            if (next === _viewMode) return;
            // 行内编辑中先取消编辑再切：_renderLeftOnly 会 innerHTML='' 销毁编辑器，而移除聚焦
            // 元素**不触发 blur** → 提交逻辑不执行 → _editingId/_inlineNew 残留 stale，之后
            // 该行点不动、详情区永久停更（_renderDetail/refreshDetail 都在 isEditing 上早退）。
            // 与 _beginRename 处理"切换编辑目标"同款（取消在飞行的编辑再继续）。
            if (_inlineNew) _cancelNewItem();
            if (_editingId) _cancelRename();
            _viewMode = next;
            try {
                if (global.localStorage) global.localStorage.setItem(VIEW_MODE_KEY, _viewMode);
            } catch (_) {}
            _applyMode();
            _syncModeBtn();
            _syncFooter();
            _renderLeftOnly();
            _refreshSelection();
        }
        function getViewMode() { return _viewMode; }
        // 当前网格格子尺寸（px）——供测试与调试读取
        function getGridCellSize() { return _gridCellSize; }

        // 开关按钮文案：显示的是"点了会切到哪"（当前网格 → 显示列表图标）
        function _syncModeBtn() {
            if (!_modeBtn) return;
            var isGrid = (_viewMode === 'grid');
            _modeBtn.textContent = isGrid ? '☰' : '▦';
            _modeBtn.title = isGrid ? AEI18n.t('切回列表视图') : AEI18n.t('切到大图标视图');
        }
        _applyMode();
        _syncModeBtn();
        _syncFooter();

        // ── 模糊匹配 ──
        function _fuzzyMatch(query, target) {
            if (!query) return true;
            var q = query.toLowerCase();
            var t = target.toLowerCase();
            var qi = 0;
            for (var ti = 0; ti < t.length && qi < q.length; ti++) {
                if (t.charAt(ti) === q.charAt(qi)) qi++;
            }
            return qi === q.length;
        }

        function _applySearch() {
            // 搜索时收敛选中：被过滤隐藏的选中项（素材/文件夹）自动取消选中，
            // 保证选中集合始终 ⊆ 可见列表——避免"看不见但会被批量执行"的误伤
            if (_searchQuery) {
                var visibleItems = _filterItems();
                var visibleIds = {};
                for (var vi = 0; vi < visibleItems.length; vi++) visibleIds[visibleItems[vi].id] = true;
                var itemIds = _getSelectedIds();
                for (var ii = 0; ii < itemIds.length; ii++) {
                    if (!visibleIds[itemIds[ii]]) _removeItemSelection(itemIds[ii]);
                }
                var folderPaths = Object.keys(_selectedFolderSet);
                for (var fi = 0; fi < folderPaths.length; fi++) {
                    var fp = folderPaths[fi];
                    // key 是 data-folder 原始值（'/A' 带前导斜杠），素材 folder/extras 是 'A' 形，
                    // 比较前须 _normPath 规范化（同 _selectFolderMutex 约定），否则永远不匹配 → 误清空。
                    // 可见判定含后代：命中素材在 'A/B' 下时，树会为它渲染祖先行 'A'，'A' 仍是可见行
                    var fpNorm = _normPath(fp);
                    var fpVisible = false;
                    if (fpNorm) {
                        var fpPrefix = fpNorm + '/';
                        for (var fk = 0; fk < visibleItems.length; fk++) {
                            var vf = visibleItems[fk].folder;
                            if (vf === fpNorm || (vf && vf.indexOf(fpPrefix) === 0)) { fpVisible = true; break; }
                        }
                        // 额外文件夹（extraFolders）不受素材级过滤影响，按搜索词单独匹配（同样含后代）
                        if (!fpVisible && _handlers.extraFolders) {
                            var extras = _handlers.extraFolders();
                            for (var ek = 0; ek < extras.length; ek++) {
                                var ex = extras[ek];
                                if (!_fuzzyMatch(_searchQuery, ex)) continue;
                                if (ex === fpNorm || ex.indexOf(fpPrefix) === 0) { fpVisible = true; break; }
                            }
                        }
                    }
                    if (!fpVisible) delete _selectedFolderSet[fp];
                }
                // _selectedId 被过滤隐藏时清空详情面板选中
                if (_selectedId && !visibleIds[_selectedId]) _selectedId = null;
            }
            _renderLeftOnly();
            _refreshSelection();
            _renderDetail();
        }

        // ── 底部快捷键栏（只建一次）──
        (function _buildFooter() {
            var footer = document.createElement('div');
            footer.className = 'assets-tree-footer';
            footer.innerHTML = AEI18n.html('<span>双击重命名 · 右键菜单</span><span>拖拽移动</span>');
            left.appendChild(footer);
            _footerEl = footer;
            _syncFooter();   // 建好即按当前模式同步（初始就是 grid 的实例不能停在列表文案上）
        })();

        // 底部提示随模式切换：网格模式给「Ctrl+滚轮 调格子大小」（该手势无可见控件，不写出来
        // 就没人知道——见 _attachGridZoom），同一行再放一条尺寸滑块（可见入口，与滚轮共用同一
        // 写入口 _applyGridCellSize，刻度双向同步）。滑块随这段文案整段重建，故每次重建都要重挂。
        // 两种模式的双击落区不同（网格：名字 = 重命名、预览图 = 主操作，见 _renderRow 的 dblclick
        // 分支），底栏文案必须跟着模式走——否则底栏写着"双击重命名"而双击预览图是导入。
        function _syncFooter() {
            if (!_footerEl) return;
            if (_viewMode !== 'grid') {
                _footerEl.innerHTML = AEI18n.html('<span>双击重命名 · 右键菜单</span><span>拖拽移动</span>');
                return;
            }
            _footerEl.innerHTML = AEI18n.html('<span>双击名字重命名 · 双击预览图') + _esc(_handlers.previewActionLabel)
                + AEI18n.html(' · 右键菜单</span>')
                + '<span class="assets-grid-zoom">'
                + AEI18n.html('<input type="range" class="assets-grid-zoom-range" min="' + GRID_CELL_MIN + '" max="' + GRID_CELL_MAX + '" step="' + GRID_CELL_STEP + '" title="' + AEI18n.t('格子大小') + '" aria-label="' + AEI18n.t('格子大小') + '">')
                + AEI18n.html('<span>Ctrl+滚轮 调格子大小</span>')
                + '</span>';
            var range = _footerEl.querySelector('.assets-grid-zoom-range');
            if (range && typeof range.addEventListener === 'function') {
                range.addEventListener('input', function () { _applyGridCellSize(this.value); });
            }
            _syncZoomRange();
        }

        function _renderIcon(it) {
            var icon = _handlers.itemIcon ? _handlers.itemIcon(it) : '';
            return icon ? '<span class="tree-row-icon">' + _esc(icon) + '</span>' : '';
        }

        function _renderRow(it, depth) {
            var row = document.createElement('div');
            row.className = 'tree-row assets-tree-row';
            row.style.paddingLeft = '2px';
            row.setAttribute('data-id', it.id);
            row.setAttribute('draggable', 'true');
            var iconHtml = _renderIcon(it);
            row.innerHTML = iconHtml +
                '<span class="tree-row-label">' + _esc(_handlers.itemLabel(it)) + '</span>';
            // 行末操作按钮（仅选中时可见）
            if (_handlers.rowActions) {
                var actionsHtml = _handlers.rowActions(it);
                if (actionsHtml) {
                    row.innerHTML += '<span class="assets-row-actions">' + actionsHtml + '</span>';
                }
            }
            if (String(it.id) === _selectedId) {
                row.classList.add('selected');
            }
            // 搜索匹配高亮
            if (_searchQuery && _fuzzyMatch(_searchQuery, _handlers.itemLabel(it))) {
                row.classList.add('search-match');
            }
            // missing 行红色提示
            var isMissing = it.missing || (it._raw && it._raw.missing);
            if (isMissing) {
                row.classList.add('missing');
            }
            row.addEventListener('click', function (e) {
                if (_editingId === String(it.id)) return;
                if (_inlineNew) return;
                var isCtrl = e.ctrlKey || e.metaKey;
                var isShift = e.shiftKey;
                var sid = String(it.id);
                var wasSelected = !!_selectedSet[sid];
                _selectKey(_itemKey(sid), 'item', isCtrl, isShift);
                // 选中互斥拒绝（素材位于已选文件夹内）：保持旧选中集，不切详情、不通知
                // （onSelect 会触发 view 的 _refresh + select，反过来推翻互斥，且 getSelected 与选中集不一致）
                if (!wasSelected && !_selectedSet[sid]) {
                    _refreshSelection();
                    return;
                }
                _selectedId = sid;
                // ctrl 取消选中后 _selectedId 可能已不在选中集内：同步为选中集内最后选中的
                // 条目（集空则清空），保持 getSelected() 与 getSelectedIds() 一致
                if (!_selectedSet[_selectedId]) {
                    _selectedId = _selectedOrder.length ? _selectedOrder[_selectedOrder.length - 1] : null;
                }
                _refreshSelection();
                _renderDetail();
                _handlers.onSelect(_selectedId);
            });
            row.addEventListener('dblclick', function (e) {
                if (_inlineNew) return;
                // 本行正在行内重命名：双击输入框是"选中一个词"的手势，既不该重开编辑器
                // （_beginRename 会 _cancelRename 重建输入框、已输入的内容被原名覆盖），
                // 也不该触发预览区的主操作。与上面 click 处理器同款守卫。
                if (_editingId === String(it.id)) return;
                var t = e && e.target;
                // 行内动作按钮（行末/格子右上角的 ↗）：click 委托（_onLeftClick）已经执行过主操作，
                // 而一次双击 = 两次 click —— 这里再触发就是第三遍导入/应用（_busy 会挡住，但会刷
                // 「正在执行操作，请等待」）；按钮上也不该弹重命名输入框。
                if (t && t.closest && t.closest('.assets-row-act')) return;
                // 大图标模式分两个落区：名字区（.tree-row-label，或正在编辑名字时的输入框）→ 行内
                // 重命名；预览区（缩略图 / hover 播放层 / 无图回落图标位）→ 主操作（导入AE / 应用）。
                // 视图未提供 onPreviewActivate 时（钩子可选）预览区回落重命名，不留死区。
                var nameZone = !!(t && t.closest && t.closest('.tree-row-label, .assets-rename-input'));
                if (_viewMode === 'grid' && _handlers.onPreviewActivate && !nameZone) {
                    _handlers.onPreviewActivate(it);
                    return;
                }
                if (_handlers.onRename && _handlers.canRename(it)) _beginRename(it.id);
            });
            if (_handlers.onDragStart) row.addEventListener('dragstart', function (e) {
                // 多选拖拽：如果拖的是选中项且选中 >1，把全部选中 ID 写入 drag data
                if (_selectedSet[String(it.id)] && _countSelected() > 1) {
                    e.dataTransfer.setData('application/x-ae-assets-batch', _getSelectedIds().join(','));
                }
                _handlers.onDragStart(it, e);
            });
            if (_handlers.onDragOver) {
                row.addEventListener('dragover', function (e) { _handlers.onDragOver(it, e); });
                row.addEventListener('dragleave', function (e) { row.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after'); });
            }
            if (_handlers.onDrop) row.addEventListener('drop', function (e) { _handlers.onDrop(it, null, e); });
            if (_handlers.onContextmenu) row.addEventListener('contextmenu', function (e) {
                e.preventDefault(); e.stopPropagation();
                _handlers.onContextmenu(it, false, null, e.clientX, e.clientY);
            });
            return row;
        }

        function _toggleFolder(path, recursive) {
            if (_collapsedSet[path]) {
                delete _collapsedSet[path];
                // shift：展开时同时展开所有后代子文件夹
                if (recursive) _expandDescendants(path);
            } else {
                _collapsedSet[path] = true;
                // shift：收起时同时收起所有后代子文件夹（与展开对称）
                if (recursive) _collapseDescendants(path);
            }
            // 保留滚动位置：折叠/展开只改变被点文件夹**之后**的可见行，该文件夹行本身在
            // 树中的位置不变（DFS 顺序里子树排在它后面）。不回传 keepScroll 会被重建成
            // 「scrollTop 保持旧值、但首批只渲染 400 行」——滚到中段再点箭头，视口里是
            // 未渲染的空白，看起来就是"跳到不知道哪里"。
            // keepScroll 路径会补渲染覆盖原视口并把 scrollTop clamp 回新内容范围内。
            _renderLeftOnly(true);
            _refreshSelection();
        }

        // 展开 path 下所有被折叠的后代文件夹
        function _expandDescendants(path) {
            var prefix = path ? path + '/' : null;
            var keys = Object.keys(_collapsedSet);
            for (var i = 0; i < keys.length; i++) {
                if (prefix && keys[i].indexOf(prefix) === 0) delete _collapsedSet[keys[i]];
            }
        }

        // 折叠 path 下所有后代子文件夹（按当前 items 重建临时树遍历，与渲染同源）
        function _collapseDescendants(path) {
            var tree = _getTree(_filterItems(), (_handlers.extraFolders && typeof _handlers.extraFolders === 'function') ? _handlers.extraFolders() : null);
            var node = tree;
            var segs = _normPath(path).split('/').filter(function (s) { return !!s; });
            for (var i = 0; i < segs.length; i++) {
                var next = null;
                for (var j = 0; j < node.folders.length; j++) {
                    if (node.folders[j].name === segs[i]) { next = node.folders[j]; break; }
                }
                if (!next) return;
                node = next;
            }
            (function walk(n, prefix) {
                for (var k = 0; k < n.folders.length; k++) {
                    var child = n.folders[k];
                    var childPath = prefix + '/' + child.name;
                    _collapsedSet[childPath] = true;
                    walk(child, childPath);
                }
            })(node, path);
        }

        function _buildFolderHead(f, depth) {
            var head = document.createElement('div');
            head.className = 'tree-row assets-tree-row assets-tree-folder';
            head.style.paddingLeft = '2px';
            head.setAttribute('data-folder', f.path || '');
            head.setAttribute('data-is-folder', '1');
            head.setAttribute('draggable', 'true');
            var isCollapsed = !_searchQuery && !!_collapsedSet[f.path];
            var childCount = _countFolderChildren(f);

            // 折叠箭头
            var arrow = document.createElement('span');
            arrow.className = 'assets-tree-arrow' + (isCollapsed ? '' : ' expanded');
            arrow.textContent = '▶';
            head.appendChild(arrow);
            // icon
            var iconEl = document.createElement('span');
            iconEl.className = 'tree-row-icon';
            iconEl.textContent = '📁';
            head.appendChild(iconEl);
            // label
            var labelEl = document.createElement('span');
            labelEl.className = 'tree-row-label';
            labelEl.textContent = f.name;  // no _esc needed — textContent is safe
            head.appendChild(labelEl);
            // meta count — 推到最右
            if (childCount > 0) {
                var meta = document.createElement('span');
                meta.className = 'assets-tree-folder-meta';
                meta.textContent = childCount;
                head.appendChild(meta);
            }

            // 点击整行（除箭头外）选中文件夹；点击三角区域展开/折叠
            head.addEventListener('click', function (e) {
                if (_editingId) return;
                if (_inlineNew) return;
                if (e.target === arrow || arrow.contains(e.target)) return;
                var isCtrl = e.ctrlKey || e.metaKey;
                var isShift = e.shiftKey;
                _selectKey(_folderKey(f.path), 'folder', isCtrl, isShift);
                _selectedId = null;
                _refreshSelection();
                _renderDetail();
                _handlers.onSelect(null);
            });
            arrow.addEventListener('click', function (e) {
                e.stopPropagation();
                // 行内编辑中禁止折叠/展开（与 head click 同守卫）：_toggleFolder → _renderLeftOnly
                // 会 innerHTML='' 销毁编辑器（移除聚焦元素不触发 blur，提交逻辑不执行），
                // _inlineNew/_editingId 残留 stale 后所有行点击都被守卫拦截，左树点击失灵
                if (_editingId) return;
                if (_inlineNew) return;
                // 多选多个文件夹时，点击选中集内其中一个的箭头 → 批量展开/折叠所有选中文件夹；
                // 点击的文件夹不在选中集内则不批量，按单文件夹原行为
                var selFolders = Object.keys(_selectedFolderSet);
                if (selFolders.length > 1 && selFolders.indexOf(f.path) !== -1) {
                    // 被点击文件夹当前折叠 → 展开操作；已展开 → 折叠操作
                    var isExpand = !!_collapsedSet[f.path];
                    for (var i = 0; i < selFolders.length; i++) {
                        if (isExpand) {
                            delete _collapsedSet[selFolders[i]];
                            if (e.shiftKey) _expandDescendants(selFolders[i]);
                        } else {
                            _collapsedSet[selFolders[i]] = true;
                            if (e.shiftKey) _collapseDescendants(selFolders[i]);
                        }
                    }
                    _renderLeftOnly(true);   // 与单击折叠同口径：保持滚动位置
                    _refreshSelection();
                    return;
                }
                _toggleFolder(f.path, e.shiftKey);
            });

            if (_handlers.onFolderDragStart) {
                head.addEventListener('dragstart', function (e) { _handlers.onFolderDragStart(f.path, e); });
            }
            if (_handlers.onDragOver) {
                head.addEventListener('dragover', function (e) {
                    _handlers.onDragOver(null, e, f.path);
                    if (e.defaultPrevented) {
                        head.classList.add('drag-over');
                    }
                });
                head.addEventListener('dragleave', function (e) { head.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after'); });
            }
            if (_handlers.onDrop) head.addEventListener('drop', function (e) {
                head.classList.remove('drag-over');
                _handlers.onDrop(null, f.path, e);
            });
            if (_handlers.onContextmenu) head.addEventListener('contextmenu', function (e) {
                e.preventDefault(); e.stopPropagation();
                _handlers.onContextmenu(null, true, f.path, e.clientX, e.clientY);
            });
            return head;
        }

        function _countFolderChildren(f) {
            // buildFolderTree 已把后代条目数预计算到节点上（count）；下面的递归只作回退，
            // 供外部构造的节点（缺字段）使用，避免计数直接显示 0。
            if (f && typeof f.count === 'number') return f.count;
            var count = f.items.length;
            for (var i = 0; i < f.folders.length; i++) {
                count += _countFolderChildren(f.folders[i]);
            }
            return count;
        }

        // ── 文件夹树缓存：折叠/展开不重建树 ──
        // 建树 + 排序 + 计数在万级条目下是百毫秒量级（素材引用库 3.9 万条目 / 1842 文件夹
        // 实测 105ms），而折叠/展开只改变可见行、树本身不变，既往每次点击都白跑一遍。
        // 缓存键 = 条目数组引用 + 额外文件夹内容签名 + 搜索词；数据入口（render/renderList）
        // 显式清缓存，折叠/展开路径（_toggleFolder → _renderLeftOnly）因此必然命中。
        var _treeCache = null;

        function _extraFoldersSig(extra) {
            if (!extra || !extra.length) return '0';
            // 分隔符用 \u0001：文件夹路径不可能含它，避免 ['ab','c'] 与 ['ab\nc'] 拼出同串
            return extra.length + '|' + extra.join('\u0001');
        }

        function _invalidateTreeCache() { _treeCache = null; }

        function _getTree(items, extra) {
            var sig = _extraFoldersSig(extra);
            var q = _searchQuery || '';
            var c = _treeCache;
            if (c && c.items === items && c.extraSig === sig && c.query === q) return c.tree;
            var tree = buildFolderTree(items, extra);
            _treeCache = { items: items, extraSig: sig, query: q, tree: tree };
            return tree;
        }

        // ── 轻量分页：flatten 可见行为 plan，逐批渲染，缓解几万条时全量建 DOM 的压力 ──
        // plan 按 DFS 顺序（folder 头 / item 行），每批只渲染 _CHUNK 行；
        // 滚动接近底部时 _renderNextChunk 追加下一批，保持嵌套 .tree-indent 结构与全部交互不变。
        var _CHUNK = 400;
        var _plan = null;          // 当前批次的静态 plan（折叠/搜索变化时重建）
        var _renderedCount = 0;    // plan 中已渲染的条目数
        var _planStack = null;     // 跨批维持的缩进父块栈（depth + block）
        // 渲染代数：每次重建左栏/销毁自增。异步产物（视频封面）回来时比对它，判断
        // 「这一格还是不是当初那一格」——重建后旧格子已被摘出文档，往它身上挂图等于丢。
        // 不用 cell.parentNode 判定：格子的父节点是分组内的 .assets-grid，重建后它仍指向
        // 那个游离容器（parentNode 不为空），判据在真机同样失效。
        var _renderSeq = 0;

        function _planNode(node, depth, plan) {
            node.folders.forEach(function (f) {
                plan.push({ type: 'folder', folder: f, depth: depth });
                // 搜索态强制展开；折叠态不纳入子节点
                if (_searchQuery || !_collapsedSet[f.path]) {
                    _planNode(f, depth + 1, plan);
                }
            });
            node.items.forEach(function (it) {
                plan.push({ type: 'item', item: it, depth: depth });
            });
        }

        function _runPlanChunk(plan, start, end) {
            if (_viewMode === 'grid') { _runPlanChunkGrid(plan, start, end); return; }
            if (!_planStack) _planStack = [{ depth: -1, block: _treeContent }];
            var stack = _planStack;
            for (var i = start; i < end; i++) {
                var e = plan[i];
                // 弹出深度 >= 当前行的块，回到正确的父块
                while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
                var parentBlock = stack[stack.length - 1].block;
                if (e.type === 'folder') {
                    var head = _buildFolderHead(e.folder, e.depth);
                    parentBlock.appendChild(head);
                    var collapsed = !_searchQuery && !!_collapsedSet[e.folder.path];
                    if (!collapsed) {
                        var block = document.createElement('div');
                        block.className = 'tree-indent';
                        block.style.marginLeft = '12px';
                        parentBlock.appendChild(block);
                        stack.push({ depth: e.depth, block: block });
                    }
                } else {
                    parentBlock.appendChild(_renderRow(e.item, e.depth));
                }
            }
        }

        // ── 网格模式渲染 ──
        // 与树模式共用同一份 plan 与分块边界（_CHUNK / _renderNextChunk 不变），只把
        // 「嵌套缩进块」换成「分组容器 + 子层容器 + 格子流」。分组容器跨分块**不重建**——分块边界
        // 切在条目中间时后续块追加进同一容器（靠 _planStack 跨批保留，与树模式的 .tree-indent 栈同机制）。
        // 分组**真嵌套**（子分组挂进父分组的子层容器、不平铺到 _treeContent），且**一个文件夹
        // 只有一条缩进线**：子层容器同时装它的子分组与它自己的格子流，与列表模式每层一个
        // .tree-indent 同构。缩进线因此连续覆盖到文件夹根的素材——把缩进线画在子分组自己身上时，
        // 根级文件夹自己的格子落在任何缩进块之外，线到它就断（用户实测点出）。
        // 格子容器懒建（条目入栈后才有）：父文件夹自己的格子排在它的子文件夹分组之后，
        // 与列表模式的顺序一致（plan 里条目本就排在子文件夹之后），也不会被兄弟文件夹插队。
        function _childBox(group) {
            var b = document.createElement('div');
            b.className = 'assets-grid-children';
            group.appendChild(b);
            return b;
        }

        function _gridSlot(entry) {
            if (entry.grid) return entry.grid;
            var g = document.createElement('div');
            g.className = 'assets-grid';
            // 根级条目没有子层容器：直接落内容区（与列表模式一致——根级行不缩进、不成块）
            (entry.box || entry.group).appendChild(g);
            entry.grid = g;
            return g;
        }

        // 条目落位：弹到「自己所属的文件夹分组」——plan 里条目的 depth 是**所属文件夹 depth + 1**
        // （_planNode 用 node 的 depth 推条目），故弹掉 depth >= 自身 depth 的项后，栈顶正是
        // 该文件夹；根级条目（depth 0）弹到根容器。与列表模式同一条栈规则（那里条目也是落进
        // 上层 .tree-indent 块，与同深度文件夹头左对齐）。
        function _runPlanChunkGrid(plan, start, end) {
            if (!_planStack) _planStack = [{ depth: -1, group: _treeContent, grid: null }];
            var stack = _planStack;
            for (var i = start; i < end; i++) {
                var e = plan[i];
                while (stack.length && stack[stack.length - 1].depth >= e.depth) stack.pop();
                if (e.type === 'item') {
                    _gridSlot(stack[stack.length - 1]).appendChild(_renderCell(e.item, e.depth));
                    continue;
                }
                var group = document.createElement('div');
                group.className = 'assets-grid-group';
                group.appendChild(_buildFolderHead(e.folder, e.depth));
                // 挂进上层文件夹的**子层容器**（缩进块）——与列表模式的子层 .tree-indent 同位置；
                // 根层没有子层容器，直接挂内容区
                var upper = stack[stack.length - 1];
                (upper.box || upper.group).appendChild(group);
                // 折叠态：组头照出、格子区为空（_planNode 已跳过其子节点），故不入栈——
                // 后续条目落到上层容器
                var collapsed = !_searchQuery && !!_collapsedSet[e.folder.path];
                if (!collapsed) {
                    // 子层容器在组头之下（缩进线因此从组头下方起画）：文件夹头不缩进，
                    // 它的子分组与自己的格子共用一个缩进块
                    stack.push({ depth: e.depth, group: group, box: _childBox(group), grid: null });
                }
            }
        }

        // 网格格子：直接复用 _renderRow——同样的类名、data-id/data-folder 属性与全部事件接线，
        // 故多选 / 框选 / 右键 / 拖拽 / 搜索高亮 / missing 红字在网格下全部照旧可用。
        // 只加格子类并插入缩略图；缩略图缺失或加载失败 → 摘掉 has-thumb，图标块露出
        // （回落不需要 JS 分支，与详情区预览图同一协议）。
        // 网格视频格子的 hover 播放（视图侧用 itemThumb 返回 { videoUrl, movPath } 启用）。
        // **首次 hover 才建 video 元素**——不预建：几百个格子各挂一个 media player 太重。
        // 平时出的是静态封面（见 _attachGridCover，视图侧产出），拿不到封面才回落图标。
        // 移出即移除元素、回到封面/图标态；解码不了的（如 CEF 解不出的 HEVC mov）交给视图侧的
        // onThumbVideoUnplayable 走转码兜底——视图知道库与数据目录，本层不管编解码。
        //
        // 转码期间的状态文案（"转码中…"）走**覆盖层**：视图只报语义（什么时候真在转码、转完没），
        // 位置与生命周期归本层（首帧到位/移出/兜底失败都由本层收掉）。为什么是覆盖层而不是
        // 插一行文字（问题现象："hover 需要转码的视频播放前会闪一下，即使命中缓存……
        // 闪的一下好像是『转码中』，跟视频分辨率不一致导致图标会位移一下"）：
        //   ① 文案只在**真在转码**时才上（缓存命中的兜底是 exists 命中后直接换源，几十毫秒结束，
        //      那种等待不该出现任何中间态——上去一下就是闪）；
        //   ② 文案绝对定位满格（见 assets.css），显隐都不参与流式布局，格子和整行都不位移。
        function _attachGridVideoHover(cell, it, thumb) {
            var active = null;
            var hintEl = null;
            function _hideHint() {
                if (hintEl && hintEl.parentNode) hintEl.parentNode.removeChild(hintEl);
            }
            function _showHint(text) {
                if (!hintEl) {
                    hintEl = document.createElement('div');
                    hintEl.className = 'assets-grid-video-hint';
                }
                hintEl.textContent = text || '';
                if (!hintEl.parentNode) cell.appendChild(hintEl);
            }
            // 句柄绑在本次 hover 的 video 元素上：转码是异步的，移出后迟到的 show 不许再往格子里
            // 冒文案（格子里已经没有这次 hover 的元素了）
            function _hintHandle(v) {
                return {
                    show: function (text) { if (active === v) _showHint(text); },
                    hide: function () { if (active === v) _hideHint(); }
                };
            }
            function _stop() {
                if (active) {
                    try { active.pause(); } catch (_) {}
                    active.remove();
                    active = null;
                }
                _hideHint();
            }
            cell.addEventListener('mouseenter', function () {
                if (active) return;
                var v = document.createElement('video');
                // is-loading：视频先挂进格子但 display:none（不影响它加载与 loadeddata——实测
                // display:none 的视频照常解码、首帧事件照常来），静态封面/图标继续撑着格子
                v.className = 'assets-grid-video is-loading';
                v.muted = true;
                v.loop = true;
                v.setAttribute('muted', '');
                v.setAttribute('playsinline', '');
                v.setAttribute('preload', 'auto');
                v.src = thumb.videoUrl;
                var _unplayable = function () {
                    if (active !== v) return;   // 已移出/已换过元素：不再处理
                    _hideHint();                // 兜底重入（转码产物也解不出）：先收掉上一轮文案
                    if (_handlers.onThumbVideoUnplayable) {
                        _handlers.onThumbVideoUnplayable(v, it, thumb, _hintHandle(v));
                    }
                };
                v.addEventListener('error', _unplayable);
                v.addEventListener('loadedmetadata', function () {
                    if (v.videoWidth === 0) _unplayable();
                });
                // 首帧可播（loadeddata）才入场：摘掉 is-loading、加 has-video（封面与图标此行才退场）。
                // hover 即加 has-video 时——封面立刻隐藏，而那一刻 readyState 还是 0、首帧尚未解出，
                // 格子空一拍才出画面（实测空档 231→456ms，用户报"hover 播放会黑一下"）。
                v.addEventListener('loadeddata', function () {
                    if (active !== v) return;
                    _hideHint();   // 视频层接管画面，转码文案同时退场（换源前后的等待都盖在这句里）
                    if (v.classList) v.classList.remove('is-loading');
                    if (cell.classList) cell.classList.add('has-video');
                });
                cell.insertBefore(v, cell.firstChild);
                active = v;
                try {
                    var pr = v.play();
                    if (pr && typeof pr.catch === 'function') pr.catch(function () {});
                } catch (_) {}
            });
            cell.addEventListener('mouseleave', function () {
                _stop();
                if (cell.classList) cell.classList.remove('has-video');
            });
        }

        // 网格缩略图懒加载：img.loading='lazy' 在 CEF 88 实测不生效（视口外图片仍全部
        // 加载并解码，滚动经过序列帧首帧等大图时掉帧），改用 IntersectionObserver 手动
        // 控 src——格子进入视口（含 300px 预加载边距）才设图源；观察器不可用时回退立即加载。
        var _thumbIO = null;
        function _thumbObserver() {
            if (_thumbIO !== null) return _thumbIO;
            if (typeof global.IntersectionObserver !== 'function') { _thumbIO = false; return _thumbIO; }
            _thumbIO = new global.IntersectionObserver(function (entries) {
                for (var i = 0; i < entries.length; i++) {
                    var en = entries[i];
                    if (!en || !en.isIntersecting) continue;
                    var img = en.target;
                    _thumbIO.unobserve(img);
                    var src = img.dataset ? img.dataset.thumbSrc : '';
                    // isConnected 明确为 false（元素已被重建移除）才跳过；
                    // 旧 DOM shim 无该属性时按仍连接处理
                    if (src && img.isConnected !== false) img.src = src;
                }
            }, { root: _treeContent, rootMargin: '300px 0px' });
            return _thumbIO;
        }
        function _lazyThumbSrc(img, url) {
            if (!img || !url) return;
            var io = _thumbObserver();
            if (!io) { img.src = url; return; }
            if (img.dataset) img.dataset.thumbSrc = url;
            io.observe(img);
        }

        // 网格视频格子的静态封面（视图侧提供 videoCover 通道时启用）。封面由视图按需产出
        // ——本层不管解码与落盘（refs 库走 Bridge ffmpeg 抽第一帧，缓存到预览根，见
        // previewStore.ensureVideoCover），只负责「拿到了就换成图、拿不到就保持图标态」，
        // 与缩略图加载失败的回落同一口径（摘掉 has-thumb 即露出图标）。
        // 未提供通道（预设/工程素材库无视频）时整段不接线，格子保持原样。
        function _attachGridCover(cell, it, thumb) {
            if (!_handlers.videoCover) return;
            var img = document.createElement('img');
            img.className = 'assets-grid-thumb';
            img.alt = '';
            img.decoding = 'async';
            img.addEventListener('error', function () {
                if (cell.classList) cell.classList.remove('has-thumb');
            });
            cell.insertBefore(img, cell.firstChild);
            var gen = _renderSeq;
            var p;
            try { p = _handlers.videoCover(it, thumb); } catch (_) { p = null; }
            if (!p || typeof p.then !== 'function') return;
            p.then(function (url) {
                // 已重渲染/已销毁（代数变了）或没封面 → 保持图标态，不往旧节点挂图
                if (!url || gen !== _renderSeq) return;
                _lazyThumbSrc(img, url);
                if (cell.classList) cell.classList.add('has-thumb');
            }, function () {});
        }

        function _renderCell(it, depth) {
            var cell = _renderRow(it, depth);
            if (cell.classList) cell.classList.add('assets-grid-cell');
            // 列表行的行内 padding-left: 2px（给行首留位）在格子上是**不对称**内边距——左边 2px、
            // 右边吃 CSS 的 4px，内容整块被顶偏 1~2px（实测图标中心 179 vs 格子中心 181）。
            // 清掉行内值，让 CSS 的 `.assets-grid-cell { padding: 6px 4px }` 两侧对称生效。
            cell.style.paddingLeft = '';
            var thumb = _handlers.itemThumb ? _handlers.itemThumb(it) : null;
            if (thumb && thumb.videoUrl) {
                _attachGridVideoHover(cell, it, thumb);
                _attachGridCover(cell, it, thumb);
            } else if (thumb && thumb.url) {
                if (cell.classList) cell.classList.add('has-thumb');
                var img = document.createElement('img');
                img.className = 'assets-grid-thumb';
                img.alt = '';
                img.decoding = 'async';
                img.addEventListener('error', function () {
                    if (cell.classList) cell.classList.remove('has-thumb');
                });
                cell.insertBefore(img, cell.firstChild);
                var asyncThumb = thumb.asyncThumbUrl;
                if (asyncThumb && typeof asyncThumb.then === 'function') {
                    // 大图缩略图异步产出（序列帧首帧降采样）：生成期间不加载原图，
                    // 成功后按视口懒加载小图；失败回退原图
                    var gen = _renderSeq;
                    asyncThumb.then(function (u) {
                        if (gen !== _renderSeq || !img.parentNode) return;
                        _lazyThumbSrc(img, u || thumb.url);
                    }, function () {
                        if (gen !== _renderSeq || !img.parentNode) return;
                        _lazyThumbSrc(img, thumb.url);
                    });
                } else {
                    _lazyThumbSrc(img, thumb.url);
                }
            }
            return cell;
        }

        // autoContinue=false：恢复滚动位置的补渲染循环自己负责覆盖范围，不要再由"接近底部"
        //   条件自动续批——循环中 scrollTop 仍是旧值/中间值，条件会被误判成立，把一批 400 行
        //   排到 rAF 里，一帧后再追加（深滚动视口跳走的直接成因之一）。
        // skipRefresh=true：恢复期间跳过逐批 _refreshSelection（每次全量 querySelectorAll，
        //   深滚动补 20~50 批会在上万行上重复遍历）；由调用方在恢复完成后统一刷新一次。
        function _renderNextChunk(autoContinue, skipRefresh) {
            if (!_plan) return;
            var end = Math.min(_renderedCount + _CHUNK, _plan.length);
            _runPlanChunk(_plan, _renderedCount, end);
            _renderedCount = end;
            if (!skipRefresh) _refreshSelection();
            if (_renderedCount >= _plan.length) { _plan = null; _planStack = null; return; }
            if (autoContinue === false) return;
            var c = _treeContent;
            // 首批未填满视口时继续补，填满后交由 scroll 监听触发
            if (c.clientHeight > 0 && c.scrollTop + c.clientHeight >= c.scrollHeight - 120) {
                if (window.requestAnimationFrame) {
                    var gen = _renderSeq;   // 同 scroll 监听：重建后旧批次作废
                    window.requestAnimationFrame(function () {
                        if (gen === _renderSeq) _renderNextChunk();
                    });
                } else _renderNextChunk();
            }
        }

        function _refreshSelection() {
            var rows = left.querySelectorAll('.tree-row[data-id], .tree-row[data-folder]');
            for (var i = 0; i < rows.length; i++) {
                var r = rows[i];
                var selected;
                if (r.getAttribute('data-folder') != null) selected = !!_selectedFolderSet[r.getAttribute('data-folder')];
                else selected = !!_selectedSet[r.getAttribute('data-id')];
                if (selected) r.classList.add('selected');
                else r.classList.remove('selected');
            }
        }

        // 重建详情前停掉预览区里正在播放的媒体：video 从 DOM 移除不会自动暂停（详情自动播放后
        // 切换选中会留下后台解码/循环）。单条分支走 _handlers.renderDetail（各库自己实现），
        // 多选与文件夹分支直接写 innerHTML、不经过各库的 renderDetail，故停播统一放在这里。
        function _pauseRightMedia() {
            if (!right) return;
            var medias = right.querySelectorAll('video, audio');
            for (var i = 0; i < medias.length; i++) {
                try { medias[i].pause(); } catch (_) {}
            }
        }

        function _renderDetail() {
            if (_handlers.isEditing && _handlers.isEditing()) return;
            _pauseRightMedia();
            var folderPaths = Object.keys(_selectedFolderSet);
            // 文件夹选中优先：显示文件夹面板
            if (folderPaths.length) {
                _renderFolderDetail(folderPaths);
                return;
            }
            var count = _countSelected();
            // 多选时显示批量操作面板
            if (count > 1) {
                right.innerHTML = '<div class="assets-detail">' +
                    '<div class="assets-detail-preview">' +
                    '<div class="assets-detail-preview-icon">📄</div>' +
                    AEI18n.html('<div class="assets-detail-preview-name">已选中 ') + count + AEI18n.html(' 个素材</div>') +
                    AEI18n.html('<div class="assets-detail-preview-sub">右键菜单可批量操作</div>') +
                    '</div>' +
                    '</div>';
                return;
            }
            var it = null;
            for (var i = 0; i < _items.length; i++) { if (String(_items[i].id) === _selectedId) { it = _items[i]; break; } }
            right.innerHTML = _handlers.renderDetail(it);
        }

        // 文件夹选中面板：单选显示名称，多选显示批量提示
        function _renderFolderDetail(paths) {
            var name, sub;
            if (paths.length === 1) {
                var cleaned = String(paths[0]).replace(/^\/+|\/+$/g, '');
                name = cleaned.indexOf('/') >= 0 ? cleaned.slice(cleaned.lastIndexOf('/') + 1) : (cleaned || paths[0]);
                sub = AEI18n.t('文件夹 · 右键菜单可操作');
            } else {
                name = AEI18n.t('已选中 {n} 个文件夹', { n: paths.length });
                sub = AEI18n.t('右键菜单可批量操作');
            }
            right.innerHTML = '<div class="assets-detail">' +
                '<div class="assets-detail-preview">' +
                '<div class="assets-detail-preview-icon">📁</div>' +
                '<div class="assets-detail-preview-name">' + _esc(name) + '</div>' +
                '<div class="assets-detail-preview-sub">' + sub + '</div>' +
                '</div>' +
                '</div>';
        }

        // ── 搜索过滤 ──
        function _filterItems() {
            if (!_searchQuery) return _items;
            return _items.filter(function (it) {
                if (_fuzzyMatch(_searchQuery, _handlers.itemLabel(it))) return true;
                if (it.folder && _fuzzyMatch(_searchQuery, it.folder)) return true;
                return false;
            });
        }

        // ── 渲染入口 ──
        function render(items) {
            _selectedId = null;
            _clearItemSelection();
            _selectedFolderSet = {};
            _lastClickKey = '';
            _items = items || [];
            _editingId = null;
            _inlineNew = null;
            _invalidateTreeCache();   // 数据入口：即便调用方复用同一数组引用也强制重建树
            _renderLeftAndDetail();
        }
        function renderList(items) {
            _items = items || [];
            _invalidateTreeCache();   // 数据入口：同上
            // 收敛陈旧选中（素材级）：后台变更后条目可能已不在新列表（归档/清理等），
            // _selectedSet/_selectedId 需保持 ⊆ 列表（与 _applySearch 的收敛口径一致），
            // 否则编辑态保存会落到已消失的条目上报「条目不存在」。调用方传的是数据全量
            // （store.list()），故按 id 存在性收敛是安全的；文件夹选中不在此收敛：用户
            // 显式创建的空文件夹本就没有素材行，按素材列表收敛会误清（见 _applySearch 同款处理）。
            var present = {};
            for (var i = 0; i < _items.length; i++) present[String(_items[i].id)] = true;
            var sids = Object.keys(_selectedSet);
            for (var j = 0; j < sids.length; j++) {
                if (!present[sids[j]]) _removeItemSelection(sids[j]);
            }
            if (_selectedId && !present[String(_selectedId)]) {
                // 同步口径与行点击里 ctrl 取消选中一致（BUG 4b）：回落到选中集内最后选中项
                _selectedId = _selectedOrder.length ? _selectedOrder[_selectedOrder.length - 1] : null;
            }
            _renderLeftOnly(true);   // 保持滚动位置：编辑期间后台异步刷新不应把长列表拉回顶部
            _refreshSelection();
        }
        function refreshDetail() {
            if (_handlers.isEditing && _handlers.isEditing()) return;
            if (_editingId) return;  // 行内重命名中不重建详情
            if (_inlineNew) return;
            _renderDetail();
        }

        function _renderLeftAndDetail() {
            _renderLeftOnly();
            _renderDetail();
        }
        function _renderLeftOnly(keepScroll) {
            // 只重建树内容区，不动搜索栏和 footer
            if (!_treeContent.parentNode) {
                // 首次插入：找到 footer 之前的位置
                var footer = left.querySelector('.assets-tree-footer');
                if (footer) left.insertBefore(_treeContent, footer);
                else left.appendChild(_treeContent);
            }
            // 重建前保存滚动位置（renderList 路径传入 keepScroll），重建后补渲染覆盖并恢复
            var prevScrollTop = keepScroll ? _treeContent.scrollTop : 0;
            _treeContent.innerHTML = '';
            // 旧格子已从 DOM 移除：断开缩略图观察（观察器复用，新格子渲染时重新 observe）
            if (_thumbIO && _thumbIO !== false) _thumbIO.disconnect();
            // 清空内容后必须把 scrollTop 显式归零：CEF 88 里 innerHTML='' 之后如果没有同步
            // 布局，scrollTop 仍读得到旧值（如 30000），随后首次 _renderNextChunk 的
            // "scrollTop + clientHeight >= scrollHeight - 120" 判据会被误判成立，把一批 400 行
            // 排进 rAF——恢复滚动位置后一帧又追加一批、scrollHeight 二次增长，滚动锚定把视口
            // 推走（深滚动折叠/展开视口跳走的直接成因，实测同步正确、一帧后 +396px）。
            _treeContent.scrollTop = 0;
            // 轻量分页状态每次重建前统一复位：空态分支不渲染，也要清掉可能残留的旧 plan，
            // 避免已排队的 _renderNextChunk rAF 把旧 plan 渲染进已清空的容器。
            // （网格模式的格子容器由 _planStack 持有，同样随 plan 一起丢——留着旧引用会把
            // 下一批格子追加进 innerHTML='' 摘掉的游离节点，条目凭空消失）
            _plan = null; _planStack = null; _renderedCount = 0; _renderSeq++;
            var filtered = _filterItems();
            var extra = (_handlers.extraFolders && typeof _handlers.extraFolders === 'function') ? _handlers.extraFolders() : null;
            if (extra && _searchQuery) {
                extra = extra.filter(function (fp) { return _fuzzyMatch(_searchQuery, fp); });
            }

            if (!filtered.length && (!extra || !extra.length)) {
                var empty = document.createElement('div');
                empty.className = 'assets-empty-state';
                empty.innerHTML = '<div class="assets-empty-state-icon">📂</div>' +
                    AEI18n.html('<div class="assets-empty-state-text">暂无素材</div>') +
                    AEI18n.html('<div class="assets-empty-state-hint">点击上方按钮或拖入文件</div>');
                _treeContent.appendChild(empty);
                // 右面板覆写需过 isEditing 守卫（与 _renderDetail 对齐）：
                // 三个 view 编辑期间经 renderList 异步刷新时，正在编辑的右面板表单不能被空态覆写
                if (!_handlers.isEditing || !_handlers.isEditing()) {
                    // 空列表分支直接覆写右栏、不经过 _renderDetail 的停播入口：先停当前预览
                    // （video 播放 / 序列帧定时器），否则元素摘除后仍在后台解码
                    _pauseRightMedia();
                    right.innerHTML = AEI18n.html('<div class="assets-empty-state"><div class="assets-empty-state-icon">📄</div><div class="assets-empty-state-text">未选中</div></div>');
                }
            } else {
                var tree = _getTree(filtered, extra);
                // 轻量分页：把可见行 flatten 成 plan，先渲染首批，滚动到底再补
                // （_plan/_planStack/_renderedCount 已在函数开头复位）
                _plan = [];
                _planNode(tree, 0, _plan);
                // 首批不自动续批：需覆盖滚动位置时由下面的恢复循环负责补渲染；
                // scrollTop 为 0（首次渲染/搜索）时 400 行足够填满视口，与既有行为一致。
                _renderNextChunk(false);
            }
            // 恢复滚动位置：原位置超出首批渲染高度时继续补渲染直至覆盖，再恢复 scrollTop
            // （clamp 到新内容范围，数据变短不越界）。首次渲染/列表短于视口时
            // scrollTop 为 0，不进此分支，行为不变。
            // 补渲染循环传 (false, true)：
            //   · 不再触发"接近底部自动续批"——循环中 scrollTop 还是旧值/中间值，那个判据会被
            //     误判成立并把一批 400 行排进 rAF，恢复后一帧又追加一批，scrollHeight 二次增长，
            //     浏览器滚动锚定把视口推走（深滚动折叠/展开视口跳走的直接成因）
            //   · 逐批跳过 _refreshSelection，循环结束统一刷新一次
            if (prevScrollTop > 0 && _treeContent.clientHeight > 0) {
                var _restored = false;
                while (_plan && _treeContent.scrollHeight < prevScrollTop + _treeContent.clientHeight) {
                    _renderNextChunk(false, true);
                    _restored = true;
                }
                if (_restored) _refreshSelection();
                var maxScroll = Math.max(0, _treeContent.scrollHeight - _treeContent.clientHeight);
                _treeContent.scrollTop = Math.min(prevScrollTop, maxScroll);
            }
        }

        function select(id) {
            if (_editingId) return;
            if (_inlineNew) return;
            var sid = String(id);
            _selectedId = sid;
            _clearItemSelection();
            _addItemSelection(sid, false);
            _selectedFolderSet = {};
            _lastClickKey = _itemKey(sid);
            _refreshSelection();
            _renderDetail();
        }

        function getSelected() { return _selectedId; }
        function getSelectedFolders() { return Object.keys(_selectedFolderSet); }
        function getSelectedFoldersCount() { return Object.keys(_selectedFolderSet).length; }
        function _getSelectedIds() {
            // 按选中先后顺序返回（_selectedOrder 与 _selectedSet 同步维护）
            return _selectedOrder.slice();
        }
        function _countSelected() { return _getSelectedIds().length; }

        // ── 行内重命名 ──
        function _beginRename(id) {
            if (!_handlers.onRename) return;
            if (_inlineNew) _cancelNewItem();
            if (_editingId) _cancelRename();
            _editingId = String(id);
            var row = left.querySelector('.tree-row[data-id="' + CSSEscape(id) + '"]');
            if (!row) { _editingId = null; return; }
            var label = row.querySelector('.tree-row-label');
            if (!label) { _editingId = null; return; }
            // 取编辑名称
            var raw = null;
            for (var i = 0; i < _items.length; i++) {
                if (String(_items[i].id) === String(id)) { raw = _items[i]; break; }
            }
            var curName = '';
            if (raw && _handlers.nameForEdit) {
                curName = _handlers.nameForEdit(raw);
            } else if (raw) {
                curName = raw.name || '';
            } else {
                curName = label.textContent || '';
            }
            var input = document.createElement('input');
            input.className = 'assets-rename-input';
            input.value = curName;
            input.style.cssText = 'flex:1 1 auto;min-width:0;height:22px;font-size:12px;padding:0 4px;background:var(--input-bg);border:1px solid var(--accent);border-radius:3px;color:var(--text-main);';
            row.replaceChild(input, label);
            input.focus();
            input.select();

            var submitted = false;
            var submit = function () {
                if (submitted) return; submitted = true;
                var newName = input.value.trim();
                if (!newName) { _cancelRename(); return; }
                if (newName === curName) { _cancelRename(); return; }
                // 校验
                var nameBad = global.AEAssetsShared.invalidNameSeg(newName);
                if (nameBad) {
                    // V3 同款修法（对齐 agent/script-tree.js、shaderUI.js）：非法名不抢回焦点——
                    // blur→submit→focus() 会形成焦点陷阱（点击空白再次 blur，toast 刷屏死循环）；
                    // 复位 submitted 允许用户修正后再次 Enter 提交，输入框保留原地
                    if (global.AEToast) AEToast.warn(nameBad);
                    submitted = false;
                    return;
                }
                _handlers.onRename(id, newName).then(function () {
                    _editingId = null;
                }).catch(function (e) {
                    _editingId = null;
                    // 保持滚动位置：万级库在深处编辑失败时不得把视口拉回顶部
                    _renderLeftOnly(true); _refreshSelection();
                    if (global.AEToast) AEToast.error(AEI18n.t('重命名失败: ') + (e && e.message ? e.message : e));
                });
            };
            var cancel = function () { _cancelRename(); };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', function () {
                // V3 同款：blur（点击空白等）时非法名直接放弃编辑恢复原名，不抢回焦点形成陷阱
                if (global.AEAssetsShared.invalidNameSeg(input.value.trim())) { _cancelRename(); return; }
                if (!submitted) submit();
            });
        }

        function _cancelRename() {
            _editingId = null;
            // 保持滚动位置：取消/失败重命名同样只是重建可见行，数据未变
            _renderLeftOnly(true);
            _refreshSelection();
        }

        // ── 文件夹行内重命名 ──
        function _beginRenameFolder(folderPath) {
            if (!_handlers.onRenameFolder) return;
            if (_editingId) _cancelRename();
            if (_inlineNew) _cancelNewItem();
            _inlineNew = { folderRename: true };  // 阻断选中/详情重建，直至提交或取消
            var row = left.querySelector('.tree-row[data-folder="' + CSSEscape(folderPath) + '"]');
            if (!row) { _inlineNew = null; return; }
            var label = row.querySelector('.tree-row-label');
            if (!label) { _inlineNew = null; return; }
            // 缓存旧名称（取末段，folderPath 如 '/a/b'）
            var fp = String(folderPath || '').replace(/^\/+|\/+$/g, '');
            var curName = fp.indexOf('/') >= 0 ? fp.slice(fp.lastIndexOf('/') + 1) : fp;
            // 记录恢复所需信息：其他编辑入口（_beginRename/_beginNewItem）经 _cancelNewItem
            // 取消本编辑时，需移除输入框并恢复原 label，否则两个编辑器并存且守卫已失效
            _inlineNew.folderRow = row;
            _inlineNew.folderLabel = label;
            _inlineNew.folderCurName = curName;
            var input = document.createElement('input');
            input.className = 'assets-rename-input';
            input.value = curName;
            row.replaceChild(input, label);
            input.focus();
            input.select();

            var submitted = false;
            var submit = function () {
                if (submitted) return; submitted = true;
                var newName = input.value.trim();
                if (!newName) { _cancelRenameFolder(row, label, curName); return; }
                if (newName === curName) { _cancelRenameFolder(row, label, curName); return; }
                var nameBad = global.AEAssetsShared.invalidNameSeg(newName, true);
                if (nameBad) {
                    // V3 同款修法（对齐 agent/script-tree.js、shaderUI.js）：非法名不抢回焦点，
                    // 防 blur→submit→focus() 焦点陷阱；复位 submitted 允许修正后再次 Enter 提交
                    if (global.AEToast) AEToast.warn(nameBad);
                    submitted = false;
                    return;
                }
                _handlers.onRenameFolder(folderPath, newName).then(function () {
                    _inlineNew = null;
                    /* success — tree will be refreshed by view */
                }).catch(function (e) {
                    _cancelRenameFolder(row, label, curName);
                    if (global.AEToast) AEToast.error(AEI18n.t('重命名失败: ') + (e && e.message ? e.message : e));
                });
            };
            var cancel = function () { _cancelRenameFolder(row, label, curName); };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', function () {
                // V3 同款：blur（点击空白等）时非法名直接放弃编辑恢复原名，不抢回焦点形成陷阱
                if (global.AEAssetsShared.invalidNameSeg(input.value.trim(), true)) { _cancelRenameFolder(row, label, curName); return; }
                if (!submitted) submit();
            });
        }

        function _cancelRenameFolder(row, label, curName) {
            _inlineNew = null;
            if (row && label) {
                var input = row.querySelector('.assets-rename-input');
                if (input) { label.textContent = curName; row.replaceChild(label, input); }
            }
        }

        // ── 行内新建 ──
        function _beginNewItem(type, parentPath) {
            if (!_handlers.onNewItem) return;
            if (_inlineNew) _cancelNewItem();
            // 如果目标文件夹是折叠状态，先展开再插入行内输入框
            // （保持滚动位置：新建时视口要能看见刚插入的输入行，不能拉回顶部）
            if (parentPath && _collapsedSet[parentPath]) {
                delete _collapsedSet[parentPath];
                _renderLeftOnly(true);
            }
            var row = document.createElement('div');
            row.className = 'tree-inline-input-row';
            var icon = document.createElement('span');
            icon.className = 'tree-row-icon';
            icon.textContent = '📁';
            row.appendChild(icon);
            var input = document.createElement('input');
            input.placeholder = type === 'folder' ? AEI18n.t('文件夹名称…') : AEI18n.t('名称…');
            row.appendChild(input);
            var hint = document.createElement('span');
            hint.className = 'tree-inline-input-hint';
            hint.textContent = 'Enter ↵';
            row.appendChild(hint);
            _inlineNew = { type: type, parentPath: parentPath, input: input, row: row };

            var targetParent = _treeContent;
            var beforeNode = targetParent.firstChild;
            if (parentPath) {
                var folderRow = _treeContent.querySelector('.tree-row[data-folder="' + CSSEscape(parentPath) + '"]');
                if (folderRow) {
                    var block = folderRow.nextElementSibling;
                    if (block && block.classList.contains('tree-indent')) {
                        targetParent = block;
                        beforeNode = block.firstChild;
                    } else if (block && (block.classList.contains('assets-grid')
                        || block.classList.contains('assets-grid-group')
                        || block.classList.contains('assets-grid-children'))) {
                        // 网格模式没有 .tree-indent 块（结构是「组头 + 子层容器（子分组… + 自己的格子流）」）：
                        // 一律插在组头**紧跟其后**的位置——落到组头上面会读成"这个文件夹之前"。
                        // 组头的下一个兄弟是子层容器（缩进块），故这里按「组头的下一个兄弟」定位，
                        // 不假定它装的是子分组还是格子流。
                        targetParent = folderRow.parentNode;
                        beforeNode = block;
                    } else {
                        targetParent = folderRow.parentNode;
                        beforeNode = targetParent.firstChild;
                    }
                }
            }
            targetParent.insertBefore(row, beforeNode);
            input.focus();

            var submitted = false;
            var submit = function () {
                if (submitted) return; submitted = true;
                var name = input.value.trim();
                if (!name) { _cancelNewItem(); return; }
                var nameBad = global.AEAssetsShared.invalidNameSeg(name);
                if (nameBad) { _cancelNewItem(); if (global.AEToast) AEToast.warn(nameBad); return; }
                var mySession = _inlineNew;   // 本会话快照：拒绝回调只清理本会话，不动后续新会话
                _handlers.onNewItem(type, parentPath, name).then(function () {
                    _inlineNew = null;
                }).catch(function (e) {
                    // 创建失败同样移除行内输入行（对齐 _cancelNewItem）：守卫失效后残留行无功能
                    // row 为闭包捕获的本行引用；仅当 _inlineNew 仍是本会话（未被新会话替换）时才清守卫
                    row.remove();
                    if (_inlineNew === mySession) _inlineNew = null;
                    if (global.AEToast) AEToast.error(AEI18n.t('创建失败: ') + (e && e.message ? e.message : e));
                });
            };
            var cancel = function () { _cancelNewItem(); };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); submit(); }
                else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
            });
            input.addEventListener('blur', function () {
                if (!submitted) submit();
            });
        }

        function _cancelNewItem() {
            // 文件夹重命名（_beginRenameFolder 存 {folderRename:true}，无新建行 row）：
            // 复用 _cancelRenameFolder 移除输入框并恢复原 label
            if (_inlineNew && _inlineNew.folderRename) {
                _cancelRenameFolder(_inlineNew.folderRow, _inlineNew.folderLabel, _inlineNew.folderCurName);
                _inlineNew = null;
                return;
            }
            if (_inlineNew && _inlineNew.row) _inlineNew.row.remove();
            _inlineNew = null;
        }

        // ── 拖拽插入指示（在 dragover 中处理）──
        // 由 opts.onDragOver 回调内部设置 .drag-insert-before/after 类
        // treeView 只提供基础类，具体逻辑在 folderViewMixin 和各 view 中

        function destroy() {
            _selectedId = null; _clearItemSelection(); _selectedFolderSet = {}; _lastClickKey = '';
            if (_onLeftClick) left.removeEventListener('click', _onLeftClick);
            if (_onLeftContextmenu) left.removeEventListener('contextmenu', _onLeftContextmenu);
            if (_rubberCleanup) _rubberCleanup();
            if (_splitDragMove) {
                document.removeEventListener('mousemove', _splitDragMove);
                // 拖拽中途被 destroy 会导致 body 样式残留，必须恢复
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
            if (_splitDragUp) {
                document.removeEventListener('mouseup', _splitDragUp);
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
            }
            if (_thumbIO && _thumbIO !== false) { try { _thumbIO.disconnect(); } catch (_) {} _thumbIO = null; }
            container.innerHTML = ''; _items = []; _editingId = null; _inlineNew = null;
            _plan = null; _planStack = null; _renderedCount = 0; _renderSeq++;
            _invalidateTreeCache();
        }

        // ── 事件委托 / 空白区 drop ──
        if (_handlers.onDragOver) {
            _treeContent.addEventListener('dragover', function (e) {
                if (!e.target.closest('.tree-row')) {
                    _handlers.onDragOver(null, e, '');
                }
            });
        }
        if (_handlers.onDrop) {
            _treeContent.addEventListener('drop', function (e) {
                if (!e.target.closest('.tree-row')) {
                    _handlers.onDrop(null, '', e);
                }
            });
        }
        _onLeftContextmenu = function (e) {
            e.preventDefault();
            if (!e.target.closest('.tree-row') && _handlers.onBlankContextmenu) {
                _handlers.onBlankContextmenu(e.clientX, e.clientY);
            }
        };
        left.addEventListener('contextmenu', _onLeftContextmenu);
        // 行末操作按钮点击
        _onLeftClick = function (e) {
            var wasRubber = _rubberDragged;
            _rubberDragged = false;
            var btn = e.target.closest('.assets-row-act');
            if (btn && _handlers.onDetailAction) {
                e.stopPropagation();
                _handlers.onDetailAction(btn.getAttribute('data-act'), btn.getAttribute('data-id'), btn);
                return;
            }
            // 框选拖拽后不触发取消选中
            if (wasRubber) return;
            // 点击空白处取消选中（排除搜索栏和 footer）
            if (!e.target.closest('.tree-row') && !e.target.closest('.assets-search-wrap') && !e.target.closest('.assets-tree-footer')) {
                _selectedId = null;
                _clearItemSelection();
                _selectedFolderSet = {};
                _lastClickKey = '';
                _refreshSelection();
                _renderDetail();
                // 通知 view 取消选中，使 _selectGen 等异步守卫失效
                _handlers.onSelect(null);
            }
        };
        left.addEventListener('click', _onLeftClick);

        // ── 框选（rubber-band selection）──
        var _rubberDragged = false;
        var _rubberBand = null;
        var _rubberCleanup = null;
        (function _bindRubberBand() {
            var band = document.createElement('div');
            _rubberBand = band;
            band.className = 'assets-rubber-band';
            band.style.cssText = 'display:none;position:fixed;border:1px solid rgba(251,191,36,.45);background:rgba(251,191,36,.05);z-index:100;pointer-events:none;';
            document.body.appendChild(band);
            var sx, sy, dragging;
            var _rubberSelectStart = function (e) { e.preventDefault(); };
            _treeContent.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                if (e.target.closest('.tree-row')) return;
                if (e.target.closest('.tree-inline-input-row')) return;
                e.preventDefault();
                sx = e.clientX; sy = e.clientY;
                dragging = true;
                document.body.style.userSelect = 'none';
                document.addEventListener('selectstart', _rubberSelectStart);
            });
            var onMouseMove = function (e) {
                if (!dragging) return;
                if (Math.abs(e.clientX - sx) < 4 && Math.abs(e.clientY - sy) < 4) return;
                _rubberDragged = true;
                band.style.display = '';
                band.style.left = Math.min(sx, e.clientX) + 'px';
                band.style.top = Math.min(sy, e.clientY) + 'px';
                band.style.width = Math.abs(e.clientX - sx) + 'px';
                band.style.height = Math.abs(e.clientY - sy) + 'px';
            };
            document.addEventListener('mousemove', onMouseMove);
            var onMouseUp = function (e) {
                if (!dragging) return;
                dragging = false;
                document.body.style.userSelect = '';
                document.removeEventListener('selectstart', _rubberSelectStart);
                band.style.display = 'none';
                if (!_rubberDragged) return;
                var x1 = Math.min(sx, e.clientX), x2 = Math.max(sx, e.clientX);
                var y1 = Math.min(sy, e.clientY), y2 = Math.max(sy, e.clientY);
                var hitKeys = [];
                var rows = _treeContent.querySelectorAll('.tree-row[data-id], .tree-row[data-folder]');
                for (var i = 0; i < rows.length; i++) {
                    var r = rows[i].getBoundingClientRect();
                    if (r.right > x1 && r.left < x2 && r.bottom > y1 && r.top < y2) {
                        if (rows[i].getAttribute('data-folder') != null) hitKeys.push({ key: _folderKey(rows[i].getAttribute('data-folder')), type: 'folder' });
                        else hitKeys.push({ key: _itemKey(String(rows[i].getAttribute('data-id'))), type: 'item' });
                    }
                }
                if (hitKeys.length) {
                    if (!(e.ctrlKey || e.metaKey)) { _clearItemSelection(); _selectedFolderSet = {}; }
                    for (var j = 0; j < hitKeys.length; j++) {
                        if (hitKeys[j].type === 'folder') _selectFolderMutex(hitKeys[j].key.slice(3));
                        else _selectItemMutex(hitKeys[j].key.slice(3));
                    }
                    var lastKey = hitKeys[hitKeys.length - 1];
                    _selectedId = lastKey.type === 'folder' ? null : lastKey.key.slice(3);
                    _lastClickKey = lastKey.key;
                    _refreshSelection();
                    _renderDetail();
                    if (hitKeys.length === 1) _handlers.onSelect(_selectedId);
                }
            };
            document.addEventListener('mouseup', onMouseUp);
            _rubberCleanup = function () {
                document.body.style.userSelect = '';
                document.removeEventListener('selectstart', _rubberSelectStart);
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (_rubberBand && _rubberBand.parentNode) _rubberBand.parentNode.removeChild(_rubberBand);
                _rubberBand = null;
            };
        })();

        return {
            render: render, renderList: renderList, select: select, getSelected: getSelected,
            getSelectedIds: _getSelectedIds, getSelectedCount: _countSelected,
            getSelectedFolders: getSelectedFolders, getSelectedFoldersCount: getSelectedFoldersCount,
            refreshDetail: refreshDetail, destroy: destroy,
            beginRename: _beginRename,
            beginRenameFolder: _beginRenameFolder,
            beginNewItem: _beginNewItem,
            cancelNewItem: _cancelNewItem,
            // 视图模式：'tree'（列表树，默认）/ 'grid'（大图标网格）
            setViewMode: setViewMode,
            getViewMode: getViewMode,
            getGridCellSize: getGridCellSize,
            isEditing: function () { return !!_editingId || !!_inlineNew; }
        };
    }

    // ── 名称/文件夹路径安全校验 ──
    // folderOnly=true：文件夹名额外拒绝系统保留目录名——归档区/垃圾区由系统管理，
    // 用户建出同名目录会与系统目录物理同路径（预设库是实体目录），或留下树上无法操作的虚拟文件夹。
    // 条目名不适用（`___archive__.ffx` 这类文件名与目录不冲突，误拒会挡住合法素材）。
    function invalidNameSeg(name, folderOnly) {
        if (name == null) return AEI18n.t('名称为空');
        var s = String(name);
        if (!s) return AEI18n.t('名称为空');
        if (s.indexOf('%') !== -1) return AEI18n.t('名称不能含 %');
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F) return AEI18n.t('名称不能含控制字符');
            if (c === 0x22 || c === 0x27) return AEI18n.t('名称不能含引号 " \'');
        }
        if (/[\/\\$]/.test(s)) return AEI18n.t('名称不能含 / \\ $');
        // Windows 文件名非法字符（对齐 memoryStore._validateName 的 [\:\*\?\"\<\>\|]；
        // 引号已在上面控制字符检查中拦截）——不拒合法中文名与空格
        if (/[:*?<>|]/.test(s)) return AEI18n.t('名称不能含 Windows 非法字符 : * ? < > |');
        if (s === '.' || s === '..') return AEI18n.t('名称不能为 . 或 ..');
        // Windows 尾随点/空格——Win32 落盘时被静默剥离（"a." → 磁盘上实为 "a"），
        // 实体重命名后磁盘名与索引脱节；校验须在入口拦下（内部点/空格不拦，不误伤 "a b.png"）
        var lastCh = s.charAt(s.length - 1);
        if (lastCh === '.' || lastCh === ' ') return AEI18n.t('名称不能以点或空格结尾');
        var upper = s.replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
            /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return AEI18n.t('名称不能是 DOS 设备名');
        if (folderOnly) {
            var AR = (global.AEAssetsShared && global.AEAssetsShared.ARCHIVE_DIR_NAME) || '___archive__';
            if (s === AR) return AEI18n.t('名称不能使用系统保留目录「{name}」（归档区由归档/恢复管理）', { name: AR });
            if (s.indexOf('___trash__') === 0) return AEI18n.t('名称不能使用系统保留目录「___trash__」（垃圾区）');
        }
        return null;
    }

    function invalidFolderPath(folder) {
        if (folder == null) return null;
        var s = String(folder);
        if (!s) return null;
        var segs = s.replace(/^\/+|\/+$/g, '').split('/').filter(function (x) { return x !== ''; });
        for (var i = 0; i < segs.length; i++) {
            var r = invalidNameSeg(segs[i], true);   // 路径段都是文件夹名 → 走文件夹口径
            if (r) return r;
        }
        return null;
    }

    // CSS.escape polyfill（Chrome 88 无 CSS.escape）
    function CSSEscape(s) {
        var str = String(s);
        return str.replace(/[^\w-]/g, function (ch) {
            var code = ch.charCodeAt(0);
            if (code === 0) return '�';
            return '\\' + code.toString(16) + ' ';
        });
    }

    function _esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── 从拖入文件列表提取文件夹层级 ──
    function deriveFolderMap(files) {
        var paths = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var p = f.webkitRelativePath || f.path || '';
            if (p && !f.webkitRelativePath) p = p.replace(/\\/g, '/');
            paths.push({ idx: i, path: p, name: f.name, isFolderDrag: !!f.webkitRelativePath });
        }
        // 找公共父目录
        var common = '';
        if (paths.length > 1) {
            var segs = paths[0].path.replace(/\/[^\/]+$/, '').split('/');
            for (var s = 0; s < segs.length; s++) {
                var prefix = segs.slice(0, s + 1).join('/') + '/';
                var ok = true;
                for (var j = 1; j < paths.length; j++) {
                    if (paths[j].path.indexOf(prefix) !== 0) { ok = false; break; }
                }
                if (ok) common = prefix;
                else break;
            }
        }
        // 文件夹拖拽（webkitRelativePath 存在）：common 就是被拖文件夹名，不能 strip 掉；
        // 把 common 限定在第一段（文件夹名），让内部子目录挂在文件夹名下面而非根级
        var rootFolderName = '';
        var isFolderDrag = false;
        for (var kd = 0; kd < paths.length; kd++) {
            if (paths[kd].isFolderDrag) { isFolderDrag = true; break; }
        }
        if (isFolderDrag) {
            rootFolderName = (common || paths[0].path).replace(/\/+$/, '').split('/')[0];
            if (rootFolderName) {
                common = rootFolderName + '/';
            }
        }
        var fileFolders = [];
        var folders = {};
        for (var k = 0; k < paths.length; k++) {
            var rel = paths[k].path;
            if (common && rel.indexOf(common) === 0) {
                rel = rel.slice(common.length);
            } else {
                var m = rel.match(/^(.*\/)([^\/]+)$/);
                rel = m ? m[2] : rel;
            }
            var lastSlash = rel.lastIndexOf('/');
            var fp = lastSlash > 0 ? rel.slice(0, lastSlash).replace(/^\/+|\/+$/g, '') : '';
            // 文件夹拖拽：把被拖的文件夹名作为 prefix 加回去
            if (rootFolderName) {
                fp = fp ? rootFolderName + '/' + fp : rootFolderName;
            }
            fileFolders[paths[k].idx] = fp;
            if (fp) {
                var parts = fp.split('/');
                var acc = '';
                for (var p = 0; p < parts.length; p++) {
                    acc = acc ? acc + '/' + parts[p] : parts[p];
                    folders[acc] = true;
                }
            }
        }
        return { fileFolders: fileFolders, folders: Object.keys(folders), common: common, paths: paths };
    }

    global.AEAssetsShared.deriveFolderMap = deriveFolderMap;
    global.AEAssetsShared.buildFolderTree = buildFolderTree;
    global.AEAssetsShared.createTreeView = createTreeView;
    global.AEAssetsShared.invalidNameSeg = invalidNameSeg;
    global.AEAssetsShared.invalidFolderPath = invalidFolderPath;

    // 共享右键菜单 helper
    function showAssetsMenu(x, y, items, onAction) {
        var old = document.querySelector('.assets-context-menu');
        if (old) old.remove();
        if (!items || !items.length) return;
        var menu = document.createElement('div');
        menu.className = 'assets-context-menu';
        menu.style.cssText = 'position:fixed;z-index:10000;background:var(--surface-2);border:1px solid var(--border);border-radius:4px;box-shadow:0 4px 12px rgba(0,0,0,.4);padding:4px 0;';
        items.forEach(function (it) {
            var item = document.createElement('div');
            item.className = 'assets-context-item' + (it.danger ? ' danger' : '');
            item.textContent = it.label;
            item.addEventListener('click', function (e) { e.stopPropagation(); menu.remove(); document.removeEventListener('click', close); onAction(it.action); });
            menu.appendChild(item);
        });
        document.body.appendChild(menu);
        menu.style.left = Math.min(x, window.innerWidth - menu.offsetWidth - 4) + 'px';
        menu.style.top = Math.min(y, window.innerHeight - menu.offsetHeight - 4) + 'px';
        var close = function (e) { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close); } };
        setTimeout(function () { document.addEventListener('click', close); }, 0);
    }
    global.AEAssetsShared.showAssetsMenu = showAssetsMenu;
})(window);
