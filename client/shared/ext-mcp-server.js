/**
 * ext-mcp-server.js — AS_ExtP 对外 MCP Server（stdio 传输）
 *
 * 由外部 Agent 软件（Claude Code / Cursor / VS Code Copilot 等）按其 MCP 配置拉起：
 *   command: node <项目>/client/shared/ext-mcp-server.js [--name <客户端名>]
 *
 * 链路：
 *   外部 Agent ⇄ (stdio ndjson JSON-RPC 2.0) ⇄ 本进程 ⇄ (WS) ⇄ Bridge(ext-mcp-relay)
 *   ⇄ 面板 ext_dispatch ⇄ toolExecutor('external-mcp') ⇄ AE
 *
 * 协议面（MCP 2025-06 起的规范版本，更早版本按子集兼容）：
 *   - initialize：回 capabilities（tools + elicitation）+ instructions（external-guidelines.js）
 *   - tools/list：经 relay 向面板拉取白名单投影（组开关 + per-tool 开关过滤后）
 *   - tools/call：两阶段——ext_check（面板判定是否需确认）→ 需确认且客户端支持
 *     elicitation 则 elicitation/create 软件内确认（60s 超时按拒绝处理）→ ext_call 执行
 *   - 不支持 elicitation 的客户端：需确认操作默认拒绝（确认门无人应答不得放行；
 *     用户显式跳过的出口是面板外接设置切 auto 档）
 *   - notifications/tools/list_changed：relay 推送 ext_tools_changed 时转发给客户端；
 *     面板上线（panelOnline false→true，含注册即在线）同样补发——AE 未开时严格客户端
 *     的首次 tools/list 只会拿到 BRIDGE_OFFLINE，无此通知则永远显示无工具
 *
 * 连接策略：initialize 不依赖 Bridge（离线可握手）；tools/list/call 需 Bridge+面板在线，
 *   否则回结构化错误。Bridge 端口发现：9877-9886 逐个 /health 探测（对齐面板侧 bridge.js），
 *   且只认「有活面板的桥」——extMcp.panelOnline 为假即跳过，旧桥无该字段回退 ext_registered
 * 校验（防绑到无面板的孤儿桥后所有调用落 PANEL_OFFLINE）。
 *
 * 执行模型：tools/call 走进程内 FIFO 队列串行（AE evalScript 单线程，串行是硬约束）；
 *   initialize/ping/tools/list 等非执行类请求即时处理不入队。
 */

'use strict';

var path = require('path');
var net = require('net');
var http = require('http');
var crypto = require('crypto');

// 内联图片提升的单点实现住在 shared/imageTranscode.js：它与面板侧转码
// 是同一条图片投递链的相邻两环（形状认知必须一致），stdio（本文件）与 bridge 内嵌 HTTP
// （ext-mcp-http.js）两个 Node 通道共用同一实现，保证同一 content 经两通道逐字节一致。
var hoistInlineImages = require('./imageTranscode.js').hoistInlineImages;

var PROJECT_ROOT = path.resolve(__dirname, '../..');

// ── vendor 依赖路径对齐（与 ae-bridge.js 同款，本进程目前无 npm 依赖，保底声明）──
var VENDOR_NODE_MODULES = path.join(PROJECT_ROOT, 'vendor', 'node_modules');
if (!process.env.NODE_PATH) {
    process.env.NODE_PATH = VENDOR_NODE_MODULES;
} else if (process.env.NODE_PATH.indexOf(VENDOR_NODE_MODULES) === -1) {
    process.env.NODE_PATH = VENDOR_NODE_MODULES + path.delimiter + process.env.NODE_PATH;
}

// ════════════════════════════════════════════════════════
//  常量与工具
// ════════════════════════════════════════════════════════

var SERVER_NAME = 'as-extp';
var SERVER_VERSION = '1.0.0';
var SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
var DEFAULT_PROTOCOL_VERSION = '2025-06-18';

var BRIDGE_HOST = '127.0.0.1';
var BRIDGE_PORT_RANGE = 10;          // 9877..9886，对齐 bridge-server start() 的 maxPort
var BRIDGE_RECONNECT_MS = 5000;      // Bridge 离线重连间隔
var RELAY_TIMEOUT_MS = 100 * 1000;   // relay 往返超时（面板有 ext_progress 心跳时按心跳续期；
                                     // 绝对上限由 relay 侧兜底——见 ext-mcp-relay.js 双闸门）
