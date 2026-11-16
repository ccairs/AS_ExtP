/**
 * assets/bootstrap.js - 素材库 LLM 工具装配
 *
 * 单工具（library + mode 两维寻址）：
 *   asset_library   素材库三架书架
 *     library=asset_refs      普通素材（引用层，originalPath 任意绝对路径；仅本库支持 add 入库）
 *     library=project_assets  工程素材（.aep 实体，仅 UI 拖入入库）
 *     library=presets         预设（.ffx 实体，仅 UI 拖入入库）
 *
 * 删除=归档：archive/restore（ids 批量 或 folder 整夹），7 天后自动物理清理；
 * 本工具无永久删除（purgeArchive 仅面板 UI；清扫由面板启动/工具调用机会式触发）。
 *
 * 共同约束：
 *   - 不暴露 remove/cleanMissing/listGarbage/cleanGarbage/deleteEmptyFolder（禁删除）
 *   - removeFolder 仅当文件夹为空时删除（强制 keepEmptyOnly，handler 内校验）
 *   - asset_refs.add 允许任意 originalPath；project_assets/presets 的 addMeta 不暴露
 *   - importToAE / applyToAE 不设防（balanced 不弹）
 *   - 归档条目除 get/restore 外一律拒绝修改（fail-closed）
 *
 * Store 实例存到 global.AEAssetsShared._sharedStores，assets/index.js mount 时复用，
 * 避免 LLM 工具与 UI 各持一份内存导致状态不一致。
 */
