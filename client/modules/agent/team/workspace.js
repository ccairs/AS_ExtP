(function (global) {
    'use strict';
    // 团队工作区：团队会话的**共享产物目录**
    //   <数据Dir>/agent/team/<团队会话id>/
    // 文件约定：**只认工作区文件表（WORKSPACE_FILES）里的文件**，目前两件：brief.md（计划书）
    // 与 storyboard.md（文字分镜）。
    // 表外路径对**模型面**一律 not_allowed；工作区自己的文件（团队清单 tasks.json 及其动态备份名）由
    // 内部调用方带 opts.internal 放行（枚举白名单）。
    // （不再约定 worklog.md / subtasks/<id>.md —— 进度由团队任务表承载，产物由回执/消息承载）。
    //
    // 只读面与写面：
    //   · read        — `read_workspace` 工具的实现体（只读，路径必须在工作区内）；
    //   · ensureDir   — 面板侧预建目录（面板侧 AEFS 预建）；
    //   · write       — `write_workspace` 工具的实现体（replace/append，单次上限 256K 字符）；
    //   · enqueueWrite— 同文件串行写队列（write 也经它落盘）；
    //   · canWrite    — 写能力探测（装配层据此决定要不要暴露 write_workspace）。
    // 「读到的/写到的到底是不是工作区里的那个文件」是正确性核心，路径判据因此集中在一个
    // 函数里（见 _normalizeRel 与 resolvePath）——**写入不另写一套校验**。
    //
    // 依赖全部**注入**（本文件不读任何全局：便于单测注入假 FS，也避免"数据目录来自哪"有两处真相）：
    //   aefs        — 文件系统。按能力探测：读 readFileResult（三态，首选）/ readFile（回退）；
    //                 写 writeFileResult（三态 Result，首选——**生产 aefs.js 目前没有这个方法**，
    //                 见 _writeCap 的注释）/ writeFile（返回 Promise<boolean>）/ writeFileSync
    //                 （同步回退，返回 boolean；链上有它，契约注释也要有）；
    //                 建目录 mkdir（Promise，首选）/ mkdirSync（回退）。生产由装配侧传 global.AEFS。
    //   getDataDir  — () => 数据目录（返回字符串或 { dir } 都接受——生产的 AEShared.getDataDir()
    //                 返回的是 { dir } 对象）。也接受直接给 dataDir 字符串（测试/审计装载用）。
    //
    // 路径安全的口径（五条，全部在下面两个函数里兑现）：
    //   ① 绝对路径一律拒：盘符 `C:\x` / 盘符相对 `C:x` / UNC `\\srv\share` / 根 `/x`；
    //   ② `..` 段一律拒——**包括** `.. `（尾部空格）与 `...`（尾部点）这类 Windows 会先剥掉
    //      尾空格/尾点再解释的写法：不先剥就判，`'.. '` 能绕过越界判据；
    //   ③ `\` 与 `/` 混用先归一（Windows 上两者是同一分隔符，不归一会让 `..\` 漏检）；
    //   ④ 段名不得只由点/空格组成（`...` 折叠后语义含混），`:` 等非法字符拒（`brief.md:x`
    //      是 NTFS 数据流，等于在文件里藏了第二份内容）；
    //   ⑤ 拼装之后再复核一次「结果确实落在工作区根之内」：先拒含 `..` 段的串，再做大小写不敏感的
    //      前缀比对 —— 上面任一条判据失效时还有这一层（防御纵深：安全边界不靠单点判据）。
    // 注：AEFS 自己还有更严的判据（拒 `%`、引号、DOS 保留设备名——见 aefs.js 的 _checkPath）。
    // 本层**不重复实现**那一套：被数据层拒时如实透传 reason='rejected'，不做第二份判据源。

    // 单次读取上限：64KB 按**字符（UTF-16 码元）**计，与平台 readFile 的 maxChars 同口径——
    // 若按 UTF-8 字节计，中文内容只能读到三分之一，「64KB」的广告与实际返回量也对不上。
    var MAX_READ_CHARS = 64 * 1024;
    // 单次写入上限：256KB 按**字符（UTF-16 码元）**计，与 MAX_READ_CHARS 同口径——按 UTF-8
    // 字节计会让中文内容只能写三分之一，而且"256KB"的广告与实际可写量也对不上。
    var MAX_WRITE_CHARS = 256 * 1024;
    // ── 工作区文件表（**唯一真相源**）────────────────────────────
    // 「工作区里有哪几个文件」只在这张表里写一次：工具的 enum、读的缺省值、可写性全部从它派生
    // （teamTools 注册时经 listFiles() 取）。**以后加工作区文件类型 = 这里加一行**——不在
    // teamTools 的 schema、工具描述、提示词、文档里各抄一份文件名清单（那是必然漂移的写法）。
    //   name        真实文件名（相对工作区根；以后允许带子目录，如 'notes/x.md'）
    //   kind        语义名（面板/日志用；不进模型可见文案）
    //   label/desc  一句话说明（desc 进工具描述，说清"什么时候写它"）
    //   writable    能不能被 write_workspace 写（只读类文件以后可以设 false）
    //   defaultRead read_workspace 省略 path 时读哪个（表里应恰有一个）
    // 当前两件：计划书（brief.md）与文字分镜（storyboard.md）——分镜从计划书里剥离，单独成文件；
    // 其余协作信息走消息与团队任务表，产物走消息回执。
    var WORKSPACE_FILES = [
        {
            name: 'brief.md',
            kind: 'brief',
            get label() { return AEI18n.t('计划书'); },
            desc: '本次任务的目标、约束与验收判据',
            writable: true,
            defaultRead: true
        },
        {
            name: 'storyboard.md',
            kind: 'storyboard',
            get label() { return AEI18n.t('文字分镜'); },
            desc: '按镜头顺序写的文字分镜：镜头列表与每镜画面内容',
            writable: true,
            defaultRead: false
        }
    ];

    // 表查一次就够（表是常量，运行期不变）：合法文件集合 + 缺省文件 + 可写集合。
    function _fileEntry(rel) {
        if (typeof rel !== 'string' || !rel) return null;
        for (var i = 0; i < WORKSPACE_FILES.length; i++) {
            // 大小写不敏感（Windows 文件系统不区分）⇒ 命中后统一回**表里的规范名**，
            // 同一文件不该因大小写不同在回执里出现两个"不同"路径。
            if (WORKSPACE_FILES[i].name.toLowerCase() === rel.toLowerCase()) return WORKSPACE_FILES[i];
        }
        return null;
    }
    function _fileNamesText() {
        var out = [];
        for (var i = 0; i < WORKSPACE_FILES.length; i++) out.push(WORKSPACE_FILES[i].name);
        return out.join(' / ');
    }
    function _defaultFile() {
        for (var i = 0; i < WORKSPACE_FILES.length; i++) {
            if (WORKSPACE_FILES[i].defaultRead === true) return WORKSPACE_FILES[i].name;
        }
        return WORKSPACE_FILES.length ? WORKSPACE_FILES[0].name : '';
    }
    // 给工具层派生 schema 用（返回副本：调用方改不动真相源）
    function listFiles() {
        var out = [];
        for (var i = 0; i < WORKSPACE_FILES.length; i++) {
            var f = WORKSPACE_FILES[i];
            out.push({
                name: f.name, kind: f.kind, label: f.label, desc: f.desc,
                writable: f.writable === true, defaultRead: f.defaultRead === true
            });
        }
        return out;
    }

    // 工作区在数据目录下的相对位置（与 sessionStore 的 `<数据Dir>/agent/sessions/...` 同根）
    var TEAM_SUBPATH = 'agent/team';

    // path 可选：读取类失败的调用方（工具层/UI）需要拿到"被拒的是哪个绝对路径"，
    // 但路径非法时（越界/形态错）压根没有可信的绝对路径可给——所以按需附带，不硬塞。
    function _fail(reason, message, path) {
        var r = { ok: false, reason: reason, message: message };
        if (typeof path === 'string' && path) r.path = path;
        return r;
    }

    function _msg(e) {
        return (e && e.message) ? String(e.message) : String(e);
    }

    function createWorkspace(opts) {
        var o = opts || {};

        function _fs() {
            return (o.aefs && typeof o.aefs === 'object') ? o.aefs : null;
        }

        // 同文件串行写队列的表：键 = 归一后的团队会话 id + '|' + 归一后的相对路径（见 _enqueue）。
        // 条目结算即删键（不长住一张越来越大的表）。
        var _queues = {};

        // 数据目录：函数优先（每次调用都重新取——用户可以在面板里换数据目录，缓存住就会写到旧根），
        // 拿不到一律返回空串（调用方据此显式失败，绝不退回相对路径或当前目录）。
        function _dataDir() {
            var v = (o.dataDir !== undefined) ? o.dataDir : '';
            var src = (typeof o.getDataDir === 'function') ? o.getDataDir : v;
            if (typeof src === 'function') {
                try { src = src(); } catch (_) { return ''; }
            }
            if (src && typeof src === 'object') src = src.dir;      // AEShared.getDataDir() → { dir }
            if (typeof src !== 'string') return '';
            return src.trim().replace(/[\\/]+$/, '');               // 去掉尾部分隔符：拼接点自己带 '/'
        }

        // 团队会话 id 会**直接进路径**，按与相对路径同级的严格度校验：只允许 [A-Za-z0-9_-]
        //（生产形态 `team_<时间戳>_<随机段>`）。空串/含分隔符/含点/中文一律判非法——
        // 非法 id 不是「读不到」，而是显式失败（bad_session_id）：id 为 `..` 时根会指到
        // <数据Dir>/agent/，那是**别的地方**，绝不能靠后续路径判据兜。
        function _sessionId(id) {
            if (typeof id !== 'string') return '';
            var s = id.trim();
            if (!s || s.length > 128) return '';
            return /^[A-Za-z0-9_-]+$/.test(s) ? s : '';
        }

        // 工作区根（总是以 '/' 结尾，拼接不会粘连）。会话 id / 数据目录任一不可用 ⇒ 空串。
        function root(teamSessionId) {
            var id = _sessionId(teamSessionId);
            if (!id) return '';
            var base = _dataDir();
            if (!base) return '';
            return base + '/' + TEAM_SUBPATH + '/' + id + '/';
        }

        function _rootOrFail(teamSessionId) {
            if (!_sessionId(teamSessionId)) {
                return _fail('bad_session_id', '团队会话 id 非法或缺失: ' + JSON.stringify(teamSessionId));
            }
            var dir = root(teamSessionId);
            if (!dir) return _fail('no_data_dir', '数据目录不可用（getDataDir 未注入或返回空字符串）');
            return { ok: true, path: dir };
        }

        // ── 唯一的安全边界①：相对路径 → 归一化相对路径 ────────────────────────────
        // 返回 { ok:true, rel } 或显式失败。rel 一律用 '/' 连接、大小写**原样保留**
        //（Windows 按大小写不敏感解析，保留原样才能把用户/模型写的路径原样回报）。
        function _normalizeRel(raw) {
            if (typeof raw !== 'string') {
                return _fail('bad_path', '路径参数必须是字符串，收到 ' + JSON.stringify(raw));
            }
            var s = raw.trim();
            if (!s) return _fail('bad_path', '路径为空');
            // 绝对形态：盘符（`C:\x` / `C:x`）、UNC 与根（`\\srv\share` / `//srv` / `/x`）。
            // 与 shared/platformTools.js 的 _isAbsFsPath 同口径（盘符后不要求分隔符——
            // `C:x` 是盘符相对路径，同样能指到工作区外）。
            if (/^[a-zA-Z]:/.test(s) || s.charAt(0) === '/' || s.charAt(0) === '\\') {
                return _fail('out_of_bounds', '只接受工作区内的相对路径，绝对路径一律拒绝: ' + raw);
            }
            var parts = s.split(/[\\/]+/);          // ③ 分隔符先归一（'\' 与 '/' 等价）
            var segs = [];
            for (var i = 0; i < parts.length; i++) {
                var seg = parts[i];
                // ② Windows 会剥掉段尾的空格与点（`foo.` / `foo ` 与 `foo` 是同一个文件）——
                // 必须先剥再判 `..`，否则 `'.. '` 与 `'...'` 会绕过越界判据。
                var stripped = seg.replace(/[ .]+$/, '');
                if (seg === '..' || stripped === '..') {
                    return _fail('out_of_bounds', '路径中含上级目录段（..），越出工作区的路径一律拒绝: ' + raw);
                }
                if (stripped === '') {
                    // 单点与空段（重复分隔符 `a//b`、尾部分隔符 `subtasks/`）都按路径语义折叠：
                    // 它们是同一个位置，不折叠会让同一文件出现多个"不同"路径。
                    if (seg === '.' || seg === '') continue;
                    // ④ 纯点/纯空格的段名（`...`、`   `）：折叠后语义含混，拒绝而不是猜
                    return _fail('bad_path', '路径段名不能只由点或空格组成: ' + JSON.stringify(seg));
                }
                if (/[<>:"|?*\u0000-\u001f]/.test(stripped)) {
                    return _fail('bad_path', '路径段含非法字符（: 会变成 NTFS 数据流）: ' + JSON.stringify(seg));
                }
                segs.push(stripped);
            }
            if (!segs.length) return _fail('bad_path', '路径为空，或只指向工作区根目录（缺文件名）');
            return { ok: true, rel: segs.join('/') };
        }

        // 结果必须落在工作区根之内：① 拒含 `..` 段的串（纵深——上游任何一条判据失效时，
        // 这里也不放行；数据根/会话 id 里带 `..` 时同样拒，AEFS 层本来也拒这类路径）；
        // ② 再做大小写不敏感 + 分隔符归一的前缀比对（根以 '/' 结尾）。
        function _withinRoot(abs, dir) {
            var a = String(abs).replace(/\\/g, '/').toLowerCase();
            var r = String(dir).replace(/\\/g, '/').toLowerCase();
            if (/(^|\/)\.\.(\/|$)/.test(a)) return false;
            if (r.charAt(r.length - 1) !== '/') r += '/';
            return a.length > r.length && a.indexOf(r) === 0;
        }

        // ── 唯一的安全边界②：相对路径 → 绝对路径（**唯一的拼装点**）────────────────
        // 所有公开方法都必须经这里拿路径：散落的 `root + 输入` 拼接就是散落的漏洞。
        // 缺省（undefined/null/空串）读 brief.md；非字符串显式报错（不静默改义）。
        function resolvePath(relPath, teamSessionId, opts) {
            var r = _rootOrFail(teamSessionId);
            if (!r.ok) return r;
            var dir = r.path;
            var raw = relPath;
            if (raw === undefined || raw === null) raw = _defaultFile();
            if (typeof raw === 'string' && !raw.trim()) raw = _defaultFile();
            var n = _normalizeRel(raw);
            if (!n.ok) return n;
            // 工作区文件白名单（**排在词法判据之后**）：越界/非法字符/数据流仍报各自的 reason，
            // 只有"形态合法但不在工作区文件表里"才报 not_allowed。命中后用表里的规范名。
            // **只约束模型**：工作区内部调用（团队任务清单 tasks.json、以及它的损坏备份
            // 「tasks.json.corrupt-<ts>.bak」这类动态文件名）经 opts.internal 放行——它们仍过上面
            // 五条词法判据，所以即便文件名算错也出不了本会话的工作区。
            var name = n.rel;
            if (!(opts && opts.internal === true)) {
                var wf = _fileEntry(n.rel);
                if (!wf) {
                    return _fail('not_allowed', '工作区只有这些文件：' + _fileNamesText()
                        + '（收到 ' + JSON.stringify(n.rel) + '）', dir + n.rel);
                }
                name = wf.name;
                // writable 是**真闸**不是建议：只在写面生效。
                // 写面 enum 已只列可写文件，这里是第二道（enum 是建议、executor 不校验 schema）。
                if (opts && opts.forWrite === true && wf.writable !== true) {
                    return _fail('read_only',
                        '这个工作区文件是只读的（表里 writable=false）：' + wf.name, dir + wf.name);
                }
            }
            var abs = dir + name;
            if (!_withinRoot(abs, dir)) {
                return _fail('out_of_bounds', '拼装结果不在工作区内，已拒绝: ' + abs);
            }
            return { ok: true, path: abs, rel: name, root: dir };
        }

        // 文本读取（opts.internal=true 供工作区内部文件用，见 resolvePath）：优先 AEFS 的**三态** Result 版（readFileResult）——只有它能区分
        // 「文件不存在」（NOT_FOUND ⇒ 显式 not_found）与「通道故障/被数据层拒绝」
        //（CHANNEL_FAILURE / REJECTED）。readFile 把两者都折叠成 null，
        // 用它时只能回一句笼统的「读不到」（下面如实写明，不假装知道原因）。
        function _readText(fsx, abs) {
            if (typeof fsx.readFileResult === 'function') {
                var p;
                try { p = fsx.readFileResult(abs); } catch (e) {
                    return Promise.resolve(_fail('read_failed', '文件读取异常: ' + _msg(e)));
                }
                return Promise.resolve(p).then(function (r) {
                    if (r && r.ok === true && typeof r.data === 'string') return { ok: true, text: r.data };
                    var code = (r && r.error && r.error.code) || '';
                    var detail = (r && r.error && r.error.message) || '';
                    if (code === 'NOT_FOUND') {
                        // 文件不存在必须是**显式失败**：静默返回空串会让模型以为"文件是空的"，
                        // 从而按"空任务书"往下做，而不是告诉用户文件还没写。
                        return _fail('not_found', '工作区内没有这个文件: ' + abs);
                    }
                    if (code === 'REJECTED') {
                        return _fail('rejected', '路径被数据层拒绝' + (detail ? '（' + detail + '）' : ''));
                    }
                    return _fail('read_failed', '文件读取失败' + (detail ? '（' + detail + '）' : '') + ': ' + abs);
                }, function (e) {
                    return _fail('read_failed', '文件读取异常: ' + _msg(e));
                });
            }
            if (typeof fsx.readFile === 'function') {
                var p2;
                try { p2 = fsx.readFile(abs); } catch (e) {
                    return Promise.resolve(_fail('read_failed', '文件读取异常: ' + _msg(e)));
                }
                return Promise.resolve(p2).then(function (text) {
                    if (typeof text === 'string') return { ok: true, text: text };
                    return _fail('not_found', '读不到该文件（不存在，或读取通道失败——注入的 AEFS 只有折叠版 '
                        + 'readFile，无法区分两者）: ' + abs);
                }, function (e) {
                    return _fail('read_failed', '文件读取异常: ' + _msg(e));
                });
            }
            return Promise.resolve(_fail('no_read', '注入的文件系统没有 readFileResult/readFile'));
        }

        // 预建工作区目录（面板侧在团队会话建立时调用；AEFS 的 mkdir 幂等）。
        // 返回 Promise：注入的 AEFS.mkdir 是异步的（真异步 fetch，不阻塞面板主线程），
        // 只有 mkdirSync 时才立刻完成——两种情况都回同一个形态，调用方不必分叉。
        function ensureDir(teamSessionId) {
            var r = _rootOrFail(teamSessionId);
            if (!r.ok) return Promise.resolve(r);
            var dir = r.path;
            var fsx = _fs();
            if (!fsx) return Promise.resolve(_fail('no_fs', '文件系统未注入（opts.aefs）'));
            if (typeof fsx.mkdir === 'function') {
                var p;
                try { p = fsx.mkdir(dir); } catch (e) {
                    return Promise.resolve(_fail('mkdir_failed', '预建工作区目录异常: ' + _msg(e)));
                }
                return Promise.resolve(p).then(function (ok) {
                    // 严格判 true：undefined/null 一律视为失败（"可能建成了"当成功会让后续写入
                    // 落到不存在的目录上，失败点被推远到更难定位的地方）
                    if (ok === true) return { ok: true, path: dir };
                    return _fail('mkdir_failed', '预建工作区目录失败（AEFS.mkdir 未返回 true）: ' + dir);
                }, function (e) {
                    return _fail('mkdir_failed', '预建工作区目录异常: ' + _msg(e));
                });
            }
            if (typeof fsx.mkdirSync === 'function') {
                var okSync = false;
                try { okSync = (fsx.mkdirSync(dir) !== false); } catch (e) {
                    return Promise.resolve(_fail('mkdir_failed', '预建工作区目录异常: ' + _msg(e)));
                }
                if (okSync) return Promise.resolve({ ok: true, path: dir });
                return Promise.resolve(_fail('mkdir_failed', '预建工作区目录失败（AEFS.mkdirSync 返回 false）: ' + dir));
            }
            return Promise.resolve(_fail('no_mkdir', '注入的文件系统没有 mkdir/mkdirSync'));
        }

        // 读取工作区内的文本文件。返回 Promise：
        //   成功 { ok:true, path（绝对路径）, rel（相对路径，下次调用用它）, content, truncated, size（截断前总字符数） }
        //   失败 { ok:false, reason, message, path? }（reason: bad_session_id / no_data_dir / bad_path /
        //        out_of_bounds / no_fs / not_found / rejected / read_failed / no_read）
        function read(relPath, teamSessionId, opts) {
            var target = resolvePath(relPath, teamSessionId, opts);
            if (!target.ok) return Promise.resolve(target);
            var fsx = _fs();
            if (!fsx) return Promise.resolve(_fail('no_fs', '文件系统未注入（opts.aefs）'));
            return _readText(fsx, target.path).then(function (r) {
                if (!r || r.ok !== true) {
                    return _fail((r && r.reason) || 'read_failed', (r && r.message) || '文件读取失败', target.path);
                }
                var text = r.text;
                var truncated = (text.length > MAX_READ_CHARS);
                return {
                    ok: true,
                    path: target.path,
                    rel: target.rel,
                    content: truncated ? text.slice(0, MAX_READ_CHARS) : text,
                    truncated: truncated,
                    size: text.length
                };
            });
        }

        // ── 写面：能力探测 → 参数校验 → 队列 → 父目录 → 落盘 ─────────────────

        // 写能力探测（**唯一判据**：装配层问 canWrite、写路径问 _writeCap，工具层不另判）。
        // 通道链（同步回退不能漏：sync-only 宿主上 canWrite() 会假 false
        // ⇒ write_workspace 静默不注册）：
        //   writeFileResult（三态 Result 版，**生产 aefs 目前没有**，留给将来落地）
        //   → writeFile（Promise<boolean>，生产走这条）
        //   → writeFileSync（boolean，同步回退）
        //   → ''（no_write）
        // 三态版只有它能区分「被数据层拒绝」与「通道故障」；折叠版两者都回 false。
        // **不**拿 writeFileLlm 顶替：它是「LLM 可写任意非系统绝对路径」的通道（绕过命名空间
        // 白名单，面板侧另有人工确认），在这里顺手用它等于把工作区写升级成任意路径写。
        function _writeCap(fsx) {
            if (!fsx) return '';
            if (typeof fsx.writeFileResult === 'function') return 'result';
            if (typeof fsx.writeFile === 'function') return 'plain';
            if (typeof fsx.writeFileSync === 'function') return 'sync';
            return '';
        }

        // 折叠版失败的统一措辞（plain / sync 两条）：false 的含义不唯一——不存在 / 被数据层拒绝 /
        // 通道故障都回假值。这里不假装知道原因，**并把 AEFS.lastError() 的原文拼上**（
        // 契约两处明写要带原文，aefs 每个失败分支都会写 _lastError 且导出 lastError()）。
        // lastError 是「**最近一次**失败原因且成功不清空」（aefs.js 自述），直接读会
        // 把**别处的旧错误**当成本次写失败的原因（甚至指向上一次 readFile 的失败）。故只在
        // 「写前快照 ≠ 写后原文」时才拼——原文没变说明本次失败没往它写东西，宁可不给也不误导。
        function _plainWriteFailure(fsx, abs, before) {
            var detail = '';
            try {
                if (fsx && typeof fsx.lastError === 'function') detail = String(fsx.lastError() || '');
            } catch (_) { detail = ''; }
            var fresh = (detail && detail !== before) ? detail : '';
            return _fail('write_failed', '文件写入失败（折叠版写入通道，无法区分「被数据层拒绝」与'
                + '「通道故障」）' + (fresh ? '；AEFS: ' + fresh : '') + ': ' + abs, abs);
        }

        // 写前快照：用于判断 lastError 是不是**本次**写入写的（见上）。
        function _lastErrorSnapshot(fsx) {
            try {
                return (fsx && typeof fsx.lastError === 'function') ? String(fsx.lastError() || '') : '';
            } catch (_) { return ''; }
        }

        // 文本写入（通道链）。成功 { ok:true }；失败 _fail(reason, message, path)。与读面同款：
        // 异常/拒绝一律折叠成显式 Result——调用方**永远**拿到 Result，不会冒出未处理的拒绝。
        function _writeText(fsx, abs, text) {
            var cap = _writeCap(fsx);
            var before = _lastErrorSnapshot(fsx);
            if (cap === 'result') {
                var p;
                try { p = fsx.writeFileResult(abs, text); } catch (e) {
                    return Promise.resolve(_fail('write_failed', '文件写入异常: ' + _msg(e), abs));
                }
                return Promise.resolve(p).then(function (r) {
                    if (r && r.ok === true) return { ok: true };
                    var code = (r && r.error && r.error.code) || '';
                    var detail = (r && r.error && r.error.message) || '';
                    if (code === 'REJECTED') {
                        // 数据层的确定性拒绝（% / 引号 / DOS 设备名 / 命名空间外）：「改路径能解决」
                        // 与「重试才可能好」是两种处置，必须分开说（同读面的三态口径）。
                        return _fail('rejected', '路径被数据层拒绝（写入未发生）'
                            + (detail ? '（' + detail + '）' : ''), abs);
                    }
                    return _fail('write_failed', '文件写入失败'
                        + (detail ? '（' + detail + '）' : '') + ': ' + abs, abs);
                }, function (e) {
                    return _fail('write_failed', '文件写入异常: ' + _msg(e), abs);
                });
            }
            if (cap === 'sync') {
                // 同步回退（宿主只给了 writeFileSync）：严格判 === true，异常同样折叠成 Result。
                var okSync = false;
                try { okSync = (fsx.writeFileSync(abs, text) === true); } catch (e) {
                    return Promise.resolve(_fail('write_failed', '文件写入异常: ' + _msg(e), abs));
                }
                if (okSync) return Promise.resolve({ ok: true });
                return Promise.resolve(_plainWriteFailure(fsx, abs, before));
            }
            var p2;
            try { p2 = fsx.writeFile(abs, text); } catch (e) {
                return Promise.resolve(_fail('write_failed', '文件写入异常: ' + _msg(e), abs));
            }
            return Promise.resolve(p2).then(function (ok) {
                if (ok === true) return { ok: true };
                return _plainWriteFailure(fsx, abs, before);
            }, function (e) {
                return _fail('write_failed', '文件写入异常: ' + _msg(e), abs);
            });
        }

        // 目标文件的父目录：工作区根（顶层文件）或 rel 去掉最后一段。缺省文件 brief.md ⇒ 根。
        function _parentOf(target) {
            var i = target.rel.lastIndexOf('/');
            return (i < 0) ? target.root : (target.root + target.rel.slice(0, i));
        }

        // 写前建父目录（AEFS 的 mkdir 幂等）。失败/no_mkdir 一律显式——父目录建不出来时继续写，
        // 失败点会被推到写入里，报出来的是「写失败」而不是真正的原因（同 ensureDir 的口径）。
        function _mkdirParent(fsx, dir) {
            if (typeof fsx.mkdir === 'function') {
                var p;
                try { p = fsx.mkdir(dir); } catch (e) {
                    return Promise.resolve(_fail('mkdir_failed', '写前建父目录异常: ' + _msg(e), dir));
                }
                return Promise.resolve(p).then(function (ok) {
                    // 严格判 true：undefined/null 一律当失败（"可能建成了"当成功会让写入落到
                    // 不存在的目录上，失败点被推远到更难定位的地方）
                    if (ok === true) return { ok: true };
                    return _fail('mkdir_failed', '写前建父目录失败（AEFS.mkdir 未返回 true）: ' + dir, dir);
                }, function (e) {
                    return _fail('mkdir_failed', '写前建父目录异常: ' + _msg(e), dir);
                });
            }
            if (typeof fsx.mkdirSync === 'function') {
                var okSync = false;
                try { okSync = (fsx.mkdirSync(dir) !== false); } catch (e) {
                    return Promise.resolve(_fail('mkdir_failed', '写前建父目录异常: ' + _msg(e), dir));
                }
                if (okSync) return Promise.resolve({ ok: true });
                return Promise.resolve(_fail('mkdir_failed', '写前建父目录失败（AEFS.mkdirSync 返回 false）: ' + dir, dir));
            }
            return Promise.resolve(_fail('no_mkdir', '注入的文件系统没有 mkdir/mkdirSync，无法保证父目录存在: ' + dir, dir));
        }

        // append 的语义 = 「读回现有内容再整体写」（AEFS 没有 append 原语）。这一步必须在**队列内**
        // 执行：读-改-写不串行的话，两次并发追加会互相覆盖（须保证并发 append 不丢行）。
        // 目标不存在 ⇒ 按「新建 + 写入」处理，不是错误。
        function _composeText(fsx, target, mode, content) {
            if (mode !== 'append') return Promise.resolve({ ok: true, text: content });
            return _readText(fsx, target.path).then(function (r) {
                if (r.ok === true) return { ok: true, text: r.text + content };
                if (r.reason === 'not_found') return { ok: true, text: content };
                // 读不回来就**不能**写：此时按 replace 落盘等于把已有内容整段清掉（静默丢数据）。
                return _fail(r.reason, '追加写入需要先读回现有内容，但读失败：' + r.message, target.path);
            });
        }

        // mode 只认 'replace'（缺省）与 'append'。其它值显式失败——把未知值当 replace 静默覆盖，
        // 正好会把调用方想要的「追加」变成「清空重写」，故必须显式失败。
        function _modeOf(raw) {
            if (raw === undefined || raw === null || raw === '') return 'replace';
            if (raw === 'replace' || raw === 'append') return raw;
            return '';
        }

        function _typeName(v) {
            if (v === null) return 'null';
            if (Object.prototype.toString.call(v) === '[object Array]') return 'array';
            return typeof v;
        }

        // 同文件串行写队列：键 = 归一后的 (团队会话 id, 相对路径)，键内串行、
        // 跨键并行。队列只做三件事：
        //   ① 串行化（后一个条目等前一个结算）；
        //   ② 保证调用方**恒**拿到一个 Result（fn 抛错 / 返回非 Result 一律折叠成显式失败——
        //      绝不把 undefined 当成功回给调用方）；
        //   ③ 失败不被吞（一个条目失败不影响后续条目：下一个照常执行，各自拿到各自的 Result）。
        function _enqueue(target, fn, sid) {
            if (typeof fn !== 'function') {
                return Promise.resolve(_fail('bad_handler',
                    'enqueueWrite 的第二参必须是写入函数（返回 Result 或它的 Promise）', target.path));
            }
            // 键用**归一后**的会话 id：' team_1 ' 与 'team_1' 指向同一个工作区，用原始串会让同一
            // 文件的两次写落进两条队列（并发直写同文件）。
            var key = _sessionId(sid) + '|' + target.rel;
            var run = function () {
                var p;
                try {
                    p = fn();
                } catch (e) {
                    return Promise.resolve(_fail('write_failed', '写队列条目异常: ' + _msg(e), target.path));
                }
                return Promise.resolve(p).then(function (r) {
                    if (r && typeof r === 'object' && typeof r.ok === 'boolean') return r;
                    return _fail('write_failed', '写队列条目没有返回 Result（缺失 ok 字段）——写入结果未知，'
                        + '按失败处理', target.path);
                }, function (e) {
                    return _fail('write_failed', '写队列条目异常: ' + _msg(e), target.path);
                });
            };
            var prev = _queues[key] || null;
            // prev 恒已结算成 Result（run 自己吃掉异常）；第二个参数是纵深防御——万一某个条目
            // 以拒绝态收尾，后续条目也必须照跑，不能把队列卡死。
            var cur = prev ? prev.then(run, run) : run();
            _queues[key] = cur;
            // 条目结算即删键；只在自己仍是最新尾节点时删（后一个条目已接上时不能删它）
            var clear = function () { if (_queues[key] === cur) delete _queues[key]; };
            cur.then(clear, clear);
            return cur;
        }

        // 公开的写队列入口。路径安全**只走** resolvePath，之后按 (会话, 相对路径) 排队。
        function enqueueWrite(relPath, fn, teamSessionId, opts) {
            var target = resolvePath(relPath, teamSessionId, opts);
            if (!target.ok) return Promise.resolve(target);
            return _enqueue(target, fn, teamSessionId);
        }

        // 写入工作区内的文本文件。校验顺序：路径 → mode/content → （队列内）写能力
        // → 追加读回 → 父目录 → 落盘。前两步是「调用方参数错」（模型改一次参数就能重试成功），
        // 后面是「环境错」——把能自纠的先报出来，模型才不会拿着环境错去改路径。
        // 返回 Promise：
        //   成功 { ok:true, path（绝对）, rel（相对，下次调用继续用它）, bytes（本次写入的字符数）, mode }
        //   失败 { ok:false, reason, message, path? }
        //        reason: bad_session_id / no_data_dir / bad_path / out_of_bounds / bad_mode /
        //                bad_content / too_large / no_fs / no_write / no_mkdir / mkdir_failed /
        //                write_failed / rejected / not_found / read_failed / no_read
        //                （enqueueWrite 另会回 bad_handler：第二参不是函数）
        function write(relPath, content, opts2) {
            var o2 = opts2 || {};
            var sid = o2.teamSessionId;
            var target = resolvePath(relPath, sid, { internal: o2.internal === true, forWrite: true });   // 唯一的安全边界（不另写一套校验；internal 见 resolvePath）
            if (!target.ok) return Promise.resolve(target);
            var mode = _modeOf(o2.mode);
            if (!mode) {
                return Promise.resolve(_fail('bad_mode',
                    'mode 只接受 replace（缺省，覆盖）或 append（追加），收到 ' + JSON.stringify(o2.mode)
                    + '——未知值不静默当 replace（那会把"追加"变成"清空重写"）', target.path));
            }
            if (typeof content !== 'string') {
                return Promise.resolve(_fail('bad_content', 'content 必须是字符串，收到 ' + _typeName(content)
                    + '——不做 String() 静默转换（数组/对象请先在调用方序列化）', target.path));
            }
            if (content.length > MAX_WRITE_CHARS) {
                return Promise.resolve(_fail('too_large', '本次 ' + content.length + ' 字符，单次上限 '
                    + MAX_WRITE_CHARS + ' 字符（256KB 按码元计）——请拆成多次写（mode=append）或分文件',
                    target.path));
            }
            return _enqueue(target, function () {
                var fsx = _fs();
                if (!fsx) return _fail('no_fs', '文件系统未注入（opts.aefs）', target.path);
                if (!_writeCap(fsx)) {
                    return _fail('no_write', '注入的文件系统没有 writeFileResult/writeFile/writeFileSync，'
                        + '工作区不可写', target.path);
                }
                return _composeText(fsx, target, mode, content).then(function (c) {
                    if (!c || c.ok !== true) return c;
                    return _mkdirParent(fsx, _parentOf(target)).then(function (m) {
                        if (!m.ok) return _fail(m.reason, m.message, target.path);
                        return _writeText(fsx, target.path, c.text).then(function (w) {
                            if (!w.ok) return _fail(w.reason, w.message, target.path);
                            // bytes = **本次写入**的字符数（replace 与 append 同口径）；追加前的
                            // 现有内容量用读面的 size 看，不在这里混算。
                            return { ok: true, path: target.path, rel: target.rel, bytes: content.length, mode: mode };
                        });
                    });
                });
            }, sid);
        }

        // 写能力探测的公开口（**装配层**用：没有写能力就别注册 write_workspace——暴露一件永远
        // 报错的工具比不暴露更糟，模型会把"内部没装配"误读成"路径写错了"）。真判据只有上面一处。
        function canWrite() { return _writeCap(_fs()) !== ''; }

        return {
            root: root,
            resolvePath: resolvePath,   // 相对路径 → 绝对路径的唯一入口（校验与拼装都在里面）
            ensureDir: ensureDir,
            read: read,
            write: write,
            canWrite: canWrite,
            enqueueWrite: enqueueWrite,
            listFiles: listFiles,       // 工作区文件表（工具 schema 的 enum 从这里派生）
            MAX_READ_CHARS: MAX_READ_CHARS,
            MAX_WRITE_CHARS: MAX_WRITE_CHARS,
            DEFAULT_FILE: _defaultFile()
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createWorkspace = createWorkspace;
    global.AEAgentTeam.WORKSPACE_MAX_READ_CHARS = MAX_READ_CHARS;
    global.AEAgentTeam.WORKSPACE_MAX_WRITE_CHARS = MAX_WRITE_CHARS;
    global.AEAgentTeam.WORKSPACE_DEFAULT_FILE = _defaultFile();
    global.AEAgentTeam.WORKSPACE_FILE_NAMES = listFiles().map(function (f) { return f.name; });
})(typeof window !== 'undefined' ? window : globalThis);
