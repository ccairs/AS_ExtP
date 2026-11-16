/**
 * skillFs.js — Skill 目录化改造的本地文件能力层
 *
 * 职责：相对路径校验、递归列目录、整树复制、递归删除、附件读取、整包写盘。
 * 背景：Skill 从单文件 SKILL.md 变为目录（SKILL.md + techniques/、reference/ 等附件），
 * 安装、卸载、LLM 读附件都要对「技能目录树」做同一批操作。集中在本模块，避免
 * view/llmTools/bootstrap 各写一份相对路径校验与回退链——多份手抄副本漂移是本仓库
 * 反复出现的问题（如 isSensitivePath 曾有四份副本，见 aefs.js 导出处注释）。
 *
 * 依赖：aefs 由调用方显式传入（与 skillCreator.js 同一分工），不读 global.AEFS。
 *   - 面板内传真实 AEFS；测试传内存 mock 即可覆盖全部回退链，不触真实磁盘。
 *   - 本文件不依赖 DOM/Node；面板运行于 Chrome 88 CEF，ES6+/async-await 可用。
 *
 * 回退链原则：真实 AEFS 的通道是 Bridge → cep.fs → ExtendScript，同一操作在不同
 * 通道上能力不同（例如 copyDir 的逐文件回退只在 Bridge 不可用时才走）。本模块的批量
 * 操作按「能力判断 → 失败回退」逐级降级；降级后仍失败就如实返回 {ok:false, code, error}，
 * 不静默半成功——半成功会让技能目录留下残缺附件或删不净的残留，重启后更难修复。
 *
 * 对外 API 挂在 global.AE_LLM.skillFs（签名与返回形状是 view/llmTools 的集成契约）：
 *   normalizeRelPath(rel)                         → string|null
 *   collectFiles(aefs, rootDir, opts)             → Promise<{ok, files, truncated}|{ok:false,code,error}>
 *   copyTree(aefs, srcDir, dstDir)                → Promise<{ok:true}|{ok:false,code,error}>
 *   removeTree(aefs, dirPath)                     → Promise<{ok:true,removed}|{ok:false,code,error}>
 *   readSkillFile(aefs, skillDir, relPath, opts)  → Promise<{ok,text,total,offset,hasMore}|{ok:false,code,error}>
 *   writePackage(aefs, skillDir, entries)         → Promise<{ok,written}|{ok:false,code,error,written}>
 */
