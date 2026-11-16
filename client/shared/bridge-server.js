/**
 * AE LLM Bridge Server — Node.js 端
 *
 * 本地 HTTP + WebSocket 服务器，监听 127.0.0.1:9877。
 * 提供文件 I/O、图片读取等 HTTP 端点，以及 WebSocket 扩展点（供 MCP 等模块注册）。
 *
 * HTTP 端点：
 *   GET  /health              — 健康检查
 *   POST /fs/read             — 读文件  { path }           → { ok, data }
 *   POST /fs/write            — 写文件  { path, content }  → { ok }
 *   POST /fs/mkdir            — 建目录  { path }           → { ok }
 *   POST /fs/list             — 列目录  { path }           → { ok, files[], dirs[] }
 *   POST /fs/delete           — 删文件  { path }           → { ok }
 *   POST /fs/exists           — 存在？ { path }           → { ok, exists }
 *   POST /fs/exists-batch     — 批量存在？ { paths[] }     → { ok, exists[], invalid[] }（一次往返省逐条开销）
 *   POST /fs/is-file          — 是文件？ { path }          → { ok, isFile } (只读，对齐 exists 安全级别)
 * POST /fs/is-link — 是链接？ { path } → { ok, isLink, realpath } (只读；- 方案③，删除/重命名前的链接提示用)
 *   POST /fs/rmdir            — 删空目录 { path }           → { ok } (非递归，拒绝非空)
 *   POST /fs/rename           — 重命名   { src, dst }      → { ok }
 *   POST /fs/copy-file        — 拷文件   { src, dst }      → { ok }
 * POST /fs/copy-dir — 拷目录 { src, dst } → { ok, copied, failed }（failed 为单文件拷贝失败计数）
 *   POST /fs/remove-dir-recursive — ⚠️ 危险：递归删整棵目录树 { path } → { ok }
 *       安全校验链：safePath(格式) + safeForDelete(命名空间白名单) + minDepthOk(2) + resolveRealSafe(symlink逃逸)
 *       用于批量删除性能优化（一次 rmSync 替代逐个 deleteFile），不可恢复
 *   POST /api/read-image      — 读图片转 base64
 *   POST /api/parse-doc       — 解析文档/表格/PDF 为结构化文本 { path } → { ok, text, format }
 *   POST /api/download-url    — 代理 HTTPS 下载（回传给 CEP，替代 certutil system.callSystem）
 *   POST /api/clipboard-image - 读系统剪贴板（图片 base64 / 文件路径列表，CEP 粘贴按钮免 Ctrl+V）
 *   POST /api/reveal-path     - 在 OS 文件管理器中定位路径 { path } → { ok, mode }（文件=打开所在目录并选中）
 *   POST /api/set-data-dir    - 同步数据目录 { dataDir } -> { ok, dataDir }
 *   POST /api/ffmpeg-transcode - 异步转码 mov/mp4 → webm { input, output, maxWidth } → { ok, taskId }
 *   POST /api/ffmpeg-frame    - 抽视频第一帧存成 JPEG { input, output, maxWidth } → { ok, output }
 *
 * 安全模型：
 *   所有 /fs/* 端点均经过 safePath 格式校验（拒 %/控制符/引号/..段/非绝对路径/DOS 设备名；
 *   唯一例外：面板经 /api/set-data-dir 同步的数据根 UNC 本身及其子路径，见 _allowedUncRoot）。
 *   删除类端点（delete/rmdir/remove-dir-recursive）额外检查：
 *     - safeForDelete：路径必须在 SAFE_NAMESPACES 白名单命名空间内（L197）
 *     - minDepthOk：路径深度≥2，防误删盘根
 *     - resolveRealSafe：消解 symlink/junction 后重校验，防符号链接逃逸
 *   SAFE_NAMESPACES 与 AEFS 端保持一致，新增需删除能力的模块时同步更新两处。
 *
 * WebSocket 扩展：
 *   addWsHandler(fn) — 注册消息处理器，fn(msg, socket, sendFrame)
 *
 * 使用方式：
 *   var bridge = require('./shared/bridge-server.js');
 *   bridge.addWsHandler(function(msg, socket, send) { ... });
 *   bridge.start();
 */

var http = require('http');
var https = require('https');
var crypto = require('crypto');
var fs = require('fs');
var path = require('path');
var url = require('url');

var PORT = 9877;
var WS_MAGIC = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ========== 数据目录（与 dataDir.js 默认逻辑一致） ==========

