(function (global) {
    function clampScriptListHeight(value, fallback) {
        const n = Number(value);
        if (!Number.isFinite(n)) {
            return fallback;
        }
        return Math.max(55, Math.min(720, Math.round(n)));
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.moduleUtils = {
        clampScriptListHeight
    };
})(window);