var ELICITATION_TIMEOUT_MS = 60 * 1000;   // 确认等待超时（超时后按「未确认=拒绝」回错误）
var BRIDGE_READY_WAIT_MS = 5 * 1000;   // 首次 Bridge 连接的等待上限（客户端启动竞态，见 waitForBridge）
var BRIDGE_READY_POLL_MS = 50;         // 等待轮询间隔
var LEGACY_VERIFY_TIMEOUT_MS = 2000;   // 旧桥（无 extMcp 字段）面板兜底校验超时，对齐 /health 单端口探测的 2s

var clientId = 'ext-' + process.pid + '-' + Date.now().toString(36);
var clientName = 'unknown';

// 命令行参数：--name <客户端名>（外部 Agent 配置里可标识自己，仅用于日志/展示）
(function parseArgs() {
    var argv = process.argv.slice(2);
    for (var i = 0; i < argv.length; i++) {
        if (argv[i] === '--name' && argv[i + 1]) {
            clientName = String(argv[i + 1]).slice(0, 64);
            i++;
        }
    }
})();

function log() {
    try {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[ext-mcp ' + clientId + ']');
        console.error.apply(console, args);   // stderr：stdout 是协议通道，日志禁入
    } catch (_) {}
}

// ════════════════════════════════════════════════════════
//  stdio JSON-RPC（MCP stdio 传输 = ndjson）
// ════════════════════════════════════════════════════════

var initialized = false;             // 收到 notifications/initialized 后为真
var clientSupportsElicitation = false;
var negotiatedVersion = DEFAULT_PROTOCOL_VERSION;
var _rpcIdSeq = 0;

function rpcResult(id, result) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, result: result }) + '\n');
}

function rpcError(id, code, message) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: id, error: { code: code, message: message } }) + '\n');
}

function rpcNotify(method, params) {
    var frame = { jsonrpc: '2.0', method: method };
    if (params !== undefined) frame.params = params;
    process.stdout.write(JSON.stringify(frame) + '\n');
}

function newLocalId() {
    _rpcIdSeq++;
    return clientId + '-' + _rpcIdSeq;   // 全局唯一前缀，防多 ext 进程 requestId 撞车
}

// 内联图片提升实现在 shared/imageTranscode.js（hoistInlineImages）——见文件顶部的 require 注释。
// 本文件只在 tools/call 结果下行时调用它。

// ════════════════════════════════════════════════════════
//  最小 WebSocket 客户端（RFC 6455，无 ws 依赖）
// ════════════════════════════════════════════════════════

var WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function WsClient(host, port) {
    this.host = host;
    this.port = port;
    this.socket = null;
    this.frameBuffer = Buffer.alloc(0);
    this.handshakeDone = false;
    this.onMessage = null;     // fn(payloadString)
    this.onClose = null;       // fn()
}

