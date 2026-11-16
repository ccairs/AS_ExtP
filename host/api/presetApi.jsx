// 预设（.ffx）ExtendScript 工具（由 host.jsx $.evalFile 加载，挂 AE 全局）
// 由面板 presetView 经 hostApi.call 调用。所有函数返回 JSON.stringify({status:"success"|"error", ...}) 字符串
// （hostApi.call 经 evalScript 拿 toString，裸对象会变 "[object Object]"，故显式 JSON.stringify；view 侧 _call 用 JSON.parse 还原）。
// 注意：数据目录文件的读写由面板侧 AEFS 负责，本文件只用 new File 操作 AE 工程 API
// （executeCommand / applyPreset / getSelectionInfo），不碰数据目录、不碰 UserPresets。

// 版本标记：hostApi.js 加载守卫据此判断内存中的 presetApi 是否过期（AE 会话内
// 升级扩展后先前加载的脚本仍在内存）。3 = 分块版（每块独立 undo group）
var PRESET_API_VERSION = 3;

// ── 触发 AE 保存预设对话框（BLOCKING，等用户操作完）──
function savePresetViaMenu(args) {
    try {
        if (!args) args = {};
        app.executeCommand(3075);  // 打开原生保存对话框，阻塞至用户关闭
        return JSON.stringify({ status: "success" });
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 应用预设到当前合成选中的多个图层（单发兼容入口，整批单次调用）──
// AE 的 layer.applyPreset() 实际作用于"当前选中的所有层"而非该 Layer 对象
// （未文档化行为，本项目目标 AE 版本已验证）：对任一选中层调用一次即应用到
// 全部选中层，.ffx 仅解析一次——与官方 Effects & Presets 面板双击应用同路径。
// 面板侧的批量应用走 beginPresetApply + applyPresetToLayersRange 分块路径
// （块间进度反馈防误判卡死）；本函数保留作单发兼容入口（host.jsx 加载检查
// 与 hotbox 探针均引用它），小批量（单块）时两者行为一致。
// 不做确认弹窗。不动选区（目标层本来就全部选中着）。
function applyPresetToSelectedLayers(args) {
    var undoStarted = false;
    try {
        if (!args) args = {};
        var ffxPath = args.ffxPath || "";
        var presetName = args.presetName || "";
        if (!ffxPath) throw new Error("ffxPath 必填");
        // 保守校验：只防明显恶意/损坏路径（空字节、非 .ffx 后缀），不限制必须在数据目录内——
        // 用户文件选择器场景需保留任意路径。空字节会截断 C 字符串，非 .ffx 属调用方传错。
        if (ffxPath.indexOf("\u0000") >= 0) throw new Error("预设路径非法（含空字节）");
        if (!/\.ffx$/i.test(ffxPath)) throw new Error("预设必须是 .ffx 文件");
        var f = new File(ffxPath);
        if (!f.exists) throw new Error("预设文件不存在: " + ffxPath);

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) throw new Error("无活动合成");
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) throw new Error("未选中任何图层");

        app.beginUndoGroup("应用预设: " + presetName);
        undoStarted = true;
        sel[0].applyPreset(f);
        app.endUndoGroup();
        undoStarted = false;
        return JSON.stringify({
            status: "success",
            applied: sel.length,
            failed: 0,
            errors: []
        });
    } catch (e) {
        if (undoStarted) { try { app.endUndoGroup(); } catch (_) {} }
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 批量应用预设：阶段 1/2 —— 校验 + 决策（小批量直接应用完 / 大批量快照）──
// syncMax 参数（面板按自身分块阈值传入，如 20）：
//   选中层数 < syncMax → 直接一次 applyPreset 应用完，undo group 本脚本内
//     开闭（Ctrl+Z 一次撤回），不动选区、无逐层定位——单次桥接往返，与官方
//     Effects & Presets 双击同速（避免 begin/range 两次往返的"慢一丢丢"）。
//     返回 {status:'done', applied: 层数}，调用方直接收尾，不得进入阶段 2。
//   否则 → 仅快照层索引（不应用、不开 undo group——分块时组由各块自开自闭，
//     AE 会切断跨 evalScript 维持的组）。返回 {status:'success', compId,
//     indexes:[选中层索引快照]}，调用方按块调 applyPresetToLayersRange。
// 校验失败返回 {status:'error', message}（此时无任何副作用，调用方不得进入阶段 2）。
function beginPresetApply(args) {
    var undoStarted = false;
    try {
        if (!args) args = {};
        var ffxPath = args.ffxPath || "";
        var presetName = args.presetName || "";
        var syncMax = Number(args.syncMax);
        if (!isFinite(syncMax) || syncMax <= 0) syncMax = 1;  // 未传视为 0：全部走分块
        if (!ffxPath) throw new Error("ffxPath 必填");
        // 保守校验与 applyPresetToSelectedLayers 一致：只防明显恶意/损坏路径
        if (ffxPath.indexOf("\u0000") >= 0) throw new Error("预设路径非法（含空字节）");
        if (!/\.ffx$/i.test(ffxPath)) throw new Error("预设必须是 .ffx 文件");
        var f = new File(ffxPath);
        if (!f.exists) throw new Error("预设文件不存在: " + ffxPath);
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) throw new Error("无活动合成");
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) throw new Error("未选中任何图层");
        if (sel.length < syncMax) {
            // 小批量：单次往返直接应用（快路径，见函数头注释）
            app.beginUndoGroup("应用预设: " + presetName);
            undoStarted = true;
            sel[0].applyPreset(f);
            app.endUndoGroup();
            undoStarted = false;
            return JSON.stringify({ status: "done", applied: sel.length });
        }
        var indexes = [];
        var ids = [];
        for (var i = 0; i < sel.length; i++) {
            indexes.push(sel[i].index);
            // 同时快照图层 id（稳定键）——分块应用跨多次 evalScript，期间用户删/加/重排
            // 图层会让位置键错位（预设静默应用到别的层，撤回还按块走，难复原）。
            // id 跨保存/重载不变；缺 id（旧 AE）记 0，块内据此整批退回位置键。
            var _lid = 0;
            try { _lid = sel[i].id; } catch (_) { _lid = 0; }
            if (!(_lid > 0)) _lid = 0;
            ids.push(_lid);
        }
        return JSON.stringify({ status: "success", compId: comp.id, indexes: indexes, layerIds: ids });
    } catch (e) {
        if (undoStarted) { try { app.endUndoGroup(); } catch (_) {} }
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// ── 批量应用预设：阶段 2/2 —— 应用到一块图层（块内一次调用 + 块内 undo group）──
// args: { ffxPath, compId, indexes: [块内层索引], layerIds: [块内层 id], last, reselect, reselectIds }
//   compId/indexes/layerIds/reselect/reselectIds 均来自 beginPresetApply 的快照；last=true 表示末块。
// 优先用 layerIds（稳定键）定位——块间跨多次 evalScript，位置键在用户动过图层后会错位。
//   layerIds 与 indexes 等长且全为正整数、且引擎有 layerByID 才启用；否则退回 indexes。
// AE 的 layer.applyPreset() 实际作用于"当前选中的所有层"而非该 Layer 对象
// （未文档化行为，本项目目标 AE 版本已验证）：把选区设为块内层后调用一次即
// 应用到整块，比逐层"清空+单选+调用"少 (块大小-1) 次选区切换与调用开销。
// 每块自开自闭 undo group：块间进度反馈防误判卡死，代价是撤回按块进行
// （用户已确认接受；单块小批量仍是一次性撤回）。
// 块内任一层定位失败 → abort（避免半块应用）；applyPreset 异常 → 本块整块失败。
// last=true 时按 reselect/reselectIds 恢复原选区（error 路径同样恢复）。
// 返回 {status:'success', applied: n} | {status:'error', message}（本块失败，可继续其余块）
//      | {status:'abort', message}（合成/图层已变更，应中止余块）
function applyPresetToLayersRange(args) {
    var undoStarted = false;
    try {
        if (!args) args = {};
        var ffxPath = args.ffxPath || "";
        var presetName = args.presetName || "";
        var compId = Number(args.compId);
        var indexes = args.indexes || [];
        var ids = args.layerIds || [];
        var last = args.last === true;
        var reselect = args.reselect || [];
        var reselectIds = args.reselectIds || [];
        if (indexes.length === 0 && ids.length === 0) return JSON.stringify({ status: "error", message: "空块" });
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem) || comp.id !== compId) {
            return JSON.stringify({ status: "abort", message: "合成已切换，批量中止" });
        }
        // id 寻址可用性判定——等长 + 全为正整数 + 引擎支持 layerByID，三者缺一即整批退回位置键
        var useIds = (typeof app.project.layerByID === "function") && ids.length === indexes.length && ids.length > 0;
        if (useIds) {
            for (var c = 0; c < ids.length; c++) { if (!(Number(ids[c]) > 0)) { useIds = false; break; } }
        }
        var n = useIds ? ids.length : indexes.length;
        // 定位块内全部层（任一缺失即中止，避免半块应用）
        var layers = [];
        for (var i = 0; i < n; i++) {
            var ly = null;
            if (useIds) {
                try { ly = app.project.layerByID(Number(ids[i])); } catch (_) { ly = null; }
                // 图层被移到别的合成 → 视为变更（applyPreset 会作用到选区，跨合成无意义）
                if (ly) {
                    var _sameComp = false;
                    try { _sameComp = !!(ly.containingComp && ly.containingComp.id === compId); } catch (_) {}
                    if (!_sameComp) ly = null;
                }
            } else {
                try { ly = comp.layer(Number(indexes[i])); } catch (_) { ly = null; }
            }
            if (!ly) return JSON.stringify({ status: "abort", message: "图层已变更，批量中止" });
            layers.push(ly);
        }
        try {
            // 选区隔离为块内层（applyPreset 作用于选中层的批量行为，见函数头注释）。
            // 清选区必须逐层 selected=false：comp.selection=null 在 CEP evalScript
            // 环境下不可靠（不生效且异常被外层吞掉），会让原全选层保持选中，
            // applyPreset 作用于全部选中层 → 每块全量应用、效果多层叠加、
            // 撤回步内容错位（与 hotbox 实现对齐的写法，hotbox 已验证可靠）
            var sl = comp.selectedLayers;
            for (var a = 0; a < sl.length; a++) sl[a].selected = false;
            for (var b = 0; b < layers.length; b++) layers[b].selected = true;
            app.beginUndoGroup("应用预设: " + presetName);
            undoStarted = true;
            layers[0].applyPreset(new File(ffxPath));
            app.endUndoGroup();
            undoStarted = false;
        } catch (e) {
            if (undoStarted) { try { app.endUndoGroup(); } catch (_) {} }
            if (last) _restoreSelection(comp, reselect, reselectIds);
            var _where = (layers[0] && layers[0].name) ? layers[0].name : ("图层 " + (useIds ? ids[0] : indexes[0]));
            return JSON.stringify({
                status: "error",
                message: _where + " 等 " + layers.length + " 层: " + e.toString()
            });
        }
        if (last) _restoreSelection(comp, reselect, reselectIds);
        return JSON.stringify({ status: "success", applied: layers.length });
    } catch (e) {
        return JSON.stringify({ status: "abort", message: e.toString() });
    }
}

