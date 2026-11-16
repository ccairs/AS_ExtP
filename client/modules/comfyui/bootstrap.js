(function (global) {
    'use strict';

    // 云端模型 ID 列表（消耗积分）
    var CLOUD_MODELS = [
        'seedream', 'gpt_image2', 'nano_banana2',
        'kling_i2v', 'kling_i2v_legacy', 'kling_start_end',
        'seedance2_i2v', 'seedance2_ref',
        'hailuo', 'happyhorse_i2v', 'happyhorse_r2v'
    ];

    // 模型 ID 枚举（供 input_schema 使用）。ALL_MODEL_IDS 为可变数组——三个工具
    // （generate/check_status/list_params）的 model_id.enum 共享同一引用，伙伴发现
    // 后就地追加即全部同步；STATIC_MODEL_IDS 恒为静态基线，云端门以它判「非内置
    // 即云端」，防就地追加后自动发现模型逃过 allowCloudModels 门
    var STATIC_MODEL_IDS = CLOUD_MODELS.concat(['txt2img', 'img2img']);
    var ALL_MODEL_IDS = CLOUD_MODELS.concat(['txt2img', 'img2img']);

    // 动态 enum（伙伴节点自动发现）：注册表变更时经 _onModelRegistryChanged 刷新
    // model_id.enum（就地追加）与 generate 描述，使新发现模型可被 LLM 直接调用
    var _generateSchema = null;     // 注册时保存 schema 引用（描述重建用）
    var _autoModelLines = [];       // 自动发现模型的描述行
    var AUTO_MODEL_LINE_MAX = 6;    // 描述里最多列几条（防伙伴模型上百个把描述撑爆）

    var _controller = null;
    var _initPromise = null;

    // 最近图片缓存与 ae:recent-images-changed 订阅已移除。会话图片改由
    // Agent 引擎在发送装配时把历史附件路径转成绝对路径（image_source=file_path 直接消费），
    // 不再有面板全局的「最后一批图」隐式状态。

    /**
     * 确保 ComfyUI controller 已初始化（不依赖 UI 挂载）。
     * 复用 index.js 已创建的 controller，或自行创建。
     */
    function _ensureController(config) {
        if (_controller && _controller.isReady()) {
            _syncEnumOnce(_controller);
            return Promise.resolve(_controller);
        }
        if (_initPromise) return _withEnumSync(_initPromise);

        _initPromise = new Promise(function (resolve, reject) {
            try {
                // 优先复用 comfyuiModule 已有的 controller
                var mod = global.AEModules && global.AEModules.comfyuiModule;
                if (mod) {
                    var existing = mod.getController();
                    if (existing && existing.isReady()) {
                        _controller = existing;
                        resolve(existing);
                        return;
                    }
                    // existing 在途（init 未完）或 init 失败——复用同一实例
                    // 并（重）跑 init（init 内部在途去重、失败可重试）。不这样做则直接
                    // 另建 controller：面板 init 在途窗口内 LLM 触发生成 → 双实例双
                    // WebSocket 状态机（saveSettings 各自为政、端点切换不同步）；面板
                    // init 失败后每次 LLM 调用再建新实例（UI 僵死而 LLM 正常）。
                    if (existing && typeof existing.init === 'function') {
                        existing.init().then(function () {
                            _controller = existing;
                            resolve(existing);
                        }).catch(function (e) {
                            _initPromise = null;
                            reject(e);
                        });
                        return;
                    }
                }

                // 自行创建 controller（不建 view）
                var settingsStore = config.settingsStore;
                var hostApi = config.hostApi;
                var ctx = { settingsStore: settingsStore, hostApi: hostApi };
                var ctrl = global.AEComfyUI.createComfyUIController(ctx);
                ctrl.init().then(function () {
                    _controller = ctrl;
                    // 暴露到全局，供 index.js 复用（避免重复创建 controller 导致 WebSocket 回调冲突）
                    global.AEComfyUI._preinitController = ctrl;
                    resolve(ctrl);
                }).catch(function (e) {
                    _initPromise = null;
                    reject(e);
                });
            } catch (e) {
                _initPromise = null;
                reject(e);
            }
        });
        return _withEnumSync(_initPromise);
    }

    /**
         * 首次拿到 controller 后一次性直读注册表同步 enum（幂等，状态挂函数属性，
         * 不依赖模块级 var）。兜底加载序竞态：ComfyUI 面板先于 agent 模块初始化时，伙伴
         * 发现先于 _onModelRegistryChanged 注册执行，此后 registry.add 去重使
         * _added=0 不再触发回调——发现过的模型将永远进不了 enum，直到这里补一次直读。
         */
    function _syncEnumOnce(ctrl) {
        if (_syncEnumOnce._done) return;
        _syncEnumOnce._done = true;
        try {
            if (ctrl && typeof ctrl.getRegistry === 'function' &&
                global.AEComfyUI && global.AEComfyUI._onModelRegistryChanged) {
                var regs = ctrl.getRegistry();
                if (regs && typeof regs.getAll === 'function') {
                    global.AEComfyUI._onModelRegistryChanged(regs.getAll());
                }
            }
        } catch (_) {}
    }

    function _withEnumSync(p) {
        return p.then(function (ctrl) { _syncEnumOnce(ctrl); return ctrl; });
    }

    /**
     * 收集图片文件（根据 image_source），返回 {blob, name} 数组。
     */
    async function _collectImages(args, ctrl) {
        var source = args.image_source || 'none';
        if (source === 'none') return [];
        if (source === 'recent_upload') {
            // 会话图片改为「历史消息里的绝对路径 + file_path」，
            // 不再有面板全局的最近图片缓存。显式报错，避免静默当成无图。
            throw new Error('image_source="recent_upload" 已移除。请改用 image_source="file_path"，'
                + '路径取聊天历史 [附件图片路径] 下的绝对路径（可直接复制）。');
        }

        var images = [];

        if (source === 'current_frame') {
            var frameFile = await ctrl.captureCurrentFrame();
            if (frameFile) {
                images.push({ blob: frameFile, name: frameFile.name || 'ae_frame.png' });
            }
        } else if (source === 'file_path') {
            var paths = args.image_paths || (args.image_path ? [args.image_path] : []);
            for (var i = 0; i < paths.length; i++) {
                var fp = paths[i];
                if (!fp) continue;
                var blobResult = (global.AEFS && typeof global.AEFS.readBlob === 'function')
                    ? await global.AEFS.readBlob(fp) : null;
                if (blobResult && blobResult.success && blobResult.blob) {
                    images.push({ blob: blobResult.blob, name: fp.replace(/^.*[\\\/]/, '') || ('image_' + i + '.png') });
                } else {
                    throw new Error('无法读取图片文件: ' + fp);
                }
            }
        }

        return images;
    }

    /**
     * 将图片上传到 ComfyUI 并映射到正确的 key。
     * 返回 { values: {}, imageFilenames: {} }
     * - pipeline 模型: 用 template.parameters(type=image) 找 key，放入 values（renderWorkflow 的 {{key}} 替换只查 values）
     *   注意：不能用 model.imageInputKeys，因为 kling_i2v 的 imageInputKeys=["image"] 与模板占位符 {{start_frame}} 不一致
     * - non-pipeline 模型: 用 model.imageInputKeys 找 key，放入 imageFilenames（buildSchemaDrivenWorkflow 用它建 LoadImage 节点）
     */
    async function _uploadAndMapImages(images, model, template, service) {
        var values = {};
        var imageFilenames = {};

        if (!images || images.length === 0) return { values: values, imageFilenames: imageFilenames };

        // 上传所有图片，得到服务端文件名
        var uploadedNames = [];
        for (var i = 0; i < images.length; i++) {
            var uploadResult = await service.uploadImage(images[i].blob, images[i].name);
            uploadedNames.push(uploadResult.name || images[i].name);
        }

        var isPipeline = !!model.pipeline;

        if (isPipeline) {
            // Pipeline 模型：把已上传文件名映射到模板 type=image 参数槽。
            // multiple 槽（Qwen-Image 多图参考）按 <key>_1..<key>_N 分配，单槽一次一张。
            var imgParams = (template.parameters || []).filter(function (p) { return p.type === 'image'; });
            var unetTools = global.AEComfyUI && global.AEComfyUI.unetModels;
            var mappedValues = (unetTools && typeof unetTools.mapUploadedImages === 'function')
                ? unetTools.mapUploadedImages(imgParams, uploadedNames)
                : null;
            if (mappedValues) {
                Object.keys(mappedValues).forEach(function (k) { values[k] = mappedValues[k]; });
            } else {
                // 兜底（unetModels 未加载）：单槽一对一；多槽无法分配时只填前面的单槽
                for (var pi = 0; pi < uploadedNames.length && pi < imgParams.length; pi++) {
                    if (imgParams[pi].multiple) break;
                    values[imgParams[pi].key] = uploadedNames[pi];
                }
            }
        } else {
            // Non-pipeline 模型：用 model.imageInputKeys 映射（与 schema 输入端口名匹配）
            var imgKeys = model.imageInputKeys || [];
            for (var ni = 0; ni < uploadedNames.length; ni++) {
                var key;
                if (ni < imgKeys.length) {
                    // 多端口模型（如 seedance2_i2v: first_frame, last_frame）
                    key = imgKeys[ni];
                } else if (imgKeys.length > 0) {
                    // 单端口多图模型（如 seedream: model.images.image_1, _2, _3...）
                    var baseKey = imgKeys[0].replace(/_\d+$/, '');
                    key = baseKey + '_' + (ni + 1);
                } else {
                    continue; // 无 imageInputKeys，跳过
                }
                imageFilenames[key] = uploadedNames[ni];
            }
        }

        return { values: values, imageFilenames: imageFilenames };
    }

    /**
     * 清理工作流中无主输入的 LoadImage / LoadVideo 孤儿节点。
     * 复制自 controller.js generate() 中的逻辑。
     */
    function _cleanupOrphanLoaders(workflow) {
        Object.keys(workflow).forEach(function (nodeId) {
            var node = workflow[nodeId];
            if (!node) return;
            var mainInput = null;
            if (node.class_type === 'LoadImage') mainInput = 'image';
            else if (node.class_type === 'LoadVideo') mainInput = 'file';
            else return;
            if (node.inputs && node.inputs[mainInput]) return;
            delete workflow[nodeId];
            Object.keys(workflow).forEach(function (nid) {
                var n = workflow[nid];
                if (n && n.inputs) {
                    Object.keys(n.inputs).forEach(function (ik) {
                        var v = n.inputs[ik];
                        if (Array.isArray(v) && v[0] === nodeId) {
                            delete n.inputs[ik];
                        }
                    });
                }
            });
        });
    }

    /**
     * 检查 ComfyUI 服务是否可达（5 秒超时）。
     * 用 REST GET /system_stats 做轻量 ping，避免 WebSocket 长时间挂起。
     */
    async function _checkConnectivity(settings) {
        var baseUrl = 'http://' + (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
        try {
            var fetchPromise = fetch(baseUrl + '/system_stats');
            var timeoutPromise = new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('timeout')); }, 5000);
            });
            var resp = await Promise.race([fetchPromise, timeoutPromise]);
            return resp.ok;
        } catch (e) {
            return false;
        }
    }

    /**
     * 轮询 ComfyUI history 直到 outputs 就绪或检测到错误。
     * ComfyUI 在 task_done 后写入 history（含 status 字段）：
     *   - 成功: status.completed=true, status.status_str="success", outputs 非空
     *   - 失败: status.completed=false, status.status_str="error", outputs 可能为空
     */
    async function _pollForResults(service, promptId, timeoutMs) {
        var startTime = Date.now();
        while (Date.now() - startTime < timeoutMs) {
            try {
                var history = await service.getHistory(promptId);
                // history 不存在（prompt 还在队列/执行中）-> 继续轮询
                if (!history || !history.status) {
                    await new Promise(function (r) { setTimeout(r, 2000); });
                    continue;
                }
                // 执行失败 -> 提取错误信息并抛出
                if (history.status.status_str === 'error' || history.status.completed === false) {
                    var errMsg = 'ComfyUI 执行失败';
                    var msgs = history.status.messages || [];
                    for (var mi = 0; mi < msgs.length; mi++) {
                        if (msgs[mi] && msgs[mi][0] === 'execution_error' && msgs[mi][1]) {
                            errMsg += ': ' + (msgs[mi][1].exception_message || msgs[mi][1].exception_type || '未知错误');
                            if (msgs[mi][1].node_type) errMsg += ' (节点: ' + msgs[mi][1].node_type + ')';
                            break;
                        }
                    }
                    throw new Error(errMsg);
                }
                // 成功且有输出 -> 返回 outputs
                if (history.outputs && Object.keys(history.outputs).length > 0) {
                    return history.outputs;
                }
                // 成功但无输出（罕见，如纯预览节点）-> 返回空对象
                if (history.status.completed === true) {
                    return history.outputs || {};
                }
            } catch (e) {
                // 轮询中的执行错误（非网络错误）直接抛出
                if (e && e.message && e.message.indexOf('ComfyUI 执行失败') >= 0) throw e;
                // 网络错误继续轮询
            }
            await new Promise(function (r) { setTimeout(r, 2000); });
        }
        throw new Error('生成超时（' + Math.round(timeoutMs / 1000) + '秒内未完成）');
    }

    /**
     * 单次状态查询（comfyui_check_status 用）：只查一次 history，立即返回，不阻塞等待。
     * 返回 { status: 'generating' | 'error' | 'done', outputs, error }。
     * 单次 fetch 带超时（默认 10s），防止 ComfyUI 历史接口挂起导致工具永久卡住；
     * 查询失败/超时一律视为仍在生成，由 LLM 稍后再次调用。
     */
    async function _queryStatusOnce(service, promptId, timeoutMs) {
        var history;
        try {
            var fetchPromise = service.getHistory(promptId);
            var timeoutPromise = new Promise(function (_, reject) {
                setTimeout(function () { reject(new Error('QUERY_TIMEOUT')); }, timeoutMs || 10000);
            });
            history = await Promise.race([fetchPromise, timeoutPromise]);
        } catch (e) {
            // 查询失败/超时：视为仍在生成，不阻塞
            return { status: 'generating', outputs: null, error: null };
        }
        // history 不存在（prompt 还在队列/执行中）-> 仍在生成
        if (!history || !history.status) {
            return { status: 'generating', outputs: null, error: null };
        }
        // 执行失败 -> 提取错误信息
        if (history.status.status_str === 'error' || history.status.completed === false) {
            var errMsg = 'ComfyUI 执行失败';
            var msgs = history.status.messages || [];
            for (var mi = 0; mi < msgs.length; mi++) {
                if (msgs[mi] && msgs[mi][0] === 'execution_error' && msgs[mi][1]) {
                    errMsg += ': ' + (msgs[mi][1].exception_message || msgs[mi][1].exception_type || '未知错误');
                    if (msgs[mi][1].node_type) errMsg += ' (节点: ' + msgs[mi][1].node_type + ')';
                    break;
                }
            }
            return { status: 'error', outputs: null, error: errMsg };
        }
        // 成功且有输出 -> done
        if (history.outputs && Object.keys(history.outputs).length > 0) {
            return { status: 'done', outputs: history.outputs, error: null };
        }
        // 成功但无输出（罕见，如纯预览节点）-> done（空输出）
        if (history.status.completed === true) {
            return { status: 'done', outputs: history.outputs || {}, error: null };
        }
        return { status: 'generating', outputs: null, error: null };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 官方模板库（Comfy-Org/workflow_templates，MIT）LLM 工具支撑
    // （LLM 路径接官方库，表单/画布保持内置模板直连；模板为 UI 格式，转换在客户端完成）
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Bridge 端口可能因 9877 被占而回退到 9878-9886，动态获取（对齐 skillStoreTool）。
     */
    function _bridgeComfyTemplatesUrl() {
        return (global.Bridge && global.Bridge.getBridgeUrl ? global.Bridge.getBridgeUrl() : 'http://127.0.0.1:9877') + '/api/comfy-templates';
    }

    /**
     * 调用 bridge /api/comfy-templates（action=search/fetch）。
     * 超时按最坏回退链路预算：search = 首次拉索引四源各 10s = 40s → 45s；
     * fetch = 索引（缓存未命中 40s）+ 模板双 CDN 20s = 60s → 75s。
     * TTL 缓存命中后均为毫秒级。
     */
    async function _bridgeComfyTemplates(action, payload, timeoutMs) {
        var timeout = timeoutMs || (action === 'fetch' ? 75000 : 45000);
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { if (controller) controller.abort(); }, timeout);
        var body = { action: action };
        var payloadKeys = Object.keys(payload || {});
        for (var i = 0; i < payloadKeys.length; i++) body[payloadKeys[i]] = payload[payloadKeys[i]];
        var opts = {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        };
        if (controller) opts.signal = controller.signal;
        try {
            var res = await fetch(_bridgeComfyTemplatesUrl(), opts);
            if (!res.ok) {
                // 非 200：优先取 bridge 错误体的 error 字段（如 name 白名单拒绝的
                // 「必须先用搜索确认 name」引导），拿不到再退回裸状态码
                var errBody = null;
                try { errBody = await res.json(); } catch (_) {}
                throw new Error((errBody && errBody.error) ? errBody.error : 'HTTP ' + res.status);
            }
            return await res.json();
        } catch (e) {
            if (e && e.name === 'AbortError') throw new Error('官方模板库请求超时（' + Math.round(timeout / 1000) + 's）');
            throw e;
        } finally {
            clearTimeout(timer);
        }
    }

    /**
     * 从转换后的 API 工作流推断输出类型（供 _backgroundPoll 超时档位与结果文案）。
     * 视频保存节点优先；再认音频/3D 保存节点；其余按图片档（图片是绝大多数场景）。
     * 注：SaveAnimatedWEBP 产物是 .webp，归图片类（与 _detectSavedOutputType 的扩展名
     * 判据一致，避免提交时说视频、落盘后又说图片的自相矛盾）。
     */
    function _detectOutputType(promptData) {
        var ids = Object.keys(promptData || {});
        var i, ct;
        for (i = 0; i < ids.length; i++) {
            ct = promptData[ids[i]] && promptData[ids[i]].class_type;
            if (ct === 'SaveVideo' || ct === 'VHS_VideoCombine' || ct === 'SaveWEBM') return 'video';
        }
        for (i = 0; i < ids.length; i++) {
            ct = promptData[ids[i]] && promptData[ids[i]].class_type;
            if (/SaveAudio|AudioSave|SaveMusic/i.test(ct || '')) return 'audio';
        }
        for (i = 0; i < ids.length; i++) {
            ct = promptData[ids[i]] && promptData[ids[i]].class_type;
            if (/SaveGLB|SaveGaussianSplat|SaveTripoSRMesh|SaveMesh|Save3D|SaveSplat/i.test(ct || '')) return '3d';
        }
        return 'image';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 任意工作流执行（comfyui_run_workflow）与节点查询（comfyui_list_nodes）支撑
    // 定位：官方模板库之外的第二条通道——LLM 直接提交任意 UI/API 格式工作流，
    // 含本机自定义节点。与 comfyui_generate（注册表内置模型）互补；
    // 转换复用 customWorkflow.normalizeWorkflow（UI 格式 → API 格式）。
    // ─────────────────────────────────────────────────────────────────────────

    // promptId → 任务元信息（outputType / label）：check_status 在 model_id 省略时
    // 据此判输出类型。三个提交入口（generate / run_official_template / run_workflow）
    // 各写一次；按 FIFO 截断，防长期运行无限增长。
    var _promptMeta = {};

    function _registerPromptMeta(promptId, meta) {
        if (!promptId) return;
        _promptMeta[String(promptId)] = meta || {};
        var keys = Object.keys(_promptMeta);
        if (keys.length <= 200) return;
        for (var i = 0; i < keys.length - 100; i++) delete _promptMeta[keys[i]];
    }

    function _getPromptMeta(promptId) {
        return _promptMeta[String(promptId)] || null;
    }

    // 落盘产物按扩展名判定输出类型（check_status 无 model_id 时的权威校正：
    // 自定义工作流可能用任何保存节点，class_type 推断会漏，产物扩展名不会）。
    // 除图像/视频外补音频/3D：SaveAudio / SaveGLB 一类节点产物不该被当图片。
    var MEDIA_EXT = {
        video: /\.(mp4|mov|webm|avi|mkv|m4v)$/,
        image: /\.(png|jpe?g|webp|gif|bmp|tiff?)$/,
        audio: /\.(flac|wav|mp3|ogg|m4a|opus|aac)$/,
        '3d': /\.(glb|gltf|obj|ply|fbx|stl|splat|spz)$/
    };

    function _detectSavedOutputType(paths) {
        for (var i = 0; i < (paths || []).length; i++) {
            var p = String(paths[i] || '').toLowerCase();
            if (MEDIA_EXT.video.test(p)) return 'video';
        }
        for (var j = 0; j < (paths || []).length; j++) {
            var p2 = String(paths[j] || '').toLowerCase();
            if (MEDIA_EXT.image.test(p2)) return 'image';
        }
        for (var k = 0; k < (paths || []).length; k++) {
            var p3 = String(paths[k] || '').toLowerCase();
            if (MEDIA_EXT.audio.test(p3)) return 'audio';
        }
        for (var m = 0; m < (paths || []).length; m++) {
            var p4 = String(paths[m] || '').toLowerCase();
            if (MEDIA_EXT['3d'].test(p4)) return '3d';
        }
        return null;
    }

    // 输出类型的人类可读量词（文案不再一律「图片/视频」）
    function _outputTypeLabel(type) {
        if (type === 'video') return '视频';
        if (type === 'image') return '图片';
        if (type === 'audio') return '音频';
        if (type === '3d') return '3D 模型';
        return '文件';
    }

    /**
     * 读取本地工作流 JSON 文本（AEFS Result 版优先；旧通道折叠兜底）。
     * 返回 {ok:true,text} | {ok:false,message}。
     */
    async function _readWorkflowText(filePath) {
        if (!global.AEFS) return { ok: false, message: 'AEFS 未加载，无法读取本地工作流文件' };
        try {
            if (typeof global.AEFS.readFileResult === 'function') {
                var r = await global.AEFS.readFileResult(filePath);
                if (r && r.ok === true && typeof r.data === 'string') return { ok: true, text: r.data };
                var code = (r && r.error && r.error.code) || 'READ_FAILED';
                var msg = (r && r.error && r.error.message) || ('读取失败: ' + filePath);
                if (code === 'NOT_FOUND') return { ok: false, message: '工作流文件不存在: ' + filePath };
                return { ok: false, message: '工作流文件读取失败(' + code + '): ' + msg };
            }
            var text = await global.AEFS.readFile(filePath);
            if (typeof text === 'string') return { ok: true, text: text };
            return { ok: false, message: '无法读取工作流文件: ' + filePath };
        } catch (e) {
            return { ok: false, message: '工作流文件读取异常: ' + ((e && e.message) || String(e)) };
        }
    }

    /**
     * 按「节点ID.输入名」精确覆盖工作流输入；裸输入名（不含点号）命中所有
     * 已有该输入键的节点（官方模板参数覆盖用——模板节点 ID 对 LLM 不可见）。
     * 返回 {applied:[...], skipped:[{key,reason}], linkReplaced:[{key,node_id,input}]}。
     * linkReplaced：被覆盖的输入原本是节点连接（["id",slot]），覆盖后连线断开、改用字面值。
     * 裸键对链接输入的替换最容易断图（如 model/positive），调用方必须给可见提示。
     */
    function _applyOverrides(promptData, overrides) {
        var applied = [];
        var skipped = [];
        var linkReplaced = [];
        if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
            return { applied: applied, skipped: skipped, linkReplaced: linkReplaced };
        }
        function captureLink(nodeId, inputName) {
            var n0 = promptData[nodeId];
            var old = n0 && n0.inputs ? n0.inputs[inputName] : undefined;
            if (Array.isArray(old) && old.length === 2 && typeof old[0] === 'string' && typeof old[1] === 'number') {
                linkReplaced.push({ key: nodeId + '.' + inputName, node_id: nodeId, input: inputName });
            }
        }
        var keys = Object.keys(overrides);
        var ids = Object.keys(promptData || {});
        for (var i = 0; i < keys.length; i++) {
            var path = String(keys[i]);
            var value = overrides[keys[i]];
            if (!path) continue;
            var dot = path.indexOf('.');
            if (dot > 0) {
                var nodeId = path.slice(0, dot);
                var inputName = path.slice(dot + 1);
                var node = promptData[nodeId];
                if (!node) { skipped.push({ key: path, reason: '节点不存在: ' + nodeId }); continue; }
                if (!node.inputs) node.inputs = {};
                captureLink(nodeId, inputName);
                node.inputs[inputName] = value;
                applied.push(path);
                continue;
            }
            // 裸输入名：命中所有已有该输入键的节点（节点 ID 对 LLM 不可见的场景）
            var hit = 0;
            for (var j = 0; j < ids.length; j++) {
                var n = promptData[ids[j]];
                if (!n || !n.inputs) continue;
                if (!Object.prototype.hasOwnProperty.call(n.inputs, path)) continue;
                captureLink(ids[j], path);
                n.inputs[path] = value;
                hit++;
                applied.push(ids[j] + '.' + path);
            }
            if (!hit) skipped.push({ key: path, reason: '没有节点含该输入名' });
        }
        return { applied: applied, skipped: skipped, linkReplaced: linkReplaced };
    }

    // 负面提示词槽位定位（只在显式传 negative_prompt 时使用；找不到就跳过并提示）：
    // ① 输入名 negative_prompt/negative（伙伴 API 节点）
    // ② 节点标题含 negative/负面（转换器不保留标题，仅 API 格式导出可能带）
    // ③ 恰有两个文本编码节点时，positive 之外的那个
    function _findNegativeSlot(promptData, positiveSlot) {
        if (!promptData) return null;
        var ids = Object.keys(promptData);
        var i, j;
        for (i = 0; i < ids.length; i++) {
            var node = promptData[ids[i]];
            var keys = Object.keys((node && node.inputs) || {});
            for (j = 0; j < keys.length; j++) {
                if (/^(negative_prompt|negative)$/i.test(keys[j]) && typeof node.inputs[keys[j]] === 'string') {
                    return { nodeId: ids[i], key: keys[j] };
                }
            }
        }
        for (i = 0; i < ids.length; i++) {
            var n2 = promptData[ids[i]];
            var title = (n2 && n2._meta && (n2._meta.title || n2._meta.name)) || '';
            if (/negative|负面|反向/i.test(title) && n2.inputs && typeof n2.inputs.text === 'string') {
                return { nodeId: ids[i], key: 'text' };
            }
        }
        var textNodes = [];
        for (i = 0; i < ids.length; i++) {
            var n3 = promptData[ids[i]];
            if (n3 && /textencode/i.test(n3.class_type || '') && n3.inputs && typeof n3.inputs.text === 'string') {
                textNodes.push(ids[i]);
            }
        }
        if (textNodes.length === 2) {
            var posId = positiveSlot && positiveSlot.nodeId;
            var other = (textNodes[0] === posId) ? textNodes[1] : textNodes[0];
            if (other !== posId) return { nodeId: other, key: 'text' };
        }
        return null;
    }

    // 视频输入槽位（上传型/路径型）：LoadVideo 与 VHS 一族的载入节点。
    // 上传型注入上传后的服务端文件名；路径型直接给本地绝对路径（VHS_LoadVideoPath）。
    var VIDEO_INPUT_SLOTS = {
        LoadVideo: { key: 'file', kind: 'upload' },
        VHS_LoadVideo: { key: 'video', kind: 'upload' },
        VHS_LoadVideoPath: { key: 'video', kind: 'path' },
        LoadVideoUpload: { key: 'video', kind: 'upload' }
    };

    function _findVideoSlots(promptData) {
        var out = [];
        var ids = Object.keys(promptData || {});
        for (var i = 0; i < ids.length; i++) {
            var node = promptData[ids[i]];
            var cfg = node && VIDEO_INPUT_SLOTS[node.class_type];
            if (cfg && node.inputs) out.push({ nodeId: ids[i], key: cfg.key, kind: cfg.kind });
        }
        return out;
    }

    /**
     * 路径型视频槽（VHS_LoadVideoPath 等）：面板侧把本地绝对路径直接写进工作流交给
     * ComfyUI 读。交出去之前先过 AEFS 路径闸（存在性 + 敏感路径拒绝），与「文件 I/O
     * 一律走 AEFS」的底线对齐；AEFS 无 existsResult 的旧环境放行（不新增不可用能力）。
     */
    async function _verifyLocalMediaPath(p) {
        if (!global.AEFS || typeof global.AEFS.existsResult !== 'function') return { ok: true };
        try {
            var res = await global.AEFS.existsResult(p);
            if (res && res.ok === true) return { ok: true };
            var code = (res && res.error && res.error.code) || 'UNKNOWN';
            var msg = (res && res.error && res.error.message) || p;
            if (code === 'NOT_FOUND') return { ok: false, message: '视频文件不存在: ' + p };
            return { ok: false, message: '视频路径被数据层拒绝(' + code + '): ' + msg };
        } catch (e) {
            return { ok: false, message: '视频路径校验异常: ' + ((e && e.message) || String(e)) };
        }
    }

    /**
     * 取 spec 的可选值清单（widget combo）：老式 `[["a","b"]]`、`["COMBO",{options:[...]}]`、
     * `["COMFY_DYNAMICCOMBO_V3",{options:[{key}]}]` 三种形态归一。非 combo 返回 null。
     */
    function _comboChoicesOf(spec) {
        if (!Array.isArray(spec) || !spec.length) return null;
        var t = spec[0];
        var extra = (spec[1] && typeof spec[1] === 'object') ? spec[1] : {};
        if (Array.isArray(t)) return t;
        if (t === 'COMFY_DYNAMICCOMBO_V3') {
            var keys = [];
            var opts = extra.options || [];
            for (var i = 0; i < opts.length; i++) {
                if (opts[i] && opts[i].key !== undefined) keys.push(opts[i].key);
            }
            return keys.length ? keys : null;
        }
        if (Array.isArray(extra.options)) return extra.options;
        return null;
    }

    function _choiceMatches(value, choices) {
        for (var i = 0; i < choices.length; i++) {
            if (String(choices[i]) === String(value)) return true;
        }
        return false;
    }

    function _choiceInvalidMessage(key, value, choices) {
        var sample = [];
        for (var c = 0; c < choices.length && sample.length < 6; c++) sample.push(String(choices[c]));
        return '输入 ' + key + ' 的值 "' + String(value) + '" 不在可选值内（共 ' + choices.length
            + ' 项，例如: ' + sample.join(' / ') + (choices.length > sample.length ? ' …' : '') + '）';
    }

    /**
     * 枚举问题复核（全量 /object_info 是会话级缓存，上传/手放/新装模型都可能让缓存落后）。
     * 对 WIDGET_CHOICE_INVALID 涉及的节点类，用 service.getObjectInfo(class_type) 拉**单节点**
     * 最新定义（comfyuiService 单节点路径不走全量缓存）重判：现在匹配上就撤销问题并回写缓存；
     * 仍不匹配则用最新可选值重写错误文案（LLM 看到的是当下真实的候选表）。
     * 返回 {problems, healed}。
     */
    async function _refineChoiceProblems(problems, promptData, catalog, service) {
        var out = { problems: problems, healed: 0 };
        if (!problems || !problems.length || !service || typeof service.getObjectInfo !== 'function') return out;
        var need = {};
        var i;
        for (i = 0; i < problems.length; i++) {
            if (problems[i].code === 'WIDGET_CHOICE_INVALID' && problems[i].class_type) need[problems[i].class_type] = 1;
        }
        var classes = Object.keys(need);
        if (!classes.length) return out;
        var freshDefs = {};
        for (i = 0; i < classes.length; i++) {
            try {
                var def = await service.getObjectInfo(classes[i]);
                if (def && def.input) {
                    freshDefs[classes[i]] = def;
                    // 回写共享目录对象（同一引用即 service 缓存，后续校验也受益）
                    catalog[classes[i]] = def;
                }
            } catch (_) { /* 单节点刷新失败：保留原问题（不因刷新失败放行） */ }
        }
        if (!Object.keys(freshDefs).length) return out;
        var kept = [];
        for (i = 0; i < problems.length; i++) {
            var p = problems[i];
            var fresh = freshDefs[p.class_type];
            if (p.code !== 'WIDGET_CHOICE_INVALID' || !fresh) { kept.push(p); continue; }
            var node = promptData[p.node_id];
            var spec = (fresh.input.required && Object.prototype.hasOwnProperty.call(fresh.input.required, p.key))
                ? fresh.input.required[p.key]
                : (fresh.input.optional && Object.prototype.hasOwnProperty.call(fresh.input.optional, p.key) ? fresh.input.optional[p.key] : null);
            var choices = _comboChoicesOf(spec);
            if (!choices || !choices.length) { kept.push(p); continue; }
            var val = (node && node.inputs) ? node.inputs[p.key] : p.value;
            if (_choiceMatches(val, choices)) { out.healed++; continue; }
            p.value = val;
            p.message = _choiceInvalidMessage(p.key, val, choices);
            kept.push(p);
        }
        out.problems = kept;
        return out;
    }

    // required 输入是否已提供：常规看同名键；V3 autogrow 组（如 ComfyMathExpression.values）
    // 在 prompt 里是点号子键（values.a / values.b…），顶层 key 本身不会出现。
    function _requiredInputSatisfied(inputs, key, spec) {
        if (Object.prototype.hasOwnProperty.call(inputs, key)) return true;
        if (Array.isArray(spec) && spec[0] === 'COMFY_AUTOGROW_V3') {
            var prefix = key + '.';
            for (var k in inputs) {
                if (Object.prototype.hasOwnProperty.call(inputs, k) && k.indexOf(prefix) === 0) return true;
            }
        }
        return false;
    }

    /**
     * 提交前结构校验（自定义工作流用；ComfyUI /prompt 的校验错误比这里难读）。
     * 返回问题数组 [{code,node_id,class_type,message}]；空数组 = 通过。
     * 校验确定性项：节点类存在、required 输入齐备、链接指向有效节点/输出槽、
     * widget 字面值在 /object_info 枚举内（自写工作流最常见的错是模型文件名/枚举拼错）。
     * 注：
     *  - 调用方须在「注入（图片/视频/overrides）之后」执行本校验，否则模板占位值
     *    （如 LoadImage 的示例文件名）会被误判——它们本来就会在注入阶段被替换。
     *  - skipInputs（可选，{"节点ID.输入名":1}）：本工具刚上传并写入的输入跳过枚举校验。
     *    全量 /object_info 有缓存（comfyuiService），刚上传的新文件名不会立刻出现在
     *    LoadImage.image / LoadVideo.file 等文件选择 combo 里，不跳过会把合法上传误判。
     */
    function _validateApiPrompt(promptData, catalog, skipInputs) {
        var problems = [];
        var ids = Object.keys(promptData || {});
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var node = promptData[id];
            if (!node || !node.class_type) {
                problems.push({ code: 'NODE_INVALID', node_id: id, message: '节点缺少 class_type' });
                continue;
            }
            var def = catalog[node.class_type];
            if (!def) {
                problems.push({ code: 'NODE_NOT_INSTALLED', node_id: id, class_type: node.class_type,
                    message: '节点未安装: ' + node.class_type });
                continue;
            }
            var required = (def.input && def.input.required) || {};
            var optional = (def.input && def.input.optional) || {};
            var reqNames = Object.keys(required);
            for (var r = 0; r < reqNames.length; r++) {
                if (!_requiredInputSatisfied(node.inputs || {}, reqNames[r], required[reqNames[r]])) {
                    problems.push({ code: 'MISSING_REQUIRED_INPUT', node_id: id, class_type: node.class_type,
                        message: '缺少必需输入: ' + reqNames[r] });
                }
            }
            var inKeys = Object.keys(node.inputs || {});
            for (var k = 0; k < inKeys.length; k++) {
                var key = inKeys[k];
                var v = node.inputs[key];
                var isLink = Array.isArray(v) && v.length === 2 && typeof v[0] === 'string' && typeof v[1] === 'number';
                if (isLink) {
                    var src = promptData[v[0]];
                    if (!src) {
                        problems.push({ code: 'DANGLING_LINK', node_id: id, class_type: node.class_type,
                            message: '输入 ' + key + ' 指向不存在的节点 ' + v[0] });
                        continue;
                    }
                    var srcDef = catalog[src.class_type];
                    if (srcDef && Array.isArray(srcDef.output) && v[1] >= srcDef.output.length) {
                        problems.push({ code: 'LINK_SLOT_RANGE', node_id: id, class_type: node.class_type,
                            message: '输入 ' + key + ' 引用的输出槽 ' + v[1] + ' 超出节点 ' + v[0] + '（' + src.class_type + '）的输出数 ' + srcDef.output.length });
                    }
                    continue;
                }
                // widget 字面值与枚举对照（只比标量值；链接/复合值跳过）
                if (skipInputs && skipInputs[id + '.' + key]) continue;
                var spec = Object.prototype.hasOwnProperty.call(required, key) ? required[key]
                    : (Object.prototype.hasOwnProperty.call(optional, key) ? optional[key] : null);
                if (!spec) continue;
                var choices = _comboChoicesOf(spec);
                if (!choices || !choices.length) continue;
                if (v === null || v === undefined || typeof v === 'object') continue;
                if (!_choiceMatches(v, choices)) {
                    problems.push({
                        code: 'WIDGET_CHOICE_INVALID', node_id: id, class_type: node.class_type,
                        key: key, value: v,
                        message: _choiceInvalidMessage(key, v, choices)
                    });
                }
            }
        }
        // 没有输出节点的工作流执行完不产生文件（LLM 自写时容易漏 SaveImage/SaveVideo）。
        var outputNodeCount = 0;
        for (var oi = 0; oi < ids.length; oi++) {
            var od = catalog[promptData[ids[oi]] && promptData[ids[oi]].class_type];
            if (od && od.output_node === true) outputNodeCount++;
        }
        if (ids.length && !outputNodeCount) {
            problems.push({
                code: 'NO_OUTPUT_NODE', node_id: '', class_type: '',
                message: '工作流没有输出节点（如 SaveImage / SaveVideo），执行不会产生可回收的文件；'
                    + '可用 comfyui_list_nodes({output_nodes:true}) 查询本机输出节点'
            });
        }
        return problems;
    }

    // ComfyUI 提交错误体 → 人可读文本（与既有工具同口径）。
    function _formatSubmitError(err) {
        var text = 'ComfyUI 提交失败';
        var nodeErrors = (err && err.node_errors) || {};
        var keys = Object.keys(nodeErrors);
        if (keys.length > 0) {
            for (var i = 0; i < keys.length; i++) {
                var ne = nodeErrors[keys[i]];
                if (ne && ne.errors) text += '\n节点 ' + keys[i] + ': ' + JSON.stringify(ne.errors);
            }
        } else if (err && err.error) {
            text += ': ' + (err.error.message || err.error);
        } else if (err && err.message) {
            text += ': ' + err.message;
        }
        return text;
    }

    async function _submitPromptOrError(service, promptData, apiKey) {
        var result = await service.submitPrompt(promptData, apiKey);
        if (result && result.error) return { ok: false, text: _formatSubmitError(result.error) };
        var promptId = typeof result === 'string' ? result : (result && result.prompt_id);
        if (!promptId) return { ok: false, text: 'ComfyUI 未返回 prompt_id' };
        return { ok: true, promptId: promptId };
    }

    // 清单类工具（comfyui_list_checkpoints / comfyui_list_nodes）的单页序列化预算。
    // 执行管线按「JSON 序列化后」长度兜底截断（>32K 只留头 24K + 尾 8K，见
    // client/modules/agent/engine/controller/toolExecutionPipeline.js），一页越过该线会被
    // 再截一次、JSON 被切坏。故清单工具自守 20K（留 4K 余量），超预算时自动减小本页条数，
    // 并用实际值回应（limit / returned）。
    var PAGING_PAYLOAD_BUDGET = 20 * 1024;
    // detail 模式为 omitted_inputs/omitted_total/hint 预留的头部空间
    var DETAIL_INPUT_BUDGET = PAGING_PAYLOAD_BUDGET - 1024;
    // combo 可选值分页：默认 60、上限 120（单输入可达上千项，只返回一页 + 翻页游标）
    var NODE_CHOICE_LIMIT_DEFAULT = 60;
    var NODE_CHOICE_LIMIT_MAX = 120;

    // 整数参数归一：null / 空串 / 纯空白不是数字参数（Number(null)=0、Number('')=0，
    // 会被夹到 min 而不是缺省值），按缺省值处理；其它非数字回落默认值，越界夹到边界。
    function _intArg(value, dft, min, max) {
        if (value === null || value === undefined) value = dft;
        else if (typeof value === 'string' && value.trim() === '') value = dft;
        var n = Number(value);
        if (!isFinite(n)) n = dft;
        n = Math.floor(n);
        if (n < min) n = min;
        if (max !== undefined && n > max) n = max;
        return n;
    }

    // 单个可选值的长度硬上限：正常文件名远低于该值，超长值截断并标记，保证单页可收敛。
    var NODE_CHOICE_VALUE_MAX = 1024;

    function _clipChoiceValue(v) {
        var s = typeof v === 'string' ? v : String(v);
        if (s.length <= NODE_CHOICE_VALUE_MAX) return { value: s, clipped: false };
        return { value: s.slice(0, NODE_CHOICE_VALUE_MAX) + '…', clipped: true };
    }

    // 该输入的可分页候选：field=结果字段名（choices / options），list=原始候选。
    // 动态 combo 的 options 是 { key, inputs } 对象，只取 key 列表；普通 COMBO 的
    // extra_dict options 仍是字符串型候选（动态 combo 不重复下发原始对象）。
    function _choiceSourceOf(spec) {
        if (!Array.isArray(spec) || !spec.length) return null;
        var t = spec[0];
        var extra = (spec[1] && typeof spec[1] === 'object') ? spec[1] : {};
        if (Array.isArray(t)) return { field: 'choices', list: t };
        if (t === 'COMFY_DYNAMICCOMBO_V3') {
            var keys = (Array.isArray(extra.options) ? extra.options : [])
                .map(function (o) { return o && o.key; })
                .filter(function (k) { return typeof k === 'string' && k; });
            return { field: 'options', list: keys };
        }
        if (t === 'COMBO' && Array.isArray(extra.options)) {
            var vals = extra.options.filter(function (v) {
                return typeof v === 'string' || typeof v === 'number';
            });
            return { field: 'choices', list: vals };
        }
        return null;
    }

    // 回填分页游标。start 为本页起点（已按总数夹取），count 为本页实际条数。
    function _writePageCursor(out, field, start, count, total) {
        out[field + '_total'] = total;
        if (start > 0) out[field + '_offset'] = start;
        var end = start + count;
        out[field + '_hasMore'] = end < total;
        out[field + '_nextOffset'] = end < total ? end : null;
    }

    // 分页写当前页，另给总数 / 是否还有下一页 / 下一页 offset。
    // offset 严格大于总数时标记 outOfRange（与本页恰好为空/末页区分，供提示文案判定）。
    function _fillPage(out, field, list, offset, limit) {
        var total = list.length;
        var start = offset > total ? total : offset;
        var end = Math.min(start + limit, total);
        var page = list.slice(start, end);
        var clipped = 0;
        for (var i = 0; i < page.length; i++) {
            var c = _clipChoiceValue(page[i]);
            page[i] = c.value;
            if (c.clipped) clipped++;
        }
        out[field] = page;
        _writePageCursor(out, field, start, page.length, total);
        if (offset > total) out[field + '_outOfRange'] = true;
        if (clipped) out[field + '_clipped'] = clipped;
    }

    function _fillChoicePage(out, list, offset, limit) {
        _fillPage(out, 'choices', list, offset, limit);
    }

    function _fillOptionPage(out, list, offset, limit) {
        _fillPage(out, 'options', list, offset, limit);
    }

    // 把候选行收敛到单页预算内，返回可序列化的最长前缀。
    // buildFn(page) 必须返回最终工具结果对象（其 JSON.stringify 即返回文本）。
    function _fitPageToBudget(candidate, buildFn) {
        var page = [];
        var used = JSON.stringify(buildFn([])).length;
        var i;
        for (i = 0; i < candidate.length; i++) {
            var addLen = JSON.stringify(candidate[i]).length + (page.length ? 1 : 0);
            // 结果里 returned / hasMore / nextOffset / message 的长度随页长微调，末尾按精确值回退
            if (used + addLen >= PAGING_PAYLOAD_BUDGET) break;
            used += addLen;
            page.push(candidate[i]);
        }
        while (page.length > 0 && JSON.stringify(buildFn(page)).length >= PAGING_PAYLOAD_BUDGET) {
            page.pop();
        }
        // 至少返回一项：否则 hasMore=true 而本页为空，翻页原地打转（单项超预算时不再收缩）
        if (!page.length && candidate.length) page.push(candidate[0]);
        return page;
    }

    // 节点查询：schema 摘要（combo 可选值分页——模型清单可达数百项，全量会撑爆工具返回）
    function _summarizeInputSpec(spec, opts) {
        opts = opts || {};
        var choiceOffset = _intArg(opts.choicesOffset, 0, 0);
        var choiceLimit = _intArg(opts.choicesLimit, NODE_CHOICE_LIMIT_DEFAULT, 1, NODE_CHOICE_LIMIT_MAX);
        var out = { type: 'UNKNOWN' };
        if (!Array.isArray(spec) || !spec.length) return out;
        var t = spec[0];
        var extra = (spec[1] && typeof spec[1] === 'object') ? spec[1] : {};
        var source = _choiceSourceOf(spec);
        if (Array.isArray(t)) {
            out.type = 'COMBO';
        } else if (t === 'COMFY_DYNAMICCOMBO_V3') {
            out.type = 'DYNAMIC_COMBO';
        } else if (t === 'COMFY_AUTOGROW_V3') {
            out.type = 'AUTOGROW';
            if (extra.template) {
                out.prefix = extra.template.prefix;
                out.min = extra.template.min;
                out.max = extra.template.max;
                out.names = extra.template.names;
            }
        } else if (t === 'COMFY_MATCHTYPE_V3') {
            out.type = 'MATCHTYPE';
            if (extra.template && extra.template.allowed_types) out.allowed_types = extra.template.allowed_types;
        } else {
            out.type = String(t);
        }
        // 动态 combo 的选项 key 分页写 options_*；字符串型 COMBO 写 choices_*
        if (source && source.field === 'options') _fillOptionPage(out, source.list, choiceOffset, choiceLimit);
        else if (source && source.field === 'choices') _fillChoicePage(out, source.list, choiceOffset, choiceLimit);
        if (extra.default !== undefined) out.default = extra.default;
        if (extra.min !== undefined) out.min = extra.min;
        if (extra.max !== undefined) out.max = extra.max;
        if (extra.step !== undefined) out.step = extra.step;
        return out;
    }

    // input= 单输入结果的翻页提示：有分页字段时按 choices_*/options_* 生成；
    // 越界空页（offset > total）与末页/已全部返回分开说明，不把越界说成「已全部返回」。
    function _specPageHint(spec) {
        var field = '';
        if (spec && spec.options_total !== undefined) field = 'options';
        else if (spec && spec.choices_total !== undefined) field = 'choices';
        if (!field) {
            return spec && Array.isArray(spec.options)
                ? '该输入是动态 combo，选项 key 见 spec.options。'
                : '该输入没有分页可选值（非 combo），schema 见 spec。';
        }
        var total = spec[field + '_total'];
        var shown = Array.isArray(spec[field]) ? spec[field].length : 0;
        var label = field === 'options' ? '动态 combo 选项' : '可选值';
        var suffix = spec[field + '_clipped'] ? '（部分可选值过长，已截断显示）' : '';
        if (total === 0) return '该输入的' + label + '为空（total=0）。';
        if (spec[field + '_outOfRange']) {
            return 'choices_offset 超出' + label + '总数 ' + total + '（有效 offset 0–' + (total - 1)
                + '），本页为空；用 choices_offset=0 重新查询或改用更小的值。' + suffix;
        }
        if (spec[field + '_hasMore']) {
            return '该输入的' + label + '共 ' + total + ' 个，本页返回 ' + shown + ' 个；用 choices_offset='
                + spec[field + '_nextOffset'] + ' 继续。' + suffix;
        }
        if (shown === 0) {
            return 'choices_offset 已到' + label + '末尾（总数 ' + total + '），本页为空；去掉 choices_offset 可回到首页。' + suffix;
        }
        return '该输入的' + label + '已全部返回（共 ' + total + ' 个）。' + suffix;
    }

    // input= 单输入结果按序列化预算收敛：候选页超预算时回退本页条数并回填游标；
    // 单个候选值本身超预算时按固定上限截断（极端情况），保证整页 <24K 兜底头窗。
    function _fitOnePage(one, source, offset) {
        if (!source || !one || !one.spec) return one;
        var field = source.field;
        var spec = one.spec;
        if (!Array.isArray(spec[field])) return one;
        var total = spec[field + '_total'] || 0;
        var start = Math.min(offset, total);
        var guard = 0;
        while (JSON.stringify(one).length >= PAGING_PAYLOAD_BUDGET && spec[field].length > 1 && guard++ < 500) {
            spec[field].pop();
            _writePageCursor(spec, field, start, spec[field].length, total);
            one.hint = _specPageHint(spec);
        }
        if (JSON.stringify(one).length >= PAGING_PAYLOAD_BUDGET && spec[field].length === 1) {
            var raw = String(spec[field][0]);
            var keep = 256;
            while (keep >= 8) {
                spec[field][0] = raw.slice(0, keep) + '…';
                spec[field + '_clipped'] = 1;
                one.hint = _specPageHint(spec) + '（单个可选值过长，已截断显示）';
                if (JSON.stringify(one).length < PAGING_PAYLOAD_BUDGET) break;
                keep = Math.floor(keep / 2);
            }
        }
        return one;
    }

    // 后台轮询超时——对齐表单批量档（controller.generate 每任务 600s + 60s
    // 余量，LLM 路径 batch_size 恒 1）；视频类再放宽三倍（Kling/Seedance 高时长
    // 档云端排队+推理远超 5 分钟）。300000 硬超时会把长时云端视频任务的结果
    // 放弃（积分已消耗、对话却报失败）。global.AEComfyUI.llmPollTimeoutMs 可注入（单测用）。
    function _bgPollTimeoutMs(outputType) {
        if (global.AEComfyUI && typeof global.AEComfyUI.llmPollTimeoutMs === 'number') {
            return global.AEComfyUI.llmPollTimeoutMs;
        }
        var base = 600000 + 60000;
        return outputType === 'video' ? base * 3 : base;
    }

    // 同一 promptId 的结果落盘去重——_backgroundPoll（后台轮询）与
    // comfyui_check_status（LLM 主动查询）双路径可能先后发现同一任务完成并各
    // 下载落盘一份（双份文件、_pruneResultDir(50) 容量无谓消耗）。首个到达路径
    // 下载落盘并缓存 promise，另一路径等待/复用同一结果；下载或落盘失败时清除
    // 标记（不缓存失败），后到路径与后续调用可重试。
    var _savedPromptOutputs = {};  // promptId → 下载落盘 promise（resolve 已保存路径数组）

    function _pruneSavedPromptOutputs() {
        var keys = Object.keys(_savedPromptOutputs);
        if (keys.length <= 200) return;
        for (var i = 0; i < keys.length - 100; i++) delete _savedPromptOutputs[keys[i]];
    }

    async function _savePromptOutputs(outputs, service, promptId) {
        if (promptId && _savedPromptOutputs[promptId]) {
            return _savedPromptOutputs[promptId];
        }
        var promise = (async function () {
            var downloaded = await _downloadOutputs(outputs, service);
            var savedPaths = [];
            for (var si = 0; si < downloaded.length; si++) {
                savedPaths.push(await _saveResultFile(downloaded[si].blob, downloaded[si].filename, si));
            }
            return savedPaths;
        })();
        if (promptId) {
            _savedPromptOutputs[promptId] = promise;
            promise.catch(function () { delete _savedPromptOutputs[promptId]; });
            _pruneSavedPromptOutputs();
        }
        return promise;
    }

    /**
     * 后台轮询 ComfyUI 生成结果，完成后自动注入到 Agent 对话。
     * fire-and-forget：不阻塞工具返回，生成完成时通过 bridge.injectSystemResult 推入对话。
     *
     * fromExternal（外接来源完全不注入）：外接通道提交的任务不写
     * 面板会话、不落卡片、不排唤起——面板不回应不是它发起的任务（唤起会白跑一轮 LLM）。
     * 下载落盘照做：外接侧经 comfyui_check_status 复用同一份落盘去重缓存拿路径。
     *
     * laneId（团队模式）：提交时所在 lane，与 sessionId 同一刻快照（见 _laneIdOfCtx）。
     * 结果注入按它写回**发起的那条 lane**；空串 ⇒ 注入回落当前 lane。
     */
    function _backgroundPoll(service, promptId, modelId, outputType, sessionId, fromExternal, laneId) {
        (async function () {
            try {
                var outputs = await _pollForResults(service, promptId, _bgPollTimeoutMs(outputType));
                var savedPaths = await _savePromptOutputs(outputs, service, promptId);
                if (fromExternal) return;
                // 产物扩展名是权威判据（提交时按节点类推断，落盘后校正，含 audio/3D）
                var detectedType = _detectSavedOutputType(savedPaths);
                if (detectedType) outputType = detectedType;
                var doneText = savedPaths.length
                    ? ('生成完成，共 ' + savedPaths.length + ' 个' + _outputTypeLabel(outputType) + '文件')
                    : '生成完成，但未产生可回收的文件（工作流可能只有预览节点）';
                var resultText = JSON.stringify({
                    status: 'done',
                    model_id: modelId,
                    outputs: savedPaths,
                    output_type: outputType,
                    count: savedPaths.length,
                    message: doneText
                });
                // 提取媒体路径用于 UI 常显区（图片缩略图 / 视频可播放）
                var media = { images: null, videos: null };
                if (outputType === 'image') {
                    var imgPaths = savedPaths.filter(function (p) { return /\.(png|jpg|jpeg|webp|gif)$/i.test(p); });
                    if (imgPaths.length) media.images = imgPaths;
                } else if (outputType === 'video') {
                    var vidPaths = savedPaths.filter(function (p) { return /\.(mp4|mov|avi|webm)$/i.test(p); });
                    if (vidPaths.length) media.videos = vidPaths;
                }
                if (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.injectSystemResult === 'function') {
                    global.AEEngine.bridge.injectSystemResult(
                        'ComfyUI 生成完成',
                        // 常显区：人话摘要；路径经 media 以缩略图/视频形式常显
                        { text: doneText, images: media.images, videos: media.videos },
                        // 细节区：完整 JSON（含 outputs 路径），默认收起
                        { text: resultText },
                        'user',
                        // 会话一致性：轮询期间用户切换会话时，结果写回提交任务的原会话
                        sessionId,
                        // lane 一致性（团队模式）：结果写回提交任务的**原 lane**，不落到
                        // 用户当前正在看的别条 lane 上（缺省/空串 ⇒ 注入回落当前 lane）
                        laneId
                    );
                }
            } catch (e) {
                console.error('[ComfyuiBootstrap] background poll error:', e);
                if (fromExternal) return;   // 外接来源不注入（失败同样不写面板会话）
                var errText = 'ComfyUI 后台生成失败: ' + (e.message || String(e));
                if (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.injectSystemResult === 'function') {
                    global.AEEngine.bridge.injectSystemResult('ComfyUI 生成失败', { text: errText }, null, 'user', sessionId, laneId);
                }
            }
        })();
    }

    /**
     * 从 outputs 中提取并下载所有结果文件。
     */
    async function _downloadOutputs(outputs, service) {
        var results = [];
        var nodeIds = Object.keys(outputs);
        for (var ni = 0; ni < nodeIds.length; ni++) {
            var nodeOutput = outputs[nodeIds[ni]];
            if (!nodeOutput) continue;
            var keys = Object.keys(nodeOutput);
            for (var ki = 0; ki < keys.length; ki++) {
                var arr = nodeOutput[keys[ki]];
                if (!Array.isArray(arr)) continue;
                for (var ii = 0; ii < arr.length; ii++) {
                    if (!arr[ii] || !arr[ii].filename) continue;
                    var blob = await service.downloadOutput(
                        arr[ii].filename, arr[ii].subfolder, arr[ii].type
                    );
                    results.push({
                        blob: blob,
                        filename: arr[ii].filename,
                        outputType: keys[ki]
                    });
                }
            }
        }
        return results;
    }

    /**
     * 将 blob 保存到本地文件，返回文件路径。
     */
    async function _saveResultFile(blob, filename, index) {
        var dataDir = '';
        try {
            dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir().dir : '';
        } catch (_) {}

        var dir = dataDir ? (dataDir + '\\temp\\comfyui-output') : '';
        if (dir) {
            // AEFS.mkdir 非递归，逐层建目录
            try {
                if (global.AEFS && global.AEFS.mkdir) {
                    await global.AEFS.mkdir(dataDir + '\\temp');
                    await global.AEFS.mkdir(dir);
                }
            } catch (_) {}
        }

        // 安全扩展名
        var ext = String(filename || '').split('.').pop().toLowerCase();
        ext = /^[\w]+$/.test(ext) ? ext : 'bin';
        var shortId = String(Date.now()).slice(-8);
        var fileName = 'ComfyUI_' + shortId + '_' + String(index + 1).padStart(3, '0') + '.' + ext;
        // 并发后台生成同毫秒完成 → shortId+index 相同 → 同路径落盘互相覆盖；
        // 落盘前去重（复用 sharedUtils 的 dedupeFileName，与画布/表单路径同语义）。
        // 模块未提供该函数时保持原名（不炸，覆盖风险仍在）。
        if (dir && global.AEComfyUI && typeof global.AEComfyUI.dedupeFileName === 'function') {
            fileName = global.AEComfyUI.dedupeFileName(dir, fileName);
        }
        var filePath = dir ? (dir + '\\' + fileName) : '';

        if (filePath && global.AEFS && typeof global.AEFS.writeBlob === 'function') {
            var ok = await global.AEFS.writeBlob(filePath, blob);
            if (ok) {
                // 落盘成功后触发结果目录裁剪（只保留最近 50 个），fire-and-forget
                _pruneResultDir(50).catch(function (_) {});
                // 返回值用「数据根相对路径」——它会进 Agent 会话（常显缩略图/
                // 细节 JSON/LLM 上下文）并随 sessions/*.json 落盘；相对路径在换数据目录后
                // 仍指向新根（绝对路径会断链、迁移后还会读旧根副本）。读侧（view/videoPreview）
                // 负责还原成绝对。数据根不可用/助手缺失时退回绝对（行为同改造前）。
                return (global.AEShared && typeof global.AEShared.toDataRelPath === 'function')
                    ? global.AEShared.toDataRelPath(dataDir, filePath) : filePath;
            }
        }

        throw new Error('保存文件失败: ' + filePath);
    }

    // 结果目录只保留最近 N 个文件（按 mtime 升序删最旧），防止 temp/comfyui-output 无限累积。
    // 注：这些文件可能被 Agent 历史会话引用，删除会让历史图片缩略图断链。
    // 48h 豁免窗——近两天的产物不参与滚动删除（用户回看历史会话的高频窗口），
    // 只删 48h 前的旧文件中最旧的超出部分。防累积能力保留：豁免窗外仍按 maxFiles
    // 滚动；48h 内的堆积上限为两天生成量（temp 目录可接受）。无条件 50 个滚动
    // 删除会把当天生成的产物挤掉，历史会话缩略图当天即断链。
    var PRUNE_PROTECT_MS = 48 * 60 * 60 * 1000;
    async function _pruneResultDir(maxFiles) {
        maxFiles = maxFiles == null ? 50 : maxFiles;
        var dataDir = '';
        try {
            dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir().dir : '';
        } catch (_) {}
        if (!dataDir) return;
        var dir = dataDir + '\\temp\\comfyui-output';
        if (!global.AEFS || typeof global.AEFS.listFiles !== 'function') return;
        var names = [];
        try { names = await global.AEFS.listFiles(dir); } catch (_) { return; }
        if (!Array.isArray(names)) return;
        // 只统计 ComfyUI_ 前缀产物
        var files = [];
        for (var i = 0; i < names.length; i++) {
            if (/^ComfyUI_/i.test(names[i])) files.push({ name: names[i], mtime: -Infinity });
        }
        if (files.length <= maxFiles) return;
        // 按 mtime 升序（旧在前），只删最旧的超出部分
        var withMtime = [];
        for (var j = 0; j < files.length; j++) {
            var st = null;
            try { st = await global.AEFS.stat(dir + '\\' + files[j].name); } catch (_) {}
            // stat 失败（st null，ES 忙时超时折叠）跳过不参与当前轮删除排序——
            // 若记 mtime=0 则升序排最前 + nowMs-0 恒超 48h 豁免窗 → stat 故障的文件
            // 最先被删（语义应为未知 → 保护跳过），部分 stat 失败时最新产物被误删
            if (!st || !st.mtimeMs) continue;
            files[j].mtime = st.mtimeMs;
            withMtime.push(files[j]);
        }
        withMtime.sort(function (a, b) { return a.mtime - b.mtime; });
        var toDelete = withMtime.length - maxFiles;
        var nowMs = Date.now();
        for (var k = 0; k < withMtime.length && toDelete > 0; k++) {
            // 升序遍历，首个 48h 内的文件之后的全部更新——直接停（豁免窗保护）
            if (nowMs - withMtime[k].mtime < PRUNE_PROTECT_MS) break;
            try { if (global.AEFS.deleteFile) await global.AEFS.deleteFile(dir + '\\' + withMtime[k].name); } catch (_) {}
            toDelete--;
        }
    }

    // temp/ae-preview 抓帧残片清扫：captureCurrentFrame 的临时 PNG
    // （temp/ae-preview/ae_preview_<ms>.png，单张可达数十 MB）只在写盘→读回 Blob 的
    // 秒级-分钟级窗口内存活，读回后 finally 即删；删除失败（面板重载 / 进程退出 /
    // 文件被占）留下的残片不在任何清扫目标里——temp 根的 ae_preview_* 匹配到不了
    // 子目录、又没有别的龄清扫目录覆盖 → 重载面板即永久残留。
    // 目标声明与删除实现都走 AETempSweep（单一真相源）：按 aePreviewTarget 的声明
    // （24h 龄阈值，抓帧无引用、用量只在秒级-分钟级）调公共 sweep()，落
    // _sweep_ae-preview.json 报告；预算清单 budgetTargets 也已同列该目录（2GB 合计
    // 口径把残片算进去）。启动清一次 + 每小时兜底，重载面板即自愈。
    // 清扫器未加载时（旧包/测试沙箱）不挂定时器：多套单测会用真定时器调
    // initComfyuiTools，挂真 setInterval 会让 Node 进程不退出。
    var _aePreviewSweepTimer = null;
    async function _cleanAePreviewTemp() {
        try {
            if (!global.AETempSweep || typeof global.AETempSweep.sweep !== 'function'
                || typeof global.AETempSweep.aePreviewTarget !== 'function') return;
            var dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir().dir : '';
            if (!dataDir) return;
            var base = dataDir.replace(/\\+$/, '');
            var target = global.AETempSweep.aePreviewTarget(base);
            await global.AETempSweep.sweep({
                dir: target.dir, match: target.match, maxAgeMs: target.maxAgeMs,
                reportPath: base + '\\temp\\_sweep_ae-preview.json'
            });
        } catch (_) {}
    }
    function _startAePreviewSweep() {
        if (_aePreviewSweepTimer) return;
        if (!global.AETempSweep || typeof global.AETempSweep.aePreviewTarget !== 'function') return;
        if (typeof setInterval !== 'function') return;
        _cleanAePreviewTemp();
        _aePreviewSweepTimer = setInterval(_cleanAePreviewTemp, 60 * 60 * 1000);
    }

    /**
         * 构建 comfyui_generate 工具描述（含可用模型列表）。
         *
         * reader 由调用方传入（注册表传 moduleId，外接投影 extTools.toToolDef 传
         * 'external-mcp'）；唯一按读者面分叉的是送达口径——面板内结果由 _backgroundPoll
         * 注入对话，外接通道无推送原语，只能自行轮询。
         */
    function _isExternalReader(reader) {
        return String(reader || '') === 'external-mcp';
    }

    // 执行期判据：toolExecutor 以 callerId 透传调用方（外接 dispatch 传 'ext:<clientId>'，
    // 面板内为空串；见 toolExecutor.js 的 handler(args, {moduleId, callerId})）。
    function _isExternalCaller(execCtx) {
        return /^ext:/.test(String((execCtx && execCtx.callerId) || ''));
    }

    // 当前轮调用所在的 lane（团队模式）：controller 经 execCtx.laneId 下发本条 lane 的身份
    //（见 toolExecutionPipeline 的 _execCtxOpts）。外接 / 单 Agent / 面板手动通道没有该字段
    // ⇒ 空串，后台结果注入回落「当前 lane」（bridge.injectSystemResult 的 laneId 语义）。
    // 与 sessionId 同一刻快照：结果迟到时用户可能已切走 lane/会话，按发起时的那条写回才对。
    function _laneIdOfCtx(execCtx) {
        return (execCtx && typeof execCtx.laneId === 'string') ? execCtx.laneId : '';
    }

    function _buildDescription(reader) {
        var external = _isExternalReader(reader);
        var lines = [
            '使用 ComfyUI 进行 AI 图像或视频生成。',
            '',
            '可用模型:',
            '【图像生成】',
            '  - txt2img: 本地文生图（checkpoint；或受支持的图像扩散模型如 ANIMA、Qwen-Image、Krea 2，自动配文本编码器/VAE 与推荐采样参数）',
            '  - img2img: 本地图生图（需输入图片；checkpoint 或受支持图像扩散模型，Qwen-Image 族支持输入图 + 多张参考图）',
            '  - seedream: 字节 Seedream 云端文生图（支持参考图）',
            '  - gpt_image2: OpenAI GPT Image 2 云端文生图（支持参考图）',
            '  - nano_banana2: Gemini Nano Banana 2 云端文生图（支持参考图）',
            '【视频生成】',
            '  - kling_i2v: Kling V3 图生视频（需要输入图片）',
            '  - kling_i2v_legacy: Kling 旧版图生视频（需要输入图片）',
            '  - kling_start_end: Kling 起止帧生成视频（需要2张图片：首帧+尾帧）',
            '  - seedance2_i2v: 字节 Seedance 2.0 首帧/首尾帧生成视频（需要输入图片）',
            '  - seedance2_ref: 字节 Seedance 2.0 参考生成视频（可选参考图/视频）',
            '  - hailuo: 海螺视频文生视频（可选首帧图片）',
            '  - happyhorse_i2v: HappyHorse 图生视频（需要输入图片）',
            '  - happyhorse_r2v: HappyHorse 参考图生视频（需要输入图片）'
        ];
        lines = lines.concat([
            '',
            '图片输入: image_source=current_frame（AE 当前帧）/ file_path（指定文件，路径放 image_paths 数组；',
            '聊天历史 [附件图片路径] 下的绝对路径可直接复制）/ none（不使用图片）。',
            '',
            'extra_params: 模型特有参数，如 width/height(尺寸)、steps(步数)、cfg、duration(视频时长)、',
            '  resolution(分辨率)、aspect_ratio(宽高比) 等。具体可用参数取决于模型。',
            '  对于本地模型(txt2img/img2img)，可通过 extra_params.model 指定模型名称：checkpoint 名，或',
            '  models/unet、models/diffusion_models 下的文件名（如 "Anime\\anima_turboV11.safetensors"）。',
            '  仅受支持的图像族可用（ANIMA / Qwen-Image / Krea 2），自动配置文本编码器/VAE 与推荐采样参数；',
            '  视频模型（MiniMax H3、WAN、LTX 等）与未适配族不可用于本地文生图，先查 comfyui_list_checkpoints（supported_only=true, modality=image）。',
            '  extra_params 可覆盖 steps / cfg / sampler / scheduler / denoise。',
            '  多张图片（image_source="file_path" 的 image_paths 数组）会依次映射：img2img 第一张为输入图，其余进参考图槽。',
            '  ⚠️ 调用前先用 comfyui_list_params 查询模型支持哪些参数及可选值，',
            '  ⚠️ 再用 comfyui_list_checkpoints 查询本地可用的 checkpoint 与扩散模型列表。',
            '  参数 key 必须与 comfyui_list_params 返回的 key 完全一致（含点号前缀，如 model.size_preset）。',
            '',
            '其他场景: 任意工作流/自定义节点 → comfyui_run_workflow；官方模板（含视频）→',
            '  comfyui_search_official_templates + comfyui_run_official_template。',
            '',
            '注意: 云端模型会消耗 ComfyUI 账户积分，且需要在 ComfyUI 模块设置中填入 Comfy API Key。',
            '如遇 Unauthorized 错误，请提示用户在 ComfyUI 模块设置中填写 API Key，而非去模型平台登录。',
            '',
            '⚠️ 异步模式: 此工具提交任务后立即返回 prompt_id（status=generating），不等待生成完成。'
        ]);
        if (external) {
            lines.push('完成结果不会主动送达，须自行调用 comfyui_check_status 反复查询；done 时 outputs 含输出路径。');
        } else {
            lines.push('生成完成后结果会自动发送到对话中（包含输出文件路径），无需手动查询。');
            lines.push('如需主动查询进度，可调用 comfyui_check_status 工具（传入 prompt_id 和 model_id）。');
        }
        // 自动发现模型列表放最末尾：它随伙伴节点安装增长（可达上百个），是唯一允许被
        // 外接投影 2048 截断吃掉的部分；上面的路由句/送达口径必须在截断线之前。
        if (_autoModelLines.length) {
            lines.push('', '自动发现的模型（伙伴节点安装后出现，均云端 API 节点，消耗积分）:');
            lines = lines.concat(_autoModelLines.slice(0, AUTO_MODEL_LINE_MAX));
            if (_autoModelLines.length > AUTO_MODEL_LINE_MAX) {
                lines.push('  …另有 ' + (_autoModelLines.length - AUTO_MODEL_LINE_MAX)
                    + ' 个未列出（用 comfyui_list_params 按 model_id 查参数）');
            }
        }
        return lines.join('\n');
    }

        /**
         * 初始化 ComfyUI LLM 工具。
         *
         * scope：八个工具全为 `['agent','external-mcp']`——**不含 shader 与 script**。
         * 这两个档位都没有生成/落盘素材的使用面：shader 轮做 GLSL 片元效果，script 轮只产出代码；
         * 八件工具（生成类与只读查询类）同属 comfyui 模块的工具面。scope 只决定默认面：
         * 用户在工具可见性面板对本视图放宽后，投放（`gate.defsFor`）与执行（`toolExecutor` 的
         * 闸口授权）按同一份 filter 放行。
         * **外接（external-mcp）必须保留**：`extPolicy` 的 comfyui 组 fixed 名单默认开，而外接的
         * tools/list 投影与执行期复检共用 `extTools.isToolExposed`（内含 `scopeAllowsExternal`）——
         * 漏了外接，该件从外接清单消失且调用被拒（getPreviewFrame 同款取舍，见其 scope 注释）。
         * 八处 `scope:` 字面量必须一致；改一处即改全部（seed/已装环境无关：工具在代码里注册，
         * 不走 ae_tools.json 的「仅补缺失」通道）。
         * 工具面含 comfyui_run_workflow（任意 UI/API 工作流 + 自定义节点 + 视频输入）与
         * comfyui_list_nodes（节点目录查询）——保持简化版，不引入官方大 MCP。
         */
    function initComfyuiTools(config) {
        // temp/ae-preview 抓帧残片清扫：启动清一次 + 每小时兜底（目标声明在 AETempSweep）
        _startAePreviewSweep();
        var toolRegistry = config.toolRegistry;
        if (!toolRegistry) {
            console.warn('[ComfyuiBootstrap] MISSING_TOOL_REGISTRY');
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }

        _generateSchema = {
            type: 'object',
            properties: {
                model_id: {
                    type: 'string',
                    description: '模型ID',
                    enum: ALL_MODEL_IDS
                },
                    prompt: {
                        type: 'string',
                        description: '正向提示词（描述要生成的内容）'
                    },
                    negative_prompt: {
                        type: 'string',
                        description: '负面提示词（描述不希望出现的内容，可选）'
                    },
                    seed: {
                        type: 'number',
                        description: '随机种子。-1 表示随机，固定数字可复现结果。默认 -1。',
                        default: -1
                    },
                    image_source: {
                        type: 'string',
                        description: '图片来源。current_frame=AE当前帧, file_path=指定文件（聊天历史 [附件图片路径] 下的绝对路径可直接用）, none=无图片',
                        enum: ['current_frame', 'file_path', 'none']
                    },
                    image_paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '当 image_source=file_path 时的图片文件路径数组'
                    },
                    extra_params: {
                        type: 'object',
                        description: '模型特有参数（如 width, height, steps, cfg, duration, resolution, aspect_ratio 等；本地文生图可传 model=checkpoint 名或扩散模型文件名）',
                        properties: {}
                    }
                },
                required: ['model_id', 'prompt']
        };
        toolRegistry.register({
            name: 'comfyui_generate',
            shortDescription: '提交 ComfyUI 图像/视频生成任务（异步，需 comfyui_check_status 轮询）',
            description: _buildDescription(),
            // 外接分支走同一构建器（送达口径不同；见 _buildDescription 注释）
            buildDescription: _buildDescription,
            input_schema: _generateSchema,
            handler: async function (args, execCtx) {
                try {
                    // 1. 确保控制器已初始化
                    var ctrl = await _ensureController(config);
                    var engine = ctrl.getEngine();
                    var service = ctrl.getService();
                    var settings = await ctrl.getSettings();

                    // 1.5. 检查 ComfyUI 连通性（5秒超时，避免 WebSocket 长时间挂起）
                    var _connected = await _checkConnectivity(settings);
                    if (!_connected) {
                        var _addr = (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: 'ComfyUI 服务未连接（' + _addr + '）。请确认 ComfyUI 已启动且地址正确。' }]
                        };
                    }

                    // 2. 检查云端模型权限（内置云端模型 + 自动发现的伙伴模型——
                    //    不在 STATIC_MODEL_IDS 内的均为云端 API 节点，同受 allowCloudModels 门；
                    //    注意不能用 ALL_MODEL_IDS 判：伙伴发现后就地追加过，发现模型会逃过此门）
                    var modelId = args.model_id;
                    if (CLOUD_MODELS.indexOf(modelId) >= 0 || STATIC_MODEL_IDS.indexOf(modelId) < 0) {
                        var _ss = config.settingsStore;
                        var _agentSettings = {};
                        if (_ss && typeof _ss.getModuleSettings === 'function') {
                            try {
                                _agentSettings = await _ss.getModuleSettings('agent', {});
                            } catch (_) {}
                        }
                        if (!_agentSettings.allowCloudModels) {
                            return {
                                success: false,
                                isError: true,
                                content: [{ type: 'text', text: '用户未开启云端模型权限。请在 Agent 模块设置中勾选"允许云端模型"后重试。' }]
                            };
                        }
                    }

                    // 3. 只读取模板：不走 ctrl.selectTemplate——那会写 currentTemplate
                    // 并触发表单重渲染，静默改掉用户表单当前选中的模板；并发时还会覆盖
                    // _pendingTemplateId 打断用户自身的模板切换。getTemplateFor 返回与
                    // selectTemplate 同构的参数集（non-pipeline 同样合并 schema 参数），
                    // 且不触碰任何表单状态
                    var template = await ctrl.getTemplateFor(modelId);
                    if (!template) {
                        return { success: false, isError: true, content: [{ type: 'text', text: '未找到模型模板: ' + modelId }] };
                    }

                    var model = engine.getById(modelId);
                    if (!model) {
                        return { success: false, isError: true, content: [{ type: 'text', text: '模型未在注册表中找到: ' + modelId + '（可能 ComfyUI 模型列表加载失败）' }] };
                    }

                    // 4. 收集并上传图片
                    var images = await _collectImages(args, ctrl);
                    var mapped = await _uploadAndMapImages(images, model, template, service);

                    // 5. 构建参数
                    var values = {};
                    if (args.prompt) values.prompt = args.prompt;
                    if (args.negative_prompt) values.negative_prompt = args.negative_prompt;
                    if (args.seed !== undefined && args.seed !== null) values.seed = args.seed;
                    else values.seed = -1;

                    // 合并 extra_params（只接受模板中已知的 key，忽略未知 key 避免污染工作流）
                    if (args.extra_params && typeof args.extra_params === 'object') {
                        var _knownKeys = {};
                        if (template.parameters && template.parameters.length > 0) {
                            for (var _ki = 0; _ki < template.parameters.length; _ki++) {
                                if (template.parameters[_ki].key) _knownKeys[template.parameters[_ki].key] = 1;
                            }
                        }
                        // 也允许 prompt/negative_prompt/seed 等标准 key
                        _knownKeys.prompt = 1;
                        _knownKeys.negative_prompt = 1;
                        _knownKeys.seed = 1;
                        var epKeys = Object.keys(args.extra_params);
                        for (var ei = 0; ei < epKeys.length; ei++) {
                            if (_knownKeys[epKeys[ei]]) {
                                values[epKeys[ei]] = args.extra_params[epKeys[ei]];
                            } else {
                                console.warn('[ComfyuiBootstrap] 忽略未知参数 key: ' + epKeys[ei] + '（模型 ' + modelId + ' 不支持此参数）');
                            }
                        }
                    }

                    // 合并 pipeline 模型的图片文件名到 values（non-pipeline 的图片文件名走 imageFilenames 参数）
                    var mvKeys = Object.keys(mapped.values);
                    for (var mi = 0; mi < mvKeys.length; mi++) {
                        values[mvKeys[mi]] = mapped.values[mvKeys[mi]];
                    }

                    // 5.5. 填充模板参数默认值（如 model/checkpoint、width、height、steps、cfg 等）
                    if (template.parameters && template.parameters.length > 0) {
                        for (var pi = 0; pi < template.parameters.length; pi++) {
                            var param = template.parameters[pi];
                            if (param.key && values[param.key] === undefined && param.default !== undefined) {
                                values[param.key] = param.default;
                            }
                        }
                    }

                    // 强制 batch_size = 1（工具不支持批量循环，必须在默认值填充之后覆盖）
                    values.batch_size = 1;

                    // 6. 构建工作流
                    // pipeline: values 含图片文件名（{{key}} 占位符替换），imageFilenames 不使用
                    // non-pipeline: imageFilenames 含图片文件名（buildSchemaDrivenWorkflow 建 LoadImage 节点）
                    var wfOpts = model && model.pipeline ? { useTemplateWorkflow: true } : {};
                    var workflow = engine.renderWorkflow(
                        modelId, values, mapped.imageFilenames, {}, wfOpts
                    );

                    // 7. 清理孤儿 LoadImage/LoadVideo 节点
                    _cleanupOrphanLoaders(workflow);

                    // 8. 提交工作流
                    var result = await service.submitPrompt(workflow, settings.apiKey);
                    if (result && result.error) {
                        var errText = 'ComfyUI 提交失败';
                        var _ne = result.error.node_errors || {};
                        var _neKeys = Object.keys(_ne);
                        if (_neKeys.length > 0) {
                            for (var ne = 0; ne < _neKeys.length; ne++) {
                                var ne2 = _ne[_neKeys[ne]];
                                if (ne2 && ne2.errors) {
                                    errText += '\n节点 ' + _neKeys[ne] + ': ' + JSON.stringify(ne2.errors);
                                }
                            }
                        } else if (result.error.error) {
                            errText += ': ' + (result.error.error.message || result.error.error);
                        } else if (result.error.message) {
                            errText += ': ' + result.error.message;
                        }
                        return { success: false, isError: true, content: [{ type: 'text', text: errText }] };
                    }

                    var promptId = typeof result === 'string' ? result : (result && result.prompt_id);
                    if (!promptId) {
                        return { success: false, isError: true, content: [{ type: 'text', text: 'ComfyUI 未返回 prompt_id' }] };
                    }

                    // 8.5 登记 promptId 来源为 llm：本路径直调 service.submitPrompt、
                    // 不经 controller.generate/generateRaw，不登记的话完成/错误事件会被
                    // controller 的未知来源跳过逻辑忽略（否则会被误判为 form：递减表单
                    // 批量计数、重复下载产物串显进表单结果区）
                    ctrl.registerPromptSource(promptId, 'llm');

                    // 9. 立即返回 prompt_id，后台自动轮询并在完成后注入结果到对话
                    var outputType = (model && model.category === 'video') ? 'video' : 'image';
                    _registerPromptMeta(promptId, { outputType: outputType, label: modelId });
                    var _sessionId = (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.getSessionId === 'function')
                        ? global.AEEngine.bridge.getSessionId() : null;
                    _backgroundPoll(service, promptId, modelId, outputType, _sessionId, _isExternalCaller(execCtx), _laneIdOfCtx(execCtx));
                    var responseText = JSON.stringify({
                        success: true,
                        status: 'generating',
                        prompt_id: promptId,
                        model_id: modelId,
                        output_type: outputType,
                        message: _isExternalCaller(execCtx)
                            ? '已提交生成任务，后台轮询中。完成结果不会主动送达，用 comfyui_check_status 查询。'
                            : '已提交生成任务，后台自动轮询中。生成完成后结果会自动发送到对话，无需手动查询。'
                    });

                    return {
                        success: true,
                        content: [{ type: 'text', text: responseText }]
                    };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_generate error:', e);
                    var _errText = '生成失败: ' + (e.message || String(e));
                    // 与 controller.js 一致：Unauthorized 错误追加 API Key 提示
                    if (/unauthorized|login first/i.test(_errText)) {
                        _errText += '\n\n请在 ComfyUI 模块设置中填入 Comfy API Key，或确认 ComfyUI 桌面端已登录。';
                    }
                    return {
                        success: false,
                        isError: true,
                        content: [{ type: 'text', text: _errText }]
                    };
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_generate tool registered');

        // 动态 enum：controller 伙伴节点自动发现后（refreshModelList 无条件触发）刷新
        // model_id.enum 与描述——新模型（如 MiniMax H3）无需发版即可被 LLM 调用。
        // 就地追加 ALL_MODEL_IDS：三个工具的 enum 共享同一数组引用，一次追加全同步
        global.AEComfyUI._onModelRegistryChanged = function (models) {
            try {
                if (!_generateSchema) return;
                var added = [];
                var lines = [];
                for (var i = 0; i < (models || []).length; i++) {
                    var m = models[i];
                    if (!m || !m.id || ALL_MODEL_IDS.indexOf(m.id) >= 0) continue;
                    added.push(m.id);
                    lines.push('  - ' + m.id + ': ' + (m.name || m.id)
                        + (m.category === 'video' ? '（视频生成，消耗积分）' : '（图像生成，消耗积分）')
                        + (m.needsImage ? '（需要输入图片）' : ''));
                }
                if (!added.length) return;  // 无新模型：enum 已是最新，无需 updateTool
                for (var a = 0; a < added.length; a++) ALL_MODEL_IDS.push(added[a]);
                _autoModelLines = _autoModelLines.concat(lines);
                toolRegistry.updateTool('comfyui_generate', {
                    description: _buildDescription()
                });
                console.log('[ComfyuiBootstrap] 模型 enum 已刷新: +' + added.length + ' 自动发现模型');
            } catch (e) {
                console.warn('[ComfyuiBootstrap] 模型 enum 刷新失败:', e && e.message);
            }
        };

        // --- comfyui_check_status: 等待并获取 ComfyUI 生成结果 ---
        toolRegistry.register({
            name: 'comfyui_check_status',
            shortDescription: '按 prompt_id 查询 ComfyUI 生成结果（立即返回，不等待）',
            description: '查询 ComfyUI 生成结果，立即返回，不等待。comfyui_generate / comfyui_run_official_template / comfyui_run_workflow 提交任务后都会返回 prompt_id，使用此工具传入 prompt_id 查询当前状态：若已完成返回 status=done 及输出文件路径；若仍在生成返回 status=generating，请稍候再次调用此工具查询。model_id 可省略（省略时按任务登记信息与产物扩展名自动判定输出类型）。',
            input_schema: {
                type: 'object',
                properties: {
                    prompt_id: {
                        type: 'string',
                        description: '提交工具返回的 prompt_id'
                    },
                    model_id: {
                        type: 'string',
                        description: '可选：生成任务使用的模型ID（用于判断输出类型；任意工作流任务可不传）'
                    }
                },
                required: ['prompt_id']
            },
            handler: async function (args) {
                try {
                    var ctrl = await _ensureController(config);
                    var service = ctrl.getService();
                    var settings = await ctrl.getSettings();

                    // 检查连通性
                    var _connected = await _checkConnectivity(settings);
                    if (!_connected) {
                        var _addr = (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: 'ComfyUI 服务未连接（' + _addr + '）。请确认 ComfyUI 已启动且地址正确。' }]
                        };
                    }

                    var promptId = args.prompt_id;
                    var modelId = args.model_id || '';
                    var meta = _getPromptMeta(promptId);

                    // 输出类型判定优先级：任务登记（提交时按工作流输出节点推断）→
                    // 注册表模型类别 → 图片兜底。落盘后再按产物扩展名校正（见下）。
                    var outputType = (meta && meta.outputType) ? meta.outputType : null;
                    if (!outputType && modelId) {
                        var engine = ctrl.getEngine();
                        var model = engine.getById(modelId);
                        outputType = (model && model.category === 'video') ? 'video' : 'image';
                    }
                    if (!outputType) outputType = 'image';

                    // 单次状态查询，立即返回，不阻塞等待
                    var once = await _queryStatusOnce(service, promptId);

                    // 仍在生成中：返回 generating，让 LLM 稍后再次调用
                    if (once.status === 'generating') {
                        return {
                            success: true,
                            content: [{ type: 'text', text: JSON.stringify({
                                success: true,
                                status: 'generating',
                                prompt_id: promptId,
                                model_id: modelId,
                                message: '任务仍在生成中，请稍后再次调用 comfyui_check_status 查询。'
                            }) }]
                        };
                    }

                    // 执行失败
                    if (once.status === 'error') {
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: once.error || '生成失败' }]
                        };
                    }

                    // 生成完成：下载并保存结果（经 _savePromptOutputs 按
                    // promptId 去重——_backgroundPoll 已落盘时直接复用，不再双份下载）
                    var outputs = once.outputs;
                    var savedPaths = await _savePromptOutputs(outputs, service, promptId);

                    // 产物扩展名是输出类型的权威判据（自定义工作流可能用任何保存节点）
                    var detected = _detectSavedOutputType(savedPaths);
                    if (detected) outputType = detected;

                    var _done = {
                        success: true,
                        status: 'done',
                        model_id: modelId || (meta && meta.label) || null,
                        outputs: savedPaths,
                        output_type: outputType,
                        count: savedPaths.length,
                        message: savedPaths.length
                            ? ('生成完成，共 ' + savedPaths.length + ' 个' + _outputTypeLabel(outputType) + '文件')
                            : '生成完成，但未产生可回收的文件（工作流可能只有预览节点）'
                    };
                    if (!modelId && meta && meta.label) _done.task = meta.label;
                    var responseText = JSON.stringify(_done);

                    return {
                        success: true,
                        content: [{ type: 'text', text: responseText }]
                    };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_check_status error:', e);
                    var _errText = '查询失败: ' + (e.message || String(e));
                    if (/unauthorized|login first/i.test(_errText)) {
                        _errText += '\n\n请在 ComfyUI 模块设置中填入 Comfy API Key，或确认 ComfyUI 桌面端已登录。';
                    }
                    return {
                        success: false,
                        isError: true,
                        content: [{ type: 'text', text: _errText }]
                    };
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_check_status tool registered');

        // --- comfyui_list_params: 查询指定模型的可用参数列表 ---
        toolRegistry.register({
            name: 'comfyui_list_params',
            shortDescription: '查询 ComfyUI 模型可用参数（调用 generate 前用）',
            description: '查询指定 ComfyUI 模型的可用参数列表（参数名、类型、默认值、可选值）。在调用 comfyui_generate 前使用此工具了解可填参数。无需 ComfyUI 连接。',
            input_schema: {
                type: 'object',
                properties: {
                    model_id: {
                        type: 'string',
                        description: '模型ID',
                        enum: ALL_MODEL_IDS
                    }
                },
                required: ['model_id']
            },
            handler: async function (args) {
                try {
                    var ctrl = await _ensureController(config);
                    var engine = ctrl.getEngine();
                    var modelId = args.model_id;
                    var model = engine.getById(modelId);
                    if (!model) {
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: '未知模型: ' + modelId }]
                        };
                    }

                    // 获取参数列表（含 schema 派生 + 模板合并）
                    var params = await engine.getModelParams(modelId);

                    // 过滤掉图片/视频类型参数（这些通过 image_source 控制），只返回可填参数
                    var result = [];
                    if (params && params.length > 0) {
                        for (var pi = 0; pi < params.length; pi++) {
                            var p = params[pi];
                            if (p.type === 'image' || p.type === 'video') continue;
                            var item = {
                                key: p.key,
                                label: p.label || p.key,
                                type: p.type,
                                default: p.default,
                                required: !!p.required
                            };
                            if (p.type === 'select' && p.choices) {
                                item.choices = p.choices;
                            }
                            if (p.min !== undefined) item.min = p.min;
                            if (p.max !== undefined) item.max = p.max;
                            if (p.step !== undefined) item.step = p.step;
                            result.push(item);
                        }
                    }

                    return {
                        success: true,
                        content: [{ type: 'text', text: JSON.stringify({
                            success: true,
                            model_id: modelId,
                            model_name: model.name,
                            category: model.category,
                            needs_image: !!model.needsImage,
                            optional_image: !!model.optionalImage,
                            params: result,
                            hint: '在 comfyui_generate 的 extra_params 中使用这些 key 传参。select 类型的参数只能从 choices 中选值。'
                        }) }]
                    };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_list_params error:', e);
                    return {
                        success: false,
                        isError: true,
                        content: [{ type: 'text', text: '查询参数失败: ' + (e.message || String(e)) }]
                    };
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_list_params tool registered');

        // --- comfyui_list_checkpoints: 查询本地可用 checkpoint 模型列表 ---
        toolRegistry.register({
            name: 'comfyui_list_checkpoints',
            shortDescription: '分页查询 ComfyUI 本地模型清单（kind/modality/supported 过滤）',
            description: [
                '查询 ComfyUI 本地模型清单并分页返回：models/checkpoints 的 checkpoint（CheckpointLoaderSimple），',
                '以及 models/unet、models/diffusion_models 的扩散模型（ComfyUI 合并进 UNETLoader 的 unet_name 下拉）。',
                '',
                '参数：offset（默认 0，上一次返回的 nextOffset 直接传入）、limit（默认 50，最大 100）、',
                'kind=checkpoint|diffusion_model、modality=image|video、supported_only=true（只留可直接出图的模型）。',
                '',
                '返回：total（匹配数）、offset/limit/returned/hasMore/nextOffset、models（每项 name/kind/modality/family/supported）、',
                'counts（全库各分组数量）、supported_diffusion_families。顺序固定：checkpoint 在前、扩散模型在后，组内按 name 排序。',
                '单页序列化超 20K 预算时自动减小实际 limit，以返回的 limit/returned 为准；offset 越界返回空 models + hasMore=false + nextOffset=null。',
                '',
                '本地文生图/图生图选型用 supported_only=true + modality=image：返回的 name 即 comfyui_generate 的 extra_params.model 取值',
                '（当前适配 ANIMA / Qwen-Image / Krea 2 等图像族）。视频扩散模型（MiniMax H3、WAN、LTX 等）与未适配族 supported=false，',
                '不能用于本地图片生成；视频需求用云端模型或官方模板。'
            ].join('\n'),
            input_schema: {
                type: 'object',
                properties: {
                    offset: {
                        type: 'number',
                        description: '分页起点（0 起），默认 0；上一次返回的 nextOffset 可直接传入'
                    },
                    limit: {
                        type: 'number',
                        description: '每页条数，默认 50，最大 100；单页超序列化预算时自动减小，以返回的 limit 为准'
                    },
                    kind: {
                        type: 'string',
                        description: '按模型类型过滤：checkpoint（models/checkpoints）或 diffusion_model（models/unet、models/diffusion_models）'
                    },
                    modality: {
                        type: 'string',
                        description: '按模态过滤：image 或 video（video 为视频扩散模型，本地图片生成不可用）'
                    },
                    supported_only: {
                        type: 'boolean',
                        description: '为 true 时只返回 supported=true 的模型（可直接用于 comfyui_generate 的本地图片生成）'
                    }
                },
                required: []
            },
            handler: async function (args) {
                args = args || {};
                try {
                    var ctrl = await _ensureController(config);
                    var settings = await ctrl.getSettings();

                    // 检查连通性
                    var _connected = await _checkConnectivity(settings);
                    if (!_connected) {
                        var _addr = (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
                        return {
                            success: false,
                            isError: true,
                            content: [{ type: 'text', text: 'ComfyUI 服务未连接（' + _addr + '）。请确认 ComfyUI 已启动且地址正确。' }]
                        };
                    }

                    // 查询本地模型：checkpoint（CheckpointLoaderSimple）+ 裸扩散模型（UNETLoader）。
                    // ComfyUI 把 models/unet 与 models/diffusion_models 合并进 unet_name 下拉。
                    var service = ctrl.getService();
                    var objectInfo = await service.getObjectInfo();
                    function _choicesOf(info, classType, inputKey) {
                        var def = info && info[classType];
                        var required = def && def.input && def.input.required;
                        var spec = required && required[inputKey];
                        if (Array.isArray(spec) && Array.isArray(spec[0])) return spec[0];
                        return [];
                    }
                    var checkpoints = _choicesOf(objectInfo, 'CheckpointLoaderSimple', 'ckpt_name');
                    var unetTools = global.AEComfyUI && global.AEComfyUI.unetModels;
                    var diffusionModels = unetTools
                        ? unetTools.listUnetNames(objectInfo)
                        : _choicesOf(objectInfo, 'UNETLoader', 'unet_name');
                    var supportedFamilies = unetTools ? unetTools.familyNames() : [];
                    function _classify(name, kind) {
                        var raw = (unetTools && typeof unetTools.classifyModel === 'function')
                            ? unetTools.classifyModel(name, kind)
                            // 兜底（unetModels 未加载）：checkpoint 按可用处理，扩散模型一律未适配
                            : {
                                name: name,
                                kind: kind,
                                modality: kind === 'checkpoint' ? 'image' : null,
                                family: null,
                                supported: kind === 'checkpoint'
                            };
                        // 只下发分页契约声明的五个字段（label 等展示用字段不进模型可见文本）
                        return {
                            name: raw.name,
                            kind: raw.kind,
                            modality: raw.modality,
                            family: raw.family,
                            supported: raw.supported === true
                        };
                    }
                    // 顺序固定：checkpoint 组在前、扩散模型组在后，组内按 name 排序
                    // （翻页只看 offset，顺序稳定才能保证不重不漏）
                    var allModels = [];
                    checkpoints.slice().sort().forEach(function (name) {
                        allModels.push(_classify(name, 'checkpoint'));
                    });
                    diffusionModels.slice().sort().forEach(function (name) {
                        allModels.push(_classify(name, 'diffusion_model'));
                    });
                    var counts = {
                        total: allModels.length,
                        checkpoints: checkpoints.length,
                        diffusion_models: diffusionModels.length,
                        image_models: 0,
                        video_models: 0,
                        unsupported_models: 0
                    };
                    allModels.forEach(function (m) {
                        if (m.supported && m.modality === 'image') counts.image_models++;
                        if (m.modality === 'video') counts.video_models++;
                        if (!m.supported && m.modality !== 'video') counts.unsupported_models++;
                    });

                    // 过滤参数：非字符串 / 非法取值不静默——归一后不匹配的取值忽略并在 message 说明
                    var notes = [];
                    function _enumFilter(field, raw, allowed) {
                        if (raw === undefined || raw === null || raw === '') return '';
                        if (typeof raw !== 'string') {
                            notes.push(field + ' 需要字符串（可选 ' + allowed.join(' / ') + '），已忽略非字符串值');
                            return '';
                        }
                        var v = raw.trim().toLowerCase();
                        if (!v) return '';
                        if (allowed.indexOf(v) >= 0) return v;
                        notes.push(field + '=' + JSON.stringify(raw) + ' 不是有效值（可选 ' + allowed.join(' / ') + '），已忽略');
                        return '';
                    }
                    var kind = _enumFilter('kind', args.kind, ['checkpoint', 'diffusion_model']);
                    var modality = _enumFilter('modality', args.modality, ['image', 'video']);
                    // supported_only 归一：布尔值 / "true"、"false" 字符串；其它类型说明后忽略
                    var supportedOnly = false;
                    var soRaw = args.supported_only;
                    if (soRaw !== undefined && soRaw !== null && soRaw !== '') {
                        if (typeof soRaw === 'boolean') supportedOnly = soRaw;
                        else if (typeof soRaw === 'string' && /^(true|false)$/i.test(soRaw.trim())) {
                            supportedOnly = soRaw.trim().toLowerCase() === 'true';
                        } else {
                            notes.push('supported_only 需要布尔值（true / false），已忽略'
                                + (typeof soRaw === 'string' ? ' ' + JSON.stringify(soRaw) : '非布尔值'));
                        }
                    }
                    var offset = _intArg(args.offset, 0, 0);
                    var limit = _intArg(args.limit, 50, 1, 100);
                    var matched = allModels.filter(function (m) {
                        if (kind && m.kind !== kind) return false;
                        if (modality && m.modality !== modality) return false;
                        if (supportedOnly && !m.supported) return false;
                        return true;
                    });
                    var total = matched.length;
                    var pageStart = Math.min(offset, total);
                    var candidate = matched.slice(pageStart, pageStart + limit);

                    function _buildMessageFor(page) {
                        var end = pageStart + page.length;
                        if (total === 0) {
                            var head0 = notes.length ? notes.join('；') + '。' : '';
                            if (counts.total === 0) {
                                return head0 + 'ComfyUI 未检测到本地模型。请把 checkpoint 放到 models/checkpoints，'
                                    + '或把扩散模型放到 models/unet / models/diffusion_models。';
                            }
                            return head0 + '当前过滤条件下没有模型（全库 ' + counts.total + ' 个）；'
                                + '去掉过滤条件或调整 kind/modality/supported_only 取值后重试。';
                        }
                        if (pageStart >= total) {
                            var outOfRange = 'offset ' + offset + ' 超出范围：匹配 ' + total + ' 个（有效 offset 0–'
                                + (total - 1) + '），本页为空；用 offset=0 重新查询或改用更小的 offset。';
                            return notes.length ? notes.join('；') + '。' + outOfRange : outOfRange;
                        }
                        var parts = [];
                        if (notes.length) parts.push(notes.join('；'));
                        var head = '匹配 ' + total + ' 个模型';
                        if (total !== counts.total) head += '（全库 ' + counts.total + ' 个）';
                        head += '，本页返回第 ' + (pageStart + 1) + '–' + end + ' 个';
                        parts.push(head);
                        parts.push(end < total ? '还有 ' + (total - end) + ' 个，用 offset=' + end + ' 继续' : '已到末页');
                        parts.push('全库分组：checkpoint ' + counts.checkpoints + ' / 扩散模型 ' + counts.diffusion_models
                            + '；图像可用 ' + counts.image_models + ' / 视频 ' + counts.video_models
                            + ' / 未适配 ' + counts.unsupported_models);
                        if (page.length && page.length < candidate.length) {
                            parts.push('单页序列化超 20K 预算，本页实际返回 ' + page.length + ' 条');
                        }
                        parts.push('本地文生图选型用 supported_only=true + modality=image，extra_params.model 取返回的 name');
                        return parts.join('。') + '。';
                    }

                    function _buildResult(page) {
                        var end = pageStart + page.length;
                        var hasMore = end < total;
                        return {
                            success: true,
                            total: total,
                            offset: offset,
                            // limit = 实际生效的页容量上限（超预算时小于请求值，以本字段为准）
                            limit: page.length < candidate.length ? page.length : limit,
                            returned: page.length,
                            hasMore: hasMore,
                            nextOffset: hasMore ? end : null,
                            models: page,
                            counts: counts,
                            supported_diffusion_families: supportedFamilies,
                            message: _buildMessageFor(page)
                        };
                    }

                    var page = _fitPageToBudget(candidate, _buildResult);
                    return {
                        success: true,
                        content: [{ type: 'text', text: JSON.stringify(_buildResult(page)) }]
                    };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_list_checkpoints error:', e);
                    return {
                        success: false,
                        isError: true,
                        content: [{ type: 'text', text: '查询模型列表失败: ' + (e.message || String(e)) }]
                    };
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_list_checkpoints tool registered');

        // --- comfyui_search_official_templates: 搜索官方模板库 ---
        toolRegistry.register({
            name: 'comfyui_search_official_templates',
            shortDescription: '搜索 ComfyUI 官方模板库（600+ 套，含本地模型与云端 API 模板）',
            description: [
                '搜索 ComfyUI 官方模板库（github.com/Comfy-Org/workflow_templates，600+ 套，持续更新），',
                '覆盖文生图/图生图/图片编辑/文生视频/图生视频/起止帧/放大/音频/3D 等场景。',
                '返回模板的 name（执行时作为 comfyui_run_official_template 的 name 参数）、标题、描述、标签，',
                '并标注「需要输入图片」与「云端/API 模板（消耗额度）」。',
                '',
                '本工具不需要 ComfyUI 已连接（数据经本地 Bridge 从 GitHub/jsdelivr 拉取，30 分钟缓存）。',
                '当内置的 13 套模板（comfyui_generate）无法覆盖需求时（如 Flux 本地出图、ControlNet、',
                '图片放大、特定风格模板等），先搜索官方库再执行。',
                '',
                '参数：query 搜索关键词（匹配名称/标题/描述/标签，多词为 AND 关系，如 "flux text to image"）；',
                'category 可选分类过滤（匹配标签，如 Image/Video/API/Upscale）；limit 默认 10 最大 20；offset 翻页。'
            ].join('\n'),
            input_schema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: '搜索关键词（匹配模板名称/标题/描述/标签）。可中英文混用，如 "图生视频"、"flux"、"upscale"'
                    },
                    category: {
                        type: 'string',
                        description: '可选分类过滤（匹配标签，如 Image、Video、API、Upscale、3D）'
                    },
                    limit: {
                        type: 'number',
                        description: '返回条数（默认 10，最大 20）'
                    },
                    offset: {
                        type: 'number',
                        description: '翻页偏移（默认 0）'
                    }
                },
                required: ['query']
            },
            handler: async function (args) {
                try {
                    var query = String((args && args.query) || '').trim();
                    var category = String((args && args.category) || '').trim();
                    var limit = Math.min(20, Math.max(1, Number((args && args.limit)) || 10));
                    var offset = Math.max(0, Number((args && args.offset)) || 0);
                    var data = await _bridgeComfyTemplates('search', {
                        query: query, category: category, limit: limit, offset: offset
                    });
                    if (data && data.ok) {
                        var text = String(data.text || '');
                        if (data.note) text += '\n[提示: ' + data.note + ']';
                        return { success: true, isError: false, content: [{ type: 'text', text: text }] };
                    }
                    throw new Error((data && data.error) || '官方模板目录返回异常');
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_search_official_templates error:', e);
                    return {
                        success: false,
                        isError: true,
                        content: [{ type: 'text', text: '搜索官方模板失败: ' + (e.message || String(e)) }]
                    };
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_search_official_templates tool registered');

        // --- comfyui_run_official_template: 执行官方模板 ---
        // 描述正文与 comfyui_generate 同款按读者面分叉（唯一差异是送达口径；理由见
        // _buildDescription 注释）。
        function _buildTemplateDescription(reader) {
            var lines = [
                '执行 ComfyUI 官方模板库的模板：自动拉取模板 → 转换为 ComfyUI API 格式 → 将 prompt 注入',
                '提示词节点 → 提交执行。工具内部完成全部转换，无需关心工作流 JSON。',
                '',
                '前置：name 必须来自 comfyui_search_official_templates 的搜索结果（不能凭空编造）。',
                '云端/API 模板（搜索结果标注「消耗额度」）需用户开启「允许云端模型」，且消耗 ComfyUI 账户积分。',
                '',
                '图片输入（图生图/图生视频/参考图模板用）：',
                '  - image_source="current_frame": 截取 AE 当前合成当前帧作为输入图片',
                '  - image_source="file_path": 使用指定文件路径的图片（通过 image_paths 传入路径数组；聊天历史 [附件图片路径] 下的绝对路径可直接复制进来）',
                '多图模板（多个图片输入节点）时按顺序逐个注入；图片数超过输入位时多余的忽略。',
                '',
                '模板参数覆盖：overrides={"节点ID.输入名": 值} 精确改，或 {"输入名": 值} 命中所有同名输入（如 {"length":39,"width":864}）。',
                '视频模板常带 turbo/加速开关（如 MiniMax H3 系列模板的 "switch"）：overrides {"switch":true,"steps":4} 切到 LoRA 少步加速档；不传则走模板默认质量档（步数多、无 LoRA）。',
                '',
                '⚠️ 异步模式: 提交后立即返回 prompt_id（status=generating），不等待完成。'
            ];
            if (_isExternalReader(reader)) {
                lines.push('完成结果不会主动送达，须自行调用 comfyui_check_status 反复查询；done 时 outputs 含输出路径。');
            } else {
                lines.push('生成完成后结果自动发送到对话（含输出文件路径）。主动查询进度用 comfyui_check_status。');
            }
            lines.push('⚠️ 模板依赖的节点/模型需已安装：转换失败时错误消息会指明缺失的节点名。');
            return lines.join('\n');
        }
        toolRegistry.register({
            name: 'comfyui_run_official_template',
            shortDescription: '执行 ComfyUI 官方模板库的模板（异步，结果自动回传对话）',
            description: _buildTemplateDescription(),
            buildDescription: _buildTemplateDescription,
            input_schema: {
                type: 'object',
                properties: {
                    name: {
                        type: 'string',
                        description: '模板名（comfyui_search_official_templates 返回的 name，如 flux_schnell）'
                    },
                    prompt: {
                        type: 'string',
                        description: '正向提示词（注入模板的提示词槽位，覆盖模板默认值）'
                    },
                    image_source: {
                        type: 'string',
                        description: '图片来源。current_frame=AE当前帧, file_path=指定文件（聊天历史 [附件图片路径] 下的绝对路径可直接用）, none=无图片',
                        enum: ['current_frame', 'file_path', 'none']
                    },
                    image_paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '当 image_source=file_path 时的图片文件路径数组'
                    },
                    overrides: {
                        type: 'object',
                        description: '精确改参数：{"节点ID.输入名": 值}（如 {"8.length":124}），或裸输入名 {"length":124} 命中所有含该输入的节点。用于改 seed/width/height/length/fps 等模板参数。'
                    }
                },
                required: ['name', 'prompt']
            },
            handler: async function (args, execCtx) {
                function fail(text) {
                    return { success: false, isError: true, content: [{ type: 'text', text: text }] };
                }
                try {
                    var name = String(args.name || '').trim();
                    var promptText = String(args.prompt || '').trim();
                    if (!name) return fail('缺少模板 name（先用 comfyui_search_official_templates 搜索获取）');
                    if (!promptText) return fail('缺少 prompt（正向提示词）');

                    // 1. 经 bridge 拉取模板（name 白名单在 bridge 侧校验，天然防伪造）
                    var tplResp = null;
                    try {
                        tplResp = await _bridgeComfyTemplates('fetch', { name: name });
                    } catch (e) {
                        return fail('模板获取失败: ' + (e.message || String(e))
                            + '。name 必须来自 comfyui_search_official_templates 的搜索结果。');
                    }
                    if (!tplResp || !tplResp.ok) {
                        return fail('模板获取失败: ' + ((tplResp && tplResp.error) || '未知错误')
                            + '。name 必须来自 comfyui_search_official_templates 的搜索结果。');
                    }
                    var meta = tplResp.meta || {};

                    // 2. 云端/API 模板权限门（对齐 comfyui_generate 的 allowCloudModels 语义：
                    //    官方索引 openSource=false ≈ 使用伙伴 API 节点，消耗账户积分）
                    if (meta.openSource === false) {
                        var _ss = config.settingsStore;
                        var _agentSettings = {};
                        if (_ss && typeof _ss.getModuleSettings === 'function') {
                            try { _agentSettings = await _ss.getModuleSettings('agent', {}); } catch (_) {}
                        }
                        if (!_agentSettings.allowCloudModels) {
                            return fail('该官方模板为云端/API 模板（消耗积分），用户未开启云端模型权限。请在 Agent 模块设置中勾选「允许云端模型」后重试，或换用搜索结果中未标注「消耗额度」的开源模板。');
                        }
                    }

                    // 3. controller + 连通性（与 comfyui_generate 一致）
                    var ctrl = await _ensureController(config);
                    var service = ctrl.getService();
                    var settings = await ctrl.getSettings();
                    var _connected = await _checkConnectivity(settings);
                    if (!_connected) {
                        var _addr = (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
                        return fail('ComfyUI 服务未连接（' + _addr + '）。请确认 ComfyUI 已启动且地址正确。');
                    }

                    // 4. UI→API 转换（/object_info 全量目录，service 内部有缓存）
                    var conv = (global.AEComfyUI && global.AEComfyUI.uiToApi) ? global.AEComfyUI.uiToApi : null;
                    if (!conv) return fail('UI→API 转换器未加载（uiToApi.js）');
                    var catalog = await service.getObjectInfo();
                    var converted = conv.convert(tplResp.template, catalog);
                    if (!converted.ok) {
                        return fail('模板转换失败 [' + converted.error.code + ']: ' + converted.error.message);
                    }
                    var promptData = converted.data;
                    var convSkipped = converted.skipped || [];

                    // 5. 注入提示词（优先伙伴 API 节点 prompt 键，其次 TextEncode.text）
                    var slot = conv.findPromptSlot(promptData);
                    if (!slot) {
                        return fail('模板中找不到可注入提示词的槽位（该模板可能不是提示词驱动），请换用其他模板。');
                    }
                    var originalPrompt = promptData[slot.nodeId].inputs[slot.key];
                    promptData[slot.nodeId].inputs[slot.key] = promptText;

                    // 6. 图片注入（多图按 LoadImage 节点顺序逐个注入）
                    var notes = [];
                    var images = [];
                    try {
                        images = await _collectImages(args, ctrl);
                    } catch (e) {
                        return fail('图片收集失败: ' + (e.message || String(e)));
                    }
                    if (images.length > 0) {
                        var imgSlots = conv.findImageSlots(promptData);
                        if (!imgSlots.length) {
                            notes.push('模板无图片输入节点，已忽略提供的图片');
                        } else {
                            for (var ii = 0; ii < images.length && ii < imgSlots.length; ii++) {
                                var up = await service.uploadImage(images[ii].blob, images[ii].name);
                                promptData[imgSlots[ii].nodeId].inputs[imgSlots[ii].key] = up.name || images[ii].name;
                            }
                            if (images.length > imgSlots.length) {
                                notes.push('图片数（' + images.length + '）超过模板输入位（' + imgSlots.length + '），多余的已忽略');
                            }
                        }
                    } else if (meta.needsImage) {
                        notes.push('该模板需要输入图片，可用 image_source=current_frame/file_path 提供');
                    }

                    // 6.5 参数覆盖（模板节点 ID 对 LLM 不可见：裸输入名命中所有同名输入）
                    var ovr = _applyOverrides(promptData, args.overrides);
                    if (ovr.skipped.length) {
                        notes.push('未生效的 overrides: ' + ovr.skipped.map(function (s) { return s.key + '(' + s.reason + ')'; }).join('、'));
                    }
                    if (ovr.linkReplaced.length) {
                        notes.push('overrides 覆盖了 ' + ovr.linkReplaced.length + ' 个链接输入（原连线已断开、改用字面值）: '
                            + ovr.linkReplaced.map(function (r) { return r.key; }).join('、'));
                    }
                    // 转换器跳过项如实告知（缺目录界面控制节点 / V3 未命名尾部值被丢弃）
                    var _tplUiSkipped = 0;
                    var _tplDropped = 0;
                    for (var _tsi = 0; _tsi < convSkipped.length; _tsi++) {
                        if (convSkipped[_tsi] && convSkipped[_tsi].dropped) _tplDropped++;
                        else _tplUiSkipped++;
                    }
                    if (_tplUiSkipped) notes.push('模板含 ' + _tplUiSkipped + ' 个未安装的界面控制节点，已跳过');
                    if (_tplDropped) notes.push(_tplDropped + ' 个节点的隐藏输入值已按默认值处理');

                    // 7. 提交（错误提取与 comfyui_generate 一致）
                    var result = await service.submitPrompt(promptData, settings.apiKey);
                    if (result && result.error) {
                        var errText = 'ComfyUI 提交失败';
                        var _ne = result.error.node_errors || {};
                        var _neKeys = Object.keys(_ne);
                        if (_neKeys.length > 0) {
                            for (var ne = 0; ne < _neKeys.length; ne++) {
                                var ne2 = _ne[_neKeys[ne]];
                                if (ne2 && ne2.errors) {
                                    errText += '\n节点 ' + _neKeys[ne] + ': ' + JSON.stringify(ne2.errors);
                                }
                            }
                        } else if (result.error.error) {
                            errText += ': ' + (result.error.error.message || result.error.error);
                        } else if (result.error.message) {
                            errText += ': ' + result.error.message;
                        }
                        return fail(errText);
                    }
                    var promptId = typeof result === 'string' ? result : (result && result.prompt_id);
                    if (!promptId) return fail('ComfyUI 未返回 prompt_id');

                    // 8. 登记来源为 llm + 后台轮询（复用 comfyui_generate 的异步结果注入链）
                    ctrl.registerPromptSource(promptId, 'llm');
                    var outputType = _detectOutputType(promptData);
                    _registerPromptMeta(promptId, { outputType: outputType, label: 'template:' + name });
                    var _sessionId = (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.getSessionId === 'function')
                        ? global.AEEngine.bridge.getSessionId() : null;
                    _backgroundPoll(service, promptId, name, outputType, _sessionId, _isExternalCaller(execCtx), _laneIdOfCtx(execCtx));

                    var originalSnippet = String(originalPrompt || '');
                    if (originalSnippet.length > 200) originalSnippet = originalSnippet.slice(0, 200) + '…';
                    var responseText = JSON.stringify({
                        success: true,
                        status: 'generating',
                        prompt_id: promptId,
                        template: name,
                        template_title: meta.title || name,
                        prompt_injected: {
                            node: promptData[slot.nodeId].class_type,
                            key: slot.key,
                            replaced_default: originalSnippet
                        },
                        overrides_applied: ovr.applied,
                        overrides_link_replaced: ovr.linkReplaced,
                        output_type: outputType,
                        notes: notes,
                        message: _isExternalCaller(execCtx)
                            ? '已提交官方模板任务，后台轮询中。完成结果不会主动送达，用 comfyui_check_status 查询。'
                            : '已提交官方模板任务，后台自动轮询中。生成完成后结果会自动发送到对话，无需手动查询。'
                    });
                    return { success: true, content: [{ type: 'text', text: responseText }] };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_run_official_template error:', e);
                    var _errText = '执行官方模板失败: ' + (e.message || String(e));
                    if (/unauthorized|login first/i.test(_errText)) {
                        _errText += '\n\n请在 ComfyUI 模块设置中填入 Comfy API Key，或确认 ComfyUI 桌面端已登录。';
                    }
                    return fail(_errText);
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_run_official_template tool registered');

        // --- comfyui_run_workflow: 执行任意 ComfyUI 工作流（UI/API 格式） ---
        // 定位：官方模板库之外的通用通道——LLM 直接提交含自定义节点的工作流
        // （用户保存的 .json，或 LLM 依 comfyui_list_nodes 查询结果拼出的图）。
        // 转换复用 customWorkflow.normalizeWorkflow（UI→API），注入复用既有槽位定位，
        // 提交后走 comfyui_generate 同款后台轮询链（结果回投对话）。
        function _buildWorkflowDescription(reader) {
            var lines = [
                '执行任意 ComfyUI 工作流（支持自定义节点）。工作流两种格式均可：',
                '  - UI 格式：ComfyUI 编辑器菜单「Save」保存的 JSON（含 nodes/links）——自动转换为 API 格式',
                '  - API 格式：菜单「Export (API)」导出的 JSON（每节点含 class_type/inputs）——直通',
                '来源：workflow 直接传 JSON 对象；或 workflow_path 传本地 .json 绝对路径（聊天历史 [附件文件路径] 下的绝对路径可直接用）。',
                '',
                '可选注入（未匹配到槽位时在 notes 说明，不阻断执行）：',
                '  - prompt / negative_prompt：注入文本编码节点的 text 槽',
                '  - image_source=current_frame|file_path + image_paths：上传图片，按 LoadImage 节点顺序注入',
                '  - video_paths：上传视频并按 LoadVideo / VHS_LoadVideo 顺序注入（参考视频/视频编辑类工作流）',
                '  - overrides：{"节点ID.输入名": 值} 精确改值（如 {"6.text":"a cat","8.width":1024}；点号输入用 {"9.format.codec":"auto"}）；不含点号的裸键命中所有同名输入',
                '  - validate_only=true：只做转换/校验/注入并返回报告，不提交（先确认节点是否齐全）',
                '',
                '自写工作流（LLM 直接拼）：用 API 格式最稳。inputs 的值 = 字面量（字符串/数字/布尔），',
                '  引用其他节点输出用 [源节点ID, 输出槽序号]（节点ID 用字符串，如 {"5":{"class_type":"VAEDecode","inputs":{"samples":["4",0],"vae":["1",2]}}}）；',
                '  工作流必须含输出节点（SaveImage / SaveVideo 等，output_node=true，可用 comfyui_list_nodes 的 output_nodes 过滤查询）。',
                '  推荐闭环：comfyui_list_nodes 查类名与输入（含 combo 可选值）→ 拼 API JSON → validate_only=true 校验 → 按 problems 改正 → 正式提交。',
                '',
                '自定义节点：本机未安装的节点会在提交前按类名报出；用 comfyui_list_nodes 查询本机节点与输入定义（含 combo 可选值、动态 combo 选项 key）。',
                '模型文件：查 class_type=CheckpointLoaderSimple / UNETLoader / VAELoader / CLIPLoader / LoraLoader 的 combo 可选值即本机文件清单，或先查 comfyui_list_checkpoints。',
                '',
                '⚠️ 异步: 提交后立即返回 prompt_id（status=generating），不等待完成。'
            ];
            if (_isExternalReader(reader)) {
                lines.push('完成结果不会主动送达，须自行调用 comfyui_check_status 反复查询（model_id 可省略）；done 时 outputs 含输出路径。');
            } else {
                lines.push('生成完成后结果自动发送到对话（含输出路径）。主动查询进度用 comfyui_check_status。');
            }
            return lines.join('\n');
        }

        toolRegistry.register({
            name: 'comfyui_run_workflow',
            shortDescription: '执行任意 ComfyUI 工作流（UI/API JSON，支持自定义节点）',
            description: _buildWorkflowDescription(),
            buildDescription: _buildWorkflowDescription,
            input_schema: {
                type: 'object',
                properties: {
                    workflow: {
                        type: 'object',
                        description: '工作流 JSON 对象（UI 格式=编辑器 Save 内容；API 格式=Export (API) 内容）。与 workflow_path 二选一。'
                    },
                    workflow_path: {
                        type: 'string',
                        description: '本地工作流 .json 的绝对路径（经 AEFS 读取）。与 workflow 二选一。'
                    },
                    prompt: {
                        type: 'string',
                        description: '正向提示词（注入文本编码槽位；工作流非提示词驱动时不要传）'
                    },
                    negative_prompt: {
                        type: 'string',
                        description: '负面提示词（注入负面文本槽位，找不到则忽略）'
                    },
                    image_source: {
                        type: 'string',
                        description: '图片来源。current_frame=AE当前帧, file_path=指定文件, none=无图片',
                        enum: ['current_frame', 'file_path', 'none']
                    },
                    image_paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '图片文件路径数组（image_source=file_path 时）'
                    },
                    video_paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '视频文件路径数组（上传并注入 LoadVideo/VHS_LoadVideo 槽）'
                    },
                    overrides: {
                        type: 'object',
                        description: '{"节点ID.输入名": 值} 精确覆盖；裸输入名命中所有同名输入'
                    },
                    validate_only: {
                        type: 'boolean',
                        description: '只转换+校验+注入并返回报告，不提交执行'
                    }
                },
                required: []
            },
            handler: async function (args, execCtx) {
                function fail(text) {
                    return { success: false, isError: true, content: [{ type: 'text', text: text }] };
                }
                try {
                    var pathArg = String(args.workflow_path || '').trim();
                    var rawJson = null;
                    var sourceLabel = '';
                    // workflow 按 schema 是对象；LLM 偶尔把 JSON 文本直接塞进字符串参数，一并容忍
                    if (args.workflow && (typeof args.workflow === 'object' || typeof args.workflow === 'string')) {
                        rawJson = typeof args.workflow === 'string' ? args.workflow : JSON.stringify(args.workflow);
                        sourceLabel = 'inline';
                    } else if (pathArg) {
                        var rr = await _readWorkflowText(pathArg);
                        if (!rr.ok) return fail(rr.message);
                        rawJson = rr.text;
                        sourceLabel = pathArg;
                    } else {
                        return fail('缺少工作流：传 workflow（JSON 对象）或 workflow_path（本地 .json 路径），二选一。');
                    }

                    var ctrl = await _ensureController(config);
                    var service = ctrl.getService();
                    var settings = await ctrl.getSettings();
                    var connected = await _checkConnectivity(settings);
                    if (!connected) {
                        var addr = (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
                        return fail('ComfyUI 服务未连接（' + addr + '）。请确认 ComfyUI 已启动且地址正确。');
                    }

                    var custom = global.AEComfyUI && global.AEComfyUI.customWorkflow;
                    if (!custom || typeof custom.normalizeWorkflow !== 'function') {
                        return fail('工作流格式归一模块 customWorkflow 未加载');
                    }
                    var norm = await custom.normalizeWorkflow(rawJson, { service: service, requireCatalog: true });
                    if (!norm || !norm.ok) {
                        return fail('工作流解析失败 [' + ((norm && norm.error && norm.error.code) || 'UNKNOWN')
                            + ']: ' + ((norm && norm.error && norm.error.message) || '未知错误'));
                    }
                    var promptData = norm.data.workflow;
                    var converted = !!norm.data.converted;
                    var skipped = norm.data.skipped || [];
                    var conv = (global.AEComfyUI && global.AEComfyUI.uiToApi) ? global.AEComfyUI.uiToApi : null;
                    if (!conv) return fail('UI→API 转换器未加载（uiToApi.js）');
                    var catalog = await service.getObjectInfo();

                    // 云端/API 节点门（对齐 comfyui_generate / run_official_template 的
                    // allowCloudModels 语义：object_info.api_node=true 的节点是伙伴云节点，
                    // 调用消耗账户积分。任意工作流内容不可预判，只能按节点类逐个体检）
                    var apiNodes = [];
                    var wfIds = Object.keys(promptData);
                    for (var ai = 0; ai < wfIds.length; ai++) {
                        var aiNode = promptData[wfIds[ai]];
                        var aiDef = aiNode && catalog[aiNode.class_type];
                        if (aiDef && aiDef.api_node === true && apiNodes.indexOf(aiNode.class_type) < 0) {
                            apiNodes.push(aiNode.class_type);
                        }
                    }
                    if (apiNodes.length) {
                        var _ssWf = config.settingsStore;
                        var _agentWf = {};
                        if (_ssWf && typeof _ssWf.getModuleSettings === 'function') {
                            try { _agentWf = await _ssWf.getModuleSettings('agent', {}); } catch (_) {}
                        }
                        if (!_agentWf.allowCloudModels) {
                            return fail('工作流包含云端/API 节点（' + apiNodes.join(', ')
                                + '），会消耗 ComfyUI 账户积分。请先在 Agent 模块设置中勾选「允许云端模型」后重试，或改用纯本地节点的工作流。');
                        }
                    }

                    // 预检：缺节点必须在做上传/注入之前失败（否则白传文件）。
                    // 完整校验放在注入之后（模板占位值先被注入替换，否则误判）。
                    var preProblems = _validateApiPrompt(promptData, catalog);
                    var missing = [];
                    for (var pi = 0; pi < preProblems.length; pi++) {
                        if (preProblems[pi].code === 'NODE_NOT_INSTALLED' && missing.indexOf(preProblems[pi].class_type) < 0) {
                            missing.push(preProblems[pi].class_type);
                        }
                    }
                    if (missing.length) {
                        return fail('工作流依赖本机未安装的节点: ' + missing.join(', ')
                            + '。请在 ComfyUI Manager 安装对应节点包后重试（可用 comfyui_list_nodes 确认本机已装节点）。');
                    }

                    // 注入（顺序：prompt → negative → 图片 → 视频 → overrides）
                    var notes = [];
                    var injected = {};
                    // 本次上传并写入的输入：枚举校验跳过（object_info 缓存不含刚上传的新文件名）
                    var injectedSkip = {};
                    if (args.prompt) {
                        var slot = conv.findPromptSlot(promptData);
                        if (!slot) {
                            return fail('工作流里找不到可注入提示词的槽位。若该工作流不是提示词驱动，去掉 prompt 参数即可；否则用 overrides 按「节点ID.输入名」直接改。');
                        }
                        promptData[slot.nodeId].inputs[slot.key] = String(args.prompt);
                        injected.prompt = { node: promptData[slot.nodeId].class_type, node_id: slot.nodeId, key: slot.key };
                    }
                    if (args.negative_prompt) {
                        var negSlot = _findNegativeSlot(promptData, injected.prompt ? { nodeId: injected.prompt.node_id } : null);
                        if (!negSlot) {
                            notes.push('未找到负面提示词槽位，已忽略 negative_prompt');
                        } else {
                            promptData[negSlot.nodeId].inputs[negSlot.key] = String(args.negative_prompt);
                            injected.negative_prompt = { node: promptData[negSlot.nodeId].class_type, node_id: negSlot.nodeId, key: negSlot.key };
                        }
                    }

                    var images = [];
                    try {
                        images = await _collectImages(args, ctrl);
                    } catch (e) {
                        return fail('图片收集失败: ' + (e.message || String(e)));
                    }
                    if (images.length) {
                        var imgSlots = conv.findImageSlots(promptData);
                        if (!imgSlots.length) {
                            notes.push('工作流无 LoadImage 节点，已忽略提供的图片');
                        } else {
                            var used = Math.min(images.length, imgSlots.length);
                            for (var ii = 0; ii < used; ii++) {
                                var up = await service.uploadImage(images[ii].blob, images[ii].name);
                                promptData[imgSlots[ii].nodeId].inputs[imgSlots[ii].key] = up.name || images[ii].name;
                                injectedSkip[imgSlots[ii].nodeId + '.' + imgSlots[ii].key] = 1;
                            }
                            injected.images = used;
                            if (images.length > imgSlots.length) {
                                notes.push('图片数（' + images.length + '）超过 LoadImage 槽位（' + imgSlots.length + '），多余的已忽略');
                            }
                        }
                    }

                    var videoPaths = Array.isArray(args.video_paths) ? args.video_paths.filter(Boolean) : [];
                    if (videoPaths.length) {
                        var vSlots = _findVideoSlots(promptData);
                        if (!vSlots.length) {
                            notes.push('工作流无 LoadVideo/VHS_LoadVideo 节点，已忽略提供的视频');
                        } else {
                            var vUsed = Math.min(videoPaths.length, vSlots.length);
                            for (var vi = 0; vi < vUsed; vi++) {
                                var vp = videoPaths[vi];
                                var slotCfg = vSlots[vi];
                                if (slotCfg.kind === 'path') {
                                    var pathOk = await _verifyLocalMediaPath(vp);
                                    if (!pathOk.ok) return fail(pathOk.message);
                                    promptData[slotCfg.nodeId].inputs[slotCfg.key] = vp;
                                } else {
                                    var vbr = (global.AEFS && typeof global.AEFS.readBlob === 'function')
                                        ? await global.AEFS.readBlob(vp) : null;
                                    if (!vbr || !vbr.success || !vbr.blob) return fail('无法读取视频文件: ' + vp);
                                    var vName = vp.replace(/^.*[\\\/]/, '') || ('video_' + vi + '.mp4');
                                    var vup = await service.uploadImage(vbr.blob, vName);
                                    promptData[slotCfg.nodeId].inputs[slotCfg.key] = vup.name || vName;
                                    injectedSkip[slotCfg.nodeId + '.' + slotCfg.key] = 1;
                                }
                            }
                            injected.videos = vUsed;
                            if (videoPaths.length > vSlots.length) {
                                notes.push('视频数（' + videoPaths.length + '）超过视频载入槽位（' + vSlots.length + '），多余的已忽略');
                            }
                        }
                    }

                    var ovr = _applyOverrides(promptData, args.overrides);
                    if (ovr.skipped.length) {
                        notes.push('未生效的 overrides: ' + ovr.skipped.map(function (s) { return s.key + '(' + s.reason + ')'; }).join('、'));
                    }
                    if (ovr.linkReplaced.length) {
                        notes.push('overrides 覆盖了 ' + ovr.linkReplaced.length + ' 个链接输入（原连线已断开、改用字面值）: '
                            + ovr.linkReplaced.map(function (r) { return r.key; }).join('、'));
                    }
                    var _skippedUiNodes = [];
                    var _droppedWidgetNodes = 0;
                    for (var _ski = 0; _ski < skipped.length; _ski++) {
                        if (skipped[_ski] && skipped[_ski].dropped) _droppedWidgetNodes++;
                        else _skippedUiNodes.push(skipped[_ski]);
                    }
                    if (_skippedUiNodes.length) {
                        notes.push('转换器跳过 ' + _skippedUiNodes.length + ' 个界面控制节点（缺目录的旁路开关等）');
                    }
                    if (_droppedWidgetNodes) {
                        notes.push(_droppedWidgetNodes + ' 个节点的隐藏输入值已按默认值处理（V3 未命名尾部值丢弃）');
                    }

                    // 注入完成后完整校验（节点类/必需输入/链接/枚举值）。结构类问题提交必被
                    // ComfyUI 拒，提前给可读错误；validate_only 则原样报告不阻断。
                    // 跳过本次上传写入的输入（缓存目录含旧文件清单，见函数注释）；
                    // 其余枚举问题再用单节点 /object_info 复核一次（缓存可能因外部上传/
                    // 手放文件/新装模型而落后，不能把合法值一直判非法）。
                    var problems = _validateApiPrompt(promptData, catalog, injectedSkip);
                    var refined = await _refineChoiceProblems(problems, promptData, catalog, service);
                    problems = refined.problems;
                    if (refined.healed) {
                        notes.push('目录缓存已过期，' + refined.healed + ' 个枚举值经单节点 /object_info 刷新后通过（缓存已更新）');
                    }
                    var outputType = _detectOutputType(promptData);
                    var nodeCount = Object.keys(promptData).length;

                    if (args.validate_only === true) {
                        var report = {
                            success: true,
                            status: 'validated',
                            workflow_source: sourceLabel,
                            workflow_format: converted ? 'ui' : 'api',
                            node_count: nodeCount,
                            output_type: outputType,
                            injected: injected,
                            overrides_applied: ovr.applied,
                        overrides_link_replaced: ovr.linkReplaced,
                            problems: problems,
                            skipped_ui_nodes: skipped,
                            notes: notes,
                            message: problems.length
                                ? ('校验发现 ' + problems.length + ' 个问题，未提交执行')
                                : '校验通过，未提交执行（去掉 validate_only 即执行）'
                        };
                        return { success: true, content: [{ type: 'text', text: JSON.stringify(report) }] };
                    }

                    if (problems.length) {
                        var blockLines = [];
                        for (var bp = 0; bp < problems.length && bp < 12; bp++) {
                            var b = problems[bp];
                            blockLines.push('- 节点 #' + b.node_id + '（' + (b.class_type || b.code) + '）: ' + b.message);
                        }
                        if (problems.length > 12) blockLines.push('- …另有 ' + (problems.length - 12) + ' 项');
                        return fail('工作流校验未通过（' + problems.length + ' 项，未提交）:\n' + blockLines.join('\n')
                            + '\n\n先用 validate_only=true 看完整报告；模型/枚举值错误用 comfyui_list_nodes 查 combo 可选值后改正。');
                    }

                    var submitted = await _submitPromptOrError(service, promptData, settings.apiKey);
                    if (!submitted.ok) return fail(submitted.text);

                    var promptId = submitted.promptId;
                    ctrl.registerPromptSource(promptId, 'llm');
                    _registerPromptMeta(promptId, { outputType: outputType, label: 'workflow' });
                    var sessionId = (global.AEEngine && global.AEEngine.bridge && typeof global.AEEngine.bridge.getSessionId === 'function')
                        ? global.AEEngine.bridge.getSessionId() : null;
                    _backgroundPoll(service, promptId, 'workflow', outputType, sessionId,
                        _isExternalCaller(execCtx), _laneIdOfCtx(execCtx));

                    var resp = {
                        success: true,
                        status: 'generating',
                        prompt_id: promptId,
                        workflow_source: sourceLabel,
                        workflow_format: converted ? 'ui' : 'api',
                        node_count: nodeCount,
                        output_type: outputType,
                        injected: injected,
                        overrides_applied: ovr.applied,
                        overrides_link_replaced: ovr.linkReplaced,
                        problems: problems,
                        skipped_ui_nodes: skipped,
                        notes: notes,
                        message: _isExternalCaller(execCtx)
                            ? '已提交工作流任务，后台轮询中。完成结果不会主动送达，用 comfyui_check_status 查询（model_id 可省略）。'
                            : '已提交工作流任务，后台自动轮询中。生成完成后结果会自动发送到对话。'
                    };
                    return { success: true, content: [{ type: 'text', text: JSON.stringify(resp) }] };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_run_workflow error:', e);
                    var errText = '执行工作流失败: ' + (e.message || String(e));
                    if (/unauthorized|login first/i.test(errText)) {
                        errText += '\n\n请在 ComfyUI 模块设置中填入 Comfy API Key，或确认 ComfyUI 桌面端已登录。';
                    }
                    return fail(errText);
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_run_workflow tool registered');

        // --- comfyui_list_nodes: 查询本机已安装节点与输入定义（写工作流用） ---
        function _buildNodesDescription() {
            return [
                '查询本机 ComfyUI 已安装的节点类型与输入定义（用于编写/校验含自定义节点的工作流），分页返回。',
                '',
                '两种用法：',
                '  1) class_type：查单个节点 schema。默认返回 required/optional 输入的类型、默认值、combo 可选值（每个输入默认 60 个，可用 choices_offset/choices_limit 翻页，上限 120；动态 combo 的选项 key 同样按该参数翻页）、autogrow 模板。',
                '     加 input=输入名 只返回该输入的 schema（大节点用这个方式逐个查）。detail 超过单页预算时省略部分输入，返回 omitted_inputs（有界前缀）、omitted_total、omitted_hasMore，不整包下发。',
                '  2) query / category / output_nodes + offset / limit：搜索节点。query 匹配类名/显示名/分类；category 按分类前缀过滤（如 video、image、api node）；output_nodes=true 只列输出保存节点（SaveImage / SaveVideo 等）。',
                '     返回类名、分类、输出类型、是否输出/API 节点，以及 total_nodes/matched/offset/limit/returned/hasMore/nextOffset；翻页把 nextOffset 作为下一次 offset（limit 默认 50、最大 200）。',
                '',
                '常用查询：',
                '  - 模型文件清单：class_type=CheckpointLoaderSimple（checkpoints）、UNETLoader（diffusion_models）、VAELoader、CLIPLoader、LoraLoader 的 combo 可选值即本机已安装文件；可选值过百时按 choices_nextOffset 翻页。',
                '  - 判断节点包是否安装：用 category 或 query 搜包名/节点名；未安装时搜不到。',
                '',
                '⚠️ 节点不存在时明确返回 NOT_FOUND 并给相近类名建议；不要凭记忆编造节点类名。'
            ].join('\n');
        }

        toolRegistry.register({
            name: 'comfyui_list_nodes',
            shortDescription: '查询本机 ComfyUI 节点类型与输入定义（写自定义工作流用）',
            description: _buildNodesDescription(),
            buildDescription: _buildNodesDescription,
            input_schema: {
                type: 'object',
                properties: {
                    class_type: {
                        type: 'string',
                        description: '节点类名（精确）。传了就返回该节点输入定义（可再加 input 只看单个输入）。'
                    },
                    input: {
                        type: 'string',
                        description: '输入名（配合 class_type）：只返回该输入的 schema，并按 choices_offset/choices_limit 分页它的 combo 可选值'
                    },
                    query: {
                        type: 'string',
                        description: '搜索关键词（匹配类名/显示名/分类）'
                    },
                    category: {
                        type: 'string',
                        description: '分类前缀过滤（如 video、image、api node）'
                    },
                    output_nodes: {
                        type: 'boolean',
                        description: '为 true 时只列输出保存节点（output_node=true，如 SaveImage / SaveVideo）'
                    },
                    offset: {
                        type: 'number',
                        description: '搜索分页起点（0 起），默认 0；上一次返回的 nextOffset 可直接传入'
                    },
                    limit: {
                        type: 'number',
                        description: '搜索每页条数，默认 50，最大 200；单页超序列化预算时自动减小，以返回的 limit 为准'
                    },
                    choices_offset: {
                        type: 'number',
                        description: 'combo 可选值 / 动态 combo 选项的分页起点，默认 0（detail 模式）；上一次返回的 choices_nextOffset 或 options_nextOffset 可直接传入'
                    },
                    choices_limit: {
                        type: 'number',
                        description: '每个 combo 输入返回的可选值条数（动态 combo 为选项条数），默认 60，最大 120（detail 模式）'
                    }
                }
            },
            handler: async function (args) {
                // 直接调用 / 旧路径可能不带参数对象：与 list_checkpoints 写法对齐
                args = args || {};
                function fail(text) {
                    return { success: false, isError: true, content: [{ type: 'text', text: text }] };
                }
                try {
                    var ctrl = await _ensureController(config);
                    var service = ctrl.getService();
                    var settings = await ctrl.getSettings();
                    var connected = await _checkConnectivity(settings);
                    if (!connected) {
                        var addr2 = (settings.host || '127.0.0.1') + ':' + (settings.port || 8188);
                        return fail('ComfyUI 服务未连接（' + addr2 + '）。节点目录需要 ComfyUI 在线。');
                    }
                    var catalog = await service.getObjectInfo();
                    if (!catalog || typeof catalog !== 'object' || !Object.keys(catalog).length) {
                        return fail('无法获取 ComfyUI 节点目录（/object_info 为空）');
                    }
                    var classType = args.class_type ? String(args.class_type).trim() : '';
                    var allNames = Object.keys(catalog);
                    var i;

                    if (classType) {
                        var def = catalog[classType];
                        if (!def) {
                            // 相近类名建议：子串双向匹配 + 拆词匹配（VHS_LoadVideo → LoadVideo）
                            var lower = classType.toLowerCase();
                            var suggests = [];
                            var seen = {};
                            function pushSuggest(nm) {
                                if (!nm || seen[nm]) return;
                                seen[nm] = 1;
                                if (suggests.length < 10) suggests.push(nm);
                            }
                            for (i = 0; i < allNames.length; i++) {
                                var nl = allNames[i].toLowerCase();
                                if (nl.indexOf(lower) >= 0 || (lower.length >= 4 && lower.indexOf(nl) >= 0)) pushSuggest(allNames[i]);
                            }
                            var parts = classType.split(/[_\/]/).filter(function (p) { return p.length >= 4; });
                            for (var pI = 0; pI < parts.length && suggests.length < 10; pI++) {
                                var pl = parts[pI].toLowerCase();
                                for (i = 0; i < allNames.length; i++) {
                                    if (allNames[i].toLowerCase().indexOf(pl) >= 0) pushSuggest(allNames[i]);
                                }
                            }
                            return fail('NOT_FOUND: 本机未安装节点 ' + classType
                                + (suggests.length ? '。相近节点: ' + suggests.join(', ') : '。可用 query 搜索安装情况'));
                        }
                        var req = (def.input && def.input.required) || {};
                        var opt = (def.input && def.input.optional) || {};
                        var rk = Object.keys(req);
                        var ok = Object.keys(opt);
                        var displayName = def.display_name || def.name || classType;
                        var outputs = Array.isArray(def.output)
                            ? def.output.map(function (t) { return Array.isArray(t) ? 'COMBO' : t; }) : [];
                        var hiddenNames = (def.input && def.input.hidden) ? Object.keys(def.input.hidden) : null;
                        // combo 可选值分页参数（单输入可达上千项，整包会撑爆单页预算）
                        var choicesOffset = _intArg(args.choices_offset, 0, 0);
                        var choicesLimit = _intArg(args.choices_limit, NODE_CHOICE_LIMIT_DEFAULT, 1, NODE_CHOICE_LIMIT_MAX);

                        // input=名字：只返回该输入的 schema
                        var inputName = args.input ? String(args.input).trim() : '';
                        if (inputName) {
                            var isReq = Object.prototype.hasOwnProperty.call(req, inputName);
                            var isOpt = Object.prototype.hasOwnProperty.call(opt, inputName);
                            if (!isReq && !isOpt) {
                                var available = rk.concat(ok);
                                var shown = available.slice(0, 80);
                                return fail('NOT_FOUND: 节点 ' + classType + ' 无输入 ' + inputName + '。可用输入: '
                                    + (shown.length ? shown.join(', ') : '无')
                                    + (available.length > shown.length ? ' …（共 ' + available.length + ' 个）' : ''));
                            }
                            var inputSpec = isReq ? req[inputName] : opt[inputName];
                            var oneSpec = _summarizeInputSpec(inputSpec, {
                                choicesOffset: choicesOffset,
                                choicesLimit: choicesLimit
                            });
                            var one = {
                                success: true,
                                class_type: classType,
                                display_name: displayName,
                                input: inputName,
                                input_kind: isReq ? 'required' : 'optional',
                                spec: oneSpec
                            };
                            one.hint = _specPageHint(oneSpec);
                            // 单输入页同样按序列化预算收敛（长 combo 值 / 大量动态选项）
                            _fitOnePage(one, _choiceSourceOf(inputSpec), choicesOffset);
                            // 非分页字段仍越线（极端 schema，如超长 autogrow names）：省略字段定义
                            if (JSON.stringify(one).length >= PAGING_PAYLOAD_BUDGET) {
                                one.spec = { type: oneSpec.type, schema_omitted: true };
                                one.hint = '该输入的 schema 超过单页预算，已省略字段定义（type=' + oneSpec.type + '）。';
                            }
                            return { success: true, content: [{ type: 'text', text: JSON.stringify(one) }] };
                        }

                        // 不带 input：按单页预算装入 inputs。装不下的输入列入 omitted_inputs
                        //（真机最坏节点 LoRA Stacker 实测约 215K 字符，绝不整包下发给模型）。
                        var detail = {
                            success: true,
                            class_type: classType,
                            display_name: displayName,
                            category: def.category || '',
                            output_node: !!def.output_node,
                            api_node: !!def.api_node,
                            python_module: def.python_module || '',
                            outputs: outputs,
                            inputs: { required: {}, optional: {} }
                        };
                        if (hiddenNames) detail.hidden_inputs = hiddenNames;
                        var omitted = [];
                        var presentOrder = [];
                        var outOfRangeInputs = 0;
                        var groups = [
                            { key: 'required', names: rk, map: req },
                            { key: 'optional', names: ok, map: opt }
                        ];
                        for (var g = 0; g < groups.length; g++) {
                            var bucket = detail.inputs[groups[g].key];
                            for (i = 0; i < groups[g].names.length; i++) {
                                var inputNameI = groups[g].names[i];
                                var summarized = _summarizeInputSpec(groups[g].map[inputNameI], {
                                    choicesOffset: choicesOffset,
                                    choicesLimit: choicesLimit
                                });
                                bucket[inputNameI] = summarized;
                                if (summarized.choices_outOfRange || summarized.options_outOfRange) outOfRangeInputs++;
                                // 预留 omitted 块的空间（名单/hint 也要占预算），避免装满分页主体后名单被迫清空
                                if (JSON.stringify(detail).length >= DETAIL_INPUT_BUDGET) {
                                    delete bucket[inputNameI];
                                    omitted.push(inputNameI);
                                } else {
                                    presentOrder.push({ group: groups[g].key, name: inputNameI });
                                }
                            }
                        }
                        if (omitted.length) {
                            // omitted_inputs 只下发有界前缀；总数 / 是否截断单独回报，
                            // 否则 400 个 80 字符输入名的名单本身就有 30K+。
                            var included = omitted.length;
                            var writeOmitted = function () {
                                detail.omitted_total = omitted.length;
                                detail.omitted_inputs = omitted.slice(0, included);
                                detail.omitted_hasMore = omitted.length > included;
                                detail.hint = '节点定义超过单页预算，已省略 ' + omitted.length + ' 个输入'
                                    + (detail.omitted_hasMore ? '（omitted_inputs 只列前 ' + included + ' 个）' : '')
                                    + '；用 input=输入名 单独查询。'
                                    + (outOfRangeInputs ? ' choices_offset 超出部分输入的可选值范围，本页为空。' : '');
                            };
                            writeOmitted();
                            // ① 名单本身也占预算：从尾部回退到有界前缀，总数仍如实回报
                            while (JSON.stringify(detail).length >= PAGING_PAYLOAD_BUDGET && included > 0) {
                                included--;
                                writeOmitted();
                            }
                            // ② 名单已空仍超线：把末尾已返回的输入挪进名单（只增 omitted_total）
                            while (JSON.stringify(detail).length >= PAGING_PAYLOAD_BUDGET && presentOrder.length) {
                                var last = presentOrder.pop();
                                delete detail.inputs[last.group][last.name];
                                omitted.push(last.name);
                                writeOmitted();
                            }
                        } else {
                            detail.hint = '用 input=输入名 只看单个输入；combo 可选值 / 动态 combo 选项用 choices_offset/choices_limit 翻页'
                                + '（默认 ' + NODE_CHOICE_LIMIT_DEFAULT + '，上限 ' + NODE_CHOICE_LIMIT_MAX + '）。'
                                + (outOfRangeInputs ? ' choices_offset 超出部分输入的可选值范围，本页为空。' : '');
                        }
                        return { success: true, content: [{ type: 'text', text: JSON.stringify(detail) }] };
                    }

                    var query = String(args.query || '').trim().toLowerCase();
                    var category = String(args.category || '').trim().toLowerCase();
                    var limit = _intArg(args.limit, 50, 1, 200);
                    var offset = _intArg(args.offset, 0, 0);
                    var matchedRows = [];
                    var wantOutputNodes = args.output_nodes === true;
                    for (i = 0; i < allNames.length; i++) {
                        var nm2 = allNames[i];
                        var d2 = catalog[nm2];
                        var cat = String((d2 && d2.category) || '');
                        if (category && cat.toLowerCase().indexOf(category) !== 0) continue;
                        if (wantOutputNodes && !(d2 && d2.output_node)) continue;
                        if (query) {
                            var hay = (nm2 + ' ' + ((d2 && (d2.display_name || d2.name)) || '') + ' ' + cat).toLowerCase();
                            if (hay.indexOf(query) < 0) continue;
                        }
                        matchedRows.push({
                            class_type: nm2,
                            category: cat,
                            output_node: !!(d2 && d2.output_node),
                            api_node: !!(d2 && d2.api_node),
                            outputs: (d2 && Array.isArray(d2.output))
                                ? d2.output.map(function (t) { return Array.isArray(t) ? 'COMBO' : t; }) : []
                        });
                    }
                    var matchedTotal = matchedRows.length;
                    var rowStart = Math.min(offset, matchedTotal);
                    var rowCandidate = matchedRows.slice(rowStart, rowStart + limit);

                    function _buildSearchResult(page) {
                        var end = rowStart + page.length;
                        var hasMore = end < matchedTotal;
                        var hint = '用 class_type 参数查询单个节点的完整输入定义；模型文件用对应 Loader 节点的 combo 可选值查看。';
                        if (rowStart >= matchedTotal && matchedTotal > 0) {
                            hint = 'offset ' + offset + ' 超出匹配总数 ' + matchedTotal + '（有效 offset 0–'
                                + (matchedTotal - 1) + '）；用 offset=0 重新查询或改用更小的 offset。';
                        }
                        var result = {
                            success: true,
                            total_nodes: allNames.length,
                            matched: matchedTotal,
                            offset: offset,
                            // limit = 实际生效的页容量上限（超预算时小于请求值，以本字段为准）
                            limit: page.length < rowCandidate.length ? page.length : limit,
                            returned: page.length,
                            hasMore: hasMore,
                            nextOffset: hasMore ? end : null,
                            nodes: page,
                            hint: hint
                        };
                        if (hasMore) {
                            result.truncated = '匹配 ' + matchedTotal + ' 个，本页返回第 ' + (rowStart + 1) + '–' + end
                                + ' 个；用 offset=' + end + ' 继续（limit 上限 200）';
                        }
                        return result;
                    }

                    var rowPage = _fitPageToBudget(rowCandidate, _buildSearchResult);
                    return { success: true, content: [{ type: 'text', text: JSON.stringify(_buildSearchResult(rowPage)) }] };
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_list_nodes error:', e);
                    return fail('查询节点目录失败: ' + (e.message || String(e)));
                }
            },
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: true,
            readOnly: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_list_nodes tool registered');

        // --- comfyui_project_asset: 本项目资产库（工程目录）列目录 / 转存 / 移出 ---
        // 定位：生成产物默认落 <数据目录>/temp/comfyui-output（滚动裁剪 + 预算/龄回收），
        // 长期资产必须显式转存到工程旁，否则会话/回执里的路径迟早失效。转存由调用方
        // （团队模式的美术执行）按需决定，不是每张都存。
        // 落点与文件操作全在 controller（getProjectDir/saveProjectAssets/listProjectAssets/
        // restoreProjectAssets）：本工具只做参数校验与回执组装。
        toolRegistry.register({
            name: 'comfyui_project_asset',
            shortDescription: '本项目资产库：列出/转存/移出（生成产物长期保留用）',
            description: [
                '本项目资产库 = 当前 AE 工程文件同目录的 _comfyui_assets 文件夹，随工程走。',
                '生成产物默认落数据目录 temp/comfyui-output，会被定期清理；要长期保留、后续还要交给 AE 使用或复用的，用 save 转存进来（复制，不移动生成产物）。',
                '旧资产用 restore 移回 temp（= 移出资产库），之后按 temp 的回收策略处理，不再是长期资产。',
                '工程未保存时不可用（资产库建在工程文件旁）。本工具不导入 AE、不改工程内容。',
                '',
                'action=list：列出资产库内文件（递归，深度 ≤3，按修改时间新→旧；folder 只看某子目录；limit 默认 200、最大 500）。',
                '  返回 files[].path 可直接传给 restore；dirs 为子目录清单。',
                'action=save：paths 为生成回执里的产物路径（相对数据目录或绝对，必须是 temp/comfyui-output 下的文件）。',
                '  folder 可选资产库内子目录（如 角色）；names 可选重命名（与 paths 一一对应，不含路径分隔符，同名自动加 _1）。',
                '  单个失败不影响其余，返回 saved / failed，saved[].path 为资产绝对路径。',
                'action=restore：paths 为 list 返回的资产路径（必须是资产库内文件）；移回 temp/comfyui-output，',
                '  返回 moved[].relPath（数据根相对，与生成回执同形态）与 failed。'
            ].join('\n'),
            input_schema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'save', 'restore'],
                        description: '必填：list=列出资产、save=转存生成产物到资产库、restore=移出资产库（移回 temp）'
                    },
                    paths: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'save/restore 必填：save 传生成回执里的产物路径（相对数据目录或绝对）；restore 传 list 返回的 path。单次上限 50 个'
                    },
                    folder: {
                        type: 'string',
                        description: 'save：资产库内相对子目录（如 角色、角色/定稿），省略=资产库根；list：只看该子目录'
                    },
                    names: {
                        type: 'array',
                        items: { type: 'string' },
                        description: 'save 可选：重命名（与 paths 一一对应、不含路径分隔符）；不给则沿用原文件名'
                    },
                    limit: {
                        type: 'number',
                        description: 'list 返回条数上限，默认 200，最大 500'
                    }
                },
                required: ['action']
            },
            handler: async function (args) {
                args = args || {};
                function fail(text) {
                    return { success: false, isError: true, content: [{ type: 'text', text: text }] };
                }
                function okText(obj) {
                    return { success: true, content: [{ type: 'text', text: JSON.stringify(obj) }] };
                }
                try {
                    var action = args.action;
                    if (action !== 'list' && action !== 'save' && action !== 'restore') {
                        return fail('action 必填：list / save / restore');
                    }
                    var ctrl = await _ensureController(config);
                    if (typeof ctrl.saveProjectAssets !== 'function'
                        || typeof ctrl.listProjectAssets !== 'function'
                        || typeof ctrl.restoreProjectAssets !== 'function') {
                        return fail('本项目资产库不可用：控制器缺少资产接口（面板需重启以加载新版本的 ComfyUI 模块）');
                    }
                    if (action === 'list') {
                        var listed = await ctrl.listProjectAssets({ folder: args.folder, limit: args.limit });
                        var listHint = listed.files.length
                            ? '要移出资产库的文件，把 path 原样传给 action=restore。'
                            : '资产库为空（或该子目录不存在）。action=save 可把生成产物转存进来。';
                        if (listed.truncated) {
                            listHint = '已达单次上限，列表不完整：用 folder 缩小范围或提高 limit 后重查。';
                        }
                        return okText({
                            status: 'done',
                            action: 'list',
                            project_dir: listed.projectDir,
                            asset_root: listed.assetRoot,
                            folder: listed.dir,
                            exists: listed.exists,
                            total: listed.total,
                            returned: listed.files ? listed.files.length : listed.total,
                            truncated: listed.truncated,
                            dirs: listed.dirs,
                            dirs_truncated: listed.dirsTruncated,
                            files: listed.files,
                            hint: listHint
                        });
                    }
                    if (action === 'save') {
                        var savedRes = await ctrl.saveProjectAssets({
                            paths: args.paths, folder: args.folder, names: args.names
                        });
                        var status = savedRes.failed.length
                            ? (savedRes.saved.length ? 'partial' : 'failed')
                            : 'done';
                        return okText({
                            status: status,
                            action: 'save',
                            project_dir: savedRes.projectDir,
                            asset_root: savedRes.assetRoot,
                            folder: savedRes.folder,
                            saved: savedRes.saved,
                            failed: savedRes.failed,
                            message: '已转存 ' + savedRes.saved.length + ' 个文件到本项目资产库'
                                + (savedRes.failed.length ? '，失败 ' + savedRes.failed.length + ' 个' : ''),
                            hint: '生成产物仍在 temp（会话里旧路径照常可用）；回报时给 saved[].path。'
                        });
                    }
                    var movedRes = await ctrl.restoreProjectAssets({ paths: args.paths });
                    var status2 = movedRes.failed.length
                        ? (movedRes.moved.length ? 'partial' : 'failed')
                        : 'done';
                    var partialCount = 0;
                    for (var fi = 0; fi < movedRes.failed.length; fi++) {
                        if (movedRes.failed[fi] && movedRes.failed[fi].partial) partialCount++;
                    }
                    return okText({
                        status: status2,
                        action: 'restore',
                        project_dir: movedRes.projectDir,
                        asset_root: movedRes.assetRoot,
                        temp_dir: movedRes.tempDir,
                        moved: movedRes.moved,
                        failed: movedRes.failed,
                        message: '已移出 ' + movedRes.moved.length + ' 个资产（移回 temp）'
                            + (movedRes.failed.length ? '，失败 ' + movedRes.failed.length + ' 个' : ''),
                        hint: partialCount
                            ? 'failed 里 partial=true 的条目已复制到 temp、但资产库源文件未删除：先确认源是否还在，不要原样重试（会再复制一份）。'
                            : '移回 temp 的产物按 temp 回收策略清理，不再作为长期资产；需要再用可重新 save。'
                    });
                } catch (e) {
                    console.error('[ComfyuiBootstrap] comfyui_project_asset error:', e);
                    var msg = (e && e.message) ? e.message : String(e);
                    return fail('本项目资产库操作失败: ' + msg);
                }
            },
            scope: { type: 'module', moduleIds: ['agent'] },
            stub: true,
            category: 'comfyui',
            source: 'comfyui'
        });

        console.log('[ComfyuiBootstrap] comfyui_project_asset tool registered');
        return { ok: true };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.initComfyuiTools = initComfyuiTools;
})(window);