// 客户端→服务端帧必须 mask（RFC 6455 5.1 节）
WsClient.prototype._encodeFrame = function (payload) {
    var len = payload.length;
    var mask = crypto.randomBytes(4);
    var header;
    if (len < 126) {
        header = Buffer.alloc(2);
        header[1] = 0x80 | len;
    } else if (len < 65536) {
        header = Buffer.alloc(4);
        header[1] = 0x80 | 126;
        header.writeUInt16BE(len, 2);
    } else {
        header = Buffer.alloc(10);
        header[1] = 0x80 | 127;
        header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x81;   // FIN + text
    var masked = Buffer.alloc(len);
    for (var i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
    return Buffer.concat([header, mask, masked]);
};

// 服务端→客户端帧不带 mask（bridge-server sendFrame 同款格式）
WsClient.prototype._decodeFrame = function (buf) {
    if (buf.length < 2) return null;
    var opcode = buf[0] & 0x0f;
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
    if (len > 32 * 1024 * 1024) throw new Error('Frame too large: ' + len);
    if (buf.length < offset + len) return null;
    var payload = buf.slice(offset, offset + len);
    var remaining = buf.slice(offset + len);
    return { opcode: opcode, payload: payload, remaining: remaining };
};

WsClient.prototype.send = function (obj) {
    if (!this.socket || !this.handshakeDone) return false;
    try {
        this.socket.write(this._encodeFrame(Buffer.from(JSON.stringify(obj))));
        return true;
    } catch (e) {
        log('ws send failed: ' + (e && e.message));
        return false;
    }
};

WsClient.prototype.close = function () {
    if (this.socket) {
        try { this.socket.destroy(); } catch (_) {}
        this.socket = null;
    }
    this.handshakeDone = false;
};

WsClient.prototype.connect = function (cb) {
    var self = this;
    var socket = net.connect(this.port, this.host);
    self.socket = socket;

    var key = crypto.randomBytes(16).toString('base64');
    // /ext-ws：外接模式专用 upgrade 路径（H1 token 鉴权豁免——本进程由外部 Agent
    // 拉起，无 evalScript 通道获取 token；协议面限定 ext_* 消息族，与 /mcp 同构）
    var handshake =
        'GET /ext-ws HTTP/1.1\r\n' +
        'Host: ' + this.host + ':' + this.port + '\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        'Sec-WebSocket-Key: ' + key + '\r\n' +
        'Sec-WebSocket-Version: 13\r\n' +
        '\r\n';

    var hsBuffer = Buffer.alloc(0);

    socket.on('connect', function () {
        socket.write(handshake);
    });

    socket.on('data', function (data) {
        if (!self.handshakeDone) {
            // 握手响应阶段：累积到 \r\n\r\n
            hsBuffer = Buffer.concat([hsBuffer, data]);
            var idx = hsBuffer.indexOf('\r\n\r\n');
            if (idx === -1) {
                if (hsBuffer.length > 8192) { socket.destroy(); if (cb) cb(new Error('handshake response too large')); }
                return;
            }
            var head = hsBuffer.slice(0, idx).toString();
            if (head.indexOf('101') === -1) {
                socket.destroy();
                if (cb) cb(new Error('ws handshake rejected: ' + head.split('\r\n')[0]));
                return;
            }
            // 校验 Sec-WebSocket-Accept（防连到非 WS 服务）
            var expect = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
            if (head.indexOf(expect) === -1) {
                socket.destroy();
                if (cb) cb(new Error('ws handshake accept mismatch'));
                return;
            }
            self.handshakeDone = true;
            var rest = hsBuffer.slice(idx + 4);
            if (cb) cb(null);
            if (rest.length) self._onData(rest);
            return;
        }
        self._onData(data);
    });

    socket.on('error', function (err) {
        if (!self.handshakeDone && cb) cb(err);
    });

    socket.on('close', function () {
        var wasDone = self.handshakeDone;
        self.handshakeDone = false;
        self.socket = null;
        if (wasDone && self.onClose) self.onClose();
    });
};

WsClient.prototype._onData = function (data) {
    var self = this;
    self.frameBuffer = Buffer.concat([self.frameBuffer, data]);
    while (true) {
        var frame;
        try {
            frame = self._decodeFrame(self.frameBuffer);
        } catch (e) {
            log('frame decode error: ' + e.message);
            if (self.socket) self.socket.destroy();
            return;
        }
        if (!frame) break;
        self.frameBuffer = frame.remaining;
        if (frame.opcode === 0x9) {          // ping → pong
            try { self.socket.write(Buffer.from([0x8A, 0x00])); } catch (_) {}
        } else if (frame.opcode === 0x8) {   // close
            try { self.socket.destroy(); } catch (_) {}
        } else if (frame.opcode === 0x1 || frame.opcode === 0x2) {
            if (self.onMessage) {
                try { self.onMessage(frame.payload.toString()); } catch (e) { log('onMessage error: ' + e.message); }
            }
        }
        // 0x0 continuation / 0xA pong：忽略（Bridge 不分片不发 ping）
    }
};

// ════════════════════════════════════════════════════════
//  Bridge 连接管理（端口发现 + 重连）
// ════════════════════════════════════════════════════════

var ws = null;
var wsConnected = false;
var panelOnline = false;
var reconnectTimer = null;
var relayPending = {};     // requestId → { resolve, reject, timer }
var firstConnectAttempted = false;   // connectBridge 是否已启动过（区分首次尝试与后续重连）
var firstConnectPending = false;     // 首次连接尝试进行中（tools 请求等待窗口的开启条件）

// 探测单个端口的 /health：回 null = 该端口不可用（连接失败/非 200/非本桥，与旧判据一致）；
// 可用则回 { panelOnline }——从 /health 的 extMcp.panelOnline 读取（bridge-server.js
// routeHttp 的 ext-mcp 诊断字段，ext-mcp-relay.js panelOnline() 同一真相源）。
// 三态：true / false / undefined（旧桥无 extMcp 字段——判定交 findBridgePort 兜底）。
// 额外成本：对同一个响应体多做一次 JSON.parse（数百字节），不新增 HTTP 往返，
// 候选端口的探测预算不变。
function probeHealth(port, cb) {
    var req = http.get({ host: BRIDGE_HOST, port: port, path: '/health', timeout: 2000 }, function (res) {
        var body = '';
        res.on('data', function (c) { body += c; });
        res.on('end', function () {
            if (res.statusCode !== 200 || body.indexOf('"ok"') === -1) { cb(null); return; }
            var parsed = null;
            try { parsed = JSON.parse(body); } catch (_) {}
            var po = (parsed && parsed.extMcp && typeof parsed.extMcp.panelOnline === 'boolean')
                ? parsed.extMcp.panelOnline : undefined;
            cb({ panelOnline: po });
        });
    });
    req.on('error', function () { cb(null); });
    req.on('timeout', function () { req.destroy(); cb(null); });
}

// 旧桥兜底校验：候选端口无 extMcp 字段时，用既有 WS 能力读面板在线态——
// 连 /ext-ws 发 ext_register，relay 注册成功即回 ext_registered {panelOnline}
// （ext-mcp-relay.js:286）。回 false（连不上/超时/桥不认 ext_register）即「确认不了有活
// 面板」→ 该端口不选用，继续探测后续候选。成本：仅此兜底路径多一跳 WS 握手 + 一次注册
// 往返（上限 LEGACY_VERIFY_TIMEOUT_MS，对齐 /health 的 2s 单端口预算）；新桥走 /health
// 快路径不受影响。注册 id 带 -probe 后缀，不占用真实 clientId（桥侧 extClients 表按
// 连接生命周期清理，收线即注销）。
function verifyPanelOnline(port, cb) {
    var probe = new WsClient(BRIDGE_HOST, port);
    var settled = false;
    var timer = setTimeout(function () { finish(false); }, LEGACY_VERIFY_TIMEOUT_MS);
    function finish(online) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        probe.close();      // 判定落定即收线（close 置 handshakeDone=false，不再回调 onClose）
        cb(online);
    }
    probe.onMessage = function (payload) {
        var msg;
        try { msg = JSON.parse(payload); } catch (_) { return; }
        if (msg && msg.type === 'ext_registered') finish(msg.panelOnline === true);
    };
    probe.onClose = function () { finish(false); };
    probe.connect(function (err) {
        if (err) { finish(false); return; }
        probe.send({ type: 'ext_register', clientId: clientId + '-probe', clientName: 'port-probe' });
    });
}

// 端口发现（9877..9886，对齐面板侧 bridge.js）。只取「首个
// /health 响应者」——本机存在无面板的孤儿桥（上一会话残留/手工启动的 bridge-server）时会
// 绑错，之后所有外接调用落到 PANEL_OFFLINE。现在候选端口还要过「面板在线」门：
//   - panelOnline === false：该桥确认自己无面板 → 跳过，继续探测后续端口；
//   - panelOnline === true：选用（单实例正常场景=首个候选即选，行为/错误码不变）；
//   - 无该字段（旧桥）：verifyPanelOnline 用既有 WS 注册能力轻校验，确认不了则跳过。
// 全部候选都不过 → cb(null)，走既有「bridge offline, retry in 5s」重连语境（不新增死路文案）。
// deps（端口表 + 两个探测函数）仅为测试注入点：行为级回归在不起真 socket 的前提下驱动
// 三段判定，生产调用不传（connectBridge 即单参调用）。
function findBridgePort(cb, deps) {
    deps = deps || {};
    var ports = deps.ports;
    if (!ports) {
        ports = [];
        for (var p = 9877; p < 9877 + BRIDGE_PORT_RANGE; p++) ports.push(p);
    }
    var probe = deps.probeHealth || probeHealth;
    var verifyPanel = deps.verifyPanel || verifyPanelOnline;
    var idx = 0;
    function next() {
        if (idx >= ports.length) { cb(null); return; }
        var port = ports[idx++];
        probe(port, function (health) {
            if (!health) { next(); return; }
            if (health.panelOnline === false) {
                log('port ' + port + ': bridge has no panel online, skipping');
                next();
                return;
            }
            if (health.panelOnline === true) { cb(port); return; }
            verifyPanel(port, function (online) {
                if (online) { cb(port); return; }
                log('port ' + port + ': panel not confirmed via ext_registered, skipping');
                next();
            });
        });
    }
    next();
}

function connectBridge() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    // 首次尝试标记：进行中开启 tools 请求等待窗口（waitForBridge），任一路径落定即关闭
    var isFirst = !firstConnectAttempted;
    firstConnectAttempted = true;
    if (isFirst) firstConnectPending = true;
    findBridgePort(function (port) {
        if (!port) {
            if (isFirst) firstConnectPending = false;
            log('bridge offline, retry in ' + (BRIDGE_RECONNECT_MS / 1000) + 's');
            reconnectTimer = setTimeout(connectBridge, BRIDGE_RECONNECT_MS);
            return;
        }
        ws = new WsClient(BRIDGE_HOST, port);
        ws.onMessage = onRelayMessage;
        ws.onClose = function () {
            wsConnected = false;
            panelOnline = false;
            failAllRelayPending('BRIDGE_DISCONNECTED: Bridge connection lost');
            log('bridge ws closed, reconnect in ' + (BRIDGE_RECONNECT_MS / 1000) + 's');
            reconnectTimer = setTimeout(connectBridge, BRIDGE_RECONNECT_MS);
        };
        ws.connect(function (err) {
            if (isFirst) firstConnectPending = false;
            if (err) {
                log('bridge ws connect failed: ' + err.message);
                reconnectTimer = setTimeout(connectBridge, BRIDGE_RECONNECT_MS);
                return;
            }
            wsConnected = true;
            log('bridge connected on port ' + port);
            // 注册身份 → relay 回 ext_registered（含面板在线态）
            ws.send({ type: 'ext_register', clientId: clientId, clientName: clientName });
        });
    });
}

