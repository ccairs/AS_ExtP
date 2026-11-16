/**
 * AE Bridge 启动脚本
 *
 * 启动共享 Bridge Server，注册 MCP 进程管理 WebSocket 处理器。
 *
 * 启动方式：node client/shared/ae-bridge.js
 */

var cp = require('child_process');
var path = require('path');

var PROJECT_ROOT = path.resolve(__dirname, '../..');

// 依赖 vendor 化：bridge 一律从 vendor/node_modules 解析依赖，避免命中根 node_modules
// 造成「开发/部署依赖源不一致」的版本漂移。部署时根本无根 node_modules，开发时根目录存在，
// 但通过 _nodeModulePaths 强制把 vendor 置顶，保证两环境行为一致。
var VENDOR_NODE_MODULES = path.join(PROJECT_ROOT, 'vendor', 'node_modules');

// 兜底：NODE_PATH 仍指向 vendor（_nodeModulePaths 未覆盖到的 ESM/边缘解析路径）
if (!process.env.NODE_PATH) {
    process.env.NODE_PATH = VENDOR_NODE_MODULES;
} else if (process.env.NODE_PATH.indexOf(VENDOR_NODE_MODULES) === -1) {
    process.env.NODE_PATH = VENDOR_NODE_MODULES + path.delimiter + process.env.NODE_PATH;
}
require('module').Module._initPaths();

// 强制优先：把 vendor/node_modules 插到每个模块解析路径的最前。
// 这样 require('@wwek/xlsx') 等一律先查 vendor，根 node_modules 不再参与；
// vendor 缺失时该路径不存在，Node 自动落到后续路径（根 node_modules），行为安全。
(function forceVendorPriority() {
    var Module = require('module');
    var _origNodeModulePaths = Module._nodeModulePaths;
    Module._nodeModulePaths = function (from) {
        var paths = _origNodeModulePaths(from);
        if (paths.indexOf(VENDOR_NODE_MODULES) === -1) {
            paths.unshift(VENDOR_NODE_MODULES);
        }
        return paths;
    };
})();

// 加载共享 Bridge Server（同目录）
var bridge = require('./bridge-server.js');
var sendFrame = bridge.sendFrame;
var log = bridge.log;

// ========== MCP 进程管理 ==========

var serverConfigs = {};
var processes = {};
// 主动停止标志（挂在 procInfo 上）：stopSingle 主动 kill 前置位于目标进程
// 的 procInfo，close 事件据此区分"用户停止"与"意外崩溃"，把 intent 透传给面板侧（避免
// 用户 stop 后误触发自动重启）。按进程身份而非 serverId 记录——stop→spawn（配置变更
// 重启）窗口内旧进程 close 与新进程 stop 交叉时，serverId 单布尔会被旧进程提前消费掉
// 新进程的停止意图（新进程 exited 帧误报意外崩溃，面板误触发自动重启）。

function isWindows() {
    return process.platform === 'win32';
}

function stopSingle(serverId, cb) {
    var procInfo = processes[serverId];
    if (!procInfo || !procInfo.child) {
        if (cb) cb();
        return;
    }
    procInfo.intentionalStop = true;
    try { procInfo.child.stdin.end(); } catch (_) {}
    if (isWindows() && procInfo.child.pid) {
        // shell:true 包装下 kill() 只能终止 cmd.exe，树形杀才能连带终止 MCP server 孙进程。
        // taskkill 原用 execSync，子进程卡住期间 bridge 事件循环完全停转（/health 心跳
        // 误判断线 → 断线页 → 重试杀 bridge；spawnSync 异步化修复的姊妹位置）。
        // 改走 bridge-server 的 _spawnAsync：10s 超时兜底 kill，完成回调驱动上层收尾
        // （stopped 帧与条目清理），事件循环全程可服务心跳与其余端点。
        bridge.spawnAsync('taskkill', ['/PID', String(procInfo.child.pid), '/T', '/F'],
            { timeout: 10000 }, function () { if (cb) cb(); });
    } else {
        try { procInfo.child.kill(); } catch (_) {}
        if (cb) cb();
    }
}

