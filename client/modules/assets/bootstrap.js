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
 *   - move 支持 id 单个与 ids 批量；批量走 store.moveBatch（批内索引只写 1 次，
 *     与 UI 多选拖拽同一接口），批量前逐条校验未知 id / 归档态并整批拒绝
 *   - moveFolder 移动文件夹（folder 单个 / folders 批量）到 targetFolder 下：目标父
 *     文件夹须已存在（根除外），目标已有同名文件夹时拒绝
 *   - createFolder 支持 folder 单个与 folders 批量（父链自动创建；已存在项不重复建；
 *     回执区分「已创建」与「已存在」）
 *   - renameFolder 只做同层改名（name 为单段新名称），跨层搬移一律走 moveFolder
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
    // 文件夹路径归一化：去首尾斜杠 + 折叠重复斜杠（'a//b' 与 'a/b' 是同一路径，
    // 不折叠会在 .folders.json 落两条记录且按任一路径都删不掉另一条）
    function _normF(f) { return String(f || '').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/'); }

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
                + ' 写：rename/move（条目；id 单个或 ids 批量）/moveFolder（文件夹；folder 或 folders 移到 targetFolder 下）/createFolder（folder 单个或 folders 批量，父链自动创建）/renameFolder（name 单段新名称；跨层搬移用 moveFolder）/removeFolder（仅空文件夹）/updateMeta（备注覆盖写；notes 空串=清除；上限 ' + NOTES_MAX + ' 字）；'
                + ' 归档（=删除）：archive / restore（ids 数组批量，或 folder 路径整夹，二选一）——用户要求「删除/清理/移除」素材或文件夹时一律用 archive；'
                + ' 本工具没有永久删除：移入归档区，7 天后自动清理，期间可 restore。归档条目仅 get/restore 可用，其余 mode 一律拒绝。'
                + ' folder 整夹归档=递归含子层；空文件夹请用 removeFolder（无内容可归档）。'
                + ' 导入 AE：importToAE（asset_refs/project_assets；ids 数组；project_assets 仅单条可传 name 覆盖工程名）；'
                + ' applyToAE（presets；不传图层参数=应用到选中图层；或 compName+layerIndex/layerName 指定图层）。'
                + '仅 asset_refs 有 add/originalPath；targetFolder 用于 moveFolder（三库）与 importToAE（仅 asset_refs）；仅 presets 有 applyToAE。',
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
                            'add', 'rename', 'move', 'createFolder', 'renameFolder', 'moveFolder', 'removeFolder',
                            'updateMeta', 'archive', 'restore', 'importToAE', 'applyToAE']
                    },
                    id: { type: 'string', description: 'get/rename/move/updateMeta/applyToAE 用：条目 id（单个；move 批量请用 ids）' },
                    ids: { type: 'array', items: { type: 'string' }, description: 'archive/restore/importToAE 用：条目 id 列表（单次上限 ' + _maxIds() + '；archive/restore 与 folder 二选一）；move 用：批量移动的条目 id 列表（与 id 二选一，上限同）' },
                    folder: { type: 'string', description: 'add/move/createFolder/removeFolder 用：目标文件夹路径（move 传空或省略=移到根目录）；moveFolder 用：要移动的源文件夹路径（单个）；renameFolder 用：原文件夹路径（同层改名，新名称传 name）；archive/restore 用：整夹归档/恢复的文件夹路径（递归含子层，与 ids 二选一）' },
                    folders: { type: 'array', items: { type: 'string' }, description: 'moveFolder 用：要移动的源文件夹路径列表（批量；与 folder 二选一，单次上限 ' + _maxIds() + '），目标父文件夹见 targetFolder；createFolder 用：要创建的文件夹路径列表（批量，父链自动创建，已存在项不重复建；与 folder 二选一，上限同）' },
                    name: { type: 'string', description: 'add/rename/renameFolder 用：条目/文件夹名称（renameFolder 为同层新名称：单段、不含 /）；importToAE（project_assets）仅单条时可选：导入后的 AE 工程名（AE 里显示为 <名>.aep，重名自动加 _N）' },
                    originalPath: { type: 'string', description: 'add（仅 asset_refs）必填：素材绝对路径（如 D:/assets/a.png）' },
                    notes: { type: 'string', description: 'updateMeta/add 用：备注（覆盖写；空串=清除；上限 ' + NOTES_MAX + ' 字）' },
                    query: { type: 'string', description: 'search 必填：关键词（匹配 name/notes）' },
                    targetFolder: { type: 'string', description: 'moveFolder 用：目标父文件夹路径（省略或空串=移到根目录；父文件夹须已存在，可先 createFolder）；importToAE（仅 asset_refs）可选：导入到 AE 工程内的文件夹路径（如 "Scenes/Intro"）' },
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
                case 'moveFolder': return _assetMoveFolder(lib, store, args);
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

    // move：id 单个与 ids 批量二选一。批量走 store.moveBatch（与 UI 多选拖拽同一接口，
    // 批内索引只写 1 次）。工具层先逐条校验：未知 id / 归档条目 / 空值或非字符串 id
    // 一律整批拒绝；回执按条目当前 folder 对账，不依赖 store 返回值。
    function _assetMove(lib, store, args) {
        var hasIds = args.ids !== undefined && args.ids !== null;
        var hasSingleId = args.id !== undefined && args.id !== null && String(args.id) !== '';
        if (hasIds) {
            if (hasSingleId) {
                return _err('move 的 id 与 ids 二选一（单个用 id，批量用 ids）');
            }
            var raw = Array.isArray(args.ids) ? args.ids : [args.ids];
            var ids = [], seen = Object.create(null);
            for (var i = 0; i < raw.length; i++) {
                if (typeof raw[i] !== 'string' || raw[i] === '') {
                    return _err('ids 必须是字符串数组（第 ' + (i + 1) + ' 项为空或非字符串）');
                }
                if (seen[raw[i]]) continue;
                seen[raw[i]] = true;
                ids.push(raw[i]);
            }
            if (!ids.length) return _err('move 的 ids 不能为空数组');
            if (ids.length > _maxIds()) {
                return _err('ids 超过单次上限 ' + _maxIds() + '（本次 ' + ids.length + ' 条），请分批');
            }
            var _idBadB = _idsCheck(lib, ids); if (_idBadB) return _err(_idBadB);
            var _fBadB = _checkFolderPath(args.folder || ''); if (_fBadB) return _err(_fBadB);
            var _fResB = _reservedFolderGuard(args.folder || ''); if (_fResB) return _err(_fResB);
            var items = [], unknown = [], archivedMsg = '';
            for (var j = 0; j < ids.length; j++) {
                var one = _getById(store, ids[j]);
                if (!one) { unknown.push(ids[j]); continue; }
                if (!archivedMsg) { var gArch = _archivedGuard(one); if (gArch) archivedMsg = gArch; }
                items.push(one);
            }
            if (unknown.length) {
                return Promise.resolve(_err('条目 id 不存在: ' + unknown.join(', ') + '（请先用 mode=list 确认 id）'));
            }
            if (archivedMsg) return Promise.resolve(_err(archivedMsg));
            if (typeof store.moveBatch !== 'function') {
                return Promise.resolve(_err('该素材库未实现 moveBatch，无法批量移动'));
            }
            var tf = _normF(args.folder || '');
            var already = 0;
            for (var k = 0; k < items.length; k++) {
                if (_normF(items[k].folder) === tf) already++;
            }
            return Promise.resolve(store.moveBatch(ids, tf)).then(function () {
                return _moveBatchReceipt(store, items, ids, tf, already, '');
            }).catch(function (e) {
                // 批内中途失败：store 可能已搬走部分（presetStore 先落盘已完成部分再抛），
                // 按条目当前 folder 复核后如实分报已移动/未移动，不把整批一律报成失败
                return _moveBatchReceipt(store, items, ids, tf, already,
                    (e && e.message) ? e.message : String(e));
            });
        }
        if (!args.id) return _err('move 必填 id（单个）或 ids（批量）');
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

    // 批量条目移动对账：按条目当前 folder 统计已到/未到目标（store.moveBatch 的返回值
    // 是处理数，批内中途失败时不可作为回执依据），回执分开报已移动与未移动。
    function _moveBatchReceipt(store, items, ids, tf, already, errMsg) {
        var arrived = 0, missing = [];
        for (var i = 0; i < ids.length; i++) {
            var cur = _getById(store, ids[i]);
            if (cur && _normF(cur.folder) === tf) arrived++;
            else missing.push(ids[i]);
        }
        var movedNow = Math.max(0, arrived - already);
        var lines = ['已移动 ' + movedNow + ' 个条目 → ' + (tf ? tf : '根目录')
            + (already > 0 ? '（另有 ' + already + ' 条原本已在目标，未改动）' : ''),
            '父链: ' + _chain(tf) + ' · 该文件夹（含子层）共 ' + _folderCount(store.list(), tf) + ' 条'];
        for (var x = 0; x < items.length; x++) {
            lines.push('- [' + (items[x].name || '?') + '] id=' + items[x].id);
        }
        if (missing.length) lines.push('未移动 ' + missing.length + ' 个: ' + missing.join(', '));
        if (errMsg) lines.push('失败原因: ' + errMsg);
        if (missing.length) lines.push('请 mode=list 复核后只重试未移动的条目');
        if (!missing.length && !errMsg) return _ok(lines.join('\n'));
        return _err(lines.join('\n'));
    }

    // 文件夹状态摘要（创建/已存在回执共用）：空文件夹记录或含子层条目数
    function _folderStateFrom(items, empty, fN) {
        return empty.indexOf(fN) !== -1 ? '当前为空' : '（含子层）共 ' + _folderCount(items, fN) + ' 条';
    }
    function _folderStateText(store, fN) {
        return _folderStateFrom(store.list() || [], (store.listEmptyFolders && store.listEmptyFolders()) || [], fN);
    }
    // 把路径及其祖先登记进文件夹集合（批内先建父链时，后建的子路径祖先已随之存在）
    function _folderSetAdd(set, fN) {
        var f = _normF(fN);
        while (f) {
            if (set[f]) break;
            set[f] = true;
            var k = f.lastIndexOf('/');
            f = k > 0 ? f.slice(0, k) : '';
        }
    }

    // 建文件夹：folder 单个或 folders 批量（父链自动创建）。已存在的路径不重复建，
    // 回执区分「已创建」与「已存在（未重复创建）」——store.createFolder 是幂等语义，
    // 自身不区分这两者，存在性在工具层用文件夹集合判定。
    function _assetCreateFolder(lib, store, args) {
        var hasFolders = args.folders !== undefined && args.folders !== null;
        var hasFolder = args.folder !== undefined && args.folder !== null && String(args.folder) !== '';
        if (hasFolder && typeof args.folder !== 'string') {
            return _err('createFolder 的 folder 必须是字符串（收到 ' + (typeof args.folder) + '）');
        }
        if (hasFolders && hasFolder) {
            return _err('createFolder 的 folder 与 folders 二选一（单个用 folder，批量用 folders）');
        }
        if (!hasFolders && !hasFolder) {
            return _err('createFolder 必填 folder（单个路径）或 folders（路径列表）');
        }
        var paths = [];
        if (hasFolders) {
            if (!Array.isArray(args.folders)) return _err('createFolder 的 folders 必须是数组');
            var seen = Object.create(null);
            for (var i = 0; i < args.folders.length; i++) {
                if (typeof args.folders[i] !== 'string') {
                    return _err('folders 必须是字符串数组（第 ' + (i + 1) + ' 项不是字符串）');
                }
                var p = _normF(args.folders[i]);
                if (!p) return _err('folders 的路径不能为空或根路径（第 ' + (i + 1) + ' 项）');
                if (seen[p]) continue;
                seen[p] = true;
                paths.push(p);
            }
            if (!paths.length) return _err('createFolder 的 folders 不能为空数组');
            if (paths.length > _maxIds()) {
                return _err('folders 超过单次上限 ' + _maxIds() + '（本次 ' + paths.length + ' 个），请分批');
            }
        } else {
            paths.push(_normF(args.folder));
        }
        for (var j = 0; j < paths.length; j++) {
            if (!paths[j]) return _err('createFolder 不支持根路径（folder 不能为空或 "/"）');
            var _fBad = _checkFolderPath(paths[j]); if (_fBad) return _err('无法创建文件夹 ' + paths[j] + '：' + _fBad);
            var _fRes = _reservedFolderGuard(paths[j]); if (_fRes) return _err('无法创建文件夹 ' + paths[j] + '：' + _fRes);
        }
        var folderSet = _folderSet(store);
        // 实体库（presets）的「已存在」来自缓存/索引，仍调一次幂等 createFolder 补建目录并刷新缓存
        function _ensurePhysical(fN) {
            if (lib !== 'presets') return Promise.resolve(true);
            return Promise.resolve(store.createFolder(fN));
        }

        // 单个：已存在只报告（不落空文件夹记录），实体库补一次幂等 mkdir
        if (!hasFolders) {
            var fN = paths[0];
            if (folderSet[fN]) {
                return _ensurePhysical(fN).then(function (ok) {
                    if (ok === false) return _err('文件夹已存在但目录不可用（补建失败）: ' + fN);
                    return _ok('文件夹已存在（未重复创建）: ' + fN + '（父链: ' + _chain(fN) + '）'
                        + '· 该文件夹' + _folderStateText(store, fN));
                }).catch(_asyncErr);
            }
            return Promise.resolve(store.createFolder(fN)).then(function (ok) {
                if (ok === false) return _err('创建失败（路径非法）: ' + fN);
                return _ok('已创建文件夹 ' + fN + '（父链: ' + _chain(fN) + '）· 该文件夹' + _folderStateText(store, fN));
            }).catch(_asyncErr);
        }

        // 批量：逐条创建（每文件夹一次索引写）；已存在项只报告、不重复建
        var created = [], existed = [], failed = [];
        return paths.reduce(function (chain, fp) {
            return chain.then(function () {
                if (folderSet[fp]) {
                    return _ensurePhysical(fp).then(function (ok) {
                        if (ok === false) failed.push({ fN: fp, error: '已存在判定后补建目录失败' });
                        else existed.push(fp);
                    }, function (e) {
                        failed.push({ fN: fp, error: (e && e.message) ? e.message : String(e) });
                    });
                }
                return Promise.resolve(store.createFolder(fp)).then(function (ok) {
                    if (ok === false) { failed.push({ fN: fp, error: '创建失败（路径非法）' }); return; }
                    created.push(fp);
                    _folderSetAdd(folderSet, fp);
                }, function (e) {
                    failed.push({ fN: fp, error: (e && e.message) ? e.message : String(e) });
                });
            });
        }, Promise.resolve()).then(function () {
            var snapItems = store.list() || [];
            var snapEmpty = (store.listEmptyFolders && store.listEmptyFolders()) || [];
            var lines = [];
            if (created.length) {
                lines.push('已创建 ' + created.length + ' 个文件夹：');
                for (var a = 0; a < created.length; a++) {
                    lines.push('- ' + created[a] + '（父链: ' + _chain(created[a]) + '）· '
                        + _folderStateFrom(snapItems, snapEmpty, created[a]));
                }
            }
            if (existed.length) {
                lines.push('已存在 ' + existed.length + ' 个（未重复创建）：');
                for (var b = 0; b < existed.length; b++) lines.push('- ' + existed[b]);
            }
            if (!created.length && !existed.length) lines.push('未创建新文件夹：');
            if (failed.length) {
                lines.push('失败 ' + failed.length + ' 个：');
                for (var c = 0; c < failed.length; c++) lines.push('- ' + failed[c].fN + '：' + failed[c].error);
            }
            var text = lines.join('\n');
            return (failed.length === paths.length) ? _err(text) : _ok(text);
        });
    }

    // 同层改名：参数只要 folder（原路径）+ name（单段新名称），目标路径由工具拼接。
    // 跨层搬移由 moveFolder 承接——目标父夹存在性/同名占用/跳过清单/批量都在那里校验。
    function _assetRenameFolder(lib, store, args) {
        if (!args.folder) return _err('renameFolder 必填 folder（原文件夹路径）');
        if (typeof args.folder !== 'string') {
            return _err('renameFolder 的 folder 必须是字符串（收到 ' + (typeof args.folder) + '）');
        }
        // 拒绝根路径——'/' 等空段路径过 invalidFolderPath 校验（空段集不拒），
        // oldN='' 触发 store「根重命名」分支，全库根级条目被批量迁移进目标（refStore
        // 索引全迁；presetStore 跨目录物理 copy+delete，中途失败留半迁移态）。UI 无此
        // 入口（treeView 只传实际子文件夹路径），仅 LLM 可达。
        if (!_normF(args.folder)) {
            return _err('renameFolder 不支持根路径：folder 不能为 "/"（根目录不可重命名，仅可重命名子文件夹）');
        }
        if (args.newFolder !== undefined && args.newFolder !== null) {
            return _err('renameFolder 已改为 name（单段新名称），不再接受 newFolder：同层改名请传 name；'
                + '跨层搬移请用 mode=moveFolder');
        }
        if (!args.name || typeof args.name !== 'string') {
            return _err('renameFolder 必填 name（新名称：单段、不含 /）');
        }
        // 单段约束不依赖 treeView（_checkName 在 treeView 未加载时是 fail-open）；
        // 含分隔符的 name 大概率是旧「完整路径」用法，直接给迁移指引
        if (args.name.indexOf('/') !== -1 || args.name.indexOf('\\') !== -1 ||
            args.name === '.' || args.name === '..') {
            return _err('name 必须是单段名称（不含 / 或 \\，且不能是 . / ..）：同层改名只传末段；'
                + '跨层搬移请用 mode=moveFolder');
        }
        var _nameBad = _checkName(args.name); if (_nameBad) return _err(_nameBad);
        var oldPath = _normF(args.folder);
        var _ofBad = _checkFolderPath(oldPath); if (_ofBad) return _err(_ofBad);
        var parent = _folderParent(oldPath);
        var newPath = parent ? (parent + '/' + args.name) : args.name;
        var _nfBad = _checkFolderPath(newPath); if (_nfBad) return _err(_nfBad);
        var _resOld = _reservedFolderGuard(oldPath); if (_resOld) return _err(_resOld);
        var _resNew = _reservedFolderGuard(newPath); if (_resNew) return _err(_resNew);
        // 源文件夹必须存在：refStore/projectAssetStore 对不存在的路径是静默 no-op，
        // 不查会回执「已重命名/名称未变」假成功（归档文件夹在活动树中不可见，同样拒绝）
        if (!_folderSet(store)[oldPath]) {
            return _err('文件夹不存在: ' + oldPath + '（请先用 mode=listFolders 确认；归档文件夹请先 mode=restore）');
        }
        if (newPath === oldPath) {
            return _ok('文件夹 ' + oldPath + ' 名称未变（未做改动）');
        }
        return Promise.resolve(store.renameFolder(oldPath, newPath)).then(function (ok) {
            if (ok === false) return _err('重命名失败（目标已存在或路径非法）: ' + oldPath);
            return _ok('已重命名文件夹 ' + oldPath + ' → ' + newPath
                + '（父链: ' + _chain(newPath) + '）· 该文件夹（含子层）共 ' + _folderCount(store.list(), newPath) + ' 条');
        }).catch(_asyncErr);
    }

    // 文件夹的父路径（根级文件夹返回空串）
    function _folderParent(folder) {
        var n = _normF(folder);
        return n.indexOf('/') >= 0 ? n.slice(0, n.lastIndexOf('/')) : '';
    }

    // 全库文件夹集合（隐式父链 + 显式空文件夹记录）。moveFolder / createFolder /
    // renameFolder 的存在性与占用判定用：虚拟库的文件夹只由条目 folder 前缀与
    // .folders.json 记录体现，没有独立目录实体。
    function _folderSet(store) {
        var set = Object.create(null);
        var items = store.list() || [];
        for (var i = 0; i < items.length; i++) {
            var f = _normF(items[i] && items[i].folder);
            while (f) {
                if (set[f]) break;
                set[f] = true;
                var k = f.lastIndexOf('/');
                f = k > 0 ? f.slice(0, k) : '';
            }
        }
        var empty = (store.listEmptyFolders && store.listEmptyFolders()) || [];
        for (var j = 0; j < empty.length; j++) {
            // 显式空文件夹记录（如只 createFolder('a/b')）只有叶子路径，父链靠隐式层级
            // 显示——这里补齐祖先，与面板树/ listFolders 的可见集合一致
            var ef = _normF(empty[j]);
            while (ef) {
                if (set[ef]) break;
                set[ef] = true;
                var ek = ef.lastIndexOf('/');
                ef = ek > 0 ? ef.slice(0, ek) : '';
            }
        }
        return set;
    }
    function _folderBaseName(folder) {
        var n = _normF(folder);
        return n.indexOf('/') >= 0 ? n.slice(n.lastIndexOf('/') + 1) : n;
    }

    // 文件夹移动：dst = targetFolder + '/' + 源文件夹末段（与面板拖拽移动同一语义）。
    // 目标父文件夹须已存在（根除外）；同名目标拒绝（refs/项目库 store 抛错，预设库跨父
    // 分支会走 _1 改名合并，工具层统一拦截）；不隐式创建父链。
    function _assetMoveFolder(lib, store, args) {
        var hasFolders = args.folders !== undefined && args.folders !== null;
        var hasFolder = args.folder !== undefined && args.folder !== null && String(args.folder) !== '';
        if (hasFolder && typeof args.folder !== 'string') {
            return Promise.resolve(_err('moveFolder 的 folder 必须是字符串（收到 ' + (typeof args.folder) + '）'));
        }
        if (args.targetFolder !== undefined && args.targetFolder !== null && typeof args.targetFolder !== 'string') {
            return Promise.resolve(_err('moveFolder 的 targetFolder 必须是字符串（收到 ' + (typeof args.targetFolder) + '）'));
        }
        if (hasFolders && hasFolder) {
            return Promise.resolve(_err('moveFolder 的 folder 与 folders 二选一（单个用 folder，批量用 folders）'));
        }
        if (!hasFolders && !hasFolder) {
            return Promise.resolve(_err('moveFolder 必填 folder（源文件夹）或 folders（源文件夹列表）'));
        }
        var srcs = [];
        var seen = Object.create(null);
        if (hasFolders) {
            var raw = Array.isArray(args.folders) ? args.folders : [args.folders];
            for (var i = 0; i < raw.length; i++) {
                if (typeof raw[i] !== 'string' || _normF(raw[i]) === '') {
                    return Promise.resolve(_err('folders 必须是字符串数组（第 ' + (i + 1) + ' 项为空或非字符串；根路径不可移动）'));
                }
                var s = _normF(raw[i]);
                if (seen[s]) continue;
                seen[s] = true;
                srcs.push(s);
            }
            if (!srcs.length) return Promise.resolve(_err('moveFolder 的 folders 不能为空数组'));
            if (srcs.length > _maxIds()) {
                return Promise.resolve(_err('folders 超过单次上限 ' + _maxIds() + '（本次 ' + srcs.length + ' 个），请分批'));
            }
        } else {
            srcs.push(_normF(args.folder));
        }
        for (var j = 0; j < srcs.length; j++) {
            if (!srcs[j]) return Promise.resolve(_err('moveFolder 不支持根路径（folder 不能为空或 "/"）'));
            var fBad = _checkFolderPath(srcs[j]); if (fBad) return Promise.resolve(_err(fBad));
            var fRes = _reservedFolderGuard(srcs[j]); if (fRes) return Promise.resolve(_err(fRes));
        }
        var tf = _normF(args.targetFolder || '');
        var tBad = _checkFolderPath(tf); if (tBad) return Promise.resolve(_err(tBad));
        var tRes = _reservedFolderGuard(tf); if (tRes) return Promise.resolve(_err(tRes));

        var folderSet = _folderSet(store);
        if (tf && !folderSet[tf]) {
            return Promise.resolve(_err('目标文件夹不存在: ' + tf
                + '（请先 mode=createFolder 创建目标父文件夹，或省略 targetFolder 移到根目录）'));
        }

        // 单个：逐项给出明确原因（不需要"跳过"清单）
        if (!hasFolders) {
            var src1 = srcs[0];
            var dst1 = tf ? (tf + '/' + _folderBaseName(src1)) : _folderBaseName(src1);
            if (!folderSet[src1]) return Promise.resolve(_err('文件夹不存在: ' + src1));
            if (src1 === dst1) return Promise.resolve(_ok('文件夹 ' + src1 + ' 已在目标位置（未做改动）'));
            if (dst1.indexOf(src1 + '/') === 0) {
                return Promise.resolve(_err('不能把文件夹移动到自身或其子层: ' + src1 + ' → ' + dst1));
            }
            if (folderSet[dst1]) {
                return Promise.resolve(_err('目标位置已有同名文件夹: ' + dst1 + '（不会合并；如需合并请先移动其下条目）'));
            }
            return Promise.resolve(store.renameFolder(src1, dst1)).then(function () {
                // 预设库纯空目录跨父移动在 removeDirRecursive 被取消时 store 回滚后不抛错，
                // 按目标文件夹是否真实存在复核，避免把未发生的移动报成成功
                if (!_folderSet(store)[dst1]) {
                    return _err('移动未完成（可能被取消或已回滚）: ' + src1 + ' → ' + dst1
                        + '；请 mode=listFolders 复核');
                }
                return _ok('已移动文件夹 ' + src1 + ' → ' + dst1 + '（父链: ' + _chain(dst1) + '）'
                    + '· 该文件夹（含子层）共 ' + _folderCount(store.list(), dst1) + ' 条');
            }).catch(_asyncErr);
        }

        // 批量：两段规划——先处理非嵌套源并占用目标位，再判嵌套源（仅当上级真的在移动
        // 集合里才随上级跳过，否则按自身目标独立评估）；不可移动项进 skipped 不中断其余
        var jobs = [], skipped = [], taken = Object.create(null);
        var pendingNested = [];
        function _planFolderMove(src) {
            var dst = tf ? (tf + '/' + _folderBaseName(src)) : _folderBaseName(src);
            if (!folderSet[src]) return { skip: '文件夹不存在' };
            if (src === dst) return { skip: '已在目标位置' };
            if (dst.indexOf(src + '/') === 0) return { skip: '目标在自身或其子层内' };
            if (taken[dst]) return { skip: '目标与同批另一源同名: ' + dst };
            if (folderSet[dst]) return { skip: '目标位置已有同名文件夹: ' + dst };
            return { dst: dst };
        }
        for (var k = 0; k < srcs.length; k++) {
            var src = srcs[k];
            var nestedIn = '';
            for (var n2 = 0; n2 < srcs.length; n2++) {
                if (srcs[n2] !== src && src.indexOf(srcs[n2] + '/') === 0) { nestedIn = srcs[n2]; break; }
            }
            if (nestedIn) { pendingNested.push({ src: src, ancestor: nestedIn }); continue; }
            var plan = _planFolderMove(src);
            if (plan.skip) { skipped.push({ src: src, reason: plan.skip }); continue; }
            taken[plan.dst] = true;
            jobs.push({ src: src, dst: plan.dst });
        }
        for (var pn = 0; pn < pendingNested.length; pn++) {
            var pSrc = pendingNested[pn].src, pAnc = pendingNested[pn].ancestor;
            var ancMoved = false;
            for (var jm = 0; jm < jobs.length; jm++) { if (jobs[jm].src === pAnc) { ancMoved = true; break; } }
            if (ancMoved) { skipped.push({ src: pSrc, reason: '已随上级文件夹 ' + pAnc + ' 一起移动' }); continue; }
            var pPlan = _planFolderMove(pSrc);
            if (pPlan.skip) { skipped.push({ src: pSrc, reason: pPlan.skip }); continue; }
            taken[pPlan.dst] = true;
            jobs.push({ src: pSrc, dst: pPlan.dst });
        }
        if (!jobs.length) {
            var head0 = '没有可移动的文件夹（目标: ' + (tf ? tf : '根目录') + '）：';
            return Promise.resolve(_ok(head0 + '\n' + _fmtMoveSkipped(skipped)));
        }
        if (typeof store.renameFoldersBatch !== 'function') {
            return Promise.resolve(_err('该素材库未实现 renameFoldersBatch，无法批量移动文件夹'));
        }
        var failures = [];
        for (var m = 0; m < jobs.length; m++) {
            jobs[m].onError = (function (j) {
                return function (err) {
                    failures.push({ src: j.src, error: (err && err.message) ? err.message : String(err) });
                };
            })(jobs[m]);
        }
        return Promise.resolve(store.renameFoldersBatch(jobs)).then(function (r) {
            var done = (r && typeof r.done === 'number') ? r.done : (jobs.length - failures.length);
            var list = store.list();
            var lines = ['已移动 ' + done + ' 个文件夹 → ' + (tf ? tf : '根目录'),
                '父链: ' + _chain(tf)];
            for (var x = 0; x < jobs.length; x++) {
                var jb = jobs[x];
                var failed = false;
                for (var f = 0; f < failures.length; f++) { if (failures[f].src === jb.src) { failed = true; break; } }
                if (failed) continue;
                lines.push('- ' + jb.src + ' → ' + jb.dst + ' · 含子层 ' + _folderCount(list, jb.dst) + ' 条');
            }
            if (skipped.length) lines.push('跳过 ' + skipped.length + ' 个：');
            var skipText = _fmtMoveSkipped(skipped);
            if (skipText) lines.push(skipText);
            if (failures.length) {
                lines.push('失败 ' + failures.length + ' 个：');
                for (var q = 0; q < failures.length; q++) {
                    lines.push('- ' + failures[q].src + '：' + failures[q].error);
                }
            }
            return _ok(lines.join('\n'));
        }).catch(function (e) {
            return _err('批量移动文件夹未完成: ' + ((e && e.message) ? e.message : String(e))
                + '\n部分文件夹可能已移动，请 mode=listFolders 复核后再重试未移动项');
        });
    }

    // moveFolder 跳过清单（三项都为空时返回空串）
    function _fmtMoveSkipped(skipped) {
        if (!skipped || !skipped.length) return '';
        var out = [];
        for (var i = 0; i < skipped.length; i++) out.push('- ' + skipped[i].src + '：' + skipped[i].reason);
        return out.join('\n');
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
        if (!normFolder) return Promise.resolve(_err('removeFolder 不能为根路径（根目录不可删除）'));
        return Promise.resolve(store.listEmptyFolders()).then(function (empty) {
            var found = false;
            if (Array.isArray(empty)) {
                for (var i = 0; i < empty.length; i++) {
                    if (empty[i] === normFolder) { found = true; break; }
                }
            }
            if (!found) {
                // 区分「非空」与「不存在/已无引用」：虚拟库的文件夹只由条目 folder 前缀
                // 体现，最后一条内容移出后它从树中消失，此时没有可删对象。
                var cnt = _folderCount(store.list(), normFolder);
                if (cnt > 0) {
                    return _err('文件夹非空（含子层 ' + cnt + ' 条条目），不能删除；请先移动或归档其下条目: ' + folder);
                }
                return _err('文件夹不存在或已无条目引用（无需删除）: ' + folder
                    + '；虚拟库中文件夹随最后一条内容移出即从树中消失，实体库请核对磁盘目录');
            }
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
