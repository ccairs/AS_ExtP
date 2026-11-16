(function (global) {
    function createMcpManagerController(context) {
        var ctx = context || {};

        return {
            init() {
            },
            destroy() {
            },
            getToolRegistry() {
                return ctx.toolRegistry || null;
            },
            getToolExecutor() {
                return ctx.toolExecutor || null;
            },
            getServerManager() {
                return ctx.serverManager || null;
            }
        };
    }

    global.AEMcpManager = global.AEMcpManager || {};
    global.AEMcpManager.createMcpManagerController = createMcpManagerController;
})(window);