// Shell 注入防御：windows shell:true → cmd.exe
// 拦 cmd.exe 在 /c 单行命令里真正解析的：& | < >（分隔/重定向）^（转义）%（变量展开）"（引号穿透）+ 控制字符（换行可分隔命令）
// 不拦 ( ) —— 仅在 IF/FOR 语句块内特殊，普通 /c 单行中是字面量；拦了会误杀 "C:\Program Files (x86)\..." 路径
// 不拦 ; ` $ ' ! —— cmd.exe 不解析这五个（! 仅延迟展开模式认，/c 默认关）
// & 留在黑名单是有意为之：URL query 含 & 的 arg 即便放行也会被 cmd 截断/注入，拒早优于带病运行
// % 必须拦：config.env 值经 spawnOptions.env 原生传递不经 shell 解析（故 env 无需校验），
// 但 command/args 里的 %VAR% 引用会被 cmd 展开——放行等于给未校验的 env 值开后门
function _hasShellChars(s) {
    if (!s || typeof s !== 'string') return false;
    if (/[&|<>^%"]/.test(s)) return true;
    for (var i = 0; i < s.length; i++) {
        var c = s.charCodeAt(i);
        if (c <= 0x1F || c === 0x7F) return true;
    }
    return false;
}

// Windows shell:true 的空格 token 加引号：Node 把 command+args 以空格拼接传给 cmd.exe
// 且不对参数加引号，含空格的 token（如 C:\Program Files\...）会被 cmd 拆散，进程启动失败。
// _hasShellChars 已拒绝引号/元字符/控制字符，包裹不会引入新的注入面；非字符串原样返回
// （交给 spawn 自身参数校验，与旧路径行为一致）。
function _shellQuote(s) {
    if (typeof s !== 'string' || !/\s/.test(s)) return s;
    // 尾部反斜杠翻倍：闭合引号前的 \ 会被子进程 MSVC CRT 当作 \" 转义符，引号不
    // 闭合、尾引号被吞进参数值（"C:\My Tools\" → C:\My Tools"）；翻倍后 CRT 解析
    // 为一个字面 \，引号正常闭合。与 communicationProvider.js 面板侧同款。
    var body = s.replace(/\\+$/, function (m) { return m + m; });
    return '"' + body + '"';
}

// Windows shell 路径的完整命令串：逐 token 加引号后以空格拼接。
// spawn 单命令串（args 传空数组）：Node 整体包成 cmd.exe 命令行（/s 开关保留内层
// 引号结构），规避外层引号被吃的经典问题。
function _buildShellCommand(command, args) {
    // 畸形配置防御：args 为字符串等非数组时，下方 for 会按字符遍历拼成
    // "cmd v e r b o s e" 错误命令并静默 spawn；入口抛错走既有 catch →
    // spawn_error 明确报错（恢复旧 shell:false 数组路径的 ERR_INVALID_ARG_TYPE 语义）
    if (args && !Array.isArray(args)) {
        throw new Error('config.args must be an array, got ' + typeof args);
    }
    var tokens = [_shellQuote(command)];
    for (var i = 0; i < (args || []).length; i++) {
        tokens.push(_shellQuote(args[i]));
    }
    return tokens.join(' ');
}

// 判断两次 spawn 的 config 是否等价（command/args/env 逐字段比对）——
// handleSpawn 复用已存活进程前比对差异，配置变化时 stop→spawn 让新配置生效。
// env null 与 {} 等价（handleSpawn 存储时 config.env || null 归一化）；值经
// String() 归一比较（JSON 数字/布尔与字符串表形不构成差异）
function _configMatches(a, b) {
    if (!a || !b) return false;
    if (String(a.command || '') !== String(b.command || '')) return false;
    var aa = a.args || [], ba = b.args || [];
    if (aa.length !== ba.length) return false;
    for (var i = 0; i < aa.length; i++) {
        if (String(aa[i]) !== String(ba[i])) return false;
    }
    var ae = a.env || {}, be = b.env || {};
    var ak = Object.keys(ae);
    if (ak.length !== Object.keys(be).length) return false;
    for (var k = 0; k < ak.length; k++) {
        var key = ak[k];
        if (!Object.prototype.hasOwnProperty.call(be, key) || String(ae[key]) !== String(be[key])) return false;
    }
    return true;
}

function handleSpawn(msg, socket) {
    var serverId = msg.serverId;
    var config = msg.config || {};

    // 校验 command 和 args 不含 shell 元字符，防 command injection
    if (_hasShellChars(config.command)) {
        console.warn('[MCP] 拒绝危险的 command: ' + String(config.command).substring(0, 80));
        sendFrame(socket, Buffer.from(JSON.stringify({
            type: 'spawn_error', serverId: serverId, message: 'Command contains forbidden shell characters', requestId: msg.requestId
        })));
        return;
    }
    var args = config.args || [];
    for (var ai = 0; ai < args.length; ai++) {
        if (_hasShellChars(args[ai])) {
            console.warn('[MCP] 拒绝危险的 arg[' + ai + ']: ' + String(args[ai]).substring(0, 80));
            sendFrame(socket, Buffer.from(JSON.stringify({
                type: 'spawn_error', serverId: serverId, message: 'Argument contains forbidden shell characters', requestId: msg.requestId
            })));
            return;
        }
    }

    // 先取旧 config 再覆盖——复用判定要用「已存活进程当时的配置」与新配置比对
    var prevConfig = serverConfigs[serverId];
    serverConfigs[serverId] = {
        command: config.command || '',
        args: config.args || [],
        env: config.env || null
    };

    var procInfo = processes[serverId];
    if (procInfo && procInfo.child) {
        // 已存活进程不能无脑复用——配置变更（command/args/env 任一差异）
        // 曾被静默忽略，旧进程继续按旧配置运行（MCP 配置变更需 stop→spawn 才生效）。
        // 等价 → 保持既有幂等复用语义（同 config 重发 spawn 直接回 spawned 带旧 pid）；
        // 有差异 → stopSingle 树杀旧进程后落新配置走下方 spawn（树杀异步不等完成：
        // 旧进程 close/error 迟到由各处理器的 processes[serverId] === newProcInfo
        // 身份守卫防误删新进程条目，与 handleSend 崩溃重启路径同款竞态防御；
        // intentionalStop 置位（挂在旧 procInfo 上）让旧进程 exited 帧带
        // intentional=true，面板不触发旧配置的自动重启）
        if (_configMatches(prevConfig, serverConfigs[serverId])) {
            sendFrame(socket, Buffer.from(JSON.stringify({
                type: 'spawned', serverId: serverId, pid: procInfo.child.pid, requestId: msg.requestId
            })));
            return;
        }
        stopSingle(serverId);
    }

    var env = Object.assign({}, process.env);
    if (config.env) {
        var keys = Object.keys(config.env);
        for (var i = 0; i < keys.length; i++) {
            env[keys[i]] = config.env[keys[i]];
        }
    }
    if (env.MODE === undefined) {
        env.MODE = 'stdio';
    }

    var spawnOptions = {
        env: env,
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: PROJECT_ROOT,
        windowsHide: true  // MCP stdio 子进程（含 Windows shell:true 的 cmd 中转）不闪黑框
    };
    if (isWindows()) {
        spawnOptions.shell = true;
    }

    var child;
    try {
        if (isWindows()) {
            // shell:true 下 Node 不给参数加引号，含空格 command/args 会被 cmd.exe 拆散
            // （如 C:\Program Files\nodejs\node.exe）；拼成带引号的单命令串 spawn
            child = cp.spawn(_buildShellCommand(config.command, config.args), [], spawnOptions);
        } else {
            child = cp.spawn(config.command, config.args, spawnOptions);
        }
    } catch (e) {
        sendFrame(socket, Buffer.from(JSON.stringify({
            type: 'spawn_error', serverId: serverId, message: e.message, requestId: msg.requestId
        })));
        return;
    }

    var newProcInfo = {
        child: child,
        // 字节级缓冲（Buffer）：按 \n 字节切行后再 toString。
        // 若按字符串拼接（data.toString() 累加），多字节 UTF-8 字符（中文结果）
        // 被 stdout chunk 边界截断会产生 U+FFFD 替换符，静默损坏 JSON 内容
        buffer: Buffer.alloc(0),
        pending: {},
        pid: child.pid,
        serverId: serverId,
        socket: socket
    };

    // MCP stdout 行缓冲上限——异常 server 持续输出无换行数据（非 JSON-RPC 帧）时，
    // 按行切分的 buffer 会无限累积打爆 ae-bridge 内存。超限丢弃最旧数据（保留最新半段），
    // 被截断的残行最终因 JSON.parse 失败走 non-JSON 日志丢弃；正常 JSON-RPC 单帧远小于
    // 此上限，不受影响。4MB 对齐 bridge-server 侧 _spawnAsync 的 stderr 累计上限量级。
    // （声明在 handleSpawn 内：旧测试按本函数切片求值，模块级声明不在其切片内。）
    var MCP_STDOUT_BUFFER_CAP = 4 * 1024 * 1024;

    child.stdout.on('data', function (data) {
        newProcInfo.buffer = Buffer.concat([newProcInfo.buffer, data]);
        // 超限丢弃最旧数据（保最新半段），防无换行输出撑爆内存
        if (newProcInfo.buffer.length > MCP_STDOUT_BUFFER_CAP) {
            newProcInfo.buffer = newProcInfo.buffer.slice(newProcInfo.buffer.length - (MCP_STDOUT_BUFFER_CAP >> 1));
            log(serverId + ' stdout buffer overflow (' + MCP_STDOUT_BUFFER_CAP + ' cap), dropped oldest bytes');
        }
        var raw = newProcInfo.buffer;
        var nl;
        while ((nl = raw.indexOf(0x0A)) !== -1) {
            var line = raw.slice(0, nl).toString().trim();
            raw = raw.slice(nl + 1);
            if (!line) continue;
            try {
                var parsed = JSON.parse(line);
                var activeSocket = newProcInfo.socket;
                if (!activeSocket) continue;
                if (parsed && parsed.id !== undefined) {
                    sendFrame(activeSocket, Buffer.from(JSON.stringify({
                        type: 'response', serverId: serverId, data: line
                    })));
                } else if (parsed && parsed.method !== undefined) {
                    sendFrame(activeSocket, Buffer.from(JSON.stringify({
                        type: 'notification', serverId: serverId, data: line
                    })));
                }
            } catch (e) {
                log(serverId + ' stdout(non-JSON): ' + line.substring(0, 80));
            }
        }
        newProcInfo.buffer = raw;
    });

    child.stderr.on('data', function (data) {
        var text = data.toString().trim();
        log(serverId + ' stderr: ' + text);
        var activeSocket = newProcInfo.socket;
        if (activeSocket) {
            sendFrame(activeSocket, Buffer.from(JSON.stringify({
                type: 'stderr', serverId: serverId, data: text
            })));
        }
    });

    child.on('close', function (code) {
        log(serverId + ' exited code=' + code);
        // 读取本进程的主动停止标志，把 intent 传给面板侧（onProcessExit 据此决定是否
        // 自动重启）。标志挂在 procInfo 上随进程走，无需清理。
        var intentional = !!newProcInfo.intentionalStop;
        var activeSocket = newProcInfo.socket;
        if (activeSocket) {
            sendFrame(activeSocket, Buffer.from(JSON.stringify({
                type: 'exited', serverId: serverId, code: code, intentional: intentional
            })));
        }
        // 旧进程的 pending 请求应被 reject（进程已退出），但仅在 processes[serverId]
        // 仍指向本进程时才删除条目——stop→restart 后旧 close 迟到不能误删新进程 procInfo
        // （否则下次 send 会重复 spawn，产生双进程）
        var ids = Object.keys(newProcInfo.pending);
        for (var i = 0; i < ids.length; i++) {
            newProcInfo.pending[ids[i]](new Error('Process exited with code ' + code));
        }
        newProcInfo.pending = {};
        if (processes[serverId] === newProcInfo) {
            delete processes[serverId];
        }
    });

    child.on('error', function (err) {
        log(serverId + ' error: ' + err.message);
        var activeSocket = newProcInfo.socket;
        if (activeSocket) {
            sendFrame(activeSocket, Buffer.from(JSON.stringify({
                type: 'error', serverId: serverId, message: err.message
            })));
        }
        // 与 close 处理器同款身份守卫：stop→restart 后旧进程 error 迟到不能误删新进程条目
        if (processes[serverId] === newProcInfo) {
            delete processes[serverId];
        }
    });

    // bridge 模式 stdin 同样必须挂 'error' 监听——子进程退出到
    // 上方 close 回调删除 processes[serverId] 之间存在窗口（stdio 关闭是异步的），窗口内
    // WS 'send' 帧的 stdin.write 写已断管道触发异步 EPIPE（handleSend 的 try/catch 只能
    // 捕获同步 throw），无监听器的 stream error 会被 Node 作为 uncaughtException 抛出，
    // bridge-server 的 gracefulExit 杀掉全部 MCP 子进程并整体退出。监听后视作该 server
    // 通道失效：向面板发 send_error 帧（面板侧消费语义为整体 reject 该 server 的在途
    // pending，对齐 handleSend 写失败分支）、拒绝并清空本侧 pending、身份守卫删除条目；
    // 不额外 kill——EPIPE 意味着子进程已退出，close 随后到达统一收尾，此处重复 kill 无
    // 意义。与 close/error 处理器幂等共存（pending 先到先清）。
    if (child.stdin && typeof child.stdin.on === 'function') {
        child.stdin.on('error', function (err) {
            log(serverId + ' stdin error (channel dead): ' + err.message);
            var activeSocket = newProcInfo.socket;
            if (activeSocket) {
                sendFrame(activeSocket, Buffer.from(JSON.stringify({
                    type: 'send_error', serverId: serverId, message: 'stdin write failed: ' + err.message
                })));
            }
            var ids = Object.keys(newProcInfo.pending);
            for (var si = 0; si < ids.length; si++) {
                newProcInfo.pending[ids[si]](new Error('stdin write failed: ' + err.message));
            }
            newProcInfo.pending = {};
            // 与 close/error 处理器同款身份守卫：stop→restart 后旧进程事件迟到不能误删新进程条目
            if (processes[serverId] === newProcInfo) {
                delete processes[serverId];
            }
        });
    }

    processes[serverId] = newProcInfo;
    log(serverId + ' spawned, pid=' + child.pid);

    sendFrame(socket, Buffer.from(JSON.stringify({
        type: 'spawned', serverId: serverId, pid: child.pid, requestId: msg.requestId
    })));
}

function handleSend(msg, socket) {
    var serverId = msg.serverId;
    var procInfo = processes[serverId];

    if (!procInfo || !procInfo.child) {
        var cfg = serverConfigs[serverId];
        if (!cfg || !cfg.command) {
            sendFrame(socket, Buffer.from(JSON.stringify({
                type: 'config_missing', serverId: serverId, requestId: msg.requestId
            })));
            return;
        }
        handleSpawn({ type: 'spawn', serverId: serverId, config: cfg, requestId: msg.requestId }, socket);
        procInfo = processes[serverId];
        if (!procInfo || !procInfo.child) {
            sendFrame(socket, Buffer.from(JSON.stringify({
                type: 'send_error', serverId: serverId, message: 'Failed to spawn server', requestId: msg.requestId
            })));
            return;
        }
    }

    try {
        procInfo.child.stdin.write(msg.message + '\n');
    } catch (e) {
        log(serverId + ' stdin write failed: ' + e.message);
        sendFrame(socket, Buffer.from(JSON.stringify({
            type: 'send_error', serverId: serverId, message: 'Failed to write: ' + e.message, requestId: msg.requestId
        })));
    }
}

function handleStop(msg, socket) {
    var serverId = msg.serverId;
    // taskkill 异步化后，条目清理与 stopped 帧移到树杀完成回调——execSync 时期
    // 两者在 kill 返回后同步完成，异步化后立即回帧会让面板在进程实际死亡前收到 stopped
    // 回调补身份守卫——restartServer（stopServer+startServer）背靠背发
    // 'stop'+'spawn' 两帧时，taskkill 回调必然迟于 handleSpawn（配置差异路径）覆写
    // processes[serverId] 完成，无守卫会把新进程条目与新配置一并误删（后续 send 撞
    // config_missing 重拉第三进程 + 新进程成孤儿）。与 close/error/stdin-error 三处
    // 处理器同款守卫。
    var captured = processes[serverId];
    stopSingle(serverId, function () {
        if (processes[serverId] === captured) {
            delete processes[serverId];
            delete serverConfigs[serverId];
        }
        sendFrame(socket, Buffer.from(JSON.stringify({
            type: 'stopped', serverId: serverId
        })));
    });
}

function handleStopAll(msg, socket) {
    var ids = Object.keys(processes);
    var remaining = ids.length;
    function finish() {
        // Clear all references
        var allIds = Object.keys(processes);
        for (var j = 0; j < allIds.length; j++) { delete processes[allIds[j]]; }
        allIds = Object.keys(serverConfigs);
        for (var k = 0; k < allIds.length; k++) { delete serverConfigs[allIds[k]]; }

        sendFrame(socket, Buffer.from(JSON.stringify({
            type: 'allStopped'
        })));
    }
    if (remaining === 0) { finish(); return; }
    // 等全部树杀完成再清引用回帧（execSync 时期循环内同步完成；异步化后计数收尾）
    for (var i = 0; i < ids.length; i++) {
        stopSingle(ids[i], function () {
            remaining--;
            if (remaining === 0) finish();
        });
    }
}

// ========== 注册外部 MCP 路由处理器（ext_* 消息族）==========

// ext-mcp-relay 必须先于 MCP 处理器注册：_client_disconnected 事件 relay 返回 false
// 继续流转到 MCP 处理器，两个模块各自清理自己的 socket 表，互不遗漏。
var extMcpRelay = require('./ext-mcp-relay.js').createExtMcpRelay(bridge);
bridge.addWsHandler(function (msg, socket) {
    return extMcpRelay.handle(msg, socket);
});
// /health 诊断信息：外部客户端数 / pending 路由数 / 面板在线态 / HTTP 端点统计
// progress = 累计心跳续期次数：长调用期间应持续增长——排查「外面判超时、
// 里面还在跑」这类口径问题前，先看这个数有没有在动
bridge.setExtMcpInfoProvider(function () {
    return {
        clients: extMcpRelay.extClientCount(),
        pending: extMcpRelay.pendingCount(),
        progress: extMcpRelay.progressCount(),
        panelOnline: extMcpRelay.panelOnline(),
        http: extMcpHttp ? extMcpHttp.getStats() : null
    };
});

// Streamable HTTP /mcp 端点：remote 型客户端接入，经 relay 虚拟
// 通道往返面板（无 WS 连接、无 elicitation 通道——需确认操作默认拒绝）
var extMcpHttp = require('./ext-mcp-http.js').createExtMcpHttpHandler(extMcpRelay, { log: bridge.log });
bridge.setExtMcpHttpHandler(extMcpHttp.handle);

// ========== 注册 MCP WebSocket 处理器 ==========

// 面板 socket 重绑：发送 MCP 控制消息（spawn/send/stop/stopAll/diagnostics）的连接即面板。
// 若在 _client_connected 时无条件把全部子进程 socket 重绑到最新连接（假设唯一 WS 客户端
// 是面板）——ext-mcp-server 等其他 WS 客户端连入会抢走子进程绑定，MCP 响应错投到外部进程。
// 改为控制消息入口重绑：面板重载后首个 MCP 消息即恢复绑定；外部进程不发这些 type，天然隔离。
function rebindPanelSocket(socket) {
    var ids = Object.keys(processes);
    for (var i = 0; i < ids.length; i++) {
        var p = processes[ids[i]];
        if (p && p.socket !== socket) {
            p.socket = socket;
            log(ids[i] + ' socket reattached to requesting client');
        }
    }
}

bridge.addWsHandler(function (msg, socket) {
    // _client_connected：连接时尚不知客户端身份（ext_register/ext_panel_hello 在欢迎帧之后
    // 才到达），不做任何绑定——由控制消息入口重绑（见 rebindPanelSocket）。
    // 返回 true 消费事件：全 false 会落回 handleWebSocketMessage 的 Unknown 兜底分支
    if (msg.type === '_client_connected') {
        return true;
    }

    // _client_disconnected 事件：清理 socket 引用（保持子进程存活以便重连）。
    // ext-mcp-relay 先于本处理器注册、已清理过自己的表；此处 return true 终结流转
    if (msg.type === '_client_disconnected') {
        var ids2 = Object.keys(processes);
        for (var j = 0; j < ids2.length; j++) {
            var proc = processes[ids2[j]];
            if (proc && proc.socket === socket) {
                proc.socket = null;
            }
        }
        return true;
    }

    // MCP 消息路由（入口重绑面板 socket）
    switch (msg.type) {
        case 'spawn':
            rebindPanelSocket(socket);
            handleSpawn(msg, socket);
            return true;
        case 'send':
            rebindPanelSocket(socket);
            handleSend(msg, socket);
            return true;
        case 'stop':
            rebindPanelSocket(socket);
            handleStop(msg, socket);
            return true;
        case 'stopAll':
            rebindPanelSocket(socket);
            handleStopAll(msg, socket);
            return true;
        case 'diagnostics':
            rebindPanelSocket(socket);
            sendFrame(socket, Buffer.from(JSON.stringify({
                type: 'diagnostics',
                activeProcesses: Object.keys(processes).length,
                nodeVersion: process.version,
                platform: process.platform
            })));
            return true;
    }

    return false; // 未处理，交给下一个 handler
});

// ========== 启动前注册退出清理钩子 ==========

bridge.registerBeforeExitHook(function () {
    var ids = Object.keys(processes);
    log('Bridge exiting: cleaning up ' + ids.length + ' MCP child process(es)...');
    // 注：taskkill 已异步化，此处 fire-and-forget 依然可靠——uv_spawn 同步完成进程
    // 创建，taskkill 是独立 OS 进程（node 退出不连带杀它），bridge 的 gracefulExit 留有
    // 500ms 窗口，树杀在 node 退出后仍会完成。
    for (var i = 0; i < ids.length; i++) {
        stopSingle(ids[i]);
    }
    processes = {};
    serverConfigs = {};
});

// ========== 启动 ==========

bridge.start(function (err) {
    if (err) {
        console.error('[AE Bridge] Failed to start: ' + err.message);
        process.exit(1);
    }
});
