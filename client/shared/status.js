(function (global) {
    // 状态提示门面：为业务层提供稳定接口。
    // 面板级提示统一走全局 AEToast（顶部弹出，覆盖所有面板）。
    // sticky 语义（Agent 运行时进度条专用）保留转发给 agent 模块的全局实现，
    // 不存在时静默跳过。
    function createStatusFacade() {
        return {
            // 显示状态消息（面板级，走 AEToast）。返回 0 占位，兼容旧调用方签名。
            show(message, type, options) {
                if (global.AEToast && typeof global.AEToast.show === 'function') {
                    var opts = options || {};
                    global.AEToast.show(message, type || 'info', { autoHideMs: opts.autoHideMs });
                }
                return 0;
            },

            // 结束 sticky 状态并可选替换为最终结果消息。
            // sticky 是 Agent 运行时进度条的语义，这里转成普通 toast 提示。
            finishSticky(requestId, message, type, options) {
                if (global.AEToast && typeof global.AEToast.show === 'function') {
                    global.AEToast.show(message, type || 'info', options);
                }
            }
        };
    }

    // 导出门面工厂，供各模块按需创建状态接口实例。
    global.AEShared = global.AEShared || {};
    global.AEShared.createStatusFacade = createStatusFacade;
})(window);