// Bridge 是独立 Node 进程，无法访问 CEP 面板的 AEShared.getDataDir()。
// 启动时从 process.env.APPDATA 计算默认数据目录；CEP 面板就绪后通过
// POST /api/set-data-dir 同步用户自定义路径（含自定义目录场景）。
var _dataDir = '';
(function _resolveDefaultDataDir() {
    try {
        var appdata = process.env.APPDATA || '';
        if (appdata) {
            _dataDir = appdata.replace(/\//g, '\\').replace(/\\+$/, '') + '\\Adobe\\CEP\\extensions\\AS_ExtP';
        }
    } catch (_) {}
})();

function _getLogPath() {
    return _dataDir ? path.join(_dataDir, 'temp', 'bridge', 'bridge.log')
                    : '';   // 无数据目录时不写文件日志（不落系统临时目录）
}

// ========== 进程级错误处理 ==========

var LOG_MAX_BYTES = 1024 * 1024;      // 1MB 上限
var LOG_KEEP_BYTES = 512 * 1024;      // 超限后保留末尾 512KB

function _stamp() {
    return new Date().toISOString();
}

// 落盘脱敏：bridge.log 可能被用户原样贴出/提交，Key/Token/用户名不进磁盘。
// bridge 是独立 Node 进程，无法加载面板的 logger.js（window 模块），规则表在此镜像同一套；
// 改脱敏规则时与 client/shared/logger.js 的 redact 同步。
function _redactLog(text) {
    try {
        return String(text)
            .replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
            .replace(/Bearer\s+\S+/gi, 'Bearer ***')
            .replace(/(api[_-]?key["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(token["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(password["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(Authorization[ \t]*:[ \t]*Basic[ \t]+)\S+/gi, '$1***')
            .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
            .replace(/([A-Za-z0-9-]*(?:session|secret|credential)[A-Za-z0-9-]*["']?[ \t]*[:=][ \t]*)(["']?)(?=[A-Za-z0-9._\-+/=]{8,})(?:[A-Za-z0-9._\-+/=]*\d[A-Za-z0-9._\-+/=]*|[A-Za-z0-9._\-+/=]{20,})/gi, '$1$2***')
            .replace(/(\/\/)[A-Za-z0-9._%\-]{1,64}:[^\s@\/]{1,64}@/g, '$1***@')
            .replace(/([A-Za-z]:[\\/])Users[\\/][^\\/\s]+/gi, '$1Users\\<user>');
    } catch (_) {
        return String(text);
    }
}

function _appendLog(line) {
    try {
        line = _redactLog(line);
        var logPath = _getLogPath();
        if (!logPath) return;   // 数据目录不可解析：不写文件日志（不放系统临时目录）
        // 确保日志目录存在
        var logDir = path.dirname(logPath);
        if (!fs.existsSync(logDir)) {
            try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
        }
        // 超 1MB 截断：只保留末尾 512KB
        if (fs.existsSync(logPath)) {
            var st = fs.statSync(logPath);
            if (st.size > LOG_MAX_BYTES) {
                var fd = fs.openSync(logPath, 'r');
                var buf = Buffer.alloc(LOG_KEEP_BYTES);
                var bytesRead = fs.readSync(fd, buf, 0, LOG_KEEP_BYTES, st.size - LOG_KEEP_BYTES);
                fs.closeSync(fd);
                fs.writeFileSync(logPath, buf.slice(0, bytesRead));
            }
        }
        fs.appendFileSync(logPath, line);
    } catch (_) {}
}

// host.jsx 用 W.Run(cmd, 0, False) 隐藏启动本进程，且不重定向 stdout/stderr——
// 生产环境下两个流没有任何接收方，console.log 会静默丢弃。接管 write 把内容同时落盘，
// 使 log() 及此后新增的 console.* 都能留存，无需改动各调用点。
// 落盘先于转发：即使紧随其后崩溃，该条记录也已写出。
// 只剥行尾换行、保留块内换行，不做行缓冲（避免半行悬挂与跨进程交错）。
function _installStdioTee() {
    [{ stream: process.stdout, level: 'LOG' },
     { stream: process.stderr, level: 'ERR' }].forEach(function (t) {
        var stream = t.stream;
        if (!stream || typeof stream.write !== 'function' || stream.__aeLogTee) return;
        var orig = stream.write;
        stream.write = function (chunk) {
            try {
                var text = typeof chunk === 'string' ? chunk
                         : (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
                if (text) _appendLog(_stamp() + ' [' + t.level + '] ' + text.replace(/[\r\n]+$/, '') + '\n');
            } catch (_) {}
            // 原样转发并返回原返回值（保 backpressure / 回调语义）
            return orig.apply(stream, arguments);
        };
        stream.__aeLogTee = true;
    });
}

process.on('uncaughtException', function (err) {
    _appendLog(_stamp() + ' [UNCAUGHT] ' + (err && err.stack || err) + '\n');
    // 崩溃也不能孤儿化 MCP 子进程：先跑清理钩子再退出
    try { _doGracefulExit(1); } catch (_) { try { process.exit(1); } catch (_) {} }
});

process.on('unhandledRejection', function (reason) {
    _appendLog(_stamp() + ' [UNHANDLED_REJECTION] ' + (reason && reason.stack || reason) + '\n');
});

// Ctrl+C / 结束进程信号：走优雅退出，确保 MCP 子进程被清理
process.on('SIGINT', function () { _doGracefulExit(0); });
process.on('SIGTERM', function () { _doGracefulExit(0); });

// ========== 日志 ==========

// 统一行格式：ISO 时间戳 + [级别] + 内容
function log(msg) {
    console.log('[Bridge] ' + msg);
}

function logErr(msg) {
    _appendLog(_stamp() + ' [ERR] ' + msg + '\n');
}

_installStdioTee();

// ========== 敏感路径拒读（凭据/密钥文件，读端点专用） ==========

// 目录段黑名单（任一路径段精确等于即拒；段级精确匹配，禁止子串匹配防误伤 my.ssh 等）
// 吸收 skill-manager llmTools 旧本地副本独有条目 .config（四份副本单点化，
// 面板侧权威实现为 aefs.js——Node 侧无法运行时共享，靠同构实现 + 测试锚定）
var SENSITIVE_DIR_SEGMENTS = ['.ssh', '.aws', '.azure', '.gcloud', '.gnupg', '.kube', '.docker', '.config'];
// 文件名黑名单（basename 精确等于，小写）：浏览器登录态/cookie/密钥串/私钥/凭据文件
// 吸收 llmTools 独有条目 credentials/cookies.db
var SENSITIVE_FILE_NAMES = ['login data', 'cookies', 'local state', 'web data',
    'key4.db', 'logins.json', 'signons.sqlite', 'login.keychain-db',
    '.netrc', '.npmrc', '.pypirc', '.git-credentials',
    'id_rsa', 'id_ed25519', 'id_ecdsa', 'id_dsa', '.pgpass',
    'credentials', 'cookies.db'];

// Win32 8.3 短名键（与 aeTools.jsx/aefs.js _shortNameKey 同构）——系统卷
// 默认开启短名生成，黑名单长名文件的确定性短别名（实测：Login Data→LOGIND~1、
// logins.json→LOGINS~1.JSO、.env→ENV~1、.git-credentials→GIT-CR~1 等）与精确
// 全等/后缀匹配全部失配。生成规则（实测归纳）：name/ext 以「位置>0 的最后一个点」
// 分界，两部分各去点与空格后取 name 前 6 / ext 前 3 字符，前导点文件（.env）
// 整体为 name。DPAPI 组合段 microsoft/credentials（9/11 字符）的短名
// MICROS~1/CREDEN~1 同理由该键比对覆盖。
function _shortNameKey(name) {
    var dot = name.lastIndexOf('.');
    var nm = dot > 0 ? name.substring(0, dot) : name;
    var ext = dot > 0 ? name.substring(dot + 1) : '';
    var n = nm.replace(/[ .]/g, '').substring(0, 6);
    if (!n) return '';
    // 仅「有短名形态」的条目参与比对：前导点文件（dot===0）/含空格/去点空格后超
    // 8 字符——≤8 字符的合法名（cookies/key4.db）无短名别名，生成键会把 cookie~1
    // 误判为 cookies 的短名（实测 cookies 短名就是自身）
    var plain = name.replace(/[ .]/g, '');
    if (dot !== 0 && name.indexOf(' ') < 0 && plain.length <= 8) return '';
    return n + '|' + (ext ? ext.replace(/[ .]/g, '').substring(0, 3) : '');
}

// 敏感路径拒读：浏览器登录态/cookie/SSH 私钥/云凭据/DPAPI 等文件，即使路径过了 safePath +
// resolveRealSafe 也不许经 bridge 读出（防面板侧注入读取本机凭据外泄）。
// 仅作用于读端点（read/read-blob/list/exists/is-file/read-image），写/删端点不动。
// 归一化：\→/、小写、压连续斜杠；全部为段级精确匹配（文件名取最后一段 basename）。
function _isSensitivePath(p) {
    if (!p || typeof p !== 'string') return false;
    var norm = p.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    var segs = norm.split('/').filter(function (s) { return s.length > 0; });
    var i, j;
    // 每段剥尾随点/空格再比对（对齐 aeTools.jsx ——
    // 只同步了 ADS 半族，全段尾点剥段缺失）：Win32 路径规范化会静默剥掉段尾的点与
    // 空格（"C:/x/.ssh." 实际打开 "C:/x/.ssh"），".ssh."/"id_rsa."/"microsoft./
    // credentials" 形态精确全等失配绕过；该段无冒号时 ADS 循环不触碰它
    for (i = 0; i < segs.length; i++) {
        segs[i] = segs[i].replace(/[. ]+$/, '');
    }
    // （同步 aeTools.jsx）：每段剥 NTFS 备用数据流（ADS）后缀——Win32 下
    // "id_rsa::$DATA" 打开的是 id_rsa 本体，段精确全等与 .pem/.key 后缀匹配均失配；
    // 剥首个冒号起至段尾再比对（盘符段单字母+冒号不剥），剥后补剥尾随点/空格
    for (i = 0; i < segs.length; i++) {
        if (segs[i].length === 2 && segs[i].charAt(1) === ':') continue;  // 盘符段保护
        var adsAt = segs[i].indexOf(':');
        if (adsAt >= 0) segs[i] = segs[i].substring(0, adsAt).replace(/[. ]+$/, '');
    }
    // 段级 8.3 短名键（name~N[.ext] 形态提取，与 _shortNameKey 同构；
    // name/ext 字符类含连字符——短名部分可含 -（实测 GIT-CR~1））
    var segKeys = [];
    for (i = 0; i < segs.length; i++) {
        var mk = /^([a-z0-9_-]{1,6})~[0-9]{1,2}(?:\.([a-z0-9_-]{1,3}))?$/.exec(segs[i]);
        segKeys[i] = mk ? (mk[1] + '|' + (mk[2] || '')) : '';
    }
    // ① 目录段黑名单（任一路径段精确命中；短名键同比对）
    for (i = 0; i < segs.length; i++) {
        for (j = 0; j < SENSITIVE_DIR_SEGMENTS.length; j++) {
            if (segs[i] === SENSITIVE_DIR_SEGMENTS[j]) return true;
            if (segKeys[i] && _shortNameKey(SENSITIVE_DIR_SEGMENTS[j]) === segKeys[i]) return true;
        }
    }
    // ② DPAPI 组合段：路径含连续段 microsoft/credentials 或 microsoft/protect
    // （短名键同比对；protect 为 7 字符合法名无短名形态，原样比对已足够）
    var msKey = _shortNameKey('microsoft');
    var crKey = _shortNameKey('credentials');
    for (i = 0; i + 1 < segs.length; i++) {
        var msHere = segs[i] === 'microsoft' || (segKeys[i] !== '' && segKeys[i] === msKey);
        var credNext = segs[i + 1] === 'credentials' || (segKeys[i + 1] !== '' && segKeys[i + 1] === crKey);
        if (msHere && (credNext || segs[i + 1] === 'protect')) return true;
    }
    var base = segs.length ? segs[segs.length - 1] : '';
    if (!base) return false;
    var baseKey = segKeys.length ? segKeys[segKeys.length - 1] : '';
    // ③ 文件名黑名单（basename 精确等于；短名键同比对）
    if (SENSITIVE_FILE_NAMES.indexOf(base) >= 0) return true;
    for (i = 0; i < SENSITIVE_FILE_NAMES.length; i++) {
        if (baseKey && _shortNameKey(SENSITIVE_FILE_NAMES[i]) === baseKey) return true;
    }
    // ④ 文件名模式：.env / .env.xxx / .envrc；以 .pem / .key / .pfx 结尾
    // （用 ".env." 前缀而非 ".env" 开头，避免误伤 .environment.md 这类合法文件，与 aeTools.jsx 侧口径一致）
    // 短名形态：ENV~1（键 "env|"）/ ENV~1.LOC（键 "env|loc"）——键以 "env|" 开头即命中；
    // .envrc 短名 ENVRC~1 键 "envrc|" 单列。.environment.md 短名键 "enviro|md" 不受影响。
    // .pem/.key/.pfx 后缀不受短名影响（短名扩展恰好保留 3 字符，此后缀规则天然覆盖）。
    if (base === '.env' || base.indexOf('.env.') === 0 || base === '.envrc') return true;
    if (baseKey && (baseKey.indexOf('env|') === 0 || baseKey === 'envrc|')) return true;
    if (/\.(pem|key|pfx)$/.test(base)) return true;
    return false;
}

// ========== WebSocket 帧处理 ==========

// 单帧声明长度与帧缓冲累计上限：HTTP 侧有 40MB/512MB 等多重上限，WS 侧曾完全没有——
// 客户端声明超大 len 后持续发送，decodeFrame 收不满整帧不消费，frameBuffer 无限累积直至 OOM。
// 超限 destroy 连接（decodeFrame 抛错走 data handler 的 catch → destroy）。
var MAX_WS_FRAME = 16 * 1024 * 1024;

function acceptWebSocket(req, socket) {
    var key = req.headers['sec-websocket-key'];
    if (!key) return false;
    var hash = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');
    socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' + hash + '\r\n\r\n'
    );
    return true;
}

function decodeFrame(buf) {
    if (buf.length < 2) return null;
    var fin = (buf[0] & 0x80) !== 0;
    var opcode = buf[0] & 0x0f;
    var masked = (buf[1] & 0x80) !== 0;
    var len = buf[1] & 0x7f;
    var offset = 2;
    if (len === 126) {
        if (buf.length < 4) return null;
        len = buf.readUInt16BE(2);
        offset = 4;
    } else if (len === 127) {
        if (buf.length < 10) return null;
        len = Number(buf.readBigUInt64BE(2));
        offset = 10;
    }
    // 单帧声明长度上限：防"声明 64 位超大 len + 持续发送"的无界缓冲累积（DoS）
    if (len > MAX_WS_FRAME) throw new Error('Frame too large: ' + len + ' bytes (max ' + MAX_WS_FRAME + ')');
    if (!masked) throw new Error('Client frame must be masked');
    var mask = buf.slice(offset, offset + 4);
    offset += 4;
    if (buf.length < offset + len) return null;
    var payload = Buffer.alloc(len);
    for (var i = 0; i < len; i++) {
        payload[i] = buf[offset + i] ^ mask[i % 4];
    }
    var remaining = buf.slice(offset + len);
    return { fin: fin, opcode: opcode, payload: payload, remaining: remaining };
}

// 分片重组（RFC 6455 5.4 节）：浏览器（CEF/Chromium）对超过其发送缓冲的消息会拆成
// [FIN=0 首片(opcode=text)] + [FIN=1 续片(opcode=continuation)]。把每个分片当
// 独立消息派发 → 大消息整体 JSON.parse 失败被静默丢弃：对面板只回一句 "Invalid JSON"
//（面板无此消息类型的 handler，直接忽略），外部 MCP 客户端则永久等不到回包，其
// tools/call FIFO 卡死、后续调用全部超时（实测截图类大回包必现；大小阈值取决于
// CEF 发送缓冲占用，非固定字节数）。按连接维护重组状态。
function createFrameReassembler(onMessage) {
    var opcode = 0;
    var chunks = [];
    var bytes = 0;
    function reset() { opcode = 0; chunks = []; bytes = 0; }
    return {
        push: function (frame) {
            if (frame.opcode === 0x0) {                 // 续片
                if (!chunks.length) { reset(); return; } // 无首片可续：丢弃该片
                chunks.push(frame.payload);
                bytes += frame.payload.length;
                if (frame.fin) {
                    var full = Buffer.concat(chunks, bytes);
                    var op = opcode;
                    reset();
                    if (op === 0x1 || op === 0x2) onMessage(full);
                }
                return;
            }
            // 控制帧（close/ping/pong）恒不分片；本就不处理 0x8/0x9/0xA
            if (frame.opcode === 0x8 || frame.opcode === 0x9 || frame.opcode === 0xA) return;
            if (!frame.fin) {                           // 首片：开始累积
                reset();
                opcode = frame.opcode;
                chunks = [frame.payload];
                bytes = frame.payload.length;
                return;
            }
            onMessage(frame.payload);                   // 未分片：原路径
        },
        bufferedBytes: function () { return bytes; }
    };
}

function sendFrame(socket, payload) {
    var buf;
    var len = payload.length;
    if (len < 126) {
        buf = Buffer.alloc(2 + len);
        buf[0] = 0x81;
        buf[1] = len;
        payload.copy(buf, 2);
    } else if (len < 65536) {
        buf = Buffer.alloc(4 + len);
        buf[0] = 0x81;
        buf[1] = 126;
        buf.writeUInt16BE(len, 2);
        payload.copy(buf, 4);
    } else {
        buf = Buffer.alloc(10 + len);
        buf[0] = 0x81;
        buf[1] = 127;
        buf.writeBigUInt64BE(BigInt(len), 2);
        payload.copy(buf, 10);
    }
    socket.write(buf);
}

// ========== 路径安全（与 AEFS _checkPath 对齐，纵深防御） ==========

function safePath(p) {
    if (!p || typeof p !== 'string') return false;
    // ① 拒 %（URL 编码攻击）
    if (p.indexOf('%') !== -1) { console.warn('[Bridge] 拒绝含 % 的路径: ' + p.substring(0, 80)); return false; }
    // ② 拒控制字符和引号
    for (var i = 0; i < p.length; i++) {
        var c = p.charCodeAt(i);
        if (c <= 0x1F || c === 0x7F || c === 0x22 || c === 0x27) {
            console.warn('[Bridge] 拒绝含非法字符的路径 (0x' + c.toString(16) + '): ' + p.substring(0, 80));
            return false;
        }
    }
    // ③ 拒 . 和 .. 作为路径段（含 : 边界——AEFS 对齐，防 D:.. 形式绕过）
    if (/(^|[\\\/\:])\.\.([\\\/\:]|$)/.test(p) || /(^|[\\\/\:])\.([\\\/\:]|$)/.test(p)) {
        console.warn('[Bridge] 拒绝含 . 或 .. 段的路径: ' + p);
        return false;
    }
    // ③b 段尾点/空格归一后为 . 或 .. 的别名段（Win32 剥尾语义）同样拒——AEFS 对齐
    var dotSegs = p.split(/[\\\/]/);
    for (var ds = 0; ds < dotSegs.length; ds++) {
        if (/^\.\.?[. ]*$/.test(dotSegs[ds])) {
            console.warn('[Bridge] 拒绝含 . 或 .. 别名段的路径: ' + p);
            return false;
        }
    }
    // ④ 必须是绝对路径：盘符开头，或已登记的数据根 UNC 白名单内（其余 UNC/无盘符一律拒）
    if (/^[A-Za-z]:[\\\/]/.test(p)) {
        // 盘符路径：既有行为不变
    } else if (_isUnderAllowedUncRoot(p)) {
        // 数据根 UNC 白名单：仅登记的数据根本身及其
        // 子路径。①②③（% / 控制字符 / 引号 / . 与 .. 段）已先行执行——UNC 放行不豁免。
        // 用原始 p 判定（clean 会把 //server 压成单斜杠，无法与盘根相对路径区分）。
    } else {
        console.warn('[Bridge] 拒绝非盘符开头的绝对路径: ' + p);
        return false;
    }
    // ⑤ 拒 DOS 设备名（全路径段，去扩展名）
    var segs = p.replace(/[\\\/]+/g, '/').replace(/\/+$/, '').split('/');
    for (var j = 0; j < segs.length; j++) {
        var upper = segs[j].replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'CONIN$' || upper === 'CONOUT$' ||
            upper === 'PRN' || upper === 'AUX' ||
            /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) {
            console.warn('[Bridge] 拒绝含 DOS 设备名的路径: ' + segs[j]);
            return false;
        }
    }
    return true;
}

// ── 数据根 UNC 白名单 ──
// 与 AEFS _checkPath 同口径（跨进程无法运行时共享，靠同构实现 + 测试锚定）。
// 单点真相源：面板经 POST /api/set-data-dir 同步（handleSetDataDir 先登记候选再校验）；
// bridge 未收到同步时不放行任何 UNC（_allowedUncRoot 为空，fail-closed 保持旧行为）。
// 普通 UNC（\\server\share\...）无需转换：Node fs 实测支持读写删；\\?\UNC\ 前缀不放行
// ——Node fs.realpathSync 拒绝该前缀（EISDIR/lstat 'UNC'，仅 .native 可用），而
// resolveRealSafe/symlink 复核链依赖 realpathSync，放行即链路失败（fail-closed）。
// 声明放在 safePath 之后仅为兼容测试的源码切片加载（bridge-symlink/bridge-sensitive-path
// 从 "function safePath(" 切到 HTTP 帮助函数段）——var 提升，运行时先于任何调用赋值。
var _allowedUncRoot = '';

function _normUncPath(p) {
    if (!p || typeof p !== 'string') return '';
    if (/^[\\\/]{2}\?/.test(p)) return '';   // \\?\ / //?/ 扩展前缀：fail-closed
    if (!/^[\\\/]{2}[^\\\/]/.test(p)) return '';
    var fwd = p.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/+$/, '');
    var segs = fwd.replace(/^\/+/, '').split('/').filter(function (x) { return !!x; });
    if (segs.length < 2) return '';
    return fwd.toLowerCase();
}

// 登记允许的 UNC 数据根（空/盘符 → 清空，fail-closed）
function _setAllowedUncRoot(p) {
    _allowedUncRoot = _normUncPath(p);
    return _allowedUncRoot;
}

function _getAllowedUncRoot() { return _allowedUncRoot; }

function _isUnderAllowedUncRoot(p) {
    if (!_allowedUncRoot) return false;
    var norm = _normUncPath(p);
    if (!norm) return false;
    return norm === _allowedUncRoot || norm.indexOf(_allowedUncRoot + '/') === 0;
}

// 深度检查：删除操作至少 2 段（最后防线，防误删根级目录）
function minDepthOk(p, min) {
    var n = p.replace(/^[A-Za-z]:[\\\/]/, '').replace(/[\\\/]+/g, '/').replace(/^\/|\/$/g, '');
    var segs = n ? n.split('/').filter(function (s) { return s.trim().length > 0; }) : [];
    return segs.length >= min;
}

// 数据目录安全校验（与 AEFS isDataDirSafe 对齐）：
//   ① safePath（格式：拒 %/控制符/引号/..段/非绝对路径/DOS 设备名；已登记 UNC 根除外）
//   ② 系统目录黑名单拒（Windows/Program Files/ProgramData/Users + 盘根/盘符）
//   ③ depth 阈值按盘符分档：系统盘(C:)depth≥2，其他盘 depth≥1；UNC 数据根 depth≥3
function _isSafeDataDir(p) {
    if (!safePath(p)) return false;
    var fwd = p.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    var stripped = fwd.replace(/^[a-z]:\//, '');
    var segs = stripped.replace(/\/+$/, '').split('/').filter(function (s) { return !!s; });
    var depth = segs.length;
    if (depth === 0
        || /^[a-z]:$/.test(fwd)
        || /^[a-z]:\/windows(\/|$)/.test(fwd)
        || /^[a-z]:\/program files(\/|$)/.test(fwd)
        || /^[a-z]:\/program files \(x86\)(\/|$)/.test(fwd)
        || /^[a-z]:\/programdata(\/|$)/.test(fwd)
        || /^[a-z]:\/users(\/|$)/.test(fwd) && depth <= 2) {
        return false;
    }
    var drive = fwd.charAt(0);
    var minDepth = (drive === 'c') ? 2 : 1;
    // UNC 数据根（登记后 safePath 才放行）：\\server\share 是共享根（等价盘根）拒，
    // 须 \\server\share\dir 起才可用
    if (_normUncPath(p)) minDepth = 3;
    return depth >= minDepth;
}

// 安全命名空间：删除操作仅允许这些路径段（与 AEFS _safeForDelete 对齐）
// 新增需删除能力的模块时，同步更新 AEFS SAFE_NAMESPACES 和此处
var SAFE_NAMESPACES = ['skills', 'memories', 'ae-tools', 'agent', 'temp', 'scripts', 'workflows', 'comfyui', '_comfyui_output', 'llm-providers', 'nodegen', 'presets', 'project-assets', 'asset-refs', 'deepseekPet', 'effects', 'AS_ExtP'];
// 白名单命中判定单独成函数——_scriptsReadRealpathBlocked 只须判「真实路径
// 是否落在 SAFE_NAMESPACES」，不能复用 safeForDelete（其黑名单①系统目录先于白名单②，
// C:\Program Files\...\scripts\x.js 这类基线放行的合法读会被误拒 403）。
// 命中条件：路径含 /ns/（中间段）或以 /ns 结尾（末尾段）。
// ⚠️ 末尾段判断必须先确认 /ns 存在（idx !== -1）再比位置——只按位置比较
// 会在串不存在(idx=-1)且 ns.length===fwd.length(目标位置也是-1)时误判命中（如 c:/x.png 长度8
// 命中 memories/ae-tools 长度8），导致 depth=1 盘根文件绕过白名单。
// ⚠️ ns 必须小写化后再匹配：fwd 已经被 toLowerCase() 小写化，
// 若 SAFE_NAMESPACES 中存在驼峰命名（如 'deepseekPet'），不统一小写会导致 indexOf 永远找不到匹配。
function _inSafeNamespace(p) {
    var fwd = String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    for (var i = 0; i < SAFE_NAMESPACES.length; i++) {
        var ns = SAFE_NAMESPACES[i].toLowerCase();
        var slashNs = '/' + ns;
        var idx = fwd.indexOf(slashNs);
        if (idx !== -1 && (fwd.indexOf(slashNs + '/') !== -1 || idx === fwd.length - ns.length - 1)) {
            return true;
        }
    }
    return false;
}
function safeForDelete(p) {
    // 压缩连续斜杠后再判定，防止 c://windows/... 绕过系统目录正则
    var fwd = p.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    // ① 拒系统目录/根目录（段级归一含尾随点/空格与 8.3 短名，与 AEFS _isSystemOrRootDir 同口径）
    var stripped = fwd.replace(/^[a-z]:\//, '');
    var segs = stripped.split('/').map(function (s) { return s.replace(/[. ]+$/, ''); })
        .filter(function (s) { return !!s; });
    var depth = segs.length;
    var i;
    for (i = 0; i < segs.length; i++) {
        if (/^[a-z0-9]{1,6}~[0-9]{1,2}$/.test(segs[i])) {
            console.warn('[Bridge] safeForDelete 拒危险路径: ' + p);
            return false;
        }
    }
    for (i = 0; i < segs.length; i++) {
        if (segs[i] === 'windows.old' || segs[i] === 'system volume information') {
            console.warn('[Bridge] safeForDelete 拒危险路径: ' + p);
            return false;
        }
    }
    if (depth === 0
        || /^[a-z]:$/.test(fwd)
        || segs[0] === 'windows'
        || segs[0] === 'program files'
        || segs[0] === 'program files (x86)'
        || segs[0] === 'programdata'
        || segs[0] === 'users' && depth <= 2) {
        console.warn('[Bridge] safeForDelete 拒危险路径: ' + p);
        return false;
    }
    // ② 白名单命名空间（判定逻辑见 _inSafeNamespace，同款口径抽出共用）
    if (_inSafeNamespace(p)) return true;
    console.warn('[Bridge] safeForDelete 拒绝: ' + p + ' (不在安全命名空间内)');
    return false;
}

// 符号链接逃逸防护（纵深防御）：消解路径上的 symlink/junction 后，对真实路径再过一次安全校验。
// 攻击场景：安全命名空间目录（如 skills/）内放置 symlink 指向系统任意文件（C:\Users\... 或 \\attacker\share），
// safePath/safeForDelete 只看输入字符串的"门牌"，realpathSync 沿链接追到"真实地址"后重校验才能堵住逃逸。
// 返回值：消解后的真实路径字符串（非布尔）——下游 fs 操作直接用返回值，消除"校验 A、操作 B"的 TOCTOU 窗口；
//        越界（真实路径不安全）返回 false。p 调用前须已过 safePath。
// 路径段里是否有桥侧口径的 8.3 短名段（与 safeForDelete 的系统目录判定同正则）。
function _hasShortNameSeg(p) {
    var fwd = String(p).replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    var segs = fwd.replace(/^[a-z]:\//, '').split('/').filter(function (s) { return !!s; })
        .map(function (s) { return s.replace(/[. ]+$/, ''); });
    for (var i = 0; i < segs.length; i++) {
        if (/^[a-z0-9]{1,6}~[0-9]{1,2}$/.test(segs[i])) return true;
    }
    return false;
}

// Win32 realpath 的长名形态：fs.realpathSync 在 Windows 上可能保留 8.3 短名段
// （Windows 8.3 短名目录形态，如 %TEMP% 里的 `~1` 段），而下游 safeForDelete
// 对「~N」段按安全口径保守拒，合法临时目录/用户目录会被整条误拒。native 实现走
// GetFinalPathNameByHandleW，返回长名形态；测试注入的 mock fs 未覆写 .native，
// 此时回落到注入的 realpathSync，保持 mock 语义。
function _realpathLong(p) {
    var rp = fs.realpathSync;
    var nativeFn = rp && rp.native;
    if (typeof nativeFn === 'function') return nativeFn.call(rp, p);
    return rp.call(fs, p);
}

function resolveRealSafe(p, isWrite) {
    if (fs.existsSync(p)) {
        var real;
        try { real = fs.realpathSync(p); }            // 沿 symlink/junction 追到底，失败=拒
        catch (_) { return false; }
        // realpathSync 可能保留 8.3 短名段（CI runner 的 RUNNER~1 即此形态）：
        // 只在这类形态出现时再取长名，避免无谓改写合法路径的书写形态。
        if (_hasShortNameSeg(real)) {
            try { real = _realpathLong(p); } catch (_) { /* 取不到长名：保留短名，下游保守拒 */ }
        }
        // realpathSync 返回统一反斜杠绝对路径；path.resolve(p) 把输入也归一同形态，
        // 再大小写不敏感比较（Windows 路径不区分大小写）。不同=命中了链接跳转。
        if (real.toLowerCase() !== path.resolve(p).toLowerCase()) {
            if (!safePath(real)) return false;
            if (isWrite && !safeForDelete(real)) return false;
        }
        return real;
    }
    // 目标不存在（写新文件）：向上走到最近一个已存在的祖先，校验其真实路径。
    // mkdir recursive 会穿过祖先 junction/symlink 建目录，祖先真实路径越界即拒。
    if (isWrite) {
        var dir = path.dirname(p);
        while (dir && !fs.existsSync(dir)) {
            var up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        if (dir && fs.existsSync(dir)) {
            try {
                var rd = fs.realpathSync(dir);
                if (_hasShortNameSeg(rd)) {
                    try { rd = _realpathLong(dir); } catch (_) { /* 保留短名，下游保守拒 */ }
                }
                if (rd.toLowerCase() !== path.resolve(dir).toLowerCase()) {
                    if (!safePath(rd)) return false;
                    if (!safeForDelete(rd)) return false;
                }
            } catch (_) { return false; }
        }
    }
    return p;
}

// 系统目录/盘根判定（LLM 专用写端点用）：与 safeForDelete 的系统目录黑名单一致，但不强制命名空间白名单。
// 这样 LLM 可写任意非系统绝对路径（如工程/导出目录的 .srt），同时仍拒绝系统关键目录。
function _isSystemOrRootPath(p) {
    var fwd = p.replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    var stripped = fwd.replace(/^[a-z]:\//, '');
    var segs = stripped.replace(/\/+$/, '').split('/').filter(function (s) { return !!s; });
    var depth = segs.length;
    if (depth === 0
        || /^[a-z]:$/.test(fwd)
        || /^[a-z]:\/windows(\/|$)/.test(fwd)
        || /^[a-z]:\/program files(\/|$)/.test(fwd)
        || /^[a-z]:\/program files \(x86\)(\/|$)/.test(fwd)
        || /^[a-z]:\/programdata(\/|$)/.test(fwd)
        || /^[a-z]:\/users(\/|$)/.test(fwd) && depth <= 2) {
        return true;
    }
    return false;
}

// LLM 专用写端点的 symlink 逃逸防护：与 resolveRealSafe 一致，但真实路径只复查系统目录黑名单，
// 不强制命名空间白名单（允许写入任意非系统绝对路径，配合面板强制确认作为授权闸门）。
function resolveRealSafeLlm(p, isWrite) {
    if (fs.existsSync(p)) {
        var real;
        try { real = fs.realpathSync(p); }            // 沿 symlink/junction 追到底，失败=拒
        catch (_) { return false; }
        if (real.toLowerCase() !== path.resolve(p).toLowerCase()) {
            if (!safePath(real)) return false;
            if (_isSystemOrRootPath(real)) return false;
            if (_isSensitivePath(real)) return false;   // symlink 逃逸到敏感文件（.ssh/.env/id_rsa 等）拒写
        }
        return real;
    }
    if (isWrite) {
        var dir = path.dirname(p);
        while (dir && !fs.existsSync(dir)) {
            var up = path.dirname(dir);
            if (up === dir) break;
            dir = up;
        }
        if (dir && fs.existsSync(dir)) {
            try {
                var rd = fs.realpathSync(dir);
                if (rd.toLowerCase() !== path.resolve(dir).toLowerCase()) {
                    if (!safePath(rd)) return false;
                    if (_isSystemOrRootPath(rd)) return false;
                    if (_isSensitivePath(rd)) return false;   // 祖先 symlink 逃逸到敏感目录（.ssh/.aws 等）拒写
                }
            } catch (_) { return false; }
        }
    }
    return p;
}

// 二进制判定（LLM 写端点防误覆盖用）：采样前 8192 字节，含 NUL 即二进制；
// UTF-8 解码后替换符(U+FFFD)占比 >10% 也视为二进制。与读侧 _readFileLooksBinary 口径一致。
function _looksBinaryBuffer(buf) {
    if (!buf || !buf.length) return false;
    var scanLen = Math.min(buf.length, 8192);
    var nulCount = 0;
    for (var i = 0; i < scanLen; i++) {
        if (buf[i] === 0) nulCount++;
    }
    if (nulCount > 0) return true;
    var text = buf.toString('utf8', 0, scanLen);
    var replCount = 0;
    for (var j = 0; j < text.length; j++) {
        if (text.charCodeAt(j) === 0xFFFD) replCount++;
    }
    if (replCount > 0 && (replCount / text.length) > 0.10) {
        // 高 FFFD 不必然是二进制——中文 Windows 的 GBK/ANSI 文本正是这个形态
        //（每个汉字解码成 1~2 个 U+FFFD）。用「能否整体解为 GBK + 无控制字节」再确认一次：
        // 确认是 GBK 文本 → 交给写端点的「非 UTF-8 文本」判据（409 → 面板按原编码写回），
        // 不在这里当二进制拒掉（否则用户编辑中文 .srt/.txt 会收到误导性的「二进制」拒绝）。
        // 其余（含 NUL、GBK 也解不动）仍按二进制判。
        if (_isNonUtf8TextBuffer(buf.slice(0, scanLen))) return false;
        return true;
    }
    return false;
}

// ========== HTTP 帮助函数 ==========

var CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
};

// 失败响应体的机器码（面板侧经 AEI18n.err(code) 取本地化文案，见 client/shared/i18n/errorCodes.js）。
// 只在 HTTP 状态 >=400 且体带 error 的失败响应上追加 code；成功体与 status 200 的交互式回执
// （needCountConfirm / needPermanentConfirm / needRecycle 等）不带 code，路由语义与状态码不变。
// 取码优先级：端点自带 code（如 TARGET_NOT_UTF8，调用方依赖该值）> 文案前缀表 > 状态码默认。
var FAIL_CODE_BY_STATUS = {
    400: 'BAD_REQUEST',
    401: 'UNAUTHORIZED',
    403: 'DENIED',
    404: 'NOT_FOUND',
    405: 'METHOD_NOT_ALLOWED',
    413: 'BODY_TOO_LARGE'
};
// 同一状态码下的固定文案对应不同语义（400 既可能是路径不合法也可能是缺参数），
// 按本文件文案前缀细分。文案本身不改，调用方仍按原文案判定（如 'Invalid JSON' → bodyLimit）。
var FAIL_CODE_PREFIXES = [
    ['Invalid path', 'INVALID_PATH'],
    ['Invalid src path', 'INVALID_PATH'],
    ['Invalid dst path', 'INVALID_PATH'],
    ['Path too shallow', 'DEPTH'],
    ['Missing content', 'NO_CONTENT'],
    ['Unknown fs method', 'METHOD_NOT_ALLOWED'],
    ['Cannot remove', 'DELETE_FAILED']
];

function _failureCode(status, body) {
    if (body && typeof body.code === 'string' && body.code) return body.code;
    var msg = (body && typeof body.error === 'string') ? body.error : '';
    for (var i = 0; i < FAIL_CODE_PREFIXES.length; i++) {
        if (msg.indexOf(FAIL_CODE_PREFIXES[i][0]) === 0) return FAIL_CODE_PREFIXES[i][1];
    }
    return FAIL_CODE_BY_STATUS[status] || 'SERVER_ERROR';
}

function jsonReply(res, status, data) {
    // 失败体补 code：只追加字段，不改状态码与既有字段（调用方逐字段读取，额外字段无影响）。
    if (status >= 400 && data && typeof data === 'object' && !Array.isArray(data)
        && data.ok !== true && typeof data.error === 'string' && typeof data.code !== 'string') {
        data = Object.assign({}, data, { code: _failureCode(status, data) });
    }
    try {
        var json = JSON.stringify(data);
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
        res.end(json);
    } catch (e) {
        // catch 内不得再无条件 writeHead——若异常源于头已发送（对已 end 的响应
        // 二次回复，_doHttpsDownload 双回调场景），writeHead 会抛 ERR_HTTP_HEADERS_SENT，
        // 且 catch 块内的新异常不会被同一 try 捕获，直接 uncaughtException →
        // _doGracefulExit 杀掉全部 MCP 子进程并退出 bridge。
        // 安全两分：headers 未发送（如 stringify 失败）保留 500 语义；已发送仅尽力 end。
        try { logErr('jsonReply error: ' + (e && e.message)); } catch (_) {}
        try {
            if (!res.headersSent) {
                res.writeHead(500, Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS));
                res.end('{"error":"Internal error"}');
            } else {
                res.end();
            }
        } catch (_) {
            try { res.end(); } catch (_) {}
        }
    }
}

// readBody 通用请求体读取：上限 40MB（parse-doc-bytes 合法载荷为 32MB base64 + JSON 包裹余量）。
// 超限丢弃后续数据并以空串回调——所有调用方 JSON.parse('') 抛错各自走 400 路径。
// 防 CORS '*' 暴露下恶意网页用 no-cors POST 无限大 body 打爆内存（写端点有独立 512MB 上限，不走此处）。
var MAX_READBODY_SIZE = 40 * 1024 * 1024;
function readBody(req, cb) {
    var chunks = [];
    var overflowed = false;
    var total = 0;
    req.on('data', function (c) {
        if (overflowed) return;
        total += c.length;
        if (total > MAX_READBODY_SIZE) {
            overflowed = true;
            chunks = []; // 释放已累积内存
            return;
        }
        chunks.push(c);
    });
    req.on('end', function () {
        if (overflowed) { cb(''); return; }
        cb(Buffer.concat(chunks).toString('utf8'));
    });
    // 客户端在请求体传输中途断开（关面板/重启 AE/fetch abort）→ req emit
    // error(ECONNRESET)。缺此监听时未处理的 stream error 变 uncaughtException →
    // _doGracefulExit(1) 先杀全部 MCP 子进程再退出 bridge（所有走 readBody 的 POST
    // 端点暴露）。对齐 handleWriteBlob 的 error 处理：释放已累积 chunks，以空串回调
    // 走调用方既有 JSON.parse('') → 400 路径（与上方超限约定一致）；流既已断开，
    // 'end' 不会再触发，回调不会双调。
    req.on('error', function () {
        chunks = [];
        cb('');
    });
}

// 剥离 UTF-8 BOM（\uFEFF）。CSV/PDF 等纯文本解析入口常带 BOM，不剥会影响首行内容。
function stripBOM(s) {
    return (typeof s === 'string' && s.charCodeAt(0) === 0xFEFF) ? s.substring(1) : s;
}

// ========== 文件 I/O 处理器 ==========

// 异步 spawn 封装：回收站移动/剪贴板读取/ffmpeg 探测原用 spawnSync，子进程运行
// 期间 Node 事件循环完全停转（回收站上限 60s）：/health 心跳误判断线 → 弹出无自动恢复
// 路径的断线页 → 用户重试杀 bridge → 进行中的删除回退物理删除（回收站保护被静默破坏）。
// 异步化后 HTTP 请求挂起等子进程退出再回复，事件循环照常服务心跳与其余端点。
// 语义对齐 spawnSync：超时 kill 并回 { status:null, timeout:true }；spawn 失败（ENOENT 等）
// 回 { error }；replied 守卫防 error+close 双回调。cap 为 stdout/stderr 累计上限
// （对齐原 maxBuffer：spawnSync 默认 1MB，剪贴板大截图 base64 放宽到 64MB）。
// 样本是否「非 UTF-8 的**文本**」（GBK/ANSI 存量文本）——写端点据此
// 拒绝按 UTF-8 覆盖（面板收到 409/TARGET_NOT_UTF8 后改走 ExtendScript 按 GBK 写回；
// Node 无 GBK 编码器，而真机实测 ES 的 f.encoding='GBK' 能写出真 GBK 字节）。
// 判据（全部满足才算）：非字节缓冲/空 → 否；含 NUL → 否（二进制）；纯 ASCII → 否（无需判）；
// 含 C0 控制字节（除 tab/CR/LF）→ 否（二进制）；采样在 8192 处可能截断多字节字符 → 允许
// 丢掉末尾 0~3 字节再判 UTF-8 合法性；非 UTF-8 且**整体可解为 GBK** → 是。
// 最后一条是与「二进制」的分界线：多数二进制字节串既非法 UTF-8、也非法 GBK，会被排除。
function _isNonUtf8TextBuffer(buf) {
    if (!buf || !buf.length) return false;
    if (!(buf instanceof Uint8Array)) return false;      // 非字节缓冲（异常形态/测试桩）→ 不判，别误拒
    var scan = buf.length;
    var hasNonAscii = false, ctrl = 0;
    for (var i = 0; i < scan; i++) {
        var b = buf[i];
        if (b === 0) return false;
        if (b >= 0x80) hasNonAscii = true;
        else if (b < 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D) ctrl++;
    }
    if (!hasNonAscii || ctrl > 0) return false;
    for (var cut = 0; cut <= 3; cut++) {
        var n = scan - cut;
        if (n <= 0) break;
        try { new TextDecoder('utf-8', { fatal: true }).decode(buf.slice(0, n)); return false; }
        catch (_) { /* 再多丢一字节 */ }
    }
    try { new TextDecoder('gbk', { fatal: true }).decode(buf.slice(0, scan)); return true; } catch (_) { return false; }
}

// 文本解码：严格 UTF-8 失败 → 尝试 GBK。
// 中文 Windows 上有大量存量文本（记事本「ANSI」保存的 .txt/.srt/.md/.jsx）是 GBK 字节：
// 按 utf8 解码得到大面积 U+FFFD（面板侧表现为「乱码文本」，或在高 FFFD 密度处被二进制
// 启发式误拒——错误文案还指向「二进制/不支持读取」）。ExtendScript 读取通道
// （aeTools.jsx readFile）早有同源回退，桥这条主通道一直缺，导致同一个文件
// 走两条通道结论不一致。
// 判据用「严格 UTF-8 解码是否失败」而不是「FFFD 占比」：合法 UTF-8 文件永不重解码
//（含真实 U+FFFD 字符的文件也保持原样——不会把合法文本误判成 GBK），只有非法字节串
// 才交给 GBK；环境无 GBK 解码器（ICU 精简）时退回落既有行为（有损 utf8）。
function _decodeTextMaybeGbk(buf) {
    // ① UTF-16 **BOM** 决定先行：PowerShell 5.1 的 `> out.txt` /
    // `Out-File`、记事本「另存为 Unicode」、`wmic /format` 等产出的 UTF-16LE/BE 文本会落到
    // GBK 分支——实测 UTF-16BE 纯 CJK 无 NUL 时，解出串的**替换字符占比**低于门槛（7.7% < 10%）
    // ⇒ 面板判「文本」⇒ **回 success 且内容是按 GBK 解出的乱码**，模型据此编造文件内容；
    // 含 NUL 的形态又被判「二进制」而拒读（文案还错）。两种结论都不对——它是**纯文本**。
    //（本函数刻意**不用**替换字符占比做判据，见下方 ①10 源码钉。）
    if (buf && buf.length >= 2) {
        if (buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2);
        if (buf[0] === 0xFE && buf[1] === 0xFF) return _utf16beToString(buf, 2);
    }
    try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf);   // 只做合法性判定，不取其结果
        return buf.toString('utf8');                             // 合法 → 直接 utf8 解码，逐字节不变（含 BOM 原样）
    } catch (_) { /* 非法 UTF-8 → 试无 BOM UTF-16，再 GBK */ }
    // ② 无 BOM 的 UTF-16 启发式**只对非法 UTF-8 生效**（关键：合法 UTF-8 文本——哪怕含真实的
    // 替换字符——绝不能被重新解释成 UTF-16，否则会破坏既有编码用例的约束）。
    var u16 = _tryDecodeUtf16NoBom(buf);
    if (u16 !== null) return u16;
    try { return new TextDecoder('gbk').decode(buf); } catch (_) { /* 无 GBK 解码器 */ }
    return buf.toString('utf8');
}

// 无 BOM 的 UTF-16 判定（命中返回字符串，未命中返回 null）：ASCII 为主的 UTF-16 文本每个第二字节为 0。
function _tryDecodeUtf16NoBom(buf) {
    if (!buf || buf.length < 8) return null;
    var n = Math.min(buf.length, 4096);
    if (n % 2 === 1) n--;
    if (n < 8) return null;
    var zEven = 0, zOdd = 0;
    for (var i = 0; i < n; i += 2) {
        if (buf[i] === 0) zEven++;
        if (buf[i + 1] === 0) zOdd++;
    }
    var pairs = n / 2;
    if (zOdd > pairs * 0.6 && zEven <= pairs * 0.05) return buf.toString('utf16le');   // 高字节为 0 ⇒ LE
    if (zEven > pairs * 0.6 && zOdd <= pairs * 0.05) return _utf16beToString(buf, 0);  // 低字节为 0 ⇒ BE
    return null;
}

function _utf16beToString(buf, start) {
    var len = buf.length - start;
    if (len % 2 === 1) len--;
    var sw = Buffer.allocUnsafe(len);
    for (var i = 0; i < len; i += 2) { sw[i] = buf[start + i + 1]; sw[i + 1] = buf[start + i]; }
    return sw.toString('utf16le');
}

function _spawnAsync(exe, args, opts, cb) {
    var cp = require('child_process');
    var timeoutMs = (opts && opts.timeout) || 0;
    var cap = (opts && opts.cap) || (1024 * 1024);
    var spawnOpts = {};
    if (opts && opts.windowsHide) spawnOpts.windowsHide = true;
    // 逐字命令行（不替调用方加引号）：explorer 的 /select,"<path>" 语法要求引号由
    // 我们自己给出，路径含空格时 Node 的默认 quoting 会改变 explorer 的解析形态。
    if (opts && opts.windowsVerbatimArguments) spawnOpts.windowsVerbatimArguments = true;
    var child;
    try {
        child = cp.spawn(exe, args, spawnOpts);
    } catch (e) {
        cb({ error: e });
        return;
    }
    // stdout/stderr 改 Buffer 累积、收尾 concat 后统一 toString——逐
    // chunk toString 会把跨 chunk 边界的多字节 UTF-8 字符（中文 PS 错误消息等）截成
    // U+FFFD 替换符（乱码），对齐 readBody 的同款修复写法。cap 语义随之为字节上限
    // 为字节上限（与字符上限量级一致，对齐 maxBuffer 口径），收尾 substring(0, cap) 兜底
    var stdoutChunks = [];
    var stdoutLen = 0;
    var stderrChunks = [];
    var stderrLen = 0;
    var replied = false;
    var timer = null;
    function finish(result) {
        if (replied) return;
        replied = true;
        if (timer) clearTimeout(timer);
        result.stdout = Buffer.concat(stdoutChunks).toString('utf8').substring(0, cap);
        result.stderr = Buffer.concat(stderrChunks).toString('utf8').substring(0, cap);
        cb(result);
    }
    if (timeoutMs > 0) {
        timer = setTimeout(function () {
            try { child.kill(); } catch (_) {}
            finish({ status: null, timeout: true });
        }, timeoutMs);
    }
    if (child.stdout) {
        child.stdout.on('data', function (d) {
            if (stdoutLen >= cap) return;
            var take = d.slice(0, cap - stdoutLen);
            stdoutChunks.push(take);
            stdoutLen += take.length;
        });
    }
    if (child.stderr) {
        child.stderr.on('data', function (d) {
            if (stderrLen >= cap) return;
            var take = d.slice(0, cap - stderrLen);
            stderrChunks.push(take);
            stderrLen += take.length;
        });
    }
    child.on('error', function (e) { finish({ status: null, error: e }); });
    child.on('close', function (code) { finish({ status: code }); });
}

// 把目录树移到 Windows 回收站（remove-dir-recursive 端点专用，最后防线可恢复）。
// 用 PowerShell 调 Shell.Application COM 对象（与 Explorer.exe 同源 Shell API）。
//
// ⚠️ 不用 Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory + SendToRecycleBin：
// 在本机 Win10 上 PowerShell 退出码 0 但文件被直接物理删除，回收站里找不到。
// 原因可能是 OnlyErrorDialogs UI 选项在 -NonInteractive 模式下退化为直接删除。
// Shell.Application + NameSpace(0x0a).MoveHere 通过 Shell COM 通道（与 Explorer 同源），
// 实测可靠：文件确实出现在 C:\$Recycle.Bin\<SID>\$R... 路径下，可恢复。
//
// 设计权衡：
//   - 仅用于目录场景（文件删除走 delete 端点，未要求改）
//   - -NoProfile/-NonInteractive：跳过用户 profile、避免卡输入
//   - windowsHide:true：不弹 PowerShell 窗口
//   - 路径单引号转义为 ''（safePath 已拒引号，此处纵深防御）
//   - 60s 超时：PowerShell 启动 ~500ms + 大目录删除耗时
//   - exit code 区分失败原因：0=成功 / 1=异常 / 3=RecycleBin null / 4=路径不存在 / 5=MoveHere 后仍在
// - 轮询验证目录已移除（最多 55 秒），防止"成功"但实际未移动的假象
function _moveDirToRecycleBin(realPath, cb) {
    var escaped = String(realPath).replace(/'/g, "''");
    // -Command 传整个脚本块；JavaScript 字符串拼接不做 PowerShell 变量插值，
    // $ErrorActionPreference / $p / $sh / $rb 等会原样传到 PowerShell 端。
    // exit 0 = 成功（目录已不在原位，假定已入回收站）
    // exit 1 = 异常（COM 创建失败、MoveHere 抛错等）
    // exit 3 = RecycleBin namespace null（Shell 不可用）
    // exit 4 = 路径不存在
    // exit 5 = MoveHere 调用后 55 秒内目录仍在（疑似未移动或被取消）
    var script =
        "$ErrorActionPreference='Stop';" +
        // zh-CN 系统上 PS 5.1 默认按控制台代码页（GB2312）向管道写字 → Node 按 utf8
        // 解出乱码，用户看到的失败原因（`Write-Error $_.Exception.Message`）全是乱码。
        // 显式把输出编码定为 UTF-8（重定向场景同样生效）。
        "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
        "try {" +
        "  $p='" + escaped + "';" +
        "  if (-not (Test-Path -LiteralPath $p)) { exit 4 }" +
        "  $sh = New-Object -ComObject Shell.Application;" +
        "  if ($null -eq $sh) { exit 1 }" +
        "  $rb = $sh.NameSpace(0x0a);" +
        "  if ($null -eq $rb) { exit 3 }" +
        "  $rb.MoveHere($p);" +
        // MoveHere 是异步 Shell 操作（大目录移动可远超 5 秒），5s 轮询
        // 截止把「慢速移动中」当失败上报 → 前端 needPermanentConfirm 弹窗文案与真实
        // 状态不符。上限放大到 55s：移动进行中目录仍在 → 继续等待而非 exit 5；仍预留
        // ~5s 给 PS 启动/COM 创建，保证在 60s spawn 总超时 kill 之内由脚本自行收尾
        // 轮询验证：55 秒内目录应消失
        "  $deadline = (Get-Date).AddSeconds(55);" +
        "  while (Test-Path -LiteralPath $p) {" +
        "    if ((Get-Date) -gt $deadline) { exit 5 }" +
        "    Start-Sleep -Milliseconds 100;" +
        "  }" +
        "  exit 0" +
        "} catch {" +
        "  Write-Error $_.Exception.Message;" +
        "  exit 1" +
        "}";
    // 异步 spawn：同步 spawnSync 会阻塞事件循环，删除大目录期间 /health 心跳
    // 误判断线 → 断线页重试杀 bridge → 本操作回退物理删除。60s 超时 kill（对齐原 timeout；
    // 后 60s = 脚本内 55s 轮询 + 启动余量，超时兜底 kill 语义不变）。
    _spawnAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 60000, windowsHide: true },
        function (result) {
            if (result.error) {
                cb({ ok: false, error: 'PS exception: ' + (result.error.message || String(result.error)) });
                return;
            }
            if (result.timeout) {
                cb({ ok: false, error: 'PS exception: timed out after 60000ms' });
                return;
            }
            if (result.status === 0) { cb({ ok: true }); return; }
            var stderr = String(result.stderr || '').trim();
            var code = result.status;
            var reason =
                code === 1 ? ('PS exception: ' + stderr.substring(0, 500)) :
                code === 3 ? 'RecycleBin namespace null (Shell API unavailable)' :
                code === 4 ? 'Path not found' :
                code === 5 ? 'Path still exists after MoveHere (timed out 55s)' :
                ('PS exit ' + code + ': ' + stderr.substring(0, 500));
            cb({ ok: false, error: reason });
        }
    );
}

// 递归统计目录下文件数（不含目录本身，含子目录内所有文件）。
// 用于 remove-dir-recursive 端点的 >50 文件阈值预检。
// 静默失败返 0（目录不存在等），调用方据 needCountConfirm 判断。
function _countFilesRecursive(dirPath) {
    var count = 0;
    try {
        var entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            if (e.isDirectory()) {
                count += _countFilesRecursive(path.join(dirPath, e.name));
            } else if (e.isFile()) {
                count++;
            }
        }
    } catch (_) {}
    return count;
}

// 分片版递归计数（审计）：语义与 _countFilesRecursive 一致（读目录失败静默跳过，
// 返回已计数），但逐目录处理并在累计阈值/单片超时后让出事件循环——remove-dir-recursive
// 的 >50 预检不再成为长同步阻塞点。目录级让出（单目录内条目循环不中断，无丢半截问题）。
function _countFilesRecursiveChunked(dirPath, callback) {
    var count = 0;
    var stack = [dirPath];
    var ops = 0;
    function runSlice() {
        var sliceStart = Date.now();
        try {
            while (stack.length) {
                var cur = stack.pop();
                var entries;
                try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
                catch (_) { continue; }
                for (var i = entries.length - 1; i >= 0; i--) {
                    var e = entries[i];
                    if (e.isDirectory()) stack.push(path.join(cur, e.name));
                    else if (e.isFile()) count++;
                }
                ops++;
                if (ops >= FS_SYNC_YIELD_EVERY || (Date.now() - sliceStart) >= FS_SYNC_SLICE_MS) {
                    ops = 0;
                    _yieldEventLoop(runSlice);
                    return;
                }
            }
            callback(count);
        } catch (_) {
            callback(count);
        }
    }
    runSlice();
}

// ========== 长同步 FS 操作的分片让出（审计：可达数据半拷贝） ==========
// 背景：copy-dir 曾用 copyDirSync 递归 fs.copyFileSync，迁移/整库导入时单个请求可连占
// 事件循环 >8s——面板心跳（main.js setTimeout(abort, 8000)）超时 → setAvailable(false)
// + 全量 IO 降级；用户点重试 → restartBridge() 杀掉正在迁移的 bridge → 半拷贝。
// 策略：逐条目处理，累计达到阈值（条数或单片毫秒）即 setImmediate 让出事件循环，
// 让 /health 与其余端点先得到服务。小目录（低于阈值）仍在本调用内同步完成——
// 既有调用方/测试的时序语义不变。返回值与同步实现完全一致。
var FS_SYNC_YIELD_EVERY = 64;   // 每处理多少条目让出一次
var FS_SYNC_SLICE_MS = 8;       // 单片最长耗时（8ms ≪ 10s 心跳间隔）
// 让出一次事件循环；无 setImmediate（极端沙箱）时用 setTimeout(0)，再退化为同步继续
function _yieldEventLoop(fn) {
    if (typeof setImmediate === 'function') { setImmediate(fn); return; }
    if (typeof setTimeout === 'function') { setTimeout(fn, 0); return; }
    fn();
}

// ========== 原子写（审计） ==========
// write / write-llm / write-base64 / write-blob 曾直接 fs.writeFileSync 目标路径：
// 盘满/进程中断会留下截断文件，把旧文件一起破坏。改为同目录唯一临时件写完再
// rename 覆盖（Windows 同卷 MoveFileEx 语义；对齐 ffmpeg 转码 .part + rename 范本）。
// 失败路径清临时件后原样抛出，调用方既有 500 处理不变。
// 临时件名 = 时间戳 + 进程内自增序号 + 随机串（不依赖 process：源码切片测试的 vm
// 沙箱没有 process，曾因此把普通写路径打成 500）。
var _atomicWriteSeq = 0;
function _atomicWriteFileSync(p, data, encoding) {
    _atomicWriteSeq = (_atomicWriteSeq + 1) % 1000000;
    var tmp = path.join(path.dirname(p),
        '.ae-bridge-write-' + Date.now() + '-' + _atomicWriteSeq + '-' +
        Math.random().toString(36).slice(2, 10) + '.part');
    try {
        if (encoding === undefined) fs.writeFileSync(tmp, data);
        else fs.writeFileSync(tmp, data, encoding);
        fs.renameSync(tmp, p);
    } catch (e) {
        try { fs.unlinkSync(tmp); } catch (_) {}
        throw e;
    }
}

// 【路由白名单】——handleFs 的 case 必须同时在这里登记，否则 HTTP 路由永远不派发它
// （404）。实测踩坑：'is-link'（引入）自诞生起就漏登记 → 面板 assets 库的
// 「这是个链接」提示恒不出现（AEFS.isLinkAsync 恒 null = 探不到，fail-open 静默放行）；
// 既有测试走「源码切片直调 switch」的方式，绕过了路由层，所以一直没暴露。
// 回归闸：单测逐条比对 handleFs 的 case 与本表。
var FS_METHODS = ['read', 'write', 'write-llm', 'write-base64', 'mkdir', 'list', 'list-sizes', 'delete', 'exists', 'is-file', 'is-link', 'realpath', 'rmdir', 'remove-dir-recursive', 'copy-dir', 'copy-file', 'rename'];

// 自有临时残留件判据（收紧）：/fs/list 一律过滤，
// 脚本树/素材列表不显示半截文件；陈旧残留的清扫（sweepStalePartFiles）另用
// _isOwnTempPartResidue（只认 ①②，理由见该函数）。
// 生成方全在本文件，判据按三处生成形态逐一对齐（旧判据 `\.part(?:\.|$)` 过宽：
// 用户真实存在的 `foo.part` / `foo.part.png` 会被一并隐藏）：
//   ① 原子写  _atomicWriteFileSync：'.ae-bridge-write-<ts>-<seq>-<rand>.part'
//             （ts = Date.now() 10~17 位、seq 自增 ≤7 位、rand = base36 ≤8 位）
//   ② 拷贝    _copyFileAtomicAsync：'<名>.<ts>-<seq>-<rand>.part'
//   ③ 转码/抽帧 /api/ffmpeg-transcode 的 '<名>.<taskId>.part[.<ext>]'（taskId = 自增数字）
//             与 /api/ffmpeg-frame 的 '<名>.<pid>_<seq>.part[.<ext>]'
// 已知代价：用户恰把文件命名成 ②/③ 形态（如 `clip.1.part.mov`）时仍会被隐藏——
// 与生成名不可区分；收敛后绝大多数「字面 .part」用户文件不再被误伤。
// 为什么选择过滤而非在结果里标记 temp:true：消费方（bridge.js listFilesAsync /
// listFilesSync、aefs.listFiles）把 files 当 string[] 直接消费，改成对象数组会破坏契约；
// 且标记法无法保证脚本树/素材列表"不显示"（消费方不会读新字段）。
function _isTempPartName(name) {
    var n = String(name || '');
    // ① 原子写（前缀自有、形态固定）
    if (/^\.ae-bridge-write-\d{10,17}-\d{1,7}-[0-9a-z]{1,8}\.part$/.test(n)) return true;
    // ② 拷贝（<名>.<ts>-<seq>-<rand>.part）
    if (/\.[0-9]{10,17}-[0-9]{1,7}-[0-9a-z]{1,8}\.part$/.test(n)) return true;
    // ③ 转码/抽帧（<名>.<数字>[_<数字>].part[.<ext>]）
    return /\.[0-9]{1,10}(?:_[0-9]{1,10})?\.part(?:\.[^.\/\\]+)?$/.test(n);
}

// 清扫专用判据（比 _isTempPartName 再收紧）：只认 ①② 两个高特异形态（<ts>-<seq>-<rand>
// 三元组同现、ts 10~17 位），不认 ③——③ 是「<名>.<数字>.part[.<ext>]」，与用户自己命名的
// 文件（如 clip.1.part.mov）按名字不可区分：误删是数据损失，误留只是不可见的占盘；且观察
// 条目本身只要求 copy/write 两族有清扫方（③ 仍照常过滤、只是不清扫）。
function _isOwnTempPartResidue(name) {
    var n = String(name || '');
    if (/^\.ae-bridge-write-\d{10,17}-\d{1,7}-[0-9a-z]{1,8}\.part$/.test(n)) return true;
    return /\.[0-9]{10,17}-[0-9]{1,7}-[0-9a-z]{1,8}\.part$/.test(n);
}

// ===== 陈旧 .part 残留清扫=====
// .part 是原子写/拷贝/转码的自有临时件（形态见 _isTempPartName）：正常路径一律
// rename 落位或失败清理（unlink），只有进程被硬杀（taskkill/崩溃/断电）才会留件。
// 残留不会被当成品消费（skip-existing 只认正式名），但会占盘，且 /fs/list 过滤后
// 用户在界面里看不见它。清扫语义：bridge 进程（重）启动后首次得知真实数据根时，
// 对数据根做一次有界遍历，只 unlink「名字命中自有 .part 形态」且「mtime 早于阈值」
// 的文件——阈值（24h）远大于任何真实在途操作时长，在途件（mtime 新鲜）一律不碰；
// mtime 取不到（未知龄）同样不碰（对齐 tempSweep「未知 → 不删」口径）。写/拷贝/
// 转码/rename 正常路径一字不改；遍历分片让出事件循环（对齐 FS_SYNC 分片纪律），
// 条目数有上限兜底，全部错误吞掉（清扫是尽力而为，不影响任何请求）。
// 可删判据 = _isOwnTempPartResidue（①② 高特异形态）；③ 与用户文件名不可区分，只过滤不清扫。
var PART_SWEEP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
var PART_SWEEP_MAX_ENTRIES = 50000;
// 应用本体重目录（手工装法下数据根 = 扩展根时同在树内）：自有 .part 生成方只写数据
// 路径，这些目录永不产出 .part——跳过避免遍历预算被 node_modules 整棵吞掉，
// 导致同层的真实数据目录（temp/assets/agent/…）扫不到。
var PART_SWEEP_SKIP_DIRS = { 'node_modules': true, '.git': true };
var _partSweptDirs = {};   // 进程内每数据根一次（面板每次启动/重连都会重发 set-data-dir）

// opts（测试注入用）：fs / maxAgeMs / maxEntries / now；done(summary) 恰好回调一次。
function sweepStalePartFiles(rootDir, opts, done) {
    opts = opts || {};
    done = (typeof done === 'function') ? done : function () {};
    var fsp = opts.fs || fs;
    var maxAgeMs = (typeof opts.maxAgeMs === 'number') ? opts.maxAgeMs : PART_SWEEP_MAX_AGE_MS;
    var maxEntries = (typeof opts.maxEntries === 'number') ? opts.maxEntries : PART_SWEEP_MAX_ENTRIES;
    var now = (typeof opts.now === 'number') ? opts.now : Date.now();
    var summary = { scanned: 0, deleted: 0, failed: 0 };
    if (!rootDir || typeof rootDir !== 'string' || typeof fsp.readdirSync !== 'function') {
        done(summary);
        return;
    }
    var queue = [rootDir];
    // 分片执行：单片超 8ms 让出事件循环（对齐 FS_SYNC 分片纪律，不阻塞 /health）；
    // 整个循环体包一层 catch——清扫是尽力而为，任何意外（畸形条目/权限异常）都
    // 终止当前轮而不是异步抛出（bridge 进程内 uncaught 会直接崩掉服务）。
    function runSlice() {
        var sliceStart = Date.now();
        var yielded = false;
        try {
            while (queue.length > 0 && summary.scanned < maxEntries) {
                var dir = queue.shift();
                var entries;
                try { entries = fsp.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
                for (var i = 0; i < entries.length; i++) {
                    if (summary.scanned >= maxEntries) break;
                    summary.scanned++;
                    var e = entries[i];
                    // 不跟随 symlink/junction：dirent 对链接的 isDirectory()/isFile() 均为
                    // false，链接目录不入队、链接文件不删（防越出数据根命名空间）
                    if (e.isDirectory()) {
                        if (!PART_SWEEP_SKIP_DIRS[String(e.name).toLowerCase()]) queue.push(path.join(dir, e.name));
                        continue;
                    }
                    if (!e.isFile() || !_isOwnTempPartResidue(e.name)) continue;
                    var full = path.join(dir, e.name);
                    var st = null;
                    try { st = fsp.statSync(full); } catch (_) { continue; }
                    var mtimeMs = (st && typeof st.mtimeMs === 'number') ? st.mtimeMs : 0;
                    if (!(mtimeMs > 0) || (now - mtimeMs) < maxAgeMs) continue;   // 新鲜/未知龄：不碰
                    try { fsp.unlinkSync(full); summary.deleted++; }
                    catch (_) { summary.failed++; }
                }
                if ((Date.now() - sliceStart) >= 8) { yielded = true; break; }
            }
        } catch (_) {}
        if (yielded) { _yieldEventLoop(runSlice); return; }
        done(summary);
    }
    runSlice();
}

// 数据根确定后触发一次（进程内每根一次）。调用点：handleSetDataDir（bridge 新生
// 进程的首次同步 / 用户切换目录；bridge 自身在 set-data-dir 前不知道自定义数据根）。
function _sweepStalePartOnce(dataDir) {
    var key = String(dataDir || '').toLowerCase();
    if (!key || _partSweptDirs[key]) return;
    _partSweptDirs[key] = true;
    sweepStalePartFiles(dataDir, null, function (summary) {
        if (!summary || (summary.deleted === 0 && summary.failed === 0)) return;
        try {
            log('[fs] 陈旧 .part 残留清扫: 删除 ' + summary.deleted + ' 个'
                + (summary.failed ? '，失败 ' + summary.failed + ' 个' : '')
                + '（扫描 ' + summary.scanned + ' 条目）');
        } catch (_) {}
    });
}

// /fs/list-sizes 的实现（模块级，供单测切片直调）：只列**文件**，每条带 size/mtimeMs。
// 为什么单开端点而不给 'list' 加字段：'list' 是启动期全树扫描的热路径（脚本树/预设库），
// 每条都 statSync 会把启动 IO 放大成 N 倍；本端点只服务 temp 缓存体积预算（30 分钟一轮）。
// 为什么不用现成的 AEFS.stat / fileSize 量体积：CEP 真机 cep.fs.stat 不带 size 字段
//（AEFS.stat().size 恒 0，见 aefs.js 的 _cepMtimeMs 注释），fileSize 走 ExtendScript 是
// **每个文件一次 evalScript**（占 AE 主线程）——量一棵树要几百次。Node 侧 statSync 是本地
// 元数据读，一次 HTTP 拿到整目录。
function listFilesWithSizeSync(dir) {
    var entries = fs.readdirSync(dir, { withFileTypes: true });
    var out = [];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (!e.isFile()) continue;              // 目录不进清单（消费方按文件删，不做递归）
        var st = null;
        try { st = fs.statSync(path.join(dir, e.name)); } catch (_) { st = null; }
        out.push({
            name: e.name,
            size: (st && typeof st.size === 'number' && st.size > 0) ? st.size : 0,
            mtimeMs: (st && typeof st.mtimeMs === 'number' && st.mtimeMs > 0) ? st.mtimeMs : 0
        });
    }
    return out;
}

// /fs/read 文本读取上限：原 512MB 对齐 read-blob 二进制口径，但文本通道是
// readFileSync utf8 + JSON.stringify 双重放大（512MB 文件 → utf8 字符串 + JSON 转义副本
// ≈ 2-3GB 峰值），同步读期间还阻塞事件循环（/health 心跳误判断线）。收敛到 64MB：
// 文本/代码/日志类读取足够（read-blob 仍承接视频等大二进制的 512MB 口径）。
// 超限回 413 并提示改用 search/分页。
var MAX_READ_TEXT_SIZE = 64 * 1024 * 1024;
// 分页读的**单槽文本缓存**：同一文件连续翻页时避免重读+重解码。
// 键含 mtime 与 size ⇒ 文件一改缓存自然失效（不需要显式清）。单槽即天然有界（最多一份文本，
// 受 MAX_READ_TEXT_SIZE 约束），不做多槽 LRU 是为「不引入新的淘汰策略与内存账」。
var _textPageCache = { key: '', text: '' };

// scripts 命名空间读端点的 junction/symlink 逃逸复核（fail-closed）。
// resolveRealSafe 的 isWrite=false 分支只复查 safePath（格式），不复查命名空间白名单
// （既有设计取舍：read 允许白名单外路径，见 bridge-symlink.test mock 3）。但 agent/scripts
// 树内被放置指向用户目录的 junction 后，list/read/exists/is-file 可沿链接枚举/读取白名单
// 外的任意文件（信息外泄），且枚举结果会喂给面板侧 cleanNonScript 的删除清单。
// 此处对「输入路径命中 scripts 命名空间」的读请求补 realpath 白名单复核：消解后的
// 真实路径必须同样落在 SAFE_NAMESPACES 内（用 _inSafeNamespace 单独判定
// 白名单命中——复用 safeForDelete 时其黑名单①先于白名单②，系统目录下含 /scripts
// 段的合法读被误拒 403），不在即由调用端点回 403。仅限 scripts 命名空间（审计覆盖
// 面）；其他命名空间读保持既有语义不变。
function _scriptsReadRealpathBlocked(inputPath, realPath) {
    var fwdIn = String(inputPath).replace(/\\/g, '/').toLowerCase().replace(/\/+/g, '/');
    var ns = 'scripts';
    // 命中条件与 safeForDelete 的白名单匹配同款：含 /ns/（中间段）或以 /ns 结尾（末段）
    var idx = fwdIn.indexOf('/' + ns);
    var inScriptsNs = idx !== -1 && (fwdIn.indexOf('/' + ns + '/') !== -1 || idx === fwdIn.length - ns.length - 1);
    if (!inScriptsNs) return false;
    // 目标不存在时 resolveRealSafe 原样返回输入（输入本身在 scripts 命名空间内，白名单
    // 必命中，不受影响）；存在的 junction/symlink 目标则须落在白名单内
    return !_inSafeNamespace(realPath);
}

function handleFs(req, res, method) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }
    // 通道异常（statSync/readFileSync/writeFileSync 等抛错）按操作归码：读/写/删三类各成一码，
    // 其余归 SERVER_ERROR；分支内的失败体自带更具体的码（如 INVALID_PATH）。
    var failCode = /^(delete|rmdir|remove-dir-recursive)$/.test(method) ? 'DELETE_FAILED'
        : /^(write|write-llm|write-base64|mkdir|rename|copy-file|copy-dir)$/.test(method) ? 'WRITE_FAILED'
            : /^(read|list|list-sizes|exists|is-file|realpath|is-link)$/.test(method) ? 'READ_FAILED'
                : 'SERVER_ERROR';
    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (e) {
            jsonReply(res, 400, { ok: false, error: 'Invalid JSON' });
            return;
        }

        try {
            switch (method) {
                case 'read':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    var rpRead = resolveRealSafe(params.path, false);
                    if (!rpRead) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // scripts 命名空间读的 junction 逃逸复核（realpath 须在白名单内）
                    if (_scriptsReadRealpathBlocked(params.path, rpRead)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpRead)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    // 大小上限：先 statSync 再读（不存在等异常走外层 catch 500，与原 readFileSync 行为一致）
                    var stRead = fs.statSync(rpRead);
                    if (stRead.size > MAX_READ_TEXT_SIZE) {
                        jsonReply(res, 413, { ok: false, error: 'File too large (' + stRead.size + ' bytes, max ' + MAX_READ_TEXT_SIZE + ') - use search or paged reading instead' });
                        return;
                    }
                    // GBK 回退（见 _decodeTextMaybeGbk）——中文 Windows 的 ANSI 存量文本
                    // 不再整段变 U+FFFD；合法 UTF-8 走原路（逐字节等价）
                    // 范围读：工具侧分页若「先整文件读、
                    // 再 substring」，60MB 文件每翻一页都要整读+整份过桥（实测 142ms、RSS **+162.8MB**）。
                    // 这里按**码元**切片（解码之后切，绝不在字节层切——字节/码元混用正是 N-1 那类缺陷），
                    // 并用**单槽文本缓存**（key = 真实路径 + mtime + size + ctime）让同文件连续翻页
                    // 不再重读重解码；ctime（保留 mtime 的写入器
                    // 会让 mtime+size 键不变 ⇒ 旧正文）。
                    var _co = params.charOffset;
                    var _cc = params.charCount;
                    var _wantRange = (typeof _co === 'number' && isFinite(_co))
                        || (typeof _cc === 'number' && isFinite(_cc) && _cc > 0);
                    if (_wantRange) {
                        // 缓存键必须包含 **ctimeMs**：只用 path+mtime+size 时，
                        // 保留 mtime 的写入器（`rsync -p`、部分编辑器的「保留时间戳」、显式 utimes）
                        // 改完文件后键不变 ⇒ 连续翻页会拿到**旧正文**（实测：同 mtime+size 改写后仍回旧文）。
                        // ctime 由内核在 inode 变更时更新，无法被 utimes 回拨。
                        var _rKey = rpRead + '|' + stRead.mtimeMs + '|' + stRead.size + '|' + stRead.ctimeMs;
                        if (_textPageCache.key !== _rKey) {
                            _textPageCache = { key: _rKey, text: _decodeTextMaybeGbk(fs.readFileSync(rpRead)) };
                        }
                        var _txt = _textPageCache.text;
                        var _off = Math.max(0, Math.floor(typeof _co === 'number' && isFinite(_co) ? _co : 0));
                        if (_off > _txt.length) _off = _txt.length;
                        var _cnt = (typeof _cc === 'number' && isFinite(_cc) && _cc > 0)
                            ? Math.floor(_cc) : (_txt.length - _off);
                        jsonReply(res, 200, {
                            ok: true,
                            data: _txt.substr(_off, _cnt),
                            range: true,
                            charOffset: _off,
                            totalChars: _txt.length
                        });
                        break;
                    }
                    jsonReply(res, 200, { ok: true, data: _decodeTextMaybeGbk(fs.readFileSync(rpRead)) });
                    break;

                case 'write':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (!safeForDelete(params.path)) { jsonReply(res, 403, { ok: false, error: 'Path not in safe namespace for write' }); return; }
                    if (_isSensitivePath(params.path)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write' }); return; }
                    if (typeof params.content !== 'string') { jsonReply(res, 400, { ok: false, error: 'Missing content' }); return; }
                    var rpWrite = resolveRealSafe(params.path, true);
                    if (!rpWrite) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    if (_isSensitivePath(rpWrite)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write' }); return; }
                    var wdir = path.dirname(rpWrite);
                    if (!fs.existsSync(wdir)) fs.mkdirSync(wdir, { recursive: true });
                    // 非 UTF-8 文本目标拒绝按 UTF-8 覆盖（与 write-llm 同口径）
                    if (fs.existsSync(rpWrite)) {
                        var _gbkHit = false;
                        try {
                            var _fdW = fs.openSync(rpWrite, 'r');
                            var _bufW = Buffer.alloc(8192);
                            var _nW = fs.readSync(_fdW, _bufW, 0, 8192, 0);
                            try { fs.closeSync(_fdW); } catch (_) {}
                            _gbkHit = _isNonUtf8TextBuffer(_bufW.slice(0, _nW));
                        } catch (_) { _gbkHit = false; }
                        if (_gbkHit) {
                            jsonReply(res, 409, { ok: false, code: 'TARGET_NOT_UTF8', encoding: 'gbk',
                                error: 'Target is not UTF-8 (GBK) - refusing silent encoding conversion' });
                            return;
                        }
                    }
                    _atomicWriteFileSync(rpWrite, params.content, 'utf8');
                    jsonReply(res, 200, { ok: true });
                    break;

                // LLM 专用写端点（配合面板强制确认）：可写任意非系统绝对路径（如工程/导出目录的 .srt），
                // 不强制命名空间白名单。安全链：safePath(格式) → _isSystemOrRootPath(系统目录) →
                // resolveRealSafeLlm(symlink 逃逸)。每次调用都会在面板侧弹确认由用户授权。
                case 'write-llm':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (_isSystemOrRootPath(params.path)) { jsonReply(res, 403, { ok: false, error: 'Path in system/root dir' }); return; }
                    if (_isSensitivePath(params.path)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write-llm' }); return; }
                    if (typeof params.content !== 'string') { jsonReply(res, 400, { ok: false, error: 'Missing content' }); return; }
                    var rpLlm = resolveRealSafeLlm(params.path, true);
                    if (!rpLlm) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // 目标已存在：先判是否目录（目录不可当文件写），再防误覆盖二进制
                    if (fs.existsSync(rpLlm)) {
                        var tStat;
                        try { tStat = fs.statSync(rpLlm); } catch (_) { tStat = null; }
                        if (tStat && tStat.isDirectory()) { jsonReply(res, 400, { ok: false, error: 'Target is a directory, cannot write as file' }); return; }
                        // 只经 fd 采样前 8KB（_looksBinaryBuffer
                        // 虽只扫 8KB，调用方却 readFileSync 整读——大文件写前再峰值一份，
                        // 读失败还 fail-open 继续覆盖）。
                        // 删除「size 超阈值按二进制保守拒」的大小分支
                        // （上批引入的功能回归）——它把 8–40MB 的纯文本目标误判为二进制
                        // 403 拒写（writeFile 工具单次上限 6MB，write-llm 自身可创建的更大
                        // 文本——如局部改写合并产物——此后永远无法再覆盖），且文案误称
                        // binary。fd 采样成本与文件大小无关，无需上限；只有两个终态：
                        //   · 采样判定为二进制 → 「Refusing to overwrite binary file」；
                        //   · 采样打开/读取失败 → fail-closed 拒写，文案区分「cannot verify」。
                        var isBin;
                        try {
                            var sniffFd = fs.openSync(rpLlm, 'r');
                            var sniffBuf = Buffer.alloc(8192);
                            var sniffLen = 0;
                            try { sniffLen = fs.readSync(sniffFd, sniffBuf, 0, 8192, 0); }
                            finally { try { fs.closeSync(sniffFd); } catch (_) {} }
                            isBin = _looksBinaryBuffer(sniffBuf.slice(0, sniffLen));
                        } catch (eSniff) {
                            jsonReply(res, 403, { ok: false, error: 'Refusing to overwrite: cannot verify existing target (' + (eSniff && eSniff.message || eSniff) + ')' });
                            return;
                        }
                        if (isBin) { jsonReply(res, 403, { ok: false, error: 'Refusing to overwrite binary file with text' }); return; }
                        // 非 UTF-8 文本（GBK/ANSI）目标拒绝按 UTF-8 覆盖——静默的编码
                        // 转换会改变文件语义（.jsx 之类尤甚）。面板收到该 code 后按原编码写回。
                        if (_isNonUtf8TextBuffer(sniffBuf.slice(0, sniffLen))) {
                            jsonReply(res, 409, { ok: false, code: 'TARGET_NOT_UTF8', encoding: 'gbk',
                                error: 'Target is not UTF-8 (GBK) - refusing silent encoding conversion' });
                            return;
                        }
                    }
                    var wdir3 = path.dirname(rpLlm);
                    if (!fs.existsSync(wdir3)) fs.mkdirSync(wdir3, { recursive: true });
                    _atomicWriteFileSync(rpLlm, params.content, 'utf8');
                    jsonReply(res, 200, { ok: true });
                    break;

                case 'write-base64':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (!safeForDelete(params.path)) { jsonReply(res, 403, { ok: false, error: 'Path not in safe namespace for write' }); return; }
                    if (_isSensitivePath(params.path)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write' }); return; }
                    if (typeof params.content !== 'string') { jsonReply(res, 400, { ok: false, error: 'Missing content' }); return; }
                    if (!/^[A-Za-z0-9+\/]*={0,2}$/.test(params.content)) { jsonReply(res, 400, { ok: false, error: 'Invalid base64 content' }); return; }
                    var rpWriteB64 = resolveRealSafe(params.path, true);
                    if (!rpWriteB64) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    if (_isSensitivePath(rpWriteB64)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write' }); return; }
                    var wdir2 = path.dirname(rpWriteB64);
                    if (!fs.existsSync(wdir2)) fs.mkdirSync(wdir2, { recursive: true });
                    _atomicWriteFileSync(rpWriteB64, Buffer.from(params.content, 'base64'));
                    jsonReply(res, 200, { ok: true });
                    break;

                case 'mkdir':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    var rpMkdir = resolveRealSafe(params.path, false);
                    if (!rpMkdir) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    fs.mkdirSync(rpMkdir, { recursive: true });
                    jsonReply(res, 200, { ok: true });
                    break;

                case 'list':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    // 不存在路径的空名单带 notFound 标记——客户端 bridge.js 将其
                    // 折叠为 null（视同需复核），由 ExtendScript 复核链给出 NOT_FOUND 定论；
                    // 存在但为空的目录不带标记，客户端把 [] 当权威答案直接采信（不再对每个
                    // 空目录经 ExtendScript/cep.fs 复核一遍——启动期大预设库全树扫描产生
                    // 上百次 evalScript 洪泛的根源）。旧客户端不读该字段，行为不变。
                    if (!fs.existsSync(params.path)) { jsonReply(res, 200, { ok: true, files: [], dirs: [], notFound: true }); return; }
                    var rpList = resolveRealSafe(params.path, false);
                    if (!rpList) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // scripts 命名空间读的 junction 逃逸复核（realpath 须在白名单内）
                    if (_scriptsReadRealpathBlocked(params.path, rpList)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpList)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    var entries = fs.readdirSync(rpList, { withFileTypes: true });
                    var files = [], dirs = [];
                    for (var i = 0; i < entries.length; i++) {
                        var e = entries[i];
                        // 原子写/转码/抽帧的 *.part 残留不进清单（见 _isTempPartName）。
                        // 目录不受影响（只过滤文件）；正常文件与既有空目录/notFound 语义均不变。
                        if (e.isFile()) { if (!_isTempPartName(e.name)) files.push(e.name); }
                        else if (e.isDirectory()) dirs.push(e.name);
                    }
                    jsonReply(res, 200, { ok: true, files: files, dirs: dirs });
                    break;

                case 'list-sizes':
                    // 只读端点（同 'list' 的读侧校验链），供 temp 缓存体积预算量体积。
                    // 目录不存在 → ok + 空清单（对体积预算而言「没有文件」就是权威答案，
                    // 与 'list' 不同：那条链下游还有 ExtendScript 复核，需要 notFound 区分
                    // 「真空目录」与「待复核」，本端点无复核链，故不带该标记）。
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (!fs.existsSync(params.path)) { jsonReply(res, 200, { ok: true, files: [] }); return; }
                    var rpSizes = resolveRealSafe(params.path, false);
                    if (!rpSizes) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    if (_scriptsReadRealpathBlocked(params.path, rpSizes)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpSizes)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    try {
                        jsonReply(res, 200, { ok: true, files: listFilesWithSizeSync(rpSizes) });
                    } catch (e) {
                        jsonReply(res, 500, { ok: false, code: 'READ_FAILED', error: 'list-sizes failed: ' + (e && e.message || e) });
                    }
                    break;

                case 'delete':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (!safeForDelete(params.path)) { jsonReply(res, 403, { ok: false, error: 'Path not in safe namespace for delete' }); return; }
                    if (!minDepthOk(params.path, 2)) { jsonReply(res, 403, { ok: false, error: 'Path too shallow for delete' }); return; }
                    var rpDel = resolveRealSafe(params.path, true);
                    if (!rpDel) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // params.recycle=true → 走与
                    // remove-dir-recursive 同一个 Shell COM 回收站通道（Shell 的 MoveHere 对文件
                    // 同样有效，Test-Path 轮询对文件同样成立）。回收站失败**不**自作 fallback：
                    // 回 { ok:false, needRecycle:false } 由调用方决定退回永久删除还是放弃。
                    if (params.recycle === true) {
                        _moveDirToRecycleBin(rpDel, function (rr) {
                            if (rr && rr.ok) jsonReply(res, 200, { ok: true, method: 'recyclebin' });
                            else jsonReply(res, 200, { ok: false, needRecycle: false, method: 'permanent', reason: (rr && rr.error) || 'recycle failed' });
                        });
                        break;
                    }
                    fs.unlinkSync(rpDel);
                    jsonReply(res, 200, { ok: true });
                    break;

                case 'exists':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    var rpExist = resolveRealSafe(params.path, false);
                    if (!rpExist) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // scripts 命名空间读的 junction 逃逸复核（realpath 须在白名单内）
                    if (_scriptsReadRealpathBlocked(params.path, rpExist)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpExist)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    jsonReply(res, 200, { ok: true, exists: fs.existsSync(rpExist) });
                    break;

                case 'is-file':
                    // 只读：safePath + resolveRealSafe(false)。不走 safeForDelete/minDepthOk。
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    var rpIsFile = resolveRealSafe(params.path, false);
                    if (!rpIsFile) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // scripts 命名空间读的 junction 逃逸复核（realpath 须在白名单内）
                    if (_scriptsReadRealpathBlocked(params.path, rpIsFile)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpIsFile)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    try {
                        var st = fs.statSync(rpIsFile);
                        jsonReply(res, 200, { ok: true, isFile: st.isFile() });
                    } catch (e) {
                        // 路径不存在或不可 stat → 不是文件
                        jsonReply(res, 200, { ok: true, isFile: false });
                    }
                    break;

                case 'realpath':
                    // 只读真实路径探测——迁移前用它判断「新旧数据根是不是
                    // 同一个物理目录 / 物理上互相嵌套」（junction/symlink/映射盘这些字符串判定
                    // 看不见的别名；字符串层已挡住大小写/`.`/`..` 变体）。安全语义与 'is-link'
                    // 一致（只读）：safePath → resolveRealSafe(false，**不**放行 symlink 逃逸）
                    // → scripts 命名空间复核 → 敏感凭据路径复核。
                    // junction 会被归一成真实
                    // 目录（同一目录的别名写法返回同一 realpath）；**不存在的路径仍 200**、原样
                    // 返回（resolveRealSafe 对 realpath 失败有回退）——调用方只做字符串比较，
                    // 不受影响；4xx 只在逃逸/被拒时出现，此时面板按「探不到」放行（fail-open）。
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    var rpReal = resolveRealSafe(params.path, false);
                    if (!rpReal) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    if (_scriptsReadRealpathBlocked(params.path, rpReal)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpReal)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    jsonReply(res, 200, { ok: true, realpath: rpReal });
                    break;

                case 'is-link':
                    // 只读探测：**条目本身**是否为链接（symlink/junction）。删除/重命名（delete/rmdir/
                    // remove-dir-recursive/rename）一律作用于 resolveRealSafe 消解后的真实目标——面板在
                    // 动手前需知道"这条是个链接"才能显式提示（方案③：不改操作语义，只加提示）。
                    // 安全语义与 'is-file' 完全一致（只读）：safePath → resolveRealSafe(false) →
                    // scripts 命名空间 junction 逃逸复核 → 敏感路径复核。
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    var rpIsLink = resolveRealSafe(params.path, false);
                    if (!rpIsLink) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // scripts 命名空间读的 junction 逃逸复核（realpath 须在白名单内）
                    if (_scriptsReadRealpathBlocked(params.path, rpIsLink)) { jsonReply(res, 403, { ok: false, error: 'Path resolved outside safe namespaces (symlink escape)' }); return; }
                    if (_isSensitivePath(rpIsLink)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    try {
                        // 必须 lstat **输入路径**（rpIsLink 已消解链接，永远探不到"是链接"）；
                        // Windows 上 junction 在 Node 里同为 S_IFLNK（isSymbolicLink()=true）。
                        var lst = fs.lstatSync(params.path);
                        var isLink = lst.isSymbolicLink();
                        jsonReply(res, 200, { ok: true, isLink: isLink, realpath: isLink ? rpIsLink : null });
                    } catch (e) {
                        // 路径不存在/不可 lstat → 同 'is-file' 的不存在口径：不是链接
                        jsonReply(res, 200, { ok: true, isLink: false, realpath: null });
                    }
                    break;

                case 'rmdir':
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (!safeForDelete(params.path)) { jsonReply(res, 403, { ok: false, error: 'Path not in safe namespace for delete' }); return; }
                    if (!minDepthOk(params.path, 2)) { jsonReply(res, 403, { ok: false, error: 'Path too shallow for rmdir' }); return; }
                    var rpRmdir = resolveRealSafe(params.path, true);
                    if (!rpRmdir) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
                    // 非递归删空目录
                    try {
                        fs.rmdirSync(rpRmdir);
                        jsonReply(res, 200, { ok: true });
                    } catch (e) {
                        jsonReply(res, 400, { ok: false, error: 'Cannot remove (not empty or not exist): ' + (e.message || '') });
                    }
                    break;

                case 'remove-dir-recursive':
                    // ⚠️ 危险文件管理函数：递归删除整棵目录树（含所有内容）。
                    // 最后防线：优先移到 Windows 回收站（可恢复），失败需前端用户确认才物理删除。
                    // 安全校验链不变：safePath(格式) → safeForDelete(白名单命名空间) → minDepthOk(深度≥2) → resolveRealSafe(symlink逃逸)
                    // 任何一道校验缺失都可能导致误删用户数据。修改时需与 delete/rmdir 端点保持对齐。
                    //
                    // 三阶段协议（前端 AEFS 配合弹窗）：
                    //   ① 文件数 >50 且未带 forceCountConfirm → {ok:false, needCountConfirm:true, count:N}
                    //   ② 回收站失败且未带 permanent → {ok:false, needPermanentConfirm:true, reason:...}（不自动 fallback）
                    //   ③ permanent:true 或回收站成功 → {ok:true, method:'recyclebin'|'permanent'}
                    if (!safePath(params.path)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
                    if (!safeForDelete(params.path)) { jsonReply(res, 403, { ok: false, error: 'Path not in safe namespace for delete' }); return; }
                    if (!minDepthOk(params.path, 2)) { jsonReply(res, 403, { ok: false, error: 'Path too shallow for remove-dir-recursive' }); return; }
                    var rpRmrec = resolveRealSafe(params.path, true);
                    if (!rpRmrec) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }

                    // ②/③ 的公共续程（预检通过后进入）
                    var _proceedRemove = function () {
                        // ② permanent:true → 直接物理删除（用户已确认永久删）
                        // 审计：改异步 fs.rm（libuv 线程池）——rmSync 删大树可连占事件循环
                        // >8s（与 copy-dir 同族阻塞源），心跳超时 → 面板误判断线 → 用户重试
                        // restartBridge 杀进程。无 fs.rm 的旧环境/测试 mock 退回 rmSync。
                        if (params.permanent) {
                            var _rmReplied = false;
                            var _rmReply = function (rmErr) {
                                if (_rmReplied) return;
                                _rmReplied = true;
                                if (rmErr) {
                                    jsonReply(res, 500, { ok: false, error: 'Cannot remove recursively: ' + (rmErr.message || '') });
                                    return;
                                }
                                jsonReply(res, 200, { ok: true, method: 'permanent' });
                            };
                            if (typeof fs.rm === 'function') {
                                fs.rm(rpRmrec, { recursive: true, force: true }, _rmReply);
                            } else {
                                try { fs.rmSync(rpRmrec, { recursive: true, force: true }); _rmReply(null); }
                                catch (e) { _rmReply(e); }
                            }
                            return;
                        }

                        // ③ 优先移到回收站（可恢复）—— 异步：回复延迟到 PowerShell 子进程
                        // 退出后，期间事件循环照常服务 /health 心跳与其余端点。
                        _moveDirToRecycleBin(rpRmrec, function (recycleResult) {
                            if (recycleResult.ok) {
                                log('Moved to Recycle Bin: ' + params.path);
                                jsonReply(res, 200, { ok: true, method: 'recyclebin' });
                                return;
                            }

                            // ④ 回收站失败 → 不自动 fallback，返回 needPermanentConfirm 让前端弹窗
                            logErr('Recycle Bin failed, need permanent confirm: ' + params.path + ' (' + recycleResult.error + ')');
                            jsonReply(res, 200, { ok: false, needPermanentConfirm: true, reason: recycleResult.error });
                        });
                    };

                    // ① 文件数预检（>50 需前端用户确认）——分片统计（审计：大树
                    // readdirSync 递归与 copy-dir 同族，可连占事件循环数秒）。
                    // permanent=true 时跳过（用户已确认永久删除，无需再统计）
                    if (!params.forceCountConfirm && !params.permanent) {
                        _countFilesRecursiveChunked(rpRmrec, function (fileCount) {
                            if (fileCount > 50) {
                                jsonReply(res, 200, { ok: false, needCountConfirm: true, count: fileCount });
                                return;
                            }
                            _proceedRemove();
                        });
                        return;
                    }
                    _proceedRemove();
                    return;

                case 'rename':
                    if (!safePath(params.src)) { jsonReply(res, 400, { ok: false, error: 'Invalid src path' }); return; }
                    if (!safePath(params.dst)) { jsonReply(res, 400, { ok: false, error: 'Invalid dst path' }); return; }
                    if (!safeForDelete(params.src)) { jsonReply(res, 403, { ok: false, error: 'Src path not in safe namespace for rename' }); return; }
                    if (!minDepthOk(params.src, 2)) { jsonReply(res, 403, { ok: false, error: 'Src path too shallow for rename' }); return; }
                    // 同目录校验（与 AEFS renameFile/renameDir 对齐，拒跨目录 rename）
                    if (path.dirname(params.src).toLowerCase() !== path.dirname(params.dst).toLowerCase()) {
                        jsonReply(res, 403, { ok: false, error: 'Rename must stay in same directory' }); return;
                    }
                    // dst 覆盖等价删旧文件，需过 safeForDelete
                    if (fs.existsSync(params.dst)) {
                        if (!safeForDelete(params.dst)) { jsonReply(res, 403, { ok: false, error: 'Dst path not in safe namespace for rename overwrite' }); return; }
                        if (!minDepthOk(params.dst, 2)) { jsonReply(res, 403, { ok: false, error: 'Dst path too shallow for rename overwrite' }); return; }
                    }
                    var rpRnSrc = resolveRealSafe(params.src, true);
                    if (!rpRnSrc) { jsonReply(res, 403, { ok: false, error: 'Src path resolved to unsafe location (symlink escape)' }); return; }
                    var rpRnDst = resolveRealSafe(params.dst, true);
                    if (!rpRnDst) { jsonReply(res, 403, { ok: false, error: 'Dst path resolved to unsafe location (symlink escape)' }); return; }
                    var rnDstDir = path.dirname(rpRnDst);
                    if (!fs.existsSync(rnDstDir)) fs.mkdirSync(rnDstDir, { recursive: true });
                    fs.renameSync(rpRnSrc, rpRnDst);
                    jsonReply(res, 200, { ok: true });
                    break;

                case 'copy-file':
                    if (!safePath(params.src)) { jsonReply(res, 400, { ok: false, error: 'Invalid src path' }); return; }
                    if (!safePath(params.dst)) { jsonReply(res, 400, { ok: false, error: 'Invalid dst path' }); return; }
                    if (!safeForDelete(params.dst)) { jsonReply(res, 403, { ok: false, error: 'Dst path not in safe namespace for copy' }); return; }
                    var rpCpSrc = resolveRealSafe(params.src, false);
                    if (!rpCpSrc) { jsonReply(res, 403, { ok: false, error: 'Src path resolved to unsafe location (symlink escape)' }); return; }
                    // src 是读语义：补敏感路径检查（与 read 端点同口径），否则可把 .env/id_rsa 拷到数据目录再读出
                    if (_isSensitivePath(rpCpSrc)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    var rpCpDst = resolveRealSafe(params.dst, true);
                    if (!rpCpDst) { jsonReply(res, 403, { ok: false, error: 'Dst path resolved to unsafe location (symlink escape)' }); return; }
                    var cpDstDir = path.dirname(rpCpDst);
                    if (!fs.existsSync(cpDstDir)) fs.mkdirSync(cpDstDir, { recursive: true });
                    // 单文件拷贝改异步 fs.copyFile（libuv 线程池）——
                    // copyFileSync 拷贝 HDD >1GB / 网络盘 >80MB 单文件可连续占住事件
                    // 循环 >8s，面板心跳误判断线 → 用户重试 restartBridge 杀掉拷贝中的
                    // bridge，目标留下半截文件。先写同目录 .part 再 rename 落位：中断只会
                    // 留下 .part，不会让 skip-existing 把半截文件当成品永久跳过。
                    _copyFileAtomicAsync(rpCpSrc, rpCpDst, function (cpErr) {
                        if (cpErr) {
                            jsonReply(res, 500, { ok: false, code: 'WRITE_FAILED', error: 'copy failed: ' + (cpErr.message || String(cpErr)) });
                            return;
                        }
                        jsonReply(res, 200, { ok: true });
                    });
                    return;

                case 'copy-dir':
                    if (!safePath(params.src)) { jsonReply(res, 400, { ok: false, error: 'Invalid src path' }); return; }
                    if (!safePath(params.dst)) { jsonReply(res, 400, { ok: false, error: 'Invalid dst path' }); return; }
                    if (!safeForDelete(params.dst)) { jsonReply(res, 403, { ok: false, error: 'Dst path not in safe namespace' }); return; }
                    var rpCdSrc = resolveRealSafe(params.src, false);
                    if (!rpCdSrc) { jsonReply(res, 403, { ok: false, error: 'Src path resolved to unsafe location (symlink escape)' }); return; }
                    // src 是读语义：补敏感路径检查（与 read/list 端点同口径），敏感目录整棵拒拷
                    if (_isSensitivePath(rpCdSrc)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
                    var rpCdDst = resolveRealSafe(params.dst, true);
                    if (!rpCdDst) { jsonReply(res, 403, { ok: false, error: 'Dst path resolved to unsafe location (symlink escape)' }); return; }
                    // 审计：分片拷贝（逐条目让出事件循环）——长迁移期间 /health 仍可响应。
                    // 返回结构不变：响应携带 failed（单文件拷贝失败计数）。
                    copyDirChunked(rpCdSrc, rpCdDst, function (cdErr, cdRes) {
                        if (cdErr) {
                            jsonReply(res, 500, { ok: false, code: 'WRITE_FAILED', error: cdErr.message || String(cdErr) });
                            return;
                        }
                        jsonReply(res, 200, { ok: true, copied: cdRes.copied, failed: cdRes.failed });
                    });
                    return;

                default:
                    jsonReply(res, 404, { ok: false, error: 'Unknown fs method: ' + method });
            }
        } catch (e) {
            jsonReply(res, 500, { ok: false, code: failCode, error: e.message || String(e) });
        }
    });
}

// 批量存在性探测：收 paths[]，逐个过 exists 的安全校验链（safePath → resolveRealSafe → _isSensitivePath），
// 返回与输入等长的 exists:boolean[]。安全语义与单点 /fs/exists 完全一致，只是批量化省往返。
// 供前端 _checkMissing / quickBar 扫描在几万素材时一次往返，避免逐条同步 XHR 阻塞 UI。
// 返回 { ok:true, exists:[...], invalid:[...] }——invalid 为校验失败的下标(NaN 语义由前端按不存在处理)。
function handleFsExistsBatch(req, res) {
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }
    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (e) {
            jsonReply(res, 400, { ok: false, error: 'Invalid JSON' });
            return;
        }
        var paths = params && Array.isArray(params.paths) ? params.paths : [];
        if (!paths.length) {
            jsonReply(res, 200, { ok: true, exists: [], invalid: [] });
            return;
        }
        // 审计：批量 realpathSync 面同样分片——几万素材时逐个 resolveRealSafe
        // （realpathSync）可连续占用事件循环数秒，心跳/其余端点排队。逐条处理，
        // 累计阈值即让出；安全语义与单点 /fs/exists 完全一致（逐条仍走同一校验链）。
        var exists = [];
        var invalid = [];
        var i = 0;
        var ops = 0;
        function runSlice() {
            var sliceStart = Date.now();
            try {
                while (i < paths.length) {
                    var p = paths[i];
                    if (typeof p !== 'string' || !safePath(p)) { invalid.push(i); exists.push(false); }
                    else {
                        var rp = resolveRealSafe(p, false);
                        if (!rp) { invalid.push(i); exists.push(false); }
                        // 与单点 /fs/exists 安全语义保持一致（scripts 命名空间 junction 逃逸复核）
                        else if (_scriptsReadRealpathBlocked(p, rp)) { invalid.push(i); exists.push(false); }
                        else if (_isSensitivePath(rp)) { invalid.push(i); exists.push(false); }
                        else { exists.push(fs.existsSync(rp)); }
                    }
                    i++;
                    ops++;
                    if (ops >= FS_SYNC_YIELD_EVERY || (Date.now() - sliceStart) >= FS_SYNC_SLICE_MS) {
                        ops = 0;
                        _yieldEventLoop(runSlice);
                        return;
                    }
                }
                jsonReply(res, 200, { ok: true, exists: exists, invalid: invalid });
            } catch (e) {
                jsonReply(res, 500, { ok: false, code: 'READ_FAILED', error: e.message || String(e) });
            }
        }
        runSlice();
    });
}

// 写二进制文件：body 即原始字节（application/octet-stream），路径走 query 参数。
// 相比 write-base64 免掉 base64 编解码 + JSON 序列化/解析，26MB 从 ~1s 降到 ~100ms。
// 安全与 write-base64 对齐：safePath + safeForDelete（写=覆盖删旧），不另设 minDepthOk。
// body 上限 MAX_WRITE_SIZE：写端点要承接图片(PNG)和视频(MP4)产物——4K 无损 PNG 极端 ~80MB，
// 1080p 长视频可破 100MB，故比 read-image 的图片专用上限(100MB)放宽到 512MB。流式累计超限即
// destroy 断开（防无限流撑爆 bridge 内存，与 download-url 同款保护）。本地生成产物是可信源，
// 512MB 覆盖所有正常产物同时仍挡住 GB 级异常流；bridge 本地 node 进程临时占用写完即释放。
// 无 cep.fs/ExtendScript 回退——二进制 body 只有 Bridge 能接，面板侧 AEFS.writeBlob 失败时
// 自行回退到 base64 链（writeFileBase64）。
var MAX_WRITE_SIZE = 512 * 1024 * 1024;
function handleWriteBlob(req, res) {
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }
    var q = url.parse(req.url, true).query;
    var p = '';
    if (q.path) {
        try { p = decodeURIComponent(q.path); }
        catch (e) { jsonReply(res, 400, { ok: false, error: 'Invalid path encoding' }); return; }
    }
    if (!safePath(p)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
    if (!safeForDelete(p)) { jsonReply(res, 403, { ok: false, error: 'Path not in safe namespace for write' }); return; }
    // 敏感路径拒写：与 write/write-base64 同口径（Blob 通道曾遗漏，二进制内容同样可承载凭据）
    if (_isSensitivePath(p)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write' }); return; }
    var rpBlob = resolveRealSafe(p, true);
    if (!rpBlob) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
    if (_isSensitivePath(rpBlob)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied for write' }); return; }
    p = rpBlob;
    var wdir = path.dirname(p);
    if (!fs.existsSync(wdir)) fs.mkdirSync(wdir, { recursive: true });
    var chunks = [];
    var totalSize = 0;
    var replied = false;
    function fail(status, msg) {
        if (replied) return;
        replied = true;
        // 先写响应再断开：先 destroy 的话 socket 已毁，jsonReply 的 writeHead 写不出，
        // 客户端收网络错误而非 413，AEFS.writeBlob 的 4xx→hardReject 分支永不命中，
        // 误回退 base64 链造成双重内存峰值。socket 已坏时 jsonReply 内部会抛错，需兜住。
        try { jsonReply(res, status, { ok: false, error: msg }); } catch (_) {}
        // 延迟到响应 flush 后再 destroy，防 RST 把 413 响应吞掉
        setImmediate(function () { try { req.destroy(); } catch (_) {} });
    }
    req.on('data', function (c) {
        totalSize += c.length;
        if (totalSize > MAX_WRITE_SIZE) {
            chunks = [];  // 释放已累积的内存再拒
            fail(413, 'Body too large (max ' + MAX_WRITE_SIZE + ' bytes)');
            return;
        }
        chunks.push(c);
    });
    req.on('error', function (e) { chunks = []; fail(500, e.message || String(e)); });
    req.on('end', function () {
        if (replied) return;
        replied = true;
        try {
            var buf = Buffer.concat(chunks);
            _atomicWriteFileSync(p, buf);   // 审计：原子写（.part + rename），中断不留截断文件
            jsonReply(res, 200, { ok: true, size: buf.length });
        } catch (e) {
            jsonReply(res, 500, { ok: false, code: 'WRITE_FAILED', error: e.message || String(e) });
        }
    });
}

// 单文件异步原子拷贝。fs.copyFile 走 libuv 线程池，拷贝期间
// 事件循环全程可用（/health 心跳与其余端点不再被大文件占住）；先写同目录 .part，
// 成功后 rename 到目标（同卷原子），失败清理 .part——中断/失败永不留下可被
// skip-existing 误当成成品的半截目标文件。copy-file 端点与 copy-dir 分片共用。
// 临时件名唯一化（时间戳 + 进程内自增序号 + 随机串，对齐
// _atomicWriteFileSync 的 .<...>.part 风格）。固定 dst + '.part' 时同一 dst 的
// 并发拷贝（用户连点/重试）互踩同一临时件——Windows 下 rename 源被另一方占用报
// EBUSY 假失败，且失败清理可能删掉并发方仍在写的临时件。唯一名后每次调用只清
// 自己创建的那一个；skip-existing 仍只认正式名（.part 残留不会被当成成品跳过）。
var _copyPartSeq = 0;
function _copyFileAtomicAsync(src, dst, cb) {
    _copyPartSeq = (_copyPartSeq + 1) % 1000000;
    var part = dst + '.' + Date.now() + '-' + _copyPartSeq + '-' +
        Math.random().toString(36).slice(2, 10) + '.part';
    fs.copyFile(src, part, function (err) {
        if (err) {
            try { fs.unlink(part, function () {}); } catch (_) {}
            cb(err);
            return;
        }
        fs.rename(part, dst, function (err2) {
            if (err2) {
                try { fs.unlink(part, function () {}); } catch (_) {}
                cb(err2);
                return;
            }
            cb(null);
        });
    });
}

// 分片版目录拷贝：语义与 copyDirSync 一致（返回
// {copied, failed}，目标已存在跳过、单文件失败计数不中断），但：
//   · 目录条目逐条处理并周期性让出事件循环——大目录迁移期间 /health 心跳照常服务；
//   · 单文件改异步 _copyFileAtomicAsync（libuv 线程池）——copyFileSync 拷贝
//     单个 >1GB 文件即可占住事件循环 >8s（让出只在条目边界，救不了单文件内部），
//     面板心跳误判断线 → 重试 restartBridge 杀进程 → 半截文件；现拷贝期间事件循环
//     全程可用，且 .part + rename 保证半截永不落在目标名上。
// 逐文件串行（栈序不变），不做并发拷贝风暴（HDD/网络盘并发反而更慢）。
function copyDirChunked(src, dst, callback) {
    var result = { copied: 0, failed: 0 };
    // 任务栈：目录任务展开为条目任务（逆序入栈保持原顺序）——让出可以发生在任意
    // 条目边界，剩余条目保留在栈上，不像「在 entries 循环内 return」那样丢半截。
    var stack = [{ dir: true, s: src, d: dst }];
    var ops = 0;
    function runSlice() {
        var sliceStart = Date.now();
        try {
            while (stack.length) {
                var t = stack.pop();
                if (t.dir) {
                    if (!fs.existsSync(t.s)) continue;
                    if (!fs.existsSync(t.d)) fs.mkdirSync(t.d, { recursive: true });
                    var entries = fs.readdirSync(t.s, { withFileTypes: true });
                    for (var i = entries.length - 1; i >= 0; i--) {
                        var e = entries[i];
                        var s = path.join(t.s, e.name);
                        var d = path.join(t.d, e.name);
                        if (e.isDirectory()) stack.push({ dir: true, s: s, d: d });
                        else if (e.isFile()) stack.push({ dir: false, s: s, d: d });
                    }
                } else {
                    // 目标已存在则跳过（不覆盖用户数据）。.part 是独立名字：被中断的
                    // 上一次拷贝只可能留下 .part，不会让这里把半截文件当成品跳过。
                    if (!fs.existsSync(t.d)) {
                        (function (task) {
                            _copyFileAtomicAsync(task.s, task.d, function (err) {
                                if (err) {
                                    // 记录失败计数并打日志（不中断整棵拷贝，其余文件继续）
                                    result.failed++;
                                    try { log('[fs] copy-dir 单文件拷贝失败: ' + task.s + ' — ' + (err && err.message)); } catch (_) {}
                                } else {
                                    result.copied++;
                                }
                                _yieldEventLoop(runSlice);   // 单文件拷贝完成即让出，继续栈上剩余条目
                            });
                        })(t);
                        return;   // 剩余条目在拷贝完成回调里继续（runSlice 从栈上恢复）
                    }
                }
                ops++;
                if (ops >= FS_SYNC_YIELD_EVERY || (Date.now() - sliceStart) >= FS_SYNC_SLICE_MS) {
                    ops = 0;
                    _yieldEventLoop(runSlice);
                    return;
                }
            }
            callback(null, result);
        } catch (e) {
            callback(e, result);
        }
    }
    runSlice();
}

// 返回 {copied, failed}——单文件 copyFileSync 失败不再静默吞，失败计数随
// 响应透出给面板侧 AEFS.copyDir 严格判定（对齐回退链 totalOk === rels.length 语义），
// 目录拷贝部分失败不再整体假成功（调用方基于假成功继续导入/迁移流程导致数据不完整）
// 注：端点使用分片版 copyDirChunked；本函数保留给同步调用方/单测
// （单测切片直调），故此处不引用也不可删。
// eslint-disable-next-line no-unused-vars
function copyDirSync(src, dst) {
    if (!fs.existsSync(src)) return { copied: 0, failed: 0 };
    if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
    var count = 0;
    var failed = 0;
    var entries = fs.readdirSync(src, { withFileTypes: true });
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var s = path.join(src, e.name);
        var d = path.join(dst, e.name);
        if (e.isDirectory()) {
            var sub = copyDirSync(s, d);
            count += sub.copied;
            failed += sub.failed;
        } else if (e.isFile()) {
            // 目标已存在则跳过（不覆盖用户数据）
            if (fs.existsSync(d)) continue;
            try {
                fs.copyFileSync(s, d);
                count++;
            } catch (err) {
                // 记录失败计数并打日志（不中断整棵拷贝，其余文件继续）；
                // catch (_) {} 无计数无日志时，面板侧无从得知部分失败
                failed++;
                try { log('[fs] copy-dir 单文件拷贝失败: ' + s + ' — ' + (err && err.message)); } catch (_) {}
            }
        }
    }
    return { copied: count, failed: failed };
}

// ========== 图片读取（从旧 mcp-bridge 迁移过来） ==========

var MAX_IMAGE_FILE_SIZE = 100 * 1024 * 1024;
var MAX_FILE_WAIT_MS = 15000;
var RETRY_DELAY_MS = 500;

// 图片文件头嗅探（纯函数，供单测直调）：返回 'image/png' / 'image/jpeg'，均不命中返回 ''。
// 必须按字节内容判定而非扩展名：AE 序列渲染产物名形如 `X.png00000`（标准图片扩展名 + 纯数字
// 帧号后缀），扩展名不在白名单里，但文件内容就是合法 PNG。反过来，扩展名像图片但内容不是
// 图片的文件也必须拒——否则工具回 success 后视觉侧拿到的是无图可用的垃圾 base64（假成功）。
var PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function _sniffImageMime(buf) {
    if (!buf || !buf.length) return '';
    var i;
    // PNG 签名按读到的字节数前缀比较（≥4 字节才判）：不足 8 字节说明读到的是被截断的头，
    // 截断交给 iendVerified 透出由调用方补读；真·非图片文件不会以 PNG 签名前缀开头。
    var pngLen = Math.min(buf.length, PNG_SIGNATURE.length);
    var pngHit = pngLen >= 4;
    for (i = 0; pngHit && i < pngLen; i++) {
        if (buf[i] !== PNG_SIGNATURE[i]) pngHit = false;
    }
    if (pngHit) return 'image/png';
    if (buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'image/jpeg';
    return '';
}

function handleReadImage(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { error: 'Method not allowed' });
        return;
    }

    readBody(req, function (body) {
        var filePath;
        try { var parsed = JSON.parse(body); filePath = parsed.filePath || ''; } catch (e) {}

        if (!filePath) {
            jsonReply(res, 400, { error: 'Missing filePath' });
            return;
        }

        // 不做扩展名前置白名单：格式一律由读到的字节内容判定（见 doConvert 里的
        // _sniffImageMime）——AE 序列渲染产物 `X.png00000` 的扩展名不是 .png，
        // 而扩展名是 .png 的文件也可能根本不是图片。

        // 路径安全：先校验原始输入，再 resolve。
        // 必须在 path.resolve 之前校验 —— resolve 会消解 .. 段，导致 safePath 的穿越检测失效。
        if (!safePath(filePath)) {
            jsonReply(res, 400, { error: 'Invalid path' });
            return;
        }
        var resolved = path.resolve(filePath);

        // 路径安全（对齐 AEFS _checkPath，与其他 FS 端点一致）
        if (!safePath(resolved)) {
            jsonReply(res, 400, { error: 'Invalid path' });
            return;
        }

        // 符号链接逃逸防护：消解 symlink/junction 后对真实路径重校验（read-image 只读，isWrite=false）
        var rpImg = resolveRealSafe(resolved, false);
        if (!rpImg) { jsonReply(res, 403, { error: 'Path resolved to unsafe location (symlink escape)' }); return; }
        resolved = rpImg;

        // 敏感路径拒读（凭据/密钥类文件不允许经 bridge 读出）
        if (_isSensitivePath(resolved)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }

        // 确认目标存在且为普通文件，拒绝对目录/特殊文件读图
        try {
            var st = fs.statSync(resolved);
            if (!st.isFile()) {
                jsonReply(res, 400, { error: 'Not a regular file' });
                return;
            }
        } catch (_) {
            jsonReply(res, 404, { error: 'File not found or not accessible' });
            return;
        }

        function safeReply(payload) {
            if (res.destroyed) return;
            jsonReply(res, 200, payload);
        }

        function doConvert(fileData) {
            // 格式判定只看字节内容（扩展名不可信，见 _sniffImageMime 注释）。
            var rmime = _sniffImageMime(fileData);
            if (!rmime) {
                jsonReply(res, 400, { success: false, error: '文件内容不是 PNG/JPEG 图片' });
                return;
            }
            var rfb = fileData.toString('base64');
            var payload = { success: true, base64: rfb, size: fileData.length, b64Len: rfb.length, mime: rmime };
            // PNG 保留既有 IEND 校验语义（截断 PNG 透出 iendVerified:false，调用方补读）。
            if (rmime === 'image/png') {
                var iendOk = false;
                if (fileData.length >= 8) {
                    iendOk = (fileData.toString('hex', fileData.length - 8, fileData.length - 4) === '49454e44');
                }
                payload.iendVerified = iendOk;
            }
            safeReply(payload);
        }

        fs.stat(resolved, function (statErr, st) {
            if (statErr) {
                jsonReply(res, 404, { error: 'File not found' });
                return;
            }
            var fileSize = st.size;

            if (fileSize > MAX_IMAGE_FILE_SIZE) {
                logErr('Oversized image rejected: ' + fileSize + ' bytes path=' + resolved);
                safeReply({ success: false, error: 'File too large (max ' + MAX_IMAGE_FILE_SIZE + ' bytes)' });
                return;
            }

            // 等待稳定的错误必须消费——回调不接 err 时，0 字节文件挂满
            // 15s 超时后仍回 {success:true, base64:''}（空图被当成功）。现超时回 504、
            // 空文件（连续两次 0 字节）回 500，明确失败；read-blob 同用共享实现。
            _waitFileStableShared(res, resolved, Date.now(), fileSize, function (waitErr) {
                if (waitErr) {
                    var waitMsg = waitErr.message || String(waitErr);
                    if (res.destroyed) return;
                    var isTimeout = /Timeout/.test(waitMsg);
                    jsonReply(res, isTimeout ? 504 : 500, { success: false, error: waitMsg, timeout: isTimeout });
                    return;
                }
                fs.readFile(resolved, function (readErr, data) {
                    if (readErr) { jsonReply(res, 404, { error: 'File not found' }); return; }
                    doConvert(data);
                });
            });
        });
    });
}

// ========== 文档/表格/PDF 解析 ==========
// 供 Agent 模块把拖入的 docx/xlsx/pdf 等文件解析为「结构化文本」注入 <context>，
// 而非仅传路径。与 read-image 同款安全校验链（safePath 双校验 + symlink 逃逸 + 敏感路径拒读 + 文件上限）。
//
// 支持的格式与解析库：
//   .docx       → mammoth（BSD-2-Clause，extractRawText 得纯文本）
//   .doc        → 明确拒绝：mammoth 只认 docx，旧版 .doc 二进制必然解析失败——
//                 入口直接报「不支持，请转存 .docx」，不再进支持表假装支持后必然
//                 "docx parse failed"
//   .xlsx/.xls/.xlsm/.csv → @wwek/xlsx（SheetJS CE，Apache-2.0，各 sheet 转 Markdown 表格/CSV）
//   .pdf        → unpdf（MIT，CJS 产物经 require() 加载以兼容 NODE_PATH vendor 化部署）
//   .txt/.md/.js → utf8 直读（免第三方库，stripBOM 去 BOM）
// 其余格式返回 { ok: false, error: 'unsupported format' }，由调用方按普通文件处理。
// 上限 MAX_PARSE_FILE_SIZE 为 512MB，防超大文档拖垮 bridge 进程。
// 大 PDF 多为内嵌字体/图片导致体积大，文本层很小；unpdf.extractText 仅做文本提取不渲染、
// 内存受控（实测 170MB PDF 解析 ~0.3s），parseCache 也只缓存解析后的纯文本不缓存原文件，
// 故 512MB 以内可直接解析文本层。
var MAX_PARSE_FILE_SIZE = 512 * 1024 * 1024;

// ========== 解析结果缓存 ==========
// 文档解析是"全量解析"（readFile 翻页/搜索每次调用都重新解析整个文件，大 PDF/xlsx 数秒），
// 加内存缓存：parse-doc 以 路径+size+mtime 为 key（文件被改即失效）；parse-doc-bytes 以
// 名称+base64长度+首尾片段 为 key。命中后搜索/分页在缓存文本上零成本。
// 上限：单条 >8MB 文本不缓存；累计 >256MB 或 >50 条时 FIFO 淘汰最旧。
var PARSE_CACHE_MAX_ENTRIES = 50;
var PARSE_CACHE_MAX_CHARS = 256 * 1024 * 1024;
var PARSE_CACHE_MAX_ITEM_CHARS = 8 * 1024 * 1024;
var _parseCache = new Map();        // key -> { text, images, imageTotal, imagesSkipped }
var _parseCacheChars = 0;
function parseCacheGet(key) {
    return _parseCache.has(key) ? _parseCache.get(key) : undefined;
}
function parseCacheSet(key, entry) {
    var text = (entry && typeof entry === 'object') ? String(entry.text || '') : String(entry || '');
    if (!text || text.length > PARSE_CACHE_MAX_ITEM_CHARS) return;
    if (_parseCache.has(key)) {
        var prev = _parseCache.get(key);
        _parseCacheChars -= String((prev && typeof prev === 'object' ? prev.text : prev) || '').length;
        _parseCache.delete(key);
    }
    while (_parseCache.size >= PARSE_CACHE_MAX_ENTRIES || (_parseCacheChars + text.length > PARSE_CACHE_MAX_CHARS)) {
        var firstKey = _parseCache.keys().next().value;
        if (firstKey === undefined) break;
        var firstVal = _parseCache.get(firstKey);
        _parseCacheChars -= String((firstVal && typeof firstVal === 'object' ? firstVal.text : firstVal) || '').length;
        _parseCache.delete(firstKey);
    }
    _parseCache.set(key, entry);
    _parseCacheChars += text.length;
}

function handleParseDoc(req, res) {
    readBody(req, function (body) {
        var input;
        try { input = JSON.parse(body || '{}'); } catch (_) { jsonReply(res, 400, { error: 'Invalid JSON' }); return; }
        var filePath = input && input.path;
        if (!filePath) { jsonReply(res, 400, { error: 'Missing path' }); return; }

        var ext = path.extname(filePath).toLowerCase();
        var SUPPORTED = { '.docx': 1, '.xlsx': 1, '.xls': 1, '.xlsm': 1, '.csv': 1, '.pdf': 1, '.txt': 1, '.md': 1, '.js': 1 };
        // mammoth 只认 .docx，旧版 .doc 必然解析失败——入口明确报不支持并引导转存
        if (ext === '.doc') { jsonReply(res, 400, { ok: false, error: '不支持旧版 .doc 格式（mammoth 仅支持 .docx）——请用 Word/WPS 转存为 .docx 后重试' }); return; }
        if (!SUPPORTED[ext]) { jsonReply(res, 400, { error: 'Unsupported format: ' + ext }); return; }

        // 路径安全：先校验原始输入，再 resolve（与 read-image 一致，resolve 前必须先校验）
        if (!safePath(filePath)) { jsonReply(res, 400, { error: 'Invalid path' }); return; }
        var resolved = path.resolve(filePath);
        if (!safePath(resolved)) { jsonReply(res, 400, { error: 'Invalid path' }); return; }
        // 符号链接逃逸防护（只读，isWrite=false）
        var real = resolveRealSafe(resolved, false);
        if (!real) { jsonReply(res, 403, { error: 'Path resolved to unsafe location (symlink escape)' }); return; }
        resolved = real;
        // 敏感路径拒读（凭据/密钥类）
        if (_isSensitivePath(resolved)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }
        // 确认存在且为普通文件
        var st;
        try { st = fs.statSync(resolved); } catch (_) { jsonReply(res, 404, { error: 'File not found or not accessible' }); return; }
        if (!st.isFile()) { jsonReply(res, 400, { error: 'Not a regular file' }); return; }
        if (st.size > MAX_PARSE_FILE_SIZE) {
            jsonReply(res, 413, { ok: false, error: 'File too large (max ' + MAX_PARSE_FILE_SIZE + ' bytes)' });
            return;
        }
        // 解析缓存：key = 真实路径 + size + mtimeMs（文件被修改即失效）；命中直接返回，免全量解析
        var cacheKey = 'doc|' + resolved + '|' + st.size + '|' + st.mtimeMs;
        var cachedEntry = parseCacheGet(cacheKey);
        if (cachedEntry !== undefined) {
            jsonReply(res, 200, _parseDocReply(ext.slice(1), cachedEntry));
            return;
        }
        // 各解析分支回复前统一写缓存
        function replyParsed(format, text, extra) {
            var entry = { text: text };
            if (extra && Array.isArray(extra.images) && extra.images.length) {
                entry.images = extra.images;
                entry.imageTotal = extra.imageTotal;
                entry.imagesSkipped = extra.imagesSkipped;
            }
            parseCacheSet(cacheKey, entry);
            jsonReply(res, 200, _parseDocReply(format, entry));
        }

        function parsePdf() {
            // unpdf 虽为 ESM 优先包，但提供 CJS 产物（exports.require → dist/index.cjs），
            // 用 require() 加载以走 NODE_PATH（vendor 化部署无根 node_modules）：
            // ESM 的 import() specifier 解析不走 NODE_PATH，部署环境会找不到。
            var unpdf;
            try { unpdf = require('unpdf'); }
            catch (e) { jsonReply(res, 500, { ok: false, error: 'unpdf not available: ' + (e && e.message) }); return; }
            fs.readFile(resolved, function (readErr, data) {
                if (readErr) { jsonReply(res, 404, { error: 'File not found' }); return; }
                // unpdf 要求 Uint8Array（Buffer 是 Uint8Array 子类但传 Buffer 会报错），显式转 Uint8Array
                var u8 = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
                unpdf.extractText(u8).then(function (r) {
                    // unpdf 按页返回数组，规范为换行分隔字符串，避免注入时 push 数组
                    var raw = (r && r.text) || '';
                    var text = Array.isArray(raw) ? raw.join('\n') : String(raw);
                    text = stripBOM(text);
                    replyParsed('pdf', text);
                }).catch(function (e) {
                    jsonReply(res, 500, { ok: false, error: 'PDF parse failed: ' + (e && e.message) });
                });
            });
        }

        function parseXlsx() {
            var XLSX;
            try { XLSX = require('@wwek/xlsx'); }
            catch (_) { jsonReply(res, 500, { ok: false, error: '@wwek/xlsx not installed' }); return; }
            var wb;
            try {
                if (ext === '.csv') {
                    // CSV 是纯文本，SheetJS readFile 按二进制解析易把 UTF-8 中文读成乱码；
                    // 显式以 utf8 读内容并经 type:'string' 交给 SheetJS，保证中文正确。
                    var csvSrc = fs.readFileSync(resolved, 'utf8');
                    wb = XLSX.read(stripBOM(csvSrc), { type: 'string' });
                } else {
                    wb = XLSX.readFile(resolved);
                }
            }
            catch (e) { jsonReply(res, 500, { ok: false, error: 'xlsx read failed: ' + (e && e.message) }); return; }
            var out = [];
            if (wb && wb.SheetNames) {
                wb.SheetNames.forEach(function (name, i) {
                    var ws = wb.Sheets[name];
                    var csv = XLSX.utils.sheet_to_csv(ws);
                    out.push((wb.SheetNames.length > 1 ? '#### Sheet: ' + name + '\n\n' : '') + csv);
                });
            }
            replyParsed(ext.slice(1), out.join('\n\n'));
        }

        function parseDocx() {
            var mammoth;
            try { mammoth = require('mammoth'); }
            catch (_) { jsonReply(res, 500, { ok: false, error: 'mammoth not installed' }); return; }
            _docxToMarkdownText(mammoth, { path: resolved }).then(function (parsed) {
                replyParsed('docx', parsed.text, parsed);
            }).catch(function (e) {
                jsonReply(res, 500, { ok: false, error: 'docx parse failed: ' + (e && e.message) });
            });
        }

        if (ext === '.pdf') { parsePdf(); return; }
        if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '.csv') { parseXlsx(); return; }
        if (ext === '.txt' || ext === '.md' || ext === '.js') {
            // 纯文本：utf8 直读（stripBOM 去 BOM），免第三方库
            fs.readFile(resolved, 'utf8', function (readErr, text) {
                if (readErr) { jsonReply(res, 500, { ok: false, error: 'text read failed: ' + (readErr && readErr.message) }); return; }
                replyParsed(ext.slice(1), stripBOM(text));
            });
            return;
        }
        parseDocx();
    });
}

// ========== 文档/表格/PDF 内容解析（bytes 通道） ==========
// 与 /api/parse-doc 的差异：不传磁盘路径，而是把文件内容（base64）直接发来解析。
// 用途：CEP 面板 HTML5 拖拽的 File 对象通常拿不到本地绝对路径（CEF 安全沙箱限制，
// file.path 各环境行为不一；实测当前环境可拿到，但不可依赖），面板侧用 FileReader
// 读内容后走此端点，绕开路径限制、不落盘，作为无路径场景的兜底通道。
// 格式分发与 parse-doc 一致（mammoth / @wwek/xlsx / unpdf），上限按 base64 长度限制。
var MAX_PARSE_BYTES = 32 * 1024 * 1024;   // base64 长度上限（约 24MB 原始内容）

function handleParseDocBytes(req, res) {
    readBody(req, function (body) {
        var input;
        try { input = JSON.parse(body || '{}'); } catch (_) { jsonReply(res, 400, { error: 'Invalid JSON' }); return; }
        var fileName = String(input && input.name || '');
        var data = String(input && input.data || '');
        if (!fileName || !data) { jsonReply(res, 400, { error: 'Missing name/data' }); return; }
        if (data.length > MAX_PARSE_BYTES) {
            jsonReply(res, 413, { ok: false, error: 'File too large (max ' + MAX_PARSE_BYTES + ' bytes base64)' });
            return;
        }
        var ext = path.extname(fileName).toLowerCase();
        var SUPPORTED = { '.docx': 1, '.xlsx': 1, '.xls': 1, '.xlsm': 1, '.csv': 1, '.pdf': 1, '.txt': 1, '.md': 1, '.js': 1 };
        // 与 parse-doc 同款——.doc 明确报不支持并引导转存（mammoth 只认 .docx）
        if (ext === '.doc') { jsonReply(res, 400, { ok: false, error: '不支持旧版 .doc 格式（mammoth 仅支持 .docx）——请用 Word/WPS 转存为 .docx 后重试' }); return; }
        if (!SUPPORTED[ext]) { jsonReply(res, 400, { error: 'Unsupported format: ' + ext }); return; }
        var buf;
        try { buf = Buffer.from(data, 'base64'); } catch (_) { jsonReply(res, 400, { error: 'Invalid base64' }); return; }

        // 内容通道缓存：key = 名称 + base64 长度 + 首尾片段（同内容重复拖入时免重复解析）
        var bytesKey = 'bytes|' + fileName.toLowerCase() + '|' + data.length + '|' + data.slice(0, 32) + '|' + data.slice(-32);
        var cachedEntry = parseCacheGet(bytesKey);
        if (cachedEntry !== undefined) {
            jsonReply(res, 200, _parseDocReply(ext.slice(1), cachedEntry));
            return;
        }

        function replyOk(format, text, extra) {
            text = stripBOM(text);
            var entry = { text: text };
            if (extra && Array.isArray(extra.images) && extra.images.length) {
                entry.images = extra.images;
                entry.imageTotal = extra.imageTotal;
                entry.imagesSkipped = extra.imagesSkipped;
            }
            parseCacheSet(bytesKey, entry);
            jsonReply(res, 200, _parseDocReply(format, entry));
        }
        function parsePdfBytes() {
            var unpdf;
            try { unpdf = require('unpdf'); }
            catch (e) { jsonReply(res, 500, { ok: false, error: 'unpdf not available: ' + (e && e.message) }); return; }
            var u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
            unpdf.extractText(u8).then(function (r) {
                var raw = (r && r.text) || '';
                replyOk('pdf', Array.isArray(raw) ? raw.join('\n') : String(raw));
            }).catch(function (e) {
                jsonReply(res, 500, { ok: false, error: 'PDF parse failed: ' + (e && e.message) });
            });
        }
        function parseXlsxBytes() {
            var XLSX;
            try { XLSX = require('@wwek/xlsx'); }
            catch (_) { jsonReply(res, 500, { ok: false, error: '@wwek/xlsx not installed' }); return; }
            var wb;
            try {
                if (ext === '.csv') {
                    wb = XLSX.read(stripBOM(buf.toString('utf8')), { type: 'string' });
                } else {
                    wb = XLSX.read(buf, { type: 'buffer' });
                }
            }
            catch (e) { jsonReply(res, 500, { ok: false, error: 'xlsx read failed: ' + (e && e.message) }); return; }
            var out = [];
            if (wb && wb.SheetNames) {
                wb.SheetNames.forEach(function (sheetName) {
                    var ws = wb.Sheets[sheetName];
                    var csv = XLSX.utils.sheet_to_csv(ws);
                    out.push((wb.SheetNames.length > 1 ? '#### Sheet: ' + sheetName + '\n\n' : '') + csv);
                });
            }
            replyOk(ext.slice(1), out.join('\n\n'));
        }
        function parseDocxBytes() {
            var mammoth;
            try { mammoth = require('mammoth'); }
            catch (_) { jsonReply(res, 500, { ok: false, error: 'mammoth not installed' }); return; }
            _docxToMarkdownText(mammoth, { buffer: buf }).then(function (parsed) {
                replyOk('docx', parsed.text, parsed);
            }).catch(function (e) {
                jsonReply(res, 500, { ok: false, error: 'docx parse failed: ' + (e && e.message) });
            });
        }

        if (ext === '.pdf') { parsePdfBytes(); return; }
        if (ext === '.xlsx' || ext === '.xls' || ext === '.xlsm' || ext === '.csv') { parseXlsxBytes(); return; }
        if (ext === '.txt' || ext === '.md' || ext === '.js') {
            replyOk(ext.slice(1), buf.toString('utf8'));
            return;
        }
        parseDocxBytes();   // .docx（.doc 已在 SUPPORTED 前被明确拒绝）
    });
}

// 读二进制文件：直接回原始字节流（application/octet-stream），免 base64 编解码 + JSON 包装 +
// 33% 膨胀传输。是 write-blob 的对称项——读上游图/视频上传 ComfyUI、编辑器加载图、截图读帧等热路径。
//
// 与 handleReadImage 的区别：
//   - 输出裸字节流（Content-Type 由扩展名推断），非 base64+JSON
//   - 不限 png/jpg/jpeg——通用二进制（图片/视频/任意文件）
//   - 不做 PNG IEND 验证等图片专属逻辑（下游读图走老 read-image 拿 iendVerified，或靠尺寸稳定）
//   - 上限 MAX_BLOB_READ 放宽到 512MB（承接视频上游，与 write-blob MAX_WRITE_SIZE 对齐）
// 安全与 read-image 对齐：safePath 双校验（原始 + resolved）+ isFile + 上限 + waitFileStable。
// 路径走 query（与 write-blob 一致），GET 方法（读无副作用，且 fetch GET 更直观）。
var MAX_BLOB_READ = 512 * 1024 * 1024;
function handleReadBlob(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'GET') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }
    var q = url.parse(req.url, true).query;
    var filePath = '';
    if (q.path) {
        try { filePath = decodeURIComponent(q.path); }
        catch (e) { jsonReply(res, 400, { ok: false, error: 'Invalid path encoding' }); return; }
    }
    if (!filePath) { jsonReply(res, 400, { ok: false, error: 'Missing path' }); return; }

    // 路径安全：先校验原始输入，再 resolve（resolve 会消解 ..，必须在 resolve 前校验，与 read-image 一致）
    if (!safePath(filePath)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }
    var resolved = path.resolve(filePath);
    if (!safePath(resolved)) { jsonReply(res, 400, { ok: false, error: 'Invalid path' }); return; }

    // 符号链接逃逸防护：消解 symlink/junction 后对真实路径重校验（read-blob 只读，isWrite=false）
    var rpBlob = resolveRealSafe(resolved, false);
    if (!rpBlob) { jsonReply(res, 403, { ok: false, error: 'Path resolved to unsafe location (symlink escape)' }); return; }
    resolved = rpBlob;

    // 敏感路径拒读（凭据/密钥类文件不允许经 bridge 读出）
    if (_isSensitivePath(resolved)) { jsonReply(res, 403, { ok: false, error: 'sensitive path denied' }); return; }

    // 确认存在且为普通文件
    try {
        var st = fs.statSync(resolved);
        if (!st.isFile()) { jsonReply(res, 400, { ok: false, error: 'Not a regular file' }); return; }
    } catch (_) {
        jsonReply(res, 404, { ok: false, error: 'File not found or not accessible' });
        return;
    }

    var fileSize = st.size;
    if (fileSize > MAX_BLOB_READ) {
        logErr('Oversized blob rejected: ' + fileSize + ' bytes path=' + resolved);
        jsonReply(res, 413, { ok: false, error: 'File too large (max ' + MAX_BLOB_READ + ' bytes)' });
        return;
    }

    // 等文件写完稳定（AE saveFrameToPng 渐进写入、画布落盘等场景），与 read-image 同款
    _waitFileStableShared(res, resolved, Date.now(), fileSize, function (err) {
        if (err) { jsonReply(res, 500, { ok: false, code: 'READ_FAILED', error: err.message || String(err) }); return; }
        // waitFileStable 已确认尺寸连续两次相等（写完），重新 stat 拿最终尺寸作 Content-Length。
        // 注：stat→stream 间理论有 TOCTOU 窗口（外部改文件），但 waitFileStable 已大幅降低概率，
        // stream.on('error') 兜底；客户端 r.blob() 按 Content-Length 收，流提前断会得到截断 blob（极端情况）。
        try {
            var st2 = fs.statSync(resolved);
            fileSize = st2.size;
        } catch (_) {}
        var mime = _mimeFromExt(path.extname(resolved).toLowerCase());
        // 流式回传：createReadStream 不把整个文件读进内存（大视频友好）。
        // writeHead 延后到 stream 'open' 成功——避免提前回 200 后 stream open 失败导致客户端收到
        // 截断响应（r.ok=true 但 blob 不完整）。open 失败返 500。中途读 error（磁盘 IO 故障，极罕见）
        // 仍可能截断，stream.on('error') end 兜底。
        var stream = fs.createReadStream(resolved);
        var headersSent = false;
        stream.on('open', function () {
            if (headersSent || res.destroyed) return;
            headersSent = true;
            res.writeHead(200, Object.assign({
                'Content-Type': mime,
                'Content-Length': fileSize,
                'Cache-Control': 'no-store'
            }, CORS_HEADERS));
            stream.pipe(res);
        });
        stream.on('error', function (e) {
            logErr('read-blob stream error: ' + (e && e.message) + ' path=' + resolved);
            if (!headersSent) {
                jsonReply(res, 500, { ok: false, code: 'READ_FAILED', error: 'Read failed: ' + (e && e.message || '') });
            } else if (!res.destroyed) {
                try { res.end(); } catch (_) {}
            }
        });
    });
}

// 共享版 waitFileStable（read-image / read-blob 复用，避免在两个闭包各写一份）
function _waitFileStableShared(res, filePath, startTime, lastSize, cb) {
    if (res.destroyed) { cb(new Error('Request destroyed')); return; }
    if (!startTime) startTime = Date.now();
    if (Date.now() - startTime > MAX_FILE_WAIT_MS) {
        // 0 字节不再「两个紧邻 stat 都为 0」立即判死——AE 渐进写图
        // 常见「先建空文件后写入」：0 字节立即判死会秒失败，挂满 15s 窗口再放行则假成功空图。
        // 现在 0 字节同样进入稳定等待窗口：期间尺寸变化即正常走；到超时仍未写入才失败，
        // 并带明确原因。读图端点按文案不含 Timeout 回 500，普通超时回 504。
        cb(new Error(lastSize === 0
            ? 'File is empty (0 bytes) after ' + Math.round(MAX_FILE_WAIT_MS / 1000) + 's wait'
            : 'Timeout waiting for file to stabilize'));
        return;
    }
    fs.stat(filePath, function (statErr, st) {
        if (res.destroyed) { cb(new Error('Request destroyed')); return; }
        if (statErr) {
            if (statErr.code === 'ENOENT') {
                setTimeout(function () { _waitFileStableShared(res, filePath, startTime, lastSize, cb); }, RETRY_DELAY_MS);
            } else {
                cb(statErr);
            }
            return;
        }
        if (lastSize !== undefined && st.size === lastSize && st.size !== 0) {
            // 连续两次尺寸相等且非 0：写完，正常返回。0 字节继续轮询（见上：可能是
            // AE 先建空文件的渐进写），到超时窗口耗尽才按空文件失败。
            cb(null);
            return;
        }
        setTimeout(function () { _waitFileStableShared(res, filePath, startTime, st.size, cb); }, RETRY_DELAY_MS);
    });
}

// 扩展名 → mime（读图/视频/通用），未知 fallback octet-stream
function _mimeFromExt(ext) {
    var map = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
        '.webp': 'image/webp', '.bmp': 'image/bmp',
        '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska',
        '.avi': 'video/x-msvideo', '.m4v': 'video/x-m4v',
        '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg'
    };
    return map[ext] || 'application/octet-stream';
}

// ========== HTTPS 代理下载（替代 certutil system.callSystem） ==========

var MAX_DOWNLOAD_SIZE = 5 * 1024 * 1024; // 5MB
var MAX_DOWNLOAD_REDIRECTS = 3;
var DOWNLOAD_TIMEOUT_MS = 15000;

// timeoutMs 可选：单请求超时（默认 DOWNLOAD_TIMEOUT_MS）。skill store 拉取用短超时，
// 避免"目录列表 + 逐 SKILL.md 回退"链路最坏耗时远超客户端等待。

// SSRF 纵深：_isPrivateHost 只做 hostname 字符串/字面 IP 判定，攻击者控制域名
// （A 记录直指 127.0.0.1/内网，即 DNS rebinding）可无条件通过调用方的前置校验——
// 真正的 DNS 解析发生在 https.get 连接时。定制 lookup：解析出实际连接 IP 后复查
// _isPrivateHost，私网/回环即拒绝连接（错误走 req.on('error') → doneOnce，对齐
// 既有失败语义）。重定向递归也经同一函数 → 每一跳连接均过 lookup 校验。
// lookup 对字面 IP 原样返回、再过一次 _isPrivateHost 幂等安全（IPv6 字面量/
// localhost 已被调用方前置字符串校验拦截，不会走到这里）。
function _safeLookup(hostname, options, callback) {
    var dns = require('dns');
    dns.lookup(hostname, options, function (err, address, family) {
        if (err) return callback(err, address, family);
        // （复查发现）：Node ≥ 20 Happy Eyeballs（autoSelectFamily）下
        // net.connect 以 {all:true} 调用定制 lookup，回调 address 是地址数组而非字符串
        // ——_isPrivateHost 的 String() 归一会把数组拼成 '127.0.0.1,93.x.x.x' 形态，
        // 不匹配任何私网模式而放行，rebinding 复查失效。数组时逐元素复查，任一私网即拒绝
        if (Array.isArray(address)) {
            for (var ai = 0; ai < address.length; ai++) {
                var one = address[ai] && address[ai].address ? address[ai].address : address[ai];
                if (_isPrivateHost(one)) {
                    return callback(new Error('Blocked private/reserved address: ' + one));
                }
            }
        } else if (_isPrivateHost(address)) {
            return callback(new Error('Blocked private/reserved address: ' + address));
        }
        callback(null, address, family);
    });
}

// deadlineTs（可选，绝对时间戳）：跨重定向的**总**时限。req.setTimeout 只是 socket
// 不活动超时——滴流响应（每 <timeout 字节持续发送）可无限重置，单个请求永不结束
// （审计：skill-store/comfy-templates 的 in-flight 队列被永久毒化）。除各跳的
// 不活动超时外，另挂 wall-clock 定时器；重定向递归透传同一 deadline，整条链受限。
function _doHttpsDownload(targetUrl, redirectCount, callback, timeoutMs, deadlineTs) {
    if (redirectCount > MAX_DOWNLOAD_REDIRECTS) {
        callback('Too many redirects');
        return;
    }

    var effectiveTimeout = timeoutMs || DOWNLOAD_TIMEOUT_MS;
    var deadlineAt = deadlineTs || (Date.now() + effectiveTimeout);
    var wallTimer = null;
    var done = false;
    function doneOnce(err, content) {
        if (done) return;
        done = true;
        if (wallTimer !== null) { try { clearTimeout(wallTimer); } catch (_) {} }
        callback(err, content);
    }

    var req = https.get(targetUrl, {
        // 连接用的 IP 须过私网复查（见 _safeLookup 注释）
        lookup: _safeLookup,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
        }
    }, function (resp) {
        // Handle redirects
        if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
            var redirectUrl = resp.headers.location;
            try {
                redirectUrl = url.resolve(targetUrl, redirectUrl);
            } catch (_) {
                resp.resume();
                doneOnce('Invalid redirect URL');
                return;
            }
            if (!/^https:\/\//.test(redirectUrl)) {
                resp.resume();
                doneOnce('Redirect to non-HTTPS URL blocked');
                return;
            }
            // 重定向目标也必须过 SSRF 校验
            var redirHostname;
            try {
                var rp = url.parse(redirectUrl);
                redirHostname = (rp.hostname || '').toLowerCase();
            } catch (_) { redirHostname = ''; }
            if (!redirHostname || _isPrivateHost(redirHostname)) {
                resp.resume();
                doneOnce('Redirect to internal/private host blocked');
                return;
            }
            resp.resume();
            // 重定向递归必须传包装回调（经外层 doneOnce 去重），不得直传原始
            // callback——否则内层递归结算时外层 done 标志从未置位，外层重定向响应排空
            // 耗时超时/外层 socket 随后报错时会以 done=false 再次调用 callback →
            // handleDownloadUrl/handleWebSearch/handleFetchPage/_fetchSkillCatalog 对已
            // end 的 res 二次 jsonReply（writeHead 抛 ERR_HTTP_HEADERS_SENT → catch 内
            // 再抛 → uncaughtException → bridge 整体退出；skill-store 链 remaining 计数
            // 重复递减、in-flight 队列永不 flush）
            _doHttpsDownload(redirectUrl, redirectCount + 1, function (err, c) { doneOnce(err, c); }, timeoutMs, deadlineAt);
            return;
        }

        if (resp.statusCode !== 200) {
            resp.resume();
            doneOnce('HTTP ' + resp.statusCode);
            return;
        }

        var chunks = [];
        var totalSize = 0;
        resp.on('data', function (chunk) {
            totalSize += chunk.length;
            if (totalSize > MAX_DOWNLOAD_SIZE) {
                req.destroy();
                doneOnce('Response too large (>5MB)');
                return;
            }
            chunks.push(chunk);
        });
        resp.on('end', function () {
            if (totalSize > MAX_DOWNLOAD_SIZE) return;
            var content = Buffer.concat(chunks).toString('utf8');
            doneOnce(null, content);
        });
        resp.on('error', function (e) {
            doneOnce('Download error: ' + e.message);
        });
    });

    req.setTimeout(effectiveTimeout);
    req.on('timeout', function () {
        req.destroy();
        doneOnce('Download timeout (' + (effectiveTimeout / 1000) + 's)');
    });
    req.on('error', function (e) {
        doneOnce('Request error: ' + e.message);
    });
    // wall-clock 总时限（防滴流响应无限重置 socket 不活动超时）。unref 不阻止进程退出。
    if (typeof setTimeout === 'function') {
        wallTimer = setTimeout(function () {
            wallTimer = null;
            try { req.destroy(); } catch (_) {}
            doneOnce('Download timeout (' + (effectiveTimeout / 1000) + 's)');
        }, Math.max(1, deadlineAt - Date.now()));
        if (wallTimer && typeof wallTimer.unref === 'function') wallTimer.unref();
    }
}

// 拒 SSRF：loopback / 内网 / 链路本地。
// IPv4 按 inet_aton 语义解析：支持 1~4 段（a / a.b / a.b.c / a.b.c.d）与
// 十进制 / 八进制(0 前缀) / 十六进制(0x 前缀) 段——覆盖 127.1、0177.0.0.1、
// 0x7f.1、2130706433 等非常规写法；IPv6 覆盖 IPv4-mapped（::ffff:127.0.0.1 与
// 十六进制组形式 ::ffff:7f00:1）、ULA fc00::/7、链路本地 fe80::/10、
// site-local fec0::/10，防止格式绕过。
function _parseIpv4Like(hostname) {
    var parts = String(hostname || '').split('.');
    if (parts.length < 1 || parts.length > 4) return null;
    function parseSeg(segStr, max) {
        var n;
        if (/^0[xX][0-9a-fA-F]+$/.test(segStr)) n = parseInt(segStr.slice(2), 16);
        else if (/^0[0-7]+$/.test(segStr)) n = parseInt(segStr.slice(1), 8);
        else if (/^0$/.test(segStr) || /^[1-9][0-9]*$/.test(segStr)) n = parseInt(segStr, 10);
        else return null;
        return (n >= 0 && n <= max) ? n : null;
    }
    var vals = [];
    for (var i = 0; i < parts.length; i++) {
        // 尾段位宽随段数收窄：4 段→255，3 段→65535，2 段→16777215，1 段→完整 32 位
        var isLast = (i === parts.length - 1);
        var max = isLast
            ? (parts.length === 1 ? 0xFFFFFFFF : Math.pow(256, 5 - parts.length) - 1)
            : 255;
        var v = parseSeg(parts[i], max);
        if (v === null) return null;
        vals.push(v);
    }
    // inet_aton 布局：首段是顶字节，中间段各占一字节，尾段整体占剩余低位字节
    if (vals.length === 1) return vals[0];
    var val = vals[0];
    for (var k = 1; k < vals.length - 1; k++) val = val * 256 + vals[k];
    return val * Math.pow(256, 4 - vals.length + 1) + vals[vals.length - 1];
}

function _isPrivateIpv4Long(long) {
    // 数值比较（long 可能 > 2^31，位运算会溢出截断）
    return (long >= 0x7F000000 && long <= 0x7FFFFFFF)      // 127.0.0.0/8
        || (long >= 0x00000000 && long <= 0x000000FF)      // 0.0.0.0/8
        || (long >= 0x0A000000 && long <= 0x0AFFFFFF)      // 10.0.0.0/8
        || (long >= 0xAC100000 && long <= 0xAC1FFFFF)      // 172.16.0.0/12
        || (long >= 0xC0A80000 && long <= 0xC0A8FFFF)      // 192.168.0.0/16
        || (long >= 0xA9FE0000 && long <= 0xA9FEFFFF);     // 169.254.0.0/16
}

function _isPrivateHost(hostname) {
    hostname = String(hostname || '').toLowerCase();
    if (hostname === 'localhost' || hostname === '::1' || hostname === '::' ||
        hostname === '0.0.0.0') return true;
    // IPv4-mapped IPv6：点分形式 ::ffff:127.0.0.1 归一成 IPv4 再判定；
    // 十六进制组形式 ::ffff:7f00:1 直接换算成 32 位数值判定
    var mapped = hostname.match(/^::ffff:(.+)$/);
    if (mapped) {
        var tail = mapped[1];
        if (/\./.test(tail)) {
            hostname = tail;
        } else {
            var g = tail.match(/^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
            if (g) return _isPrivateIpv4Long(parseInt(g[1], 16) * 65536 + parseInt(g[2], 16));
            return false;
        }
    }
    // IPv6 内网段：ULA fc00::/7（fc00~fdff）、链路本地 fe80::/10 与 site-local fec0::/10（fe80~feff）
    if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true;
    if (/^fe[89abcdef][0-9a-f]:/.test(hostname)) return true;
    var long = _parseIpv4Like(hostname);
    if (long !== null) return _isPrivateIpv4Long(long);
    return false;
}

function handleDownloadUrl(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }

    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { jsonReply(res, 400, { ok: false, error: 'Invalid JSON' }); return; }
        // JSON.parse('null') 返回 null 不进 catch：不守卫则属性访问抛未捕获异常触发进程退出
        if (!params || typeof params !== 'object') { jsonReply(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

        var targetUrl = params.url;
        if (!targetUrl || typeof targetUrl !== 'string') {
            jsonReply(res, 400, { ok: false, error: 'Missing url' });
            return;
        }

        // 安全校验：仅 HTTPS，拒控制字符防 HTTP 走私
        if (!/^https:\/\/.+/.test(targetUrl)) {
            jsonReply(res, 400, { ok: false, error: 'Only HTTPS URLs allowed' });
            return;
        }
        if (targetUrl.length > 4096) {
            jsonReply(res, 400, { ok: false, error: 'URL too long' });
            return;
        }
        // 拒控制字符（\x00-\x1f \x7f），防止换行/回车注入 HTTP 请求行
        if (/[\x00-\x1f\x7f]/.test(targetUrl)) {
            jsonReply(res, 400, { ok: false, error: 'URL contains control characters' });
            return;
        }

        var parsed;
        try { parsed = url.parse(targetUrl); } catch (_) { jsonReply(res, 400, { ok: false, error: 'Invalid URL' }); return; }
        var hostname = (parsed.hostname || '').toLowerCase();
        if (!hostname) { jsonReply(res, 400, { ok: false, error: 'Invalid hostname' }); return; }

        // 拒 URL 中含 @ 的用户信息段（防混淆 https://trusted@evil.com）
        // url.parse 把 @ 前当 auth，hostname 仍是 evil.com，但视觉上用户可能误判
        if (parsed.auth) {
            jsonReply(res, 400, { ok: false, error: 'URL with credentials not allowed' });
            return;
        }

        // 拒 SSRF：localhost / 内网 / 链路本地
        if (_isPrivateHost(hostname)) {
            jsonReply(res, 403, { ok: false, error: 'Internal/private URLs not allowed' });
            return;
        }

        _doHttpsDownload(targetUrl, 0, function (err, content) {
            if (err) {
                jsonReply(res, 502, { ok: false, error: err });
            } else {
                jsonReply(res, 200, { ok: true, content: content });
            }
        });
    });
}

// ========== Web Search（桌宠联网搜索，cn.bing.com HTML 爬取） ==========

// 桥侧搜索超时档位（三处联动，必须 桥 < 客户端 < 桌宠外层——桥最早超时，调用方才能
// 拿到明确错误而不是自己的 abort/超时兜底，否则「客户端已 abort、桥侧请求仍在跑」）：
//   ① 桥侧 6500ms（本常量）：超时即由 _doHttpsDownload 的 req.destroy() 主动中止上游；
//   ② 客户端 abort 8s（webSearchTool.js / petWebSearch.js）——桥 6.5s 先回，8s 用不到；
//   ③ 桌宠 executeTool 硬超时 10s（petController.js，命中只回「工具执行超时」丢原因）。
// 桥侧压到 6–7s（原为默认 DOWNLOAD_TIMEOUT_MS 15s，必然晚于
// ① ② 两层，客户端先 abort 后桥侧请求仍在跑）。
var WEB_SEARCH_TIMEOUT_MS = 6500;

// 结果条数口径（实测）：Bing CN 首页只有 8~10 条 b_algo，num 的「上限 20」拿不满；
// 且**没有可用的翻页参数**——first=10/11/20、count=20、first+FORM=PERE、first+mkt、首页 FPIG
// 令牌在 4 个查询词上全部被忽略（结果集与首页完全相同、页面自报当前页恒为 1），www.bing.com
// 本机不可达。无 cookie 会话时 Bing 不认翻页，故端点不提供 page：提供了模型只会反复拿回同一批
// 结果。要更多结果只能换查询词（工具描述里已给改写指引）。

function _stripBingTags(html) {
    return String(html || '')
        .replace(/<[^>]*>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x27;/g, "'")
        .replace(/&#39;/g, "'");
}

function _parseBingResults(html, limit) {
    var results = [];
    // Bing CN HTML：每条结果在 <li class="b_algo"> 内
    // 标题: <h2><a href="...">title</a></h2>
    // 摘要: <p class="b_lineclamp...">snippet</p> 或 <div class="b_caption"><p>snippet</p></div>
    var blockRe = /<li[^>]*class="[^"]*b_algo[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
    // 优先匹配 <h2> 内的链接（更准确），fallback 到 block 内第一个 <a>
    var linkReH2 = /<h2[^>]*>\s*<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    var linkReFallback = /<a[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
    var snippetRe = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i;
    var snippetRe2 = /<div[^>]*class="[^"]*b_caption[^"]*"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i;
    // 条数上限：由调用方（handleWebSearch 的 num）决定，缺省 8。
    // 写死 8 时工具侧 num 可到 20 → LLM 传 20 只拿到 8（口径不一致）。
    var max = (typeof limit === 'number' && isFinite(limit) && limit > 0) ? Math.floor(limit) : 8;
    var m;
    while ((m = blockRe.exec(html)) && results.length < max) {
        var block = m[1];
        var linkMatch = block.match(linkReH2) || block.match(linkReFallback);
        if (!linkMatch) continue;
        var url = linkMatch[1];
        var title = _stripBingTags(linkMatch[2]).trim();
        if (!title || !url) continue;
        // 提取摘要
        var snippet = '';
        var snipMatch = block.match(snippetRe);
        if (!snipMatch) snipMatch = block.match(snippetRe2);
        if (snipMatch) snippet = _stripBingTags(snipMatch[1]).trim();
        results.push({ title: title, url: url, snippet: snippet });
    }
    return results;
}

function handleWebSearch(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }

    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { jsonReply(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

        var query = (params && params.query ? params.query : '').toString().trim();
        if (!query) {
            jsonReply(res, 400, { ok: false, error: 'Missing query' });
            return;
        }
        if (query.length > 500) {
            jsonReply(res, 400, { ok: false, error: 'Query too long' });
            return;
        }
        // 拒控制字符（防 HTTP 走私）
        if (/[\x00-\x1f\x7f]/.test(query)) {
            jsonReply(res, 400, { ok: false, error: 'Query contains control characters' });
            return;
        }
        // num：与工具侧（webSearchTool.handleSearchWeb）同口径 [1,20]、默认 5。
        // 端点**完全不读**该参数时解析硬上限 8 条：LLM 传 20 只拿 8 条、传 1 也拿 8 条，
        // 工具 schema 里的 num 形同虚设。上限 20 与工具侧一致，防超大 num 撑大上下文。
        var numRaw = Number(params && params.num);
        var num = (isFinite(numRaw) && numRaw > 0) ? Math.min(20, Math.max(1, Math.floor(numRaw))) : 5;

        // 国内直连 cn.bing.com，零配置无 Key。
        // 显式传桥侧档位（WEB_SEARCH_TIMEOUT_MS，见常量处三档注释）：到点经既有中止
        // 通道 req.destroy() 主动断开上游，不再走默认 15s——否则客户端 8s abort 后
        // 桥侧请求仍在跑（审计）。
        var searchUrl = 'https://cn.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN';
        _doHttpsDownload(searchUrl, 0, function (err, content) {
            if (err) {
                // 超时（socket 不活动 / wall-clock 兜底，_doHttpsDownload 两条通道统一文案
                // 「Download timeout (Ns)」）回明确超时错误：SEARCH_TIMEOUT 前缀 + timeout:true
                // 标记，与「查询非法」「Bing 不可达」等失败区分开；504 对齐本文件其它超时
                // 回包口径（如 ext 调用 waitMsg 分支）。用前缀精确匹配——不按 /timeout/i
                // 泛匹配，否则上游 connect ETIMEDOUT 等网络错会被误标成桥侧 6.5s 主动中止。
                var timedOut = String(err).indexOf('Download timeout (') === 0;
                if (timedOut) err = 'SEARCH_TIMEOUT: 搜索超时（桥侧 ' + (WEB_SEARCH_TIMEOUT_MS / 1000) + 's 主动中止上游请求）';
                logErr('[web-search] download failed: ' + err + ' (query=' + query + ')');
                jsonReply(res, timedOut ? 504 : 502, { ok: false, error: err, timeout: !!timedOut });
                return;
            }
            var html = content.toString('utf8');
            var results = _parseBingResults(html, num);
            log('[web-search] query="' + query + '" htmlLen=' + html.length + ' num=' + num
                + ' results=' + results.length);
            if (results.length === 0) {
                // 解析为空时记录 HTML 开头，便于排查正则过时；并带 degraded 标记回给调用方——
                // 一条都没解析出来不能当「确实没有结果」（Bing 改版/限流时调用方会据此告知
                // 用户「没搜到」，故障被吞成正常空结果）。
                logErr('[web-search] no results parsed. html head: ' + html.substring(0, 500));
                jsonReply(res, 200, {
                    ok: true, results: [], query: query, num: num,
                    degraded: true,
                    note: '可能是页面结构改版、请求被限流，或该查询确实没有结果'
                });
                return;
            }
            jsonReply(res, 200, { ok: true, results: results, query: query, num: num });
        }, WEB_SEARCH_TIMEOUT_MS);
    });
}

// ========== 网页正文抓取（LLM read_url 工具） ==========

// 桥侧档位（与 web-search 同原则：桥必须早于客户端超时收口，调用方才能拿到桥侧可读原因——
// 否则客户端 abort 先到，原因丢失，只剩一句「页面抓取超时（15s）」）：
//   ① 桥侧 12000ms（本常量）：到点由 _doHttpsDownload 经 req.destroy() 主动中止上游；
//   ② 客户端 abort 15000ms（readUrlTool.js）：桥先回，客户端用不到 abort。
// 此处不传档位 → 走缺省 DOWNLOAD_TIMEOUT_MS 15s，与客户端 abort 打平，谁先到不确定。
var FETCH_PAGE_TIMEOUT_MS = 12000;

// 数字/十六进制 HTML 实体解码为真实字符（&#65;→A、&#x27;→'、&#x1F600;→😀）。
// 越界码位（0 或 >0x10FFFF）替换为空格。
function _decodeNumericEntities(s) {
    return String(s || '')
        .replace(/&#(\d+);/g, function (_, d) {
            var c = parseInt(d, 10);
            if (!(c > 0 && c <= 0x10FFFF)) return ' ';
            try { return String.fromCodePoint(c); } catch (_) { return ' '; }
        })
        .replace(/&#x([0-9a-f]+);/gi, function (_, h) {
            var c = parseInt(h, 16);
            if (!(c > 0 && c <= 0x10FFFF)) return ' ';
            try { return String.fromCodePoint(c); } catch (_) { return ' '; }
        });
}