// ── Bridge 就绪等待（启动竞态修复）──
// 客户端拉起本进程后 initialize→initialized→tools/list 毫秒级连发，而 connectBridge 的
// 端口探测 + WS 握手需数十 ms；首次尝试进行中时等待其落定而非立即拒绝（最长 BRIDGE_READY_WAIT_MS）。
// 非等待窗口（已连上 / connectBridge 从未启动（require 测试场景）/ 首次尝试已落定）立即
// 返回当前态——重连窗口中的调用与测试微任务级联语义保持不变。
function waitForBridge() {
    return new Promise(function (resolve) {
        if (wsConnected || !firstConnectPending) { resolve(wsConnected); return; }
        var waited = 0;
        var iv = setInterval(function () {
            if (wsConnected || !firstConnectPending) { clearInterval(iv); resolve(wsConnected); return; }
            waited += BRIDGE_READY_POLL_MS;
            if (waited >= BRIDGE_READY_WAIT_MS) { clearInterval(iv); resolve(false); }
        }, BRIDGE_READY_POLL_MS);
    });
}

// ── relay 往返请求（带超时的 promise 化）──
// 等待计时按条续期（ext_progress 心跳）：长渲染/长脚本期间面板每 ~20s 报一次进展，
// 这里重置同一条的定时器——否则固定的 100s 会先把 promise reject 掉，relay 还在等、
// 面板还在跑，外面却已经拿到「超时」。绝对上限由 relay 侧 30min 兜底。
function armRelayTimeout(rid) {
    var entry = relayPending[rid];
    if (!entry) return;
    clearTimeout(entry.timer);
    var ms = entry.timeoutMs || RELAY_TIMEOUT_MS;
    entry.timer = setTimeout(function () {
        delete relayPending[rid];
        // 超时错误如实说明「可能仍在执行」——AE evalScript 不可取消，面板侧
        // 可能已收到派发并执行中，仅回包迟到。提示外部 Agent 勿盲目重试造成重复副作用
        entry.reject(new Error('RELAY_TIMEOUT: no response within ' + (ms / 1000) +
            's（面板可能仍在执行本调用，请先查询确认结果，勿盲目重试）'));
    }, ms);
}

