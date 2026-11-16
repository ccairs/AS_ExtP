(function(global) {

    var _require = null;
    var _process = null;
    var _diagnostics = {};

    var BRIDGE_DEFAULT_PORT = 9877;
    var BRIDGE_HOST = '127.0.0.1';

    // MCP Streamable HTTP 会话头：服务器在 initialize 响应头下发
    // Mcp-Session-Id，客户端后续所有请求必须回带（大小写不敏感）。
    var MCP_SESSION_HEADER = 'Mcp-Session-Id';

    // 动态获取 Bridge 端口：优先用 Bridge.getBridgePort()（带 /health 探测 + 缓存），
    // Bridge 未加载时回退默认端口 9877（保证错误信息可见）。
    function getBridgePort() {
        try {
            if (global.Bridge && typeof global.Bridge.getBridgePort === 'function') {
                return global.Bridge.getBridgePort();
            }
        } catch (_) {}
        return BRIDGE_DEFAULT_PORT;
    }

    function clearBridgePortCache() {
        try {
            if (global.Bridge && typeof global.Bridge.clearPortCache === 'function') {
                global.Bridge.clearPortCache();
            }
        } catch (_) {}
    }

    // 日志中的 MCP 服务器地址：userinfo、query 值、fragment 值一律打码（token/key 常以任意
    // 参数名出现在 URL 里）。落盘日志出口另有统一 redact，这里是对 URL 形态的精确收敛。
    function _maskHashForLog(hash) {
        try {
            var seg = hash.slice(1);
            if (!seg) return hash;
            var ps = seg.split('&');
            for (var i = 0; i < ps.length; i++) {
                var eq = ps[i].indexOf('=');
                if (eq > 0) ps[i] = ps[i].slice(0, eq + 1) + '***';
                else if (ps[i].length >= 12) ps[i] = '***';
            }
            return '#' + ps.join('&');
        } catch (_) {
            return '#';
        }
    }

    function _maskUrlForLog(u) {
        try {
            var s = String(u).replace(/(\/\/)[^@\/\s]+@/, '$1***@');
            var q = s.indexOf('?');
            if (q < 0) {
                var h0 = s.indexOf('#');
                return h0 < 0 ? s : s.slice(0, h0) + _maskHashForLog(s.slice(h0));
            }
            var h = s.indexOf('#', q);
            var hash = h >= 0 ? s.slice(h) : '';
            var query = h >= 0 ? s.slice(q + 1, h) : s.slice(q + 1);
            var parts = query.split('&');
            for (var i = 0; i < parts.length; i++) {
                var eq = parts[i].indexOf('=');
                if (eq > 0) parts[i] = parts[i].slice(0, eq + 1) + '***';
                // 无 '=' 的裸参数（如 ?tokenabcdefghijkl）：长串视为凭据直接整体打码
                else if (parts[i].length >= 12) parts[i] = '***';
            }
            return s.slice(0, q) + '?' + parts.join('&') + (hash ? _maskHashForLog(hash) : '');
        } catch (_) {
            // fail-closed：解析失败时宁可丢地址也不把可能带凭据的原文写进日志
            return '[url masked]';
        }
    }

    // ========== Node.js 环境检测 ==========

    function detectNode() {
        if (_process) return true;

        try {
            if (typeof require !== 'undefined') {
                _require = require;
                try { _process = require('process'); } catch (e) { _process = process; }
            }
        } catch (e) {}

        if (!_require && typeof global !== 'undefined' && typeof global.require !== 'undefined') {
            _require = global.require;
        }
        if (!_require && typeof window !== 'undefined' && typeof window.require !== 'undefined') {
            _require = window.require;
        }
        if (!_require && typeof nodeRequire !== 'undefined') {
            _require = nodeRequire;
        }
        if (!_process && typeof global !== 'undefined' && typeof global.process !== 'undefined') {
            _process = global.process;
        }
        if (!_process && typeof window !== 'undefined' && typeof window.process !== 'undefined') {
            _process = window.process;
        }
        if (!_process && typeof process !== 'undefined') {
            _process = process;
        }

        _diagnostics.requireAvailable = !!_require;
        _diagnostics.processAvailable = !!_process;

        return !!_require;
    }

    function getChildProcess() {
        if (!detectNode()) return null;

        try {
            return _require('child_process');
        } catch (e1) {
            try {
                return _require('node:child_process');
            } catch (e2) {
                _diagnostics.childProcessError = e1.message;
                return null;
            }
        }
    }

    function isWindows() {
        if (_process && _process.platform) {
            return _process.platform === 'win32';
        }
        if (typeof navigator !== 'undefined' && navigator.platform) {
            return /Win/i.test(navigator.platform);
        }
        return false;
    }

    // Windows shell:true 的空格 token 加引号：Node 把 command+args 以空格拼接传给 cmd.exe
    // 且不对参数加引号，含空格的 token（如 C:\Program Files\...）会被 cmd 拆散，进程启动失败。
    // spawnProcess 内 _hasShellChars 已拒绝引号/元字符/控制字符，包裹不会引入新的注入面；
    // 非字符串原样返回（交给 spawn 自身参数校验，与旧路径行为一致）。与 ae-bridge.js 桥端同款。
    function _shellQuote(s) {
        if (typeof s !== 'string' || !/\s/.test(s)) return s;
        // 尾部反斜杠翻倍：闭合引号前的 \ 会被子进程 MSVC CRT 当作 \" 转义符，引号不
        // 闭合、尾引号被吞进参数值（"C:\My Tools\" → C:\My Tools"）；翻倍后 CRT 解析
        // 为一个字面 \，引号正常闭合。与 ae-bridge.js 桥端同款。
        var body = s.replace(/\\+$/, function (m) { return m + m; });
        return '"' + body + '"';
    }

    // Windows shell 路径的完整命令串：逐 token 加引号后以空格拼接。
    // spawn 单命令串（args 传空数组）：Node 整体包成 cmd.exe 命令行（/s 开关保留内层
    // 引号结构），规避外层引号被吃的经典问题。与 ae-bridge.js 桥端同款。
    function _buildShellCommand(command, args) {
        // 畸形配置防御：args 为字符串等非数组时（用户手写 JSON 畸形，config.args||[]
        // 原样透传），下方 for 会按字符遍历拼成 "cmd v e r b o s e" 错误命令并静默
        // spawn；入口抛错走 spawnProcess 既有 catch → spawn_error 明确报错。
        // 与 ae-bridge.js 桥端同款。
        if (args && !Array.isArray(args)) {
            throw new Error('config.args must be an array, got ' + typeof args);
        }
        var tokens = [_shellQuote(command)];
        for (var i = 0; i < (args || []).length; i++) {
            tokens.push(_shellQuote(args[i]));
        }
        return tokens.join(' ');
    }

    // Windows 下 spawn 用 shell:true 包装，child.kill() 只能终止 cmd.exe 包装层，
    // 树形杀（taskkill /T）才能连带终止 MCP server 孙进程。
    // 原 execSync 是 （ae-bridge stopSingle）的姊妹位置——taskkill 卡住期间
    // 面板 UI 线程完全冻结。改异步 spawn fire-and-forget：调用方（条目清理）不依赖
    // 进程已死，stdio ignore + 进程退出事件由系统收尾。
    function killProcessTree(child) {
        if (!child) return;
        try {
            if (isWindows() && child.pid) {
                var cpModule = getChildProcess();
                var tk = cpModule.spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'],
                    { stdio: 'ignore' });
                tk.on('error', function () { try { child.kill(); } catch (_) {} });
            } else {
                child.kill();
            }
        } catch (_) {
            try { child.kill(); } catch (_) {}
        }
    }

    function getEnv() {
        if (_process && _process.env) {
            return _process.env;
        }
        return {};
    }

    function webSocketAvailable() {
        return typeof WebSocket !== 'undefined';
    }

    // ========== WebSocket Bridge 客户端 ==========

    function createCommunicationProvider() {
        var processes = {};
        var serverConfigs = {};
        var mode = 'direct';
        var bridgeWs = null;
        var bridgeConnected = false;
        var bridgeMessageQueue = [];
        var bridgePending = {};
        var bridgeConnectCallbacks = [];
        var bridgeConnectTimeout = null;
        var bridgeReconnectTimer = null;
        var bridgeReconnectDelay = 1000;
        var bridgeReconnectMaxDelay = 30000;
        // 桥离线是**受支持的降级态**（面板其余功能经 cep.fs 正常工作），
        // 每次重连尝试都打 WARN（真机实测 2.5 小时 256 条「30 秒一对」），会把 panel.log
        // 轮转额度吃光、转掉真故障现场。现改为：转入离线报一次 WARN，离线期每 5 分钟至多一条
        // WARN，其余尝试降级为 LOG；恢复在线时复位（下次离线重新立刻 WARN）。
        var BRIDGE_OFFLINE_WARN_EVERY_MS = 5 * 60 * 1000;
        var _lastBridgeOfflineWarnAt = 0;
        function _bridgeOfflineLog(msg) {
            var now = Date.now();
            if (!_lastBridgeOfflineWarnAt || (now - _lastBridgeOfflineWarnAt) >= BRIDGE_OFFLINE_WARN_EVERY_MS) {
                _lastBridgeOfflineWarnAt = now;
                console.warn('[MCP Bridge] ' + msg);
            } else {
                console.log('[MCP Bridge] ' + msg);
            }
        }
        var callbacks = {};
        var httpConnections = {};
        // 主动停止标志：stopServer 主动 kill 时挂在 procInfo 上（_intentionalStop），
        // 崩溃回调据此区分"用户停止"与"意外崩溃"。不按 serverId 记共享表：
        // restart = kill 旧进程（taskkill 异步，close 迟到）+ 立即 spawn 新进程，
        // 共享表的新进程 close 会误读旧标志——新进程的意外崩溃被当成主动停止。
        // bridge 模式下 WS 断线窗口内 stopServer 记录的「待发 stop 清单」。
        // 断线期间 stop 帧无法送达 bridge，ae-bridge 侧 onclose 语义为「保留子进程以便
        // 重连」——WS 恢复后 recoverAllOnBridgeReconnect 又显式跳过 stopped server，
        // 不补发的话 bridge 侧子进程将成无主孤儿存活（占用资源、stderr 持续刷入面板，
        // 泄漏持续到面板关闭）。onopen flush 完成后统一补发并清空（stop 在 spawn 之后
        // 发送，确保停止意图最终压过恢复拉起）
        var pendingBridgeStops = {};
        // 进程退出/崩溃回调（由 serverManager 接线到 lifecycle 状态同步与自动重启）
        var onProcessExit = null;
        // SSE 断流/自愈重连轻量回调（由 serverManager 接线到 lifecycle
        // 状态同步——不注销工具、不触发自动重启）
        var onSseDisconnected = null;
        var onSseReconnected = null;
        // bridge 断线重连成功回调（由 serverManager 接线到 lifecycle 恢复 MCP server）
        var onBridgeReconnect = null;
        // 是否已成功连接过一次：仅"断线重连"（非首次连接）触发 onBridgeReconnect，
        // 避免与启动路径（bootstrap 直接/轮询启动）重复重建
        var everConnected = false;

        function isHttpConfig(cfg) {
            return cfg && typeof cfg.url === 'string' && cfg.url.trim().length > 0 && !cfg.command;
        }

        function getDiagnostics() {
            var diag = {
                mode: mode,
                requireAvailable: _diagnostics.requireAvailable,
                processAvailable: _diagnostics.processAvailable,
                childProcessError: _diagnostics.childProcessError || null,
                isWindows: isWindows(),
                activeProcesses: Object.keys(processes).length,
                bridgeConnected: bridgeConnected,
                bridgeUrl: 'ws://' + BRIDGE_HOST + ':' + getBridgePort(),
                webSocketAvailable: webSocketAvailable(),
                lastBridgeError: _diagnostics.bridgeError || null
            };
            return diag;
        }

        function scheduleBridgeReconnect() {
            // 已有 pending 重连直接返回：onerror 与 timer 回调 err 分支会先后双重调度
            // （前者 flush 回调先挂上新 timer，后者再 clearTimeout 重挂同 delay 的 timer），
            // 既打出重复日志又无任何时序意义——delay 翻倍只发生在 timer 回调内
            if (bridgeReconnectTimer) {
                return;
            }
            if (bridgeReconnectDelay > bridgeReconnectMaxDelay) {
                bridgeReconnectDelay = bridgeReconnectMaxDelay;
            }
            _bridgeOfflineLog('Reconnecting in ' + (bridgeReconnectDelay / 1000) + 's...');
            bridgeReconnectTimer = setTimeout(function() {
                bridgeReconnectTimer = null;
                connectBridge(function(err) {
                    if (err) {
                        bridgeReconnectDelay = Math.min(bridgeReconnectDelay * 2, bridgeReconnectMaxDelay);
                        scheduleBridgeReconnect();
                    }
                });
            }, bridgeReconnectDelay);
        }

        function flushBridgeConnectCallbacks(err) {
            var cbs = bridgeConnectCallbacks.slice();
            bridgeConnectCallbacks = [];
            for (var i = 0; i < cbs.length; i++) {
                try { cbs[i](err || null); } catch (e) {}
            }
        }

        function connectBridge(callback) {
            if (callback) bridgeConnectCallbacks.push(callback);

            if (!webSocketAvailable()) {
                _diagnostics.bridgeError = 'WebSocket not available in this environment';
                flushBridgeConnectCallbacks(new Error(_diagnostics.bridgeError));
                return;
            }

            if (bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                bridgeConnected = true;
                flushBridgeConnectCallbacks(null);
                return;
            }

            if (bridgeWs && bridgeWs.readyState === WebSocket.CONNECTING) {
                return;
            }

            try {
                var wsPort = getBridgePort();
                // H1 修复：WS URL 附加 token query（浏览器 WebSocket 不能设自定义头，
                // bridge 侧 upgrade 校验 URL query）。同步读上次缓存的 token（首次为
                // null——首连被拒后重连即带上），并 fire-and-forget 刷新缓存（bridge
                // 重启换新 token，下次连接生效）；无 token（AE 不可达/开发模式）不附加。
                var wsUrl = 'ws://' + BRIDGE_HOST + ':' + wsPort;
                if (global.Bridge) {
                    var _cachedT = (typeof global.Bridge.getCachedBridgeToken === 'function')
                        ? global.Bridge.getCachedBridgeToken() : null;
                    if (_cachedT) wsUrl += '?token=' + encodeURIComponent(_cachedT);
                    if (typeof global.Bridge.refreshBridgeToken === 'function') {
                        global.Bridge.refreshBridgeToken();   // 异步刷新，不阻塞本次连接
                    }
                }
                bridgeWs = new WebSocket(wsUrl);
            } catch (e) {
                _diagnostics.bridgeError = 'Failed to create WebSocket: ' + e.message;
                bridgeWs = null;
                flushBridgeConnectCallbacks(new Error(_diagnostics.bridgeError));
                return;
            }

            // 当前轮连接的 socket 引用：error/close/timeout 等迟到事件据此判断是否属于
            // 当前连接——重连建立新 bridgeWs 后，旧 socket 迟到的 close 会误清新连接
            //（flushBridgePending + close 掉新 socket），必须按实例比对丢弃
            var selfWs = bridgeWs;

            if (bridgeConnectTimeout) {
                clearTimeout(bridgeConnectTimeout);
                bridgeConnectTimeout = null;
            }

            bridgeConnectTimeout = setTimeout(function() {
                bridgeConnectTimeout = null;
                if (bridgeWs !== selfWs) return; // 旧连接的迟到超时：新连接已建立，不得误关
                if (bridgeWs && bridgeWs.readyState === WebSocket.CONNECTING) {
                    bridgeConnected = false;
                    _diagnostics.bridgeError = 'Bridge connection timeout after 5s (is ae-bridge.js running?)';
                    try { bridgeWs.close(); } catch (e) {}
                    bridgeWs = null;
                    flushBridgeConnectCallbacks(new Error(_diagnostics.bridgeError));
                    scheduleBridgeReconnect();
                }
            }, 5000);

            bridgeWs.onmessage = function(event) {
                try {
                    var msg = JSON.parse(event.data);
                    handleBridgeMessage(msg);
                } catch (e) {
                    console.warn('[MCP Bridge] bad message: ' + event.data);
                }
            };

            bridgeWs.onopen = function() {
                if (bridgeConnectTimeout) {
                    clearTimeout(bridgeConnectTimeout);
                    bridgeConnectTimeout = null;
                }
                if (bridgeReconnectTimer) {
                    clearTimeout(bridgeReconnectTimer);
                    bridgeReconnectTimer = null;
                }
                bridgeConnected = true;
                bridgeReconnectDelay = 1000;
                _lastBridgeOfflineWarnAt = 0;   // 恢复在线 → 复位离线告警节流

                // WS 握手成功 = 该端口的 http.Server 在线（bridge-server 在同一 server 上 upgrade WS），
                // 立即回写 shared Bridge 可用性缓存（含实际端口），缩短 isAvailable()=false 空窗：
                // heartbeat 首拍要等 bootstrap 完成后才启动，期间 AEFS 等 IO 会误降级 cep.fs/ExtendScript
                //（桥实际在线却整段走回退通道，日志刷屏且慢）。持续探测权仍归 heartbeat，下拍失败会如实翻转。
                try {
                    if (global.Bridge && typeof global.Bridge.markAvailable === 'function') {
                        global.Bridge.markAvailable(wsPort);
                    }
                } catch (e) {}

                // 断线重连成功（非首次连接）→ 通知上层恢复 MCP server。
                // bridge 进程若重启，其子进程/配置会全部丢失，客户端需主动重建；
                // 仅 ws 断线而 bridge 存活时，重建是幂等的（ae-bridge 侧 spawn 复用存活进程）。
                var wasConnected = everConnected;
                everConnected = true;
                if (wasConnected && typeof onBridgeReconnect === 'function') {
                    try {
                        onBridgeReconnect();
                    } catch (e) {
                        console.warn('[MCP Bridge] onBridgeReconnect error: ' + e.message);
                    }
                }

                while (bridgeMessageQueue.length > 0) {
                    var m = bridgeMessageQueue.shift();
                    // direct 模式下 send() 已本地 spawn 的 server 不再向 bridge 重发 spawn 帧：
                    // 否则 bridge 再拉起第二个进程，本地进程成孤儿且从未与 bridge 握手（审计）。
                    // 未本地 spawn 的帧照常 flush（正常 bridge 路径不受影响）
                    if (m.type === 'spawn' && processes[m.serverId] && processes[m.serverId].child) {
                        continue;
                    }
                    // flush 的 send 同样包异常——刚握手成功又立即失效的极端窗口下
                    // send 抛错若外逸会中断整个 onopen（剩余帧丢失、connect 回调与 stop 补发不执行）
                    try {
                        bridgeWs.send(JSON.stringify(m));
                    } catch (e) {
                        console.warn('[MCP Bridge] flush 队列帧发送失败: ' + m.serverId + ' ' + e.message);
                    }
                }

                // 补发断线窗口内 stopServer 记录的 stop 帧（在上方 flush 的
                // spawn 之后发送，停止意图最终压过恢复拉起——即便 flush 队列里残留
                // stopped server 的 spawn 帧把 bridge 侧进程拉起，随后的 stop 帧也会
                // 将其杀掉，与面板侧 'stopped' 状态最终一致）
                var stopIds = Object.keys(pendingBridgeStops);
                for (var si = 0; si < stopIds.length; si++) {
                    delete pendingBridgeStops[stopIds[si]];
                    try {
                        bridgeWs.send(JSON.stringify({ type: 'stop', serverId: stopIds[si] }));
                        console.warn('[MCP Bridge] 补发断线期间积压的 stop 帧: ' + stopIds[si]);
                    } catch (e) {
                        // send 失败（刚握手成功又立即失效的极端窗口）回写
                        // 清单条目，下次 onopen 仍可补发，stop 意图不丢失
                        pendingBridgeStops[stopIds[si]] = true;
                        console.warn('[MCP Bridge] 补发 stop 帧失败: ' + stopIds[si] + ' ' + e.message);
                    }
                }

                flushBridgeConnectCallbacks(null);
            };

            bridgeWs.onerror = function() {
                if (bridgeWs !== selfWs) return; // 旧 socket 迟到的 error：不影响新连接
                if (bridgeConnectTimeout) {
                    clearTimeout(bridgeConnectTimeout);
                    bridgeConnectTimeout = null;
                }
                bridgeConnected = false;
                if (!bridgeWs) return;
                _diagnostics.bridgeError = 'Bridge connection error — is "node ae-bridge.js" running on ws://' + BRIDGE_HOST + ':' + getBridgePort() + '?';
                _bridgeOfflineLog(_diagnostics.bridgeError);
                // 连接失败可能因 bridge 重启换端口，清缓存让下次重连重新探测
                clearBridgePortCache();
                flushBridgePending(new Error(_diagnostics.bridgeError));
                flushBridgeConnectCallbacks(new Error(_diagnostics.bridgeError));
                var ws = bridgeWs;
                bridgeWs = null;
                try { ws.close(); } catch (e) {}
                scheduleBridgeReconnect();
            };

            bridgeWs.onclose = function() {
                if (bridgeWs !== selfWs) return; // 旧 socket 迟到的 close：不得清掉新连接的 pending/句柄
                if (bridgeConnectTimeout) {
                    clearTimeout(bridgeConnectTimeout);
                    bridgeConnectTimeout = null;
                }
                bridgeConnected = false;
                if (!bridgeWs) return;
                _diagnostics.bridgeError = 'Bridge connection closed';
                _bridgeOfflineLog(_diagnostics.bridgeError);
                // 连接关闭可能因 bridge 重启换端口，清缓存让下次重连重新探测
                clearBridgePortCache();
                flushBridgePending(new Error(_diagnostics.bridgeError));
                flushBridgeConnectCallbacks(new Error(_diagnostics.bridgeError));
                var ws = bridgeWs;
                bridgeWs = null;
                try { ws.close(); } catch (e) {}
                scheduleBridgeReconnect();
            };
        }

        // 拒绝某 server 的全部在途 bridge 请求（server 级故障：spawn 失败/stdin 写失败/停止）。
        // send_error/spawn_error 若用 FIFO shift 只拒绝最旧一个：并发请求时错误发给
        // 错误的调用方、其余空等 90s 超时；这两类错误均影响该 server 全部请求，应整体 reject。
        function _rejectServerPending(serverId, err) {
            var pending = bridgePending[serverId];
            if (pending && pending.length) {
                while (pending.length > 0) {
                    var item = pending.shift();
                    if (item && item.cb) item.cb(err);
                }
            }
        }

        function handleBridgeMessage(msg) {
            if (msg.type === 'response' && msg.serverId) {
                var pending = bridgePending[msg.serverId];
                if (pending && pending.length) {
                    // 优先按 JSON-RPC id 匹配（msg.data 内含响应 id）：
                    // 长耗时调用与快速调用并发时响应乱序到达，FIFO shift 会把结果发给错误的请求方
                    var respId = null;
                    try { respId = (JSON.parse(msg.data) || {}).id; } catch (e) {}
                    var hit = null;
                    if (respId != null) {
                        for (var ri = 0; ri < pending.length; ri++) {
                            if (pending[ri] && pending[ri].id === respId) {
                                hit = pending.splice(ri, 1)[0];
                                break;
                            }
                        }
                    }
                    // id 可解析但无匹配 → 重复/迟到响应（如 config_missing 重发后服务器
                    // 重复应答），必须丢弃：FIFO 兜底会把它错投给最旧的在途请求，
                    // 该请求的真实响应到来时又会错投给下一个，形成连锁错投。
                    // id 不可解析（null）才保留 FIFO 兜底（遗留服务器兼容）。
                    if (!hit && respId == null) hit = pending.shift() || null;
                    if (hit && hit.cb) hit.cb(null, msg.data);
                }
            } else if (msg.type === 'notification' && msg.serverId) {
                var evt = { serverId: msg.serverId, data: msg.data };
                try { evt.parsed = JSON.parse(msg.data); } catch (e) {}
                if (typeof callbacks.onNotification === 'function') {
                    callbacks.onNotification(evt);
                }
                console.log('[MCP ' + msg.serverId + '] notification: ' + msg.data.substring(0, 200));
            } else if (msg.type === 'stderr' && msg.serverId) {
                console.error('[MCP ' + msg.serverId + '] stderr: ' + msg.data);
                if (typeof callbacks.onStderr === 'function') {
                    callbacks.onStderr(msg.serverId, msg.data);
                }
            } else if (msg.type === 'send_error' && msg.serverId) {
                _rejectServerPending(msg.serverId, new Error(msg.message));
            } else if (msg.type === 'spawn_error' && msg.serverId) {
                _rejectServerPending(msg.serverId, new Error('Spawn failed: ' + msg.message));
            } else if (msg.type === 'connected') {
                console.log('[MCP Bridge] connected v' + msg.bridgeVersion);
            } else if (msg.type === 'exited') {
                console.warn('[MCP Bridge] ' + msg.serverId + ' exited code=' + msg.code);
                // reject 挂起的请求（与 direct 模式 notifyPendingErrors 对齐），
                // 避免请求方空等到 90s send 超时才报错
                _rejectServerPending(msg.serverId, new Error('Process exited with code ' + msg.code));
                bridgePending[msg.serverId] = null;
                // bridge 模式进程退出（意外崩溃/正常退出）→ 同步 lifecycle 状态 + 自动重启，
                // 与 direct 模式 child.on('close') 走同一条 onProcessExit → handleCrash 链路。
                // intentional=true（用户 stop）时 handleCrash 直接 return，不覆盖 'stopped' 状态。
                if (typeof onProcessExit === 'function') {
                    onProcessExit(msg.serverId, { code: msg.code, intentional: !!msg.intentional });
                }
            } else if (msg.type === 'config_missing' && msg.serverId) {
                console.warn('[MCP Bridge] config missing for ' + msg.serverId + ', re-sending');
                var sc = serverConfigs[msg.serverId];
                if (sc && sc.command && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                    // 重发 spawn 前检查本地进程存活——有则先停本地再让 bridge
                    // 接管（对齐 onopen flush :326 的本地进程检查精神， 修复的姊妹
                    // 缺口）：否则 bridge spawn 第二个进程，本地进程 pending 无人消费
                    // 成孤儿；send() 切桥分支已先停一次，此处为纵深兜底（覆盖历史队列
                    // 帧等其他到达路径）
                    if (processes[msg.serverId] && processes[msg.serverId].child) {
                        _stopLocalProcess(msg.serverId);
                    }
                    bridgeWs.send(JSON.stringify({
                        type: 'spawn',
                        serverId: msg.serverId,
                        config: {
                            command: sc.command,
                            args: sc.args || [],
                            env: sc.env || null
                        }
                    }));
                    // 触发 config_missing 的请求已被 bridge 丢弃（handleSend 未写入 stdin），
                    // 重发 spawn 后按序重发在途消息（WS 消息有序，spawn 先于 send 被处理），
                    // 否则这些请求会空等 90s 超时
                    var pend2 = bridgePending[msg.serverId];
                    if (pend2 && pend2.length) {
                        for (var ri = 0; ri < pend2.length; ri++) {
                            if (pend2[ri] && pend2[ri].msg) {
                                bridgeWs.send(JSON.stringify({
                                    type: 'send',
                                    serverId: msg.serverId,
                                    message: pend2[ri].msg
                                }));
                            }
                        }
                    }
                } else if (!sc) {
                    // 本地已无该 server 的配置（断线窗口内 stopServer 已删除）
                    // ——迟到请求不得触发重发 spawn 把已停 server 拉起成孤儿进程；
                    // reject 该 server 的在途请求快速失败（否则空等 90s send 超时）
                    _rejectServerPending(msg.serverId, new Error('Server stopped (no local config)'));
                    bridgePending[msg.serverId] = null;
                }
            } else if (msg.type === 'error') {
                console.warn('[MCP Bridge] error: ' + msg.serverId + ' ' + msg.message);
            }
        }

        function flushBridgePending(err) {
            var keys = Object.keys(bridgePending);
            for (var i = 0; i < keys.length; i++) {
                var list = bridgePending[keys[i]];
                if (list) {
                    for (var j = 0; j < list.length; j++) {
                        if (list[j] && list[j].cb) list[j].cb(err);
                    }
                }
            }
            bridgePending = {};
        }

        function sendViaBridge(serverId, message, callback) {
            if (!bridgeConnected || !bridgeWs) {
                connectBridge(function(err) {
                    if (err) {
                        callback(err);
                        return;
                    }
                    doBridgeSend(serverId, message, callback);
                });
                return;
            }
            doBridgeSend(serverId, message, callback);
        }

        function doBridgeSend(serverId, message, callback) {
            var hasId = false;
            try {
                var parsed = JSON.parse(message);
                hasId = parsed.id !== undefined;
            } catch (e) {}

            if (hasId) {
                if (!bridgePending[serverId]) {
                    bridgePending[serverId] = [];
                }
                // 记录请求 id 与原始消息：响应按 id 匹配回调（见 handleBridgeMessage），
                // 原始消息供 config_missing 时重发（bridge 丢弃了首次投递）
                bridgePending[serverId].push({ id: parsed.id, cb: callback, msg: message });
            }

            var frame = {
                type: 'send',
                serverId: serverId,
                message: message
            };

            var raw = JSON.stringify(frame);
            if (bridgeWs.readyState === WebSocket.OPEN) {
                bridgeWs.send(raw);
            } else {
                bridgeMessageQueue.push(frame);
            }
        }

        function configureServer(serverId, config) {
            // HTTP/SSE transport
            if (isHttpConfig(config)) {
                setupHttpConnection(serverId, config);
                return;
            }

            // start（含 restart=stop+start）时撤销断线窗口积压的待发 stop——
            // 后写意图胜出。否则重连 onopen 补发的旧 stop 帧会杀掉刚 spawn 的新进程
            // （改配置后保存重启恰逢断线即命中），状态机回 'disconnected' 需再次手动启动
            delete pendingBridgeStops[serverId];

            serverConfigs[serverId] = {
                command: config.command || '',
                args: config.args || [],
                env: config.env || null
            };

            var spawnFrame = {
                type: 'spawn',
                serverId: serverId,
                config: {
                    command: config.command || '',
                    args: config.args || [],
                    env: config.env || null
                }
            };

            if (bridgeConnected && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                bridgeWs.send(JSON.stringify(spawnFrame));
            } else {
                bridgeMessageQueue.push(spawnFrame);
            }
        }

        function removeConfig(serverId) {
            if (httpConnections[serverId]) {
                disconnectHttpServer(serverId);
            }
            delete serverConfigs[serverId];
        }

        // ========== HTTP/SSE Transport ==========

        // 合并默认 headers 与用户配置 headers（用户 headers 优先，可覆盖 Content-Type/Accept）
        // value 强制转 string，避免 fetch 因非字符串 value 抛 TypeError
        // null/undefined value 会被跳过（不写入 merged），避免发送 "null"/"undefined" 字符串
        // sessionId：MCP Streamable HTTP 服务器下发的会话 id（见 _captureSessionId）。
        // 有值时回带到请求头——这是协议状态而非用户配置：先移除用户配置里的同名字段
        // （任意大小写变体，fetch 按名合并且大小写不敏感，两写会拼成 "a, b" 脏值），
        // 再写服务器给的值。无值时完全不触碰 merged——非会话型服务器行为逐字节不变。
        function _mergeHttpHeaders(userHeaders, sessionId) {
            var merged = {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream, application/json'
            };
            if (userHeaders) {
                for (var k in userHeaders) {
                    if (userHeaders.hasOwnProperty(k) && userHeaders[k] !== null && userHeaders[k] !== undefined) {
                        merged[k] = String(userHeaders[k]);
                    }
                }
            }
            if (sessionId) {
                var existingKeys = Object.keys(merged);
                for (var ek = 0; ek < existingKeys.length; ek++) {
                    if (existingKeys[ek].toLowerCase() === MCP_SESSION_HEADER.toLowerCase() &&
                        existingKeys[ek] !== MCP_SESSION_HEADER) {
                        delete merged[existingKeys[ek]];
                    }
                }
                merged[MCP_SESSION_HEADER] = String(sessionId);
            }
            return merged;
        }

        // 读取响应头里的会话 id。Headers.get 规范上大小写不敏感，但测试/极简 fetch
        // 实现可能只做字面匹配，故两种常见写法都试；取不到/空串返回 null（无会话语义）。
        function _readSessionId(response) {
            if (!response || !response.headers || typeof response.headers.get !== 'function') return null;
            var raw = null;
            try {
                raw = response.headers.get(MCP_SESSION_HEADER);
                if (raw === null || raw === undefined) raw = response.headers.get('mcp-session-id');
            } catch (e) {
                return null;
            }
            if (typeof raw !== 'string') return null;
            var trimmed = raw.trim();
            return trimmed.length > 0 ? trimmed : null;
        }

        // initialize 响应（或 SSE 建立响应）带会话头 → 存入连接状态，后续请求在
        // _mergeHttpHeaders 里回带。新会话落地即清除「已通知重握手」去重标记
        // （见 _handleHttp404），下一轮会话失效时仍可再触发一次重建。
        function _captureSessionId(conn, serverId, response) {
            if (!conn) return;
            var sid = _readSessionId(response);
            if (!sid) return;
            if (conn.sessionId !== sid) {
                conn.sessionId = sid;
                console.log('[MCP HTTP ' + serverId + '] session id established');
            }
            conn._sessionExpiredNotified = false;
        }

        // 会话失效（服务器对携带会话 id 的请求答 404）：清空本地 sessionId，再走既有
        // 重连/重握手链（onProcessExit → lifecycle.handleCrash → 1s 后 startServer →
        // configureServer 重建连接 → initialize 重新下发会话 id），不新造重试机制；
        // 失败明细沿用既有 serverErrors/状态通知链路。无会话 id 的连接（多数自建/本地
        // 实现）与旧行为逐字节一致：404 只作为该请求的 HTTP 错误上报。
        // 同一条失效会话只通知一次（_sessionExpiredNotified）：多个在途请求并发收到
        // 404 时不得重复 onProcessExit（防 crash 熔断计数被无谓放大）。
        function _handleHttp404(conn, serverId) {
            if (!conn || !conn.sessionId) return;
            conn.sessionId = null;
            if (conn._sessionExpiredNotified) return;
            conn._sessionExpiredNotified = true;
            console.warn('[MCP HTTP ' + serverId + '] session expired (HTTP 404), re-initializing');
            if (typeof onProcessExit === 'function') {
                try {
                    onProcessExit(serverId, { intentional: false, error: 'MCP session expired (HTTP 404)' });
                } catch (e) {
                    console.warn('[MCP HTTP ' + serverId + '] session-expired notify failed: ' + e.message);
                }
            }
        }

        function setupHttpConnection(serverId, config) {
            // Clean up existing connection first (re-config case)
            if (httpConnections[serverId]) {
                disconnectHttpServer(serverId);
            }

            var url = config.url.trim();
            var transport = config.transport || 'http';

            // Auto-detect: URL path ends with /sse → legacy SSE transport
            if (!config.transport && (url.endsWith('/sse') || url.indexOf('/sse?') !== -1)) {
                transport = 'sse';
            }

            var conn = {
                url: url,
                type: transport,
                headers: (config.headers && typeof config.headers === 'object' && !Array.isArray(config.headers)) ? config.headers : null,
                pending: {},
                // MCP Streamable HTTP 会话状态：服务器 initialize 响应头下发的
                // Mcp-Session-Id（_captureSessionId 写入、_mergeHttpHeaders 回带）；
                // _sessionExpiredNotified 为 404 重握手的一次性去重标记
                sessionId: null,
                _sessionExpiredNotified: false,
                // legacy SSE 的 fetch 流控制（_sseClosed/_sseAbort 见 setupSseConnection）
                _sseClosed: false,
                _sseAbort: null,
                messageUrl: transport === 'http' ? url : null,
                connected: transport === 'http'
            };

            httpConnections[serverId] = conn;
            console.log('[MCP HTTP] ' + serverId + ' configured: ' + transport + ' ' + _maskUrlForLog(url));

            if (transport === 'sse') {
                setupSseConnection(serverId, conn);
            }
        }

        // Legacy SSE transport：以 fetch 流实现（而非 EventSource）。
        // EventSource 不支持自定义请求头，带鉴权的 SSE 服务器 GET 流会 401，
        // headers 仅作用于 POST 时鉴权不生效。
        // fetch 流 + event:/data: 帧解析（endpoint 事件路由），断流后指数退避重连。
        function setupSseConnection(serverId, conn) {
            conn._sseClosed = false;
            conn._sseAbort = (typeof AbortController !== 'undefined') ? new AbortController() : null;

            function notifyPendingError(msg) {
                var ids = Object.keys(conn.pending);
                for (var i = 0; i < ids.length; i++) {
                    var cb = conn.pending[ids[i]];
                    delete conn.pending[ids[i]];
                    try { cb(new Error(msg)); } catch (e) {}
                }
            }

            // 已送达过 endpoint（lifecycle 已置 connected）的连接断流时，经
            // 轻量通道（onSseDisconnected）通知 lifecycle 置 disconnected——否则断线
            // 窗口内 UI 恒显「已连接」，用户无从感知故障。断流是可自愈的传输层故障
            // （scheduleReconnect 重连后 transport 恢复、工具注册表全程有效，即基线
            // 语义），不走 onProcessExit→handleCrash 全语义（工具注销 + 崩溃自动重启）
            // ——那会让断流一次工具即静默消失、自愈后无人 re-register。
            // 仅在 conn.connected 为真时通知：connecting 阶段的断流由握手超时路径善后，
            // 避免干扰 startServer 的在途握手。
            function notifyLifecycleDown(msg) {
                if (!conn.connected || typeof onSseDisconnected !== 'function') return;
                try { onSseDisconnected(serverId, { error: msg }); } catch (e) {}
            }

            function scheduleReconnect() {
                if (conn._sseClosed) return;
                // 重连指数退避（3s 起步 ×2 递增，封顶 30s）——服务端长期
                // 不可用时固定 3s 重连是无限打点；endpoint 送达时重置基数。
                var delay = conn._reconnectDelay || 3000;
                conn._reconnectDelay = Math.min(delay * 2, 30000);
                setTimeout(connect, delay);
            }

            function handleEndpoint(endpointUrl) {
                // Resolve relative URLs against the SSE URL
                if (endpointUrl.indexOf('://') === -1) {
                    var protoEnd = conn.url.indexOf('://');
                    var hostStart = conn.url.indexOf('/', protoEnd + 3);
                    if (endpointUrl.charAt(0) === '/') {
                        endpointUrl = hostStart !== -1
                            ? conn.url.substring(0, hostStart) + endpointUrl
                            : conn.url + endpointUrl;
                    } else {
                        var lastSlash = conn.url.lastIndexOf('/');
                        endpointUrl = conn.url.substring(0, lastSlash + 1) + endpointUrl;
                    }
                }
                conn.messageUrl = endpointUrl;
                conn.connected = true;
                // endpoint 送达 = 流真正可用，重置重连退避基数
                conn._reconnectDelay = 3000;
                // 自愈重连成功点——通知 lifecycle 恢复断流时置的
                // disconnected 状态（工具注册表全程未动，无需 re-register）
                if (typeof onSseReconnected === 'function') {
                    try { onSseReconnected(serverId); } catch (e) {}
                }
                console.log('[MCP SSE ' + serverId + '] Endpoint: ' + _maskUrlForLog(endpointUrl));

                // Flush queued requests
                if (conn._sendQueue && conn._sendQueue.length > 0) {
                    var queue = conn._sendQueue;
                    conn._sendQueue = null;
                    for (var qi = 0; qi < queue.length; qi++) {
                        sendHttp(serverId, queue[qi].message, queue[qi].callback);
                    }
                }
            }

            function dispatchSseEvent(eventName, data) {
                if (eventName === 'endpoint') {
                    handleEndpoint(data.trim());
                    return;
                }
                try {
                    var parsed = JSON.parse(data);
                    routeHttpResponse(serverId, conn, parsed);
                } catch (e) {
                    console.warn('[MCP SSE ' + serverId + '] Non-JSON message');
                }
            }

            // 解析 SSE 帧流：event:/data: 字段 + 空行边界；返回未完成的尾行供下次拼接。
            // dataLines/eventName 为跨 read chunk 状态：事件的数据行与边界空行可能落在
            // 不同 chunk，若用每次调用的局部变量，已累积的数据行会在调用结束时丢弃，
            // 整条事件静默丢失（在途请求等不到响应，直到 90s send 超时）
            var sseDataLines = [];
            var sseEventName = '';
            function parseSseFrames(text) {
                var normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
                var lines = normalized.split('\n');
                var lastLine = lines.pop() || '';
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i];
                    if (line.indexOf('event:') === 0) {
                        var ev = line.substring(6);
                        if (ev.charAt(0) === ' ') ev = ev.substring(1);
                        sseEventName = ev;
                    } else if (line.indexOf('data:') === 0) {
                        var value = line.substring(5);
                        if (value.charAt(0) === ' ') value = value.substring(1);
                        sseDataLines.push(value);
                    } else if (line === '') {
                        // 空行 = 事件边界
                        if (sseDataLines.length > 0) {
                            dispatchSseEvent(sseEventName, sseDataLines.join('\n'));
                            sseDataLines = [];
                        }
                        sseEventName = '';
                    }
                    // 忽略 id:/retry: 字段
                }
                return lastLine;
            }

            function pumpStream(response) {
                // 新一条 SSE 流从空白解析状态开始：丢弃上一条断流残留的半成品事件，
                // 避免拼接进重连后新流的首个事件
                sseDataLines = [];
                sseEventName = '';
                if (!response.body || typeof response.body.getReader !== 'function') {
                    // 无流式读取能力：整段读完后按断流处理重连（仅作环境兜底）
                    response.text().then(function (text) {
                        parseSseFrames(text + '\n');
                        if (conn._sseClosed) return;
                        conn.connected = false;
                        notifyPendingError('SSE connection closed');
                        scheduleReconnect();
                    }).catch(function () {
                        if (conn._sseClosed) return;
                        conn.connected = false;
                        scheduleReconnect();
                    });
                    return;
                }

                var reader = response.body.getReader();
                var decoder = new TextDecoder();
                var buffer = '';

                function pump() {
                    reader.read().then(function (result) {
                        if (conn._sseClosed) return;
                        if (result.done) {
                            // 断流：在途请求的响应只能经此流送达，已丢失，须 reject
                            // 先通知 lifecycle 置 disconnected（须赶在 connected 清零前判定）
                            notifyLifecycleDown('SSE connection closed');
                            conn.connected = false;
                            notifyPendingError('SSE connection closed');
                            scheduleReconnect();
                            return;
                        }
                        buffer += decoder.decode(result.value, { stream: true });
                        buffer = parseSseFrames(buffer);
                        pump();
                    }).catch(function (err) {
                        if (conn._sseClosed) return;
                        console.warn('[MCP SSE ' + serverId + '] Stream read error: ' + err.message);
                        // 读流出错同为断流，通知 lifecycle 置 disconnected
                        notifyLifecycleDown('SSE connection error: ' + err.message);
                        conn.connected = false;
                        notifyPendingError('SSE connection error');
                        scheduleReconnect();
                    });
                }
                pump();
            }

            function connect() {
                if (conn._sseClosed) return;
                var headers = _mergeHttpHeaders(conn.headers, conn.sessionId);
                headers['Accept'] = 'text/event-stream';
                fetch(conn.url, {
                    method: 'GET',
                    headers: headers,
                    signal: conn._sseAbort ? conn._sseAbort.signal : undefined
                }).then(function (response) {
                    if (conn._sseClosed) return;
                    if (!response.ok) {
                        console.warn('[MCP SSE ' + serverId + '] Connection error: HTTP ' + response.status);
                        conn.connected = false;
                        notifyPendingError('SSE connection error: HTTP ' + response.status);
                        scheduleReconnect();
                        return;
                    }
                    // 服务器在建立响应头下发会话 id 时记录（非会话型服务器无此头，行为不变）
                    _captureSessionId(conn, serverId, response);
                    console.log('[MCP SSE ' + serverId + '] Connection opened');
                    pumpStream(response);
                }).catch(function (err) {
                    if (conn._sseClosed) return;
                    console.warn('[MCP SSE ' + serverId + '] Connection error: ' + err.message);
                    conn.connected = false;
                    // 对齐 !response.ok 分支——连接失败同样拒绝在途请求
                    //（断流瞬间新 POST 的回调在 notifyPendingError 清空后才挂入 pending
                    // 的竞态窗口，错过断流拒绝即空等 90s send 超时）
                    notifyPendingError('SSE connection error: ' + (err && err.message ? err.message : 'connection failed'));
                    scheduleReconnect();
                });
            }

            connect();
        }

        function disconnectHttpServer(serverId) {
            var conn = httpConnections[serverId];
            if (!conn) return;

            // 标记关闭并中断 SSE fetch 流（fetch 流无法像 EventSource 一样 .close()）
            conn._sseClosed = true;
            if (conn._sseAbort) {
                try { conn._sseAbort.abort(); } catch (e) {}
            }

            // Notify pending callbacks
            var ids = Object.keys(conn.pending);
            for (var i = 0; i < ids.length; i++) {
                var cb = conn.pending[ids[i]];
                delete conn.pending[ids[i]];
                try { cb(new Error('Server disconnected')); } catch (e) {}
            }

            // SSE 就绪前排队等待 endpoint 的请求同样 reject：
            // 只清 pending 时 _sendQueue 里的请求要空等 90s send 超时
            if (conn._sendQueue && conn._sendQueue.length) {
                var queued = conn._sendQueue;
                conn._sendQueue = null;
                for (var qi = 0; qi < queued.length; qi++) {
                    try { queued[qi].callback(new Error('Server disconnected')); } catch (e) {}
                }
            }

            delete httpConnections[serverId];
            console.warn('[MCP HTTP] ' + serverId + ' disconnected');
        }

        function routeHttpResponse(serverId, conn, parsed) {
            if (parsed && parsed.id !== undefined && parsed.id !== null && conn.pending[parsed.id]) {
                var cb = conn.pending[parsed.id];
                delete conn.pending[parsed.id];
                cb(null, JSON.stringify(parsed));
            } else if (parsed && parsed.method !== undefined) {
                // Server-initiated notification
                if (typeof callbacks.onNotification === 'function') {
                    callbacks.onNotification({
                        serverId: serverId,
                        data: JSON.stringify(parsed),
                        parsed: parsed
                    });
                }
                console.log('[MCP ' + serverId + '] notification: ' + (parsed.method || ''));
            }
        }

        function sendHttp(serverId, message, callback) {
            var conn = httpConnections[serverId];
            if (!conn) {
                callback(new Error('HTTP connection not found: ' + serverId));
                return;
            }

            if (!conn.connected) {
                // Queue for SSE servers that haven't received endpoint yet
                if (!conn._sendQueue) conn._sendQueue = [];
                conn._sendQueue.push({ message: message, callback: callback });
                return;
            }

            var postUrl = conn.messageUrl || conn.url;
            if (!postUrl) {
                callback(new Error('No message URL for: ' + serverId));
                return;
            }

            var reqId = null;
            try { var parsed = JSON.parse(message); reqId = parsed.id; } catch (e) {}

            if (reqId !== undefined && reqId !== null) {
                conn.pending[reqId] = callback;
            }

            fetch(postUrl, {
                method: 'POST',
                headers: _mergeHttpHeaders(conn.headers, conn.sessionId),
                body: message
            }).then(function (response) {
                // initialize 响应下发会话 id → 记录；后续请求（initialized 通知、
                // tools/list、tools/call）经 _mergeHttpHeaders 自动回带
                _captureSessionId(conn, serverId, response);
                if (!response.ok) {
                    cleanupHttpPending(conn, reqId);
                    // 404：对已建立的会话即「会话失效」——清本地 sessionId 并走既有
                    // 重连/重握手链；无会话的连接只按普通 HTTP 错误上报（行为不变）
                    if (response.status === 404) {
                        _handleHttp404(conn, serverId);
                    }
                    callback(new Error('HTTP ' + response.status + ': ' + response.statusText));
                    return;
                }

                var contentType = response.headers.get('Content-Type') || '';

                if (contentType.indexOf('text/event-stream') !== -1) {
                    // Streamable HTTP: SSE streaming response
                    // SSE legacy transport: 响应经 GET fetch 流送达（见 setupSseConnection），POST 的响应丢弃
                    if (conn.type === 'sse') return;
                    readFetchSSEStream(response, serverId, conn, reqId);
                } else {
                    // JSON response
                    response.text().then(function (text) {
                        if (conn.type === 'sse') return; // SSE legacy: 响应经 GET fetch 流送达，此处丢弃
                        cleanupHttpPending(conn, reqId);
                        try {
                            var json = JSON.parse(text);
                            callback(null, JSON.stringify(json));
                        } catch (e) {
                            callback(null, text);
                        }
                    }).catch(function (err) {
                        cleanupHttpPending(conn, reqId);
                        callback(err);
                    });
                }
            }).catch(function (err) {
                cleanupHttpPending(conn, reqId);
                callback(err);
            });
        }

        function cleanupHttpPending(conn, reqId) {
            if (reqId !== undefined && reqId !== null && conn) {
                delete conn.pending[reqId];
            }
        }

        function readFetchSSEStream(response, serverId, conn, reqId) {
            // 每条 POST 响应是独立 SSE 流：数据行缓冲为本次调用的局部状态（跨 chunk 累积）。
            // 同一 server 可能有两条响应流并发在途（调用方停止/90s 超时放弃等待后本泵仍在
            // 后台读流，与后续请求的响应流重叠；MCP 面板保存触发的 tools/list 刷新同理），
            // 挂 conn 共享会被后启动的流重置并混入半成品数据行，事件错拼/丢失
            var dataLines = [];
            // 按「流归属」记账——本流只负责本次 POST 的 reqId（sendHttp 传入）。
            // done（服务端/代理截断提前收流）时若该 id 仍未命中，响应不会再来：立即删 pending
            // 并以「流已关闭」reject，调用方不再空等 90s send 超时（90s 兜底保留，用于读错误/
            // 永不结束的流等场景）。只动本流自己的 id，其他并发流的 pending 不受影响；
            // 命中/超时/断线等既有清理路径照旧。
            function failPendingIfUnresolved() {
                if (reqId === undefined || reqId === null) return;   // 通知类消息无 pending
                var cb = conn.pending[reqId];
                if (!cb) return;                                      // 已命中结算或已被清理（幂等）
                delete conn.pending[reqId];
                cb(new Error('SSE stream closed before response (id ' + reqId + ')'));
            }
            // Fallback: no streaming support
            if (!response.body || typeof response.body.getReader !== 'function') {
                response.text().then(function (text) {
                    parseSSEBuffer(text, serverId, conn, dataLines);
                    failPendingIfUnresolved();   // 全量文本已解析完，仍未命中即流已结束
                }).catch(function (err) {
                    console.warn('[MCP HTTP ' + serverId + '] Read error: ' + err.message);
                });
                return;
            }

            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';

            function pump() {
                reader.read().then(function (result) {
                    if (result.done) { failPendingIfUnresolved(); return; }
                    buffer += decoder.decode(result.value, { stream: true });
                    buffer = parseSSEBuffer(buffer, serverId, conn, dataLines);
                    pump();
                }).catch(function (err) {
                    console.warn('[MCP HTTP ' + serverId + '] Stream read error: ' + err.message);
                });
            }

            pump();
        }

        function parseSSEBuffer(text, serverId, conn, dataLines) {
            // Normalize \r\n → \n, strip stray \r
            var normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '');
            var lines = normalized.split('\n');
            var lastLine = lines.pop() || '';
            // 跨 read chunk 状态由调用方持有（readFetchSSEStream 每条响应流一个局部数组）：
            // 事件的数据行与边界空行可能落在不同 chunk，局部于单次 parse 调用会在返回时
            // 丢弃已累积的数据行，整条事件静默丢失（在途请求等不到响应直到 90s 超时）

            for (var i = 0; i < lines.length; i++) {
                var line = lines[i];

                if (line.indexOf('data:') === 0) {
                    var value = line.substring(5);
                    if (value.charAt(0) === ' ') value = value.substring(1);
                    dataLines.push(value);
                } else if (line === '') {
                    // Empty line = event boundary
                    if (dataLines.length > 0) {
                        var data = dataLines.join('\n');
                        dataLines.length = 0;
                        try {
                            var parsed = JSON.parse(data);
                            routeHttpResponse(serverId, conn, parsed);
                        } catch (e) {}
                    }
                }
                // Ignore event:, id:, retry: fields
            }

            return lastLine;
        }

        // ========== 子进程 spawn (direct 模式) ==========

        function spawnProcess(serverId) {
            var cpModule = getChildProcess();
            if (!cpModule) {
                _diagnostics.spawnError = 'child_process not available - use bridge mode';
                return null;
            }

            var config = serverConfigs[serverId];
            if (!config || !config.command) {
                _diagnostics.spawnError = 'No config for server: ' + serverId;
                return null;
            }

            // Shell 注入防御：windows shell:true → cmd.exe（与 ae-bridge.js 桥端同款校验，双端纵深）
            // 拦 & | < > ^ % " + 控制字符；放行 ( ) ; ` $ ' !（cmd /c 单行不解析，拦了误杀 "(x86)" 路径）
            // % 必须拦：防 env 值经 %VAR% 引用展开回流 shell；& 必拦：URL query 含 & 放行也会被 cmd 截断/注入
            function _hasShellChars(s) {
                if (!s || typeof s !== 'string') return false;
                if (/[&|<>^%"]/.test(s)) return true;
                for (var ci = 0; ci < s.length; ci++) {
                    var cc = s.charCodeAt(ci);
                    if (cc <= 0x1F || cc === 0x7F) return true;
                }
                return false;
            }
            if (_hasShellChars(config.command)) {
                _diagnostics.spawnError = 'Command contains forbidden shell characters';
                console.warn('[MCP] 拒绝危险的 command: ' + String(config.command).substring(0, 80));
                return null;
            }
            var cpArgs = config.args || [];
            for (var cai = 0; cai < cpArgs.length; cai++) {
                if (_hasShellChars(cpArgs[cai])) {
                    _diagnostics.spawnError = 'Argument contains forbidden shell characters';
                    console.warn('[MCP] 拒绝危险的 arg[' + cai + ']: ' + String(cpArgs[cai]).substring(0, 80));
                    return null;
                }
            }

            var env = Object.assign({}, getEnv());
            if (config.env && typeof config.env === 'object') {
                var envKeys = Object.keys(config.env);
                for (var i = 0; i < envKeys.length; i++) {
                    env[envKeys[i]] = config.env[envKeys[i]];
                }
            }

            var wind = isWindows();
            var spawnOptions = {
                env: env,
                stdio: ['pipe', 'pipe', 'pipe']
            };
            if (wind) {
                spawnOptions.shell = true;
            }

            var child;
            try {
                if (wind) {
                    // shell:true 下 Node 不给参数加引号，含空格 command/args 会被 cmd.exe 拆散
                    // （如 C:\Program Files\nodejs\node.exe）；拼成带引号的单命令串 spawn
                    child = cpModule.spawn(_buildShellCommand(config.command, config.args), [], spawnOptions);
                } else {
                    child = cpModule.spawn(config.command, config.args, spawnOptions);
                }
            } catch (e) {
                console.warn('[MCP] spawn exception for ' + serverId + ': ' + e.message);
                _diagnostics.spawnError = 'spawn exception: ' + e.message;
                return null;
            }

            if (!child || !child.stdout || !child.stdin) {
                console.warn('[MCP] spawn returned invalid child object for ' + serverId);
                _diagnostics.spawnError = 'spawn returned invalid child object';
                return null;
            }

            var procInfo = {
                child: child,
                buffer: '',
                pending: {},
                pid: child.pid,
                serverId: serverId,
                // 流式 UTF-8 解码器——data.toString() 按 chunk 独立解码，多字节
                // 字符跨 chunk 边界会产生 U+FFFD 乱码；stream:true 让 TextDecoder
                // 跨 chunk 保留未完成的字节序列（同文件 SSE 路径 stream:true 用法）
                decoder: (typeof TextDecoder === 'function') ? new TextDecoder() : null
            };

            child.stdout.on('data', function(data) {
                // 流式解码；TextDecoder 不可用的环境保留旧 toString 逻辑兜底
                if (procInfo.decoder) {
                    procInfo.buffer += procInfo.decoder.decode(data, { stream: true });
                } else {
                    procInfo.buffer += data.toString();
                }
                // 行缓冲兜底：MCP stdio 是 NDJSON（按行分割），buffer 只暂存不完整行。
                // 若 server 异常持续输出无换行内容，buffer 会无限增长撑爆内存；
                // 超上限视为协议违规，kill 进程断开（close 事件会清理并通知 pending）。
                if (procInfo.buffer.length > 8 * 1024 * 1024) {
                    console.error('[MCP ' + serverId + '] stdout 行缓冲超过 8MB（非 NDJSON 输出），断开进程');
                    procInfo.buffer = '';
                    killProcessTree(child);
                    return;
                }
                var lines = procInfo.buffer.split('\n');
                procInfo.buffer = lines.pop();
                for (var i = 0; i < lines.length; i++) {
                    var line = lines[i].trim();
                    if (line) {
                        handleMessage(serverId, line, procInfo);
                    }
                }
            });

            child.stderr.on('data', function(data) {
                // 诊断输出仅打 console，超长截断防刷屏（不影响 server 功能）
                var s = String(data);
                if (s.length > 2000) s = s.slice(0, 2000) + '…[truncated ' + s.length + ' chars]';
                console.warn('[MCP ' + serverId + ' stderr] ' + s.trim());
            });

            child.on('close', function(code) {
                // decoder 收尾 flush——末尾多字节序列可能仍滞留在 decoder 内部
                // 状态；flush 后 buffer 里的残留半行（无换行结尾的最后一行）按行协议
                // 处理，再通知剩余 pending 失败
                if (procInfo.decoder) {
                    try { procInfo.buffer += procInfo.decoder.decode(); } catch (_) {}
                }
                if (procInfo.buffer) {
                    var lastLine = procInfo.buffer.trim();
                    procInfo.buffer = '';
                    if (lastLine) handleMessage(serverId, lastLine, procInfo);
                }
                console.warn('[MCP ' + serverId + '] exited code=' + code);
                notifyPendingErrors(serverId, procInfo, 'Process exited with code ' + code);
                // 仅当 processes[serverId] 仍指向本进程时才清理——restart/stop+start 后
                // 新进程已 spawn，旧 close 延迟到达时不能误删新进程的 procInfo（否则重复 spawn 双进程）
                if (processes[serverId] === procInfo) delete processes[serverId];
                // 主动停止只认本进程自己的标志（见顶部 _intentionalStop 注释）：
                // 按 serverId 记共享表时，restart 窗口里新进程的崩溃会误读旧进程的
                // 停止标志 → handleCrash 跳过（不注销工具、不自动重启、状态滞留
                // 'connected'），旧进程的 close 又会把标志提前消费掉让真停止漏判
                var intentional = !!procInfo._intentionalStop;
                if (onProcessExit) onProcessExit(serverId, { code: code, intentional: intentional });
            });

            child.on('error', function(err) {
                console.warn('[MCP ' + serverId + '] error: ' + err.message);
                notifyPendingErrors(serverId, procInfo, 'Process error: ' + err.message);
                // 仅守卫删除；不调 onProcessExit——Node 保证 spawn 失败时 error 之后必触发 close，
                // 由 close 统一触发一次 onProcessExit，避免 error+close 双触发导致 handleCrash 双执行
                // （双重启调度、双握手、fetchAndRegister 并发改名污染、熔断计数加倍）
                if (processes[serverId] === procInfo) delete processes[serverId];
            });

            // stdin 必须挂 'error' 监听——子进程退出到上方 close 回调删除
            // processes[serverId] 之间存在窗口，窗口内新请求写已断管道触发 EPIPE，
            // 该错误以异步 'error' 事件抛出（send 的 try/catch 只能捕获同步 throw），
            // 无监听器的 stream error 会被 Node 作为 uncaughtException 抛出崩溃宿主进程。
            // 监听后吞掉此类错误并视作该 server 通道失效：通知在途请求失败、守卫删除
            // processes 条目、kill 残留子进程（close 回调统一触发 onProcessExit 走既有
            // 崩溃恢复链，此处不重复触发）。typeof 守卫兼容 spawn 返回非完整流对象的异常环境。
            if (typeof child.stdin.on === 'function') {
                child.stdin.on('error', function(err) {
                    console.warn('[MCP ' + serverId + '] stdin error (channel dead): ' + err.message);
                    notifyPendingErrors(serverId, procInfo, 'Server stdin broken: ' + err.message);
                    if (processes[serverId] === procInfo) delete processes[serverId];
                    killProcessTree(child);
                });
            }

            processes[serverId] = procInfo;
            console.log('[MCP ' + serverId + '] spawned, pid=' + child.pid);
            return child;
        }

        function handleMessage(serverId, rawLine, procInfo) {
            try {
                var msg = JSON.parse(rawLine);
                var id = msg.id;
                if (id !== undefined && procInfo.pending[id]) {
                    var cb = procInfo.pending[id];
                    delete procInfo.pending[id];
                    cb(null, rawLine);
                }
            } catch (e) {
                console.warn('[MCP ' + serverId + '] bad message: ' + rawLine.substring(0, 100));
            }
        }

        function notifyPendingErrors(serverId, procInfo, errorMsg) {
            var ids = Object.keys(procInfo.pending);
            for (var i = 0; i < ids.length; i++) {
                procInfo.pending[ids[i]](new Error(errorMsg));
            }
            procInfo.pending = {};
        }

        // 停止本地（direct 模式 spawn 的）进程的统一入口，从 stopServer 的
        // direct 分支提取：stdin.end + 树形 kill + 拒绝在途请求 + 清理 processes 条目。
        // 供三处复用，防止本地进程成孤儿：
        //   ① send() 自动切桥分支——切桥前先停本地，否则 bridge 侧 config_missing 重发
        //      spawn 拉起第二个进程，本地进程 pending 无人消费成孤儿（stopServer 桥
        //      分支只杀 bridge 侧进程，本地进程泄漏至面板退出）；
        // ② config_missing 重发 spawn 前——对齐 onopen flush 的本地进程检查（精神）；
        //   ③ stopServer 桥分支——同时清理本地 processes 残留（direct→bridge 切换窗口
        //      遗留的本地进程）。
        // 幂等：processes 无该 server 条目时无操作
        function _stopLocalProcess(serverId) {
            var procInfo = processes[serverId];
            if (!procInfo || !procInfo.child) return;
            // 标志挂本进程的 procInfo（close 回调按进程实例读取，见上方 close 处注释）
            procInfo._intentionalStop = true;
            try { procInfo.child.stdin.end(); } catch (_) {}
            killProcessTree(procInfo.child);
            notifyPendingErrors(serverId, procInfo, 'Server stopped');
            delete processes[serverId];
        }

        // ========== 统一发送接口 (自动选择 direct/bridge) ==========

        // 单次请求超时（默认 90s，与既有行为一致）。opts.timeoutMs 供 MCP 工具长调用
        // 放大该值：超时回调会清理 pending 条目（迟到响应按"未知 id"丢弃），因此
        // 需要接住迟到响应的调用方必须把超时推后，而不是让它先触发。
        function _resolveSendTimeoutMs(opts) {
            var t = opts && opts.timeoutMs;
            return (typeof t === 'number' && t > 0) ? t : 90000;
        }

        function send(serverId, message, callback, opts) {
            // 通知（无 id，如握手后的 notifications/initialized）不期待响应：
            // 不挂 90s 超时包装，否则连接 90s 后必误报一次 send timeout
            //（stdio/bridge 无响应可等；SSE legacy 的 POST 响应被有意丢弃，同样等不到回调）
            var parsedMsg = null;
            try { parsedMsg = JSON.parse(message); } catch (e) {}
            var isNotification = !(parsedMsg && parsedMsg.id !== undefined);
            var timeoutMs = _resolveSendTimeoutMs(opts);

            // HTTP/SSE transport
            if (httpConnections[serverId]) {
                var httpDone = false;
                var httpTimeout = isNotification ? null : setTimeout(function() {
                    if (httpDone) return;
                    httpDone = true;
                    console.warn('[MCP HTTP ' + serverId + '] send timeout after ' + (timeoutMs / 1000) + 's');
                    // 清理 pending 残留：响应永不到达时，conn.pending 里的条目会永久泄漏
                    var conn = httpConnections[serverId];
                    if (conn && parsedMsg && parsedMsg.id !== undefined && parsedMsg.id !== null) {
                        delete conn.pending[parsedMsg.id];
                    }
                    callback(new Error('Send timeout - server did not respond within ' + (timeoutMs / 1000) + 's'));
                }, timeoutMs);

                function httpWrappedCallback(err, result) {
                    if (httpDone) return;
                    httpDone = true;
                    if (httpTimeout) clearTimeout(httpTimeout);
                    callback(err, result);
                }

                sendHttp(serverId, message, httpWrappedCallback);
                return;
            }

            var done = false;
            var timeout = isNotification ? null : setTimeout(function() {
                if (done) return;
                done = true;
                console.warn('[MCP ' + serverId + '] send timeout after ' + (timeoutMs / 1000) + 's');
                // 清理 pending 残留（对齐 HTTP 路径超时分支）——响应永不到达时
                // direct 的 procInfo.pending[req.id] / bridge 的 bridgePending[serverId]
                // 条目会永久泄漏。幂等：响应迟到时 handleMessage / handleBridgeMessage
                // 对已删条目走"未知 id 丢弃"路径，无害
                if (parsedMsg && parsedMsg.id !== undefined && parsedMsg.id !== null) {
                    var pi = processes[serverId];
                    if (pi && pi.pending) delete pi.pending[parsedMsg.id];
                    var bp = bridgePending[serverId];
                    if (bp && bp.length) {
                        for (var bi = bp.length - 1; bi >= 0; bi--) {
                            if (bp[bi] && bp[bi].id === parsedMsg.id) bp.splice(bi, 1);
                        }
                    }
                }
                callback(new Error('Send timeout - server did not respond within ' + (timeoutMs / 1000) + 's'));
            }, timeoutMs);

            function wrappedCallback(err, result) {
                if (done) return;
                done = true;
                if (timeout) clearTimeout(timeout);
                callback(err, result);
            }

            if (bridgeConnected && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                if (mode !== 'bridge') {
                    mode = 'bridge';
                    console.log('[MCP] Auto-switching to bridge mode (Bridge is connected)');
                }
                // direct 模式本地 spawn 过的 server 切桥前先停本地进程——
                // 请求改走 bridge 后本地进程的 pending 无人消费，且 bridge 查无配置回
                // config_missing 会重发 spawn 拉起第二个进程（双进程，本地进程成孤儿
                // 泄漏至面板退出）。 修复只挡了断线队列 flush 一条路径，此处补齐
                // send() 自动切桥路径
                if (processes[serverId] && processes[serverId].child) {
                    _stopLocalProcess(serverId);
                }
                sendViaBridge(serverId, message, wrappedCallback);
                return;
            }

            if (mode === 'bridge') {
                sendViaBridge(serverId, message, wrappedCallback);
                return;
            }

            var cpModule = getChildProcess();
            if (!cpModule) {
                mode = 'bridge';
                if (webSocketAvailable()) {
                    connectBridge(function(err) {
                        if (err) {
                            wrappedCallback(err);
                            return;
                        }
                        sendViaBridge(serverId, message, wrappedCallback);
                    });
                } else {
                    _diagnostics.spawnError = 'child_process not available and WebSocket not available';
                    wrappedCallback(new Error(_diagnostics.spawnError));
                }
                return;
            }

            var procInfo = processes[serverId];
            if (!procInfo || !procInfo.child) {
                var child = spawnProcess(serverId);
                if (!child) {
                    wrappedCallback(new Error(_diagnostics.spawnError || 'Failed to start server process: ' + serverId));
                    return;
                }
                procInfo = processes[serverId];
            }

            var req;
            try {
                req = JSON.parse(message);
            } catch (e) {
                wrappedCallback(new Error('Invalid JSON message: ' + e.message));
                return;
            }

            if (req.id !== undefined) {
                procInfo.pending[req.id] = wrappedCallback;
            }

            try {
                procInfo.child.stdin.write(message + '\n');
            } catch (e) {
                if (req.id !== undefined) {
                    delete procInfo.pending[req.id];
                }
                console.warn('[MCP ' + serverId + '] stdin write failed: ' + e.message);
                wrappedCallback(new Error('Failed to write to server process: ' + e.message));
            }
        }

        function stopServer(serverId) {
            // HTTP/SSE transport
            if (httpConnections[serverId]) {
                disconnectHttpServer(serverId);
                return;
            }

            if (mode === 'bridge') {
                if (bridgeConnected && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                    bridgeWs.send(JSON.stringify({ type: 'stop', serverId: serverId }));
                    // reject 该 server 的在途请求（与 direct 模式 notifyPendingErrors 对齐），
                    // 否则调用方要空等 90s send 超时才收到错误
                    _rejectServerPending(serverId, new Error('Server stopped'));
                    bridgePending[serverId] = null;
                    // 桥分支同时清理本地 processes 残留（direct→bridge 切换窗口
                    // 遗留的本地进程）——只向 bridge 发 stop 杀 bridge 侧进程，本地进程
                    // 会泄漏至面板退出（_intentionalStop 置位防止 close 回调误触发自动重启）
                    if (processes[serverId] && processes[serverId].child) {
                        _stopLocalProcess(serverId);
                    }
                    return;
                }
                // bridge 模式但连接断开（bridgeWs 为空/非 OPEN）——stop 帧无法
                // 送达 bridge。把 serverId 记入待发 stop 清单，WS onopen 后统一补发
                //（stop 在 flush 的 spawn 之后发送，停止意图最终压过恢复拉起）。
                // 在途请求照旧拒绝；不 return——落到下方 direct 兜底分支处理本地进程残留
                pendingBridgeStops[serverId] = true;
                _rejectServerPending(serverId, new Error('Server stopped'));
                bridgePending[serverId] = null;
                // 同时删除 serverConfigs——config_missing 重发路径的 stop 意图
                // 消费点。重连 onopen 补发 stop（清单消费完毕）后，flushBridgeConnect
                // Callbacks 放行的迟到请求若命中 bridge 侧 config_missing，重发逻辑会因
                // serverConfigs 仍在而把已停 server 重新拉起成无主孤儿（lifecycle 已
                // stopped、recoverAll 跳过，与同型危害且迟到请求在用户已点
                // 停止后仍被执行）。删除后 config_missing 走无配置分支：不重发 spawn，
                // 在途请求快速失败。start 经 configureServer 重建配置不受影响
                //（start 会撤销待发 stop，后写意图胜出）
                delete serverConfigs[serverId];
            }

            // direct 兜底分支（含：bridge 模式断线时也经此清理本地残留）
            _stopLocalProcess(serverId);
        }

        function stopAll() {
            // Clean up HTTP/SSE connections
            var httpIds = Object.keys(httpConnections);
            for (var hi = 0; hi < httpIds.length; hi++) {
                disconnectHttpServer(httpIds[hi]);
            }

            if (mode === 'bridge' && bridgeConnected && bridgeWs) {
                bridgeWs.send(JSON.stringify({ type: 'stopAll' }));
                // 同 stopServer：reject 全部在途请求，而非静默清空
                flushBridgePending(new Error('Server stopped'));
                // 桥分支同样清理本地 processes 残留（direct→bridge 切换窗口遗留的
                // 本地进程，对照 stopServer 桥分支的 direct 兜底写法）——只向 bridge
                // 发 stopAll 杀 bridge 侧进程，本地进程会泄漏至面板退出
                var localIds = Object.keys(processes);
                for (var li = 0; li < localIds.length; li++) {
                    _stopLocalProcess(localIds[li]);
                }
                return;
            }

            var ids = Object.keys(processes);
            for (var i = 0; i < ids.length; i++) {
                stopServer(ids[i]);
            }
            processes = {};
            serverConfigs = {};
        }

        var cpModule = getChildProcess();
        if (!cpModule && webSocketAvailable()) {
            mode = 'bridge';
            connectBridge(function(err) {
                if (!err) {
                    console.log('[MCP] 通过 Bridge 转发，CEF 环境无 child_process');
                }
            });
        } else if (cpModule) {
            console.log('[MCP] Running in direct mode (child_process available)');
        } else {
            console.warn('[MCP] child_process not available, WebSocket not available - MCP servers cannot run');
        }

        // 等待 Bridge(WebSocket) 握手成功 —— 作为「桥已就绪」的权威信号。
        // bridge-server 在同一个 http.Server 上升级成 WebSocket（见 bridge-server.js 的 'upgrade' 处理），
        // 故 WS onopen 即代表 HTTP /health 亦可用。用它取代启动阶段易因 HTTP 探测 fetch 挂起而误判的
        // waitForReady 轮询（挂起 fetch 会把等待链卡死，最后落到 watchdog 误判，尽管桥其实已在线）。
        // - 已连接：立即 resolve(true)
        // - 连接中/未连接：注册到 connectBridge 回调队列，ws onopen 时回调带 null 触发 resolve(true)
        // - 超时未握手：resolve(false)，由调用方（main.js 启动门）按既有链路回退/弹窗
        function waitForBridgeConnected(timeoutMs) {
            return new Promise(function (resolve) {
                if (bridgeConnected && bridgeWs && bridgeWs.readyState === WebSocket.OPEN) {
                    resolve(true);
                    return;
                }
                var wait = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : 4000;
                var settled = false;
                var tmr = null;
                function done(ok) {
                    if (settled) return;
                    settled = true;
                    if (tmr) { clearTimeout(tmr); tmr = null; }
                    resolve(ok);
                }
                // connectBridge 已 connected 会立即 flush callback(null)；连接中则入队待 onopen。
                connectBridge(function (err) { done(!err); });
                tmr = setTimeout(function () { tmr = null; done(false); }, wait);
            });
        }

        // 同步查询桥就绪（供启动门兜底复核 + 失败遮罩自愈轮询用）——
        // WS onopen 即代表 HTTP 可用（同端口 upgrade，见 waitForBridgeConnected 注释）。
        function isBridgeConnected() {
            try { return !!(bridgeConnected && bridgeWs && bridgeWs.readyState === WebSocket.OPEN); } catch (_) { return false; }
        }

        return {
            send: send,
            configureServer: configureServer,
            removeConfig: removeConfig,
            stopServer: stopServer,
            stopAll: stopAll,
            getDiagnostics: getDiagnostics,
            waitForBridgeConnected: waitForBridgeConnected,
            isBridgeConnected: isBridgeConnected,
            setOnProcessExit: function(fn) { onProcessExit = fn; },
            setOnSseDisconnected: function(fn) { onSseDisconnected = fn; },
            setOnSseReconnected: function(fn) { onSseReconnected = fn; },
            setOnBridgeReconnect: function(fn) { onBridgeReconnect = fn; }
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createCommunicationProvider = createCommunicationProvider;

})(window);
