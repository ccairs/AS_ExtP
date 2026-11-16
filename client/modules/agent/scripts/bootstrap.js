/**
 * agent/scripts/bootstrap.js - script_manager LLM 工具装配
 *
 * 单一粗粒度工具 + mode 参数，覆盖 Agent 脚本列表的全部管理操作：
 *   读 mode（不弹）：list / get / search / listFolders / readContent
 *   写 mode（balanced 弹）：create / write / rename / move / createFolder / renameFolder / removeFolder / cleanNonScript
 *   删除 mode（FORCE 强制弹，任何权限模式都弹）：delete
 *
 * 设计参考：modules/assets/bootstrap.js（asset_library 单工具：library + mode）
 * 安全门禁：复用 agent/scripts/scriptSecurity.js 的共享函数
 *
 * 共同约束：
 *   - 所有路径操作必须通过 _ensurePathInScriptsNamespace 校验（防 LLM 越界到脚本目录外）
 *   - removeFolder 仅当文件夹为空时删除（强制 keepItems=true，handler 内校验）
 *   - delete 是不可逆操作，权限策略返回 'FORCE'（参 permissions.js _scriptManagerNeedsConfirm）
 *   - cleanNonScript 仅清理 agent/scripts 基准下的非 .jsx/.jsxbin 文件
 */