(function (global) {

    // 相对路径长度上限：Windows 全路径约 260（未开长路径）到 32767，技能目录本身占一截；
    // 512 是「单条相对路径」的保守上限，超长路径还会触发 AEFS/_checkPath 的拒绝。
    var MAX_REL_PATH_LEN = 512;
    var DEFAULT_MAX_FILES = 500;
    var DEFAULT_MAX_DEPTH = 8;
    var DEFAULT_MAX_CHARS = 20000;

    // 整树操作的兜底扫描上限刻意高于展示用的默认值：默认 500 个文件对「列附件」够用，
    // 但整树复制若被静默截断会得到残缺技能。超过上限时 copyTree 明确失败（COPY_INCOMPLETE），
    // 而不是拷一半报成功。
    var TREE_OP_MAX_FILES = 5000;
    var TREE_OP_MAX_DEPTH = 32;

    var CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
    var DRIVE_LETTER_RE = /^[A-Za-z]:/;
    // Windows 文件名非法字符。AEFS 的 _checkPath 也会拒这些字符，但 writePackage 必须在
    // **任何写盘之前**整体拒绝非法路径（契约要求），所以这里必须先判一遍。
    var SEGMENT_ILLEGAL_RE = /[<>:"|?*]/;

    function _fail(code, error) {
        return { ok: false, code: code, error: error || '' };
    }

    function _pkgFail(code, error, written) {
        return { ok: false, code: code, error: error || '', written: written || [] };
    }

    function _hasFn(obj, name) {
        return !!obj && typeof obj[name] === 'function';
    }

    function _msg(e) {
        return e && e.message ? String(e.message) : String(e);
    }

    // 取整数选项：非法/低于下限时回落默认值（调用方传 undefined 是常态，
    // 但 UI 传 ''、null、NaN 也不该让上限变成 0 而静默空列表）。
    function _intOpt(value, dflt, min) {
        var n = Number(value);
        if (!isFinite(n) || n < min) return dflt;
        return Math.floor(n);
    }

    // 拼绝对路径：沿用 base 已有分隔符风格（AEFS 两种都认，两个通道各自会归一），
    // 避免把 `E:/x` 拼成 `E:/x\y` 这种混合串在 mock 断言里难以核对。
    function _joinFs(base, name) {
        var b = String(base);
        if (b.length > 0 && (b.charAt(b.length - 1) === '/' || b.charAt(b.length - 1) === '\\')) return b + name;
        return b + (b.indexOf('\\') >= 0 ? '\\' : '/') + name;
    }

    // 相对路径 → 绝对路径（相对路径内部统一用 '/'，拼到 Windows 基目录时转成分隔符）
    function _absFromRel(baseDir, rel) {
        var sep = String(baseDir).indexOf('\\') >= 0 ? '\\' : '/';
        return _joinFs(baseDir, String(rel).replace(/\//g, sep));
    }

    // 解析后的绝对路径是否落在技能目录内（大小写不敏感、分隔符归一）。
    // normalizeRelPath 已拒绝 .. 与绝对路径，这里是纵深防御：万一拼接口径变了
    // （或 skillDir 自身带尾部斜杠/反斜杠），仍要保证读取目标不逃出技能目录。
    function _insideDir(baseDir, absPath) {
        var base = String(baseDir).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        var target = String(absPath).replace(/\\/g, '/').toLowerCase();
        return target === base || target.indexOf(base + '/') === 0;
    }

    // ── 1. 相对路径校验 ─────────────────────────────────────────────

    /**
     * 校验并归一化技能目录内的相对路径。
     * @param {*} rel
     * @returns {string|null} 合法返回正斜杠相对路径；非法返回 null。
     *
     * 非法集合（安全边界，不做「尽量修正」）：非字符串/空、超长、控制字符、以 / 开头
     * （绝对值/UNC）、盘符、任一段为 .. / . / 空（连续或结尾斜杠）、段内含
     * Windows 非法字符。
     */
    function normalizeRelPath(rel) {
        if (typeof rel !== 'string') return null;
        // 反斜杠先归一再判断：调用方可能来自 Windows 路径、UI 输入或 LLM 参数
        var s = rel.replace(/\\/g, '/');
        // 只剥「开头连续的 ./」：中间出现的 . 段仍按非法拒绝——若把 . 段当可忽略，
        // 本模块的校验语义就与 AEFS/文件系统实际解析出的路径不一致（安全边界必须两边一致）。
        while (s.length >= 2 && s.charAt(0) === '.' && s.charAt(1) === '/') s = s.substring(2);
        if (s.length === 0 || s.length > MAX_REL_PATH_LEN) return null;
        if (CONTROL_CHAR_RE.test(s)) return null;
        if (s.charAt(0) === '/') return null;          // 绝对路径 / UNC（\\server 归一后以 / 开头）
        if (DRIVE_LETTER_RE.test(s)) return null;      // C:/ C:\ 盘符绝对路径
        var segments = s.split('/');
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            if (seg === '' || seg === '.' || seg === '..') return null;
            if (SEGMENT_ILLEGAL_RE.test(seg)) return null;
            // AEFS._checkPath 对含 '%' 的路径直接拒绝（percent 语义/走私防护）。
            // 这里提前拒：否则「Skill(file) 读 % 文件」会落到 readFile 返回 null →
            // 误报「不存在或为空」；远端包也会到写盘才整包失败。口径与 skillRemote 对齐。
            if (seg.indexOf('%') >= 0) return null;
            // Windows 会静默剥离段尾空格/句点（实际落点与路径字符串不一致）→ 拒
            if (/[ .]$/.test(seg)) return null;
        }
        return s;
    }

    // ── 2. 递归列目录 ───────────────────────────────────────────────

    /**
     * 递归列出 rootDir 下的全部文件（相对 rootDir 的正斜杠路径 + 体积）。
     * @param {object} aefs  AEFS 实例或 mock（需 listDirs/listFiles）
     * @param {string} rootDir 绝对目录路径
     * @param {{maxFiles?:number, maxDepth?:number}} [opts]
     * @returns {Promise<{ok:true, files:Array<{path:string,size:number|null}>, truncated:boolean}
     *                  |{ok:false, code:string, error:string}>}
     *
     * maxFiles：最多收集的文件数，达到上限立即停止并 truncated=true。
     * maxDepth：最多下钻的子目录层数（rootDir 为第 0 层；默认 8，即根下 8 层）。
     * aefs 缺少列目录能力 → NO_AEFS。listFilesWithSize 只走 Bridge（拿不到体积时
     * resolve null），所以体积拿不到一律 size:null，不按 0 记。
     */
    async function collectFiles(aefs, rootDir, opts) {
        if (!_hasFn(aefs, 'listDirs') || !_hasFn(aefs, 'listFiles')) {
            return _fail('NO_AEFS', AEI18n.t('AEFS 不可用（缺少 listDirs/listFiles）'));
        }
        if (typeof rootDir !== 'string' || rootDir === '') {
            return _fail('INVALID_PATH', AEI18n.t('根目录无效: ') + String(rootDir));
        }
        opts = (opts && typeof opts === 'object') ? opts : {};
        var maxFiles = _intOpt(opts.maxFiles, DEFAULT_MAX_FILES, 1);
        var maxDepth = _intOpt(opts.maxDepth, DEFAULT_MAX_DEPTH, 0);
        var files = [];
        var truncated = false;

        async function listNames(method, dirAbs) {
            var names;
            try {
                names = await aefs[method](dirAbs);
            } catch (e) {
                var err = new Error(method + AEI18n.t(' 失败: ') + dirAbs + ' — ' + _msg(e));
                err.skillFsResult = _fail('LIST_FAILED', err.message);
                throw err;
            }
            if (!Array.isArray(names)) {
                // 三态 API 的失败值（null）不能当「空目录」：那会让调用方以为目录里没文件
                var err2 = new Error(method + AEI18n.t(' 返回非数组: ') + dirAbs);
                err2.skillFsResult = _fail('LIST_FAILED', err2.message);
                throw err2;
            }
            var out = [];
            for (var i = 0; i < names.length; i++) {
                if (typeof names[i] === 'string' && names[i] !== '') out.push(names[i]);
            }
            // 目录项排序：Bridge/cep.fs/ExtendScript 各通道的返回顺序不保证一致，
            // 排序让同一棵树在 UI、测试与两次调用之间得到稳定结果。
            out.sort();
            return out;
        }

        async function sizesIn(dirAbs) {
            if (!_hasFn(aefs, 'listFilesWithSize')) return null;
            var sized;
            try {
                sized = await aefs.listFilesWithSize(dirAbs);
            } catch (_) {
                return null;
            }
            if (!Array.isArray(sized)) return null;   // null = 拿不到体积（不是「全是 0」）
            // null-prototype：文件名来自磁盘/网络包，`__proto__` 之类的键在普通 {} 上
            // 会被原型 setter 拦截（与 parseSimpleYaml 同一类不可信映射防护）
            var map = Object.create(null);
            for (var i = 0; i < sized.length; i++) {
                var it = sized[i];
                if (it && typeof it.name === 'string' && typeof it.size === 'number'
                    && isFinite(it.size) && it.size >= 0) {
                    map[it.name] = it.size;
                }
            }
            return map;
        }

        async function walk(dirAbs, relPrefix, depth) {
            var names = await listNames('listFiles', dirAbs);
            var sizes = names.length > 0 ? await sizesIn(dirAbs) : null;
            for (var i = 0; i < names.length; i++) {
                if (files.length >= maxFiles) { truncated = true; return; }
                var name = names[i];
                var size = null;
                if (sizes && Object.prototype.hasOwnProperty.call(sizes, name)) size = sizes[name];
                files.push({ path: relPrefix + name, size: size });
            }
            if (depth >= maxDepth) return;
            var dirs = await listNames('listDirs', dirAbs);
            for (var d = 0; d < dirs.length; d++) {
                if (truncated) return;
                await walk(_joinFs(dirAbs, dirs[d]), relPrefix + dirs[d] + '/', depth + 1);
            }
        }

        try {
            await walk(rootDir, '', 0);
        } catch (e) {
            if (e && e.skillFsResult) return e.skillFsResult;
            return _fail('LIST_FAILED', AEI18n.t('列目录失败: ') + rootDir + ' — ' + _msg(e));
        }
        files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
        return { ok: true, files: files, truncated: truncated };
    }

    // ── 3. 整树复制 ─────────────────────────────────────────────────

    /**
     * 把 srcDir 整棵树复制到 dstDir。
     * 优先 aefs.copyDir（Bridge 侧真实现，二进制安全、自动建父目录）；
     * 不可用/返回非 true 时退化为 collectFiles + aefs.copyFile 逐文件复制
     * （copyFile 由 AEFS 负责建父目录）。
     * @returns {Promise<{ok:true}|{ok:false, code:string, error:string}>}
     *
     * 注意：与 AEFS.copyDir 语义对齐——空源目录（含源目录不存在）只确保目标目录存在
     * 并返回 ok，这是既有契约（copyDir 回退链对空源就是这么处理的），本模块不另造语义。
     */
    async function copyTree(aefs, srcDir, dstDir) {
        if (!aefs || typeof aefs !== 'object') return _fail('NO_AEFS', AEI18n.t('AEFS 不可用'));
        if (typeof srcDir !== 'string' || srcDir === '' || typeof dstDir !== 'string' || dstDir === '') {
            return _fail('INVALID_PATH', AEI18n.t('源目录/目标目录无效'));
        }
        var hasCopyDir = _hasFn(aefs, 'copyDir');
        var hasCopyFile = _hasFn(aefs, 'copyFile');
        if (!hasCopyDir && !hasCopyFile) {
            return _fail('NO_COPY_CHANNEL', AEI18n.t('AEFS 缺少 copyDir/copyFile，无法复制目录'));
        }
        // 契约固定「=== true」：降级实现/mock 返回 truthy 非 true 不能算成功，
        // 否则整树复制失败会被当成成功，后续写 SKILL.md 会把残缺目录注册成技能。
        if (hasCopyDir) {
            var fastOk = false;
            try { fastOk = (await aefs.copyDir(srcDir, dstDir)) === true; } catch (_) { fastOk = false; }
            if (fastOk) return { ok: true };
        }
        if (!hasCopyFile) {
            return _fail('COPY_FAILED', AEI18n.t('整树复制失败且 AEFS 缺少 copyFile 逐文件兜底: ') + srcDir);
        }
        var collected = await collectFiles(aefs, srcDir, { maxFiles: TREE_OP_MAX_FILES, maxDepth: TREE_OP_MAX_DEPTH });
        if (!collected.ok) {
            return _fail(collected.code || 'COPY_FAILED', AEI18n.t('列源目录失败: ') + (collected.error || srcDir));
        }
        if (collected.truncated) {
            return _fail('COPY_INCOMPLETE', AEI18n.t('源目录文件数超过逐文件兜底上限（') + collected.files.length + AEI18n.t('），未复制（避免拷入残缺技能）'));
        }
        if (collected.files.length === 0) {
            // 空源目录：copyDir 的成功语义包含「建目标目录」，逐文件兜底没有文件可拷，
            // 显式补一次 mkdir 保持语义等价（AEFS.mkdir 已存在，缺则只能接受空目标不存在）
            if (_hasFn(aefs, 'mkdir')) {
                var mkOk = false;
                try { mkOk = (await aefs.mkdir(dstDir)) === true; } catch (_) { mkOk = false; }
                if (!mkOk) return _fail('COPY_FAILED', AEI18n.t('创建目标目录失败: ') + dstDir);
            }
            return { ok: true };
        }
        for (var i = 0; i < collected.files.length; i++) {
            var rel = collected.files[i].path;
            var ok = false;
            try { ok = !!(await aefs.copyFile(_absFromRel(srcDir, rel), _absFromRel(dstDir, rel))); } catch (_) { ok = false; }
            if (!ok) return _fail('COPY_FAILED', AEI18n.t('复制文件失败: ') + rel);
        }
        return { ok: true };
    }

    // ── 4. 递归删除 ─────────────────────────────────────────────────

    function _canSyncRemove(aefs) {
        return _hasFn(aefs, 'listFilesSync') && _hasFn(aefs, 'listDirsSync')
            && _hasFn(aefs, 'deleteFileSync') && _hasFn(aefs, 'rmdirSync');
    }

    // 同步递归删除（异步链不可用/失败时的最后兜底）。
    // 同步通道会阻塞主线程，但 removeTree 只在卸载/失败清理等低频流程调用，可接受。
    function _removeTreeSync(aefs, dirPath) {
        var files;
        try { files = aefs.listFilesSync(dirPath); } catch (_) { return false; }
        if (!Array.isArray(files)) return false;
        for (var i = 0; i < files.length; i++) {
            if (typeof files[i] !== 'string' || files[i] === '') return false;
            var fOk = false;
            try { fOk = aefs.deleteFileSync(_joinFs(dirPath, files[i])) === true; } catch (_) { fOk = false; }
            if (!fOk) return false;
        }
        var dirs;
        try { dirs = aefs.listDirsSync(dirPath); } catch (_) { return false; }
        if (!Array.isArray(dirs)) return false;
        for (var d = 0; d < dirs.length; d++) {
            if (typeof dirs[d] !== 'string' || dirs[d] === '') return false;
            if (_removeTreeSync(aefs, _joinFs(dirPath, dirs[d])) !== true) return false;
        }
        var rmOk = false;
        try { rmOk = aefs.rmdirSync(dirPath) === true; } catch (_) { rmOk = false; }
        return rmOk;
    }

    // 存在性探测：返回 true/false/null（null = 无探测能力或通道异常，不能证明「不存在」）。
    async function _probeExists(aefs, p) {
        if (_hasFn(aefs, 'exists')) {
            try {
                var r = await aefs.exists(p);
                if (r === true) return true;
                if (r === false) return false;
                return null;
            } catch (_) { return null; }
        }
        if (_hasFn(aefs, 'existsSync')) {
            try {
                var s = aefs.existsSync(p);
                if (s === true) return true;
                if (s === false) return false;
                return null;
            } catch (_) { return null; }
        }
        return null;
    }

    /**
     * 递归删除目录树。按能力逐级回退：
     *   a. aefs.removeDirRecursive(dirPath, {preConfirmed:true}) === true
     *      （Bridge 可用时走回收站；preConfirmed 表示调用方已在卸载确认里告知不可恢复，
     *        本模块不重复弹窗）
     *   b. collectFiles → 逐个 aefs.deleteFile → aefs.rmdir
     *   c. 同步兜底：listFilesSync/listDirsSync 递归 + deleteFileSync + rmdirSync
     * 「目录本来就不存在」视为 {ok:true, removed:false}；存在但删不掉如实失败
     * （不能把残留目录报成已卸载——磁盘是重启后的事实源，残留会让技能复活）。
     * @returns {Promise<{ok:true, removed:boolean}|{ok:false, code:string, error:string}>}
     */
    async function removeTree(aefs, dirPath) {
        if (!aefs || typeof aefs !== 'object') return _fail('NO_AEFS', AEI18n.t('AEFS 不可用'));
        if (typeof dirPath !== 'string' || dirPath === '') return _fail('INVALID_PATH', AEI18n.t('目录路径无效'));

        if (_hasFn(aefs, 'removeDirRecursive')) {
            var recOk = false;
            try { recOk = (await aefs.removeDirRecursive(dirPath, { preConfirmed: true })) === true; } catch (_) { recOk = false; }
            if (recOk) return { ok: true, removed: true };
        }

        // 逐文件异步删除。超过上限时不继续（列不全就无法保证删净），交给同步兜底从根重建遍历。
        if (_hasFn(aefs, 'deleteFile') && _hasFn(aefs, 'rmdir')) {
            var collected = await collectFiles(aefs, dirPath, { maxFiles: TREE_OP_MAX_FILES, maxDepth: TREE_OP_MAX_DEPTH });
            if (collected.ok && !collected.truncated) {
                var allDeleted = true;
                for (var i = 0; i < collected.files.length; i++) {
                    var delOk = false;
                    try { delOk = !!(await aefs.deleteFile(_absFromRel(dirPath, collected.files[i].path))); } catch (_) { delOk = false; }
                    if (!delOk) { allDeleted = false; break; }
                }
                if (allDeleted) {
                    var rmOk = false;
                    try { rmOk = !!(await aefs.rmdir(dirPath)); } catch (_) { rmOk = false; }
                    if (rmOk) return { ok: true, removed: true };
                }
            }
        }

        if (_canSyncRemove(aefs) && _removeTreeSync(aefs, dirPath) === true) {
            return { ok: true, removed: true };
        }

        // 所有删除链都没成功：目录本来就不存在（并发卸载/上一步已删）算成功；
        // 存在或无探测能力时如实失败——不能把「删不掉」报成「已删除」。
        var exists = await _probeExists(aefs, dirPath);
        if (exists === false) return { ok: true, removed: false };
        return _fail('REMOVE_FAILED', AEI18n.t('无法删除目录: ') + dirPath);
    }

    // ── 5. 附件读取（分页） ─────────────────────────────────────────

    /**
     * 读取技能目录内某个文件的文本片段（供 LLM 按需分页读附件）。
     * @param {object} aefs
     * @param {string} skillDir 技能目录绝对路径
     * @param {string} relPath 技能目录内的相对路径
     * @param {{offset?:number, maxChars?:number}} [opts]
     * @returns {Promise<{ok:true, text:string, total:number, offset:number, hasMore:boolean}
     *                  |{ok:false, code:string, error:string}>}
     * code ∈ INVALID_PATH/SENSITIVE/NOT_FOUND/BINARY/READ_FAILED。
     *
     * 「空文件」判 NOT_FOUND 是既有契约（aefs.readFile 把通道失败折叠成 null，
     * 空串与读失败无法区分，统一按不存在处理）。
     */
    async function readSkillFile(aefs, skillDir, relPath, opts) {
        if (!_hasFn(aefs, 'readFile')) return _fail('READ_FAILED', AEI18n.t('AEFS 不可用，无法读取文件'));
        if (typeof skillDir !== 'string' || skillDir === '') return _fail('INVALID_PATH', AEI18n.t('技能目录无效'));
        var rel = normalizeRelPath(relPath);
        if (rel === null) return _fail('INVALID_PATH', AEI18n.t('非法相对路径: ') + String(relPath));
        var absPath = _absFromRel(skillDir, rel);
        if (!_insideDir(skillDir, absPath)) {
            return _fail('INVALID_PATH', AEI18n.t('路径逃逸技能目录: ') + rel);
        }
        // 敏感路径判定：AEFS 无该能力时**拒绝**（fail-closed），与下方注释一致——
        // 缺能力直接放行（fail-open），与注释相反；生产 AEFS 有该能力，当前不可利用，
        // 但降级环境/测试装配下不应留 fail-open 读口。
        if (!_hasFn(aefs, 'isSensitivePath')) {
            return _fail('SENSITIVE', AEI18n.t('AEFS 缺少 isSensitivePath 判定，拒绝读取附件（fail-closed）: ') + rel);
        }
        var sensitive = true;   // 判不出来按敏感拒（fail-closed）：读侧宁可不给，也不赌
        try { sensitive = !!aefs.isSensitivePath(absPath); } catch (_) { sensitive = true; }
        if (sensitive) return _fail('SENSITIVE', AEI18n.t('拒绝读取敏感路径: ') + rel);
        var content;
        try {
            content = await aefs.readFile(absPath);
        } catch (e) {
            return _fail('READ_FAILED', AEI18n.t('读取失败: ') + rel + ' — ' + _msg(e));
        }
        if (content === null || content === undefined || content === '') return _fail('NOT_FOUND', AEI18n.t('文件不存在或为空: ') + rel);
        if (typeof content !== 'string') return _fail('READ_FAILED', AEI18n.t('读取结果不是文本: ') + rel);
        if (content.indexOf('\u0000') !== -1) return _fail('BINARY', AEI18n.t('二进制文件不支持文本读取: ') + rel);

        opts = (opts && typeof opts === 'object') ? opts : {};
        var offset = _intOpt(opts.offset, 0, 0);
        var maxChars = _intOpt(opts.maxChars, DEFAULT_MAX_CHARS, 1);
        var total = content.length;
        // 越界 offset 返回空文本 + hasMore:false，调用方据此终止翻页（不报错——
        // offset 来自上一轮返回值，末尾之后取一页是正常收尾）
        var text = offset >= total ? '' : content.slice(offset, offset + maxChars);
        return {
            ok: true,
            text: text,
            total: total,
            offset: offset,
            hasMore: offset + text.length < total
        };
    }

    // ── 6. 整包写盘 ─────────────────────────────────────────────────

    // SKILL.md 的写盘策略：优先 global.AE_LLM.atomicWriteFile（skillCreator.js 已导出
    // 3 参签名 (aefs, path, content)，即 .tmp→rename + .recovery 兜底），否则 aefs.writeFile。
    // 形参个数判定保留：独立加载/旧装配可能只有 2 参实现，两种形态都可用。
    function _writeMainFile(aefs, absPath, text) {
        var atomic = (global.AE_LLM && typeof global.AE_LLM.atomicWriteFile === 'function')
            ? global.AE_LLM.atomicWriteFile : null;
        if (!atomic) return aefs.writeFile(absPath, text);
        try {
            return Promise.resolve(atomic.length >= 3 ? atomic(aefs, absPath, text) : atomic(absPath, text));
        } catch (e) {
            return Promise.reject(e);
        }
    }

    /**
     * 把技能包整包写入 skillDir。
     * @param {object} aefs
     * @param {string} skillDir 技能目录绝对路径（写文件时由 AEFS 自动创建父目录）
     * @param {Array<{path:string,text:string}|{path:string,base64:string,binary:true}>} entries
     * @returns {Promise<{ok:true, written:string[]}|{ok:false, code:string, error:string, written:string[]}>}
     *
     * 写序：非 SKILL.md 附件先写，SKILL.md 最后写。SKILL.md 是「这个目录是一个技能」的
     * 发现标记（bootstrap 扫 skills 一层子目录找 SKILL.md）；最后写它，中途失败/断电
     * 就不会留下「能被发现、附件却残缺」的技能。任一失败立即返回并附 written（已落盘
     * 的相对路径），由调用方清理目录。
     */
    async function writePackage(aefs, skillDir, entries) {
        if (!aefs || !_hasFn(aefs, 'writeFile')) return _pkgFail('NO_AEFS', AEI18n.t('AEFS 不可用，无法写文件'), []);
        if (typeof skillDir !== 'string' || skillDir === '') return _pkgFail('INVALID_PATH', AEI18n.t('技能目录无效'), []);
        if (!Array.isArray(entries)) return _pkgFail('INVALID_ENTRY', AEI18n.t('entries 必须是数组'), []);

        // 先全量校验（路径 + 内容字段），任何一条非法 → 整体拒绝且不写任何文件。
        // 不能边写边校验：写到一半才发现坏路径会留下半套附件，调用方还得自己清理。
        var planned = [];
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (!e || typeof e !== 'object') return _pkgFail('INVALID_ENTRY', AEI18n.t('entries[{index}] 不是对象', { index: i }), []);
            var rel = normalizeRelPath(e.path);
            if (rel === null) return _pkgFail('INVALID_PATH', AEI18n.t('entries[{index}].path 非法: ', { index: i }) + String(e.path), []);
            // 根级 SKILL.md（大小写不敏感：Windows 文件系统不区分大小写，skill.md 也是入口文件，
            // 写序与原子写策略必须一致）
            var isMain = rel.toLowerCase() === 'skill.md';
            var item = { path: rel, absPath: _absFromRel(skillDir, rel), isMain: isMain };
            if (e.binary === true) {
                if (isMain) return _pkgFail('INVALID_ENTRY', AEI18n.t('SKILL.md 必须以文本条目提供'), []);
                if (typeof e.base64 !== 'string' || e.base64 === '') {
                    return _pkgFail('INVALID_ENTRY', AEI18n.t('entries[{index}] 二进制条目缺少 base64', { index: i }), []);
                }
                item.binary = true;
                item.base64 = e.base64;
            } else {
                if (typeof e.text !== 'string') {
                    return _pkgFail('INVALID_ENTRY', AEI18n.t('entries[{index}] 文本条目缺少 text', { index: i }), []);
                }
                item.text = e.text;
            }
            planned.push(item);
        }

        var ordered = [];
        for (var a = 0; a < planned.length; a++) if (!planned[a].isMain) ordered.push(planned[a]);
        for (var b = 0; b < planned.length; b++) if (planned[b].isMain) ordered.push(planned[b]);

        var written = [];
        for (var w = 0; w < ordered.length; w++) {
            var it = ordered[w];
            var ok = false;
            try {
                if (it.binary) {
                    if (!_hasFn(aefs, 'writeFileBase64')) {
                        return _pkgFail('NO_AEFS', AEI18n.t('AEFS 缺少 writeFileBase64，无法写二进制附件: ') + it.path, written);
                    }
                    ok = !!(await aefs.writeFileBase64(it.absPath, it.base64));
                } else if (it.isMain) {
                    ok = !!(await _writeMainFile(aefs, it.absPath, it.text));
                } else {
                    ok = !!(await aefs.writeFile(it.absPath, it.text));
                }
            } catch (_) {
                ok = false;
            }
            if (!ok) return _pkgFail('WRITE_FAILED', AEI18n.t('写入失败: ') + it.path, written);
            written.push(it.path);
        }
        return { ok: true, written: written };
    }

    // ── 导出 ────────────────────────────────────────────────────────

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.skillFs = {
        normalizeRelPath: normalizeRelPath,
        collectFiles: collectFiles,
        copyTree: copyTree,
        removeTree: removeTree,
        readSkillFile: readSkillFile,
        writePackage: writePackage
    };

})(window);