// 提取正文可读文本：去脚本/样式/导航等外壳，保留块级结构换行
function _extractPageText(html, maxChars) {
    var title = (String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
    // title 与 body 用同一套实体解码（数字 + 常用命名实体），保持一致
    title = _decodeNumericEntities(_stripBingTags(title))
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ').trim();
    var body = String(html || '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
        .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
        .replace(/<(nav|header|footer|aside|form|button)[\s\S]*?<\/\1>/gi, ' ')
        // title 已单独提取返回，正文里剔除避免开头重复
        .replace(/<title[\s\S]*?<\/title>/gi, ' ')
        // 块级标签结尾补换行，保留段落/列表结构，避免全挤一行
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article|blockquote|pre)>/gi, '\n')
        .replace(/<(br|hr)\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    var text = body.replace(/\u00a0/g, ' ');
    // 数字/十六进制实体解码放在 &amp; 之前，避免 &amp; 后的数字实体被二次解码；
    // &#39;/&#x27; 也由此统一覆盖
    text = _decodeNumericEntities(text)
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/[ \t]{2,}/g, ' ')
        .split('\n').map(function (ln) { return ln.trim(); }).filter(function (ln) { return ln; }).join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
    maxChars = maxChars || 80 * 1024;
    if (text.length > maxChars) text = text.slice(0, maxChars) + '\n\n[... 已截断，如需更完整内容请根据有效链接自行查看]';
    return { title: title, text: text };
}

