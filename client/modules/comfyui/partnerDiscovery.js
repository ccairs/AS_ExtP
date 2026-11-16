(function (global) {
    'use strict';

    // ============================================================================
    // 伙伴 API 节点自动发现（schema 推导注册）
    // （表单/画布零维护方案）
    //
    // 官方事实（ComfyUI 主库 comfy_api_nodes/ 源码确认）：
    //   - 新式节点 category = "partner/video/MiniMax"（IO.Schema 写法）
    //   - 旧式节点 CATEGORY = "api node/video/Minimax"（传统写法）
    //   两种前缀均识别（大小写不敏感），ComfyUI 若再改名只是发现静默失效，
    //   静态 template-list.json 的 13 条不受影响（合并时静态优先）。
    //
    // 推导产物 = registry 条目（template-list.json 同构）+ 模板卡片（select 用）：
    //   classType/id ← 节点名；name ← display_name；category ← category 第 2 段
    //   （仅收 video/image——buildSchemaDrivenWorkflow 的输出节点只支持两类）；
    //   modelKey/modelValue ← 名为 model 的 COMBO 及其 default；
    //   promptKey ← 名含 prompt 的 STRING 输入；imageInputKeys ← IMAGE 输入端口；
    //   videoInputKeys ← VIDEO 输入端口；needsImage/optionalImage ← IMAGE 端口必选性。
    // 全部字段在消费端（schemaToParams/buildSchemaDrivenWorkflow）有兜底，
    // 推导不出来就留空走兜底，不阻塞注册。
    //
    // 纯函数设计：输入 objectInfo 全量目录 + 静态清单，输出待注册条目，便于单测。
    // ============================================================================

    var PARTNER_CATEGORY_PREFIXES = ['partner/', 'api node/'];
    // 表单/画布输出链只支持这两类（buildSchemaDrivenWorkflow 硬编码 SaveVideo/SaveImage）
    var SUPPORTED_MEDIA = { video: 1, image: 1 };

    function _isPartnerCategory(category) {
        if (!category || typeof category !== 'string') return false;
        var lower = category.toLowerCase();
        for (var i = 0; i < PARTNER_CATEGORY_PREFIXES.length; i++) {
            if (lower.indexOf(PARTNER_CATEGORY_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    // 从 category 提取媒体类型：partner/video/MiniMax → video；api node/image/X → image
    function _mediaFromCategory(category) {
        var segs = String(category || '').split('/');
        for (var i = 0; i < segs.length; i++) {
            var seg = segs[i].trim().toLowerCase();
            if (SUPPORTED_MEDIA[seg]) return seg;
        }
        return null;
    }

    function _specTypeStr(spec) {
        if (!Array.isArray(spec) || !spec.length) return null;
        return Array.isArray(spec[0]) ? 'COMBO' : String(spec[0]);
    }

    // 归并 required+optional 输入为 [{name, spec, required}]（跳过 hidden——
    // schemaToParams 也只读 required/optional，auth token 等隐藏输入不进表单）
    function _collectInputs(nodeDef) {
        var out = [];
        var input = (nodeDef && nodeDef.input) || {};
        var groups = [['required', input.required || {}], ['optional', input.optional || {}]];
        for (var g = 0; g < groups.length; g++) {
            var src = groups[g][1];
            var keys = Object.keys(src);
            for (var k = 0; k < keys.length; k++) {
                var spec = src[keys[k]];
                if (Array.isArray(spec) && spec.length) {
                    out.push({ name: keys[k], spec: spec, required: (g === 0) });
                }
            }
        }
        return out;
    }

    // DynamicCombo（COMFY_DYNAMICCOMBO_V3）嵌套端口扫描：取首个 option 的
    // required/optional，key 拼接对齐 templateEngine.extractSchemaImagePorts
    // 的 scanDC 规则（dcPrefix+subKey 与 dcPrefix+subKey.innerKey 两级），保证
    // 与运行时 extractSchemaImagePorts 产出的端口名一致（mapImagePorts 命中；
    // 静态条目同款格式，如 seedance2_ref 的 model.reference_images.image_1）。
    // 返回 {imageKeys, videoKeys, hasRequiredImage}；畸形结构静默返回空。
    function _scanDynamicComboPorts(dcKey, spec) {
        var result = { imageKeys: [], videoKeys: [], hasRequiredImage: false };
        var opts = (spec[1] && spec[1].options) || [];
        if (!opts.length || !opts[0] || !opts[0].inputs) return result;
        var dcInputs = opts[0].inputs;
        var prefix = dcKey + '.';
        var groups = [[dcInputs.required || {}, true], [dcInputs.optional || {}, false]];
        for (var g = 0; g < groups.length; g++) {
            var src = groups[g][0];
            var isReq = groups[g][1];
            var keys = Object.keys(src);
            for (var k = 0; k < keys.length; k++) {
                var sub = src[keys[k]];
                if (!sub) continue;
                if (Array.isArray(sub)) {
                    // 一级嵌套：subKey 直接是端口 spec
                    var t1 = _specTypeStr(sub);
                    if (t1 === 'IMAGE') {
                        result.imageKeys.push(prefix + keys[k]);
                        if (isReq) result.hasRequiredImage = true;
                    } else if (t1 === 'VIDEO') {
                        result.videoKeys.push(prefix + keys[k]);
                    }
                } else if (typeof sub === 'object') {
                    // 两级嵌套：subKey 是分组（如 images:{image_1:[...]})
                    var inner = Object.keys(sub);
                    for (var iv = 0; iv < inner.length; iv++) {
                        var innerSpec = sub[inner[iv]];
                        var t2 = _specTypeStr(innerSpec);
                        if (t2 === 'IMAGE') {
                            result.imageKeys.push(prefix + keys[k] + '.' + inner[iv]);
                            if (isReq) result.hasRequiredImage = true;
                        } else if (t2 === 'VIDEO') {
                            result.videoKeys.push(prefix + keys[k] + '.' + inner[iv]);
                        }
                    }
                }
            }
        }
        return result;
    }

    // 推导单个节点 → registry 条目 + 模板卡片；不合适返回 null
    function _deriveEntry(nodeName, nodeDef) {
        if (!nodeDef || typeof nodeDef !== 'object') return null;
        var category = nodeDef.category;
        if (!_isPartnerCategory(category)) return null;
        var media = _mediaFromCategory(category);
        if (!media) return null;  // audio/3d 等：表单输出链不支持，跳过

        var inputs = _collectInputs(nodeDef);
        if (!inputs.length) return null;  // 无可填输入（纯工具节点）不值得注册

        var imageInputKeys = [];
        var videoInputKeys = [];
        var promptKey = null;
        var modelKey = null;
        var modelValue = null;
        var hasRequiredImage = false;
        var hasOptionalImage = false;

        for (var i = 0; i < inputs.length; i++) {
            var inp = inputs[i];
            var typeStr = _specTypeStr(inp.spec);
            if (typeStr === 'IMAGE') {
                imageInputKeys.push(inp.name);
                if (inp.required) hasRequiredImage = true;
                else hasOptionalImage = true;
            } else if (typeStr === 'VIDEO') {
                videoInputKeys.push(inp.name);
            } else if (typeStr === 'STRING') {
                // promptKey：名含 prompt 的字符串输入（prompt_text/prompt 均命中）
                if (!promptKey && /prompt/i.test(inp.name)) promptKey = inp.name;
            } else if (typeStr === 'COMBO') {
                // modelKey：名为 model 的下拉（伙伴节点惯例）
                if (inp.name === 'model' && !modelKey) {
                    modelKey = inp.name;
                    var extra = inp.spec[1];
                    if (extra && typeof extra === 'object' && extra.default !== undefined) {
                        modelValue = extra.default;
                    } else if (Array.isArray(inp.spec[0]) && inp.spec[0].length) {
                        modelValue = inp.spec[0][0];
                    }
                }
            } else if (typeStr === 'COMFY_DYNAMICCOMBO_V3') {
                // DynamicCombo（如 ByteDance 系的 model 选择器）：嵌套端口按首个
                // option 提取（默认模型的输入面），运行时 schemaToParams 会按用户
                // 切换的 option 动态刷新参数。
                // 名为 model 的 DynamicCombo 同时登记 modelKey/modelValue（对齐静态
                // 条目 seedance2_ref 形态）——view.js 的切换联动、schemaToParams 的
                // select 默认值、extractSchemaImagePorts 的精确 option 匹配都依赖
                // 这两字段；缺省时切换模型版本不刷新子参数（合并态参数误提交 →
                // ComfyUI unknown kwarg），下拉初始空选
                if (inp.name === 'model' && !modelKey) {
                    modelKey = inp.name;
                    var dcOpts = (inp.spec[1] && inp.spec[1].options) || [];
                    if (dcOpts.length && dcOpts[0] && dcOpts[0].key !== undefined) {
                        modelValue = String(dcOpts[0].key);
                    }
                }
                var dc = _scanDynamicComboPorts(inp.name, inp.spec);
                if (dc.imageKeys.length) {
                    imageInputKeys = imageInputKeys.concat(dc.imageKeys);
                    if (dc.hasRequiredImage) hasRequiredImage = true;
                    else hasOptionalImage = true;
                }
                if (dc.videoKeys.length) videoInputKeys = videoInputKeys.concat(dc.videoKeys);
            }
        }

        var displayName = (nodeDef.display_name && String(nodeDef.display_name)) || nodeName;
        // mode 语义对齐静态清单：video→i2v/t2v，image→i2i/t2i
        var mode;
        if (media === 'video') mode = hasRequiredImage ? 'i2v' : 't2v';
        else mode = hasRequiredImage ? 'i2i' : 't2i';
        var entry = {
            id: nodeName,
            name: displayName,
            category: media,
            mode: mode,
            templateId: nodeName,
            classType: nodeName,
            modelKey: modelKey,
            modelValue: (modelValue === undefined) ? null : modelValue,
            promptKey: promptKey,
            needsImage: hasRequiredImage,
            optionalImage: hasOptionalImage,
            cloud: true,      // 伙伴节点全走 API（消耗积分）
            auto: true        // 自动发现标记（调试/测试用，静态条目无此字段）
        };
        if (imageInputKeys.length) entry.imageInputKeys = imageInputKeys;
        if (videoInputKeys.length) entry.videoInputKeys = videoInputKeys;

        // 模板卡片（templateEngine.templates 同构；parameters 留空——
        // selectTemplate 对非 pipeline 走 getModelParams 拉 schema 参数）
        var card = {
            id: nodeName,
            name: displayName,
            description: String(nodeDef.description || ''),
            category: media,
            mode: entry.mode,
            cloud: true,
            parameters: [],
            workflow: null
        };
        return { entry: entry, card: card };
    }

    /**
     * 扫描 /object_info 全量目录，推导伙伴节点注册条目。
     * @param objectInfo  /object_info 响应（{nodeClass: {input, category, display_name, ...}}）
     * @param existingClassTypes  静态清单已注册的 classType 集合（数组或 Set）——命中则跳过（静态优先）
     * @returns {Array<{entry, card}>}
     */
    function discoverPartnerNodes(objectInfo, existingClassTypes) {
        var out = [];
        if (!objectInfo || typeof objectInfo !== 'object') return out;
        var seen = {};
        if (Array.isArray(existingClassTypes)) {
            for (var e = 0; e < existingClassTypes.length; e++) seen[existingClassTypes[e]] = 1;
        } else if (existingClassTypes && typeof existingClassTypes.forEach === 'function') {
            existingClassTypes.forEach(function (ct) { seen[ct] = 1; });
        }
        Object.keys(objectInfo).forEach(function (nodeName) {
            if (seen[nodeName]) return;  // 静态条目优先，不重复注册
            var derived = _deriveEntry(nodeName, objectInfo[nodeName]);
            if (derived) out.push(derived);
        });
        return out;
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.partnerDiscovery = {
        discoverPartnerNodes: discoverPartnerNodes,
        _isPartnerCategory: _isPartnerCategory,
        _mediaFromCategory: _mediaFromCategory
    };
})(typeof global !== 'undefined' ? global : window);
