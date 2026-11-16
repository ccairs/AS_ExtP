(function (global) {
    'use strict';

    // ════════════════════════════════════════════════════════════════════
    // skillRemote：GitHub / jsDelivr 技能包（整个技能目录）解析与下载
    //
    // 职责边界（设计取舍）：
    //   1. 只做「解析 + 编排」：识别 URL → 枚举技能目录全部文件 → 逐个下载；
    //   2. 不直接联网、不碰 DOM / AEFS / Node：所有网络由调用方以函数注入
    //      （deps.fetchJson / fetchText / fetchBinary）。超时、SSRF 私网校验、
    //      重定向逐跳校验、Bridge 代理回退、单响应大小预检都是调用方责任；
    //   3. 不落盘：只返回 text / base64 条目，由 skillFs.writePackage 写盘。
    //
    // 为什么不在本模块里 fetch：面板 view.js 的下载链路带「redirect:'manual'
    //   逐跳 SSRF 复查 + Bridge 代理回退 + AbortController 取消」语义；而本模块
    //   必须能被单测完全离线验证（注入假 fetch，不联网）。网络策略留在调用方，
    //   本模块才能保持纯逻辑。
    //
    // 契约（view.js 依赖，勿随意改名）：
    //   parseSourceUrl(url) → null | {kind:'single',url}
    //                       | {kind:'repo',host,owner,repo,candidates,notes}
    //   resolveRemoteSkill(source, {fetchJson}) → {ok:true,ref,dir,files,bases,notes}
    //                                            | {ok:false,code,error}
    //   downloadSkillPackage(files, bases, deps, opts) → {ok:true,entries,totalBytes,warnings}
    //                                                   | {ok:false,code,error,path?}
    //   isBinaryPath(path) → boolean
    // ════════════════════════════════════════════════════════════════════

    var SKILL_MD = 'SKILL.md';
    var MAX_REF_CANDIDATES = 3;   // ref 含斜杠歧义时候选上限（契约定死 3）
    var CONTENTS_DIR_LIMIT = 30;  // Contents API 递归的目录数上限（防超大仓库拖死面板）
    var NOTE_LIMIT = 30;          // notes 上限，避免异常来源把 UI 提示刷爆

    // ─────────────────────────── 文本/二进制判定 ───────────────────────────
    //
    // 白名单扩展名 = 文本；白名单外扩展名 = 二进制；无扩展名 = 文本。
    // 为什么用白名单而不是黑名单：技能附件里可能出现任意格式，未知格式按二进制
    // 处理最多是「多走一次 base64 通道」；反过来把真二进制当文本会写出损坏文件。
    // 白名单覆盖常见文档/代码/配置；契约里列出的必选扩展名全部在内。
    var TEXT_EXTENSIONS = Object.create(null);
    (function () {
        var names = (
            // 契约明列
            'md txt json yaml yml js mjs cjs ts tsx jsx py sh bat ps1 css html htm xml '
            + 'csv tsv ini cfg toml dot gitignore gitattributes license svg srt vtt rb php '
            + 'java go rs c lua sql gradle properties env editorconfig npmrc '
            // 同族常见文本格式（附件里出现概率高，按文本处理更合理）
            + 'markdown mdx text jsonc json5 bash zsh fish cmd psm1 psd1 '
            + 'scss sass less styl xsl xslt h hpp hh cc cpp cxx hxx kt kts swift dart '
            + 'cs fs fsx vb scala clj cljs cljc edn ex exs erl hrl elm hs lhs ml mli pl pm pod '
            + 'awk sed vim conf config nvmrc gitmodules licence readme make mk cmake '
            + 'patch diff log lock map proto graphql gql tf tfvars hcl'
        ).split(/\s+/);
        for (var i = 0; i < names.length; i++) {
            if (names[i]) TEXT_EXTENSIONS[names[i]] = true;
        }
    })();

    function _extensionOf(path) {
        var p = String(path == null ? '' : path);
        var slash = p.lastIndexOf('/');
        if (slash < 0) slash = p.lastIndexOf('\\');
        var base = slash >= 0 ? p.slice(slash + 1) : p;
        var dot = base.lastIndexOf('.');
        // dot <= 0：无扩展名（LICENSE / Makefile / Dockerfile）或以 '.' 开头的隐藏文件
        // （.gitignore / .editorconfig），都按文本处理
        if (dot <= 0 || dot === base.length - 1) return '';
        return base.slice(dot + 1).toLowerCase();
    }

    function isBinaryPath(path) {
        var ext = _extensionOf(path);
        if (!ext) return false;   // 无扩展名 → 文本
        return TEXT_EXTENSIONS[ext] !== true;
    }

    // ─────────────────────────── 通用小工具 ───────────────────────────

    function _isString(v) { return typeof v === 'string'; }

    function _hasControl(s) { return /[\x00-\x1f\x7f]/.test(s); }

    function _errText(e) {
        var msg = (e && e.message) ? String(e.message) : String(e);
        return msg.length > 200 ? (msg.slice(0, 200) + '…') : msg;
    }

    function _fail(code, error, path) {
        var out = { ok: false, code: code, error: error };
        if (_isString(path) && path) out.path = path;
        return out;
    }

    function _safeDecodeSeg(seg) {
        try { return decodeURIComponent(seg); } catch (_) { return seg; }
    }

    // 手写 URL 拆分，不 new URL：本模块要能在 CEP 面板、独立加载、测试沙箱三种
    // 环境里跑；且我们只需要 host + path 段，不依赖 WHATWG 解析细节。
    function _splitHttpUrl(raw) {
        var m = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^\/?#]+)([^?#]*)/.exec(raw);
        if (!m) return null;
        var scheme = m[1].toLowerCase();
        if (scheme !== 'http' && scheme !== 'https') return null;
        var host = m[2].toLowerCase();
        var at = host.lastIndexOf('@');
        if (at >= 0) host = host.slice(at + 1);        // 去 userinfo
        var colon = host.indexOf(':');
        if (colon >= 0) host = host.slice(0, colon);   // 去端口
        var rawSegs = (m[3] || '').split('/');
        var segs = [];
        for (var i = 0; i < rawSegs.length; i++) {
            if (rawSegs[i] === '') continue;
            var dec = _safeDecodeSeg(rawSegs[i]);
            // 解码后出现路径分隔符/控制字符/`.`/`..` = 路径走私或畸形链接，
            // 按「不可识别」回退单文件安装（旧行为），不在解析层做任何修正
            if (dec === '' || dec === '.' || dec === '..'
                || dec.indexOf('/') >= 0 || dec.indexOf('\\') >= 0 || _hasControl(dec)) {
                return { host: host, segs: segs, unsafe: true };
            }
            segs.push(dec);
        }
        return { host: host, segs: segs, unsafe: false };
    }

    // GitHub owner/repo 只允许 ASCII 字母数字与 . _ -（GitHub 自身规则）
    function _isValidOwnerRepo(v) {
        return _isString(v) && /^[A-Za-z0-9._-]+$/.test(v) && v !== '.' && v !== '..';
    }

    function _isSafeSegment(seg) {
        if (!_isString(seg) || seg === '' || seg === '.' || seg === '..') return false;
        if (_hasControl(seg)) return false;
        if (seg.indexOf('/') >= 0 || seg.indexOf('\\') >= 0) return false;
        return true;
    }

    // ref（分支/标签名）安全校验：逐段过 _isSafeSegment，拒绝控制字符/反斜杠
    function _isSafeRef(ref) {
        if (!_isString(ref) || ref === '') return false;
        if (_hasControl(ref) || ref.indexOf('\\') >= 0) return false;
        var parts = ref.split('/');
        for (var i = 0; i < parts.length; i++) {
            if (!_isSafeSegment(parts[i])) return false;
        }
        return true;
    }

    // Windows 非法文件名字符（落盘端是 AEFS/Windows）。在下载前丢弃这类条目并记
    // notes，比整包卡在写盘失败的 INVALID_PATH 上更容易让用户理解。
    var WINDOWS_ILLEGAL = /[<>:"|?*]/;

    // 相对路径安全校验（目录、列表条目、下载文件路径共用）。
    // 拒绝：非字符串、控制字符、反斜杠、`..`、`.`、空段（连续斜杠/尾斜杠）、
    //       绝对路径（前导 '/'）、盘符、Windows 非法字符、段尾空格/句点。
    // 返回 true 表示可以安全地拼进目标技能目录。
    function _isSafeRelPath(rel) {
        if (!_isString(rel)) return false;
        if (rel === '') return true;              // 空串 = 目录根
        if (rel.charAt(0) === '/' || rel === '.' || rel === '..') return false;
        if (_hasControl(rel) || rel.indexOf('\\') >= 0) return false;
        var parts = rel.split('/');
        for (var i = 0; i < parts.length; i++) {
            var seg = parts[i];
            if (!_isSafeSegment(seg)) return false;
            if (WINDOWS_ILLEGAL.test(seg)) return false;
            // AEFS._checkPath 对任何含 '%' 的路径直接拒绝（percent 语义/走私防护）——
            // 到写盘才失败会让整包安装白下载，故在枚举阶段就丢弃并记 notes。
            if (seg.indexOf('%') >= 0) return false;
            // Windows 会静默剥离段尾空格/句点，落盘路径与列表不一致 → 视为非法
            if (/[ .]$/.test(seg)) return false;
        }
        return true;
    }

    // 列表条目路径归一：
    //   - jsDelivr flat API 的 name 固有地以 '/' 开头（是 API 格式，不是绝对路径
    //     条目），只在 allowLeadingSlash=true 时剥掉前导斜杠；
    //   - tree / contents API 的 path 本就不带前导斜杠，若出现则视为可疑条目丢弃。
    function _sanitizeListedPath(rawPath, allowLeadingSlash) {
        var p = _isString(rawPath) ? rawPath : '';
        if (!p) return null;
        if (allowLeadingSlash) p = p.replace(/^\/+/, '');
        return _isSafeRelPath(p) ? p : null;
    }

    // 仓库内路径 → 相对目标目录的路径；不在目录下返回 null
    function _relToDir(repoPath, dir) {
        if (!dir) return repoPath;
        if (repoPath === dir) return null;
        var prefix = dir + '/';
        if (repoPath.length <= prefix.length) return null;
        if (repoPath.slice(0, prefix.length) !== prefix) return null;
        return repoPath.slice(prefix.length);
    }

    function _encodePathForUrl(path) {
        if (!path) return '';
        var parts = String(path).split('/');
        var out = [];
        for (var i = 0; i < parts.length; i++) {
            out.push(encodeURIComponent(parts[i]));
        }
        return out.join('/');
    }

    function _joinUrl(base, path) {
        return String(base).replace(/\/+$/, '') + '/' + _encodePathForUrl(path);
    }

    // 主文件识别大小写不敏感：Windows 上 bootstrap 读 <dir>\SKILL.md 不区分大小写，
    // 仓库里写小写 skill.md 的技能若按精确名判定会被误拒（本地安装/重启加载却正常）。
    function _isMainSkillMd(p) {
        return _isString(p) && p.toLowerCase() === 'skill.md';
    }

    function _hasSkillMd(files) {
        for (var i = 0; i < files.length; i++) {
            if (_isMainSkillMd(files[i].path)) return true;
        }
        return false;
    }

    // ─────────────────────────── 1) parseSourceUrl ───────────────────────────
    //
    // 返回 null 表示输入不是可用字符串；{kind:'single'} 表示保持旧单文件下载行为。
    // 只有「能唯一/有限候选地推断出技能目录」的 GitHub 系链接才返回 kind:'repo'。

    // 列表条目收集：过滤非法路径 + 限定在 dir 下 + 去重 + 排序（确定性输出，
    // 下载顺序与 resolve 结果一致，测试可断言）
    function _collectFiles(list, dir, pushNote, allowLeadingSlash) {
        var files = [];
        var seen = Object.create(null);
        var dropped = 0;
        var samples = [];
        for (var i = 0; i < list.length; i++) {
            var entry = list[i] || {};
            var safePath = _sanitizeListedPath(entry.path, allowLeadingSlash);
            if (safePath === null) {
                // 契约：任何含 `..` / 绝对路径 / 控制字符的条目一律丢弃并记 notes
                dropped++;
                if (samples.length < 2) samples.push(String(entry.path));
                continue;
            }
            var rel = _relToDir(safePath, dir);
            if (rel === null) continue;
            if (seen[rel]) continue;
            seen[rel] = true;
            var size = (typeof entry.size === 'number' && isFinite(entry.size) && entry.size >= 0)
                ? entry.size : 0;   // 列表没给 size 时记 0（未知），下载时以实际内容为准
            files.push({ path: rel, size: size });
        }
        if (dropped > 0) {
            pushNote('已丢弃 ' + dropped + ' 个非法路径条目（含 ".."、绝对路径或控制字符等），如：'
                + samples.join('、'));
        }
        files.sort(function (a, b) { return a.path < b.path ? -1 : (a.path > b.path ? 1 : 0); });
        return files;
    }

    // 由「末段是 SKILL.md 的路径段」生成 ref 歧义候选：ref 从 1 段到最多 3 段，
    // dir = 剩余段去掉末尾 SKILL.md。
    // 例：main/skills/pdf/SKILL.md →
    //   {ref:'main', dir:'skills/pdf'}, {ref:'main/skills', dir:'pdf'},
    //   {ref:'main/skills/pdf', dir:''}
    function _skillDirCandidates(pathSegs) {
        var maxN = Math.min(MAX_REF_CANDIDATES, pathSegs.length - 1);
        var out = [];
        for (var n = 1; n <= maxN; n++) {
            var tail = pathSegs.slice(n);
            if (tail.length > 0 && tail[tail.length - 1] === SKILL_MD) tail = tail.slice(0, -1);
            out.push({ ref: pathSegs.slice(0, n).join('/'), dir: tail.join('/') });
        }
        return out;
    }

    // 由「目录链接路径段」生成 ref 歧义候选：tree / jsDelivr 目录链接没有
    // 「末段必为 SKILL.md」约束，ref 可取满全部段（dir 为空 = 仓库根目录）。
    function _treeDirCandidates(pathSegs) {
        var maxN = Math.min(MAX_REF_CANDIDATES, pathSegs.length);
        var out = [];
        for (var n = 1; n <= maxN; n++) {
            out.push({ ref: pathSegs.slice(0, n).join('/'), dir: pathSegs.slice(n).join('/') });
        }
        return out;
    }

    // 候选安全过滤 + notes 标注歧义；过滤后为空 → 回退 single（保持旧行为更安全）
    function _finishRepoReparse(url, host, owner, repo, rawCandidates, notes) {
        var candidates = [];
        for (var i = 0; i < rawCandidates.length; i++) {
            var c = rawCandidates[i];
            if (!_isSafeRef(c.ref)) {
                notes.push('已忽略不安全的 ref 候选：' + String(c.ref));
                continue;
            }
            if (!_isSafeRelPath(c.dir)) {
                notes.push('已忽略不安全的目录候选：' + String(c.dir));
                continue;
            }
            candidates.push({ ref: c.ref, dir: c.dir });
        }
        if (candidates.length === 0) return { kind: 'single', url: url };
        if (candidates.length > 1) {
            notes.push('链接中 ref 可能含斜杠，已生成 ' + candidates.length
                + ' 个候选（按 ref 由短到长依次尝试）');
        }
        return {
            kind: 'repo', host: host, owner: owner, repo: repo,
            candidates: candidates, notes: notes
        };
    }

    function _single(url) { return { kind: 'single', url: url }; }

    function _parseRawUrl(url, segs) {
        // 形态：raw.githubusercontent.com/<o>/<r>/<ref...>/<path...>/SKILL.md
        if (segs.length < 4) return _single(url);   // 至少 o/r/ref/SKILL.md 四段
        var owner = segs[0];
        var repo = segs[1];
        if (!_isValidOwnerRepo(owner) || !_isValidOwnerRepo(repo)) return _single(url);
        var rest = segs.slice(2);
        if (rest[rest.length - 1] !== SKILL_MD) return _single(url);   // 末段非 SKILL.md → 旧单文件
        var notes = [];
        return _finishRepoReparse(url, 'raw', owner, repo, _skillDirCandidates(rest), notes);
    }

    function _parseGithubUrl(url, segs) {
        if (segs.length < 2) return _single(url);
        var owner = segs[0];
        var repo = segs[1];
        // 容忍 clone URL 的 .git 后缀（用户常直接粘贴仓库 clone 链接）
        if (/\.git$/i.test(repo)) repo = repo.slice(0, -4);
        if (!_isValidOwnerRepo(owner) || !_isValidOwnerRepo(repo)) return _single(url);
        var rest = segs.slice(2);

        // 仓库根：ref=null → resolve 时先取 default_branch
        if (rest.length === 0) {
            return {
                kind: 'repo', host: 'github', owner: owner, repo: repo,
                candidates: [{ ref: null, dir: '' }],
                notes: ['仓库根链接：将按默认分支解析并在仓库根查找 ' + SKILL_MD]
            };
        }

        var marker = rest[0];
        if (marker === 'blob') {
            // blob 是文件链接：末段须为 SKILL.md 才能推断出技能目录，否则回退单文件
            var blobPath = rest.slice(1);
            if (blobPath.length < 2 || blobPath[blobPath.length - 1] !== SKILL_MD) return _single(url);
            return _finishRepoReparse(url, 'github', owner, repo, _skillDirCandidates(blobPath), []);
        }
        if (marker === 'tree') {
            // tree 是目录链接：路径段全部按目录处理（ref 歧义由候选依次试）
            var treePath = rest.slice(1);
            if (treePath.length === 0) return _single(url);
            var notes = ['目录链接：将枚举该目录下的全部文件（含 ' + SKILL_MD + '）'];
            return _finishRepoReparse(url, 'github', owner, repo, _treeDirCandidates(treePath), notes);
        }
        // issues / releases / pull 等非技能目录链接 → 旧单文件行为
        return _single(url);
    }

    function _parseJsdelivrUrl(url, segs) {
        // 契约形态：cdn.jsdelivr.net/gh/<o>/<r>@<ref>/<path...>
        // ref 由 @ 后到第一个 '/' 明确给出，不存在 GitHub 那种 ref 斜杠歧义。
        if (segs.length < 3 || segs[0] !== 'gh') return _single(url);
        var owner = segs[1];
        var repoWithRef = segs[2];
        var rest = segs.slice(3);
        var at = repoWithRef.indexOf('@');
        if (at < 0) return _single(url);   // 无 @ 版本 → 不满足契约形态，回退单文件
        var repo = repoWithRef.slice(0, at);
        var ref = repoWithRef.slice(at + 1);
        if (!_isValidOwnerRepo(owner) || !_isValidOwnerRepo(repo)) return _single(url);
        if (!_isSafeRef(ref)) return _single(url);
        // 路径末段 SKILL.md → dir 取其父目录；否则该路径本身就是目录
        var dir;
        if (rest.length > 0 && rest[rest.length - 1] === SKILL_MD) {
            dir = rest.slice(0, -1).join('/');
        } else {
            dir = rest.join('/');
        }
        if (!_isSafeRelPath(dir)) return _single(url);
        return {
            kind: 'repo', host: 'jsdelivr', owner: owner, repo: repo,
            candidates: [{ ref: ref, dir: dir }], notes: []
        };
    }

    function parseSourceUrl(url) {
        if (!_isString(url)) return null;
        var s = url.trim();
        if (!s) return null;
        var parts = _splitHttpUrl(s);
        if (!parts || parts.unsafe) return _single(s);
        if (parts.host === 'raw.githubusercontent.com') return _parseRawUrl(s, parts.segs);
        if (parts.host === 'github.com') return _parseGithubUrl(s, parts.segs);
        if (parts.host === 'cdn.jsdelivr.net') return _parseJsdelivrUrl(s, parts.segs);
        return _single(s);   // 其余链接保持旧单文件安装行为
    }

    // ─────────────────────────── 2) resolveRemoteSkill ───────────────────────────
    //
    // 目录枚举策略（单 candidate 内，按序尝试；任一策略失败只记原因并换下一条）：
    //   host !== 'jsdelivr'：GitHub Trees API → jsDelivr flat API → GitHub Contents API
    //   host === 'jsdelivr'：jsDelivr flat API → GitHub Trees API → GitHub Contents API
    //   - Trees API 的 ref 不能带 '/'（GitHub API 语义），带斜杠时跳过；
    //   - Contents API 递归是 ref 带斜杠时唯一可行的枚举方式，目录数上限 30；
    //   - ref=null（仓库根）先 GET /repos/{o}/{r} 取 default_branch。
    // 候选（ref 歧义）依次尝试，前一个候选列表里没有 SKILL.md 就换下一个。

    var STRATEGY_LABEL = {
        tree: 'GitHub Trees API',
        jsdelivr: 'jsDelivr flat API',
        contents: 'GitHub Contents API'
    };

    function _apiRepoBase(owner, repo) {
        return 'https://api.github.com/repos/' + owner + '/' + repo;
    }

    async function _callFetchJson(fetchJson, url) {
        var data = await fetchJson(url);
        if (_isString(data)) {
            // 兼容调用方注入「返回文本、由本模块 JSON.parse」的实现
            try { data = JSON.parse(data); } catch (_) { throw new Error('响应不是合法 JSON'); }
        }
        if (!data || typeof data !== 'object') throw new Error('响应不是 JSON 对象');
        return data;
    }

    async function _fetchDefaultBranch(fetchJson, owner, repo) {
        var data = await _callFetchJson(fetchJson, _apiRepoBase(owner, repo));
        var branch = data && data.default_branch;
        if (!_isString(branch) || branch === '') throw new Error('响应缺少 default_branch');
        if (!_isSafeRef(branch)) throw new Error('default_branch 含非法字符');
        return branch;
    }

    async function _listViaGithubTree(owner, repo, ref, fetchJson) {
        var url = _apiRepoBase(owner, repo) + '/git/trees/' + _encodePathForUrl(ref) + '?recursive=1';
        var data = await _callFetchJson(fetchJson, url);
        if (!Array.isArray(data.tree)) throw new Error('响应缺少 tree 数组');
        // truncated=true 表示列表不完整：不能拿残缺清单当技能包，换下一条策略
        if (data.truncated) throw new Error('文件列表被 GitHub 截断（仓库过大）');
        var list = [];
        for (var i = 0; i < data.tree.length; i++) {
            var e = data.tree[i];
            if (e && e.type === 'blob' && _isString(e.path)) {
                list.push({ path: e.path, size: typeof e.size === 'number' ? e.size : 0 });
            }
        }
        return list;
    }

    async function _listViaJsdelivrFlat(owner, repo, ref, fetchJson) {
        var url = 'https://data.jsdelivr.com/v1/package/gh/' + owner + '/' + repo
            + '@' + _encodePathForUrl(ref) + '/flat';
        var data = await _callFetchJson(fetchJson, url);
        if (!Array.isArray(data.files)) throw new Error('响应缺少 files 数组');
        var list = [];
        for (var i = 0; i < data.files.length; i++) {
            var e = data.files[i];
            if (e && _isString(e.name)) {
                list.push({ path: e.name, size: typeof e.size === 'number' ? e.size : 0 });
            }
        }
        return list;
    }

    // Contents API 递归（ref 带斜杠时唯一可行）：从目标目录开始 BFS，目录数上限 30。
    // 超上限直接判该策略失败——残缺清单装出来的技能包会少附件，比失败更糟。
    async function _listViaGithubContents(owner, repo, ref, dir, fetchJson) {
        var base = _apiRepoBase(owner, repo) + '/contents';
        var queue = [dir || ''];
        var visited = 0;
        var list = [];
        while (queue.length > 0) {
            if (visited >= CONTENTS_DIR_LIMIT) {
                throw new Error('目录数超过上限 ' + CONTENTS_DIR_LIMIT);
            }
            var d = queue.shift();
            visited++;
            var url = base + (d ? '/' + _encodePathForUrl(d) : '') + '?ref=' + encodeURIComponent(ref);
            var data = await _callFetchJson(fetchJson, url);
            if (!Array.isArray(data)) throw new Error('响应不是目录数组：' + (d || '/'));
            for (var i = 0; i < data.length; i++) {
                var e = data[i];
                if (!e || !_isString(e.path)) continue;
                if (e.type === 'file') list.push({ path: e.path, size: typeof e.size === 'number' ? e.size : 0 });
                else if (e.type === 'dir') queue.push(e.path);
                // symlink / submodule 不下载：内容不在树内，取到的会是链接文本或不可达路径
            }
        }
        return list;
    }

    async function _runListStrategy(kind, owner, repo, ref, dir, fetchJson) {
        if (kind === 'tree') return _listViaGithubTree(owner, repo, ref, fetchJson);
        if (kind === 'jsdelivr') return _listViaJsdelivrFlat(owner, repo, ref, fetchJson);
        return _listViaGithubContents(owner, repo, ref, dir, fetchJson);
    }

    function _listStrategiesFor(host, ref) {
        var order = (host === 'jsdelivr')
            ? ['jsdelivr', 'tree', 'contents']
            : ['tree', 'jsdelivr', 'contents'];
        var out = [];
        for (var i = 0; i < order.length; i++) {
            // Trees API 的 {ref} 是路径段，不能承载含 '/' 的 ref
            if (order[i] === 'tree' && ref.indexOf('/') >= 0) continue;
            out.push(order[i]);
        }
        return out;
    }

    function _buildBases(owner, repo, ref, dir) {
        var refPath = _encodePathForUrl(ref);
        var dirPath = _encodePathForUrl(dir);
        var raw = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + refPath;
        var jsdelivr = 'https://cdn.jsdelivr.net/gh/' + owner + '/' + repo + '@' + refPath;
        // 契约：dir 为空时 base 不带尾斜杠；拼文件 URL 时由 download 侧补 '/'
        if (dirPath) {
            raw += '/' + dirPath;
            jsdelivr += '/' + dirPath;
        }
        return { raw: raw, jsdelivr: jsdelivr };
    }

    function _coerceSource(source) {
        if (_isString(source)) return parseSourceUrl(source);
        if (source && typeof source === 'object' && _isString(source.kind)) return source;
        return null;
    }

    async function resolveRemoteSkill(source, deps) {
        var parsed = _coerceSource(source);
        if (!parsed) return _fail('INVALID_SOURCE', '链接解析结果为空，无法解析技能目录');
        if (parsed.kind !== 'repo') {
            return _fail('NOT_REPO_SOURCE', '该链接不是可枚举目录的 GitHub/jsDelivr 链接，请按单文件方式安装');
        }
        if (!_isValidOwnerRepo(parsed.owner) || !_isValidOwnerRepo(parsed.repo)
            || !Array.isArray(parsed.candidates) || parsed.candidates.length === 0) {
            return _fail('INVALID_SOURCE', '技能来源缺少 owner/repo/candidates');
        }
        if (!deps || typeof deps.fetchJson !== 'function') {
            return _fail('NO_FETCH_JSON', '缺少 deps.fetchJson，无法读取目录列表');
        }
        var fetchJson = deps.fetchJson;
        var notes = Array.isArray(parsed.notes) ? parsed.notes.slice(0, NOTE_LIMIT) : [];
        function addNote(msg) { if (notes.length < NOTE_LIMIT) notes.push(msg); }
        var reasons = [];
        function addReason(msg) { if (reasons.length < 12) reasons.push(msg); }
        var sawListing = false;   // 是否有策略成功返回过列表
        var sawNoSkillMd = false; // 列表成功但目标目录里没有 SKILL.md

        var candidates = parsed.candidates;
        for (var ci = 0; ci < candidates.length; ci++) {
            var cand = candidates[ci] || {};
            var dir = _isString(cand.dir) ? cand.dir : '';
            if (!_isSafeRelPath(dir)) {
                addReason('候选 ' + (ci + 1) + ' 目录不安全，已跳过');
                continue;
            }
            var ref = cand.ref;
            if (ref === null || ref === undefined || ref === '') {
                try {
                    ref = await _fetchDefaultBranch(fetchJson, parsed.owner, parsed.repo);
                    addNote('链接未指定版本，已按默认分支 "' + ref + '" 解析');
                } catch (e) {
                    addReason('默认分支解析失败（' + _errText(e) + '）');
                    continue;
                }
            }
            if (!_isSafeRef(ref)) {
                addReason('候选 ' + (ci + 1) + ' 的 ref 不安全，已跳过');
                continue;
            }

            var strategies = _listStrategiesFor(parsed.host, ref);
            var files = null;
            for (var si = 0; si < strategies.length; si++) {
                var kind = strategies[si];
                var rawList;
                try {
                    rawList = await _runListStrategy(kind, parsed.owner, parsed.repo, ref, dir, fetchJson);
                } catch (e) {
                    addReason(STRATEGY_LABEL[kind] + ' 失败：' + _errText(e));
                    continue;
                }
                sawListing = true;
                var collected = _collectFiles(rawList, dir, addNote, kind === 'jsdelivr');
                if (_hasSkillMd(collected)) {
                    files = collected;
                    if (si > 0) addNote(STRATEGY_LABEL[kind] + ' 回退成功');
                    break;
                }
                sawNoSkillMd = true;
                addReason(STRATEGY_LABEL[kind] + '：目录 "' + (dir || '/') + '" 下未找到 ' + SKILL_MD);
            }
            if (files) {
                if (ci > 0) addNote('已按候选 ' + (ci + 1) + '（ref=' + ref + '，dir=' + (dir || '/') + '）解析成功');
                return {
                    ok: true,
                    ref: ref,
                    dir: dir,
                    files: files,
                    bases: _buildBases(parsed.owner, parsed.repo, ref, dir),
                    notes: notes
                };
            }
        }

        if (sawNoSkillMd) {
            return {
                ok: false,
                code: 'NO_SKILL_MD',
                error: '在 ' + parsed.owner + '/' + parsed.repo + ' 的目标目录中未找到 '
                    + SKILL_MD + '（已尝试 ' + candidates.length + ' 个 ref/dir 候选）'
            };
        }
        if (!sawListing) {
            return {
                ok: false,
                code: 'LIST_FAILED',
                error: '技能目录列表获取失败：' + (reasons.length ? reasons.join('；') : '所有列表策略均不可用')
            };
        }
        return {
            ok: false,
            code: 'LIST_FAILED',
            error: '技能目录列表获取失败：' + reasons.join('；')
        };
    }

    // ─────────────────────────── 3) downloadSkillPackage ───────────────────────────
    //
    // 并发 worker 池（默认 4）：自实现而不用 Promise.all(files.map(...))，因为：
    //   - 需要限制并发（200 个文件同时发请求会打爆 CEP Chromium 连接池）；
    //   - 需要 fail-fast：任一文件失败即停止取新任务，已发出请求等待其落地；
    //   - 结果按文件索引收集，保证 entries 顺序与 files 完全一致（与完成时序无关）。

    var DEFAULT_LIMITS = {
        maxFiles: 200,
        maxFileBytes: 2 * 1024 * 1024,
        maxBinaryFileBytes: 8 * 1024 * 1024,
        maxTotalBytes: 20 * 1024 * 1024,
        concurrency: 4
    };

    function _pickLimit(value, fallback) {
        var n = Number(value);
        return (isFinite(n) && n > 0) ? n : fallback;
    }

    // base64 解码后的字节数估算（契约：二进制按 base64 长度估算）。
    // 减 padding：10 字节 → 16 字符含 '=='，实际 10；不去 padding 会高估 2 字节。
    function _estimateBase64Bytes(b64) {
        var s = String(b64 == null ? '' : b64).replace(/\s+/g, '');
        if (!s) return 0;
        var pad = 0;
        if (s.charAt(s.length - 1) === '=') pad++;
        if (s.length > 1 && s.charAt(s.length - 2) === '=') pad++;
        return Math.floor(s.length * 3 / 4) - pad;
    }

    // 单文件下载：先 raw，失败再 jsDelivr（同一 CDN 不做重试——重试语义归调用方）。
    async function _downloadOne(path, bases, deps, limits) {
        var binary = isBinaryPath(path);
        var urls = [_joinUrl(bases.raw, path)];
        if (_isString(bases.jsdelivr) && bases.jsdelivr !== '') {
            var alt = _joinUrl(bases.jsdelivr, path);
            if (alt !== urls[0]) urls.push(alt);   // 两个 base 相同则不必重复请求
        }
        var lastErr = null;
        for (var i = 0; i < urls.length; i++) {
            var url = urls[i];
            try {
                if (binary) {
                    if (typeof deps.fetchBinary !== 'function') {
                        // 正常路径已在 downloadSkillPackage 前置拦截，这里只是防御
                        return _fail('BINARY_UNSUPPORTED', '技能包含二进制文件（如 ' + path
                            + '），当前环境不支持二进制下载；请改用「文件路径」安装整个技能目录', path);
                    }
                    var b64 = await deps.fetchBinary(url);
                    if (!_isString(b64)) throw new Error('fetchBinary 未返回 base64 字符串');
                    var bytes = _estimateBase64Bytes(b64);
                    if (bytes > limits.maxBinaryFileBytes) {
                        return _fail('FILE_TOO_LARGE', '二进制文件超过单文件上限 '
                            + limits.maxBinaryFileBytes + ' 字节：' + path, path);
                    }
                    return { ok: true, entry: { path: path, base64: b64, binary: true }, bytes: bytes };
                }
                var text = await deps.fetchText(url);
                // null/undefined 视为该 CDN 失败（契约要求返回 string）：否则会把
                // 「下载失败」静默写成空文件，比直接报错更难排查。空串 '' 是合法空文件。
                if (text === null || text === undefined) throw new Error('fetchText 未返回文本');
                if (!_isString(text)) text = String(text);
                // 契约：文本按字符长度估字节。不能用 UTF-8 字节数——中文 skill 会被
                // 放大近 3 倍误判超限（本上限只防内存耗尽，不追求精确字节语义）。
                var textBytes = text.length;
                if (textBytes > limits.maxFileBytes) {
                    return _fail('FILE_TOO_LARGE', '文本文件超过单文件上限 '
                        + limits.maxFileBytes + ' 字节：' + path, path);
                }
                return { ok: true, entry: { path: path, text: text }, bytes: textBytes };
            } catch (e) {
                lastErr = e;
                if (typeof deps.log === 'function') {
                    try {
                        deps.log('下载失败（尝试下一个 CDN）：' + url + '：' + _errText(e));
                    } catch (_) { /* 日志回调异常不影响主流程 */ }
                }
            }
        }
        return _fail('DOWNLOAD_FAILED', '文件下载失败（raw 与 jsDelivr 均不可用）：' + path
            + '（' + _errText(lastErr) + '）', path);
    }

    async function downloadSkillPackage(files, bases, deps, opts) {
        deps = deps || {};
        opts = opts || {};
        if (!Array.isArray(files)) return _fail('INVALID_ARGS', 'files 必须是数组');
        if (!bases || !_isString(bases.raw) || bases.raw === '') {
            return _fail('INVALID_ARGS', '缺少 bases.raw');
        }
        if (typeof deps.fetchText !== 'function') return _fail('INVALID_ARGS', '缺少 deps.fetchText');

        var limits = {
            maxFiles: _pickLimit(opts.maxFiles, DEFAULT_LIMITS.maxFiles),
            maxFileBytes: _pickLimit(opts.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
            maxBinaryFileBytes: _pickLimit(opts.maxBinaryFileBytes, DEFAULT_LIMITS.maxBinaryFileBytes),
            maxTotalBytes: _pickLimit(opts.maxTotalBytes, DEFAULT_LIMITS.maxTotalBytes),
            concurrency: _pickLimit(opts.concurrency, DEFAULT_LIMITS.concurrency)
        };
        limits.concurrency = Math.max(1, Math.min(16, Math.floor(limits.concurrency)));

        // ── 前置校验（不发起任何网络请求）──
        // 先校验路径/数量/SKILL.md/二进制能力，避免下了一半才失败、白耗请求。
        var norm = [];
        for (var i = 0; i < files.length; i++) {
            var f = files[i] || {};
            var p = f.path;
            if (!_isString(p) || p === '') return _fail('INVALID_ARGS', 'files[' + i + '].path 非法');
            if (!_isSafeRelPath(p)) return _fail('INVALID_PATH', '文件路径非法：' + p);
            norm.push({ path: p, size: typeof f.size === 'number' ? f.size : 0 });
        }
        if (norm.length === 0) return _fail('NO_SKILL_MD', '技能包为空，缺少 ' + SKILL_MD);
        if (norm.length > limits.maxFiles) {
            return _fail('TOO_MANY_FILES', '技能包含 ' + norm.length + ' 个文件，超过上限 '
                + limits.maxFiles + '；请改用「文件路径」安装本地技能目录');
        }
        var skillIndex = -1;
        for (i = 0; i < norm.length; i++) {
            if (_isMainSkillMd(norm[i].path)) { skillIndex = i; break; }
        }
        if (skillIndex < 0) return _fail('NO_SKILL_MD', '技能包缺少 ' + SKILL_MD + '，拒绝安装');
        // 契约：SKILL.md 必须是文本。白名单判定下 SKILL.md 恒为文本，这里是显式护栏，
        // 防止将来改判定规则后 SKILL.md 被走 base64 通道。
        if (isBinaryPath(norm[skillIndex].path)) {
            return _fail('SKILL_MD_NOT_TEXT', SKILL_MD + ' 必须按文本下载，当前被判定为二进制');
        }
        var binaryCount = 0;
        var firstBinaryPath = '';
        for (i = 0; i < norm.length; i++) {
            if (isBinaryPath(norm[i].path)) {
                binaryCount++;
                if (!firstBinaryPath) firstBinaryPath = norm[i].path;
            }
        }
        if (binaryCount > 0 && typeof deps.fetchBinary !== 'function') {
            return _fail('BINARY_UNSUPPORTED', '技能包含 ' + binaryCount + ' 个二进制文件（如 '
                + firstBinaryPath + '），当前环境不支持二进制下载；请改用「文件路径」安装整个技能目录',
                firstBinaryPath);
        }

        var warnings = [];
        if (!_isString(bases.jsdelivr) || bases.jsdelivr === '') {
            warnings.push('没有 jsDelivr 回退地址，仅在 raw.githubusercontent.com 上尝试下载');
        }

        var entries = new Array(norm.length);
        var totalBytes = 0;
        var doneCount = 0;
        var nextIndex = 0;
        var failure = null;
        var onProgress = (typeof opts.onProgress === 'function') ? opts.onProgress : null;

        async function worker() {
            while (true) {
                if (failure) return;           // fail-fast：失败后不再取新任务
                var idx = nextIndex++;         // 单线程自增，天然无竞争
                if (idx >= norm.length) return;
                var item = norm[idx];
                var res = await _downloadOne(item.path, bases, deps, limits);
                if (!res.ok) {
                    if (!failure) failure = res;
                    return;
                }
                // JS 单线程，多 worker 累加 totalBytes 安全；超总量立即停止
                totalBytes += res.bytes;
                if (totalBytes > limits.maxTotalBytes) {
                    if (!failure) {
                        failure = _fail('TOTAL_TOO_LARGE', '技能包总大小超过上限 '
                            + limits.maxTotalBytes + ' 字节；请改用「文件路径」安装本地技能目录',
                            item.path);
                    }
                    return;
                }
                entries[idx] = res.entry;
                doneCount++;
                if (onProgress) {
                    try { onProgress({ done: doneCount, total: norm.length, path: item.path }); } catch (_) {}
                }
            }
        }

        var workers = [];
        for (var w = 0; w < limits.concurrency; w++) workers.push(worker());
        await Promise.all(workers);
        if (failure) return failure;
        return { ok: true, entries: entries, totalBytes: totalBytes, warnings: warnings };
    }

    // ─────────────────────────── 导出 ───────────────────────────

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.skillRemote = {
        parseSourceUrl: parseSourceUrl,
        resolveRemoteSkill: resolveRemoteSkill,
        downloadSkillPackage: downloadSkillPackage,
        isBinaryPath: isBinaryPath
    };

})(window);