// 按快照恢复原选区（隔离过程改变了选区）。优先按 id 恢复——批量跨多次 evalScript，
// 位置键在用户删/加/重排图层后会偏移（原注释"尽力恢复"即指此），id 不受影响。
function _restoreSelection(comp, indexes, ids) {
    try {
        // 清选区用逐层 selected=false（comp.selection=null 不可靠，见 applyPresetToLayersRange 注释）
        var sl = comp.selectedLayers;
        for (var a = 0; a < sl.length; a++) sl[a].selected = false;
        var _ids = ids || [];
        var _compId = comp.id;
        var useIds = (typeof app.project.layerByID === "function") && _ids.length === indexes.length && _ids.length > 0;
        for (var i = 0; i < indexes.length; i++) {
            try {
                var ly = null;
                if (useIds && Number(_ids[i]) > 0) {
                    ly = app.project.layerByID(Number(_ids[i]));
                    if (ly) {
                        var _sameComp = false;
                        try { _sameComp = !!(ly.containingComp && ly.containingComp.id === _compId); } catch (_) {}
                        if (!_sameComp) ly = null;
                    }
                }
                if (!ly) ly = comp.layer(indexes[i]);
                if (ly) ly.selected = true;
            } catch (_) {}
        }
    } catch (_) {}
}