// fetch-page 结果缓存：LLM 读长文时会用 offset 分多次翻页，若每次都重新下载整页，
// 既浪费（每次翻页都走完整抓取）又有分页错位风险（两次请求间页面变化导致 total/内容漂移）。
// 短 TTL 缓存提取结果（非原始 HTML），命中后直接切片，保证一次翻页序列的一致性。
var FETCH_PAGE_CACHE = new Map(); // url → { at, title, text }
var FETCH_PAGE_TTL_MS = 60 * 1000;
var FETCH_PAGE_MAX = 20;          // 上限防膨胀，超限淘汰最旧（Map 迭代序 = 插入序）

function _getFetchPageCache(urlKey) {
    var hit = FETCH_PAGE_CACHE.get(urlKey);
    if (!hit) return null;
    if (Date.now() - hit.at > FETCH_PAGE_TTL_MS) {
        FETCH_PAGE_CACHE.delete(urlKey);
        return null;
    }
    return hit;
}

function _setFetchPageCache(urlKey, title, text) {
    // 重新插入刷新 Map 位置（近似 LRU）
    FETCH_PAGE_CACHE.delete(urlKey);
    FETCH_PAGE_CACHE.set(urlKey, { at: Date.now(), title: title, text: text });
    while (FETCH_PAGE_CACHE.size > FETCH_PAGE_MAX) {
        FETCH_PAGE_CACHE.delete(FETCH_PAGE_CACHE.keys().next().value);
    }
}

