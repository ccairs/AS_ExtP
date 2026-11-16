(function (global) {
    'use strict';

    // ============================================================================
    // 官方模板 → pipeline 格式推导器（手调层统一为自动拉取）
    //
    // 输入：uiToApi.convert 产出的 API 工作流 + /object_info 目录 + 官方索引 meta
    // 输出：与手调 templates/*.json 完全同构的模板（parameters + {{key}} 占位符
    //       workflow）+ registry 条目（pipeline:true）——表单/画布按既有 pipeline
    //       路径消费，零新执行路径。
    //
    // 标准节点词汇表（转换器解析 widget 顺序时已算出注入点，此处只做语义化）：
    //   CheckpointLoaderSimple.ckpt_name → model select（choices 活拉）
    //   CLIPTextEncode.text（非空序）→ prompt / negative_prompt
    //   EmptyLatentImage / EmptySD3LatentImage → width / height / batch_size
    //   KSampler → seed / steps / cfg / sampler_name / scheduler / denoise
    //   LoadImage.image → image_1..N（type=image，registry.imageInputKeys）
    //   LoadVideo.file → video_1..N（type=video，registry.videoInputKeys）
    //   未连接的 IMAGE/VIDEO 输入（直接 socket、动态下拉子路径、autogrow 首槽）→
    //   注入 LoadImage/LoadVideo + image_N/video_N 参数（表单上传槽；辅助图不注入）
    //   SaveVideo 存在 → category=video；否则 image
    //   其余节点类（未知 loader/后处理/放大链…）→ 跳过：值保持字面 = 模板默认
    //   无 CLIPTextEncode 字面提示词时 → 提示词槽兜底：非 output 节点上的必需 STRING
    //   字面输入（末段 user_prompt/positive_prompt > 末段 prompt > 含 prompt/text；
    //   其余键只认 caption/tags/style/lyrics/text_prompt/description/instruction/
    //   high_level_description 白名单；negative/system 键不进候选；同级 multiline 优先；
    //   动态下拉子输入按点号路径解析 spec，如 model.prompt）；空字面值只认提示词命名键
    //   且节点输出仍被非 output 节点消费；仍无才 NO_PROMPT_SLOT
    //   提示词槽落在动态下拉子输入时，同组可调 widget（duration/resolution/ratio/
    //   generate_audio/task_type/output_format）→ 参数，choices 取 catalog
    //
    // 语义约定（消费端既有特判，生成模板必须对齐）：
    //   - prompt 参数 key 固定 'prompt'（画布上游文本节点覆盖 effParams.prompt）
    //   - seed key 固定 'seed'（renderWorkflow 替换层 -1→随机特判）
    //   - batch_size 固定（runGenWorkflow 批量循环读取后删除）
    //   - 所有参数带 default（=模板原值）→ 占位符全替换，不触发
    //     removeUnreplacedPlaceholders 删除路径
    // ============================================================================

    var LATENT_RE = /^Empty\w*Latent/;   // EmptyLatentImage / EmptySD3LatentImage …

    function _isWidgetType(spec0) {
        if (Array.isArray(spec0)) return true;
        return typeof spec0 === 'string' && ['INT', 'FLOAT', 'STRING', 'TEXT', 'BOOLEAN', 'COMBO'].indexOf(spec0) >= 0;
    }

    // 从 catalog 取某节点某输入的 spec（[type, extra...]，不存在返回 null）
    function _inputSpec(catalog, classType, inputKey) {
        try {
            var def = catalog[classType];
            if (!def || !def.input) return null;
            return (def.input.required && def.input.required[inputKey]) ||
                (def.input.optional && def.input.optional[inputKey]) || null;
        } catch (_) { return null; }
    }

    function _specTypeStr(spec) {
        if (!Array.isArray(spec) || !spec.length) return null;
        return Array.isArray(spec[0]) ? 'COMBO' : String(spec[0]);
    }

    // 从 catalog 取某节点某输入的 COMBO 选项（不存在返回 null）
    function _choicesFor(catalog, classType, inputKey) {
        try {
            var spec = _inputSpec(catalog, classType, inputKey);
            if (spec && Array.isArray(spec[0])) return spec[0].slice();
        } catch (_) {}
        return null;
    }

    function _hasOwn(obj, key) {
        return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    function _specTail(spec) {
        var t = spec && spec[1];
        return (t && typeof t === 'object' && !Array.isArray(t)) ? t : null;
    }

    // 按点号路径取输入 spec 与其所在分组：动态下拉子输入（如 model.prompt）的
    // 中间段必须是 COMFY_DYNAMICCOMBO_V3，按节点已取值选中 option 后继续走其 inputs。
    // 返回 {spec, required} 或 null。
    function _resolveInputSpec(catalog, classType, keyPath, nodeInputs) {
        try {
            var def = catalog[classType];
            if (!def || !def.input) return null;
            var parts = String(keyPath).split('.');
            var group = def.input;
            var spec = null, required = false;
            for (var i = 0; i < parts.length; i++) {
                var req = group.required || {};
                var opt = group.optional || {};
                if (_hasOwn(req, parts[i])) { spec = req[parts[i]]; required = true; }
                else if (_hasOwn(opt, parts[i])) { spec = opt[parts[i]]; required = false; }
                else return null;
                if (i === parts.length - 1) break;
                if (!Array.isArray(spec) || spec[0] !== 'COMFY_DYNAMICCOMBO_V3') return null;
                var tail = _specTail(spec);
                var options = (tail && Array.isArray(tail.options)) ? tail.options : [];
                var selected = nodeInputs[parts.slice(0, i + 1).join('.')];
                var chosen = null;
                for (var k = 0; k < options.length; k++) {
                    if (options[k] && String(options[k].key) === String(selected)) { chosen = options[k]; break; }
                }
                if (!chosen) return null;
                group = chosen.inputs || {};
            }
            return spec ? { spec: spec, required: required } : null;
        } catch (_) { return null; }
    }

    // 提示词键名优先级：末段 user_prompt/positive_prompt > 末段 prompt/prompt_text >
    // 键名含 prompt/text > 其他
    function _promptKeyRank(key) {
        var last = key.indexOf('.') >= 0 ? key.slice(key.lastIndexOf('.') + 1) : key;
        if (/^(user_prompt|positive_prompt)$/i.test(last)) return -1;
        if (/^prompt(_text)?$/i.test(last)) return 0;
        if (/prompt|text/i.test(key)) return 1;
        return 2;
    }

    // 负向/系统提示词槽承载约束文本而非用户正向描述，不作提示词候选
    function _isExcludedPromptKey(key) {
        return /negative|system/i.test(key);
    }

    // 兜底候选（键名与 prompt/text 无关）的显式白名单：只认语义确定的提示词类文本域。
    // 数学表达式（expression）、sigmas、mask、正则替换片段等非提示词文本不参数化。
    var PROMPT_FALLBACK_KEYS = [
        'caption', 'tags', 'style', 'lyrics', 'text_prompt',
        'description', 'instruction', 'high_level_description'
    ];

    function _isPromptFallbackKey(key) {
        var last = key.indexOf('.') >= 0 ? key.slice(key.lastIndexOf('.') + 1) : key;
        return PROMPT_FALLBACK_KEYS.indexOf(String(last).toLowerCase()) >= 0;
    }

    // 动态下拉子输入（如 model.prompt）同组的可调 widget → 参数。仅白名单键；
    // choices 只取 catalog options，缺失时退化为当前值单值、仍无则跳过；
    // model 本身与 reference_*（走端口）/ watermark / auto_* 不暴露。
    var CLOUD_TUNABLE_PARAMS = [
        { name: 'duration', get label() { return AEI18n.t('时长'); }, kind: 'number' },
        { name: 'resolution', get label() { return AEI18n.t('分辨率'); }, kind: 'select' },
        { name: 'ratio', get label() { return AEI18n.t('比例'); }, kind: 'select' },
        { name: 'generate_audio', get label() { return AEI18n.t('生成音频'); }, kind: 'boolean' },
        { name: 'task_type', get label() { return AEI18n.t('任务类型'); }, kind: 'select' },
        { name: 'output_format', get label() { return AEI18n.t('输出格式'); }, kind: 'select' }
    ];

    function _exposeCloudParams(parameters, catalog, classType, nodeInputs, promptKey) {
        var dot = String(promptKey).lastIndexOf('.');
        if (dot < 0) return;
        var prefix = String(promptKey).slice(0, dot + 1);
        var used = {};
        for (var pi = 0; pi < parameters.length; pi++) used[parameters[pi].key] = 1;
        for (var ci = 0; ci < CLOUD_TUNABLE_PARAMS.length; ci++) {
            var meta = CLOUD_TUNABLE_PARAMS[ci];
            var path = prefix + meta.name;
            if (!_hasOwn(nodeInputs, path)) continue;
            if (used[meta.name]) continue;
            var value = nodeInputs[path];
            if (value === undefined || value === null || Array.isArray(value)) continue;
            var resolved = _resolveInputSpec(catalog, classType, path, nodeInputs);
            if (!resolved) continue;
            var specType = _specTypeStr(resolved.spec);
            var tail = _specTail(resolved.spec) || {};
            var param = null;
            if (meta.kind === 'number') {
                if (specType !== 'INT' || typeof value !== 'number') continue;
                param = { key: meta.name, label: meta.label, type: 'number', default: value };
                if (typeof tail.min === 'number') param.min = tail.min;
                if (typeof tail.max === 'number') param.max = tail.max;
                if (typeof tail.step === 'number') param.step = tail.step;
            } else if (meta.kind === 'select') {
                if (specType !== 'COMBO') continue;
                var choices = Array.isArray(resolved.spec[0]) ? resolved.spec[0].slice() : null;
                if (!choices && Array.isArray(tail.options)) choices = tail.options.slice();
                if (!choices || !choices.length) {
                    if (typeof value === 'string' && value) choices = [value];
                    else continue;
                }
                var defVal = (typeof value === 'string' && value) ? value
                    : (typeof tail.default === 'string' ? tail.default : choices[0]);
                param = { key: meta.name, label: meta.label, type: 'select', choices: choices, default: defVal };
            } else {
                if (specType !== 'BOOLEAN') continue;
                var bVal = (typeof value === 'boolean') ? value : tail.default;
                if (typeof bVal !== 'boolean') continue;
                param = { key: meta.name, label: meta.label, type: 'boolean', default: bVal };
            }
            if (!param) continue;
            used[meta.name] = 1;
            parameters.push(param);
            nodeInputs[path] = '{{' + meta.name + '}}';
        }
    }

    // 从 output 节点沿输入 link 反向收集可达节点 id；无 output 节点时返回 null
    function _reachableNodeIds(promptData, catalog) {
        var ids = Object.keys(promptData);
        var deps = {};
        var i, k;
        for (i = 0; i < ids.length; i++) deps[ids[i]] = [];
        for (i = 0; i < ids.length; i++) {
            var node = promptData[ids[i]];
            if (!node || !node.inputs) continue;
            var keys = Object.keys(node.inputs);
            for (k = 0; k < keys.length; k++) {
                var val = node.inputs[keys[k]];
                if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string' && deps[val[0]]) {
                    deps[ids[i]].push(val[0]);
                }
            }
        }
        var stack = [];
        for (i = 0; i < ids.length; i++) {
            var def = catalog[promptData[ids[i]] && promptData[ids[i]].class_type];
            if (def && def.output_node === true) stack.push(ids[i]);
        }
        if (!stack.length) return null;
        var seen = {};
        while (stack.length) {
            var id = stack.pop();
            if (seen[id]) continue;
            seen[id] = 1;
            var srcs = deps[id] || [];
            for (k = 0; k < srcs.length; k++) {
                if (!seen[srcs[k]]) stack.push(srcs[k]);
            }
        }
        return seen;
    }

    // AUTOGROW 组首槽：仅当子输入类型匹配且 catalog 声明了槽名时返回槽名
    function _autogrowSlotName(spec, typeName) {
        var tail = _specTail(spec) || {};
        var tpl = tail.template || {};
        var names = Array.isArray(tpl.names) ? tpl.names : [];
        if (!names.length) return null;
        var req = (tpl.input && tpl.input.required) || {};
        var opt = (tpl.input && tpl.input.optional) || {};
        var childKey = Object.keys(req)[0] || Object.keys(opt)[0];
        if (!childKey) return null;
        if (_specTypeStr(req[childKey] || opt[childKey]) !== typeName) return null;
        return String(names[0]);
    }

    // catalog 声明的未连接媒体输入（IMAGE/VIDEO）：直接输入、动态下拉子路径、
    // autogrow 首槽。辅助图（模板内部的填充/运动/背景等派生图）不注入。
    var AUX_IMAGE_SLOT_RE = /(^|\.)(ref_pad_image|continue_motion|color_map|backgrounds|character_image)($|\.)/i;

    function _collectSlots(promptData, catalog, reachable, typeName) {
        var slots = [];
        function walk(group, requiredGroup, prefix, nodeId, nodeInputs) {
            var keys = Object.keys(group || {});
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                var spec = group[key];
                var type = _specTypeStr(spec);
                var path = prefix + key;
                if (type === 'COMFY_AUTOGROW_V3') {
                    var slotName = _autogrowSlotName(spec, typeName);
                    if (!slotName) continue;
                    var slotPath = path + '.' + slotName;
                    if (_hasOwn(nodeInputs, slotPath)) continue;
                    if (typeName === 'IMAGE' && AUX_IMAGE_SLOT_RE.test(slotPath)) continue;
                    slots.push({ nodeId: nodeId, path: slotPath, required: false });
                    continue;
                }
                if (type === 'COMFY_DYNAMICCOMBO_V3') {
                    var options = (_specTail(spec) || {}).options;
                    if (!Array.isArray(options)) continue;
                    var selected = nodeInputs[path];
                    var chosen = null;
                    for (var oi = 0; oi < options.length; oi++) {
                        if (options[oi] && String(options[oi].key) === String(selected)) { chosen = options[oi]; break; }
                    }
                    if (!chosen) continue;
                    var sub = chosen.inputs || {};
                    walk(sub.required || {}, true, path + '.', nodeId, nodeInputs);
                    walk(sub.optional || {}, false, path + '.', nodeId, nodeInputs);
                    continue;
                }
                if (type === typeName && !_hasOwn(nodeInputs, path)) {
                    if (typeName === 'IMAGE' && AUX_IMAGE_SLOT_RE.test(path)) continue;
                    slots.push({ nodeId: nodeId, path: path, required: requiredGroup });
                }
            }
        }
        var ids = Object.keys(promptData);
        for (var ni = 0; ni < ids.length; ni++) {
            var node = promptData[ids[ni]];
            if (!node || !node.class_type) continue;
            if (!reachable[ids[ni]]) continue;
            var def = catalog[node.class_type];
            if (!def || def.output_node === true) continue;
            // 提示词生成/编码工具（TextGenerate/TextEncode 一族）与 LLM/视觉理解
            // 辅助节点（GeminiNode 一族）的媒体输入不是用户的参考媒体槽
            if (/TextGenerate|TextEncode|GeminiNode/i.test(node.class_type)) continue;
            walk(def.input.required || {}, true, '', ids[ni], node.inputs || {});
            walk(def.input.optional || {}, false, '', ids[ni], node.inputs || {});
        }
        return slots;
    }

    // 未连接媒体输入 → image_N/video_N 参数 + 注入 LoadImage/LoadVideo
    // （目标输入写 [注入节点 id, 0]）。返回注入的 key 列表；firstSeq 为起始编号。
    function _injectSlots(promptData, catalog, parameters, typeName, firstSeq) {
        var reachable = _reachableNodeIds(promptData, catalog);
        if (!reachable) return [];
        var slots = _collectSlots(promptData, catalog, reachable, typeName);
        if (!slots.length) return [];
        var isImage = (typeName === 'IMAGE');
        var injectClass = isImage ? 'LoadImage' : 'LoadVideo';
        var injectInput = isImage ? 'image' : 'file';
        var keyName = isImage ? 'image' : 'video';
        var labelName = isImage ? '输入图片 ' : '输入视频 ';
        var nextId = 0;
        var ids = Object.keys(promptData);
        for (var i = 0; i < ids.length; i++) {
            var num = parseInt(ids[i], 10);
            if (String(num) === ids[i] && num > nextId) nextId = num;
        }
        var injected = [];
        for (var si = 0; si < slots.length; si++) {
            var slot = slots[si];
            nextId += 1;
            while (promptData[String(nextId)] !== undefined) nextId += 1;
            var injId = String(nextId);
            var seq = firstSeq + si;
            var injKey = keyName + '_' + seq;
            var injNode = { class_type: injectClass, inputs: {} };
            injNode.inputs[injectInput] = '{{' + injKey + '}}';
            promptData[injId] = injNode;
            var target = promptData[slot.nodeId];
            target.inputs = target.inputs || {};
            target.inputs[slot.path] = [injId, 0];
            parameters.push({ key: injKey, label: labelName + seq, type: keyName, required: !!slot.required });
            injected.push(injKey);
        }
        return injected;
    }

    /**
     * 推导。返回 { ok:true, data:{template, registryEntry} } 或 { ok:false, error:{code,message} }
     * @param promptData  uiToApi.convert 的 data（API 格式 {"<id>":{class_type,inputs}}）
     * @param catalog     /object_info 全量目录
     * @param meta        官方索引条目 {name,title,description,openSource,...}
     */
    function derive(promptData, catalog, meta) {
        if (!promptData || typeof promptData !== 'object') {
            return { ok: false, error: { code: 'NOT_API_FORMAT', message: '缺少 API 格式工作流（需先经 uiToApi.convert）' } };
        }
        if (!catalog || typeof catalog !== 'object') {
            return { ok: false, error: { code: 'NO_CATALOG', message: '缺少 /object_info 节点目录' } };
        }
        meta = meta || {};
        var name = String(meta.name || '').trim();
        if (!name) {
            return { ok: false, error: { code: 'NO_NAME', message: '缺少模板 name' } };
        }

        var id = 'official_' + name;
        var parameters = [];
        var imageKeys = [];
        var videoKeys = [];
        var hasVideoOutput = false;
        var sawPrompt = false, sawNegative = false;
        // 多实例去重——SDXL refiner 等工作流有双 KSampler/双
        // CheckpointLoader，首个全参数化、后续字面保留（refiner 的精调 steps/denoise
        // 不能被共享占位符覆盖，否则官方模板调优丢失 + 表单出现重复参数）
        var sawModelParam = false, sawSampler = false, sawLatent = false, sawSeed = false;
        // 提示词槽候选：CLIPTextEncode 字面 text 优先（循环内直接参数化）；无命中时由
        // 循环后的候选扫描兜底（键名 prompt-like / 必需 STRING widget），命中后其
        // seed/model 顺带参数化
        var apiMainCandidate = null;

        // 逐节点扫描（顺序无关，参数按语义归类）
        var nodeIds = Object.keys(promptData);
        for (var ni = 0; ni < nodeIds.length; ni++) {
            var nodeId = nodeIds[ni];
            var node = promptData[nodeId];
            if (!node || !node.class_type) continue;
            var ct = node.class_type;
            var inputs = node.inputs || {};

            if (ct === 'SaveVideo' || ct === 'VHS_VideoCombine') hasVideoOutput = true;

            // ---- CheckpointLoaderSimple.ckpt_name → model select（首个；refiner 第二 loader 字面保留）----
            if (ct === 'CheckpointLoaderSimple' && typeof inputs.ckpt_name === 'string') {
                if (sawModelParam) continue;
                sawModelParam = true;
                var ckChoices = _choicesFor(catalog, ct, 'ckpt_name') || [inputs.ckpt_name];
                parameters.push({
                    key: 'model', label: AEI18n.t('模型'), type: 'select',
                    choices: ckChoices, default: inputs.ckpt_name
                });
                inputs.ckpt_name = '{{model}}';
                continue;
            }

            // ---- CLIPTextEncode.text → prompt / negative_prompt（按非空序）----
            if (ct === 'CLIPTextEncode' && typeof inputs.text === 'string' && inputs.text) {
                if (!sawPrompt) {
                    parameters.push({ key: 'prompt', label: AEI18n.t('正向提示词'), type: 'textarea', required: true, default: inputs.text });
                    inputs.text = '{{prompt}}';
                    sawPrompt = true;
                } else if (!sawNegative) {
                    parameters.push({ key: 'negative_prompt', label: AEI18n.t('负向提示词'), type: 'textarea', default: inputs.text });
                    inputs.text = '{{negative_prompt}}';
                    sawNegative = true;
                }
                // 第三个及以后的文本编码节点：字面保留（少见，宁少勿乱）
                continue;
            }

            // ---- 空文本（如 flux 无负向）：字面保留 ----
            if (ct === 'CLIPTextEncode') continue;

            // ---- Empty*Latent* → width / height / batch_size（首个；后续字面保留）----
            if (LATENT_RE.test(ct)) {
                if (sawLatent) continue;
                sawLatent = true;
                if (typeof inputs.width === 'number') {
                    parameters.push({ key: 'width', label: AEI18n.t('宽度'), type: 'number', default: inputs.width, min: 256, max: 4096, step: 64 });
                    inputs.width = '{{width}}';
                }
                if (typeof inputs.height === 'number') {
                    parameters.push({ key: 'height', label: AEI18n.t('高度'), type: 'number', default: inputs.height, min: 256, max: 4096, step: 64 });
                    inputs.height = '{{height}}';
                }
                if (typeof inputs.batch_size === 'number') {
                    // ⚠️ batch_size 只建参数、不造占位符（workflow 保留字面值）：
                    // 表单/画布的批量循环语义是「参数驱动 N 次提交、workflow 内恒 1」
                    // （controller.generate 与 runGenWorkflow 均无条件 delete values.batch_size，
                    // 注释明确「workflow 里无 {{batch_size}} 占位符」——造了占位符反而在
                    // delete 后被 removeUnreplacedPlaceholders 删掉 EmptyLatentImage 的必填
                    // 输入 → ComfyUI 拒单）。对齐 txt2img 形态：param 驱动循环 + 字面值。
                    parameters.push({ key: 'batch_size', label: AEI18n.t('生成数量'), type: 'number', default: inputs.batch_size, min: 1, max: 16, step: 1 });
                }
                continue;
            }

            // ---- KSampler → seed / steps / cfg / sampler / scheduler / denoise（首个；refiner 第二采样器字面保留）----
            if (ct === 'KSampler') {
                if (sawSampler) continue;
                sawSampler = true;
                if (typeof inputs.seed === 'number') {
                    parameters.push({ key: 'seed', label: AEI18n.t('种子'), type: 'number', default: inputs.seed, min: -1, max: 2147483647 });
                    inputs.seed = '{{seed}}';
                    sawSeed = true;
                }
                if (typeof inputs.steps === 'number') {
                    parameters.push({ key: 'steps', label: AEI18n.t('步数'), type: 'number', default: inputs.steps, min: 1, max: 150 });
                    inputs.steps = '{{steps}}';
                }
                if (typeof inputs.cfg === 'number') {
                    parameters.push({ key: 'cfg', label: 'CFG', type: 'number', default: inputs.cfg, min: 1, max: 30, step: 0.5 });
                    inputs.cfg = '{{cfg}}';
                }
                if (typeof inputs.sampler_name === 'string') {
                    var smpChoices = _choicesFor(catalog, ct, 'sampler_name') || [inputs.sampler_name];
                    parameters.push({ key: 'sampler_name', label: AEI18n.t('采样器'), type: 'select', choices: smpChoices, default: inputs.sampler_name });
                    inputs.sampler_name = '{{sampler_name}}';
                }
                if (typeof inputs.scheduler === 'string') {
                    var schChoices = _choicesFor(catalog, ct, 'scheduler') || [inputs.scheduler];
                    parameters.push({ key: 'scheduler', label: AEI18n.t('调度器'), type: 'select', choices: schChoices, default: inputs.scheduler });
                    inputs.scheduler = '{{scheduler}}';
                }
                if (typeof inputs.denoise === 'number') {
                    parameters.push({ key: 'denoise', label: AEI18n.t('去噪强度'), type: 'number', default: inputs.denoise, min: 0, max: 1, step: 0.05 });
                    inputs.denoise = '{{denoise}}';
                }
                continue;
            }

            // ---- LoadImage.image → image_N（type=image 参数 + registry.imageInputKeys）----
            if (ct === 'LoadImage' && typeof inputs.image === 'string') {
                var imgKey = 'image_' + (imageKeys.length + 1);
                parameters.push({ key: imgKey, label: '输入图片 ' + (imageKeys.length + 1), type: 'image', required: true });
                inputs.image = '{{' + imgKey + '}}';
                imageKeys.push(imgKey);
                continue;
            }

            // ---- LoadVideo.file → video_N（type=video 参数 + registry.videoInputKeys）----
            // file 为连线（数组）时字面保留：播放链由模板自身连接，不参数化
            if (ct === 'LoadVideo' && typeof inputs.file === 'string') {
                var vidKey = 'video_' + (videoKeys.length + 1);
                parameters.push({ key: vidKey, label: '输入视频 ' + (videoKeys.length + 1), type: 'video', required: true });
                inputs.file = '{{' + vidKey + '}}';
                videoKeys.push(vidKey);
                continue;
            }

            // ---- 其余节点（VAEDecode / 未知 loader / 后处理链…）：字面保留 ----
        }

        // ---- 提示词槽候选（无 CLIPTextEncode 字面 text 命中时）----
        // 非 output 节点上的字面 STRING 必需输入。优先级：键名 prompt-like
        //（根键或动态下拉子键末段，如 model.prompt）> 键名含 prompt/text > 其他，
        // 同级 multiline:true 优先。连线值（[nodeId, slot]）不参数化——覆盖成字面值
        // 会静默销毁图边（上游编码节点变孤儿）。
        // 空字面值只认提示词命名键，且节点输出必须仍被非 output 节点消费：只连预览/
        // 保存节点的空槽无法确认是用户提示词槽，参数化会静默无效。
        if (!sawPrompt) {
            var liveSourceIds = {};
            for (var li = 0; li < nodeIds.length; li++) {
                var liveNode = promptData[nodeIds[li]];
                if (!liveNode || !liveNode.class_type) continue;
                var liveDef = catalog[liveNode.class_type];
                if (liveDef && liveDef.output_node === true) continue;
                var liveInputs = liveNode.inputs || {};
                for (var lk in liveInputs) {
                    if (!_hasOwn(liveInputs, lk)) continue;
                    var lv = liveInputs[lk];
                    if (Array.isArray(lv) && lv.length === 2 && typeof lv[0] === 'string') liveSourceIds[lv[0]] = 1;
                }
            }
            var candOrder = 0;
            var promptCandidates = [];
            for (var ci = 0; ci < nodeIds.length; ci++) {
                var candNode = promptData[nodeIds[ci]];
                if (!candNode || !candNode.class_type) continue;
                var candDef = catalog[candNode.class_type];
                if (!candDef || candDef.output_node === true) continue;
                // 只排除标准 CLIPTextEncode：其空 text 是负向提示词约定（字面保留）；
                // 其它 *TextEncode* 类（如 TextEncodeQwenImageEditPlus）的 prompt 是
                // 用户提示词槽，不能按类名宽泛排除
                if (candNode.class_type === 'CLIPTextEncode') continue;
                var candInputs = candNode.inputs || {};
                var candKeys = Object.keys(candInputs);
                for (var ck = 0; ck < candKeys.length; ck++) {
                    var candKey = candKeys[ck];
                    var candVal = candInputs[candKey];
                    if (typeof candVal !== 'string') continue;
                    if (_isExcludedPromptKey(candKey)) continue;
                    var candKeyRank = _promptKeyRank(candKey);
                    if (candKeyRank >= 2 && !_isPromptFallbackKey(candKey)) continue;
                    if (!candVal && (candKeyRank > 1 || !liveSourceIds[nodeIds[ci]])) continue;
                    var candSpec = _resolveInputSpec(catalog, candNode.class_type, candKey, candInputs);
                    if (!candSpec || !candSpec.required) continue;
                    if (_specTypeStr(candSpec.spec) !== 'STRING') continue;
                    var candTail = _specTail(candSpec.spec);
                    if (candTail && candTail.forceInput === true) continue;
                    promptCandidates.push({
                        node: candNode,
                        key: candKey,
                        keyRank: candKeyRank,
                        multiRank: (candTail && candTail.multiline === true) ? 0 : 1,
                        order: candOrder++
                    });
                }
            }
            promptCandidates.sort(function (a, b) {
                if (a.keyRank !== b.keyRank) return a.keyRank - b.keyRank;
                if (a.multiRank !== b.multiRank) return a.multiRank - b.multiRank;
                return a.order - b.order;
            });
            if (promptCandidates.length) apiMainCandidate = promptCandidates[0];
        }

        // ---- 提示词槽参数化（无 CLIPTextEncode 命中时）----
        // prompt 必参数化（否则 NO_PROMPT_SLOT）；seed/model 顺带（去重：KSampler/
        // CheckpointLoader 已参数化过则跳过）。提示词槽位于动态下拉子输入（如
        // model.prompt）时，同组可调 widget 一并参数化（_exposeCloudParams）。
        if (!sawPrompt && apiMainCandidate) {
            var apiNode = apiMainCandidate.node;
            var apiInputs = apiNode.inputs;
            var pk = apiMainCandidate.key;
            parameters.push({ key: 'prompt', label: AEI18n.t('正向提示词'), type: 'textarea', required: true, default: apiInputs[pk] });
            apiInputs[pk] = '{{prompt}}';
            sawPrompt = true;
            if (!sawSeed && typeof apiInputs.seed === 'number') {
                parameters.push({ key: 'seed', label: AEI18n.t('种子'), type: 'number', default: apiInputs.seed, min: -1, max: 2147483647 });
                apiInputs.seed = '{{seed}}';
            }
            if (!sawModelParam && typeof apiInputs.model === 'string') {
                var apiModelSpec = _inputSpec(catalog, apiNode.class_type, 'model');
                if (apiModelSpec && Array.isArray(apiModelSpec[0])) {
                    // 普通 COMBO → select 活拉 choices；DynamicCombo 字面保留（子参数
                    // 需 schema 驱动刷新，表单 pipeline 路径不支持，模板默认 option 即默认模型）
                    parameters.push({
                        key: 'model', label: AEI18n.t('模型'), type: 'select',
                        choices: apiModelSpec[0].slice(), default: apiInputs.model
                    });
                    apiInputs.model = '{{model}}';
                }
            }
            _exposeCloudParams(parameters, catalog, apiNode.class_type, apiInputs, pk);
        }

        if (!sawPrompt) {
            return { ok: false, error: { code: 'NO_PROMPT_SLOT', message: '模板中没有可参数化的提示词节点（非提示词驱动），不适合表单/画布' } };
        }
        if (!parameters.some(function (p) { return p.type !== 'image'; })) {
            // 理论上 sawPrompt 已保证非空，防御分支
            return { ok: false, error: { code: 'NO_PARAMS', message: '未推导出任何参数' } };
        }

        // ---- 未连接媒体输入 → image_N/video_N 参数 + 注入 LoadImage/LoadVideo ----
        // 官方模板常把参考图/参考视频放在未连接的 IMAGE/VIDEO 输入（直接 socket、
        // 动态下拉子路径、autogrow 首槽），模板内没有对应 loader 节点 → 表单缺少
        // 上传槽。注入的 loader 只在用户填值后接上；未填时占位符被删、节点成孤儿由
        // 渲染侧清理层连同指向它的 link 一并移除，模板原有默认行为不变。
        var injectedImageKeys = _injectSlots(promptData, catalog, parameters, 'IMAGE', imageKeys.length + 1);
        var injectedVideoKeys = [];
        if (hasVideoOutput) {
            injectedVideoKeys = _injectSlots(promptData, catalog, parameters, 'VIDEO', videoKeys.length + 1);
        }

        var category = hasVideoOutput ? 'video' : 'image';
        var hasImage = imageKeys.length > 0;
        var mode = hasVideoOutput
            ? (hasImage ? 'i2v' : 't2v')
            : (hasImage ? 'i2i' : 't2i');

        var template = {
            id: id,
            name: String(meta.title || name),
            description: String(meta.description || ''),
            category: category,
            mode: mode,
            cloud: !meta.openSource,
            parameters: parameters,
            workflow: promptData,   // 已就地占位符化
            official: true          // 来源标记（官方库生成，区别于手调/自定义）
        };

        var registryEntry = {
            id: id,
            name: template.name,
            category: category,
            mode: mode,
            templateId: id,
            classType: null,        // pipeline 路径不使用
            modelKey: null,
            modelValue: null,
            promptKey: 'prompt',
            needsImage: hasImage,
            optionalImage: false,
            cloud: !meta.openSource,
            pipeline: true,         // 走占位符替换路径（与手调模板同轨）
            auto: true
        };
        var allImageKeys = imageKeys.concat(injectedImageKeys);
        if (allImageKeys.length) registryEntry.imageInputKeys = allImageKeys.slice();
        if (injectedImageKeys.length) {
            // 注入的图槽是可选参考图：needsImage 仍只由 LoadImage 派生（画布必图守卫不变）
            registryEntry.optionalImage = true;
        }
        var allVideoKeys = videoKeys.concat(injectedVideoKeys);
        if (allVideoKeys.length) registryEntry.videoInputKeys = allVideoKeys.slice();

        return { ok: true, data: { template: template, registryEntry: registryEntry } };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.templateDeriver = {
        derive: derive
    };
})(typeof global !== 'undefined' ? global : window);
