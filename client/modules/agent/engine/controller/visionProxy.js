(function (global) {
    'use strict';
    // 视觉代理层拆分。由 controller.js 组装区经 AEEngine.createVisionProxy() 创建。
    // 纯迁移自 controller.js 的视觉代理注入族（describeImage/ImagesViaVisionProxy、
    // buildVisionProxyFailMessage、blobToDataUrl、buildVideoUrlPart、describeVideoViaVisionProxy、
    // injectVideoViaReadVideo）。
    // 依赖注入（opts）：getHasVisionProxy/getVisionProxyModelId/getVisionProxyProviderId（视觉代理状态，
    // 由 controller 持有并写入，此处经惰性 getter 读取）；resolveApiKeyForPlatform（controller 函数）；
    // readVideoStable（mediaReaders）；getIntentValidation（intentValidation）；getLlmChannel（llmChannel）。
    // _visionProxyFailReason 为视觉代理调用失败原因，随迁入本单元闭包（源写点与读取点均在本单元），
    // 经 getVisionProxyFailReason() 暴露给 controller 用于 showStatus 提示。
    function createVisionProxy(opts) {
        var _visionProxyFailReason = '';

        // 单图视觉代理请求：向视觉代理发送单张图片并返回其中文描述（失败/跳过返回 null）。
        // deps 提供已解析的公共上下文（vModel/vPlatform/apiKey/channel），由批量函数一次性准备后并发复用，
        // 避免每张图重复解析模型配置。每张图独立一次请求：结果互不影响、更客观稳定，且易命中平台缓存。
        async function describeImageViaVisionProxy(item, deps) {
            var it = item || {};
            if (!it.url || !deps || !deps.channel) return null;
            var sysPrompt = (global.AEEngine && global.AEEngine.prompts && global.AEEngine.prompts.buildImageDescriptionSystemPrompt)
                ? global.AEEngine.prompts.buildImageDescriptionSystemPrompt(it.hint || '图片', it.purpose || '')
                : '请用中文详细描述这张图片的内容。';
            var ctx = {
                apiKey: deps.apiKey,
                model: deps.vModel,
                platform: deps.vPlatform,
                jsonMode: false, // 识图描述是自然语言，关闭 JSON 模式
                messages: [
                    { role: 'system', content: sysPrompt },
                    { role: 'user', content: [
                        { type: 'image_url', image_url: { url: it.url } },
                        { type: 'text', text: '请用中文详细、客观地描述这张图片的内容。' }
                    ]}
                ],
                options: {
                    timeoutMs: 60000,
                    // 绑当前运行轮的 signal（轮次中途点停止可立即中止在途识图；
                    // gather 阶段尚无运行轮时为 null，退回旧语义）
                    signal: (typeof opts.getAbortSignal === 'function') ? opts.getAbortSignal() : null
                }
            };
            try {
                var chunk = await deps.channel.sendJson(ctx);
                if (chunk && chunk.error) return null;
                var content = chunk && chunk.content ? chunk.content : '';
                return content || null;
            } catch (e) {
                return null;
            }
        }

        // 单次分析图片数上限：超出部分不再请求视觉代理，以占位描述告知 LLM（防一次拖入大量图
        // 触发平台限流/风控，导致整批描述丢失）。
        var MAX_PROXY_IMAGES = 10;
        // 并发池大小：任意时刻最多 4 个单图请求在飞（完成一个补一个），
        // 避免一次性全量并发触发平台限流（429）。
        var PROXY_CONCURRENCY = 4;

        // 视觉代理分析：每张图片独立一次请求（并发池）逐一分析，返回与 items 逐项对齐的中文描述数组（失败/跳过项为 null）。
        // items: [{ url, hint, purpose }]；内部过滤空 url 并保持结果对齐。
        // 采用单图并发而非一次多图请求：单图结果不被其他图影响、更稳定客观、单张失败不影响其余，且易命中平台缓存；代价是并发请求数较多。
        async function describeImagesViaVisionProxy(items) {
            // 失败原因按批记录——入口清零上一批的残留，否则上一批的
            // no_api_key / request_failed:* 会混进本批的 buildVisionProxyFailMessage
            // 与 getVisionProxyFailReason 消费点，向 LLM/用户报出早已过时的原因
            //（如 Key 已配置仍提示"未配置 API Key"）。
            _visionProxyFailReason = '';
            var list = (Array.isArray(items) ? items : []).map(function (it) { return it || {}; });
            var result = new Array(list.length).fill(null);
            if (!opts.getHasVisionProxy()) return result;
            var valid = [];
            var idxMap = [];
            for (var vi = 0; vi < list.length; vi++) {
                if (list[vi].url) { valid.push(list[vi]); idxMap.push(vi); }
            }
            if (!valid.length) return result;
            // 超上限：只分析前 MAX_PROXY_IMAGES 张，溢出索引延后填占位描述
            var overflowIdx = [];
            if (valid.length > MAX_PROXY_IMAGES) {
                overflowIdx = idxMap.slice(MAX_PROXY_IMAGES);
                valid = valid.slice(0, MAX_PROXY_IMAGES);
                idxMap = idxMap.slice(0, MAX_PROXY_IMAGES);
            }
            var _dbg = (global.AEAgentApp && global.AEAgentApp.debugLog) || function () {};
            // 一次性解析公共上下文（模型/平台/API Key/发送通道），供各单图并发复用
            var deps = null;
            try {
                var resolved = global.AE_LLM && global.AE_LLM.resolveLlmConfig
                    ? await global.AE_LLM.resolveLlmConfig({ model: opts.getVisionProxyModelId(), platform: opts.getVisionProxyProviderId() })
                    : { model: opts.getVisionProxyModelId(), platform: opts.getVisionProxyProviderId() };
                var vModel = (resolved && resolved.model) || opts.getVisionProxyModelId();
                var vPlatform = (resolved && resolved.platform) || opts.getVisionProxyProviderId();
                var apiKey = await opts.resolveApiKeyForPlatform(vPlatform);
                if (!apiKey) {
                    _dbg('Vision-Proxy', 'API Key 未配置: platform=' + vPlatform);
                    _visionProxyFailReason = 'no_api_key';
                    return result;
                }
                var channel = opts.getLlmChannel();
                if (!channel || !channel.sendJson) {
                    _dbg('Vision-Proxy', 'llmChannel.sendJson 不可用');
                    _visionProxyFailReason = 'request_failed:no_channel';
                    return result;
                }
                deps = { vModel: vModel, vPlatform: vPlatform, apiKey: apiKey, channel: channel };
            } catch (e) {
                _visionProxyFailReason = 'request_failed:' + (e && e.message);
                return result;
            }
            _dbg('Vision-Proxy', '并发单图调用视觉模型: ' + deps.vPlatform + '/' + deps.vModel + ' images=' + valid.length
                + (overflowIdx.length ? ' (skipped=' + overflowIdx.length + ', 超上限' + MAX_PROXY_IMAGES + ')' : ''));
            // 并发池：多个 worker 共享 nextIdx 游标取任务，任意时刻在飞请求 ≤ PROXY_CONCURRENCY。
            // JS 单线程下 nextIdx++ 的同步段不可打断，无竞态。
            var nextIdx = 0;
            async function poolWorker() {
                while (nextIdx < valid.length) {
                    var i = nextIdx++;
                    result[idxMap[i]] = await describeImageViaVisionProxy(valid[i], deps);
                }
            }
            var workers = [];
            for (var w = 0; w < Math.min(PROXY_CONCURRENCY, valid.length); w++) workers.push(poolWorker());
            await Promise.all(workers);
            var got = 0;
            for (var gi = 0; gi < idxMap.length; gi++) {
                if (result[idxMap[gi]]) got++;
            }
            // 全部实际发起的请求都失败即记录 request_failed:all——不再因存在
            // 溢出占位（>MAX_PROXY_IMAGES 张）而跳过，否则该批失败原因缺失，消费点
            //（buildVisionProxyFailMessage / getVisionProxyFailReason 状态提示）会拿到
            // 上一批的陈旧值。溢出占位不是请求结果，不影响 got 的判定。
            if (!got) _visionProxyFailReason = 'request_failed:all';
            _dbg('Vision-Proxy', '单图并发描述完成: ' + got + '/' + valid.length
                + (overflowIdx.length ? ' skipped=' + overflowIdx.length : ''));
            // 溢出项填占位描述（非 null，调用方会拼进注入文本，LLM 可感知并告知用户）
            for (var oi = 0; oi < overflowIdx.length; oi++) {
                result[overflowIdx[oi]] = '[第 ' + (overflowIdx[oi] + 1) + ' 张图片超出单次 ' + MAX_PROXY_IMAGES
                    + ' 张分析上限，本次未分析。请告知用户：如需分析其余图片，可分批发送。]';
            }
            return result;
        }

        // 根据 _visionProxyFailReason 生成明确的失败提示，注入主 LLM 上下文。
        // no_api_key → 指引配置 API Key；request_failed → 带出具体错误信息，让 LLM 能告知用户原因。
        function buildVisionProxyFailMessage(prefix, kind) {
            if (_visionProxyFailReason === 'no_api_key') {
                return '[' + (prefix || '图片已读取') + '，但视觉代理平台未配置 API Key，无法分析' + (kind || '图片') + '。请告知用户：到模型管理面板为视觉代理平台配置 API Key 后重试。]';
            }
            var errDetail = '';
            if (_visionProxyFailReason && _visionProxyFailReason.indexOf('request_failed:') === 0) {
                errDetail = '（' + _visionProxyFailReason.slice('request_failed:'.length) + '）';
            }
            return '[' + (prefix || '图片已读取') + '，但视觉代理模型分析' + (kind || '图片') + '失败' + errDetail + '。请告知用户检查视觉模型配置。]';
        }

        // blob → base64 data URL（CEP Chromium 环境，FileReader 可用）。
        function blobToDataUrl(blob) {
            return new Promise(function (resolve) {
                try {
                    var reader = new FileReader();
                    reader.onload = function () { resolve(reader.result); };
                    reader.onerror = function () { resolve(null); };
                    reader.readAsDataURL(blob);
                } catch (_) { resolve(null); }
            });
        }

        // 构造 video_url 内容块：优先走「上传拿 file_id 引用」（方案 1）；
        // 若平台无上传能力（如火山 Agent/Coding 套餐）或配置了 inline，则转 base64 内联（方案 2）。
        // 内联前做体积上限校验（默认 100MB，可用 videoInput.maxSizeMB 覆盖），超限返回 null 拒绝注入。
        // 防断层由调用方 readVideoStable 保证：反复读到尺寸稳定，避免吃到写了一半的 mp4。
        async function buildVideoUrlPart(blob, filename, provider, apiKey) {
            var vi = provider && provider.videoInput;
            if (!blob || !provider || !provider.baseUrl) return null;
            var canUpload = !!(vi && vi.upload && vi.upload.endpoint);
            var inline = !!(vi && vi.inline);
            if (inline || !canUpload) {
                var maxMB = (vi && vi.maxSizeMB) > 0 ? vi.maxSizeMB : 100;
                var maxBytes = maxMB * 1024 * 1024;
                if (blob.size > maxBytes) {
                    console.warn('[Video-HOOK] 视频超过内联上限 ' + maxMB + 'MB size=' + blob.size + ' name=' + filename);
                    return null;
                }
                var dataUrl = await blobToDataUrl(blob);
                return dataUrl ? { type: 'video_url', video_url: { url: dataUrl } } : null;
            }
            var reference = (vi && vi.reference) || 'ms://';
            var fileId = await global.AE_LLM.uploadVideoFile(blob, filename, { provider: provider, apiKey: apiKey });
            return fileId ? { type: 'video_url', video_url: { url: reference + fileId } } : null;
        }

        // 视频代理：用配置的视觉代理模型识别视频并生成中文描述。
        // 非视频主模型 + 已配置视觉代理时调用。代理模型支持视频则上传/内联并识别；
        // 不支持视频则返回一段说明文案（提示代理模型不支持视频识别）。
        // 返回描述字符串（含"不支持视频"的说明）；识别失败返回 null。
        async function describeVideoViaVisionProxy(videoPath, hint, userRequest) {
            if (!opts.getHasVisionProxy()) return null;
            var _dbg = (global.AEAgentApp && global.AEAgentApp.debugLog) || function () {};
            try {
                var resolved = global.AE_LLM && global.AE_LLM.resolveLlmConfig
                    ? await global.AE_LLM.resolveLlmConfig({ model: opts.getVisionProxyModelId(), platform: opts.getVisionProxyProviderId() })
                    : { model: opts.getVisionProxyModelId(), platform: opts.getVisionProxyProviderId() };
                var vModel = (resolved && resolved.model) || opts.getVisionProxyModelId();
                var vPlatform = (resolved && resolved.platform) || opts.getVisionProxyProviderId();
                var apiKey = await opts.resolveApiKeyForPlatform(vPlatform);
                if (!apiKey) {
                    _dbg('Video-Proxy', 'API Key 未配置: platform=' + vPlatform);
                    return null;
                }
                // 视觉代理模型不支持视频 → 明确说明，不尝试上传
                if (!(global.AE_LLM && global.AE_LLM.supportsVideo && global.AE_LLM.supportsVideo(vModel, vPlatform))) {
                    _dbg('Video-Proxy', '视觉代理不支持视频: ' + vPlatform + '/' + vModel);
                    return '（当前视觉代理模型不支持视频识别，无法查看该视频。）请告知用户：切换至支持视频的模型（如 Kimi K3 / 豆包 Seed 2.1），或在「模型管理」为视觉代理配置支持视频的模型。';
                }
                var registry = global.AE_LLM.providerRegistry;
                var provider = (registry && typeof registry.getProvider === 'function') ? registry.getProvider(vPlatform) : null;
                if (!provider || !provider.baseUrl || !provider.videoInput || !(provider.videoInput.inline || (provider.videoInput.upload && provider.videoInput.upload.endpoint))) {
                    _dbg('Video-Proxy', '视觉代理平台未配置视频上传端点或内联支持: ' + vPlatform);
                    return null;
                }
                var read = await opts.readVideoStable(videoPath);
                if (!read || !read.success || !read.blob) {
                    _dbg('Video-Proxy', 'readVideoStable 失败: ' + videoPath);
                    return null;
                }
                var fname = videoPath.replace(/^.*[\\\/]/, '') || 'video.mp4';
                var _vpPart = await buildVideoUrlPart(read.blob, fname, provider, apiKey);
                if (!_vpPart) {
                    _dbg('Video-Proxy', 'buildVideoUrlPart 返回空（上传失败或超内联上限）: ' + videoPath);
                    return null;
                }
                var sysPrompt = (global.AEEngine && global.AEEngine.prompts && global.AEEngine.prompts.buildVideoDescriptionSystemPrompt)
                    ? global.AEEngine.prompts.buildVideoDescriptionSystemPrompt(hint, userRequest)
                    : '请用中文详细描述这段视频的内容。';
                var channel = opts.getLlmChannel();
                if (!channel || !channel.sendJson) {
                    _dbg('Video-Proxy', 'llmChannel.sendJson 不可用');
                    return null;
                }
                var ctx = {
                    apiKey: apiKey,
                    model: vModel,
                    platform: vPlatform,
                    jsonMode: false, // 视频描述是自然语言，关闭 JSON 模式
                    messages: [
                        { role: 'system', content: sysPrompt },
                        { role: 'user', content: [
                            _vpPart,
                            { type: 'text', text: '请描述这段视频' }
                        ]}
                    ],
                    options: {
                        timeoutMs: 90000,
                        // 同图片代理，绑当前运行轮 signal（停止即中止在途识别）
                        signal: (typeof opts.getAbortSignal === 'function') ? opts.getAbortSignal() : null
                    }
                };
                _dbg('Video-Proxy', '调用视觉代理识别视频: ' + vPlatform + '/' + vModel);
                var result = await channel.sendJson(ctx);
                if (result && result.error) {
                    _dbg('Video-Proxy', '请求失败: ' + (result.message || result.error));
                    return null;
                }
                var content = result && result.content ? result.content : '';
                _dbg('Video-Proxy', '描述长度: ' + (content ? content.length : 0));
                return content || null;
            } catch (e) {
                _dbg('Video-Proxy', '异常: ' + (e && e.message));
                return null;
            }
        }

        // 查询视频工具 hook：read_video 成功执行后，读取视频文件并上传到当前平台 Files API，
        // 换取 file_id 后以 video_url content block 注入 messages。仅主模型支持视频能力才注入；
        // 否则给 LLM 明确反馈，避免困惑或重复调用。
        async function injectVideoViaReadVideo(toolResults, messages, model, platform) {
            if (!global.AE_LLM || typeof global.AE_LLM.supportsVideo !== 'function') return;
            if (!Array.isArray(toolResults) || !Array.isArray(messages)) return;
            var _dbg = (global.AEAgentApp && global.AEAgentApp.debugLog) || function () {};
            var videoPaths = [];
            var videoPurpose = []; // 与 videoPaths 一一对应：工具调用时主 LLM 传入的 purpose 需求提示词
            for (var i = 0; i < toolResults.length; i++) {
                var tr = toolResults[i];
                if (tr && tr.toolName === 'read_video' && tr.success !== false) {
                    try {
                        var parsed = JSON.parse(tr.content || '{}');
                        if (parsed && parsed.filePath) {
                            videoPaths.push(parsed.filePath);
                            videoPurpose.push(opts.getIntentValidation().resolvePurpose(tr.args));
                        }
                    } catch (_) {}
                }
            }
            if (videoPaths.length === 0) return;

            // 主模型需支持视频能力（video:true），否则无法注入 video_url
            var canSeeVideo = global.AE_LLM.supportsVideo(model, platform);
            _dbg('Video-HOOK', 'read_video 触发: paths=' + videoPaths.length + ' model=' + model + ' platform=' + platform + ' canSeeVideo=' + !!canSeeVideo + ' hasProxy=' + opts.getHasVisionProxy());
            if (opts.getHasVisionProxy()) {
                // 视觉代理优先：配置了视觉代理时，无论主模型是否支持视频，都用视觉代理识别视频（代理同时覆盖图片和视频）
                // 失败项不再静默丢弃——按原始下标占位（null），多视频部分失败时逐项
                // 标注；只 push 成功项时，失败视频凭空消失且成功项的【视频 N】序号错位。
                var _vProxyDescs = [];
                var _vProxyOkCount = 0;
                for (var vpi = 0; vpi < videoPaths.length; vpi++) {
                    var _vpDesc = await describeVideoViaVisionProxy(videoPaths[vpi], '用户查询的视频', videoPurpose[vpi]);
                    if (_vpDesc) _vProxyOkCount++;
                    _vProxyDescs.push(_vpDesc);
                }
                if (_vProxyOkCount > 0) {
                    var _vDescText = videoPaths.length === 1
                        ? _vProxyDescs[0]
                        : _vProxyDescs.map(function (d, i) {
                            return '【视频 ' + (i + 1) + '】\n' + (d || '[该视频识别失败，视觉代理无法查看其内容]');
                        }).join('\n\n');
                    var _vDescMsg = '以下是视频的视觉描述（由视觉代理模型生成）：\n\n' + _vDescText;
                    messages.push({ role: 'user', content: _vDescMsg });
                    // 描述同步落入 contextManager（隐藏 user 消息），防循环内压缩重建 messages 时丢失
                    if (typeof opts.persistVisionDesc === 'function') opts.persistVisionDesc(_vDescMsg);
                    _dbg('Video-Proxy', '视频描述已注入 messages, 成功=' + _vProxyOkCount + ' 失败=' + (videoPaths.length - _vProxyOkCount));
                } else if (canSeeVideo) {
                    // 代理全部失败 + 主模型支持视频：回退直接注入 video_url
                    _dbg('Video-Proxy', '视频描述生成失败，回退主模型直接注入 video_url');
                    await injectVideoDirectly();
                    if (global.AEToast) global.AEToast.show(AEI18n.t('视觉代理分析视频失败，已回退主模型直接识别'), 'warn');
                } else {
                    // 代理全部失败且主模型也不支持视频：必须给 LLM 反馈，否则 LLM 调了 read_video 却得不到任何信息会困惑或重复调用
                    messages.push({ role: 'user', content: '[read_video 已调用，但视觉代理模型识别视频失败，无法查看视频内容。请告知用户检查视觉代理模型配置。]' });
                    _dbg('Video-Proxy', '所有视频描述生成失败，已注入失败提示');
                }
                return;
            }
            // 直接注入 video_url：无代理时主模型支持视频，或代理全部失败后回退主模型时共用。
            // 函数声明提升，可被上方代理分支的回退调用。
            async function injectVideoDirectly() {
                var registry = global.AE_LLM.providerRegistry;
                var provider = (registry && typeof registry.getProvider === 'function') ? registry.getProvider(platform) : null;
                if (!provider || !provider.baseUrl || !provider.videoInput || !(provider.videoInput.inline || (provider.videoInput.upload && provider.videoInput.upload.endpoint))) {
                    messages.push({ role: 'user', content: '[read_video 无法执行：当前平台 ' + platform + ' 未配置视频上传端点或内联支持（videoInput.upload.endpoint / videoInput.inline）。请告知用户检查模型配置。]' });
                    return;
                }
                var apiKey = await opts.resolveApiKeyForPlatform(platform);
                if (!apiKey) {
                    messages.push({ role: 'user', content: '[read_video 无法执行：当前平台 ' + platform + ' 未配置 API Key。请告知用户到「模型管理」为该平台配置 API Key。]' });
                    return;
                }
                var videoParts = [];
                for (var vi = 0; vi < videoPaths.length; vi++) {
                    var vp = videoPaths[vi];
                    try {
                        var read = await opts.readVideoStable(vp);
                        if (read && read.success && read.blob) {
                            var fname = vp.replace(/^.*[\\\/]/, '') || 'video.mp4';
                            var _vpPart = await buildVideoUrlPart(read.blob, fname, provider, apiKey);
                            if (_vpPart) {
                                videoParts.push(_vpPart);
                                _dbg('Video-HOOK', '视频已注入 video_url: ' + vp);
                            } else {
                                _dbg('Video-HOOK', 'buildVideoUrlPart 返回空（上传失败或超内联上限）: ' + vp);
                            }
                        } else {
                            _dbg('Video-HOOK', 'readVideoStable 失败: ' + vp);
                        }
                    } catch (e) {
                        _dbg('Video-HOOK', '视频处理异常: ' + (e && e.message));
                    }
                }
                if (videoParts.length > 0) {
                    videoParts.push({ type: 'text', text: '以上是用户查询的视频。请根据视频内容完成用户需求。' });
                    // 多模态混搭：若上一条已是数组型 user 消息（如图片注入的 image_url 列表），
                    // 把视频 parts 合并进同一消息，使图片+视频作为单个多模态 payload 一起发送。
                    // 上一条是字符串（如视觉代理文本描述）或非 user 时，仍独立推送，保持兼容。
                    var _lastMsg = messages[messages.length - 1];
                    if (_lastMsg && _lastMsg.role === 'user' && Array.isArray(_lastMsg.content)) {
                        _lastMsg.content = _lastMsg.content.concat(videoParts);
                        _dbg('Video-HOOK', '视频 parts 已合并进上一条多模态 user 消息（图片+视频混搭）');
                    } else {
                        messages.push({ role: 'user', content: videoParts });
                    }
                } else {
                    messages.push({ role: 'user', content: '[read_video 已调用，但视频读取或上传失败，无法查看视频内容。请告知用户检查视频文件路径或模型配置。]' });
                }
            }

            if (!canSeeVideo) {
                messages.push({ role: 'user', content: '[read_video 已调用，但当前模型不支持视频（video）能力，无法查看视频内容。请告知用户：到「模型管理」切换至支持视频的模型（如 Kimi K3 / 豆包 Seed 2.1），或改用其他方式处理。]' });
                return;
            }
            await injectVideoDirectly();
        }

        return {
            describeImageViaVisionProxy: describeImageViaVisionProxy,
            describeImagesViaVisionProxy: describeImagesViaVisionProxy,
            buildVisionProxyFailMessage: buildVisionProxyFailMessage,
            blobToDataUrl: blobToDataUrl,
            buildVideoUrlPart: buildVideoUrlPart,
            describeVideoViaVisionProxy: describeVideoViaVisionProxy,
            injectVideoViaReadVideo: injectVideoViaReadVideo,
            getVisionProxyFailReason: function () { return _visionProxyFailReason; }
        };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createVisionProxy = createVisionProxy;
})(typeof global !== 'undefined' ? global : window);