(function (global) {
    'use strict';

    global.AEAssetsShared = global.AEAssetsShared || {};

    var TOOL_NAMES = ['asset_library'];

    // ── library 映射（id 前缀与三库一一对应，用于自校验）──
    var LIBRARIES = { asset_refs: true, project_assets: true, presets: true };
    var ID_PREFIX = { asset_refs: 'ref_', project_assets: 'pa_', presets: 'pr_' };

    // ── 权限策略共用的 mode 分类（与 permissions.js 的 CONFIRM_COND 保持一致）──
    var READ_MODES = {
        list: true, get: true, search: true,
        listFolders: true, listEmptyFolders: true,
        listMissing: true, scanMissing: true, listArchive: true
    };
    var IMPORT_MODES = {
        importToAE: true, applyToAE: true
    };
    // 归档/恢复：按写 mode 处理（面板 balanced 弹确认、外接放行）——可恢复，不设 FORCE
    var ARCHIVE_MODES = { archive: true, restore: true };

    var NOTES_MAX = 2000;
    var NOTES_EXCERPT = 40;

    function _ok(text) {
        return { success: true, isError: false, content: [{ type: 'text', text: String(text) }] };
    }
    function _err(text) {
        return { success: false, isError: true, content: [{ type: 'text', text: String(text) }] };
    }
    function _asyncErr(e) {
        var msg = (e && e.message) ? e.message : String(e);
        return { success: false, isError: true, content: [{ type: 'text', text: '执行错误: ' + msg }] };
    }

    // 名称/文件夹路径校验：委托 global.AEAssetsShared.invalidNameSeg / invalidFolderPath。
    // LLM 入口与 UI 入口（treeView.js）对齐，防止含 %/引号/.. /DOS 名等字符的命名
    // 通过 _checkPath 后被拒（renameFile/mkdir/writeFileSync 失败）。
    function _checkName(name) {
        var fn = global.AEAssetsShared && global.AEAssetsShared.invalidNameSeg;
        if (typeof fn !== 'function') return null; // AEAssetsShared 未就绪时不阻断（UI 侧已校验）
        return fn(name);
    }
    function _checkFolderPath(folder) {
        var fn = global.AEAssetsShared && global.AEAssetsShared.invalidFolderPath;
        if (typeof fn !== 'function') return null;
        return fn(folder);
    }

    // originalPath 入口字符校验（口径对齐 shared/aefs.js _checkPath 的必拒
    // 形态）——含 %/控制字符/引号的路径 AEFS 全拒（exists/deleteFile 恒 false），入库即
    // 永久 missing；. / .. 段与非绝对路径同样无法探测
    function _checkOriginalPath(p) {
        var s = String(p == null ? '' : p);
        if (s.indexOf('%') !== -1) return 'originalPath 不能含 %（AEFS 拒绝该字符，入库后无法探测/导入）';
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c <= 0x1F || c === 0x7F) return 'originalPath 不能含控制字符';
            if (c === 0x22 || c === 0x27) return 'originalPath 不能含引号（AEFS 拒绝该字符）';
        }
        if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(s) || /(^|[\\\/\:])\.([\\\/\:]|$)/.test(s)) {
            return 'originalPath 不能含 . 或 .. 路径段';
        }
        var cleaned = s.replace(/\\/g, '/').replace(/\/+/g, '/');
        // file:/// 判定对齐 AEFS _checkPath ④ 口径（/^file:\/+/i 剥离后
        // 校验盘符）——先压缩斜杠会把 file:///C:/x 压成 file:/C:/x，
        // indexOf('file:///') 恒不成立，误拒 AEFS 实际支持（_toWin 可转）的合法形态。
        if (/^file:\/+/i.test(cleaned)) {
            var stripped = cleaned.replace(/^file:\/+/i, '');
            if (!/^[A-Za-z][:\|]\//.test(stripped)) {
                return 'originalPath 必须是绝对路径（如 D:/assets/a.png）';
            }
        } else if (!/^[A-Za-z]:\//.test(cleaned)) {
            return 'originalPath 必须是绝对路径（如 D:/assets/a.png）';
        }
        // 敏感路径**入库时就拒**——AEFS 的探测/读取面按敏感规则一律拒绝
        //（.key/.pem/.pfx 后缀、.config/.docker 等段、id_rsa/.env 等文件名；见 aefs.js
        // _isSensitivePath 权威实现）。入库不查时：`Keynote.key` 这类素材入库成功、
        // 随即被判「原文件已丢失」，用户点「清理索引」把引用删掉。委托同一实现（单点，不抄规则）。
        try {
            var aefsRef = (typeof AEFS !== 'undefined' && AEFS) ? AEFS
                : (typeof window !== 'undefined' && window.AEFS) ? window.AEFS : null;
            if (aefsRef && typeof aefsRef.isSensitivePath === 'function' && aefsRef.isSensitivePath(s)) {
                return 'originalPath 被安全策略视为凭据类路径（如 .key/.pem/.pfx/.env 或 .config 等目录）：入库后无法读取，请改名或换目录';
            }
        } catch (_) {}
        return null;
    }

    // ── 通用小工具 ──
    function _normF(f) { return String(f || '').replace(/^\/+|\/+$/g, ''); }

    // 父链：'根 > 角色 > 眼睛'（回执统一口径）
    function _chain(folder) {
        var f = _normF(folder);
        return '根' + (f ? ' > ' + f.split('/').join(' > ') : '');
    }

    // 该文件夹（含子层）条目数
    function _folderCount(items, folder) {
        var n = _normF(folder);
        var c = 0;
        for (var i = 0; i < items.length; i++) {
            var f = _normF(items[i].folder);
            if (f === n || (n !== '' && f.indexOf(n + '/') === 0)) c++;
        }
        return c;
    }

    // 备注摘要（截断 + 空白折叠为空格，单行）
    function _excerpt(s) {
        var t = String(s == null ? '' : s).replace(/\s+/g, ' ').replace(/^ | $/g, '');
        if (t.length <= NOTES_EXCERPT) return t;
        return t.slice(0, NOTES_EXCERPT) + '…';
    }

    function _notesSuffix(it) {
        var out = '';
        var n = String(it.notes || '');
        if (n) out += ' · notes: ' + _excerpt(n);
        return out;
    }

    // 归档剩余天数（archivedAt 无效则不给天数）
    function _remainDays(it) {
        var S = global.AEAssetsShared;
        var ttl = (S && S.ARCHIVE_TTL_MS) || (7 * 24 * 3600 * 1000);
        var t = Date.parse(it && it.archivedAt);
        if (isNaN(t)) return null;
        var d = Math.ceil((t + ttl - Date.now()) / (24 * 3600 * 1000));
        return d < 0 ? 0 : d;
    }

    // 条目摘要行（list/search/listMissing/listArchive 共用）
    function _summarizeItem(it) {
        var right = (it.archived ? ' [已归档' + (_remainDays(it) != null ? ' · 剩余 ' + _remainDays(it) + ' 天' : '') + ']' : '')
            + (it.missing ? ' [missing]' : '');
        return '- [' + (it.name || '?') + '] id=' + (it.id || '?')
            + (it.folder ? ' folder=' + it.folder : '')
            + (it.type ? ' type=' + it.type : '')
            + _notesSuffix(it)
            + right;
    }

    // 归档条目修改面防火墙：命中则返回错误文案（get/restore/archive 之外一律拒绝）
    function _archivedGuard(it) {
        if (!it || !it.archived) return null;
        var d = _remainDays(it);
        return '条目「' + (it.name || it.id) + '」已归档' + (d != null ? '（剩余 ' + d + ' 天）' : '')
            + '，如需修改请先 mode=restore';
    }

    // id 与 library 自校验（前缀 ref_/pa_/pr_；批量先全量校验再执行）
    function _idCheck(lib, id) {
        var s = String(id == null ? '' : id);
        for (var other in ID_PREFIX) {
            if (!ID_PREFIX.hasOwnProperty(other) || other === lib) continue;
            if (s.indexOf(ID_PREFIX[other]) === 0) {
                return 'id=' + s + ' 属于 ' + other + '（前缀 ' + ID_PREFIX[other] + '），请改 library=' + other;
            }
        }
        return null;
    }
    function _idsCheck(lib, ids) {
        for (var i = 0; i < ids.length; i++) {
            var bad = _idCheck(lib, ids[i]);
            if (bad) return bad;
        }
        return null;
    }

    // 系统保留目录守卫：___archive__ / ___trash__ 由归档与垃圾功能管理，
    // 不得作为普通目标文件夹（否则条目"物理在归档区、索引却是活跃态"：清扫不认领、
    // 归档面板不显示、孤儿收编排除 → 状态无法自愈）。三库统一（虚拟库虽只影响呈现，
    // 但保留同一规则可避免语义分裂）。
    function _reservedFolderGuard(folder) {
        var f = _normF(folder);
        if (!f) return null;
        var AR = (global.AEAssetsShared && global.AEAssetsShared.ARCHIVE_DIR_NAME) || '___archive__';
        var segs = f.split('/');
        for (var i = 0; i < segs.length; i++) {
            if (segs[i] === AR) {
                return '文件夹路径不能使用系统保留目录「' + AR + '」（归档区由 archive/restore 管理）: ' + folder;
            }
            if (segs[i].indexOf('___trash__') === 0) {
                return '文件夹路径不能使用系统保留目录「___trash__」（垃圾区）: ' + folder;
            }
        }
        return null;
    }

    function _maxIds() {
        var S = global.AEAssetsShared;
        return (S && S.ARCHIVE_MAX_IDS) || 200;
    }
    function _maxFolder() {
        var S = global.AEAssetsShared;
        return (S && S.ARCHIVE_MAX_FOLDER) || 1000;
    }

    function _getById(store, id) {
        if (typeof store.getById === 'function') return store.getById(id);
        var all = store.list();
        for (var i = 0; i < all.length; i++) {
            if (all[i].id === id) return all[i];
        }
        return null;
    }

    // 归档/列表归档前机会式补扫（过期项只在三重判据内被清；无过期项零磁盘 I/O）。
    // build(prefix) 返回最终文本；prefix 为清扫提示行（可能为空串）。
    function _sweepNoteThen(store, build) {
        if (typeof store.sweepArchive !== 'function') return Promise.resolve(build(''));
        var p;
        try { p = store.sweepArchive(); } catch (_) { return Promise.resolve(build('')); }
        return Promise.resolve(p).then(function (r) {
            return build((r && r.deleted) ? ('（顺带清理过期归档 ' + r.deleted + ' 条）\n') : '');
        }, function () { return build(''); });
    }

    // 批量回执：动作头行 → 逐条成功行 → 失败块
    function _batchBlock(head, okLines, failures) {
        var lines = [head];
        for (var i = 0; i < okLines.length; i++) lines.push('- ' + okLines[i]);
        if (failures && failures.length) {
            lines.push('失败 ' + failures.length + ' 条：');
            for (var j = 0; j < failures.length; j++) {
                var f = failures[j];
                lines.push('- ' + (f.name ? '「' + f.name + '」' : '') + (f.id ? ' id=' + f.id : '') + '：' + (f.error || '未知错误'));
            }
        }
        return lines.join('\n');
    }

    /**
     * 初始化素材库 LLM 工具。
     * @param {object} config
     *   toolRegistry (必填)
     *   hostApi      (必填，用于 importToAE / applyToAE)
     *   dataDir      (可选，缺省从 AEShared.getDataDir 取)
     */
    async function initAssetsTools(config) {
        config = config || {};
        var toolRegistry = config.toolRegistry;
        var hostApi = config.hostApi || (global.AEPlatform && global.AEPlatform.hostApi) || null;
        var dataDir = config.dataDir || '';
        if (!dataDir) {
            try { dataDir = global.AEShared.getDataDir().dir; } catch (_) {}
        }
        if (!toolRegistry) {
            console.warn('[AssetsBootstrap] MISSING_TOOL_REGISTRY');
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }
        if (!dataDir) {
            console.warn('[AssetsBootstrap] MISSING_DATA_DIR');
            return { ok: false, error: 'MISSING_DATA_DIR' };
        }

        // 创建三个 store 实例并 load（mount 时复用，避免双实例不一致）。
        // UI（index.js mount）先执行时已创建并回写 _sharedStores：此处必须复用，
        // 无条件覆盖会让 UI 持旧实例、LLM 工具持新实例（双实例窗口，状态不一致）
        var shared = global.AEAssetsShared._sharedStores;
        var refStore, projStore, presetStore;
        if (shared && shared.refStore && shared.projStore && shared.presetStore) {
            refStore = shared.refStore;
            projStore = shared.projStore;
            presetStore = shared.presetStore;
        } else {
            refStore = global.AEAssetsShared.createRefStore({ dataDir: dataDir });
            projStore = global.AEAssetsShared.createProjectAssetStore({ dataDir: dataDir, hostApi: hostApi });
            presetStore = global.AEAssetsShared.createPresetStore({ dataDir: dataDir });
            global.AEAssetsShared._sharedStores = {
                refStore: refStore,
                projStore: projStore,
                presetStore: presetStore
            };
        }

        // 并行 load（首次冷启动可能空目录，load 失败不阻断工具注册）
        try {
            await Promise.all([
                refStore.load(),
                projStore.load(),
                presetStore.load()
            ]);
        } catch (e) {
            console.warn('[AssetsBootstrap] store load 部分失败: ' + (e && e.message ? e.message : e));
        }

        // 启动清扫（归档机制）：load 之后 fire-and-forget 跑一次，
        // 失败仅 log 不阻断启动；清扫判据在 store 内（索引登记 + TTL + 路径白名单）
        [refStore, projStore, presetStore].forEach(function (st) {
            if (!st || typeof st.sweepArchive !== 'function') return;
            try {
                Promise.resolve(st.sweepArchive()).then(function (r) {
                    if (r && r.deleted) console.log('[AssetsBootstrap] 启动清扫：删除过期归档 ' + r.deleted + ' 条');
                    if (r && r.failed && r.failed.length) console.warn('[AssetsBootstrap] 启动清扫：' + r.failed.length + ' 条删除失败（保留待下次）');
                }, function (e) {
                    console.warn('[AssetsBootstrap] 启动清扫失败: ' + (e && e.message ? e.message : e));
                });
            } catch (_) {}
        });

        var STORES = { asset_refs: refStore, project_assets: projStore, presets: presetStore };

        // ── 注册 asset_library（单工具，library + mode）──
        toolRegistry.register({
            name: 'asset_library',
            shortDescription: '素材库（素材/工程素材/预设）：查询·备注·文件管理·归档·导入 AE（library + mode）',
            description: '素材库三架书架，先选 library（条目 id 前缀 ref_/pa_/pr_ 与三库一一对应，传错会拒绝并提示正确库）：'
                + ' asset_refs 普通素材（引用层，不拷贝文件，记录 originalPath；仅本库支持 add 入库）；'
                + ' project_assets 工程素材（.aep 实体，UI 拖入入库，LLM 不入库）；'
                + ' presets 预设（.ffx 实体，UI 拖入入库，LLM 不入库）。'
                + '按 mode 操作：'
                + ' 读（不弹确认）：list/get/search/listFolders/listEmptyFolders/listMissing/scanMissing/listArchive；'
                + ' 写：rename/move/createFolder/renameFolder/removeFolder（仅空文件夹）/updateMeta（备注覆盖写；notes 空串=清除；上限 ' + NOTES_MAX + ' 字）；'
                + ' 归档（=删除）：archive / restore（ids 数组批量，或 folder 路径整夹，二选一）——用户要求「删除/清理/移除」素材或文件夹时一律用 archive；'
                + ' 本工具没有永久删除：移入归档区，7 天后自动清理，期间可 restore。归档条目仅 get/restore 可用，其余 mode 一律拒绝。'
                + ' folder 整夹归档=递归含子层；空文件夹请用 removeFolder（无内容可归档）。'
                + ' 导入 AE：importToAE（asset_refs/project_assets；ids 数组；project_assets 仅单条可传 name 覆盖工程名）；'
                + ' applyToAE（presets；不传图层参数=应用到选中图层；或 compName+layerIndex/layerName 指定图层）。'
                + '仅 asset_refs 有 add/originalPath/targetFolder；仅 presets 有 applyToAE。',
            input_schema: {
                type: 'object',
                properties: {
                    library: {
                        type: 'string',
                        enum: ['asset_refs', 'project_assets', 'presets'],
                        description: '必填：素材库（id 前缀 ref_/pa_/pr_ 一一对应，传错会被拒并提示正确库）'
                    },
                    mode: {
                        type: 'string',
                        enum: ['list', 'get', 'search', 'listFolders', 'listEmptyFolders',
                            'listMissing', 'scanMissing', 'listArchive',
                            'add', 'rename', 'move', 'createFolder', 'renameFolder', 'removeFolder',
                            'updateMeta', 'archive', 'restore', 'importToAE', 'applyToAE']
                    },
                    id: { type: 'string', description: 'get/rename/move/updateMeta/applyToAE 用：条目 id（单个）' },
                    ids: { type: 'array', items: { type: 'string' }, description: 'archive/restore/importToAE 用：条目 id 列表（单次上限 ' + _maxIds() + '；archive/restore 与 folder 二选一）' },
                    folder: { type: 'string', description: 'add/move/createFolder/removeFolder 用：目标文件夹路径；archive/restore 用：整夹归档/恢复的文件夹路径（递归含子层，与 ids 二选一）' },
                    newFolder: { type: 'string', description: 'renameFolder 必填：新文件夹路径' },
                    name: { type: 'string', description: 'add/rename/createFolder 用；importToAE（project_assets）仅单条时可选：导入后的 AE 工程名（AE 里显示为 <名>.aep，重名自动加 _N）' },
                    originalPath: { type: 'string', description: 'add（仅 asset_refs）必填：素材绝对路径（如 D:/assets/a.png）' },
                    notes: { type: 'string', description: 'updateMeta/add 用：备注（覆盖写；空串=清除；上限 ' + NOTES_MAX + ' 字）' },
                    query: { type: 'string', description: 'search 必填：关键词（匹配 name/notes）' },
                    targetFolder: { type: 'string', description: 'importToAE（仅 asset_refs）可选：导入到 AE 工程内的文件夹路径（如 "Scenes/Intro"）' },
                    compName: { type: 'string', description: 'applyToAE 指定图层模式必填：合成名称（传此字段或 layerIndex/layerName 任一即进入指定图层模式，否则用选中图层）' },
                    layerIndex: { type: 'number', description: 'applyToAE 指定图层模式用：图层索引（与 layerName 二选一）' },
                    layerName: { type: 'string', description: 'applyToAE 指定图层模式用：图层名称（与 layerIndex 二选一）' }
                },
                required: ['library', 'mode']
            },
            // scope（shader 模式不需要素材库的工具）：原 global
            // → `['agent','external-mcp']`，**不含 shader**。shader 轮输入取自
            // 当前图层（iChannel0）与映射图层（iChannel1/2/3，须已在合成里），素材库的
            // 引用层/工程素材/预设三架书架在那里没有消费点。外接必须保留——extPolicy 的
            // assets 组 fixed 名单含它，而 tools/list 投影不查 scope、调用闸门才查。
            // Script 档只产出代码，素材库的
            // importToAE / applyToAE / 归档等管理动作属于 AE 操作面，故移出 Script 默认面
            //（面板仍可手动放宽）。
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'assets',
            source: 'assets',
            handler: function (args) {
                return _handleAssetLibrary(args, STORES, hostApi);
            }
        });

        console.log('[AssetsBootstrap] Registered ' + TOOL_NAMES.length + ' assets tool (asset_library)');
        return { ok: true, toolNames: TOOL_NAMES };
    }

    // ════════════════════════════════════════════════════════
    //  asset_library 分发
    // ════════════════════════════════════════════════════════
    function _handleAssetLibrary(args, stores, hostApi) {
        args = args || {};
        try {
            var lib = args.library;
            if (!lib) return _err('必填 library（asset_refs / project_assets / presets）');
            if (!LIBRARIES[lib]) {
                return _err('未知 library: ' + lib + '（可选 asset_refs / project_assets / presets）');
            }
            var store = stores && stores[lib];
            if (!store) return _err('library 未就绪（store 缺失）: ' + lib);
            var mode = args.mode;
            if (!mode) return _err('必填 mode');

            // 删除假入口路由：本工具没有永久删除——删除=归档
            if (mode === 'delete' || mode === 'remove' || mode === 'purge' || mode === 'purgeArchive') {
                return _err('本工具没有删除/永久清理（删除=归档）：素材与文件夹请用 mode=archive（ids 或 folder）；'
                    + '永久清理仅在面板「素材库 → 归档区」按钮打开的归档区面板里提供');
            }

            switch (mode) {
                // ── 读 ──
                case 'list': return _ok(_fmtList(store.list(), args.folder));
                case 'get': return _ok(_fmtGet(store, args.id));
                case 'search': return _ok(_fmtSearch(store.list(), args.query));
                case 'listFolders': return _ok(_fmtFolderList(store));
                case 'listEmptyFolders': return _ok(_fmtEmptyFolders(store));
                case 'listMissing': return _ok(_fmtMissing(store.listMissing()));
                case 'listArchive': return _sweepNoteThen(store, function (note) {
                    return _fmtArchive(store).then(function (text) { return _ok(note + text); });
                });
                case 'scanMissing':
                    return store.scanMissing().then(function (r) {
                        return _ok('扫描完成，丢失条目数: ' + r.missingCount);
                    }).catch(_asyncErr);

                // ── 写（仅 asset_refs）──
                case 'add': return _assetAdd(lib, store, args);

                // ── 写（三库通用）──
                case 'rename': return _assetRename(lib, store, args);
                case 'move': return _assetMove(lib, store, args);
                case 'createFolder': return _assetCreateFolder(lib, store, args);
                case 'renameFolder': return _assetRenameFolder(lib, store, args);
                case 'removeFolder': return _removeFolderSafe(store, args.folder);
                case 'updateMeta': return _assetUpdateMeta(lib, store, args);

                // ── 归档（删除=归档）──
                case 'archive': return _assetArchive(lib, store, args);
                case 'restore': return _assetRestore(lib, store, args);

                // ── 导入 AE ──
                case 'importToAE':
                    if (lib === 'presets') return _err('presets 不支持 importToAE（预设用 applyToAE 应用到图层）');
                    return _importToAE(lib, store, hostApi, args);
                case 'applyToAE':
                    if (lib !== 'presets') return _err('仅 presets 支持 applyToAE（素材/工程素材用 importToAE 导入）');
                    return _applyToAE(store, hostApi, args);

                default: return _err('未知 mode: ' + mode);
            }
        } catch (e) {
            return _asyncErr(e);
        }
    }

    // ── add（仅 asset_refs）──
    function _assetAdd(lib, store, args) {
        if (lib !== 'asset_refs') {
            return _err(lib === 'project_assets'
                ? '工程素材不支持 add（.aep 由 UI 拖入入库）'
                : '预设不支持 add（.ffx 由 UI 拖入入库）');
        }
        if (!args.originalPath) return _err('add 模式必填 originalPath');
        // originalPath 受限字符入口拦截——AEFS._checkPath 对含 %/控制字符/引号的
        // 路径一律拒绝（exists/deleteFile/importFilesToAE 全 false），此类路径入库即永久
        // missing（scanMissing 标记后 cleanMissing 误删引用）
        var _opBad = _checkOriginalPath(args.originalPath);
        if (_opBad) return _err(_opBad);
        if (args.name) { var _bad = _checkName(args.name); if (_bad) return _err(_bad); }
        if (args.folder) {
            var _fBad = _checkFolderPath(args.folder); if (_fBad) return _err(_fBad);
            var _fRes = _reservedFolderGuard(args.folder); if (_fRes) return _err(_fRes);
        }
        if (args.notes !== undefined && typeof args.notes !== 'string') {
            return _err('notes 必须是字符串（收到 ' + (typeof args.notes) + '）');
        }
        if (args.notes !== undefined && String(args.notes).length > NOTES_MAX) {
            return _err('备注超长（' + String(args.notes).length + ' 字，上限 ' + NOTES_MAX + ' 字）');
        }
        var opts = { originalPath: args.originalPath };
        if (args.name) opts.name = args.name;
        if (args.folder) opts.folder = args.folder;
        if (args.notes !== undefined) opts.notes = args.notes;
        return store.add(opts).then(function (it) {
            return _ok('已添加「' + it.name + '」(id=' + it.id + ', type=' + it.type + ')'
                + '\n父链: ' + _chain(it.folder) + ' · 该文件夹（含子层）共 ' + _folderCount(store.list(), it.folder) + ' 条');
        }).catch(_asyncErr);
    }

    function _assetRename(lib, store, args) {
        if (!args.id || !args.name) return _err('rename 必填 id 和 name');
        var _idBad = _idCheck(lib, args.id); if (_idBad) return _err(_idBad);
        { var _bad = _checkName(args.name); if (_bad) return _err(_bad); }
        var it = _getById(store, args.id);
        if (!it) return Promise.resolve(_err('条目不存在: ' + args.id));
        var g = _archivedGuard(it); if (g) return Promise.resolve(_err(g));
        var oldName = it.name;
        return Promise.resolve(store.rename(args.id, args.name)).then(function (ok) {
            if (ok === false) return _err('重命名失败: ' + args.id);
            var cur = _getById(store, args.id) || it;
            return _ok('已重命名「' + oldName + '」→「' + cur.name + '」(' + args.id + ')'
                + '\n父链: ' + _chain(cur.folder) + ' · 该文件夹（含子层）共 ' + _folderCount(store.list(), cur.folder) + ' 条');
        }).catch(_asyncErr);
    }

    function _assetMove(lib, store, args) {
        if (!args.id) return _err('move 必填 id');
        var _idBad = _idCheck(lib, args.id); if (_idBad) return _err(_idBad);
        var _fBad = _checkFolderPath(args.folder || ''); if (_fBad) return _err(_fBad);
        var _fRes = _reservedFolderGuard(args.folder || ''); if (_fRes) return _err(_fRes);
        var it = _getById(store, args.id);
        if (!it) return Promise.resolve(_err('条目不存在: ' + args.id));
        var g = _archivedGuard(it); if (g) return Promise.resolve(_err(g));
        return Promise.resolve(store.move(args.id, _normF(args.folder || ''))).then(function (ok) {
            if (ok === false) return _err('移动失败: ' + args.id);
            var cur = _getById(store, args.id) || it;
            return _ok('已移动「' + cur.name + '」(' + args.id + ') → ' + (cur.folder ? cur.folder : '根目录')
                + '\n父链: ' + _chain(cur.folder) + ' · 该文件夹（含子层）共 ' + _folderCount(store.list(), cur.folder) + ' 条');
        }).catch(_asyncErr);
    }

    function _assetCreateFolder(lib, store, args) {
        if (!args.folder) return _err('createFolder 必填 folder');
        var _fBad = _checkFolderPath(args.folder); if (_fBad) return _err(_fBad);
        var _fRes = _reservedFolderGuard(args.folder); if (_fRes) return _err(_fRes);
        var fN = _normF(args.folder);
        return Promise.resolve(store.createFolder(fN)).then(function (ok) {
            if (ok === false) return _err('创建失败（路径非法或已存在）: ' + args.folder);
            var empt = (store.listEmptyFolders && store.listEmptyFolders()) || [];
            return _ok('已创建文件夹 ' + fN + '（父链: ' + _chain(fN) + '）'
                + '· 该文件夹' + (empt.indexOf(fN) !== -1 ? '当前为空' : '（含子层）共 ' + _folderCount(store.list(), fN) + ' 条'));
        }).catch(_asyncErr);
    }

    function _assetRenameFolder(lib, store, args) {
        if (!args.folder || !args.newFolder) return _err('renameFolder 必填 folder 和 newFolder');
        // 拒绝根路径——'/' 等空段路径过 invalidFolderPath 校验（空段集不拒），
        // 归一化后 oldN='' 触发 store「根重命名」分支：全库根级条目被批量迁移进
        // newFolder（refStore 索引全迁；presetStore 跨目录物理 copy+delete，中途失败
        // 留半迁移态）。UI 无此入口（treeView 只传实际子文件夹路径），仅 LLM 可达。
        if (!_normF(args.folder)) {
            return _err('renameFolder 不支持根路径：folder 不能为 "/"（根目录不可重命名，仅可重命名子文件夹）');
        }
        // newFolder 归一化后为空（如 '/'）——非空校验只查 truthy，'/' 通过
        // 后 store 层把 newN='' 当「条目提升到根 / 复制到根」执行，静默改变全库结构
        if (!_normF(args.newFolder)) {
            return _err('renameFolder 的 newFolder 不能为 "/"（归一化后为空，不能把文件夹改名为根目录）');
        }
        var _nfBad = _checkFolderPath(args.newFolder); if (_nfBad) return _err(_nfBad);
        var _resOld = _reservedFolderGuard(args.folder); if (_resOld) return _err(_resOld);
        var _resNew = _reservedFolderGuard(args.newFolder); if (_resNew) return _err(_resNew);
        var oldPath = _normF(args.folder), newPath = _normF(args.newFolder);
        return Promise.resolve(store.renameFolder(oldPath, newPath)).then(function (ok) {
            if (ok === false) return _err('重命名失败（目标已存在或路径非法）: ' + args.folder);
            return _ok('已重命名文件夹 ' + oldPath + ' → ' + newPath
                + '（父链: ' + _chain(newPath) + '）· 该文件夹（含子层）共 ' + _folderCount(store.list(), newPath) + ' 条');
        }).catch(_asyncErr);
    }

    function _assetUpdateMeta(lib, store, args) {
        if (!args.id) return _err('updateMeta 必填 id');
        var _idBad = _idCheck(lib, args.id); if (_idBad) return _err(_idBad);
        if (args.notes === undefined) return _err('updateMeta 必填 notes');
        if (typeof args.notes !== 'string') {
            return _err('notes 必须是字符串（收到 ' + (typeof args.notes) + '）；清空备注传空串 ""');
        }
        if (String(args.notes).length > NOTES_MAX) {
            return _err('备注超长（' + String(args.notes).length + ' 字，上限 ' + NOTES_MAX + ' 字）');
        }
        var it = _getById(store, args.id);
        if (!it) return Promise.resolve(_err('条目不存在: ' + args.id));
        var g = _archivedGuard(it); if (g) return Promise.resolve(_err(g));
        var oldLen = String(it.notes || '').length;
        return Promise.resolve(store.updateMeta(args.id, { notes: args.notes })).then(function () {
            var cur = _getById(store, args.id) || it;
            var newNotes = String(cur.notes || '');
            var head;
            if (newNotes === '') {
                head = '已清空备注「' + cur.name + '」(' + args.id + ')';
            } else {
                head = '已更新备注「' + cur.name + '」(' + args.id + ') → "' + _excerpt(newNotes) + '"'
                    + '（共 ' + newNotes.length + ' 字' + (oldLen ? '；原备注 ' + oldLen + ' 字已覆盖' : '') + '）';
            }
            return _ok(head + '\n父链: ' + _chain(cur.folder));
        }).catch(_asyncErr);
    }

    // ── 归档 / 恢复（ids 批量 或 folder 整夹，二选一）──
    function _assetArchive(lib, store, args) {
        var sel = _pickSelector(args, 'archive');
        if (sel.err) return _err(sel.err);
        return _sweepNoteThen(store, function (note) {
            var p;
            if (sel.folder != null) {
                p = store.archiveFolder(sel.folder);
            } else {
                p = store.archive(sel.ids);
            }
            return Promise.resolve(p).then(function (res) {
                return _ok(note + _fmtArchiveResult(lib, res, sel.folder));
            });
        });
    }

    function _assetRestore(lib, store, args) {
        var sel = _pickSelector(args, 'restore');
        if (sel.err) return _err(sel.err);
        var p = (sel.folder != null) ? store.restoreFolder(sel.folder) : store.restore(sel.ids);
        return Promise.resolve(p).then(function (res) {
            return _ok(_fmtRestoreResult(lib, res, sel.folder));
        }).catch(_asyncErr);
    }

    // 寻址参数校验：ids 与 folder 二选一 + 上限 + id 前缀自校验
    function _pickSelector(args, mode) {
        var hasIds = args.ids !== undefined && args.ids !== null;
        var hasFolder = args.folder !== undefined && args.folder !== null && String(args.folder) !== '';
        if (hasIds && hasFolder) return { err: 'ids 与 folder 二选一（' + mode + '）' };
        if (!hasIds && !hasFolder) {
            return { err: mode + ' 必填 ids（条目 id 数组）或 folder（文件夹路径），二选一' };
        }
        if (hasFolder) {
            var fN = _normF(args.folder);
            if (!fN) return { err: mode + ' 的 folder 不能为根路径（请指定子文件夹）' };
            var fBad = _checkFolderPath(args.folder);
            if (fBad) return { err: fBad };
            return { folder: fN };
        }
        var ids = Array.isArray(args.ids) ? args.ids : [args.ids];
        if (!ids.length) return { err: mode + ' 的 ids 不能为空数组' };
        if (ids.length > _maxIds()) {
            return { err: 'ids 超过单次上限 ' + _maxIds() + '（本次 ' + ids.length + ' 条），请分批' };
        }
        var idBad = _idsCheck(args.library, ids);
        if (idBad) return { err: idBad };
        return { ids: ids };
    }

    function _fmtArchiveResult(lib, res, folder) {
        res = res || {};
        var archived = res.archived || [];
        var missing = res.missing || [];
        var failures = res.failures || [];
        var head;
        if (folder != null) {
            head = '已归档文件夹「' + folder + '」共 ' + archived.length + ' 条'
                + '（7 天后自动清理；mode=restore 可恢复）'
                + '\n父链: ' + _chain(folder);
        } else {
            head = '已归档 ' + archived.length + ' 条（7 天后自动清理；mode=restore 可恢复）：';
        }
        var okLines = archived.map(function (it) {
            var line = '[' + it.name + '] id=' + it.id + ' 原位置: ' + (it.folder ? it.folder : '根');
            if (lib === 'asset_refs') {
                line += '（引用层：外部原文件不受影响）';
            } else if (it.archivePath) {
                line += ' · 归档路径: ' + String(it.archivePath).replace(/^.*\/(___archive__\/.*)$/, '$1');
            }
            return line;
        });
        var text = _batchBlock(head, okLines, failures);
        if (res.adopted) text += '\n已收编未登记文件 ' + res.adopted + ' 个（原目录内未索引的实体文件，一并归档）';
        if (res.skippedInvalid) text += '\n跳过非法文件名 ' + res.skippedInvalid + ' 个（未收编，留在原目录）';
        if (res.folderRecordsRemoved && res.folderRecordsRemoved.length) {
            text += '\n已移除文件夹记录 ' + res.folderRecordsRemoved.length + ' 个';
        }
        if (res.folderRecordsError) {
            text += '\n注意：文件夹记录移除失败（' + res.folderRecordsError + '），条目已归档、记录可稍后重试移除';
        }
        if (missing.length) {
            text += '\n已移除丢失条目的索引 ' + missing.length + ' 条（文件不存在，无实体可归档）：';
            text += '\n' + missing.map(function (m) { return '- [' + m.name + '] id=' + m.id; }).join('\n');
        }
        return text;
    }

    function _fmtRestoreResult(lib, res, folder) {
        res = res || {};
        var restored = res.restored || [];
        var failures = res.failures || [];
        var head;
        if (folder != null) {
            head = '已恢复文件夹「' + folder + '」共 ' + restored.length + ' 条 → 原位置：'
                + '\n父链: ' + _chain(folder);
        } else {
            head = '已恢复 ' + restored.length + ' 条：';
        }
        var okLines = restored.map(function (it) {
            return '[' + it.name + '] id=' + it.id + ' → ' + (it.folder ? it.folder : '根目录');
        });
        return _batchBlock(head, okLines, failures);
    }

    // ── 导入 AE ──
    function _importToAE(lib, store, hostApi, args) {
        if (!hostApi) return Promise.resolve(_err('hostApi 未就绪，无法导入 AE'));
        var ids = args.ids;
        if (ids === undefined && args.id !== undefined) ids = [args.id];   // 兼容单条 id
        if (!Array.isArray(ids) || ids.length === 0) {
            return Promise.resolve(_err('importToAE 必填 ids（条目 id 列表）'));
        }
        var _idBad = _idsCheck(lib, ids); if (_idBad) return Promise.resolve(_err(_idBad));
        if (args.name && ids.length > 1) {
            return Promise.resolve(_err('name 仅当 ids 为单条时可用（批量导入用各自条目名）'));
        }
        if (lib === 'asset_refs') {
            var items = [];
            for (var i = 0; i < ids.length; i++) {
                var found = _getById(store, ids[i]);
                if (!found) return Promise.resolve(_err('条目 id 不存在: ' + ids[i]));
                var g = _archivedGuard(found); if (g) return Promise.resolve(_err(g));
                if (found.missing) return Promise.resolve(_err('条目丢失，无法导入: ' + found.name + ' (' + found.id + ')'));
                items.push({ path: found.originalPath, folder: args.targetFolder || found.folder || '' });
            }
            return global.AEAssetsShared.importFilesToAE(hostApi, items).then(function (r) {
                var msg = '导入完成: 成功 ' + r.ok + ' 条';
                if (r.fail) msg += '，失败 ' + r.fail + ' 条';
                if (r.renames && r.renames.length) {
                    msg += '\n重命名: ' + r.renames.map(function (x) { return x.orig + '→' + x.renamed; }).join(', ');
                }
                return _ok(msg);
            }).catch(_asyncErr);
        }
        // project_assets：单条（可传 name 覆盖工程名）
        var item = _getById(store, ids[0]);
        if (!item) return Promise.resolve(_err('条目 id 不存在: ' + ids[0]));
        var gp = _archivedGuard(item); if (gp) return Promise.resolve(_err(gp));
        if (item.missing) return Promise.resolve(_err('条目丢失，无法导入: ' + item.name));
        if (!item.aepPath) return Promise.resolve(_err('条目无 aepPath，无法导入'));
        var baseName = args.name || item.name || '';
        return global.AEAssetsShared.importProjectToAE(hostApi, item.aepPath, baseName).then(function (r) {
            // importProjectToAE 返回字符串："xxx" 或 "RENAMED:xxx"
            var s = String(r || '');
            if (s.indexOf('RENAMED:') === 0) {
                return _ok('已导入工程「' + item.name + '」(id=' + item.id + ')（AE 中已有同名，已重命名为: ' + s.slice(8) + '）');
            }
            return _ok('已导入工程: ' + s);
        }).catch(_asyncErr);
    }

    function _applyToAE(store, hostApi, args) {
        if (!hostApi) return Promise.resolve(_err('hostApi 未就绪，无法应用到 AE'));
        if (!args.id) return Promise.resolve(_err('applyToAE 必填 id'));
        var item = _getById(store, args.id);
        if (!item) return Promise.resolve(_err('条目 id 不存在: ' + args.id));
        var g = _archivedGuard(item); if (g) return Promise.resolve(_err(g));
        if (item.missing) return Promise.resolve(_err('条目丢失，无法应用: ' + item.name));
        if (!item.ffxPath) return Promise.resolve(_err('条目无 ffxPath，无法应用'));
        if (!item.name) return Promise.resolve(_err('条目无 name，无法应用（数据损坏）'));

        // 二选一：指定图层（compName/layerIndex/layerName）vs 选中图层（不传图层参数）
        var hasLayerTarget = args.compName || args.layerIndex !== undefined || args.layerName;
        if (hasLayerTarget) {
            if (!args.compName) return Promise.resolve(_err('指定图层模式必填 compName（合成名称）'));
            if (args.layerIndex === undefined && !args.layerName) {
                return Promise.resolve(_err('指定图层模式需提供 layerIndex 或 layerName 至少一个'));
            }
            var layerTarget = {
                compName: args.compName,
                layerIndex: args.layerIndex,
                layerName: args.layerName
            };
            return global.AEAssetsShared.applyPresetToLayer(hostApi, item.ffxPath, layerTarget).then(function (r) {
                var layerDesc = r.layer ? (r.layer.name + ' (index=' + r.layer.index + ')') : '未知';
                return _ok('已应用预设「' + item.name + '」(' + item.id + ') → 图层 ' + layerDesc
                    + (args.compName ? ' · 合成 ' + args.compName : ''));
            }).catch(_asyncErr);
        }
        return global.AEAssetsShared.applyPresetToAE(hostApi, item.ffxPath, item.name).then(function (r) {
            var msg = '已应用预设「' + item.name + '」(' + item.id + ') 到选中图层: 成功 ' + r.applied + ' 个';
            if (r.failed) msg += '，失败 ' + r.failed + ' 个';
            if (r.errors && r.errors.length) msg += '\n错误: ' + r.errors.join('; ');
            return _ok(msg);
        }).catch(_asyncErr);
    }

    // ════════════════════════════════════════════════════════
    //  共用辅助
    // ════════════════════════════════════════════════════════

    // removeFolder 安全包装：先校验空，再调 store.deleteEmptyFolder
    // 三 store 都已实现 deleteEmptyFolder（语义对齐）：
    //   - refStore（via folderStoreMixin）：从 .folders.json 删虚拟记录，串行化写入
    //   - projectAssetStore：从 .folders.json 删虚拟记录，串行化写入
    //   - presetStore：物理 rmdir + 刷新 _emptyDirs 缓存
    // 仅删空文件夹：先校验 listEmptyFolders 包含 folder，非空则拒
    function _removeFolderSafe(store, folder) {
        if (!folder) return Promise.resolve(_err('removeFolder 必填 folder'));
        var normFolder = _normF(folder);
        return Promise.resolve(store.listEmptyFolders()).then(function (empty) {
            var found = false;
            if (Array.isArray(empty)) {
                for (var i = 0; i < empty.length; i++) {
                    if (empty[i] === normFolder) { found = true; break; }
                }
            }
            if (!found) return _err('文件夹非空或不存在，仅允许删除空文件夹: ' + folder);
            if (typeof store.deleteEmptyFolder !== 'function') {
                return _err('store 未实现 deleteEmptyFolder，无法删除: ' + folder);
            }
            return store.deleteEmptyFolder(normFolder).then(function (ok) {
                if (!ok) return _err('删除失败（可能目录非空或路径非法）: ' + folder);
                return _ok('已删除空文件夹 ' + normFolder + '（父链: ' + _chain(normFolder) + '）');
            }).catch(_asyncErr);
        });
    }

    function _fmtList(items, folderFilter) {
        if (!items || !items.length) return '（空）';
        var list = items;
        if (folderFilter) {
            var norm = _normF(folderFilter);
            list = items.filter(function (it) {
                var f = _normF(it.folder);
                if (f === norm) return true;
                return norm.length > 0 && f.indexOf(norm + '/') === 0;
            });
        }
        if (!list.length) return '（无匹配条目）';
        var lines = ['共 ' + list.length + ' 条：'];
        for (var i = 0; i < list.length; i++) lines.push(_summarizeItem(list[i]));
        return lines.join('\n');
    }

    function _fmtGet(store, id) {
        if (!id) return '错误：缺少 id';
        var it = _getById(store, id);
        if (!it) return '未找到 id=' + id;
        var lines = ['--- ' + it.name + ' ---'];
        if (it.archived) {
            var d = _remainDays(it);
            lines.push('[已归档' + (d != null ? ' · 剩余 ' + d + ' 天' : '') + ']（mode=restore 可恢复）');
        }
        lines.push('父链: ' + _chain(it.folder));
        Object.keys(it).forEach(function (k) {
            lines.push(k + ': ' + JSON.stringify(it[k]));
        });
        return lines.join('\n');
    }

    // 匹配面：name + notes（大小写不敏感），命中行标注命中字段
    function _matchFields(it, q) {
        var hit = [];
        if (String(it.name || '').toLowerCase().indexOf(q) >= 0) hit.push('name');
        if (String(it.notes || '').toLowerCase().indexOf(q) >= 0) hit.push('notes');
        return hit;
    }

    function _fmtSearch(items, query) {
        if (!query) return '错误：缺少 query';
        var q = String(query).toLowerCase();
        var matched = [];
        for (var i = 0; i < items.length; i++) {
            var hit = _matchFields(items[i], q);
            if (hit.length) matched.push({ it: items[i], hit: hit });
        }
        if (!matched.length) return '未匹配到关键词: ' + query;
        var lines = ['匹配 ' + matched.length + ' 条：'];
        for (var j = 0; j < matched.length; j++) {
            lines.push(_summarizeItem(matched[j].it) + ' · ' + matched[j].hit.join('+') + ' 命中');
        }
        return lines.join('\n');
    }

    function _fmtFolderList(store) {
        // 从 list() 反推全部 folder 路径（含中间层级）
        var items = store.list();
        var set = {};
        for (var i = 0; i < items.length; i++) {
            var f = _normF(items[i].folder);
            if (!f) continue;
            var segs = f.split('/');
            var acc = '';
            for (var s = 0; s < segs.length; s++) {
                if (!segs[s]) continue;
                acc = acc ? acc + '/' + segs[s] : segs[s];
                set[acc] = true;
            }
        }
        // 加上空文件夹
        var empty = store.listEmptyFolders() || [];
        for (var e = 0; e < empty.length; e++) {
            set[_normF(empty[e])] = true;
        }
        var folders = Object.keys(set).sort();
        if (!folders.length) return '（无文件夹）';
        return '共 ' + folders.length + ' 个文件夹：\n' + folders.map(function (f) { return '- ' + f; }).join('\n');
    }

    function _fmtEmptyFolders(store) {
        var empty = store.listEmptyFolders() || [];
        if (!empty.length) return '（无空文件夹）';
        return '共 ' + empty.length + ' 个空文件夹：\n' + empty.map(function (f) { return '- ' + f; }).join('\n');
    }

    function _fmtMissing(missing) {
        if (!missing || !missing.length) return '（无丢失条目）';
        var lines = ['丢失 ' + missing.length + ' 条：'];
        for (var i = 0; i < missing.length; i++) lines.push(_summarizeItem(missing[i]));
        return lines.join('\n');
    }

    // 归档区：按原文件夹分组（组头给归档时间与剩余天数），末尾附未登记项（盘上有、索引无）
    function _fmtArchive(store) {
        var arch = (store.listArchive && store.listArchive()) || [];
        var lines = [];
        if (!arch.length) {
            lines.push('（归档区为空）');
        } else {
            lines.push('归档区 ' + arch.length + ' 条（7 天后自动清理；mode=restore 恢复）：');
            var groups = {};
            var order = [];
            for (var i = 0; i < arch.length; i++) {
                var key = _normF(arch[i].folder);
                if (!groups[key]) { groups[key] = []; order.push(key); }
                groups[key].push(arch[i]);
            }
            for (var g = 0; g < order.length; g++) {
                var k = order[g];
                var list = groups[k];
                var d = _remainDays(list[0]);
                lines.push('- ' + (k ? k : '（根）') + '（' + list.length + ' 条 · 归档于 '
                    + String(list[0].archivedAt || '').slice(0, 10) + (d != null ? ' · 剩余 ' + d + ' 天' : '') + '）');
                for (var j = 0; j < list.length; j++) {
                    lines.push('  - [' + list[j].name + '] id=' + list[j].id + _notesSuffix(list[j]));
                }
            }
        }
        if (typeof store.listUnregisteredArchive === 'function') {
            return Promise.resolve().then(function () {
                return store.listUnregisteredArchive();
            }).then(function (un) { return _withUnregistered(lines, un); },
                function () { return lines.join('\n'); });
        }
        return Promise.resolve(lines.join('\n'));
    }

    function _withUnregistered(lines, un) {
        if (un && un.length) {
            lines.push('未登记 ' + un.length + ' 项（归档区存在但索引无记录，不会自动清理，请人工确认）：');
            for (var i = 0; i < Math.min(un.length, 10); i++) lines.push('- ' + un[i]);
            if (un.length > 10) lines.push('- …（其余 ' + (un.length - 10) + ' 项略）');
        }
        return lines.join('\n');
    }

    // 暴露
    global.AEAssetsShared.initAssetsTools = initAssetsTools;
    // 校验函数的 UI 出口（E2E-2）：refView 拖入路径复用同一判据，避免
    // "LLM 入口拒、UI 入口放行"的两套口径漂移（本文件载入晚于 refView，调用发生在运行时，无载序问题）
    global.AEAssetsShared.checkOriginalPath = _checkOriginalPath;
    // 供 permissions.js 引用（避免循环依赖，permissions.js 内部硬编码同名集合）
    global.AEAssetsShared.READ_MODES = READ_MODES;
    global.AEAssetsShared.IMPORT_MODES = IMPORT_MODES;
    global.AEAssetsShared.ARCHIVE_MODES = ARCHIVE_MODES;
})(window);
