// ── Bridge token 鉴权 ─────────────────────────
// AE 宿主是唯一可信源：startBridge 生成会话级随机 token，经一次性临时文件交接给
// bridge（bridge 读取后即删），面板经 evalScript('getBridgeToken()') 从本进程内存
// 获取。本机其他进程无该通道（Origin 头对非浏览器客户端可任意伪造）。
// ExtendScript 无 crypto——用 Date.now + 多轮 Math.random 拼接（会话级秘密，
// 非长期密钥，熵要求放宽）。
var _AS_EXT_BRIDGE_TOKEN = "";

// $.fileName 在本 AE 版本里锚不到 host.jsx（实测返回 AE
// 应用目录 Support Files），据此推导的「扩展根」会让 vendor node / bridge 脚本 /
// host/api 模块路径全错——表现为桥不自动启动 + cmd 兜底找不到 node，每次启动尝试弹一次
// AE「警告: ERROR:」模态框。面板加载 host.jsx 时注入 __AS_EXTP_ROOT（client/main.js，
// 取自 CEP 的扩展路径）；$.fileName 仅作兜底。两者都拿不到时返回 ""。
function _extRootFs() {
    // 每个候选都必须过存在性校验（<root>/host/host.jsx 在盘）才可用。真机实测
    // $.fileName 返回的是裸序号（"26"/"27"…逐次递增），File() 按 AE 的 Support Files
    // 目录解析 → parent.parent 恰是**不相干的 AE 应用目录**（与失败日志中的错误根一字
    // 不差）；不校验就会拿它拼出全错的 vendor node / bridge / host api 路径。
    // 校验同时兜住「注入值本身是垃圾」（任何来源的坏值一律丢弃，绝不用于拼路径）。
    function _validRoot(root) {
        if (typeof root !== "string" || !root) return "";
        var r = root.replace(/[\\\/]+$/, "");
        if (!r) return "";
        try { return (new File(r + "/host/host.jsx")).exists ? r : ""; } catch (_) { return ""; }
    }
    var good = "";
    try {
        good = _validRoot(__AS_EXTP_ROOT);
        if (good) {
            // 记住本次成功解析的根：后续注入被坏值覆盖时仍可自愈（引擎会话级记忆）
            try { __AS_EXTP_ROOT_GOOD = good; } catch (_) {}
            return good;
        }
    } catch (_) {}
    try {
        good = _validRoot(__AS_EXTP_ROOT_GOOD);
        if (good) return good;
    } catch (_) {}
    try {
        var f = new File($.fileName);
        if (f && f.parent && f.parent.fsName) {
            var p = f.parent.parent;
            good = _validRoot(p && p.fsName ? String(p.fsName) : "");
            if (good) return good;
        }
    } catch (_) {}
    return "";
}

function _genBridgeToken() {
    // ExtendScript 的 Number.toString(radix) 对小数退化（真机实测：
    // Math.random().toString(36).substring(2) 恒为空串 → token 退化成纯毫秒时间戳，
    // 可猜测）。整数路径正常（token 文件名随机段已验证），改用整数随机段。
    var parts = [String(new Date().getTime())];
    for (var i = 0; i < 8; i++) {
        parts.push(Math.floor(Math.random() * 1e9).toString(36));
    }
    return parts.join("-");
}

// 启动链诊断日志（数据目录 temp/logs/ae_bridge_debug.log）：排查「面板加载时 node 静默不起」。
// 真机：面板加载路径 startBridge 全链无痕失败（token 文件写出但从未被
// 消费、无 node 进程、无错误日志），重试按钮路径却成功——断点在 wscript/VBS 内部，
// On Error Resume Next + wscript 恒返 0 让 host.jsx 误判成功。VBS 内部写同款日志自证。
// 体积上限：超 256KB 先截断再追加。纯 append 无上限时，每次面板
// 加载/重启桥都追加数行，永不清理（实测 52KB）。VBS 侧（Dbg 子过程）只写固定几行，
// 由本函数在每次启动链开始时兜住上限即可。
// 两处对齐（诊断包工作流）：
//   ① 时间戳统一 ISO 本地时间：混用 new Date().toString() 与 VBScript 的
//      Now，**同一个文件里混两种且都依赖系统区域设置**，导出包内跨段按时间对齐时要人工换算；
//   ② 截断**保留尾部**——open("w") 直接清空会把启动链现场的最后一批证据
//      一起丢掉；与 as_effect_host.log 等既有口径一致（定位只看最近一段）。
// 落点由系统临时目录改到**数据目录** temp/logs（日志/缓存一律写数据目录，
// panel.log 同目录）；token 交接文件与 .vbs 启动器同样
// 落在数据目录 temp 下。
var _DBG_LOG_MAX = 256 * 1024;
var _DBG_LOG_KEEP = 128 * 1024;

// 数据根目录：与原生宿主同款解析（dataRootDirPath）——读指针文件 data-dir.txt
//（面板切换数据目录时原子写入），缺失/为空则用 APPDATA 默认根。
// 解析失败（APPDATA 不可得）返回空串：调用方走 $.writeln 兜底，不落系统临时目录。
function _dataRootDir() {
    var defRoot = "";
    try {
        var appdata = $.getenv("APPDATA");
        if (appdata) defRoot = appdata + "\\Adobe\\CEP\\extensions\\AS_ExtP";
    } catch (_) {}
    try {
        if (defRoot) {
            var ptr = new File(defRoot + "\\data-dir.txt");
            if (ptr.exists && ptr.open("r")) {
                // 指针文件由面板用 AEFS 写盘（UTF-8 无 BOM）。ExtendScript 的 File
                // 默认按**系统代码页**解读（中文 Windows = GBK）→ 数据根含中文时读成乱码
                // 路径，_dataTempDir 随后恒失败（启动期诊断日志消失、token/vbs 全退
                // %TEMP% 兜底）。原生侧两处读取都做了 UTF-8 校验，唯独这里没有——
                // 显式声明编码对齐（BOM 一并剥除，防未来写入侧带 BOM）。
                ptr.encoding = "UTF-8";
                var content = ptr.read();
                ptr.close();
                content = String(content == null ? "" : content).replace(/^[\uFEFF\s\r\n]+/, "").replace(/[\s\r\n]+$/, "");
                if (content) return content.replace(/[\\\/]+$/, "");
            }
        }
    } catch (_) {}
    return defRoot;
}

// 数据目录 temp 下的子目录解析（建成返回路径，建不出来返回空串）：
// token / vbs 走子目录 `handoff`，日志走 `logs`（两者不与 temp 根同层）
function _dataTempDir(sub) {
    var root = _dataRootDir();
    if (!root) return "";
    var dir = root + "\\temp" + (sub ? "\\" + sub : "");
    try {
        var f = new Folder(dir);
        if (!f.exists) {
            try { new Folder(root + "\\temp").create(); } catch (_) {}
            try { f.create(); } catch (_) {}
        }
        if (!new Folder(dir).exists) return "";
    } catch (_) { return ""; }
    return dir;
}

// ISO 8601 **UTC** 时间：ExtendScript 基于 ES3，
// 没有 Date.toISOString，手工拼。拼成**本地时间且不带偏移标记**时，桥侧
// （bridge-server.js `_stamp` = `toISOString()`）是 UTC，VBS 侧 `IsoNow` 也是本地——
// 三者的输出被拼进**同一份诊断包**，同一物理时刻会差一个时区（本机 8 小时），
// 排查「VBS 写完令牌 → 桥有没有起来」时会得出「桥比面板早 8 小时启动」这类**错误结论**。
// 统一口径：**全链 ISO UTC（带 Z）**，跨机/跨时区可比对，也便于脚本处理。
function _isoUtc(d) {
    function p2(n) { return (n < 10 ? '0' : '') + n; }
    return d.getUTCFullYear() + '-' + p2(d.getUTCMonth() + 1) + '-' + p2(d.getUTCDate())
        + 'T' + p2(d.getUTCHours()) + ':' + p2(d.getUTCMinutes()) + ':' + p2(d.getUTCSeconds()) + 'Z';
}

