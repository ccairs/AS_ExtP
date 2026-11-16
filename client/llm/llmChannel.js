(function(global) {
    'use strict';

    // Helper: find built-in provider by ID from BUILTIN_LLM_PROVIDERS (no literal URLs)
    function _getBuiltinProviderById(platformId) {
        if (!global.AE_LLM || !global.AE_LLM.BUILTIN_LLM_PROVIDERS) return null;
        var builtins = global.AE_LLM.BUILTIN_LLM_PROVIDERS;
        for (var i = 0; i < builtins.length; i++) {
            if (builtins[i].id === platformId) return builtins[i];
        }
        return null;
    }

    function _getFallbackProvider() {
        // Fall back to openrouter if platform unknown or registry unavailable
        return _getBuiltinProviderById('openrouter') || _getBuiltinProviderById('deepseek') || null;
    }

    // 客户端会话标识——声明式会话头（provider.sessionIdHeader，如 OpenCode Go 的
    // x-opencode-session）的兜底取值。Agent 主循环有真实会话 id，会在 context.sessionId
    // 显式传入并优先使用；宠物聊天/ComfyUI 面板/工具描述生成等旁路调用方没有会话概念，
    // 落到这里取安装级稳定 id（值稳定，服务端路由与前缀缓存才有意义）。
    // localStorage 不可用（Node 测试沙箱/无存储环境）时退化为进程内随机 id：请求仍能带上
    // 头（不触发 400），只是跨重启不复用路由。
    var _clientSessionId = '';
    function getClientSessionId() {
        if (_clientSessionId) return _clientSessionId;
        var KEY = 'ae_llm_client_session_id';
        try {
            var saved = global.localStorage && global.localStorage.getItem(KEY);
            if (saved && typeof saved === 'string') {
                _clientSessionId = saved;
                return _clientSessionId;
            }
        } catch (_) {}
        _clientSessionId = 'as-extp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
        try {
            if (global.localStorage && global.localStorage.setItem) global.localStorage.setItem(KEY, _clientSessionId);
        } catch (_) {}
        return _clientSessionId;
    }

    async function resolveLlmConfig(context) {
        var ctx = context || {};
        var globalSettings = {};
        try {
            if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                var appCtx = global.AEAppContainer.getContext();
                if (appCtx && appCtx.settingsStore && typeof appCtx.settingsStore.getGlobalSettings === 'function') {
                    globalSettings = await appCtx.settingsStore.getGlobalSettings({});
                }
            }
        } catch (_) {}

        var platform = ctx.providerId
            || ctx.platform
            || globalSettings.defaultProviderId
            || globalSettings.defaultPlatform
            || 'deepseek';

        var model = ctx.modelId
            || ctx.model
            || globalSettings.defaultModelId
            || globalSettings.defaultModel
            || 'deepseek-v4-pro';

        // 防御：globalSettings 可能存了该 provider 不存在的孤儿模型（历史脏数据/迁移残留），
        // 此时面板显示兜底成首个模型、但存储仍是孤儿，导致用不存在的模型发请求报错。
        // 校验 model 是否在该 provider 的 models 列表里，不在就 fallback 首个。
        var provider = resolveProvider(platform);
        // resolveProvider 对已删除/未知平台会回退到内置兜底 provider（openrouter/
        // deepseek），但 platform 仍是旧 ID——jsonMode/视觉能力按旧 ID 查表恒 false，
        // 调用方还按旧平台解析 API Key 发给回退目标（必 401）。回退发生时把
        // platform 同步为实际请求目标，能力查表/Key 解析/错误提示才与真实请求一致。
        if (provider && provider.id && provider.id !== platform) {
            platform = provider.id;
        }
        if (provider && provider.models && provider.models.length) {
            var modelExists = false;
            for (var mi = 0; mi < provider.models.length; mi++) {
                if (provider.models[mi].id === model) { modelExists = true; break; }
            }
            if (!modelExists) model = provider.models[0].id;
        }

        return { platform: platform, model: model, providerId: platform, modelId: model };
    }

    function resolveProvider(platformId) {
        if (global.AE_LLM && global.AE_LLM.providerRegistry) {
            var provider = global.AE_LLM.providerRegistry.getProvider(platformId);
            if (provider) return provider;
        }
        // Fallback: try builtins, no literal URLs
        return _getBuiltinProviderById(platformId) || _getFallbackProvider();
    }

    function supportsVision(model, platform) {
        // Query registry capabilities only, safe fallback false
        if (!model) return false;
        var platformId = platform;
        if (!platformId) return false;
        if (global.AE_LLM && global.AE_LLM.providerRegistry) {
            return global.AE_LLM.providerRegistry.supportsVision(platformId, model);
        }
        return false;
    }

    function supportsResponseFormat(model, platform) {
        // Query registry capabilities only, safe fallback false
        if (!model) return false;
        var platformId = platform;
        if (!platformId) return false;
        if (global.AE_LLM && global.AE_LLM.providerRegistry) {
            return global.AE_LLM.providerRegistry.supportsJsonMode(platformId, model);
        }
        return false;
    }

    function classifyError(error) {
        var msg = String(error && error.message ? error.message : error).toLowerCase();
        if (msg.indexOf('abort') >= 0 || msg.indexOf('timeout') >= 0 || msg.indexOf('timed out') >= 0) {
            return { type: 'timeout' };
        }
        if (msg.indexOf('failed to fetch') >= 0 || msg.indexOf('network') >= 0 || msg.indexOf('net::') >= 0) {
            return { type: 'network' };
        }
        if (msg.indexOf('401') >= 0 || msg.indexOf('unauthorized') >= 0 || msg.indexOf('invalid api') >= 0) {
            return { type: 'auth' };
        }
        if (msg.indexOf('429') >= 0 || msg.indexOf('rate') >= 0 || msg.indexOf('too many') >= 0) {
            return { type: 'rate' };
        }
        if (msg.indexOf('402') >= 0 || msg.indexOf('payment') >= 0 || msg.indexOf('insufficient') >= 0 || msg.indexOf('quota') >= 0 || msg.indexOf('balance') >= 0) {
            return { type: 'quota' };
        }
        if (msg.indexOf('500') >= 0 || msg.indexOf('502') >= 0 || msg.indexOf('503') >= 0 || msg.indexOf('server') >= 0) {
            return { type: 'server' };
        }
        return { type: 'unknown' };
    }

    function isAbortError(error) {
        if (!error) return false;
        if (error.name === 'AbortError') return true;
        var msg = String(error.message || error).toLowerCase();
        return msg.indexOf('abort') >= 0;
    }

    async function streamRequest(opts, callbacks) {
        var timeoutMs = Number(opts.timeoutMs) || 120000;
        var timeoutId = null;
        var activeReader = null;

        // 流式通道同一缺口的补全：超时须能真正中止底层 fetch 连接——
        // 首字节窗口（头未到）内超时只 resolve 不 abort，代理/服务端挂起时连接
        // 持续占用（浏览器对同 host 并发连接有限，反复超时后新请求排队饿死）。
        // 内部建 AbortController，外部 signal 支持 addEventListener 时联动转发
        // （保持用户主动停止语义）；不支持事件接口的 signal（旧 mock/极端环境）
        // 回退直传。
        var signalOwner = null;
        var fetchSignal = opts.signal || null;
        if (typeof AbortController === 'function') {
            signalOwner = new AbortController();
            fetchSignal = signalOwner.signal;
            if (opts.signal) {
                if (opts.signal.aborted) {
                    signalOwner.abort();
                } else if (typeof opts.signal.addEventListener === 'function') {
                    opts.signal.addEventListener('abort', function () { signalOwner.abort(); });
                } else {
                    fetchSignal = opts.signal;
                    signalOwner = null;
                }
            }
        }

        var state = { content: '', reasoningContent: '', toolCallsAccum: {}, finishReason: '' };
        var provider = resolveProvider(opts.platform);
        var protocol = provider.protocol || 'openai-compatible';
        var adapter = global.AE_LLM.protocolAdapters.getAdapter(protocol);
        var temperature = provider.defaults && provider.defaults.temperature !== undefined
            ? provider.defaults.temperature : 0.2;

        // jsonMode: 启用后请求 API 级 JSON 格式强制（模型支持时），从源头杜绝 JSON 外文字
        var responseFormat = (opts.jsonMode && supportsResponseFormat(opts.model, opts.platform))
            ? { type: 'json_object' } : null;

        return new Promise(function(resolve) {
            var timedOut = false;
            timeoutId = setTimeout(function() {
                timedOut = true;
                // 中止底层连接：头未到时唯一能真正取消 fetch 的通道
                if (signalOwner) { try { signalOwner.abort(); } catch (_) {} }
                // 取消正在进行的 reader，中止流式读取和后续 token 回调
                if (activeReader) { try { activeReader.cancel(); } catch (_) {} }
                resolve({ error: 'REQUEST_TIMEOUT', message: '请求超时，模型在 ' + Math.round(timeoutMs / 1000) + ' 秒内未响应' });
            }, timeoutMs);

            var buildCtx = {
                provider: provider,
                model: opts.model || '',
                messages: opts.messages || [],
                tools: Array.isArray(opts.tools) && opts.tools.length > 0 ? opts.tools : null,
                toolChoice: Array.isArray(opts.tools) && opts.tools.length > 0 ? 'auto' : null,
                stream: true,
                temperature: temperature,
                responseFormat: responseFormat,
                reasoningEffort: opts.reasoningEffort || null
            };

            var requestBody = adapter.buildRequest(buildCtx);
            var defaultEndpoint = protocol === 'anthropic-messages' ? '/v1/messages' : '/chat/completions';
            var apiUrl = provider.baseUrl + (provider.endpoint || defaultEndpoint);
            var headers = global.AE_LLM.protocolAdapters.makeHeaders(provider, opts.apiKey || '', {
                sessionId: opts.sessionId || getClientSessionId()
            });

            fetch(apiUrl, {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(requestBody),
                signal: fetchSignal
            }).then(async function(response) {
                if (timedOut) {
                    // 已超时，取消响应体读取，丢弃后续 token
                    try { response.body.cancel(); } catch (_) {}
                    return;
                }

                if (!response.ok) {
                    var errText = '';
                    try { errText = await response.text(); } catch (_) {}
                    // 错误体读取完成才脱离首字节超时——头到达即清表会让
                    // text() 停滞（代理缓冲挂起）时超时回调永不触发，Promise 永挂
                    clearTimeout(timeoutId);
                    resolve({ error: 'API_ERROR', message: 'API请求失败: ' + response.status + ' ' + errText, status: response.status });
                    return;
                }

                var reader = response.body.getReader();
                activeReader = reader;
                // 流读取已建立，首字节超时使命结束；读流阶段由空闲超时（readTimeoutId）接管
                clearTimeout(timeoutId);
                var decoder = new TextDecoder();
                var buffer = '';
                // 流式解析改走 SSE 事件装配器——按空行边界分派事件、同一事件
                // 多个 data: 行以 \n 合并成完整 payload 后再 parse（规范合规的多行拆分
                // 编码逐行 parse 必失败而静默丢事件）。测试/mock 环境替换
                // protocolAdapters 且未提供装配器工厂时，回退逐行解析，行为不变。
                var sseAssembler = (global.AE_LLM.protocolAdapters.createSseEventAssembler
                    && global.AE_LLM.protocolAdapters.createSseEventAssembler(adapter.parseSseLine)) || null;

                // 读流阶段兜底超时：首字节超时已在上方 clearTimeout，
                // 但服务端 [DONE] 后若保持连接不关闭，reader.read() 会无限挂起。
                // 采用「空闲超时」语义：收到 chunk 只刷新 lastChunkAt 时间戳，不逐 token 重建定时器
                // （避免高吞吐下每 token 清/建定时器的开销）；定时器每轮窗口到期时检查一次，
                // 仅真正静默超过 timeoutMs 才取消 reader 并按超时返回。
                // 深度思考期间 reasoning token 慢速流出不再被总时长误杀。
                var lastChunkAt = Date.now();
                var readTimeoutId = null;
                function scheduleReadIdle() {
                    if (readTimeoutId) clearTimeout(readTimeoutId);
                    readTimeoutId = setTimeout(function() {
                        if (Date.now() - lastChunkAt >= timeoutMs) {
                            if (activeReader) { try { activeReader.cancel(); } catch (_) {} }
                            resolve({ error: 'REQUEST_TIMEOUT', message: '请求超时，模型在 ' + Math.round(timeoutMs / 1000) + ' 秒内未响应' });
                            return;
                        }
                        // 窗口内仍有数据流入：按剩余空闲时间续期
                        scheduleReadIdle();
                    }, timeoutMs - (Date.now() - lastChunkAt));
                }
                scheduleReadIdle();

                try {
                    var doneReceived = false;
                    while (true) {
                        var readResult = await reader.read();
                        if (readResult.done) break;

                        // 收到数据视为活跃：刷新空闲超时计时基准
                        lastChunkAt = Date.now();
                        buffer += decoder.decode(readResult.value, { stream: true });
                        var lines = buffer.split('\n');
                        buffer = lines.pop() || '';

                        for (var li = 0; li < lines.length; li++) {
                            var parsed = sseAssembler
                                ? sseAssembler.feed(lines[li])
                                : adapter.parseSseLine(lines[li]);
                            if (parsed) {
                                if (parsed.done) { doneReceived = true; break; }
                                adapter.processStreamEvent(parsed, state, callbacks);
                            }
                        }
                        if (doneReceived) break;
                    }

                    // 哨兵帧（OpenAI [DONE] / Anthropic message_stop）break 后主动
                    // cancel reader——网关对 SSE 保活不关连接时，不 cancel 底层连接会一直
                    // 挂到空闲超时/浏览器并发连接数上限
                    if (doneReceived) {
                        try { reader.cancel(); } catch (_) {}
                    }

                    // 流结束冲刷——服务端关流时最后一个事件可能无尾随空行，
                    // 装配器路径把 buffer 残余行投喂后统一 flush 分派（只把整段
                    // buffer 当单行 parse，多行残余必失败）；回退路径保持原单行语义。
                    if (sseAssembler) {
                        var tailLines = buffer.split('\n');
                        for (var ti = 0; ti < tailLines.length; ti++) {
                            var tailParsed = sseAssembler.feed(tailLines[ti]);
                            if (tailParsed && !tailParsed.done) {
                                adapter.processStreamEvent(tailParsed, state, callbacks);
                            }
                        }
                        var flushed = sseAssembler.flush();
                        if (flushed && !flushed.done) {
                            adapter.processStreamEvent(flushed, state, callbacks);
                        }
                    } else {
                        var pending = buffer.trim();
                        if (pending) {
                            var lastParsed = adapter.parseSseLine(pending);
                            if (lastParsed && !lastParsed.done) adapter.processStreamEvent(lastParsed, state, callbacks);
                        }
                    }

                    resolve({
                        content: state.content,
                        reasoningContent: state.reasoningContent || '',
                        toolCalls: adapter.finalizeToolCalls(state.toolCallsAccum),
                        finishReason: state.finishReason,
                        usage: state.usage || null
                    });
                } finally {
                    clearTimeout(readTimeoutId);
                    activeReader = null;
                }
            }).catch(function(err) {
                clearTimeout(timeoutId);
                if (isAbortError(err)) {
                    // 主动 abort（用户停止/会话切换）：独立错误类型；message 保留 'abort' 字样，
                    // 兼容调用方对 result.message 包含 'abort' 的识别（agent controller / panelChat）
                    resolve({ error: 'ABORTED', message: 'Request aborted', aborted: true });
                    return;
                }
                resolve({ error: 'NETWORK_ERROR', message: String(err && err.message ? err.message : err) });
            });
        });
    }

    // 视频文件上传（方案 1）：把本地视频 Blob 上传到 provider 的 Files API，返回 file_id。
    // provider 需配置 videoInput.upload（endpoint/purpose），否则返回 null。
    // 上传请求不能带 Content-Type（浏览器自动加 multipart boundary），因此手动构造 headers。
    async function uploadVideoFile(blob, filename, opts) {
        opts = opts || {};
        var provider = opts.provider;
        var apiKey = opts.apiKey || '';
        if (!blob || !provider || !provider.baseUrl) return null;
        var input = provider.videoInput;
        var upload = input && input.upload;
        if (!upload || !upload.endpoint) return null;
// 端点支持绝对地址（如火山方舟标准 Files API），否则按 baseUrl + 相对路径拼接。
        // 避免 Agent/Coding 等套餐 baseUrl（如 /api/plan）与标准端点重复拼接导致 404。
        var ep = String(upload.endpoint);
        var url = /^https?:\/\//i.test(ep) ? ep : provider.baseUrl + ep;
        var form = new FormData();
        form.append('purpose', upload.purpose || 'video');
        form.append('file', blob, filename || 'video.mp4');
        var headers = {};
        if (provider.auth && provider.auth.type === 'x-api-key') {
            headers['x-api-key'] = apiKey;
        } else {
            headers['Authorization'] = 'Bearer ' + apiKey;
        }
        // 兜底超时：上传大视频是长操作（内联上限 100MB），阈值参考 ffmpegMovPlayer 的
        // 5 分钟兜底先例（300000ms）。防止网络挂起时 fetch 永不 settle、视觉代理流程永久阻塞；
        // 超时时 abort 底层连接，并以 Promise.race 兜底 reject，不依赖 fetch 对 abort 的实现。
        // 超时须覆盖到「响应体读取/解析完成」——头到达即 clearTimeout 会让 body 停滞时
        // （代理缓冲挂起）同样永不 settle。改为头到达后不清表，text()/json() 与同一 timeoutPromise
        // race，body 停滞照样按超时 abort 中断；超时行为保持 abort 语义不变。
        var timeoutMs = Number(opts.timeoutMs) || 300000;
        var controller = new AbortController();
        var timedOut = false;
        var timeoutId = null;
        var timeoutPromise = new Promise(function (resolve, reject) {
            timeoutId = setTimeout(function () {
                timedOut = true;
                controller.abort();
                reject(new Error('abort'));
            }, timeoutMs);
        });
        function timeoutError() {
            return new Error('视频文件上传超时（' + Math.round(timeoutMs / 1000) + ' 秒）: 上传长时间无响应已中止，请检查网络后重试');
        }
        var resp = null;
        try {
            var fetchPromise = fetch(url, { method: 'POST', headers: headers, body: form, signal: controller.signal });
            // race 已由超时决出后，fetch 因 abort 产生的 rejection 由这里兜住，避免 unhandled
            fetchPromise.catch(function () {});
            resp = await Promise.race([fetchPromise, timeoutPromise]);
        } catch (e) {
            clearTimeout(timeoutId);
            if (timedOut) throw timeoutError();
            throw e;
        }
        var data = null;
        try {
            if (!resp.ok) {
                var errText = '';
                try { errText = await Promise.race([resp.text(), timeoutPromise]); } catch (_) {}
                if (timedOut) throw timeoutError();   // 错误体读取阶段超时（abort 触发 text() 拒绝被内层吞掉）
                throw new Error('视频文件上传失败: ' + resp.status + ' ' + errText);
            }
            try {
                // 响应体解析与同一超时 race：json() 停滞/被 abort 时按超时语义失败
                data = await Promise.race([resp.json(), timeoutPromise]);
            } catch (e2) {
                if (timedOut) throw timeoutError();
                // 非 abort 的 JSON 解析失败沿用旧语义：data 留 null → fileId 空 → 返回 null
            }
        } finally {
            clearTimeout(timeoutId);
        }
        // OpenAI 兼容 Files API：顶层 id，或包在 data.id
        var fileId = (data && data.id) || (data && data.data && data.data.id) || '';
        return fileId || null;
    }

    function createLlmChannel(opts) {
        opts = opts || {};
        var getTools = opts.getTools || function() { return []; };
        var onStatusChange = opts.onStatusChange || null;

        // 并发安全的活动请求跟踪：数组保存所有在途请求的 AbortController。
        // 原单槽实现会被并发 sendStream/sendJson 覆盖（后请求覆盖前请求的 controller），
        // 导致先发起的请求 abort() 失效、isActive() 误报。每个请求只在 finally 移除自己。
        var abortControllers = [];

        // 把外部 signal（context.options.signal，调用方自己的运行轮 AbortController）
        // 转发到本请求的内部 myController：addEventListener 可用时监听一次转发；
        // 只支持 aborted 标记的旧 mock/极端环境在已中止时直接 abort。返回清除函数。
        // sendStream/sendJson 若完全忽略 options.signal，调用方（agent
        // 停止）只能调全局 channel.abort()，会连带中止桌宠/ComfyUI/MCP 等共享通道的
        // 在途请求；转发后各请求只被自己的 signal 中止。
        function _bindExternalSignal(externalSignal, myController) {
            if (!externalSignal) return null;
            if (externalSignal.aborted) {
                try { myController.abort(); } catch (_) {}
                return null;
            }
            if (typeof externalSignal.addEventListener === 'function') {
                var onAbort = function () { try { myController.abort(); } catch (_) {} };
                try { externalSignal.addEventListener('abort', onAbort); } catch (_) { return null; }
                return function () {
                    try { externalSignal.removeEventListener('abort', onAbort); } catch (_) {}
                };
            }
            return null;
        }

        // 纯传输：发送一轮 messages + tools，流式返回 content 和 tool_calls
        // 不做 tool loop，不执行工具，不管理消息数组
        async function sendStream(context, callbacks) {
            callbacks = callbacks || {};
            // 并发安全：递归/并发 sendStream 各自持自己的 controller 并登记到数组，
            // finally 只移除自己，后完成的请求不会误清新请求（保持原单槽守卫语义）。
            var myController = new AbortController();
            abortControllers.push(myController);
            // 在 resolveLlmConfig 等 await 之前就绑定外部 signal，
            // 停止动作落在装配窗口内也不会漏中止
            var options = context.options || {};
            var _unbindExternal = _bindExternalSignal(options.signal, myController);

            try {
                var messages = (context.messages || []).slice();
                var tools = context.tools || getTools() || [];
                var apiKey = context.apiKey || '';
                var resolved = await resolveLlmConfig(context);
                var model = resolved.model;
                var platform = resolved.platform;

                if (onStatusChange) onStatusChange('streaming', {});

                var streamResult = await streamRequest({
                    messages: messages,
                    tools: tools,
                    apiKey: apiKey,
                    model: model,
                    platform: platform,
                    signal: myController.signal,
                    timeoutMs: options.timeoutMs || 120000,
                    reasoningEffort: context.reasoningEffort || null,
                    jsonMode: context.jsonMode === true,
                    // 会话标识透传给请求装配（声明式会话头取值）；缺失时 streamRequest 回退安装级 id
                    sessionId: context.sessionId || ''
                }, {
                    onToken: callbacks.onToken,
                    onReasoning: callbacks.onReasoning
                });

                if (streamResult.error) {
                    if (callbacks.onError) callbacks.onError(streamResult);
                    return streamResult;
                }

                if (!streamResult.toolCalls || streamResult.toolCalls.length === 0) {
                    if (onStatusChange) onStatusChange('idle', {});
                } else {
                    if (onStatusChange) onStatusChange('tool_calling', { toolCalls: streamResult.toolCalls });
                }
                if (callbacks.onComplete) callbacks.onComplete(streamResult);
                return streamResult;
            } catch (e) {
                var errorResult = { error: 'EXCEPTION', message: String(e && e.message ? e.message : e) };
                if (callbacks.onError) callbacks.onError(errorResult);
                return errorResult;
            } finally {
                // 解除外部 signal 监听（防长期持引用）
                if (_unbindExternal) { try { _unbindExternal(); } catch (_) {} }
                // 只移除自己的 controller；abort() 置空数组后 indexOf 找不到自己，不影响新请求
                var _ci = abortControllers.indexOf(myController);
                if (_ci >= 0) abortControllers.splice(_ci, 1);
            }
        }

        async function sendJson(context) {
            var myController = new AbortController();
            abortControllers.push(myController);
            // 与 sendStream 同款——在 resolveLlmConfig await 前绑定
            // context.options.signal，停止只中止本请求（不再依赖全局 channel.abort）
            var options = context.options || {};
            var _unbindExternal = _bindExternalSignal(options.signal, myController);

            var apiKey = context.apiKey || '';
            var resolved = await resolveLlmConfig(context);
            var model = resolved.model;
            var platform = resolved.platform;
            var jsonMode = context.jsonMode !== false;

            var provider = resolveProvider(platform);
            var protocol = provider.protocol || 'openai-compatible';
            var adapter = global.AE_LLM.protocolAdapters.getAdapter(protocol);
            var temperature = provider.defaults && provider.defaults.temperature !== undefined
                ? provider.defaults.temperature : 0.2;

            var supportsJsonMode = supportsResponseFormat(model, platform);

            var responseFormat = (jsonMode && supportsJsonMode) ? { type: 'json_object' } : null;

            var buildCtx = {
                provider: provider,
                model: model,
                messages: context.messages || [],
                tools: null,
                toolChoice: null,
                stream: false,
                temperature: temperature,
                responseFormat: responseFormat,
                reasoningEffort: context.reasoningEffort || null
            };

            var requestBody = adapter.buildRequest(buildCtx);
            var defaultEndpoint = protocol === 'anthropic-messages' ? '/v1/messages' : '/chat/completions';
            var apiUrl = provider.baseUrl + (provider.endpoint || defaultEndpoint);
            var headers = global.AE_LLM.protocolAdapters.makeHeaders(provider, apiKey || '', {
                sessionId: context.sessionId || getClientSessionId()
            });

            var timeoutMs = Number(options.timeoutMs) || 90000;
            var timeoutId = null;
            var timedOut = false;

            try {
                timeoutId = setTimeout(function() {
                    timedOut = true;
                    myController.abort();
                }, timeoutMs);
                var response = await fetch(apiUrl, {
                    method: 'POST',
                    headers: headers,
                    body: JSON.stringify(requestBody),
                    signal: myController.signal
                });

                // 超时不在此清表——须覆盖到响应体（text/json）读取解析完成。
                // 头到达后 body 停滞（代理缓冲挂起）时，超时触发的 abort 会让
                // response.text()/json() 以 AbortError 拒绝，落入下方 catch 的超时分支；
                // 正常路径在 json() 完成后清表（catch/finally 中均有兜底清理）。

                if (!response.ok) {
                    var errText = '';
                    try { errText = await response.text(); } catch (_) {}
                    // 错误体读取阶段超时（abort 触发 text() 拒绝被内层吞掉）→ 按超时语义返回
                    if (timedOut) {
                        return { error: 'REQUEST_TIMEOUT', message: '请求超时，模型在 ' + Math.round(timeoutMs / 1000) + ' 秒内未响应' };
                    }
                    return {
                        error: 'API_ERROR',
                        message: 'API请求失败: ' + response.status + ' ' + errText,
                        status: response.status
                    };
                }

                var data = await response.json();
                if (timeoutId) clearTimeout(timeoutId);   // 响应体解析完成，超时使命结束
                var result = adapter.parseJsonResponse(data);

                if (data && data.usage && onStatusChange) {
                    onStatusChange('token_usage', data.usage);
                }

                return result;

            } catch (e) {
                if (timeoutId) clearTimeout(timeoutId);
                if (timedOut) {
                    return { error: 'REQUEST_TIMEOUT', message: '请求超时，模型在 ' + Math.round(timeoutMs / 1000) + ' 秒内未响应' };
                }
                if (isAbortError(e)) {
                    return { error: 'ABORTED', message: 'Request aborted', aborted: true };
                }
                return { error: 'NETWORK_ERROR', message: String(e && e.message ? e.message : e) };
            } finally {
                if (timeoutId) clearTimeout(timeoutId);
                // 解除外部 signal 监听（防长期持引用）
                if (_unbindExternal) { try { _unbindExternal(); } catch (_) {} }
                var _ci = abortControllers.indexOf(myController);
                if (_ci >= 0) abortControllers.splice(_ci, 1);
            }
        }

        function abort() {
            // 中止所有活动请求；置空数组后各请求 finally 中 indexOf 找不到自己，
            // 之后新发起的请求不受影响
            for (var i = 0; i < abortControllers.length; i++) {
                abortControllers[i].abort();
            }
            abortControllers = [];
        }

        function isActive() {
            return abortControllers.length > 0;
        }

        return {
            sendStream: sendStream,
            sendJson: sendJson,
            abort: abort,
            isActive: isActive,
            getClientSessionId: getClientSessionId
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createLlmChannel = createLlmChannel;
    global.AE_LLM.classifyError = classifyError;
    global.AE_LLM.isAbortError = isAbortError;
    global.AE_LLM.resolveLlmConfig = resolveLlmConfig;
    global.AE_LLM.supportsVision = supportsVision;
    global.AE_LLM.supportsResponseFormat = supportsResponseFormat;
    global.AE_LLM.uploadVideoFile = uploadVideoFile;
})(window);