(function (global) {
    'use strict';

    global.AEScriptManager = global.AEScriptManager || {};

    var TOOL_NAME = 'script_manager';

    // ── 权限策略共用的 mode 分类（与 permissions.js 的 _scriptManagerNeedsConfirm 保持一致）──
    var READ_MODES = {
        list: true, get: true, search: true, listFolders: true, readContent: true
    };

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

    // 审查警告（valid=true 的轻微问题）取文案：与 submit_script 的成功回执同款
    // （engine/controller/scriptTools.js 的「风险提示: …」），保证同一条审查在两处口径一致
    function _reviewWarningTexts(warnings) {
        return (Array.isArray(warnings) ? warnings : [])
            .map(function (w) { return (w && (w.message || w.code)) ? String(w.message || w.code) : ''; })
            .filter(function (t) { return !!t; });
    }

    // 写盘前校验（与 submit_script 同款：静态 + LLM 审查）。fail-closed：校验服务未就绪即拒绝写入。
    // 复用 engine 装配的 scriptValidator（global.AEEngine.scriptValidator），无 context 时传空上下文，
    // 模型审查仍可基于脚本内容判定危险（危险操作/沙箱逃逸/混淆绕过）。
    // 通过时一并回传 warnings——审查 prompt 明确要求轻微问题走 valid=true+warnings，
    // 不回传就是整段丢弃（写盘这条路径没有用户确认步骤，结果回执是唯一通路）。
    async function _validateScriptContent(content) {
        var v = global.AEEngine && global.AEEngine.scriptValidator;
        if (!v || typeof v.validate !== 'function') {
            return { ok: false, error: '脚本校验服务未就绪，拒绝写入以防安全风险' };
        }
        try {
            var res = await v.validate(String(content == null ? '' : content), {
                userMessage: '',
                contextMessages: [],
                signal: null
            });
            if (res && res.valid) return { ok: true, warnings: _reviewWarningTexts(res.warnings) };
            var lines = ((res && res.errors) || []).map(function (e) { return '- ' + (e.message || e.code || ''); });
            return { ok: false, error: '脚本校验未通过，已拒绝写入：\n' + lines.join('\n') };
        } catch (e) {
            return { ok: false, error: '脚本校验执行异常: ' + (e && e.message ? e.message : String(e)) };
        }
    }

    // ── 脚本目录解析 + 危险检测（统一入口）──
    function _resolveScriptDir() {
        var sec = global.AEScriptSecurity;
        if (!sec) return { ok: false, error: 'AEScriptSecurity 未就绪' };
        var dir = sec.getDefaultScriptDir();
        if (!dir) return { ok: false, error: '无法确定脚本目录（数据目录未就绪）' };
        if (sec.isDangerousScriptDir(dir)) {
            return { ok: false, error: '脚本目录位于危险位置: ' + dir };
        }
        var normalized = sec.normalizeScriptDir(dir);
        return { ok: true, dir: normalized };
    }

    // 基准/路径归一——反斜杠转正斜杠、压缩中间连续分隔符、去尾斜杠、
    // 小写。旧构造链缺「压缩中间连续分隔符」一步（_inAgentScriptsBase 的 fwd 有）：
    // 数据目录含 \\ 时 baseNorm 带 //，与 fwd 的压缩形态永不相等 → script_manager
    // 全部 mode 报「不在基准下」（fail-closed 瘫痪）。
    function _normBase(p) {
        return String(p).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '').toLowerCase();
    }

    // ── 路径归属验证：必须落在 agent/scripts 基准下 ──
    // 防止 LLM 传入系统路径或其他工程的脚本路径
    function _inAgentScriptsBase(p, baseNorm) {
        if (!p || !baseNorm) return false;
        var fwd = String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
        // 拒 .. 和 . 段
        if (fwd.indexOf('/../') !== -1) return false;
        if (fwd.indexOf('/./') !== -1) return false;
        var len = fwd.length;
        if (len >= 3 && fwd.lastIndexOf('/..') === len - 3) return false;
        if (len >= 2 && fwd.lastIndexOf('/.') === len - 2) return false;
        // 必须在 base 下（含自身，但 base 本身由调用方单独拦截）
        return fwd.indexOf(baseNorm + '/') === 0 || fwd === baseNorm;
    }

    // 校验路径必须在脚本目录内（防 LLM 越界）
    function _ensurePathInScriptsNamespace(path, baseDir) {
        var sec = global.AEScriptSecurity;
        if (!sec) return { ok: false, error: 'AEScriptSecurity 未就绪' };
        if (!path) return { ok: false, error: '缺少 path 参数' };
        if (!sec._checkPathSafe(path)) return { ok: false, error: '路径不合法: ' + path };
        if (!sec.inScriptsNamespace(path)) return { ok: false, error: '路径不在脚本命名空间内: ' + path };
        // 双重校验：必须落在 agent/scripts 基准下（防 symlink 逃逸）
        // baseNorm 经 _normBase 压缩中间连续分隔符
        var baseNorm = _normBase(baseDir);
        if (!_inAgentScriptsBase(path, baseNorm)) {
            return { ok: false, error: '路径不在 agent/scripts 基准下: ' + path };
        }
        return { ok: true };
    }

    // 删除/清理目标的 realpath 逃逸复核（fail-closed）。_inAgentScriptsBase 只做
    // 字符串前缀判定，树内 junction 指向用户目录时字符串仍在基准下、真实路径已在基准外——
    // 删除/清理会穿透删掉非脚本文件。面板侧无 Node fs（CEP 10 Chrome 88 无 require/
    // cep_node，与注释同因）无法直接 fs.realpathSync，realpath 复核经 Bridge 读
    // 端点探测实现：scripts 命名空间的读请求在 bridge 侧对「realpath 逃出 SAFE_NAMESPACES
    // 白名单」的 junction/symlink 回 403（bridge-server _scriptsReadRealpathBlocked，与本条
    // 同一判据）。AEFS.existsSync 对 4xx 真拒绝不回退 cep.fs（返回 false 且
    // Bridge.getLastSyncRejection 留有 4xx 记录），据此区分「真不存在」（无记录，照常删）
    // 与「逃逸拒绝」（有记录，整链拒绝——含 AEFS.deleteFileSync 对 cep.fs 回退的堵截）。
    // Bridge 不可用（isAvailable false）时无 realpath 通道，跳过复核不阻断正常删除
    // （bridge 不可用窗口的逃逸为既有架构残留，见审计记录）。仅用于删除/清理路径，
    // 读路径不加（性能约束）。
    function _deleteTargetEscapes(path) {
        var AEFS = global.AEFS;
        if (!AEFS) return false;
        if (!global.Bridge || typeof global.Bridge.isAvailable !== 'function'
            || !global.Bridge.isAvailable()) return false;
        // 探测前清空拒绝记录保证新鲜性——existsSync 可能在到达 Bridge 前
        // 短路（路径校验拒绝/敏感路径），残留的上一次调用 4xx 记录会被误读为当前
        // 路径的逃逸证据（误拒删除/误剔除待清理项）。无 clearSyncRejection 的旧
        // mock 保持旧行为
        if (typeof global.Bridge.clearSyncRejection === 'function') global.Bridge.clearSyncRejection();
        if (AEFS.existsSync(path)) return false;
        var rej = (typeof global.Bridge.getLastSyncRejection === 'function')
            ? global.Bridge.getLastSyncRejection() : null;
        // exists 的 4xx 真拒绝（403 symlink 逃逸/敏感路径）＝目标经链接指向脚本目录外
        return !!(rej && rej.method === 'exists' && rej.status >= 400 && rej.status < 500);
    }

    // ── 节点摘要行 ──
    function _summarizeNode(n) {
        if (n.type === 'folder') {
            return '- 📁 ' + n.name + '  (depth=' + n.depth + ')';
        }
        return '- 📄 ' + n.name + '  (depth=' + n.depth + ')';
    }

    function _formatList(nodes, folderFilter, baseDir) {
        if (!nodes || !nodes.length) return '（空）';
        var list = nodes;
        if (folderFilter) {
            var norm = String(folderFilter).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').toLowerCase();
            var baseNorm = String(baseDir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            list = nodes.filter(function (n) {
                var f = String(n.path).replace(/\\/g, '/').toLowerCase();
                // 相对路径：去掉 baseDir 前缀后比较
                if (f.indexOf(baseNorm + '/') === 0) f = f.slice(baseNorm.length + 1);
                if (f === norm) return true;
                return norm.length > 0 && f.indexOf(norm + '/') === 0;
            });
        }
        if (!list.length) return '（无匹配条目）';
        var lines = ['共 ' + list.length + ' 项：'];
        for (var i = 0; i < list.length; i++) lines.push(_summarizeNode(list[i]));
        return lines.join('\n');
    }

    function _formatGet(nodes, path) {
        if (!path) return '错误：缺少 path';
        // 去尾斜杠 + 规范化分隔符后再比较（LLM 可能传带尾斜杠的路径）
        var tNorm = String(path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            var pNorm = String(n.path).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            if (pNorm === tNorm) {
                var lines = ['--- ' + n.name + ' ---'];
                Object.keys(n).forEach(function (k) {
                    lines.push(k + ': ' + JSON.stringify(n[k]));
                });
                return lines.join('\n');
            }
        }
        return '未找到 path=' + path;
    }

    function _formatSearch(nodes, query) {
        if (!query) return '错误：缺少 query';
        var q = String(query).toLowerCase();
        var matched = [];
        for (var i = 0; i < nodes.length; i++) {
            var name = String(nodes[i].name || '').toLowerCase();
            if (name.indexOf(q) >= 0) matched.push(nodes[i]);
        }
        if (!matched.length) return '未匹配到关键词: ' + query;
        var lines = ['匹配 ' + matched.length + ' 项：'];
        for (var j = 0; j < matched.length; j++) lines.push(_summarizeNode(matched[j]));
        return lines.join('\n');
    }

    function _formatFolderList(nodes) {
        var set = {};
        for (var i = 0; i < nodes.length; i++) {
            if (nodes[i].type !== 'folder') continue;
            var f = String(nodes[i].path).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
            set[f] = true;
        }
        var folders = Object.keys(set).sort();
        if (!folders.length) return '（无文件夹）';
        return '共 ' + folders.length + ' 个文件夹：\n' + folders.map(function (f) { return '- ' + f; }).join('\n');
    }

    // ── 自动去重：name → name_2 → name_3 ... ──
    function _dedupePath(parentDir, baseName, ext) {
        var AEFS = global.AEFS;
        var scriptName = baseName + ext;
        var fullPath = parentDir.replace(/[\\\/]+$/, '') + '/' + scriptName;
        var n = 1;
        var current = baseName;
        while (AEFS.existsSync(fullPath)) {
            n++;
            current = baseName + '_' + n;
            scriptName = current + ext;
            fullPath = parentDir.replace(/[\\\/]+$/, '') + '/' + scriptName;
        }
        return { path: fullPath, name: scriptName, renamed: n > 1 };
    }

    // ════════════════════════════════════════════════════════
    //  主 handler
    // ════════════════════════════════════════════════════════
    function _handleScriptManager(args, hostApi, execCtx) {
        args = args || {};
        var mode = args.mode;
        // script_manager 以 scope: moduleIds:['script', 'external-mcp'] 限定，仅 Script 模式
        // 与外接可见/可调（Agent/Shader 模式经 toolExecutor scope 校验被拒）。category: 'scripts'
        // 仅是
        // 分组元数据，供 tool_search 按分组检索，不参与权限/可见性判定。
        // 写操作（create/write 等）不再按模式拦截：写盘前经 _validateScriptContent 的 **LLM 审查**
        //（并走 permissions.js _scriptManagerNeedsConfirm 的 balanced/FORCE 弹窗确认）。
        // 这里**没有**静态门——`validator.validate` 是纯 LLM 层
        //（validator.js:1-8），门只在运行/提交路径上（llm-preview / user-library）。
        // **外接通道跳过该 LLM 审查**：判据是 toolExecutor 传入的 callerId 前缀 'ext:'
        //（同款判据见 scriptTools.js 的 submit_script）；理由同 executeExtendScript——外接客户端
        // 自带模型、面板不必配 LLM，接了会把外接卡在面板配置上。路径/危险目录/名称校验不受影响。
        var _isExtCall = !!(execCtx && typeof execCtx.callerId === 'string'
            && execCtx.callerId.indexOf('ext:') === 0);
        try {
            // 解析脚本目录（读 mode 中的 list/listFolders 不需要 path 校验，但也需要目录）
            var dirInfo = _resolveScriptDir();
            if (!dirInfo.ok) return _err(dirInfo.error);
            var baseDir = dirInfo.dir;

            switch (mode) {
                // ── 读 mode ──
                case 'list': return _listTree(baseDir, args.folder);
                case 'get': return _getNode(baseDir, args.path);
                case 'search': return _searchTree(baseDir, args.query);
                case 'listFolders': return _listFoldersOnly(baseDir);
                case 'readContent': return _readContent(baseDir, args.path);

                // ── 写 mode（create/write 写盘前必须通过脚本校验，防把危险脚本直接落入脚本库）──
                case 'create': return _createScriptValidated(baseDir, args, _isExtCall);
                case 'write': return _writeScriptValidated(baseDir, args, _isExtCall);
                case 'rename': return _renameNode(baseDir, args);
                case 'move': return _moveNode(baseDir, args);
                case 'createFolder': return _createFolder(baseDir, args);
                case 'renameFolder': return _renameFolder(baseDir, args);
                case 'removeFolder': return _removeFolderSafe(baseDir, args.folder);
                case 'cleanNonScript': return _cleanNonScript(baseDir);

                // ── 删除 mode（FORCE 弹窗由 permissions.js 处理）──
                case 'delete': return _deleteNode(baseDir, args.path);

                default: return _err('未知 mode: ' + mode);
            }
        } catch (e) {
            return _asyncErr(e);
        }
    }

    // create：先校验（提供 content 时）再写盘
    async function _createScriptValidated(baseDir, args, isExtCall) {
        // 廉价参数校验先行：缺 name 不必先跑昂贵的 LLM 审查
        if (!args.name) return _err('create 必填 name');
        var warnings = [];
        if (args.content != null) {
            if (isExtCall) {
                // 外接通道跳过面板 LLM 审查（路径/名称/危险目录校验仍生效）
                console.warn('[script_manager] 外接通道：跳过面板 LLM 审查（create）');
            } else {
                var v = await _validateScriptContent(args.content);
                if (!v.ok) return _err(v.error);
                warnings = v.warnings || [];
            }
        }
        return _withReviewWarnings(_createScript(baseDir, args), warnings);
    }

    // write：必须先通过校验再覆盖写盘
    async function _writeScriptValidated(baseDir, args, isExtCall) {
        // 廉价参数校验先行：缺 path/content 直接拒绝——否则缺 content 会被校验器
        // 误报「脚本校验未通过：脚本为空」，缺 path 会白跑一轮 LLM 审查才报参数错误
        if (!args.path) return _err('write 必填 path');
        if (args.content == null) return _err('write 必填 content');
        var warnings = [];
        if (isExtCall) {
            // 外接通道跳过面板 LLM 审查（路径/危险目录校验仍生效）
            console.warn('[script_manager] 外接通道：跳过面板 LLM 审查（write）');
        } else {
            var v = await _validateScriptContent(args.content);
            if (!v.ok) return _err(v.error);
            warnings = v.warnings || [];
        }
        return _withReviewWarnings(_writeScript(baseDir, args), warnings);
    }

    // 成功回执附审查风险提示（口径同 submit_script 的「风险提示: …」——LLM 据此在
    // 下一次写入时改进；无警告时原样返回回执）
    function _withReviewWarnings(res, warnings) {
        if (!warnings || !warnings.length || !res || !Array.isArray(res.content)) return res;
        var suffix = ' 风险提示: ' + warnings.join('; ');
        for (var i = 0; i < res.content.length; i++) {
            var c = res.content[i];
            if (c && c.type === 'text' && typeof c.text === 'string') c.text += suffix;
        }
        return res;
    }

    // 递归深度上限（对齐 _scanTreeSync 的 maxDepth=20）——
    // _copyRecursive/_deleteRecursive/_cleanNonScript.scan 无深度限制，junction 环
    // （自引用链接）下无限递归栈溢出。depth 缺省 undefined 按 0 计，
    // 既有调用点零改动。另注：报告修复方向中的「已访问 realpath 去重」
    // 依赖 realpath 通道（AEFS 未暴露，bridge 也未提供查询端点），字符串去重对
    // 自引用环无效（路径字符串逐层不同），深度截断已足以防溢出。
    var MAX_TREE_DEPTH = 20;

    // ── 同步扫描：构建扁平节点列表（type/name/path/depth）──
    // AEFS.listFilesSync / listDirsSync 是同步的，递归也同步——所有调用栈内立即完成
    function _scanTreeSync(dirPath, maxDepth) {
        var AEFS = global.AEFS;
        if (!AEFS) return [];
        var result = [];
        function walk(dir, depth) {
            if (depth > maxDepth) return;
            var files = AEFS.listFilesSync(dir) || [];
            var dirs = AEFS.listDirsSync(dir) || [];
            var visibleDirs = [];
            for (var i = 0; i < dirs.length; i++) {
                if (dirs[i] !== '__order__') visibleDirs.push(dirs[i]);
            }
            visibleDirs.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
            for (var di = 0; di < visibleDirs.length; di++) {
                var dirPath = dir.replace(/[\\\/]+$/, '') + '/' + visibleDirs[di];
                result.push({ type: 'folder', name: visibleDirs[di], path: dirPath, depth: depth });
                walk(dirPath, depth + 1);
            }
            var scripts = [];
            for (var si = 0; si < files.length; si++) {
                var lower = files[si].toLowerCase();
                if (lower.indexOf('.jsx') === lower.length - 4 || lower.indexOf('.jsxbin') === lower.length - 7) {
                    scripts.push(files[si]);
                }
            }
            scripts.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
            for (var sj = 0; sj < scripts.length; sj++) {
                result.push({
                    type: 'script',
                    name: scripts[sj],
                    path: dir.replace(/[\\\/]+$/, '') + '/' + scripts[sj],
                    depth: depth
                });
            }
        }
        walk(dirPath, 0);
        return result;
    }

    // ── list：扫描整个脚本树 ──
    function _listTree(baseDir, folderFilter) {
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        var nodes = _scanTreeSync(baseDir, 20);
        return _ok(_formatList(nodes, folderFilter, baseDir));
    }

    function _getNode(baseDir, path) {
        if (!path) return _err('get 必填 path');
        var check = _ensurePathInScriptsNamespace(path, baseDir);
        if (!check.ok) return _err(check.error);
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        var nodes = _scanTreeSync(baseDir, 20);
        return _ok(_formatGet(nodes, path));
    }

    function _searchTree(baseDir, query) {
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        var nodes = _scanTreeSync(baseDir, 20);
        return _ok(_formatSearch(nodes, query));
    }

    function _listFoldersOnly(baseDir) {
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        var nodes = _scanTreeSync(baseDir, 20);
        return _ok(_formatFolderList(nodes));
    }

    function _readContent(baseDir, path) {
        if (!path) return _err('readContent 必填 path');
        var check = _ensurePathInScriptsNamespace(path, baseDir);
        if (!check.ok) return _err(check.error);
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        // 仅允许读 .jsx/.jsxbin 文件
        var lower = String(path).toLowerCase();
        if (lower.indexOf('.jsx') !== lower.length - 4 && lower.indexOf('.jsxbin') !== lower.length - 7) {
            return _err('仅支持读取 .jsx/.jsxbin 文件');
        }
        try {
            var content = AEFS.readFileSync(path);
            if (!content) return _err('读取失败或文件为空');
            return _ok(content);
        } catch (e) {
            return _err('读取异常: ' + (e && e.message ? e.message : String(e)));
        }
    }

    // ── create：新建脚本（初始内容可选）──
    function _createScript(baseDir, args) {
        if (!args.name) return _err('create 必填 name');
        var sec = global.AEScriptSecurity;
        var AEFS = global.AEFS;
        if (!sec || !AEFS) return _err('依赖未就绪');

        // 解析父目录（: folder 段逐段 validateName，对齐 _createFolder——
        // 尾随点/空格段被 Win32 静默剥离会产生幻影路径（返回的 path 与实际落盘
        // 目录不一致）；分隔符归一 / 与 \\ 均可并压缩连续段）
        var parentDir = baseDir;
        if (args.folder) {
            var folderSegs = String(args.folder).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').split('/');
            for (var fi = 0; fi < folderSegs.length; fi++) {
                if (!sec.validateName(folderSegs[fi])) return _err('父文件夹名包含非法字符: ' + folderSegs[fi]);
            }
            parentDir = sec.normalizeScriptDir(baseDir).replace(/[\\\/]+$/, '') + '/' + folderSegs.join('\\');
        }
        // 校验父目录在脚本命名空间内
        var parentCheck = _ensurePathInScriptsNamespace(parentDir, baseDir);
        if (!parentCheck.ok) return _err('父目录不合法: ' + parentCheck.error);

        var stripped = String(args.name).replace(/\.(jsx|jsxbin)$/i, '');
        if (!sec.validateName(stripped)) return _err('脚本名称包含非法字符');
        var dedup = _dedupePath(parentDir, stripped, '.jsx');

        // 确保父目录存在
        AEFS.mkdirSync(parentDir);
        var initialContent = args.content != null ? String(args.content) : '// ' + dedup.name + '\n';
        if (AEFS.writeFileSync(dedup.path, initialContent)) {
            var msg = '已创建脚本: ' + dedup.name;
            if (dedup.renamed) msg += '（' + stripped + ' 已存在，已自动重命名）';
            msg += '  path=' + dedup.path;
            return _ok(msg);
        }
        return _err('创建失败 — ' + (AEFS.lastError() || '未知错误'));
    }

    // ── write：覆盖写入脚本内容 ──
    function _writeScript(baseDir, args) {
        if (!args.path) return _err('write 必填 path');
        if (args.content == null) return _err('write 必填 content');
        var check = _ensurePathInScriptsNamespace(args.path, baseDir);
        if (!check.ok) return _err(check.error);
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        // 仅允许写 .jsx/.jsxbin
        var lower = String(args.path).toLowerCase();
        if (lower.indexOf('.jsx') !== lower.length - 4 && lower.indexOf('.jsxbin') !== lower.length - 7) {
            return _err('仅支持写入 .jsx/.jsxbin 文件');
        }
        if (AEFS.writeFileSync(args.path, String(args.content))) {
            return _ok('已写入: ' + args.path);
        }
        return _err('写入失败 — ' + (AEFS.lastError() || '未知错误'));
    }

    // ── rename：重命名文件或文件夹 ──
    function _renameNode(baseDir, args) {
        if (!args.path) return _err('rename 必填 path');
        if (!args.newName) return _err('rename 必填 newName');
        var check = _ensurePathInScriptsNamespace(args.path, baseDir);
        if (!check.ok) return _err(check.error);
        // 拒绝重命名脚本根目录——_inAgentScriptsBase 有意放行
        // path===base（base 由调用方单独拦截），_deleteNode/_removeFolderSafe
        // 均有根拦截而 rename 漏了：auto 权限下 LLM 传 path=<脚本根>
        // newName=xxx 即把整个脚本库根目录改名（脚本树变空、全部脚本工具失效）
        if (_normBase(args.path) === _normBase(baseDir)) return _err('拒绝重命名脚本根目录');
        var sec = global.AEScriptSecurity;
        var AEFS = global.AEFS;
        if (!sec || !AEFS) return _err('依赖未就绪');

        // 文件/文件夹判定优先问文件系统（对齐 _copyRecursive 修复）——
        // 纯扩展名嗅探把 *.jsx 命名的目录误走文件分支（newName 被强制追加扩展名，
        // renameFileSync 对目录行为不确定）；isFileSync 不可用时退回嗅探（旧行为）
        var isFile = AEFS.isFileSync
            ? AEFS.isFileSync(args.path)
            : String(args.path).toLowerCase().match(/\.(jsx|jsxbin)$/i);
        var newName;
        if (isFile) {
            // 脚本文件：保留原扩展名（.jsx/.jsxbin）
            var origExt = String(args.path).toLowerCase().match(/\.(jsxbin)$/i) ? '.jsxbin' : '.jsx';
            var stripped = String(args.newName).replace(/\.(jsx|jsxbin)$/i, '');
            if (!sec.validateName(stripped)) return _err('新名称包含非法字符');
            newName = stripped + origExt;
        } else {
            // 文件夹：直接用 newName
            if (!sec.validateName(args.newName)) return _err('新名称包含非法字符');
            newName = args.newName;
        }

        // 先剥尾随斜杠再取父目录：带尾斜杠的路径（e:/x/folder/）在
        // /\/[^\/]+$/ 下匹配不到末段，parentDir 会残留尾斜杠产出双斜杠目标路径
        var srcPathNorm = String(args.path).replace(/[\\\/]/g, '/').replace(/\/+$/, '');
        var parentDir = srcPathNorm.replace(/\/[^\/]+$/, '');
        var dstPath = parentDir + '/' + newName;
        // 完全相同（含大小写）才视为未变化：仅大小写不同的更名在 Windows
        // 合法，比较保留原大小写，不得静默吞掉
        if (srcPathNorm === dstPath) {
            return _ok('名称未变化（大小写敏感后已相同）');
        }
        // existsSync 在 Windows 大小写不敏感 FS 上对「源自身的大小写变体」也返回
        // true——与源仅大小写不同的目标放行执行，否则合法的大小写更名永远报已存在
        if (AEFS.existsSync(dstPath) && dstPath.toLowerCase() !== srcPathNorm.toLowerCase()) {
            return _err('「' + newName + '」已存在');
        }
        if (AEFS.renameFileSync(srcPathNorm, dstPath)) {
            return _ok('已重命名: ' + newName + '  path=' + dstPath);
        }
        return _err('重命名失败 — ' + (AEFS.lastError() || '未知错误'));
    }

    // ── move：移动文件或文件夹 ──
    function _moveNode(baseDir, args) {
        if (!args.path) return _err('move 必填 path');
        if (!args.folder) return _err('move 必填 folder（目标文件夹）');
        var srcCheck = _ensurePathInScriptsNamespace(args.path, baseDir);
        if (!srcCheck.ok) return _err(srcCheck.error);

        var sec = global.AEScriptSecurity;
        var AEFS = global.AEFS;
        if (!sec || !AEFS) return _err('依赖未就绪');

        // 目标文件夹路径（相对 folder 解析为绝对）
        // folder 段逐段 validateName（对齐 _createScript）——
        // 尾点/尾空格段被 Win32 静默剥离产生幻影路径（回报的 path 与实际落盘目录
        // 不一致，后续 rename/delete 按回报路径找不到目标）；含非法字符则错误
        // 信息无参数校验上下文
        var folderSegs = String(args.folder).replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '').split('/');
        for (var fi = 0; fi < folderSegs.length; fi++) {
            if (!folderSegs[fi] || !sec.validateName(folderSegs[fi])) return _err('目标文件夹名包含非法字符: ' + folderSegs[fi]);
        }
        var targetDir = String(baseDir).replace(/[\\\/]+$/, '') + '\\' + String(args.folder).replace(/^\/+|\/+$/g, '').replace(/\//g, '\\');
        var targetCheck = _ensurePathInScriptsNamespace(targetDir, baseDir);
        if (!targetCheck.ok) return _err('目标目录不合法: ' + targetCheck.error);

        // 防止把文件夹移动到自身或子目录内（: norm 经 _normBase 压缩中间分隔符）
        var srcNorm = _normBase(args.path);
        var tgtNorm = _normBase(targetDir);
        if (tgtNorm === srcNorm || (tgtNorm + '/').indexOf(srcNorm + '/') === 0) {
            return _err('不能将文件夹移动到自身或子目录内');
        }

        // baseName 从原始路径提取保留大小写——旧代码取自 toLowerCase
        // 后的 srcNorm，move 后脚本名被静默小写化（树显示与引用不一致）
        var baseName = String(args.path).replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop();
        var dstPath = String(targetDir).replace(/[\\\/]+$/, '') + '/' + baseName;
        if (AEFS.existsSync(dstPath)) return _err('目标位置已存在: ' + dstPath);

        // 用 copyFile + deleteFile 实现 move（AEFS.renameFileSync 跨目录可能失败）
        if (!_copyRecursive(args.path, dstPath)) {
            // 复制阶段失败：源文件保持原状，但目标可能有部分文件残留——清理目标避免脏状态
            _deleteRecursive(dstPath);
            return _err('移动失败（复制阶段异常），已清理目标位置');
        }
        // 复制成功后删除源：若失败需明确告知（目标已就位但源未清理）
        if (!_deleteRecursive(args.path)) {
            return _ok('已复制到目标但源删除失败（请手动清理）: ' + args.path + ' → ' + dstPath);
        }
        return _ok('已移动: ' + args.path + ' → ' + dstPath);
    }

    // 递归复制（文件或文件夹）。 depth 超限返回失败（深度截断防环溢出）
    function _copyRecursive(srcPath, dstPath, depth) {
        if ((depth || 0) > MAX_TREE_DEPTH) return false;
        var AEFS = global.AEFS;
        if (!AEFS) return false;
        // 文件：优先问文件系统（AEFS.isFileSync）——扩展名嗅探会把非脚本杂文件
        // （.txt 等）误判为文件夹（在目标处误建同名目录）、把 *.jsx 命名的目录
        // 误判为文件（复制必败，文件夹永远无法 move）。isFileSync 不可用时退回嗅探。
        var isFile = AEFS.isFileSync
            ? AEFS.isFileSync(srcPath)
            : String(srcPath).toLowerCase().match(/\.(jsx|jsxbin)$/i);
        if (isFile || !AEFS.existsSync(srcPath)) {
            return AEFS.copyFileSync(srcPath, dstPath);
        }
        // 文件夹
        AEFS.mkdirSync(dstPath);
        var files = AEFS.listFilesSync(srcPath) || [];
        var dirs = AEFS.listDirsSync(srcPath) || [];
        var ok = true;
        for (var i = 0; i < files.length; i++) {
            if (!AEFS.copyFileSync(srcPath.replace(/[\\\/]+$/, '') + '/' + files[i], dstPath + '/' + files[i])) ok = false;
        }
        for (var j = 0; j < dirs.length; j++) {
            if (dirs[j] === '__order__') continue;
            if (!_copyRecursive(srcPath.replace(/[\\\/]+$/, '') + '/' + dirs[j], dstPath + '/' + dirs[j], (depth || 0) + 1)) ok = false;
        }
        return ok;
    }

    // 递归删除（文件或文件夹）。 depth 超限返回失败（深度截断防环溢出）
    function _deleteRecursive(path, depth) {
        if ((depth || 0) > MAX_TREE_DEPTH) return false;
        var AEFS = global.AEFS;
        if (!AEFS) return false;
        // 递归链每一级目标过 realpath 复核——顶层目标与嵌套 junction 均拦截
        //（move 的源删除同经此处）；逃逸即失败返回，不再下探
        if (_deleteTargetEscapes(path)) return false;
        // 文件：优先问文件系统（AEFS.isFileSync），扩展名嗅探无法区分 *.jsx 命名的
        // 目录（被当文件删失败）与非脚本杂文件（被当目录误 rmdir）。不可用时退回嗅探。
        var isFile = AEFS.isFileSync
            ? AEFS.isFileSync(path)
            : String(path).toLowerCase().match(/\.(jsx|jsxbin)$/i);
        if (isFile) {
            return AEFS.deleteFileSync(path);
        }
        var files = AEFS.listFilesSync(path) || [];
        var dirs = AEFS.listDirsSync(path) || [];
        for (var i = 0; i < files.length; i++) {
            AEFS.deleteFileSync(path.replace(/[\\\/]+$/, '') + '/' + files[i]);
        }
        for (var j = 0; j < dirs.length; j++) {
            if (dirs[j] === '__order__') continue;
            _deleteRecursive(path.replace(/[\\\/]+$/, '') + '/' + dirs[j], (depth || 0) + 1);
        }
        if (AEFS.rmdirSync(path)) return true;
        // 无 Bridge 时 rmdirSync 通道缺失（cep.fs 无 rmdir 原语）恒返 false：
        // 内容已清空的目录壳残留无害，复核「已消失或仅剩 __order__ 元数据」后如实
        // 返回成功，避免删空目录永远误报「删除失败」；仍有可见内容才真正报失败
        if (!AEFS.existsSync(path)) return true;
        var restFiles = AEFS.listFilesSync(path) || [];
        var restDirs = AEFS.listDirsSync(path) || [];
        for (var ri = 0; ri < restFiles.length; ri++) {
            if (restFiles[ri] !== '__order__') return false;
        }
        for (var rj = 0; rj < restDirs.length; rj++) {
            if (restDirs[rj] !== '__order__') return false;
        }
        return true;
    }

    function _createFolder(baseDir, args) {
        if (!args.folder) return _err('createFolder 必填 folder');
        var sec = global.AEScriptSecurity;
        var AEFS = global.AEFS;
        if (!sec || !AEFS) return _err('依赖未就绪');
        // 校验每个路径段名称合法
        // 分隔符归一：/ 与 \\ 均可（对齐 create 的 folder 接受度）——
        // 否则反斜杠形态整段落入 validateName 被当非法字符拒绝
        var segs = String(args.folder).replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').split('/');
        for (var i = 0; i < segs.length; i++) {
            if (!sec.validateName(segs[i])) return _err('文件夹名包含非法字符: ' + segs[i]);
        }
        var fullPath = String(baseDir).replace(/[\\\/]+$/, '') + '\\' + segs.join('\\');
        var check = _ensurePathInScriptsNamespace(fullPath, baseDir);
        if (!check.ok) return _err(check.error);
        if (AEFS.existsSync(fullPath)) return _err('文件夹已存在: ' + fullPath);
        if (AEFS.mkdirSync(fullPath)) {
            return _ok('已创建文件夹: ' + fullPath);
        }
        return _err('创建失败 — ' + (AEFS.lastError() || '未知错误'));
    }

    function _renameFolder(baseDir, args) {
        if (!args.folder) return _err('renameFolder 必填 folder（原路径）');
        if (!args.newFolder) return _err('renameFolder 必填 newFolder（新名称）');
        var check = _ensurePathInScriptsNamespace(args.folder, baseDir);
        if (!check.ok) return _err(check.error);
        // 拒绝重命名脚本根目录（同 _renameNode，对齐 _deleteNode/
        // _removeFolderSafe 的根拦截）——renameFolder 传根目录同样把整个脚本库改名
        if (_normBase(args.folder) === _normBase(baseDir)) return _err('拒绝重命名脚本根目录');
        var sec = global.AEScriptSecurity;
        var AEFS = global.AEFS;
        if (!sec || !AEFS) return _err('依赖未就绪');
        if (!sec.validateName(args.newFolder)) return _err('新名称包含非法字符');
        // 先剥尾随斜杠再取父目录（对齐 _renameNode）——folder 带尾 /
        // 时 /\/[^\/]+$/ 匹配不到末段，parentDir 残留尾斜杠、dstPath 出现 //
        // 双斜杠错位目标
        var folderNorm = String(args.folder).replace(/[\\\/]/g, '/').replace(/\/+$/, '');
        var parentDir = folderNorm.replace(/\/[^\/]+$/, '');
        var dstPath = parentDir + '/' + args.newFolder;
        var dstCheck = _ensurePathInScriptsNamespace(dstPath, baseDir);
        if (!dstCheck.ok) return _err(dstCheck.error);
        // 对齐 _renameNode 的大小写特例——Windows 大小写不敏感
        // FS 上 existsSync 对「源自身的大小写变体」也返回 true，仅大小写不同的文件夹
        // 更名（MyFolder → myfolder）若不特例放行会永远报「目标已存在」
        if (AEFS.existsSync(dstPath) && dstPath.toLowerCase() !== folderNorm.toLowerCase()) {
            return _err('目标已存在: ' + dstPath);
        }
        if (AEFS.renameFileSync(folderNorm, dstPath)) {
            return _ok('已重命名文件夹: ' + args.newFolder + '  path=' + dstPath);
        }
        return _err('重命名失败 — ' + (AEFS.lastError() || '未知错误'));
    }

    // removeFolder 安全包装：仅删空文件夹（与素材库 _removeFolderSafe 一致）
    // 注意：__order__ 是 AEFS 的目录排序元数据文件，不算"用户内容"，
    // 文件夹仅含 __order__ 时视为空，先删除 __order__ 再 rmdirSync
    function _removeFolderSafe(baseDir, folder) {
        if (!folder) return _err('removeFolder 必填 folder');
        var check = _ensurePathInScriptsNamespace(folder, baseDir);
        if (!check.ok) return _err(check.error);
        // 拒绝删除基准根本身（对齐 _deleteNode 的根目录拦截）：folder 传
        // 脚本根且树空时会一路放行到 rmdirSync 把根目录删掉
        // 两侧均经 _normBase 压缩——单侧压缩会使 // 数据目录下根拦截失效
        var baseNorm = _normBase(baseDir);
        var folderNorm = _normBase(folder);
        if (folderNorm === baseNorm) return _err('拒绝删除脚本根目录');
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        var files = AEFS.listFilesSync(folder) || [];
        var dirs = AEFS.listDirsSync(folder) || [];
        var visibleDirs = [];
        for (var i = 0; i < dirs.length; i++) {
            if (dirs[i] !== '__order__') visibleDirs.push(dirs[i]);
        }
        // 过滤 __order__ 元数据文件
        var realFiles = [];
        for (var j = 0; j < files.length; j++) {
            if (files[j] !== '__order__') realFiles.push(files[j]);
        }
        if (realFiles.length > 0 || visibleDirs.length > 0) {
            return _err('文件夹非空，仅允许删除空文件夹: ' + folder);
        }
        // 删除残留的 __order__ 元数据文件（如有）
        for (var k = 0; k < files.length; k++) {
            AEFS.deleteFileSync(folder.replace(/[\\\/]+$/, '') + '/' + files[k]);
        }
        if (AEFS.rmdirSync(folder)) {
            return _ok('已删除空文件夹: ' + folder);
        }
        return _err('删除失败 — ' + (AEFS.lastError() || '未知错误'));
    }

    // ── cleanNonScript：清理非脚本文件 ──
    function _cleanNonScript(baseDir) {
        var AEFS = global.AEFS;
        if (!AEFS) return _err('AEFS 未就绪');
        var sec = global.AEScriptSecurity;
        if (!sec) return _err('AEScriptSecurity 未就绪');

        var baseNorm = _normBase(baseDir);  // 压缩中间连续分隔符
        var junkFiles = [];
        var emptyDirs = [];

        function scan(dir, depth) {
            // 深度截断（环场景下有限时间返回而非栈溢出）
            if ((depth || 0) > MAX_TREE_DEPTH) return { scripts: 0, junks: 0 };
            // 经 _normBase 压缩中间连续分隔符（与 baseNorm 同形态比较）
            var dirNorm = _normBase(dir);
            // 防止 symlink 逃逸
            if (dirNorm !== baseNorm && dirNorm.indexOf(baseNorm + '/') !== 0) return { scripts: 0, junks: 0 };
            var files = AEFS.listFilesSync(dir) || [];
            var dirs = AEFS.listDirsSync(dir) || [];
            var scriptCount = 0;
            var junkCount = 0;
            for (var i = 0; i < files.length; i++) {
                if (files[i] === '__order__') continue;  // 排序元数据非用户内容，不当垃圾（对齐 _removeFolderSafe）
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
                    var r = scan(dir.replace(/[\\\/]+$/, '') + '/' + dirs[d], (depth || 0) + 1);
                    childScripts += r.scripts;
                    childJunks += r.junks;
                }
            }
            // 整棵子树无脚本即标记清理：纯空目录、仅剩 __order__ 元数据的
            // 目录与清完垃圾后变空的目录一并覆盖——要求「有非脚本文件才标记」
            // 会漏清纯空子目录；基准根本身永不清
            if (scriptCount === 0 && childScripts === 0
                && dirNorm !== baseNorm) {
                emptyDirs.push(dir);
            }
            return { scripts: scriptCount + childScripts, junks: junkCount + childJunks };
        }
        scan(baseDir);

        // 删除前最终安全校验：每个待删路径必须在 base 下
        function _filterSafe(paths) {
            var safe = [];
            for (var i = 0; i < paths.length; i++) {
                var pNorm = _normBase(paths[i]);  // 
                if (_inAgentScriptsBase(paths[i], baseNorm) && pNorm !== baseNorm) {
                    // 字符串前缀之外补 realpath 复核——待删路径经 junction
                    // 指向基准外（如用户目录）即剔除，防清理穿透删非脚本文件
                    if (_deleteTargetEscapes(paths[i])) continue;
                    safe.push(paths[i]);
                }
            }
            return safe;
        }
        junkFiles = _filterSafe(junkFiles);
        emptyDirs = _filterSafe(emptyDirs);
        // 按深度倒序（先删最深层）
        emptyDirs.sort(function (a, b) {
            var da = String(a).replace(/\\/g, '/').replace(/\/+$/, '').split('/').length;
            var db = String(b).replace(/\\/g, '/').replace(/\/+$/, '').split('/').length;
            return db - da;
        });

        if (junkFiles.length === 0 && emptyDirs.length === 0) {
            return _ok('未发现非脚本文件');
        }

        var deleted = 0;
        var failed = 0;
        for (var i = 0; i < junkFiles.length; i++) {
            if (AEFS.deleteFileSync(junkFiles[i])) deleted++;
            else failed++;
        }
        var removedDirs = 0;
        for (var j = 0; j < emptyDirs.length; j++) {
            // __order__ 不列为垃圾（保护存活目录的排序元数据），但待删目录内残留
            // 的 __order__ 会挡住 rmdir——随目录一并清除（对齐 _removeFolderSafe）
            AEFS.deleteFileSync(emptyDirs[j].replace(/[\\\/]+$/, '') + '/__order__');
            if (AEFS.rmdirSync(emptyDirs[j])) removedDirs++;
            else failed++;
        }
        var msg = '已清理 ' + deleted + '/' + junkFiles.length + ' 个非脚本文件';
        if (emptyDirs.length > 0) msg += '、' + removedDirs + '/' + emptyDirs.length + ' 个空文件夹';
        if (failed > 0) msg += '（' + failed + ' 个失败）';
        return _ok(msg);
    }

    // ── delete：删除文件或文件夹（FORCE 弹窗由 permissions 处理）──
    function _deleteNode(baseDir, path) {
        if (!path) return _err('delete 必填 path');
        var check = _ensurePathInScriptsNamespace(path, baseDir);
        if (!check.ok) return _err(check.error);
        // 拒绝删除基准根本身。 两侧均经 _normBase 压缩中间分隔符
        var baseNorm = _normBase(baseDir);
        var pathNorm = _normBase(path);
        if (pathNorm === baseNorm) return _err('拒绝删除脚本根目录');
        // 删除目标 realpath 复核——junction 指向基准外（如用户目录）即拒绝
        if (_deleteTargetEscapes(path)) {
            return _err('拒绝删除：目标经 symlink/junction 指向 agent/scripts 基准外 — ' + path);
        }
        if (_deleteRecursive(path)) {
            return _ok('已删除: ' + path);
        }
        return _err('删除失败 — ' + (global.AEFS.lastError ? (global.AEFS.lastError() || '未知错误') : '未知错误'));
    }

    // ════════════════════════════════════════════════════════
    //  注册入口
    // ════════════════════════════════════════════════════════
    async function initScriptManagerTools(config) {
        config = config || {};
        var toolRegistry = config.toolRegistry;
        var hostApi = config.hostApi || (global.AEPlatform && global.AEPlatform.hostApi) || null;
        if (!toolRegistry) {
            console.warn('[ScriptManagerBootstrap] MISSING_TOOL_REGISTRY');
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }

        toolRegistry.register({
            name: TOOL_NAME,
            description: 'Agent 脚本列表管理（数据目录 agent/scripts 下的 .jsx/.jsxbin 文件）。按 mode 操作：'
                + ' list/get/search/listFolders/readContent（读，不弹确认）；'
                + ' create/write/rename/move/createFolder/renameFolder/removeFolder/cleanNonScript（写，balanced 弹确认）；'
                + ' delete（强制弹窗，任何权限模式都需确认）；'
                + ' 安全约束：create/write 写盘前会经过脚本校验（静态 + LLM 审查），所有路径必须落在 agent/scripts 基准下；removeFolder 仅删空文件夹。',
            input_schema: {
                type: 'object',
                properties: {
                    mode: {
                        type: 'string',
                        enum: ['list', 'get', 'search', 'listFolders', 'readContent',
                            'create', 'write', 'rename', 'move',
                            'createFolder', 'renameFolder', 'removeFolder', 'cleanNonScript',
                            'delete']
                    },
                    path: {
                        type: 'string',
                        description: 'get/readContent/write/rename/move/delete 必填：脚本文件或文件夹的绝对路径（必须在 agent/scripts 下）'
                    },
                    name: {
                        type: 'string',
                        description: 'create 必填：脚本名称（无需扩展名，自动加 .jsx）；rename 用（新名称，文件自动保留原扩展名）'
                    },
                    content: {
                        type: 'string',
                        description: 'create 可选（默认生成头注释）/ write 必填：脚本内容（字符串）'
                    },
                    folder: {
                        type: 'string',
                        description: 'list 可选（按文件夹过滤）/ create 可选（父文件夹相对路径）/ move 必填（目标文件夹）/ createFolder 必填（新文件夹相对路径）/ removeFolder 必填（要删的空文件夹路径）/ renameFolder 必填（原文件夹路径）。相对路径如 "intro/sub"'
                    },
                    newName: {
                        type: 'string',
                        description: 'rename 必填：新名称（脚本文件无需带扩展名，自动补 .jsx/.jsxbin 保留原扩展名）'
                    },
                    newFolder: {
                        type: 'string',
                        description: 'renameFolder 必填：新文件夹名称（单段名称，非路径）'
                    },
                    query: {
                        type: 'string',
                        description: 'search 必填：名称关键词（大小写不敏感）'
                    }
                },
                required: ['mode']
            },
            scope: { type: 'module', moduleIds: ['script', 'external-mcp'] },
            stub: false,
            category: 'scripts',
            source: 'agent',
            handler: function (args, execCtx) {
                return _handleScriptManager(args, hostApi, execCtx);
            }
        });

        return { ok: true, toolName: TOOL_NAME };
    }

    // 暴露
    global.AEScriptManager.initScriptManagerTools = initScriptManagerTools;
    global.AEScriptManager.READ_MODES = READ_MODES;
})(window);
