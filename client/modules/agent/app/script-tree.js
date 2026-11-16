// ====== Script Tree — single IIFE, only init/refresh exposed ======
window.ScriptTree = (function () {
    // ====== Internal State ======
    var RECENT_MAX = 3;
    var RECENT_KEY = 'ae_script_recent';
    var DEPTH_MAX = 20;

    var treeState = null;
    var recentList = [];
    var contextTarget = null;

    // ── 安全门禁：从 agent/scripts/scriptSecurity.js 引用（避免双份实现）──
    var _checkPathSafe = window.AEScriptSecurity._checkPathSafe;
    var inScriptsNamespace = window.AEScriptSecurity.inScriptsNamespace;
    var validateName = window.AEScriptSecurity.validateName;

    function initTreeState() {
        var stateFactory = window.AEAgentApp && window.AEAgentApp.state;
        treeState = (stateFactory && typeof stateFactory.createTreeState === 'function')
            ? stateFactory.createTreeState()
            : { flatNodes: [], collapsedSet: {}, selectedSet: {}, lastClickedPath: '', searchQuery: '', dragSourcePath: '', dragSourceType: '', ignoredNonScript: 0 };
    }

    // ====== Recent Files ======

    function loadRecent() {
        try {
            var raw = localStorage.getItem(RECENT_KEY);
            if (raw) { recentList = JSON.parse(raw); }
            if (!Array.isArray(recentList)) recentList = [];
        } catch (_) { recentList = []; }
        // 载入即按「当前数据目录的脚本根」收敛。换过数据目录后，旧根的绝对路径**仍然
        // 存在**（用户还没删旧目录）→ 点开会编辑旧副本（renderRecent 的存在性过滤拦不住这种
        // 「旧根还在」的情况）；旧根删掉后才会被那层过滤清掉。拿不到脚本根时保持原样
        //（fail-open），不猜。
        try {
            var root = (typeof getDefaultScriptDir === 'function') ? getDefaultScriptDir() : '';
            if (root) {
                var norm = String(root).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() + '/';
                var kept = recentList.filter(function (r) {
                    var p = (r && typeof r.path === 'string') ? r.path.replace(/\\/g, '/').toLowerCase() : '';
                    return p.indexOf(norm) === 0;
                });
                if (kept.length !== recentList.length) {
                    recentList = kept;
                    saveRecent();   // 顺手落盘，避免每次载入重复过滤
                }
            }
        } catch (_) {}
    }

    function saveRecent() {
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentList.slice(0, RECENT_MAX))); } catch (_) {}
    }

    function addRecent(filePath, fileName) {
        recentList = recentList.filter(function (r) { return r.path !== filePath; });
        recentList.unshift({ path: filePath, name: fileName, time: Date.now() });
        if (recentList.length > RECENT_MAX) recentList.length = RECENT_MAX;
        saveRecent();
    }

    // ====== Fuzzy Match ======

    function fuzzyMatch(query, target) {
        if (!query) return true;
        var q = query.toLowerCase();
        var t = target.toLowerCase();
        var qi = 0;
        for (var ti = 0; ti < t.length && qi < q.length; ti++) {
            if (t.charAt(ti) === q.charAt(qi)) qi++;
        }
        return qi === q.length;
    }

    // ====== Search ======

    function applySearch(query) {
        treeState.searchQuery = query;
        if (!query) {
            for (var i = 0; i < treeState.flatNodes.length; i++) {
                treeState.flatNodes[i].matched = true;
            }
        } else {
            for (var i = 0; i < treeState.flatNodes.length; i++) {
                var node = treeState.flatNodes[i];
                node.matched = (node.type === 'folder') || fuzzyMatch(query, node.name);
                if (node.matched && node.type === 'script') {
                    for (var j = i - 1; j >= 0; j--) {
                        if (treeState.flatNodes[j].depth < node.depth && treeState.flatNodes[j].type === 'folder') {
                            delete treeState.collapsedSet[treeState.flatNodes[j].path];
                        }
                        if (treeState.flatNodes[j].depth === 0) break;
                    }
                }
            }
        }
        var clearBtn = document.getElementById('scriptSearchClear');
        if (clearBtn) { clearBtn.classList.toggle('visible', !!query); }
        renderTree();
    }

    // ====== Context Menu ======

    function showContextMenu(x, y) {
        var menu = document.getElementById('scriptContextMenu');
        if (!menu) return;
        var node = contextTarget;
        var items = menu.querySelectorAll('.context-menu-item');
        for (var i = 0; i < items.length; i++) {
            var action = items[i].getAttribute('data-action');
            if (!node) { items[i].style.display = 'none'; continue; }
            if (node.type === 'folder') {
                items[i].style.display = (action === 'new-folder' || action === 'new-script' || action === 'rename' || action === 'delete') ? '' : 'none';
            } else {
                items[i].style.display = (action === 'open' || action === 'run' || action === 'rename' || action === 'delete') ? '' : 'none';
            }
        }
        var seps = menu.querySelectorAll('.context-menu-sep');
        for (var s = 0; s < seps.length; s++) { seps[s].style.display = ''; }
        var maxX = window.innerWidth - 170;
        var maxY = window.innerHeight - 200;
        menu.style.left = Math.min(x, maxX) + 'px';
        menu.style.top = Math.min(y, maxY) + 'px';
        menu.style.display = 'block';
    }

    function hideContextMenu() {
        var menu = document.getElementById('scriptContextMenu');
        if (menu) menu.style.display = 'none';
        contextTarget = null;
    }

    function bindContextMenu() {
        var menu = document.getElementById('scriptContextMenu');
        if (!menu) return;
        menu.addEventListener('click', function (e) {
            var item = e.target.closest('.context-menu-item');
            if (!item) return;
            var action = item.getAttribute('data-action');
            var node = contextTarget;
            hideContextMenu();
            if (!node) return;
            switch (action) {
                case 'open': loadIntoPreview(node.path, node.name); break;
                case 'run': var svc = window.AEAgentApp && window.AEAgentApp.llmService; if (svc && typeof svc.runScriptFileByPath === 'function') svc.runScriptFileByPath(node.path, node.name); break;
                case 'rename': beginRename(node); break;
                case 'delete':
                    if (node.type === 'script') {
                        var selCount = Object.keys(treeState.selectedSet).filter(function(k){return treeState.selectedSet[k]}).length;
                        if (selCount > 1 && treeState.selectedSet[node.path]) {
                            batchDelete();
                        } else {
                            deleteOne(node.path, node.name);
                        }
                    } else if (node.type === 'folder') {
                        var isEmpty = AEFS.listFilesSync(node.path).length === 0 && AEFS.listDirsSync(node.path).length === 0;
                        if (!isEmpty) { showStatus(AEI18n.t('文件夹不为空，无法删除'), 'error'); break; }
                        showConfirm(AEI18n.t('确认删除'), AEI18n.t('确认要删除文件夹「') + node.name + AEI18n.t('」吗？'), 'confirm').then(function(ok) {
                            if (!ok) return;
                            if (AEFS.rmdirSync(node.path)) {
                                showStatus(AEI18n.t('已删除文件夹: ') + node.name, 'success');
                                refreshTree();
                            } else { showStatus(AEI18n.t('删除文件夹失败'), 'error', { autoHideMs: 5200 }); }
                        });
                    }
                    break;
                case 'new-folder': newFolder(node.type === 'folder' ? node.path : ''); break;
                case 'new-script': newScript(node.type === 'folder' ? node.path : ''); break;
            }
        });
        document.addEventListener('click', function (e) {
            if (!e.target.closest('.ae-context-menu') && !e.target.closest('.tree-file-row') && !e.target.closest('.tree-folder-row') && !e.target.closest('.tree-recent-row')) {
                hideContextMenu();
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape') hideContextMenu();
        });
    }

    // ====== Selection ======

    function updateBatchButtons() {
        var delBtn = document.getElementById('scriptBatchDeleteBtn');
        var moveBtn = document.getElementById('scriptBatchMoveBtn');
        var count = Object.keys(treeState.selectedSet).filter(function (k) { return treeState.selectedSet[k]; }).length;
        if (delBtn) delBtn.disabled = count === 0;
        if (moveBtn) moveBtn.disabled = count === 0;
    }

    function toggleSelect(path, isCtrl, isShift) {
        var scriptsOnly = [];
        for (var i = 0; i < treeState.flatNodes.length; i++) {
            if (treeState.flatNodes[i].type === 'script') {
                scriptsOnly.push(treeState.flatNodes[i].path);
            }
        }
        if (isShift && treeState.lastClickedPath) {
            var from = scriptsOnly.indexOf(treeState.lastClickedPath);
            var to = scriptsOnly.indexOf(path);
            if (from !== -1 && to !== -1) {
                var start = Math.min(from, to);
                var end = Math.max(from, to);
                if (!isCtrl) treeState.selectedSet = {};
                for (var i = start; i <= end; i++) {
                    treeState.selectedSet[scriptsOnly[i]] = true;
                }
            }
        } else if (isCtrl) {
            if (treeState.selectedSet[path]) {
                delete treeState.selectedSet[path];
            } else {
                treeState.selectedSet[path] = true;
            }
        } else {
            treeState.selectedSet = {};
            treeState.selectedSet[path] = true;
        }
        treeState.lastClickedPath = path;
        renderTree();
    }

    // ====== Tree Scan ======

    function tryDecodeUri(str) {
        try { return decodeURIComponent(str); } catch (_) { return str; }
    }

    // _checkPathSafe / inScriptsNamespace / validateName 已移至 agent/scripts/scriptSecurity.js
    // 顶部 var 引用 window.AEScriptSecurity，避免双份实现漂移

    function buildTreeSync(dirPath, depth, filesSync, dirsSync, callback) {
        // Alphabetical sort — no __order__ dependency
        dirsSync.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });

        var visibleDirs = [];
        for (var vd = 0; vd < dirsSync.length; vd++) {
            if (dirsSync[vd] !== '__order__') { visibleDirs.push(dirsSync[vd]); }
        }

        var nodes = [];
        for (var di = 0; di < visibleDirs.length; di++) {
            nodes.push({
                type: 'folder',
                name: tryDecodeUri(visibleDirs[di]),
                path: dirPath.replace(/[\\\/]+$/, '') + '/' + visibleDirs[di],
                depth: depth,
                expanded: false,
                matched: true
            });
        }

        var scripts = [];
        for (var si = 0; si < filesSync.length; si++) {
            var lower = filesSync[si].toLowerCase();
            if (lower.indexOf('.jsx') === lower.length - 4 || lower.indexOf('.jsxbin') === lower.length - 7) {
                scripts.push(filesSync[si]);
            } else {
                treeState.ignoredNonScript++;
            }
        }
        scripts.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });

        for (var sj = 0; sj < scripts.length; sj++) {
            nodes.push({
                type: 'script',
                name: tryDecodeUri(scripts[sj]),
                path: dirPath.replace(/[\\\/]+$/, '') + '/' + scripts[sj],
                depth: depth,
                matched: true
            });
        }

        var pending = visibleDirs.length;
        if (pending === 0) { callback(nodes); return; }

        var allNodes = nodes;
        var childResults = new Array(visibleDirs.length);

        visibleDirs.forEach(function (dirName, idx) {
            var childPath = dirPath.replace(/[\\\/]+$/, '') + '/' + dirName;
            scanTree(childPath, depth + 1, function (childNodes) {
                childResults[idx] = childNodes || [];
                pending--;
                if (pending === 0) {
                    var result = [];
                    var scriptStartIdx = visibleDirs.length;
                    for (var k = 0; k < allNodes.length; k++) {
                        result.push(allNodes[k]);
                        if (k < scriptStartIdx && childResults[k]) {
                            result = result.concat(childResults[k]);
                        }
                    }
                    callback(result);
                }
            });
        });
    }

    function scanTreeViaExtendScript(dirPath, depth, callback) {
        // 统一走 AEFS.scanTree（含 _checkPath 安全校验 + ExtendScript 递归扫描）
        if (!window.AEFS || typeof window.AEFS.scanTree !== 'function') {
            callback(null);
            return;
        }
        // settle-once 守卫——10s 超时先触发后，迟到的 resolve/reject 仍会再次
        // 回调；上层 buildTreeSync 的 pending 计数被同一子目录双扣，轻则树提前
        // 收尾丢子树、重则 pending 永不到 0（列表刷新无回调挂死）。守卫保证
        // 本函数对 callback 恰好调用一次（超时结果或真实结果，先到者胜）。
        var settled = false;
        function _done(nodes) {
            if (settled) return;
            settled = true;
            callback(nodes);
        }
        var timeout = setTimeout(function () { _done(null); }, 10000);
        window.AEFS.scanTree(dirPath, depth + DEPTH_MAX).then(function (tree) {
            clearTimeout(timeout);
            if (settled) return;
            if (!tree) { _done([]); return; }
            try {
                flattenExtendScriptTree(tree, depth, _done);
            } catch (_) { _done(null); }
        }).catch(function () {
            clearTimeout(timeout);
            _done(null);
        });
    }

    function flattenExtendScriptTree(esNode, depth, callback) {
        treeState.ignoredNonScript += (esNode.nf || 0);
        var nodes = [];
        var dirs = esNode.d || [];
        dirs.sort(function (a, b) { return (a.n || '').toLowerCase().localeCompare((b.n || '').toLowerCase()); });
        var visibleDirs = [];
        for (var vi = 0; vi < dirs.length; vi++) {
            if (dirs[vi].n !== '__order__') { visibleDirs.push(dirs[vi]); }
        }
        for (var i = 0; i < visibleDirs.length; i++) {
            nodes.push({ type: 'folder', name: visibleDirs[i].n, path: visibleDirs[i].p, depth: depth, expanded: false, matched: true });
        }
        var files = esNode.f || [];
        files.sort(function (a, b) { return (a.n || '').toLowerCase().localeCompare((b.n || '').toLowerCase()); });
        for (var j = 0; j < files.length; j++) {
            nodes.push({ type: 'script', name: files[j].n, path: files[j].p, depth: depth, matched: true });
        }
        var pending = visibleDirs.length;
        if (pending === 0) { callback(nodes); return; }
        var allNodes = nodes;
        var childResults = new Array(visibleDirs.length);
        visibleDirs.forEach(function (dir, idx) {
            flattenExtendScriptTree({ n: dir.n, p: dir.p, d: dir.d || [], f: dir.f || [], nf: dir.nf || 0 }, depth + 1, function (childNodes) {
                childResults[idx] = childNodes || [];
                pending--;
                if (pending === 0) {
                    var result = [];
                    var dirCount = visibleDirs.length;
                    for (var k = 0; k < allNodes.length; k++) {
                        result.push(allNodes[k]);
                        if (k < dirCount && childResults[k]) { result = result.concat(childResults[k]); }
                    }
                    callback(result);
                }
            });
        });
    }

    function scanTree(dirPath, depth, callback) {
        if (typeof depth !== 'number') depth = 0;
        if (!inScriptsNamespace(dirPath)) { callback(null); return; }
        if (depth > DEPTH_MAX) { callback(null); return; }
        var filesSync = AEFS.listFilesSync(dirPath);
        var dirsSync = AEFS.listDirsSync(dirPath);
        if (dirsSync.length > 0 || filesSync.length > 0 || (typeof Bridge !== 'undefined' && Bridge.isAvailable && Bridge.isAvailable())) {
            buildTreeSync(dirPath, depth, filesSync, dirsSync, callback);
            return;
        }
        // AEFS 返回空 — 可能是真空目录，也可能是 _checkPath 拒绝了路径
        // 回退到 ExtendScript 前做显式校验，防止把非法路径直接交给 new Folder()
        if (!_checkPathSafe(dirPath)) { callback(null); return; }
        scanTreeViaExtendScript(dirPath, depth, callback);
    }

    function refreshTree() {
        // 脚本目录固定使用数据目录 agent/scripts（不再支持用户自定义）
        var scriptDir = getDefaultScriptDir();
        if (!scriptDir) {
            treeState.flatNodes = [];
            renderTree();
            showStatus(AEI18n.t('无法确定脚本保存目录'), 'error');
            return;
        }
        if (isDangerousScriptDir(scriptDir)) {
            console.error('[ScriptTree] 拒绝危险脚本目录: ' + scriptDir);
            treeState.flatNodes = [];
            renderTree();
            showStatus(AEI18n.t('脚本目录位于危险位置，已拒绝'), 'error', { autoHideMs: 5200 });
            return;
        }
        treeState.ignoredNonScript = 0;
        scanTree(scriptDir, 0, function (nodes) {
            if (!nodes) {
                showStatus(AEI18n.t('读取脚本列表失败'), 'error', { autoHideMs: 5200 });
                return;
            }
            treeState.flatNodes = nodes;
            if (treeState.searchQuery) {
                for (var i = 0; i < nodes.length; i++) {
                    nodes[i].matched = (nodes[i].type === 'folder') || fuzzyMatch(treeState.searchQuery, nodes[i].name);
                }
            }
            renderTree();
            var scriptCount = nodes.filter(function (n) { return n.type === 'script'; }).length;
            var msg = AEI18n.t('已加载 {count} 个脚本', { count: scriptCount });
            if (treeState.ignoredNonScript > 0) {
                msg += AEI18n.t('（忽略 {count} 个非脚本文件）', { count: treeState.ignoredNonScript });
            }
            showStatus(msg, 'success');
        });
    }

    // ====== E2-C Block Rendering ======

    function formatTime(ts) {
        var diff = Date.now() - ts;
        if (diff < 60000) return AEI18n.t('刚刚');
        if (diff < 3600000) return AEI18n.t('{n}分钟前', { n: Math.floor(diff / 60000) });
        if (diff < 86400000) return AEI18n.t('{n}小时前', { n: Math.floor(diff / 3600000) });
        if (diff < 604800000) return AEI18n.t('{n}天前', { n: Math.floor(diff / 86400000) });
        var d = new Date(ts);
        return (d.getMonth() + 1) + '/' + d.getDate();
    }

    function renderRecent(container) {
        // 过滤掉已删除的文件。AEFS 不可用（异常/未注入）时跳过过滤与保存——
        // 原条件把 AEFS 存在性并进 filter，AEFS 缺失时恒 false，会把「最近使用」
        // 整表清空并写回 localStorage（重启后记录永久丢失）
        if (typeof AEFS !== 'undefined' && AEFS && typeof AEFS.existsSync === 'function') {
            recentList = recentList.filter(function (r) {
                return r.path && AEFS.existsSync(r.path);
            });
            saveRecent();
        }
        if (recentList.length === 0) return;
        var section = document.createElement('div');
        section.className = 'tree-recent-section';
        var title = document.createElement('div');
        title.className = 'tree-section-title';
        title.innerHTML = AEI18n.html('<span>\u{1F4CC} 最近使用</span><span style="text-transform:none;letter-spacing:0">上次打开</span>');
        section.appendChild(title);
        for (var i = 0; i < recentList.length; i++) {
            var item = recentList[i];
            var row = document.createElement('div');
            row.className = 'tree-recent-row';
            var dot = document.createElement('span');
            dot.className = 'tree-recent-dot';
            row.appendChild(dot);
            var icon = document.createElement('span');
            icon.className = 'tree-block-icon file-icon';
            row.appendChild(icon);
            var name = document.createElement('span');
            name.style.cssText = 'flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--text-main)';
            name.textContent = item.name;
            row.appendChild(name);
            var relPath = '';
            var sd = normalizeScriptDir(getDefaultScriptDir());
            if (sd && item.path.toLowerCase().indexOf(sd.toLowerCase()) === 0) {
                relPath = item.path.slice(sd.length).replace(/^[\\\/]+/, '').replace(/\\/g, '/');
                relPath = relPath.replace(/\/[^\/]+$/, '/');
            }
            var pathEl = document.createElement('span');
            pathEl.className = 'tree-recent-path';
            pathEl.textContent = relPath;
            row.appendChild(pathEl);
            var time = document.createElement('span');
            time.className = 'tree-recent-time';
            time.textContent = formatTime(item.time);
            row.appendChild(time);
            row.addEventListener('click', function () { hideContextMenu(); });
            row.addEventListener('dblclick', (function (p) { return function () { hideContextMenu(); loadIntoPreview(p.path, p.name); }; })(item));
            row.addEventListener('contextmenu', (function (p) { return function (evt) {
                evt.preventDefault(); evt.stopPropagation();
                contextTarget = { type: 'script', name: p.name, path: p.path };
                showContextMenu(evt.clientX, evt.clientY);
            }; })(item));
            section.appendChild(row);
        }
        var sep = document.createElement('div');
        sep.style.cssText = 'height:1px;background:var(--border);margin:0 0 2px 0';
        section.appendChild(sep);
        container.appendChild(section);
    }

    function renderFile(container, node) {
        var row = document.createElement('div');
        row.className = 'tree-file-row';
        row.setAttribute('data-path', node.path);
        row.setAttribute('data-type', 'script');
        if (treeState.selectedSet[node.path]) row.classList.add('selected');
        if (treeState.searchQuery && node.matched && node.type === 'script') row.classList.add('search-match');

        var icon = document.createElement('span');
        icon.className = 'tree-block-icon file-icon';
        row.appendChild(icon);

        var name = document.createElement('span');
        name.className = 'tree-block-name';
        name.textContent = node.name;
        row.appendChild(name);

        // origin=external 徽标（外部 Agent 经 script_manager 写入的脚本）
        try {
            var extReg = window.AEExternal && window.AEExternal.bridgeClient;
            var extInfo = extReg && typeof extReg.getLibOrigin === 'function'
                ? extReg.getLibOrigin(node.name) : null;
            if (extInfo) {
                var extBadge = document.createElement('span');
                extBadge.className = 'ext-origin-badge';
                extBadge.textContent = AEI18n.t('外');
                extBadge.title = AEI18n.t('由外部 Agent 写入') + (extInfo.ts ? ' · ' + new Date(extInfo.ts).toLocaleString() : '');
                row.appendChild(extBadge);
            }
        } catch (_) {}

        // Highlight recent indicator
        for (var r = 0; r < recentList.length; r++) {
            if (recentList[r].path && recentList[r].path === node.path) { row.classList.add('has-recent'); break; }
        }

        container.appendChild(row);

        row.addEventListener('dblclick', function () { hideContextMenu(); loadIntoPreview(node.path, node.name); });
        row.addEventListener('click', function (e) {
            hideContextMenu();
            if (e.ctrlKey || e.metaKey) { toggleSelect(node.path, true, false); }
            else if (e.shiftKey) { toggleSelect(node.path, false, true); }
            else { toggleSelect(node.path, false, false); }
        });
        row.addEventListener('contextmenu', function (e) {
            e.preventDefault(); e.stopPropagation();
            contextTarget = node;
            showContextMenu(e.clientX, e.clientY);
        });
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', onDragStart);
        row.addEventListener('dragover', onDragOver);
        row.addEventListener('dragleave', onDragLeave);
        row.addEventListener('drop', onDrop);
        row.addEventListener('dragend', onDragEnd);
    }

    function renderFolder(container, node, depth) {
        var row = document.createElement('div');
        row.className = 'tree-folder-row';
        row.setAttribute('data-path', node.path);
        row.setAttribute('data-type', 'folder');

        var arrow = document.createElement('span');
        arrow.className = 'tree-block-arrow' + (treeState.collapsedSet[node.path] ? '' : ' expanded');
        arrow.textContent = '▶';
        arrow.addEventListener('click', function (e) { e.stopPropagation(); toggleFolder(node.path); });
        row.appendChild(arrow);

        var icon = document.createElement('span');
        icon.className = 'tree-block-icon folder-icon';
        row.appendChild(icon);

        var name = document.createElement('span');
        name.className = 'tree-block-name';
        name.textContent = node.name;
        row.appendChild(name);

        var meta = document.createElement('span');
        meta.className = 'tree-block-meta';
        var childCount = 0, scriptCount = 0;
        var idx = -1;
        for (var i = 0; i < treeState.flatNodes.length; i++) {
            if (treeState.flatNodes[i] === node) { idx = i; break; }
        }
        if (idx >= 0) {
            for (var i = idx + 1; i < treeState.flatNodes.length; i++) {
                if (treeState.flatNodes[i].depth <= node.depth) break;
                if (treeState.flatNodes[i].type === 'folder') childCount++;
                else scriptCount++;
            }
        }
        var parts = [];
        if (childCount > 0) parts.push(AEI18n.t('{n} 子目录', { n: childCount }));
        if (scriptCount > 0) parts.push(AEI18n.t('{n} 脚本', { n: scriptCount }));
        meta.textContent = parts.join(' · ') || AEI18n.t('空');
        row.appendChild(meta);

        row.addEventListener('click', function (e) {
            hideContextMenu();
            if (e.target === arrow) return;
            toggleFolder(node.path);
        });
        row.addEventListener('contextmenu', function (e) {
            e.preventDefault(); e.stopPropagation();
            contextTarget = node;
            showContextMenu(e.clientX, e.clientY);
        });
        row.setAttribute('draggable', 'true');
        row.addEventListener('dragstart', onDragStart);
        row.addEventListener('dragover', onDragOver);
        row.addEventListener('dragleave', onDragLeave);
        row.addEventListener('drop', onDrop);
        row.addEventListener('dragend', onDragEnd);

        container.appendChild(row);
    }

    function renderBlock(container, nodes, startIdx, blockDepth) {
        var i = startIdx;
        var depthClass = 'l' + Math.min(blockDepth, 4);
        var wrapper = document.createElement('div');
        wrapper.className = 'tree-block ' + depthClass;
        container.appendChild(wrapper);

        while (i < nodes.length) {
            var node = nodes[i];
            if (node.depth < blockDepth) break;
            if (node.type === 'folder') {
                renderFolder(wrapper, node, node.depth);
                if (!treeState.collapsedSet[node.path]) {
                    i = renderBlock(wrapper, nodes, i + 1, node.depth + 1);
                } else {
                    i++;
                    while (i < nodes.length && nodes[i].depth > node.depth) { i++; }
                }
            } else {
                renderFile(wrapper, node);
                i++;
            }
        }
        if (wrapper.children.length === 0 && wrapper.parentNode) {
            wrapper.parentNode.removeChild(wrapper);
        }
        return i;
    }

    function renderTree() {
        var container = document.getElementById('scriptTree');
        if (!container) return;
        container.innerHTML = '';

        var nodes = treeState.flatNodes;
        var hasNodes = nodes && nodes.length > 0;

        // 最近使用 — 置顶
        renderRecent(container);

        // Browse title — always shown (so new buttons are accessible)
        var title = document.createElement('div');
        title.className = 'tree-section-title';
        var left = document.createElement('span');
        left.textContent = AEI18n.t('浏览目录');
        title.appendChild(left);
        var right = document.createElement('span');
        right.style.cssText = 'display:flex;align-items:center;gap:2px;text-transform:none;letter-spacing:0';
        var folderCount = document.createElement('span');
        folderCount.style.cssText = 'font-size:9px;color:var(--text-muted);margin-right:6px';
        folderCount.textContent = (hasNodes ? nodes.filter(function (n) { return n.type === 'folder'; }).length : 0) + AEI18n.t(' 个文件夹');
        right.appendChild(folderCount);
        var newFileBtn = document.createElement('span');
        newFileBtn.className = 'tree-block-icon file-icon';
        newFileBtn.style.cssText = 'width:16px;height:16px;cursor:pointer;opacity:0.6;transition:opacity .12s;margin-left:4px';
        newFileBtn.title = AEI18n.t('新建脚本');
        newFileBtn.addEventListener('click', function(e){ e.stopPropagation(); newScript(''); });
        right.appendChild(newFileBtn);
        var newDirBtn = document.createElement('span');
        newDirBtn.className = 'tree-block-icon folder-icon';
        newDirBtn.style.cssText = 'width:16px;height:16px;cursor:pointer;opacity:0.6;transition:opacity .12s;margin-left:2px';
        newDirBtn.title = AEI18n.t('新建文件夹');
        newDirBtn.addEventListener('click', function(e){ e.stopPropagation(); newFolder(''); });
        right.appendChild(newDirBtn);
        var cleanBtn = document.createElement('span');
        cleanBtn.className = 'tree-block-icon clean-icon';
        cleanBtn.style.cssText = 'width:16px;height:16px;cursor:pointer;opacity:0.6;transition:opacity .12s;margin-left:2px';
        cleanBtn.title = AEI18n.t('清理非脚本文件');
        cleanBtn.addEventListener('click', function(e){ e.stopPropagation(); cleanNonScriptFiles(); });
        right.appendChild(cleanBtn);
        title.appendChild(right);
        container.appendChild(title);

        // Search mode: flat result list instead of tree
        if (treeState.searchQuery) {
            var matchedScripts = [];
            for (var si = 0; si < nodes.length; si++) {
                if (nodes[si].type === 'script' && nodes[si].matched) matchedScripts.push(nodes[si]);
            }
            if (matchedScripts.length === 0) {
                var noResult = document.createElement('div');
                noResult.className = 'empty';
                noResult.textContent = AEI18n.t('没有匹配的脚本');
                container.appendChild(noResult);
            } else {
                for (var mi = 0; mi < matchedScripts.length; mi++) {
                    var ms = matchedScripts[mi];
                    var srow = document.createElement('div');
                    srow.className = 'tree-file-row';
                    if (treeState.selectedSet[ms.path]) srow.classList.add('selected');
                    var sicon = document.createElement('span');
                    sicon.className = 'tree-block-icon file-icon';
                    srow.appendChild(sicon);
                    var sname = document.createElement('span');
                    sname.className = 'tree-block-name';
                    sname.textContent = ms.name;
                    srow.appendChild(sname);
                    var spath = document.createElement('span');
                    spath.style.cssText = 'font-size:9px;color:var(--text-muted);flex-shrink:0;margin-left:auto';
                    var sd = normalizeScriptDir(getDefaultScriptDir());
                    var rel = ms.path;
                    if (sd && rel.toLowerCase().indexOf(sd.toLowerCase()) === 0) {
                        rel = rel.slice(sd.length).replace(/^[\\\/]+/, '').replace(/\\/g, '/').replace(/\/[^\/]+$/, '');
                    }
                    spath.textContent = rel || '';
                    srow.appendChild(spath);
                    srow.addEventListener('dblclick', (function(p){return function(){hideContextMenu();loadIntoPreview(p.path,p.name);};})(ms));
                    srow.addEventListener('click', (function(p){return function(e){
                        hideContextMenu();
                        if (e.ctrlKey||e.metaKey) toggleSelect(p.path,true,false);
                        else if (e.shiftKey) toggleSelect(p.path,false,true);
                        else toggleSelect(p.path,false,false);
                    };})(ms));
                    srow.addEventListener('contextmenu', (function(p){return function(e){e.preventDefault();e.stopPropagation();contextTarget=p;showContextMenu(e.clientX,e.clientY);};})(ms));
                    container.appendChild(srow);
                }
            }
            var footer = document.createElement('div');
            footer.className = 'tree-footer';
            footer.innerHTML = '<span>' + matchedScripts.length + AEI18n.html(' 个匹配</span><span>Esc 清除搜索</span>');
            container.appendChild(footer);
            updateBatchButtons();
            return;
        }

        if (!hasNodes) {
            var empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = AEI18n.t('当前目录没有 .jsx/.jsxbin 脚本');
            container.appendChild(empty);
            var footer = document.createElement('div');
            footer.className = 'tree-footer';
            footer.innerHTML = AEI18n.html('<span>双击打开脚本 · Ctrl+点击多选</span><span>右键菜单 · 拖拽移动</span>');
            container.appendChild(footer);
            return;
        }

        var visibleNodes = [];
        var collapseStack = {};
        for (var i = 0; i < nodes.length; i++) {
            var node = nodes[i];
            if (node.depth > 0) {
                var parentCollapsed = false;
                for (var d = 0; d < node.depth; d++) {
                    if (collapseStack[d]) { parentCollapsed = true; break; }
                }
                if (parentCollapsed) continue;
            }
            if (node.type === 'folder') {
                for (var dd = node.depth + 1; dd <= DEPTH_MAX; dd++) { delete collapseStack[dd]; }
                collapseStack[node.depth] = treeState.collapsedSet[node.path] === true;
            }
            visibleNodes.push(node);
        }

        if (visibleNodes.length > 0) {
            renderBlock(container, visibleNodes, 0, 0);
        }

        var footer = document.createElement('div');
        footer.style.cssText = 'padding:3px 10px;font-size:9px;color:var(--text-muted);border-top:1px solid var(--border);flex-shrink:0;display:flex;justify-content:space-between';
        footer.innerHTML = AEI18n.html('<span>双击打开脚本 · Ctrl+点击多选</span><span>右键菜单 · 拖拽移动</span>');
        container.appendChild(footer);

        updateBatchButtons();
    }

    function toggleFolder(path) {
        if (treeState.collapsedSet[path]) {
            delete treeState.collapsedSet[path];
        } else {
            treeState.collapsedSet[path] = true;
        }
        renderTree();
    }

    // ====== Load Into Preview ======

    function loadIntoPreview(filePath, fileName) {
        // 直接走 AEFS 读文件，不绕 ExtendScript
        try {
            var content = AEFS.readFileSync(filePath);
            // 严格判别 null/undefined——readFileSync 失败返回 null（真失败），
            // 空文件正常读取返回 ''，旧 `!content` 把 0 字节脚本误报「读取失败」
            if (content === null || content === undefined) { showStatus(AEI18n.t('读取脚本失败: 无法读取文件 ') + (fileName || filePath) + (AEFS.lastError() ? ' — ' + AEFS.lastError() : ''), 'error', { autoHideMs: 5200 }); return; }
            document.getElementById('scriptPreview').value = content;
            generatedScript = content;
            // 程序化赋值 .value 不派发 input 事件，previewDraft 的输入
            // 防抖不触发——整页重载后预览区回显旧草稿而非刚加载的脚本。对齐 LLM
            // 生成路径（app/service.js 的显式 saveSettings），两个入口行为对称。
            try {
                if (typeof saveSettings === 'function') {
                    saveSettings(Object.assign({}, cachedSettings, getCurrentSettingsFromUI(), { previewDraft: content }));
                }
            } catch (_) {}
            var svc = window.AEAgentApp && window.AEAgentApp.llmService;
            if (svc && typeof svc.highlightCode === 'function') svc.highlightCode(true);
            showStatus(AEI18n.t('已加载脚本: ') + fileName, 'success');
            addRecent(filePath, fileName);
            renderTree();
        } catch (_) { showStatus(AEI18n.t('读取脚本失败: 内容解码异常'), 'error', { autoHideMs: 5200 }); }
    }

    // ====== Drag & Drop ======

    function onDragStart(e) {
        var path = this.getAttribute('data-path');
        var type = this.getAttribute('data-type');
        if (!path) return;
        e.dataTransfer.setData('application/x-ae-script-tree', '1');
        e.dataTransfer.setData('text/plain', JSON.stringify({ path: path, type: type }));
        e.dataTransfer.effectAllowed = 'move';
        treeState.dragSourcePath = path;
        treeState.dragSourceType = type;
        if (type === 'script' && treeState.selectedSet[path]) {
            treeState.dragSelectedSet = {};
            var keys = Object.keys(treeState.selectedSet);
            for (var i = 0; i < keys.length; i++) {
                if (treeState.selectedSet[keys[i]]) treeState.dragSelectedSet[keys[i]] = true;
            }
        }
        this.classList.add('drag-source');
    }

    function onDragOver(e) {
        e.preventDefault();
        if (!e.dataTransfer.types || e.dataTransfer.types.indexOf('application/x-ae-script-tree') === -1) return;
        var targetPath = this.getAttribute('data-path');
        var targetType = this.getAttribute('data-type');
        if (treeState.dragSourceType === 'folder') {
            var srcClean = treeState.dragSourcePath.replace(/\\/g, '/').replace(/\/+$/, '');
            var tgtClean = targetPath.replace(/\\/g, '/').replace(/\/+$/, '');
            if (tgtClean === srcClean || (tgtClean + '/').indexOf(srcClean + '/') === 0) { e.dataTransfer.dropEffect = 'none'; return; }
            if (targetType === 'script') {
                var srcParent = srcClean.replace(/\/[^\/]+$/, '');
                var tgtParent = tgtClean.replace(/\/[^\/]+$/, '');
                if (srcParent.toLowerCase() === tgtParent.toLowerCase()) { e.dataTransfer.dropEffect = 'none'; return; }
            }
        }
        var rows = document.querySelectorAll('.tree-file-row, .tree-folder-row');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
        }
        if (targetType === 'folder') {
            if (treeState.dragSourceType === 'script') {
                var srcParentCheck = treeState.dragSourcePath.replace(/\\/g, '/').replace(/\/[^\/]+$/, '').toLowerCase();
                var tgtSelfCheck = targetPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (srcParentCheck === tgtSelfCheck) { e.dataTransfer.dropEffect = 'none'; return; }
            }
            this.classList.add('drag-over');
            e.dataTransfer.dropEffect = 'move';
        } else if (targetType === 'script') {
            var rect = this.getBoundingClientRect();
            var midY = rect.top + rect.height / 2;
            if (e.clientY < midY) { this.classList.add('drag-insert-before'); }
            else { this.classList.add('drag-insert-after'); }
            e.dataTransfer.dropEffect = 'move';
        }
    }

    function onDragLeave(e) {
        this.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
    }

    function onDrop(e) {
        e.preventDefault();
        this.classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
        if (!e.dataTransfer.types || e.dataTransfer.types.indexOf('application/x-ae-script-tree') === -1) return;
        var targetPath = this.getAttribute('data-path');
        var targetType = this.getAttribute('data-type');
        var sourcePath = treeState.dragSourcePath;
        var sourceType = treeState.dragSourceType;
        if (!sourcePath || !targetPath) return;
        if (sourcePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === targetPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()) return;
        if (targetType === 'folder') {
            if (sourceType === 'script') {
                if (treeState.dragSelectedSet && Object.keys(treeState.dragSelectedSet).length > 1) {
                    executeBatchMoveToFolder(targetPath);
                } else {
                    executeMoveFile(sourcePath, targetPath);
                }
            } else if (sourceType === 'folder') {
                executeMoveFolder(sourcePath, targetPath);
            }
        } else if (targetType === 'script') {
            var targetParent = targetPath.replace(/\\/g, '/').replace(/\/[^\/]+$/, '');
            var sourceParent = sourcePath.replace(/\\/g, '/').replace(/\/[^\/]+$/, '');
            if (sourceType === 'script' && treeState.dragSelectedSet && Object.keys(treeState.dragSelectedSet).length > 1) {
                executeBatchMoveToFolder(targetParent);
            } else if (targetParent === sourceParent) {
                // Same directory — no reorder, just ignore
            } else if (sourceType === 'script') {
                executeMoveFile(sourcePath, targetParent);
            } else if (sourceType === 'folder') {
                executeMoveFolder(sourcePath, targetParent);
            }
        }
    }

    function onDragEnd(e) {
        this.classList.remove('drag-source');
        treeState.dragSourcePath = '';
        treeState.dragSourceType = '';
        treeState.dragSelectedSet = null;
        var rows = document.querySelectorAll('.tree-file-row, .tree-folder-row');
        for (var i = 0; i < rows.length; i++) {
            rows[i].classList.remove('drag-over', 'drag-insert-before', 'drag-insert-after');
        }
    }

    // ====== File Operations ======

    function executeMoveFile(srcPath, dstFolderPath) {
        var fileName = srcPath.replace(/\\/g, '/').split('/').pop();
        var dstPath = dstFolderPath.replace(/[\\\/]+$/, '') + '/' + fileName;
        if (srcPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === dstPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()) { return; }
        if (AEFS.existsSync(dstPath)) {
            showConfirm(AEI18n.t('覆盖确认'), AEI18n.t('目标位置已存在「') + fileName + AEI18n.t('」，是否覆盖？')).then(function (ok) {
                if (!ok) return;
                doSingleMove(srcPath, dstPath);
            });
            return;
        }
        doSingleMove(srcPath, dstPath);
    }

    function doSingleMove(srcPath, dstPath) {
        if (!AEFS.copyFileSync(srcPath, dstPath)) {
            showStatus(AEI18n.t('移动失败: ') + srcPath + ' — ' + (AEFS.lastError() || AEI18n.t('未知错误')), 'error', { autoHideMs: 5200 });
            return;
        }
        if (!AEFS.deleteFileSync(srcPath)) {
            // 复制已成功：目标副本已存在、源未删除——如实汇报两个路径（对齐 agent/scripts/
            // bootstrap.js _moveNode 的「已复制到目标但源删除失败」语义）。用 copy && delete 短路只报「移动失败」，目标副本已成静默双份（刷新后才可见）。
            // copy && delete 短路只报「移动失败」，目标副本已成静默双份（刷新后才可见）。
            showStatus(AEI18n.t('已复制到目标但源未删除: ') + srcPath + ' → ' + dstPath
                + AEI18n.punct('（', ' (') + (AEFS.lastError() || AEI18n.t('未知错误')) + AEI18n.punct('）', ')'), 'error', { autoHideMs: 8000 });
            refreshTree();
            return;
        }
        showStatus(AEI18n.t('已移动: ') + srcPath, 'success');
        refreshTree();
    }

    // 移动清单摘要里的文件名列表：最多列 5 个，其余用省略号（状态栏单行展示）
    function _briefNames(names) {
        var MAX = 5;
        if (!names || names.length === 0) return '';
        if (names.length <= MAX) return names.join(AEI18n.punct('、', ', '));
        return names.slice(0, MAX).join(AEI18n.punct('、', ', ')) + '…';
    }

    // 文件夹移动清单摘要：如实区分「已移动 / 已复制但源未删除 / 失败」三类
    function _moveManifestSummary(manifest) {
        if (!manifest) return '';
        var parts = [];
        if (manifest.moved.length > 0) parts.push(AEI18n.t('已移动 {n} 个文件', { n: manifest.moved.length }));
        if (manifest.partial.length > 0) parts.push(AEI18n.t('已复制但源未删除 {n} 个: {names}', { n: manifest.partial.length, names: _briefNames(manifest.partial) }));
        if (manifest.failed.length > 0) parts.push(AEI18n.t('失败 {n} 个: {names}', { n: manifest.failed.length, names: _briefNames(manifest.failed) }));
        return parts.join(AEI18n.punct('；', '; ', '、'));
    }

    function executeBatchMoveToFolder(dstFolderPath) {
        var paths = Object.keys(treeState.dragSelectedSet || treeState.selectedSet).filter(function (k) {
            return (treeState.dragSelectedSet || treeState.selectedSet)[k];
        });
        if (paths.length === 0) return;
        var dstNorm = dstFolderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        var realPaths = [];
        for (var p = 0; p < paths.length; p++) {
            var srcParent = paths[p].replace(/\\/g, '/').replace(/\/[^\/]+$/, '').toLowerCase();
            if (srcParent !== dstNorm) { realPaths.push(paths[p]); }
        }
        if (realPaths.length === 0) { treeState.selectedSet = {}; treeState.dragSelectedSet = null; refreshTree(); return; }
        // 移动前先收集目标目录同名冲突名单，统一弹一次覆盖确认——
        // AEFS.copyFileSync 为无条件覆盖语义，批量移动无 existsSync 检查时，
        // Ctrl 多选拖入含同名文件的目录会被静默覆盖丢数据（与单文件 executeMoveFile
        // 的覆盖确认语义不对称）。用户确认覆盖则照常移动；拒绝则跳过冲突项移动
        // 其余并计数汇报，不再静默覆盖。
        var conflicts = [];
        for (var c = 0; c < realPaths.length; c++) {
            var cname = realPaths[c].replace(/\\/g, '/').split('/').pop();
            var cdst = dstFolderPath.replace(/[\\\/]+$/, '') + '/' + cname;
            if (AEFS.existsSync(cdst)) conflicts.push(cname);
        }
        var proceed = Promise.resolve(true);
        if (conflicts.length > 0) {
            proceed = showConfirm(AEI18n.t('覆盖确认'), AEI18n.t('目标位置已存在 ') + conflicts.length + AEI18n.t(' 个同名脚本：')
                + conflicts.join(AEI18n.punct('、', ', ', '、')) + AEI18n.t('。是否覆盖？\n\n（取消则跳过同名脚本，移动其余）'));
        }
        proceed.then(function (ok) {
            var skipSet = {};
            if (!ok) {
                for (var s = 0; s < conflicts.length; s++) skipSet[conflicts[s].toLowerCase()] = true;
            }
            var moved = 0, failed = 0, skipped = 0, partial = 0;
            var partialNames = [], failedNames = [];
            function moveNext(idx) {
                if (idx >= realPaths.length) {
                    var msg = AEI18n.t('已移动 {done}/{total} 个脚本', { done: moved, total: realPaths.length })
                        + (skipped ? AEI18n.t('，跳过 {n} 个同名脚本', { n: skipped }) : '')
                        + (partial ? AEI18n.t('，已复制但源未删除 {n} 个: {names}', { n: partial, names: _briefNames(partialNames) }) : '')
                        + (failed ? AEI18n.t('，失败 {n} 个: {names}', { n: failed, names: _briefNames(failedNames) }) : '');
                    // 有任何半移动/失败时用错误态提示（不看失败数一律报绿色成功会让半移动看起来成功）
                    var allOk = (partial === 0 && failed === 0);
                    showStatus(msg, allOk ? 'success' : 'error', allOk ? {} : { autoHideMs: 8000 });
                    treeState.selectedSet = {}; treeState.dragSelectedSet = null; refreshTree();
                    return;
                }
                var src = realPaths[idx];
                var name = src.replace(/\\/g, '/').split('/').pop();
                if (skipSet[name.toLowerCase()]) { skipped++; moveNext(idx + 1); return; }
                var dst = dstFolderPath.replace(/[\\\/]+$/, '') + '/' + name;
                var copyOk = AEFS.copyFileSync(src, dst);
                if (!copyOk) { failed++; failedNames.push(name); }
                else if (!AEFS.deleteFileSync(src)) { partial++; partialNames.push(name); }
                else { moved++; }
                moveNext(idx + 1);
            }
            moveNext(0);
        });
    }

    // manifest 记录 { moved:[文件名], partial:[文件名], failed:[文件名] }，跨递归累计；
    // success 语义 = 全部文件 copy+delete 都成功（partial/失败都算未完整完成）
    function moveFolderRecursive(srcPath, dstParentPath, depth, callback, manifest) {
        var mf = manifest || { moved: [], partial: [], failed: [] };
        if (depth > DEPTH_MAX) { callback(false, mf); return; }
        var folderName = srcPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
        var dstPath = dstParentPath.replace(/[\\\/]+$/, '') + '/' + folderName;
        AEFS.mkdirSync(dstPath);
        var files = AEFS.listFilesSync(srcPath);
        var dirs = AEFS.listDirsSync(srcPath);
        var pending = files.length + dirs.length;
        if (pending === 0) { callback(true, mf); return; }
        var ok = true;
        function doneOne(success) { if (!success) ok = false; pending--; if (pending === 0) callback(ok, mf); }
        for (var f = 0; f < files.length; f++) {
            var src = srcPath.replace(/[\\\/]+$/, '') + '/' + files[f];
            var dst = dstPath + '/' + files[f];
            // copy/delete 分开判：复制成功而删源失败时如实计入 partial（文件已在目标、源
            // 仍残留），而不是只留一个 false 汇总、失败现场无清单可查
            var copyOk = AEFS.copyFileSync(src, dst);
            var delOk = copyOk ? AEFS.deleteFileSync(src) : false;
            if (!copyOk) mf.failed.push(files[f]);
            else if (!delOk) mf.partial.push(files[f]);
            else mf.moved.push(files[f]);
            doneOne(copyOk && delOk);
        }
        for (var d = 0; d < dirs.length; d++) {
            // IIFE 捕获本次迭代的 childSrc——回调异步触发时 var 循环变量已推进
            // （同款 var 闭包陷阱），直读闭包会拿到最后一个子目录的路径。
            (function (childSrc) {
                moveFolderRecursive(childSrc, dstPath, depth + 1, function (childOk) {
                    // 子目录内容全部移出后回收源子目录——子目录本体不删除时，
                    // 源树残留空目录骨架，顶层 rmdirSync(srcPath) 因非空静默失败，
                    // 「已移动文件夹」后新旧目录在树中并存。rmdir 失败不判为移动失败
                    // （文件已安全迁移，与 executeMoveFolder 顶层 rmdirSync 同语义）。
                    if (childOk) AEFS.rmdirSync(childSrc);
                    doneOne(childOk);
                }, mf);
            })(srcPath.replace(/[\\\/]+$/, '') + '/' + dirs[d]);
        }
    }

    function executeMoveFolder(srcPath, dstParentPath) {
        var folderName = srcPath.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
        var dstFolderPath = dstParentPath.replace(/[\\\/]+$/, '') + '/' + folderName;
        // 目标为源自身或其后代目录时拒绝——onDragOver 仅视觉拦截（dropEffect='none'
        // 只改光标，preventDefault 后 drop 仍会触发），无此校验时 moveFolderRecursive 会把
        // 文件夹逐层复制进自身直至深度上限、rmdirSync 源目录失败，目录树嵌套错乱。
        // 对齐 scripts/bootstrap.js _moveNode 的后代校验写法（大小写不敏感，覆盖
        // onDrop 的 targetType==='folder' 与 targetType==='script' 两条文件夹移动路径）。
        var srcNorm = srcPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        var dstNorm = dstFolderPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        if (dstNorm === srcNorm || (dstNorm + '/').indexOf(srcNorm + '/') === 0) {
            showStatus(AEI18n.t('不能将文件夹移动到自身或子目录内'), 'error'); return;
        }
        // 移动收尾：成功才回收源目录并报成功；未完整完成时按清单如实汇报
        //（已移动 / 已复制但源未删除 / 失败），源目录不删、目标保留已复制文件。
        // 不做整体回滚（数据已在目标，回滚是二次搬运且可能覆盖目标侧新写入）。
        function finishMoveFolder(success, manifest) {
            if (success) {
                AEFS.rmdirSync(srcPath);
                showStatus(AEI18n.t('已移动文件夹: ') + srcPath + ' → ' + dstFolderPath, 'success');
            } else {
                var detail = _moveManifestSummary(manifest);
                var hasHardFail = !!(manifest && manifest.failed.length > 0);
                showStatus((hasHardFail ? AEI18n.t('移动文件夹失败') : AEI18n.t('移动文件夹未完整完成'))
                    + (detail ? '：' + detail : '')
                    + AEI18n.t('（源: ') + srcPath + AEI18n.t('，目标: ') + dstFolderPath + AEI18n.punct('）', ')'),
                    'error', { autoHideMs: 8000 });
            }
            refreshTree();
        }
        if (AEFS.existsSync(dstFolderPath)) {
            showConfirm(AEI18n.t('覆盖确认'), AEI18n.t('目标位置已存在文件夹「') + folderName + AEI18n.t('」，是否合并？')).then(function (ok) {
                if (!ok) return;
                // 合并分支须传 dstParentPath（与下方非合并分支一致）——dstFolderPath 已拼过
                // 一次 folderName，moveFolderRecursive 内部还会再拼一层，传它会产生
                // B/A/A 嵌套目录，「合并」语义落空；传 dstParentPath 则目标正是 B/A 本身，
                // mkdirSync 对已存在目录失败无害（返回值本就被忽略），文件按覆盖语义落入。
                moveFolderRecursive(srcPath, dstParentPath, 0, finishMoveFolder);
            });
            return;
        }
        moveFolderRecursive(srcPath, dstParentPath, 0, finishMoveFolder);
    }

    // ====== Batch Ops ======

    function batchDelete() {
        var paths = Object.keys(treeState.selectedSet).filter(function (k) { return treeState.selectedSet[k]; });
        if (paths.length === 0) return;
        showConfirm(AEI18n.t('批量删除'), AEI18n.t('确认要删除选中的 ') + paths.length + AEI18n.t(' 个脚本吗？'), 'confirm').then(function (ok) {
            if (!ok) return;
            var deleted = 0;
            for (var i = 0; i < paths.length; i++) { if (AEFS.deleteFileSync(paths[i])) deleted++; }
            showStatus(AEI18n.t('已删除 ') + deleted + '/' + paths.length + AEI18n.t(' 个脚本'), 'success');
            treeState.selectedSet = {};
            refreshTree();
        });
    }

    function cleanNonScriptFiles() {
        var scriptDir = normalizeScriptDir(getDefaultScriptDir());
        if (!scriptDir) { showStatus(AEI18n.t('无法确定脚本目录'), 'error'); return; }
        // 安全校验：对齐 refreshTree 的 isDangerousScriptDir 检查（纵深防御）
        if (typeof isDangerousScriptDir === 'function' && isDangerousScriptDir(scriptDir)) {
            showStatus(AEI18n.t('脚本目录位于危险位置，已拒绝清理'), 'error', { autoHideMs: 5200 });
            return;
        }
        // 专属安全措施：计算数据目录下的 agent/scripts 基准路径（对齐 projectAssetStore._inProjectAssets）
        // 所有待删路径必须在此基准下（纵深防御：即使 getDefaultScriptDir 异常也不误删）
        var dataBase = '';
        try {
            if (window.AEShared && typeof window.AEShared.getDataDir === 'function') {
                var dd = window.AEShared.getDataDir();
                if (dd && dd.dir) dataBase = dd.dir;
            }
        } catch (_) { dataBase = ''; }
        var agentScriptsBase = dataBase
            ? dataBase.replace(/\\/g, '/').replace(/\/+$/, '') + '/agent/scripts'
            : '';
        var agentScriptsBaseNorm = agentScriptsBase.toLowerCase();

        // 专属路径归属验证：路径必须在数据目录的 agent/scripts 下（防 cachedSettings 篡改指向其他 scripts 目录）
        // 对齐 projectAssetStore._inProjectAssets：拒 .. 和 . 段 + 必须在基准下 + 不删基准根本身
        function _inAgentScripts(p) {
            if (!agentScriptsBaseNorm) return false;  // 数据目录未就绪 → 拒绝全部
            var fwd = String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
            // 拒 .. 和 . 段（不依赖 AEFS _checkPath 做唯一防线）
            if (fwd.indexOf('/../') !== -1) return false;
            if (fwd.indexOf('/./') !== -1) return false;
            var len = fwd.length;
            if (len >= 3 && fwd.lastIndexOf('/..') === len - 3) return false;
            if (len >= 2 && fwd.lastIndexOf('/.') === len - 2) return false;
            // 必须在 agentScriptsBase 下（含自身，但 _base 本身在下方单独拦截）
            return fwd.indexOf(agentScriptsBaseNorm + '/') === 0 || fwd === agentScriptsBaseNorm;
        }

        var rootNorm = scriptDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

        // 递归扫描：收集非脚本文件 + 标记"清理后变空"的文件夹
        // 安全：每个子目录路径都验证仍在 scriptDir 下（防 symlink 逃逸）
        //        并通过 _inAgentScripts 确保在数据目录基准下（防 cachedSettings 篡改）
        // 返回 {scripts, junks}：该子树脚本数与非脚本文件数
        var junkFiles = [];
        var emptyDirs = [];
        var failedPaths = [];
        function scan(dir) {
            // 路径归属验证：防止 symlink 逃逸到 scriptDir 之外
            var dirNorm = dir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            if (dirNorm !== rootNorm && dirNorm.indexOf(rootNorm + '/') !== 0) {
                console.warn('[ScriptTree] cleanNonScriptFiles 跳过 scriptDir 外的路径: ' + dir);
                return { scripts: 0, junks: 0 };
            }
            // 专属安全：路径必须在数据目录的 agent/scripts 基准下
            if (!_inAgentScripts(dir)) {
                console.warn('[ScriptTree] cleanNonScriptFiles 跳过 agent/scripts 基准外的路径: ' + dir);
                return { scripts: 0, junks: 0 };
            }
            var files = AEFS.listFilesSync(dir);
            var dirs = AEFS.listDirsSync(dir);
            var scriptCount = 0;
            var junkCount = 0;
            for (var i = 0; i < files.length; i++) {
                var lower = files[i].toLowerCase();
                if (lower.indexOf('.jsx') === lower.length - 4 || lower.indexOf('.jsxbin') === lower.length - 7) {
                    scriptCount++;
                } else {
                    junkFiles.push(dir.replace(/[\\\/]+$/, '') + '/' + files[i]);
                    junkCount++;
                }
            }
            var childScripts = 0;
            var childJunks = 0;
            for (var d = 0; d < dirs.length; d++) {
                if (dirs[d] !== '__order__') {
                    var r = scan(dir.replace(/[\\\/]+$/, '') + '/' + dirs[d]);
                    childScripts += r.scripts;
                    childJunks += r.junks;
                }
            }
            // 无脚本 + 有非脚本文件（清理后会变空）+ 非根目录
            // 注意：不清理"原本就空的文件夹"（junks=0 且 childJunks=0 时保留）
            // 纵深防御：禁止清理 agent/scripts 基准根本身（对齐 projectAssetStore._removeDir 拒删 _base）
            if (scriptCount === 0 && childScripts === 0
                && (junkCount + childJunks > 0)
                && dirNorm !== rootNorm
                && dirNorm !== agentScriptsBaseNorm) {
                emptyDirs.push(dir);
            }
            return { scripts: scriptCount + childScripts, junks: junkCount + childJunks };
        }
        scan(scriptDir);

        // 删除前最终安全校验：逐个验证每个待删路径都在 agent/scripts 基准下
        // 防止扫描后、删除前 cachedSettings 被其他代码路径篡改
        function _filterSafe(paths) {
            var safe = [];
            for (var i = 0; i < paths.length; i++) {
                if (_inAgentScripts(paths[i]) && paths[i].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() !== agentScriptsBaseNorm) {
                    safe.push(paths[i]);
                } else {
                    console.warn('[ScriptTree] cleanNonScriptFiles 删除校验拒绝: ' + paths[i]);
                    failedPaths.push(paths[i] + ' (安全校验拒绝)');
                }
            }
            return safe;
        }
        junkFiles = _filterSafe(junkFiles);
        emptyDirs = _filterSafe(emptyDirs);

        // emptyDirs 按深度倒序（先删最深层的，避免父目录"非空"阻塞）
        emptyDirs.sort(function (a, b) {
            var da = a.replace(/\\/g, '/').replace(/\/+$/, '').split('/').length;
            var db = b.replace(/\\/g, '/').replace(/\/+$/, '').split('/').length;
            return db - da;
        });

        if (junkFiles.length === 0 && emptyDirs.length === 0) {
            if (failedPaths.length > 0) {
                showStatus(AEI18n.t('未发现可清理文件（') + failedPaths.length + AEI18n.t(' 个路径被安全校验拒绝）'), 'error', { autoHideMs: 8000 });
            } else {
                showStatus(AEI18n.t('未发现非脚本文件'), 'success');
            }
            return;
        }

        var msg = AEI18n.t('发现 {n} 个非脚本文件', { n: junkFiles.length });
        if (emptyDirs.length > 0) {
            msg += AEI18n.t('、{n} 个关联空文件夹', { n: emptyDirs.length });
        }
        msg += AEI18n.t('，确认清理？');

        showConfirm(AEI18n.t('清理非脚本文件'), msg, 'confirm').then(function (ok) {
            if (!ok) return;
            var total = junkFiles.length + emptyDirs.length;
            var noticeId = 'clean-non-script';
            var AENotice = window.AENotice;
            if (AENotice && typeof AENotice.show === 'function') {
                AENotice.show({
                    id: noticeId,
                    icon: '🧹',
                    title: AEI18n.t('清理非脚本文件'),
                    message: AEI18n.t('正在清理…'),
                    tone: 'info',
                    dismissible: false,
                    progress: 0,
                    progressLabel: '0 / ' + total
                });
            }
            var deleted = 0;
            var removedDirs = 0;
            var idx = 0;
            // 用异步步骤让进度条有机会渲染
            function step() {
                if (idx >= junkFiles.length) return finalize();
                if (AEFS.deleteFileSync(junkFiles[idx])) {
                    deleted++;
                } else {
                    failedPaths.push(junkFiles[idx]);
                }
                idx++;
                if (AENotice && typeof AENotice.update === 'function') {
                    AENotice.update(noticeId, {
                        progress: (deleted + removedDirs) / total * 100,
                        progressLabel: (deleted + removedDirs) + ' / ' + total
                    });
                }
                setTimeout(step, 0);
            }
            function finalize() {
                var dirIdx = 0;
                function dirStep() {
                    if (dirIdx >= emptyDirs.length) return done();
                    if (AEFS.rmdirSync(emptyDirs[dirIdx])) {
                        removedDirs++;
                    } else {
                        failedPaths.push(emptyDirs[dirIdx]);
                    }
                    dirIdx++;
                    if (AENotice && typeof AENotice.update === 'function') {
                        AENotice.update(noticeId, {
                            progress: (deleted + removedDirs) / total * 100,
                            progressLabel: (deleted + removedDirs) + ' / ' + total
                        });
                    }
                    setTimeout(dirStep, 0);
                }
                dirStep();
            }
            function done() {
                if (AENotice && typeof AENotice.close === 'function') {
                    AENotice.close(noticeId);
                }
                var resultMsg = AEI18n.t('已清理 {done}/{total} 个非脚本文件', { done: deleted, total: junkFiles.length });
                if (emptyDirs.length > 0) {
                    resultMsg += AEI18n.t('、{done}/{total} 个空文件夹', { done: removedDirs, total: emptyDirs.length });
                }
                var failedCount = failedPaths.length;
                if (failedCount > 0) {
                    resultMsg += AEI18n.t('（{n} 个失败）', { n: failedCount });
                    console.warn('[ScriptTree] cleanNonScriptFiles 失败路径:', failedPaths);
                }
                showStatus(resultMsg, failedCount > 0 ? 'error' : 'success', { autoHideMs: failedCount > 0 ? 8000 : undefined });
                refreshTree();
            }
            step();
        });
    }

    // ====== New / Delete / Rename ======

    // validateName 已移至 agent/scripts/scriptSecurity.js，顶部 var 引用

    function newFolder(parentPath) {
        if (!parentPath) {
            parentPath = normalizeScriptDir(getDefaultScriptDir());
        }
        // Inline creation
        var container = document.getElementById('scriptTree');
        if (!container) return;
        var row = document.createElement('div');
        row.className = 'tree-inline-input-row';
        var icon = document.createElement('span');
        icon.className = 'tree-block-icon';
        icon.className = 'tree-block-icon folder-icon';
        row.appendChild(icon);
        var input = document.createElement('input');
        input.placeholder = AEI18n.t('文件夹名称...');
        row.appendChild(input);
        var hint = document.createElement('span');
        hint.className = 'tree-inline-input-hint';
        hint.textContent = 'Enter ↵';
        row.appendChild(hint);

        var afterEl = (function(c){var all=c.querySelectorAll('.tree-section-title');return all[all.length-1]})(container);
        if (afterEl && afterEl.parentNode) {
            afterEl.parentNode.insertBefore(row, afterEl.nextSibling);
        } else {
            container.insertBefore(row, container.firstChild);
        }
        input.focus();

        var done = false;
        var submit = function () {
            if (done) return; done = true;
            var name = input.value.trim();
            if (!name) { row.remove(); return; }
            if (!validateName(name)) { row.remove(); showStatus(AEI18n.t('文件夹名包含非法字符'), 'error'); return; }
            // Auto-deduplicate: myfolder → myfolder_2 → myfolder_3 ...
            var base = name;
            var fullPath = parentPath.replace(/[\\\/]+$/, '') + '/' + base;
            var n = 1;
            while (AEFS.existsSync(fullPath)) {
                n++;
                base = name + '_' + n;
                fullPath = parentPath.replace(/[\\\/]+$/, '') + '/' + base;
            }
            row.remove();
            if (AEFS.mkdirSync(fullPath)) {
                showStatus(n > 1 ? AEI18n.t('已创建文件夹: ') + base + AEI18n.punct('（', ' (') + name + AEI18n.t(' 已存在）') : AEI18n.t('已创建文件夹: ') + base, 'success');
                refreshTree();
            } else { showStatus(AEI18n.t('创建文件夹失败 — ') + (AEFS.lastError() || AEI18n.t('未知错误')), 'error', { autoHideMs: 5200 }); }
        };
        var cancel = function () {
            if (done) return; done = true;
            row.remove();
        };
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', function () { submit(); });
    }

    function newScript(parentPath) {
        if (!parentPath) {
            parentPath = normalizeScriptDir(getDefaultScriptDir());
        }
        // Inline creation
        var container = document.getElementById('scriptTree');
        if (!container) return;
        var row = document.createElement('div');
        row.className = 'tree-inline-input-row';
        var icon = document.createElement('span');
        icon.className = 'tree-block-icon';
        icon.className = 'tree-block-icon file-icon';
        row.appendChild(icon);
        var input = document.createElement('input');
        input.placeholder = AEI18n.t('脚本名称...');
        row.appendChild(input);
        var hint = document.createElement('span');
        hint.className = 'tree-inline-input-hint';
        hint.textContent = 'Enter ↵';
        row.appendChild(hint);
        var afterEl = (function(c){var all=c.querySelectorAll('.tree-section-title');return all[all.length-1]})(container);
        if (afterEl && afterEl.parentNode) {
            afterEl.parentNode.insertBefore(row, afterEl.nextSibling);
        } else {
            container.insertBefore(row, container.firstChild);
        }
        input.focus();

        var done = false;
        var submit = function () {
            if (done) return; done = true;
            var baseName = input.value.trim() || 'generated_script_' + Date.now();
            var stripped = baseName.replace(/\.(jsx|jsxbin)$/i, '');
            if (!stripped) { row.remove(); return; }
            if (!validateName(stripped)) { row.remove(); showStatus(AEI18n.t('脚本名称包含非法字符'), 'error', { autoHideMs: 4000 }); return; }
            // Auto-deduplicate: myscript.jsx → myscript_2.jsx → myscript_3.jsx ...
            var base = stripped;
            var scriptName = base + '.jsx';
            var fullPath = parentPath.replace(/[\\\/]+$/, '') + '/' + scriptName;
            var n = 1;
            var parentDir = parentPath.replace(/[\\\/]+$/, '');
            while (AEFS.existsSync(fullPath) || AEFS.existsSync(parentDir + '/' + base + '.jsxbin')) {
                n++;
                base = stripped + '_' + n;
                scriptName = base + '.jsx';
                fullPath = parentDir + '/' + scriptName;
            }
            row.remove();
            AEFS.mkdirSync(parentPath);
            if (AEFS.writeFileSync(fullPath, '// ' + scriptName + '\n')) {
                showStatus(n > 1 ? AEI18n.t('已创建脚本: ') + scriptName + AEI18n.punct('（', ' (') + stripped + AEI18n.t(' 已存在）') : AEI18n.t('已创建脚本: ') + scriptName, 'success');
                refreshTree();
            } else { showStatus(AEI18n.t('创建脚本失败 — ') + (AEFS.lastError() || AEI18n.t('未知错误')), 'error', { autoHideMs: 5200 }); }
        };
        var cancel = function () {
            if (done) return; done = true;
            row.remove();
        };
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', function () { submit(); });
    }

    function deleteOne(filePath, fileName) {
        showConfirm(AEI18n.t('确认删除'), AEI18n.t('确认要删除脚本「') + (fileName || filePath) + AEI18n.t('」吗？'), 'confirm').then(function (ok) {
            if (!ok) return;
            if (AEFS.deleteFileSync(filePath)) {
                showStatus(AEI18n.t('已删除脚本: ') + (fileName || filePath), 'success');
                refreshTree();
            } else { showStatus(AEI18n.t('删除脚本失败 — ') + (AEFS.lastError() || AEI18n.t('未知错误')), 'error', { autoHideMs: 5200 }); }
        });
    }

    function beginRename(node) {
        // 属性值转义（\ 与 "）——文件名/路径含引号时选择器非法，querySelector
        // 直接抛 SyntaxError 中断重命名入口
        var sel = '.tree-file-row[data-path="' + node.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
        var row = document.querySelector(sel);
        if (!row) {
            sel = '.tree-folder-row[data-path="' + node.path.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]';
            row = document.querySelector(sel);
        }
        if (!row) return;
        var nameEl = row.querySelector('.tree-block-name');
        if (!nameEl) return;
        var baseName = (node.name || '').replace(/\.(jsx|jsxbin)$/i, '');
        var input = document.createElement('input');
        input.className = 'script-rename-input';
        input.value = baseName;
        input.style.cssText = 'flex:1 1 auto;min-width:0;height:24px;font-size:12px;padding:0 4px;background:var(--input-bg);border:1px solid var(--accent);border-radius:3px;color:var(--text-main);';
        row.replaceChild(input, nameEl);
        // done 守卫（对齐 newFolder/newScript）——Enter 提交成功后
        // refreshTree→renderTree 重建 DOM 会移除聚焦的 input 触发二次 blur→submit，
        // 对已改名的旧路径再发 renameFileSync → 失败误报「重命名失败」
        var done = false;
        var submit = function () {
            if (done) return;
            var newName = input.value.trim();
            // 非法名不抢焦点（防 blur→submit→focus 焦点陷阱）；点击空白放弃由 blur 分支处理
            if (!validateName(newName)) { showStatus(AEI18n.t('名称包含非法字符'), 'error'); return; }
            done = true;
            var normalized = (node.name || '').toLowerCase().endsWith('.jsxbin') ? newName + '.jsxbin' : newName + '.jsx';
            if (normalized === node.name) { renderTree(); return; }
            doRename(node.path, node.name, normalized);
        };
        var cancel = function () {
            if (done) return;
            done = true;
            renderTree();
        };
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') { e.preventDefault(); submit(); }
            else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        // blur（点击空白）时非法名直接放弃编辑恢复原名，不再抢回焦点形成陷阱
        input.addEventListener('blur', function () {
            if (!validateName(input.value.trim())) { cancel(); return; }
            submit();
        });
        input.focus();
        input.select();
    }

    function doRename(filePath, oldName, newName) {
        var parentDir = filePath.replace(/\\/g, '/').replace(/\/[^\/]+$/, '');
        var dstPath = parentDir + '/' + newName;
        // Check for duplicate (case-insensitive, skip if same file)
        if (filePath.replace(/\\/g, '/').toLowerCase() !== dstPath.replace(/\\/g, '/').toLowerCase() && AEFS.existsSync(dstPath)) {
            showStatus(AEI18n.punct('「', '"', '「', '„', '“', '« ', '«') + newName + AEI18n.t('」已存在'), 'error');
            renderTree(); // restore DOM
            return;
        }
        if (AEFS.renameFileSync(filePath, dstPath)) {
            showStatus(AEI18n.t('已重命名为: ') + newName, 'success');
            refreshTree();
        } else {
            showStatus(AEI18n.t('重命名失败 — ') + (AEFS.lastError() || AEI18n.t('未知错误')), 'error', { autoHideMs: 5200 });
            renderTree(); // restore DOM
        }
    }

    // ====== Entry Point & Bind ======

    function bindEvents() {
        var si = document.getElementById('scriptSearch');
        if (si) {
            si.addEventListener('input', function () { applySearch(this.value); });
            si.addEventListener('keydown', function (e) { if (e.key === 'Escape') { this.value = ''; applySearch(''); } });
        }
        var sc = document.getElementById('scriptSearchClear');
        if (sc) {
            sc.addEventListener('click', function () { var si2 = document.getElementById('scriptSearch'); if (si2) { si2.value = ''; applySearch(''); } });
        }
        bindContextMenu();

        // 工具栏操作按钮已由浏览区标题栏 + 右键菜单替代，全部隐藏
        var toolbarBtns = ['scriptNewFileBtn', 'scriptNewFolderBtn', 'scriptBatchDeleteBtn', 'scriptBatchMoveBtn'];
        for (var t = 0; t < toolbarBtns.length; t++) {
            var tb = document.getElementById(toolbarBtns[t]);
            if (tb) tb.style.display = 'none';
        }

        var tc = document.getElementById('scriptTree');
        if (tc) {
            tc.addEventListener('dragover', function (e) {
                if (!e.dataTransfer.types || e.dataTransfer.types.indexOf('application/x-ae-script-tree') === -1) return;
                if (e.target.closest('.tree-file-row') || e.target.closest('.tree-folder-row')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
            });
            tc.addEventListener('drop', function (e) {
                if (!e.dataTransfer.types || e.dataTransfer.types.indexOf('application/x-ae-script-tree') === -1) return;
                if (e.target.closest('.tree-file-row') || e.target.closest('.tree-folder-row')) return;
                e.preventDefault();
                var sp = treeState.dragSourcePath;
                var st = treeState.dragSourceType;
                var scriptDir = normalizeScriptDir(getDefaultScriptDir());
                if (!sp || !scriptDir) return;
                var srcP = sp.replace(/\\/g, '/').replace(/\/[^\/]+$/, '');
                if (srcP.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() === scriptDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()) return;
                if (st === 'script' && treeState.dragSelectedSet && Object.keys(treeState.dragSelectedSet).length > 1) {
                    executeBatchMoveToFolder(scriptDir);
                } else if (st === 'script') {
                    executeMoveFile(sp, scriptDir);
                } else if (st === 'folder') {
                    executeMoveFolder(sp, scriptDir);
                }
            });
            // Click on empty space → deselect all
            tc.addEventListener('click', function (e) {
                if (e.target.closest('.tree-file-row') || e.target.closest('.tree-folder-row') || e.target.closest('.tree-recent-row')) return;
                if (Object.keys(treeState.selectedSet).filter(function(k){return treeState.selectedSet[k]}).length > 0) {
                    treeState.selectedSet = {};
                    renderTree();
                }
            });
        }
    }

    function init() {
        initTreeState();
        loadRecent();
        bindEvents();
        refreshTree();
    }

    // ====== Exports ======
    return { init: init, refresh: refreshTree, loadIntoPreview: loadIntoPreview };
})();
