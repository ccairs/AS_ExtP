/**
 * ext-mcp-relay.js — Bridge 侧外部 MCP 路由（ext_* 消息族）
 *
 * 职责：
 *   维护「面板 socket」与「外部 MCP server 进程 socket」两张连接表，
 *   按 requestId 把外部工具调用路由到面板、面板执行结果路由回发起方，
 *   实现「外部 Agent → MCP Server 进程 → Bridge → 面板 → toolExecutor → AE」反向命令通道。
 *
 * 消息协议（WS JSON 帧，type 字段分发）：
 *   外部 MCP server 进程 → relay：
 *     ext_register    {clientId, clientName?}          → 注册连接；回 ext_registered {panelOnline}
 *     ext_tools_query {requestId}                       → 转面板 ext_tools_request；面板回 ext_tools_result
 *     ext_check       {requestId, tool, args}           → 转面板（权限确认预检）；面板回 ext_check_result
 *     ext_call        {requestId, tool, args}           → 转面板 ext_dispatch；面板回 ext_result
 *   面板 → relay：
 *     ext_panel_hello {}                                → 注册面板 socket；回 ext_panel_ack；广播 ext_panel_status
 *     ext_tools_result {requestId, tools, instructions} → 按 pending 表路由回发起方 ext socket
 *     ext_check_result {requestId, confirm, reason}     → 同上
 *     ext_result       {requestId, ok, result, error}   → 同上
 *     ext_tools_changed {}                              → 广播全部 ext 客户端（触发其 notifications/tools/list_changed）
 *     ext_progress     {ids: [...]}                      → 心跳：这些 requestId 仍在面板队列/执行中，
 *                                                          刷新各自 pending 时间戳（并转发给发起方刷新其等待计时）
 *   relay → 外部进程（应答/通知）：
 *     ext_registered / ext_tools_response / ext_check_result / ext_call_result /
 *     ext_panel_status {online}
 *   relay → 面板（转发）：
 *     ext_tools_request {requestId, clientId} / ext_dispatch {requestId, clientId, tool, args}
 *
 * 安全要点：
 *   - ext_dispatch 只能由 relay 内部产生（外部进程直接发 ext_result 伪造结果仅能命中自己发起的
 *     pending 请求，面板侧结果伪造同理——requestId 由发起方生成且路由表精确匹配 socket）
 *   - 面板离线时 ext_call 直接回 PANEL_OFFLINE，不缓存
 *   - 同一 requestId 在飞时的重复派发被拒绝（回 EXT_DUPLICATE_ID，不覆盖既有 pending）：
 *     不合规客户端同 id 并发会让第一调用方永久挂起（其回包只结算第二调用方）
 *   - pending 表带时间戳：**相对超时**（默认 90s，被 ext_progress 心跳刷新）+ **绝对上限**
 *     （默认 30min，心跳也救不回）双闸门，超时清理并回错误
 */

'use strict';

var EXT_CALL_TIMEOUT_MS = 90 * 1000;       // pending 相对超时（面板无心跳即判失联）
var EXT_CALL_MAX_MS = 30 * 60 * 1000;      // pending 绝对上限（心跳不得无限续命）
var SWEEP_INTERVAL_MS = 15 * 1000;         // 超时清扫周期

// 面板角色消息族（ext_panel_hello 注册执行目标 / 三类回包 / 清单变更广播 / 进展心跳）——
// 仅允许主路径 token 鉴权的面板连接发送，/ext-ws 标记连接一律拒（见 handle 内注释）
var PANEL_ROLE_TYPES = {
    ext_panel_hello: 1,
    ext_tools_result: 1,
    ext_check_result: 1,
    ext_result: 1,
    ext_tools_changed: 1,
    ext_progress: 1
};

