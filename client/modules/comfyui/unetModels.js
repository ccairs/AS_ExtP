(function (global) {
    // 裸扩散模型（models/unet + models/diffusion_models）的文生图 / 图生图支持。
    //
    // 这类模型没有内嵌文本编码器与 VAE，CheckpointLoaderSimple 加载不了，需要
    // UNETLoader + CLIPLoader + VAELoader 的组合图：
    //   - qwen_image 族：TextEncodeQwenImage21 一次输出 positive / negative / latent，
    //     参考图（可多张）走 io.Autogrow 的 images 输入，按 API 的平铺点号键
    //     "images.image_1"… 提交；vae 必须接上（参考图会被编码进 conditioning）。
    //   - anima / krea2 族：CLIPTextEncode + EmptyLatentImage（文生图）；
    //     图生图用 LoadImage → VAEEncode → KSampler(denoise)。
    //
    // 模型分模态：UNETLoader 下拉同时混有图像模型与视频模型（MiniMax H3、WAN、LTX 等），
    // 本地视频模型不参与 txt2img / img2img，也不进表单下拉；清单工具仍会返回它们并
    // 标注 modality='video' / supported=false。未适配的图像族同样只出现在清单里。
    //
    // 本模块是纯函数：不碰 DOM、不发请求。catalog 由调用方从 /object_info 提供，
    // 表单（templateEngine）与 LLM 工具（bootstrap）共用同一套选型逻辑。
    (function () {
        var DEFAULT_WIDTH = 1024;
        var DEFAULT_HEIGHT = 1024;
        var DEFAULT_STEPS = 20;
        var DEFAULT_CFG = 7;
        var MAX_REFERENCE_IMAGES = 16;   // TextEncodeQwenImage21 的 images 槽上限

        // 每族的图结构与选型偏好。加一族 = 这里加一条 + buildWorkflow 里加分支。
        // modality 目前只有 image（本地视频模型不内置支持，见 VIDEO_PATTERNS）。
        var FAMILIES = [
            {
                family: 'anima',
                label: 'ANIMA',
                modality: 'image',
                patterns: [/anima/i, /anime\//i],
                clipType: 'stable_diffusion',
                clipPrefs: [/qwen_3_06b/i, /qwen_?3.*0?6b/i],
                clipExcludes: [],
                vaePrefs: [/qwen_image_vae/i, /qwen_image_2\.1_vae/i],
                sampling: { steps: 30, cfg: 4, sampler: 'er_sde', scheduler: 'simple', denoise: 0.7 },
                turbo: { patterns: [/turbo/i], steps: 12, cfg: 1 },
                supportsReference: false
            },
            {
                family: 'qwen_image',
                label: 'Qwen-Image',
                modality: 'image',
                patterns: [/qwen/i, /noctq/i],
                clipType: 'qwen_image',
                clipPrefs: [/qwen3vl_8b/i, /qwen3vl/i, /qwen_2_5_vl/i],
                clipExcludes: [/heretic/i],
                vaePrefs: [/qwen_image_2\.1_vae/i, /qwen_image_vae/i],
                sampling: { steps: 25, cfg: 1, sampler: 'euler', scheduler: 'simple', denoise: 1.0 },
                cfgPatterns: [[/noctq/i, 3]],
                supportsReference: true
            },
            {
                // Krea 2（ComfyUI 原生支持：CLIPLoader type=krea2 + Qwen3-VL 4B + Qwen image VAE）。
                // Turbo 是蒸馏版：8 步 / CFG 1 / er_sde / simple（实测口径，见 comfyui-mcp krea2-txt2img）。
                family: 'krea2',
                label: 'Krea 2',
                modality: 'image',
                patterns: [/krea[ _.-]?2/i],
                clipType: 'krea2',
                clipPrefs: [/qwen3vl_4b/i, /qwen3vl/i],
                clipExcludes: [],
                vaePrefs: [/qwen_image_vae/i, /qwen_image_2\.1_vae/i],
                sampling: { steps: 8, cfg: 1, sampler: 'er_sde', scheduler: 'simple', denoise: 0.7 },
                turbo: { patterns: [/turbo/i], steps: 8, cfg: 1 },
                supportsReference: false
            }
        ];

        // 视频扩散模型识别（仅按文件名）。UNETLoader 下拉 = 图像模型 + 视频模型，
        // 视频模型不能走本模块的通用 KSampler 图（需要专用节点与帧数/时长参数）。
        // 关键词与 ComfyUI 生态常见命名对齐；未命中且未适配族的模型按“未识别”处理。
        var VIDEO_PATTERNS = [
            /minimax/i,
            /hunyuan[ _.-]?video|video[ _.-]?hunyuan/i,
            /wan[ _.-]?(2\.?[12]|video)/i,
            /ltxv|ltx[ _.-]?(v|2)/i,
            /mochi/i,
            /cogvideo/i,
            /cosmos/i,
            /stable[ _.-]?video/i,
            /(^|[^a-z0-9])svd([^a-z0-9]|$)/i,
            /\bvideo\b/i,
            /(^|[^a-z0-9])(t2v|i2v|fl2v|ref2v|fl2va|ref2va)([^a-z0-9]|$)/i,
            /seedance|kling|hailuo|happyhorse|seedvr|framepack|skyreels/i
        ];

        function normalizeName(value) {
            return String(value === undefined || value === null ? '' : value)
                .replace(/\\/g, '/')
                .toLowerCase();
        }

        function matchesAny(name, patterns) {
            if (!patterns) return false;
            for (var i = 0; i < patterns.length; i++) {
                if (patterns[i].test(name)) return true;
            }
            return false;
        }

        function detectFamily(modelName) {
            var name = normalizeName(modelName);
            if (!name) return null;
            for (var i = 0; i < FAMILIES.length; i++) {
                if (matchesAny(name, FAMILIES[i].patterns)) return FAMILIES[i];
            }
            return null;
        }

        function familyNames() {
            return FAMILIES.map(function (f) { return f.family; });
        }

        // 模态识别：已适配族优先（均为图像族），其余按文件名的视频关键词判定。
        // 返回 'image' | 'video' | null（null = 未识别，任务归属未知）。
        function detectModality(modelName) {
            var name = normalizeName(modelName);
            if (!name) return null;
            var def = detectFamily(name);
            if (def) return def.modality || 'image';
            if (matchesAny(name, VIDEO_PATTERNS)) return 'video';
            return null;
        }

        function isVideoModel(modelName) {
            return detectModality(modelName) === 'video';
        }

        function isImageModel(modelName) {
            return detectModality(modelName) === 'image';
        }

        // 模型清单分类（供 comfyui_list_checkpoints 与表单注入共用）：
        //   kind='checkpoint' | 'diffusion_model'
        //   supported = 能由扩展的本地文生图/图生图流程直接出图：
        //     checkpoint —— 文件名不是视频模型即可（模板通用图，CheckpointLoaderSimple 能加载）；
        //     扩散模型 —— 必须命中已适配的图像族（krea2 也算）。
        function classifyModel(modelName, kind) {
            var name = String(modelName === undefined || modelName === null ? '' : modelName);
            var isCheckpoint = kind === 'checkpoint';
            var def = detectFamily(name);
            var modality = def
                ? (def.modality || 'image')
                : (matchesAny(normalizeName(name), VIDEO_PATTERNS) ? 'video' : null);
            // checkpoint 走模板通用图（CheckpointLoaderSimple），未命中视频关键词即按图像用
            if (isCheckpoint && !modality) modality = 'image';
            var supported = isCheckpoint
                ? (modality !== 'video')
                : !!(def && (def.modality || 'image') === 'image');
            return {
                name: name,
                kind: isCheckpoint ? 'checkpoint' : 'diffusion_model',
                modality: modality,
                family: def ? def.family : null,
                label: def ? def.label : null,
                supported: supported
            };
        }

        // checkpoint 下拉过滤：视频 checkpoint 不进图像模型下拉
        function filterImageModelNames(names) {
            var list = Array.isArray(names) ? names : [];
            return list.filter(function (name) { return detectModality(name) !== 'video'; });
        }

        // 表单下拉只列能直接出图的图像扩散模型；视频模型与未适配族不列出
        // （comfyui_list_checkpoints 分页返回全部模型并标注 modality / supported）。
        function listImageUnetNames(objectInfo) {
            return listUnetNames(objectInfo).filter(function (name) { return isImageModel(name); });
        }

        function _choicesOf(objectInfo, classType, inputKey) {
            try {
                var def = objectInfo && objectInfo[classType];
                var required = def && def.input && def.input.required;
                var spec = required && required[inputKey];
                if (Array.isArray(spec) && Array.isArray(spec[0])) return spec[0].slice();
            } catch (e) {
                // /object_info 形状异常按“不可用”处理，不阻断其它模型
            }
            return [];
        }

        // UNETLoader 的 unet_name 下拉 = models/unet + models/diffusion_models 的并集
        function listUnetNames(objectInfo) {
            return _choicesOf(objectInfo, 'UNETLoader', 'unet_name');
        }

        // 自动选型所需的目录：文本编码器 / CLIP type / VAE / 采样器与调度器，
        // 以及 qwen_image 族依赖的两个节点是否已安装。
        function buildCatalog(objectInfo) {
            return {
                textEncoders: _choicesOf(objectInfo, 'CLIPLoader', 'clip_name'),
                clipTypes: _choicesOf(objectInfo, 'CLIPLoader', 'type'),
                vaes: _choicesOf(objectInfo, 'VAELoader', 'vae_name'),
                samplers: _choicesOf(objectInfo, 'KSampler', 'sampler_name'),
                schedulers: _choicesOf(objectInfo, 'KSampler', 'scheduler'),
                hasQwenImage21Encoder: !!(objectInfo && objectInfo.TextEncodeQwenImage21),
                hasQwen21Cache: !!(objectInfo && objectInfo.QwenImage21Cache)
            };
        }

        function pickByPrefs(list, prefs, excludes) {
            if (!list || list.length === 0) return null;
            excludes = excludes || [];
            for (var p = 0; p < (prefs || []).length; p++) {
                var hits = list.filter(function (name) { return prefs[p].test(name); });
                if (hits.length === 0) continue;
                for (var h = 0; h < hits.length; h++) {
                    if (!matchesAny(hits[h], excludes)) return hits[h];
                }
                return hits[0];
            }
            return null;
        }

        // overrides: { clip, vae, clip_type } —— 表单/工具显式指定时跳过自动选型
        function resolveWiring(def, catalog, overrides) {
            overrides = overrides || {};
            catalog = catalog || {};
            var encoders = catalog.textEncoders || [];
            var vaes = catalog.vaes || [];
            var clipTypes = catalog.clipTypes || [];
            var clipName = overrides.clip ? String(overrides.clip) : pickByPrefs(encoders, def.clipPrefs, def.clipExcludes);
            var vaeName = overrides.vae ? String(overrides.vae) : pickByPrefs(vaes, def.vaePrefs, []);
            var clipType = overrides.clip_type ? String(overrides.clip_type) : def.clipType;
            if (!clipName) {
                throw new Error(def.label + ' 族没有可用的文本编码器（models/text_encoders）。请先安装该族的文本编码器，或在 extra_params 里显式传 clip。');
            }
            if (encoders.length > 0 && encoders.indexOf(clipName) < 0) {
                throw new Error('指定的文本编码器不在 ComfyUI 模型列表里: ' + clipName);
            }
            if (clipTypes.length > 0 && clipTypes.indexOf(clipType) < 0) {
                throw new Error('当前 ComfyUI 的 CLIPLoader 不支持 type=' + clipType + '（' + def.label + ' 族需要）。请升级 ComfyUI 后重试。');
            }
            if (!vaeName) {
                throw new Error(def.label + ' 族没有可用的 VAE（models/vae）。请先安装该族的 VAE，或在 extra_params 里显式传 vae。');
            }
            if (vaes.length > 0 && vaes.indexOf(vaeName) < 0) {
                throw new Error('指定的 VAE 不在 ComfyUI 模型列表里: ' + vaeName);
            }
            return {
                clipName: clipName,
                clipType: clipType,
                vaeName: vaeName
            };
        }

        // 族默认采样参数（含 turbo / NoctQ 特例）；UI 在切换模型时用它同步步数/CFG/denoise
        function samplingDefaults(modelName) {
            var def = detectFamily(modelName);
            if (!def) return null;
            var name = normalizeName(modelName);
            var out = {
                family: def.family,
                label: def.label,
                steps: def.sampling.steps,
                cfg: def.sampling.cfg,
                sampler: def.sampling.sampler,
                scheduler: def.sampling.scheduler,
                denoise: def.sampling.denoise
            };
            if (def.turbo && matchesAny(name, def.turbo.patterns)) {
                out.steps = def.turbo.steps;
                out.cfg = def.turbo.cfg;
            }
            for (var i = 0; i < (def.cfgPatterns || []).length; i++) {
                if (def.cfgPatterns[i][0].test(name)) out.cfg = def.cfgPatterns[i][1];
            }
            return out;
        }

        // 显式值优先；与模板静态默认值相同视为“用户没改”，用族推荐值兜底。
        // （表单与 LLM 工具都会先填模板默认值，只有“不同”才是真正的显式覆盖。）
        function resolveSampling(def, modelName, values, templateDefaults) {
            values = values || {};
            templateDefaults = templateDefaults || {};
            var base = samplingDefaults(modelName) || {
                steps: DEFAULT_STEPS,
                cfg: DEFAULT_CFG,
                sampler: def.sampling.sampler,
                scheduler: def.sampling.scheduler,
                denoise: def.sampling.denoise
            };
            function resolved(key) {
                var v = values[key];
                if (v === undefined || v === null || v === '') return base[key];
                if (templateDefaults[key] !== undefined && String(v) === String(templateDefaults[key])) return base[key];
                return v;
            }
            return {
                steps: resolved('steps'),
                cfg: resolved('cfg'),
                sampler: resolved('sampler') || base.sampler,
                scheduler: resolved('scheduler') || base.scheduler,
                denoise: resolved('denoise')
            };
        }

        function randomSeed() {
            return Math.floor(Math.random() * 2147483647);
        }

        function _finiteNumber(value, fallback) {
            var n = typeof value === 'number' ? value : parseFloat(value);
            return isFinite(n) ? n : fallback;
        }

        // TextEncodeQwenImage21 的 resolution 决定参考图重采样尺寸与 latent 边长
        // （32 的倍数，16-4096；0 = 保持各参考图自身尺寸）
        function _qwenResolution(width) {
            var w = _finiteNumber(width, DEFAULT_WIDTH);
            var rounded = Math.round(w / 32) * 32;
            if (rounded < 32) rounded = 32;
            if (rounded > 4096) rounded = 4096;
            return rounded;
        }

        function _cleanImages(list) {
            var out = [];
            if (!Array.isArray(list)) return out;
            for (var i = 0; i < list.length && out.length < MAX_REFERENCE_IMAGES; i++) {
                if (typeof list[i] === 'string' && list[i]) out.push(list[i]);
            }
            return out;
        }

        // params:
        //   model / prompt / negative_prompt / width / height / batch_size / seed
        //   steps / cfg / sampler / scheduler / denoise
        //   mode: 'txt2img' | 'img2img'
        //   inputImages: [服务端文件名]（img2img 第一张是输入图；qwen 族全部当参考图）
        function buildWorkflow(def, wiring, params, catalog) {
            params = params || {};
            catalog = catalog || {};
            var mode = params.mode === 'img2img' ? 'img2img' : 'txt2img';
            var inputImages = _cleanImages(params.inputImages);
            var positive = params.prompt === undefined || params.prompt === null ? '' : String(params.prompt);
            var negative = params.negative_prompt === undefined || params.negative_prompt === null ? '' : String(params.negative_prompt);
            var width = _finiteNumber(params.width, DEFAULT_WIDTH);
            var height = _finiteNumber(params.height, DEFAULT_HEIGHT);
            var steps = _finiteNumber(params.steps, def.sampling.steps);
            var cfg = _finiteNumber(params.cfg, def.sampling.cfg);
            var sampler = params.sampler || def.sampling.sampler;
            var scheduler = params.scheduler || def.sampling.scheduler;
            var denoise = mode === 'img2img' ? _finiteNumber(params.denoise, def.sampling.denoise) : 1.0;
            var batchSize = Math.max(1, Math.floor(_finiteNumber(params.batch_size, 1)));
            var seed = params.seed;
            if (seed === undefined || seed === null || seed === -1 || seed === '-1') seed = randomSeed();
            seed = _finiteNumber(seed, randomSeed());

            var wf = {
                '1': {
                    class_type: 'UNETLoader',
                    inputs: { unet_name: params.model, weight_dtype: 'default' }
                },
                '2': {
                    class_type: 'CLIPLoader',
                    inputs: { clip_name: wiring.clipName, type: wiring.clipType }
                },
                '3': {
                    class_type: 'VAELoader',
                    inputs: { vae_name: wiring.vaeName }
                }
            };

            if (def.family === 'qwen_image') {
                if (!catalog.hasQwenImage21Encoder) {
                    throw new Error('ComfyUI 缺少 TextEncodeQwenImage21 节点，无法生成 Qwen-Image 图。请升级 ComfyUI 后重试。');
                }
                if (mode === 'img2img' && inputImages.length === 0) {
                    throw new Error('Qwen-Image 图生图需要至少 1 张输入图/参考图。');
                }
                // 参考图：LoadImage → TextEncodeQwenImage21 的 autogrow images（平铺点号键）
                var imageInputs = {};
                for (var qi = 0; qi < inputImages.length; qi++) {
                    var imgId = String(20 + qi);
                    wf[imgId] = { class_type: 'LoadImage', inputs: { image: inputImages[qi] } };
                    imageInputs['images.image_' + (qi + 1)] = [imgId, 0];
                }
                var encodeInputs = {
                    clip: ['2', 0],
                    vae: ['3', 0],
                    prompt: positive,
                    negative_prompt: negative,
                    resolution: _qwenResolution(width)
                };
                Object.keys(imageInputs).forEach(function (k) { encodeInputs[k] = imageInputs[k]; });
                wf['5'] = {
                    class_type: 'TextEncodeQwenImage21',
                    inputs: encodeInputs,
                    _meta: { title: AEI18n.t('Qwen-Image 文本编码（正向/负向/潜空间）') }
                };
                var modelRef = ['1', 0];
                if (catalog.hasQwen21Cache) {
                    wf['4'] = {
                        class_type: 'QwenImage21Cache',
                        inputs: { model: ['1', 0], device: 'auto', dtype: 'default' }
                    };
                    modelRef = ['4', 0];
                }
                wf['6'] = {
                    class_type: 'KSampler',
                    inputs: {
                        model: modelRef,
                        positive: ['5', 0],
                        negative: ['5', 1],
                        latent_image: ['5', 2],
                        seed: seed,
                        steps: steps,
                        cfg: cfg,
                        sampler_name: sampler,
                        scheduler: scheduler,
                        denoise: denoise
                    }
                };
                wf['7'] = { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } };
                wf['8'] = { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'ComfyUI' } };
                return wf;
            }

            // anima / krea2 族（标准 CLIPTextEncode + EmptyLatentImage 图）
            if (inputImages.length > 0 && mode !== 'img2img') {
                throw new Error(def.label + ' 不支持参考图（多图参考仅 Qwen-Image 族）：文生图请清空参考图，或改用 Qwen-Image 模型。');
            }
            wf['4'] = {
                class_type: 'CLIPTextEncode',
                inputs: { text: positive, clip: ['2', 0] },
                _meta: { title: AEI18n.t('正向提示词') }
            };
            wf['5'] = {
                class_type: 'CLIPTextEncode',
                inputs: { text: negative, clip: ['2', 0] },
                _meta: { title: AEI18n.t('负向提示词') }
            };
            var latentRef;
            if (mode === 'img2img') {
                if (inputImages.length === 0) {
                    throw new Error(def.label + ' 图生图需要 1 张输入图。');
                }
                wf['6'] = { class_type: 'LoadImage', inputs: { image: inputImages[0] } };
                wf['7'] = { class_type: 'VAEEncode', inputs: { pixels: ['6', 0], vae: ['3', 0] } };
                latentRef = ['7', 0];
            } else {
                wf['6'] = {
                    class_type: 'EmptyLatentImage',
                    inputs: { width: width, height: height, batch_size: batchSize }
                };
                latentRef = ['6', 0];
            }
            wf['8'] = {
                class_type: 'KSampler',
                inputs: {
                    model: ['1', 0],
                    positive: ['4', 0],
                    negative: ['5', 0],
                    latent_image: latentRef,
                    seed: seed,
                    steps: steps,
                    cfg: cfg,
                    sampler_name: sampler,
                    scheduler: scheduler,
                    denoise: denoise
                }
            };
            wf['9'] = { class_type: 'VAEDecode', inputs: { samples: ['8', 0], vae: ['3', 0] } };
            wf['10'] = { class_type: 'SaveImage', inputs: { images: ['9', 0], filename_prefix: 'ComfyUI' } };
            return wf;
        }

        // 多图映射：把已上传的服务端文件名分配到模板的图片参数槽。
        // 单槽（type=image 且无 multiple）一次一张；multiple 槽按 <key>_1..<key>_N 分配，
        // 受参数 maxCount 限制（Qwen-Image 多图参考走这里）。
        function mapUploadedImages(imgParams, uploadedNames) {
            var out = {};
            var params = Array.isArray(imgParams) ? imgParams : [];
            var names = Array.isArray(uploadedNames) ? uploadedNames : [];
            var idx = 0;
            for (var i = 0; i < params.length && idx < names.length; i++) {
                var p = params[i];
                if (!p || p.type !== 'image') continue;
                if (p.multiple) {
                    var maxN = Math.max(1, parseInt(p.maxCount, 10) || 10);
                    var take = Math.min(maxN, names.length - idx);
                    for (var k = 0; k < take; k++) out[p.key + '_' + (k + 1)] = names[idx++];
                } else {
                    out[p.key] = names[idx++];
                }
            }
            return out;
        }

        global.AEComfyUI = global.AEComfyUI || {};
        global.AEComfyUI.unetModels = {
            detectFamily: detectFamily,
            detectModality: detectModality,
            isImageModel: isImageModel,
            isVideoModel: isVideoModel,
            classifyModel: classifyModel,
            familyNames: familyNames,
            samplingDefaults: samplingDefaults,
            listUnetNames: listUnetNames,
            listImageUnetNames: listImageUnetNames,
            filterImageModelNames: filterImageModelNames,
            buildCatalog: buildCatalog,
            resolveWiring: resolveWiring,
            resolveSampling: resolveSampling,
            buildWorkflow: buildWorkflow,
            mapUploadedImages: mapUploadedImages
        };
    })();
})(window);
