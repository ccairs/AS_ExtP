(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    var NS = 'presets';

    function _norm(f) { return String(f || '').replace(/^\/+|\/+$/g, ''); }
    // 归档态判定（热路径内联判据；语义与 AEAssetsShared.isArchived 一致）
    function _isArch(it) { return !!(it && it.archived); }
    // 系统目录（归档区/垃圾区）判定：孤儿收编与空目录扫描一律跳过——
    // 不跳过则归档的 .ffx 下次 load 被 _discoverOrphans 收编回正常条目（假归档）
    function _isSystemDirName(name) {
        var n = String(name || '');
        var SH = global.AEAssetsShared;
        // 归档区精确匹配：前缀匹配会把用户目录 ___archive__备份 一并排除——
        // 其下 .ffx 将永不被收编也不可见（静默消失）。___trash__ 保留既有前缀口径（旧方案兼容）
        if (n === SH.ARCHIVE_DIR_NAME) return true;
        return n.indexOf('___trash__') === 0;
    }
    function _genId() { return 'pr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
    function _now() { return new Date().toISOString(); }

    function presetBaseName(fileName) {
        return String(fileName || '').replace(/\.ffx$/i, '');
    }
    function _baseNameFromFile(p) {
        var s = String(p || '').replace(/\\/g, '/');
        var i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
    }
    // 纵深防御：路径必须在指定 base（数据目录的 presets）内
    // 仅检查含 /presets/ 段不够——索引被篡改后 ffxPath 可指向其他位置的
    // presets 目录，必须以 base 为前缀。
    function _inPresets(p, base) {
        var fwd = String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
        if (fwd.indexOf('/../') !== -1) return false;
        if (fwd.indexOf('/./') !== -1) return false;
        var len = fwd.length;
        if (len >= 3 && fwd.lastIndexOf('/..') === len - 3) return false;
        if (len >= 2 && fwd.lastIndexOf('/.') === len - 2) return false;
        var baseFwd = String(base || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        return fwd.indexOf(baseFwd + '/') === 0 || fwd === baseFwd;
    }

    // 从 ffxPath 推导物理文件夹（相对 _base）
    function _folderFromPath(ffxPath, base) {
        var abs = String(ffxPath || '').replace(/\\/g, '/');
        var b = base.replace(/\\/g, '/').replace(/\/+$/, '');
        if (abs.indexOf(b + '/') !== 0) return '';
        var rel = abs.slice(b.length + 1);
        var ls = rel.lastIndexOf('/');
        return ls >= 0 ? _norm(rel.slice(0, ls)) : '';
    }

    function createPresetStore(opts) {
        opts = opts || {};
        var _AEFS = opts.AEFS || global.AEFS;
        var dataDir = opts.dataDir || (global.AEShared && global.AEShared.getDataDir ? global.AEShared.getDataDir().dir : '');
        var _base = String(dataDir).replace(/\\/g, '/').replace(/\/+$/, '') + '/assets/' + NS;
        var _items = [];
        // 上次清扫留痕：{ at, deleted, failed, kept }——UI 归档面板头部展示
        var _lastSweep = null;
        var _indexPath = _base + '/index.json';
        var _emptyDirs = [];

        // 收编孤儿 .ffx 的元数据探测：手动拷入的预设没有 AE 侧来源信息，
        // 详情里的「大小 / KF / EXP / FX」恒为 0/false（不可信）；改从 .ffx 字节本体
        // 静态读出（判据与真机 11 样本对照见 ffxMeta.js 头注释）；探测失败（桥离线/解析不了）
        // 返回 null，调用方保留旧行为——不编造元数据。
        // 同一层目录的候选并行探测，避免大库首扫逐文件串行等桥。
        function _probeOrphanMetas(paths) {
            var SH = global.AEAssetsShared;
            if (!SH.readFfxMeta) return Promise.resolve(paths.map(function () { return null; }));
            return Promise.all(paths.map(function (p) {
                try {
                    return Promise.resolve(SH.readFfxMeta(_AEFS, p)).catch(function () { return null; });
                } catch (e) { return null; }
            })).then(function (metas) {
                // 探测失败的如实留痕（一次一条，不逐文件刷屏）：通道故障/格式不认识时
                // 元数据会退回 0/false，日志是唯一线索
                var failed = 0;
                for (var i = 0; i < metas.length; i++) if (!metas[i]) failed++;
                if (failed) console.warn('[presetStore] ' + failed + '/' + paths.length + ' 个新收编预设元数据探测失败（大小/KF/EXP/FX 暂缺）');
                return metas;
            });
        }
        // 统一形状：探测成功用真值，失败保留旧行为（0/false）
        function _metaFields(meta) {
            return {
                size: (meta && meta.size > 0) ? meta.size : 0,
                hasKeyframes: !!(meta && meta.hasKeyframes),
                hasExpressions: !!(meta && meta.hasExpressions),
                hasEffects: !!(meta && meta.hasEffects)
            };
        }

        // 预览帧协作件：落盘 / 删除 / 回收统一走 previewStore（两库同形，见该文件头）。
        // 落点是**库外**独立根 <dataDir>/assets/previews/presets/<id>/preview.jpg——预设是共享真实
        // 目录树里的裸 .ffx 文件，没有 per-item 目录；做同目录兄弟文件（foo.ffx + foo.jpg）要在
        // move / rename / 跨目录改文件夹三处补随迁逻辑，且预设库无垃圾回收机制 → 孤儿 .jpg 永久残留

        // 懒解析：manifest 里 previewStore.js 先于本文件加载，生产环境必然可用；只加载本文件的
        // 沙箱里可能缺失，此时预览相关动作降级为 no-op 并 warn 一次（不静默）。预览是附加物，
        // 缺它不该让素材库主功能构造失败。
        var _preview = null;
        var _previewWarned = false;
        function _previewStore() {
            if (_preview) return _preview;
            var SH = global.AEAssetsShared;
            if (!SH || typeof SH.createPreviewStore !== 'function') {
                if (!_previewWarned) {
                    _previewWarned = true;
                    console.warn('[presetStore] previewStore 未加载：预览帧删除/回收降级为 no-op');
                }
                return null;
            }
            _preview = SH.createPreviewStore({ AEFS: _AEFS, dataDir: dataDir, lib: 'presets' });
            return _preview;
        }

        var _writeQueue = Promise.resolve();
        function _serialized(fn) {
            var p = _writeQueue.then(fn, fn);
            _writeQueue = p.then(function () {}, function () {});
            return p;
        }

        function getBaseDir() { return _base; }
        function getIndexPath() { return _indexPath; }
        // list() 默认排除归档条目（归档区对常规读路径/UI 树不可见；
        // 归档条目经 listArchive() 或 getById() 访问）
        function list() { return _items.filter(function (x) { return !_isArch(x); }); }
        function getLastSweep() { return _lastSweep; }

        function listArchive() { return _items.filter(function (x) { return _isArch(x); }).slice(); }

        // 归档区内未登记项（盘上有、索引无）：不删、不自动登记，仅报告（fail-safe 可见性）。
        // 索引丢失时归档文件成"僵尸"——清扫只删索引登记项，故必须让用户看见它们。
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
                if (!_indexedAt(p)) out.push(p);
            }
            return out;
        }
        function getById(id) {
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) return _items[i];
            }
            return null;
        }
        function listEmptyFolders() { return _emptyDirs.slice(); }

        // ── 扫描物理空目录（无 .ffx 的目录一律列入，含中间目录）──
        // 归档区/垃圾区子树整体跳过（系统目录不参与"空文件夹"呈现，也不该被空目录清理 rmdir）
        async function _scanEmptyDirs(dirPath, relativePath, out) {
            if (relativePath && _isSystemDirName(String(relativePath).split('/')[0])) return;
            var hasFfx = false;
            try {
                var files = await _AEFS.listFilesAsync(dirPath);
                if (Array.isArray(files)) {
                    for (var i = 0; i < files.length; i++) {
                        if (/\.ffx$/i.test(files[i])) { hasFfx = true; break; }
                    }
                }
            } catch (_) {}
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(dirPath); } catch (_) {}
            if (Array.isArray(subDirs)) {
                for (var d = 0; d < subDirs.length; d++) {
                    var subRel = relativePath ? relativePath + '/' + subDirs[d] : subDirs[d];
                    await _scanEmptyDirs(dirPath + '/' + subDirs[d], subRel, out);
                }
            }
            if (!hasFfx && relativePath) out.push(relativePath);
        }

        async function _refreshEmptyDirs() {
            var out = [];
            await _scanEmptyDirs(_base, '', out);
            _emptyDirs = out;
        }

        // 局部更新空文件夹缓存：只重判给定相对路径目录是否为空（目录自身是否有 .ffx）。
        // "空"定义与 _scanEmptyDirs 一致（!hasFfx && relativePath），且与子目录无连锁，
        // 故移动/增删单个预设只影响其所在目录，无需全树扫描（避免每次操作 O(树) 的 XHR 累积）。
        // 传入 dirRels 为相对 _base 的路径数组（如 ['a/b']）；''（根目录）不参与缓存。
        async function _refreshEmptyFolders(dirRels) {
            if (!Array.isArray(dirRels) || !dirRels.length) return;
            var seen = [];
            for (var i = 0; i < dirRels.length; i++) {
                var rel = _norm(dirRels[i]);
                if (!rel || seen.indexOf(rel) !== -1) continue;
                if (_isSystemDirName(rel.split('/')[0])) continue;   // 归档区/垃圾区不参与空文件夹缓存
                seen.push(rel);
                var hasFfx = false;
                try {
                    var files = await _AEFS.listFilesAsync(_base + '/' + rel);
                    if (Array.isArray(files)) {
                        for (var j = 0; j < files.length; j++) {
                            if (/\.ffx$/i.test(files[j])) { hasFfx = true; break; }
                        }
                    }
                } catch (_) {}
                var idx = _emptyDirs.indexOf(rel);
                if (hasFfx && idx !== -1) _emptyDirs.splice(idx, 1);
                else if (!hasFfx && idx === -1) _emptyDirs.push(rel);
            }
        }

        // ── 递归清理空目录（bottom-up rmdir）──
        // removed（可选，出参）：实际被删掉的相对路径——调用方据此同步 _emptyDirs 缓存
        // （缓存不同步＝树上留下"归档/删除后原地遗留的空文件夹"幽灵，见 _pruneEmptyAncestors 注释）
        async function _cleanupEmptyDirs(dirPath, relativePath, removed) {
            removed = removed || [];
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(dirPath); } catch (_) { return removed; }
            if (Array.isArray(subDirs)) {
                for (var d = 0; d < subDirs.length; d++) {
                    await _cleanupEmptyDirs(dirPath + '/' + subDirs[d], relativePath ? relativePath + '/' + subDirs[d] : subDirs[d], removed);
                }
            }
            if (!relativePath) return removed;
            var files = [];
            try { files = await _AEFS.listFilesAsync(dirPath); } catch (_) {}
            var subAfter = [];
            try { subAfter = await _AEFS.listDirsAsync(dirPath); } catch (_) {}
            if (files.length === 0 && subAfter.length === 0) {
                var ok = false;
                try { ok = await _AEFS.rmdir(dirPath); } catch (_) { ok = false; }
                if (ok) removed.push(relativePath);
            }
            return removed;
        }

        // 祖先空链清理（对齐 renameFolder 的②旧父链向上删空链）：归档 'a/b/c' 后 a/b、a 若在物理上
        // 已空，同样要删——否则原地留下空壳目录，树上（_emptyDirs/目录扫描）就多出一个
        // "归档后遗留的空文件夹"。只在**确已空**（无文件、无子目录）时删，遇到非空即停。
        async function _pruneEmptyAncestors(fN, removed) {
            removed = removed || [];
            var parent = String(fN).lastIndexOf('/') >= 0 ? String(fN).slice(0, String(fN).lastIndexOf('/')) : '';
            while (parent) {
                var pAbs = _base + '/' + parent;
                if (!_inPresetsBase(pAbs)) break;
                var pFiles = [], pDirs = [];
                try { pFiles = await _AEFS.listFilesAsync(pAbs); } catch (_) { break; }
                try { pDirs = await _AEFS.listDirsAsync(pAbs); } catch (_) { break; }
                if (!Array.isArray(pFiles) || !Array.isArray(pDirs)) break;
                if (pFiles.length || pDirs.length) break;
                var ok = false;
                try { ok = await _AEFS.rmdir(pAbs); } catch (_) { ok = false; }
                if (!ok) break;
                removed.push(parent);
                parent = parent.lastIndexOf('/') >= 0 ? parent.slice(0, parent.lastIndexOf('/')) : '';
            }
            return removed;
        }

        // ── 加载 ──
        async function load() { return _serialized(function () { return _loadInner(); }); }
        async function _loadInner() {
            // 三态读取（单点助手 readManifestThreeState）——读失败
            // （CHANNEL_FAILURE/REJECTED）时中止本次加载：旧路径把读失败折叠为空索引，
            // 随后 _discoverOrphans 按磁盘重建 + _flushIndex 覆盖 index.json，用户维护的
            // notes/来源图层/hasKeyframes 元数据永久丢失（且此分支
            // 无 .corrupt.bak 保护）。NOT_FOUND（真没有）/ok('')（空文件，数据已失，
            // 重建即恢复）按空重建，与旧 readFile null 折叠口径逐字等价。
            var rs = await global.AEAssetsShared.readManifestThreeState(_AEFS, _indexPath);
            if (rs.state === 'failed') {
                throw new Error(AEI18n.t('预设库 index.json 读取失败(') + rs.code + (rs.channel ? '@' + rs.channel : '') + AEI18n.t(')，已中止加载以防覆盖'));
            }
            var raw = rs.raw;
            if (!raw) { _items = []; }
            else {
                try {
                    var data = JSON.parse(raw);
                    _items = Array.isArray(data && data.items) ? data.items : [];
                } catch (e) {
                    // 解析失败先保留 .corrupt.bak 再置空（不再静默）——其后
                    // _discoverOrphans + _flushIndex 会立即用重建数据覆盖损坏文件，
                    // .bak 必须在覆盖前完成保留（按磁盘 .ffx 重建只救回文件条目，
                    // 用户维护的 notes/来源图层/hasKeyframes 元数据仅存 .bak）
                    console.warn('[presetStore] index.json 解析失败，已保留损坏文件为 ' + _indexPath + '.corrupt.bak，按空重建: ' + (e && e.message ? e.message : e));
                    _items = [];
                    await global.AEAssetsShared.backupCorruptFile(_AEFS, _indexPath);
                }
            }
            // 迁移：folder 从物理路径推导，覆盖旧虚拟 folder
            // 归档条目例外：其 ffxPath 指向 ___archive__，重算会把恢复目标
            // （原位置）冲掉——归档条目的 folder 恒保留归档前的位置
            for (var i = 0; i < _items.length; i++) {
                // tags 字段已废弃：载入即剔除旧值，
                // 随下方 _flushIndex 从 index.json 里消失（不做字段就永远留着死数据）
                delete _items[i].tags;
                if (_isArch(_items[i])) continue;
                _items[i].folder = _folderFromPath(_items[i].ffxPath, _base);
            }
            await _discoverOrphans(_base, '');
            await _backfillMeta();
            await _refreshEmptyDirs();
            try { await _flushIndex(); } catch (_) {}
            // 预览回收：保留集合 = 当前索引持有的全部 id（存活 ∪ 已归档——归档→恢复往返期间
            // 条目仍在 _items 里带 archived 标志，预览必须留着）。
            // 兜住所有删除挂点够不到的角落：崩溃中断的删除、cleanMissing、missing 分支的归档、
            // _discoverOrphans 重新收编（换 id）、索引损坏后重建。
            try {
                var _pvGc = _previewStore();
                if (_pvGc) {
                    var _keepIds = [];
                    for (var _pi = 0; _pi < _items.length; _pi++) _keepIds.push(_items[_pi].id);
                    await _pvGc.gc(_keepIds);
                }
            } catch (_) {}
        }

        // ── 元数据补测（存量侧）──
        // 收编时未探测元数据的条目 size 恒为 0（写死的 0/false），刷新时给这些「从未探测成功」
        // 的条目补一次静态探测——判据是 size 为 0/缺失：真 .ffx 恒非空，探测成功必得 >0，
        // 故此标记天然幂等（已探测成功的不重复读盘）。只补派生字段（大小/三标志），
        // 用户维护的 notes/source 一律不动；归档/missing 条目不碰（文件可能已不在原位）。
        async function _backfillMeta() {
            var pending = [];
            for (var i = 0; i < _items.length; i++) {
                var it = _items[i];
                if (it.missing || _isArch(it)) continue;
                if (it.size > 0) continue;
                pending.push(it);
            }
            if (!pending.length) return 0;
            var metas = await _probeOrphanMetas(pending.map(function (it) { return it.ffxPath; }));
            var filled = 0;
            for (var k = 0; k < pending.length; k++) {
                if (!metas[k]) continue;
                var mf = _metaFields(metas[k]);
                if (!mf.size) continue;
                pending[k].size = mf.size;
                pending[k].hasKeyframes = mf.hasKeyframes;
                pending[k].hasExpressions = mf.hasExpressions;
                pending[k].hasEffects = mf.hasEffects;
                filled++;
            }
            if (filled) console.log('[presetStore] 元数据补测 ' + filled + '/' + pending.length + ' 条（历史收编无大小/KF/EXP/FX）');
            return filled;
        }

        // ── 自动发现孤儿 .ffx ──
        // 归档区/垃圾区跳过（不跳过则归档条目下次 load 被收编回正常条目——假归档）
        async function _discoverOrphans(dirPath, relativePath) {
            if (relativePath && _isSystemDirName(String(relativePath).split('/')[0])) return;
            var files = [];
            try { files = await _AEFS.listFilesAsync(dirPath); } catch (_) { files = []; }
            var candidates = [];   // 通过全部过滤的候选 → 批量探测元数据后再落条目
            for (var i = 0; i < files.length; i++) {
                var fn = files[i];
                if (!/\.ffx$/i.test(fn)) continue;
                var ffxPath = dirPath + '/' + fn;
                // 归档标识防线（纵深防御）：路径落在 ___archive__ 之下即不收编——
                // 目录名防线（_isSystemDirName）之外再按路径判一次，防归档区被改名/嵌套布局
                // 变化时未登记归档件被收编成"活"条目（其后的清扫判据又不认它，成永久僵尸）
                if (global.AEAssetsShared.underArchiveDir(_base, ffxPath)) continue;
                var alreadyIndexed = false;
                for (var j = 0; j < _items.length; j++) {
                    if (_items[j].ffxPath === ffxPath) { alreadyIndexed = true; break; }
                }
                if (alreadyIndexed) continue;
                // 收编前校验文件名合法性（对齐 projectAssetStore._standardize）——
                // 含 %/引号等受限字符的 .ffx 被 AEFS._checkPath 全拒（deleteFile/exists 恒
                // false），收编后成为「删除后自动复活」的幽灵条目（删除复核误判已删净→
                // 索引删成功、磁盘残留→下次刷新再收编）
                var _orphanBad = global.AEAssetsShared.invalidNameSeg
                    ? global.AEAssetsShared.invalidNameSeg(presetBaseName(fn)) : null;
                if (_orphanBad) {
                    console.warn('[presetStore] 跳过非法文件名孤儿（不收编，请手动重命名）: ' + ffxPath + ' — ' + _orphanBad);
                    continue;
                }
                candidates.push({ fn: fn, ffxPath: ffxPath });
            }
            var newItems = [];
            if (candidates.length) {
                var metas = await _probeOrphanMetas(candidates.map(function (c) { return c.ffxPath; }));
                for (var ci = 0; ci < candidates.length; ci++) {
                    var fxc = candidates[ci];
                    var mf = _metaFields(metas[ci]);
                    _items.push({
                        id: _genId(), name: presetBaseName(fxc.fn),
                        folder: _norm(relativePath || ''), ffxPath: fxc.ffxPath,
                        source: { layerName: '', propertyPath: '' }, createdAt: _now(),
                        notes: '',
                        hasKeyframes: mf.hasKeyframes, hasExpressions: mf.hasExpressions,
                        hasEffects: mf.hasEffects, size: mf.size
                    });
                    newItems.push(_items[_items.length - 1]);
                }
            }
            if (newItems.length) {
                try { await _flushIndex(); console.log('[presetStore] 发现 ' + newItems.length + ' 个孤儿 .ffx，已自动索引'); }
                catch (e) { console.warn('[presetStore] 孤儿索引写入失败: ' + (e && e.message ? e.message : e)); }
            }
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(dirPath); } catch (_) { subDirs = []; }
            for (var d = 0; d < subDirs.length; d++) {
                var subRel = relativePath ? (relativePath + '/' + subDirs[d]) : subDirs[d];
                await _discoverOrphans(dirPath + '/' + subDirs[d], subRel);
            }
        }

        async function _flushIndex() {
            // 原子写（.tmp → rename）——写盘窗口中断不再截断 index.json
            // （否则损坏 → 静默置空 → _discoverOrphans 重建 + 立即覆盖，元数据归零固化）
            var ok = await global.AEAssetsShared.atomicWriteJson(_AEFS, _indexPath, JSON.stringify({ version: 1, items: _items }, null, 2));
            if (!ok) { console.warn('[presetStore] 写 index.json 失败'); throw new Error(AEI18n.t('写入 index.json 失败')); }
        }

        // 删除回包 false 时的复核（与 projectAssetStore 归档分支的 exists 复核同口径）：
        // deleteFile 回包丢失（实际已删）不得 _recordUndeleted —— 否则移动/改名后旧路径多出
        // 一条 missing:true 幽灵条目（用户看到"移动后的新条目 + 源文件夹里的丢失条目"两条）。
        // exists 折叠 false（含通道故障）按"已不存在"放行（源已删 = 删除成功）；
        // 复核抛错时保守按"仍在"处理（维持旧的补偿记录，防孤儿重索引）。
        async function _sourceStillExists(p) {
            try { return !!(await _AEFS.exists(p)); } catch (_) { return true; }
        }

        // ── 删除旧 .ffx 失败的补偿记录 ──
        // 索引已指向新路径后旧文件删除失败时，把旧路径记入索引（missing 条目）：
        // _discoverOrphans 按 ffxPath 全等判重，索引中有记录（无论 missing）就不会把旧文件
        // 重新索引成重复条目；残留记录由用户经 scanMissing/cleanMissing 清理
        // skipFlush=true 时只改内存不落盘（批量场景由调用方收尾统一写 1 次）
        async function _recordUndeleted(paths, skipFlush) {
            var added = [];
            for (var i = 0; i < paths.length; i++) {
                var p = paths[i];
                var dup = false;
                for (var j = 0; j < _items.length; j++) {
                    if (_items[j].ffxPath === p) { dup = true; break; }
                }
                if (dup) continue;
                added.push({
                    id: _genId(), name: presetBaseName(_baseNameFromFile(p)),
                    folder: _folderFromPath(p, _base), ffxPath: p, missing: true,
                    source: { layerName: '', propertyPath: '' }, createdAt: _now(),
                    notes: '', hasKeyframes: false, hasExpressions: false, hasEffects: false, size: 0
                });
            }
            if (!added.length) return;
            for (var k = 0; k < added.length; k++) _items.push(added[k]);
            if (skipFlush) return;
            try { await _flushIndex(); }
            catch (e) {
                // 补偿记录写失败：回滚内存保持与磁盘一致，仅降级 warn（原操作本身已成功）
                for (var r = added.length - 1; r >= 0; r--) {
                    var idx = _items.indexOf(added[r]);
                    if (idx !== -1) _items.splice(idx, 1);
                }
                console.warn('[presetStore] 删除失败补偿记录写入失败: ' + (e && e.message ? e.message : e));
            }
        }

        // 递归收集目录下所有 .ffx 文件路径（删除失败补偿记录用）
        async function _collectFfxPaths(dirPath, out) {
            var files = [];
            try { files = await _AEFS.listFilesAsync(dirPath); } catch (_) { return; }
            if (Array.isArray(files)) {
                for (var i = 0; i < files.length; i++) {
                    if (/\.ffx$/i.test(files[i])) out.push(dirPath + '/' + files[i]);
                }
            }
            var subDirs = [];
            try { subDirs = await _AEFS.listDirsAsync(dirPath); } catch (_) { return; }
            if (Array.isArray(subDirs)) {
                for (var d = 0; d < subDirs.length; d++) {
                    await _collectFfxPaths(dirPath + '/' + subDirs[d], out);
                }
            }
        }

        // 纵深防御：路径必须在 _base（数据目录的 presets）内，防 .. 逃逸和索引篡改后指向其他 presets 目录
        // 对齐 projectAssetStore._inProjectAssets
        function _inPresetsBase(p) {
            var fwd = String(p || '').replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
            if (fwd.indexOf('/../') !== -1) return false;
            if (fwd.indexOf('/./') !== -1) return false;
            var len = fwd.length;
            if (len >= 3 && fwd.lastIndexOf('/..') === len - 3) return false;
            if (len >= 2 && fwd.lastIndexOf('/.') === len - 2) return false;
            var baseFwd = String(_base).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            return fwd.indexOf(baseFwd + '/') === 0 || fwd === baseFwd;
        }

        // 索引级占位检测——missing 条目（含 _recordUndeleted 补偿记录）的 ffxPath 指向
        // 已不存在的文件，文件系统探测不到，防重须同时查索引（对齐 _mkMeta 的 ffxPath 查重，
        // missing 条目参与判定），否则 move/rename/keepItems 会产生同 ffxPath 双条目（内容串用）。
        // exclude 为去重中的自身条目（其 ffxPath 尚未更新到新路径）
        function _indexedAt(p, exclude) {
            for (var i = 0; i < _items.length; i++) {
                if (_items[i] !== exclude && _items[i].ffxPath === p) return true;
            }
            return false;
        }

        // ── 添加元信息 ──
        async function addMeta(o) { return _serialized(function () { return _addMetaInner(o); }); }
        // 构造 meta（校验 + 构建，不 push、不落盘）。单条 addMeta 与批量 addMetaBatch 共用。
        function _mkMeta(o) {
            o = o || {};
            if (!_inPresets(o.ffxPath, _base)) throw new Error(AEI18n.t('ffxPath 不在 presets 数据目录内'));
            for (var d = 0; d < _items.length; d++) {
                if (_items[d].ffxPath === o.ffxPath) throw new Error(AEI18n.t('该预设文件已索引: ') + o.ffxPath);
            }
            var meta = {
                id: _genId(),
                name: o.name || presetBaseName(_baseNameFromFile(o.ffxPath)),
                folder: _folderFromPath(o.ffxPath, _base),
                ffxPath: o.ffxPath,
                source: o.source || { layerName: '', propertyPath: '' },
                createdAt: o.createdAt || _now(),
                notes: o.notes || '',
                hasKeyframes: !!o.hasKeyframes,
                hasExpressions: !!o.hasExpressions,
                hasEffects: !!o.hasEffects,
                size: o.size || 0
            };
            return meta;
        }

        // 预览帧落盘：把面板侧已缩好的小图（o.previewSource = { blob, time }）写到该条目的
        // 预览目录，并把 { file, time } 记进 meta。按生成的 id 写，故与 addMeta 同一步完成
        // ——不产生第二次索引写。失败只 warn 一行，条目不写 previewFrame（预览是附加物）。
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
            var meta = _mkMeta(o);
            await _attachPreview(meta, o);
            _items.push(meta);
            try { await _flushIndex(); }
            catch (e) { _items.pop(); throw e; }
            // 新增预设所在目录必有 .ffx，只会从空列表移除；局部刷新即可
            await _refreshEmptyFolders([_folderFromPath(meta.ffxPath, _base)]);
            return meta;
        }
        // 批量导入：循环内只改内存，末尾一次 flush（替代逐条 addMeta 的 N 次全量重写）。
        // 保持 _serialized 原子性 + 失败回滚（flush 失败移除本次新增项）。
        // 约定：批量场景均为新增（导入文件路径唯一），不做覆盖旧条目；与单条 addMeta 的回滚语义对齐。
        async function addMetaBatch(metas) {
            if (!Array.isArray(metas) || !metas.length) return [];
            return _serialized(function () {
                var added = [];
                for (var i = 0; i < metas.length; i++) added.push(_mkMeta(metas[i]));
                // 预览帧：本批共用同一张已缩好的小图（一次保存可能产出多个 .ffx），
                // 逐条目按各自 id 写一份——故缩图只做一次、写盘 N 次
                return metas.reduce(function (chain, o, idx) {
                    return chain.then(function () { return _attachPreview(added[idx], o); });
                }, Promise.resolve()).then(function () {
                    for (var j = 0; j < added.length; j++) _items.push(added[j]);
                    return _flushIndex();
                }).then(function () {
                    return added;
                }).catch(function (e) {
                    for (var k = 0; k < added.length; k++) {
                        var idx = _items.indexOf(added[k]);
                        if (idx !== -1) _items.splice(idx, 1);
                    }
                    throw e;
                }).then(function (addedArr) {
                    // 局部刷新：只重判新增预设所在目录（去空/去重由内部处理）；失败不致命，不触发回滚
                    var rels = [];
                    for (var b = 0; b < addedArr.length; b++) {
                        var r = _folderFromPath(addedArr[b].ffxPath, _base);
                        if (r && rels.indexOf(r) === -1) rels.push(r);
                    }
                    return _refreshEmptyFolders(rels).then(function () { return addedArr; }, function () { return addedArr; });
                });
            });
        }

        // ── 编辑备注 ──
        async function updateMeta(id, patch) { return _serialized(function () { return _updateMetaInner(id, patch); }); }
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
        // 两态不出现「索引指新时间、图还是旧的」错位。
        async function regeneratePreview(id, prepared) {
            var pv = _previewStore();
            if (!pv) throw new Error(AEI18n.t('previewStore 未加载'));
            var pf = await pv.savePrepared(prepared, id);
            if (!pf) throw new Error(AEI18n.t('预览写盘失败'));
            await updateMeta(id, { previewFrame: pf });
            return pf;
        }

        // ── 改名 ──
        async function rename(id, newName) { return _serialized(function () { return _renameInner(id, newName); }); }
        async function _renameInner(id, newName) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var old = _items[i];
                    var newFfxPath = old.ffxPath.replace(/[^\\/]+\.ffx$/i, function () { return newName + '.ffx'; });
                    if (newFfxPath !== old.ffxPath) {
                        // 重名检测（对齐 _moveInner 的 existsAsync 惯例）——renameFile 的契约是
                        // dst 已存在即静默覆盖删除旧文件，不拦会把目标 .ffx 覆盖丢失（原预设永久丢失 +
                        // 索引两条目指向同一路径，被覆盖条目从此应用错误内容）。重命名语义应报错拒绝，
                        // 不做自动改名；大小写改名须放行：大小写不敏感文件系统上目标探测会命中自身
                        // 补索引级查重——目标路径被 missing 条目占位时文件系统探测不到，
                        // 不拦会产生同 ffxPath 双条目（应用时实际执行另一条目刚写入的文件内容）
                        if (_indexedAt(newFfxPath, old) ||
                            (newFfxPath.toLowerCase() !== old.ffxPath.toLowerCase() && await _AEFS.existsAsync(newFfxPath))) {
                            throw new Error(AEI18n.t('同名预设已存在: ') + newName);
                        }
                        var savedName = old.name, savedFfx = old.ffxPath;
                        old.name = newName; old.ffxPath = newFfxPath;
                        try { await _flushIndex(); }
                        catch (e) { old.name = savedName; old.ffxPath = savedFfx; throw e; }
                        try {
                            var renFfx = await _AEFS.renameFile(savedFfx, newFfxPath);
                            if (!renFfx) throw new Error(AEI18n.t('ffx 改名失败'));
                        } catch (e) {
                            old.name = savedName; old.ffxPath = savedFfx;
                            try { await _flushIndex(); } catch (_) { console.error('[presetStore] rename 回滚 flush 失败'); }
                            throw e;
                        }
                    } else {
                        var savedName2 = old.name;
                        old.name = newName;
                        try { await _flushIndex(); }
                        catch (e) { old.name = savedName2; throw e; }
                    }
                    break;
                }
            }
            // 找不到 id 须拒绝：静默 resolve 会被调用方（bootstrap _wrap）当作成功 → LLM 假成功
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        // ── 移动条目到物理目录（copyFile + deleteFile）──
        // 单个移动：立即局部刷新受影响的空文件夹缓存。
        // _moveInner 对未知 id 返回 false（moveBatch 批量契约：静默跳过陈旧 id）；
        // 单条入口转抛错，防调用方（bootstrap _wrap）把 false/undefined 一律当成功
        async function move(id, targetFolder) {
            return _serialized(function () {
                return _moveInner(id, targetFolder, null).then(function (ok) {
                    if (ok === false) throw new Error(AEI18n.t('条目不存在: ') + id);
                    return ok;   // 保留 _moveInner 的返回契约（true = 成功定位并处理）
                });
            });
        }

        // 单条移动核心。返回是否成功定位并移动（false = 未找到 id）。
        // dirRels 为可选的目录收集数组：批量移动时传入共享数组，仅收集不刷新，
        // 由 moveBatch 末尾统一去重刷新一次，避免 N 个文件移到同目录时重复 listFiles。
        // skipFlush 为 true 时跳过 _flushIndex（批量场景由 moveBatch 收尾统一写 1 次，
        // 避免 N 个文件 N 次全量索引落盘）；单条回滚照常（内存态还原即可，索引未动）。
        async function _moveInner(id, targetFolder, dirRels, skipFlush) {
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    var oldPath = _items[i].ffxPath;
                    var bn = _baseNameFromFile(oldPath);
                    var tf = _norm(targetFolder || '');
                    // 目标不得是系统目录（归档区/垃圾区）——否则条目"物理在归档区、
                    // 索引活跃"，孤儿收编排除 + 清扫不认领，状态无法自愈
                    if (tf && _isSystemDirName(String(tf).split('/')[0])) {
                        throw new Error(AEI18n.t('不能移动到系统目录（归档区/垃圾区）: ') + tf);
                    }
                    var newPath = tf ? (_base + '/' + tf + '/' + bn) : (_base + '/' + bn);

                    // 同路径（移动到条目已所在的文件夹）须在重名检测前短路：
                    // exists 探测的是文件自身，放后面会把 newPath 挤成 _1 后缀 → 无端改名
                    if (newPath === oldPath) return true;

                    // 重名检测：目标已存在则加 _1, _2...
                    // 补索引级占位判定——目标路径被 missing 条目占位时文件系统探测不到，
                    // 不查索引会出现同 ffxPath 双条目（先查索引可省一次探测往返）
                    var dedupCounter = 0;
                    var nameStem = presetBaseName(bn);
                    while (_indexedAt(newPath, _items[i]) || await _AEFS.existsAsync(newPath)) {
                        dedupCounter++;
                        bn = nameStem + '_' + dedupCounter + '.ffx';
                        newPath = tf ? (_base + '/' + tf + '/' + bn) : (_base + '/' + bn);
                    }

                    var targetDir = newPath.replace(/\/[^\/]+$/, '');
                    var mkOk = await _AEFS.mkdirAsync(targetDir);
                    if (mkOk !== true) throw new Error(AEI18n.t('无法创建目标目录'));

                    var cpOk = await _AEFS.copyFileAsync(oldPath, newPath);
                    if (!cpOk) throw new Error(AEI18n.t('文件复制失败'));

                    var savedPath = _items[i].ffxPath, savedFolder = _items[i].folder, savedName = _items[i].name;
                    _items[i].ffxPath = newPath;
                    _items[i].folder = _folderFromPath(newPath, _base);
                    if (dedupCounter > 0) _items[i].name = nameStem + '_' + dedupCounter;
                    // 批量（skipFlush）跳过逐条 flush（moveBatch 收尾统一写）；删除旧文件
                    // 对单条/批量都必须执行——批量若在此提前返回，移动退化为复制，旧文件会被
                    // 下次 load 的 _discoverOrphans 重新索引成重复条目
                    if (!skipFlush) {
                        try { await _flushIndex(); }
                        catch (e) {
                            _items[i].ffxPath = savedPath; _items[i].folder = savedFolder; _items[i].name = savedName;
                            try { await _AEFS.deleteFile(newPath); } catch (_) {}
                            throw e;
                        }
                    }

                    var delOk = await _AEFS.deleteFile(oldPath);
                    // 回包丢失但源已删 → 视为删除成功、不记 undeleted（否则留下 missing 幽灵条目）
                    if (!delOk && await _sourceStillExists(oldPath)) {
                        console.warn('[presetStore] move: 旧文件删除失败 ' + oldPath + '，已记入 missing 条目防孤儿重索引');
                        await _recordUndeleted([oldPath], skipFlush);
                    }
                    // 局部刷新：只重判源目录（可能变空）与目标目录（必然非空）两个点，避免全树扫描。
                    // 批量场景由 moveBatch 统一刷新，此处仅收集目录。
                    if (Array.isArray(dirRels)) {
                        dirRels.push(_folderFromPath(oldPath, _base), _folderFromPath(newPath, _base));
                    } else {
                        await _refreshEmptyFolders([_folderFromPath(oldPath, _base), _folderFromPath(newPath, _base)]);
                    }
                    return true;
                }
            }
            return false;
        }

        // ── 批量移动：复用单条移动核心，收集所有源/目标目录后统一去重刷新一次 ──
        // 相比逐个 move（每个都立即局部刷新），避免同一目标目录被重复 listFiles。
        // 索引同样收尾统一写 1 次（批内 skipFlush）：N 个文件从 N 次全量索引落盘
        // 降为 1 次；中途失败先 flush 已完成部分再抛错（已移动的文件不丢索引）。
        async function moveBatch(ids, targetFolder, onProgress) {
            var list = Array.isArray(ids) ? ids.slice() : [];
            return _serialized(function () {
                var dirRels = [];
                var moved = 0;
                var total = list.length;
                var n = 0;
                return list.reduce(function (chain, id) {
                    return chain.then(function () {
                        return _moveInner(id, targetFolder, dirRels, true).then(function (ok) {
                            if (ok) moved++;
                            n++;
                            // 进度回调统一形状 (done, failed, total)（三库统一）：
                            // 本库每搬一个文件都是一次真实 I/O，故逐条回调——UI 侧按「首次回调时
                            // 建卡片」，只有这种慢批量才会出现进度卡片。
                            if (onProgress) onProgress(moved, n - moved, total);
                        });
                    });
                }, Promise.resolve()).then(function () {
                    if (moved > 0) return _flushIndex();
                }).then(function () {
                    return _refreshEmptyFolders(dirRels).then(function () { return moved; });
                }, function (err) {
                    // 中途失败：已完成部分先落盘（尽力），再抛原始错误
                    return _flushIndex().catch(function () {}).then(function () { throw err; });
                });
            });
        }

        // ── 删除条目 ──
        async function remove(id) { return _serialized(function () { return _removeInner(id); }); }
        async function _removeInner(id) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var removed = _items.splice(i, 1)[0];
                    try { await _flushIndex(); }
                    catch (e) { _items.splice(i, 0, removed); throw e; }
                    try { await _AEFS.deleteFile(removed.ffxPath); } catch (e2) {}
                    var stillThere = await _AEFS.exists(removed.ffxPath);
                    // exists 折叠 false 可能是通道故障而非真删——existsResult
                    // 三态复核：CHANNEL_FAILURE/REJECTED（无法确认已删）按删除失败处理
                    // 恢复索引，防磁盘 .ffx 残留被下次 load 的孤儿收编重建（用户维护的
                    // notes/来源元数据丢失）；NOT_FOUND（真删）放行
                    if (stillThere === false && typeof _AEFS.existsResult === 'function') {
                        try {
                            var _recheck = await _AEFS.existsResult(removed.ffxPath);
                            if (_recheck && _recheck.ok === false && _recheck.error && _recheck.error.code !== 'NOT_FOUND') {
                                stillThere = true;   // 无法确认按未删（fail-safe）
                            }
                        } catch (_) {}
                    }
                    if (stillThere) {
                        _items.splice(i, 0, removed);
                        try { await _flushIndex(); } catch (_) {}
                        throw new Error(AEI18n.t('预设文件删除失败，已恢复索引: ') + removed.ffxPath);
                    }
                    // 文件确认已删 → 连带删预览目录。挂在 exists 三态复核**之后**：复核失败会
                    // 恢复索引（条目仍在），此时预览不能提前删。
                    var _pv1 = _previewStore();
                    if (_pv1) { try { await _pv1.deleteOne(removed.id); } catch (_) {} }
                    // 局部刷新：被删文件所在目录可能因此变空，重判该目录即可
                    await _refreshEmptyFolders([_folderFromPath(removed.ffxPath, _base)]);
                    break;
                }
            }
            // 找不到 id 须拒绝：静默 resolve 会被调用方（bootstrap _wrap）当作成功 → LLM 假成功
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        async function setMissing(id, missing) { return _serialized(function () { return _setMissingInner(id, missing); }); }
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

        // ── 批量清理丢失索引（ffx 文件不存在但索引仍在）──
        function listMissing() {
            // 归档条目不参与 missing 面（生命周期归归档清扫管）
            return _items.filter(function (x) { return !!x.missing && !_isArch(x); }).slice();
        }
        // 扫描所有条目检测 ffx 文件是否存在，更新 missing 标记
        async function scanMissing() { return _serialized(function () { return _scanMissingInner(); }); }
        async function _scanMissingInner() {
            var changed = false;
            // 批量探测：一次真异步往返判全部 ffx 存在性，替代逐条同步 XHR（几万预设时不冻结 UI）
            // 归档条目跳过（其文件在归档区，存在性由清扫负责）
            var active = _items.filter(function (x) { return !_isArch(x); });
            var paths = active.map(function (x) { return x.ffxPath; });
            var results;
            try { results = await _AEFS.existsBatch(paths); }
            catch (_) { return { missingCount: _items.filter(function (x) { return !!x.missing && !_isArch(x); }).length }; }
            for (var i = 0; i < active.length; i++) {
                var exists = !!(results && results[i]);
                var shouldMissing = !exists;
                if (active[i].missing !== shouldMissing) {
                    active[i].missing = shouldMissing;
                    changed = true;
                }
            }
            if (changed) {
                try { await _flushIndex(); } catch (_) {}
            }
            return { missingCount: _items.filter(function (x) { return !!x.missing && !_isArch(x); }).length };
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

        // ── 文件夹操作（物理目录，不再使用 .folders.json 虚拟文件夹体系）──

        // 入 _serialized 队列——mkdir + 局部刷新若与队列内 load() 的全量重扫
        // （_refreshEmptyDirs 整体覆盖 _emptyDirs）交错，会丢失新建目录或残留已删目录的幽灵显示
        async function createFolder(folderPath) {
            var fp = _norm(folderPath);
            if (!fp) return false;
            return _serialized(function () { return _createFolderInner(fp); });
        }
        async function _createFolderInner(fp) {
            // 不得建系统保留目录（归档区/垃圾区）——预设库是实体目录，同名即与归档区物理同路径
            if (global.AEAssetsShared.badReservedFolderSeg && global.AEAssetsShared.badReservedFolderSeg(fp)) return false;
            var ok = await _AEFS.mkdir(_base + '/' + fp);
            if (ok === true) await _refreshEmptyFolders([fp]);
            return ok === true;
        }

        async function renameFolder(oldPath, newPath) { return _serialized(function () { return _renameFolderInner(oldPath, newPath); }); }

        // ── 批量移动文件夹：串行执行单文件夹移动（skipHousekeeping），索引写收尾统一 1 次。
        // 空目录善后按 job 定向处理（_housekeepCrossDirMove，O(子树+深度)），不再全树扫描。
        // 任一失败：已完成部分先落盘（尽力）再抛错，调用方继续/中止自行决策。
        async function renameFoldersBatch(jobs, onProgress) {
            var list = Array.isArray(jobs) ? jobs.slice() : [];
            return _serialized(function () {
                var done = 0, failed = 0;
                return list.reduce(function (chain, job) {
                    return chain.then(function () {
                        return _renameFolderInner(job.src, job.dst, true).then(function () {
                            done++;
                            // 同父目录 renameDir 原子移动：缓存前缀平移即可；
                            // 跨目录移动：定向善后（旧子树清理+父链删空+新子树入缓存）
                            var oN = _norm(job.src), nN = _norm(job.dst);
                            if (oN && nN) {
                                var sameParent2 = (oN.lastIndexOf('/') >= 0 ? oN.slice(0, oN.lastIndexOf('/')) : '') ===
                                    (nN.lastIndexOf('/') >= 0 ? nN.slice(0, nN.lastIndexOf('/')) : '');
                                if (sameParent2) _shiftEmptyDirsPrefix(oN, nN);
                                else return _housekeepCrossDirMove(oN, nN);
                            }
                        }, function (err) {
                            failed++;
                            if (job.onError) { try { job.onError(err); } catch (_) {} }
                        }).then(function () {
                            if (onProgress) onProgress(done, failed, list.length);
                        });
                    });
                }, Promise.resolve()).then(function () {
                    // 索引落盘失败须向上传播（对齐 moveBatch）：吞错会让物理已移动的文件夹
                    // 重启后变 missing，UI 却报"已移动 N 个"假成功
                    if (done > 0) return _flushIndex();
                }).then(function () {
                    return { done: done, failed: failed };
                });
            });
        }
        // skipHousekeeping：批量场景（renameFoldersBatch）跳过内部的 flushIndex 与
        // 全树清理/重扫（每个文件夹一次 → 收尾统一 1 次）；内存态更新照常
        async function _renameFolderInner(oldPath, newPath, skipHousekeeping) {
            var oldN = _norm(oldPath), newN = _norm(newPath);
            // 重命名目标不得落在系统目录下（如 'a' → '___archive__/a' 会把物理目录搬进归档区）
            if (newN && _isSystemDirName(String(newN).split('/')[0])) {
                throw new Error(AEI18n.t('不能重命名到系统目录（归档区/垃圾区）: ') + newN);
            }
            if (oldN === newN) return;
            // 自嵌套防护——newN 落在 oldN 子树下时，跨父分支的 copyDir 会把
            // 目录递归复制进自身（无限膨胀），须整体拒绝（对齐 _moveFolder 的既有口径）
            if (oldN && newN && newN.indexOf(oldN + '/') === 0) {
                throw new Error(AEI18n.t('不能重命名到自身子路径下: ') + newN);
            }

            // 收集受影响条目
            var affected = [];
            for (var i = 0; i < _items.length; i++) {
                var f = _norm(_items[i].folder);
                if (f === oldN || (oldN.length > 0 && f.indexOf(oldN + '/') === 0)) {
                    affected.push({ idx: i, oldFfx: _items[i].ffxPath, oldFolder: _items[i].folder });
                }
            }

            // 同父目录 → renameDir 快速路径
            var oldParent = oldN.lastIndexOf('/') >= 0 ? oldN.slice(0, oldN.lastIndexOf('/')) : '';
            var newParent = newN.lastIndexOf('/') >= 0 ? newN.slice(0, newN.lastIndexOf('/')) : '';
            var sameParent = (oldParent === newParent) && oldN !== '' && newN !== '';

            if (sameParent) {
                // 同父 renameDir 对已存在 dst 走「删旧目录再改名」覆盖语义——目标下
                // 条目/物理空目录会被并吞（静默合并无提示无撤销，目标未索引 .ffx 物理丢失），
                // 须占用检测（对齐视图层 _moveFolder 的口径，收口行内重命名/批量
                // 拖拽/LLM 入口三个旁路）。跨父分支不拦：命中索引占位时走的 _1 去重
                // 契约（copyFile 链自动避让，非静默合并）。oldN 子树条目随迁移不算占用
                if (newN) {
                    for (var gi = 0; gi < _items.length; gi++) {
                        var gf = _norm(_items[gi].folder);
                        if (gf === oldN || gf.indexOf(oldN + '/') === 0) continue;
                        if (gf === newN || gf.indexOf(newN + '/') === 0) {
                            throw new Error(AEI18n.t('目标文件夹已存在: ') + newN);
                        }
                    }
                    if (_emptyDirs.indexOf(newN) !== -1) {
                        throw new Error(AEI18n.t('目标文件夹已存在: ') + newN);
                    }
                }
                var renDirOk = await _AEFS.renameDir(_base + '/' + oldN, _base + '/' + newN);
                if (!renDirOk) throw new Error(AEI18n.t('目录重命名失败'));
                var saved = [];
                for (var j = 0; j < affected.length; j++) {
                    var a = affected[j];
                    var bn = _baseNameFromFile(a.oldFfx);
                    var relNew = _norm(a.oldFolder) === oldN ? newN : _norm(newN + '/' + _norm(a.oldFolder).slice(oldN.length + 1));
                    var newFfx = relNew ? (_base + '/' + relNew + '/' + bn) : (_base + '/' + bn);
                    saved.push({ idx: a.idx, ffxPath: _items[a.idx].ffxPath, folder: _items[a.idx].folder });
                    _items[a.idx].ffxPath = newFfx;
                    _items[a.idx].folder = _folderFromPath(newFfx, _base);
                }
                if (skipHousekeeping) return;
                try { await _flushIndex(); }
                catch (e) {
                    for (var r = 0; r < saved.length; r++) { _items[saved[r].idx].ffxPath = saved[r].ffxPath; _items[saved[r].idx].folder = saved[r].folder; }
                    // 磁盘目录一并回滚（尽力）：renameDir 已先行，索引写失败若不还原目录，
                    // 磁盘指向新路径而索引停在旧路径，下次 load 的孤儿发现会把新路径文件
                    // 重新索引成重复条目（对齐跨目录分支的磁盘回滚与单条 rename 的回滚语义）
                    try { await _AEFS.renameDir(_base + '/' + newN, _base + '/' + oldN); } catch (_) {}
                    throw e;
                }
                // renameDir 原子重命名不改变空文件夹事实，仅路径前缀整体平移（无全树扫描），
                // 与批量路径（renameFoldersBatch）的 _shiftEmptyDirsPrefix 对齐，防幽灵目录残留
                _shiftEmptyDirsPrefix(oldN, newN);
            } else if (affected.length > 0) {
                // 跨目录：copyFile + deleteFile
                var todo = [];
                for (var k = 0; k < affected.length; k++) {
                    var bnk = _baseNameFromFile(affected[k].oldFfx);
                    var fOld = _norm(affected[k].oldFolder);
                    var relNew = fOld === oldN ? newN : _norm(newN + '/' + fOld.slice(oldN.length + 1));
                    var nf = relNew ? (_base + '/' + relNew + '/' + bnk) : (_base + '/' + bnk);
                    todo.push({ idx: affected[k].idx, oldFfx: affected[k].oldFfx, newFfx: nf, newFolder: relNew });
                }
                // 建目标目录
                var created = [];
                for (var m = 0; m < todo.length; m++) {
                    var td = todo[m].newFfx.replace(/\/[^\/]+$/, '');
                    if (created.indexOf(td) === -1) {
                        // mkdir 对已存在目录同样返回 true，须先探测区分「本次新建」——
                        // 失败回滚只允许删自己新建的目录，不能误删用户已有的同名目录（哪怕为空）
                        var tdExisted = false;
                        try { tdExisted = (await _AEFS.existsAsync(td)) === true; } catch (_) {}
                        var mkOk = await _AEFS.mkdir(td);
                        if (mkOk !== true) {
                            for (var rc = 0; rc < created.length; rc++) { try { await _AEFS.rmdir(created[rc]); } catch (_) {} }
                            throw new Error(AEI18n.t('无法创建目标目录'));
                        }
                        if (!tdExisted) created.push(td);
                    }
                }
                // 复制（带重名检测）
                for (var n = 0; n < todo.length; n++) {
                    if (todo[n].oldFfx === todo[n].newFfx) continue;
                    // 目标已存在则加 _1, _2...
                    // 索引级占位判定（口径同 rename/_moveInner/removeFolder）——
                    // 目标路径被 missing 条目占位时文件系统探测不到，不查索引会出现同
                    // ffxPath 双条目（条目指向另一条目刚写入的文件内容）；exclude 传
                    // todo[n].idx 对应条目自身（此刻其 ffxPath 仍指向旧路径）
                    var dedupN = 0;
                    var stemN = presetBaseName(_baseNameFromFile(todo[n].newFfx));
                    var newFfxN = todo[n].newFfx;
                    while (_indexedAt(newFfxN, _items[todo[n].idx]) || await _AEFS.exists(newFfxN)) {
                        dedupN++;
                        var dedupBn = stemN + '_' + dedupN + '.ffx';
                        newFfxN = (todo[n].newFolder ? (_base + '/' + todo[n].newFolder + '/' + dedupBn) : (_base + '/' + dedupBn));
                    }
                    if (dedupN > 0) {
                        todo[n].newFfx = newFfxN;
                        todo[n].dedupName = stemN + '_' + dedupN;
                    }
                    var cpOk = await _AEFS.copyFile(todo[n].oldFfx, todo[n].newFfx);
                    if (!cpOk) {
                        for (var rb = 0; rb < n; rb++) { if (todo[rb].oldFfx !== todo[rb].newFfx) try { await _AEFS.deleteFile(todo[rb].newFfx); } catch (_) {} }
                        // 回滚补目录清理——只删本次新建的目标目录（倒序先删深层；rmdir 拒绝
                        // 非空，部分文件未清时自然失败跳过），否则空目录残留被下次 load 收入
                        // _emptyDirs 成树上幽灵目录
                        for (var rd = created.length - 1; rd >= 0; rd--) { try { await _AEFS.rmdir(created[rd]); } catch (_) {} }
                        throw new Error(AEI18n.t('文件复制失败'));
                    }
                }
                // 更新索引
                var saved2 = [];
                for (var p = 0; p < todo.length; p++) {
                    saved2.push({ idx: todo[p].idx, ffxPath: _items[todo[p].idx].ffxPath, folder: _items[todo[p].idx].folder, name: _items[todo[p].idx].name });
                    _items[todo[p].idx].ffxPath = todo[p].newFfx;
                    _items[todo[p].idx].folder = todo[p].newFolder;
                    if (todo[p].dedupName) _items[todo[p].idx].name = todo[p].dedupName;
                }
                if (!skipHousekeeping) {
                    try { await _flushIndex(); }
                    catch (e) {
                        for (var r2 = 0; r2 < saved2.length; r2++) { _items[saved2[r2].idx].ffxPath = saved2[r2].ffxPath; _items[saved2[r2].idx].folder = saved2[r2].folder; _items[saved2[r2].idx].name = saved2[r2].name; }
                        for (var rb2 = 0; rb2 < todo.length; rb2++) { if (todo[rb2].oldFfx !== todo[rb2].newFfx) try { await _AEFS.deleteFile(todo[rb2].newFfx); } catch (_) {} }
                        // 回滚补目录清理——只删本次新建的目标目录（对齐复制失败分支
                        // 的同一做法：倒序先删深层，rmdir 拒绝非空自然跳过），否则空目录残留
                        // 被下次 load 收入 _emptyDirs 成树上幽灵目录
                        for (var rd2 = created.length - 1; rd2 >= 0; rd2--) { try { await _AEFS.rmdir(created[rd2]); } catch (_) {} }
                        throw e;
                    }
                }
                // 删旧文件
                for (var q = 0; q < todo.length; q++) {
                    if (todo[q].oldFfx === todo[q].newFfx) continue;
                    var delOk = await _AEFS.deleteFile(todo[q].oldFfx);
                    // 回包丢失但源已删 → 视为删除成功、不记 undeleted（否则留下 missing 幽灵条目）
                    if (!delOk && await _sourceStillExists(todo[q].oldFfx)) {
                        console.warn('[presetStore] renameFolder: 旧文件删除失败 ' + todo[q].oldFfx + '，已记入 missing 条目防孤儿重索引');
                        await _recordUndeleted([todo[q].oldFfx], skipHousekeeping);
                    }
                }
                if (skipHousekeeping) return;
                // 定向善后：旧子树清理+父链删空+缓存前缀处理（替代全树 cleanup+重扫）
                await _housekeepCrossDirMove(oldN, newN);
            } else if (oldN && newN) {
                // 纯空目录跨父移动：AEFS.renameDir 无条件拒跨目录（仅同父目录原子重命名），
                // 须整目录复制 + 递归删除旧目录；空目录物理上可能含未索引 .ffx 孤儿文件，
                // 故整树复制而非仅 mkdir 新目录（删除手段对齐 removeFolder 的 removeDirRecursive）
                var cpDirOk = await _AEFS.copyDir(_base + '/' + oldN, _base + '/' + newN);
                if (!cpDirOk) throw new Error(AEI18n.t('目录复制失败'));
                // 用户取消 removeDirRecursive 的确认弹窗会抛 {code:'CANCELLED'}（契约源 aefs.js
                // 注释：调用方须 catch 并跳过后续处理，否则取消被误判为技术故障）。
                // 取消 = 放弃移动：旧目录未删，copyDir 已复制的新目录必须回滚删除——否则新旧目录
                // 双份 .ffx 孤儿并存、_emptyDirs 缓存脱节。取消是用户主动行为，单条入口（renameFolder）
                // 不抛错（防上层误报「移动文件夹失败」），也不执行 _shiftEmptyDirsPrefix（移动未发生，
                // 缓存前缀不得平移）；批量入口（renameFoldersBatch，skipHousekeeping）rethrow 记入
                // failed——若吞掉，批量的 then() 会把未移动的旧子树当已搬走做善后（误删旧树空子目录、
                // 已回滚的新目录被扫描出幽灵缓存条目）
                var rmDirOk;
                try {
                    rmDirOk = await _AEFS.removeDirRecursive(_base + '/' + oldN);
                } catch (e) {
                    if (e && e.code === 'CANCELLED') {
                        try { await _AEFS.removeDirRecursive(_base + '/' + newN); } catch (_) {}
                        if (skipHousekeeping) throw e;
                        return;
                    }
                    throw e;
                }
                if (!rmDirOk) {
                    console.warn('[presetStore] renameFolder: 旧目录删除失败 ' + oldN + '，残留 .ffx 已记入 missing 条目防孤儿重索引');
                    // 空目录物理上可能含未索引 .ffx 孤儿文件（copyDir 已复制到新目录），
                    // 残留旧文件须记入索引防 _discoverOrphans 把旧目录孤儿重新索引进来与新目录副本成重复对
                    var leftover = [];
                    await _collectFfxPaths(_base + '/' + oldN, leftover);
                    await _recordUndeleted(leftover, skipHousekeeping);
                }
                // 目录整体平移不改变空文件夹事实，仅路径前缀整体平移（无全树扫描）
                _shiftEmptyDirsPrefix(oldN, newN);
            }
        }

        // 把 _emptyDirs 中以 oldN 或 oldN/ 开头的路径替换为 newN 前缀（renameDir 原子重命名专用，无全树扫描）
        function _shiftEmptyDirsPrefix(oldN, newN) {
            if (!oldN || !newN) return;
            for (var ek = _emptyDirs.length - 1; ek >= 0; ek--) {
                var en = _emptyDirs[ek];
                if (en === oldN) _emptyDirs[ek] = newN;
                else if (en.indexOf(oldN + '/') === 0) _emptyDirs[ek] = newN + en.slice(oldN.length);
            }
        }

        // ── 跨目录移动文件夹的定向善后（替代全树 cleanup+重扫，O(新旧子树+深度)）──
        // ① 旧子树 scoped bottom-up 删空目录（目录整体搬走后残留的中间目录）
        // ② 旧父链向上删空链（旧目录搬走后父目录可能变全空）
        // ③ 空目录缓存剔除旧前缀条目
        // ④ 新子树 scoped 扫描入缓存（新建中间目录无 .ffx，按"空"定义需入缓存）
        async function _housekeepCrossDirMove(oldN, newN) {
            // ① 旧子树定向清理（磁盘上目录已搬走，扫描失败静默跳过）
            try { await _cleanupEmptyDirs(_base + '/' + oldN, oldN); } catch (_) {}
            // ② 旧父链向上删空链（目录已不存在，listDirs 为空即停）
            var parent = oldN.lastIndexOf('/') >= 0 ? oldN.slice(0, oldN.lastIndexOf('/')) : '';
            while (parent) {
                var pAbs = _base + '/' + parent;
                var pFiles = [], pDirs = [];
                try { pFiles = await _AEFS.listFilesAsync(pAbs); } catch (_) { break; }
                try { pDirs = await _AEFS.listDirsAsync(pAbs); } catch (_) { break; }
                if (pFiles.length || pDirs.length) break;
                try { if (!(await _AEFS.rmdir(pAbs))) break; } catch (_) { break; }
                _emptyDirs = _emptyDirs.filter(function (e) { return e !== parent; });
                parent = parent.lastIndexOf('/') >= 0 ? parent.slice(0, parent.lastIndexOf('/')) : '';
            }
            // ③ 缓存剔除旧前缀
            _emptyDirs = _emptyDirs.filter(function (e) { return e !== oldN && e.indexOf(oldN + '/') !== 0; });
            // ④ 新子树 scoped 扫描入缓存
            var newOut = [];
            await _scanEmptyDirs(_base + '/' + newN, newN, newOut);
            for (var i = 0; i < newOut.length; i++) {
                if (_emptyDirs.indexOf(newOut[i]) === -1) _emptyDirs.push(newOut[i]);
            }
        }

        async function removeFolder(folderPath, keepItems, onProgress, isCancelled) { return _serialized(function () { return _removeFolderInner(folderPath, keepItems, onProgress, isCancelled); }); }
        async function _removeFolderInner(folderPath, keepItems, onProgress, isCancelled) {
            var fN = _norm(folderPath);
            var result = 0;
            function _under(f, prefix) {
                if (f === prefix) return true;
                if (prefix.length > 0 && f.indexOf(prefix + '/') === 0) return true;
                return false;
            }
            if (keepItems) {
                // 快照遍历（先对"本轮待处理条目"取快照，循环只遍历快照）——若以
                // _items.length 为上界，而循环体内的 _recordUndeleted 会向 _items 追加一条
                // missing 补偿条目（其 folder 仍在本文件夹下），该新条目被同一轮再次命中 →
                // 再次 copyFile（磁盘真的多写一份）+ 再次追加 → 循环永不终止（磁盘写爆 + 面板
                // 卡死）。快照遍历保证只处理调用时已存在的条目，对外语义不变：条目仍提升
                // 到根目录，删除失败仍如实记 missing。
                var targets = [];
                for (var kk = 0; kk < _items.length; kk++) {
                    if (_under(_norm(_items[kk].folder), fN)) targets.push(_items[kk]);
                }
                var kTotal = targets.length;
                var kDone = 0;
                // 同一次调用内同一 oldPath 只记一次 missing（快照中可能存在指向同一物理文件的重复条目）
                var recordedUndeleted = {};
                for (var i = 0; i < targets.length; i++) {
                    var it = targets[i];
                    kDone++;
                    if (onProgress) onProgress(kDone, kTotal);
                    var oldPath = it.ffxPath;
                    var bn = _baseNameFromFile(oldPath);
                    var newPath = _base + '/' + bn;

                    // 同路径（条目已在根目录）须在重名检测前短路：
                    // exists 探测的是文件自身，放后面会把 newPath 挤成 _1 后缀 → 自我复制
                    if (newPath === oldPath) continue;

                    // 重名检测：目标已存在则加 _1, _2...
                    // 索引级占位判定——目标路径被 missing 条目（含已提升条目）占位时
                    // 文件系统探测不到，不查索引会出现同 ffxPath 双条目
                    var dedupCounter2 = 0;
                    var nameStem2 = presetBaseName(bn);
                    while (_indexedAt(newPath, it) || await _AEFS.exists(newPath)) {
                        dedupCounter2++;
                        bn = nameStem2 + '_' + dedupCounter2 + '.ffx';
                        newPath = _base + '/' + bn;
                    }

                    var cpOk = await _AEFS.copyFile(oldPath, newPath);
                    if (!cpOk) throw new Error(AEI18n.t('文件复制失败: ') + bn);
                    var savedPath = it.ffxPath, savedFolder = it.folder, savedName = it.name;
                    it.ffxPath = newPath; it.folder = '';
                    if (dedupCounter2 > 0) it.name = nameStem2 + '_' + dedupCounter2;
                    try { await _flushIndex(); }
                    catch (e) {
                        it.ffxPath = savedPath; it.folder = savedFolder; it.name = savedName;
                        try { await _AEFS.deleteFile(newPath); } catch (_) {}
                        throw e;
                    }
                    var delOk = await _AEFS.deleteFile(oldPath);
                    // 回包丢失但源已删 → 视为删除成功、不记 undeleted（否则留下 missing 幽灵条目）
                    if (!delOk && await _sourceStillExists(oldPath)) {
                        if (!recordedUndeleted[oldPath]) {
                            console.warn('[presetStore] removeFolder: 旧文件删除失败 ' + oldPath + '，已记入 missing 条目防孤儿重索引');
                            await _recordUndeleted([oldPath], false);
                            recordedUndeleted[oldPath] = true;
                        }
                    }
                }
                result = 0;
            } else {
                // ⚠️ 危险操作：removeDirRecursive 递归删整棵目录树（含 .ffx + 子目录 + 孤儿文件），不可恢复
                // 预设使用实体物理文件夹，优先 removeDirRecursive 一次删整个目录树（1 次同步 XHR）
                // 失败回退逐个 deleteFile（N 次 XHR）。对齐 projectAssetStore._removeDir 策略。
                // 安全保障（对齐 projectAssetStore._removeDir）：
                //   ① fN 非空检查（防删 _base 根）
                //   ② _inPresetsBase 检查（路径必须在 _base 内，防 .. 逃逸）
                //   ③ 拒删 _base 根（显式比较，纵深防御）
                //   ④ removeDirRecursive 自带 _checkPath/_safeForDelete(presets)/_depthOk(2)
                if (!fN) throw new Error(AEI18n.t('不能删除根目录'));
                var targetDir = _base + '/' + fN;
                // ② 路径必须在 _base 内（防 .. 逃逸）
                if (!_inPresetsBase(targetDir)) {
                    console.warn('[presetStore] removeFolder 拒非 presets 路径: ' + targetDir);
                    throw new Error(AEI18n.t('目标路径不在预设目录内'));
                }
                // ③ 拒删 _base 根（纵深防御，fN 非空已间接防但显式更安全）
                var baseFwd = String(_base).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                var dirFwd = String(targetDir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
                if (dirFwd === baseFwd) {
                    console.warn('[presetStore] removeFolder 拒删 presets 根: ' + targetDir);
                    throw new Error(AEI18n.t('不能删除预设根目录'));
                }
                // 收集匹配条目（按 item.folder 前缀匹配）
                var toRemove = [];
                for (var m = 0; m < _items.length; m++) {
                    if (_under(_norm(_items[m].folder), fN)) toRemove.push(_items[m]);
                }
                // 删目录（含所有 .ffx + 子目录 + 孤儿文件）
                // 用户取消 AEFS 内部确认弹窗 → removeDirRecursive 抛 {code:'CANCELLED'}。
                // 让 CANCELLED 直接向上传播（不在此 return）：调用方据此静默处理，
                // 既不会误判为"技术故障"回退逐个 deleteFile 物理删除（异常中断，下方回退不执行），
                // 也不会在用户取消时误显示"已删除"成功 toast。
                var recOk = await _AEFS.removeDirRecursive(targetDir);
                var delFailures = [];
                if (!recOk) {
                    // 回退：逐个 deleteFile（removeDirRecursive 失败或 Bridge 不可用）
                    var cancelled = false;
                    for (var n = 0; n < toRemove.length; n++) {
                        // 用户点进度卡片「取消」：中止后续删除
                        if (isCancelled && isCancelled()) { cancelled = true; break; }
                        var ffxPath = toRemove[n].ffxPath;
                        var delOk = await _AEFS.deleteFile(ffxPath);
                        if (onProgress) onProgress(n + 1, toRemove.length);
                        // deleteFile 返回 false 时再 exists 确认（防 Bridge 撒谎），返回 true 信任以省 XHR
                        if (!delOk && await _AEFS.exists(ffxPath)) {
                            delFailures.push(toRemove[n]);
                        }
                    }
                    if (cancelled) {
                        // 用户取消：抛 CANCELLED 让共享调用方（folderViewMixin）提示已删除数量，不误显示成功/失败
                        var _ce = new Error('USER_CANCELLED');
                        _ce.code = 'CANCELLED';
                        throw _ce;
                    }
                }
                // 批量 splice 成功删除的条目（recOk 时 delFailures 为空，全部 splice）
                var removed = [];
                for (var p = 0; p < toRemove.length; p++) {
                    if (delFailures.indexOf(toRemove[p]) === -1) {
                        var rmIdx = _items.indexOf(toRemove[p]);
                        if (rmIdx !== -1) {
                            _items.splice(rmIdx, 1);
                            removed.push({ item: toRemove[p], idx: rmIdx });
                        }
                    }
                }
                if (removed.length) {
                    try { await _flushIndex(); }
                    catch (e) {
                        // flushIndex 失败：回滚 splice（文件已删，索引恢复，下次 load 变 missing 可 cleanMissing）
                        for (var q = removed.length - 1; q >= 0; q--) {
                            _items.splice(removed[q].idx, 0, removed[q].item);
                        }
                        throw e;
                    }
                }
                // 索引移除已落盘 → 连带删预览目录。仅对成功 splice 的条目；flush 失败已回滚
                // （条目不删、预览也不删），故挂在此处而非 splice 循环内。
                var _pvF = _previewStore();
                if (_pvF && removed.length) {
                    for (var pr = 0; pr < removed.length; pr++) {
                        try { await _pvF.deleteOne(removed[pr].item.id); } catch (_) {}
                    }
                }
                if (delFailures.length) {
                    // 部分文件删除失败如实抛错（对齐单条 remove 的删除失败抛错语义；调用方
                    // folderViewMixin catch 后走「删除失败」错误 toast）——若 removed.length>0
                    // 时仅 console.warn 后正常 resolve，UI 误报「已删除文件夹」成功 toast。成功条目
                    // 已 splice+flush；失败条目保留索引与磁盘文件，可重试（removed.length===0 的
                    // 旧「全失败才抛错」路径同样被覆盖）。
                    throw new Error(AEI18n.t('部分文件删除失败（成功 ') + removed.length + AEI18n.t(' 个，失败 ') + delFailures.length + AEI18n.t(' 个）: ') + delFailures.map(function (f) { return f.ffxPath; }).join(', '));
                }
                // 回退删除后，仅清理被删文件夹自身及其子目录（不扫全树，避免误删用户手动创建的空文件夹）
                if (!recOk) {
                    await _cleanupEmptyDirs(targetDir, fN);
                }
                result = removed.length;
            }
            // 删除整棵子树：从空文件夹缓存中移除被删文件夹 fN 及其所有子目录（无全树扫描）
            for (var ek2 = _emptyDirs.length - 1; ek2 >= 0; ek2--) {
                var en2 = _emptyDirs[ek2];
                if (en2 === fN || (fN.length > 0 && en2.indexOf(fN + '/') === 0)) _emptyDirs.splice(ek2, 1);
            }
            return result;
        }

        // 删除空物理目录（对齐 projectAssetStore.deleteEmptyFolder 语义）
        // 仅供 LLM 工具调用：仅当目录存在且为空时删除，并刷新 _emptyDirs 缓存
        // 不删条目、不删 .ffx 文件
        // 入 _serialized 队列（同 createFolder：防缓存移除与 load() 全量重扫交错复活幽灵目录）
        async function deleteEmptyFolder(folderPath) {
            var fp = _norm(folderPath);
            if (!fp) return false;
            var targetDir = _base + '/' + fp;
            if (!_inPresetsBase(targetDir)) return false;
            return _serialized(function () { return _deleteEmptyFolderInner(fp, targetDir); });
        }
        async function _deleteEmptyFolderInner(fp, targetDir) {
            var ok = await _AEFS.rmdir(targetDir);
            if (ok) {
                // 删除单个空文件夹：直接移出缓存（无全树扫描）
                var di = _emptyDirs.indexOf(fp);
                if (di !== -1) _emptyDirs.splice(di, 1);
            }
            return ok;
        }

        // ════════════════════════════════════════════════════════
        //  归档（物理文件：移入 <base>/___archive__/<stamp>_<名>.ffx）
        //  删除=归档；folder 恒保存原位置（恢复目标）；7 天后清扫物理删。
        // ════════════════════════════════════════════════════════
        function _archiveDirPath() { return _base + '/' + global.AEAssetsShared.ARCHIVE_DIR_NAME; }

        // 物理库的归档/恢复/清扫在磁盘变更后
        // 绝不回滚索引（见 _flushAfterMove）——保留一个无人调用的回滚入口会诱导未来
        // 重新接回"索引说原位、磁盘说归档区"的三方分裂路径。

        // 归档区落名去重：同秒多条同名 → _2/_3 递增（索引与磁盘双查，绝不覆盖已有归档件）
        async function _uniqueArchivePath(stamp, baseName, exclude) {
            var archiveDir = _archiveDirPath();
            var stem = presetBaseName(baseName);
            var candidate = archiveDir + '/' + stamp + '_' + baseName;
            var n = 1;
            while (_indexedAt(candidate, exclude) || await _AEFS.existsAsync(candidate)) {
                n++;
                candidate = archiveDir + '/' + stamp + '_' + stem + '_' + n + '.ffx';
            }
            return candidate;
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
            var dirRels = [];
            var dirReady = false;
            for (var i = 0; i < list.length; i++) {
                var it = getById(list[i]);
                if (!it) { res.failures.push({ id: list[i], error: AEI18n.t('条目不存在') }); continue; }
                if (_isArch(it)) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('条目已是归档态') }); continue; }
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
                var srcPath = it.ffxPath;
                var dst = null;
                try { dst = await _uniqueArchivePath(stamp, _baseNameFromFile(srcPath), it); }
                catch (_) { dst = null; }
                if (!dst) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('归档路径生成失败') }); continue; }
                var cpOk = false;
                try { cpOk = await _AEFS.copyFileAsync(srcPath, dst); } catch (_) { cpOk = false; }
                if (!cpOk) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('文件复制失败（未归档·原位置保留）') }); continue; }
                var delOk = false;
                try { delOk = await _AEFS.deleteFile(srcPath); } catch (_) { delOk = false; }
                // 数据安全：deleteFile 回报 false ≠「源还在」——Bridge 已执行删除但回包丢失
                // （空闲退出/被杀/网络异常）时，cep.fs/ExtendScript 回退对「已不存在」同样返回
                // false（同一失败语义）。必须用 exists(源) 复核：源仍在才回滚删副本；源已消失
                // 即视为删除成功（保留副本、按移动完成继续），否则会把唯一副本删掉、源与副本双失。
                if (!delOk && await _AEFS.exists(srcPath)) {
                    // 源删不掉（被占用等）：回滚副本，条目保持活跃（原位置保留）
                    try { await _AEFS.deleteFile(dst); } catch (_) {}
                    res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('原文件删除失败（已回滚，原位置保留）') });
                    continue;
                }
                if (!delOk) {
                    // 通道假失败但源已不存在：不删 dst，按移动完成继续，如实警告（不静默）
                    res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('删除通道回报失败但源已不存在，已按移动完成处理，副本保留') });
                }
                undo.push({
                    kind: 'flag', it: it,
                    saved: { ffxPath: it.ffxPath, archived: it.archived, archivedAt: it.archivedAt, hadAt: ('archivedAt' in it) }
                });
                it.ffxPath = dst;
                it.archived = true;
                it.archivedAt = ts;
                res.archived.push({ id: it.id, name: it.name, folder: it.folder, archivePath: dst });
                dirRels.push(_folderFromPath(srcPath, _base));
            }
            if (undo.length) await _flushAfterMove();   // 不回滚：物理状态已变更（见 _flushAfterMove 注释）
            if (dirRels.length) {
                try { await _refreshEmptyFolders(dirRels); } catch (_) {}
            }
            return res;
        }

        async function restore(ids) { return _serialized(function () { return _restoreInner(ids); }); }
        async function _restoreInner(ids) {
            var list = Array.isArray(ids) ? ids : [ids];
            var res = { restored: [], failures: [] };
            var undo = [];
            var dirRels = [];
            for (var i = 0; i < list.length; i++) {
                var it = getById(list[i]);
                if (!it) { res.failures.push({ id: list[i], error: AEI18n.t('条目不存在') }); continue; }
                if (!_isArch(it)) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('条目未归档') }); continue; }
                var srcPath = it.ffxPath;
                // 目标越界防线：folder/name 来自索引，可能被手工篡改（.. / 绝对路径 /
                // 含分隔符的名）；AEFS 白名单是第一道，store 层再按 _inPresetsBase 复核兜底
                var badSeg = global.AEAssetsShared.badNameSeg
                    ? global.AEAssetsShared.badNameSeg(it.name) : null;
                var targetDir = it.folder ? (_base + '/' + it.folder) : _base;
                var target = targetDir + '/' + it.name + '.ffx';
                if (badSeg || !_inPresetsBase(target)) {
                    res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('恢复目标越界或名称非法，已拒绝: ') + target });
                    continue;
                }
                // 重名去重：目标被占则 _1/_2 后缀（不覆盖现有文件）
                var n = 0;
                while (_indexedAt(target, it) || await _AEFS.existsAsync(target)) {
                    n++;
                    target = targetDir + '/' + it.name + '_' + n + '.ffx';
                }
                var mk = await _AEFS.mkdirAsync(targetDir);
                if (mk !== true) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('目标目录创建失败: ') + it.folder }); continue; }
                var cp = false;
                try { cp = await _AEFS.copyFileAsync(srcPath, target); } catch (_) { cp = false; }
                if (!cp) {
                    // 归档副本被外部清理与"复制通道失败"是两种事实，不得混报
                    var srcAlive = true;
                    try { srcAlive = await _AEFS.existsAsync(srcPath); } catch (_) { srcAlive = true; }
                    res.failures.push({
                        id: it.id, name: it.name,
                        error: srcAlive ? AEI18n.t('文件恢复失败（归档副本仍在，可重试）') : AEI18n.t('归档副本已丢失（疑被外部清理），无法恢复: ') + srcPath
                    });
                    continue;
                }
                var del = false;
                try { del = await _AEFS.deleteFile(srcPath); } catch (_) { del = false; }
                // 数据安全：同归档分支——deleteFile 回报 false ≠「源还在」，exists(源) 复核防
                // Bridge 假失败时把已恢复的唯一副本（target）当回滚对象删掉。
                if (!del && await _AEFS.exists(srcPath)) {
                    try { await _AEFS.deleteFile(target); } catch (_) {}
                    res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('归档副本清理失败（已回滚，保持归档态）') });
                    continue;
                }
                if (!del) {
                    // 通道假失败但归档副本已不存在：不删 target，按恢复完成继续，如实警告（不静默）
                    res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('删除通道回报失败但源已不存在，已按移动完成处理，副本保留') });
                }
                undo.push({
                    kind: 'flag', it: it,
                    saved: { ffxPath: it.ffxPath, archived: it.archived, archivedAt: it.archivedAt, hadAt: ('archivedAt' in it) }
                });
                it.ffxPath = target;
                it.archived = false;
                delete it.archivedAt;
                res.restored.push({ id: it.id, name: it.name, folder: it.folder, to: target });
                dirRels.push(it.folder);
            }
            if (undo.length) await _flushAfterMove();   // 不回滚：物理状态已变更（见 _flushAfterMove 注释）
            if (dirRels.length) {
                try { await _refreshEmptyFolders(dirRels); } catch (_) {}
            }
            return res;
        }

        // 收编子树内未登记 .ffx（口径对齐 _discoverOrphans：按 ffxPath 判重、非法名跳过）
        async function _adoptOrphansInFolder(dirPath, fN) {
            var SH = global.AEAssetsShared;
            var paths = [];
            try { await _collectFfxPaths(dirPath, paths); } catch (_) {}
            var valid = [];
            var skipped = 0;
            for (var i = 0; i < paths.length; i++) {
                var p = paths[i];
                if (_indexedAt(p)) continue;   // 已索引（含 missing/归档态）不收编
                var fn = _baseNameFromFile(p);
                var bad = SH.invalidNameSeg ? SH.invalidNameSeg(presetBaseName(fn)) : null;
                if (bad) { skipped++; continue; }
                valid.push({ p: p, fn: fn });
            }
            var added = [];
            if (valid.length) {
                var metas = await _probeOrphanMetas(valid.map(function (v) { return v.p; }));
                for (var vi = 0; vi < valid.length; vi++) {
                    var mf = _metaFields(metas[vi]);
                    added.push({
                        id: _genId(), name: presetBaseName(valid[vi].fn),
                        folder: _folderFromPath(valid[vi].p, _base), ffxPath: valid[vi].p, missing: false,
                        source: { layerName: '', propertyPath: '' }, createdAt: _now(),
                        notes: '',
                        hasKeyframes: mf.hasKeyframes, hasExpressions: mf.hasExpressions,
                        hasEffects: mf.hasEffects, size: mf.size
                    });
                }
            }
            if (added.length) {
                var startIdx = _items.length;
                for (var j = 0; j < added.length; j++) _items.push(added[j]);
                try { await _flushIndex(); }
                catch (e) {
                    for (var k = added.length - 1; k >= 0; k--) _items.splice(startIdx + k, 1);
                    throw e;
                }
            }
            return { adopted: added.length, skipped: skipped };
        }

        // 整夹归档：① 收编子树未登记 .ffx（否则残留文件下次 load 复活）② 前缀展开归档 ③ 清空目录
        async function archiveFolder(folder, nowMs) { return _serialized(function () { return _archiveFolderInner(folder, nowMs); }); }
        async function _archiveFolderInner(folder, nowMs) {
            var SH = global.AEAssetsShared;
            var fN = _norm(folder);
            if (!fN) throw new Error(AEI18n.t('不能归档根目录（请指定子文件夹）'));
            // 系统目录（归档区/垃圾区）不可作为归档目标：其下文件不属于活跃条目，
            // 收编+搬移会破坏归档命名，且空目录清理可能 rmdir 归档区本身
            if (_isSystemDirName(String(fN).split('/')[0])) {
                throw new Error(AEI18n.t('不能归档系统目录（') + global.AEAssetsShared.ARCHIVE_DIR_NAME + ' / ___trash__' + AEI18n.punct('）', ')'));
            }
            var dirPath = _base + '/' + fN;
            // 路径越界防线：fN 来自 LLM/UI（入口有 invalidFolderPath），store 层再复核一次——
            // 越界时 _collectFfxPaths 会把库外 .ffx 收编、_cleanupEmptyDirs 会 rmdir 库外空目录
            if (!_inPresetsBase(dirPath)) throw new Error(AEI18n.t('目标路径不在预设目录内: ') + folder);
            var adopt = await _adoptOrphansInFolder(dirPath, fN);
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
            res.adopted = adopt.adopted;
            res.skippedInvalid = adopt.skipped;
            // 自底向上 rmdir 空目录（部分归档失败时目录非空，不会被删）+ 祖先空链
            var removedDirs = [];
            try { await _cleanupEmptyDirs(dirPath, fN, removedDirs); } catch (_) {}
            try { await _pruneEmptyAncestors(fN, removedDirs); } catch (_) {}
            // 缓存同步（否则归档文件夹后原地遗留空文件夹）：_archiveInner 末尾的
            // _refreshEmptyFolders 会把"刚被搬空"的目录登记进 _emptyDirs，而上面已把物理目录 rmdir——
            // 不同步剔除就在树上渲染出一个空文件夹幽灵节点
            _pruneEmptyDirCache(removedDirs);
            res.cleanedDirs = removedDirs.length;
            return res;
        }

        // 空文件夹缓存剔除：把已 rmdir 的相对路径（连同其后代）从 _emptyDirs 摘掉
        function _pruneEmptyDirCache(rels) {
            if (!rels || !rels.length) return;
            for (var i = 0; i < rels.length; i++) {
                var r = rels[i];
                if (!r) continue;
                _emptyDirs = _emptyDirs.filter(function (e) { return e !== r && e.indexOf(r + '/') !== 0; });
            }
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
        async function _flushAfterMove() {
            try { await _flushIndex(); return; }
            catch (e1) {
                try { await _flushIndex(); return; }
                catch (e2) {
                    var err = new Error(AEI18n.t('磁盘状态已变更但索引落盘失败（') + (e2 && e2.message ? e2.message : e2)
                        + AEI18n.t('）：本次操作已生效，索引将在下次成功写入时补齐；')
                        + AEI18n.t('若在补齐前重启面板，归档件会显示为「未登记」（文件仍在 ___archive__ 内，可手工恢复）'));
                    err.code = 'FLUSH_FAILED_AFTER_MOVE';
                    throw err;
                }
            }
        }



        // 删除核（sweep 与 purgeArchive 共用）：物理删归档件 + 删索引。
        // 第三道防线在此复核：只删位于本库 ___archive__ 下的路径（篡改索引 ⇒ 跳过计入 failed）。
        async function _deleteArchivedItems(targets) {
            if (!targets.length) return { deleted: 0, failed: [] };
            var SH = global.AEAssetsShared;
            var del = [];
            var failed = [];
            for (var j = 0; j < targets.length; j++) {
                var it = targets[j];
                var p = it.ffxPath;
                if (!_inPresetsBase(p) || !SH.underArchiveDir(_base, p)) {
                    failed.push({ id: it.id, name: it.name, path: p, error: AEI18n.t('路径不在归档区，跳过') });
                    continue;
                }
                var ok = false;
                try { ok = await _AEFS.deleteFile(p); } catch (_) { ok = false; }
                if (!ok) {
                    // 删除失败复核：文件确已不存在（外部已清）也算清理成功；仍存在则保留等下次
                    var exists = true;
                    try { exists = await _AEFS.existsAsync(p); } catch (_) { exists = true; }
                    if (exists) { failed.push({ id: it.id, name: it.name, path: p, error: AEI18n.t('文件删除失败') }); continue; }
                }
                del.push(it);
            }
            var undo = [];
            for (var k = 0; k < del.length; k++) {
                var idx = _items.indexOf(del[k]);
                _items.splice(idx, 1);
                undo.push({ kind: 'drop', it: del[k], idx: idx });
            }
            if (undo.length) await _flushAfterMove();   // 不回滚：物理状态已变更（见 _flushAfterMove 注释）
            // 索引移除已落盘 → 连带删预览目录（仅对物理删除成功的归档件；失败项保留预览等下次）
            var _pvA = _previewStore();
            if (_pvA && del.length) {
                for (var pk = 0; pk < del.length; pk++) {
                    try { await _pvA.deleteOne(del[pk].id); } catch (_) {}
                }
            }
            if (del.length) {
                // 归档目录已空 → best-effort rmdir（失败忽略；非空则保留）
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

        // 7 天清扫：物理删过期归档件（不走回收站）+ 删索引。
        // 判据：索引登记（本函数遍历 _items）+ TTL（archiveExpiredAt）+ 路径在 ___archive__ 下。
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
            var r = await _deleteArchivedItems(expired);
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
            return _deleteArchivedItems(targets);
        }

        return {
            getBaseDir: getBaseDir, getIndexPath: getIndexPath,
            list: list, load: load,
            addMeta: addMeta, addMetaBatch: addMetaBatch, updateMeta: updateMeta, regeneratePreview: regeneratePreview,
            rename: rename, remove: remove, move: move, moveBatch: moveBatch, setMissing: setMissing,
            listMissing: listMissing, scanMissing: scanMissing, cleanMissing: cleanMissing,
            createFolder: createFolder, listEmptyFolders: listEmptyFolders,
            renameFolder: renameFolder, renameFoldersBatch: renameFoldersBatch, removeFolder: removeFolder,
            deleteEmptyFolder: deleteEmptyFolder,
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

    global.AEAssetsShared.presetBaseName = presetBaseName;
    global.AEAssetsShared.createPresetStore = createPresetStore;
})(window);
