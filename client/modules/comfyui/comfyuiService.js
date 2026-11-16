(function (global) {
    // 内网/本机判定：优先复用 providerRegistry 的统一实现（单一事实源），
    // 注册表未加载时退回本地副本，保证本模块可独立工作。
    function isPrivateHost(h) {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        if (registry && typeof registry.isPrivateOrLocalHost === 'function') {
            return registry.isPrivateOrLocalHost(h);
        }
        h = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
        if (!h) return false;
        if (h === 'localhost' || h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
        if (/\.(local|lan|internal)$/.test(h)) return true;
        if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
            var seg = h.split('.').map(function (s) { return parseInt(s, 10); });
            for (var i = 0; i < 4; i++) {
                if (seg[i] > 255) return false;
            }
            if (seg[0] === 127 || seg[0] === 10) return true;
            if (seg[0] === 172 && seg[1] >= 16 && seg[1] <= 31) return true;
            if (seg[0] === 192 && seg[1] === 168) return true;
            return false;
        }
        return false;
    }

    function createComfyUIService(options) {
        var host = (options && options.host) || '127.0.0.1';
        var port = (options && options.port) || 8188;
        var baseUrl = 'http://' + host + ':' + port;
        var wsUrl = 'ws://' + host + ':' + port;
        var clientId = null;
        var currentPromptId = null;
        var ws = null;
        var connected = false;
        var reconnecting = false;
        var objectInfoCache = null;
        // objectInfoCache 的陈旧标记——WS 断线（服务器重启/新增节点）时置位。
        // 只在 updateEndpoint/disconnect 清缓存时，onclose 重连后 connect 的预热
        // getObjectInfo(undefined, true) 命中旧缓存直接返回，模型清单与节点 schema
        // 跨重连持续陈旧，只有面板重载才恢复。置 stale 后：全量拉取绕过旧缓存重拉；
        // 重拉失败时回退旧缓存（离线不退化）。
        var objectInfoStale = false;
        // 重连成功回调（controller 注册：联动清 modelRegistry schema 缓存 +
        // 重拉模型清单/schema 预热）。仅「曾建立连接后掉线再成功恢复」触发，首次连接不触发。
        var reconnectCallbacks = [];
        var reconnectPending = false;

        // 仅允许本机/内网 ComfyUI：公网地址直接拦截（baseUrl 固定 http:// 拼接，
        // 公网请求会导致 API Key 明文外发），所有网络请求前置校验。
        function _assertPrivateHost() {
            if (isPrivateHost(host)) return;
            throw new Error('已拦截外网 ComfyUI 地址（' + host + '）：仅允许本机/内网地址（如 127.0.0.1、192.168.x.x、10.x.x.x、172.16-31.x.x 或 *.local/*.lan/*.internal）');
        }

        var progressCallback = null;
        var executingCallback = null;
        var completeCallback = null;
        var errorCallback = null;

        function generateUUID() {
            return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
                var r = Math.random() * 16 | 0;
                var v = c === 'x' ? r : (r & 0x3 | 0x8);
                return v.toString(16);
            });
        }

        function ensureClientId() {
            if (!clientId) clientId = generateUUID();
            return clientId;
        }

        // REST API
        // testConnection 带超时（对齐同文件 fetch 超时模式，restGetTimeoutMs 注入）——
        // 裸 fetch 在服务器 accept 后响应停滞时永不 settle，测试连接可无限挂起。
        async function testConnection() {
            _assertPrivateHost();
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.restGetTimeoutMs === 'number')
                ? global.AEComfyUI.restGetTimeoutMs : 60000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (_, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('连接测试超时')); }, timeoutMs);
            });
            // 网络层失败（fetch reject）转为既有用户提示；HTTP 状态错误在 then 内已转明确文案原样上抛
            var doFetch = fetch(baseUrl + '/system_stats').catch(function () {
                throw new Error('无法连接到 ComfyUI，请确认已启动且地址端口正确');
            }).then(function (resp) {
                if (resp.status === 403) {
                    throw new Error('连接被拒绝 (403)，请确认 ComfyUI 已启用 CORS：启动时添加 --enable-cors-header');
                }
                if (!resp.ok) throw new Error('连接失败: ' + resp.status);
                return resp.json();
            });
            try {
                return await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        // 其余 REST 端点补超时（对齐 uploadImage 的 单点方案）——
        // 裸 fetch 在服务端 accept 后响应停滞时永不 settle：getObjectInfo 挂起会经
        // templateEngine 的 _pendingFetches 永久污染并发缓存（后来者复用永不 resolve
        // 的 pending），提交/历史/队列/下载挂起则让调用方永久等待。超时 reject 后
        // templateEngine 的 .catch 自会清 pending，缓存污染自愈。GET 类默认 60s、
        // submitPrompt 默认 120s（与上传同量级），注入常量 restGetTimeoutMs /
        // submitPromptTimeoutMs（单测用，与 uploadImageTimeoutMs 同机制）。
        async function submitPrompt(workflowJson, apiKey) {
            _assertPrivateHost();
            ensureClientId();
            if (!connected) await connect();
            var body = { prompt: workflowJson, client_id: clientId };
            // 如果配置了 API Key，通过 extra_data 传入
            if (apiKey) {
                body.extra_data = { api_key_comfy_org: apiKey };
            }
            var headers = { 'Content-Type': 'application/json' };
            if (apiKey) {
                headers['X-API-Key'] = apiKey;
            }
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.submitPromptTimeoutMs === 'number')
                ? global.AEComfyUI.submitPromptTimeoutMs : 120000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (resolve, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('提交超时')); }, timeoutMs);
            });
            var resp;
            try {
                resp = await Promise.race([
                    fetch(baseUrl + '/prompt', {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(body)
                    }),
                    timeoutP
                ]);
            } finally {
                clearTimeout(timeoutTimer);
            }
            if (!resp.ok) {
                var err = await resp.json().catch(function () { return {}; });
                // 提取 API 返回的错误信息
                var errorResult = {};
                if (err.node_errors && Object.keys(err.node_errors).length > 0) {
                    errorResult = err;
                } else if (err.error) {
                    // 有些 API 使用 { error: "message" } 格式
                    errorResult = { node_errors: {}, error: err.error, message: err.message };
                } else {
                    // 构造包含原始响应的错误对象，便于调试
                    errorResult = err;
                    // 确保有 node_errors 属性标记为错误
                    if (!errorResult.node_errors) {
                        errorResult.node_errors = {};
                    }
                }
                return { error: errorResult };
            }
            var data = await resp.json();
            currentPromptId = data.prompt_id;
            return data.prompt_id;
        }

        async function getHistory(promptId) {
            _assertPrivateHost();
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.restGetTimeoutMs === 'number')
                ? global.AEComfyUI.restGetTimeoutMs : 60000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (resolve, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('获取历史超时')); }, timeoutMs);
            });
            var doFetch = fetch(baseUrl + '/history/' + promptId).then(function (resp) {
                if (!resp.ok) throw new Error('获取历史失败: ' + resp.status);
                return resp.json();
            }).then(function (data) {
                return data[promptId] || data;
            });
            try {
                return await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        async function getQueue() {
            _assertPrivateHost();
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.restGetTimeoutMs === 'number')
                ? global.AEComfyUI.restGetTimeoutMs : 60000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (resolve, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('获取队列超时')); }, timeoutMs);
            });
            var doFetch = fetch(baseUrl + '/queue').then(function (resp) {
                if (!resp.ok) throw new Error('获取队列失败: ' + resp.status);
                return resp.json();
            });
            try {
                return await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        // 取消目标按调用方传入的 promptId 优先——currentPromptId 是"最后一次提交"
        // 的全局值，表单与画布并发生成时取消会打错对象；调用方（如进度卡取消按钮）
        // 知道自己对应哪个 prompt，显式传入。未传时保持旧行为（取最后一次提交）。
        // Promise.race 超时（对齐同文件 fetch 超时模式）——裸 fetch 挂起时
        // 进度卡「取消」点击无任何反馈。
        async function interrupt(promptId) {
            _assertPrivateHost();
            var body = {};
            var target = (typeof promptId === 'string' && promptId) ? promptId : currentPromptId;
            if (target) body.prompt_id = target;
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.restGetTimeoutMs === 'number')
                ? global.AEComfyUI.restGetTimeoutMs : 60000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (_, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('取消超时')); }, timeoutMs);
            });
            var doFetch = fetch(baseUrl + '/interrupt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function (resp) {
                if (!resp.ok) throw new Error('取消失败: ' + resp.status);
            });
            try {
                return await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        // 同 interrupt，clearQueue 支持指定 promptId（不传则维持旧的"最后一次提交"行为）
        // Promise.race 超时（对齐同文件 fetch 超时模式）
        async function clearQueue(promptId) {
            // 只清理当前客户端的排队任务，不影响其他客户端
            var target = (typeof promptId === 'string' && promptId) ? promptId : currentPromptId;
            var body = target ? { delete: [target] } : {};
            if (!target) return; // 无任务时不发请求
            _assertPrivateHost();
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.restGetTimeoutMs === 'number')
                ? global.AEComfyUI.restGetTimeoutMs : 60000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (_, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('清空队列超时')); }, timeoutMs);
            });
            var doFetch = fetch(baseUrl + '/queue', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            }).then(function (resp) {
                if (!resp.ok) throw new Error('清空队列失败: ' + resp.status);
            });
            try {
                await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
            if (target === currentPromptId) currentPromptId = null;
        }

        // 上传超时的单点修复—— 只给表单路径（controller.
        // _uploadImageWithTimeout）包了超时，LLM 工具路径（bootstrap）、画布路径
        // （sharedUtils）与 controller passthrough 的裸 await 在服务端 accept 后
        // 响应停滞时 Promise 永不 settle（Agent 工具调用永不返回 / 画布节点挂死）。
        // 超时放进 uploadImage 内部后所有调用方统一获得保护；controller 侧
        // _uploadImageWithTimeout 保留（双层 race 无害、文案一致，兼容既有测试）。
        // 常量沿用 global.AEComfyUI.uploadImageTimeoutMs 注入（单测用），默认 120s。
        async function uploadImage(blob, filename) {
            _assertPrivateHost();
            var formData = new FormData();
            formData.append('image', blob, filename);
            formData.append('overwrite', 'true');
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.uploadImageTimeoutMs === 'number')
                ? global.AEComfyUI.uploadImageTimeoutMs : 120000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (resolve, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('图片上传超时')); }, timeoutMs);
            });
            var doUpload = fetch(baseUrl + '/upload/image', {
                method: 'POST',
                body: formData
            }).then(function (resp) {
                if (!resp.ok) throw new Error('上传失败: ' + resp.status);
                return resp.json();
            });
            try {
                return await Promise.race([doUpload, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        async function downloadOutput(filename, subfolder, type) {
            _assertPrivateHost();
            var url = baseUrl + '/view?filename=' + encodeURIComponent(filename) +
                '&subfolder=' + encodeURIComponent(subfolder || '') +
                '&type=' + encodeURIComponent(type || 'output');
            // 下载产物独立超时档——与元数据 GET 共用 restGetTimeoutMs(60s) 时，
            // 慢速链路下载大视频（生成已成功、积分已耗）60s 超时即丢产物。放宽至 10 分钟
            // （内网/本机地址约束下大文件也有余量）；global.AEComfyUI.downloadOutputTimeoutMs
            // 可注入（单测用，与 uploadImageTimeoutMs 同机制）
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.downloadOutputTimeoutMs === 'number')
                ? global.AEComfyUI.downloadOutputTimeoutMs : 600000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (resolve, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('下载超时')); }, timeoutMs);
            });
            var doFetch = fetch(url).then(function (resp) {
                if (!resp.ok) throw new Error('下载失败: ' + resp.status);
                return resp.blob();
            });
            try {
                return await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        async function getObjectInfo(nodeClass, _skipTimeout) {
            _assertPrivateHost();
            var url = baseUrl + '/object_info';
            if (nodeClass) {
                url = baseUrl + '/object_info/' + encodeURIComponent(nodeClass);
            }
            // 只有全量拉取才缓存；断线后 stale 标记置位时绕过旧缓存重拉
            if (!nodeClass && objectInfoCache && !objectInfoStale) return objectInfoCache;
            var doFetch = fetch(url).then(function (resp) {
                if (!resp.ok) throw new Error('获取节点信息失败: ' + resp.status);
                return resp.json();
            }).then(function (data) {
                if (!nodeClass) {
                    objectInfoCache = data;
                    objectInfoStale = false;   // 重拉成功 → 陈旧标记复位
                }
                // 带 nodeClass 时返回该节点的定义：ComfyUI 以 nodeClass 为 key
                return nodeClass ? (data[nodeClass] || data) : data;
            });
            // stale 全量重拉失败 → 回退旧缓存（离线回退不退化；stale 保持，
            // 下次调用继续尝试刷新，不会把旧数据当新数据无限沿用而不自知）
            if (!nodeClass && objectInfoCache && objectInfoStale) {
                doFetch = doFetch.catch(function (e) {
                    console.warn('[ComfyUIService] 重连后刷新节点信息失败，沿用旧缓存:', e && e.message);
                    return objectInfoCache;
                });
            }
            // connect 的预热调用（_skipTimeout=true，fire-and-forget 无等待方）
            // 豁免超时——挂起仅表现为缓存未预热（不阻塞任何调用方、不污染 templateEngine
            // 的 pending 缓存，该缓存仅由显式的带 nodeClass 拉取写入），且避免为预热
            // 注册瞬态定时器干扰重连链路的定时器语义；显式拉取路径照常带超时
            if (_skipTimeout) return doFetch;
            var timeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.restGetTimeoutMs === 'number')
                ? global.AEComfyUI.restGetTimeoutMs : 60000;
            var timeoutTimer = null;
            var timeoutP = new Promise(function (resolve, reject) {
                timeoutTimer = setTimeout(function () { reject(new Error('获取节点信息超时')); }, timeoutMs);
            });
            try {
                return await Promise.race([doFetch, timeoutP]);
            } finally {
                clearTimeout(timeoutTimer);
            }
        }

        // WebSocket — shared handler setup
        function setupWsHandlers(socket) {
            socket.onmessage = function (event) {
                // Skip binary messages (preview images)
                if (event.data instanceof ArrayBuffer || event.data instanceof Blob) return;
                try {
                    var msg = JSON.parse(event.data);
                    var data = msg.data || {};
                    switch (msg.type) {
                        case 'progress':
                            if (progressCallback) progressCallback(data);
                            break;
                        case 'executing':
                            if (data.node === null) {
                                if (completeCallback) completeCallback(data);
                            } else {
                                if (executingCallback) executingCallback(data);
                            }
                            break;
                        case 'executed':
                            break;
                        case 'execution_error':
                            if (errorCallback) errorCallback(data);
                            break;
                        case 'execution_start':
                            break;
                        case 'status':
                            break;
                    }
                } catch (e) {
                    console.warn('[ComfyUIService] 消息解析错误:', e);
                }
            };

            socket.onclose = function () {
                connected = false;
                // 已建立的连接掉线 → 服务器可能已重启/节点集变化，标记
                // object_info 陈旧并等待重连成功后重拉（重拉失败由 getObjectInfo 回退旧缓存）
                objectInfoStale = true;
                reconnectPending = true;
                attemptReconnect(3, 2000);
            };

            socket.onerror = function () {
                connected = false;
            };
        }

        var _connectPromise = null;
        function connect() {
            if (connected) return Promise.resolve();
            // 并发调用（表单+画布同时首次提交）共享同一连接 Promise，否则各自
            // new WebSocket 建立双连接：消息双发且 disconnect 只关其一，泄漏一个。
            // attemptReconnect 的重连定时器也改走这里（共享同一 _connectPromise），
            // 重连窗口内 submitPrompt 触发的 connect 与重连定时器不再各建一条连接
            if (_connectPromise) return _connectPromise;
            _connectPromise = new Promise(function (resolve, reject) {
                _assertPrivateHost();
                ensureClientId();
                var wsFullUrl = wsUrl + '/ws?clientId=' + clientId;
                var connectFailed = false;
                var connectResolved = false;
                // 发起时捕获连接纪元——握手期间被 disconnect()/updateEndpoint()
                // 作废时，onopen 不让新连接落地（attemptReconnect 改走
                // connect 后由其下轮纪元检查终止重试链）
                var epoch = _connEpoch;
                ws = new WebSocket(wsFullUrl);
                // 握手竞速超时（默认 10s，global.AEComfyUI.connectTimeoutMs 可注入）——
                // 服务器 TCP accept 后 WS 握手停滞（onopen/onerror/onclose 均不触发）时
                // Promise 永不 settle，submitPrompt 永久挂起。超时兜底 reject 并清
                // _connectPromise（纪元一致时），后续调用可重新发起连接
                var connectTimeoutMs = (global.AEComfyUI && typeof global.AEComfyUI.connectTimeoutMs === 'number')
                    ? global.AEComfyUI.connectTimeoutMs : 10000;
                var connectTimer = setTimeout(function () {
                    if (connectResolved) return;
                    connectFailed = true;
                    try { ws.onclose = null; ws.onerror = null; ws.close(); } catch (_) {}
                    if (epoch === _connEpoch) _connectPromise = null;
                    reject(new Error('WebSocket 连接超时'));
                }, connectTimeoutMs);

                ws.onopen = function () {
                    connectResolved = true;
                    clearTimeout(connectTimer);
                    if (epoch !== _connEpoch) {
                        // 竞态：握手期间被 disconnect——新连接不落地，直接关掉；
                        // resolve 而非 reject（调用方按未连接状态继续）
                        try { ws.onclose = null; ws.close(); } catch (_) {}
                        _connectPromise = null;
                        resolve();
                        return;
                    }
                    connected = true;
                    setupWsHandlers(ws);
                    // 重连成功（曾掉线）→ 通知订阅者清 schema 缓存并重拉；
                    // 置位在预热之前，保证预热 getObjectInfo 走 stale 重拉而非旧缓存
                    var wasReconnect = reconnectPending;
                    reconnectPending = false;
                    // 预热全量 object_info 缓存，豁免超时（见 getObjectInfo 内说明）
                    getObjectInfo(undefined, true).catch(function () {});
                    if (wasReconnect) {
                        for (var ri = 0; ri < reconnectCallbacks.length; ri++) {
                            try { reconnectCallbacks[ri](); } catch (_) {}
                        }
                    }
                    _connectPromise = null;
                    resolve();
                };

                ws.onclose = function () {
                    connected = false;
                    if (!connectResolved) {
                        // 握手阶段即被服务端关闭（拒握手只 close 不触发 error）——
                        // 兜底 reject，防 submitPrompt 永久挂起；重连照旧走 attemptReconnect
                        clearTimeout(connectTimer);
                        if (epoch === _connEpoch) _connectPromise = null;
                        reject(new Error('WebSocket 连接关闭'));
                    }
                    if (!connectFailed) {
                        attemptReconnect(3, 2000);
                    }
                };

                ws.onerror = function () {
                    connectFailed = true;
                    if (!connectResolved) {
                        clearTimeout(connectTimer);
                        connected = false;
                        _connectPromise = null;
                        reject(new Error('WebSocket 连接失败'));
                    }
                };
            });
            // executor 同步抛错（私网断言）未走 onerror，rejected promise 会残留在
            // _connectPromise：失败后清缓存，后续调用可重新发起连接而非复用旧错误
            _connectPromise.catch(function () { if (!connected) _connectPromise = null; });
            return _connectPromise;
        }

        // 连接纪元——disconnect()/updateEndpoint() 递增；重连链路捕获发起时的纪元，
        // 每步校验，纪元变化（用户主动断开/换端点）即自停。否则 attemptReconnect 的
        // setTimeout 链不随 disconnect 取消，主动断开后仍向新 wsUrl 建 WS 并置
        // connected=true（僵尸连接，指向换端点后的错误地址）。
        var _connEpoch = 0;

        function attemptReconnect(maxAttempts, interval) {
            if (reconnecting) return;
            reconnecting = true;
            var epoch = _connEpoch;
            var attempts = 0;
            function tryConnect() {
                if (epoch !== _connEpoch) { reconnecting = false; return; }
                if (connected || attempts >= maxAttempts) { reconnecting = false; return; }
                attempts++;
                setTimeout(function () {
                    if (epoch !== _connEpoch) { reconnecting = false; return; }
                    if (connected) { reconnecting = false; return; }
                    // 改走 connect()（复用 _connectPromise 去重）——重连窗口内
                    // submitPrompt 触发的 connect 与本定时器共享同一连接，不再裸
                    // new WebSocket 产生双连接（被覆盖者成孤儿连接泄漏）。connect 失败
                    // （reject）时按 attempts 计数递归重试；纪元变化由 connect 的 onopen
                    // 校验 + 本函数入口检查共同终止链
                    connect().then(function () {
                        reconnecting = false;
                    }, function () {
                        tryConnect();
                    });
                }, interval);
            }
            tryConnect();
        }

        function updateEndpoint(newHost, newPort) {
            disconnect();
            if (newHost) host = newHost;
            if (typeof newPort === 'number' && newPort > 0) port = newPort;
            baseUrl = 'http://' + host + ':' + port;
            wsUrl = 'ws://' + host + ':' + port;
            objectInfoCache = null;
        }

        function disconnect() {
            _connEpoch++;  // 作废在途重连链路
            if (ws) {
                ws.onclose = null;
                ws.close();
                ws = null;
            }
            _connectPromise = null;
            connected = false;
            objectInfoCache = null;
        }

        // 轻量探活：REST GET /system_stats，4s 超时，成功返 true，失败/超时返 false（永不 reject）。
        // 顶栏状态灯用这个判可达性——isConnected() 只反映 WebSocket 状态，而 WS 仅在首次提交时才开，
        // 闲置时永远 false，灯一直灰。ping 走 REST 才能反映 ComfyUI 是否真在跑。
        function ping() {
            return new Promise(function (resolve) {
                if (!isPrivateHost(host)) { resolve(false); return; } // 外网地址直接判不可达
                var done = false;
                var timer = setTimeout(function () {
                    if (done) return;
                    done = true;
                    resolve(false);
                }, 4000);
                fetch(baseUrl + '/system_stats').then(function (r) {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(!!r.ok);
                }).catch(function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(false);
                });
            });
        }

        return {
            connect: connect,
            disconnect: disconnect,
            updateEndpoint: updateEndpoint,
            isConnected: function () { return connected; },
            getHost: function () { return host; },
            getPort: function () { return port; },
            ping: ping,
            testConnection: testConnection,
            submitPrompt: submitPrompt,
            getHistory: getHistory,
            getQueue: getQueue,
            interrupt: interrupt,
            clearQueue: clearQueue,
            uploadImage: uploadImage,
            downloadOutput: downloadOutput,
            getObjectInfo: getObjectInfo,
            onProgress: function (cb) { progressCallback = cb; },
            onExecuting: function (cb) { executingCallback = cb; },
            onComplete: function (cb) { completeCallback = cb; },
            onError: function (cb) { errorCallback = cb; },
            // 重连成功回调（controller 注册联动清 schema 缓存 + 重拉模型清单）
            onReconnect: function (cb) { if (typeof cb === 'function') reconnectCallbacks.push(cb); }
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createComfyUIService = createComfyUIService;
    global.AEComfyUI.isPrivateHost = isPrivateHost;
})(window);