// 正文检索：与 platformTools 的 _searchFileText 同语义（普通词大小写不敏感；/pattern/flags 走正则；
// 每页最多 20 条命中、每条带前后 120 字符上下文；searchOffset 跳过前 N 条命中用于翻页）。
var PAGE_SEARCH_MAX_HITS = 20;
var PAGE_SEARCH_CTX = 120;
// 正则搜索的墙钟预算：LLM 可控正则的灾难性回溯会把桥事件循环
// 独占（实测 8KB 文本 >20s ⇒ 心跳误判断线、用户重试杀桥）。100ms 对正常搜索绰绰有余
//（页面正文上限 80KB，普通词扫描 ~0.1ms 级），超时即如实回「正则过慢」。
var PAGE_SEARCH_BUDGET_MS = 100;

function _searchPageText(text, keyword, skipHits) {
    var hits = [];
    var total = 0;
    var explicit = /^\/([\s\S]*)\/([dgimsuvy]*)$/.exec(keyword);
    if (explicit) {
        // 灾难性回溯的入口识别（与 platformTools._looksCatastrophicRegex **同款副本**，两处须同步改；
        // 原判据只认「单原子+量词」叠量词，`(?:a+)+` / `((a+))+` / `(a|aa)+` /
        // `(a|a?)+` 全过闸——桥是 Node，实测后两者在 n=30 上分别约 7.2s / 42.8s 独占事件循环）。
        var _shapeProbe = String(explicit[1]);
        _shapeProbe = _shapeProbe.replace(/\[(?:\\.|[^\]\\])*\]/g, 'x');   // ① 字符类折叠成单原子
        var _spPool = 'yzqwertyuiopasdfghjkl', _spI = 0;
        _shapeProbe = _shapeProbe.replace(/\\./g, function () { return _spPool.charAt(_spI++ % _spPool.length); });
        var _ATOM = '(?:[a-zA-Z0-9._]|x)';
        var _QUANT = '(?:[+*]|\\{\\d+,\\d*\\})';
        var _cat = false;
        // 家族一：单原子 + 量词，外面再叠量词；家族二：`(?:…)` / 多余括号包裹的同款
        if (new RegExp('\\(' + _ATOM + _QUANT + '\\)\\s*' + _QUANT).test(_shapeProbe)) _cat = true;
        if (!_cat && new RegExp('\\(' + '\\?:' + _ATOM + _QUANT + '\\)\\s*' + _QUANT).test(_shapeProbe)) _cat = true;
        if (!_cat && new RegExp('\\(\\(' + _ATOM + _QUANT + '\\)\\)\\s*' + _QUANT).test(_shapeProbe)) _cat = true;
        // 家族三：分支互为前缀/相等（先去掉分支尾部量词）+ 整组叠量词
        if (!_cat) {
            var _BR = '(?:[a-zA-Z0-9._x](?:(?:[+*?])|\\{\\d+,\\d*\\})?)+';
            var _altRe = new RegExp('\\(\\??:?(' + _BR + '(?:\\|' + _BR + ')+' + ')\\)\\s*' + _QUANT, 'g'), _am;
            while (!_cat && (_am = _altRe.exec(_shapeProbe)) !== null) {
                var _brs = _am[1].split('|');
                for (var _bi = 0; _bi < _brs.length; _bi++) _brs[_bi] = _brs[_bi].replace(/(?:[+*]|\{\d+,\d*\})$/, '');
                for (var _bi2 = 0; _bi2 < _brs.length && !_cat; _bi2++) {
                    for (var _bj = 0; _bj < _brs.length; _bj++) {
                        if (_bi2 === _bj) continue;
                        if (_brs[_bi2] === _brs[_bj]
                            || (_brs[_bj].length > _brs[_bi2].length && _brs[_bj].indexOf(_brs[_bi2]) === 0)) { _cat = true; break; }
                    }
                }
            }
        }
        if (_cat) {
            return { hits: hits, total: 0, catastrophic: true };
        }
        var flags = explicit[2];
        if (flags.indexOf('g') === -1) flags += 'g';   // 保证 exec 循环能前进
        var re;
        try { re = new RegExp(explicit[1], flags); }
        catch (e) { return { hits: hits, total: 0, invalid: true }; }
        var guard = 0;
        var m;
        // 时间预算闸：正则**完全由 LLM 提供**，灾难性回溯
        // 会把桥的**事件循环**独占——实测 `/^(a+)+$/` 在 8KB 文本上每 +2 字符约 ×4：
        // n=16→3.3ms、20→44ms、24→719ms、26→2906ms，8KB 长串 >20s（子进程被硬杀）。
        // 桥事件循环被占住时心跳会被误判断线（本文件多处注释记录过该级联）。
        // 这里加**墙钟预算**：超时即中止并如实回「正则过慢」，而不是把桥拖死。
        var _reDeadline = Date.now() + PAGE_SEARCH_BUDGET_MS;
        while ((m = re.exec(text)) !== null) {
            // 零宽命中需手动前进，否则死循环
            if (typeof m[0] === 'string' && m[0].length === 0) re.lastIndex++;
            if (total >= skipHits && hits.length < PAGE_SEARCH_MAX_HITS) {
                var s1 = Math.max(0, m.index - PAGE_SEARCH_CTX);
                var e1 = Math.min(text.length, m.index + (m[0] ? m[0].length : 0) + PAGE_SEARCH_CTX);
                hits.push({ offset: m.index, snippet: text.substring(s1, e1) });
            }
            total++;
            if (++guard > 200000) break;   // 防海量匹配拖死
            // 每 256 次查一次钟（Date.now 也有成本，别放进最内层每次循环）
            if ((guard & 255) === 0 && Date.now() > _reDeadline) {
                return { hits: hits, total: total, slowRegex: true };
            }
        }
        return { hits: hits, total: total };
    }
    var lowerText = text.toLowerCase();
    var lowerKw = keyword.toLowerCase();
    if (!lowerKw) return { hits: hits, total: 0 };
    var idx = lowerText.indexOf(lowerKw);
    while (idx !== -1) {
        if (total >= skipHits && hits.length < PAGE_SEARCH_MAX_HITS) {
            var s2 = Math.max(0, idx - PAGE_SEARCH_CTX);
            var e2 = Math.min(text.length, idx + Math.max(1, keyword.length) + PAGE_SEARCH_CTX);
            hits.push({ offset: idx, snippet: text.substring(s2, e2) });
        }
        total++;
        idx = lowerText.indexOf(lowerKw, idx + Math.max(1, lowerKw.length));
    }
    return { hits: hits, total: total };
}

function handleFetchPage(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }

    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { jsonReply(res, 400, { ok: false, error: 'Invalid JSON' }); return; }
        // JSON.parse('null') 返回 null 不进 catch：不守卫则属性访问抛未捕获异常触发进程退出
        if (!params || typeof params !== 'object') { jsonReply(res, 400, { ok: false, error: 'Invalid JSON' }); return; }

        var targetUrl = params.url;
        if (!targetUrl || typeof targetUrl !== 'string') { jsonReply(res, 400, { ok: false, error: 'Missing url' }); return; }
        if (!/^https:\/\/.+/.test(targetUrl)) { jsonReply(res, 400, { ok: false, error: 'Only HTTPS URLs allowed' }); return; }
        if (targetUrl.length > 4096) { jsonReply(res, 400, { ok: false, error: 'URL too long' }); return; }
        if (/[\x00-\x1f\x7f]/.test(targetUrl)) { jsonReply(res, 400, { ok: false, error: 'URL contains control characters' }); return; }

        var parsed;
        try { parsed = url.parse(targetUrl); } catch (_) { jsonReply(res, 400, { ok: false, error: 'Invalid URL' }); return; }
        var hostname = (parsed.hostname || '').toLowerCase();
        if (!hostname) { jsonReply(res, 400, { ok: false, error: 'Invalid hostname' }); return; }
        if (parsed.auth) { jsonReply(res, 400, { ok: false, error: 'URL with credentials not allowed' }); return; }
        if (_isPrivateHost(hostname)) { jsonReply(res, 403, { ok: false, error: 'Internal/private URLs not allowed' }); return; }

        // 命中缓存直接用提取结果（含空正文页：短期内容不变，避免反爬页反复完整抓取）
        var cached = _getFetchPageCache(targetUrl);
        if (cached) { replyWithSlice(cached); return; }

        _doHttpsDownload(targetUrl, 0, function (err, content) {
            if (err) {
                jsonReply(res, 502, { ok: false, error: err });
                return;
            }
            var html = content.toString('utf8');
            var page = _extractPageText(html, 80 * 1024);
            _setFetchPageCache(targetUrl, page.title, page.text);
            replyWithSlice(page);
        }, FETCH_PAGE_TIMEOUT_MS);

        function replyWithSlice(page) {
            if (!page.text) {
                jsonReply(res, 200, { ok: true, title: page.title, text: '', note: '页面无可提取正文（可能为脚本渲染或反爬页）' });
                return;
            }
            // 长正文分页：以字符偏移切片。limit 钳制到 [500, 16000]，默认 8000。
            var total = page.text.length;
            // 关键词/正则检索（与读文件的 search 同语义）：大小写不敏感；/pattern/flags
            // 走正则；每页最多 20 条命中，命中带字符偏移 + 前后文片段，用 searchOffset 翻页。
            // 在缓存正文上检索，不重新下载——长文"先搜定位、再按 offset 读那一段"比一页页翻便宜得多。
            if (params.search && typeof params.search === 'string') {
                var so = Math.max(0, Number(params.searchOffset) || 0);
                var sres = _searchPageText(page.text, params.search, so);
                // 危险形状入口即拒：灾难性回溯全在**单次 exec 内部**，
                // 逐次查钟拦不住（面板侧实测：加了查钟仍卡 2830ms），只能编译前识别并拒绝。
                if (sres.catastrophic) {
                    jsonReply(res, 200, {
                        ok: false,
                        error: '该正则含嵌套量词（形如 (a+)+ / (a*)*），可能触发灾难性回溯并独占桥事件循环，已拒绝执行。'
                            + '请改写为等价但不嵌套的形式，或改用普通关键词搜索: ' + params.search
                    });
                    return;
                }
                if (sres.invalid) {
                    jsonReply(res, 200, {
                        ok: false,
                        error: '正则表达式无效: ' + params.search + '。可用普通关键词（大小写不敏感），或以 /pattern/ 形式如 /关键词\\d+/i'
                    });
                    return;
                }
                jsonReply(res, 200, {
                    ok: true, title: page.title, total: total,
                    search: params.search, searchOffset: so,
                    hits: sres.hits.length, matchTotal: sres.total, matches: sres.hits,
                    // 时间预算闸中止过扫描时 matchTotal 只是**下界**——这里把
                    // `slowRegex` 静默丢掉了（面板侧会标注、桥侧不会），
                    // 模型会把截断后的 total 当成精确命中数。
                    matchTotalIsLowerBound: sres.slowRegex === true ? true : undefined,
                    slowRegex: sres.slowRegex === true ? true : undefined,
                    note: sres.slowRegex === true
                        ? '正则过慢已中止扫描（超过 ' + PAGE_SEARCH_BUDGET_MS + 'ms），matchTotal 为下界；请改用更具体的词或更简单的正则'
                        : undefined
                });
                return;
            }
            var offset = Math.max(0, Number(params.offset) || 0);
            var limit = Math.min(16000, Math.max(500, Number(params.limit) || 8000));
            var slice = page.text.slice(offset, offset + limit);
            var hasMore = (offset + slice.length) < total;
            var note;
            if (hasMore) {
                note = '正文共 ' + total + ' 字符，本次返回第 ' + offset + '~' + (offset + slice.length) + ' 字符；可用 offset=' + (offset + limit) + ' 继续读取';
            } else if (offset >= total && total > 0) {
                // offset 超范围：明确告知，避免 LLM 误判为页面无内容
                note = 'offset=' + offset + ' 已超出正文总长度 ' + total + '，正文已全部读取完毕';
            } else {
                note = '';
            }
            jsonReply(res, 200, { ok: true, title: page.title, text: slice, total: total, offset: offset, hasMore: hasMore, note: note });
        }
    });
}

