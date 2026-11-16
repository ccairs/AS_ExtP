(function (global) {
    global.AEAssetsShared = global.AEAssetsShared || {};

    var NS = 'asset-refs';

    var VIDS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v', 'wmv', 'flv', 'mpg', 'mpeg'];
    var AUDS = ['mp3', 'wav', 'aac', 'flac', 'ogg', 'm4a', 'wma'];
    var IMGS = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tiff', 'tif', 'svg'];

    // ── 纯函数：类型判定 ──
    function detectType(fileName, mime) {
        if (mime) {
            if (mime.indexOf('video/') === 0) return 'video';
            if (mime.indexOf('audio/') === 0) return 'audio';
            if (mime.indexOf('image/') === 0) return 'image';
        }
        var m = String(fileName || '').toLowerCase().match(/\.(\w+)$/);
        var ext = m ? m[1] : '';
        if (VIDS.indexOf(ext) >= 0) return 'video';
        if (AUDS.indexOf(ext) >= 0) return 'audio';
        if (IMGS.indexOf(ext) >= 0) return 'image';
        return null;
    }

    // ── 纯函数：路径取基名 ──
    function baseName(p) {
        var s = String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '');
        var i = s.lastIndexOf('/');
        return i >= 0 ? s.slice(i + 1) : s;
    }

    function _norm(f) { return String(f || '').replace(/^\/+|\/+$/g, ''); }
    // 归档态判定（热路径内联判据，避免每次 filter 都穿 global 链）
    function _isArch(it) { return !!(it && it.archived); }
    function _genId() { return 'ref_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
    function _now() { return new Date().toISOString(); }

    // ── store 工厂 ──
    // opts: { AEFS, dataDir }
    function createRefStore(opts) {
        opts = opts || {};
        var _AEFS = opts.AEFS || global.AEFS;
        var dataDir = opts.dataDir || (global.AEShared && global.AEShared.getDataDir ? global.AEShared.getDataDir().dir : '');
        var _file = String(dataDir).replace(/\\/g, '/').replace(/\/+$/, '') + '/assets/' + NS + '/refs.json';
        var _items = [];
        // 上次清扫留痕：{ at, deleted, failed, kept }——UI 归档面板头部展示
        var _lastSweep = null;
        var _fm = global.AEAssetsShared.createFolderStoreMixin({
            AEFS: _AEFS,
            foldersPath: String(dataDir).replace(/\\/g, '/').replace(/\/+$/, '') + '/assets/' + NS + '/.folders.json',
            logTag: '[refStore]',
            // 空文件夹判定的批量数据源：listEmptyFolders 用它一次扫描建"含条目文件夹集合"，
            // 免掉对每条文件夹记录全量扫 _items（素材引用库万级条目下旧路径每次调用 2.2s，
            // 折叠/展开都会触发 → 左树点击卡死）。list() 已排除归档条目，与 hasEntries 口径一致。
            listEntries: function () { return list(); },
            // 空文件夹判定：其下有条目（含子层级）的文件夹不是空文件夹——
            // 防止"显式创建过但已放素材"的文件夹被 removeFolder 安全校验当作空文件夹放过（假成功）
            // 归档条目不算条目（归档整夹后原文件夹应自然消失/可被 removeFolder 清理）
            // 注：注入 listEntries 后本函数只作兼容回退（未注入时的旧路径）。
            hasEntries: function (fp) {
                var n = _norm(fp);
                return _items.some(function (x) {
                    if (global.AEAssetsShared.isArchived(x)) return false;
                    var f = _norm(x.folder);
                    return f === n || f.indexOf(n + '/') === 0;
                });
            }
        });

        // 封面协作件：封面图由 Bridge ffmpeg 抽视频一帧产出（见
        // previewStore.ensureVideoCover），落点是库外独立根
        // <dataDir>/assets/previews/asset-refs/<id>/preview.jpg；本 store 只负责**载入期回收**。
        // 引用库不挂删除钩子：这里没有 per-item 物理删除路径（删除=归档，条目留在 _items 里
        // 带 archived 标志），归档清扫 / purgeArchive / cleanMissing / 索引损坏重建全由
        // 保留集合（索引里全部 id）兜住——挂钩子只是把同一件事提前，徒增分支。
        // 懒解析：manifest 里 previewStore.js 先于本文件加载，生产环境必然可用；只加载本文件的
        // 沙箱里可能缺失，此时回收降级为 no-op 并 warn 一次（不静默）。
        var _preview = null;
        var _previewWarned = false;
        function _previewStore() {
            if (_preview) return _preview;
            var SH = global.AEAssetsShared;
            if (!SH || typeof SH.createPreviewStore !== 'function') {
                if (!_previewWarned) {
                    _previewWarned = true;
                    console.warn('[refStore] previewStore 未加载：封面回收降级为 no-op');
                }
                return null;
            }
            _preview = SH.createPreviewStore({ AEFS: _AEFS, dataDir: dataDir, lib: 'asset-refs' });
            return _preview;
        }

        // 写串行化：所有"改内存 + _save 整个数组"的操作必须排队执行。
        // 否则多文件 drop 的并发 add 各自 stringify 整个 _items 并发 writeFile，
        // 一个失败 splice 回滚抵不掉在途写入里已含本条目的 payload → 幽灵条目复活。
        var _writeQueue = Promise.resolve();
        function _serialized(fn) {
            var p = _writeQueue.then(fn, fn);   // 前一步成败都不影响本步执行
            _writeQueue = p.then(function () {}, function () {});  // 任一步失败都不斩断队列
            return p;
        }

        function getFilePath() { return _file; }
        // list() 默认排除归档条目（归档区对常规读路径/UI 树不可见；
        // 归档条目经 listArchive() 或 getById() 访问）
        function list() { return _items.filter(function (x) { return !_isArch(x); }); }

        async function load() {
            return _serialized(function () { return _loadInner(); });
        }
        async function _loadInner() {
            // 三态读取（单点助手 readManifestThreeState）——读失败
            // （CHANNEL_FAILURE/REJECTED）时中止本次加载：旧路径把读失败折叠为空清单，
            // 用户下一次 add/move/rename 等任意写操作即用「空+新」覆盖 refs.json，
            // originalPath 等全部引用记录丢失（覆盖触发点为下次写操作，
            // 且该分支无 .corrupt.bak 保护）。NOT_FOUND（真没有）/ok('')（空文件）
            // 按空重建，与旧 readFile null 折叠口径逐字等价。
            var rs = await global.AEAssetsShared.readManifestThreeState(_AEFS, _file);
            if (rs.state === 'failed') {
                throw new Error(AEI18n.t('素材库 refs.json 读取失败(') + rs.code + (rs.channel ? '@' + rs.channel : '') + AEI18n.t(')，已中止加载以防覆盖'));
            }
            var raw = rs.raw;
            if (!raw) { _items = []; }
            else {
                try {
                    var o = JSON.parse(raw);
                    _items = Array.isArray(o.items) ? o.items : [];
                } catch (e) {
                    _items = [];
                    // 解析失败先保留 .corrupt.bak 再置空——后续 add 等操作会用
                    // 空+新条目覆盖清单，originalPath 等全部引用记录仅存 .bak 可手工恢复
                    console.warn('[refStore] 清单解析失败，已保留损坏文件为 ' + _file + '.corrupt.bak，重置为空: ' + (e && e.message ? e.message : e));
                    await global.AEAssetsShared.backupCorruptFile(_AEFS, _file);
                }
            }
            await _fm.loadFolders();
            // 封面回收：保留集合 = 索引里全部 id（存活 ∪ 已归档——归档→恢复往返期间条目
            // 仍在 _items 里带 archived 标志，封面必须留着）
            try {
                var _pvGc = _previewStore();
                if (_pvGc) {
                    var _keepIds = [];
                    for (var _pi = 0; _pi < _items.length; _pi++) _keepIds.push(_items[_pi].id);
                    await _pvGc.gc(_keepIds);
                }
            } catch (_) {}
        }

        async function _save() {
            // 原子写（.tmp → rename）——写盘窗口中断不再截断 refs.json
            // （否则损坏 → 置空 → 后续覆盖，全部引用条目丢失）
            var ok = await global.AEAssetsShared.atomicWriteJson(_AEFS, _file, JSON.stringify({ version: 1, items: _items }, null, 2));
            if (!ok) {
                console.warn('[refStore] 写入失败: ' + _file);
                throw new Error(AEI18n.t('写入失败'));
            }
        }

        var createFolder = _fm.createFolder;
        var listEmptyFolders = _fm.listEmptyFolders;
        var deleteEmptyFolder = _fm.deleteEmptyFolder;

        async function add(o) {
            return _serialized(function () {
                return _addInner(o);
            });
        }
        // 构造 item（校验 + 构建，不 push、不落盘）。单条 add 与批量 addBatch 共用。
        function _mkItem(o) {
            o = o || {};
            if (!o.originalPath) throw new Error(AEI18n.t('originalPath 必填'));
            var name = o.name || baseName(o.originalPath);
            // 类型取自实际文件（originalPath 的基名），而非可能被覆盖的显示名；
            // 否则 name='我的图' 这类无扩展名显示名会让 detectType 落空误判为 other
            var type = o.type || detectType(baseName(o.originalPath), o.mime);
            if (!type) type = 'other';
            var it = {
                id: _genId(),
                name: name,
                originalPath: o.originalPath,
                type: type,
                folder: _norm(o.folder || ''),
                addedAt: _now(),
                size: o.size || 0,
                missing: false,
                // 备注（三库统一字段；旧数据缺省读作 ''）——LLM updateMeta 覆盖写
                notes: o.notes || ''
            };
            // 序列帧：o.sequence 传出 { count, prefix, ext }；originalPath 为首帧路径
            if (o.sequence) {
                it.sequence = {
                    count: o.sequence.count,
                    prefix: o.sequence.prefix,
                    ext: o.sequence.ext
                };
            }
            return it;
        }
        async function _addInner(o) {
            var it = _mkItem(o);
            var idx = _items.length;
            _items.push(it);
            try { await _save(); }
            catch (e) { _items.splice(idx, 1); throw e; }
            return it;
        }
        // 批量导入：循环内只改内存，末尾一次 _save（替代逐条 add 的 N 次全量重写）。
        // 保持 _serialized 原子性 + 失败回滚（_save 失败移除本次新增项）。
        async function addBatch(items) {
            if (!Array.isArray(items) || !items.length) return [];
            return _serialized(function () {
                var added = [];
                for (var i = 0; i < items.length; i++) added.push(_mkItem(items[i]));
                var startIdx = _items.length;
                for (var j = 0; j < added.length; j++) _items.push(added[j]);
                return _save().then(function () {
                    return added;
                }).catch(function (e) {
                    for (var k = added.length - 1; k >= 0; k--) _items.splice(startIdx + k, 1);
                    throw e;
                });
            });
        }

        async function remove(id) {
            return _serialized(function () { return _removeInner(id); });
        }
        async function _removeInner(id) {
            var found = _items.some(function (x) { return x.id === id; });
            // 找不到 id 须拒绝（与 _renameInner/_moveInner/_setMissingInner 一致）：静默 resolve 会被调用方当作成功 → LLM 假成功
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
            var saved = _items;
            _items = _items.filter(function (x) { return x.id !== id; });
            try { await _save(); }
            catch (e) { _items = saved; throw e; }
        }

        async function rename(id, newName) {
            return _serialized(function () { return _renameInner(id, newName); });
        }
        async function _renameInner(id, newName) {
            var found = false;
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) {
                    found = true;
                    var saved = _items[i].name;
                    _items[i].name = newName;
                    try { await _save(); }
                    catch (e) { _items[i].name = saved; throw e; }
                    break;
                }
            }
            // 找不到 id 须拒绝：静默 resolve 会被调用方（bootstrap _wrap）当作成功 → LLM 假成功
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
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
                    try { await _save(); }
                    catch (e) { _items[i].folder = saved; throw e; }
                    break;
                }
            }
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        // 虚拟文件夹重命名：改所有该文件夹下 items 的 folder 前缀
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

        // 改 oldN 子树下所有条目的 folder 前缀 → newN；返回快照（{idx, folder}）供回滚。
        // oldN 为空 = 根，匹配所有条目（既有语义）。单条与批量共用。
        function _rewriteFolderPrefix(oldN, newN) {
            var saved = [];
            _items.forEach(function (x, idx) {
                var f = _norm(x.folder);
                if (f === oldN || oldN.length === 0 || f.indexOf(oldN + '/') === 0) {
                    saved.push({ idx: idx, folder: x.folder });
                }
            });
            _items.forEach(function (x) {
                var f = _norm(x.folder);
                if (f === oldN) x.folder = newN;
                else if (oldN.length === 0) x.folder = _norm(newN + '/' + f);
                else if (f.indexOf(oldN + '/') === 0) x.folder = _norm(newN + '/' + f.slice(oldN.length + 1));
            });
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
            try { await _save(); }
            catch (e) {
                saved.forEach(function (s) { _items[s.idx].folder = s.folder; });
                throw e;
            }
            try { await _fm.syncFoldersOnRename(oldN, newN); }
            catch (fmErr) {
                // refs.json 已改写成功，.folders.json 同步失败不应让整体报"重命名失败"：
                // 空文件夹记录的内存态已由 mixin 回滚与磁盘一致，降级 warn 防树与数据矛盾
                console.warn('[refStore] 重命名后同步 .folders.json 失败: ' + (fmErr && fmErr.message ? fmErr.message : fmErr));
            }
        }

        // 批量移动条目到虚拟文件夹。契约与 presetStore.moveBatch 对齐（见
        // 其实现）：
        //   · 返回成功条数；未知 / 陈旧 id 静默跳过，不中断整批（同批重复 id 只算一次）
        //   · 批内索引写**恰好 1 次**——逐条 move 是 N 次全量落盘，那才是"卡"的根因
        //   · 写盘失败**回滚全部内存后抛**（本库是纯内存批改，可整体回滚；预设库物理文件
        //     已搬走故只 flush 已完成部分，两库差异是有意的）
        //   · onProgress 语义 = 每完成一个耗时步骤回调一次。本库批内只有收尾一次索引写，
        //     没有可报告的中间步骤 → **不回调**。故 UI 侧不会为短操作建瞬态进度卡片
        //     （避免短操作出现瞬态 UI 闪烁的既有原则）。
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
                return _save().then(function () {
                    return moved;
                }, function (e) {
                    for (var k = 0; k < saved.length; k++) saved[k].item.folder = saved[k].folder;
                    throw e;
                });
            });
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
                return _save().then(function () {
                    // .folders.json 同步：与单条同款降级——refs.json 已改写成功，同步失败只 warn
                    // （串行 await，确保返回时 .folders.json 已落定，调用方随后的刷新看到一致态）
                    var syncChain = Promise.resolve();
                    for (var s = 0; s < synced.length; s++) {
                        (function (job) {
                            syncChain = syncChain.then(function () {
                                return Promise.resolve()
                                    .then(function () { return _fm.syncFoldersOnRename(job.oldN, job.newN); })
                                    .catch(function (fmErr) {
                                        console.warn('[refStore] 重命名后同步 .folders.json 失败: ' + (fmErr && fmErr.message ? fmErr.message : fmErr));
                                    });
                            });
                        })(synced[s]);
                    }
                    return syncChain.then(function () {
                        if (onProgress) onProgress(done, failed, list.length);
                        return { done: done, failed: failed };
                    });
                }, function (e) {
                    // 索引落盘失败：回滚全部内存后抛（批内已成功的部分也回滚——纯内存可整体回滚）
                    for (var k = 0; k < savedAll.length; k++) {
                        _items[savedAll[k].idx].folder = savedAll[k].folder;
                    }
                    throw e;
                });
            });
        }

        // keepItems=true：items 提到根（保留子路径）；false：删除该文件夹下所有 items
        async function removeFolder(folder, keepItems, onProgress, isCancelled) {
            return _serialized(function () { return _removeFolderInner(folder, keepItems, onProgress, isCancelled); });
        }
        async function _removeFolderInner(folder, keepItems, onProgress, isCancelled) {
            // 取消契约（对齐 projectAssetStore）：进入执行时已取消则中止并抛 USER_CANCELLED，
            // 让进度卡片的「取消」按钮生效（isCancelled 参数必须被检查）
            if (typeof isCancelled === 'function' && isCancelled()) {
                var cerr = new Error('USER_CANCELLED');
                cerr.code = 'CANCELLED';
                throw cerr;
            }
            var fN = _norm(folder);
            var result = 0;
            // 辅助：判 f 是否在 fN 路径下（fN 为空 = 根，匹配所有）
            function _under(f, prefix) {
                if (f === prefix) return true;
                if (prefix.length === 0) return true;
                return f.indexOf(prefix + '/') === 0;
            }
            if (keepItems) {
                var saved = [];
                _items.forEach(function (x, idx) {
                    var f = _norm(x.folder);
                    if (_under(f, fN)) {
                        saved.push({ idx: idx, folder: x.folder });
                    }
                });
                _items.forEach(function (x) {
                    var f = _norm(x.folder);
                    if (f === fN) x.folder = '';
                    else if (fN.length === 0) x.folder = f;
                    else if (f.indexOf(fN + '/') === 0) x.folder = f.slice(fN.length + 1);
                });
                try { await _save(); }
                catch (e) {
                    saved.forEach(function (s) { _items[s.idx].folder = s.folder; });
                    throw e;
                }
                result = 0;
            } else {
                var saved = _items;
                var removedCount = _items.filter(function (x) {
                    var f = _norm(x.folder);
                    return _under(f, fN);
                }).length;
                _items = _items.filter(function (x) {
                    var f = _norm(x.folder);
                    return !_under(f, fN);
                });
                try { await _save(); }
                catch (e) { _items = saved; throw e; }
                if (onProgress) onProgress(removedCount, removedCount);
                result = removedCount;
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
                    try { await _save(); }
                    catch (e) { _items[i].missing = saved; throw e; }
                    break;
                }
            }
            if (!found) throw new Error(AEI18n.t('条目不存在: ') + id);
        }

        function listMissing() {
            // 归档条目不参与 missing 面（其生命周期归归档清扫管，不该被 cleanMissing 二次处理）
            return _items.filter(function (x) { return !!x.missing && !_isArch(x); }).slice();
        }
        async function scanMissing() { return _serialized(function () { return _scanMissingInner(); }); }
        async function _scanMissingInner() {
            var changed = false;
            // 批量探测：一次真异步往返判全部 originalPath 存在性，替代逐条同步 XHR（几万引用素材时不冻结 UI）
            // 归档条目跳过（原始文件本就不归素材库管，探测结果对归档态无意义）
            var active = _items.filter(function (x) { return !_isArch(x); });
            var paths = active.map(function (x) { return x.originalPath; });
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
                try { await _save(); } catch (_) {}
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
            try { await _save(); }
            catch (e) {
                for (var r = removed.length - 1; r >= 0; r--) _items.splice(removed[r].idx, 0, removed[r].item);
                throw e;
            }
            return { cleaned: removed.length };
        }

        // ════════════════════════════════════════════════════════
        //  备注与查找（三库统一接口；合并工具 asset_library 依赖）
        // ════════════════════════════════════════════════════════
        function getById(id) {
            for (var i = 0; i < _items.length; i++) {
                if (_items[i].id === id) return _items[i];
            }
            return null;
        }

        // 备注覆盖写（notes:'' = 清空）。返回条目（含归档态：归档条目的 notes 由入口拒绝，不在 store 层拦）
        async function updateMeta(id, patch) { return _serialized(function () { return _updateMetaInner(id, patch); }); }
        async function _updateMetaInner(id, patch) {
            var it = getById(id);
            // 找不到 id 须拒绝（与其他方法一致）：静默 resolve 会被调用方当作成功 → LLM 假成功
            if (!it) throw new Error(AEI18n.t('条目不存在: ') + id);
            patch = patch || {};
            var saved = { notes: it.notes };
            if (patch.notes !== undefined) it.notes = String(patch.notes == null ? '' : patch.notes);
            try { await _save(); }
            catch (e) { it.notes = saved.notes; throw e; }
            return it;
        }

        // ════════════════════════════════════════════════════════
        //  归档（引用层：仅索引标记——外部原文件永不动）
        //  删除=归档；7 天后清扫删除索引条目（见 sweepArchive）。
        // ════════════════════════════════════════════════════════
        function getLastSweep() { return _lastSweep; }

        function listArchive() {
            return _items.filter(function (x) { return _isArch(x); }).slice();
        }

        // 回滚账本：flag = 标记归档（还原两个字段）；drop = 移除索引（按 idx 插回）
        function _rollbackUndo(undo) {
            for (var i = undo.length - 1; i >= 0; i--) {
                var u = undo[i];
                if (u.kind === 'flag') {
                    if (u.saved.hadAt) u.it.archivedAt = u.saved.archivedAt;
                    else delete u.it.archivedAt;
                    u.it.archived = u.saved.archived;
                } else if (u.kind === 'drop') {
                    _items.splice(u.idx, 0, u.it);
                }
            }
        }

        function _archiveOne(it, ts, res, undo) {
            if (_isArch(it)) { res.failures.push({ id: it.id, name: it.name, error: AEI18n.t('条目已是归档态') }); return; }
            if (it.missing) {
                // 文件已丢失：无实体可归档 → 按既有 cleanMissing 语义移除索引（回执如实写明）
                var idx = _items.indexOf(it);
                _items.splice(idx, 1);
                undo.push({ kind: 'drop', it: it, idx: idx });
                res.missing.push({ id: it.id, name: it.name });
                return;
            }
            undo.push({
                kind: 'flag', it: it,
                saved: { archived: it.archived, archivedAt: it.archivedAt, hadAt: ('archivedAt' in it) }
            });
            it.archived = true;
            it.archivedAt = ts;
            res.archived.push({ id: it.id, name: it.name, folder: it.folder });
        }

        async function archive(ids, nowMs) { return _serialized(function () { return _archiveInner(ids, nowMs); }); }
        async function _archiveInner(ids, nowMs) {
            var list = Array.isArray(ids) ? ids : [ids];
            var ts = new Date(nowMs == null ? Date.now() : nowMs).toISOString();
            var res = { archived: [], missing: [], failures: [] };
            var undo = [];
            for (var i = 0; i < list.length; i++) {
                var it = getById(list[i]);
                if (!it) { res.failures.push({ id: list[i], error: AEI18n.t('条目不存在') }); continue; }
                _archiveOne(it, ts, res, undo);
            }
            if (undo.length) {
                try { await _save(); }
                catch (e) { _rollbackUndo(undo); throw e; }
            }
            return res;
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
                undo.push({ kind: 'flag', it: it, saved: { archived: it.archived, archivedAt: it.archivedAt, hadAt: ('archivedAt' in it) } });
                it.archived = false;
                delete it.archivedAt;
                res.restored.push({ id: it.id, name: it.name, folder: it.folder });
            }
            if (undo.length) {
                try { await _save(); }
                catch (e) { _rollbackUndo(undo); throw e; }
            }
            return res;
        }

        // 整夹归档：前缀展开活跃条目（已归档条目不参与、其时钟不被重置）→ 逐条归档 → 移除文件夹记录
        async function archiveFolder(folder, nowMs) { return _serialized(function () { return _archiveFolderInner(folder, nowMs); }); }
        async function _archiveFolderInner(folder, nowMs) {
            var SH = global.AEAssetsShared;
            var fN = _norm(folder);
            if (!fN) throw new Error(AEI18n.t('不能归档根目录（请指定子文件夹）'));
            var ids = [];
            for (var i = 0; i < _items.length; i++) {
                if (_isArch(_items[i])) continue;
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

        // 整夹恢复：前缀展开归档条目 → 逐条清标记（引用层无物理动作，原位置即原 folder）
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

        // 删除核（sweep 与 purgeArchive 共用）：引用层只删索引，外部原文件永不动
        async function _deleteArchivedIndexes(targets) {
            if (!targets.length) return { deleted: 0, failed: [] };
            var undo = [];
            for (var j = 0; j < targets.length; j++) {
                var idx = _items.indexOf(targets[j]);
                _items.splice(idx, 1);
                undo.push({ kind: 'drop', it: targets[j], idx: idx });
            }
            try { await _save(); }
            catch (e) { _rollbackUndo(undo); throw e; }
            return { deleted: targets.length, failed: [] };
        }

        // 7 天清扫：删除过期归档条目的索引（引用层无物理删除——外部原文件永不动）。
        // 判据用 archiveExpiredAt（archivedAt 无效/缺失一律不删，宁留不误删）。
        async function sweepArchive(nowMs) { return _serialized(function () { return _sweepArchiveInner(nowMs); }); }
        async function _sweepArchiveInner(nowMs) {
            var t = nowMs == null ? Date.now() : nowMs;
            var SH = global.AEAssetsShared;
            var kept = 0;
            var expired = [];
            for (var i = 0; i < _items.length; i++) {
                if (!_isArch(_items[i])) continue;
                if (SH.archiveExpiredAt(_items[i], t)) expired.push(_items[i]);
                else kept++;
            }
            var r = await _deleteArchivedIndexes(expired);
            _lastSweep = { at: new Date(t).toISOString(), deleted: r.deleted, failed: r.failed.length, kept: kept };
            return { deleted: r.deleted, failed: r.failed, kept: kept };
        }

        // 立即清理（仅 UI 归档区面板调用；LLM 面无此 mode）：
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
            return _deleteArchivedIndexes(targets);
        }

        return {
            getFilePath: getFilePath,
            list: list,
            load: load,
            add: add, addBatch: addBatch,
            remove: remove,
            rename: rename,
            move: move,
            moveBatch: moveBatch,
            renameFolder: renameFolder,
            renameFoldersBatch: renameFoldersBatch,
            removeFolder: removeFolder,
            setMissing: setMissing,
            listMissing: listMissing,
            scanMissing: scanMissing,
            cleanMissing: cleanMissing,
            // 备注 / 查找 / 归档（删除=归档）
            getById: getById,
            updateMeta: updateMeta,
            listArchive: listArchive,
            getLastSweep: getLastSweep,
            archive: archive,
            restore: restore,
            archiveFolder: archiveFolder,
            restoreFolder: restoreFolder,
            sweepArchive: sweepArchive,
            purgeArchive: purgeArchive,
            // 虚拟文件夹
            createFolder: createFolder,
            listEmptyFolders: listEmptyFolders,
            deleteEmptyFolder: deleteEmptyFolder
        };
    }

    global.AEAssetsShared.detectType = detectType;
    global.AEAssetsShared.baseName = baseName;
    global.AEAssetsShared.createRefStore = createRefStore;
})(window);
