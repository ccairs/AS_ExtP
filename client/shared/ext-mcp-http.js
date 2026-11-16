/**
 * ext-mcp-http.js — Bridge 内嵌 Streamable HTTP MCP 端点
 *
 * 形态：
 *   Bridge 的 HTTP server 加 /mcp 路由，外部 Agent 以 remote 型客户端接入
 *   （Claude Code / Cursor 等填 http://127.0.0.1:<port>/mcp）。零新进程，
 *   协议核心与 stdio 入口（ext-mcp-server.js）同构——差异仅在传输薄壳。
 *
 * 传输语义（MCP Streamable HTTP，无会话无 SSE 的最简合法形态）：
 *   - POST /mcp：单条 JSON-RPC 2.0 消息，回 application/json（规范允许服务端
 *     只回 JSON；不开 SSE 流）
 *   - 不下发 Mcp-Session-Id → 无会话状态，客户端每连接自行 initialize
 *   - GET /mcp（SSE 流）/ DELETE /mcp（会话终止）→ 405：无 SSE 即无服务端
 *     主动推送通道
 *   - 安全：Host/Origin 双校验由 bridge-server routeHttp 前置把守（非浏览器
 *     客户端无 Origin 头放行，浏览器 file:// 外一律拒）——与既有端点同防线
 *
 * 确认语义：
 *   无 SSE 通道 ⇒ 无法下发 elicitation/create ⇒ capabilities 不广告 elicitation。
 *   tools/call 的两阶段确认：面板判定需确认时默认拒绝（CONFIRM_REQUIRED，
 *   fail-closed）——HTTP 客户端无确认交互通道，跳过确认放行会让
 *   memory_delete / 资产删除等不可逆工具可经 POST /mcp 绕过用户确认执行。
 *
 * 执行模型：tools/call 走本模块 FIFO 队列串行（与 ext-mcp-server 同规——
 *   AE evalScript 单线程硬约束 + 排队上限防恶意堆积）；initialize/ping/
 *   tools/list 为非执行类，即时处理不入队。
 */

'use strict';

// 内联图片提升单点：与 stdio 通道（ext-mcp-server.js）共用同一实现——
// 两通道对同一面板回包 content 的转换结果必须逐字节一致。
var hoistInlineImages = require('./imageTranscode.js').hoistInlineImages;

var SERVER_NAME = 'as-extp';
var SERVER_VERSION = '1.0.0';
var SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
var DEFAULT_PROTOCOL_VERSION = '2025-06-18';

var MAX_PENDING_CALLS = 32;        // 排队上限（与 stdio 入口同值）
var MAX_BODY_SIZE = 4 * 1024 * 1024;   // JSON-RPC 单消息体上限（无二进制载荷场景的保守值）