// ========== Skill 在线目录（anthropics/skills，GitHub 优先 + jsdelivr 回退） ==========
// 归一化官方 anthropics/skills 的 skills/ 目录，返回可直接下载的裸 SKILL.md 链接。
//
// 上游能力拆成两个独立环节，各自带回退：
// 1) 目录列表：GitHub Contents API 优先；失败时回退 jsdelivr data API（flat 文件清单，
//    境内可达性通常更好）
// 2) SKILL.md 正文：raw.githubusercontent.com 优先，cdn.jsdelivr.net 逐 skill 跨 CDN 回退；
//    install_url 指向实际下载成功的 CDN，保证 skill_manager install source=url 一步可达
//    （两个 CDN 均失败的 skill 不返回——既无描述也无可用链接，返回只会误导 LLM）

var SKILL_STORE_CACHE = { at: 0, skills: null, source: '' };
var SKILL_STORE_TTL_MS = 30 * 60 * 1000; // 30 分钟缓存，避免每次拉全表
var SKILL_STORE_REQ_TIMEOUT_MS = 8000;    // 单请求短超时：小文件足够，且目录+下载+回退链路可控
var SKILL_STORE_INFLIGHT = null;          // catalog 拉取进行中的回调队列（并发去重）
// 审计：in-flight 队列的全局 wall-clock 上限。socket 超时是不活动超时，滴流响应
// 可无限重置；目录列表 + 逐 SKILL.md × 双 CDN 的最坏链路也远超客户端等待。超时后
// 队列按失败结算并清空，后续调用不再被毒化的 in-flight 永久挂起（可重新发起）。
var SKILL_STORE_INFLIGHT_DEADLINE_MS = 60 * 1000;

// 目录列表源：依次尝试，取第一个成功者
var SKILL_DIR_LISTERS = [
    {
        name: 'github',
        list: function (callback) {
            // GitHub Contents API：列 skills/ 下的 dir 类型条目
            _doHttpsDownload('https://api.github.com/repos/anthropics/skills/contents/skills?ref=main', 0, function (err, content) {
                if (err) { callback(err, null); return; }
                var arr;
                try { arr = JSON.parse(content); } catch (_) { callback('目录解析失败', null); return; }
                if (!Array.isArray(arr)) { callback('目录格式异常', null); return; }
                var names = [];
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i] && arr[i].type === 'dir' && arr[i].name && /^[a-z0-9][a-z0-9-]*$/.test(arr[i].name)) {
                        names.push(arr[i].name);
                    }
                }
                callback(null, names);
            }, SKILL_STORE_REQ_TIMEOUT_MS);
        }
    },
    {
        name: 'jsdelivr',
        list: function (callback) {
            // jsdelivr data API（flat 文件清单）：从 /skills/<name>/SKILL.md 提取目录名
            _doHttpsDownload('https://data.jsdelivr.com/v1/package/gh/anthropics/skills@main/flat', 0, function (err, content) {
                if (err) { callback(err, null); return; }
                var data;
                try { data = JSON.parse(content); } catch (_) { callback('目录解析失败', null); return; }
                var files = data && data.files;
                if (!Array.isArray(files)) { callback('目录格式异常', null); return; }
                var names = [];
                var seen = {};
                for (var i = 0; i < files.length; i++) {
                    var m = String(files[i].name || '').match(/^\/skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/);
                    if (m && !seen[m[1]]) { seen[m[1]] = true; names.push(m[1]); }
                }
                callback(null, names);
            }, SKILL_STORE_REQ_TIMEOUT_MS);
        }
    }
];

// SKILL.md 正文 CDN：raw.githubusercontent 优先，jsdelivr 回退
var SKILL_RAW_BASES = [
    'https://raw.githubusercontent.com/anthropics/skills/main/skills',
    'https://cdn.jsdelivr.net/gh/anthropics/skills@main/skills'
];

// 解析 SKILL.md frontmatter 的 name / description / license，返回轻量元数据
function _parseSkillFrontmatter(md, fallbackName) {
    var name = fallbackName || '';
    var description = '';
    var license = '';
    var m = String(md || '').match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n/);
    if (m) {
        var fm = m[1];
        var lines = fm.split(/\r?\n/);
        var curKey = '';
        var curVal = '';
        function commit() {
            if (!curKey) return;
            var v = curVal.replace(/\s+/g, ' ').replace(/['"]/g, '').trim();
            if (curKey === 'name' && !name) name = v;
            else if (curKey === 'description' && !description) description = v;
            else if (curKey === 'license' && !license) license = v;
            curKey = ''; curVal = '';
        }
        for (var i = 0; i < lines.length; i++) {
            var ln = lines[i];
            var km = ln.match(/^([A-Za-z][A-Za-z0-9-]*):\s?(.*)$/);
            if (km && !/^\s/.test(ln)) { commit(); curKey = km[1].toLowerCase(); curVal = km[2] || ''; }
            else if (/^\s+/.test(ln)) curVal += ' ' + ln.trim();
        }
        commit();
    }
    return { name: name, description: description, license: license };
}

// 抓取单个 SKILL.md：依次尝试各 CDN，返回 [实际成功的 base, 正文]；全失败返回 [null, null]
function _fetchSkillMd(name, callback) {
    var idx = 0;
    function tryNext() {
        if (idx >= SKILL_RAW_BASES.length) { callback(null, null); return; }
        var base = SKILL_RAW_BASES[idx];
        _doHttpsDownload(base + '/' + name + '/SKILL.md', 0, function (err, md) {
            if (!err && md) { callback(base, md); return; }
            idx++;
            tryNext();
        }, SKILL_STORE_REQ_TIMEOUT_MS);
    }
    tryNext();
}

// 依次尝试各目录列表源，取第一个成功者
function _listSkillDirs(callback) {
    var idx = 0;
    function tryNext() {
        if (idx >= SKILL_DIR_LISTERS.length) {
            callback('目录列表获取失败（GitHub 与 jsdelivr 均不可用）', null, '');
            return;
        }
        var src = SKILL_DIR_LISTERS[idx];
        src.list(function (err, names) {
            if (err || !names || !names.length) { idx++; tryNext(); return; }
            callback(null, names, src.name);
        });
    }
    tryNext();
}

// 拉取并归一化整个 catalog。
// TTL 内直接命中缓存；拉取进行中复用同一 in-flight 请求，避免 TTL 过期瞬间的并发请求重复拉全表。
// 结果按目录原始顺序填充（异步完成序不稳定），全 CDN 失败的 skill 剔除。
function _fetchSkillCatalog(callback) {
    if (SKILL_STORE_CACHE.skills && (Date.now() - SKILL_STORE_CACHE.at) < SKILL_STORE_TTL_MS) {
        callback(null, SKILL_STORE_CACHE.skills, SKILL_STORE_CACHE.source + '（缓存）');
        return;
    }
    if (SKILL_STORE_INFLIGHT) { SKILL_STORE_INFLIGHT.push(callback); return; }
    var queue = [callback];
    SKILL_STORE_INFLIGHT = queue;
    var deadlineTimer = null;
    function done(err, skills, source) {
        // 只允许「当前队列」结算：deadline 已清空并放行新一轮后，旧拉取的迟到完成
        // 不得清掉新队列/把结果送给新调用方（按队列身份判等，而非可复用的全局槽）
        if (SKILL_STORE_INFLIGHT !== queue) return;
        if (deadlineTimer !== null) { try { clearTimeout(deadlineTimer); } catch (_) {} deadlineTimer = null; }
        SKILL_STORE_INFLIGHT = null;
        for (var i = 0; i < queue.length; i++) queue[i](err, skills, source);
    }
    if (typeof setTimeout === 'function') {
        deadlineTimer = setTimeout(function () {
            deadlineTimer = null;
            done('Skill 目录拉取超时（' + Math.round(SKILL_STORE_INFLIGHT_DEADLINE_MS / 1000) + 's 未完成，已放弃本次拉取，请重试）', null, '');
        }, SKILL_STORE_INFLIGHT_DEADLINE_MS);
        if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    }

    _listSkillDirs(function (listErr, names, listSource) {
        if (listErr || !names || !names.length) {
            done(listErr || '目录列表获取失败（GitHub 与 jsdelivr 均不可用）', null, '');
            return;
        }
        var slots = new Array(names.length);
        var remaining = names.length;
        for (var i = 0; i < names.length; i++) {
            (function (nm, slot) {
                _fetchSkillMd(nm, function (usedBase, md) {
                    if (usedBase && md) {
                        var meta = _parseSkillFrontmatter(md, nm);
                        slots[slot] = {
                            name: meta.name || nm,
                            description: meta.description,
                            license: meta.license || '',
                            url: usedBase + '/' + nm + '/SKILL.md'
                        };
                    } else {
                        slots[slot] = null;
                    }
                    remaining--;
                    if (remaining === 0) {
                        var out = [];
                        for (var k = 0; k < slots.length; k++) {
                            if (slots[k]) out.push(slots[k]);
                        }
                        // 全部 SKILL.md 下载失败视为整体失败，不缓存空目录：
                        // 瞬时网络故障不该让后续 30 分钟查询都返回"无匹配 Skill"
                        if (!out.length) {
                            done('SKILL.md 下载全部失败（raw.githubusercontent 与 jsdelivr 均不可用）', null, '');
                            return;
                        }
                        // deadline 已作废旧队列（身份判等失败）时，
                        // 迟到完成不得写 30 分钟 TTL 缓存——done 会丢弃，但缓存写入若
                        // 发生在 done 之前，旧目录会被后续查询命中。
                        if (SKILL_STORE_INFLIGHT !== queue) return;
                        _cacheSkillStore(out, listSource);
                        done(null, out, listSource);
                    }
                });
            })(names[i], i);
        }
    });
}

function _cacheSkillStore(skills, source) {
    SKILL_STORE_CACHE.at = Date.now();
    SKILL_STORE_CACHE.skills = skills;
    SKILL_STORE_CACHE.source = source;
}

// 关键词过滤：匹配 name/description。
function _filterSkills(skills, query) {
    if (!query) return skills;
    var q = query.toLowerCase();
    var terms = q.split(/\s+/).filter(function (t) { return t; });
    return skills.filter(function (s) {
        var hay = ((s.name || '') + ' ' + (s.description || '')).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
}

function _fmtSkillList(skills) {
    if (!skills || !skills.length) return '（无匹配 Skill，可尝试更宽泛的关键词）';
    var lines = ['官方 anthropics/skills 目录，共 ' + skills.length + ' 项（可直接用 skill_manager install source=url 安装）：'];
    for (var i = 0; i < skills.length; i++) {
        var s = skills[i];
        lines.push('- [' + s.name + '] ' + (s.description || '(无描述)')
            + (s.license ? ' | license: ' + s.license : '')
            + '\n  install_url: ' + s.url);
    }
    return lines.join('\n');
}

function handleSkillStore(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }
    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { params = {}; }
        // JSON.parse('null') 返回 null 不进 catch：归一为 {} 防止属性访问抛未捕获异常
        if (!params || typeof params !== 'object') params = {};
        var query = String(params.query || '').trim();
        var limit = Math.min(20, Math.max(1, Number(params.limit) || 10));
        var offset = Math.max(0, Number(params.offset) || 0);

        _fetchSkillCatalog(function (err, skills, source) {
            if (err) {
                jsonReply(res, 502, { ok: false, error: err });
                return;
            }
            var filtered = _filterSkills(skills, query);
            var total = filtered.length;
            var slice = filtered.slice(offset, offset + limit);
            var hasMore = (offset + slice.length) < total;
            var text = _fmtSkillList(slice);
            var note = '来源: ' + source;
            if (total > (offset + slice.length)) note += '；还有 ' + (total - offset - slice.length) + ' 项未显示，可用 offset=' + (offset + limit) + ' 翻页';
            // offset 超范围：明确告知，避免 LLM 在 total>0 时误读"无匹配"而换关键词重试
            if (!slice.length && total > 0 && offset > 0) {
                note += '；offset=' + offset + ' 已超出过滤结果总数 ' + total + '（该 query 下已无更多条目）';
            }
            jsonReply(res, 200, { ok: true, text: text, note: note, source: source, total: total, offset: offset, hasMore: hasMore });
        });
    });
}

// ========== ComfyUI 官方模板库（Comfy-Org/workflow_templates，MIT License） ==========

// comfyui LLM 路径的官方模板源。
// 与 skill-store 同构：bridge 侧拉取 + 30 分钟缓存 + 双 CDN 回退 + in-flight 去重。
// 分工：bridge 只做「索引搜索（服务端过滤）+ 模板正文代理」；官方模板为 UI 保存
// 格式，UI→API 转换在客户端完成（需 /object_info 解析 widget 顺序）。
// 安全：模板正文按 name 白名单代理——name 必须命中缓存索引的条目名（索引拉不
// 下来就拒绝 fetch），既防路径穿越，也保证 LLM 无法借参数指定任意 URL（无 SSRF 面，
// URL 全部由固定 BASES 拼接）。

var COMFY_TPL_CACHE = { at: 0, index: null, source: '' };
var COMFY_TPL_TTL_MS = 30 * 60 * 1000;    // 30 分钟缓存（对齐 skill-store）
var COMFY_TPL_REQ_TIMEOUT_MS = 10000;     // 单请求超时：索引数百 KB，10s 足够
var COMFY_TPL_INFLIGHT = null;            // 索引拉取进行中的回调队列（并发去重）
// 审计：与 skill-store 同款 in-flight 全局 wall-clock 上限（四源回退 × 滴流响应
// 可把队列永久挂住）；超时按失败结算并清空，磁盘缓存兜底后仍无则报错，后续调用可重发。
var COMFY_TPL_INFLIGHT_DEADLINE_MS = 60 * 1000;

// 索引源：中文版优先（LLM 对话语言为中文，title/description 更贴合），英文版兜底；
// 每版均配 jsdelivr CDN 回退（境内可达性）
var COMFY_TPL_INDEX_BASES = [
    'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.zh.json',
    'https://cdn.jsdelivr.net/gh/Comfy-Org/workflow_templates@main/templates/index.zh.json',
    'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/index.json',
    'https://cdn.jsdelivr.net/gh/Comfy-Org/workflow_templates@main/templates/index.json'
];
var COMFY_TPL_RAW_BASES = [
    'https://raw.githubusercontent.com/Comfy-Org/workflow_templates/main/templates/',
    'https://cdn.jsdelivr.net/gh/Comfy-Org/workflow_templates@main/templates/'
];

// 落盘缓存（离线/重启免重拉）：索引与模板正文 write-through 到数据目录
// （<dataDir>/temp/bridge/comfy-tpl/），CDN 全部失败时回落磁盘；_dataDir 未同步
// 或 fs 不可用（vm 切片测试环境）时静默跳过，行为与纯内存版一致。
// 磁盘不做 TTL 剔除——只在 CDN 不可达时兜底，网络恢复后内存 TTL 过期自然回源。
function _comfyTplCacheDir() {
    if (typeof fs === 'undefined' || typeof path === 'undefined' || !_dataDir) return null;
    return path.join(_dataDir, 'temp', 'bridge', 'comfy-tpl');
}
function _writeComfyTplCache(file, content) {
    var dir = _comfyTplCacheDir();
    if (!dir) return;
    try {
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, file), content);
    } catch (_) {}
}
function _readComfyTplCache(file) {
    var dir = _comfyTplCacheDir();
    if (!dir) return null;
    try { return fs.readFileSync(path.join(dir, file), 'utf8'); } catch (_) { return null; }
}

// 归一化 index 条目为轻量搜索项（LLM 上下文友好：只留决策所需字段）。
// needsImage 从 io.inputs 推导（有 image 类输入的模板需要用户给图）。
// groupType 为所属分组的 type（video/image/…，来自分组层，非模板自身字段）。
function _normalizeComfyTplEntry(e, groupType) {
    if (!e || typeof e !== 'object' || !e.name) return null;
    var needsImage = false;
    try {
        var ins = e.io && e.io.inputs;
        if (Array.isArray(ins)) {
            for (var i = 0; i < ins.length; i++) {
                var mt = (ins[i] && (ins[i].mediaType || ins[i].type)) || '';
                if (/image/i.test(mt)) { needsImage = true; break; }
            }
        }
    } catch (_) { /* io 缺失/畸形不影响搜索 */ }
    var tags = Array.isArray(e.tags) ? e.tags.slice(0, 12) : [];
    return {
        name: String(e.name),
        title: String(e.title || e.name),
        description: String(e.description || ''),
        tags: tags,
        type: String(groupType || ''),
        openSource: !!e.openSource,
        needsImage: needsImage,
        date: String(e.date || '')
    };
}

// 展平官方索引：真实结构（index.json / index.zh.json 实测）顶层为
// 9 个分类分组 [{moduleName, type, category, title, templates: [条目…]}]，模板
// 嵌套在 .templates[] 内；兼容顶层直接平铺条目数组的形态（防御上游结构变化）。
function _flattenComfyTplIndex(raw) {
    var out = [];
    if (!Array.isArray(raw)) return out;
    for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (!item || typeof item !== 'object') continue;
        if (Array.isArray(item.templates)) {
            for (var t = 0; t < item.templates.length; t++) {
                var norm = _normalizeComfyTplEntry(item.templates[t], item.type);
                if (norm) out.push(norm);
            }
        } else {
            // 平铺形态兜底（无 templates 字段且自身是模板条目）
            var flat = _normalizeComfyTplEntry(item);
            if (flat) out.push(flat);
        }
    }
    return out;
}

// 拉取官方模板索引（TTL 缓存 + in-flight 去重；全部 CDN 失败不缓存空表）
function _fetchComfyTplIndex(callback) {
    if (COMFY_TPL_CACHE.index && (Date.now() - COMFY_TPL_CACHE.at) < COMFY_TPL_TTL_MS) {
        callback(null, COMFY_TPL_CACHE.index, COMFY_TPL_CACHE.source + '（缓存）');
        return;
    }
    if (COMFY_TPL_INFLIGHT) { COMFY_TPL_INFLIGHT.push(callback); return; }
    var queue = [callback];
    COMFY_TPL_INFLIGHT = queue;
    var deadlineTimer = null;
    function done(err, index, source) {
        // 只允许「当前队列」结算（见 skill-store 同款注释）：deadline 清空并放行
        // 新一轮后，旧拉取的迟到完成不得清掉新队列
        if (COMFY_TPL_INFLIGHT !== queue) return;
        if (deadlineTimer !== null) { try { clearTimeout(deadlineTimer); } catch (_) {} deadlineTimer = null; }
        COMFY_TPL_INFLIGHT = null;
        for (var i = 0; i < queue.length; i++) queue[i](err, index, source);
    }
    // CDN 全败/超时共用的收口：先回落磁盘缓存（离线/重启兜底；无缓存才真正失败）
    function failFromDiskOr(errMsg) {
        // 旧队列已被 deadline 作废（身份判等失败）时直接丢弃——
        // 磁盘兜底数据也不得写回内存缓存污染新一轮的 30 分钟 TTL。
        if (COMFY_TPL_INFLIGHT !== queue) return;
        var cached = _readComfyTplCache('index.json');
        if (cached) {
            try {
                var c = JSON.parse(cached);
                if (c && Array.isArray(c.index) && c.index.length) {
                    COMFY_TPL_CACHE.at = Date.now();
                    COMFY_TPL_CACHE.index = c.index;
                    COMFY_TPL_CACHE.source = (c.source || 'Comfy-Org/workflow_templates@main') + '（磁盘缓存）';
                    done(null, c.index, COMFY_TPL_CACHE.source);
                    return;
                }
            } catch (_) {}
        }
        done(errMsg, null, '');
    }
    if (typeof setTimeout === 'function') {
        deadlineTimer = setTimeout(function () {
            deadlineTimer = null;
            failFromDiskOr('模板索引拉取超时（' + Math.round(COMFY_TPL_INFLIGHT_DEADLINE_MS / 1000) + 's 未完成，已放弃本次拉取，请重试）');
        }, COMFY_TPL_INFLIGHT_DEADLINE_MS);
        if (deadlineTimer && typeof deadlineTimer.unref === 'function') deadlineTimer.unref();
    }
    var idx = 0;
    function tryNext() {
        if (idx >= COMFY_TPL_INDEX_BASES.length) {
            failFromDiskOr('模板索引获取失败（GitHub 与 jsdelivr 均不可用）');
            return;
        }
        var base = COMFY_TPL_INDEX_BASES[idx];
        idx++;
        _doHttpsDownload(base, 0, function (err, content) {
            if (err || !content) { tryNext(); return; }
            var raw;
            try { raw = JSON.parse(content); } catch (_) { tryNext(); return; }
            if (!Array.isArray(raw) || !raw.length) { tryNext(); return; }
            var out = _flattenComfyTplIndex(raw);
            if (!out.length) { tryNext(); return; }
            // 队列身份校验通过后才写内存/磁盘缓存。旧拉取链的
            // 迟到完成（deadline 已清空并放行新一轮）会先写缓存再被 done 丢弃，
            // 把旧索引写进 30 分钟 TTL；现校验不通过直接丢弃（不写缓存、不 tryNext）。
            if (COMFY_TPL_INFLIGHT !== queue) return;
            COMFY_TPL_CACHE.at = Date.now();
            COMFY_TPL_CACHE.index = out;
            COMFY_TPL_CACHE.source = 'Comfy-Org/workflow_templates@main ' + (base.indexOf('.zh.json') >= 0 ? 'index.zh' : 'index');
            _writeComfyTplCache('index.json', JSON.stringify({ at: COMFY_TPL_CACHE.at, source: COMFY_TPL_CACHE.source, index: out }));
            done(null, out, COMFY_TPL_CACHE.source);
        }, COMFY_TPL_REQ_TIMEOUT_MS);
    }
    tryNext();
}

// 搜索过滤：query 词全部命中（name/title/description/tags 拼串，小写匹配）；
// category 优先匹配分组 type（video/image/…），并兼容 tags 子串（如 api/upscale）
function _filterComfyTpls(entries, query, category) {
    var list = entries;
    if (category) {
        var cat = String(category).toLowerCase();
        list = list.filter(function (e) {
            if (e.type && e.type.toLowerCase() === cat) return true;
            return (e.tags || []).some(function (t) { return String(t).toLowerCase().indexOf(cat) >= 0; });
        });
    }
    if (!query) return list;
    var terms = String(query).toLowerCase().split(/\s+/).filter(function (t) { return t; });
    return list.filter(function (e) {
        var hay = (e.name + ' ' + e.title + ' ' + e.description + ' ' + (e.tags || []).join(' ')).toLowerCase();
        return terms.every(function (t) { return hay.indexOf(t) >= 0; });
    });
}

function _fmtComfyTplList(entries, total, offset) {
    if (!entries || !entries.length) return '（无匹配模板，可尝试更宽泛的关键词，如 flux / 文生图 / 图生视频 / upscale）';
    var lines = ['官方模板库匹配 ' + total + ' 项，当前显示第 ' + (offset + 1) + '~' + (offset + entries.length) + ' 项（name 用于 comfyui_run_official_template 执行）：'];
    for (var i = 0; i < entries.length; i++) {
        var e = entries[i];
        var meta = [];
        if (e.type) meta.push(e.type);
        if (e.needsImage) meta.push('需要输入图片');
        if (!e.openSource) meta.push('云端/API 模板（消耗额度）');
        if (e.date) meta.push(e.date);
        lines.push('- [' + e.name + '] ' + e.title
            + (meta.length ? '（' + meta.join('，') + '）' : '')
            + (e.description ? '：' + e.description : '')
            + (e.tags && e.tags.length ? ' | 标签: ' + e.tags.join(', ') : ''));
    }
    return lines.join('\n');
}

// 代理单模板 JSON：name 必须命中索引（白名单校验），双 CDN 依次回退
function _fetchComfyTplByName(name, callback) {
    _fetchComfyTplIndex(function (err, index) {
        if (err || !index) { callback('模板索引不可用: ' + (err || 'empty'), null, ''); return; }
        var hit = null;
        for (var i = 0; i < index.length; i++) {
            if (index[i].name === name) { hit = index[i]; break; }
        }
        // 白名单：name 不在索引内一律拒绝（同时天然拦截 ../ 路径穿越与 .app.json 变体）
        if (!hit) { callback('模板不存在: ' + name + '（必须先用搜索确认 name）', null, ''); return; }
        var bi = 0;
        // 正文解析失败的保留错误：坏内容（企业代理/插页 200 返回 HTML 等）不阻塞下一 CDN，
        // 双 CDN 全败时用它报出具体原因（与索引路径 :2887 的 tryNext 口径一致）
        var lastParseErr = null;
        function tryNext() {
            if (bi >= COMFY_TPL_RAW_BASES.length) {
                // 双 CDN 全败：回落磁盘缓存（离线/重启兜底）
                var cached = _readComfyTplCache(name + '.json');
                if (cached) {
                    try {
                        callback(null, JSON.parse(cached), hit, '磁盘缓存');
                        return;
                    } catch (_) {}
                }
                callback(lastParseErr || '模板下载失败（raw.githubusercontent 与 jsdelivr 均不可用）', null, '');
                return;
            }
            var base = COMFY_TPL_RAW_BASES[bi];
            bi++;
            _doHttpsDownload(base + encodeURIComponent(name) + '.json', 0, function (dlErr, content) {
                if (dlErr || !content) { tryNext(); return; }
                var parsed;
                try { parsed = JSON.parse(content); } catch (_) {
                    // 解析失败回落下一 CDN（对齐索引路径）：raw 被代理/插页污染返回 200
                    // 非 JSON 时，jsdelivr 明明可用也不该直接判死；全败才用此错误收口。
                    lastParseErr = '模板 JSON 解析失败: ' + name;
                    tryNext();
                    return;
                }
                _writeComfyTplCache(name + '.json', content);
                callback(null, parsed, hit, base);
            }, COMFY_TPL_REQ_TIMEOUT_MS);
        }
        tryNext();
    });
}

function handleComfyTemplates(req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }
    if (req.method !== 'POST') {
        jsonReply(res, 405, { ok: false, error: 'Method not allowed' });
        return;
    }
    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { params = {}; }
        if (!params || typeof params !== 'object') params = {};
        var action = String(params.action || 'search');

        if (action === 'search') {
            var query = String(params.query || '').trim();
            var category = String(params.category || '').trim();
            var limit = Math.min(20, Math.max(1, Number(params.limit) || 10));
            var offset = Math.max(0, Number(params.offset) || 0);
            _fetchComfyTplIndex(function (err, index, source) {
                if (err) {
                    jsonReply(res, 502, { ok: false, error: err });
                    return;
                }
                var filtered = _filterComfyTpls(index, query, category);
                var total = filtered.length;
                var slice = filtered.slice(offset, offset + limit);
                var hasMore = (offset + slice.length) < total;
                var text = _fmtComfyTplList(slice, total, offset);
                var note = '来源: ' + source;
                if (hasMore) note += '；还有 ' + (total - offset - slice.length) + ' 项未显示，可用 offset=' + (offset + limit) + ' 翻页';
                if (!slice.length && total > 0 && offset > 0) {
                    note += '；offset=' + offset + ' 已超出过滤结果总数 ' + total + '（该 query 下已无更多条目）';
                }
                // entries：结构化条目（表单 modal 直消费，免解析 text——text 面向 LLM，
                // 正则重解析格式化文本是脆弱契约，标题含（）等字符即截断）
                jsonReply(res, 200, { ok: true, text: text, note: note, source: source, total: total, offset: offset, hasMore: hasMore, entries: slice });
            });
            return;
        }

        if (action === 'fetch') {
            var name = String(params.name || '').trim();
            if (!name || name !== encodeURIComponent(name)) {
                // 二次防线：索引白名单已是主闸门，这里先拦掉明显畸形输入（含 / \ .. 等）
                jsonReply(res, 400, { ok: false, error: '非法模板名' });
                return;
            }
            _fetchComfyTplByName(name, function (err, template, meta, base) {
                if (err) {
                    jsonReply(res, 404, { ok: false, error: err });
                    return;
                }
                jsonReply(res, 200, {
                    ok: true,
                    template: template,
                    meta: {
                        name: meta.name,
                        title: meta.title,
                        description: meta.description,
                        tags: meta.tags,
                        openSource: meta.openSource,
                        needsImage: meta.needsImage
                    },
                    source: base
                });
            });
            return;
        }

        jsonReply(res, 400, { ok: false, error: '未知 action: ' + action + '（支持 search / fetch）' });
    });
}

// ========== WebSocket 扩展系统 ==========

var wsMessageHandlers = [];
var _extMcpInfoProvider = null;   // EXT-MCP 诊断信息提供者（ae-bridge.js 注册 relay 统计）
var _extMcpHttpHandler = null;    // EXT-MCP Streamable HTTP /mcp 端点（ae-bridge.js 注册）

function addWsHandler(fn) {
    wsMessageHandlers.push(fn);
}

// 注册 ext-mcp 诊断信息回调（/health 返回 extMcp 字段）
function setExtMcpInfoProvider(fn) {
    if (typeof fn === 'function') _extMcpInfoProvider = fn;
}

// 注册 ext-mcp Streamable HTTP 端点处理器（POST /mcp JSON-RPC）
function setExtMcpHttpHandler(fn) {
    if (typeof fn === 'function') _extMcpHttpHandler = fn;
}

function handleWebSocketMessage(socket, msg) {
    var parsed;
    try {
        parsed = JSON.parse(msg.toString());
    } catch (e) {
        sendFrame(socket, Buffer.from(JSON.stringify({ type: 'error', message: 'Invalid JSON' })));
        return;
    }
    // /ext-ws 协议面强制隔离：ext 连接只放行
    // ext_* 消息族（relay 路由），spawn/send/stop 等 MCP 控制消息一律拒——
    // 原「外部进程不发这些 type，天然隔离」是君子协定，/ext-ws 免 token 后
    // 必须强制（否则本机恶意进程经 /ext-ws 发 spawn 帧重开 RCE 面）
    if (socket.__asExtWs && (typeof parsed.type !== 'string' || parsed.type.indexOf('ext_') !== 0)) {
        log('WS ext-path rejected non-ext message type: ' + (parsed.type || '?'));
        sendFrame(socket, Buffer.from(JSON.stringify({
            type: 'error',
            message: 'ext-ws path only accepts ext_* messages (got: ' + (parsed.type || '?') + ')'
        })));
        return;
    }
    for (var i = 0; i < wsMessageHandlers.length; i++) {
        try {
            var handled = wsMessageHandlers[i](parsed, socket, sendFrame);
            if (handled) return;
        } catch (e) {
            logErr('WS handler error: ' + (e && e.stack || e));
        }
    }
    sendFrame(socket, Buffer.from(JSON.stringify({ type: 'error', message: 'Unknown message type: ' + (parsed.type || '?') })));
}

// ========== ffmpeg 转码(mov -> webm vp9 alpha) ==========

// 在 PATH 和常见路径中找 ffmpeg（不同用户安装位置不同,不硬编码）
// vendor 那份受 .gitattributes 的 LFS 管辖（`vendor/ffmpeg/*.exe`）。
// GitHub「Download ZIP」/ 未装 git-lfs 的 clone 得到的是 **133 字节指针**——只看 `existsSync`
// 会让优先级 0 的它**遮住** PATH 上真正可用的系统 ffmpeg，转码固定回「缺编码器」（与 host 侧
// node 的同款失败链）。判据与 install.bat / host.jsx 同口径：**<1MB 视为 LFS 指针**。
var _LFS_POINTER_MAX = 1024 * 1024;
function _isUsableBinary(p) {
    try {
        var fs = require('fs');
        return fs.existsSync(p) && fs.statSync(p).size > _LFS_POINTER_MAX;
    } catch (_) { return false; }
}
function _findFfmpeg() {
    var fs = require('fs');
    // 0. 内置 vendor ffmpeg（最优先，免用户装）——但必须是**真二进制**，不是 LFS 指针
    try {
        var vendorFfmpeg = require('path').resolve(__dirname, '../../vendor/ffmpeg/ffmpeg.exe');
        if (_isUsableBinary(vendorFfmpeg)) return vendorFfmpeg;
    } catch (_) {}
    // 1. PATH 中找
    var paths = (process.env.PATH || '').split(';');
    for (var i = 0; i < paths.length; i++) {
        var dir = paths[i].replace(/^"|"$/g, '');
        try { if (fs.existsSync(dir + '/ffmpeg.exe')) return dir + '/ffmpeg.exe'; } catch (_) {}
        try { if (fs.existsSync(dir + '/ffmpeg')) return dir + '/ffmpeg'; } catch (_) {}
    }
    // 2. 常见包管理器安装位置
    var home = process.env.USERPROFILE || process.env.HOME || '';
    if (home) {
        try { if (fs.existsSync(home + '/scoop/shims/ffmpeg.exe')) return home + '/scoop/shims/ffmpeg.exe'; } catch (_) {}
    }
    // chocolatey
    try { if (fs.existsSync('C:/ProgramData/chocolatey/bin/ffmpeg.exe')) return 'C:/ProgramData/chocolatey/bin/ffmpeg.exe'; } catch (_) {}
    // winget / 手动解压常见位置
    try { if (fs.existsSync('C:/ffmpeg/bin/ffmpeg.exe')) return 'C:/ffmpeg/bin/ffmpeg.exe'; } catch (_) {}
    return null;
}

// 快速检查 ffmpeg 编码器是否可用（异步 spawn + 5s 超时，不阻塞事件循环；
// spawn 失败/超时回全 false——与原 spawnSync 异常回退语义一致，由调用方走"缺编码器"500）
function _checkFfmpegCodec(ffmpegExe, cb) {
    _spawnAsync(ffmpegExe, ['-encoders'], { timeout: 5000 }, function (result) {
        var out = String(result.stdout || '');
        cb({
            hasVP9: out.indexOf('libvpx-vp9') !== -1,
            hasVP8: out.indexOf('libvpx') !== -1,
            hasX264: out.indexOf('libx264') !== -1,
            hasOpus: out.indexOf('libopus') !== -1
        });
    });
}

// 从 ffmpeg 路径推导 ffprobe 路径（同目录，后缀替换）
// 同款 LFS 判据：ffprobe.exe 也受 .gitattributes 管辖，指针会让时长/像素格式探测恒失败（静默回默认值）。
function _findFfprobe(ffmpegExe) {
    if (!ffmpegExe) return null;
    var fs = require('fs');
    var dir = require('path').dirname(ffmpegExe);
    try { if (_isUsableBinary(dir + '/ffprobe.exe')) return dir + '/ffprobe.exe'; } catch (_) {}
    try { if (_isUsableBinary(dir + '/ffprobe')) return dir + '/ffprobe'; } catch (_) {}
    return null;
}

// ffprobe 取媒体时长（秒）；ffprobe 不存在/spawn 失败/超时回 0
// （异步 spawn + 10s 超时，原 spawnSync 阻塞事件循环）
function _probeDuration(ffmpegExe, input, cb) {
    var ffprobeExe = _findFfprobe(ffmpegExe);
    if (!ffprobeExe) { cb(0); return; }
    _spawnAsync(ffprobeExe, [
        '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', input
    ], { timeout: 10000 }, function (result) {
        cb(parseFloat(String(result.stdout || '')) || 0);
    });
}

// ffprobe 取视频轨像素格式（如 yuv420p / yuva420p）；取不到回空串。
// 用途：源无 alpha 通道时不必按 alpha 编 VP9——yuva420p 比 yuv420p 慢得多也大得多，
// 而本路由无条件用 alpha（为素材库的带 alpha mov 而设）时，普通 mp4 预览白付代价。
function _probePixFmt(ffmpegExe, input, cb) {
    var ffprobeExe = _findFfprobe(ffmpegExe);
    if (!ffprobeExe) { cb(''); return; }
    _spawnAsync(ffprobeExe, [
        '-v', 'error', '-select_streams', 'v:0',
        '-show_entries', 'stream=pix_fmt',
        '-of', 'default=noprint_wrappers=1:nokey=1', input
    ], { timeout: 10000 }, function (result) {
        cb(String(result.stdout || '').trim().split('\n')[0] || '');
    });
}

// 像素格式是否带 alpha 通道（决定 VP9 能否走非 alpha 快路径）。
// 覆盖实际会遇到的名字：yuva*/ya*（带 alpha 的 yuv）、rgba/bgra/argb/abgr、gbrap。
// 注意 pal8 里的 'a' 不是 alpha，故按模式匹配而非"含字母 a"。
function _pixFmtHasAlpha(pixFmt) {
    return /yuva|^ya\d|rgba|bgra|argb|abgr|gbrap/i.test(String(pixFmt || ''));
}