function relayRequest(frame, timeoutMs) {
    return new Promise(function (resolve, reject) {
        if (!wsConnected || !ws) {
            reject(new Error('BRIDGE_OFFLINE: Bridge is not connected'));
            return;
        }
        var rid = frame.requestId;
        frame.clientId = clientId;
        if (!ws.send(frame)) {
            reject(new Error('BRIDGE_OFFLINE: Bridge connection lost'));
            return;
        }
        relayPending[rid] = { resolve: resolve, reject: reject, timer: null, timeoutMs: timeoutMs || RELAY_TIMEOUT_MS };
        armRelayTimeout(rid);
    });
}

function settleRelay(rid, err, result) {
    var entry = relayPending[rid];
    if (!entry) return;
    delete relayPending[rid];
    clearTimeout(entry.timer);
    if (err) entry.reject(new Error(err));
    else entry.resolve(result);
}

function failAllRelayPending(message) {
    var ids = Object.keys(relayPending);
    for (var i = 0; i < ids.length; i++) settleRelay(ids[i], message, null);
}

// ── relay → 本进程 消息分发 ──
// 工具清单变更通知单点（复用既有构造与发送路径）：
//   ① relay 推送 ext_tools_changed（面板策略变更）；
//   ② 面板上线（panelOnline false→true，含注册即在线）——AE 未开时客户端 tools/list
//      只会拿到 BRIDGE_OFFLINE，严格客户端只认 notifications/tools/list_changed，
//      不补发就永远显示无工具。重复上线（relay 每次 hello 都广播
//      状态）由跳变判定挡掉，不刷屏；initialize 握手前不发。
function notifyToolsListChanged() {
    if (initialized) rpcNotify('notifications/tools/list_changed');
}