function createExtMcpHttpHandler(relay, opts) {
    opts = opts || {};
    var log = opts.log || function () {};

    function getInstructions() {
        try {
            var g = require('./external-guidelines.js');
            if (g && typeof g.getInstructions === 'function') return g.getInstructions();
            if (g && typeof g.INSTRUCTIONS === 'string') return g.INSTRUCTIONS;
        } catch (e) {
            log('[ext-mcp-http] guidelines load failed: ' + (e && e.message));
        }
        return '';
    }

    var clientId = 'ext-http-' + Math.random().toString(36).slice(2, 10);
    var clientName = 'http-client';
    var _rpcIdSeq = 0;

    function newLocalId() {
        _rpcIdSeq++;
        return clientId + '-' + _rpcIdSeq;   // pending 表全局唯一前缀（与 WS 客户端空间隔离）
    }

    // ── tools/call FIFO（AE 执行串行 + 防堆积，对齐 ext-mcp-server）──
    var callQueue = [];
    var callBusy = false;
    var stats = { totalCalls: 0, rejectedCalls: 0, queuePeak: 0, totalErrors: 0 };

    function getStats() {
        return {
            totalCalls: stats.totalCalls,
            rejectedCalls: stats.rejectedCalls,
            queuePeak: stats.queuePeak,
            totalErrors: stats.totalErrors,
            queueNow: callQueue.length,
            busy: callBusy,
            panelOnline: relay.panelOnline()
        };
    }

    function enqueueToolsCall(id, params, reply) {
        stats.totalCalls++;
        if (callQueue.length >= MAX_PENDING_CALLS) {
            stats.rejectedCalls++;
            reply({
                jsonrpc: '2.0', id: id,
                result: {
                    content: [{ type: 'text', text: 'QUEUE_FULL: 排队已达上限 ' + MAX_PENDING_CALLS + '（AE 执行串行），请稍后重试' }],
                    isError: true
                }
            });
            return;
        }
        callQueue.push({ id: id, params: params, reply: reply });
        if (callQueue.length > stats.queuePeak) stats.queuePeak = callQueue.length;
        drainCallQueue();
    }

    function drainCallQueue() {
        if (callBusy || callQueue.length === 0) return;
        callBusy = true;
        var item = callQueue.shift();
        runToolsCall(item.id, item.params, item.reply, function () {
            callBusy = false;
            drainCallQueue();
        });
    }

    // tools/call 主链：check →（需确认即默认拒绝——HTTP 无 elicitation 通道，
    // 修复：跳过放行改 fail-closed）→ call；done 在终态输出后回调（FIFO 放行）
    function runToolsCall(id, params, reply, done) {
        params = params || {};
        var toolName = params.name;
        var args = params.arguments || {};
        if (!toolName) {
            reply({ jsonrpc: '2.0', id: id, error: { code: -32602, message: 'params.name required' } });
            done();
            return;
        }

        relay.requestVirtual({ type: 'ext_check', requestId: newLocalId(), clientId: clientId, tool: toolName, args: args })
            .then(function (check) {
                if (!check.ok) throw new Error(check.error || 'check failed');
                if (!check.confirm) return 'pass';
                // 需确认的高危操作在 HTTP 通道默认拒绝——
                // HTTP 客户端无 elicitation 通道，原「跳过确认放行」使 memory_delete /
                // 资产删除等不可逆工具可经 POST /mcp 绕过用户确认执行。
                log('[ext-mcp-http] confirm required but HTTP has no elicitation channel, DENYING: ' + toolName);
                throw new Error('CONFIRM_REQUIRED: 工具「' + toolName + '」需要用户确认'
                    + (check.reason ? '（' + check.reason + '）' : '')
                    + '，但 HTTP 通道不支持确认交互，已默认拒绝。请在面板中直接使用该工具，或改用支持确认的标准 MCP 客户端。');
            })
            .then(function (go) {
                if (go !== 'pass') throw new Error('INTERNAL: unexpected flow state');
                var frame = { type: 'ext_call', requestId: newLocalId(), clientId: clientId, tool: toolName, args: args };
                return relay.requestVirtual(frame);
            })
            .then(function (res) {
                if (!res.ok) throw new Error(res.error || 'call failed');
                // 面板回包：result 为 toolExecutor 的 mcpResult 形态 { success, isError, content }。
                // 内容构造与 stdio 通道（ext-mcp-server.js runToolsCall）逐字对齐——两通道对同一
                // content 的转换结果必须逐字节一致。
                var r = res.result;
                var content;
                if (r && Array.isArray(r.content)) {
                    content = r.content;
                } else if (r && typeof r === 'object') {
                    content = [{ type: 'text', text: JSON.stringify(r, null, 2) }];
                } else {
                    content = [{ type: 'text', text: String(r) }];
                }
                // 内联图片（getShaderPreview/getPreviewFrame 的 imageDataUrl）提升为 MCP image
                // block：HTTP 通道原样透传 r.content 时，整幅 base64 作为纯文本下行撞客户端
                // 结果预算被截断、图片进不了视觉通道（该缺陷 stdio 侧同款，两通道处理一致）。
                reply({ jsonrpc: '2.0', id: id, result: { content: hoistInlineImages(content, log), isError: !!(r && r.isError === true) } });
            })
            .catch(function (err) {
                stats.totalErrors++;
                reply({
                    jsonrpc: '2.0', id: id,
                    result: {
                        content: [{ type: 'text', text: 'ERROR: ' + (err && err.message ? err.message : String(err)) }],
                        isError: true
                    }
                });
            })
            .then(function () { done(); });
    }

    // ── JSON-RPC 分发（单消息；MCP 2025-06-18 起无批量）──
    // reply(null) = notification → HTTP 层回 202 Accepted（规范对通知的合法响应）
    function dispatch(msg, reply) {
        if (!msg || typeof msg !== 'object') {
            reply({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
            return;
        }
        // notification（无 id）：接受，无响应体
        if (msg.id === undefined) { reply(null); return; }

        switch (msg.method) {
            case 'initialize': {
                var params = msg.params || {};
                var info = params.clientInfo || {};
                if (info && info.name) clientName = String(info.name).slice(0, 64);
                var requested = params.protocolVersion;
                var negotiated = (requested && SUPPORTED_VERSIONS.indexOf(requested) >= 0)
                    ? requested : DEFAULT_PROTOCOL_VERSION;
                reply({
                    jsonrpc: '2.0', id: msg.id,
                    result: {
                        protocolVersion: negotiated,
                        capabilities: {
                            tools: { listChanged: false }   // 无 SSE 通道，list_changed 推不出去
                        },
                        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
                        instructions: getInstructions()
                    }
                });
                return;
            }
            case 'ping':
                reply({ jsonrpc: '2.0', id: msg.id, result: {} });
                return;
            case 'tools/list':
                relay.requestVirtual({ type: 'ext_tools_query', requestId: newLocalId(), clientId: clientId })
                    .then(function (res) {
                        if (!res.ok) throw new Error(res.error || 'tools query failed');
                        reply({ jsonrpc: '2.0', id: msg.id, result: { tools: res.tools || [] } });
                    })
                    .catch(function (err) {
                        reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32003, message: err.message } });
                    });
                return;
            case 'tools/call':
                enqueueToolsCall(msg.id, msg.params, reply);
                return;
            default:
                reply({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found: ' + msg.method } });
        }
    }

    // ── HTTP 层（bridge-server routeHttp 前置 Host/Origin 校验后转入）──
    function _json(res, status, data) {
        try {
            res.writeHead(status, {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type, Accept, Mcp-Session-Id'
            });
            if (data === null) res.end();       // notification → 202 无响应体
            else res.end(JSON.stringify(data));
        } catch (_) {}
    }

    function handle(req, res) {
        // 无 SSE 流 / 无会话：GET 与 DELETE 按 Streamable HTTP 规范回 405
        if (req.method === 'GET' || req.method === 'DELETE') {
            res.writeHead(405, { 'Allow': 'POST' });
            res.end();
            return;
        }
        if (req.method !== 'POST') {
            _json(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method Not Allowed' } });
            return;
        }

        // 读 body（带上限；MCP JSON-RPC 无二进制载荷）
        var chunks = [];
        var overflowed = false;
        var total = 0;
        req.on('data', function (c) {
            if (overflowed) return;
            total += c.length;
            if (total > MAX_BODY_SIZE) { overflowed = true; chunks = []; return; }
            chunks.push(c);
        });
        req.on('error', function () { /* 连接中断：'end' 不再触发，响应随连接消亡 */ });
        req.on('end', function () {
            if (overflowed) {
                _json(res, 413, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Payload too large' } });
                return;
            }
            var body = Buffer.concat(chunks).toString('utf8');
            var msg;
            try {
                msg = JSON.parse(body);
            } catch (e) {
                _json(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
                return;
            }
            dispatch(msg, function (frame) {
                if (frame === null) _json(res, 202, null);   // notification：202 Accepted 无响应体
                else _json(res, 200, frame);
            });
        });
    }

    return {
        handle: handle,
        getStats: getStats,
        clientId: function () { return clientId; },
        clientName: function () { return clientName; }
    };
}

module.exports = { createExtMcpHttpHandler: createExtMcpHttpHandler, MAX_PENDING_CALLS: MAX_PENDING_CALLS };
