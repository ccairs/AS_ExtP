(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    var NS = 'project-assets';

    // 索引字段 sourceName 的固定源文：落盘值与界面语言无关（t() 只在显示侧查询；
    // 旧数据可能是任何语言的同值文本，读侧不比较、不迁移）。
    var SOURCE_NAME_PROJECT = '工程';
    var SOURCE_NAME_BUNDLE = '工程包';

    function _norm(f) { return String(f || '').replace(/^\/+|\/+$/g, ''); }
    // 归档态判定（热路径内联判据；语义与 AEAssetsShared.isArchived 一致）
    function _isArch(it) { return !!(it && it.archived); }
    function _genId() { return 'pa_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
    function _now() { return new Date().toISOString(); }

    // 纯函数：aep 文件名 → 基名（去 .aep）
    function assetBaseName(fileName) {
        return String(fileName || '').replace(/\.aep$/i, '');
    }

    // ── 共享目录检测：拖入 / 孤儿标准化 / 垃圾检测三处共用 ──
    // 规则：AE 打包标准 = 1 .aep + 1 资产文件夹 + txt报告（非.aep忽略）
    //   只有 .aep（N个）      → projects，N 个独立工程
    //   只有子文件夹           → container，递归深入
    //   1 .aep + 1 子文件夹    → projects，1 个工程包（子文件夹是资产）
    //   1 .aep + 多子文件夹    → invalid（非标准 AE 打包结构）
    //   N≥2 .aep + 子文件夹    → invalid（多个工程争资产）
    async function classifyDir(AEFS, dirPath) {
        var files = [];
        try { files = await (AEFS.listFilesAsync ? AEFS.listFilesAsync(dirPath) : AEFS.listFiles(dirPath)); } catch (_) { files = []; }
        var aeps = [];
        for (var i = 0; i < files.length; i++) {
            if (/\.aep$/i.test(files[i])) aeps.push(files[i]);
        }
        var subDirs = [];
        try { subDirs = await (AEFS.listDirsAsync ? AEFS.listDirsAsync(dirPath) : AEFS.listDirs(dirPath)); } catch (_) { subDirs = []; }

        if (aeps.length === 0 && subDirs.length === 0) {
            return { type: 'empty' };
        }
        if (aeps.length === 0) {
            return { type: 'container', subDirs: subDirs };
        }
        if (subDirs.length === 0) {
            return { type: 'projects', projects: aeps.map(function (fn) { return { name: fn, hasAssets: false }; }) };
        }
        if (aeps.length === 1 && subDirs.length === 1) {
            return { type: 'projects', projects: [{ name: aeps[0], hasAssets: true, assetDir: subDirs[0] }] };
        }
        return { type: 'invalid', reason: AEI18n.t('结构非标准 AE 打包（应为 1 .aep + 1 资产文件夹）') };
    }

    // 递归遍历：projects → onProject(dirPath, project)；invalid → onInvalid(dirPath, reason)；container → 递归；empty → 跳过
    // onProgress 在本目录处理完成后才触发（"已检查 N 个目录"计完整处理的目录），
    // isCancelled 每层入口检查——取消只中止尚未开始的目录，正在处理的目录（含其 onProject）
    // 先跑完，取消时已发现的工程不丢失。
    async function walkDir(AEFS, dirPath, callbacks) {
        var onProject = callbacks.onProject || function () {};
        var onInvalid = callbacks.onInvalid || function () {};
        var onProgress = callbacks.onProgress || null;
        // isCancelled() 可选：返回 true 时中止遍历（每层入口检查，递归调用自然短路）
        var isCancelled = callbacks.isCancelled || null;
        if (isCancelled && isCancelled()) return;
        var cls = await classifyDir(AEFS, dirPath);
        if (cls.type === 'projects') {
            for (var i = 0; i < cls.projects.length; i++) {
                await onProject(dirPath, cls.projects[i]);
            }
        } else if (cls.type === 'container') {
            for (var d = 0; d < cls.subDirs.length; d++) {
                if (isCancelled && isCancelled()) break;
                await walkDir(AEFS, dirPath + '/' + cls.subDirs[d], callbacks);
            }
        } else if (cls.type === 'invalid') {
            await onInvalid(dirPath, cls.reason);
        }
        if (onProgress) onProgress();
    }

    // 判断目录树里是否包含至少一个合法工程（垃圾检测用）
    async function hasValidProject(AEFS, dirPath) {
        var cls = await classifyDir(AEFS, dirPath);
        if (cls.type === 'projects') return true;
        if (cls.type === 'container') {
            for (var d = 0; d < cls.subDirs.length; d++) {
                if (await hasValidProject(AEFS, dirPath + '/' + cls.subDirs[d])) return true;
            }
        }
        return false;
    }

    global.AEAssetsShared.assetBaseName = assetBaseName;
    global.AEAssetsShared.classifyDir = classifyDir;
    global.AEAssetsShared.walkDir = walkDir;
    global.AEAssetsShared.hasValidProject = hasValidProject;

    // opts: { AEFS, dataDir, hostApi }
    function createProjectAssetStore(opts) {
        opts = opts || {};
        var _AEFS = opts.AEFS || global.AEFS;
        var dataDir = opts.dataDir || (global.AEShared && global.AEShared.getDataDir ? global.AEShared.getDataDir().dir : '');
        var _base = String(dataDir).replace(/\\/g, '/').replace(/\/+$/, '') + '/assets/' + NS;
        // 垃圾区：所有垃圾统一移入 _base/___trash__/ 文件夹内（跨目录无法原子 rename，copy+delete 实现 move）。
        // TRASH_PREFIX 为旧方案的就地改名前缀，遗留带前缀条目会被垃圾检测并入垃圾区文件夹。
        var TRASH_PREFIX = '___trash__';
        var TRASH_DIR = TRASH_PREFIX;
        // 归档区（删除=归档）：与垃圾区同层的系统目录。
        // 结构性排除点：标准化 ①②④ 不碰、垃圾检测不列、_discoverOrphans 类扫描不存在于本库。
        var ARCHIVE_DIR = global.AEAssetsShared.ARCHIVE_DIR_NAME;
        var _items = [];
        // 上次清扫留痕：{ at, deleted, failed, kept }——UI 归档面板头部展示
        var _lastSweep = null;
        var _indexPath = _base + '/index.json';
        // 预览帧协作件：落盘 / 删除 / 回收统一走 previewStore（两库同形，见该文件头）。
        // 落点是**库外**独立根 <dataDir>/assets/previews/project-assets/<id>/preview.jpg——
        // 不写进条目目录，因为 classifyDir 判「1 .aep + 多子目录 → invalid」，预览子目录会让
        // 条目被当垃圾移走；写条目目录根部虽可行，但与预设库形成两套路径/两套生命周期。
        // 懒解析：manifest 里 previewStore.js 先于本文件加载，生产环境必然可用；只加载本文件
        // 的沙箱里可能缺失，此时预览相关动作降级为 no-op 并 warn 一次（不静默）。预览是附加物，
        // 缺它不该让素材库主功能构造失败。
        var _preview = null;
        var _previewWarned = false;
        function _previewStore() {
            if (_preview) return _preview;
            var SH = global.AEAssetsShared;
            if (!SH || typeof SH.createPreviewStore !== 'function') {
                if (!_previewWarned) {
                    _previewWarned = true;
                    console.warn('[projectAssetStore] previewStore 未加载：预览帧删除/回收降级为 no-op');
                }
                return null;
            }
            _preview = SH.createPreviewStore({ AEFS: _AEFS, dataDir: dataDir, lib: 'project-assets' });
            return _preview;
        }
        // 已迁移但删除失败的旧 .aep 路径（防跨 load 重复 copy）
        var _migratedSources = [];
        // 标准化阶段非法文件名 toast 会话级去重——每次 load 都跑 _standardize，
        // 同一非法文件名无去重会持续弹 toast 轰炸（键为 .aep 完整路径）
        var _stdToastShown = {};
        var _fm = global.AEAssetsShared.createFolderStoreMixin({
            AEFS: _AEFS,
            foldersPath: _base + '/.folders.json',
            logTag: '[projectAssetStore]',
            // 空文件夹判定的批量数据源：listEmptyFolders 用它一次扫描建"含条目文件夹集合"
            // （旧路径对每条文件夹记录全量扫 _items，万级条目下是秒级；折叠/展开都会触发）。
            // list() 已排除归档条目，与 hasEntries 口径一致。
            listEntries: function () { return list(); },
            // 空文件夹判定：其下有条目（含子层级）的文件夹不是空文件夹（防 removeFolder 假空校验）
            // 归档条目不算条目（归档整夹后原虚拟文件夹应自然消失/可被 removeFolder 清理）
            // 注：注入 listEntries 后本函数只作兼容回退（未注入时的旧路径）。
            hasEntries: function (fp) {
                var n = String(fp || '').replace(/^\/+|\/+$/g, '');
                return _items.some(function (x) {
                    if (_isArch(x)) return false;
                    var f = String(x.folder || '').replace(/^\/+|\/+$/g, '');
                    return f === n || (n.length > 0 && f.indexOf(n + '/') === 0);
                });
            }
        });
        var _folders = _fm._folders;

        // 写串行化：共享 index.json，并发写会互相覆盖丢数据
        var _writeQueue = Promise.resolve();
        function _serialized(fn) {
            var p = _writeQueue.then(fn, fn);
            _writeQueue = p.then(function () {}, function () {});
            return p;
        }

        function getBaseDir() { return _base; }
        // list() 默认排除归档条目（归档区对常规读路径/UI 树不可见；
        // 归档条目经 listArchive() 或 getById() 访问）
        function list() { return _items.filter(function (x) { return !_isArch(x); }); }
        function getLastSweep() { return _lastSweep; }

        function listArchive() { return _items.filter(function (x) { return _isArch(x); }).slice(); }

        // 归档区内未登记项（盘上有、索引无）：不删、不自动登记，仅报告（fail-safe 可见性）
        async function listUnregisteredArchive() {
            var out = [];
            var archiveDir = _archiveDirPath();
            var files = [];
            try { files = await _AEFS.listFilesAsync(archiveDir); } catch (_) { return out; }
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(archiveDir); } catch (_) { subDirs = []; }
            var all = (files || []).concat(subDirs || []);
            for (var i = 0; i < all.length; i++) {
                var p = archiveDir + '/' + all[i];
                var known = _items.some(function (x) { return x.targetFolder === p || x.aepPath === p; });
                if (!known) out.push(p);
            }
            return out;
        }
        function getById(id) {
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) return _items[i];
            }
            return null;
        }

        async function load() {
            return _serialized(function () { return _loadInner(); });
        }
        async function _loadInner() {
            // 三态读取（单点助手 readManifestThreeState）——读失败
            // （CHANNEL_FAILURE/REJECTED）时中止本次加载：旧路径把读失败折叠为空索引，
            // 随后 _standardize 重建落盘 + _flushIndex 覆盖 index.json，用户维护的
            // notes 等元数据永久丢失（且此分支无 .corrupt.bak 保护）。
            // NOT_FOUND（真没有）/ok('')（空文件）按空重建，与旧 readFile null
            // 折叠口径逐字等价。
            var rs = await global.AEAssetsShared.readManifestThreeState(_AEFS, _indexPath);
            if (rs.state === 'failed') {
                throw new Error(AEI18n.t('工程素材库 index.json 读取失败(') + rs.code + (rs.channel ? '@' + rs.channel : '') + AEI18n.t(')，已中止加载以防覆盖'));
            }
            var raw = rs.raw;
            if (!raw) { _items = []; _migratedSources = []; }
            else {
                try {
                    var data = JSON.parse(raw);
                    _items = Array.isArray(data && data.items) ? data.items : [];
                    _migratedSources = Array.isArray(data && data.migratedSources) ? data.migratedSources : [];
                } catch (e) {
                    // 解析失败先保留 .corrupt.bak 再置空（不再静默）——其后
                    // _standardize 重建落盘会覆盖损坏文件，用户维护的 notes 等
                    // 元数据仅存 .bak 可手工恢复
                    console.warn('[projectAssetStore] index.json 解析失败，已保留损坏文件为 ' + _indexPath + '.corrupt.bak，按空重建: ' + (e && e.message ? e.message : e));
                    _items = []; _migratedSources = [];
                    await global.AEAssetsShared.backupCorruptFile(_AEFS, _indexPath);
                }
            }
            await _dedupById();
            var stdStats = await _standardize();
            await _fm.loadFolders();
            // 预览回收：保留集合 = 当前索引持有的全部 id（存活 ∪ 已归档——归档→恢复往返
            // 期间条目仍在 _items 里带 archived 标志，预览必须留着）。
            // 兜住所有删除挂点够不到的角落：崩溃中断的删除、cleanMissing、missing 分支的
            // 归档、addMeta 覆盖旧 id、_dedupById 重发 id、索引损坏后重建。
            try {
                var _pvGc = _previewStore();
                if (_pvGc) {
                    var _keepIds = [];
                    for (var _pi = 0; _pi < _items.length; _pi++) _keepIds.push(_items[_pi].id);
                    await _pvGc.gc(_keepIds);
                }
            } catch (_) {}
            return stdStats;
        }

        async function _flushIndex() {
            // 原子写（.tmp → rename）——写盘窗口中断不再截断 index.json
            // （否则损坏 → 静默置空 → _standardize 重建 + 覆盖，notes 等元数据丢失固化）
            var ok = await global.AEAssetsShared.atomicWriteJson(_AEFS, _indexPath, JSON.stringify({ version: 1, items: _items, migratedSources: _migratedSources }, null, 2));
            if (!ok) { console.warn('[projectAssetStore] 写 index.json 失败'); throw new Error(AEI18n.t('写入 index.json 失败')); }
        }

        // 同 id 去重：发现重复时给其余条目重新分配 id（不删除数据）
        async function _dedupById() {
            var byId = {};
            for (var i = 0; i < _items.length; i++) {
                var m = _items[i];
                (byId[m.id] = byId[m.id] || []).push(m);
            }
            var ids = Object.keys(byId);
            if (ids.length === _items.length) return;   // 无冲突，零额外 I/O
            var changed = false;
            for (var k = 0; k < ids.length; k++) {
                var group = byId[ids[k]];
                if (group.length === 1) continue;
                console.warn('[projectAssetStore] 检测到重复 id ' + ids[k] + '，重新分配');
                for (var g = 1; g < group.length; g++) {
                    group[g].id = _genId();
                    changed = true;
                }
            }
            if (changed) {
                try { await _flushIndex(); }
                catch (e) { console.warn('[projectAssetStore] _dedupById 写 index.json 失败: ' + (e && e.message ? e.message : e)); }
            }
        }

        // 标准化：扫描 _base，把所有合法工程移到根目录 + 补/更新索引。
        // 规则见 classifyDir。非法结构留给垃圾检测。
        // 关键顺序：先 copy + 更新索引(flushIndex)，成功后才删旧；flushIndex 失败则回滚新 copy，
        // 旧文件还在，下次 load 能恢复，不会产生重复条目。
        async function _standardize() {
            var stdImported = 0;  // 本次新建入库的工程数
            var stdAligned = 0;   // 本次对齐（文件夹名/.aep 文件名/item.name）次数
            // 清理不存在的 migratedSources（旧 .aep 被外部删除等情况）
            if (_migratedSources.length) {
                var validSources = [];
                for (var s = 0; s < _migratedSources.length; s++) {
                    var srcExists = await _AEFS.existsAsync(_migratedSources[s]);
                    if (srcExists) validSources.push(_migratedSources[s]);
                }
                if (validSources.length !== _migratedSources.length) {
                    _migratedSources = validSources;
                    try { await _flushIndex(); } catch (_) {}
                }
            }
            // migratedSet：已迁移但删除失败的旧 .aep 路径（防跨 load 重复 copy）
            var migratedSet = {};
            for (var ms0 = 0; ms0 < _migratedSources.length; ms0++) migratedSet[_migratedSources[ms0]] = true;
            // aepPath → item 映射（快速查找已索引条目）
            var itemByAepPath = {};
            var indexed = {};  // 已处理路径（避免重复）
            for (var k = 0; k < _items.length; k++) {
                if (_items[k].aepPath) itemByAepPath[_items[k].aepPath] = _items[k];
            }

            // ① 处理 _base 根级的裸 .aep（套文件夹，不能 copyDir 整个 _base）
            var rootFiles = [];
            try { rootFiles = await _AEFS.listFilesAsync(_base); } catch (_) { rootFiles = []; }
            for (var r = 0; r < rootFiles.length; r++) {
                if (!/\.aep$/i.test(rootFiles[r])) continue;
                if (String(rootFiles[r]).indexOf(TRASH_PREFIX) === 0) continue;  // 旧方案垃圾遗留，留给垃圾检测并入垃圾区
                var oldAepPath = _base + '/' + rootFiles[r];
                if (indexed[oldAepPath] || migratedSet[oldAepPath]) continue;
                // 归档标识防线（纵深防御）：已被归档条目索引的裸 .aep 不参与标准化——
                // 目录名防线（___archive__ 前缀）之外再按条目 archived 标记判一次，防归档布局
                // 被外部改动（目录改名/手工搬动）时把归档件当活动工程重新入库
                if (_isArch(itemByAepPath[oldAepPath])) continue;
                var bname0 = assetBaseName(rootFiles[r]);
                // 名称校验（与 view 拖入一致，纵深防御：AEFS _checkPath 兜底但拒字符集不同）
                var nameBad0 = global.AEAssetsShared.invalidNameSeg ? global.AEAssetsShared.invalidNameSeg(bname0) : null;
                if (nameBad0) {
                    console.warn('[projectAssetStore] 跳过非法文件名: ' + rootFiles[r] + ' — ' + nameBad0);
                    if (!_stdToastShown[oldAepPath]) {
                        _stdToastShown[oldAepPath] = true;
                        if (typeof AEToast !== 'undefined') AEToast.warn(AEI18n.t('文件「') + rootFiles[r] + AEI18n.t('」含受限字符，无法自动处理，请手动移除或重命名'), { autoHideMs: 5000 });
                    }
                    continue;
                }
                var targetDir0 = await _ensureUniqueDir(bname0, _base);
                if (!targetDir0) continue;
                var mkOk0 = await _AEFS.mkdirAsync(targetDir0);
                if (mkOk0 !== true) { console.warn('[projectAssetStore] 标准化建目录失败: ' + targetDir0); continue; }
                var newAepPath0 = targetDir0 + '/' + rootFiles[r];
                var cpOk0 = await _AEFS.copyFileAsync(oldAepPath, newAepPath0);
                if (!cpOk0) {
                    console.warn('[projectAssetStore] 标准化复制失败: ' + oldAepPath);
                    try { await _AEFS.rmdir(targetDir0); } catch (_) {}
                    continue;
                }
                // 更新/新建索引（flushIndex 成功后才删旧，失败则回滚新 copy）
                var existing0 = itemByAepPath[oldAepPath];
                var indexOk0 = true;
                if (existing0) {
                    var saved0 = { aepPath: existing0.aepPath, targetFolder: existing0.targetFolder, sourceType: existing0.sourceType, sourceName: existing0.sourceName };
                    existing0.aepPath = newAepPath0;
                    existing0.targetFolder = targetDir0;
                    existing0.sourceType = 'import';
                    existing0.sourceName = SOURCE_NAME_PROJECT;
                    try { await _flushIndex(); }
                    catch (e) {
                        existing0.aepPath = saved0.aepPath;
                        existing0.targetFolder = saved0.targetFolder;
                        existing0.sourceType = saved0.sourceType;
                        existing0.sourceName = saved0.sourceName;
                        indexOk0 = false;
                        console.warn('[projectAssetStore] 标准化更新索引失败: ' + newAepPath0);
                    }
                } else {
                    try {
                        await _addMetaInner({
                            name: bname0, folder: '', aepPath: newAepPath0,
                            targetFolder: targetDir0, sourceType: 'import', sourceName: SOURCE_NAME_PROJECT,
                            originalProject: '', size: 0
                        });
                        stdImported++;
                    } catch (e) {
                        console.warn('[projectAssetStore] 标准化索引失败: ' + newAepPath0 + ' — ' + (e && e.message ? e.message : e));
                        indexOk0 = false;
                    }
                }
                if (!indexOk0) {
                    // 回滚新 copy，旧文件还在，下次 load 重试
                    try { await _AEFS.deleteFile(newAepPath0); } catch (_) {}
                    try { await _AEFS.rmdir(targetDir0); } catch (_) {}
                    continue;
                }
                // 索引已持久化，删旧 .aep
                var delOk0 = await _AEFS.deleteFile(oldAepPath);
                if (delOk0 !== true) {
                    // 旧删不掉，记录 migratedSource 防跨 load 重复
                    _migratedSources.push(oldAepPath);
                    migratedSet[oldAepPath] = true;
                    try { await _flushIndex(); } catch (_) {}
                }
                indexed[newAepPath0] = true;
                indexed[oldAepPath] = true;
                itemByAepPath[newAepPath0] = existing0 || true;
            }

            // ② 扫 _base 子目录，walkDir 找深层合法工程
            var topDirs = [];
            try { topDirs = await _AEFS.listDirsAsync(_base); } catch (_) { topDirs = []; }
            for (var d = 0; d < topDirs.length; d++) {
                if (String(topDirs[d]).indexOf(TRASH_PREFIX) === 0) continue;  // 垃圾区文件夹/旧方案遗留不参与标准化（丢弃物不复活入库）
                if (String(topDirs[d]) === ARCHIVE_DIR) continue;   // 归档区不参与标准化（精确匹配：___archive__备份 之类用户目录不误伤）
                var subPath = _base + '/' + topDirs[d];
                await global.AEAssetsShared.walkDir(_AEFS, subPath, {
                    onProject: async function (dirPath, project) {
                        var aepPath = dirPath + '/' + project.name;
                        if (indexed[aepPath] || migratedSet[aepPath]) return;
                        // 归档标识防线（纵深防御）：该 .aep 已被归档条目索引 ⇒ 不参与
                        // 标准化（不改名/不搬回/不重建索引）——与 ① 同款，目录名防线之外的条目级兜底
                        if (_isArch(itemByAepPath[aepPath])) return;
                        var bname = assetBaseName(project.name);
                        // 名称校验（与 view 拖入一致）
                        var nameBad = global.AEAssetsShared.invalidNameSeg ? global.AEAssetsShared.invalidNameSeg(bname) : null;
                        if (nameBad) {
                            console.warn('[projectAssetStore] 跳过非法文件名: ' + project.name + ' — ' + nameBad);
                            if (!_stdToastShown[aepPath]) {
                                _stdToastShown[aepPath] = true;
                                if (typeof AEToast !== 'undefined') AEToast.warn(AEI18n.t('文件「') + project.name + AEI18n.t('」含受限字符，无法自动处理，请手动移除或重命名'), { autoHideMs: 5000 });
                            }
                            return;
                        }
                        var targetDir = await _ensureUniqueDir(bname, dirPath);
                        if (!targetDir) return;
                        var existingItem = itemByAepPath[aepPath];
                        // 已在根级 + 已索引 → 跳过
                        if (dirPath === targetDir && existingItem) {
                            indexed[aepPath] = true;
                            return;
                        }
                        var oldAepPath2 = aepPath;
                        var newAepPath = aepPath;  // 默认不变
                        var moved = false;
                        if (dirPath !== targetDir) {
                            if (project.hasAssets) {
                                // 工程包：整目录 copyDir（携带全部内容，含根级附带文件如 txt 报告）。
                                // 与删除阶段 _removeDir(dirPath) 对称——旧做法只拷 .aep + 资产子目录，
                                // 根级附带文件既未被复制又被整目录删除，造成不可恢复丢失
                                var mkOk = await _AEFS.mkdirAsync(targetDir);
                                if (mkOk !== true) { console.warn('[projectAssetStore] 标准化建目录失败: ' + targetDir); return; }
                                var cpDirOk = await _AEFS.copyDirAsync(dirPath, targetDir);
                                if (!cpDirOk) { console.warn('[projectAssetStore] 标准化复制失败: ' + dirPath); return; }
                            } else {
                                // 裸工程：mkdir + copyFile 单个 .aep
                                var mkOk = await _AEFS.mkdirAsync(targetDir);
                                if (mkOk !== true) { console.warn('[projectAssetStore] 标准化建目录失败: ' + targetDir); return; }
                                var cpOk = await _AEFS.copyFileAsync(aepPath, targetDir + '/' + project.name);
                                if (!cpOk) { console.warn('[projectAssetStore] 标准化复制失败: ' + aepPath); return; }
                            }
                            newAepPath = targetDir + '/' + project.name;
                            moved = true;
                        }
                        // 更新/新建索引（flushIndex 成功后才删旧，失败则回滚新 copy）
                        var indexOk = true;
                        if (existingItem) {
                            // 已索引但深层 → 更新 aepPath + targetFolder
                            var saved = { aepPath: existingItem.aepPath, targetFolder: existingItem.targetFolder, sourceType: existingItem.sourceType, sourceName: existingItem.sourceName };
                            existingItem.aepPath = newAepPath;
                            existingItem.targetFolder = targetDir;
                            existingItem.sourceType = project.hasAssets ? 'bundle' : 'import';
                            existingItem.sourceName = project.hasAssets ? SOURCE_NAME_BUNDLE : SOURCE_NAME_PROJECT;
                            try { await _flushIndex(); }
                            catch (e) {
                                existingItem.aepPath = saved.aepPath;
                                existingItem.targetFolder = saved.targetFolder;
                                existingItem.sourceType = saved.sourceType;
                                existingItem.sourceName = saved.sourceName;
                                indexOk = false;
                                console.warn('[projectAssetStore] 标准化更新索引失败: ' + newAepPath);
                            }
                        } else {
                            try {
                                await _addMetaInner({
                                    name: bname, folder: '', aepPath: newAepPath,
                                    targetFolder: targetDir,
                                    sourceType: project.hasAssets ? 'bundle' : 'import',
                                    sourceName: project.hasAssets ? SOURCE_NAME_BUNDLE : SOURCE_NAME_PROJECT,
                                    originalProject: '', size: 0
                                });
                                stdImported++;
                            } catch (e) {
                                console.warn('[projectAssetStore] 标准化索引失败: ' + newAepPath + ' — ' + (e && e.message ? e.message : e));
                                indexOk = false;
                            }
                        }
                        if (!indexOk) {
                            // 回滚新 copy，旧文件还在，下次 load 重试
                            if (moved) {
                                if (project.hasAssets) {
                                    try { await _removeDir(targetDir); } catch (_) {}
                                } else {
                                    try { await _AEFS.deleteFile(newAepPath); } catch (_) {}
                                    try { await _AEFS.rmdir(targetDir); } catch (_) {}
                                }
                            }
                            return;
                        }
                        // 索引已持久化，删旧
                        var migrateFailed = false;
                        if (moved) {
                            if (project.hasAssets) {
                                var remResult = await _removeDir(dirPath);
                                if (!remResult.success) migrateFailed = true;
                            } else {
                                var delOk = await _AEFS.deleteFile(aepPath);
                                if (delOk !== true) migrateFailed = true;
                            }
                        }
                        if (migrateFailed) {
                            _migratedSources.push(oldAepPath2);
                            migratedSet[oldAepPath2] = true;
                            try { await _flushIndex(); } catch (_) {}
                        }
                        indexed[newAepPath] = true;
                        indexed[oldAepPath2] = true;
                        itemByAepPath[newAepPath] = existingItem || true;
                        console.log('[projectAssetStore] 标准化入库: ' + newAepPath);
                    },
                    onInvalid: async function (dirPath, reason) {
                        console.warn('[projectAssetStore] 非法结构: ' + dirPath + ' — ' + reason);
                    }
                });
            }

            // ③ 清理空壳父目录（移走工程后变空的，不进入 targetFolder 内部）
            await _cleanupEmptyDirs();

            // ④ 对齐文件夹名 + .aep 文件名与显示名
            // 场景：①历史重命名只改了文件夹没改 .aep 文件 ②用户手动改了文件夹名
            // flushIndex 失败时逆序回滚磁盘 rename，保证内存与索引一致
            var alignmentChanged = false;
            var _alignRollback = [];  // {type:'file'|'dir'|'name', from?, to?, item, savedAepPath?, savedName?}
            for (var a = 0; a < _items.length; a++) {
                var item = _items[a];
                if (!item.aepPath || !item.targetFolder) continue;
                // 归档条目跳过 ④ 对齐：其 targetFolder 指向 ___archive__/<时间戳>_<名>，
                // 对齐会把目录名改成 item.name（丢时间戳、破坏归档命名与清扫判据）
                if (_isArch(item)) continue;

                // ④a 对齐父文件夹名与 item.name（即使 .aep missing，文件夹可能还在）
                var actualFolderName = _baseNameFromFile(item.targetFolder);
                if (actualFolderName !== item.name) {
                    var newTargetFolder = item.targetFolder.replace(/[^\\/]+$/, function () { return item.name; });
                    if (newTargetFolder !== item.targetFolder) {
                        var folderSrcExists = await _AEFS.existsAsync(item.targetFolder);
                        if (folderSrcExists) {
                            var folderDstExists = await _AEFS.existsAsync(newTargetFolder);
                            if (folderDstExists) {
                                // 目标已存在（同名素材冲突，_ensureUniqueDir 曾给本素材文件夹加 _N 后缀）：
                                // 反向对齐——把 item.name 改成磁盘实际的 actualFolderName，
                                // 让下方 ④b 把 .aep 文件名也同步到新 item.name（如「示例工程_1.aep」）
                                var savedName = item.name;
                                item.name = actualFolderName;
                                alignmentChanged = true;
                                stdAligned++;
                                _alignRollback.push({ type: 'name', item: item, savedName: savedName });
                                console.log('[projectAssetStore] 文件夹名对齐反向（目标已存在）：item.name 「' + savedName + '」 → 「' + actualFolderName + '」');
                            } else {
                                var renDirOk = await _AEFS.renameDir(item.targetFolder, newTargetFolder);
                                if (renDirOk) {
                                    var savedTargetFolder = item.targetFolder;
                                    var savedAepPath = item.aepPath;
                                    // 同步更新 aepPath 中的 targetFolder 部分
                                    item.aepPath = item.aepPath.replace(item.targetFolder, newTargetFolder);
                                    item.targetFolder = newTargetFolder;
                                    alignmentChanged = true;
                                    stdAligned++;
                                    _alignRollback.push({ type: 'dir', from: newTargetFolder, to: savedTargetFolder, item: item, savedAepPath: savedAepPath });
                                    console.log('[projectAssetStore] 文件夹名已对齐: ' + newTargetFolder);
                                } else {
                                    console.warn('[projectAssetStore] 文件夹名对齐失败: ' + item.targetFolder + ' → ' + newTargetFolder);
                                }
                            }
                        }
                    }
                }

                // ④b 对齐 .aep 文件名与 item.name + '.aep'
                var actualName = _baseNameFromFile(item.aepPath);
                var expectedName = item.name + '.aep';
                if (actualName !== expectedName) {
                    var newPath = item.targetFolder + '/' + expectedName;
                    if (newPath === item.aepPath) continue;
                    var srcExists = await _AEFS.existsAsync(item.aepPath);
                    if (!srcExists) continue;  // missing，跳过
                    var dstExists = await _AEFS.existsAsync(newPath);
                    if (dstExists) {
                        console.warn('[projectAssetStore] 文件名对齐跳过（目标已存在）: ' + newPath);
                        continue;
                    }
                    var renOk = await _AEFS.renameFile(item.aepPath, newPath);
                    if (renOk) {
                        var savedAepPath2 = item.aepPath;
                        item.aepPath = newPath;
                        alignmentChanged = true;
                        stdAligned++;
                        _alignRollback.push({ type: 'file', from: newPath, to: savedAepPath2, item: item });
                        console.log('[projectAssetStore] 文件名已对齐: ' + newPath);
                    } else {
                        console.warn('[projectAssetStore] 文件名对齐失败: ' + item.aepPath + ' → ' + newPath);
                    }
                }
            }
            if (alignmentChanged) {
                try {
                    await _flushIndex();
                } catch (e) {
                    // 索引写入失败：逆序回滚磁盘 rename，恢复内存状态
                    // 逆序保证：先回滚 ④b（renameFile），再回滚 ④a（renameDir）
                    // ④b 的文件在 ④a 的新文件夹内，必须先回滚文件名再回滚文件夹名
                    for (var rb = _alignRollback.length - 1; rb >= 0; rb--) {
                        var op = _alignRollback[rb];
                        try {
                            if (op.type === 'file') {
                                await _AEFS.renameFile(op.from, op.to);
                                op.item.aepPath = op.to;
                            } else if (op.type === 'dir') {
                                await _AEFS.renameDir(op.from, op.to);
                                op.item.targetFolder = op.to;
                                op.item.aepPath = op.savedAepPath;
                            } else if (op.type === 'name') {
                                op.item.name = op.savedName;
                            }
                        } catch (_) {}
                    }
                    console.warn('[projectAssetStore] 标准化对齐索引写入失败，已回滚磁盘操作');
                }
            }
            return { imported: stdImported, aligned: stdAligned };
        }

        // 找一个 _base 下不冲突的目录名。excludePath 跳过自身（已在根级的情况）
        async function _ensureUniqueDir(baseName, excludePath) {
            var candidate = _base + '/' + baseName;
            var exclFwd = String(excludePath || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            var idx = 0;
            while (idx < 1000) {
                var candFwd = candidate.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (candFwd === exclFwd) return candidate;
                var exists = await _AEFS.existsAsync(candidate);
                if (!exists) return candidate;
                idx++;
                candidate = _base + '/' + baseName + '_' + idx;
            }
            console.warn('[projectAssetStore] _ensureUniqueDir 超过 1000 次冲突，放弃: ' + baseName);
            return null;
        }

        // 递归删空壳目录（rmdir 只删空目录，非空跳过）。跳过 targetFolder 内部，不删 _base 本身。
        async function _cleanupEmptyDirs() {
            var targetFolders = [];
            for (var k = 0; k < _items.length; k++) {
                if (_items[k].targetFolder) {
                    targetFolders.push(_items[k].targetFolder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase());
                }
            }
            await _cleanupEmptyDirsInner(_base, targetFolders);
        }
        async function _cleanupEmptyDirsInner(dirPath, targetFolders) {
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(dirPath); } catch (_) { subDirs = []; }
            for (var d = 0; d < subDirs.length; d++) {
                var subPath = dirPath + '/' + subDirs[d];
                var subFwd = subPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                // 是 targetFolder → 跳过（工程目录内部不清理）
                var isTarget = false;
                for (var t = 0; t < targetFolders.length; t++) {
                    if (subFwd === targetFolders[t]) { isTarget = true; break; }
                }
                if (isTarget) continue;
                await _cleanupEmptyDirsInner(subPath, targetFolders);
                try { await _AEFS.rmdir(subPath); } catch (_) {}
            }
        }

        // 发现垃圾目录：
        // 1. 非法结构/空壳（hasValidProject=false 的非 targetFolder 顶级目录）
        // 2. migratedSources 残留（已 copy 但删除失败的旧 .aep 所在顶级目录）
        // 3. 旧方案就地改名（TRASH_PREFIX 前缀）的遗留条目 → 一并入列，统一并入垃圾区文件夹
        // 排除已索引工程的 targetFolder 与垃圾区文件夹自身。
        async function listGarbage() {
            var targetFolders = {};
            for (var k = 0; k < _items.length; k++) {
                if (_items[k].targetFolder) {
                    targetFolders[_items[k].targetFolder.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()] = true;
                }
            }
            var migratedSetLG = {};
            for (var msLG = 0; msLG < _migratedSources.length; msLG++) {
                migratedSetLG[_migratedSources[msLG].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()] = true;
            }
            var garbage = [];
            var seen = {};
            var topDirs = [];
            try { topDirs = await _AEFS.listDirsAsync(_base); } catch (_) { topDirs = []; }
            for (var d = 0; d < topDirs.length; d++) {
                var topDirName = String(topDirs[d]);
                var fullPath = _base + '/' + topDirName;
                var fullFwd = fullPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (topDirName === TRASH_DIR) continue;  // 垃圾区文件夹自身不入列
                if (topDirName === ARCHIVE_DIR) continue;  // 归档区自身不入列（精确匹配；索引丢条目时也不得被当垃圾搬走）
                if (topDirName.indexOf(TRASH_PREFIX) === 0) {  // 旧方案就地改名遗留 → 并入垃圾区文件夹
                    garbage.push(fullPath); seen[fullFwd] = true;
                    continue;
                }
                if (targetFolders[fullFwd]) continue;
                // 非法结构/空壳
                var hasValid = await global.AEAssetsShared.hasValidProject(_AEFS, fullPath);
                if (!hasValid) {
                    garbage.push(fullPath); seen[fullFwd] = true;
                    continue;
                }
                // migratedSources 残留：检查顶级目录下是否有 migratedSource 的 .aep
                for (var ms = 0; ms < _migratedSources.length; ms++) {
                    var srcFwd = _migratedSources[ms].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                    if (srcFwd.indexOf(fullFwd + '/') === 0) {
                        // 旧 .aep 在这个顶级目录下
                        var srcExists = await _AEFS.existsAsync(_migratedSources[ms]);
                        if (srcExists) {
                            if (!seen[fullFwd]) { garbage.push(fullPath); seen[fullFwd] = true; }
                            break;
                        }
                    }
                }
            }
            // 检查 _base 根级文件：
            //   .aep 在 migratedSources 里 → 垃圾（① deleteFile 失败残留）
            //   非 .aep 非 system 文件 → 垃圾（用户误放的无关文件）
            var rootAepFiles = [];
            try { rootAepFiles = await _AEFS.listFilesAsync(_base); } catch (_) { rootAepFiles = []; }
            for (var rf = 0; rf < rootAepFiles.length; rf++) {
                var rootFn = rootAepFiles[rf];
                var rootFilePath = _base + '/' + rootFn;
                if (String(rootFn).indexOf(TRASH_PREFIX) === 0) {  // 旧方案就地改名遗留 → 并入垃圾区文件夹
                    garbage.push(rootFilePath);
                    continue;
                }
                var rootFileFwd = rootFilePath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (/\.aep$/i.test(rootFn)) {
                    // .aep 残留：只有在 migratedSources 里才算垃圾（已 copy 走的旧位置）
                    if (migratedSetLG[rootFileFwd]) {
                        var rootExists = await _AEFS.existsAsync(rootFilePath);
                        if (rootExists) garbage.push(rootFilePath);
                    }
                } else {
                    // 非 .aep：跳过系统文件（index.json, .folders.json），其余都是垃圾
                    if (rootFn === 'index.json' || rootFn === '.folders.json') continue;
                    var nonAepExists = await _AEFS.existsAsync(rootFilePath);
                    if (nonAepExists) garbage.push(rootFilePath);
                }
            }
            return garbage;
        }

        async function cleanGarbage(paths, onProgress) {
            if (!Array.isArray(paths)) return { cleaned: 0, failed: [] };
            var cleaned = 0, failed = [];
            var movedPaths = [];   // 记录成功移入垃圾区文件夹的路径
            var trashDir = _base + '/' + TRASH_DIR;
            var trashDirFwd = trashDir.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            // 垃圾区文件夹统一收纳所有垃圾（mkdir 幂等，已存在不报错）
            var mkOk = await _AEFS.mkdirAsync(trashDir);
            if (mkOk !== true) return { cleaned: 0, failed: [AEI18n.t('创建垃圾区文件夹失败: ') + trashDir] };
            for (var i = 0; i < paths.length; i++) {
                if (!_inProjectAssets(paths[i])) { failed.push(paths[i] + AEI18n.t(' (安全拒绝)')); continue; }
                var srcFwd = String(paths[i]).replace(/\\/g, '/').replace(/\/+$/, '');
                // 纵深防御：归档区不可被当垃圾搬入垃圾区（索引丢条目时的兜底；listGarbage 已排除）
                if (String(paths[i]).replace(/\\/g, '/').toLowerCase().indexOf('/' + ARCHIVE_DIR.toLowerCase()) >= 0) {
                    failed.push(paths[i] + AEI18n.t(' (归档区，拒绝)'));
                    continue;
                }
                // 纵深防御：垃圾区文件夹自身不可移入自身
                if (srcFwd.toLowerCase() === trashDirFwd) { failed.push(paths[i] + AEI18n.t(' (垃圾区自身)')); continue; }
                console.log('[projectAssetStore] 移入垃圾区: ' + paths[i]);
                try {
                    var baseName = srcFwd.split('/').pop();
                    // 目标 = 垃圾区文件夹内加时间戳前缀防重名。跨目录无法原子 rename（AEFS/Bridge 均拒），
                    // copy + delete 实现 move：copy 全成功才删源，中断最多在垃圾区留副本，不会丢数据
                    var dstPath = trashDir + '/' + Date.now() + '_' + baseName;
                    var pathIsFile = await _AEFS.isFile(paths[i]);
                    var mvOk;
                    if (pathIsFile) {
                        mvOk = await _AEFS.copyFileAsync(paths[i], dstPath);
                        if (mvOk === true) mvOk = await _AEFS.deleteFile(paths[i]);
                    } else {
                        mvOk = await _AEFS.copyDirAsync(paths[i], dstPath);
                        if (mvOk === true) {
                            // 源目录已完整复制进垃圾区，物理删除源（skipRecycle：不走回收站/确认弹窗协议）
                            var rmRes = await _removeDir(paths[i], { skipRecycle: true });
                            mvOk = rmRes.success === true;
                        }
                    }
                    if (mvOk === true) { cleaned++; movedPaths.push(paths[i]); }
                    else failed.push(paths[i] + AEI18n.t(' (移动失败)'));
                } catch (e) {
                    failed.push(paths[i] + ' (' + (e && e.message ? e.message : e) + ')');
                }
                if (onProgress) onProgress(i + 1, paths.length);
            }
            // 从 _migratedSources 移除已移入垃圾区的源路径及其子路径（走 _serialized 防并发写覆盖）
            if (movedPaths.length) {
                await _serialized(function () {
                    var before = _migratedSources.length;
                    _migratedSources = _migratedSources.filter(function (src) {
                        var srcFwd = String(src).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                        for (var c = 0; c < movedPaths.length; c++) {
                            var cleanFwd = movedPaths[c].replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                            if (srcFwd === cleanFwd || srcFwd.indexOf(cleanFwd + '/') === 0) return false;
                        }
                        return true;
                    });
                    if (_migratedSources.length !== before) {
                        return _flushIndex();
                    }
                });
            }
            return { cleaned: cleaned, failed: failed };
        }

        async function addMeta(o) { return _serialized(function () { return _addMetaInner(o); }); }
        // 构造 meta 对象（不 push、不落盘）。单条 addMeta 与批量 addMetaBatch 共用。
        function _mkMeta(o) {
            var name = o.name || assetBaseName(_baseNameFromFile(o.aepPath));
            var meta = {
                id: _genId(),
                name: name,
                folder: _norm(o.folder || ''),
                aepPath: o.aepPath,
                targetFolder: o.targetFolder || '',
                sourceType: o.sourceType || 'import',
                sourceName: o.sourceName || '',
                originalProject: o.originalProject || '',
                size: o.size || 0,
                exportTime: o.exportTime || _now(),
                notes: o.notes || ''
            };
            return meta;
        }

        // 预览帧落盘：把面板侧已缩好的小图（o.previewSource = { blob, time }）写到该条目的
        // 预览目录，并把 { file, time } 记进 meta。按生成的 id 写，故与 addMeta 同一步完成
        // ——不产生第二次索引写。失败只 warn 一行，条目不写 previewFrame（预览是附加物）。
        // _standardize 不碰该字段（它只重算 aepPath/targetFolder/name/sourceType）。
        async function _attachPreview(meta, o) {
            if (!o || !o.previewSource) return;
            var pv = _previewStore();
            if (!pv) return;
            try {
                var pf = await pv.savePrepared(o.previewSource, meta.id);
                if (pf) meta.previewFrame = pf;
            } catch (_) {}
        }
        async function _addMetaInner(o) {
            o = o || {};
            var aepPath = o.aepPath || '';
            var replaced = [];
            if (aepPath) {
                for (var i = _items.length - 1; i >= 0; i--) {
                    if (_items[i].aepPath === aepPath) {
                        console.log('[projectAssetStore] addMeta 覆盖旧条目: ' + _items[i].name + ' (' + _items[i].id + ')');
                        replaced.push({ idx: i, item: _items.splice(i, 1)[0] });
                    }
                }
            }
            var meta = _mkMeta(o);
            await _attachPreview(meta, o);
            _items.push(meta);
            try { await _flushIndex(); }
            catch (e) {
                var popIdx = _items.indexOf(meta);
                if (popIdx !== -1) _items.splice(popIdx, 1);
                // 恢复被覆盖删除的旧条目（倒序收集 idx 递减，倒序遍历 = idx 递增顺序插回），
                // 否则内存与磁盘旧索引不一致，旧条目在本次会话中丢失
                for (var r = replaced.length - 1; r >= 0; r--) _items.splice(replaced[r].idx, 0, replaced[r].item);
                throw e;
            }
            return meta;
        }

        // 批量导入：循环内只改内存，末尾一次 flush（替代逐条 addMeta 的 N 次全量重写）。
        // 保持 _serialized 原子性 + 失败回滚（flush 失败移除本次新增项）。
        // 约定：批量场景均为新增（aepPath 唯一），不做覆盖旧条目；与单条 addMeta 的回滚语义对齐。
        async function addMetaBatch(metas) {
            if (!Array.isArray(metas) || !metas.length) return [];
            return _serialized(function () {
                var added = [];
                for (var i = 0; i < metas.length; i++) {
                    added.push(_mkMeta(metas[i]));
                }
                // 预览帧：整批共用同一张已缩好的小图（同一合成），逐条目按各自 id 写一份
                // ——故缩图只做一次、写盘 N 次
                return metas.reduce(function (chain, o, idx) {
                    return chain.then(function () { return _attachPreview(added[idx], o); });
                }, Promise.resolve()).then(function () {
                    for (var p = 0; p < added.length; p++) _items.push(added[p]);
                    return _flushIndex();
                }).then(function () {
                    return added;
                }).catch(function (e) {
                    for (var j = 0; j < added.length; j++) {
                        var idx = _items.indexOf(added[j]);
                        if (idx !== -1) _items.splice(idx, 1);
                    }
                    throw e;
                });
            });
        }

        function _baseNameFromFile(p) {
            var s = String(p || '').replace(/\\/g, '/');
            var i = s.lastIndexOf('/');
            return i >= 0 ? s.slice(i + 1) : s;
        }

        // 纵深防御：路径必须在数据目录的 project-assets 内（_base 子路径）
        // 仅检查含 /project-assets/ 段不够——索引被篡改后 targetFolder 可指向其他位置的
        // project-assets 目录（如 C:/.../scripts/project-assets/evil），必须以 _base 为前缀。
        function _inProjectAssets(p) {
            var fwd = String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
            // 纵深防御：拒 .. 和 . 段（不依赖 AEFS _checkPath 做唯一防线）
            // . 段会绕过下方根保护比较（"a/./b" !== "a/b"），须在此一并拒绝
            if (fwd.indexOf('/../') !== -1) return false;
            if (fwd.indexOf('/./') !== -1) return false;
            var len = fwd.length;
            if (len >= 3 && fwd.lastIndexOf('/..') === len - 3) return false;
            if (len >= 2 && fwd.lastIndexOf('/.') === len - 2) return false;
            // 必须在 _base（数据目录的 project-assets）内，防索引篡改后指向其他 project-assets 目录
            var baseFwd = String(_base).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            return fwd.indexOf(baseFwd + '/') === 0 || fwd === baseFwd;
        }

        async function rename(id, newName) {
            return _serialized(function () { return _renameInner(id, newName); });
        }
        async function _renameInner(id, newName) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var old = _items[i];
                    // 归档条目的 targetFolder 指向归档区的归档包目录：改名的物理动作会把整包
                    // 改名/搬出归档区（归档区外路径），必须禁止；归档件改名请先 restore
                    if (_isArch(old)) throw new Error(AEI18n.t('条目已归档，不能重命名（请先 restore 恢复）: ') + id);
                    // missing 条目无实体目录/文件：只改索引字段，跳过两次物理改名。
                    // missing 可能已陈旧（文件被放回但扫描尚未更新）：先做存在性确认，
                    // 文件仍在则按实体改名走，避免真包留在旧路径被孤立；通道故障按"仍存在"保守处理
                    var wasMissing = !!old.missing;
                    if (wasMissing) {
                        // missing 可能陈旧（文件被放回而扫描未更新）：三态确认后决定走实体改名还是
                        // 仅改索引；通道不可判时维持仅改索引（不因拿不到而误报改名失败）
                        var missState = await _probePathState(old.aepPath);
                        if (missState === 'exists') wasMissing = false;
                    }
                    var newFolder = old.targetFolder.replace(/[^\\/]+$/, function () { return newName; });
                    if (newFolder !== old.targetFolder) {
                        // 双重查重（对齐 presetStore.rename 的语义），检查
                        // 放在改动内存字段之前，命中即抛错无需回滚——
                        // ① 索引级：目标 targetFolder/aepPath 被其他条目（missing 占位——物理
                        // 目录已删但索引残留）占用时文件系统探测不到，不拦会产生同 aepPath
                        // 双条目（missing 条目懒检测"复活"后两同名条目指向同一工程）；
                        // ② 文件系统级：renameDir 与 renameFile 同契约（dst 已存在即静默并入/
                        // 覆盖），不拦会把 A 目录并入既有 B 目录。大小写-only 改名是同一路径
                        // 自身（大小写不敏感文件系统上探测会命中自身），须放行跳过该检查。
                        var _newAepPath = newFolder + '/' + newName + '.aep';
                        var _nfLower = newFolder.toLowerCase();
                        var _naLower = _newAepPath.toLowerCase();
                        for (var di = 0; di < _items.length; di++) {
                            if (_items[di].id === old.id) continue;  // 跳过自身（含大小写-only 改名）
                            if (String(_items[di].targetFolder || '').toLowerCase() === _nfLower ||
                                String(_items[di].aepPath || '').toLowerCase() === _naLower) {
                                throw new Error(AEI18n.t('已存在同名条目: ') + newName);
                            }
                        }
                        if (_nfLower !== String(old.targetFolder).toLowerCase()) {
                            // exists 与 existsAsync 在 aefs 中均为真异步等价 API；
                            // 个别旧调用环境/mock 仅有 exists，作回退
                            var _exFn = _AEFS.existsAsync || _AEFS.exists;
                            if (_exFn && await _exFn(newFolder)) {
                                throw new Error(AEI18n.t('已存在同名目录: ') + newName);
                            }
                        }
                        var savedName = old.name;
                        var savedAep = old.aepPath;
                        var savedFolder = old.targetFolder;
                        var savedMissing = !!old.missing;
                        // 先更新内存
                        old.aepPath = old.aepPath.replace(old.targetFolder, newFolder);
                        old.targetFolder = newFolder;
                        old.name = newName;
                        if (!wasMissing) {
                            // 实体仍在（可能此前 missing 误标）：随改名清除 missing，防改名后
                            // remove() 走 missing 分支只删索引、把实体留成孤儿
                            old.missing = false;
                            // ① 改文件夹名
                            var renOk = await _AEFS.renameDir(savedFolder, newFolder);
                            if (!renOk) {
                                old.name = savedName;
                                old.aepPath = savedAep;
                                old.targetFolder = savedFolder;
                                old.missing = savedMissing;
                                throw new Error(AEI18n.t('文件夹改名失败'));
                            }
                            // ② 对齐 .aep 文件名（文件夹改名后里面的 .aep 还是旧名）
                            var aepAfterFolderRename = old.aepPath;  // .../NewName/OldName.aep
                            var newAepPath = newFolder + '/' + newName + '.aep';
                            if (aepAfterFolderRename !== newAepPath) {
                                var renFileOk = await _AEFS.renameFile(aepAfterFolderRename, newAepPath);
                                if (!renFileOk) {
                                    try { await _AEFS.renameDir(newFolder, savedFolder); } catch (_) {}
                                    old.name = savedName;
                                    old.aepPath = savedAep;
                                    old.targetFolder = savedFolder;
                                    old.missing = savedMissing;
                                    throw new Error(AEI18n.t('aep 文件改名失败'));
                                }
                                old.aepPath = newAepPath;
                            }
                            // ③ 写索引
                            try {
                                await _flushIndex();
                            } catch (e) {
                                // 回滚：先把 .aep 文件名恢复、再恢复文件夹名
                                if (old.aepPath !== savedAep) {
                                    try { await _AEFS.renameFile(newAepPath, aepAfterFolderRename); } catch (_) {}
                                }
                                try { await _AEFS.renameDir(newFolder, savedFolder); } catch (_) {}
                                old.name = savedName;
                                old.aepPath = savedAep;
                                old.targetFolder = savedFolder;
                                old.missing = savedMissing;
                                throw e;
                            }
                        } else {
                            old.aepPath = newFolder + '/' + newName + '.aep';
                            try { await _flushIndex(); }
                            catch (e) {
                                old.name = savedName;
                                old.aepPath = savedAep;
                                old.targetFolder = savedFolder;
                                throw e;
                            }
                        }
                    } else {
                        var savedName3 = old.name;
                        old.name = newName;
                        try { await _flushIndex(); }
                        catch (e) { old.name = savedName3; throw e; }
                    }
                    break;
                }
            }
            // 找不到 id 须拒绝：静默 resolve 会被调用方（bootstrap _wrap）当作成功 → LLM 假成功
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        // 内部：删实体文件夹，返回 { failures }。不碰 _items，不调 _flushIndex。
        // remove / removeFolder 共用，批量删时只需一次 flush。
        async function _removeEntity(m) {
            var failures = [];
            var success = true;
            if (m.targetFolder) {
                var result = await _removeDir(m.targetFolder);
                if (!result.success) {
                    success = false;
                    failures = result.failures.slice();
                }
            } else {
                // 无 targetFolder（不应该发生，标准化保证所有工程都套文件夹）
                try {
                    var ok = await _AEFS.deleteFile(m.aepPath);
                    if (ok !== true) failures.push(m.aepPath);
                } catch (e) { failures.push(m.aepPath); }
            }
            // 实体已删 → 连带删预览目录（预览在库外独立根，不随条目目录走）。
            // 挂此处一处覆盖 remove 与 removeFolder(keepItems=false) 两个调用方。
            if (success) {
                var pv = _previewStore();
                if (pv) { try { await pv.deleteOne(m.id); } catch (_) {} }
            }
            return { success: success, failures: failures };
        }

        async function remove(id) {
            return _serialized(function () { return _removeInner(id); });
        }
        async function _removeInner(id) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var m = _items[i];
                    // 归档条目的 targetFolder/aepPath 指向归档区：物理删除=绕过归档语义的永久清理，
                    // 且会绕过归档区路径判据；归档件清理由 restore / purgeArchive 承接
                    if (_isArch(m)) throw new Error(AEI18n.t('条目已归档，不能直接删除（请用 restore 恢复或从归档区永久清理）: ') + id);
                    if (!m.missing) {
                        // 正常删除：删实体文件夹（含 .aep + 资产）
                        var result = await _removeEntity(m);
                        // 用户取消删除时 result.success 为 false，不应继续删索引
                        if (!result.success) {
                            if (result.failures.length) {
                                throw new Error(AEI18n.t('删除失败: ') + result.failures.join(', '));
                            }
                            // 用户取消 AEFS 内部确认弹窗：抛 CANCELLED 让调用方静默处理，
                            // 避免误显示"已删除"成功 toast（也不显示错误 toast）。
                            var _ce2 = new Error('USER_CANCELLED');
                            _ce2.code = 'CANCELLED';
                            throw _ce2;
                        }
                    } else if (m.targetFolder) {
                        // missing：.aep 已不存在，只删索引。残留目录由"检测垃圾"功能清理。
                    }
                    var delIdx = _items.indexOf(m);
                    if (delIdx !== -1) _items.splice(delIdx, 1);
                    try { await _flushIndex(); }
                    catch (e) {
                        _items.splice(delIdx, 0, m);
                        throw e;
                    }
                    break;
                }
            }
            // 找不到 id 须拒绝：静默 resolve 会被调用方（bootstrap _wrap）当作成功 → LLM 假成功
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        // 递归清 collectFiles 产物目录。返回 { success, failures, deleted }——failures 为删除失败的文件/目录路径列表，
        // deleted 为**实际已删除**的文件数 + 目录数（递归累加）。归档/恢复的失败分支靠它区分
        // 「源一点没动」与「源已被部分删除（不可逆）」——后者若再删 dst 副本，已从源删掉的文件就永久消失
        // （skipRecycle 走物理删除，不进回收站）。其余调用方（cleanGarbage/_removeEntity 等）只消费 success，语义不变。
        // 入口做 project-assets 命名空间纵深防御，与 AEFS _safeForDelete 形成双层兜底。
        // opts.skipRecycle=true：跳过 removeDirRecursive（回收站/确认弹窗协议），直接走逐文件物理删除回退链。
        // 用于移入垃圾区后的源目录清理——内容已完整复制进垃圾区，无需回收站二次保护。
        async function _removeDir(dirPath, opts) {
            opts = opts || {};
            if (!_inProjectAssets(dirPath)) {
                console.warn('[projectAssetStore] _removeDir 拒非 project-assets 路径: ' + dirPath);
                return { success: false, failures: [dirPath], deleted: 0 };
            }
            // 纵深防御：禁止递归删 project-assets 根目录本身。targetFolder 正常应为 _base/<name>（或更深），
            // 绝不能是 _base——否则会递归清空整个命名空间下所有素材。每文件删除虽走 AEFS._depthOk，
            // 但顶层补一道断言，防路径构造 bug/空名产生浅层路径。
            var baseFwd = String(_base).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            var dirFwd = String(dirPath).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            if (dirFwd === baseFwd) {
                console.warn('[projectAssetStore] _removeDir 拒删 project-assets 根: ' + dirPath);
                return { success: false, failures: [dirPath], deleted: 0 };
            }
            // 优先使用递归删除（Bridge 一次 rmSync，大批量删除性能优化）
            if (!opts.skipRecycle) {
                try {
                    var recOk = await _AEFS.removeDirRecursive(dirPath);
                    // 一次 rmSync 无从计数——deleted 只为失败分支「是否已发生不可逆删除」服务，
                    // success=true 时调用方不看 deleted，故置 0 不误导
                    if (recOk) return { success: true, failures: [], deleted: 0 };
                } catch (e) {
                    // 用户取消弹窗 → 终止删除（不可回退到逐个 deleteFile 物理删除，否则违背用户意图）
                    if (e && e.code === 'CANCELLED') return { success: false, failures: [], deleted: 0 };
                    // 其他异常继续走回退
                }
            }
            // 回退：逐个删除文件 + 子目录 + rmdir
            var failures = [];
            var deleted = 0;
            var files = [];
            try { files = await _AEFS.listFilesAsync(dirPath); } catch (_) { files = []; }
            for (var i = 0; i < files.length; i++) {
                var fp = dirPath + '/' + files[i];
                try {
                    var ok = await _AEFS.deleteFile(fp);
                    if (!ok) failures.push(fp); else deleted++;
                } catch (_) { failures.push(fp); }
            }
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(dirPath); } catch (_) { subDirs = []; }
            for (var d = 0; d < subDirs.length; d++) {
                var subResult = await _removeDir(dirPath + '/' + subDirs[d], opts);
                // 递归累加：子目录内已删文件/目录 + 子目录自身（其 rmdir 成功已计入 subResult.deleted）
                deleted += (subResult && subResult.deleted) || 0;
                if (!subResult.success) {
                    failures = failures.concat(subResult.failures);
                }
            }
            try {
                var rmOk = await _AEFS.rmdir(dirPath);
                if (!rmOk) failures.push(dirPath + ' (rmdir)'); else deleted++;
            } catch (_) { failures.push(dirPath + ' (rmdir)'); }
            return { success: failures.length === 0, failures: failures, deleted: deleted };
        }

        async function move(id, folder) {
            return _serialized(function () { return _moveInner(id, folder); });
        }
        async function _moveInner(id, folder) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var saved = _items[i].folder;
                    _items[i].folder = _norm(folder || '');
                    try { await _flushIndex(); }
                    catch (e) { _items[i].folder = saved; throw e; }
                    break;
                }
            }
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        // 批量移动条目到虚拟文件夹。契约与 presetStore.moveBatch 对齐（见
        // 下文）：
        //   · 返回成功条数；未知 / 陈旧 id 静默跳过，不中断整批（同批重复 id 只算一次）
        //   · 批内索引写**恰好 1 次**——逐条 move 是 N 次全量落盘，那才是"卡"的根因
        //   · 写盘失败**回滚全部内存后抛**（本库 move 只改 folder 字段、无文件系统操作，
        //     可整体回滚；预设库物理文件已搬走故只 flush 已完成部分，两库差异是有意的）
        //   · onProgress 语义 = 每完成一个耗时步骤回调一次。本库批内只有收尾一次索引写，
        //     没有可报告的中间步骤 → **不回调**。故 UI 侧不会为短操作建瞬态进度卡片
        //     （对齐「避免短操作出现瞬态 UI 闪烁」的既有原则）。
        async function moveBatch(ids, targetFolder, onProgress) {
            var list = Array.isArray(ids) ? ids.slice() : [];
            return _serialized(function () {
                var tf = _norm(targetFolder || '');
                var saved = [];
                var moved = 0;
                var seen = {};
                for (var i = 0; i < list.length; i++) {
                    var id = list[i];
                    if (seen[id]) continue;
                    seen[id] = true;
                    var hit = null;
                    for (var j = 0; j < _items.length; j++) {
                        if (_items[j].id === id) { hit = _items[j]; break; }
                    }
                    if (!hit) continue;
                    saved.push({ item: hit, folder: hit.folder });
                    hit.folder = tf;
                    moved++;
                }
                if (!moved) return 0;
                return _flushIndex().then(function () {
                    return moved;
                }, function (e) {
                    for (var k = 0; k < saved.length; k++) saved[k].item.folder = saved[k].folder;
                    throw e;
                });
            });
        }

        // ── 虚拟文件夹操作（改 folder 字段 + 回写 index.json）──

        var createFolder = _fm.createFolder;
        var listEmptyFolders = _fm.listEmptyFolders;

        // 删除空虚拟文件夹：复用 folderStoreMixin.deleteEmptyFolder（带写串行化），
        // 语义与 refStore 一致（仅删 .folders.json 虚拟记录，不动物理目录/条目）
        var deleteEmptyFolder = _fm.deleteEmptyFolder;

        // 重命名虚拟文件夹：改所有匹配前缀的条目 folder + 空文件夹路径 → 回写 index.json
        async function renameFolder(oldPath, newPath) {
            return _serialized(function () { return _renameFolderInner(oldPath, newPath); });
        }
        // 目标占用检测（对齐视图层 _moveFolder 的 口径，收口三个
        // 旁路——行内重命名/批量拖拽/LLM 入口均绕过视图层直达 store）——'a' 改名为
        // 已存在的 'b' 时两文件夹条目静默合并、无提示无撤销。oldN 子树条目随迁移不算
        // 占用；newN 为空（移到根）是既有语义（条目平铺根级不冲突），跳过检测。
        // 单条（_renameFolderInner）与批量（renameFoldersBatch）共用，防两处判据漂移。
        function _checkFolderRenameTarget(oldN, newN) {
            if (oldN && newN && newN.indexOf(oldN + '/') === 0) {
                throw new Error(AEI18n.t('不能重命名到自身子路径下: ') + newN);
            }
            if (!newN) return;
            for (var gi = 0; gi < _items.length; gi++) {
                var gf = _norm(_items[gi].folder);
                if (gf === oldN || (oldN && gf.indexOf(oldN + '/') === 0)) continue;
                if (gf === newN || gf.indexOf(newN + '/') === 0) {
                    throw new Error(AEI18n.t('目标文件夹已存在: ') + newN);
                }
            }
            if (_fm.listEmptyFolders().indexOf(newN) !== -1) {
                throw new Error(AEI18n.t('目标文件夹已存在: ') + newN);
            }
        }

        // 改 oldN 子树下条目的 folder 前缀 → newN；返回快照供回滚。
        // 注意与 refStore 的同名辅助**语义不同**（本库不把 oldN==='' 当"全部条目"）——
        // 是既存差异，此处按本库原语义抽取，不顺手统一。
        function _rewriteFolderPrefix(oldN, newN) {
            var saved = [];
            for (var i = 0; i < _items.length; i++) {
                var f = _norm(_items[i].folder);
                if (f === oldN || (oldN.length > 0 && f.indexOf(oldN + '/') === 0)) {
                    saved.push({ item: _items[i], folder: _items[i].folder });
                }
            }
            for (var j = 0; j < saved.length; j++) {
                var item = saved[j].item;
                var fj = _norm(item.folder);
                if (fj === oldN) item.folder = newN;
                else if (fj.indexOf(oldN + '/') === 0) item.folder = _norm(newN + '/' + fj.slice(oldN.length + 1));
            }
            return saved;
        }

        async function _renameFolderInner(oldPath, newPath) {
            var oldN = _norm(oldPath), newN = _norm(newPath);
            // 同名重命名（含归一化后相等，如 'a/'→'a'）是无操作——须在
            // 占用检测前早退：'a' 是已记录空文件夹时必在 listEmptyFolders() 中，会被
            // 自己的占用检测误抛「目标文件夹已存在」（对齐 presetStore.js 同名早退）。
            if (oldN === newN) return;
            _checkFolderRenameTarget(oldN, newN);
            var saved = _rewriteFolderPrefix(oldN, newN);
            // 一次性写回 index.json
            try { await _flushIndex(); }
            catch (e) {
                // 回滚全部内存
                for (var r = 0; r < saved.length; r++) {
                    saved[r].item.folder = saved[r].folder;
                }
                throw e;
            }
            try { await _fm.syncFoldersOnRename(oldN, newN); }
            catch (fmErr) {
                // index.json 写成功后，.folders.json 同步失败不应让整体报"重命名失败"：
                // 空文件夹记录的内存态已由 mixin 回滚与磁盘一致，降级 warn 防树与数据矛盾
                console.warn('[projStore] 重命名后同步 .folders.json 失败: ' + (fmErr && fmErr.message ? fmErr.message : fmErr));
            }
        }

        // 批量重命名虚拟文件夹。契约与 presetStore.renameFoldersBatch 对齐：
        //   · 返回 { done, failed }；逐 job 失败**不中断整批**，计入 failed，可选 job.onError(err)
        //   · 收尾索引写 1 次，失败**上抛**（吞错会让 UI 报"已移动 N 个"假成功）
        //   · 占用检测与单条同源（_checkFolderRenameTarget），防两处判据漂移
        //   · onProgress(done, failed, total)：本库批内只有收尾一次索引写，无中间耗时步骤 →
        //     仅在收尾回调一次（UI 侧按「首次回调时建卡片」不会为它建卡片）
        async function renameFoldersBatch(jobs, onProgress) {
            var list = Array.isArray(jobs) ? jobs.slice() : [];
            return _serialized(function () {
                var done = 0, failed = 0;
                var savedAll = [];
                var synced = [];
                for (var i = 0; i < list.length; i++) {
                    var job = list[i] || {};
                    var oldN = _norm(job.src), newN = _norm(job.dst);
                    try {
                        if (oldN !== newN) {
                            _checkFolderRenameTarget(oldN, newN);
                            savedAll = savedAll.concat(_rewriteFolderPrefix(oldN, newN));
                            synced.push({ oldN: oldN, newN: newN });
                        }
                        done++;
                    } catch (err) {
                        failed++;
                        if (job.onError) { try { job.onError(err); } catch (_) {} }
                    }
                }
                if (!done) {
                    if (onProgress) onProgress(0, failed, list.length);
                    return { done: done, failed: failed };
                }
                return _flushIndex().then(function () {
                    // .folders.json 同步：与单条同款降级——index.json 写成功后，同步失败只 warn
                    // （串行 await，确保返回时 .folders.json 已落定，调用方随后的刷新看到一致态）
                    var syncChain = Promise.resolve();
                    for (var s = 0; s < synced.length; s++) {
                        (function (jb) {
                            syncChain = syncChain.then(function () {
                                return Promise.resolve()
                                    .then(function () { return _fm.syncFoldersOnRename(jb.oldN, jb.newN); })
                                    .catch(function (fmErr) {
                                        console.warn('[projStore] 重命名后同步 .folders.json 失败: ' + (fmErr && fmErr.message ? fmErr.message : fmErr));
                                    });
                            });
                        })(synced[s]);
                    }
                    return syncChain.then(function () {
                        if (onProgress) onProgress(done, failed, list.length);
                        return { done: done, failed: failed };
                    });
                }, function (e) {
                    // 索引落盘失败：回滚全部内存后抛（批内已成功的部分也回滚——纯内存可整体回滚）。
                    // 快照形状是 {item, folder}（对象引用，本库辅助的既有形状），不是 {idx, folder}
                    for (var k = 0; k < savedAll.length; k++) {
                        savedAll[k].item.folder = savedAll[k].folder;
                    }
                    throw e;
                });
            });
        }

        // 删除虚拟文件夹：keepItems=true 清 folder 字段；keepItems=false 删所有匹配条目
        // onProgress(done, total) 可选：keepItems=false 逐条删除实体时驱动进度卡片
        // isCancelled() 可选：返回 true 时中止后续删除（用户点进度卡片「取消」）
        // 返回：keepItems=false 时返回实际删除的条目数；keepItems=true 返回 0
        async function removeFolder(folderPath, keepItems, onProgress, isCancelled) {
            return _serialized(function () { return _removeFolderInner(folderPath, keepItems, onProgress, isCancelled); });
        }
        async function _removeFolderInner(folderPath, keepItems, onProgress, isCancelled) {
            var fN = _norm(folderPath);
            var result = 0;
            function _under(f, prefix) {
                if (f === prefix) return true;
                if (prefix.length > 0 && f.indexOf(prefix + '/') === 0) return true;
                return false;
            }
            if (keepItems) {
                // 归档条目的 folder 只是归档面板分组（恢复目标 archivedFrom 是绝对路径，不随之改变），
                // 随「保留条目」一并移到根组；无物理动作
                var saved = [];
                for (var i = 0; i < _items.length; i++) {
                    if (_under(_norm(_items[i].folder), fN)) {
                        saved.push({ item: _items[i], folder: _items[i].folder });
                    }
                }
                for (var j = 0; j < saved.length; j++) {
                    saved[j].item.folder = '';
                }
                try { await _flushIndex(); }
                catch (e) {
                    for (var r = 0; r < saved.length; r++) {
                        saved[r].item.folder = saved[r].folder;
                    }
                    throw e;
                }
                result = 0;
            } else {
                // 删文件夹内的所有条目（含实体文件），批量处理只写一次 index.json。
                // 归档条目的 targetFolder/aepPath 指向归档区：物理文件不随目录删除，单独走
                // _deleteArchivedPackages（skipRecycle + 归档区路径复核，与 purgeArchive 同口径）；
                // 文件夹被永久删除时其归档件一并清理
                var toRemove = [];
                var archivedUnder = [];
                for (var m = 0; m < _items.length; m++) {
                    if (!_under(_norm(_items[m].folder), fN)) continue;
                    if (_isArch(_items[m])) archivedUnder.push(_items[m]);
                    else toRemove.push(_items[m]);
                }
                var allFailures = [];
                var cancelled = false;
                var entityFailed = [];   // 实体删除彻底失败的条目（磁盘删除失败，如 .aep 被占用）：保留索引，防下次 load 重新索引"复活"
                for (var n = 0; n < toRemove.length; n++) {
                    // 用户点进度卡片「取消」：中止后续删除
                    if (isCancelled && isCancelled()) { cancelled = true; break; }
                    // missing 条目：实体已不存在，跳过实体删除只删索引（对齐单条 remove 的
                    // missing 语义）——否则 _removeEntity 删已消失目录走失败链，该条目
                    // 永久滞留索引，重试删除同一文件夹永远失败
                    if (toRemove[n].missing) {
                        if (onProgress) onProgress(n + 1, toRemove.length);
                        continue;
                    }
                    var r = await _removeEntity(toRemove[n]);
                    if (onProgress) onProgress(n + 1, toRemove.length);
                    if (!r.success) {
                        // 用户取消删除：终止后续删除，不删任何索引
                        if (!r.failures.length) {
                            cancelled = true;
                            break;
                        }
                    }
                    if (r.failures.length) {
                        allFailures = allFailures.concat(r.failures);
                        entityFailed.push(toRemove[n]);
                    }
                }
                if (cancelled) {
                    // 用户取消（进度卡片「取消」按钮或 AEFS 内部确认弹窗）：抛 CANCELLED 让共享调用方（folderViewMixin）处理，
                    // 避免用户取消时误显示"已删除"成功 toast（也不显示错误 toast）。
                    var _ce = new Error('USER_CANCELLED');
                    _ce.code = 'CANCELLED';
                    throw _ce;
                }
                // 批量 splice + 单次 flush（只 splice 实体删除成功的条目；失败条目保留索引，
                // 语义对齐单条 remove()：failures 非空时抛错保留索引）
                var failedSet = {};
                for (var fe = 0; fe < entityFailed.length; fe++) failedSet[entityFailed[fe].id] = true;
                var removed = [];
                for (var p = 0; p < toRemove.length; p++) {
                    if (failedSet[toRemove[p].id]) continue;
                    var idx = _items.indexOf(toRemove[p]);
                    if (idx !== -1) { _items.splice(idx, 1); removed.push({ item: toRemove[p], idx: idx }); }
                }
                try { await _flushIndex(); }
                catch (e) {
                    // 回滚内存
                    for (var q = removed.length - 1; q >= 0; q--) {
                        _items.splice(removed[q].idx, 0, removed[q].item);
                    }
                    throw e;
                }
                // 归档包永久清理：文件夹被永久删除后，归档条目的"原位置"已不存在；失败如实并入回执
                var archPurged = { deleted: 0, failed: [], flushError: '', flushCode: '' };
                if (archivedUnder.length) {
                    try { archPurged = await _deleteArchivedPackages(archivedUnder); }
                    catch (e2) {
                        // 物理删除已完成、索引落盘失败：_deleteArchivedPackages 把真实结果挂在
                        // e.partial，按其结果合并（未挂时按内存是否已 splice 兜底），逐条原因保留
                        var flushMsg = (e2 && e2.message) || String(e2);
                        var partial = e2 && e2.partial;
                        if (partial) {
                            archPurged = {
                                deleted: partial.deleted || 0,
                                failed: (partial.failed || []).slice(),
                                flushError: flushMsg,
                                flushCode: (e2 && e2.code) || ''
                            };
                        } else {
                            var goneCount = 0, stillIndexed = [];
                            for (var au = 0; au < archivedUnder.length; au++) {
                                if (_items.indexOf(archivedUnder[au]) === -1) goneCount++;
                                else stillIndexed.push(archivedUnder[au]);
                            }
                            archPurged = {
                                deleted: goneCount,
                                failed: stillIndexed.map(function (x) {
                                    return { id: x.id, name: x.name, path: x.targetFolder || x.aepPath, error: flushMsg };
                                }),
                                flushError: flushMsg,
                                flushCode: (e2 && e2.code) || ''
                            };
                        }
                    }
                }
                var archFailed = archPurged.failed || [];
                if (allFailures.length || archFailed.length || archPurged.flushError) {
                    // 部分实体删除失败如实抛错（对齐单条 remove 的 failures 抛错语义；调用方
                    // folderViewMixin catch 后走「删除失败」错误 toast）——若仅 console.warn 后
                    // 正常 resolve，UI 误报「已删除文件夹」成功 toast。成功条目已 splice+flush 保留
                    // 删除效果；失败条目保留索引与磁盘文件（防下次 load 重新索引"复活"），可重试。
                    // 落盘失败单独成句，避免与部分失败计数自相矛盾。
                    var errParts = [];
                    if (allFailures.length || archFailed.length) {
                        var failedPaths = allFailures.concat(archFailed.map(function (f) {
                            return (f.name || '') + ' ' + (f.path || f.id || '') + (f.error ? '（' + f.error + '）' : '');
                        }));
                        errParts.push(AEI18n.t('部分删除失败（成功 ') + (removed.length + (archPurged.deleted || 0)) + AEI18n.t(' 个，失败 ') + (allFailures.length + archFailed.length) + AEI18n.t(' 个）: ') + failedPaths.join(', '));
                    }
                    if (archPurged.flushError) errParts.push(archPurged.flushError);
                    var delErr = new Error(errParts.join((typeof AEI18n.punct === 'function') ? AEI18n.punct('；', '; ') : '；'));
                    if (archPurged.flushCode) delErr.code = archPurged.flushCode;
                    throw delErr;
                }
                result = removed.length + (archPurged.deleted || 0);
            }
            _fm.syncFoldersOnRemove(fN, _under);
            return result;
        }

        async function setMissing(id, missing) {
            return _serialized(function () { return _setMissingInner(id, missing); });
        }
        async function _setMissingInner(id, missing) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var saved = _items[i].missing;
                    _items[i].missing = !!missing;
                    try { await _flushIndex(); }
                    catch (e) { _items[i].missing = saved; throw e; }
                    break;
                }
            }
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        function listMissing() {
            // 归档条目不参与 missing 面（生命周期归归档清扫管）
            return _items.filter(function (x) { return !!x.missing && !_isArch(x); }).slice();
        }
        async function scanMissing() { return _serialized(function () { return _scanMissingInner(); }); }
        async function _scanMissingInner() {
            var changed = false;
            // 批量探测：一次真异步往返判全部 aepPath 存在性，替代逐条同步 exists（条目多时不冻结 UI）
            // 归档条目跳过（其 .aep 在归档目录，存在性由清扫负责）
            var active = _items.filter(function (x) { return !_isArch(x); });
            var paths = [];
            for (var p0 = 0; p0 < active.length; p0++) paths.push(active[p0].aepPath);
            var existsArr = await _AEFS.existsBatch(paths);
            for (var i = 0; i < active.length; i++) {
                var exists = !!(existsArr && existsArr[i]);
                var shouldMissing = !exists;
                if (active[i].missing !== shouldMissing) {
                    active[i].missing = shouldMissing;
                    changed = true;
                }
            }
            if (changed) {
                try { await _flushIndex(); } catch (_) {}
            }
            return { missingCount: _items.filter(function (x) { return !!x.missing && !_isArch(x); }).length, changed: changed };
        }
        async function cleanMissing() { return _serialized(function () { return _cleanMissingInner(); }); }
        async function _cleanMissingInner() {
            var removed = [];
            for (var i = _items.length - 1; i >= 0; i--) {
                if (_items[i].missing && !_isArch(_items[i])) {
                    removed.push({ item: _items[i], idx: i });
                    _items.splice(i, 1);
                }
            }
            if (removed.length === 0) return { cleaned: 0 };
            try { await _flushIndex(); }
            catch (e) {
                // 回滚：removed 是倒序收集的（idx 递减），倒序遍历 = idx 递增顺序插回
                for (var r = removed.length - 1; r >= 0; r--) _items.splice(removed[r].idx, 0, removed[r].item);
                throw e;
            }
            return { cleaned: removed.length };
        }

        async function updateMeta(id, patch) {
            return _serialized(function () { return _updateMetaInner(id, patch); });
        }
        async function _updateMetaInner(id, patch) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var savedNotes = _items[i].notes;
                    var savedPreview = _items[i].previewFrame;
                    if (patch.notes !== undefined) _items[i].notes = String(patch.notes || '');
                    // 预览帧白名单字段（面板侧抓帧写入；传空值 = 清除）
                    if (patch.previewFrame !== undefined) {
                        if (patch.previewFrame && patch.previewFrame.file) {
                            _items[i].previewFrame = { file: String(patch.previewFrame.file), time: Number(patch.previewFrame.time) || 0 };
                        } else {
                            delete _items[i].previewFrame;
                        }
                    }
                    try { await _flushIndex(); }
                    catch (e) {
                        _items[i].notes = savedNotes;
                        _items[i].previewFrame = savedPreview;
                        throw e;
                    }
                    break;
                }
            }
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        // 手工重生成预览：详情区「重新截取」把 AE 当前画面抓一帧
        // 覆盖旧预览。prepared 由面板侧抓帧+缩图产出（captureCurrentFrame → preparePreviewFrame）。
        // **落盘成功才写索引**：savePrepared 失败（含 prepared 为空）时旧图与旧索引原样保留，
        // 两态不出现「索引指新时间、图还是旧的」错位。与 presetStore 同形。
        async function regeneratePreview(id, prepared) {
            var pv = _previewStore();
            if (!pv) throw new Error(AEI18n.t('previewStore 未加载'));
            var pf = await pv.savePrepared(prepared, id);
            if (!pf) throw new Error(AEI18n.t('预览写盘失败'));
            await updateMeta(id, { previewFrame: pf });
            return pf;
        }

        // ════════════════════════════════════════════════════════
        //  归档（物理目录：整包移入 <base>/___archive__/<stamp>_<名>/）
        //  删除=归档；archivedFrom 记录原 targetFolder；7 天后清扫物理删。
        // ════════════════════════════════════════════════════════
        function _archiveDirPath() { return _base + '/' + ARCHIVE_DIR; }

        // 物理库的归档/恢复/清扫在磁盘变更后
        // 绝不回滚索引（见 _flushAfterMove）——保留一个无人调用的回滚入口会诱导未来
        // 重新接回"索引说原位、磁盘说归档区"的三方分裂路径。

        // 归档区落名去重：同秒多条同名 → _2/_3 递增（磁盘与索引双查）
        async function _uniqueArchiveDir(stamp, baseName, exclude) {
            var archiveDir = _archiveDirPath();
            var candidate = archiveDir + '/' + stamp + '_' + baseName;
            var n = 1;
            while (await _AEFS.existsAsync(candidate)) {
                n++;
                candidate = archiveDir + '/' + stamp + '_' + baseName + '_' + n;
            }
            return candidate;
        }

        // 裸件（无 targetFolder）归档落名去重：与目录分支 _uniqueArchiveDir 同款语义——
        // 同秒同名不得共用目标。批量归档两条同名裸件时，后一条 copyFileAsync 会**静默覆盖**前一条的
        // 归档件，而原件已删 ⇒ 内容不可恢复、索引两条指向同一路径。索引 + 磁盘双查（不覆盖未登记既有件）。
        async function _uniqueArchiveFile(stamp, baseName, exclude) {
            var archiveDir = _archiveDirPath();
            var m = /^(.*)(\.[^.\/\\]+)$/.exec(String(baseName));
            var stem = m ? m[1] : String(baseName);
            var ext = m ? m[2] : '';
            var candidate = archiveDir + '/' + stamp + '_' + baseName;
            var n = 1;
            while (_aepIndexedAt(candidate, exclude) || await _AEFS.existsAsync(candidate)) {
                n++;
                candidate = archiveDir + '/' + stamp + '_' + stem + '_' + n + ext;
            }
            return candidate;
        }

        // 索引中是否已有条目指向该 aepPath（排除自身）——裸件去重的索引侧防线
        function _aepIndexedAt(p, exclude) {
            var f = String(p).replace(/\\/g, '/');
            for (var i = 0; i < _items.length; i++) {
                if (_items[i] === exclude) continue;
                if (String(_items[i].aepPath || '').replace(/\\/g, '/') === f) return true;
            }
            return false;
        }

        async function archive(ids, nowMs) { return _serialized(function () { return _archiveInner(ids, nowMs); }); }
        async function _archiveInner(ids, nowMs) {
            var SH = global.AEAssetsShared;
            var list = Array.isArray(ids) ? ids : [ids];
            var ts = new Date(nowMs == null ? Date.now() : nowMs).toISOString();
            var stamp = SH.archiveStamp(nowMs);
            var archiveDir = _archiveDirPath();
            var res = { archived: [], missing: [], failures: [] };
            var undo = [];
            var dirReady = false;
            for (var i = 0; i < list.length; i++) {
                var it = getById(list[i]);
                if (!it) { res.failures.push({ id: list[i], error: AEI18n.t('条目不存在') }); continue; }
                if (_isArch(it)) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('条目已是归档态') }); continue; }
                if (!it.targetFolder) {
                    // 无实体目录（理论不该出现，标准化保证所有工程套文件夹）：按裸 .aep 文件走单文件归档
                    if (!it.aepPath) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('条目无实体路径，无法归档') }); continue; }
                }
                if (it.missing) {
                    // 文件已丢失：无实体可归档 → 移除索引（回执单列 missing）
                    var idx = _items.indexOf(it);
                    _items.splice(idx, 1);
                    undo.push({ kind: 'drop', it: it, idx: idx });
                    res.missing.push({ id: it.id, name: it.name });
                    continue;
                }
                if (!dirReady) {
                    var mkOk = await _AEFS.mkdirAsync(archiveDir);
                    if (mkOk !== true) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('归档区创建失败') }); continue; }
                    dirReady = true;
                }
                var moved = false;
                var movedAsFile = false;   // 裸件（文件移动）与目录包移动在下游判据上必须区分
                var dst = null;
                var newAepPath = null;
                var saved = {
                    targetFolder: it.targetFolder, aepPath: it.aepPath,
                    archived: it.archived, archivedAt: it.archivedAt,
                    hadAt: ('archivedAt' in it), hadFrom: ('archivedFrom' in it), archivedFrom: it.archivedFrom
                };
                if (it.targetFolder) {
                    var oldDir = it.targetFolder;
                    dst = await _uniqueArchiveDir(stamp, it.name, it);
                    if (!dst) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('归档路径生成失败') }); continue; }
                    var cpOk = false;
                    try { cpOk = await _AEFS.copyDirAsync(oldDir, dst); } catch (_) { cpOk = false; }
                    if (!cpOk) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('目录复制失败（未归档·原位置保留）') }); continue; }
                    // copy 全成功才删源（cleanGarbage 同款 copy+delete 移动语义）
                    var rmRes = await _removeDir(oldDir, { skipRecycle: true });
                    if (!(rmRes && rmRes.success === true)) {
                        // 源已被部分删除（deleted>0）时不可逆——再删 dst 副本会把那些
                        // 已从源删掉的文件一起埋葬（skipRecycle 物理删除，不进回收站）。
                        // 只有"一点没动"（deleted===0）才可能走原有回滚：删副本、原位置保留、continue。
                        if (!(rmRes && rmRes.deleted > 0)) {
                            // （源整体消失）：deleted===0 ≠「源还在」——源目录在 copy 完成后被外部
                            // 删除/网络盘掉线时 listFiles/listDirs 折叠成 []、rmdir 对不存在路径恒 false，
                            // 同样得到 deleted===0；不加复核就会删掉 dst 唯一副本（源与副本双失）。
                            // 与文件级同口径：先 exists(源) 复核——源已不存在＝删除事实已成立，
                            // 保留副本、条目按移动完成继续并如实警告（不静默）；源仍在才回滚删副本。
                            var srcGone = false;
                            try { srcGone = !(await _AEFS.exists(oldDir)); } catch (_) { srcGone = false; }
                            if (!srcGone) {
                                try { await _removeDir(dst, { skipRecycle: true }); } catch (_) {}
                                res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('原目录删除失败（已回滚，原位置保留）') });
                                continue;
                            }
                            res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('删除通道回报失败但源已不存在，已按移动完成处理，副本保留') });
                        } else {
                            // 部分删除已发生：保留完整副本、条目按完成归档，并把如实说明推进 failures（不静默）
                            res.failures.push({
                                id: it.id, name: it.name,
                                error: AEI18n.t('原目录仅部分删除（残留 ') + rmRes.failures.length + AEI18n.t(' 项，源已不可逆变更）；归档副本已保留')
                            });
                        }
                    }
                    newAepPath = dst + '/' + (String(it.aepPath || '').split('/').pop() || (_baseNameFromFile(it.aepPath) || it.name + '.aep'));
                    moved = true;
                } else {
                    // 经去重（同秒同名 / 既有未登记件都不得覆盖）
                    dst = await _uniqueArchiveFile(stamp, _baseNameFromFile(it.aepPath), it);
                    var cpF = false;
                    try { cpF = await _AEFS.copyFileAsync(it.aepPath, dst); } catch (_) { cpF = false; }
                    if (!cpF) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('文件复制失败（未归档·原位置保留）') }); continue; }
                    var delF = false;
                    try { delF = await _AEFS.deleteFile(it.aepPath); } catch (_) { delF = false; }
                    // 数据安全：deleteFile 回报 false ≠「源还在」——Bridge 已执行删除但回包丢失
                    // （空闲退出/被杀/网络异常）时，cep.fs/ExtendScript 回退对「已不存在」同样返回
                    // false（同一失败语义）。必须用 exists(源) 复核：源仍在才回滚删副本；源已消失
                    // 即视为删除成功（保留副本、按移动完成继续），否则会把唯一副本删掉、源与副本双失。
                    if (!delF && await _AEFS.exists(it.aepPath)) {
                        try { await _AEFS.deleteFile(dst); } catch (_) {}
                        res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('原文件删除失败（已回滚，原位置保留）') });
                        continue;
                    }
                    if (!delF) {
                        // 通道假失败但源已不存在：不删 dst，按移动完成继续，如实警告（不静默）
                        res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('删除通道回报失败但源已不存在，已按移动完成处理，副本保留') });
                    }
                    newAepPath = dst;
                    moved = true;
                    movedAsFile = true;
                }
                if (!moved) continue;
                undo.push({ kind: 'flag', it: it, saved: saved });
                it.archivedFrom = saved.targetFolder || '';
                // 裸件（无 targetFolder）归档**不写 targetFolder**——它的语义是"归档的那个目录"，
                // 下游以它作目录判据：restore 走 copyDirAsync、_deleteArchivedPackages 走 _removeDir+rmdir。
                // 曾把 .aep 文件路径写进 targetFolder → 裸件既恢复不了（copyDir 空失败）也清扫不掉（rmdir 非目录）。
                it.targetFolder = movedAsFile ? '' : dst;
                it.aepPath = newAepPath;
                it.archived = true;
                it.archivedAt = ts;
                res.archived.push({ id: it.id, name: it.name, folder: it.folder, archivePath: dst });
            }
            if (undo.length) await _flushAfterMove();   // 不回滚：物理状态已变更（见 _flushAfterMove 注释）
            return res;
        }

        // 恢复目标：优先 archivedFrom（父目录在且目标未被占）；否则回落 _ensureUniqueDir(name, _base)
        async function _resolveRestoreTarget(it) {
            var from = String(it.archivedFrom || '').replace(/\\/g, '/').replace(/\/+$/, '');
            if (from && _inProjectAssets(from)) {
                var parent = from.replace(/\/[^\/]+$/, '');
                var parentOk = false;
                try { parentOk = await _AEFS.existsAsync(parent); } catch (_) { parentOk = false; }
                var taken = true;
                try { taken = await _AEFS.existsAsync(from); } catch (_) { taken = true; }
                if (parentOk && !taken) return from;
            }
            // 名称/路径防线：name 来自索引（可被篡改）——先过 invalidNameSeg，
            // 再由 _inProjectAssets 复核落点，防止 _base/<name> 拼出库外路径
            var badName = global.AEAssetsShared.badNameSeg
                ? global.AEAssetsShared.badNameSeg(it.name) : null;
            if (badName) return null;
            var fb = await _ensureUniqueDir(it.name, null);
            if (!fb || !_inProjectAssets(fb)) return null;
            return fb;
        }

        async function restore(ids) { return _serialized(function () { return _restoreInner(ids); }); }
        async function _restoreInner(ids) {
            var list = Array.isArray(ids) ? ids : [ids];
            var res = { restored: [], failures: [] };
            var undo = [];
            for (var i = 0; i < list.length; i++) {
                var it = getById(list[i]);
                if (!it) { res.failures.push({ id: list[i], error: AEI18n.t('条目不存在') }); continue; }
                if (!_isArch(it)) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('条目未归档') }); continue; }
                var saved = {
                    targetFolder: it.targetFolder, aepPath: it.aepPath,
                    archived: it.archived, archivedAt: it.archivedAt,
                    hadAt: ('archivedAt' in it), hadFrom: ('archivedFrom' in it), archivedFrom: it.archivedFrom
                };
                var srcPath = it.targetFolder;
                var aepBase = String(it.aepPath || '').split('/').pop();
                if (srcPath) {
                    var target = await _resolveRestoreTarget(it);
                    if (!target) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('恢复目标越界或名称非法，已拒绝（自查索引中的 name/archivedFrom）') }); continue; }
                    var cpOk = false;
                    try { cpOk = await _AEFS.copyDirAsync(srcPath, target); } catch (_) { cpOk = false; }
                    if (!cpOk) {
                        // 文案精确化：归档包被外部清理与"复制通道失败"是两种事实，不得混报
                        var pkgAlive = true;
                        try { pkgAlive = await _AEFS.existsAsync(srcPath); } catch (_) { pkgAlive = true; }
                        res.failures.push({
                            id: it.id, name: it.name,
                            error: pkgAlive ? AEI18n.t('目录恢复失败（归档副本仍在，可重试）') : AEI18n.t('归档副本已丢失（疑被外部清理），无法恢复: ') + srcPath
                        });
                        continue;
                    }
                    var rmRes = await _removeDir(srcPath, { skipRecycle: true });
                    if (!(rmRes && rmRes.success === true)) {
                        // 同归档分支——归档副本已被部分删除时不得再删新位置副本（否则已删残留
                        // 无源可取回）；deleted===0（副本一点没动）才可能走回滚删新位置、保持归档态
                        if (!(rmRes && rmRes.deleted > 0)) {
                            // 同归档分支——归档副本整体消失（外部清理/网络盘掉线）时
                            // deleted===0，删 target 会把刚恢复的唯一副本也删掉（源与副本双失）。
                            // 与文件级同口径：exists(源) 复核，源已不存在则保留 target 按恢复完成继续。
                            var srcGone = false;
                            try { srcGone = !(await _AEFS.exists(srcPath)); } catch (_) { srcGone = false; }
                            if (!srcGone) {
                                try { await _removeDir(target, { skipRecycle: true }); } catch (_) {}
                                res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('归档副本清理失败（已回滚，保持归档态）') });
                                continue;
                            }
                            res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('删除通道回报失败但源已不存在，已按移动完成处理，副本保留') });
                        } else {
                            res.failures.push({
                                id: it.id, name: it.name,
                                error: AEI18n.t('归档副本仅部分删除（残留 ') + rmRes.failures.length + AEI18n.t(' 项）；已恢复到新位置')
                            });
                        }
                    }
                    it.targetFolder = target;
                    it.aepPath = target + '/' + aepBase;
                } else {
                    // 裸文件归档（无 targetFolder）：恢复到 _base 下
                    var tfb = await _ensureUniqueDirFile(it.name + '.aep');
                    if (!tfb || !_inProjectAssets(tfb)) {
                        res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('恢复目标越界或名称非法，已拒绝') });
                        continue;
                    }
                    var targetFile = tfb;
                    var cpF = false;
                    try { cpF = await _AEFS.copyFileAsync(it.aepPath, targetFile); } catch (_) { cpF = false; }
                    if (!cpF) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('文件恢复失败（归档副本仍在）') }); continue; }
                    var delF = false;
                    try { delF = await _AEFS.deleteFile(it.aepPath); } catch (_) { delF = false; }
                    // 数据安全：同归档分支——deleteFile 回报 false ≠「源还在」，exists(源) 复核防
                    // Bridge 假失败时把已恢复的唯一副本（targetFile）当回滚对象删掉。
                    if (!delF && await _AEFS.exists(it.aepPath)) {
                        try { await _AEFS.deleteFile(targetFile); } catch (_) {}
                        res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('归档副本清理失败（已回滚，保持归档态）') });
                        continue;
                    }
                    if (!delF) {
                        // 通道假失败但归档副本已不存在：不删 targetFile，按恢复完成继续，如实警告（不静默）
                        res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('删除通道回报失败但源已不存在，已按移动完成处理，副本保留') });
                    }
                    it.aepPath = targetFile;
                }
                undo.push({ kind: 'flag', it: it, saved: saved });
                it.archived = false;
                delete it.archivedAt;
                delete it.archivedFrom;
                res.restored.push({ id: it.id, name: it.name, folder: it.folder, to: it.targetFolder || it.aepPath });
            }
            if (undo.length) await _flushAfterMove();   // 不回滚：物理状态已变更（见 _flushAfterMove 注释）
            return res;
        }

        // 裸文件恢复目标（_ensureUniqueDir 为目录语义，文件版本局部实现）
        async function _ensureUniqueDirFile(fileName) {
            var candidate = _base + '/' + fileName;
            var n = 0;
            while (await _AEFS.existsAsync(candidate)) {
                n++;
                candidate = _base + '/' + fileName.replace(/\.aep$/i, '') + '_' + n + '.aep';
            }
            return candidate;
        }

        async function archiveFolder(folder, nowMs) { return _serialized(function () { return _archiveFolderInner(folder, nowMs); }); }
        async function _archiveFolderInner(folder, nowMs) {
            var SH = global.AEAssetsShared;
            var fN = _norm(folder);
            if (!fN) throw new Error(AEI18n.t('不能归档根目录（请指定子文件夹）'));
            var ids = [];
            for (var i = 0; i < _items.length; i++) {
                if (_isArch(_items[i])) continue;   // 已归档条目不参与展开、时钟不被重置
                if (SH.folderUnder(_items[i].folder, fN)) ids.push(_items[i].id);
            }
            if (!ids.length) throw new Error(AEI18n.t('文件夹不存在或没有可归档的条目（空文件夹请用 removeFolder）'));
            if (ids.length > SH.ARCHIVE_MAX_FOLDER) {
                throw new Error(AEI18n.t('本次展开 ') + ids.length + AEI18n.t(' 条，超过单次上限 ') + SH.ARCHIVE_MAX_FOLDER + AEI18n.t('，请分批'));
            }
            var res = await _archiveInner(ids, nowMs);
            // 记录移除失败不得让整个整夹归档报错（条目已归档成功）：软降级为回执附注
            try { res.folderRecordsRemoved = await _fm.removeFolderRecords(fN); }
            catch (e) {
                res.folderRecordsRemoved = [];
                res.folderRecordsError = (e && e.message ? e.message : String(e));
            }
            return res;
        }

        async function restoreFolder(folder) { return _serialized(function () { return _restoreFolderInner(folder); }); }
        async function _restoreFolderInner(folder) {
            var SH = global.AEAssetsShared;
            var fN = _norm(folder);
            // 空串 = 根级：只恢复 folder==='' 的归档条目——面板「（根）」组按钮需要；
            // 非空走前缀递归（含子层）。恢复是安全操作，无需像 archiveFolder 那样拒绝根。
            var isRoot = (fN === '');
            var ids = [];
            for (var i = 0; i < _items.length; i++) {
                if (!_isArch(_items[i])) continue;
                var inScope = isRoot ? (_norm(_items[i].folder) === '') : SH.folderUnder(_items[i].folder, fN);
                if (inScope) ids.push(_items[i].id);
            }
            if (!ids.length) {
                throw new Error(isRoot ? AEI18n.t('根级没有归档条目') : AEI18n.t('该文件夹下没有归档条目（空文件夹请用 createFolder 创建）'));
            }
            return _restoreInner(ids);
        }

        // 落盘失败处理（物理库共用）：文件已搬移/已删除 ⇒ **绝不回滚内存**
        // ——回滚会造成「索引说在原地、磁盘说在归档区」的三方分裂：条目显示活跃但文件失踪
        // （下次 scanMissing 标 missing），归档件成"未登记"孤儿且永不被清扫认领。
        // 重试一次（瞬时故障）；仍失败则保留与磁盘一致的内存态并抛错，等下次任意成功写入
        // （含下次 load 的收尾 _flushIndex）补齐——错误码 FLUSH_FAILED_AFTER_MOVE 便于上层如实措辞。
        async function _flushAfterMove(tailMsg) {
            try { await _flushIndex(); return; }
            catch (e1) {
                try { await _flushIndex(); return; }
                catch (e2) {
                    var err = new Error(AEI18n.t('磁盘状态已变更但索引落盘失败（') + (e2 && e2.message ? e2.message : e2)
                        + AEI18n.t('）：本次操作已生效，索引将在下次成功写入时补齐；')
                        + (tailMsg || AEI18n.t('若在补齐前重启面板，归档件会显示为「未登记」（文件仍在 ___archive__ 内，可手工恢复）')));
                    err.code = 'FLUSH_FAILED_AFTER_MOVE';
                    throw err;
                }
            }
        }



        // 删除回包丢失时的存在性三态校验：AEFS.existsAsync 是
        // 两态折叠——通道故障/拒绝也会返回 false，"拿不到"被当成"已删"，索引条目被移除
        // 而归档文件仍滞留磁盘（面板里该包消失、UI 无法再恢复；文件成无人认领的孤儿）。
        // 只有 existsResult 的 NOT_FOUND 是权威"真不存在"才放行"已删除"；通道故障/
        // 拒绝/超时一律按"仍未删除"处理（宁可下次清扫重试，不可移除索引）。旧 mock/
        // 旧版 AEFS 无 existsResult 时回退 existsAsync 两态（保持逐分支等价）。
        // 存在性三态：'exists' / 'gone'（权威 NOT_FOUND）/ 'unknown'（通道故障、拒绝、旧接口不可判）
        async function _probePathState(p) {
            if (typeof _AEFS.existsResult === 'function') {
                var r = null;
                try { r = await _AEFS.existsResult(p); } catch (_) { return 'unknown'; }
                if (r && r.ok === true) return 'exists';
                if (r && r.ok === false && r.error && r.error.code === 'NOT_FOUND') return 'gone';
                return 'unknown';
            }
            try {
                var alive = await _AEFS.existsAsync(p);
                return alive ? 'exists' : 'gone';
            } catch (_) { return 'unknown'; }
        }

        async function _probePathGone(p) {
            return (await _probePathState(p)) === 'gone';
        }

        // 目录包"真不存在"复核：exists 单判据在瞬态故障（离线共享/权限拒绝）下会误判；
        // 追加父目录列表交叉校验——列表可读且仍含该目录 ⇒ 仍存在；列表不可读 ⇒ 不敢判 gone。
        // 必须用三态 listDirsResult：listDirsAsync 会把 NOT_FOUND/CHANNEL_FAILURE/REJECTED
        // 统一折叠成 []，无法区分"空目录"与"读不到"。
        async function _probeArchiveDirGone(dirPath) {
            if (!(await _probePathGone(dirPath))) return false;
            var fwd = String(dirPath).replace(/\\/g, '/').replace(/\/+$/, '');
            var slash = fwd.lastIndexOf('/');
            if (slash < 0) return false;
            var parent = fwd.slice(0, slash), leaf = fwd.slice(slash + 1);
            if (typeof _AEFS.listDirsResult !== 'function') return false;   // 旧 AEFS 无三态：保守
            var r = null;
            try { r = await _AEFS.listDirsResult(parent); } catch (_) { return false; }
            if (r && r.ok === false && r.error && r.error.code === 'NOT_FOUND') return true;   // 父目录不存在 ⇒ 目录必不存在
            if (!r || r.ok !== true || !Array.isArray(r.data)) return false;   // 列表不可读：按仍存在
            return r.data.indexOf(leaf) === -1;
        }

        // 删除核（sweep 与 purgeArchive 共用）：物理删归档包 + 删索引。
        // 第三道防线在此复核：只删位于本库 ___archive__ 下的路径（篡改索引 ⇒ 跳过计入 failed）。
        async function _deleteArchivedPackages(targets) {
            if (!targets.length) return { deleted: 0, failed: [] };
            var SH = global.AEAssetsShared;
            var del = [];
            var failed = [];
            for (var j = 0; j < targets.length; j++) {
                var it = targets[j];
                var p = it.targetFolder || it.aepPath;
                if (!_inProjectAssets(p) || !SH.underArchiveDir(_base, p)) {
                    failed.push({ id: it.id, name: it.name, path: p, error: AEI18n.t('路径不在归档区，跳过') });
                    continue;
                }
                var okOne = false;
                if (it.targetFolder) {
                    var rmRes = await _removeDir(it.targetFolder, { skipRecycle: true });
                    okOne = !!(rmRes && rmRes.success === true);
                    // 目录包也可能已被外部删除/崩溃中断：与裸文件同口径做"真不存在"复核，
                    // 否则 purge/sweep 对已消失的包永远失败，条目成僵尸；用父目录列表交叉校验，
                    // 避免瞬态 exists 失败被当成"已消失"而移除索引
                    if (!okOne) okOne = await _probeArchiveDirGone(it.targetFolder);
                } else {
                    try { okOne = await _AEFS.deleteFile(it.aepPath); } catch (_) { okOne = false; }
                    if (!okOne) okOne = await _probePathGone(it.aepPath);
                }
                if (!okOne) { failed.push({ id: it.id, name: it.name, path: p, error: AEI18n.t('归档包删除失败') }); continue; }
                del.push(it);
            }
            var undo = [];
            for (var k = 0; k < del.length; k++) {
                var idx = _items.indexOf(del[k]);
                _items.splice(idx, 1);
                undo.push({ kind: 'drop', it: del[k], idx: idx });
            }
            if (undo.length) {
                try { await _flushAfterMove(AEI18n.t('若在补齐前重启面板，归档区可能仍显示这些条目（物理文件已删除，重新清理即可）')); }   // 不回滚：物理状态已变更（见 _flushAfterMove 注释）
                catch (e) {
                    // 物理删除已完成、索引未落盘：把部分结果挂在错误上，调用方据真实结果合并回执
                    e.partial = { deleted: del.length, failed: failed };
                    throw e;
                }
            }
            // 索引移除已落盘 → 连带删预览目录（仅对物理删除成功的目标；失败项保留预览等下次）
            var _pvDel = _previewStore();
            if (_pvDel) {
                for (var pd = 0; pd < del.length; pd++) {
                    try { await _pvDel.deleteOne(del[pd].id); } catch (_) {}
                }
            }
            if (del.length) {
                // 归档目录已空 → best-effort rmdir（失败忽略）
                try {
                    var leftF = await _AEFS.listFilesAsync(_archiveDirPath());
                    var leftD = await _AEFS.listDirsAsync(_archiveDirPath());
                    if ((leftF || []).length === 0 && (leftD || []).length === 0) {
                        try { await _AEFS.rmdir(_archiveDirPath()); } catch (_) {}
                    }
                } catch (_) {}
            }
            return { deleted: del.length, failed: failed };
        }

        // 7 天清扫：物理删过期归档包（跳过回收站）+ 删索引
        async function sweepArchive(nowMs) { return _serialized(function () { return _sweepArchiveInner(nowMs); }); }
        async function _sweepArchiveInner(nowMs) {
            var SH = global.AEAssetsShared;
            var t = nowMs == null ? Date.now() : nowMs;
            var kept = 0;
            var expired = [];
            for (var i = 0; i < _items.length; i++) {
                if (!_isArch(_items[i])) continue;
                if (SH.archiveExpiredAt(_items[i], t)) expired.push(_items[i]);
                else kept++;
            }
            var r = await _deleteArchivedPackages(expired);
            _lastSweep = { at: new Date(t).toISOString(), deleted: r.deleted, failed: r.failed.length, kept: kept };
            return { deleted: r.deleted, failed: r.failed, kept: kept };
        }

        // 立即清理（仅 UI 归档区面板；LLM 面无此 mode）：
        // 不做 TTL 判定——用户显式点击即视为确认永久清理。
        // opts.ids 指定条目 / opts.folder 指定原文件夹（递归）/ 都不给 = 清空整个归档区。
        async function purgeArchive(opts) { return _serialized(function () { return _purgeArchiveInner(opts); }); }
        async function _purgeArchiveInner(opts) {
            opts = opts || {};
            var fN = _norm(opts.folder || '');
            var ids = Array.isArray(opts.ids) ? opts.ids : null;
            var targets = [];
            for (var i = 0; i < _items.length; i++) {
                if (!_isArch(_items[i])) continue;
                if (ids) { if (ids.indexOf(_items[i].id) === -1) continue; }
                else if (fN !== '' && !global.AEAssetsShared.folderUnder(_items[i].folder, fN)) continue;
                targets.push(_items[i]);
            }
            return _deleteArchivedPackages(targets);
        }

        return {
            getBaseDir: getBaseDir,
            list: list,
            load: load,
            addMeta: addMeta,
            addMetaBatch: addMetaBatch,
            rename: rename,
            remove: remove,
            move: move,
            moveBatch: moveBatch,
            renameFolder: renameFolder,
            renameFoldersBatch: renameFoldersBatch,
            removeFolder: removeFolder,
            setMissing: setMissing,
            listMissing: listMissing,
            scanMissing: scanMissing,
            cleanMissing: cleanMissing,
            updateMeta: updateMeta,
            regeneratePreview: regeneratePreview,
            listGarbage: listGarbage,
            cleanGarbage: cleanGarbage,
            // 空虚拟文件夹
            createFolder: createFolder,
            deleteEmptyFolder: deleteEmptyFolder,
            listEmptyFolders: listEmptyFolders,
            // 备注 / 查找 / 归档（删除=归档）
            getById: getById,
            listArchive: listArchive,
            getLastSweep: getLastSweep,
            archive: archive,
            restore: restore,
            archiveFolder: archiveFolder,
            restoreFolder: restoreFolder,
            sweepArchive: sweepArchive,
            purgeArchive: purgeArchive,
            listUnregisteredArchive: listUnregisteredArchive
        };
    }

    global.AEAssetsShared.createProjectAssetStore = createProjectAssetStore;
})(window);
