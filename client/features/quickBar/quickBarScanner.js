// quickBarScanner.js — 4 类数据扫描
(function (global) {
    'use strict';

    var SCAN_TIMEOUT_MS = 8000;
    var DEPTH_MAX = 20;

    // 复用 ScriptTree 的路径解码与校验（不依赖 ScriptTree 内部，独立实现一份避免循环依赖）
    function _tryDecodeUri(str) {
        try { return decodeURIComponent(str); } catch (_) { return str; }
    }

    function _checkPathSafe(p) {
        if (!p || typeof p !== 'string') return false;
        if (p.indexOf('%') !== -1) return false;
        for (var i = 0; i < p.length; i++) {
            var c = p.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F || c === 0x22 || c === 0x27) return false;
        }
        if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(p)) return false;
        if (/(^|[\\\/\:])\.([\\\/\:]|$)/.test(p)) return false;
        if (!/^[A-Za-z]:[\\\/]/.test(p) && !/^file:\/+/i.test(p)) return false;
        var segs = p.replace(/[\\\/]+/g, '/').replace(/\/+$/, '').split('/');
        for (var j = 0; j < segs.length; j++) {
            var upper = segs[j].replace(/\..*$/, '').toUpperCase();
            if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' ||
                /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return false;
        }
        return true;
    }

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

    function _getDataDir() {
        try {
            if (global.AEShared && global.AEShared.getDataDir) {
                return global.AEShared.getDataDir().dir || '';
            }
        } catch (_) {}
        return '';
    }

    function _getScriptDir() {
        // 脚本目录固定使用数据目录 agent/scripts（不再支持用户自定义）
        // 注意：ScriptTree 只暴露 {init, refresh}，不提供 getDefaultScriptDir
        if (typeof getDefaultScriptDir === 'function') {
            try { return getDefaultScriptDir() || ''; } catch (_) {}
        }
        return '';
    }

    function _isDangerousScriptDir(p) {
        if (!p) return true;
        var fwd = String(p).replace(/\\/g, '/').toLowerCase();
        if (fwd.indexOf('c:/windows') === 0) return true;
        if (fwd.indexOf('c:/program files') === 0) return true;
        if (fwd.indexOf('c:/programdata') === 0) return true;
        // C:/Users 浅层目录（depth ≤ 2）禁用
        if (fwd.indexOf('c:/users/') === 0) {
            var segs = fwd.split('/').filter(function (s) { return !!s; });
            if (segs.length <= 2) return true;
        }
        return false;
    }

    // ===== scripts 扫描：递归遍历 .jsx/.jsxbin =====
    function scanScripts() {
        return new Promise(function (resolve) {
            var scriptDir = _getScriptDir();
            if (!scriptDir || _isDangerousScriptDir(scriptDir)) {
                resolve({ items: [], error: scriptDir ? 'dangerous' : 'no-dir' });
                return;
            }
            if (!_checkPathSafe(scriptDir)) {
                resolve({ items: [], error: 'invalid-path' });
                return;
            }
            if (typeof CSInterface === 'undefined') {
                resolve({ items: [], error: 'no-csinterface' });
                return;
            }

            var settled = false;
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                resolve({ items: [], error: 'timeout' });
            }, SCAN_TIMEOUT_MS);

            // 直接递归扫描（ScriptTree 仅暴露 init/refresh，不提供 scanTree）
            _scanScriptsViaExtendScript(scriptDir, function (items, err) {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ items: items || [], error: err });
            });
        });
    }

    function _extractFolder(rootPath, fullPath) {
        try {
            var root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
            var full = fullPath.replace(/\\/g, '/');
            if (full.indexOf(root) !== 0) return '';
            var rel = full.slice(root.length).replace(/^\/+/, '');
            var segs = rel.split('/');
            if (segs.length <= 1) return '';
            return segs.slice(0, -1).join('/');
        } catch (_) { return ''; }
    }

    function _scanScriptsViaExtendScript(dirPath, callback) {
        // 统一走 AEFS.scanTree（含 _checkPath 安全校验 + ExtendScript 递归扫描）
        if (!global.AEFS || typeof global.AEFS.scanTree !== 'function') {
            callback([], AEI18n.t('AEFS.scanTree 不可用'));
            return;
        }
        global.AEFS.scanTree(dirPath, DEPTH_MAX).then(function (tree) {
            if (!tree) { callback([], null); return; }
            try {
                var items = [];
                _flattenScriptTree(tree, '', function (item) { items.push(item); });
                callback(items, null);
            } catch (e) { callback([], 'parse-error'); }
        }).catch(function () { callback([], 'exception'); });
    }

    function _readJsonFile(path) {
        return new Promise(function (resolve) {
            if (!global.AEFS || typeof global.AEFS.readFile !== 'function') {
                resolve(null);
                return;
            }
            global.AEFS.readFile(path).then(function (raw) {
                if (!raw) { resolve(null); return; }
                try { resolve(JSON.parse(raw)); } catch (e) {
                    console.warn('[QuickBar] JSON 解析失败: ' + path);
                    resolve(null);
                }
            }).catch(function () { resolve(null); });
        });
    }

    function _exists(path) {
        return new Promise(function (resolve) {
            if (!global.AEFS || typeof global.AEFS.exists !== 'function') {
                resolve(true); // 无法校验时默认存在
                return;
            }
            global.AEFS.exists(path).then(function (ok) { resolve(ok !== false); })
                .catch(function () { resolve(true); });
        });
    }

    // 批量存在性探测：一次真异步往返替代逐条 _exists（几万素材时不冻结 UI）。
    // AEFS.existsBatch 不可用时回退逐条 _exists。返回 legal 长度数组（缺失按存在=true 处理，
    // 与 _exists 默认存在语义对齐，避免无法校验时误标 missing）。
    function _existsBatch(paths) {
        if (!paths || !paths.length) return Promise.resolve([]);
        if (global.AEFS && typeof global.AEFS.existsBatch === 'function') {
            return global.AEFS.existsBatch(paths).then(function (arr) {
                if (!Array.isArray(arr)) return paths.map(function () { return true; });
                while (arr.length < paths.length) arr.push(true);   // 防御性补齐
                return arr.map(function (ok) { return ok !== false; });
            }).catch(function () {
                return paths.map(function () { return true; });
            });
        }
        return Promise.all(paths.map(_exists));
    }

    function _normalizeName(name) {
        if (!name) return '';
        return String(name).replace(/\.(ffx|aep|aet)$/i, '');
    }

    // ===== presets 扫描 =====
    function scanPresets() {
        return _readJsonFile(_getDataDir() + '/assets/presets/index.json').then(function (data) {
            if (!data || !Array.isArray(data.items)) return { items: [], error: null };
            // 归档条目（archived）不进快捷栏——本扫描器直读索引，绕过了 store.list()
            var items = data.items.filter(function (it) { return !it.archived; });
            return _existsBatch(items.map(function (it) { return it.ffxPath; })).then(function (oks) {
                return items.map(function (it, i) {
                    return {
                        id: it.id || it.ffxPath,
                        name: _normalizeName(it.name),
                        folder: it.folder || '',
                        path: it.ffxPath,
                        type: 'preset',
                        meta: {
                            size: it.size,
                            missing: !oks[i]
                        }
                    };
                });
            }).then(function (list) { return { items: list, error: null }; });
        });
    }

    // ===== projects 扫描 =====
    function scanProjects() {
        return _readJsonFile(_getDataDir() + '/assets/project-assets/index.json').then(function (data) {
            if (!data || !Array.isArray(data.items)) return { items: [], error: null };
            // 归档条目（archived）不进快捷栏
            var items = data.items.filter(function (it) { return !it.archived; });
            return _existsBatch(items.map(function (it) { return it.aepPath; })).then(function (oks) {
                return items.map(function (it, i) {
                    return {
                        id: it.id || it.aepPath,
                        name: _normalizeName(it.name),
                        folder: it.folder || '',
                        path: it.aepPath,
                        type: 'project',
                        meta: {
                            sourceType: it.sourceType,
                            missing: !oks[i]
                        }
                    };
                });
            }).then(function (list) { return { items: list, error: null }; });
        });
    }

    // ===== refs 扫描 =====
    function scanRefs() {
        return _readJsonFile(_getDataDir() + '/assets/asset-refs/refs.json').then(function (data) {
            if (!data || !Array.isArray(data.items)) return { items: [], error: null };
            // 归档条目（archived）不进快捷栏
            var items = data.items.filter(function (it) { return !it.archived; });
            return _existsBatch(items.map(function (it) { return it.originalPath; })).then(function (oks) {
                return items.map(function (it, i) {
                    return {
                        id: it.id || it.originalPath,
                        name: _normalizeName(it.name),
                        folder: it.folder || '',
                        path: it.originalPath,
                        type: 'ref',
                        meta: {
                            size: it.size,
                            sourceType: it.sourceType,
                            missing: !oks[i]
                        }
                    };
                });
            }).then(function (list) { return { items: list, error: null }; });
        });
    }

    function _flattenScriptTree(node, folder, fn) {
        if (!node) return;
        var allDirs = node.d || [];
        var dirs = [];
        for (var di = 0; di < allDirs.length; di++) {
            if (allDirs[di].n !== '__order__') dirs.push(allDirs[di]);
        }
        dirs.sort(function (a, b) { return (a.n || '').toLowerCase().localeCompare((b.n || '').toLowerCase()); });
        var files = node.f || [];
        files.sort(function (a, b) { return (a.n || '').toLowerCase().localeCompare((b.n || '').toLowerCase()); });
        for (var i = 0; i < files.length; i++) {
            fn({
                id: files[i].p,
                name: _tryDecodeUri(files[i].n).replace(/\.jsxbin?$/i, '').replace(/\.jsx$/i, ''),
                folder: folder,
                path: files[i].p,
                type: 'script',
                meta: {}
            });
        }
        for (var j = 0; j < dirs.length; j++) {
            _flattenScriptTree(dirs[j], folder ? folder + '/' + dirs[j].n : dirs[j].n, fn);
        }
    }

    // ===== 公共 API =====
    function scan(category) {
        if (category === 'scripts') return scanScripts();
        if (category === 'presets') return scanPresets();
        if (category === 'projects') return scanProjects();
        if (category === 'refs') return scanRefs();
        return Promise.resolve({ items: [], error: 'unknown-category' });
    }

    global.AEQuickBarScanner = {
        scan: scan,
        scanScripts: scanScripts,
        scanPresets: scanPresets,
        scanProjects: scanProjects,
        scanRefs: scanRefs,
        fuzzyMatch: _fuzzyMatch
    };
})(window);
