(function (global) {
    function createTemplateEngine() {
        var templates = {};
        var _registry = null;   // modelRegistry 实例
        var _service = null;    // comfyuiService 实例（用于 /object_info 调用）
        var _unetModelSet = {}; // 归一化模型名 → true：models/unet + models/diffusion_models 的裸扩散模型
        var _hiddenUnetSet = {}; // 未进下拉的扩散模型（视频 / 未适配族）→ true：绕过下拉指定时明确报错
        var _modelCatalog = null; // 从 /object_info 提取的目录（文本编码器 / CLIP type / VAE / qwen 节点）

        function setRegistry(r) { _registry = r; }
        function setService(s) { _service = s; }

        function loadTemplates() {
            var templateIds = ['txt2img', 'img2img',
                'seedance2_i2v', 'seedance2_ref', 'seedream', 'gpt_image2',
                'kling_i2v', 'kling_i2v_legacy', 'kling_start_end',
                'hailuo', 'happyhorse_i2v', 'happyhorse_r2v', 'nano_banana2'];
            var failed = [];
            var extRoot = (typeof window !== 'undefined' && window.__ext_root) || '';
            var basePath = extRoot ? extRoot + '\\client\\modules\\comfyui\\templates\\' : '';
            var promises = templateIds.map(function (id) {
                var filePath = basePath + id + '.json';
                return AEFS.readFile(filePath).then(function (text) {
                    if (text) {
                        try { templates[id] = JSON.parse(text); }
                        catch (e) { console.warn('[TemplateEngine] 解析模板失败:', id, e); failed.push(id); }
                    } else {
                        failed.push(id);
                    }
                }).catch(function (e) {
                    console.warn('[TemplateEngine] 加载模板失败:', id, e && e.message);
                    failed.push(id);
                });
            });
            return Promise.all(promises).then(function () {
                if (failed.length > 0) {
                    console.warn('[TemplateEngine] 以下模板加载失败: ' + failed.join(', '));
                }
                return { loaded: Object.keys(templates).length, failed: failed };
            });
        }

        function getTemplate(id) {
            var tpl = templates[id];
            if (!tpl) return null;
            var clone = { id: tpl.id, name: tpl.name, description: tpl.description,
                category: tpl.category, mode: tpl.mode, cloud: tpl.cloud,
                modelSource: tpl.modelSource,
                parameters: (tpl.parameters || []).slice(),
                workflow: tpl.workflow,
                workflow_variants: tpl.workflow_variants,
                variant_key: tpl.variant_key, variant_map: tpl.variant_map
            };
            return clone;
        }

        // 伙伴节点发现：注入自动发现的模板卡片（select 下拉用）。
        // 按 id 查重（静态 loadTemplates 条目优先），返回是否新增。
        function addTemplate(tpl) {
            if (!tpl || !tpl.id || templates[tpl.id]) return false;
            templates[tpl.id] = tpl;
            return true;
        }

        // 伙伴节点发现：静态清单已注册的 classType 集合（发现层去重用，静态优先）
        function getRegisteredClassTypes() {
            if (!_registry) return [];
            var all = _registry.getAll();
            var out = [];
            for (var i = 0; i < all.length; i++) {
                if (all[i] && all[i].classType) out.push(all[i].classType);
            }
            return out;
        }

        // 伙伴节点发现：registry 条目追加（委托 modelRegistry.add，静态 id 优先）
        function addRegistryEntry(entry) {
            if (!_registry || typeof _registry.add !== 'function') return false;
            return _registry.add(entry);
        }

        function _normalizeModelName(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/\\/g, '/')
                .toLowerCase();
        }

        // 混合模型下拉：checkpoint + models/unet、models/diffusion_models 的裸扩散模型。
        // 只有声明 modelSource:'mixed' 的模板才把扩散模型并进下拉。
        // 传入的 unetList 由调用方按模态过滤（controller 只传能出图的图像模型；
        // 视频模型与未适配族留给 comfyui_list_checkpoints 归类展示，不进表单下拉）。
        // allUnetList = 未过滤的全量；用于把「绕过下拉指定」的视频/未适配模型拦成明确报错
        // （LLM 的 extra_params.model 与升级前缓存都可能带出这类名字）。
        function injectModelChoices(modelList, unetList, allUnetList) {
            modelList = Array.isArray(modelList) ? modelList.slice() : [];
            unetList = Array.isArray(unetList) ? unetList.slice() : [];
            allUnetList = Array.isArray(allUnetList) ? allUnetList.slice() : [];
            // 同名同时出现在两类里时按 checkpoint 处理（CheckpointLoaderSimple 能加载的优先）
            var ckptSet = {};
            for (var ci = 0; ci < modelList.length; ci++) {
                ckptSet[_normalizeModelName(modelList[ci])] = true;
            }
            _unetModelSet = {};
            for (var ui = 0; ui < unetList.length; ui++) {
                var normalized = _normalizeModelName(unetList[ui]);
                if (!ckptSet[normalized]) _unetModelSet[normalized] = true;
            }
            _hiddenUnetSet = {};
            for (var hi = 0; hi < allUnetList.length; hi++) {
                var hiddenName = _normalizeModelName(allUnetList[hi]);
                if (!hiddenName || ckptSet[hiddenName] || _unetModelSet[hiddenName]) continue;
                _hiddenUnetSet[hiddenName] = true;
            }
            Object.keys(templates).forEach(function (id) {
                var tpl = templates[id];
                if (!tpl || !tpl.workflow || tpl.mode === 'custom') return;
                // Find CheckpointLoaderSimple nodes and mark model placeholder
                var hasCheckpoint = false;
                Object.keys(tpl.workflow).forEach(function (nodeId) {
                    var node = tpl.workflow[nodeId];
                    if (node && node.class_type === 'CheckpointLoaderSimple') {
                        node.inputs.ckpt_name = '{{model}}';
                        hasCheckpoint = true;
                    }
                });
                if (!hasCheckpoint) return;

                var choices = modelList.slice();
                if (tpl.modelSource === 'mixed') {
                    for (var uj = 0; uj < unetList.length; uj++) {
                        if (choices.indexOf(unetList[uj]) < 0) choices.push(unetList[uj]);
                    }
                }

                // Build model parameter: select if model list available, text fallback otherwise
                var modelParam;
                if (choices.length > 0) {
                    modelParam = {
                        key: 'model',
                        label: AEI18n.t('模型'),
                        type: 'select',
                        choices: choices,
                        default: choices[0]
                    };
                } else {
                    modelParam = {
                        key: 'model',
                        label: AEI18n.t('模型 (手动输入)'),
                        type: 'text',
                        default: '',
                        placeholder: '例如 v1-5-pruned-emaonly.safetensors'
                    };
                }

                // Update existing or insert at front
                // 只升级（文本→下拉），不降级（下拉↛文本），避免连接断开后把好好的下拉毁掉
                var existingIdx = -1;
                for (var i = 0; i < tpl.parameters.length; i++) {
                    if (tpl.parameters[i].key === 'model') { existingIdx = i; break; }
                }
                if (existingIdx >= 0) {
                    if (modelParam.type === 'select') {
                        tpl.parameters[existingIdx] = modelParam;
                    }
                    // modelList 为空且已有参数 → 保留现有参数不变
                } else {
                    tpl.parameters.unshift(modelParam);
                }
            });
        }

        // 采样器 / 调度器下拉：模板 JSON 里是静态兜底清单（断连时可用），
        // 连上 ComfyUI 后用 /object_info 的 KSampler 枚举覆盖（不同版本/自定义节点会增减）。
        function _applySamplingChoices(catalog) {
            var samplers = (catalog && catalog.samplers) || [];
            var schedulers = (catalog && catalog.schedulers) || [];
            if (samplers.length === 0 && schedulers.length === 0) return;
            Object.keys(templates).forEach(function (id) {
                var tpl = templates[id];
                if (!tpl || !Array.isArray(tpl.parameters)) return;
                for (var i = 0; i < tpl.parameters.length; i++) {
                    var p = tpl.parameters[i];
                    if (!p || p.type !== 'select') continue;
                    var list = null;
                    if (p.key === 'sampler') list = samplers;
                    else if (p.key === 'scheduler') list = schedulers;
                    if (!list || list.length === 0) continue;
                    p.choices = list.slice();
                    if (p.default === undefined || list.indexOf(p.default) < 0) p.default = list[0];
                }
            });
        }

        // controller 刷新模型列表时注入 /object_info 目录；UNET 自动选型用
        function setModelCatalog(catalog) {
            _modelCatalog = catalog || null;
            _applySamplingChoices(_modelCatalog);
        }

        // 切模型时给 UI 的族推荐参数（步数/CFG）；非扩散模型返回 null
        function getUnetSamplingHints(modelName) {
            var um = global.AEComfyUI && global.AEComfyUI.unetModels;
            if (!um || typeof um.samplingDefaults !== 'function') return null;
            return um.samplingDefaults(modelName);
        }

        function _templateParamDefaults(tpl) {
            var defaults = {};
            (tpl.parameters || []).forEach(function (p) {
                if (p && p.key) defaults[p.key] = p.default;
            });
            return defaults;
        }

        function _isUnetModel(modelName) {
            return !!_unetModelSet[_normalizeModelName(modelName)];
        }

        function _isHiddenUnetModel(modelName) {
            return !!_hiddenUnetSet[_normalizeModelName(modelName)];
        }

        // 收集模板表单/工具传入的图片文件名：input_image 在前，reference_images_1..N 按序号在后
        function _collectImageFilenames(values) {
            var files = [];
            if (typeof values.input_image === 'string' && values.input_image) files.push(values.input_image);
            var refs = [];
            Object.keys(values).forEach(function (k) {
                var m = /^reference_images_(\d+)$/.exec(k);
                if (m && typeof values[k] === 'string' && values[k]) {
                    refs.push({ n: parseInt(m[1], 10), v: values[k] });
                }
            });
            refs.sort(function (a, b) { return a.n - b.n; });
            for (var i = 0; i < refs.length; i++) files.push(refs[i].v);
            return files;
        }

        // 选中裸扩散模型时整张图由 unetModels 构建，不走模板 JSON 的 {{}} 替换路径
        function _buildUnetWorkflow(tpl, values) {
            var um = global.AEComfyUI && global.AEComfyUI.unetModels;
            if (!um) throw new Error('UNET 文生图支持模块未加载（unetModels.js）');
            var def = um.detectFamily(values.model);
            if (!def) {
                throw new Error('暂不支持的扩散模型族: ' + values.model + '。当前支持 ' + um.familyNames().join(' / ') + '；其它模型请用自定义工作流。');
            }
            if (!_modelCatalog) {
                throw new Error('缺少 ComfyUI 节点信息，无法为扩散模型自动选择文本编码器/VAE：请先连接 ComfyUI 并刷新模型列表。');
            }
            var wiring = um.resolveWiring(def, _modelCatalog, {
                clip: values.clip,
                vae: values.vae,
                clip_type: values.clip_type
            });
            var sampling = um.resolveSampling(def, values.model, values, _templateParamDefaults(tpl));
            return um.buildWorkflow(def, wiring, {
                model: values.model,
                mode: tpl.mode === 'img2img' ? 'img2img' : 'txt2img',
                inputImages: _collectImageFilenames(values),
                prompt: values.prompt,
                negative_prompt: values.negative_prompt,
                width: values.width,
                height: values.height,
                batch_size: values.batch_size,
                seed: values.seed,
                steps: sampling.steps,
                cfg: sampling.cfg,
                sampler: sampling.sampler,
                scheduler: sampling.scheduler,
                denoise: sampling.denoise
            }, _modelCatalog);
        }

        function getAllTemplates() {
            return Object.keys(templates).map(function (k) { return templates[k]; });
        }

        function removeUnreplacedPlaceholders(obj) {
            if (!obj || typeof obj !== 'object') return;
            Object.keys(obj).forEach(function (key) {
                var val = obj[key];
                if (typeof val === 'string' && /^\{\{[\w.]+\}\}$/.test(val)) {
                    delete obj[key];
                } else if (val && typeof val === 'object') {
                    removeUnreplacedPlaceholders(val);
                }
            });
        }

        function escapeJsonString(str) {
            return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')
                .replace(/[\x00-\x1f]/g, function (c) {
                    return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4);
                });
        }

        function renderWorkflow(modelId, paramValues, imageFilenames, videoFilenames, opts) {
            // 两条路径，由 registry 模型的 pipeline 字段决定：
            //   pipeline=true  → 读 templates/<id>.json 的 workflow，做 {{key}} 占位符替换
            //   pipeline 缺省  → buildDynamicWorkflow 从头拼 workflow（不读模板 workflow！）
            //
            // ⚠️ non-pipeline 模型的 templates/<id>.json 里写死的 LoadImage/LoadVideo 节点结构
            //    **不会被使用**——buildDynamicWorkflow 自己建加载节点。模板 JSON 仅 parameters 生效。
            //    例：seedance2_ref 模板里的 ref_image_loader_*/ref_video_loader_* 节点是文档性质，
            //    实际加载节点由 buildDynamicWorkflow 按 imageInputKeys/videoInputKeys 动态建。
            //    真正的 workflow 真相源：pipeline=模板 JSON，non-pipeline=buildDynamicWorkflow 代码。
            //
            // 表单例外（opts.useTemplateWorkflow=true）：表单 values 用扁平 key（与模板占位符匹配），
            // 且不传 imageFilenames，必须走模板 JSON 占位符替换路径，否则非 pipeline 表单的图片输入丢失。
            // 画布不传 opts，非 pipeline 仍走 buildDynamicWorkflow（图来自端口连线）。
            var m = _registry ? _registry.getById(modelId) : null;
            var useTemplateWorkflow = opts && opts.useTemplateWorkflow;

            if (m && !m.pipeline && !useTemplateWorkflow) {
                // 非 pipeline：schema 优先，回退 buildDynamicWorkflow
                var cachedSchema = _registry ? _registry.getSchema(modelId) : null;
                if (cachedSchema) {
                    return buildSchemaDrivenWorkflow(m, cachedSchema, paramValues, imageFilenames || {}, videoFilenames || {});
                }
                return buildDynamicWorkflow(m, paramValues, imageFilenames || {}, videoFilenames || {});
            }

            // pipeline：走现有 {{key}} 占位符替换
            var templateId = m ? (m.templateId || m.id) : modelId;
            var tpl = templates[templateId];
            if (!tpl) throw new Error('模板不存在: ' + templateId);
            // 模板参数默认值兜底：占位符对应的值缺失时（旧画布节点 / 老调用方没有
            // 新增参数）用模板默认值，避免 removeUnreplacedPlaceholders 把
            // KSampler 的 sampler_name / scheduler 这类必填输入删掉。
            var values = {};
            var _pvKeys = Object.keys(paramValues || {});
            for (var _pvi = 0; _pvi < _pvKeys.length; _pvi++) {
                values[_pvKeys[_pvi]] = paramValues[_pvKeys[_pvi]];
            }
            var _paramDefaults = _templateParamDefaults(tpl);
            Object.keys(_paramDefaults).forEach(function (key) {
                if ((values[key] === undefined || values[key] === null) && _paramDefaults[key] !== undefined) {
                    values[key] = _paramDefaults[key];
                }
            });

            // 混合模型模板选中裸扩散模型（models/unet / models/diffusion_models）时，
            // 由 unetModels 构建 UNETLoader + CLIP + VAE 图；checkpoint 仍走模板替换。
            if (tpl.modelSource === 'mixed' && values.model && _isUnetModel(values.model)) {
                return _buildUnetWorkflow(tpl, values);
            }
            // 视频模型 / 未适配扩散模型：不在下拉里，但 LLM 的 extra_params.model 或
            // 升级前表单缓存可能带出来。不拦会退化成 CheckpointLoaderSimple 报错，
            // 这里给可操作提示。
            if (tpl.modelSource === 'mixed' && values.model && _isHiddenUnetModel(values.model)) {
                var _um = global.AEComfyUI && global.AEComfyUI.unetModels;
                var _families = (_um && typeof _um.familyNames === 'function') ? _um.familyNames().join(' / ') : '';
                throw new Error('该扩散模型不能用于本地文生图/图生图: ' + values.model
                    + '（视频模型或暂未适配的模型族）。请换成受支持的图像模型'
                    + (_families ? '（' + _families + '）' : '') + '，或改用自定义工作流。');
            }
            // checkpoint 路径不消费参考图：提示但不打断（表单里 Qwen 专用槽切回 checkpoint 后常残留）
            if (tpl.modelSource === 'mixed' && Object.keys(values).some(function (k) { return /^reference_images_\d+$/.test(k); })) {
                console.warn('[TemplateEngine] 参考图仅 Qwen-Image 扩散模型支持，当前 checkpoint 路径已忽略');
            }

            // 选取 workflow 模板：支持 workflow_variants 按模型切换
            var workflowTemplate;
            if (tpl.variant_key && tpl.workflow_variants) {
                var variantVal = values[tpl.variant_key];
                // variant_map 将参数值映射到 variant key，未匹配的用原值
                var variantKey = (tpl.variant_map && tpl.variant_map[variantVal]) || variantVal;
                workflowTemplate = tpl.workflow_variants[variantKey];
                if (!workflowTemplate) {
                    throw new Error('不支持的模型: ' + variantVal + '（模板: ' + templateId + '）');
                }
            } else {
                workflowTemplate = tpl.workflow;
            }

            // Custom workflows: directly set values by nodeId_inputKey
            if (tpl.mode === 'custom') {
                var workflow = JSON.parse(JSON.stringify(workflowTemplate || tpl.workflow));
                // key→{nodeId, inputKey} 优先用模板 params 定义反解。param 的
                // key 本就是 _sanitizeKey(nodeId + '_' + inputKey) 的编码产物（与 values
                // 里的 key 天然一致），param 定义自带精确的 nodeId/inputKey；而 split('_')
                // 是非对称反解——节点 ID 含下划线（如 KSampler_1）时 'KSampler_1_seed'
                // 会被切成 nodeId='KSampler' 找不到节点，表单参数静默失效。映射未命中
                // （旧模板遗留 key）回退 split 逻辑保持兼容。
                var _paramMap = {};
                (tpl.parameters || []).forEach(function (p) {
                    if (p && p.key && p.nodeId !== undefined && p.inputKey !== undefined) {
                        _paramMap[p.key] = { nodeId: p.nodeId, inputKey: p.inputKey };
                    }
                });
                Object.keys(values).forEach(function (key) {
                    var nodeId, inputKey;
                    var _pm = _paramMap[key];
                    if (_pm) {
                        nodeId = _pm.nodeId;
                        inputKey = _pm.inputKey;
                    } else {
                        var parts = key.split('_');
                        if (parts.length < 2) return;
                        nodeId = parts[0];
                        inputKey = parts.slice(1).join('_');
                    }
                    var val = values[key];
                    // seed=-1 时随机生成
                    if (/seed/i.test(inputKey) && (val === -1 || val === '-1')) {
                        val = Math.floor(Math.random() * 2147483647);
                    }
                    var curInput = (workflow[nodeId] && workflow[nodeId].inputs)
                        ? workflow[nodeId].inputs[inputKey] : undefined;
                    // 连接引用（数组）与对象型 widget 值（{__value__: [...]} 等，含 null）是服务端
                    // 原值：同名调用方值不得把它们覆盖成字符串。输入不存在时仍按 values 新增。
                    if (workflow[nodeId] && workflow[nodeId].inputs && typeof curInput !== 'object') {
                        workflow[nodeId].inputs[inputKey] = val;
                    }
                });
                return workflow;
            }

            // Preset templates: {{key}} placeholder substitution
            // 模板里占位符都带引号（"{{key}}"），替换时连带引号一起换：
            // 字符串 → "escaped"，number/boolean → 裸 token（7 / true / false）。
            // 若只换占位符文本，boolean false 会被插进引号变成字符串 "false"，
            // 在 ComfyUI(Python) 里是 truthy → 水印开关恒开。number 同理变成 "7" 字符串。
            // ⚠️ key 允许点号（model.aspect_ratio 等 DynamicCombo 嵌套 key）——\w+ → [\w.]+
            var workflowStr = JSON.stringify(workflowTemplate);
            var _unreplacedKeys = [];
            workflowStr = workflowStr.replace(/"?\{\{([\w.]+)\}\}"?/g, function (match, key) {
                var val = values[key];
                if (val === undefined || val === null) {
                    // 未提供值：还原成带引号占位符，交给 removeUnreplacedPlaceholders 删除
                    _unreplacedKeys.push(key);
                    return '"{{' + key + '}}"';
                }
                if (key === 'seed' && (val === -1 || val === '-1')) {
                    var rseed = Math.floor(Math.random() * 2147483647);
                    return String(rseed);
                }
                if (typeof val === 'string') return '"' + escapeJsonString(val) + '"';
                return JSON.stringify(val);
            });

            if (_unreplacedKeys.length > 0) {
                console.warn('[TemplateEngine] 未替换占位符 (' + _unreplacedKeys.length + '):',
                    _unreplacedKeys.join(', '),
                    '— 模型=' + modelId + ', 可用参数=' + (values ? Object.keys(values).join(',') : '(无)'));
            }

            // 移除未替换的可选参数（值仍为 {{key}} 的占位符）
            var workflow = JSON.parse(workflowStr);
            removeUnreplacedPlaceholders(workflow);
            return workflow;
        }

        function loadCustomWorkflow(jsonString) {
            var workflow = JSON.parse(jsonString);
            var parameters = [];

            Object.keys(workflow).forEach(function (nodeId) {
                var node = workflow[nodeId];
                if (!node || !node.class_type || !node.inputs) return;

                Object.keys(node.inputs).forEach(function (inputKey) {
                    var val = node.inputs[inputKey];
                    // 只有可文本/数值/布尔编辑的原始值建参数：连接引用（[nodeId, slot] 数组）、
                    // 对象型 widget 值（{__value__: [...]} 等）与 null 是服务端直接消费的字面值，
                    // 不建参数，workflow 内保持原样。
                    if (typeof val === 'object') return;

                    var param = {
                        key: _sanitizeKey(nodeId + '_' + inputKey),
                        nodeId: nodeId,
                        inputKey: inputKey,
                        label: inputKey,
                        type: 'text',
                        default: val
                    };

                    if (typeof val === 'number') {
                        param.type = 'number';
                        param.step = Number.isInteger(val) ? 1 : 0.1;
                        // Set reasonable min/max based on value and key name
                        if (/width|height|size|resolution/i.test(inputKey)) {
                            param.min = 64;
                            param.max = 4096;
                            param.step = 64;
                        } else if (/seed/i.test(inputKey)) {
                            param.min = -1;
                            param.max = 2147483647;
                        } else if (/step/i.test(inputKey)) {
                            param.min = 1;
                            param.max = 150;
                        } else if (/cfg|scale|weight|strength|denoise/i.test(inputKey)) {
                            param.min = 0;
                            param.max = 30;
                            param.step = 0.1;
                        } else if (val > 1000) {
                            param.min = 0;
                            param.max = _finiteNum(val * 2);
                        }
                    } else if (typeof val === 'boolean') {
                        param.type = 'boolean';
                    } else if (typeof val === 'string') {
                        param.type = val.length > 50 ? 'textarea' : 'text';
                    }

                    parameters.push(param);
                });
            });

            // 注册前查重——已存在 workflow 内容（JSON.stringify 深比较）相同的
            // custom 模板时复用既有条目（替换 parameters 保持最新解析结果并返回既有 id），
            // 避免会话内重复导入同一工作流使注册表与模板下拉无限累积
            var wfStr = JSON.stringify(workflow);
            var existIds = Object.keys(templates);
            for (var ei = 0; ei < existIds.length; ei++) {
                var existTpl = templates[existIds[ei]];
                if (existTpl && existTpl.mode === 'custom' && existTpl.workflow &&
                    JSON.stringify(existTpl.workflow) === wfStr) {
                    existTpl.parameters = parameters;
                    return existTpl;
                }
            }

            var id = 'custom_' + Date.now();
            var tpl = {
                id: id,
                name: '自定义工作流',
                category: 'custom',
                mode: 'custom',
                parameters: parameters,
                workflow: workflow
            };
            templates[id] = tpl;
            return tpl;
        }

        function validateWorkflow(workflowJson) {
            var errors = [];
            if (!workflowJson || typeof workflowJson !== 'object') {
                return { valid: false, errors: ['工作流必须是 JSON 对象'] };
            }

            Object.keys(workflowJson).forEach(function (nodeId) {
                var node = workflowJson[nodeId];
                if (!node.class_type) {
                    errors.push('节点 ' + nodeId + ' 缺少 class_type');
                }
                if (!node.inputs || typeof node.inputs !== 'object') {
                    errors.push('节点 ' + nodeId + ' 缺少 inputs');
                }
            });

            return { valid: errors.length === 0, errors: errors };
        }

        function loadRegistry(jsonString) {
            if (!_registry) throw new Error('modelRegistry 未注入');
            _registry.load(jsonString);
        }

        async function fetchModelSchema(modelId) {
            var m = _registry ? _registry.getById(modelId) : null;
            if (!m) throw new Error('未知模型: ' + modelId);
            if (!m.classType) throw new Error('模型 ' + modelId + ' 无 classType');

            var classType = m.classType;

            // 查缓存
            var cached = _registry.getSchema(modelId);
            if (cached) return cached;

            // 防并发重复请求
            var pending = _registry.getPending(classType);
            if (pending) return pending;

            if (!_service) throw new Error('service 未注入，无法拉取 schema: ' + classType);

            var promise = _service.getObjectInfo(classType).then(function (data) {
                _registry.setSchema(classType, data);
                _registry.clearPending(classType);
                return data;
            }).catch(function (e) {
                _registry.clearPending(classType);
                throw e;
            });

            _registry.setPending(classType, promise);
            return promise;
        }

        // 在 COMFY_DYNAMICCOMBO_V3 的 options 中按 key 匹配目标 option
        // 返回该 option 的 inputs 对象 {required:{...}, optional:{...}}，找不到返 null
        function _findDynamicComboOption(spec, targetValue) {
            var typeStr = spec[0];
            if (typeStr !== 'COMFY_DYNAMICCOMBO_V3') return null;
            var opts = (spec[1] && spec[1].options) || [];
            if (!opts.length) return null;
            // 优先精确匹配
            if (targetValue) {
                for (var i = 0; i < opts.length; i++) {
                    if (opts[i].key === targetValue) return opts[i].inputs || null;
                }
            }
            // 未匹配 → 合并所有 option 的子参数（确保不漏，ComfyUI 更新不丢参数）
            return _mergeDynamicComboInputs(opts);
        }

        function _mergeDynamicComboInputs(opts) {
            var merged = { required: {}, optional: {} };
            for (var i = 0; i < opts.length; i++) {
                var inputs = opts[i].inputs;
                if (!inputs) continue;
                var req = inputs.required || {};
                var opt = inputs.optional || {};
                Object.keys(req).forEach(function (k) { merged.required[k] = req[k]; });
                Object.keys(opt).forEach(function (k) { merged.optional[k] = opt[k]; });
            }
            return merged;
        }

        // 参数 key 白名单清洗：只允许字母/数字/下划线/点/短横。
        // key 会拼入 view 的 data-key 属性与 querySelector，来源（/object_info 响应、
        // 用户导入的工作流 JSON）外部可控，必须在生成源头清洗一次——下游渲染、
        // 事件绑定、参数查找统一使用这同一把清洗后的 key，不再各自清洗。
        function _sanitizeKey(key) {
            return String(key).replace(/[^A-Za-z0-9_.-]/g, '_');
        }

        // 数值兜底：强制 Number，非有限数 → undefined（下游跳过该属性输出）。
        // 挡住 "1\" onfocus=..." 这类字符串/异常值进入 min/max/step 属性。
        function _finiteNum(v) {
            var n = Number(v);
            return Number.isFinite(n) ? n : undefined;
        }

        // 单个输入规格 → 参数定义
        function _convertInputSpec(key, spec, isRequired, model) {
            // 跳过 model 参数（由 registry modelValue 注入，不在面板展示）
            var modelKey = model ? model.modelKey : null;
            if ((modelKey && key === modelKey) || key === 'model_name' || key === 'modelId') return null;

            // 跳过 IMAGE / LATENT / MASK 类型（走节点连线，不在参数面板）
            var typeInfo = spec[0];
            var typeStr = Array.isArray(typeInfo) ? 'COMBO' : typeInfo;
            if (typeStr === 'IMAGE' || typeStr === 'LATENT' || typeStr === 'MASK' || typeStr === 'COMFY_AUTOGROW_V3') return null;
            // 跳过非 model 的 DynamicCombo，V1 不递归展开
            if (typeStr === 'COMFY_DYNAMICCOMBO_V3') return null;

            var opts = spec[1] || {};
            var param = {
                key: _sanitizeKey(key),
                label: _labelFromKey(key),
                required: isRequired,
                default: opts.default
            };

            if (Array.isArray(typeInfo)) {
                // COMBO: typeInfo 本身就是选项数组
                param.type = 'select';
                param.choices = typeInfo;
            } else if (typeStr === 'COMBO') {
                // COMBO 作为类型字符串，options 在 spec[1].options
                param.type = 'select';
                param.choices = opts.options || [];
            } else if (typeStr === 'INT') {
                param.type = 'number';
                param.step = (opts.step !== undefined) ? _finiteNum(opts.step) : 1;
                if (opts.min !== undefined) param.min = _finiteNum(opts.min);
                if (opts.max !== undefined) param.max = _finiteNum(opts.max);
            } else if (typeStr === 'FLOAT') {
                param.type = 'number';
                param.step = (opts.step !== undefined) ? _finiteNum(opts.step) : 0.1;
                if (opts.min !== undefined) param.min = _finiteNum(opts.min);
                if (opts.max !== undefined) param.max = _finiteNum(opts.max);
            } else if (typeStr === 'BOOLEAN') {
                param.type = 'boolean';
            } else if (typeStr === 'STRING') {
                param.type = opts.multiline ? 'textarea' : 'text';
            }

            return param;
        }

        function _labelFromKey(key) {
            var map = {
                'prompt': '提示词', 'negative_prompt': '负面提示词',
                'prompt_text': '提示词', 'width': '宽度', 'height': '高度',
                'model': '模型', 'seed': '随机种子', 'steps': '步数', 'cfg': 'CFG',
                'denoise': '降噪强度', 'batch_size': '批量', 'duration': '时长',
                'mode': '模式', 'aspect_ratio': '宽高比', 'quality': '质量',
                'style': '风格', 'watermark': '水印', 'safe_mode': '安全模式',
                'prompt_optimizer': '提示词优化', 'n': '生成数量',
                'resolution': '分辨率', 'size_preset': '尺寸预设',
                'size': '尺寸', 'background': '背景', 'custom_width': '自定义宽度',
                'custom_height': '自定义高度'
            };
            // 先查完整 key（含 dot notation），再查最后一段
            if (map[key]) return map[key];
            var dotIdx = key.lastIndexOf('.');
            var lastSeg = dotIdx >= 0 ? key.slice(dotIdx + 1) : key;
            return map[lastSeg] || lastSeg;
        }

        // modelValueOverride: 可选，用户当前选择的 model 值（用于 DynamicCombo 子参数联动）
        // 不传则用 registry 中固定的 m.modelValue（向后兼容）
        function schemaToParams(schema, modelId, modelValueOverride) {
            var m = _registry ? _registry.getById(modelId) : null;
            if (!schema || !schema.input) return [];

            var params = [];
            var required = schema.input.required || {};
            var optional = schema.input.optional || {};

            // 用户切换 model select 后，用 override 值匹配 DynamicCombo option
            var _effectiveModelValue = (modelValueOverride !== undefined) ? modelValueOverride : (m ? m.modelValue : null);

            function processParams(source, isReq) {
                Object.keys(source).forEach(function (key) {
                    var spec = source[key];
                    var typeInfo = spec[0];
                    var typeStr = Array.isArray(typeInfo) ? 'COMBO' : typeInfo;
                    var dcInputs = _findDynamicComboOption(spec, _effectiveModelValue);
                    if (dcInputs) {
                        // DynamicCombo 自身作为可选项（多选时生成 select，让用户切换模型版本）
                        if (typeStr === 'COMFY_DYNAMICCOMBO_V3') {
                            var dcOpts = (spec[1] && spec[1].options) || [];
                            if (dcOpts.length > 1) {
                                params.push({
                                    key: _sanitizeKey(key),
                                    label: _labelFromKey(key),
                                    type: 'select',
                                    choices: dcOpts.map(function (o) { return o.key; }),
                                    default: m ? m.modelValue : (dcOpts[0] ? dcOpts[0].key : ''),
                                    required: true
                                });
                            }
                        }
                        var dcPrefix = key + '.';
                        var dcReq = dcInputs.required || {};
                        var dcOpt = dcInputs.optional || {};
                        Object.keys(dcReq).forEach(function (subKey) {
                            var p = _convertInputSpec(dcPrefix + subKey, dcReq[subKey], true, m);
                            if (p) params.push(p);
                        });
                        Object.keys(dcOpt).forEach(function (subKey) {
                            var p = _convertInputSpec(dcPrefix + subKey, dcOpt[subKey], false, m);
                            if (p) params.push(p);
                        });
                        return;
                    }
                    var p = _convertInputSpec(key, spec, isReq, m);
                    if (p) params.push(p);
                });
            }

            processParams(required, true);
            processParams(optional, false);

            // schema 拉到了但解析出 0 个参数 → 多半 classType 拉到了空节点 / 节点被改名
            if (params.length === 0) {
                console.warn('[TemplateEngine] schemaToParams 解析出 0 个参数 — modelId=' + modelId +
                    ', classType=' + (m && m.classType) +
                    ', schema.input keys=' + JSON.stringify(Object.keys((schema && schema.input) || {})) +
                    '（检查 classType 是否正确、节点是否已升级）');
            }
            return params;
        }

        // 从 schema 提取所有 IMAGE 类型端口（含 DynamicCombo 嵌套）
        function extractSchemaImagePorts(schema, model) {
            if (!schema || !schema.input) return [];
            var ports = [];
            var required = schema.input.required || {};
            var optional = schema.input.optional || {};

            function scanSource(source) {
                Object.keys(source).forEach(function (key) {
                    var spec = source[key];
                    var typeInfo = spec[0];
                    var typeStr = Array.isArray(typeInfo) ? 'COMBO' : typeInfo;
                    if (typeStr === 'IMAGE') ports.push(key);
                    if (typeStr === 'COMFY_DYNAMICCOMBO_V3') {
                        var dcInputs = _findDynamicComboOption(spec, model ? model.modelValue : null);
                        if (dcInputs) {
                            var dcPrefix = key + '.';
                            var dcReq = dcInputs.required || {};
                            var dcOpt = dcInputs.optional || {};
                            function scanDC(dict) {
                                Object.keys(dict).forEach(function (subKey) {
                                    var subSpec = dict[subKey];
                                    if (subSpec && typeof subSpec === 'object' && !Array.isArray(subSpec)) {
                                        Object.keys(subSpec).forEach(function (innerKey) {
                                            var innerSpec = subSpec[innerKey];
                                            var innerType = Array.isArray(innerSpec[0]) ? 'COMBO' : innerSpec[0];
                                            if (innerType === 'IMAGE') ports.push(dcPrefix + subKey + '.' + innerKey);
                                        });
                                    } else if (Array.isArray(subSpec)) {
                                        var subType = Array.isArray(subSpec[0]) ? 'COMBO' : subSpec[0];
                                        if (subType === 'IMAGE') ports.push(dcPrefix + subKey);
                                    }
                                });
                            }
                            scanDC(dcReq);
                            scanDC(dcOpt);
                        }
                    }
                });
            }
            scanSource(required);
            scanSource(optional);
            return ports;
        }

        // 自适应图片端口映射：端口改名时按位置映射，多图续 key 保留原 key
        function mapImagePorts(imageFilenames, registryImgKeys, schemaImgPorts) {
            var result = {};
            // 功能不退化：schema 缺失 / DynamicCombo option 未匹配 → schemaImgPorts 为空时
            // 原样透传所有 imageFilenames，否则丢全部图（比 buildDynamicWorkflow 少建 LoadImage）
            if (!schemaImgPorts || schemaImgPorts.length === 0) {
                var _passthroughKeys = Object.keys(imageFilenames);
                for (var _pi = 0; _pi < _passthroughKeys.length; _pi++) {
                    result[_passthroughKeys[_pi]] = imageFilenames[_passthroughKeys[_pi]];
                }
                console.warn('[TemplateEngine] mapImagePorts schemaImgPorts 为空，原样透传图片');
                return result;
            }
            var imgKeys = Object.keys(imageFilenames);
            for (var i = 0; i < imgKeys.length; i++) {
                var key = imgKeys[i];
                var filename = imageFilenames[key];
                // 情况1：key 在 schema 里 → 直接用
                if (schemaImgPorts.indexOf(key) >= 0) {
                    result[key] = filename;
                    continue;
                }
                // 情况1.5：多图续 key（baseKey + _N）
                // schema 只声明 _1，_2/_3 等是运行时动态扩展端口。
                // 如果 key 的 baseKey + _1 在 schema 里，保留原 key（否则多图会覆盖丢图）。
                var keyMatch = key.match(/^(.+)_(\d+)$/);
                if (keyMatch) {
                    var keyBase = keyMatch[1];
                    if (schemaImgPorts.indexOf(keyBase + '_1') >= 0) {
                        result[key] = filename;
                        continue;
                    }
                }
                // 情况2：key 不在 schema（改名了）→ 按位置映射
                var regIdx = registryImgKeys.indexOf(key);
                if (regIdx >= 0 && regIdx < schemaImgPorts.length) {
                    var newPort = schemaImgPorts[regIdx];
                    result[newPort] = filename;
                    continue;
                }
                // 情况3：回退到 schema 第一个端口
                if (schemaImgPorts.length > 0) {
                    var _fbPort = schemaImgPorts[0];
                    // 同端口已被本次映射占用：保留先到的图并告警，不再静默覆盖
                    // （无 _N 后缀注册键的多图上传全走此回退时，后图覆盖前图 → 静默丢图）
                    if (result[_fbPort] !== undefined) {
                        console.warn('[TemplateEngine] 图片端口冲突: ' + _fbPort + ' 已被 ' +
                            result[_fbPort] + ' 占用，丢弃 ' + key + ' → ' + filename +
                            '（模型图片端口数不足或 key 失配，请检查 imageInputKeys）');
                        continue;
                    }
                    result[_fbPort] = filename;
                    console.warn('[TemplateEngine] 图片端口回退: ' + key + ' → ' + _fbPort);
                }
            }
            return result;
        }

        function buildSchemaDrivenWorkflow(model, schema, paramValues, imageFilenames, videoFilenames) {
            var wf = {};
            var nextNodeId = 1;
            var mainNodeId = String(nextNodeId++);
            var inputs = {};

            // 1. 注入 model 值（用户在表单切换的版本优先，兜底用 registry modelValue）
            var modelKey = model.modelKey || null;
            if (modelKey) {
                if (paramValues && paramValues[modelKey] !== undefined) {
                    inputs[modelKey] = paramValues[modelKey];
                } else if (model.modelValue) {
                    inputs[modelKey] = model.modelValue;
                }
            }

            // 2. 自适应图片端口映射
            var schemaImgPorts = extractSchemaImagePorts(schema, model);
            var registryImgKeys = model.imageInputKeys || [];
            var mappedImgPorts = mapImagePorts(imageFilenames || {}, registryImgKeys, schemaImgPorts);

            // 3. 视频端口映射（原样用）
            var mappedVidPorts = {};
            var vidKeys = Object.keys(videoFilenames || {});
            for (var vi = 0; vi < vidKeys.length; vi++) {
                mappedVidPorts[vidKeys[vi]] = videoFilenames[vidKeys[vi]];
            }

            // 4. 填用户参数（跳过内部 key、model key、所有端口 key）
            var paramKeys = paramValues ? Object.keys(paramValues) : [];
            var INTERNAL_KEYS = { imageOrder: 1, videoOrder: 1, width: 1, height: 1, modelId: 1, _result: 1 };
            var promptKey = model.promptKey || 'prompt';
            var _skipPortKeys = {};
            var _regImgK = model.imageInputKeys || [];
            for (var _si = 0; _si < _regImgK.length; _si++) _skipPortKeys[_regImgK[_si]] = 1;
            for (var _sj = 0; _sj < schemaImgPorts.length; _sj++) _skipPortKeys[schemaImgPorts[_sj]] = 1;
            var _regVidK = model.videoInputKeys || [];
            for (var _sv = 0; _sv < _regVidK.length; _sv++) _skipPortKeys[_regVidK[_sv]] = 1;
            // 多图续 key：baseKey + _N
            for (var _bk = 0; _bk < _regImgK.length; _bk++) {
                var _baseKey = _regImgK[_bk].replace(/_\d+$/, '');
                if (_baseKey !== _regImgK[_bk]) {
                    for (var _bn = 1; _bn <= 20; _bn++) _skipPortKeys[_baseKey + '_' + _bn] = 1;
                }
            }
            // 功能不退化：buildDynamicWorkflow 跳过 input_image / reference_image_1..3 这些
            // pipeline 模板占位符参数（误入 non-pipeline 路径时不污染主节点 inputs），此处保持一致
            _skipPortKeys['input_image'] = 1;
            _skipPortKeys['reference_image_1'] = 1;
            _skipPortKeys['reference_image_2'] = 1;
            _skipPortKeys['reference_image_3'] = 1;
            for (var i = 0; i < paramKeys.length; i++) {
                var k = paramKeys[i];
                if (INTERNAL_KEYS[k]) continue;
                if (k.charAt(0) === '_') continue;  // 画布内部状态键（_frameHTMLs/_batchCurIdx 等）不发给 ComfyUI
                if (k === modelKey) continue;
                if (_skipPortKeys[k]) continue;
                if (mappedImgPorts[k]) continue;
                if (mappedVidPorts[k]) continue;
                var v = paramValues[k];
                var targetKey = (k === 'prompt') ? promptKey : k;
                if (targetKey === 'seed' && (v === -1 || v === '-1')) {
                    v = Math.floor(Math.random() * 2147483647);
                }
                inputs[targetKey] = v;
            }

            // 5. 建 LoadImage 节点
            var mappedImgKeys = Object.keys(mappedImgPorts);
            for (var j = 0; j < mappedImgKeys.length; j++) {
                var imgPortKey = mappedImgKeys[j];
                var loaderId = String(nextNodeId++);
                wf[loaderId] = { class_type: 'LoadImage', inputs: { image: mappedImgPorts[imgPortKey] } };
                inputs[imgPortKey] = [loaderId, 0];
            }

            // 6. 建 LoadVideo 节点
            var mappedVidKeys = Object.keys(mappedVidPorts);
            for (var vj = 0; vj < mappedVidKeys.length; vj++) {
                var vidPortKey = mappedVidKeys[vj];
                var vLoaderId = String(nextNodeId++);
                wf[vLoaderId] = { class_type: 'LoadVideo', inputs: { file: mappedVidPorts[vidPortKey] } };
                inputs[vidPortKey] = [vLoaderId, 0];
            }

            // 7. 主节点
            wf[mainNodeId] = { class_type: model.classType, inputs: inputs };

            // 8. 输出节点
            var outputNodeId = String(nextNodeId++);
            var prefix = 'nodegen_' + (model.id || 'gen');
            if (model.category === 'video') {
                // ComfyUI ≥0.33 的 SaveVideo.execute 把 format 定为必填位置参数；
                // 缺 format 会在执行期报 TypeError（提交阶段不校验）。auto = MP4(H.264)/WebM(AV1) 自选。
                wf[outputNodeId] = {
                    class_type: 'SaveVideo',
                    inputs: { filename_prefix: prefix, video: [mainNodeId, 0], format: 'auto', codec: 'auto' }
                };
            } else {
                wf[outputNodeId] = { class_type: 'SaveImage', inputs: { filename_prefix: prefix, images: [mainNodeId, 0] } };
            }

            // 功能不退化：对齐 buildDynamicWorkflow 的详细日志（端口映射 + input key 一览，便于排查端口/参数丢失）
            console.log('[TemplateEngine] buildSchemaDrivenWorkflow 主节点', model.classType,
                '| schemaImgPorts:', JSON.stringify(schemaImgPorts),
                '| mappedImgPorts:', JSON.stringify(mappedImgPorts),
                '| mappedVidPorts:', JSON.stringify(mappedVidPorts),
                '| imageFilenames keys:', JSON.stringify(Object.keys(imageFilenames || {})),
                '| inputKeys:', JSON.stringify(Object.keys(inputs)));

            var _validation = validateWorkflowAgainstSchema(wf, schema, model);
            if (!_validation.valid) {
                console.warn('[TemplateEngine] buildSchemaDrivenWorkflow 校验未通过:', _validation.errors);
            }

            return wf;
        }

        function validateWorkflowAgainstSchema(workflow, schema, model) {
            var errors = [];
            if (!workflow || !schema || !model || !model.classType) return { valid: true, errors: errors };
            var mainNode = null;
            Object.keys(workflow).forEach(function (nid) {
                if (workflow[nid].class_type === model.classType) mainNode = workflow[nid];
            });
            if (!mainNode) return { valid: true, errors: errors };

            var validKeys = {};
            var schemaInput = schema.input || {};
            var req = schemaInput.required || {};
            var opt = schemaInput.optional || {};
            Object.keys(req).forEach(function (k) { validKeys[k] = 1; });
            Object.keys(opt).forEach(function (k) { validKeys[k] = 1; });
            // DynamicCombo 嵌套 key
            Object.keys(req).forEach(function (k) {
                var spec = req[k];
                if (spec[0] === 'COMFY_DYNAMICCOMBO_V3') {
                    var dcInputs = _findDynamicComboOption(spec, model.modelValue);
                    if (dcInputs) {
                        var dcReq = dcInputs.required || {}, dcOpt = dcInputs.optional || {};
                        function collectDC(dict) {
                            Object.keys(dict).forEach(function (subKey) {
                                var subSpec = dict[subKey];
                                if (subSpec && typeof subSpec === 'object' && !Array.isArray(subSpec)) {
                                    Object.keys(subSpec).forEach(function (innerKey) {
                                        validKeys[k + '.' + subKey + '.' + innerKey] = 1;
                                    });
                                } else {
                                    validKeys[k + '.' + subKey] = 1;
                                }
                            });
                        }
                        collectDC(dcReq);
                        collectDC(dcOpt);
                    }
                }
            });

            var inputKeys = Object.keys(mainNode.inputs || {});
            for (var i = 0; i < inputKeys.length; i++) {
                var ik = inputKeys[i];
                if (validKeys[ik]) continue;
                // 多图续 key 合法化：baseKey + _N 如果 baseKey + _1 在 validKeys 里，则合法
                var ikMatch = ik.match(/^(.+)_\d+$/);
                if (ikMatch && validKeys[ikMatch[1] + '_1']) continue;
                errors.push('主节点 inputs 含未知 key: ' + ik + '（不在 schema ' + model.classType + ' 的 input 里）');
            }
            return { valid: errors.length === 0, errors: errors };
        }

        // 从 registry 的 imageInputKeys/videoInputKeys 逐键派生参考图/视频上传槽参数。
        // schemaToParams._convertInputSpec 过滤了 IMAGE/VIDEO 类型端口，non-pipeline 表单的
        // 上传槽由此补回。getModelParams 与 refreshModelParams 共用（切换 model 版本后槽不丢）。
        // 槽语义按 registry 键是否带 _N 后缀区分（与画布 runGenWorkflow 的多图续 key 口径一致）：
        //   - 带 _N 后缀（model.images.image_1）：多图续 key 模型 → baseKey 一个 multiple 槽
        //     （表单 slot 产生 baseKey_1.._N，mapImagePorts 情况1.5 命中 schema 的 _1 声明）
        //   - 无 _N 后缀（first_frame/last_frame）：单图端口 → 每键一个独立单图槽。
        //     若只从首键派生一个 multiple 槽：多端口模型（seedance2_i2v）的后续端口
        //     在表单无法设置，且多图槽的 _N 续 key 对无后缀模型在 mapImagePorts 三种匹配
        //     全部落空，走回退全部折叠到首个端口互相覆盖。
        function _deriveMediaSlots(params, m) {
            var _imgKeys = m.imageInputKeys || [];
            for (var _ik = 0; _ik < _imgKeys.length; _ik++) {
                var _rawImgKey = _imgKeys[_ik];
                var _imgSlotKey = _sanitizeKey(_rawImgKey.replace(/_\d+$/, ''));
                var _hasImgSlot = params.some(function (p) { return p.key === _imgSlotKey; });
                if (!_hasImgSlot) {
                    if (/_\d+$/.test(_rawImgKey)) {
                        params.push({ key: _imgSlotKey, label: AEI18n.t('参考图片(可选)'), type: 'image', multiple: true, maxCount: 20 });
                    } else {
                        params.push({ key: _imgSlotKey, label: _labelFromKey(_rawImgKey), type: 'image' });
                    }
                }
            }
            var _vidKeys = m.videoInputKeys || [];
            for (var _vk = 0; _vk < _vidKeys.length; _vk++) {
                var _rawVidKey = _vidKeys[_vk];
                var _vidSlotKey = _sanitizeKey(_rawVidKey.replace(/_\d+$/, ''));
                var _hasVidSlot = params.some(function (p) { return p.key === _vidSlotKey; });
                if (!_hasVidSlot) {
                    if (/_\d+$/.test(_rawVidKey)) {
                        params.push({ key: _vidSlotKey, label: AEI18n.t('参考视频(可选)'), type: 'video', multiple: true, maxCount: 10 });
                    } else {
                        params.push({ key: _vidSlotKey, label: _labelFromKey(_rawVidKey), type: 'video' });
                    }
                }
            }
            return params;
        }

        async function getModelParams(modelId) {
            var m = _registry ? _registry.getById(modelId) : null;
            if (!m) return [];

            // 非 pipeline：动态拉 schema
            if (!m.pipeline && m.classType) {
                try {
                    var schema = await fetchModelSchema(modelId);
                    var params = schemaToParams(schema, modelId);
                    // non-pipeline 表单需要图片上传槽：schemaToParams._convertInputSpec 过滤了
                    // IMAGE 类型端口，这里从 imageInputKeys 派生图片槽参数
                    // 过滤 _convertInputSpec 对嵌套 dict（如 images:{image_1:[...]}) 产生的残破参数（type=undefined）
                    params = params.filter(function (p) { return p.type; });
                    params = _deriveMediaSlots(params, m);
                    // 功能不退化：schema 可能缺字段（旧模型未升级 / ComfyUI 节点未补全 schema），
                    // 从模板 JSON 合并 schema 没有的非图/非视频参数，保证表单参数只多不少
                    var _tpl = templates[m.templateId || m.id];
                    if (_tpl && _tpl.parameters) {
                        var _schemaKeys = {};
                        params.forEach(function (p) { _schemaKeys[p.key] = 1; });
                        // DynamicCombo 子参数在 schema 里是 modelKey.xxx，模板里是 xxx，
                        // 需同时检查两种 key 避免重复合并导致参数重复
                        var _dcPrefix = m.modelKey ? (m.modelKey + '.') : '';
                        _tpl.parameters.forEach(function (tp) {
                            if (tp.type === 'image' || tp.type === 'video') return;
                            if (_schemaKeys[tp.key]) {
                                // schema 有同 key 但可能缺 default -> 从模板补充默认值
                                for (var _si = 0; _si < params.length; _si++) {
                                    if (params[_si].key === tp.key && params[_si].default === undefined && tp.default !== undefined) {
                                        params[_si].default = tp.default;
                                        break;
                                    }
                                }
                                return;
                            }
                            if (_dcPrefix && _schemaKeys[_dcPrefix + tp.key]) return;
                            params.push(tp);
                        });
                    }
                    return params;
                } catch (e) {
                    // schema 拉取失败常见原因：ComfyUI 节点升级后 classType 改名 / 节点被移除。
                    // 回退到模板 parameters 后参数面板仍能用（模板内置），但 buildDynamicWorkflow
                    // 仍用 model.classType 提交 → ComfyUI 会报 unknown node / 端口名错。
                    // 此日志帮快速定位：对照 registry classType 与 ComfyUI 实际节点名。
                    console.warn('[TemplateEngine] schema 拉取失败 — modelId=' + modelId +
                        ', classType=' + m.classType +
                        ', err=' + (e && e.message) +
                        '（检查 ComfyUI 节点是否已升级/改名，对照 template-list.json 的 classType）');
                }
            }

            // pipeline 或 动态拉失败：回退 JSON parameters
            var tpl = templates[m.templateId || m.id];
            var params = (tpl && tpl.parameters) || [];
            // schema 拉取失败的 non-pipeline 回退：模板 image/video 槽 key 可能与 registry 键
            // 不一致（如 seedream 模板 reference_image vs registry model.images.image_1），
            // controller.generate 只按 registry 键收集表单文件 → 已上传文件名残留在 values，
            // 被 buildDynamicWorkflow/buildSchemaDrivenWorkflow 的端口跳过表静默丢弃（_1.._3）
            // 或作为未知输入塞主节点触发 unknown kwarg（_4..N）。剔除与 registry 键不一致的
            // 模板图/视频槽并按 registry 派生（与 schema 成功路径同口径）；key 一致的模板槽
            // （如 hailuo first_frame_image、seedance2_i2v first_frame/last_frame）原样保留。
            if (!m.pipeline && m.classType) {
                var _fbImgKeys = m.imageInputKeys || [];
                var _fbVidKeys = m.videoInputKeys || [];
                params = params.filter(function (p) {
                    if (p.type !== 'image' && p.type !== 'video') return true;
                    var pool = (p.type === 'image') ? _fbImgKeys : _fbVidKeys;
                    return pool.indexOf(p.key) >= 0 || pool.indexOf(p.key.replace(/_\d+$/, '')) >= 0;
                });
                params = _deriveMediaSlots(params, m);
            }
            return params;
        }

        // 刷新模型参数（用户切换 model select 后调用）
        // modelValue: 用户当前选择的 model 值（DynamicCombo option key）
        // 返回新参数列表，DynamicCombo 子参数按新 modelValue 匹配；非 DynamicCombo 参数不变
        // 复用 getModelParams 的 schema 拉取 + 模板合并逻辑，仅 override modelValue
        async function refreshModelParams(modelId, modelValue) {
            var m = _registry ? _registry.getById(modelId) : null;
            if (!m || m.pipeline || !m.classType) {
                // pipeline 或无 schema：参数不随 model 值变化，直接返回原参数
                return getModelParams(modelId);
            }
            var schema = _registry.getSchema(modelId);
            if (!schema) {
                // schema 未缓存：拉取后用 override 生成
                try { schema = await fetchModelSchema(modelId); }
                catch (e) { return getModelParams(modelId); }
            }
            var params = schemaToParams(schema, modelId, modelValue);
            params = params.filter(function (p) { return p.type; });
            // 切换 model 版本后同样派生图/视频上传槽（与 getModelParams 一致），否则表单重建丢参考图槽
            params = _deriveMediaSlots(params, m);
            // 合并模板参数（与 getModelParams 同逻辑）
            var _tpl = templates[m.templateId || m.id];
            if (_tpl && _tpl.parameters) {
                var _schemaKeys = {};
                params.forEach(function (p) { _schemaKeys[p.key] = 1; });
                var _dcPrefix = m.modelKey ? (m.modelKey + '.') : '';
                _tpl.parameters.forEach(function (tp) {
                    if (tp.type === 'image' || tp.type === 'video') return;
                    if (_schemaKeys[tp.key]) return;
                    if (_dcPrefix && _schemaKeys[_dcPrefix + tp.key]) return;
                    params.push(tp);
                });
            }
            return params;
        }

        function buildDynamicWorkflow(model, paramValues, imageFilenames, videoFilenames) {
            var wf = {};
            var nextNodeId = 1;
            var mainNodeId = String(nextNodeId++);
            var inputs = {};

            // --- 注入 model 值 ---
            // 优先用用户选择的值（paramValues[modelKey]），兜底 model.modelValue
            // 与 buildSchemaDrivenWorkflow 逻辑一致，否则切换 model 版本（如 gpt-image-1 vs gpt-image-2）不生效
            var modelKey = model.modelKey || null;
            if (modelKey) {
                if (paramValues && paramValues[modelKey] !== undefined) {
                    inputs[modelKey] = paramValues[modelKey];
                } else if (model.modelValue) {
                    inputs[modelKey] = model.modelValue;
                }
            }

            // --- 填入用户参数 ---
            var imgKeys = model.imageInputKeys || [];
            var vidKeys = model.videoInputKeys || [];
            var promptKey = model.promptKey || 'prompt';
            var paramKeys = paramValues ? Object.keys(paramValues) : [];
            // imageOrder/videoOrder 是画布内部边排序簿记（edge id 数组），非 ComfyUI 节点输入，
            // 禁止 leak 进主节点 inputs（non-pipeline 模型会直送 ComfyUI 触发未知输入错误）。
            // width/height 是 _autoFitNode 写入的节点 UI 尺寸（像素），同理不可 leak。
            // model 由上方 modelKey/modelValue 注入，paramValues.model 若残留（旧模型值）
            // 会覆盖正确值 → 跳过。
            var INTERNAL_KEYS = { imageOrder: 1, videoOrder: 1, width: 1, height: 1 };
            for (var i = 0; i < paramKeys.length; i++) {
                var k = paramKeys[i];
                if (k === 'modelId') continue;
                // 所有 _ 前缀内部簿记 key（_result/_placeholders/_frameHTMLs/_multiImgs 等）
                // 一律禁止 leak 进 ComfyUI 节点 inputs（只挡 _result 时 _placeholders/_frameHTMLs 等内部键会漏入）
                if (k.charAt(0) === '_') continue;
                if (k === modelKey) continue;
                if (INTERNAL_KEYS[k]) continue;
                if (imgKeys.indexOf(k) >= 0) continue;
                if (vidKeys.indexOf(k) >= 0) continue;
                if (k === 'input_image' || k === 'reference_image_1' || k === 'reference_image_2' || k === 'reference_image_3') continue;
                var v = paramValues[k];
                var targetKey = (k === 'prompt') ? promptKey : k;
                if (targetKey === 'seed' && (v === -1 || v === '-1')) {
                    v = Math.floor(Math.random() * 2147483647);
                }
                inputs[targetKey] = v;
            }

            // --- LoadImage 节点（有上游图时，含动态编号 key）---
            var imgFilenames = imageFilenames || {};
            var allImgKeys = Object.keys(imgFilenames);
            for (var j = 0; j < allImgKeys.length; j++) {
                var imgKey = allImgKeys[j];
                var filename = imgFilenames[imgKey];
                var loaderId = String(nextNodeId++);
                wf[loaderId] = {
                    class_type: 'LoadImage',
                    inputs: { image: filename }
                };
                inputs[imgKey] = [loaderId, 0];
            }

            // --- LoadVideo 节点（有上游视频时，按 videoFilenames 的 key 建）---
            // 视频参考：seedance2_ref 的 videoInputKeys=[model.reference_videos.video_1]，多视频续 _2/_3。
            // LoadVideo 节点输入 key 为 file（见 templates/seedance2_ref.json ref_video_loader_*）。
            var vidFilenames = videoFilenames || {};
            var allVidKeys = Object.keys(vidFilenames);
            for (var vj = 0; vj < allVidKeys.length; vj++) {
                var vidKey = allVidKeys[vj];
                var vfilename = vidFilenames[vidKey];
                var vLoaderId = String(nextNodeId++);
                wf[vLoaderId] = {
                    class_type: 'LoadVideo',
                    inputs: { file: vfilename }
                };
                inputs[vidKey] = [vLoaderId, 0];
            }

            // --- 主节点 ---
            wf[mainNodeId] = { class_type: model.classType, inputs: inputs };

            // 生成节点 input key 一览（排查端口/参数丢失用）
            console.log('[TemplateEngine] buildDynamicWorkflow 主节点',
                model.classType,
                'inputKeys:',
                JSON.stringify(Object.keys(inputs)),
                '| imageFilenames keys:',
                JSON.stringify(Object.keys(imageFilenames || {})));

            // 校验 imageInputKeys/videoInputKeys 前缀是否在 schema 顶层 input 里。
            // ComfyUI 节点升级改端口名时（如 model.images.image_1 → model.ref_images.image_1），
            // registry 的 imageInputKeys 会与 schema 脱节 → LoadImage 建了但主节点 inputs key
            // 不被 ComfyUI 认识 → unknown kwarg。此校验在 schema 缓存可用时给出明确 warn。
            var _schema = _registry ? _registry.getSchema(model.id) : null;
            if (_schema && _schema.input) {
                var _schemaTop = {};
                var _reqK = Object.keys(_schema.input.required || {});
                var _optK = Object.keys(_schema.input.optional || {});
                for (var _r = 0; _r < _reqK.length; _r++) _schemaTop[_reqK[_r]] = 1;
                for (var _o = 0; _o < _optK.length; _o++) _schemaTop[_optK[_o]] = 1;
                var _portKeys = imgKeys.concat(vidKeys);
                for (var _p = 0; _p < _portKeys.length; _p++) {
                    var _pk = _portKeys[_p];
                    var _prefix = _pk.split('.')[0];
                    if (!_schemaTop[_prefix]) {
                        console.warn('[TemplateEngine] 端口 key 不在 schema 顶层 — modelId=' + model.id +
                            ', classType=' + model.classType +
                            ', portKey=' + _pk +
                            ', schemaTopKeys=' + JSON.stringify(Object.keys(_schemaTop)) +
                            '（ComfyUI 节点可能改了端口名，检查 template-list.json 的 imageInputKeys/videoInputKeys）');
                    }
                }
            }

            // --- 输出节点 ---
            var outputNodeId = String(nextNodeId++);
            if (model.category === 'video') {
                // ComfyUI ≥0.33 的 SaveVideo.execute 把 format 定为必填位置参数；
                // 缺 format 会在执行期报 TypeError（提交阶段不校验）。auto = MP4(H.264)/WebM(AV1) 自选。
                wf[outputNodeId] = {
                    class_type: 'SaveVideo',
                    inputs: {
                        filename_prefix: 'nodegen_' + (model.id || 'gen'),
                        video: [mainNodeId, 0],
                        format: 'auto',
                        codec: 'auto'
                    }
                };
            } else {
                wf[outputNodeId] = {
                    class_type: 'SaveImage',
                    inputs: {
                        filename_prefix: 'nodegen_' + (model.id || 'gen'),
                        images: [mainNodeId, 0]
                    }
                };
            }

            return wf;
        }

        function warmupSchemas() {
            if (!_registry) return Promise.resolve();
            var all = _registry.getAll();
            var seen = {};  // classType → firstModelId
            for (var i = 0; i < all.length; i++) {
                var m = all[i];
                if (!m.pipeline && m.classType && !seen[m.classType]) {
                    seen[m.classType] = m.id;
                }
            }
            var classTypes = Object.keys(seen);
            var tasks = classTypes.map(function (ct) {
                return fetchModelSchema(seen[ct]).catch(function (e) {
                    console.warn('[TemplateEngine] 预暖 schema 失败: ' + ct + ' — ' + (e && e.message));
                });
            });
            return Promise.all(tasks);
        }

        return {
            loadTemplates: loadTemplates,
            getTemplate: getTemplate,
            addTemplate: addTemplate,
            getRegisteredClassTypes: getRegisteredClassTypes,
            addRegistryEntry: addRegistryEntry,
            getAllTemplates: getAllTemplates,
            renderWorkflow: renderWorkflow,
            loadCustomWorkflow: loadCustomWorkflow,
            validateWorkflow: validateWorkflow,
            injectModelChoices: injectModelChoices,
            setModelCatalog: setModelCatalog,
            getUnetSamplingHints: getUnetSamplingHints,
            setRegistry: setRegistry,
            setService: setService,
            loadRegistry: loadRegistry,
            getModelParams: getModelParams,
            refreshModelParams: refreshModelParams,
            fetchModelSchema: fetchModelSchema,
            warmupSchemas: warmupSchemas,
            extractSchemaImagePorts: extractSchemaImagePorts,
            mapImagePorts: mapImagePorts,
            buildSchemaDrivenWorkflow: buildSchemaDrivenWorkflow,
            validateWorkflowAgainstSchema: validateWorkflowAgainstSchema,
            getById: function (id) { return _registry ? _registry.getById(id) : null; }
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createTemplateEngine = createTemplateEngine;
})(window);
