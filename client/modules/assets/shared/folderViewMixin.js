(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    var NOTICE_THRESHOLD = 20;   // 批量移动超此数量才显示进度条（少量静默处理）

    // 列表加载遮罩：加载期间覆盖列表的暗底 + 居中转圈（无文字）。
    // 延迟挂载：加载极快（小库）时遮罩在渲染前即被跳过，视觉上完全不会出现。
    // 返回 handle { hide() }。
    function createLoadingOverlay(containerEl) {
        var ov = document.createElement('div');
        ov.className = 'assets-loading-overlay';
        var spin = document.createElement('div');
        spin.className = 'assets-loading-spinner';
        ov.appendChild(spin);
        var mounted = false;
        // 80ms 宽限：短促加载（少于约30条的小库）已结束的话，遮罩根本不会挂载
        var timer = setTimeout(function () {
            mounted = true;
            // 转圈定位到「素材列表」区（左侧树），而非整个树+详情区域
            var target = containerEl.querySelector('.assets-tree-left') || containerEl;
            target.appendChild(ov);
        }, 80);
        var hidden = false;
        return {
            hide: function () {
                if (hidden) return;
                hidden = true;
                clearTimeout(timer);
                if (mounted && ov.parentNode) ov.parentNode.removeChild(ov);
            }
        };
    }

    // ──  链接条目显式提示 ──
    // 语义背景：bridge 的 delete/rmdir/remove-dir-recursive/rename 一律作用于 resolveRealSafe
    // 消解后的真实目标（realpath）——条目本身是 symlink/junction 时，删除/重命名会改到
    // "真实目标"并留下悬挂链接（空 junction 的 rmdir 会删目标目录）。操作语义不改
    // （取向①②未采纳），但动手前必须让用户看到这条事实（显式确认；取消 → 什么都不做）。
    // 探测走 AEFS.isLinkAsync（bridge /fs/is-link，只读）：探测不可用/通道失败/旧版 bridge
    // 一律按「不是链接」放行——提示通道故障不阻断既有删除/重命名流程（fail-open，行为与
    // 本次改动前逐字一致）。非链接条目不弹框、流程与文案不变。
    // entries: [{ path, label }]（path = 物理路径；label = 给用户看的条目名/路径）
    // 返回 Promise<boolean>：true = 继续（无链接 / 用户确认继续）；false = 用户取消。
    function confirmLinkTargets(AEFS, entries) {
        if (!AEFS || typeof AEFS.isLinkAsync !== 'function') return Promise.resolve(true);
        var list = (entries || []).filter(function (en) { return en && en.path; });
        if (!list.length) return Promise.resolve(true);
        var probes = list.map(function (en) {
            return Promise.resolve(AEFS.isLinkAsync(en.path)).then(function (r) {
                if (r && r.isLink) {
                    return { label: en.label || en.path, realpath: r.realpath || AEI18n.t('（真实路径解析失败）') };
                }
                return null;
            }, function () { return null; });
        });
        return Promise.all(probes).then(function (hits) {
            var links = hits.filter(function (x) { return !!x; });
            if (!links.length) return true;
            var body;
            var linkTail = AEI18n.t('\n（删除将删除真实目标并留下悬挂链接；重命名同理）');
            if (links.length === 1) {
                body = AEI18n.t('条目「{label}」是链接（symlink/junction），继续将作用于其真实目标：\n', { label: links[0].label })
                    + links[0].realpath
                    + linkTail;
            } else {
                body = AEI18n.t('以下 {n} 个条目本身是链接（symlink/junction），继续将作用于其真实目标：\n', { n: links.length })
                    + links.map(function (x) { return '「' + x.label + '」→ ' + x.realpath; }).join('\n')
                    + linkTail;
            }
            // 无确认通道（异常环境）按放行：与探测失败同口径，不改既有流程
            if (typeof global.showConfirm !== 'function') return true;
            return global.showConfirm(AEI18n.t('链接条目确认'), body + AEI18n.t('\n\n是否继续？'), 'danger').then(function (ok) { return !!ok; });
        });
    }

    // opts: {
    //   store,            // 需有 createFolder / renameFolder / removeFolder / listEmptyFolders / move
    //   refresh,          // function() — 刷新树
    //   confirmMsg: { folderDeleteBody: function(folderPath) → string },
    //   renderItemContextmenu: function(item, x, y) — optional, view 自定义条目右键菜单
    //   beginNewItem: function(type, parentPath) — optional, treeView 行内新建
    //   beginRenameFolder: function(folderPath) — optional, treeView 行内重命名文件夹
    // }
    function createFolderViewHelpers(opts) {
        opts = opts || {};
        var _store = opts.store;
        var _refresh = opts.refresh || function () {};
        var _confirmMsg = opts.confirmMsg || {};
        var _renderItemCtx = opts.renderItemContextmenu || null;
        var _beginNewItem = opts.beginNewItem || null;
        var _beginRenameFolder = opts.beginRenameFolder || null;
        var _importFolderToAE = opts.importFolderToAE || null;
        var _busy = false;

        function _warnBusy() { if (global.AEToast) AEToast.warn(AEI18n.t('正在执行操作，请等待')); }

        function _norm(f) { return String(f || '').replace(/^\/+|\/+$/g, ''); }

        // 后置注入：treeView 引用（用于读取多选文件夹）
        var _tv = null;
        function setTreeView(tv) { _tv = tv; }

        // ──  链接条目守卫 ──
        // 删除/重命名作用于 realpath 目标：条目本身是 symlink/junction 时必须先显式提示
        // （确认文案见 confirmLinkTargets）。entries 命中链接 → 用户确认后才执行 fn；
        // 取消 → 不执行 fn（什么都不做），resolve false。无链接/探不到（fail-open）→ 直接执行 fn。
        // 返回 fn 的结果；取消时返回 false（调用方按 `go === false` 区分取消）。
        function _withLinkGuard(entries, fn) {
            return Promise.resolve(global.AEAssetsShared.confirmLinkTargets(global.AEFS, entries)).then(function (go) {
                if (!go) return false;
                return fn();
            });
        }

        // 文件夹条目在磁盘上的物理路径（探测"条目本身是链接"用）。store 未暴露 getBaseDir
        // （纯虚拟库）时返回 null → 跳过探测（fail-open，不改既有流程）。
        function _folderPhysPath(fp) {
            if (!_store || typeof _store.getBaseDir !== 'function') return null;
            var base = String(_store.getBaseDir() || '').replace(/\\/g, '/').replace(/\/+$/, '');
            if (!base) return null;
            var rel = _norm(fp);
            return rel ? (base + '/' + rel) : base;
        }

        function _folderLinkEntries(paths) {
            var out = [];
            for (var i = 0; i < paths.length; i++) {
                var p = _folderPhysPath(paths[i]);
                if (p) out.push({ path: p, label: _norm(paths[i]) || AEI18n.t('（根）') });
            }
            return out;
        }

        // ── 文件夹管理函数 ──

        function _newFolder(parentPath) {
            if (_busy) { _warnBusy(); return; }
            // 优先使用行内编辑
            if (_beginNewItem) {
                _beginNewItem('folder', parentPath || '');
                return;
            }
            // fallback: showPrompt 模态框
            var parent = parentPath || '';
            var hint = parent ? AEI18n.t('在「{parent}」下新建文件夹', { parent: parent }) : AEI18n.t('新建文件夹');
            _busy = true;
            global.showPrompt(hint, '').then(function (name) {
                if (!name) { _busy = false; return; }
                var bad = global.AEAssetsShared.invalidNameSeg(name, true);
                if (bad) { _busy = false; if (global.AEToast) AEToast.warn(bad); return; }
                var fullPath = parent ? (parent + '/' + name) : name;
                _store.createFolder(fullPath).then(function (ok) {
                    _busy = false;
                    if (ok) {
                        _refresh();
                        if (global.AEToast) AEToast.success(AEI18n.t('文件夹已创建: ') + fullPath);
                    } else {
                        if (global.AEToast) AEToast.error(AEI18n.t('创建文件夹失败'));
                    }
                }).catch(function () { _busy = false; if (global.AEToast) AEToast.error(AEI18n.t('创建文件夹失败')); });
            });
        }

        // 目标路径是否已被占用（判据抽共用的 扩展）：
        //   ① 空文件夹清单命中 —— 原既有检查；
        //   ② 索引中以 dst 为前缀的 folder（dst 本身或 dst/ 子层）—— 非空同名目标。
        // 单条移动（_moveFolder）与批量移动（_moveFolders）必须共用本判据：两条路径各写一份
        // 曾使批量漏掉 ②，预设库跨父移动走 copyFile 分支把同名目标静默 _1 改名合并
        //（presetStore.renameFoldersBatch），用户看到"已移动 N 个文件夹"但条目已被改名。
        function _targetOccupied(dst) {
            var d = _norm(dst);
            if (!d) return false;
            if (_store && typeof _store.listEmptyFolders === 'function') {
                var empties = _store.listEmptyFolders() || [];
                if (empties.indexOf(d) !== -1) return true;
            }
            if (typeof _store.list === 'function') {
                var entries = _store.list() || [];
                for (var i = 0; i < entries.length; i++) {
                    var mf = String((entries[i] && entries[i].folder) || '');
                    if (mf === d || mf.indexOf(d + '/') === 0) return true;
                }
            }
            return false;
        }

        function _moveFolder(srcFolder, targetFolder) {
            if (_busy) { _warnBusy(); return; }
            var src = String(srcFolder || '').replace(/^\/+|\/+$/g, '');
            if (!src) return;
            var name = src.indexOf('/') >= 0 ? src.slice(src.lastIndexOf('/') + 1) : src;
            var dst = targetFolder ? (targetFolder + '/' + name) : name;
            dst = String(dst).replace(/^\/+|\/+$/g, '');  // 归一化：targetFolder 可能来自树节点路径（带前导 /）
            if (dst === src) return;
            // 防拖入自身后代：src='a', dst='a/b/a' → dst.indexOf(src+'/')===0
            if (dst.indexOf(src + '/') === 0) {
                if (global.AEToast) AEToast.warn(AEI18n.t('不能将文件夹移动到自身或其子文件夹'));
                return;
            }
            // 空/非空同名目标一律拒绝——原检查只查空文件夹，非空时 refStore 静默合并、
            // presetStore dedup 静默 _1 改名，磁盘名/索引脱节且无任何提示。
            // 判据抽到 _targetOccupied，与批量移动共用同一份。
            if (_targetOccupied(dst)) {
                if (global.AEToast) AEToast.warn(AEI18n.t('目标位置已有同名文件夹'));
                return;
            }
            _busy = true;
            _store.renameFolder(src, dst).then(function () { _busy = false; _refresh(); })
                .catch(function (e) { _busy = false; if (global.AEToast) AEToast.error(AEI18n.t('移动文件夹失败: ') + (e && e.message ? e.message : e)); });
        }

        function _renameFolderPrompt(folderPath) {
            if (_busy) { _warnBusy(); return; }
            // 优先使用行内编辑
            if (_beginRenameFolder) {
                _beginRenameFolder(folderPath);
                return;
            }
            // fallback: showPrompt 模态框
            _busy = true;
            var fp = String(folderPath || '').replace(/^\/+|\/+$/g, '');
            var displayName = fp.indexOf('/') >= 0 ? fp.slice(fp.lastIndexOf('/') + 1) : fp;
            global.showPrompt(AEI18n.t('重命名文件夹'), displayName).then(function (newName) {
                if (!newName) { _busy = false; return; }
                var bad = global.AEAssetsShared.invalidNameSeg(newName, true);
                if (bad) { _busy = false; if (global.AEToast) AEToast.warn(bad); return; }
                var slashIdx = fp.lastIndexOf('/');
                var newPath = slashIdx >= 0 ? fp.slice(0, slashIdx + 1) + newName : newName;
                // 文件夹本身是链接时先显式提示（重命名作用于真实目标、留悬挂链接）；
                // 用户取消 → 什么都不做。同名（newPath===fp）是无操作，不探测不弹。
                var _ents = (newPath !== fp) ? _folderLinkEntries([fp]) : [];
                _withLinkGuard(_ents, function () {
                    _store.renameFolder(fp, newPath).then(function () { _busy = false; _refresh(); })
                        .catch(function (e) { _busy = false; if (global.AEToast) AEToast.error(AEI18n.t('重命名失败: ') + (e && e.message ? e.message : e)); });
                }).then(function (go) { if (go === false) _busy = false; });
            });
        }

        // 归档文件夹（原「删除文件夹」）：整体移入归档区，7 天后自动清理（期间可恢复）
        function _archiveFolderPrompt(folderPath) {
            if (_busy) { _warnBusy(); return; }
            _busy = true;
            // 删除=归档：文件夹整体移入归档区，7 天后自动清理（期间可恢复）
            var count = _folderItemCount(folderPath);
            var body = AEI18n.t('确定归档文件夹「{path}」？', { path: folderPath })
                + (count > 0 ? AEI18n.t('含子文件夹共 {n} 条将移入归档区，', { n: count }) : '')
                + AEI18n.t('7 天后自动清理（期间可在「归档区」面板恢复）。');
            // 文件夹本身是链接时先显式提示（归档=物理搬移，作用于真实目标）；取消 → 什么都不做
            _withLinkGuard(_folderLinkEntries([folderPath]), function () {
                _archiveFolderConfirmed(folderPath, count, body);
            }).then(function (go) { if (go === false) _busy = false; });
        }

        // 归档确认 + 执行链（从 _archiveFolderPrompt 原样抽出，守卫通过后调用）
        function _archiveFolderConfirmed(folderPath, count, body) {
            global.showConfirm(AEI18n.t('归档文件夹'), body, 'danger').then(function (ok) {
                if (!ok) { _busy = false; return; }
                // 归档是逐条搬移（工程素材整包复制，可能耗时），用 AENotice 进度卡片反馈
                var notice = null;
                if (count > NOTICE_THRESHOLD && global.AENotice) {
                    notice = global.AENotice.show({
                        id: 'assets-folder-archive',
                        title: AEI18n.t('归档文件夹'),
                        message: AEI18n.t('正在归档「{path}」…', { path: folderPath }),
                        tone: 'warn',
                        dismissible: false
                    });
                }
                _store.archiveFolder(folderPath).then(function (res) {
                    _busy = false;
                    _refresh();
                    if (notice && global.AENotice) notice.close();
                    var n = (res && res.archived) ? res.archived.length : 0;
                    var fails = (res && res.failures) ? res.failures : [];
                    if (fails.length) {
                        // 条目级失败（复制失败/删源失败等）不得用绿色 success 语音粉饰——
                        // 分档对齐同文件 _archiveFolders 的失败分支，失败明细给首条原因
                        var err0 = (fails[0] && fails[0].error) ? fails[0].error : AEI18n.t('未知错误');
                        if (global.AEToast) AEToast.error(AEI18n.t('归档文件夹「') + folderPath + AEI18n.t('」完成（') + n + AEI18n.t(' 成功，') + fails.length + AEI18n.t(' 失败）: ') + err0);
                        return;
                    }
                    var extra = '';
                    if (res && res.missing && res.missing.length) extra += AEI18n.t('，移除丢失索引 {n} 条', { n: res.missing.length });
                    if (global.AEToast) AEToast.success(AEI18n.t('已归档文件夹「') + folderPath + AEI18n.punct('」（', '" (', '」（', '“ (', '” (', ' » (', '» (') + n + AEI18n.t(' 条，7 天后自动清理') + extra + AEI18n.punct('）', ')'));
                }).catch(function (e) {
                    _busy = false;
                    if (notice && global.AENotice) notice.close();
                    if (e && (e.code === 'CANCELLED' || e.message === 'USER_CANCELLED')) {
                        if (global.AEToast) AEToast.info(AEI18n.t('已取消'));
                        return;
                    }
                    if (global.AEToast) AEToast.error(AEI18n.t('归档失败: ') + (e && e.message ? e.message : e));
                });
            });
        }

        // 该文件夹（含子层）当前活跃条目数（归档确认框与面板计数用）
        function _folderItemCount(folderPath) {
            var n = _norm(folderPath);
            var items = (_store && _store.list) ? _store.list() : [];
            var c = 0;
            for (var i = 0; i < items.length; i++) {
                var f = _norm(items[i].folder);
                if (f === n || (n !== '' && f.indexOf(n + '/') === 0)) c++;
            }
            return c;
        }

        // 归档区条目数（工具栏徽标）
        function _archivedCount() {
            if (!_store || typeof _store.listArchive !== 'function') return 0;
            try { return (_store.listArchive() || []).length; } catch (_) { return 0; }
        }

        // ── 归档区面板（只读列表 + 恢复 / 立即清理；立即清理仅 UI 提供）──
        // UI 优化：
        //   ① 单例：重复打开先收旧面板（否则连点两次叠两层，点遮罩只能逐个关）
        //   ② 组头剩余天数取"该组最快过期"的一条（取 rows[0] 时，组内归档时间不同会误导）
        //   ③ 组间 + 组内按紧迫度排序（最快过期在前），紧迫度分级着色（≤1 天红 / ≤3 天橙）
        //   ④ 搜索过滤（名称 / 备注）+ 多选批量（全选 / 恢复选中 / 清理选中）
        //   ⑤ 未登记项可展开列出（失败安全可见性）；空态给出说明
        //   ⑥ 危险操作（立即清理 / 清空）与主操作（恢复）视觉分层
        // ⑦：条目详情不再用原生 title（悬停会弹原生白框，观感差）——改悬停时写入页脚状态行
        // 结构：head（标题/副信息/关闭）+ tools（搜索/全选/批量）+ list + unreg + foot，
        // 静态骨架只建一次、每次只重渲染 list/unreg，搜索框焦点不丢。
        // 页脚提示语（静止态文案）：悬停条目行时会被该条详情临时顶掉，鼠标离开还原（见 _setFootInfo）
        var FOOT_HINT = AEI18n.t('点行选中（Ctrl 加选 / Shift 连选）→ 「恢复选中 / 清理选中」批量处理；7 天后自动物理清理（不走回收站）');
        var _archivePanelEl = null;   // 当前打开的面板（单例）
        var _archivePanelKey = null;  // 当前面板的 ESC 监听（单例重开时先解绑，防监听泄漏）
        function _openArchivePanel() {
            if (!_store || typeof _store.listArchive !== 'function') return;
            if (_archivePanelEl && _archivePanelEl.parentNode) _archivePanelEl.parentNode.removeChild(_archivePanelEl);
            if (_archivePanelKey) { document.removeEventListener('keydown', _archivePanelKey); _archivePanelKey = null; }
            _archivePanelEl = null;

            var overlay = document.createElement('div');
            overlay.className = 'assets-archive-panel';
            overlay.setAttribute('data-act', 'archive-overlay');
            var box = document.createElement('div');
            box.className = 'assets-archive-box';
            overlay.appendChild(box);

            var _sel = {};           // 多选态：id → true（跨重渲染保留）
            var _query = '';         // 搜索词
            var _showUnreg = false;  // 未登记项展开态
            var _collapsed = {};     // 分组折叠态：文件夹 key（'' 表示根组）→ true
            var _anchorId = null;    // Shift 连选的锚点（最近一次点选的行 id）

            function esc(s) {
                return String(s == null ? '' : s)
                    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
            }
            function remainDays(it) {
                var S = global.AEAssetsShared;
                var ttl = (S && S.ARCHIVE_TTL_MS) || (7 * 24 * 3600 * 1000);
                var t = Date.parse(it && it.archivedAt);
                if (isNaN(t)) return null;
                var d = Math.ceil((t + ttl - Date.now()) / (24 * 3600 * 1000));
                return d < 0 ? 0 : d;
            }
            function urgencyCls(d) {
                if (d == null) return '';
                if (d <= 1) return ' is-urgent';
                if (d <= 3) return ' is-soon';
                return '';
            }
            function list() { try { return _store.listArchive() || []; } catch (_) { return []; } }

            // ── 静态骨架 ──
            var head = document.createElement('div');
            head.className = 'assets-archive-head';
            var elTitle = document.createElement('span');
            elTitle.className = 'assets-archive-title';
            // 标题里的总数改成胶囊（与组头"条数胶囊"同款）——"归档区（15 条）"这种全角括号
            // 串在 13px 标题里像一句话，拆成 标题 + 胶囊 更好扫
            elTitle.appendChild(document.createTextNode(AEI18n.t('归档区')));
            var elCount = document.createElement('span');
            elCount.className = 'assets-archive-count';
            elTitle.appendChild(elCount);
            var elSub = document.createElement('span');
            elSub.className = 'assets-archive-sub';
            var btnClose = document.createElement('button');
            btnClose.className = 'btn btn-slice secondary';
            btnClose.textContent = AEI18n.t('关闭');
            btnClose.setAttribute('data-aact', 'close');
            head.appendChild(elTitle);
            head.appendChild(elSub);
            head.appendChild(btnClose);

            var tools = document.createElement('div');
            tools.className = 'assets-archive-tools';
            var search = document.createElement('input');
            search.className = 'assets-archive-search';
            search.setAttribute('type', 'text');
            search.setAttribute('placeholder', AEI18n.t('搜索名称 / 备注…'));
            var btnSelAll = document.createElement('button');
            btnSelAll.className = 'btn btn-slice secondary';
            btnSelAll.setAttribute('data-aact', 'sel-all');
            var btnRestoreSel = document.createElement('button');
            btnRestoreSel.className = 'btn btn-slice secondary';
            btnRestoreSel.setAttribute('data-aact', 'restore-selected');
            var btnPurgeSel = document.createElement('button');
            btnPurgeSel.className = 'btn btn-slice danger';
            btnPurgeSel.setAttribute('data-aact', 'purge-selected');
            tools.appendChild(search);
            tools.appendChild(btnSelAll);
            tools.appendChild(btnRestoreSel);
            tools.appendChild(btnPurgeSel);

            var listEl = document.createElement('div');
            listEl.className = 'assets-archive-list';
            var unregEl = document.createElement('div');
            unregEl.className = 'assets-archive-unreg-wrap';
            var unregBtn = document.createElement('button');
            unregBtn.className = 'assets-archive-unreg-toggle';
            unregBtn.setAttribute('data-aact', 'toggle-unreg');
            unregBtn.style.display = 'none';
            var unregList = document.createElement('div');
            unregList.className = 'assets-archive-unreg-list';
            unregEl.appendChild(unregBtn);
            unregEl.appendChild(unregList);
            var foot = document.createElement('div');
            foot.className = 'assets-archive-foot';
            var footHint = document.createElement('span');
            footHint.className = 'assets-archive-foot-hint';
            // 提示语压到一行内（12px 字号下会折成两行，页脚显脏）
            // 这句同时是"静止态"文案——鼠标悬停条目行时页脚临时改成该条详情，离开还原
            footHint.textContent = FOOT_HINT;
            var btnPurgeAll = document.createElement('button');
            // 文案精简（用户反馈）：永久删除语义由 title + 二次确认框承担（确认框文案即"永久删除…不可恢复"），
            // 视觉层级降到 danger-ghost，与行内「立即清理」同档，不跟主操作抢眼
            btnPurgeAll.className = 'btn btn-slice danger-ghost';
            btnPurgeAll.textContent = AEI18n.t('清理归档区');
            btnPurgeAll.setAttribute('title', AEI18n.t('永久删除归档区内全部条目（不走回收站，不可恢复）'));
            btnPurgeAll.setAttribute('data-aact', 'purge-all');
            foot.appendChild(footHint);
            foot.appendChild(btnPurgeAll);

            box.appendChild(head);
            box.appendChild(tools);
            box.appendChild(listEl);
            box.appendChild(unregEl);
            box.appendChild(foot);

            // ── 数据 → 视图 ──
            function selectedIds() {
                return Object.keys(_sel).filter(function (id) { return _sel[id]; });
            }
            // 当前**可见**行 id 的显示顺序（含分组间顺序；折叠组与搜索过滤掉的行不在内）——
            // Shift 连选按这个顺序取区间（用户看到的顺序）
            function visibleRowIds() {
                var out = [];
                visibleGroups().forEach(function (g) { g.rows.forEach(function (it) { out.push(it.id); }); });
                return out;
            }
            // 筛选后的**全部**行 id（含折叠组）——「全选/取消全选」的作用域（折叠只是显示层过滤）
            function filteredRowIds() {
                var q = String(_query || '').toLowerCase();
                var out = [];
                list().forEach(function (it) {
                    if (q) {
                        var hay = String(it.name || '').toLowerCase() + ' ' + String(it.notes || '').toLowerCase();
                        if (hay.indexOf(q) < 0) return;
                    }
                    out.push(it.id);
                });
                return out;
            }
            function visibleGroups() {
                var q = String(_query || '').toLowerCase();
                var byKey = {}, order = [];
                list().forEach(function (it) {
                    if (q) {
                        var hay = String(it.name || '').toLowerCase() + ' ' + String(it.notes || '').toLowerCase();
                        if (hay.indexOf(q) < 0) return;
                    }
                    var k = _norm(it.folder);
                    if (!byKey[k]) { byKey[k] = []; order.push(k); }
                    byKey[k].push(it);
                });
                var groups = order.map(function (k) {
                    var rows = byKey[k].slice().sort(function (a, b) {
                        var da = remainDays(a), db = remainDays(b);
                        var na = (da == null ? 1e9 : da), nb = (db == null ? 1e9 : db);
                        if (na !== nb) return na - nb;
                        return String(a.name || '').localeCompare(String(b.name || ''));
                    });
                    return { key: k, rows: rows, fastest: rows.length ? remainDays(rows[0]) : null };
                });
                // 组间同样按"最快过期"升序（最紧急的组排最前）
                groups.sort(function (a, b) {
                    var na = (a.fastest == null ? 1e9 : a.fastest), nb = (b.fastest == null ? 1e9 : b.fastest);
                    return na - nb;
                });
                return groups;
            }
            function renderList() {
                var groups = visibleGroups();
                var total = list().length;
                if (!total) {
                    listEl.innerHTML = '<div class="assets-archive-empty">'
                        + '<div class="assets-archive-empty-icon"></div>'
                        // 不用"归档区为空"——本函数先于 renderUnreg 跑（未登记项是异步读），
                        // 底下同时挂着「未登记 N 项」时"为空"自相矛盾；措辞对两种情况都成立
                        + AEI18n.html('<div class="assets-archive-empty-text">归档区没有已登记的条目</div>')
                        + AEI18n.html('<div class="assets-archive-empty-hint">在素材/预设/工程素材上点「归档」的条目会先停留在这里，7 天后自动清理，期间可随时恢复</div>')
                        + '</div>';
                    return;
                }
                if (!groups.length) {
                    listEl.innerHTML = AEI18n.html('<div class="assets-archive-empty"><div class="assets-archive-empty-text">没有匹配「')
                        + esc(_query) + AEI18n.html('」的归档条目</div></div>');
                    return;
                }
                var html = '';
                groups.forEach(function (g) {
                    var rows = g.rows;
                    var fastest = g.fastest;
                    var collapsed = !!_collapsed[g.key];
                    var archivedAt = String(rows[0].archivedAt || '').slice(0, 10);
                    html += '<div class="assets-archive-group' + (collapsed ? ' is-collapsed' : '') + '">'
                        // 组头即折叠开关（点组名切换）：折叠只是显示层过滤，不参与 visibleGroups()
                        // 的筛选——「全选」仍覆盖被折叠组的条目（按钮上带计数、清理有二次确认）
                        + '<div class="assets-archive-group-head">'
                        // 组头不再挂 title（悬停弹出白框观感差）——折叠语义靠 ▾/▸ 指示 + hover 提亮
                        + '<button type="button" class="assets-archive-group-toggle" data-aact="toggle-group" data-folder="' + esc(g.key) + '">'
                        + '<span class="assets-archive-caret">' + (collapsed ? '▸' : '▾') + '</span>'
                        // 组名分三段渲染（名字 / 条数胶囊 / 归档元信息）——挤成一行时
                        // "预设/动画（15 条 · 归档于 … · 最快剩余 7 天）"，同字号同灰度读起来是一团；
                        // 紧迫度配色移到条数胶囊上（哪个组有救不回来的条目，看数字颜色即可）
                        + '<span class="assets-archive-group-name">'
                        + '<span class="assets-archive-group-label">' + esc(g.key ? g.key : AEI18n.t('（根）')) + '</span>'
                        + '<span class="assets-archive-group-count' + urgencyCls(fastest) + '">' + rows.length + AEI18n.html(' 条</span>')
                        + AEI18n.html('<span class="assets-archive-group-meta">归档于 ') + esc(archivedAt)
                        + (fastest != null ? AEI18n.t(' · 最快剩余 ') + fastest + AEI18n.t(' 天') : '') + '</span>'
                        + '</span>'
                        + '</button>'
                        + '<button class="btn btn-slice secondary" data-aact="restore-folder" data-folder="' + esc(g.key) + '">' + AEI18n.t('恢复该组') + '</button>'
                        + '<button class="btn btn-slice danger-ghost" data-aact="purge-folder" data-folder="' + esc(g.key) + '">' + AEI18n.t('清理该组') + '</button>'
                        + '</div>';
                    if (collapsed) { html += '</div>'; return; }
                    rows.forEach(function (it) {
                        var d = remainDays(it);
                        // 这条详情不再进 title（原生悬停白框观感差）——放进 data-info，
                        // 由列表的 mouseover/mouseout 委托写进页脚状态行（见 _setFootInfo）
                        var info = it.name + AEI18n.t(' · 原位置: ') + (it.folder ? it.folder : AEI18n.t('根'))
                            + AEI18n.t(' · 归档于 ') + String(it.archivedAt || '').slice(0, 16).replace('T', ' ')
                            + (it.ffxPath || it.aepPath ? AEI18n.t(' · 归档路径: ') + (it.ffxPath || it.aepPath) : '');
                        // 单条操作交给多选：行本身即选中开关（data-aact="sel"），
                        // 行内不再放「恢复 / 立即清理」按钮——单条 = 选中一条 + 点批量按钮
                        // 行内不渲染勾选框——选中态只由行高亮表达，
                        // 选择交互走行点击 / Ctrl 切换 / Shift 区间（见点击处理里的 sel 分支）
                        html += '<div class="assets-archive-row' + (_sel[it.id] ? ' is-sel' : '') + '" data-aact="sel" data-id="' + esc(it.id) + '" data-info="' + esc(info) + '">'
                            + '<span class="assets-archive-name">' + esc(it.name) + '</span>'
                            + (it.notes ? '<span class="assets-archive-notes">' + esc(String(it.notes).replace(/\s+/g, ' ').slice(0, 40)) + '</span>' : '<span class="assets-archive-notes"></span>')
                            + (d != null ? '<span class="assets-archive-exp' + urgencyCls(d) + '">' + AEI18n.t('剩 ') + d + AEI18n.t(' 天') + '</span>' : '<span class="assets-archive-exp"></span>')
                            + '</div>';
                    });
                    html += '</div>';
                });
                listEl.innerHTML = html;
            }
            function renderTools() {
                var n = selectedIds().length;
                // 标签必须与实际动作一致——"有选中即显示取消全选"与点击逻辑相反：
                // "未全选则全选"，于是 1/94 选中时点「取消全选」反而全选（用户报的 bug）。
                // 现在按**筛选后全部行**是否已全选决定标签与动作（含折叠组，见）
                var _allIds = filteredRowIds();
                var _allSel = _allIds.length > 0 && n >= _allIds.length;
                btnSelAll.textContent = _allSel ? AEI18n.t('取消全选') : AEI18n.t('全选');
                btnRestoreSel.textContent = AEI18n.t('恢复选中 (') + n + ')';
                btnPurgeSel.textContent = AEI18n.t('清理选中 (') + n + ')';
                btnRestoreSel.disabled = n === 0;
                btnPurgeSel.disabled = n === 0;
            }
            function renderHead() {
                var all = list().length;
                var sweepInfo = '';
                try {
                    var ls = (typeof _store.getLastSweep === 'function') ? _store.getLastSweep() : null;
                    if (ls && ls.deleted) sweepInfo = AEI18n.t(' · 上次清理 {n} 条', { n: ls.deleted });
                } catch (_) {}
                elCount.textContent = all + AEI18n.t(' 条');
                elSub.textContent = AEI18n.t('7 天后自动清理') + sweepInfo + (_query ? AEI18n.t(' · 筛选「') + _query + AEI18n.punct('」', '"', '」', '“', '”', ' »', '»') : '');
            }
            function renderUnreg() {
                if (typeof _store.listUnregisteredArchive !== 'function') { unregEl.innerHTML = ''; return; }
                var p;
                try { p = _store.listUnregisteredArchive(); } catch (_) { unregEl.innerHTML = ''; return; }
                Promise.resolve(p).then(function (un) {
                    if (!un || !un.length) { unregBtn.style.display = 'none'; unregList.innerHTML = ''; return; }
                    unregBtn.style.display = '';
                    unregBtn.textContent = AEI18n.t('未登记 ') + un.length + AEI18n.t(' 项') + (_showUnreg ? ' ▾' : ' ▸')
                        + AEI18n.t('（归档区存在但索引无记录，不会自动清理，请人工确认）');
                    if (!_showUnreg) { unregList.innerHTML = ''; return; }
                    var html = '';
                    for (var i = 0; i < Math.min(un.length, 20); i++) html += '<div class="assets-archive-unreg-item">' + esc(un[i]) + '</div>';
                    if (un.length > 20) html += AEI18n.html('<div class="assets-archive-unreg-item">…（其余 ') + (un.length - 20) + AEI18n.html(' 项略）</div>');
                    unregList.innerHTML = html;
                }, function () { unregBtn.style.display = 'none'; unregList.innerHTML = ''; });
            }
            // 选中态收敛：归档区里已不存在的 id 从 _sel 摘掉——清扫/恢复/清理后按钮计数不虚高
            // （否则可能出现"恢复选中 (3)"但列表只剩 2 行、点下去还带一条"条目不存在"失败）。
            // 按**全量归档列表**收敛而非当前可见行：否则一搜索就会把看不见的选中项丢掉
            function pruneSel() {
                var live = {};
                var all = list();
                for (var i = 0; i < all.length; i++) { if (all[i] && all[i].id) live[all[i].id] = true; }
                Object.keys(_sel).forEach(function (id) { if (!live[id]) delete _sel[id]; });
                if (_anchorId && !live[_anchorId]) _anchorId = null;   // 锚点随条目消失（清扫/恢复）一起失效
            }
            // 就地同步可见行的选中态（不重渲染列表：保住滚动位置与搜索框焦点）
            function paintRows() {
                if (!listEl.querySelectorAll) return;
                var rows = listEl.querySelectorAll('.assets-archive-row');
                for (var i = 0; i < rows.length; i++) {
                    var r = rows[i];
                    var id = r.getAttribute && r.getAttribute('data-id');
                    var want = !!_sel[id];
                    var has = String(r.className || '').indexOf('is-sel') >= 0;
                    if (want !== has) r.className = want ? 'assets-archive-row is-sel' : 'assets-archive-row';
                }
            }
            function render() { pruneSel(); renderHead(); renderTools(); renderList(); renderUnreg(); }

            function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); if (_archivePanelEl === overlay) _archivePanelEl = null; }
            function afterMutate(msg, isWarn) {
                _refresh(); render();
                if (msg && global.AEToast) { if (isWarn) AEToast.warn(msg, { autoHideMs: 8000 }); else AEToast.success(msg); }
            }
            // 部分失败如实回执：批量恢复/清理只报成功条数时，failures/failed 被整段丢弃——
            // 用户看到"已恢复 2 条"却不知道哪条为何没成（归档副本已丢 / 路径越界 / 目录建不出来）
            function failNote(fails) {
                if (!fails || !fails.length) return '';
                var f = fails[0] || {};
                var why = String(f.error || f.name || f.path || '').replace(/\s+/g, ' ');
                if (why.length > 48) why = why.slice(0, 48) + '…';
                return AEI18n.t('，失败 {n} 条', { n: fails.length }) + (why ? AEI18n.t('（首条：{why}）', { why: why }) : '');
            }
            // store 未按契约返回（返回 null / 缺字段）时不得当成功——项目内"假成功"同类问题已多次返工
            function resultMissing(res, key) {
                return !res || !Array.isArray(res[key]);
            }

            // ── 动作 ──
            function doRestore(ids) {
                if (!ids.length) return;
                Promise.resolve(_store.restore(ids)).then(function (res) {
                    if (resultMissing(res, 'restored')) {
                        if (global.AEToast) AEToast.error(AEI18n.t('恢复失败：store 未返回结果（未做任何改动）'));
                        return;
                    }
                    var fails = res.failures || [];
                    for (var i = 0; i < ids.length; i++) delete _sel[ids[i]];
                    afterMutate(AEI18n.t('已恢复 {n} 条', { n: res.restored.length }) + failNote(fails), fails.length > 0);
                }, function (err) { if (global.AEToast) AEToast.error(AEI18n.t('恢复失败: ') + (err && err.message ? err.message : err)); });
            }
            function doPurge(ids, folder, label) {
                // 归档件本身是链接时先显式提示（清理=物理删除，作用于真实目标；
                // 逐条探测归档清单里的物理路径、一次汇总）。ids 为 null（清理整组/全部）时
                // 探测清单内全部条目；探测不可用 → 放行既有流程（fail-open）。
                var purgeEntries = [];
                try {
                    var archAll = (typeof _store.listArchive === 'function') ? (_store.listArchive() || []) : [];
                    var _idSet = null;
                    if (ids) { _idSet = {}; for (var pi = 0; pi < ids.length; pi++) _idSet[ids[pi]] = true; }
                    for (var ai = 0; ai < archAll.length; ai++) {
                        var ait = archAll[ai];
                        if (!ait || (_idSet && !_idSet[ait.id])) continue;
                        var ap = ait.ffxPath || ait.aepPath;
                        if (ap) purgeEntries.push({ path: ap, label: ait.name || ait.id });
                    }
                } catch (_) { purgeEntries = []; }
                _withLinkGuard(purgeEntries, function () {
                global.showConfirm(AEI18n.t('立即清理'), AEI18n.t('将永久删除') + (label ? label : ' ' + ids.length + AEI18n.t(' 条归档件'))
                    + AEI18n.t('（不可恢复），确定？'), 'danger').then(function (ok) {
                    if (!ok) return;
                    Promise.resolve(_store.purgeArchive(ids ? { ids: ids } : { folder: folder })).then(function (res) {
                        if (resultMissing(res, 'failed') || typeof res.deleted !== 'number') {
                            if (global.AEToast) AEToast.error(AEI18n.t('清理未返回结果，请刷新面板确认归档区实际状态'));
                            return;
                        }
                        if (ids) for (var i = 0; i < ids.length; i++) delete _sel[ids[i]];
                        // 永久删除更要如实报失败：failed 里的条目仍在归档区（路径越界被拒 / 文件删不掉）
                        afterMutate(AEI18n.t('已清理 {n} 条', { n: res.deleted }) + failNote(res.failed), (res.failed || []).length > 0);
                    }, function (err) { if (global.AEToast) AEToast.error(AEI18n.t('清理失败: ') + (err && err.message ? err.message : err)); });
                });
                });
            }

            search.addEventListener('input', function (e) {
                _query = String((e && e.target && e.target.value) || '');
                renderList(); renderHead();
            });

            // ── 条目详情走页脚状态行（原生 title 悬停会弹白框，观感差）──
            // 悬停某行 → 页脚提示语临时换成该行详情（原位置 / 归档时间 / 归档路径）；移出还原静止态文案。
            // 事件挂在 listEl 上做委托——列表每次重渲染（innerHTML）不需要重挂。
            function _setFootInfo(txt) {
                if (txt) {
                    footHint.textContent = txt;
                    footHint.className = 'assets-archive-foot-hint is-info';
                } else {
                    footHint.textContent = FOOT_HINT;
                    footHint.className = 'assets-archive-foot-hint';
                }
            }
            function _rowOf(node) {
                var el = node;
                while (el && el !== listEl && !(el.getAttribute && el.getAttribute('data-aact') === 'sel')) el = el.parentNode;
                return (el && el !== listEl) ? el : null;
            }
            listEl.addEventListener('mouseover', function (e) {
                var r = _rowOf(e && e.target);
                if (r) _setFootInfo(r.getAttribute('data-info'));
            });
            // 只有"移出到列表外/行外"才还原：行内子元素之间移动（鼠标滑过行内 span）不算离开
            listEl.addEventListener('mouseout', function (e) {
                if (!_rowOf(e && e.relatedTarget)) _setFootInfo('');
            });

            box.addEventListener('click', function (e) {
                var el = e.target;
                while (el && el !== box && !(el.getAttribute && el.getAttribute('data-aact'))) el = el.parentNode;
                if (!el || el === box || !el.getAttribute) return;
                var act = el.getAttribute('data-aact');
                if (act === 'close') { close(); return; }
                if (act === 'sel') {
                    // 选择模型（文件列表惯例；行内已无勾选框，选中态只由 is-sel 表达）：
                    //   Shift → 锚点到本行（按可见顺序）的区间，替换当前选择，锚点不动
                    //   Ctrl/Cmd → 切换本行加选；锚点移到本行
                    //   单击 → 该行已选中且唯一则取消；否则只选它（清掉其它）
                    var sid = el.getAttribute('data-id');
                    var ev = e || {};
                    var order = null;
                    if (ev.shiftKey) {
                        order = visibleRowIds();
                        var a = _anchorId ? order.indexOf(_anchorId) : -1;
                        var b2 = order.indexOf(sid);
                        if (a >= 0 && b2 >= 0) {
                            _sel = {};
                            for (var k = Math.min(a, b2); k <= Math.max(a, b2); k++) _sel[order[k]] = true;
                            paintRows();
                            renderTools();
                            return;
                        }
                        // 锚点不可见（切了搜索/折叠）→ 退化为单击
                    }
                    if (ev.ctrlKey || ev.metaKey) {
                        if (_sel[sid]) delete _sel[sid]; else _sel[sid] = true;
                    } else {
                        var onlyThis = !!_sel[sid] && selectedIds().length === 1;
                        _sel = {};
                        if (!onlyThis) _sel[sid] = true;
                    }
                    _anchorId = sid;
                    // 就地同步行样式：不重渲染列表（保住滚动位置与搜索框焦点）。
                    // 单击可能清掉别行的选中 → 需要整片刷新可见行，而不只是点中的那行
                    var rowEl = (String(el.className || '').indexOf('assets-archive-row') === 0) ? el : el.parentNode;
                    if (rowEl && typeof rowEl.className === 'string' && rowEl.className.indexOf('assets-archive-row') === 0) {
                        rowEl.className = _sel[sid] ? 'assets-archive-row is-sel' : 'assets-archive-row';
                    }
                    paintRows();
                    renderTools();
                    return;
                }
                if (act === 'sel-all') {
                    // 作用域 = 筛选后的全部行（含折叠组）；标签由 renderTools 按同一判据给出
                    var ids = filteredRowIds();
                    var allSel = ids.length > 0 && selectedIds().length >= ids.length;
                    _sel = {};
                    if (!allSel) ids.forEach(function (id) { _sel[id] = true; });
                    _anchorId = null;
                    renderTools();
                    renderList();
                    return;
                }
                if (act === 'toggle-group') {
                    var gk = el.getAttribute('data-folder');
                    if (_collapsed[gk]) delete _collapsed[gk]; else _collapsed[gk] = true;
                    renderList();
                    return;
                }
                if (act === 'restore-selected') { doRestore(selectedIds()); return; }
                if (act === 'purge-selected') {
                    var sel = selectedIds();
                    doPurge(sel, null, AEI18n.t('选中的 {n} 条归档件', { n: sel.length }));
                    return;
                }
                // （原按 id 的单条 restore/purge 分支已随行内按钮退场，单条 = 勾行 + 批量按钮）
                if (act === 'restore-folder') {
                    var f = el.getAttribute('data-folder');
                    // 空串 = （根）组：store 侧语义为"仅根级归档条目"
                    Promise.resolve(_store.restoreFolder(f || '')).then(function (res) {
                        if (resultMissing(res, 'restored')) {
                            if (global.AEToast) AEToast.error(AEI18n.t('恢复该组失败：store 未返回结果（未做任何改动）'));
                            return;
                        }
                        var fails = res.failures || [];
                        afterMutate(AEI18n.t('已恢复 {n} 条', { n: res.restored.length }) + failNote(fails), fails.length > 0);
                    }, function (err) { if (global.AEToast) AEToast.error(AEI18n.t('恢复失败: ') + (err && err.message ? err.message : err)); });
                    return;
                }
                if (act === 'purge-folder') {
                    // 面板分组是**精确 folder 键**（visibleGroups），而 store.purgeArchive({folder})
                    // 是前缀递归且空串 = 清空全部——「清理该组」曾把根组当"全清"、把父组连带子孙组
                    // 一起永久删除（那些子孙组在界面上是单独显示的）。改按该组当前显示的精确条目 id 清理；
                    // 「清理归档区」按钮才有全清语义（purge-all 分支不动）。
                    var pf = _norm(el.getAttribute('data-folder') || '');
                    var grp = null;
                    var groups = visibleGroups();
                    for (var gi = 0; gi < groups.length; gi++) {
                        if (groups[gi].key === pf) { grp = groups[gi]; break; }
                    }
                    if (!grp || !grp.rows.length) return;   // 空组不弹确认（没东西可清理）
                    var pids = grp.rows.map(function (x) { return x.id; });
                    doPurge(pids, null, AEI18n.t('该组 {n} 条归档件', { n: pids.length }));
                    return;
                }
                if (act === 'toggle-unreg') { _showUnreg = !_showUnreg; renderUnreg(); return; }
                if (act === 'purge-all') { doPurge(null, '', AEI18n.t('归档区内全部条目')); return; }
            });
            overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
            // ESC 关闭（解绑避免监听泄漏）
            function _onKey(e) {
                if (e && (e.key === 'Escape' || e.keyCode === 27)) { close(); }
            }
            _archivePanelKey = _onKey;
            document.addEventListener('keydown', _onKey);
            var _closeOrig = close;
            close = function () {
                document.removeEventListener('keydown', _onKey);
                if (_archivePanelKey === _onKey) _archivePanelKey = null;
                _closeOrig();
            };
            document.body.appendChild(overlay);
            _archivePanelEl = overlay;
            render();

            // 打开前机会式补扫：过期待清理项随面板呈现即时消化
            if (typeof _store.sweepArchive === 'function') {
                try {
                    Promise.resolve(_store.sweepArchive()).then(function (r) {
                        if (r && r.deleted) { _refresh(); render(); }
                    }, function () {});
                } catch (_) {}
            }
        }

        // 批量删除文件夹：只保留最外层（选中了父+子时，删父即覆盖子，避免重复删）
        function _dedupeFolders(paths) {
            var normed = [];
            for (var i = 0; i < paths.length; i++) {
                var p = _norm(paths[i]);
                if (p && normed.indexOf(p) === -1) normed.push(p);
            }
            var out = [];
            for (var j = 0; j < normed.length; j++) {
                var isUnder = false;
                for (var k = 0; k < normed.length; k++) {
                    if (j === k) continue;
                    if (normed[j].indexOf(normed[k] + '/') === 0) { isUnder = true; break; }
                }
                if (!isUnder) out.push(normed[j]);
            }
            return out;
        }

        // 批量归档文件夹（原「批量删除文件夹」）：只保留最外层（选中父+子时，归档父即覆盖子）
        function _archiveFolders(paths) {
            if (_busy) { _warnBusy(); return; }
            var list = _dedupeFolders(paths);
            if (!list.length) return;
            _busy = true;
            var totalItems = 0;
            for (var ti = 0; ti < list.length; ti++) totalItems += _folderItemCount(list[ti]);
            var body = AEI18n.t('确定归档选中的 {n} 个文件夹', { n: list.length })
                + (totalItems > 0 ? AEI18n.t('（含子文件夹共 {n} 条）', { n: totalItems }) : '')
                + AEI18n.t('？将移入归档区，7 天后自动清理（期间可在「归档区」面板恢复）。');
            // 任一文件夹本身是链接时先显式提示（逐条探测、一次汇总弹窗）；取消 → 什么都不做
            _withLinkGuard(_folderLinkEntries(list), function () { _archiveFoldersConfirmed(list, body); })
                .then(function (go) { if (go === false) _busy = false; });
        }

        // 批量归档文件夹的确认 + 执行链（从 _archiveFolders 原样抽出，守卫通过后调用）
        function _archiveFoldersConfirmed(list, body) {
            global.showConfirm(AEI18n.t('批量归档文件夹'), body, 'danger').then(function (ok) {
                if (!ok) { _busy = false; return; }
                var cancelled = false;
                var doneCount = 0, failCount = 0, itemCount = 0;
                // 文件夹内部条目的失败不能吞：只按 Promise resolve 记 doneCount 时，回执里的
                // failures（.aep 被占/复制失败）与 missing（丢失索引）整段丢弃 → 某文件夹有
                // 条目归档失败时仍报"已归档 N 个文件夹"的纯成功汇总，失败条目其实还留在活跃区。
                var itemFailCount = 0;
                var totalCount = list.length;
                var notice = null;
                if (totalCount > NOTICE_THRESHOLD && global.AENotice) {
                    notice = global.AENotice.show({
                        id: 'assets-folder-batch-archive',
                        title: AEI18n.t('归档文件夹'),
                        message: AEI18n.t('正在归档… {done}/{total}', { done: 0, total: totalCount }),
                        tone: 'warn',
                        dismissible: false,
                        progress: 0,
                        progressLabel: '0/' + totalCount,
                        actions: [
                            { label: AEI18n.t('取消'), type: 'secondary', onClick: function () { cancelled = true; }, keepOpen: false }
                        ],
                        onClose: function (result) {
                            if (result && result.action === AEI18n.t('取消')) cancelled = true;
                        }
                    });
                }
                function _update(done) {
                    if (notice && global.AENotice) {
                        global.AENotice.update('assets-folder-batch-archive', {
                            message: AEI18n.t('正在归档… {done}/{total}', { done: done, total: totalCount }),
                            progress: totalCount ? Math.round(done / totalCount * 100) : 0,
                            progressLabel: done + '/' + totalCount
                        });
                    }
                }
                var next = function (i) {
                    if (cancelled || i >= list.length) {
                        _busy = false;
                        _refresh();
                        if (notice) notice.close();
                        if (cancelled) { if (global.AEToast) AEToast.info(AEI18n.t('已取消（已归档 ') + doneCount + AEI18n.t(' 个文件夹）')); }
                        else if (failCount > 0 || itemFailCount > 0) { if (global.AEToast) AEToast.error(AEI18n.t('归档完成（') + doneCount + AEI18n.t(' 成功，') + (failCount + itemFailCount) + AEI18n.t(' 失败）')); }
                        else if (doneCount > 0) { if (global.AEToast) AEToast.success(AEI18n.t('已归档 ') + doneCount + AEI18n.t(' 个文件夹（') + itemCount + AEI18n.t(' 条，7 天后自动清理）')); }
                        return;
                    }
                    _store.archiveFolder(list[i]).then(function (res) {
                        doneCount++;
                        itemCount += (res && res.archived) ? res.archived.length : 0;
                        // 条目级失败与丢失索引一并计入失败数（口径对齐单文件夹路径的 extra 附注），
                        // 收尾走既有失败分支如实汇报——不再把"文件夹内部有失败"淹没在成功汇总里。
                        itemFailCount += ((res && res.failures) ? res.failures.length : 0)
                            + ((res && res.missing) ? res.missing.length : 0);
                        _update(doneCount);
                        next(i + 1);
                    }).catch(function (e) {
                        if (e && (e.code === 'CANCELLED' || e.message === 'USER_CANCELLED')) { cancelled = true; next(i + 1); return; }
                        failCount++;
                        if (global.AEToast) AEToast.error(AEI18n.t('归档 ') + list[i] + AEI18n.t(' 失败: ') + (e && e.message ? e.message : e));
                        next(i + 1);
                    });
                };
                next(0);
            });
        }

        // 批量移动文件夹：拖拽多个选中文件夹到目标
        function _moveFolders(paths, targetFolder) {
            if (_busy) { _warnBusy(); return; }
            var list = _dedupeFolders(paths);
            if (!list.length) return;
            var dstBase = _norm(targetFolder);
            var jobs = [];
            var skipped = [];   // 静默跳过项（目标重名/目标在自身内）：结束时统一提示，防用户误以为全部成功
            for (var i = 0; i < list.length; i++) {
                var src = list[i];
                var name = src.indexOf('/') >= 0 ? src.slice(src.lastIndexOf('/') + 1) : src;
                var dst = dstBase ? (dstBase + '/' + name) : name;
                dst = _norm(dst);
                if (dst === src) continue;                       // 原地不动（符合预期，无需提示）
                if (dst.indexOf(src + '/') === 0) { skipped.push(src + AEI18n.t('（目标在其自身内）')); continue; }
                // 与单条移动共用 _targetOccupied（空文件夹 + 索引非空同名/子层），
                // 只查 listEmptyFolders → "移进已有同名非空文件夹"不被拦，预设库
                // renameFoldersBatch 的 copyFile 分支会静默 _1 改名合并、提示谎报"已移动 N 个"
                if (_targetOccupied(dst)) { skipped.push(src + AEI18n.t('（目标已有同名文件夹）')); continue; }
                jobs.push({ src: src, dst: dst });
            }
            function _notifySkipped() {
                if (skipped.length && global.AEToast) {
                    AEToast.warn(AEI18n.t('已跳过 ') + skipped.length + AEI18n.t(' 个文件夹：') + skipped.join(AEI18n.punct('、', ', ', '、')), { autoHideMs: 6000 });
                }
            }
            if (!jobs.length) { _notifySkipped(); return; }
            // 存储层必须提供批量接口：缺失即显式报错，不静默降级为
            // 逐条 renameFolder——逐条是 N 次全量索引落盘。
            if (typeof _store.renameFoldersBatch !== 'function') {
                if (global.AEToast) AEToast.error(AEI18n.t('该素材库未提供文件夹批量重命名接口，已取消'));
                return;
            }
            _busy = true;
            var notice = null;
            // 进度卡片在**首次进度回调时创建**，不在调用前创建：
            // 纯内存批改的库（refs / project-assets）整批只有一次索引写、仅在收尾回调一次
            // → 卡片建了立刻关、不跨帧绘制，等于不出现；只有逐条搬目录的预设库才会建。
            // 依据既有原则「避免短操作出现瞬态 UI 闪烁」。
            var ensureNotice = function () {
                if (notice || !(jobs.length > NOTICE_THRESHOLD) || !global.AENotice) return;
                notice = global.AENotice.show({
                    id: 'assets-folder-batch-move',
                    title: AEI18n.t('移动文件夹'),
                    message: AEI18n.t('正在移动…'),
                    tone: 'info',
                    dismissible: false,
                    progress: 0,
                    progressLabel: '0/' + jobs.length
                });
            };
            _store.renameFoldersBatch(jobs, function (doneN, failedN, totalN) {
                ensureNotice();
                if (notice && global.AENotice) {
                    var tot = totalN || jobs.length;
                    global.AENotice.update('assets-folder-batch-move', {
                        message: AEI18n.t('正在移动… {done}/{total}', { done: doneN + failedN, total: tot }),
                        progress: tot ? Math.round((doneN + failedN) / tot * 100) : 0,
                        progressLabel: (doneN + failedN) + '/' + tot
                    });
                }
            }).then(function (r) {
                _busy = false;
                _refresh();
                if (notice) notice.close();
                var done = r ? r.done : 0, failed = r ? r.failed : 0;
                if (failed > 0) { if (global.AEToast) AEToast.error(AEI18n.t('移动完成（') + done + AEI18n.t(' 成功，') + failed + AEI18n.t(' 失败）')); }
                else if (done > 0) { if (global.AEToast) AEToast.success(AEI18n.t('已移动 ') + done + AEI18n.t(' 个文件夹')); }
                _notifySkipped();
            }).catch(function (e) {
                _busy = false;
                _refresh();
                if (notice) notice.close();
                if (global.AEToast) AEToast.error(AEI18n.t('批量移动文件夹失败: ') + (e && e.message ? e.message : e));
            });
        }

        // ── treeView 选项（直接展开到 createTreeView({...})）──

        // 拖拽中的源文件夹路径：dragover 阶段 dataTransfer 处于保护模式，getData 恒返回 ''，
        // 读不到 dragstart 写入的数据，改用变量传递（drop 结束时清除、下次 dragstart 覆盖）
        var _dragSrcFolder = null;

        var folderTreeViewOpts = {
            onFolderDragStart: function (folderPath, e) {
                _dragSrcFolder = folderPath;
                e.dataTransfer.setData('application/x-ae-folder-move', folderPath);
                e.dataTransfer.effectAllowed = 'move';
                // 多选文件夹拖拽：批量写入
                var folders = _tv ? _tv.getSelectedFolders() : [];
                if (folders.length > 1 && folders.indexOf(folderPath) !== -1) {
                    e.dataTransfer.setData('application/x-ae-folder-move-batch', folders.join('\n'));
                }
            },

            onBlankContextmenu: function (x, y) {
                global.AEAssetsShared.showAssetsMenu(x, y, [
                    { label: AEI18n.t('新建文件夹'), action: 'newFolder' }
                ], function (act) {
                    if (act === 'newFolder') _newFolder();
                });
            },

            extraFolders: function () { return _store.listEmptyFolders(); },

            onDragOver: function (item, e, targetFolder) {
                var ok = (e.dataTransfer.types && (
                    e.dataTransfer.types.indexOf('application/x-ae-assets') !== -1 ||
                    e.dataTransfer.types.indexOf('application/x-ae-folder-move') !== -1
                ));
                if (!ok) return;
                // 防自拖：文件夹不能拖到自己身上（dragover 读不到 dataTransfer 数据，用 _dragSrcFolder）
                if (e.dataTransfer.types.indexOf('application/x-ae-folder-move') !== -1) {
                    if (_dragSrcFolder && targetFolder != null && (_dragSrcFolder === targetFolder || targetFolder.indexOf(_dragSrcFolder + '/') === 0)) return;
                }
                e.preventDefault(); e.dataTransfer.dropEffect = 'move';
            },

            onDrop: function (item, targetFolder, e) {
                if (_busy) { _warnBusy(); return; }
                e.preventDefault();
                _dragSrcFolder = null;   // 拖拽会话结束，清除源路径记录
                var folder = targetFolder != null ? targetFolder : (item ? (item.folder || '') : '');
                // 多选文件夹移动
                if (e.dataTransfer.types && e.dataTransfer.types.indexOf('application/x-ae-folder-move-batch') !== -1) {
                    var batchFolders = (e.dataTransfer.getData('application/x-ae-folder-move-batch') || '').split('\n').filter(function (x) { return !!x; });
                    if (batchFolders.length) { _moveFolders(batchFolders, folder); return; }
                }
                // 文件夹移动
                if (e.dataTransfer.types && e.dataTransfer.types.indexOf('application/x-ae-folder-move') !== -1) {
                    var srcFolder = e.dataTransfer.getData('application/x-ae-folder-move');
                    if (srcFolder && srcFolder !== folder) {
                        _moveFolder(srcFolder, folder);
                    }
                    return;
                }
                // 条目移动（支持批量）
                if (e.dataTransfer.types && e.dataTransfer.types.indexOf('application/x-ae-assets') !== -1) {
                    // 批量拖拽优先
                    var batchStr = e.dataTransfer.getData('application/x-ae-assets-batch');
                    if (batchStr) {
                        var ids = batchStr.split(',').filter(function (x) { return !!x; });
                        // 存储层必须提供批量移动接口：缺失即显式报错，
                        // 不静默降级为逐条 move——逐条是 N 次全量索引落盘，那正是"卡"的根因。
                        if (typeof _store.moveBatch !== 'function') {
                            if (global.AEToast) AEToast.error(AEI18n.t('该素材库未提供批量移动接口，已取消'));
                            return;
                        }
                        _busy = true;
                        var mvTotal = ids.length;
                        var mvNotice = null;
                        // 进度卡片在**首次进度回调时创建**，不在调用前创建：
                        // 纯内存批改的库（refs / project-assets）整批只有一次索引写、不产生中间回调
                        // → 永不建卡片；只有逐条搬文件的预设库（真实 I/O）才会建。
                        // 依据既有原则「避免短操作出现瞬态 UI 闪烁」。
                        var ensureMvNotice = function () {
                            if (mvNotice || !(mvTotal > NOTICE_THRESHOLD) || !global.AENotice) return;
                            mvNotice = global.AENotice.show({
                                id: 'assets-batch-move',
                                title: AEI18n.t('批量移动'),
                                message: AEI18n.t('正在移动…'),
                                tone: 'info',
                                dismissible: false,
                                progress: 0,
                                progressLabel: '0/' + mvTotal
                            });
                        };
                        _store.moveBatch(ids, folder, function (done, failed, total) {
                            ensureMvNotice();
                            var d = done + failed;
                            var tot = total || mvTotal;
                            if (mvNotice) {
                                global.AENotice.update('assets-batch-move', {
                                    message: AEI18n.t('正在移动… {done}/{total}', { done: d, total: tot }),
                                    progress: tot ? Math.round(d / tot * 100) : 0,
                                    progressLabel: d + '/' + tot
                                });
                            }
                        }).then(function (moved) {
                            _busy = false;
                            if (mvNotice) mvNotice.close();
                            _refresh();
                            // 陈旧 id 会被 store.moveBatch 静默跳过（契约：未知 id 不中断整批），
                            // 成功 toast 只报移动数会让用户以为整批都动了——补报跳过数
                            var mvN = moved || 0;
                            var mvSkip = mvTotal - mvN;
                            if (global.AEToast) AEToast.success(AEI18n.t('已移动 ') + mvN + AEI18n.t(' 个素材') + (mvSkip > 0 ? (AEI18n.t('（跳过 ') + mvSkip + AEI18n.t(' 个已不存在）')) : ''));
                        }).catch(function (err) {
                            _busy = false;
                            if (mvNotice) mvNotice.close();
                            if (global.AEToast) AEToast.error(AEI18n.t('批量移动失败: ') + (err && err.message ? err.message : err));
                        });
                        return;
                    }
                    // 单个拖拽
                    var sourceId = e.dataTransfer.getData('application/x-ae-assets');
                    if (!sourceId) return;
                    _busy = true;
                    _store.move(sourceId, folder).then(function () { _busy = false; _refresh(); }).catch(function (err) {
                        _busy = false;
                        if (global.AEToast) AEToast.error(AEI18n.t('移动失败: ') + (err && err.message ? err.message : err));
                    });
                }
            },

            onContextmenu: function (item, isFolder, folderPath, x, y) {
                if (isFolder) {
                    // 多选文件夹：右键任一选中文件夹 → 批量操作菜单
                    var selFolders = _tv && _tv.getSelectedFolders ? _tv.getSelectedFolders() : [];
                    if (selFolders.length > 1 && selFolders.indexOf(folderPath) !== -1) {
                        global.AEAssetsShared.showAssetsMenu(x, y, [
                            { label: AEI18n.t('归档选中文件夹 ({count})', { count: selFolders.length }), action: 'archiveFolders', danger: true }
                        ], function (act) {
                            if (act === 'archiveFolders') _archiveFolders(selFolders);
                        });
                        return;
                    }
                    var fmenu = [
                        { label: AEI18n.t('新建子文件夹'), action: 'newSubFolder' },
                        { label: AEI18n.t('重命名文件夹'), action: 'renameFolder' }
                    ];
                    if (_importFolderToAE) fmenu.push({ label: AEI18n.t('导入AE'), action: 'importFolderAE' });
                    fmenu.push({ label: AEI18n.t('归档文件夹'), action: 'archiveFolder', danger: true });
                    global.AEAssetsShared.showAssetsMenu(x, y, fmenu, function (act) {
                        if (act === 'newSubFolder') _newFolder(folderPath);
                        else if (act === 'renameFolder') _renameFolderPrompt(folderPath);
                        else if (act === 'importFolderAE' && _importFolderToAE) _importFolderToAE(folderPath);
                        else if (act === 'archiveFolder') _archiveFolderPrompt(folderPath);
                    });
                    return;
                }
                if (item && _renderItemCtx) {
                    _renderItemCtx(item, x, y);
                }
            }
        };

        // 后置注入：等 treeView 创建后，把行内编辑方法挂上来
        function setInlineCallbacks(beginNewItem, beginRenameFolder) {
            _beginNewItem = beginNewItem;
            _beginRenameFolder = beginRenameFolder;
        }

        return {
            _newFolder: _newFolder,
            _moveFolder: _moveFolder,
            _renameFolderPrompt: _renameFolderPrompt,
            _archiveFolderPrompt: _archiveFolderPrompt,
            _archiveFolders: _archiveFolders,
            _moveFolders: _moveFolders,
            _archivedCount: _archivedCount,
            _openArchivePanel: _openArchivePanel,
            // 条目级入口（view 的归档/重命名）复用的链接守卫与文件夹物理路径
            _withLinkGuard: _withLinkGuard,
            _folderPhysPath: _folderPhysPath,
            folderTreeViewOpts: folderTreeViewOpts,
            setInlineCallbacks: setInlineCallbacks,
            setTreeView: setTreeView
        };
    }

    global.AEAssetsShared.createFolderViewHelpers = createFolderViewHelpers;
    global.AEAssetsShared.createLoadingOverlay = createLoadingOverlay;
    // 链接条目显式提示（删除/重命名前；探测结果来自 AEFS.isLinkAsync）
    global.AEAssetsShared.confirmLinkTargets = confirmLinkTargets;
})(window);
