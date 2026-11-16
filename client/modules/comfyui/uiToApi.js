(function (global) {
    'use strict';

    // ============================================================================
    // ComfyUI 官方模板 UI 格式 → API 格式转换器
    // （官方模板全部是 UI 保存格式，/prompt 端点只收 API 格式，
    //  转换是 LLM 路径接官方库的核心工程量。）
    //
    // 输入：UI 工作流 {nodes:[...], links:[[id,src,srcSlot,dst,dstSlot,type],...]}
    //       + /object_info 全量目录 {classType: {input:{required,optional},...}}
    // 输出：aefs Result 三态——{ok:true, data:{"<id>":{class_type,inputs}}} 或
    //       {ok:false, error:{code, message, node:{id,type}}}
    //
    // 实现为 ComfyUI 前端 graphToPrompt 的保守子集：
    //  - widgets_values 位置式 → 按 object_info 的 input 定义顺序（required 后 optional）
    //    解析为具名 inputs；已连接输入跳过 widget 取值（converted widget 语义）
    //  - widget 值对位两形态（全库 619 模板实测，3327 个含
    //    converted-widget 节点中 99.4% 为占位式）：
    //      · 占位式：已连接 widget 仍占 widgets_values 位置（官方库现状；
    // ComfyUI 官方 issue 的错位即发生在此区域，本转换器按占位式
    //        优先消费 + 跳位式回落，两端都能对齐）
    //      · 跳位式：已连接 widget 不占位（旧假设）
    //  - widgets_values_named（新版序列化的按名权威值表，1172 节点）：存在且非空时
    //    未连接 widget 一律按名取值，天然免疫 control_after_generate/动态 widget 错位
    //  - widget 判定（isWidgetInput）：数组/标量白名单/动态下拉/MATCHTYPE 是 widget；
    //    spec 尾 forceInput:true → 强制连接槽；socketless:true → widget-only 输入；
    //    自定义标量类型（COLOR/IMAGECOMPARE/BOUNDING_BOXES…）带 default 且非核心
    //    socket 类型 → widget（值优先 widgets_values，其次 spec default）
    //  - widget 字面值形状：数组型值输出 {__value__: [...]}（服务端把裸数组当连接引用，
    //    execution.py 解包 __value__ 后交给节点）；连接槽引用 [nodeId, slot] 不包。
    //    required socketless widget 无值且 spec 无 default → 输出 null（服务端要求该键
    //    存在，省略会被判 required_input_missing；节点自身默认值生效）
    //  - seed 类 INT/FLOAT widget 后跟 control_after_generate 控制串（fixed/
    //    increment/decrement/randomize）→ 消费但不输出
    //  - bypass（mode 4）节点：下游引用沿同类型输入链穿透到最近的活跃上游
    //  - PrimitiveNode / Reroute：UI-only 节点，链接解析时取字面值 / 穿透
    //  - Note / MarkdownNote：纯注释节点，整体跳过
    //  - 子图（definitions.subgraphs，全库 40% 模板）：expandSubgraphs 先展开成平铺
    //    图再转换；node.subgraph 内联形态（LiteGraph 原生子图，官方库未见）仍明确报错
    //  - mute（mode 2）、object_info 缺失：明确报错（不猜——宁拒勿错，ComfyUI 校验
    //    错误比转换错误更难读）。唯一例外：**无进出槽**的界面控制节点缺失于 object_info
    //    （rgthree 的 Fast Groups Bypasser / Fast Muter 一族，多个官方模板在用）——它们
    //    不参与数据流、语义已落到受影响节点的 mode 上，跳过本体并在结果 skipped 里如实列出
    //    （调用方给可见提示），不因一个开关节点硬拒整张模板。
    //  - V3 动态输入（ComfyUI 0.39.0 官方模板已大面积使用，server 侧 comfy_api/latest/_io.py
    //    的 DynamicCombo/Autogrow + build_nested_inputs 决定 API 契约）：
    //      · COMFY_DYNAMICCOMBO_V3：值是选中 option.key；选中项的 inputs 作为额外 widget
    //        序列化（named 用点号全路径 "format.bit_depth"）。API 键同样用点号路径，
    //        子输入自身是 dynamic combo 时继续递归（"format.codec"、"format.codec.encoding"）
    //      · COMFY_MATCHTYPE_V3：可连接（连接优先）也可当 widget（未连接时取位置/按名值）
    //      · COMFY_AUTOGROW_V3：不是 widget，UI 展开成连接槽（槽名 parent.<name>，前缀
    //        来自 template.prefix / template.names）；API 键即槽名原样，无槽则不输出
    //      · 位置式容错：widget 值不足时用 spec 默认值回填（optional/required 同规则，
    //        ComfyUI 前端加载旧模板时同样按默认值补 widget）；声明 widget 消费完仍有
    //        剩余值时视为 hidden V3 输入丢弃，并在结果 skipped 里记 dropped 计数
    //      · 动态下拉值不在 options 中 → DYNAMIC_COMBO_INVALID（带节点与合法 key，不静默猜）
    // ============================================================================

    var WIDGET_TYPES = { INT: 1, FLOAT: 1, STRING: 1, TEXT: 1, BOOLEAN: 1, COMBO: 1 };
    // ComfyUI 核心 socket 类型（comfy/comfy_types/node_typing.py 的 IO 枚举）：只作连接槽，
    // 即使 spec 尾带 default 也不当 widget（V1 自定义节点会给 socket 声明 default）
    var SOCKET_TYPES = {
        IMAGE: 1, MASK: 1, LATENT: 1, CONDITIONING: 1, SAMPLER: 1, SIGMAS: 1, GUIDER: 1,
        NOISE: 1, CLIP: 1, CONTROL_NET: 1, VAE: 1, MODEL: 1, LORA_MODEL: 1, LOSS_MAP: 1,
        CLIP_VISION: 1, CLIP_VISION_OUTPUT: 1, STYLE_MODEL: 1, GLIGEN: 1, UPSCALE_MODEL: 1,
        AUDIO: 1, WEBCAM: 1, POINT: 1, FACE_ANALYSIS: 1, BBOX: 1, SEGS: 1, VIDEO: 1, '*': 1
    };
    // V3 动态输入类型（本机 ComfyUI 0.39.0 /object_info 实测 + server 侧
    // comfy_api/latest/_io.py 的 DynamicCombo/Autogrow 实现）：
    //  - COMFY_DYNAMICCOMBO_V3：动态下拉。widget，值为选中 option.key；选中项的 inputs
    //    会作为额外 widget 序列化，API 键为点号路径 parent.child（可继续嵌套 dynamic combo）
    //  - COMFY_MATCHTYPE_V3：可连接也可当 widget（连接优先，未连接取字面值）
    //  - COMFY_AUTOGROW_V3：不是 widget，按「连接组」处理（UI 槽名即 API 键）
    var DYNAMIC_COMBO_TYPE = 'COMFY_DYNAMICCOMBO_V3';
    var MATCHTYPE_TYPE = 'COMFY_MATCHTYPE_V3';
    var AUTOGROW_TYPE = 'COMFY_AUTOGROW_V3';
    var CONTROL_VALUES = { fixed: 1, increment: 1, decrement: 1, randomize: 1 };
    // 新版 ComfyUI 上传类节点的 widget 尾部类型标记（upload 按钮的隐式值，非输入）
    var UPLOAD_WIDGET_MARKS = { image: 1, video: 1, audio: 1, output: 1 };
    var UI_ONLY_NOTE_TYPES = { Note: 1, MarkdownNote: 1 };
    // 动态 combo 嵌套深度上限（官方库最深 3 层：format.codec.encoding，兜底防环）
    var MAX_DYNAMIC_DEPTH = 12;

    function err(code, message, node) {
        return { ok: false, error: { code: code, message: message, node: node || null } };
    }

    function hasOwn(obj, key) {
        return !!obj && Object.prototype.hasOwnProperty.call(obj, key);
    }

    // spec 是否可当 widget（对齐 ComfyUI 前端 graphToPrompt 的 widget 判定）：
    //  - forceInput:true → 强制连接槽，类型是标量也不当 widget（不占 widgets_values 位置）
    //  - socketless:true → widget-only 输入（无连接槽）
    //  - 数组 = combo；标量白名单 / V3 动态下拉 / MATCHTYPE = widget
    //  - spec 尾带 widgetType（如 "FLOAT,INT" + widgetType:"FLOAT"）→ widget：
    //    ComfyUI 用 widgetType 标明多类型串里实际使用的 widget 类型
    //  - 自定义标量类型（COLOR / IMAGECOMPARE / BOUNDING_BOXES…）：spec 尾带 default
    //    且非核心 socket 类型 / 非多类型串（"A,B,C" 是连接槽）→ widget
    // 其余（IMAGE/MODEL/LATENT/AUTOGROW/未知 socket 类型…）= 连接槽/连接组
    function isWidgetInput(spec) {
        if (!Array.isArray(spec) || !spec.length) return false;
        var tail = specTail(spec);
        if (tail && tail.forceInput === true) return false;
        if (tail && tail.socketless === true) return true;
        var t = spec[0];
        if (Array.isArray(t)) return true;
        if (typeof t !== 'string') return false;
        if (WIDGET_TYPES[t] === 1) return true;
        if (t === DYNAMIC_COMBO_TYPE || t === MATCHTYPE_TYPE) return true;
        if (tail && tail.widgetType) return true;
        if (!tail || !hasOwn(tail, 'default')) return false;
        if (t.indexOf(',') >= 0) return false;
        return SOCKET_TYPES[t] !== 1;
    }

    // spec 的元数据尾（object_info 的 [类型, {…}] 第二项；无则 null）
    function specTail(spec) {
        var t = spec && spec[1];
        return (t && typeof t === 'object' && !Array.isArray(t)) ? t : null;
    }

    // 数组型 widget 值在 API 格式里包成 {__value__: [...]}：服务端把裸数组当连接引用
    // （长度 2 的 [nodeId, slot]），execution.py 解包 __value__ 后交给节点；连接槽引用不包
    function wrapWidgetValue(v) {
        return Array.isArray(v) ? { __value__: v } : v;
    }

    // socketless widget（widget-only 输入，无连接槽）：服务端要求该键存在（省略会被判
    // required_input_missing），缺值且无 spec default 时提交 null，由节点自身默认值生效
    function isSocketlessWidget(spec) {
        var tail = specTail(spec);
        return !!(tail && tail.socketless === true && tail.forceInput !== true);
    }

    // widget 默认值：① spec[1].default ② 普通 combo 的第一项 ③ dynamic combo 的首个 option.key
    // （ComfyUI 前端加载旧模板时同样按 widget 默认值补齐缺失值，server 侧 V1 节点亦有函数默认值）
    function specDefault(spec) {
        var tail = specTail(spec);
        if (tail && tail.default !== undefined) return { ok: true, value: tail.default };
        if (spec && Array.isArray(spec[0]) && spec[0].length) return { ok: true, value: spec[0][0] };
        if (spec && spec[0] === DYNAMIC_COMBO_TYPE) {
            var opts = dynamicOptions(spec);
            if (opts.length && opts[0] && opts[0].key !== undefined) return { ok: true, value: opts[0].key };
        }
        return { ok: false };
    }

    function dynamicOptions(spec) {
        var tail = specTail(spec);
        return (tail && Array.isArray(tail.options)) ? tail.options : [];
    }

    function findDynamicOption(spec, value) {
        var opts = dynamicOptions(spec);
        for (var i = 0; i < opts.length; i++) {
            if (opts[i] && String(opts[i].key) === String(value)) return opts[i];
        }
        return null;
    }

    function dynamicValueError(fullKey, spec, value) {
        var keys = [];
        var opts = dynamicOptions(spec);
        for (var i = 0; i < opts.length; i++) {
            if (opts[i] && opts[i].key !== undefined) keys.push(String(opts[i].key));
        }
        return {
            code: 'DYNAMIC_COMBO_INVALID',
            message: '动态下拉值非法: ' + fullKey + '=' + JSON.stringify(value) +
                '（合法值: ' + (keys.length ? keys.join(' / ') : '无') + '）'
        };
    }

    // 节点定义是否含 V3 动态输入（根层）：决定位置式剩余值能否按 hidden V3 输入丢弃
    function defHasV3Input(def) {
        var groups = [def.input.required || {}, def.input.optional || {}];
        for (var g = 0; g < groups.length; g++) {
            var names = Object.keys(groups[g]);
            for (var i = 0; i < names.length; i++) {
                var spec = groups[g][names[i]];
                if (Array.isArray(spec) && (spec[0] === DYNAMIC_COMBO_TYPE ||
                    spec[0] === MATCHTYPE_TYPE || spec[0] === AUTOGROW_TYPE)) return true;
            }
        }
        return false;
    }


    // 无进出槽节点判定：inputs / outputs 都必须是**存在且为空**的数组（正面证据）。
    // 字段缺省（老序列化/手写模板）一律按「可能有槽」保守处理——读不到 outputs 不等于
    // 没有输出，把 CheckpointLoaderSimple 这类真节点当开关静默跳过会直接丢节点。
    // 命中者（rgthree 的 Fast Groups Bypasser / Fast Muter 一族）只是界面开关：
    // 既不消费上游也不产出给下游，语义靠把受影响节点置 mode 4 落地。
    function _isSlotlessNode(n) {
        return Array.isArray(n.inputs) && n.inputs.length === 0 &&
               Array.isArray(n.outputs) && n.outputs.length === 0;
    }

    // ============================================================================
    // 子图展开：definitions.subgraphs（官方子图格式）→ 平铺 UI 工作流
    // 全库实测 619 模板中 244 个（40%）使用子图；真实形态：
    //   - 实例节点 type = 子图定义 UUID（definitions.subgraphs[].id）
    //   - 定义体：inputs/outputs（边界端口，linkIds 指向边界 link）+ nodes + links
    //   - 内部 links 为对象格式 {id, origin_id, origin_slot, target_id, target_slot, type}
    //   - 边界虚拟节点：被 links 引用但不在 nodes[]（通常 -10 入 / -20 出，少数模板
    //     用其他 id——按 sgInputs/sgOutputs 的 linkIds 引用动态推导；linkIds 之外的
    //     幽灵 id（已删节点的残留 link）按死链丢弃，与 ComfyUI 前端语义一致）
    // 展开语义（对齐 ComfyUI 前端 graphToPrompt，参照 comfyui-mcp expandComponents）：
    //   - 内部节点/链接克隆进主图，全新 id 防多实例与嵌套冲突
    //   - 实例输入（按名匹配子图输入端口）：边界 link 全部改接外部源
    //   - 实例输出（按名匹配子图输出端口）：改接内部真实源
    //   - 提升值两形态：v2（无 proxyWidgets，widgets_values 位置对应 sg.inputs，
    //     新版 ComfyUI 序列化）/ v1（properties.proxyWidgets [[内部id, widget名]] 与
    //     widgets_values 位置对应；'-1' 指子图输入端口本身）→ 合成
    //     PrimitiveNode 字面值链注入内部消费点（复用现有 literal 机制，零位置推导）
    //   - 未连且无提升值的边界输入：清槽回落内部节点自身 widget 默认值（配合占位式
    // 消费恰好还原 UI 显示值——上游在此错位而本实现语义正确）
    //   - 实例 bypass(m4)/mute(m2)：内部节点整体标记同 mode（bypass 走既有穿透，
    //     mute 保持 MUTED_NODE 拒绝）
    // ============================================================================

    function expandSubgraphs(wf) {
        var defs = (wf.definitions && Array.isArray(wf.definitions.subgraphs)) ? wf.definitions.subgraphs : [];
        if (!defs.length) return { ok: true, data: wf };
        var sgMap = {};
        var d, i;
        for (d = 0; d < defs.length; d++) {
            if (defs[d] && defs[d].id) sgMap[defs[d].id] = defs[d];
        }

        var nodes = JSON.parse(JSON.stringify(wf.nodes || []));
        var links = JSON.parse(JSON.stringify(wf.links || []));

        // 新 id 分配基准：越过主图与全部定义体的既有节点/链接 id
        var nextNodeId = 1, nextLinkId = 1;
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i] && typeof nodes[i].id === 'number' && nodes[i].id >= nextNodeId) nextNodeId = nodes[i].id + 1;
        }
        for (i = 0; i < links.length; i++) {
            if (Array.isArray(links[i]) && typeof links[i][0] === 'number' && links[i][0] >= nextLinkId) nextLinkId = links[i][0] + 1;
        }
        for (d = 0; d < defs.length; d++) {
            var dn = defs[d].nodes || [], dl = defs[d].links || [];
            for (i = 0; i < dn.length; i++) {
                if (dn[i] && typeof dn[i].id === 'number' && dn[i].id >= nextNodeId) nextNodeId = dn[i].id + 1;
            }
            for (i = 0; i < dl.length; i++) {
                if (dl[i] && typeof dl[i].id === 'number' && dl[i].id >= nextLinkId) nextLinkId = dl[i].id + 1;
            }
        }

        var MAX_PASSES = 10;
        for (var pass = 0; pass < MAX_PASSES; pass++) {
            var instances = [];
            for (i = 0; i < nodes.length; i++) {
                if (nodes[i] && sgMap[nodes[i].type]) instances.push(nodes[i]);
            }
            if (!instances.length) break;
            for (var k = 0; k < instances.length; k++) {
                var one = _expandOneSubgraph(instances[k], sgMap[instances[k].type], nodes, links, nextNodeId, nextLinkId);
                if (!one.ok) return one;
                nodes = one.nodes;
                links = one.links;
                nextNodeId = one.nextNodeId;
                nextLinkId = one.nextLinkId;
            }
        }
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i] && sgMap[nodes[i].type]) {
                return err('SUBGRAPH_DEPTH', '子图嵌套超过 ' + MAX_PASSES + ' 层（疑似循环引用），无法展开');
            }
        }
        var out = {};
        for (var key in wf) out[key] = wf[key];
        out.nodes = nodes;
        out.links = links;
        return { ok: true, data: out };
    }

    // 展开单个子图实例（返回 {ok, nodes, links, nextNodeId, nextLinkId} 或 err）
    function _expandOneSubgraph(comp, sg, nodes, links, nextNodeId, nextLinkId) {
        var i, j;
        var innerNodes = sg.nodes || [];
        var innerLinks = sg.links || [];
        var sgInputs = sg.inputs || [];
        var sgOutputs = sg.outputs || [];

        var nodeRemap = {};
        for (i = 0; i < innerNodes.length; i++) nodeRemap[String(innerNodes[i].id)] = nextNodeId++;
        var linkRemap = {};
        for (i = 0; i < innerLinks.length; i++) {
            if (innerLinks[i]) linkRemap[String(innerLinks[i].id)] = nextLinkId++;
        }

        // 输入边界节点 id：sgInputs[].linkIds 所指 link 的 origin（动态推导，不硬编码 -10）
        var inBoundary = {};
        var linkById = {};
        for (i = 0; i < innerLinks.length; i++) {
            if (innerLinks[i]) linkById[String(innerLinks[i].id)] = innerLinks[i];
        }
        for (i = 0; i < sgInputs.length; i++) {
            var lids = sgInputs[i].linkIds || [];
            for (j = 0; j < lids.length; j++) {
                var il = linkById[String(lids[j])];
                if (il && !nodeRemap.hasOwnProperty(String(il.origin_id))) {
                    inBoundary[String(il.origin_id)] = 1;
                }
            }
        }

        // 克隆内部节点（槽位/输出链接引用换新 id；实例 bypass/mode 传播）
        var clones = [];
        var cloneById = {};
        for (i = 0; i < innerNodes.length; i++) {
            var c = JSON.parse(JSON.stringify(innerNodes[i]));
            c.id = nodeRemap[String(innerNodes[i].id)];
            var cin = c.inputs || [];
            for (j = 0; j < cin.length; j++) {
                if (cin[j] && cin[j].link !== null && cin[j].link !== undefined) {
                    var rm = linkRemap[String(cin[j].link)];
                    if (rm !== undefined) cin[j].link = rm;
                }
            }
            var cout = c.outputs || [];
            for (j = 0; j < cout.length; j++) {
                if (cout[j] && Array.isArray(cout[j].links)) {
                    for (var q = 0; q < cout[j].links.length; q++) {
                        var rm2 = linkRemap[String(cout[j].links[q])];
                        if (rm2 !== undefined) cout[j].links[q] = rm2;
                    }
                }
            }
            if (comp.mode === 4 || comp.mode === 2) c.mode = comp.mode;
            clones.push(c);
            cloneById[String(c.id)] = c;
        }

        // 内部链接 → 主图数组格式（边界/幽灵链不进输出——凡引用非内部节点即丢弃）
        var newLinks = [];
        for (i = 0; i < innerLinks.length; i++) {
            var l = innerLinks[i];
            if (!l) continue;
            var srcId = nodeRemap[String(l.origin_id)];
            var tgtId = nodeRemap[String(l.target_id)];
            if (srcId === undefined || tgtId === undefined) continue;
            newLinks.push([linkRemap[String(l.id)], srcId, l.origin_slot, tgtId, l.target_slot, l.type]);
        }

        // 主图链接索引（改接外部链用）
        var outerLinkById = {};
        for (i = 0; i < links.length; i++) {
            if (Array.isArray(links[i])) outerLinkById[String(links[i][0])] = links[i];
        }
        var linksToRemove = {};
        var linksToAdd = [];

        // 实例输入槽 → 子图输入端口：具名槽按名匹配；空名槽（真实数据存在未命名
        // 端口，如 templates-1_click 的 ""/_1/_2/_3 连接槽）按两侧序列 zip 对齐。
        // sg 输入无实例槽是正常形态（widget 未暴露为槽，如 krea2 的 14 输入仅
        // 10 个有槽）；反之实例槽找不到 sg 输入 = 定义与实例端口表不一致，fail-closed
        var compInputByName = {};
        var compEmptySlots = [];
        var compInputs = comp.inputs || [];
        for (i = 0; i < compInputs.length; i++) {
            if (!compInputs[i]) continue;
            if (compInputs[i].name) compInputByName[compInputs[i].name] = compInputs[i];
            else compEmptySlots.push(compInputs[i]);
        }
        var sgInputNames = {};
        var sgEmptyInputIdx = [];
        for (i = 0; i < sgInputs.length; i++) {
            if (sgInputs[i].name) sgInputNames[sgInputs[i].name] = 1;
            else sgEmptyInputIdx.push(i);
        }
        for (var ckey in compInputByName) {
            if (!sgInputNames[ckey]) {
                return err('SUBGRAPH_IO_MISMATCH',
                    '子图实例 #' + comp.id + ' 的输入端口「' + ckey + '」在定义中不存在',
                    { id: comp.id, type: comp.type });
            }
        }
        // 空名槽 ↔ 空名端口按序 zip
        var emptySlotByInputIdx = {};
        for (i = 0; i < compEmptySlots.length && i < sgEmptyInputIdx.length; i++) {
            emptySlotByInputIdx[sgEmptyInputIdx[i]] = compEmptySlots[i];
        }

        // 每个子图输入端口的边界 link 全集：linkIds 为主 + 同边界节点同 slot 的
        // 未列出链兜底（de-virtualization 重挂链，参照 comfyui-mcp；全库实测 9 条）
        function boundaryLinksForInput(idx) {
            var seen = {};
            var out = [];
            var lids = (sgInputs[idx] && sgInputs[idx].linkIds) || [];
            for (var a = 0; a < lids.length; a++) {
                var il2 = linkById[String(lids[a])];
                if (il2 && !seen[String(il2.id)] && inBoundary[String(il2.origin_id)]) {
                    seen[String(il2.id)] = 1;
                    out.push(il2);
                }
            }
            for (var b = 0; b < innerLinks.length; b++) {
                var il3 = innerLinks[b];
                if (!il3 || seen[String(il3.id)]) continue;
                if (inBoundary[String(il3.origin_id)] && String(il3.origin_slot) === String(idx)) {
                    seen[String(il3.id)] = 1;
                    out.push(il3);
                }
            }
            return out;
        }

        // 提升值（v2：无 proxyWidgets，widgets_values 位置对应 sg.inputs；
        // v1：proxyWidgets 与 widgets_values 位置对应）。命名值表优先（25 实例）。
        var pw = (comp.properties && Array.isArray(comp.properties.proxyWidgets)) ? comp.properties.proxyWidgets : [];
        var wv = Array.isArray(comp.widgets_values) ? comp.widgets_values : [];
        var wvNamed = (comp.widgets_values_named && typeof comp.widgets_values_named === 'object'
            && !Array.isArray(comp.widgets_values_named)) ? comp.widgets_values_named : null;
        var wvNamedHasKeys = false;
        if (wvNamed) {
            for (var vnk in wvNamed) {
                if (Object.prototype.hasOwnProperty.call(wvNamed, vnk)) { wvNamedHasKeys = true; break; }
            }
        }
        var v2 = !(pw && pw.length); // v1 = 有 proxyWidgets；v2 = 无（新版序列化）
        var namedHas = function (name) {
            return !!(wvNamed && Object.prototype.hasOwnProperty.call(wvNamed, name));
        };
        // v2 提升值取值：named 表存在且非空时**只认 named 表**——named 缺键 = 该端口无
        // 提升值（走清槽分支回落内部默认值）。位置数组的下标是 widget 序列化序，与子图
        // 输入端口序无关（前几个端口常是未连接的 IMAGE 输入，根本不在 named 表里），
        // 按位置回退会把 widgets_values[0] 的提示词文本灌进 first_frame 这类端口
        //（真机 E2E：video_minimax_h3_t2v 执行期 string indices must be integers）。
        // 位置回退只保留给「无 named 表」的旧序列化。
        var valueForInput = function (idx, name) {
            if (namedHas(name)) return wvNamed[name];
            if (wvNamedHasKeys) return undefined;
            return (idx < wv.length) ? wv[idx] : undefined;
        };

        // ---- 逐输入端口：外部改接 / 提升值注入 / 清槽 ----
        for (i = 0; i < sgInputs.length; i++) {
            var sgInput = sgInputs[i];
            var blinks = boundaryLinksForInput(i);
            var compSlot = sgInput.name ? compInputByName[sgInput.name] : emptySlotByInputIdx[i];
            var outerLink = (compSlot && compSlot.link !== null && compSlot.link !== undefined)
                ? outerLinkById[String(compSlot.link)] : null;

            if (outerLink) {
                // 已连接：外部源改接全部边界消费点
                for (j = 0; j < blinks.length; j++) {
                    var bl = blinks[j];
                    var consumer = cloneById[String(nodeRemap[String(bl.target_id)])];
                    if (!consumer || !consumer.inputs) continue;
                    var slot = consumer.inputs[bl.target_slot];
                    if (!slot) continue;
                    var newId = nextLinkId++;
                    linksToAdd.push([newId, outerLink[1], outerLink[2], consumer.id, bl.target_slot, bl.type]);
                    slot.link = newId;
                    // 外部源若为未展开的嵌套实例，登记新链防后续展开丢链
                    for (var w = 0; w < nodes.length; w++) {
                        if (nodes[w] && nodes[w].id === outerLink[1] && Array.isArray(nodes[w].outputs)) {
                            var so = nodes[w].outputs[outerLink[2]];
                            if (so) {
                                if (!Array.isArray(so.links)) so.links = [];
                                so.links.push(newId);
                            }
                            break;
                        }
                    }
                }
                if (compSlot) linksToRemove[String(compSlot.link)] = 1;
            } else {
                // 未连接：提升值（v2 按端口序 / v1 '-1' 项按端口名）或清槽
                var value = v2 ? valueForInput(i, sgInput.name) : undefined;
                if (!v2) {
                    for (var p = 0; p < pw.length; p++) {
                        if (Array.isArray(pw[p]) && String(pw[p][0]) === '-1' && pw[p][1] === sgInput.name) {
                            value = (p < wv.length) ? wv[p] : value;
                        }
                    }
                }
                if (value !== undefined && value !== null) {
                    // 合成 Primitive 字面值节点，链入全部消费点（复用现有 literal 机制）
                    var primId = nextNodeId++;
                    var primLinkIds = [];
                    for (j = 0; j < blinks.length; j++) {
                        var bl2 = blinks[j];
                        var consumer2 = cloneById[String(nodeRemap[String(bl2.target_id)])];
                        if (!consumer2 || !consumer2.inputs) continue;
                        var slot2 = consumer2.inputs[bl2.target_slot];
                        if (!slot2) continue;
                        var plink = nextLinkId++;
                        linksToAdd.push([plink, primId, 0, consumer2.id, bl2.target_slot, bl2.type]);
                        slot2.link = plink;
                        primLinkIds.push(plink);
                    }
                    if (primLinkIds.length) {
                        clones.push({
                            id: primId, type: 'PrimitiveNode', mode: 0, order: 0, pos: [0, 0], flags: {},
                            properties: {}, inputs: [],
                            widgets_values: [value],
                            outputs: [{ name: sgInput.name, type: sgInput.type || '', links: primLinkIds }]
                        });
                    }
                } else {
                    // 无值：清槽，回落内部节点自身 widget 默认值（占位式消费还原 UI 值）
                    for (j = 0; j < blinks.length; j++) {
                        var bl3 = blinks[j];
                        var consumer3 = cloneById[String(nodeRemap[String(bl3.target_id)])];
                        if (consumer3 && consumer3.inputs && consumer3.inputs[bl3.target_slot]) {
                            consumer3.inputs[bl3.target_slot].link = null;
                        }
                    }
                }
            }
        }

        // ---- v1 真实内部节点的提升值（proxyWidgets [[内部id, widget名]]，按槽名定位）----
        if (pw && pw.length && wv.length) {
            for (var p2 = 0; p2 < pw.length; p2++) {
                var entry = pw[p2];
                if (!Array.isArray(entry) || entry.length < 2) continue;
                var innerId = String(entry[0]);
                var wName = String(entry[1]);
                var val = (p2 < wv.length) ? wv[p2] : undefined;
                if (innerId === '-1' || val === undefined || val === null) continue; // '-1' 已在端口循环处理
                var target = cloneById[String(nodeRemap[innerId])];
                if (!target || !Array.isArray(target.inputs)) continue;
                var tslotIdx = -1;
                for (var t = 0; t < target.inputs.length; t++) {
                    if (target.inputs[t] && target.inputs[t].name === wName) { tslotIdx = t; break; }
                }
                if (tslotIdx < 0) continue; // 非槽位化 widget：保留内部节点自身值（现库无此数据）
                var primId2 = nextNodeId++;
                var plink2 = nextLinkId++;
                target.inputs[tslotIdx].link = plink2;
                linksToAdd.push([plink2, primId2, 0, target.id, tslotIdx, target.inputs[tslotIdx].type || '']);
                clones.push({
                    id: primId2, type: 'PrimitiveNode', mode: 0, order: 0, pos: [0, 0], flags: {},
                    properties: {}, inputs: [],
                    widgets_values: [val],
                    outputs: [{ name: wName, type: target.inputs[tslotIdx].type || '', links: [plink2] }]
                });
            }
        }

        // ---- 实例输出 → 外部消费点改接内部真实源（按名匹配子图输出端口）----
        var compOutputs = comp.outputs || [];
        for (i = 0; i < compOutputs.length; i++) {
            var compOut = compOutputs[i];
            if (!compOut || !Array.isArray(compOut.links) || !compOut.links.length) continue;
            var sgOut = null;
            for (j = 0; j < sgOutputs.length; j++) {
                if (sgOutputs[j].name === compOut.name) { sgOut = sgOutputs[j]; break; }
            }
            if (!sgOut) {
                return err('SUBGRAPH_IO_MISMATCH',
                    '子图实例 #' + comp.id + ' 的输出端口「' + compOut.name + '」在定义中不存在',
                    { id: comp.id, type: comp.type });
            }
            // 输出端口的生产者：linkIds 中指向输出边界的 link 之 origin
            var innerSrcId, innerSrcSlot = 0;
            var olids = sgOut.linkIds || [];
            for (j = 0; j < olids.length; j++) {
                var ol = linkById[String(olids[j])];
                if (ol && nodeRemap[String(ol.origin_id)] !== undefined) {
                    innerSrcId = nodeRemap[String(ol.origin_id)];
                    innerSrcSlot = ol.origin_slot;
                    break;
                }
            }
            if (innerSrcId === undefined) continue; // 无生产者（悬空输出）：外部链一并移除
            // 内部源克隆的输出槽登记新链：源若为未展开的嵌套实例，其后续展开的
            // 输出改接按 outputs[].links 找链——不登记会漏改接留悬空链
            var srcClone = cloneById[String(innerSrcId)];
            for (j = 0; j < compOut.links.length; j++) {
                var olink = outerLinkById[String(compOut.links[j])];
                if (!olink) continue;
                var newId2 = nextLinkId++;
                linksToAdd.push([newId2, innerSrcId, innerSrcSlot, olink[3], olink[4], olink[5]]);
                if (srcClone && Array.isArray(srcClone.outputs) && srcClone.outputs[innerSrcSlot]) {
                    if (!Array.isArray(srcClone.outputs[innerSrcSlot].links)) {
                        srcClone.outputs[innerSrcSlot].links = [];
                    }
                    srcClone.outputs[innerSrcSlot].links.push(newId2);
                }
                linksToRemove[String(olink[0])] = 1;
                // 外部消费点槽位换新链引用
                for (var w2 = 0; w2 < nodes.length; w2++) {
                    if (nodes[w2] && nodes[w2].id === olink[3] && Array.isArray(nodes[w2].inputs)) {
                        for (var s2 = 0; s2 < nodes[w2].inputs.length; s2++) {
                            if (nodes[w2].inputs[s2] && nodes[w2].inputs[s2].link === olink[0]) {
                                nodes[w2].inputs[s2].link = newId2;
                            }
                        }
                        break;
                    }
                }
            }
        }

        // ---- 实例残留链兜底清理：实例输入槽引用的全部旧链（含其他实例改接产生、
        // dst 指向本实例的新链）必须移除——任何未匹配端口的漏网链在实例移除后悬空 ----
        for (i = 0; i < compInputs.length; i++) {
            var rl = compInputs[i] && compInputs[i].link;
            if (rl !== null && rl !== undefined) linksToRemove[String(rl)] = 1;
        }

        // ---- 组装：移除实例本体与旧链，并入克隆与新链 ----
        var resultNodes = [];
        for (i = 0; i < nodes.length; i++) {
            if (nodes[i] && nodes[i].id !== comp.id) resultNodes.push(nodes[i]);
        }
        for (i = 0; i < clones.length; i++) resultNodes.push(clones[i]);
        var resultLinks = [];
        for (i = 0; i < links.length; i++) {
            if (!linksToRemove[String(links[i][0])]) resultLinks.push(links[i]);
        }
        for (i = 0; i < newLinks.length; i++) resultLinks.push(newLinks[i]);
        for (i = 0; i < linksToAdd.length; i++) resultLinks.push(linksToAdd[i]);

        return { ok: true, nodes: resultNodes, links: resultLinks, nextNodeId: nextNodeId, nextLinkId: nextLinkId };
    }

    function convert(wf, catalog) {
        if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes) || !Array.isArray(wf.links)) {
            return err('NOT_UI_FORMAT', AEI18n.t('不是 ComfyUI UI 保存格式（缺 nodes/links 数组）'));
        }
        if (!catalog || typeof catalog !== 'object') {
            return err('NO_CATALOG', AEI18n.t('缺少 /object_info 节点目录，无法解析 widget 顺序'));
        }

        // ---- 0. 子图展开（无 definitions.subgraphs 时零开销直通）----
        var expanded = expandSubgraphs(wf);
        if (!expanded.ok) return expanded;
        wf = expanded.data;

        // ---- 1. 建索引：节点表 + 链接表 ----
        var nodeById = {};
        var i, n;
        for (i = 0; i < wf.nodes.length; i++) {
            n = wf.nodes[i];
            if (n && n.id !== undefined && n.id !== null) nodeById[String(n.id)] = n;
        }
        var linkById = {};
        for (i = 0; i < wf.links.length; i++) {
            var l = wf.links[i];
            if (Array.isArray(l) && l.length >= 5) linkById[String(l[0])] = l;
        }

        // ---- 2. 逐节点检查支持性 ----
        var skipped = [];
        var skippedIds = {};   // id → 1（第 5 步据此从 API 输出里排除，见下）
        for (i = 0; i < wf.nodes.length; i++) {
            n = wf.nodes[i];
            if (!n || !n.type) continue;
            if (UI_ONLY_NOTE_TYPES[n.type]) continue;
            if (n.subgraph !== undefined) {
                return err('SUBGRAPH_UNSUPPORTED',
                    '模板使用了 subgraph（子图）节点，当前转换器暂不支持，请换用无子图的平铺模板（搜索结果可换 name 重试）',
                    { id: n.id, type: n.type });
            }
            if (n.type !== 'Reroute' && n.type !== 'PrimitiveNode' &&
                String(n.type).indexOf('Primitive') !== 0 && !catalog[n.type]) {
                // 无进出槽的界面控制节点（rgthree 的 Fast Groups Bypasser / Fast Muter 一族，
                // 多个官方模板在用）：既不消费也不产出数据，其语义在保存时已落到受影响节点的
                // mode 上（bypass=mode 4，由第 3 步穿透链还原）——本体不进 API 输出，也不因
                // 「本机没装该节点包」硬拒整张模板（真机复现：仅一个旁路开关节点就让整份模板
                // 导入失败）。其余缺节点照旧明确报错（宁拒勿错：widget 顺序无从得知）。
                if (_isSlotlessNode(n)) {
                    skipped.push({ id: n.id, type: n.type });
                    skippedIds[String(n.id)] = 1;
                    continue;
                }
                return err('NODE_NOT_FOUND',
                    AEI18n.t('节点未安装: {type}（该模板依赖的自定义节点在本机 ComfyUI 不存在，可先在 ComfyUI 中安装对应节点包）', { type: n.type }),
                    { id: n.id, type: n.type });
            }
            if (n.mode === 2) {
                return err('MUTED_NODE',
                    '模板包含被静音（mute）的节点，语义无法保守转换，请换用其他模板',
                    { id: n.id, type: n.type });
            }
            if (n.mode !== undefined && n.mode !== 0 && n.mode !== 4) {
                return err('UNSUPPORTED_MODE',
                    '节点 mode=' + n.mode + ' 非常规值（仅支持 0=活跃 / 4=bypass）',
                    { id: n.id, type: n.type });
            }
        }

        // ---- 3. 链接源解析（bypass 穿透 / Reroute 穿透 / Primitive 取字面值） ----
        // 返回 {ref:[nodeId, slot]} | {literal: value}；失败抛字符串消息
        function resolveSource(linkId, depth) {
            if (depth > 64) throw 'bypass/Reroute 穿透链路过深（疑似循环）';
            var link = linkById[String(linkId)];
            if (!link) throw '链接缺失: link#' + linkId;
            var srcNode = nodeById[String(link[1])];
            if (!srcNode) throw '链接指向不存在的节点: ' + link[1];
            var wantType = link[5] || '';

            // bypass（mode 4）：穿透到活跃上游。同槽位索引优先（ComfyUI 前端语义：
            // bypass 输出槽 i 直通输入槽 i，类型可变换——如 AUDIO→VOICE 的克隆节点），
            // 失败再沿同类型输入链找
            if (srcNode.mode === 4) {
                var inputs = srcNode.inputs || [];
                var byIdx = inputs[Number(link[2]) || 0];
                if (byIdx && byIdx.link !== null && byIdx.link !== undefined) {
                    try {
                        return resolveSource(byIdx.link, depth + 1);
                    } catch (_) { /* 同槽位链断，走类型匹配 */ }
                }
                for (var k = 0; k < inputs.length; k++) {
                    var inLink = inputs[k].link;
                    if (inLink === null || inLink === undefined) continue;
                    var inLinkId = String(inLink);
                    var inLinkDef = linkById[inLinkId];
                    // 类型匹配（bypass 节点的输入槽 type 可能缺失，缺省放行第一条）
                    if (!inLinkDef || !inLinkDef[5] || !wantType || inLinkDef[5] === wantType) {
                        try {
                            return resolveSource(inLink, depth + 1);
                        } catch (_) { /* 该输入链断，试下一条 */ }
                    }
                }
                throw 'BYPASS_BROKEN|bypass 节点无可用输入链: #' + srcNode.id + '（' + srcNode.type + '）';
            }
            // Reroute：单输入穿透
            if (srcNode.type === 'Reroute') {
                var rrIn = (srcNode.inputs || [])[0];
                if (rrIn && rrIn.link !== null && rrIn.link !== undefined) {
                    return resolveSource(rrIn.link, depth + 1);
                }
                throw 'Reroute 节点无输入链';
            }
            // PrimitiveNode：输出的是 widget 字面值（widgets_values[0]）
            if (srcNode.type === 'PrimitiveNode' || String(srcNode.type).indexOf('Primitive') === 0) {
                var wv = srcNode.widgets_values;
                var val = Array.isArray(wv) ? wv[0] : wv;
                return { literal: val };
            }
            return { ref: [String(srcNode.id), Number(link[2]) || 0] };
        }

        // ---- 4. 单节点 inputs 构建 ----
        // 值源优先级：① widgets_values_named（按名权威，动态 combo 子输入用点号全路径）
        // ② 位置式两遍（占位式优先，跳位式回落）。动态 combo 选中项的 inputs 按声明顺序
        // 就地展开继续消费；AUTOGROW 按 UI 槽名收集；MATCHTYPE 连接优先、未连接取字面值。
        // 返回 {ok:true, inputs, dropped?} 或 {ok:false, error:{code,message}}。
        function buildNodeInputs(node, def) {
            var slotByName = {};
            var slotNames = [];
            var slots = node.inputs || [];
            var s;
            for (s = 0; s < slots.length; s++) {
                if (slots[s] && slots[s].name) {
                    slotByName[slots[s].name] = slots[s].link;
                    slotNames.push(slots[s].name);
                }
            }
            var groups = [def.input.required || {}, def.input.optional || {}];
            var rootNames = {};
            var g, ni;
            for (g = 0; g < groups.length; g++) {
                var rn = Object.keys(groups[g]);
                for (ni = 0; ni < rn.length; ni++) rootNames[rn[ni]] = 1;
            }

            function slotLinked(name) {
                return slotByName[name] !== undefined && slotByName[name] !== null;
            }
            function linkValue(name) {
                var src = resolveSource(slotByName[name], 0);
                // PrimitiveNode 字面值落到目标 widget 上：数组同样包 __value__；连接引用原样
                return (src.literal !== undefined) ? wrapWidgetValue(src.literal) : src.ref;
            }
            // bypass 断链语义（对齐 ComfyUI 前端）：连接解析失败源于 bypass 链断时，
            // optional 输入省略、required 输入按 LINK_UNRESOLVED 拒绝（提交缺必填的
            // prompt 会被 ComfyUI 拒绝，提前报错带清晰指引）
            function isBypassBroken(msg) {
                return typeof msg === 'string' && msg.indexOf('BYPASS_BROKEN|') === 0;
            }
            function bypassMsg(msg) {
                return String(msg).replace('BYPASS_BROKEN|', '（bypass 链断裂——源节点被旁路且无可用输入，可换用其他模板）');
            }
            // 解析已连接槽：{ok:true, value} | {ok:true, omitted:true} | {ok:false, error}
            function resolveSlot(name, optionalGroup) {
                try {
                    return { ok: true, value: linkValue(name) };
                } catch (msg) {
                    if (isBypassBroken(msg) && optionalGroup) return { ok: true, omitted: true };
                    return { ok: false, error: { code: 'LINK_UNRESOLVED', message: '输入 ' + name + ' 解析失败: ' + bypassMsg(msg) } };
                }
            }
            // AUTOGROW：声明 key 下 UI 槽 name 以 key+"." 开头的全部连接槽 → 槽名即点号 API 键
            // （值 = 链接引用 / Primitive 字面值；无槽则不输出，对齐 Python 侧 EMPTY_DICT 语义）
            function collectAutogrow(fullKey, inputs) {
                var prefix = fullKey + '.';
                for (var a = 0; a < slotNames.length; a++) {
                    var nm = slotNames[a];
                    if (nm.indexOf(prefix) !== 0 || !slotLinked(nm)) continue;
                    var rr = resolveSlot(nm, true);
                    if (rr.ok && !rr.omitted) inputs[nm] = rr.value;
                }
            }
            // named 模式：动态 combo 选中项的 inputs 递归（prefix 形如 "format."）
            function walkNamedGroup(optInputs, prefix, out, depth) {
                if (depth > MAX_DYNAMIC_DEPTH) {
                    return { ok: false, error: { code: 'DYNAMIC_COMBO_DEPTH', message: '动态下拉嵌套超过 ' + MAX_DYNAMIC_DEPTH + ' 层（疑似循环引用）: ' + prefix } };
                }
                var r1 = walkNamed(optInputs.required || {}, true, prefix, out, depth);
                if (!r1.ok) return r1;
                return walkNamed(optInputs.optional || {}, false, prefix, out, depth);
            }
            function walkNamed(groupObj, requiredGroup, prefix, out, depth) {
                var names = Object.keys(groupObj);
                for (var i = 0; i < names.length; i++) {
                    var k = names[i];
                    var sp = groupObj[k];
                    if (!Array.isArray(sp) || !sp.length) continue;
                    var full = prefix + k;
                    if (sp[0] === AUTOGROW_TYPE) { collectAutogrow(full, out); continue; }
                    if (slotLinked(full)) {
                        var rr = resolveSlot(full, !requiredGroup);
                        if (!rr.ok) return rr;
                        if (!rr.omitted) out[full] = rr.value;
                        continue;
                    }
                    if (!isWidgetInput(sp)) {
                        if (requiredGroup) return { ok: false, error: { code: 'MISSING_INPUT', message: '缺少必需输入: ' + full + '（未连接且非 widget）' } };
                        continue;
                    }
                    var val;
                    var found = false;
                    if (hasOwn(named, full)) {
                        val = named[full];
                        found = true;
                    } else if (prefix && !rootNames[k] && hasOwn(named, k)) {
                        // 部分前端版本把动态子 widget 序列化为裸名（如 SaveVideo 的 codec）；仅当同名键
                        // 不是根层输入时按嵌套子键回退，避免与根层同名字段抢值
                        val = named[k];
                        found = true;
                    }
                    if (!found) {
                        var df = specDefault(sp);
                        if (df.ok) {
                            val = df.value;
                            found = true;
                        } else if (requiredGroup && isSocketlessWidget(sp) && sp[0] !== DYNAMIC_COMBO_TYPE) {
                            val = null;   // socketless widget 无值无默认 → 提交 null（见 isSocketlessWidget）
                            found = true;
                        } else if (requiredGroup) {
                            return { ok: false, error: { code: 'WIDGET_MISMATCH', message: 'widget 值缺失: ' + full + '（按名值表中无此键且无默认值）' } };
                        } else {
                            continue; // optional widget 未物化且无默认 → 省略
                        }
                    }
                    out[full] = wrapWidgetValue(val);
                    if (sp[0] === DYNAMIC_COMBO_TYPE) {
                        var op = findDynamicOption(sp, val);
                        if (!op) return { ok: false, error: dynamicValueError(full, sp, val) };
                        var sub = walkNamedGroup(op.inputs || {}, full + '.', out, depth + 1);
                        if (!sub.ok) return sub;
                    }
                }
                return { ok: true };
            }

            // 位置模式：动态 combo 选中项的 inputs 递归（与当前消费位置共享 wi）
            function walkPosGroup(optInputs, prefix, state, depth) {
                if (depth > MAX_DYNAMIC_DEPTH) {
                    return { ok: false, error: { code: 'DYNAMIC_COMBO_DEPTH', message: '动态下拉嵌套超过 ' + MAX_DYNAMIC_DEPTH + ' 层（疑似循环引用）: ' + prefix } };
                }
                var r1 = walkPos(optInputs.required || {}, true, prefix, state, depth);
                if (!r1.ok) return r1;
                return walkPos(optInputs.optional || {}, false, prefix, state, depth);
            }
            function walkPos(groupObj, requiredGroup, prefix, state, depth) {
                var names = Object.keys(groupObj);
                for (var i = 0; i < names.length; i++) {
                    var k = names[i];
                    var sp = groupObj[k];
                    if (!Array.isArray(sp) || !sp.length) continue;
                    var full = prefix + k;
                    if (sp[0] === AUTOGROW_TYPE) { collectAutogrow(full, state.inputs); continue; }
                    var widget = isWidgetInput(sp);
                    if (slotLinked(full)) {
                        var rr = resolveSlot(full, !requiredGroup);
                        if (!rr.ok) return rr;
                        if (!rr.omitted) state.inputs[full] = rr.value;
                        // 占位式：已连接 widget 仍占 widgets_values 位置（官方库实测 99.4%）。
                        // MATCHTYPE 连接后按纯槽处理：官方库序列化里没有它的占位值，占位会挤位。
                        if (widget && state.occupy && sp[0] !== MATCHTYPE_TYPE && state.wi < state.wv.length) {
                            state.wi++;
                            if ((sp[0] === 'INT' || sp[0] === 'FLOAT') && state.wi < state.wv.length) {
                                var nx = state.wv[state.wi];
                                if (typeof nx === 'string' && CONTROL_VALUES[nx.toLowerCase()] === 1) state.wi++;
                            }
                        }
                        continue;
                    }
                    if (!widget) {
                        if (requiredGroup) return { ok: false, error: { code: 'MISSING_INPUT', message: '缺少必需输入: ' + full + '（未连接且非 widget）' } };
                        continue;
                    }
                    var val;
                    var have = false;
                    if (state.wi < state.wv.length) {
                        val = state.wv[state.wi];
                        state.wi++;
                        have = true;
                        // control_after_generate：数值 widget 后跟控制串 → 消费但不输出
                        if ((sp[0] === 'INT' || sp[0] === 'FLOAT') && state.wi < state.wv.length) {
                            var nx2 = state.wv[state.wi];
                            if (typeof nx2 === 'string' && CONTROL_VALUES[nx2.toLowerCase()] === 1) state.wi++;
                        }
                    } else {
                        // widget 值不足：用 spec 默认值回填（optional/required 同规则——
                        // ComfyUI 前端加载旧模板时同样按 widget 默认值补齐）；optional
                        // widget 无默认值时省略（对齐非 widget optional 的省略语义）
                        var dfp = specDefault(sp);
                        if (dfp.ok) {
                            val = dfp.value;
                            have = true;
                        } else if (!requiredGroup) {
                            continue;
                        }
                    }
                    if (!have) {
                        if (isSocketlessWidget(sp) && sp[0] !== DYNAMIC_COMBO_TYPE) {
                            state.inputs[full] = null;   // socketless widget 无值无默认 → 提交 null
                            continue;
                        }
                        return { ok: false, error: { code: 'WIDGET_MISMATCH', message: 'widget 值不足: 需要 ' + full + '（第 ' + (state.wi + 1) + ' 个），模板只提供 ' + state.wv.length + ' 个' } };
                    }
                    state.inputs[full] = wrapWidgetValue(val);
                    if (sp[0] === DYNAMIC_COMBO_TYPE) {
                        var op = findDynamicOption(sp, val);
                        if (!op) return { ok: false, error: dynamicValueError(full, sp, val) };
                        var sub = walkPosGroup(op.inputs || {}, full + '.', state, depth + 1);
                        if (!sub.ok) return sub;
                    }
                }
                return { ok: true };
            }

            var named = (node.widgets_values_named && typeof node.widgets_values_named === 'object'
                && !Array.isArray(node.widgets_values_named)) ? node.widgets_values_named : null;
            if (named) {
                var hasKey = false;
                for (var nk in named) {
                    if (Object.prototype.hasOwnProperty.call(named, nk)) { hasKey = true; break; }
                }
                if (hasKey) {
                    var nInputs = {};
                    for (g = 0; g < groups.length; g++) {
                        var namedStep = walkNamed(groups[g], g === 0, '', nInputs, 0);
                        if (!namedStep.ok) return { ok: false, error: namedStep.error };
                    }
                    return { ok: true, inputs: nInputs };
                }
            }

            // 位置式消费（upload 尾部标记先剥）
            var widgetsValues = Array.isArray(node.widgets_values) ? node.widgets_values : [];
            while (widgetsValues.length && UPLOAD_WIDGET_MARKS[widgetsValues[widgetsValues.length - 1]] === 1) {
                widgetsValues = widgetsValues.slice(0, -1);
            }
            // 序列化按钮 widget（如 upload 按钮 {type:"button", options:{serialize:false}}）
            // 只是 UI 控件描述、不是输入值：从值序列里跳过（不产出输入）；真实值对象
            // （{__value__:…}、曲线点等）没有 type/options.serialize 标记，不受影响
            widgetsValues = widgetsValues.filter(function (v) {
                return !(v && typeof v === 'object' && !Array.isArray(v) &&
                    (v.type === 'button' || (v.options && v.options.serialize === false)));
            });
            // 占位式（Style B，官方库 99.4%）：已连接 widget 槽跳过占位值；
            // 对齐失败回落跳位式（Style A，旧假设：已连接不占位）
            var hasV3 = defHasV3Input(def);
            var lastFail = null;
            var droppedCandidate = null;
            for (var occupy = 1; occupy >= 0; occupy--) {
                var state = { wi: 0, inputs: {}, occupy: occupy === 1, wv: widgetsValues };
                var step = null;
                for (g = 0; g < groups.length; g++) {
                    step = walkPos(groups[g], g === 0, '', state, 0);
                    if (!step.ok) break;
                }
                if (step && !step.ok) { lastFail = step.error; continue; }
                if (state.wi === widgetsValues.length) return { ok: true, inputs: state.inputs };
                if (state.wi < widgetsValues.length) {
                    // 声明 widget 消费完仍有剩余值：V3 节点视为 hidden V3 输入丢弃
                    //（如 SaveVideo 旧 object_info 未暴露的 codec），ComfyUI 执行时走节点默认值；
                    // 普通节点保持原语义（对齐失败）
                    if (hasV3 && !droppedCandidate) {
                        droppedCandidate = { inputs: state.inputs, dropped: widgetsValues.length - state.wi };
                    }
                    lastFail = {
                        code: 'WIDGET_MISMATCH',
                        message: 'widget 值对齐失败: 消费 ' + state.wi + ' 个，模板提供 ' + widgetsValues.length + ' 个（疑似含未识别的特殊 widget）'
                    };
                }
            }
            if (droppedCandidate) {
                return { ok: true, inputs: droppedCandidate.inputs, dropped: droppedCandidate.dropped };
            }
            return { ok: false, error: lastFail };
        }

        // ---- 5. 活跃节点 → API 格式 ----
        var prompt = {};
        var node;
        for (i = 0; i < wf.nodes.length; i++) {
            node = wf.nodes[i];
            if (!node || !node.type) continue;
            if (UI_ONLY_NOTE_TYPES[node.type]) continue;              // 纯注释
            if (node.type === 'Reroute' || node.type === 'PrimitiveNode' ||
                String(node.type).indexOf('Primitive') === 0) continue; // UI-only
            if (node.mode === 4) continue;                             // bypass：跳过本体
            if (skippedIds[String(node.id)]) continue;                 // 缺目录的界面控制节点（见第 2 步）

            var def = catalog[node.type];
            if (!def || !def.input) {
                return err('NODE_NOT_FOUND', '节点定义缺失: ' + node.type, { id: node.id, type: node.type });
            }

            var built = buildNodeInputs(node, def);
            if (!built.ok) {
                return err(built.error.code,
                    '节点 #' + node.id + '（' + node.type + '）' + built.error.message,
                    { id: node.id, type: node.type });
            }
            prompt[String(node.id)] = { class_type: node.type, inputs: built.inputs };
            // 位置式剩余值按 hidden V3 输入丢弃时如实记录（结构向后兼容：只在条目上加 dropped）
            if (built.dropped > 0) {
                skipped.push({ id: node.id, type: node.type, dropped: built.dropped });
            }
        }

        if (!Object.keys(prompt).length) {
            return err('EMPTY_GRAPH', AEI18n.t('模板中没有可执行节点'));
        }
        // skipped：被跳过的界面控制节点明细 + hidden V3 输入丢弃计数（调用方据此给
        // 用户可见提示——静默处理会让用户以为模板没被改写）。无跳过时省略该字段，
        // 既有消费方零改动；条目结构向后兼容（{id,type} 上只新增 dropped）。
        var out = { ok: true, data: prompt };
        if (skipped.length) out.skipped = skipped;
        return out;
    }

    // ============================================================================
    // 提示词槽位定位（run_official_template 注入 prompt 用）
    // 优先级：① 输入名匹配 prompt/prompt_text 且当前值为非空字符串（伙伴 API 节点）
    //        ② class 名含 TextEncode 且有 text 输入（本地 SD 系）
    //        ③ 输入名含 prompt 的字符串槽（兜底）
    // 返回 {nodeId, key, original} 或 null
    // ============================================================================
    function findPromptSlot(promptData) {
        if (!promptData) return null;
        var ids = Object.keys(promptData);
        var i, j, node, keys;
        for (i = 0; i < ids.length; i++) {
            node = promptData[ids[i]];
            keys = Object.keys((node && node.inputs) || {});
            for (j = 0; j < keys.length; j++) {
                if (/^prompt(_text)?$/i.test(keys[j]) && typeof node.inputs[keys[j]] === 'string' && node.inputs[keys[j]]) {
                    return { nodeId: ids[i], key: keys[j], original: node.inputs[keys[j]] };
                }
            }
        }
        for (i = 0; i < ids.length; i++) {
            node = promptData[ids[i]];
            if (node && /textencode/i.test(node.class_type || '') && node.inputs &&
                typeof node.inputs.text === 'string' && node.inputs.text) {
                return { nodeId: ids[i], key: 'text', original: node.inputs.text };
            }
        }
        for (i = 0; i < ids.length; i++) {
            node = promptData[ids[i]];
            keys = Object.keys((node && node.inputs) || {});
            for (j = 0; j < keys.length; j++) {
                if (/prompt/i.test(keys[j]) && typeof node.inputs[keys[j]] === 'string' && node.inputs[keys[j]]) {
                    return { nodeId: ids[i], key: keys[j], original: node.inputs[keys[j]] };
                }
            }
        }
        return null;
    }

    // 图片输入槽位定位（LoadImage 节点的 image 输入——上传后的文件名注入点）
    function findImageSlots(promptData) {
        var out = [];
        if (!promptData) return out;
        var ids = Object.keys(promptData);
        for (var i = 0; i < ids.length; i++) {
            var node = promptData[ids[i]];
            if (node && node.class_type === 'LoadImage' && node.inputs) {
                out.push({ nodeId: ids[i], key: 'image', original: node.inputs.image });
            }
        }
        return out;
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.uiToApi = {
        convert: convert,
        expandSubgraphs: expandSubgraphs,
        findPromptSlot: findPromptSlot,
        findImageSlots: findImageSlots
    };
})(typeof global !== 'undefined' ? global : window);
