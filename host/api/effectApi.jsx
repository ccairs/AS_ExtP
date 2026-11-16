// 效果（.aex 内置/第三方效果）ExtendScript 工具（由 host.jsx $.evalFile 加载，挂 AE 全局）
// 由热盒（AEGP，经 AEGP_ExecuteScript）与面板经 hostApi.call 共用。
// 所有函数返回 JSON.stringify({status:"success"|"error", ...}) 字符串。
// 模式对齐 presetApi.jsx：遍历 comp.selectedLayers + beginUndoGroup 包裹。

// ── 应用效果到当前合成选中的多个图层 ──
// args: { matchName: "ADBE Gaussian Blur", effectName: "高斯模糊" }
// matchName 为 AE 效果唯一标识（effects_cache.json 里 name→matchName）；
// 遍历 comp.selectedLayers 逐个 layer.effect.addProperty(matchName)，包 undoGroup（一次 Ctrl+Z 回退）。
// 失败逐层收集，不静默；效果名不存在（matchName 错误）时 addProperty 抛错并计入 errors。
function applyEffectToSelectedLayers(args) {
    var undoStarted = false;
    try {
        if (!args) args = {};
        var matchName = args.matchName || "";
        var effectName = args.effectName || "";
        if (!matchName) throw new Error("matchName 必填");
        if (matchName.indexOf("\u0000") >= 0) throw new Error("matchName 非法（含空字节）");
        // 保守校验：matchName 仅允许字母数字下划线空格 . - + ( )（真实 matchName 如
        // "ADBE Gaussian Blur"/"PEAF"/"BAO_Boa"），防注入脚本代码。
        if (!/^[A-Za-z0-9_ .\-+()]{2,128}$/.test(matchName)) throw new Error("matchName 格式非法");

        var comp = app.project.activeItem;
        if (!comp || !(comp instanceof CompItem)) throw new Error("无活动合成");
        var sel = comp.selectedLayers;
        if (!sel || sel.length === 0) throw new Error("未选中任何图层");

        app.beginUndoGroup("应用效果: " + effectName);
        undoStarted = true;
        var applied = 0;
        var failed = 0;
        var errors = [];
        var MAX_ERRORS = 20;  // 失败明细最多收集 20 条，防止批量失败（如 matchName 错误全军覆没）返回体撑爆
        for (var i = 0; i < sel.length; i++) {
            try {
                sel[i].effect.addProperty(matchName);
                applied++;
            } catch (e) {
                failed++;
                if (errors.length < MAX_ERRORS) errors.push(sel[i].name + ": " + e.toString());
            }
        }
        app.endUndoGroup();
        undoStarted = false;
        return JSON.stringify({
            status: "success",
            applied: applied,
            failed: failed,
            errors: errors,
            errorsTruncated: Math.max(0, failed - errors.length)
        });
    } catch (e) {
        if (undoStarted) { try { app.endUndoGroup(); } catch (_) {} }
        return JSON.stringify({ status: "error", message: e.toString() });
    }
}