function onRelayMessage(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { log('bad relay json: ' + text.slice(0, 80)); return; }
    var prevPanelOnline;
    switch (msg.type) {
        case 'ext_registered':
            prevPanelOnline = panelOnline;
            panelOnline = !!msg.panelOnline;
            log('registered at relay, panelOnline=' + panelOnline);
            // 注册即在线（面板 hello 早于本客户端接入，如客户端后于面板重连）：
            // 补发一次，覆盖「先失败过一次 tools/list 的严格客户端」
            if (panelOnline && !prevPanelOnline) notifyToolsListChanged();
            return;
        case 'ext_panel_status':
            prevPanelOnline = panelOnline;
            panelOnline = !!msg.online;
            log('panel status: online=' + panelOnline);
            if (panelOnline && !prevPanelOnline) notifyToolsListChanged();
            return;
        case 'ext_progress':
            // 面板心跳：该调用仍在执行 → 续期本条等待计时（relay 已先行续期其 pending）
            if (msg.requestId && relayPending[msg.requestId]) {
                log('progress: ' + msg.requestId + ' still running, wait extended');
                armRelayTimeout(msg.requestId);
            }
            return;
        case 'ext_tools_response':
            settleRelay(msg.requestId, msg.ok === false ? (msg.error || 'tools query failed') : null, msg);
            return;
        case 'ext_check_result':
            settleRelay(msg.requestId, msg.ok === false ? (msg.error || 'check failed') : null, msg);
            return;
        case 'ext_call_result':
            settleRelay(msg.requestId, msg.ok === false ? (msg.error || 'call failed') : null, msg);
            return;
        case 'ext_tools_changed':
            notifyToolsListChanged();
            return;
        case 'connected':   // Bridge 欢迎帧，忽略
            return;
    }
}

// ════════════════════════════════════════════════════════
//  elicitation（确认弹在 Agent 软件内，MCP 2025-06-18 规范）
// ════════════════════════════════════════════════════════

var elicitationPending = {};   // id → { resolve, timer }

