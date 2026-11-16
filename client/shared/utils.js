(function (global) {
    // 统一限制“生成超时秒数”的输入范围，避免非法值影响请求控制逻辑。
    // 规则：非数字回退到 300 秒；有效值强制裁剪到 [30, 900] 并取整。
    function clampTimeoutSec(value) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            return 300;
        }
        return Math.max(30, Math.min(900, Math.round(n)));
    }

    // shared 工具集合：集中导出跨模块复用能力。
    global.AEShared = global.AEShared || {};
    global.AEShared.utils = {
        clampTimeoutSec
    };
})(window);