// opts（可选，全部有默认值）：{ callTimeoutMs, maxCallMs, sweepIntervalMs, now }
//   —— 供测试注入短时限与假时钟（行为级断言不真等 90s）；生产调用不传。
function createExtMcpRelay(bridge, opts) {
    var sendFrame = bridge.sendFrame;
    var log = bridge.log;
    var o = opts || {};
    var callTimeoutMs = (typeof o.callTimeoutMs === 'number') ? o.callTimeoutMs : EXT_CALL_TIMEOUT_MS;
    var maxCallMs = (typeof o.maxCallMs === 'number') ? o.maxCallMs : EXT_CALL_MAX_MS;
    var sweepIntervalMs = (typeof o.sweepIntervalMs === 'number') ? o.sweepIntervalMs : SWEEP_INTERVAL_MS;
    var now = (typeof o.now === 'function') ? o.now : function () { return Date.now(); };

    var panelSocket = null;             // 面板 socket（ext_panel_hello 注册）
    var extClients = {};                // clientId -> socket
    // null-proto：requestId 是外部进程可控的任意字符串，普通 {} 下 '__proto__' 键的赋值
    // 会走原型 setter（条目丢失、回包路由不到），'constructor' 等原型键也会干扰占用判定。
    // 同 id 占用检查依赖该表是纯映射。
    var pending = Object.create(null);  // requestId -> { socket|reply, ts(相对计时), startTs(绝对计时), kind }
    var sweepTimer = null;
    var progressRefreshes = 0;          // 累计心跳续期次数（/health 可观测：长调用是否真在续期）

    function _send(socket, obj) {
        if (!socket) return;
        try {
            sendFrame(socket, Buffer.from(JSON.stringify(obj)));
        } catch (e) {
            log('[ext-mcp] send failed: ' + (e && e.message));
        }
    }

    function panelOnline() {
        return !!panelSocket;
    }

    // ── 超时清扫：pending 请求超时回错误（防外部进程挂起等待） ──
    // 两道闸门：
    //   ① 相对超时（callTimeoutMs，默认 90s）——被 ext_progress 心跳刷新。长渲染/长脚本
    //      不再被误判失联，面板的真结果也不再因迟到被当成陈旧回包丢弃；
    //   ② 绝对上限（maxCallMs，默认 30min）——心跳救不回：防「面板还能心跳但永远不回结果」
    //      把外部客户端无限期挂住。
    function failPending(id, entry, reason) {
        delete pending[id];
        var errFrame = {
            type: entry.kind === 'tools' ? 'ext_tools_response' :
                  (entry.kind === 'check' ? 'ext_check_result' : 'ext_call_result'),
            requestId: id,
            ok: false,
            // 超时如实说明「可能仍在执行」——面板可能已收到派发，仅回包迟到
            error: reason === 'max'
                ? 'EXT_TIMEOUT: 调用超过绝对上限 ' + Math.round(maxCallMs / 1000) +
                  's（面板持续报告该调用仍在执行但始终未返回结果；请重载面板恢复后再试）'
                : 'EXT_TIMEOUT: no response from panel within ' + Math.round(callTimeoutMs / 1000) +
                  's（调用可能仍在面板执行中，勿盲目重试）'
        };
        if (entry.reply) entry.reply(errFrame);   // HTTP 虚拟客户端回调
        else _send(entry.socket, errFrame);
    }

    function sweep() {
        var t = now();
        var ids = Object.keys(pending);
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var entry = pending[id];
            if (t - entry.startTs > maxCallMs) { failPending(id, entry, 'max'); continue; }
            if (t - entry.ts > callTimeoutMs) { failPending(id, entry, 'rel'); }
        }
    }

    // 同 requestId 已在飞时**拒绝**重复派发（返回 false），不再覆盖既有条目——
    // 覆盖会让第一调用方永久挂起：面板回包按 id 只结算第二调用方，第一方直到相对/绝对超时
    // 才收到超时错误（若面板结果先到，第一方的真结果还会被当陈旧回包丢弃）。占用检查用
    // hasOwnProperty：requestId 允许是任意字符串，避免 '__proto__'/'constructor' 等原型键误判占用。
    function trackPending(id, entry) {
        if (Object.prototype.hasOwnProperty.call(pending, id)) return false;
        var t = now();
        entry.ts = t;          // 相对计时（心跳刷新）
        entry.startTs = t;     // 绝对计时（心跳不刷新）
        // 记录本请求派发时的面板 socket——面板 close 可能晚于
        // 「新面板 socket 的 hello」到达（事件序空窗），只认「当前 panelSocket」会让旧
        // socket 名下的 pending 白等相对超时。close 时按 entry.panel === socket 精确回收。
        entry.panel = panelSocket;
        pending[id] = entry;
        ensureSweep();
        return true;
    }

    function ensureSweep() {
        if (sweepTimer) return;
        sweepTimer = setInterval(sweep, sweepIntervalMs);
        if (sweepTimer.unref) sweepTimer.unref();   // 不阻止进程退出
    }

    // 同 id 冲突回包：错误码 EXT_DUPLICATE_ID 供程序化判定，
    // 文案说明成因与调用方义务（唯一 requestId）。
    function duplicateIdFrame(id, kind) {
        return {
            type: kind === 'tools' ? 'ext_tools_response' :
                  (kind === 'check' ? 'ext_check_result' : 'ext_call_result'),
            requestId: id,
            ok: false,
            error: 'EXT_DUPLICATE_ID: requestId 已在飞，拒绝重复派发（同一 requestId 并发会让首个调用方被永久挂起；请确保每次调用使用唯一 requestId）'
        };
    }

    // ── 面板在线状态变化 → 广播全部外部进程 ──
    function broadcastPanelStatus(online) {
        var ids = Object.keys(extClients);
        for (var i = 0; i < ids.length; i++) {
            _send(extClients[ids[i]], { type: 'ext_panel_status', online: online });
        }
    }

    // ── 面板回包路由：按 pending 表精确路由回发起方 socket ──
    function routePanelReply(msg, replyType) {
        var id = msg.requestId;
        var entry = pending[id];
        if (!entry) {
            log('[ext-mcp] stale panel reply, requestId=' + id + ' type=' + replyType);
            return true;   // 已超时清理或伪造——吞掉不转发
        }
        delete pending[id];
        var frame = { type: replyType, requestId: id, ok: msg.ok !== false };
        if (msg.error) frame.error = String(msg.error);
        if (replyType === 'ext_tools_response') {
            if (msg.tools) frame.tools = msg.tools;
            if (msg.instructions) frame.instructions = msg.instructions;
        }
        if (replyType === 'ext_check_result') {
            frame.confirm = msg.confirm === true;
            if (msg.reason) frame.reason = String(msg.reason);
        }
        if (replyType === 'ext_call_result') {
            frame.result = msg.result !== undefined ? msg.result : null;
        }
        if (entry.reply) entry.reply(frame);       // HTTP 虚拟客户端：回调代 socket
        else _send(entry.socket, frame);
        return true;
    }

    // ── 面板断开：该面板 socket 名下在飞 pending 立即以 PANEL_OFFLINE 结算 ──
    // 只置 panelSocket=null + 广播状态时，在飞请求要等
    // 相对超时（默认 90s；stdio 客户端自带 100s 等待）才被清扫——面板已确定离线，
    // 外部客户端没有理由白等一轮。面板重连后的迟到真回包走 routePanelReply 的
    // 陈旧分支被吞（与超时清扫后的行为一致），不会二次结算/覆盖。

    //   (a) 不再依赖 socket === panelSocket 判定——网络/浏览器层事件序可能是「新面板
    //       socket 的 hello 先于旧 socket close」，旧 close 到达时 panelSocket 已指向
    //       新 socket；若只按当前面板处理，旧 socket 名下 pending 仍要白等 90s。
    //       现按 entry.panel === sock（派发时记录的 socket）精确回收其名下请求。
    //   (b) 错误文案补「可能仍在执行、勿盲目重试」指引（对齐 ext-mcp-server.js 的
    //       RELAY_TIMEOUT 文案）：面板断开时调用可能已派发进 AE，evalScript 不可取消，
    //       盲目重试会造成重复副作用。前缀保留 PANEL_OFFLINE 供程序化判定/文案文档引用。
    function failPendingForPanelSocket(sock) {
        if (!sock) return;
        var ids = Object.keys(pending);
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var entry = pending[id];
            if (!entry || entry.panel !== sock) continue;
            delete pending[id];
            var errFrame = {
                type: entry.kind === 'tools' ? 'ext_tools_response' :
                      (entry.kind === 'check' ? 'ext_check_result' : 'ext_call_result'),
                requestId: id,
                ok: false,
                error: 'PANEL_OFFLINE: 面板连接已断开，本调用可能仍在面板执行中（AE 执行不可取消），请先查询确认结果，勿盲目重试'
            };
            if (entry.reply) entry.reply(errFrame);   // HTTP 虚拟客户端回调
            else _send(entry.socket, errFrame);
        }
    }

    function handle(msg, socket) {
        // 连接生命周期事件（bridge-server 在 accept/断开时广播）
        if (msg.type === '_client_connected') return false;   // 不在连接时做任何绑定（多客户端安全，见 ae-bridge.js 注释）
        if (msg.type === '_client_disconnected') {
            if (socket && socket === panelSocket) {
                panelSocket = null;
                log('[ext-mcp] panel disconnected');
                broadcastPanelStatus(false);
            }
            // 面板 socket 断线回收：该 socket 可能是当前面板，也可能是
            // 「close 事件晚于新面板 hello」的旧面板——两种都用 __relayPanelSock 标记识别，
            // 并按 entry.panel 精确结算它名下的在飞请求（不强依赖它是当前 panelSocket）。
            if (socket && socket.__relayPanelSock) {
                failPendingForPanelSocket(socket);
            }
            // 清理绑定此 socket 的外部进程连接表项 + 其名下在飞请求
            var ids = Object.keys(extClients);
            for (var i = 0; i < ids.length; i++) {
                if (extClients[ids[i]] === socket) {
                    log('[ext-mcp] ext client disconnected: ' + ids[i]);
                    delete extClients[ids[i]];
                }
            }
            // 该 socket 名下的 pending 一并回收（发起方已死：面板的回包无处可去，
            // 留着只让 /health 虚高、白等一轮清扫）。面板侧执行不可取消——其迟到回包
            // 走 routePanelReply 的陈旧分支被吞（与超时清扫后的行为一致）。
            var deadIds = Object.keys(pending);
            for (var d = 0; d < deadIds.length; d++) {
                var de = pending[deadIds[d]];
                if (de && de.socket === socket) {
                    delete pending[deadIds[d]];
                    log('[ext-mcp] dropped pending request of disconnected client: ' + deadIds[d]);
                }
            }
            return false;   // 断开事件继续给其他 handler（ae-bridge MCP 模块也要清 socket 引用）
        }

        // /ext-ws 协议面配套：面板角色消息不得来自
        // ext 标记连接——面板经主路径 token 鉴权接入（socket 无 __asExtWs 标记），
        // /ext-ws 免 token 入口的本地进程若可发 ext_panel_hello 即抢占 panelSocket
        // （ext_dispatch 执行目标错投 + ext_check 确认门被代答），回包类可代答伪造
        // 结果。ext 连接只允许 ext_register/ext_tools_query/ext_check/ext_call。
        if (socket && socket.__asExtWs && PANEL_ROLE_TYPES[msg.type]) {
            log('[ext-mcp] rejected panel-role message from ext-ws socket: ' + msg.type);
            return true;   // 吞掉不转发
        }

        switch (msg.type) {
            // ── 外部 MCP server 进程消息 ──
            case 'ext_register': {
                var clientId = String(msg.clientId || '').slice(0, 128);
                if (!clientId) {
                    _send(socket, { type: 'ext_registered', ok: false, error: 'clientId required' });
                    return true;
                }
                extClients[clientId] = socket;
                ensureSweep();
                log('[ext-mcp] ext client registered: ' + clientId + (msg.clientName ? ' (' + msg.clientName + ')' : ''));
                _send(socket, { type: 'ext_registered', ok: true, clientId: clientId, panelOnline: panelOnline() });
                return true;
            }
            case 'ext_tools_query': {
                var qid = msg.requestId;
                if (!qid || !panelSocket) {
                    _send(socket, { type: 'ext_tools_response', requestId: qid, ok: false, error: panelOnline() ? 'requestId required' : 'PANEL_OFFLINE' });
                    return true;
                }
                if (!trackPending(qid, { socket: socket, kind: 'tools' })) {
                    _send(socket, duplicateIdFrame(qid, 'tools'));
                    return true;
                }
                _send(panelSocket, { type: 'ext_tools_request', requestId: qid, clientId: msg.clientId || '' });
                return true;
            }
            case 'ext_check': {
                var cid = msg.requestId;
                if (!cid || !panelSocket) {
                    _send(socket, { type: 'ext_check_result', requestId: cid, ok: false, error: panelOnline() ? 'requestId required' : 'PANEL_OFFLINE' });
                    return true;
                }
                if (!trackPending(cid, { socket: socket, kind: 'check' })) {
                    _send(socket, duplicateIdFrame(cid, 'check'));
                    return true;
                }
                // clientId 透传（与 ext_tools_query/ext_call 对齐，面板侧留痕数据源完备）
                _send(panelSocket, { type: 'ext_check_request', requestId: cid, clientId: msg.clientId || '', tool: msg.tool, args: msg.args || {} });
                return true;
            }
            case 'ext_call': {
                var rid = msg.requestId;
                if (!rid || !panelSocket) {
                    _send(socket, { type: 'ext_call_result', requestId: rid, ok: false, error: panelOnline() ? 'requestId required' : 'PANEL_OFFLINE' });
                    return true;
                }
                if (!trackPending(rid, { socket: socket, kind: 'call' })) {
                    _send(socket, duplicateIdFrame(rid, 'call'));
                    return true;
                }
                var dispatchFrame = {
                    type: 'ext_dispatch',
                    requestId: rid,
                    clientId: msg.clientId || '',
                    tool: String(msg.tool || ''),
                    args: msg.args || {}
                };
                // 确认留痕标记（granted/skipped）：仅元数据（日志/toast），不影响门控
                if (msg.confirm === 'granted' || msg.confirm === 'skipped') {
                    dispatchFrame.confirm = msg.confirm;
                }
                _send(panelSocket, dispatchFrame);
                return true;
            }

            // ── 面板消息 ──
            case 'ext_panel_hello':
                panelSocket = socket;
                // 给面板连接打历史标记——旧面板 socket 的 close 可能
                // 晚于新面板 hello（此时 socket !== panelSocket），断线回收仍需识别其身份。
                if (socket) socket.__relayPanelSock = true;
                ensureSweep();
                log('[ext-mcp] panel hello');
                _send(socket, { type: 'ext_panel_ack', ok: true });
                broadcastPanelStatus(true);
                return true;
            case 'ext_tools_result':
                return routePanelReply(msg, 'ext_tools_response');
            case 'ext_check_result':
                return routePanelReply(msg, 'ext_check_result');
            case 'ext_result':
                return routePanelReply(msg, 'ext_call_result');
            case 'ext_tools_changed': {
                // 面板侧工具可见性变化 → 广播全部外部进程（其转发 notifications/tools/list_changed 给 Agent 客户端）
                var cids = Object.keys(extClients);
                for (var j = 0; j < cids.length; j++) {
                    _send(extClients[cids[j]], { type: 'ext_tools_changed' });
                }
                return true;
            }
            // ── 面板进展心跳（长调用防误判）──
            // 面板在派发队列非空期间定期上报「这些 requestId 还在我这儿」：
            //   ① 刷新 pending 相对计时——否则 90s 就把在跑的调用判成失联，且它随后的
            //      真回包会因 pending 已被清而走「陈旧回包」分支被吞（外面白等、里面白干）；
            //   ② 转发给发起方 socket——stdio 客户端自带 100s 等待同样需要刷新，
            //      否则它在 relay 还耐心等的时候先把 promise reject 了。
            // HTTP 虚拟客户端无自带计时（entry.reply 直接 resolve），刷新 pending 即够。
            case 'ext_progress': {
                var pids = Array.isArray(msg.ids) ? msg.ids : [];
                for (var pi = 0; pi < pids.length; pi++) {
                    var pe = pending[pids[pi]];
                    if (!pe) continue;              // 未知/已收尾的 id 静默忽略（迟到的正常现象）
                    pe.ts = now();
                    progressRefreshes++;
                    if (!pe.progressLogged) {       // 每条只记一次（长调用期间不刷屏，但留得下线索）
                        pe.progressLogged = true;
                        log('[ext-mcp] progress: ' + pids[pi] + ' still running (wait extended)');
                    }
                    if (pe.socket) _send(pe.socket, { type: 'ext_progress', requestId: pids[pi] });
                }
                return true;
            }
        }
        return false;   // 未识别，交给下一个 handler
    }

    // ── HTTP 虚拟客户端往返（Bridge 内嵌 /mcp 端点）──
    // 无 WS 连接的请求-响应：pending 表挂 reply 回调（routePanelReply/sweep 优先走回调），
    // 面板转发帧与 WS 路径同构。resolve 恒回帧（错误也走 ok:false 帧，调用方统一解析）。
    function requestVirtual(msg) {
        return new Promise(function (resolve) {
            var kind = msg.type === 'ext_tools_query' ? 'tools'
                : (msg.type === 'ext_check' ? 'check' : 'call');
            var replyType = kind === 'tools' ? 'ext_tools_response'
                : (kind === 'check' ? 'ext_check_result' : 'ext_call_result');
            var id = msg.requestId;
            if (!id || !panelSocket) {
                resolve({ type: replyType, requestId: id, ok: false, error: panelOnline() ? 'requestId required' : 'PANEL_OFFLINE' });
                return;
            }
            if (!trackPending(id, { socket: null, reply: resolve, kind: kind })) {
                resolve(duplicateIdFrame(id, kind));
                return;
            }
            if (kind === 'tools') {
                _send(panelSocket, { type: 'ext_tools_request', requestId: id, clientId: msg.clientId || '' });
            } else if (kind === 'check') {
                _send(panelSocket, { type: 'ext_check_request', requestId: id, clientId: msg.clientId || '', tool: msg.tool, args: msg.args || {} });
            } else {
                var dispatchFrame = {
                    type: 'ext_dispatch',
                    requestId: id,
                    clientId: msg.clientId || '',
                    tool: String(msg.tool || ''),
                    args: msg.args || {}
                };
                if (msg.confirm === 'granted' || msg.confirm === 'skipped') dispatchFrame.confirm = msg.confirm;
                _send(panelSocket, dispatchFrame);
            }
        });
    }

    return {
        handle: handle,
        panelOnline: panelOnline,
        requestVirtual: requestVirtual,
        extClientCount: function () { return Object.keys(extClients).length; },
        pendingCount: function () { return Object.keys(pending).length; },
        // /health 可观测：累计心跳续期次数——长调用期间应持续增长（为 0 而调用又很久 =
        // 面板没发心跳，回到「外面判超时、里面白干」的老路）
        progressCount: function () { return progressRefreshes; },
        // 测试暴露（与各模块「仅为测试暴露」同口径）：手动触发一次清扫——行为级断言
        // 注入假时钟后即刻判定，不真等 sweepIntervalMs。
        _sweep: sweep
    };
}

module.exports = { createExtMcpRelay: createExtMcpRelay };