function requestElicitation(message) {
    return new Promise(function (resolve) {
        if (!clientSupportsElicitation) { resolve('unsupported'); return; }
        var id = newLocalId();
        var timer = setTimeout(function () {
            delete elicitationPending[id];
            resolve('timeout');           // 超时按未确认处理（拒绝执行）
        }, ELICITATION_TIMEOUT_MS);
        elicitationPending[id] = { resolve: resolve, timer: timer };
        process.stdout.write(JSON.stringify({
            jsonrpc: '2.0',
            id: id,
            method: 'elicitation/create',
            params: {
                message: message,
                requestedSchema: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        }) + '\n');
    });
}

function settleElicitation(id, action) {
    var entry = elicitationPending[id];
    if (!entry) return;
    delete elicitationPending[id];
    clearTimeout(entry.timer);
    entry.resolve(action === 'accept' ? 'accept' : 'decline');
}

// ════════════════════════════════════════════════════════
//  MCP 方法实现
// ════════════════════════════════════════════════════════

function getInstructions() {
    try {
        var g = require('./external-guidelines.js');
        if (g && typeof g.getInstructions === 'function') return g.getInstructions();
        if (g && typeof g.INSTRUCTIONS === 'string') return g.INSTRUCTIONS;
    } catch (e) {
        log('external-guidelines load failed: ' + e.message);
    }
    return '';
}

function handleInitialize(id, params) {
    params = params || {};
    var caps = params.capabilities || {};
    clientSupportsElicitation = !!(caps.elicitation && (caps.elicitation.create !== false));
    // 版本协商：客户端请求版本在支持清单内则跟随，否则回落默认（协议允许服务端回自己的版本）
    var requested = params.protocolVersion;
    if (requested && SUPPORTED_VERSIONS.indexOf(requested) >= 0) negotiatedVersion = requested;
    rpcResult(id, {
        protocolVersion: negotiatedVersion,
        capabilities: {
            tools: { listChanged: true },
            elicitation: {}
        },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        instructions: getInstructions()
    });
}

function handleToolsList(id) {
    waitForBridge()
        .then(function (ready) {
            if (!ready) throw new Error('BRIDGE_OFFLINE: Bridge is not connected');
            return relayRequest({ type: 'ext_tools_query', requestId: newLocalId() });
        })
        .then(function (res) {
            rpcResult(id, { tools: res.tools || [] });
        })
        .catch(function (err) {
            rpcError(id, -32003, err.message);
        });
}

// tools/call 主链：check → (elicitation) → call；done 在终态输出后回调（FIFO 放行）
function runToolsCall(id, params, done) {
    params = params || {};
    var toolName = params.name;
    var args = params.arguments || {};
    if (!toolName) { rpcError(id, -32602, 'params.name required'); done(); return; }

    var confirmReason = '';
    var confirmState = '';   // ''=无需确认 / 'granted'=用户已确认（'skipped' 已随 unsupported 收紧退役，relay/面板侧兼容保留）
    waitForBridge()
        .then(function (ready) {
            if (!ready) throw new Error('BRIDGE_OFFLINE: Bridge is not connected');
            return relayRequest({ type: 'ext_check', requestId: newLocalId(), clientId: clientId, tool: toolName, args: args });
        })
        .then(function (check) {
            if (!check.confirm) return 'pass';        // 无需确认，直接执行
            confirmReason = check.reason || '';
            // 需确认 → elicitation（客户端不支持/拒绝/超时均不执行）
            return requestElicitation(
                '外部工具调用确认：' + toolName + (confirmReason ? '\n' + confirmReason : '') +
                '\n来源：' + clientName + '（经 AS_ExtP 外接模式）'
            ).then(function (action) {
                if (action === 'accept') { confirmState = 'granted'; return 'pass'; }
                if (action === 'unsupported') {
                    // 客户端不支持 elicitation → 默认拒绝——
                    // balanced 档确认门的承诺是「高危操作有人把关」，无人应答不得静默
                    // 放行（无人应答即静默放行在 HTTP 面同样是破洞）。用户
                    // 显式授权跳过的出口是面板外接设置切 auto 档，而非客户端能力缺失
                    // 自动降级。留痕通道（confirm='skipped'）随之退役，relay/面板侧
                    // 兼容保留（旧版本进程升级窗口内仍可能发）。
                    log('confirm required but client lacks elicitation support, DENYING: ' + toolName);
                    throw new Error('CONFIRM_REQUIRED: 工具「' + toolName + '」需要用户确认'
                        + (confirmReason ? '（' + confirmReason + '）' : '')
                        + '，但当前客户端不支持确认交互（elicitation），已默认拒绝。'
                        + '请在面板外接设置切换 auto 档（显式授权全部放行）、改用支持确认的 MCP 客户端，或在面板中直接使用该工具。');
                }
                if (action === 'timeout') throw new Error('CONFIRM_TIMEOUT: 用户未在 ' + (ELICITATION_TIMEOUT_MS / 1000) + 's 内确认，已取消执行');
                throw new Error('USER_REJECTED: 用户拒绝了本次工具调用');
            });
        })
        .then(function (go) {
            if (go !== 'pass') throw new Error('INTERNAL: unexpected flow state');
            var frame = { type: 'ext_call', requestId: newLocalId(), tool: toolName, args: args };
            if (confirmState) frame.confirm = confirmState;   // 面板日志/toast 留痕
            return relayRequest(frame);
        })
        .then(function (res) {
            // 面板回包：result 为 toolExecutor 的 mcpResult 形态 { success, isError, content }
            var r = res.result;
            var content;
            if (r && Array.isArray(r.content)) {
                content = r.content;
            } else if (r && typeof r === 'object') {
                content = [{ type: 'text', text: JSON.stringify(r, null, 2) }];
            } else {
                content = [{ type: 'text', text: String(r) }];
            }
            // 内联图片（getShaderPreview/getPreviewFrame/analyzeImage 抓帧模式的 imageDataUrl）
            // 提升为 MCP image block：否则整幅 base64 作为纯文本下行，撞客户端结果预算被截断。
            // 实现在 shared/imageTranscode.js，与 HTTP 通道（ext-mcp-http.js）共用同一单点。
            rpcResult(id, { content: hoistInlineImages(content, log), isError: !!(r && r.isError === true) });
        })
        .catch(function (err) {
            stats.totalErrors++;
            rpcResult(id, {
                content: [{ type: 'text', text: 'ERROR: ' + (err && err.message ? err.message : String(err)) }],
                isError: true
            });
        })
        .then(function () { done(); });   // 终态输出完毕，放行队列下一个
}

// ════════════════════════════════════════════════════════
//  stdio 入站分发 + tools/call FIFO 队列
// ════════════════════════════════════════════════════════

var MAX_PENDING_CALLS = 32;   // 排队上限（防恶意客户端无限堆积占满队列）
var callQueue = [];
var callBusy = false;

// 诊断计数器（排队诊断）：日志输出 + 测试断言 + 诊断面板数据源
var stats = { totalCalls: 0, rejectedCalls: 0, queuePeak: 0, totalErrors: 0 };

function getStats() {
    return {
        totalCalls: stats.totalCalls,
        rejectedCalls: stats.rejectedCalls,
        queuePeak: stats.queuePeak,
        totalErrors: stats.totalErrors,
        queueNow: callQueue.length,
        busy: callBusy,
        bridgeConnected: wsConnected,
        panelOnline: panelOnline
    };
}

function enqueueToolsCall(id, params) {
    stats.totalCalls++;
    if (callQueue.length >= MAX_PENDING_CALLS) {
        stats.rejectedCalls++;
        rpcResult(id, {
            content: [{ type: 'text', text: 'QUEUE_FULL: 排队已达上限 ' + MAX_PENDING_CALLS + '（AE 执行串行），请稍后重试' }],
            isError: true
        });
        return;
    }
    callQueue.push({ id: id, params: params });
    if (callQueue.length > stats.queuePeak) stats.queuePeak = callQueue.length;
    drainCallQueue();
}

function drainCallQueue() {
    if (callBusy || callQueue.length === 0) return;
    callBusy = true;
    var item = callQueue.shift();
    // 串行保证：runToolsCall 终态输出后 done 放行下一个（AE evalScript 单线程硬约束）
    runToolsCall(item.id, item.params, function () {
        callBusy = false;
        drainCallQueue();
    });
}

function handleStdioLine(line) {
    var msg;
    try { msg = JSON.parse(line); } catch (e) { return; }   // 静默丢弃坏行（协议容错）
    if (!msg || typeof msg !== 'object' || !msg.method) {
        // 无 method 的帧只可能是对 elicitation/create 的响应（result.action）
        if (msg && msg.id !== undefined && elicitationPending[msg.id]) {
            var action = msg.result && msg.result.action;
            settleElicitation(msg.id, action);
        }
        return;
    }

    // notification（无 id）
    if (msg.id === undefined) {
        if (msg.method === 'notifications/initialized') initialized = true;
        return;
    }

    // request
    switch (msg.method) {
        case 'initialize':
            handleInitialize(msg.id, msg.params);
            return;
        case 'ping':
            rpcResult(msg.id, {});
            return;
        case 'tools/list':
            handleToolsList(msg.id);
            return;
        case 'tools/call':
            enqueueToolsCall(msg.id, msg.params);
            return;
        default:
            rpcError(msg.id, -32601, 'Method not found: ' + msg.method);
    }
}

// stdio 读入：按行切分（字节缓冲，防多字节 UTF-8 被 chunk 边界截断）。
// 仅主模块运行时接管（require 场景不挂 stdin 监听）
function startStdio() {
    var buffer = Buffer.alloc(0);
    process.stdin.on('data', function (data) {
        buffer = Buffer.concat([buffer, data]);
        var nl;
        while ((nl = buffer.indexOf(0x0A)) !== -1) {
            var line = buffer.slice(0, nl).toString().trim();
            buffer = buffer.slice(nl + 1);
            if (line) handleStdioLine(line);
        }
    });
    process.stdin.on('end', function () {
        log('stdin closed, exiting');
        process.exit(0);
    });
    process.stdin.on('error', function () { process.exit(0); });
}

// ════════════════════════════════════════════════════════
//  启动与导出
// ════════════════════════════════════════════════════════

// 外部 Agent 以主模块拉起时才自启（连 Bridge + 接管 stdio）；被 require（测试等）
// 时仅暴露内部件不自启——避免测试进程被重连定时器与 stdin 监听拖挂
if (require.main === module) {
    startStdio();
    connectBridge();
    log('ext-mcp-server started, clientName=' + clientName + ', pid=' + process.pid);
}

module.exports = {
    WsClient: WsClient,
    handleStdioLine: handleStdioLine,
    handleInitialize: handleInitialize,
    newLocalId: newLocalId,
    getStats: getStats,
    enqueueToolsCall: enqueueToolsCall,
    waitForBridge: waitForBridge,
    MAX_PENDING_CALLS: MAX_PENDING_CALLS,
    // 图片投递链末端：与 shared/imageTranscode.js 同一实现（对齐后输入可能是面板转码过的
    // JPEG，mime 推导必须跟着走），供行为级测试直接调用——与上方既有内部件同一「仅为测试暴露」口径。
    hoistInlineImages: hoistInlineImages,
    // 同上口径：心跳续期语义的行为级断言需直接投喂 relay 帧并检查 pending 表
    // （避免真等 RELAY_TIMEOUT_MS）。
    _onRelayMessage: onRelayMessage,
    _relayPending: function () { return relayPending; },
    _armRelayTimeout: armRelayTimeout,
    // 同上口径：端口发现的面板在线门用注入端口表/探测函数做行为级断言
    // （不起真 socket、不真等超时）；_probeHealth 直接对本地 /health 桩验字段读取。

    _findBridgePort: findBridgePort,
    _probeHealth: probeHealth
};