// 日志脱敏：启动链日志（ae_bridge_debug.log）可能被用户直接贴出/提交，Key/Token 与用户名
// 路径不进磁盘。host 是 ExtendScript（ES3），规则表在此镜像 client/shared/logger.js 的 redact
// （规则集与 bridge-server.js 的 _redactLog 同源，改动需三处同步）。
// 注意：字符类里的 / 必须写作 \/（ES3 正则字面量不认字符类上下文）。
function _redactLogLine(text) {
    try {
        return String(text)
            .replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
            .replace(/Bearer\s+\S+/gi, 'Bearer ***')
            .replace(/(api[_-]?key["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(token["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(password["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(Authorization[ \t]*:[ \t]*Basic[ \t]+)\S+/gi, '$1***')
            .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
            .replace(/([A-Za-z0-9-]*(?:session|secret|credential)[A-Za-z0-9-]*["']?[ \t]*[:=][ \t]*)(["']?)(?=[A-Za-z0-9._\-+\/=]{8,})(?:[A-Za-z0-9._\-+\/=]*\d[A-Za-z0-9._\-+\/=]*|[A-Za-z0-9._\-+\/=]{20,})/gi, '$1$2***')
            .replace(/(\/\/)[A-Za-z0-9._%\-]{1,64}:[^\s@\/]{1,64}@/g, '$1***@')
            .replace(/([A-Za-z]:[\\\/])Users[\\\/][^\\\/\s]+/gi, '$1Users\\<user>');
    } catch (_) {
        return String(text);
    }
}

function _dbgLog(line) {
    try {
        line = _redactLogLine(line);
        var logDir = _dataTempDir("logs");
        if (!logDir) { $.writeln("[AS_ExtP] " + line); return; }
        var f = new File(logDir + "/ae_bridge_debug.log");
        if (f.exists && f.length > _DBG_LOG_MAX) {
            // 读全文 → 只留尾部 → 覆盖重写。刻意不设置 encoding：读与写都用文件默认编码，
            // 往返一致（若把读设成 UTF-8 而原内容是系统默认编码，中文段会变乱码）。
            var all = '';
            var r = new File(f.fsName);
            if (r.open("r")) {
                all = r.read() || '';
                r.close();
            }
            var keep = all.length > _DBG_LOG_KEEP ? all.substring(all.length - _DBG_LOG_KEEP) : all;
            var t = new File(f.fsName);
            if (t.open("w")) {
                // 首行自证记录：否则"日志变短了"无从判断是轮转还是丢失
                t.write('[cap] ' + _isoUtc(new Date()) + ' 超上限，已保留末尾\r\n' + keep);
                t.close();
            }
        }
        if (f.open("a")) {
            f.write(_isoUtc(new Date()) + ' ' + line + "\r\n");
            f.close();
        }
    } catch (_) {}
}

function getBridgeToken() {
    return _AS_EXT_BRIDGE_TOKEN;
}

// 握手残留清扫：token 只在「bridge 成功读到」时被删（bridge-server 读后即删），
// 启动失败的那些没人读、会一直留在数据目录 temp 里（实测累积 18 个、最老跨两天，且它们是
// 认证凭据，不该在盘上堆积）。每次启动 bridge 前清掉同目录里**超过 10 分钟**的 token 与
// .vbs 启动器——从写入到被读走只有秒级，10 分钟前的必然是无主残留；本次交接刚创建的
// token 不受影响（它是新的）。拿不到修改时间的条目一律不动（宁留不误删）；只按名字模式
// 匹配，不碰清扫报告、预览帧与日志（日志另有体积上限）。多实例探测脚本
//（ae_extp_axdetect_*.axd，正常路径用后即删）按同一模式收陈旧
// 残留；多实例标记 ae_extp_multi_instance.json **不在此列**——它是面板读取的信号，
// 生命周期由启动检测/复核与面板 10 分钟过期清理管理，不属于"写完即弃"的交接件。
// ⚠️ AEFS 例外：此处用裸 File.remove()，因为本函数
// 属于**启动链**——它跑的时机正是「桥还没有」的时候，而 AEFS 是面板侧模块、删接口依赖桥/CEP，
// 结构上不可能在此调用；作用域已收窄到三处已知 handoff 目录 + 精确文件名 + 只删文件 + mtime 门槛。
function _sweepHandoffLeftovers(dir) {
    if (!dir) return 0;
    var entries = [];
    try {
        var d = new Folder(dir);
        if (!d.exists) return 0;
        entries = d.getFiles("ae_*");
    } catch (_) { return 0; }
    var cutoff = (new Date()).getTime() - 10 * 60 * 1000;
    var removed = 0;
    for (var i = 0; i < entries.length; i++) {
        var it = entries[i];
        var nm = "";
        try { nm = String(it.name); } catch (_) {}
        // 名字分两类：① 既有 token/vbs 交接件（历史模式保持原样，AEFS 删除审计逐字钉住）；
        // ② 多实例探测脚本（.axd，写完即弃）。标记 ae_extp_multi_instance.json 不在此列——
        // 它是面板读取的信号，由启动检测/复核与面板过期清理管理。
        var isHandoffLeftover = /^(ae_extp_bridge_token_[a-z0-9]+\.tmp|ae_bridge_[0-9]+\.vbs)$/i.test(nm);
        var isAxProbeLeftover = /^ae_extp_axdetect_[0-9a-z]+\.axd$/i.test(nm);
        if (!isHandoffLeftover && !isAxProbeLeftover) continue;
        // 只删文件：目录也有 remove()（会连内容一起删），若碰巧有同名目录，这里把它排除
        try { if (typeof it.getFiles === "function") continue; } catch (_) {}
        var mt = 0;
        try { mt = it.modified ? it.modified.getTime() : 0; } catch (_) {}
        if (!mt || mt >= cutoff) continue;
        try { it.remove(); removed++; } catch (_) {}
    }
    return removed;
}

// 启动交接件目录（token / vbs）：主 = 数据目录 `temp/handoff`；兜底 = 系统临时目录
// `%TEMP%\AS_ExtP\handoff`（Windows；macOS 取 TMPDIR）。
// 为什么这一件允许破「一律写数据目录」的政策：token 是**跨进程交接件**，
// 活得只有秒级（bridge 读后即删），且有两道兜底（读后即删 + 启动链自清超 10 分钟残留）；
// 而数据目录不可用时若直接不落盘，bridge 会 fail-closed → 整条链路不可用。故保留系统 temp 的
// **兜底**（仍放在专目录里，不散在 temp 根）；两处都拿不到才不写文件。
function _handoffDir() {
    var d = _dataTempDir("handoff");
    if (d) return d;
    var existing = _tmpFallbackHandoff();
    if (existing) return existing;
    var bases = [];
    try { if ($.getenv("TEMP")) bases.push(String($.getenv("TEMP"))); } catch (_) {}
    try { if ($.getenv("TMPDIR")) bases.push(String($.getenv("TMPDIR"))); } catch (_) {}
    for (var i = 0; i < bases.length; i++) {
        try {
            var base = bases[i].replace(/[\\\/]+$/, "");
            if (!base) continue;
            if (!new Folder(base).exists) continue;          // 系统 temp 本身不存在 → 换下一个
            // 分隔符一律用 / ：ExtendScript 在 Windows 上同样归一化正斜杠，macOS 上 \ 是字面字符
            //（用 \\ 拼时 mac 上会永远解析不出来 → 兜底形同虚设）
            var sub = base + "/AS_ExtP";
            var dir = sub + "/handoff";
            if (!new Folder(sub).exists) { try { new Folder(sub).create(); } catch (_) {} }
            if (!new Folder(dir).exists) { try { new Folder(dir).create(); } catch (_) {} }
            if (new Folder(dir).exists) return dir;
        } catch (_) {}
    }
    return "";
}

// 系统 temp 兜底目录的**只读**解析（清扫用）：只认已存在的目录，不创建
function _tmpFallbackHandoff() {
    var bases = [];
    try { if ($.getenv("TEMP")) bases.push(String($.getenv("TEMP"))); } catch (_) {}
    try { if ($.getenv("TMPDIR")) bases.push(String($.getenv("TMPDIR"))); } catch (_) {}
    for (var i = 0; i < bases.length; i++) {
        try {
            var base = bases[i].replace(/[\\\/]+$/, "");
            if (!base) continue;
            var dir = base + "/AS_ExtP/handoff";
            if (new Folder(dir).exists) return dir;
        } catch (_) {}
    }
    return "";
}

// ── 路径编码 / cwd 通道小工具（提升到文件作用域）─────────────
// 原定义在 startBridge 内（其启动通道专用）；修复 cscript 门后，_runAxDetectionProbe
// 的命令行同样需要「非 ASCII 路径 → cwd + 相对名」通道，故提升共用。行为逐字不变。
function _hasNonAscii(s) {
    return /[^\x00-\x7F]/.test(String(s == null ? "" : s));
}
// 归因展示：File.encode 把 >127 字符按 RFC2396 做 UTF-8 百分号编码，输出纯 ASCII，
// 可安全进以系统代码页写出的日志/控制台，不引入二次乱码（失败时路径仍可人工还原）。
// ASCII 路径原样返回（不把分隔符等普通字符也做成 %XX，保持日志可读）。
function _asciiPathForLog(s) {
    var str = String(s == null ? "" : s);
    if (!_hasNonAscii(str)) return str;
    try { return String(File.encode(str)); } catch (_) { return str; }
}
function _normPath(p) {
    return String(p == null ? "" : p).replace(/[\\\/]+/g, "\\").replace(/\\+$/, "").toLowerCase();
}
function _leafName(p) {
    var s = String(p == null ? "" : p);
    var i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
    return i >= 0 ? s.substring(i + 1) : s;
}
// 进入 cwd=dir 并自证；返回 { moved, before }。moved=false 时保证 cwd 已还原。
// 两条运行时自证（立此纪律：wscript/cscript 相对名在 cwd 未生效时找不到文件，
// 非零退出会弹 AE 模态框——必须运行期证实，不能只靠系统语义假设）：
//   ① Folder.current 读回 == dir（setter 真生效）；
//   ② 切换前后 `cd` 输出不同且落点以 dir 叶子名结尾（子进程确实继承 cwd）。
// cwd 是进程级状态：调用方必须在 finally 立即恢复，缩短影响窗口。
function _enterCwd(dir) {
    var st = { moved: false, before: null };
    if (!dir) return st;
    try { st.before = Folder.current; } catch (_) { st.before = null; }
    try {
        var probeBefore = String(system.callSystem('cmd /c cd'));
        Folder.current = new Folder(dir);
        var nowFs = "";
        try { nowFs = String(Folder.current.fsName); } catch (_) { nowFs = ""; }
        if (!nowFs || _normPath(nowFs) !== _normPath(dir)) {
            try { if (st.before) Folder.current = st.before; } catch (_) {}
            return st;
        }
        var probeAfter = String(system.callSystem('cmd /c cd')).replace(/[\s\r\n]+$/, "");
        st.moved = (probeAfter !== "" && probeAfter !== probeBefore && /handoff$/i.test(probeAfter));
        if (!st.moved) {
            try { if (st.before) Folder.current = st.before; } catch (_) {}
        }
    } catch (_) {
        try { if (st.before) Folder.current = st.before; } catch (_) {}
        st.moved = false;
    }
    return st;
}
function _restoreCwd(st) {
    if (st && st.moved && st.before) {
        try { Folder.current = st.before; } catch (_) {}
    }
}

// ── 多实例检测与标记（明确不支持多实例）────────────────
// bridge 是单实例资源（固定端口段，启动时按脚本路径杀所有同路径 node 进程）。
// 两个 AE 实例同时开面板会互相杀对方的 bridge → 双方 401/断线乒乓。不支持
// 多实例后，宿主在启动桥**之前**用 WMI 查本机其它 AfterFX.exe（排除自身 PID）：
// 有则把标记写进启动交接目录（temp/handoff，路径与回退沿用 token/vbs 交接件规则），
// 面板据此显示明确提示并停止 restartBridge 自愈（断互杀循环）；无则清掉旧标记。
// 检测不可用（非 Windows / WMI 或 cscript 失败 / 目录不可写）按「未检测」处理：
// 不写不清，单实例路径逐字不变。
// 探测脚本落 .axd 由 `cscript //E:vbscript` 显式指定引擎执行：不采用 .vbs 是为了
// 不进既有启动链回归用例的 .vbs 交接件计数口径（那是启动器专用），也不落入
// _sweepHandoffLeftovers 的 vbs 清扫模式；陈旧探测脚本由该函数的新增模式收掉。
var _MULTI_INSTANCE_MARKER_NAME = "ae_extp_multi_instance.json";

function _multiInstanceMarkerPath(dir) {
    return dir ? (dir + "/" + _MULTI_INSTANCE_MARKER_NAME) : "";
}

// 探测脚本内容（VBScript，仅向 stdout 输出一行 ASCII 结果；On Error Resume Next
// 保证任何 WMI 失败都输出 ok=0 而非非零退出码，规避 system.callSystem 弹窗路径）。
// 自身 PID 识别：先找命令行含本脚本路径的 cscript 进程，再沿 ParentProcessId 上溯
// （callSystem 可能经 cmd 中转，故非固定一跳）到 AfterFX.exe；识别不到时 self=0，
// 上层以 count>=2 判定（自身必是其中之一，排除自身由上层按 self 过滤）。
function _axDetectProbeVbs() {
    var L = [];
    L.push('On Error Resume Next');
    L.push('ok = 1');
    L.push('Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")');
    L.push('If Err.Number <> 0 Then ok = 0');
    L.push('selfPid = 0');
    L.push('cnt = 0');
    L.push('pids = ""');
    L.push('If ok = 1 Then');
    L.push('  pName = LCase(WScript.ScriptFullName)');
    L.push('  Set scSet = svc.ExecQuery("SELECT ProcessId, ParentProcessId, CommandLine FROM Win32_Process WHERE Name = \'cscript.exe\'")');
    L.push('  If Err.Number <> 0 Then ok = 0');
    L.push('  For Each sc In scSet');
    L.push('    If InStr(1, LCase(sc.CommandLine), pName, 1) > 0 Then');
    L.push('      pid = sc.ParentProcessId');
    L.push('      For hop = 0 To 5');
    L.push('        If selfPid > 0 Then Exit For');
    L.push('        Set ppSet = svc.ExecQuery("SELECT ProcessId, ParentProcessId, Name FROM Win32_Process WHERE ProcessId = " & pid)');
    L.push('        For Each pp In ppSet');
    L.push('          If LCase(pp.Name) = "afterfx.exe" Then selfPid = pp.ProcessId');
    L.push('          pid = pp.ParentProcessId');
    L.push('        Next');
    L.push('      Next');
    L.push('    End If');
    L.push('  Next');
    // ThreadCount > 0 —— 排除「全线程已退出、仅剩进程对象」的尸体（真实现场：
    // 昨会话崩溃残留的 AfterFX 进程 ThreadCount=0/HandleCount=0，Get-Process 仍列它，
    // 无过滤时被当第二个实例 → 误写标记 → 面板误报「另一实例」并阻断 restartBridge
    // 自愈，用户需重启才能消）。实测：同机 过滤前 count=2（尸体+活体）、过滤后 count=1。
    L.push('  Set axSet = svc.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = \'AfterFX.exe\' AND ThreadCount > 0")');
    L.push('  If Err.Number <> 0 Then ok = 0');
    L.push('  For Each ap In axSet');
    L.push('    cnt = cnt + 1');
    L.push('    If pids <> "" Then pids = pids & ","');
    L.push('    pids = pids & ap.ProcessId');
    L.push('  Next');
    L.push('End If');
    L.push('WScript.Echo "ASEXT_AXDETECT ok=" & ok & " count=" & cnt & " self=" & selfPid & " pids=" & pids');
    return L.join('\r\n') + '\r\n';
}

// 解析探测输出（单个 ASCII 结果行）；不可解析/未检测返回 null
function _parseAxDetectResult(out) {
    if (out === null || out === undefined) return null;
    var m = /ASEXT_AXDETECT ok=(\d+) count=(\d+) self=(\d+) pids=([0-9,]*)/.exec(String(out));
    if (!m) return null;
    var pids = [];
    if (m[4]) {
        var parts = m[4].split(",");
        for (var i = 0; i < parts.length; i++) {
            if (parts[i]) pids.push(parseInt(parts[i], 10));
        }
    }
    return {
        ok: m[1] === "1",
        count: parseInt(m[2], 10) || 0,
        selfPid: parseInt(m[3], 10) || 0,
        pids: pids
    };
}

// cscript 可用性（模态防护）：WSH 被组策略禁用/杀软拦截时，cscript 命令非零退出
// 会触发 system.callSystem 的「After Effects 警告: ERROR:」模态框（见 startBridge
// 内注释），每次加载/重试都执行则反复弹模态。探测前先做一次廉价判定（系统目录下
// cscript.exe 是否存在），不可用直接返回 UNKNOWN（不写不清），不再发起会弹模态的调用。
// 结果缓存：一次判定，后续调用不再重复 File 探测；也不重复刷日志。
//
// 注意 Folder.systemPath 不存在 —— ExtendScript 无此属性（官方 Folder 静态属性
// 表：appData/appPackage/commonFiles/current/desktop/fs/myDocuments/startup/system/
// temp/trash/userData），真机实测恒 undefined → 本门恒 false → 多实例 WMI 探测自诞生起
// 就不发起任何调用：门判 false 时整段跳过（真机日志 "cscript available: false" + 僵尸进程在场却无标记，双证）。
// 改为双候选逐一 File.exists（任一命中即可用；命中即止，不探测第二个）：
//   ① Folder.system（文档记为 %windir%，但真机实测 fsName = C:\Windows\SYSTEM32——
//      两种落点都覆盖：先按「该目录 + /cscript.exe」试，正是真机锚到 System32 的形态）；
//   ② $.getenv("windir") + /System32/cscript.exe（文档形态宿主兜底；getenv 在数据目录
//      链已用，见 _tmpFallbackHandoff）。
var _cscriptAvailable = null;
function _isCscriptAvailable() {
    if (_cscriptAvailable !== null) return _cscriptAvailable;
    _cscriptAvailable = false;
    var cands = [];
    try {
        var sysFs = String(Folder.system.fsName || "");
        if (sysFs) cands.push(sysFs.replace(/[\\\/]+$/, "") + "/cscript.exe");
    } catch (_) {}
    try {
        var winDir = String($.getenv("windir") || "");
        if (winDir) cands.push(winDir.replace(/[\\\/]+$/, "") + "/System32/cscript.exe");
    } catch (_) {}
    for (var ci = 0; ci < cands.length && !_cscriptAvailable; ci++) {
        try { if (new File(cands[ci]).exists) _cscriptAvailable = true; } catch (_) {}
    }
    _dbgLog("[multiInstance] cscript available: " + _cscriptAvailable
        + (_cscriptAvailable ? "" : "（跳过 WMI 探测，避免弹模态警告）"));
    return _cscriptAvailable;
}

// 同步执行 WMI 探测：写 .axd 探测脚本 → cscript //E:vbscript 执行（stdout 回传）
// → 立即删脚本。任何一步失败返回 null（调用方按「未检测」处理）。
function _runAxDetectionProbe(dir) {
    if (!dir) return null;
    // 可用性预判先于写脚本/调系统命令：不可用直接按未检测返回（见上方注释）
    if (!_isCscriptAvailable()) return null;
    var probePath = dir + "/ae_extp_axdetect_" + new Date().getTime().toString(36)
        + Math.floor(Math.random() * 1e9).toString(36) + ".axd";
    var pf = new File(probePath);
    var written = false;
    try {
        if (pf.open("w")) {
            written = pf.write(_axDetectProbeVbs());
            pf.close();
        }
    } catch (_) { written = false; }
    if (!written) return null;
    // 命令行经 system.callSystem 走系统代码页——数据目录含非 ASCII（中文用户名）时
    // 绝对路径会被写成 '?' → cscript 找不到脚本、非零退出弹 AE 模态框（语义的同族
    // 缺口；cscript 门一旦可用该通道就会走到，故必须一并封住）。复用
    // 「cwd + 纯 ASCII 相对名」通道：两条自证任一不成立则退回绝对路径并留编码归因。
    var probePathSafe = probePath.replace(/\//g, "\\");
    var cmdArg = '"' + probePathSafe + '"';
    var cwdSt = null;
    if (_hasNonAscii(probePathSafe)) {
        var probeName = _leafName(probePathSafe);
        if (probeName && !_hasNonAscii(probeName)) cwdSt = _enterCwd(dir);
        if (cwdSt && cwdSt.moved) {
            cmdArg = '"' + probeName + '"';
            _dbgLog("[multiInstance] probe via cwd-relative name (non-ASCII-safe): " + probeName);
        } else {
            _dbgLog("[multiInstance] probePath contains non-ASCII; system codepage may mangle it: "
                + _asciiPathForLog(probePathSafe));
        }
    }
    var out = null;
    try {
        out = system.callSystem('cscript //nologo //E:vbscript ' + cmdArg);
    } catch (_) { out = null; }
    _restoreCwd(cwdSt);
    try { pf.remove(); } catch (_) {}
    var res = _parseAxDetectResult(out);
    if (!res) _dbgLog("[multiInstance] probe unusable, out=" + String(out).substring(0, 120));
    return res;
}

// 写标记：{"ts":毫秒,"iso":"本地ISO","selfPid":N,"pids":[其它 AE 的 PID]}
function _writeMultiInstanceMarker(dir, others, selfPid) {
    if (!dir) return false;
    var f = new File(_multiInstanceMarkerPath(dir));
    var ok = false;
    try {
        if (f.open("w")) {
            var now = new Date();
            ok = f.write('{"ts":' + now.getTime() + ',"iso":"' + _isoUtc(now) + '","selfPid":'
                + (selfPid || 0) + ',"pids":[' + others.join(",") + ']}');
            f.close();
        }
    } catch (_) { ok = false; }
    return !!ok;
}

function _clearMultiInstanceMarker(dir) {
    if (!dir) return false;
    try {
        var f = new File(_multiInstanceMarkerPath(dir));
        if (!f.exists) return false;
        return !!f.remove();
    } catch (_) { return false; }
}

// 把一次探测结果落到标记上。返回 "MULTI" / "SINGLE" / "UNKNOWN"：
//   ok=0 或结果缺失 → UNKNOWN（不写不清，行为不变）
//   count>=2 → 写标记（pids 排除自身；自身 PID 未识别时列出全部）
//   count<=1 → 清标记（启动即单实例：立刻解除旧标记，不等面板 10 分钟过期）
function _applyMultiInstanceDetection(dir, res) {
    if (!dir || !res || !res.ok) return "UNKNOWN";
    var others = [];
    for (var i = 0; i < res.pids.length; i++) {
        if (res.pids[i] !== res.selfPid) others.push(res.pids[i]);
    }
    if (res.count >= 2) {
        if (!others.length) others = res.pids.slice(0);
        var wrote = _writeMultiInstanceMarker(dir, others, res.selfPid);
        _dbgLog("[multiInstance] detected " + res.count + " AfterFX (self=" + res.selfPid
            + "), marker " + (wrote ? "written" : "WRITE FAILED") + " pids=" + others.join(","));
        return "MULTI";
    }
    _clearMultiInstanceMarker(dir);
    _dbgLog("[multiInstance] single AfterFX, marker cleared");
    return "SINGLE";
}

// 面板重试时经 evalScript 调用的复核入口：重新跑 WMI 探测并更新/清除标记，
// 返回 "MULTI" / "SINGLE" / "UNKNOWN"。面板仅在 SINGLE 时恢复既有自愈路径
// （含 restartBridge）；MULTI/UNKNOWN 保持冲突态，绝不重启杀进程。
function refreshMultiInstanceMarker() {
    if (!isWindows()) return "UNKNOWN";
    var dir = "";
    try { dir = _handoffDir(); } catch (_) { dir = ""; }
    if (!dir) return "UNKNOWN";
    var status = _applyMultiInstanceDetection(dir, _runAxDetectionProbe(dir));
    _dbgLog("[refreshMultiInstanceMarker] " + status);
    return status;
}

function startBridge() {
    var hostFile = new File($.fileName);
    // 扩展根优先取面板注入的 __AS_EXTP_ROOT（$.fileName 真机上锚不到本文件）；
    // $.fileName 仅作兜底，两者都拿不到时下游会自行失败并留归因。
    var _rootFs = _extRootFs();
    var projectRoot = _rootFs ? new Folder(_rootFs) : hostFile.parent.parent;
    var bridgePath = projectRoot.fsName + "/client/shared/ae-bridge.js";

    // 路径编码小工具（_hasNonAscii / _asciiPathForLog） 起移至文件作用域——
    // _runAxDetectionProbe 的探测命令行同样依赖，见文件上方「路径编码 / cwd 通道小工具」。

    // 早退防「模态框风暴」：扩展根解析错时（历史真机：$.fileName 指向应用目录），
    // 每条启动尝试都会因 wscript/cmd 失败各弹一次 AE「警告: ERROR:」模态框。宁可不动手：
    // 桥脚本不存在时直接放弃当前轮启动并留归因（面板失败浮层/诊断包可见），不再触发弹窗。
    // 归因如实——打印实际解析出的根与候选状态（旧标记只判非空，会把回退值也标成
    // __AS_EXTP_ROOT，误导排查）。
    if (!(new File(bridgePath)).exists) {
        _dbgLog("[startBridge] ABORT: bridge script not found: " + _asciiPathForLog(bridgePath)
            + " (resolved root=" + (_rootFs ? _asciiPathForLog(_rootFs) : "(none — injected/remembered/$fileName candidates all invalid)")
            + ", injected=" + (_asciiPathForLog(typeof __AS_EXTP_ROOT === "string" ? __AS_EXTP_ROOT : "(unset)")) + ")");
        $.writeln("[AS_ExtP] Bridge: bridge script missing, abort launch");
        return;
    }

    // token 交接文件：随机文件名（缩短可枚举暴露面），内容即 token；bridge 读后即删。
    // 写失败也照常传 argv——bridge 侧读文件失败会 fail-closed 锁死自身（拒绝所有
    // 请求），面板探测失败 → restartBridge 重试交接，优于无鉴权放行。
    _AS_EXT_BRIDGE_TOKEN = _genBridgeToken();
    // 交接件专目录（token 与 vbs 不散在 temp 根）：
    // 主 = 数据目录 temp/handoff；兜底 = 系统临时目录 %TEMP%\AS_ExtP\handoff（见 _handoffDir 注释）。
    // 路径分隔符用 / ：ExtendScript File 在 Windows 上同样归一化正斜杠，
    // 且 macOS 分支直接拼进 shell 命令（\\ 会成为 POSIX 文件名字面量）
    var _handoff = _handoffDir();
    // 先清无主残留（上次启动失败留下的 token/vbs），再写本次交接文件；
    // 同时扫 temp 根与系统 temp 兜底目录，收掉本改动之前散在那里的历史残留
    var _sweptHandoff = _sweepHandoffLeftovers(_handoff) + _sweepHandoffLeftovers(_dataTempDir(""))
        + _sweepHandoffLeftovers(_tmpFallbackHandoff());
    if (_sweptHandoff > 0) _dbgLog("[startBridge] handoff sweep removed " + _sweptHandoff);
    // 多实例检测（不支持多实例）：启动桥之前用 WMI 查本机是否
    // 还有其它 AfterFX.exe（排除自身 PID）——有则写标记供面板明示并停止自愈互杀，
    // 无则清掉旧标记。检测不可用按未检测处理（不写不清），不阻断/不改变下列启动链。
    if (isWindows()) {
        try {
            _applyMultiInstanceDetection(_handoff, _runAxDetectionProbe(_handoff));
        } catch (_) {}
    }
    // 两处目录都拿不到时才不落盘（argv 仍带空的 --bridge-token-file → bridge fail-closed →
    // 面板 restartBridge 重试交接，优于无鉴权放行）；绝不退化成无根路径（"/xxx" = 当前盘根）
    var tokenPath = _handoff ? (_handoff + "/ae_extp_bridge_token_"
        + new Date().getTime().toString(36) + Math.floor(Math.random() * 1e9).toString(36) + ".tmp") : "";
    var tokenWritten = false;
    if (tokenPath) {
        var tokenFile = new File(tokenPath);
        if (tokenFile.open("w")) {
            tokenWritten = tokenFile.write(_AS_EXT_BRIDGE_TOKEN);
            tokenFile.close();
        }
    }
    // 日志落在以系统代码页写出的文件里：路径先 ASCII 化，非 ASCII 字符
    // 直接落盘会变 '?'，归因失真。
    _dbgLog("[startBridge] token file " + (tokenWritten ? "written" : (tokenPath ? "WRITE FAILED" : "SKIPPED (no handoff dir)"))
        + ": " + (_asciiPathForLog(tokenPath) || "数据目录与系统 temp 都不可用——按政策不落盘"));
    if (!tokenWritten) {
        $.writeln("[AS_ExtP] Bridge: token handoff file " + (tokenPath ? "write failed" : "skipped (no handoff dir)"));
    }

    if (isWindows()) {
        // 用 .vbs + wscript 启动，避开旧代码 netstat|findstr 引发的 system.callSystem 弹窗。
        // 背景：system.callSystem 在命令返回非零退出码或 stderr 非空时弹 "After Effects 警告: ERROR:" 对话框。
        //   旧代码 netstat|findstr 无匹配返回 1 → 触发弹窗，cmd GBK 编码导致弹窗文本乱码。
        // 方案：生成 .vbs，用 wscript 执行。VBS 内 WMI 杀旧 ae-bridge 进程 + WScript.Shell.Run 隐藏启动 node。
        //   wscript 退出码 0（On Error Resume Next 保证无脚本错误），不触发弹窗。

        var vendorNode = (projectRoot.fsName + "/vendor/node/node.exe").replace(/\//g, "\\");
        var bridgePathSafe = bridgePath.replace(/\//g, "\\");
        var tokenPathSafe = tokenPath.replace(/\//g, "\\");
        // 另两个 server 脚本完整路径：bridge-server.js 为同目录第二 server 入口；
        // legacyPathSafe 是改名前（mcp-bridge 时代）残留旧进程的脚本路径，当时的发布版从 mcp-manager 模块启动
        var serverPathSafe = (projectRoot.fsName + "/client/shared/bridge-server.js").replace(/\//g, "\\");
        var legacyPathSafe = (projectRoot.fsName + "/client/modules/mcp-manager/mcp-bridge.js").replace(/\//g, "\\");

        var nodePath = vendorNode;
        // vendor node 可用性判据：**不能只看 exists**。
        // `vendor/node/node.exe` 由 .gitattributes 交给 LFS；GitHub「Download ZIP」（不解析 LFS）
        // 或未装 git-lfs 的 clone 会得到 **133 字节的指针文本**——exists 为真，于是：
        //   · VBS 里 W.Run 启动它失败（err=193），被 On Error Resume Next 吞掉、只留一行 debug 日志；
        //   · `cmd start` 兜底**不触发**（只有 wscript 自身抛错才走，而它恒退出 0）；
        //   · restartBridge()（面板「↻ 重新检测」）重跑同一条坏路径 ⇒ **永久卡住**，
        //     也不会回退 PATH 的 node.exe（README 承诺的「系统 Node.js」路径实际不存在）。
        // 判据与仓库自己的 tools/install.bat:306 同口径：**<1MB 视为 LFS 指针**（真 node.exe 数十 MB）。
        var _vendorNodeOk = false;
        try {
            var _vf = new File(vendorNode);
            _vendorNodeOk = _vf.exists && _vf.length > 1024 * 1024;
            if (_vf.exists && !_vendorNodeOk) {
                $.writeln("[AS_ExtP] Bridge: vendor node 疑似 LFS 指针（" + _vf.length + " 字节），回退 PATH node.exe"
                    + "；请重新获取二进制（git lfs pull 或跑 tools/install.bat）");
            }
        } catch (_vfe) { _vendorNodeOk = false; }
        if (!_vendorNodeOk) {
            nodePath = "node.exe";
            if (!(new File(vendorNode)).exists) {
                $.writeln("[AS_ExtP] Bridge: vendor node not found, fallback to PATH node.exe");
            }
        }

        // 生成 .vbs：WMI 杀旧进程 + 隐藏启动 node
        // vbs 启动器与 token 同目录（temp/handoff）；目录不可用则不写 vbs，
        // 直接走下方 cmd start 兜底（路径缺目录时会退化成 "\ae_bridge_*.vbs" = 当前盘根）
        var vbsPath = _handoff ? (_handoff + "\\ae_bridge_" + (new Date().getTime()) + ".vbs") : "";
        var vbsFile = vbsPath ? new File(vbsPath) : null;
        // 诊断日志路径传入 VBS（VBS 内 Dbg 子过程写同一文件，自证 wscript 确实执行了脚本）。
        // VBScript 字符串不转义反斜杠，TEMP 路径无引号，直接拼入即可
        var dbgPathSafe = (_dataTempDir("logs") || "") + "\\ae_bridge_debug.log";
        // VBS 语法：双引号转义为 ""；W.Run 命令参数 """p1"" ""p2""" 传递 "p1" "p2" 给 ShellExecute
        var vbsLines = [];
        vbsLines.push('On Error Resume Next');
        // ISO **UTC**：与 AE 侧 `_isoUtc`、桥侧 `_stamp` 同口径
        //（三者输出被拼进同一份诊断包；混用本地时间与 UTC ⇒ 同一时刻差一个时区，
        // 排查启动时序会得出错误结论）。VBScript 只有本地 `Now`，故由本侧把时区偏移**注入**生成的
        // 脚本：ES3 的 `getTimezoneOffset()` 语义是「UTC − 本地」分钟数（东八区为 -480），
        // 于是 `DateAdd("n", 偏移, Now)` 即 UTC ✓。VBScript 拼接用 &，补零用 Right。
        vbsLines.push('Function IsoNow()');
        vbsLines.push('  IsoNow = DateAdd("n", ' + new Date().getTimezoneOffset() + ', Now)');
        vbsLines.push('  IsoNow = Year(IsoNow) & "-" & Right("0" & Month(IsoNow), 2) & "-" & Right("0" & Day(IsoNow), 2)');
        vbsLines.push('  IsoNow = IsoNow & "T" & Right("0" & Hour(IsoNow), 2) & ":" & Right("0" & Minute(IsoNow), 2) & ":" & Right("0" & Second(IsoNow), 2) & "Z"');
        vbsLines.push('End Function');
        vbsLines.push('Sub Dbg(s)');
        vbsLines.push('  On Error Resume Next');
        // 与 AE 侧 _redactLogLine 同口径：VBS 日志同样可能被用户直接贴出，先把用户主目录折叠。
        // 边界：只折叠当前进程的 USERPROFILE（异 profile / 其他盘符的用户主目录若出现在日志里
        // 不会被折叠；该场景由诊断包出口的统一 redact 兜底）。
        vbsLines.push('  If Len(Environ("USERPROFILE")) > 0 Then s = Replace(s, Environ("USERPROFILE"), "%USERPROFILE%")');
        vbsLines.push('  Set fso = CreateObject("Scripting.FileSystemObject")');
        vbsLines.push('  Set ts = fso.OpenTextFile("' + dbgPathSafe + '", 8, True)');
        vbsLines.push('  ts.WriteLine IsoNow() & " [vbs] " & s');
        vbsLines.push('  ts.Close');
        vbsLines.push('End Sub');
        vbsLines.push('Dbg "vbs start: " & WScript.ScriptFullName');
        vbsLines.push('Set W = WScript.CreateObject("WScript.Shell")');
        // WMI 杀旧进程精确化：只终止「node.exe 且命令行包含本扩展根目录下 server 脚本
        // 完整路径之一」的进程。旧逻辑 LIKE '%ae-bridge%'/'%mcp-bridge%' 纯子串匹配，
        // 会误杀命令行恰好含该子串的无关进程（如 notepad D:\notes\ae-bridge-设计.md）。
        // wqlLikeEscape — 把 Windows 路径转义为 WQL LIKE 字面量（五步，前四步顺序不可换）：
        //   ① \ → \\：WQL 字符串以反斜杠为转义符，字面反斜杠必须写两个（否则 Invalid query）；
        //   ② [ → [[] ：LIKE 中 [ 是字符类定界符，字面 [ 用 [[] 表示；
        //   ③ _ → [_] ：LIKE 通配符（任意单字符），官方转义写法即字符类 [_]；
        //   ④ % → [%] ：LIKE 通配符（任意长度串），同理用字符类 [%]。
        //   ⑤ ' → \'：WQL 字符串字面量内单引号需反斜杠转义（对齐 about_WQL 文档；
        //              扩展装在含撇号路径如 C:\Users\O'Brien\ 下时，裸 ' 提前终止
        //              字符串 → 查询 Invalid query → ExecQuery 抛错被 On Error Resume
        //              Next 吞掉 → 旧 bridge 进程杀不掉 → 新进程端口被占起不来）。
        //              必须放在 ① 之后追加，插入的 \ 才不会被二次翻倍。
        // 大小写：WQL 的 = 与 LIKE 比较均不区分大小写（Windows 路径语义一致），无需显式处理。
        function wqlLikeEscape(s) {
            return s.replace(/\\/g, "\\\\").replace(/\[/g, "[[]")
                    .replace(/_/g, "[_]").replace(/%/g, "[%]")
                    .replace(/'/g, "\\'");
        }
        // 映像名条件用 Name（Win32_Process 无 ImageName 属性，那是 tasklist/性能计数器的叫法）。
        // 改名前残留的旧进程命令行指向 legacyPathSafe，一并精确匹配，保持原「杀旧进程」语义。
        var wqlPath1 = wqlLikeEscape(bridgePathSafe);
        var wqlPath2 = wqlLikeEscape(serverPathSafe);
        var wqlPath3 = wqlLikeEscape(legacyPathSafe);
        vbsLines.push('Set svc = GetObject("winmgmts:\\\\.\\root\\cimv2")');
        vbsLines.push('Set procs = svc.ExecQuery("SELECT * FROM Win32_Process WHERE Name = \'node.exe\' AND (CommandLine LIKE \'%' + wqlPath1 + '%\' OR CommandLine LIKE \'%' + wqlPath2 + '%\' OR CommandLine LIKE \'%' + wqlPath3 + '%\')")');
        vbsLines.push('killed = 0');
        vbsLines.push('For Each p In procs');
        vbsLines.push('  p.Terminate()');
        vbsLines.push('  killed = killed + 1');
        vbsLines.push('Next');
        vbsLines.push('Dbg "wmi query err=" & Err.Number & " killed=" & killed');
        vbsLines.push('WScript.Sleep 500');
        // 隐藏窗口启动 node（intWindowStyle=0, bWaitOnReturn=False）；
        // --bridge-token-file 传 token 交接文件路径（bridge 敏感端点鉴权）
        // 引号结构（H1R 修复）：整条命令是单个 VBScript 字符串字面量，路径两侧的引号是
        // 字符串内的"嵌入式字面引号"（两个 "），不是字符串定界——`=` 后写 `""` 而非 `"""`：
        // 三引号的前两个成字面引号、第三个会提前关闭字符串，其后 tokenPath 变裸代码，
        // wscript 报 800A0401「语句未结束」(9,217) 且整脚本不执行（bridge 从未启动）。
        // 首尾的 `"""` 是「开字符串+字面引号」/「字面引号+关字符串」，仅行首行尾合法。
        // 最终传给 W.Run 的命令行："NODE" "BRIDGE" --bridge-token-file="TOKEN"
        vbsLines.push('r = W.Run("""' + nodePath + '"" ""' + bridgePathSafe + '"" --bridge-token-file=""' + tokenPathSafe + '""", 0, False)');
        vbsLines.push('Dbg "W.Run rc=" & r & " err=" & Err.Number & " " & Err.Description');

        // 写 .vbs：检查 open/write 返回值。Temp 不可写/磁盘满时会生成空或半截 .vbs，
        // wscript 执行失败返回非零退出码——恰是上方注释要规避的 system.callSystem 弹窗路径。
        // 失败（open 拒绝或 write 失败）则跳过 wscript 直接走 cmd start 兜底；open 成功后
        // 无论 write 结果都 close（句柄不泄漏）。
        //
        // 编码修复：不设 encoding = 按系统代码页写盘。扩展/数据目录含
        // 用户名（%APPDATA%），用户名或数据目录含该代码页表示不了的字符（英文系统 + 中文
        // 用户名、emoji）时，VBS 内容里的 node/bridge/token 路径被静默写成 '?' → W.Run 起不
        // 来桥、cmd 兜底同样失败，重试不自愈。改为 UTF-16LE 写盘并显式以首字符写 BOM：
        // wscript/cscript 只把「带 BOM 的 UTF-16LE」识别为 Unicode 脚本（UTF-8 不被 WSH
        // 接受，会按 ANSI 逐字节读 → 每个 ASCII 字符间夹 0x00，800A0401 整脚本不执行）。
        // 依据 Adobe《JavaScript Tools Guide》Unicode I/O：16 位 Unicode 写入用 UCS-2
        //（Windows 平台字节序即 UTF-16LE），BOM 必须由写入方写为首字符，引擎不自动补。
        // 编码是 File 实例属性、非全局，写完复位到系统默认（避免该实例被复用时带上 Unicode
        // 编码）。open() 的编码探测在部分实现里会重置 encoding，故 open 成功后再钉一次；
        // 写后回读前两字节自证 BOM（FF FE）确实落盘，否则按「未写成」走 cmd 兜底——绝不把
        // 非 Unicode 的 .vbs 交给 wscript（失败无声，只剩面板浮层，正是该故障的现场）。
        // 修复（真机实测）：内容全 ASCII 时按默认编码直写——ASCII 在任何代码页
        // 下都安全，且这条路径一直可用；而无条件 UTF-16LE 通道在真机上未被
        // 引擎接受（写出无 BOM → 自证失败 → 桥永不启动、走 cmd 兜底再失败 → 弹模态框）。
        // 仅当内容含非 ASCII（用户名/路径带非本代码页字符）才走 UTF-16LE+BOM 并用自证把关，
        // 自证不过则退回默认编码直写（尽力而为，残留风险在 cmd 兜底与 encNote 归因里可见）。
        var vbsText = vbsLines.join('\r\n') + '\r\n';
        var vbsNeedUnicode = /[^\x00-\x7F]/.test(vbsText);
        var vbsWritten = false;
        if (vbsFile) {
            try {
                if (vbsNeedUnicode) {
                    var vbsEnc = "UTF-16LE";
                    try {
                        if (typeof File.isEncodingAvailable === "function" && !File.isEncodingAvailable(vbsEnc)) {
                            vbsEnc = "UCS-2";   // 同族备用名（Adobe 文档推荐写法，Windows 同为 LE）
                        }
                    } catch (_) {}
                    vbsFile.encoding = vbsEnc;
                    if (vbsFile.open("w")) {
                        try {
                            vbsFile.encoding = vbsEnc;  // open 的编码探测可能已重置，写前再钉一次
                            vbsWritten = vbsFile.write('\uFEFF' + vbsText);
                        } finally {
                            vbsFile.close();
                        }
                    }
                    try { vbsFile.encoding = ""; } catch (_) {}
                    if (vbsWritten) {
                        // 自证：首两字节必须是 FF FE。用同一 File 实例重开（BINARY 读），
                        // 不新建对象（避免第二把句柄/额外 File 创建被其他启动链断言计入）。
                        var vbsBomOk = false;
                        try {
                            vbsFile.encoding = "BINARY";
                            if (vbsFile.open("r")) {
                                var vbsHead = String(vbsFile.read(2) || "");
                                vbsFile.close();
                                vbsBomOk = vbsHead.length === 2
                                    && vbsHead.charCodeAt(0) === 0xFF && vbsHead.charCodeAt(1) === 0xFE;
                            }
                            try { vbsFile.encoding = ""; } catch (_) {}
                        } catch (_) { vbsBomOk = false; }
                        if (!vbsBomOk) {
                            _dbgLog("[startBridge] vbs UTF-16LE BOM missing — plain write fallback");
                            vbsWritten = false;
                        }
                    }
                    if (!vbsWritten) {
                        try {
                            if (vbsFile.open("w")) {
                                try { vbsWritten = vbsFile.write(vbsText); } finally { vbsFile.close(); }
                            }
                        } catch (_) { vbsWritten = false; }
                    }
                } else {
                    // ASCII 内容：默认编码直写（wscript 按 ANSI 读全兼容）
                    if (vbsFile.open("w")) {
                        try { vbsWritten = vbsFile.write(vbsText); } finally { vbsFile.close(); }
                    }
                }
            } catch (_) { vbsWritten = false; }
        }
        _dbgLog("[startBridge] vbs " + (vbsWritten ? "written" : (vbsPath ? "WRITE FAILED" : "SKIPPED (no handoff dir)"))
            + ": " + (_asciiPathForLog(vbsPath) || "数据目录与系统 temp 都不可用——按政策不落盘")
            + " node=" + _asciiPathForLog(nodePath));

        // ── 非 ANSI 路径下的启动通道与归因──────────────────────────
        // system.callSystem 的命令行按系统代码页转字节：路径含该代码页表示不了的字符时
        // 会变 '?'（wscript 找不到 .vbs、cmd start 找不到 node）。规避法：命令行只出现
        // **纯 ASCII 字面量**，目录经进程 cwd 传递——Folder.current 是 ExtendScript 官方
        // 支持的「设置当前目录」入口（File/Folder 路径参数走 Unicode API，不经命令行编码）。
        // 两条运行时自证，任一不成立就退回绝对路径写法（ASCII 环境逐字不变：
        // vbsPath 全 ASCII 时根本不进这条通道）：
        //   ① Folder.current 读回 == handoff 目录（setter 真生效）；
        //   ② 切换前后 `cd` 输出不同且落点以 handoff 结尾（子进程确实继承 cwd，不是只改了
        //      脚本引擎内部状态）。②失败时启动相对名会 800A0401/找不到文件，而 wscript
        //      非零退出会弹 AE 模态框——所以必须运行期证实，不能只靠系统语义假设。
        // cwd 是进程级状态：进入后必须在 finally 立即恢复，缩短影响窗口（callSystem 同步，
        // 执行期间 AE 主线程本就阻塞；恢复失败最坏是 AE 的 cwd 停在数据目录，不影响功能）。
        // _normPath/_leafName/_enterCwd(_handoff)/_restoreCwd 已提升至文件作用域
        // （探测链路共用）；此处仅保留调用。
        // wscript 启动：vbsPath 含非 ASCII 时走「cwd=handoff + 纯 ASCII 文件名」；
        // 纯 ASCII 路径直接绝对路径启动（不做多余 cwd 切换）
        function launchViaWscript() {
            if (!_hasNonAscii(vbsPath)) {
                return system.callSystem('wscript "' + vbsPath + '"');
            }
            var vbsName = _leafName(vbsPath);
            var cwdSt = null;
            if (vbsName && !_hasNonAscii(vbsName)) {
                cwdSt = _enterCwd(_handoff);
            }
            try {
                if (cwdSt && cwdSt.moved) {
                    _dbgLog("[startBridge] wscript via cwd-relative name (non-ASCII-safe): " + vbsName);
                    return system.callSystem('wscript "' + vbsName + '"');
                }
                _dbgLog("[startBridge] wscript falls back to absolute path containing non-ASCII; "
                    + "system codepage may mangle it: " + _asciiPathForLog(vbsPath));
                return system.callSystem('wscript "' + vbsPath + '"');
            } finally {
                _restoreCwd(cwdSt);
            }
        }

        // 兜底：cmd start（start 返回 0，不弹窗）
        // 此处用 nodePath（vendor 缺失时已回退 PATH node.exe）而非 vendorNode——
        // 否则精简部署 + .vbs 写失败两条件叠加时，start 启动不存在的绝对路径，bridge 静默未启动
        function launchViaStart(reason) {
            // 编码归因：非 ASCII 路径在系统代码页不能表示时会被写成 '?'，start
            // 兜底与 wscript 同因失效。把归因写进诊断日志（面板失败浮层/诊断包据此区分
            // 「桥没起来」是端口、依赖还是路径编码问题），路径用 File.encode ASCII 化。
            var encNote = "";
            if (_hasNonAscii(nodePath) || _hasNonAscii(bridgePathSafe) || _hasNonAscii(tokenPathSafe)) {
                encNote = " [path-encoding] 命令行含非 ASCII 路径，系统代码页不能表示时会被写成 '?'；"
                    + "建议把扩展安装目录与数据目录移到纯 ASCII 路径。"
                    + " node=" + _asciiPathForLog(nodePath)
                    + " bridge=" + _asciiPathForLog(bridgePathSafe)
                    + " tokenPath=" + _asciiPathForLog(tokenPathSafe);
            }
            $.writeln("[AS_ExtP] Bridge: " + reason + ", trying start fallback");
            _dbgLog("[startBridge] start fallback: " + reason + encNote);
            // token 与 .vbs 同在 handoff 目录：token 路径非 ASCII 时改用「cwd=handoff +
            // 纯 ASCII 文件名」传递（同上方通道）。node/bridge 在安装目录、其路径非 ASCII
            // 时命令行无法绕开（已进 encNote 归因）——这是该兜底链路的已知残余。
            var tokenArg = tokenPathSafe;
            var cwdSt = null;
            if (tokenPath && _handoff && _hasNonAscii(tokenPathSafe)) {
                var tokenName = _leafName(tokenPath);
                if (tokenName && !_hasNonAscii(tokenName)) {
                    cwdSt = _enterCwd(_handoff);
                    if (cwdSt.moved) tokenArg = tokenName;
                }
            }
            try {
                var out2 = system.callSystem('cmd /c start "" /MIN "' + nodePath + '" "' + bridgePathSafe
                    + '" --bridge-token-file="' + tokenArg + '"');
                _dbgLog("[startBridge] start fallback out: " + out2);
                $.writeln("[AS_ExtP] Bridge: start fallback launched");
            } catch (e2) {
                _dbgLog("[startBridge] start fallback EXCEPTION: " + e2.toString());
                $.writeln("[AS_ExtP] Bridge: all launch methods failed: " + e2.toString());
            } finally {
                _restoreCwd(cwdSt);
            }
        }

        if (vbsWritten) {
            // wscript 同步执行 .vbs：VBS 内 W.Run(...,False) 不等待 node，wscript 很快退出（~600ms）
            // wscript 退出码 0（On Error Resume Next 保证无脚本错误），不触发 system.callSystem 弹窗
            try {
                var out1 = launchViaWscript();
                _dbgLog("[startBridge] wscript out: " + out1);
                $.writeln("[AS_ExtP] Bridge: wscript launched, node=" + nodePath);
            } catch (e) {
                _dbgLog("[startBridge] wscript EXCEPTION: " + e.toString());
                launchViaStart("wscript failed: " + e.toString());
            }
        } else {
            launchViaStart("vbs write failed");
        }
        // AEFS 例外（同 _sweepHandoffLeftovers）：启动链里删自己刚写的 .vbs 交接件，
        // 此刻桥尚未就绪、面板尚未接管，裸 File.remove 是唯一可用手段
        try { vbsFile.remove(); } catch (_) {}

    } else {
        try {
            // macOS/其他：token 交接文件用 POSIX 路径形态（数据目录按平台自然形态给出）
            system.callSystem('node "' + bridgePath + '" --bridge-token-file="' + tokenPath + '" &');
            $.writeln("[AS_ExtP] Bridge auto-started (background)");
        } catch (e) {
            $.writeln("[AS_ExtP] Failed to auto-start bridge: " + e.toString());
        }
    }
}

function isWindows() {
    return $.os.indexOf("Windows") >= 0;
}

var _bridgeStarted = false;

function initExtension() {
    if (_bridgeStarted) return;
    _bridgeStarted = true;
    startBridge();
}

// panel 运行时 Bridge 崩溃后可通过 evalScript 调用此函数强制重启
// 重置一次性守卫 → startBridge() 内部 WMI 杀旧 ae-bridge 进程后重新拉起 node
function restartBridge() {
    _bridgeStarted = false;
    initExtension();
    return "OK";
}

// ── 宿主 API 模块加载失败握手────────────────────────────────────
// main.js 的 evalScript 回调只 console.log、loadHostApiModules 的 evalFile
// 失败只有 $.writeln——用户在面板侧拿不到归因。这里把失败逐条写进既有交接目录
// temp/handoff/ae_extp_host_load_errors.json（面板可读，多实例标记同目录先例），
// 同时 _dbgLog 落启动链诊断日志；下一次加载全部成功则删掉该文件，不留陈旧失败。
// 注：host.jsx 整体未被 evalFile 成功加载（evalScript 返回 "ERR:…"）的场景发生在
// 本文件执行之前，host 侧无法落盘，只能由面板 side 的回调处理。
var _HOST_LOAD_ERRORS_NAME = "ae_extp_host_load_errors.json";

// ExtendScript 无 JSON——最小字符串转义（引号/反斜杠/控制字符）
function _jsonEscHostStr(s) {
    var str = String(s == null ? "" : s);
    var out = "";
    for (var i = 0; i < str.length; i++) {
        var c = str.charAt(i);
        var code = str.charCodeAt(i);
        if (c === "\\") out += "\\\\";
        else if (c === "\"") out += "\\\"";
        else if (c === "\r") out += "\\r";
        else if (c === "\n") out += "\\n";
        else if (c === "\t") out += "\\t";
        else if (code < 0x20) out += " ";
        else out += c;
    }
    return out;
}

// errors: [{module, error}]；空数组 = 清掉旧握手文件（本次加载无失败）
function _writeHostLoadErrors(errors) {
    var dir = "";
    try { dir = _handoffDir(); } catch (_) { dir = ""; }
    if (!dir) return false;
    var f = new File(dir + "/" + _HOST_LOAD_ERRORS_NAME);
    if (!errors || !errors.length) {
        try { if (f.exists) f.remove(); } catch (_) {}
        return true;
    }
    try {
        if (!f.open("w")) return false;
        var items = [];
        for (var i = 0; i < errors.length; i++) {
            items.push('{"module":"' + _jsonEscHostStr(errors[i].module)
                + '","error":"' + _jsonEscHostStr(errors[i].error) + '"}');
        }
        var ok = f.write('{"ts":' + (new Date()).getTime() + ',"iso":"'
            + _isoUtc(new Date()) + '","errors":[' + items.join(",") + ']}');
        f.close();
        return !!ok;
    } catch (_) { return false; }
}



(function loadHostApiModules() {
    // 若 API 函数已被 preload 或其他机制加载，跳过。
    // 早退必须同时覆盖全部 API 函数：只查旧函数会漏掉后新增的模块（如热盒的
    // effectApi/scriptRunner/presetApi），导致 AEGP 调用 applyEffectToSelectedLayers
    // 或 applyPresetToSelectedLayers 时报"函数未定义"。
    if (typeof getProjectState === "function" && typeof assets_getActiveComp === "function"
        && typeof applyEffectToSelectedLayers === "function"
        && typeof runScriptSandboxed === "function"
        && typeof applyPresetToSelectedLayers === "function") return;
    var hostFile = new File($.fileName);
    // 扩展根优先取面板注入的 __AS_EXTP_ROOT（$.fileName 真机上锚不到本文件，
    // 会把 api 目录算成 AE 应用目录下的 Support Files/api）；两者都取不到时按存在性择优。
    var _rootFs = _extRootFs();
    var hostDirFs = "";
    if (_rootFs) hostDirFs = _rootFs.replace(/\\/g, "/") + "/host";
    else { try { if (hostFile.parent && hostFile.parent.fsName) hostDirFs = String(hostFile.parent.fsName).replace(/\\/g, "/"); } catch (_) {} }
    var apiDir = hostDirFs ? hostDirFs + "/api" : "";
    if (apiDir && !(new Folder(apiDir)).exists) {
        try {
            var _altDir = String(hostFile.parent.fsName).replace(/\\/g, "/");
            if ((new Folder(_altDir + "/api")).exists) { apiDir = _altDir + "/api"; hostDirFs = _altDir; }
        } catch (_) {}
    }
    var extRootFs = hostDirFs.replace(/\/host$/, "");
    var loadErrors = [];
    $.writeln("[AS_ExtP] Loading API modules from: " + apiDir);

    var modules = [
        // JSON polyfill 必须最先加载：runtimeApi/aeTools 及所有工具执行通道
        // （bootstrap.js 的 JSON.parse、executeExtendScript 的 JSON.stringify）都依赖引擎有 JSON。
        // ExtendScript 无原生 JSON，缺失会让工具执行在用户代码跑之前就崩。
        { name: "json2", path: apiDir + "/json2.jsx" },
        { name: "runtimeApi", path: apiDir + "/runtimeApi.jsx" },
        { name: "projectAssetApi", path: apiDir + "/projectAssetApi.jsx" },
        { name: "presetApi", path: apiDir + "/presetApi.jsx" },
        { name: "effectApi", path: apiDir + "/effectApi.jsx" },
        { name: "scriptRunner", path: apiDir + "/scriptRunner.jsx" }
    ];

    for (var i = 0; i < modules.length; i++) {
        var mod = modules[i];
        var f = new File(mod.path);
        if (!f.exists) {
            $.writeln("[AS_ExtP] WARNING: Module file not found: " + mod.path);
            loadErrors.push({ module: mod.name, error: "module file not found: " + mod.path });
            continue;
        }
        try {
            $.evalFile(mod.path);
            $.writeln("[AS_ExtP] Loaded: " + mod.name);
        } catch (e) {
            $.writeln("[AS_ExtP] ERROR loading " + mod.name + ": " + e.toString());
            loadErrors.push({ module: mod.name, error: e.toString() });
        }
    }

    if (typeof getProjectInfo !== "function") {
        var toolsPath = extRootFs + "/client/modules/ae-tools/aeTools.jsx";
        var toolsFile = new File(toolsPath);
        if (toolsFile.exists) {
            try {
                $.evalFile(toolsPath);
                $.writeln("[AS_ExtP] Loaded aeTools from: " + toolsPath);
            } catch (e) {
                $.writeln("[AS_ExtP] ERROR loading aeTools: " + e.toString());
                loadErrors.push({ module: "aeTools", error: e.toString() });
            }
        } else {
            loadErrors.push({ module: "aeTools", error: "file not found: " + toolsPath });
        }
    }

    // 汇总态：文件都在但函数仍不可挂载（异常被吞/加载器异常）也要可归因
    var hasAeToolsError = false;
    for (var le = 0; le < loadErrors.length; le++) {
        if (loadErrors[le].module === "aeTools") hasAeToolsError = true;
    }
    if (!hasAeToolsError && typeof getProjectInfo !== "function") {
        loadErrors.push({ module: "aeTools", error: "getProjectInfo unavailable after load" });
    }
    for (var lg = 0; lg < loadErrors.length; lg++) {
        _dbgLog("[hostApi] load failed: " + loadErrors[lg].module + ": " + loadErrors[lg].error);
    }
    _writeHostLoadErrors(loadErrors);

    $.writeln("[AS_ExtP] API modules loaded. AE tools available: " + (typeof getProjectInfo === "function"));
})();

initExtension();