// 转码任务注册表：taskId → { status, progress, output, error, proc }
var _transcodeTasks = {};
var _transcodeTaskSeq = 0;
// 转码进程级看门狗：客户端 5 分钟本地超时只 reject 本地 Promise、不取消本进程；
// ffmpeg 挂死（坏输入/网络盘 I/O 卡死等）时 close 永不触发 → 任务恒 running →
// _hasRunningTranscode() 让 idle 退出循环永不退出（bridge 常驻不空闲）。15 分钟档位
// 远高于客户端 5 分钟超时与 VP9 提速后的正常耗时（本机 1080p→640p 约 36s），
// 只兜真正挂死的进程；对齐抽帧路径 _spawnAsync(..., {timeout:30000}) 的 kill 语义。
var TRANSCODE_TIMEOUT_MS = 15 * 60 * 1000;

// POST /api/ffmpeg-transcode — 启动异步转码，立即返回 taskId
// body 是 JSON 参数（正常很小），上限对齐 readBody 的 40MB 口径（MAX_READBODY_SIZE）：
// 自行 `body += chunk` 无上限累加时，CORS '*' 暴露下恶意网页 no-cors POST 大 body
// 会打爆 bridge 内存。该手动累加还有正确性缺陷——Buffer 隐式 toString 把多字节
// UTF-8 字符跨 TCP chunk 边界截断成 U+FFFD（中文路径 parse 失败/静默损坏），故整体
// 改用 readBody（Buffer.concat 后一次 toString('utf8')，超限空串回调 → 400 同口径）。
function handleFfmpegTranscode(req, res) {
    if (req.method !== 'POST') { jsonReply(res, 405, { error: 'POST required' }); return; }
    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { jsonReply(res, 400, { error: 'invalid JSON' }); return; }
        // JSON.parse('null') 返回 null 不进 catch：不守卫则属性访问抛未捕获异常触发进程退出
        if (!params || typeof params !== 'object') { jsonReply(res, 400, { error: 'invalid JSON' }); return; }
        var input = params.input || '';
        var output = params.output || '';
        if (!input || !output) { jsonReply(res, 400, { error: 'input/output required' }); return; }
        if (!safePath(input)) { jsonReply(res, 403, { error: 'input path rejected' }); return; }
        if (!safePath(output) || !safeForDelete(output)) { jsonReply(res, 403, { error: 'output path rejected' }); return; }
        if (!minDepthOk(output, 2)) { jsonReply(res, 403, { error: 'output depth' }); return; }
        var resolvedInput = resolveRealSafe(input, false);
        var resolvedOutput = resolveRealSafe(output, true);
        if (!resolvedInput || !resolvedOutput) { jsonReply(res, 403, { error: 'symlink rejected' }); return; }
        // input 是读语义：补敏感路径检查（与 /fs/read 同口径），防转码通道读出凭据/密钥
        if (_isSensitivePath(resolvedInput)) { jsonReply(res, 403, { error: 'sensitive path denied' }); return; }

        var cp = require('child_process');
        var ffmpegExe = _findFfmpeg();
        if (!ffmpegExe) {
            jsonReply(res, 500, {
                error: 'ffmpeg 未安装',
                detail: '请用以下任一方式安装:\n  winget install ffmpeg\n  scoop install ffmpeg\n  choco install ffmpeg\n  或从 https://ffmpeg.org/download.html 下载后加入 PATH'
            });
            return;
        }

        // 0. 确保输出目录存在
        try {
            var _path = require('path');
            var outDir = _path.dirname(resolvedOutput);
            require('fs').mkdirSync(outDir, { recursive: true });
        } catch (_) {}

        // 1. ffprobe 获取时长（用于进度计算）—— 异步（原 spawnSync 阻塞事件循环，
        //    探测期间 /health 心跳与其余端点排队）
        _probeDuration(ffmpegExe, resolvedInput, function (duration) {

            // 2. 检测可用编码器，按优先级选：VP9+alpha > VP9 > VP8 > H.264（异步）
            _checkFfmpegCodec(ffmpegExe, function (codecs) {
              // 2b. 探源像素格式：只有明确探到"无 alpha"才降为非 alpha 编码。
              //     探不到（无 ffprobe/超时）保守维持 alpha——不让素材库的带 alpha mov
              //     静默掉透明度；普通 mp4 探到 yuv420p 则走快路径。
              _probePixFmt(ffmpegExe, resolvedInput, function (pixFmt) {
                var dropAlpha = !!pixFmt && !_pixFmtHasAlpha(pixFmt);
                var encArgs;  // 编码器相关参数数组
                if (codecs.hasVP9) {
                    encArgs = ['-c:v', 'libvpx-vp9', '-pix_fmt', dropAlpha ? 'yuv420p' : 'yuva420p',
                        '-b:v', '0', '-crf', '30', '-auto-alt-ref', '0',
                        // 预览级转码的耗时闸门：VP9 默认参数在本机实测为 2 分钟级（60 秒
                        // 1080p→640p），长视频会撞客户端 5 分钟超时；row-mt（多线程行）+
                        // cpu-used 4 提到约 3 倍速（同片 36s）。cpu-used 换的是压缩率，
                        // 预览场景可接受（产物约 15MB/分钟）。
                        '-row-mt', '1', '-cpu-used', '4'];
                } else if (codecs.hasVP8) {
                    encArgs = ['-c:v', 'libvpx', '-pix_fmt', 'yuv420p', '-b:v', '1M', '-crf', '10'];
                } else if (codecs.hasX264) {
                    encArgs = ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '23', '-preset', 'fast'];
                } else {
                    jsonReply(res, 500, {
                        error: 'ffmpeg 缺少可用编码器',
                        detail: '当前 ffmpeg 未编译 libvpx/libx264。请重新安装完整版:\n  winget install ffmpeg\n  scoop install ffmpeg'
                    });
                    return;
                }

                // 3. 启动异步转码
                var taskId = String(++_transcodeTaskSeq);
                var task = { status: 'running', progress: 0, output: resolvedOutput, duration: duration, proc: null };
                _transcodeTasks[taskId] = task;

                // 输出先写临时名，ffmpeg exit 0 后原子 rename 到最终名。
                // 客户端 5 分钟超时只是本地 reject、不取消本进程，用户重试会再起一个
                // ffmpeg——两个 ffmpeg -y 同写最终名时，交错输出被客户端 hash 缓存
                // 永久命中坏文件。临时名带 taskId（每次尝试唯一），双写天然隔离到各自
                // 临时文件；最终名只在完整产物 rename 后存在，客户端 exists(最终名)
                // 命中即为完整文件（也修复了转码进行中重试被当缓存命中半截文件的问题）。
                // 临时名形如 <名>.<taskId>.part.<ext>：容器扩展名必须留在**最后**——ffmpeg
                // 按输出扩展名选 muxer，以 .part 结尾时判定不出容器，直接
                // "Error opening output file: Invalid argument"（实测 .webm.1.part 必失败、
                // .webm 正常；素材库的 mov 兜底转码因此从未产出过文件）。
                var _extMatch = /^(.*)(\.[^.\/\\]+)$/.exec(resolvedOutput);
                var partPath = _extMatch
                    ? _extMatch[1] + '.' + taskId + '.part' + _extMatch[2]
                    : resolvedOutput + '.' + taskId + '.part';

                // 根据 maxWidth 构建 scale filter，maxWidth=0 则保持原分辨率
                var maxW = parseInt(String(params.maxWidth || '0'), 10) || 0;
                var vfArgs = maxW > 0 ? ['-vf', 'scale=' + maxW + ':-2:force_original_aspect_ratio=decrease'] : [];
                // 保留音轨：转码产物是给人看的预览，静音会让"怎么点都没声"无法解释
                // （固定 -an 时，源明明是 aac 却产出无音轨文件）。webm 容器选 Opus，
                // -ac 2 兜住多声道源（Opus 对 >5.1 布局会直接报错，降混比让整单转码失败划算）；
                // 源本就无音轨时这些参数被忽略（实测 exit 0，不报错）。
                // 无 libopus 编码器的极端构建退回 -an（有画面优先）。
                var audioArgs = codecs.hasOpus
                    ? ['-c:a', 'libopus', '-b:a', '96k', '-ac', '2']
                    : ['-an'];
                var args = ['-y', '-i', resolvedInput].concat(encArgs).concat(vfArgs).concat(audioArgs).concat([partPath]);
                var proc = cp.spawn(ffmpegExe, args, { windowsHide: true }); // 转码期间不闪黑框
                task.proc = proc;
                var stderr = '';

                // 进程级看门狗（见 TRANSCODE_TIMEOUT_MS 注释）：超时 kill + 按 task error
                // 结算，客户端下一次轮询即拿到 error 文案；任务状态离开 running 后 idle
                // 退出循环恢复可退出。ffmpeg 无子进程，直接 kill 即可（Windows 下
                // child.kill() 走 TerminateProcess，无需进程树处理）。
                var watchdog = setTimeout(function () {
                    if (task.status !== 'running') return;
                    task.status = 'error';
                    task.error = 'ffmpeg 转码超时（' + Math.round(TRANSCODE_TIMEOUT_MS / 60000) + ' 分钟），已终止进程';
                    logErr('[ffmpeg-transcode] task ' + taskId + ' 超时 ' + TRANSCODE_TIMEOUT_MS + 'ms，kill ffmpeg');
                    try { proc.kill(); } catch (_) {}
                    // 失败残留的半截 .part 清掉（best-effort，与 close 失败路径同口径）
                    try { require('fs').unlinkSync(partPath); } catch (_) {}
                    setTimeout(function () { delete _transcodeTasks[taskId]; }, 300000);
                }, TRANSCODE_TIMEOUT_MS);

                proc.stderr.on('data', function (chunk) {
                    stderr += String(chunk);
                    // 解析 time=HH:MM:SS.MS 计算进度
                    if (duration > 0) {
                        var m = stderr.match(/time=(\d+):(\d+):(\d+)\.(\d+)/g);
                        if (m) {
                            var last = m[m.length - 1];
                            var p = last.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
                            var secs = parseInt(p[1], 10) * 3600 + parseInt(p[2], 10) * 60 + parseInt(p[3], 10) + parseInt(p[4], 10) / 100;
                            task.progress = Math.min(99, Math.round(secs / duration * 100));
                        }
                    } else {
                        // 无 duration 时用模糊进度（0→90%，靠 close 事件设 100%）
                        task.progress = Math.min(90, task.progress + 1);
                    }
                });

                proc.on('close', function (code) {
                    task.proc = null;
                    clearTimeout(watchdog);
                    // 看门狗已按超时结算（kill 后 close 迟到）：不覆盖 error 文案、不重复清理
                    if (task.status !== 'running') return;
                    if (code === 0) {
                        // 完整产物落地：同目录原子 rename（Windows 同卷 MoveFileEx 语义）。
                        // rename 失败（如 .part 被清缓存删走）按转码失败结算，不留半截最终名。
                        try {
                            require('fs').renameSync(partPath, resolvedOutput);
                            task.status = 'done';
                            task.progress = 100;
                        } catch (e) {
                            task.status = 'error';
                            task.error = 'rename part 失败: ' + ((e && e.message) || e);
                            try { require('fs').unlinkSync(partPath); } catch (_) {}
                        }
                    } else {
                        task.status = 'error';
                        task.error = 'ffmpeg exit ' + code + ': ' + stderr.substring(stderr.length > 500 ? stderr.length - 500 : 0);
                        // 失败残留的半截 .part 清掉（best-effort），避免堆积
                        try { require('fs').unlinkSync(partPath); } catch (_) {}
                    }
                    // 5 分钟后清理
                    setTimeout(function () { delete _transcodeTasks[taskId]; }, 300000);
                });

                proc.on('error', function (e) {
                    task.proc = null;
                    clearTimeout(watchdog);
                    if (task.status !== 'running') return;
                    task.status = 'error';
                    task.error = 'spawn ffmpeg failed: ' + e.message;
                    // 与 close / 看门狗分支同口径延时清理任务表——
                    // error 分支不排清理时错误态条目永久驻留（_transcodeTasks 缓慢泄漏）。
                    setTimeout(function () { delete _transcodeTasks[taskId]; }, 300000);
                });

                jsonReply(res, 200, { ok: true, taskId: taskId });
              });
            });
        });
    });
}

// POST /api/ffmpeg-frame — 抽一帧存成 JPEG（素材库视频格子的封面）
//
// 为什么要有这条路由：CEF 88 解不出画面的源（本机素材库的 mjpeg mov、HEVC）在面板侧
// 根本拿不到一帧像素（canvas 抽帧只能解 h264/mp4 一类），封面只能由 ffmpeg 出。
//
// 取帧位置：默认 25% 处，不是第 0 帧——本机实测两个素材包的第一帧
// 分别是「纯黑」和「一个小点」，当封面等于给格子换成黑块，比 emoji 更没信息；
// 25% 处两包都已出主体（glitch 出故障画面、冲击波出环状爆发）。ffprobe 拿不到时长
// （无 ffprobe/探测失败）时退回第 0 帧。
//
// 同步返回（不建任务表、不要 taskId）：单帧抽完即回，没有进度可报；安全校验链与
// /api/ffmpeg-transcode 逐条一致（input 是读语义 + 敏感路径检查，output 是删语义 + 深度）。
var _frameSeq = 0;
function handleFfmpegFrame(req, res) {
    if (req.method !== 'POST') { jsonReply(res, 405, { error: 'POST required' }); return; }
    readBody(req, function (body) {
        var params;
        try { params = JSON.parse(body); } catch (_) { jsonReply(res, 400, { error: 'invalid JSON' }); return; }
        if (!params || typeof params !== 'object') { jsonReply(res, 400, { error: 'invalid JSON' }); return; }
        var input = params.input || '';
        var output = params.output || '';
        if (!input || !output) { jsonReply(res, 400, { error: 'input/output required' }); return; }
        if (!safePath(input)) { jsonReply(res, 403, { error: 'input path rejected' }); return; }
        if (!safePath(output) || !safeForDelete(output)) { jsonReply(res, 403, { error: 'output path rejected' }); return; }
        if (!minDepthOk(output, 2)) { jsonReply(res, 403, { error: 'output depth' }); return; }
        var resolvedInput = resolveRealSafe(input, false);
        var resolvedOutput = resolveRealSafe(output, true);
        if (!resolvedInput || !resolvedOutput) { jsonReply(res, 403, { error: 'symlink rejected' }); return; }
        if (_isSensitivePath(resolvedInput)) { jsonReply(res, 403, { error: 'sensitive path denied' }); return; }

        var ffmpegExe = _findFfmpeg();
        if (!ffmpegExe) {
            jsonReply(res, 500, {
                error: 'ffmpeg 未安装',
                detail: '请用以下任一方式安装:\n  winget install ffmpeg\n  scoop install ffmpeg\n  choco install ffmpeg\n  或从 https://ffmpeg.org/download.html 下载后加入 PATH'
            });
            return;
        }
        try { require('fs').mkdirSync(require('path').dirname(resolvedOutput), { recursive: true }); } catch (_) {}

        // 临时名 <名>.<pid>_<seq>.part.<ext>：扩展名必须留在最后（ffmpeg 按扩展名选
        // muxer/编码器，见 /api/ffmpeg-transcode 的记录）；pid+序号防并发抽帧互踩。
        var _extMatch = /^(.*)(\.[^.\/\\]+)$/.exec(resolvedOutput);
        var _partTag = process.pid + '_' + (++_frameSeq);
        var partPath = _extMatch
            ? _extMatch[1] + '.' + _partTag + '.part' + _extMatch[2]
            : resolvedOutput + '.' + _partTag + '.part';

        var maxW = parseInt(String(params.maxWidth || '0'), 10) || 0;
        var vfArgs = maxW > 0 ? ['-vf', 'scale=' + maxW + ':-2:force_original_aspect_ratio=decrease'] : [];

        function _run(at) {
            // -update 1：单张图写到固定文件名（image2 muxer 默认要求 %d 序列模式，
            // 不带它会打一行警告；-frames:v 1 + -update 1 是官方给的单图写法）
            var args = ['-y'];
            if (at > 0) args = args.concat(['-ss', String(at)]);
            args = args.concat(['-i', resolvedInput, '-frames:v', '1', '-an', '-sn', '-update', '1'])
                .concat(vfArgs).concat(['-q:v', '4', partPath]);
            _spawnAsync(ffmpegExe, args, { timeout: 30000, windowsHide: true, cap: 256 * 1024 }, function (r) {
                var fs = require('fs');
                if (r.error || r.timeout || r.status !== 0) {
                    try { fs.unlinkSync(partPath); } catch (_) {}
                    var msg = r.error ? ('spawn ffmpeg failed: ' + ((r.error && r.error.message) || r.error))
                        : (r.timeout ? 'ffmpeg 抽帧超时(30s)' : ('ffmpeg exit ' + r.status + ': ' + String(r.stderr || '').slice(-500)));
                    jsonReply(res, 500, { ok: false, error: msg });
                    return;
                }
                // exit 0 也可能没有产物（如 -ss 落在时长之外："Output file is empty"），
                // 按失败结算——客户端据此保持图标态，不会把空文件当封面
                var size = 0;
                try { size = fs.statSync(partPath).size; } catch (_) {}
                if (!size) {
                    try { fs.unlinkSync(partPath); } catch (_) {}
                    jsonReply(res, 500, { ok: false, error: 'ffmpeg 未产出帧（seek 位置可能超出时长）' });
                    return;
                }
                try {
                    fs.renameSync(partPath, resolvedOutput);
                } catch (e) {
                    try { fs.unlinkSync(partPath); } catch (_) {}
                    jsonReply(res, 500, { ok: false, error: 'rename part 失败: ' + ((e && e.message) || e) });
                    return;
                }
                jsonReply(res, 200, { ok: true, output: resolvedOutput, at: at });
            });
        }

        // 显式给了 at（秒）就用它；否则按 25% 处取（见函数头），探不到时长退回第 0 帧
        if (typeof params.at === 'number' && params.at >= 0) { _run(params.at); return; }
        _probeDuration(ffmpegExe, resolvedInput, function (duration) {
            _run(duration > 0 ? Math.round(duration * 0.25 * 100) / 100 : 0);
        });
    });
}

// POST /api/clipboard-image — 读系统剪贴板（免 Ctrl+V 的原生通道）。
// 供 CEP 面板「粘贴按钮」使用：CEF file:// 上下文 navigator.clipboard.read() 被安全策略拒绝，
// 面板只能退化为 execCommand('paste') + 等用户手动 Ctrl+V，体验差。这里由 Node 起 PowerShell
//（-Sta：WinForms Clipboard API 要求 STA 线程）直接读 Windows 剪贴板：
//   ① Clipboard.GetImage()        → PNG base64（截图/画图/浏览器复制的位图）
//   ② Clipboard.GetFileDropList() → 文件路径数组（Explorer 复制的文件，视频只能走这条）
// 返回：{ ok, kind:'image', base64, mime } / { ok, kind:'files', files[] } / { ok:false, error }
//   error 'empty' = 剪贴板无图片/文件（面板据此直接报错，不再等 Ctrl+V）
// 编码：路径可能含中文，先 UTF8→base64 传输再解码，避开控制台 GBK 输出乱码。
// 安全：无入参（不拼用户数据进脚本），仅读本机当前用户剪贴板；大截图 base64 可超 1MB，
// 原 spawnSync maxBuffer 默认 1MB 会 ENOBUFS，故放宽到 64MB（现为异步 spawn 的 stdout 累计上限 cap）。
// 原 spawnSync 阻塞事件循环（上限 15s），期间 /health 心跳误判断线；异步化后请求
// 挂起等 PowerShell 退出再回复，事件循环照常服务。
function handleClipboardImage(req, res) {
    if (req.method !== 'POST') { jsonReply(res, 405, { ok: false, error: 'POST required' }); return; }
    if (process.platform !== 'win32') {
        jsonReply(res, 200, { ok: false, error: 'unsupported_platform' });
        return;
    }
    // 无参数，但读掉请求体保持 keep-alive 连接语义（与其他 POST 端点一致）
    readBody(req, function () {
        var script =
            "$ErrorActionPreference='Stop';" +
            "try {" +
            "  Add-Type -AssemblyName System.Windows.Forms,System.Drawing;" +
            "  $img = [System.Windows.Forms.Clipboard]::GetImage();" +
            "  if ($null -ne $img) {" +
            "    $ms = New-Object System.IO.MemoryStream;" +
            "    $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png);" +
            "    $b64 = [Convert]::ToBase64String($ms.ToArray());" +
            "    $ms.Dispose(); $img.Dispose();" +
            "    [Console]::Out.Write('IMG:' + $b64);" +
            "    exit 0" +
            "  }" +
            "  $fd = [System.Windows.Forms.Clipboard]::GetFileDropList();" +
            "  if ($null -ne $fd -and $fd.Count -gt 0) {" +
            "    $list = @(); foreach ($f in $fd) { $list += $f }" +
            "    $txt = [string]::Join([char]10, $list);" +
            "    [Console]::Out.Write('FILES:' + [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($txt)));" +
            "    exit 0" +
            "  }" +
            "  exit 3" +
            "} catch {" +
            "  [Console]::Err.Write($_.Exception.Message);" +
            "  exit 1" +
            "}";
        // powershell.exe 优先走 PATH；宿主进程 PATH 缺 PowerShell 目录时回退 SystemRoot 全路径
        var psExe = 'powershell.exe';
        try {
            var fullPs = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
            if (fs.existsSync(fullPs)) psExe = fullPs;
        } catch (_) {}
        _spawnAsync(
            psExe,
            ['-NoProfile', '-NonInteractive', '-Sta', '-Command', script],
            { timeout: 15000, windowsHide: true, cap: 64 * 1024 * 1024 },
            function (result) {
                var out = String(result.stdout || '').trim();
                if (result.status === 0 && out.indexOf('IMG:') === 0) {
                    jsonReply(res, 200, { ok: true, kind: 'image', base64: out.substring(4), mime: 'image/png' });
                    return;
                }
                if (result.status === 0 && out.indexOf('FILES:') === 0) {
                    var files = [];
                    try {
                        var txt = Buffer.from(out.substring(6), 'base64').toString('utf8');
                        files = txt.split('\n').filter(function (s) { return s && s.trim().length > 0; });
                    } catch (_) {}
                    if (files.length) {
                        jsonReply(res, 200, { ok: true, kind: 'files', files: files });
                        return;
                    }
                    jsonReply(res, 200, { ok: false, error: 'empty' });
                    return;
                }
                if (result.status === 3) {
                    jsonReply(res, 200, { ok: false, error: 'empty' });
                    return;
                }
                var stderr = String(result.stderr || '').trim();
                jsonReply(res, 200, {
                    ok: false,
                    error: 'ps_failed',
                    detail: ('exit ' + result.status +
                        (result.error ? ' ' + (result.error.message || result.error) : '') +
                        (result.timeout ? ' (timed out after 15000ms)' : '') +
                        ': ' + stderr).substring(0, 300)
                });
            }
        );
    });
}

// POST /api/reveal-path — 在 OS 文件管理器中定位路径（聊天区本地路径点击的唯一落点）。
// 入参 { path }：文件 → 打开所在目录并选中；目录 → 直接打开。
//
// 为什么放在 Bridge 而不是 ExtendScript：CEP 面板没有 shell API；`Folder.execute()` 只能
// 打开目录、无法选中文件；`system.callSystem` 需要把路径拼进命令行（路径来自聊天文本/LLM，
// 是注入面，且项目在脚本侧禁用系统调用）。这里用 spawn 数组参数、不经 shell——路径里的
// 引号/&/|/% 都不会被解释，选中的是「传入的那一个路径」。
// 安全边界：只做展示（不读写文件）；/api/* 前缀已由 token 鉴权覆盖（_pathNeedsAuth），
// 另拒相对路径、控制字符与不存在的路径。旧版 Bridge 无此路由时面板回退 ExtendScript
// （只能打开目录），见 shared/revealPath.js。
function handleRevealPath(req, res) {
    if (req.method !== 'POST') { jsonReply(res, 405, { error: 'POST required' }); return; }
    readBody(req, function (body) {
        var params = null;
        try { params = JSON.parse(body); } catch (_) { params = null; }
        if (!params || typeof params !== 'object') { jsonReply(res, 400, { error: 'invalid JSON' }); return; }
        var p = params.path;
        if (typeof p !== 'string' || !p) { jsonReply(res, 400, { error: 'path required' }); return; }
        if (p.length > 8192) { jsonReply(res, 400, { error: 'path too long' }); return; }
        // 控制字符：Windows 文件名不可能包含；NUL 还会截断 spawn 参数
        if (/[\u0000-\u001f]/.test(p)) { jsonReply(res, 400, { error: 'invalid path' }); return; }
        if (!path.isAbsolute(p)) { jsonReply(res, 400, { error: 'absolute path required' }); return; }
        // 存在性用**异步** stat：UNC/已断开的网络盘上 statSync 会把 Bridge 事件循环同步卡住
        //（心跳、面板保活、其它请求全部停摆）。异步 stat 跑在线程池里；另加 3s 回复超时——
        // 迟到的 stat 结果直接丢弃，不让一次不可达的 UNC 路径拖住请求。
        var replied = false;
        var timer = null;
        function reply(code, obj) {
            if (replied) return;
            replied = true;
            if (timer) { clearTimeout(timer); timer = null; }
            jsonReply(res, code, obj);
        }
        timer = setTimeout(function () {
            reply(504, { ok: false, error: 'stat_timeout' });
        }, 3000);
        fs.stat(p, function (err, st) {
            if (replied) return;
            if (err || !st) { reply(404, { ok: false, error: 'not_found' }); return; }
            var isDir = st.isDirectory();
            // explorer/open/xdg-open 的退出码不代表定位结果（explorer 成功也常返回 1），
            // 只把 spawn 失败（r.error）判为失败；超时也按「已下发」返回（进程可能已起窗口）。
            function done(r) {
                if (r && r.error) { reply(500, { ok: false, error: 'spawn_failed' }); return; }
                reply(200, { ok: true, mode: isDir ? 'open' : 'select' });
            }
            if (process.platform === 'win32') {
                // explorer 的 /select 语法：路径紧跟逗号并加引号（含空格时必须）。
                // windowsVerbatimArguments 让 Node 不再二次加引号，命令行与
                // `explorer.exe /select,"C:\a b\c.png"` 逐字一致（与 exec 版相同，但不过 shell）。
                var winArg = isDir ? ('"' + p + '"') : ('/select,"' + p + '"');
                // 不传 windowsHide：explorer 是 GUI 进程，开关只影响控制台窗口，但避免
                // 新窗口首帧继承隐藏态；它没有控制台，不会闪黑框。
                _spawnAsync('explorer.exe', [winArg],
                    { windowsVerbatimArguments: true, timeout: 8000 }, done);
                return;
            }
            if (process.platform === 'darwin') {
                _spawnAsync('open', isDir ? [p] : ['-R', p], { timeout: 8000 }, done);
                return;
            }
            // 其他平台：xdg-open 只能定位到目录（多数文件管理器不支持“选中”）
            _spawnAsync('xdg-open', [isDir ? p : path.dirname(p)], { timeout: 8000 }, done);
        });
    });
}

// GET /api/ffmpeg-progress?taskId=xxx — 查询转码进度
function handleFfmpegProgress(req, res) {
    if (req.method !== 'GET') { jsonReply(res, 405, { error: 'GET required' }); return; }
    var query = url.parse(req.url, true).query;
    var taskId = (query.taskId || '').toString();
    var task = _transcodeTasks[taskId];
    if (!task) { jsonReply(res, 404, { error: 'task not found' }); return; }
    jsonReply(res, 200, {
        ok: true,
        status: task.status,
        progress: task.progress,
        output: task.status === 'done' ? task.output : undefined,
        error: task.error
    });
}