// ── 取当前选中信息（供 index.json 记来源 + 标志位）──
// 返回 { layers: [{name,index,typeName}], propertyPath, hasKeyframes, hasExpressions, hasEffects }
function getSelectionInfo(args) {
    try {
        if (!args) args = {};
        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) {
            return JSON.stringify({ status: "error", message: "无活动合成" });
        }
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) {
            return JSON.stringify({ status: "error", message: "未选中任何图层" });
        }

        var layers = [];
        for (var i = 0; i < sel.length; i++) {
            layers.push({ name: sel[i].name, index: sel[i].index, typeName: sel[i].typeName || "" });
        }

        var hasKeyframes = false;
        var hasExpressions = false;
        var hasEffects = false;
        var propPath = "";

        var selProps = null;
        try { selProps = comp.selectedProperties; } catch (_) { selProps = null; }
        if (selProps && selProps.length > 0) {
            var firstProp = null;
            for (var j = 0; j < selProps.length; j++) {
                var p = selProps[j];
                try { if (p.isTimeVarying) hasKeyframes = true; } catch (_) {}
                try { if (p.expression && String(p.expression).length > 0) hasExpressions = true; } catch (_) {}
                try {
                    var pn = String(p.name || "").toLowerCase();
                    var pm = String(p.matchName || "");
                    if (pn === "effects" || /effect/i.test(pm)) hasEffects = true;
                } catch (_) {}
                try { if (!firstProp && p.propertyDepth > 0) firstProp = p; } catch (_) {}
            }
            if (firstProp) propPath = _buildPropPath(firstProp);
        }

        // 兜底：选中图层是否含效果
        if (!hasEffects) {
            for (var k = 0; k < sel.length; k++) {
                try { if (sel[k].effect && sel[k].effect.numProperties > 0) hasEffects = true; } catch (_) {}
            }
        }

        return JSON.stringify({
            status: "success",
            layers: layers,
            propertyPath: propPath,
            hasKeyframes: hasKeyframes,
            hasExpressions: hasExpressions,
            hasEffects: hasEffects
        });
    } catch (e) {
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}

// 属性 → 可读路径（如 "Transform > Position"）
function _buildPropPath(p) {
    try {
        var parts = [];
        var cur = p;
        var maxDepth = 50;
        while (cur && cur.propertyDepth > 0 && maxDepth > 0) {
            parts.unshift(cur.name);
            var parent = cur.parentProperty;
            if (cur === parent) break;
            cur = parent;
            maxDepth--;
        }
        return parts.join(" > ");
    } catch (_) {
        return "";
    }
}