// POST /api/set-data-dir - CEP 面板同步数据目录到 Bridge
// Bridge 启动时从 APPDATA 计算默认路径，CEP 面板就绪后用此端点同步用户自定义路径。
// 安全校验：safePath(格式) + _isSafeDataDir(系统目录黑名单 + 深度)，与 AEFS isDataDirSafe 对齐。
function handleSetDataDir(req, res) {
    if (req.method !== 'POST') { jsonReply(res, 405, { error: 'POST required' }); return; }
    readBody(req, function (body) {
        var dir = '';
        try { var parsed = JSON.parse(body); dir = parsed.dataDir || ''; } catch (e) {}
        if (dir && typeof dir === 'string') {
            dir = dir.replace(/\//g, '\\').replace(/\\+$/, '');
            // 数据根 UNC 白名单随同步更新：先登记候选再校验——
            // safePath 会把白名单外的 UNC 数据根拒成「非盘符绝对路径」。校验失败恢复
            // 旧 _dataDir 的登记（fail-closed：旧根也非 UNC 时清空）。
            _setAllowedUncRoot(dir);
            if (!_isSafeDataDir(dir)) {
                _setAllowedUncRoot(_dataDir);
                logErr('拒危险数据目录路径: ' + dir);
                jsonReply(res, 403, { ok: false, error: 'Dangerous path rejected' });
                return;
            }
            _dataDir = dir;
            _setAllowedUncRoot(_dataDir);   // 与 _dataDir 同步；盘符路径 → 清空白名单
            log('数据目录已更新: ' + _dataDir);
            // 数据根确定后做一次陈旧 .part 残留清扫（进程内每根一次；异步
            // 分片，不阻塞本响应）——bridge 新生进程的首次同步即覆盖「上次被硬杀
            // 留下的 .part」回收场景。
            try { _sweepStalePartOnce(_dataDir); } catch (_) {}
            jsonReply(res, 200, { ok: true, dataDir: _dataDir });
        } else {
            jsonReply(res, 400, { ok: false, error: 'dataDir required' });
        }
    });
}

// ========== HTTP 请求路由 ==========

// Origin 校验：拒绝来自外部网页的请求，仅放行本地 CEP 面板与非浏览器客户端。
// CEP 面板以 file:// 加载，XHR/WebSocket 的 Origin 实测为 "file://"（CEF Chrome 88 行为，经 CDP 9223 确认）。
// node/curl 等本地工具不带 Origin header。
// 拒 null origin：远程攻击者用 file:// HTML（双击打开）或 sandbox iframe 连 ws://127.0.0.1:9877，
//   现代浏览器发 Origin: null，放行 null 即等于放行远程 CSWSH → spawn RCE。CEP 面板发 file:// 不发 null，故拒 null 不影响功能。
function originOk(req) {
    var origin = req.headers['origin'];
    if (!origin) return true;                  // 非浏览器客户端（node/curl）—— 本地工具，放行
    if (origin.indexOf('file://') === 0) return true;  // CEP 面板（实测 Origin=file://）
    return false;                              // null / http(s) / 其他 —— 拒绝
}

// Host 头校验：防 DNS rebinding 的标准修复（对齐 Ollama CVE-2024-28224 官方方案）。
// rebinding 攻击下浏览器请求发往 attacker.com（DNS 二次解析到 127.0.0.1），此时 Host 头
// 携带 attacker.com 而非本机地址。Origin 校验已能拦截该路径，这里是纵深防御第二道闸门
// （若未来 Origin 逻辑回归，Host 仍兜底）。放行：本机地址（127.0.0.1/localhost/::1，
// 端口不校验——请求物理上已到达监听端口）；无 Host 头（HTTP/1.0 本地工具）放行。
function hostOk(req) {
    var host = req.headers['host'];
    if (!host) return true;                    // HTTP/1.0 或无 Host 的本地客户端
    host = String(host).toLowerCase();
    var idx = host.lastIndexOf(':');
    var hostname = (idx > 0) ? host.slice(0, idx) : host;
    if (hostname.charAt(0) === '[' && hostname.charAt(hostname.length - 1) === ']') {
        hostname = hostname.slice(1, -1);      // [::1]:9877 → ::1
    }
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

// ========== 桥接 token 鉴权 ==========
// 信任模型：AE 宿主（host.jsx）是唯一可信源——启动 bridge 时生成一次性随机 token，
// 经临时文件（路径经 argv 传递）交接给 bridge（读取后立即删除），面板经 evalScript
// 从 AE 进程内存获取同一 token。Origin 头对非浏览器客户端可任意伪造（curl -H
// "Origin: file://" 即过 originOk），originOk 只防浏览器侧 CSWSH/rebinding——
// token 才是本机进程级边界。
// 残余风险（文档化）：交接文件在 bridge 读取前存在极短窗口，同用户进程理论可竞读
// （路径随机命名缩短暴露面）；_authToken 为 null（手动开发启动 / 测试沙盒）时不鉴权。
var _authToken = null;

function setAuthToken(t) {
    _authToken = (t && typeof t === 'string') ? t.trim() : null;
}

// timing-safe 比较（sha256 归一长度后 crypto.timingSafeEqual，防逐字节时序侧信道）
function _tokenEquals(provided) {
    if (!_authToken || typeof provided !== 'string' || !provided) return false;
    try {
        var a = crypto.createHash('sha256').update(_authToken).digest();
        var b = crypto.createHash('sha256').update(provided).digest();
        return crypto.timingSafeEqual(a, b);
    } catch (_) {
        return false;
    }
}

// HTTP：Authorization: Bearer <token>
function authTokenOk(req) {
    var h = req && req.headers && req.headers['authorization'];
    if (typeof h !== 'string') return false;
    var m = /^Bearer\s+(.+)$/.exec(h.trim());
    return !!(m && _tokenEquals(m[1].trim()));
}

// WS（浏览器 WebSocket 不能设自定义头）：URL query ?token=<token>
function authWsTokenOk(req) {
    try {
        var q = url.parse(req.url, true).query;
        return !!(q && typeof q.token === 'string' && _tokenEquals(q.token));
    } catch (_) {
        return false;
    }
}

// 敏感路由：/fs/*（读写删全族——任意读/任意写/递归删）与 /api/*（图片读取/剪贴板/
// ffmpeg/数据目录变更等）。/health（存活探测，无敏感数据）与 /mcp（外接模式——外部
// MCP 客户端无 evalScript 通道获取 token；依赖外接模式显式开启 + extPolicy 分级门
// + 确认默认拒）不要求 token。
function _pathNeedsAuth(u) {
    if (!u || typeof u !== 'string') return false;
    var p = url.parse(u).pathname || '';
    return p.indexOf('/fs/') === 0 || p === '/fs' || p.indexOf('/api/') === 0 || p === '/api';
}

// 启动交接：--bridge-token-file=<path>（host.jsx 写入，读后即删）或
// AS_EXTP_BRIDGE_TOKEN 环境变量。argv 指定但交接失败/内容为空 → fail-closed：
// 启用随机不可知 token 拒绝所有请求（面板探测失败 → restartBridge 重新交接自愈）。
// 两者皆无（手动开发启动）→ _authToken 保持 null（旧行为）。
function _initTokenFromArgv() {
    for (var i = 0; i < process.argv.length; i++) {
        var a = process.argv[i];
        if (a.indexOf('--bridge-token-file=') === 0) {
            var f = a.slice('--bridge-token-file='.length);
            var handed = null;
            try {
                handed = fs.readFileSync(f, 'utf8');
            } catch (e) {
                // 读失败：交接文件不存在/不可读——fail-closed 锁死，等面板 restartBridge 自愈
                setAuthToken(crypto.randomBytes(32).toString('hex'));
                logErr('Bridge token handoff FAILED, bridge locked with random token; reason: '
                    + (e && e.message));
                return;
            }
            // 一次性交接文件即删（无论内容有效与否都要清理，防秘密残留）。删除失败
            //（AV 实时扫描短暂锁定新写文件等）时抹空内容防秘密残留——残留的 token
            // 文件可被同用户进程读取（文件名随机仅缩短暴露面）。真机排查：
            // 此类残留文件曾长期被误判为「bridge 启动失败」（实际 token 已消费、bridge 正常运行）。
            try { fs.unlinkSync(f); } catch (e2) {
                try { fs.writeFileSync(f, ''); } catch (_) {}
                logErr('Bridge token file delete failed (content wiped): ' + (e2 && e2.message));
            }
            // 读成功但 trim 后为空（空文件/纯空白）不得静默关闭
            // 鉴权——setAuthToken('') → _authToken=null → 全端点鉴权短路，
            // 注释宣称的 fail-closed 只覆盖了读失败。现与读失败同走随机 token fail-closed。
            if (!handed || !handed.trim()) {
                setAuthToken(crypto.randomBytes(32).toString('hex'));
                logErr('Bridge token handoff EMPTY, bridge locked with random token');
                return;
            }
            setAuthToken(handed);
            log('Bridge token auth enabled (handoff file consumed)');
            return;
        }
    }
    try {
        // env 显式提供（含空串）即按鉴权模式处理：空/纯空白同样 fail-closed 锁死；
        // 仅「无 argv 且无 env」的手动启动保持不鉴权（旧行为）。
        if (typeof process.env.AS_EXTP_BRIDGE_TOKEN === 'string') {
            setAuthToken(process.env.AS_EXTP_BRIDGE_TOKEN);
            if (!_authToken) {
                setAuthToken(crypto.randomBytes(32).toString('hex'));
                logErr('Bridge token env EMPTY/whitespace, bridge locked with random token');
                return;
            }
            log('Bridge token auth enabled (env)');
        }
    } catch (_) {}
}

function routeHttp(req, res) {
    // Host 头校验（DNS rebinding 防线，先于 preflight——rebinding 域名的预检也一并拒绝）
    if (!hostOk(req)) {
        jsonReply(res, 403, { error: 'Forbidden host' });
        return;
    }

    // Origin 校验：拒外部网页跨域调用。
    // L3 修复：移至 preflight 之前——原顺序 OPTIONS 先行直接 204，被 Origin 拒绝的
    // 域名也能拿到预检放行信号（纵深缺失）；现 host/origin 双闸先行，preflight 免
    // token（浏览器预检不带自定义头，token 校验对 preflight 无意义）
    if (!originOk(req)) {
        jsonReply(res, 403, { error: 'Forbidden origin' });
        return;
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
    }

    // H1 修复：敏感端点 token 鉴权（/fs/*、/api/*；例外见 _pathNeedsAuth 注释）
    if (_authToken && _pathNeedsAuth(req.url) && !authTokenOk(req)) {
        jsonReply(res, 401, { error: 'Unauthorized: bridge token required' });
        return;
    }

    // 合法 HTTP 请求（CEP 面板文件操作 / 心跳）重置 idle 退出计时。
    // 这样面板开着时（持续心跳 + 文件操作）bridge 常驻，面板关闭后 30s 才退出。
    _scheduleIdleExit();

    // Health check
    if (req.url === '/health') {
        // authRequired（H1 补强）：面板心跳据此区分「进程在线」与「鉴权可用」——
        // token 失配时 /health 仍 200（豁免），但 AEFS/WS 全族 401；不带此字段
        // 面板心跳无从察觉（真机故障：心跳显示在线、一切 IO 失败、
        // 断线阻断与 restartBridge 自愈链永不触发）
        var health = { ok: true, port: PORT, version: '1.0.0', uptime: process.uptime(), authRequired: !!_authToken };
        // EXT-MCP 诊断：外部客户端数 / 等待面板回包的 pending 数（ae-bridge.js 注册）
        if (typeof _extMcpInfoProvider === 'function') {
            try { health.extMcp = _extMcpInfoProvider() || null; } catch (_) {}
        }
        jsonReply(res, 200, health);
        return;
    }

    // EXT-MCP Streamable HTTP 端点：POST /mcp 单条 JSON-RPC。
    // Host/Origin 校验已在前置完成（非浏览器 MCP 客户端无 Origin 头放行）。
    if (url.parse(req.url).pathname === '/mcp') {
        if (typeof _extMcpHttpHandler !== 'function') {
            jsonReply(res, 503, { error: 'EXT-MCP HTTP endpoint not available (start via ae-bridge.js)' });
            return;
        }
        try {
            _extMcpHttpHandler(req, res);
        } catch (e) {
            logErr('ext-mcp http handler error: ' + (e && e.message));
            jsonReply(res, 500, { error: 'Internal error' });
        }
        return;
    }

    // File I/O: /fs/<method>（method 后可挂 query，如 write-blob?path=...、read-blob?path=...）
    var fsMatch = url.parse(req.url).pathname.match(/^\/fs\/(\w[\w\-]*)$/);
    if (fsMatch) {
        if (fsMatch[1] === 'write-blob') { handleWriteBlob(req, res); return; }
        if (fsMatch[1] === 'read-blob') { handleReadBlob(req, res); return; }
        if (fsMatch[1] === 'exists-batch') { handleFsExistsBatch(req, res); return; }
        if (FS_METHODS.indexOf(fsMatch[1]) >= 0) { handleFs(req, res, fsMatch[1]); return; }
    }

    // Image reader
    if (req.url === '/api/read-image') {
        handleReadImage(req, res);
        return;
    }

    // 鉴权健康探测（H1 补强）：/api/* 前缀 → token 门槛自动生效。面板心跳/就绪
    // 判定用 200/401 区分「token 有效」与「token 失配（进程活但全族 401）」；
    // 无鉴权模式（_authToken=null）恒 200。无副作用，只作回声。
    if (req.url === '/api/auth-probe') {
        jsonReply(res, 200, { ok: true, auth: !!_authToken });
        return;
    }

    // 文档/表格/PDF 解析（Agent 拖入文件 → 结构化文本注入 context）
    if (req.url === '/api/parse-doc') {
        handleParseDoc(req, res);
        return;
    }

    // 文档/表格/PDF 内容解析（不传磁盘路径，直接解析 base64 内容，CEP 拖拽 File 无路径时的兜底通道）
    if (req.url === '/api/parse-doc-bytes') {
        handleParseDocBytes(req, res);
        return;
    }

    // HTTPS proxy download (replaces certutil system.callSystem)
    if (req.url === '/api/download-url') {
        handleDownloadUrl(req, res);
        return;
    }

    // Web search proxy (Bing CN HTML, 供桌宠联网搜索用)
    if (req.url === '/api/web-search') {
        handleWebSearch(req, res);
        return;
    }

    // 网页正文抓取（LLM read_url 工具）
    if (req.url === '/api/fetch-page') {
        handleFetchPage(req, res);
        return;
    }

    // Skill 在线目录（LLM search_skill_store 工具）
    if (req.url === '/api/skill-store') {
        handleSkillStore(req, res);
        return;
    }

    // ComfyUI 官方模板库（LLM comfyui_search_official_templates / comfyui_run_official_template 工具）
    if (req.url === '/api/comfy-templates') {
        handleComfyTemplates(req, res);
        return;
    }

    if (req.url === '/api/ffmpeg-transcode') {
        handleFfmpegTranscode(req, res);
        return;
    }

    if (req.url === '/api/ffmpeg-frame') {
        handleFfmpegFrame(req, res);
        return;
    }

    if (req.url.indexOf('/api/ffmpeg-progress') === 0) {
        handleFfmpegProgress(req, res);
        return;
    }

    // 系统剪贴板读取（CEP 粘贴按钮原生通道，免 Ctrl+V）
    if (req.url === '/api/clipboard-image') {
        handleClipboardImage(req, res);
        return;
    }

    // 本地路径在 OS 文件管理器中定位（聊天区点击路径；文件=打开所在目录并选中）
    if (req.url === '/api/reveal-path') {
        handleRevealPath(req, res);
        return;
    }

    // CEP 面板同步数据目录（含用户自定义路径），Bridge 据此更新错误日志路径
    if (req.url === '/api/set-data-dir') {
        handleSetDataDir(req, res);
        return;
    }

    // 404
    jsonReply(res, 404, { error: 'Not found' });
}

// ========== 服务器创建 ==========

var server = http.createServer(routeHttp);

// ========== 空闲退出：无客户端 30s 后自动退出（优雅：先杀子进程 → 关服务器 → 退出） ==========

var _clientCount = 0;
var _idleExitTimer = null;
var IDLE_EXIT_MS = 30000;

// 退出前的清理钩子（供 ae-bridge 等模块注册子进程清理）
var _onBeforeExitHooks = [];

function registerBeforeExitHook(fn) {
    if (typeof fn === 'function') _onBeforeExitHooks.push(fn);
}

var _exiting = false;

function _doGracefulExit(code) {
    if (_exiting) return;
    _exiting = true;
    // 先执行所有清理钩子（杀 MCP 子进程等）
    for (var i = 0; i < _onBeforeExitHooks.length; i++) {
        try { _onBeforeExitHooks[i](); } catch (_) {}
    }
    _onBeforeExitHooks = [];
    // 关闭 HTTP 服务器（停止接受新连接）
    try { server.close(); } catch (_) {}
    // 给 server.close() 一小段回调时间，然后强制退出
    setTimeout(function () {
        process.exit(code || 0);
    }, 500);
}

function _hasRunningTranscode() {
    var ids = Object.keys(_transcodeTasks);
    for (var i = 0; i < ids.length; i++) {
        if (_transcodeTasks[ids[i]].status === 'running') return true;
    }
    return false;
}

function _scheduleIdleExit() {
    if (_idleExitTimer) clearTimeout(_idleExitTimer);
    if (_clientCount > 0) return;

    function tryExit() {
        if (_clientCount > 0) return;
        // 仍有转码任务在跑时挂起退出，等 ffmpeg 自行完成后才退出，避免中断转码或遗留孤儿
        if (_hasRunningTranscode()) {
            _idleExitTimer = setTimeout(tryExit, IDLE_EXIT_MS);
            return;
        }
        log('Idle timeout (' + (IDLE_EXIT_MS / 1000) + 's) - exiting');
        _doGracefulExit();
    }

    _idleExitTimer = setTimeout(tryExit, IDLE_EXIT_MS);
}

server.on('upgrade', function (req, socket, head) {
    // Host 头校验 + Origin 校验：拒外部网页的 WebSocket 连接
    // （防 spawn RCE 等高危 WS 端点被网页触达；Host 为 DNS rebinding 第二道闸门）
    if (!hostOk(req) || !originOk(req)) {
        socket.destroy();
        return;
    }
    // H1 修复：WS 通道 token 鉴权（浏览器 WebSocket 不能设自定义头 → URL query）。
    // WS 承载 spawn（MCP 进程管理——任意命令执行面）等最高危能力，必须校验。
    // /ext-ws 路径豁免：外接模式 ext-mcp-server（外部 Agent 拉起的独立进程，无
    // evalScript 通道获取 token）专用入口——协议面限定 ext_* 消息族（relay 路由，
    // 无 spawn 等高危命令），受 extPolicy 激活态 + 投影门 + 确认默认拒三层门把守，
    // 与 /mcp HTTP 豁免同构。
    var _isExtPath = false;
    try { _isExtPath = url.parse(req.url).pathname === '/ext-ws'; } catch (_) {}
    if (_authToken && !_isExtPath && !authWsTokenOk(req)) {
        log('WS upgrade rejected: missing/invalid bridge token');
        socket.destroy();
        return;
    }
    // /ext-ws 连接打标记：handleWebSocketMessage 据此强制 ext_* 协议面隔离
    if (_isExtPath) socket.__asExtWs = true;
    if (!acceptWebSocket(req, socket)) {
        socket.destroy();
        return;
    }

    _clientCount++;
    if (_idleExitTimer) { clearTimeout(_idleExitTimer); _idleExitTimer = null; }
    log('WebSocket client connected (' + _clientCount + ' active)');

    // 通知所有处理器：新客户端已连接（供 MCP 等模块重新绑定 socket）
    for (var i = 0; i < wsMessageHandlers.length; i++) {
        try { wsMessageHandlers[i]({ type: '_client_connected' }, socket, sendFrame); } catch (_) {}
    }

    var frameBuffer = Buffer.alloc(0);
    var reassembler = createFrameReassembler(
        function (payload) { handleWebSocketMessage(socket, payload); }
    );

    socket.on('data', function (data) {
        frameBuffer = Buffer.concat([frameBuffer, data]);
        while (true) {
            var result;
            try {
                result = decodeFrame(frameBuffer);
            } catch (e) {
                log('Frame decode error: ' + e.message);
                socket.destroy();
                return;
            }
            if (!result) break;
            frameBuffer = result.remaining;
            reassembler.push(result);
            if (reassembler.bufferedBytes() > MAX_WS_FRAME) {
                log('WebSocket fragmented message too large (' + reassembler.bufferedBytes() + ' > ' + MAX_WS_FRAME + '), destroying connection');
                socket.destroy();
                return;
            }
        }
        // 帧缓冲累计上限（须在 while 消费之后检查）：口径 = MAX_WS_FRAME + 14（14 为
        // masked 64 位帧头 2+8+4 的最大值），即"单个最大合法帧的总字节数"。检查放在
        // 消费之前且只对 payload 计数，会把恰好 16MB 载荷 + 帧头的完整合法帧（含分块
        // 到达、流水线多帧的中间态）误杀；放在消费之后，合法帧永远先被 decodeFrame
        // 消费，超限只可能是恶意"声明超限帧"绕过了 decodeFrame 的即抛检查——纵深防御兜底。
        if (frameBuffer.length > MAX_WS_FRAME + 14) {
            log('WebSocket frame buffer too large (' + frameBuffer.length + ' > ' + (MAX_WS_FRAME + 14) + '), destroying connection');
            socket.destroy();
        }
    });

    // 发送欢迎消息
    sendFrame(socket, Buffer.from(JSON.stringify({
        type: 'connected',
        bridgeVersion: '2.0.0'
    })));

    socket.on('close', function () {
        _clientCount = Math.max(0, _clientCount - 1);
        log('WebSocket client disconnected (' + _clientCount + ' active)');
        // 通知所有处理器
        for (var i = 0; i < wsMessageHandlers.length; i++) {
            try { wsMessageHandlers[i]({ type: '_client_disconnected' }, socket, sendFrame); } catch (_) {}
        }
        _scheduleIdleExit();
    });

    socket.on('error', function (err) {
        // 连接数扣减只在 close 事件做：error 后 destroy() 必然触发 close，
        // 此处再减一次会在多客户端场景把计数提前扣穿（仍有客户端时误判 0，30s idle 误退出）
        log('Socket error: ' + err.message);
        socket.destroy();
    });
});

// 启动时开始计时（如果没有客户端连接，30s 后自动退出）
_scheduleIdleExit();

// ========== 端口占用处理 ==========

function getPidOnPort(port) {
    try {
        var cp = require('child_process');
        var result;
        if (process.platform === 'win32') {
            // netstat 输出形如 "TCP 0.0.0.0:9877 0.0.0.0:0 LISTENING 1234"
            // 用 :port 后跟空格边界，避免 :9877 误匹配 :98770
            result = cp.execSync('netstat -ano | findstr ":' + port + ' " | findstr LISTENING', { encoding: 'utf8' });
            var lines = result.trim().split(/\r?\n/);
            for (var i = 0; i < lines.length; i++) {
                var parts = lines[i].trim().split(/\s+/);
                var pid = parts[parts.length - 1];
                if (pid && /^\d+$/.test(pid) && pid !== String(process.pid)) {
                    return parseInt(pid, 10);
                }
            }
        } else {
            // macOS/Linux: 用 lsof
            result = cp.execSync('lsof -ti tcp:' + port + ' -sTCP:LISTEN', { encoding: 'utf8' });
            var pids = result.trim().split(/\r?\n/);
            for (var j = 0; j < pids.length; j++) {
                var p = parseInt(pids[j], 10);
                if (p && p !== process.pid) return p;
            }
        }
    } catch (e) {}
    return null;
}

// 取进程命令行，用于判断占用端口的进程是不是我们自己的旧 bridge。
// 只杀自己的僵尸进程，绝不误杀别的程序（用户可能用 9877 跑其他服务）。
function getProcessCommandLine(pid) {
    try {
        var cp = require('child_process');
        if (process.platform === 'win32') {
            var viaPs = false;
            var out;
            try {
                out = cp.execSync('wmic process where "ProcessId=' + pid + '" get CommandLine /value', { encoding: 'utf8' });
            } catch (_) {
                // Win11 24H2+ 已移除 wmic（默认组件裁剪）——wmic 不可用时
                // 回退 PowerShell Get-CimInstance（Win32_Process），否则僵尸 bridge 识别
                // 恒失败、退化为不杀旧进程走端口回退。命令行拼接安全：pid 来自
                // getPidOnPort 的 parseInt(/^\d+$/) 产物，纯数字无注入面；PS 侧输出
                // 即原始命令行（无 "CommandLine=" 前缀，与 wmic /value 形状不同）
                viaPs = true;
                out = cp.execSync(
                    // PS 输出编码定 UTF-8（zh-CN 默认 GB2312 → 中文安装路径下命令行
                    // 回读乱码 → 旧 bridge 识别失败只能退端口回退）
                    'powershell -NoProfile -NonInteractive -Command "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-CimInstance Win32_Process -Filter \'ProcessId=' + pid + '\').CommandLine"',
                    { encoding: 'utf8' });
            }
            if (viaPs) return String(out || '').trim();
            var m = out.match(/CommandLine=(.*)/);
            return m ? m[1].trim() : '';
        } else {
            return cp.execSync('cat /proc/' + pid + '/cmdline 2>/dev/null', { encoding: 'utf8' }).replace(/\0/g, ' ').trim();
        }
    } catch (e) {
        return '';
    }
}

// 与 host.jsx 的 WMI 杀旧进程同口径——只杀「命令行包含**本安装**
// bridge 入口脚本完整路径」的进程。按 /ae-bridge|mcp-bridge|bridge-server/i 纯子串
// 匹配，会误杀命令行恰好含该子串的无关进程（如 notepad D:\notes\ae-bridge-设计.md），
// 与 tryKillExisting 上方「别的程序占用 9877 时不杀，换端口」的承诺相悖。
// 候选路径：本进程入口 process.argv[1]（本次真实启动脚本）+ 本安装三个入口的绝对路径
// （ae-bridge.js / bridge-server.js / 改名前的 client/modules/mcp-manager/mcp-bridge.js）。
// 规范化：'\\'→'/' 且转小写后做整段包含匹配（Windows 路径大小写/斜杠不敏感，与 host
// WQL 的 = / LIKE 语义一致）。匹配不到 → 不杀，交由 start() 端口回退换端口。
function _ownBridgeEntryPaths() {
    var out = [];
    function add(p) {
        if (!p) return;
        try {
            var n = path.resolve(String(p)).replace(/\\/g, '/').toLowerCase();
            if (out.indexOf(n) === -1) out.push(n);
        } catch (_) {}
    }
    try {
        if (process && process.argv && process.argv[1]) add(process.argv[1]);
    } catch (_) {}
    try { add(path.join(__dirname, 'ae-bridge.js')); } catch (_) {}
    try { add(path.join(__dirname, 'bridge-server.js')); } catch (_) {}
    try { add(path.join(__dirname, '..', 'modules', 'mcp-manager', 'mcp-bridge.js')); } catch (_) {}
    return out;
}

function _cmdLineMatchesOwnBridge(cmdLine) {
    var norm = String(cmdLine || '').replace(/\\/g, '/').toLowerCase();
    if (!norm) return false;
    var paths = _ownBridgeEntryPaths();
    for (var i = 0; i < paths.length; i++) {
        if (norm.indexOf(paths[i]) !== -1) return true;
    }
    return false;
}

function tryKillExisting(port) {
    var p = port || PORT;
    var oldPid = getPidOnPort(p);
    if (!oldPid) return false;

    // 只杀自己的旧 bridge 进程（命令行含本安装入口脚本完整路径，含 mcp-bridge 旧名）。
    // 别的程序占用 9877 时不杀，让 start() 的端口回退逻辑换到 9878-9886。
    var cmdLine = getProcessCommandLine(oldPid);
    if (!_cmdLineMatchesOwnBridge(cmdLine)) {
        log('Port ' + p + ' in use by PID ' + oldPid + ' (not our bridge: "' + (cmdLine || 'unknown') + '") - skipping kill, will try next port');
        return false;
    }

    log('Port ' + p + ' in use by our old bridge PID ' + oldPid + ' - attempting to kill...');
    try {
        var cp = require('child_process');
        if (process.platform === 'win32') {
            cp.execSync('taskkill /F /PID ' + oldPid, { stdio: 'ignore' });
        } else {
            process.kill(oldPid, 'SIGKILL');
        }
        log('Killed old process PID ' + oldPid);
        return true;
    } catch (e) {
        logErr('Failed to kill PID ' + oldPid + ': ' + e.message);
    }
    return false;
}

// 预探测端口是否已有监听者：TCP 连接被接受即视为占用。
// Windows 上 libuv 对监听 socket 默认设 SO_REUSEADDR，端口被外部程序占用时
// listen() 不报 EADDRINUSE 而与其共存绑定（连接分发不确定，常被占用者吞掉），
// 因此不能只靠 EADDRINUSE 被动回退——listen 前必须主动探测，占用则顺延下一端口。
// loopback 上空闲端口立即 ECONNREFUSED；超时（有监听者但不 accept）保守视为占用。
function probePortOccupied(port, cb) {
    var net = require('net');
    var settled = false;
    var sock = net.connect({ host: '127.0.0.1', port: port, timeout: 600 });
    function done(occupied) {
        if (settled) return;
        settled = true;
        try { sock.destroy(); } catch (_) {}
        cb(occupied);
    }
    sock.on('connect', function () { done(true); });
    sock.on('timeout', function () { done(true); });
    sock.on('error', function () { done(false); });
}

function start(callback) {
    var basePort = PORT;
    var maxPort = PORT + 9;  // 尝试 10 个端口：9877-9886
    var currentPort = PORT;
    var killedOnce = false;
    var callbackDone = false;

    function onListening() {
        PORT = currentPort;
        log('Bridge server listening on http://127.0.0.1:' + currentPort);
        log('Health check: http://127.0.0.1:' + currentPort + '/health');
        if (!callbackDone) { callbackDone = true; if (callback) callback(null); }
    }

    server.on('error', function (err) {
        if (callbackDone) return;
        if (err.code === 'EADDRINUSE') {
            // 兜底路径（预探测与 listen 间的竞态 / 非 Windows 平台）：
            // 首次占用：尝试杀掉占端口的旧 bridge 进程
            if (!killedOnce && tryKillExisting(currentPort)) {
                killedOnce = true;
                setTimeout(function () {
                    tryPort(currentPort);
                }, 500);
                return;
            }
            // 杀不掉（别的程序占用）→ 试下一个端口
            nextPort(currentPort);
            return;
        }
        logErr('Server error: ' + err.message);
        callbackDone = true;
        if (callback) callback(err);
    });

    function nextPort(port) {
        var next = port + 1;
        if (next <= maxPort) {
            log('Port ' + port + ' in use, trying ' + next);
            tryPort(next);
            return;
        }
        logErr('All ports ' + basePort + '-' + maxPort + ' in use');
        callbackDone = true;
        if (callback) callback(new Error('EADDRINUSE'));
    }

    function tryPort(port) {
        if (callbackDone) return;
        probePortOccupied(port, function (occupied) {
            if (callbackDone) return;
            if (occupied) {
                // 端口已有监听者：若是我们自己的旧 bridge 则杀掉重试本端口
                if (!killedOnce && tryKillExisting(port)) {
                    killedOnce = true;
                    setTimeout(function () { tryPort(port); }, 500);
                    return;
                }
                nextPort(port);
                return;
            }
            currentPort = port;
            server.listen(port, '127.0.0.1', onListening);
        });
    }

    tryPort(currentPort);
}

// ========== 鉴权初始化（require 即生效——ae-bridge.js 与直启 bridge-server.js 两入口统一）==========

_initTokenFromArgv();

// ========== 导出 ==========

module.exports = {
    PORT: PORT,
    server: server,
    start: start,
    addWsHandler: addWsHandler,
    setExtMcpInfoProvider: setExtMcpInfoProvider,
    setExtMcpHttpHandler: setExtMcpHttpHandler,
    registerBeforeExitHook: registerBeforeExitHook,
    sendFrame: sendFrame,
    log: log,
    logErr: logErr,
    // H1 修复：token 鉴权（测试/嵌入方注入；正常流程经 _initTokenFromArgv 交接）
    setAuthToken: setAuthToken,
    authTokenOk: authTokenOk,
    authWsTokenOk: authWsTokenOk,
    // 导出异步 spawn 封装，供 ae-bridge.js 的 taskkill 树杀复用（execSync 阻塞
    // 事件循环的姊妹位置统一异步化）
    spawnAsync: _spawnAsync
};

// ========== Word（docx）正文/表格 → Markdown ==========
// mammoth.convertToHtml 保留标题、列表与表格结构；这里把其 HTML 转成 Markdown：
// 标题按级别带 #、列表保留 - / 1. 前缀（嵌套按层级缩进）、表格按管道表输出（首行即表头，
// 单元格内 | 转义、colspan 补空列、rowspan 不展开）。嵌套表格把内层文字并入外层单元格。
function _docxHtmlToMarkdown(html) {
    var src = String(html || '');
    var blocks = [];
    var buf = '';
    var listStack = [];
    var tableDepth = 0;
    var tableRows = null;
    var cellText = null;
    var cellColspan = 1;
    var linkHref = '';

    function decode(t) {
        return t.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
    }
    function flushParagraph() {
        var raw = String(buf || '');
        buf = '';
        if (!raw.trim()) return;
        if (listStack.length > 0 && /^( {2})*(- |[0-9]+\. )/.test(raw)) {
            pushListItem(raw.replace(/\s+$/, ''));
        } else {
            blocks.push(raw.trim());
        }
    }
    function appendInline(text) {
        var t = decode(String(text || ''));
        if (tableRows) {
            if (cellText !== null) {
                cellText += t.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
            }
            return;
        }
        buf += t;
    }
    function listIndent() {
        return new Array(Math.max(1, listStack.length)).join('  ');
    }
    function pushListItem(line) {
        var t = String(line || '').replace(/\s+$/, '');
        if (!t.trim()) return;
        var last = blocks.length ? blocks[blocks.length - 1] : '';
        if (last && /^( {2})*(- |[0-9]+\. )/.test(last)) {
            blocks[blocks.length - 1] = last + '\n' + t;
        } else {
            blocks.push(t);
        }
    }
    function flushCell() {
        if (!tableRows || cellText === null) return;
        var row = tableRows[tableRows.length - 1];
        if (!row) return;
        row.push(String(cellText || '').replace(/\s+/g, ' ').trim());
        for (var extra = 1; extra < cellColspan; extra++) row.push('');
        cellColspan = 1;
        cellText = null;
    }
    function flushRow() {
        if (!tableRows) return;
        flushCell();
        if (tableRows.length && tableRows[tableRows.length - 1].length === 0) tableRows.pop();
    }
    function flushTable() {
        if (!tableRows) return;
        flushRow();
        var rows = tableRows;
        tableRows = null;
        var width = 0;
        var r;
        for (r = 0; r < rows.length; r++) width = Math.max(width, rows[r].length);
        if (!rows.length || !width) return;
        var lines = [];
        for (r = 0; r < rows.length; r++) {
            var cells = rows[r].slice();
            while (cells.length < width) cells.push('');
            lines.push('| ' + cells.join(' | ') + ' |');
            if (r === 0) {
                var sep = [];
                for (var c = 0; c < width; c++) sep.push('---');
                lines.push('| ' + sep.join(' | ') + ' |');
            }
        }
        blocks.push(lines.join('\n'));
    }

    var i = 0;
    while (i < src.length) {
        var lt = src.indexOf('<', i);
        if (lt === -1) { appendInline(src.slice(i)); break; }
        if (lt > i) appendInline(src.slice(i, lt));
        var gt = src.indexOf('>', lt);
        if (gt === -1) break;
        var raw = src.slice(lt + 1, gt);
        i = gt + 1;
        if (!raw || raw.charAt(0) === '!') continue;
        var closing = raw.charAt(0) === '/';
        var body = closing ? raw.slice(1) : raw;
        body = body.replace(/\/\s*$/, '');
        var m = /^([a-zA-Z][a-zA-Z0-9]*)/.exec(body);
        if (!m) continue;
        var tag = m[1].toLowerCase();
        var attrs = body.slice(m[1].length);

        if (tag === 'br') { appendInline(' '); continue; }
        if (tag === 'table') {
            if (!closing) {
                if (tableDepth === 0) { flushParagraph(); tableRows = []; }
                else { appendInline(' '); }
                tableDepth++;
            } else {
                tableDepth = Math.max(0, tableDepth - 1);
                if (tableDepth === 0) flushTable();
            }
            continue;
        }
        if (tableDepth > 1) {
            if (tag === 'tr' || tag === 'td' || tag === 'th') continue;
        }
        if (tag === 'tr') {
            if (!closing) { if (tableRows) { flushRow(); tableRows.push([]); } } else { flushRow(); }
            continue;
        }
        if (tag === 'td' || tag === 'th') {
            if (!closing) {
                flushCell();
                cellText = '';
                var cs = /colspan\s*=\s*"(\d+)"/i.exec(attrs);
                cellColspan = cs ? Math.max(1, Math.min(20, Number(cs[1]) || 1)) : 1;
            } else {
                flushCell();
            }
            continue;
        }
        if (tag === 'p') {
            if (tableRows) { if (closing) appendInline(' '); continue; }
            if (closing) flushParagraph();
            continue;
        }
        if (/^h[1-6]$/.test(tag)) {
            var level = Number(tag.charAt(1));
            if (!closing) {
                flushParagraph();
            } else {
                var headText = buf.trim();
                buf = '';
                if (headText) blocks.push(new Array(level + 1).join('#') + ' ' + headText);
            }
            continue;
        }
        if (tag === 'ul' || tag === 'ol') {
            if (!closing) {
                flushParagraph();
                listStack.push({ ordered: tag === 'ol', index: 0 });
            } else {
                listStack.pop();
            }
            continue;
        }
        if (tag === 'li') {
            if (tableRows) continue;
            if (!closing) {
                flushParagraph();
                var list = listStack.length ? listStack[listStack.length - 1] : { ordered: false, index: 0 };
                var prefix = list.ordered ? (++list.index) + '. ' : '- ';
                buf = listIndent() + prefix;
            } else {
                var itemText = buf.replace(/\s+$/, '');
                buf = '';
                if (itemText.trim()) pushListItem(itemText);
            }
            continue;
        }
        if (closing) {
            if (tag === 'strong' || tag === 'b') appendInline('**');
            else if (tag === 'em' || tag === 'i') appendInline('*');
            else if (tag === 'code') appendInline('`');
            else if (tag === 'a') { appendInline(linkHref ? '](' + linkHref + ')' : ']'); linkHref = ''; }
            continue;
        }
        if (tag === 'strong' || tag === 'b') { appendInline('**'); continue; }
        if (tag === 'em' || tag === 'i') { appendInline('*'); continue; }
        if (tag === 'code') { appendInline('`'); continue; }
        if (tag === 'a') {
            var hm = /href\s*=\s*"([^"]*)"/i.exec(attrs);
            linkHref = hm ? hm[1] : '';
            appendInline('[');
            continue;
        }
        if (tag === 'img') {
            var am = /alt\s*=\s*"([^"]*)"/i.exec(attrs);
            appendInline(am && am[1] ? '[' + am[1] + ']' : '[图片]');
            continue;
        }
    }
    if (tableRows) flushTable();
    flushParagraph();
    return blocks.join('\n\n').trim();
}

// 解析 docx 文本：优先 convertToHtml → Markdown（保留标题/列表/表格与内嵌图片占位），
// 失败或为空时回落 extractRawText；返回值 { text, images, imageTotal, imagesSkipped }，
// images 为已提取到数据目录的图片文件（正文占位给出路径，供模型按需用 read_image 查看）。
function _docxToMarkdownText(mammoth, sourceOpts) {
    var images = [];
    var imageTotal = 0;
    var imagesSkipped = 0;
    var MAX_IMAGES = 20;
    var imgDir = _docxImagesDir();

    function rawText() {
        if (!mammoth || typeof mammoth.extractRawText !== 'function') {
            return Promise.reject(new Error('mammoth extractRawText not available'));
        }
        return mammoth.extractRawText(sourceOpts).then(function (r) {
            return { text: (r && r.value) || '', images: [], imageTotal: 0, imagesSkipped: 0 };
        }, function (e) {
            throw new Error('extractRawText failed: ' + ((e && e.message) || e));
        });
    }

    if (!mammoth || typeof mammoth.convertToHtml !== 'function') return rawText();

    var convertImage = null;
    if (mammoth.images && typeof mammoth.images.imgElement === 'function') {
        convertImage = mammoth.images.imgElement(function (image) {
            var idx = ++imageTotal;
            return image.read().then(function (buffer) {
                var saved = _saveDocxImage(buffer, image && image.contentType, idx, imgDir, MAX_IMAGES, images);
                if (!saved.saved) imagesSkipped++;
                return { src: 'docx-image', alt: saved.alt };
            }, function () {
                imagesSkipped++;
                return { src: 'docx-image', alt: '图片 ' + idx + '（读取失败）' };
            });
        });
    }

    var input = {};
    for (var k in sourceOpts) {
        if (Object.prototype.hasOwnProperty.call(sourceOpts, k)) input[k] = sourceOpts[k];
    }

    return mammoth.convertToHtml(input, convertImage ? { convertImage: convertImage } : undefined).then(function (r) {
        var md = _docxHtmlToMarkdown(r && r.value);
        if (md) return { text: md, images: images, imageTotal: imageTotal, imagesSkipped: imagesSkipped };
        return rawText();
    }, function (e) {
        if (typeof logErr === 'function') logErr('docx convertToHtml failed, fallback extractRawText: ' + ((e && e.message) || e));
        return rawText().then(null, function (e2) {
            throw new Error('convertToHtml failed: ' + ((e && e.message) || e) + '; ' + ((e2 && e2.message) || e2));
        });
    });
}

// 数据目录下的 docx 图片落点（<数据目录>/temp/docx-images）；数据目录不可用时返回空串。
function _docxImagesDir() {
    if (!_dataDir) return '';
    return path.join(_dataDir, 'temp', 'docx-images');
}

// 保存一张 docx 内嵌图片：只收 PNG/JPEG，按内容哈希去重，跳过图标级与超大图；
// 单文档最多保留 maxImages 张。返回 { alt, saved }：alt 为 Markdown 占位文案
// （已保存时含绝对路径，跳过时含原因），saved 表示本次是否落盘。
function _saveDocxImage(buffer, contentType, idx, imgDir, maxImages, images) {
    function skip(alt) { return { alt: alt, saved: false }; }
    var type = String(contentType || '').toLowerCase();
    var ext = type.indexOf('png') !== -1 ? 'png' : ((type.indexOf('jpeg') !== -1 || type.indexOf('jpg') !== -1) ? 'jpg' : '');
    if (!ext) return skip('图片 ' + idx + '（格式不支持，已跳过）');
    if (!imgDir || !buffer || !buffer.length) return skip('图片 ' + idx + '（数据目录不可用，未提取）');
    if (buffer.length < 4096) return skip('图片 ' + idx + '（图标尺寸，已跳过）');
    if (buffer.length > 4 * 1024 * 1024) return skip('图片 ' + idx + '（超过 4MB，已跳过）');
    var hash = crypto.createHash('sha1').update(buffer).digest('hex');
    var filename = hash + '.' + ext;
    var filePath = path.join(imgDir, filename);
    for (var i = 0; i < images.length; i++) {
        if (images[i].hash === hash) return skip('图片 ' + idx + '（与图片 ' + images[i].index + ' 相同）');
    }
    if (images.length >= maxImages) return skip('图片 ' + idx + '（超出单文档提取上限）');
    var partPath = '';
    try {
        fs.mkdirSync(imgDir, { recursive: true });
        if (!fs.existsSync(filePath)) {
            if (typeof fs.renameSync === 'function') {
                partPath = filePath + '.part';
                fs.writeFileSync(partPath, buffer);
                fs.renameSync(partPath, filePath);
                partPath = '';
            } else {
                fs.writeFileSync(filePath, buffer);
            }
        }
    } catch (e) {
        if (partPath && typeof fs.unlinkSync === 'function') {
            try { fs.unlinkSync(partPath); } catch (_) {}
        }
        if (typeof logErr === 'function') logErr('docx image write failed: ' + ((e && e.message) || e));
        return skip('图片 ' + idx + '（写入失败，未提取）');
    }
    images.push({ path: filePath, size: buffer.length, hash: hash, index: idx });
    return { alt: '图片 ' + idx + '（' + filePath + '）', saved: true };
}

// 解析接口统一回包：缓存条目为 { text, images?, imageTotal?, imagesSkipped? }；
// docx 带内嵌图片时回包额外带 images / imageTotal / imagesSkipped（诊断与测试用，正文占位已含路径）。
function _parseDocReply(format, entry) {
    var text = (entry && typeof entry === 'object') ? entry.text : entry;
    var out = { ok: true, format: String(format || '').replace(/^\./, ''), text: text };
    if (entry && typeof entry === 'object' && Array.isArray(entry.images) && entry.images.length) {
        out.images = entry.images;
        out.imageTotal = entry.imageTotal;
        out.imagesSkipped = entry.imagesSkipped;
    }
    return out;
}
