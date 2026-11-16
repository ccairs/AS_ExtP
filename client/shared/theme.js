(function (global) {
    // 主题管理门面：统一接收 settings 并把主题应用动作转发给全局实现，
    // 减少业务模块对具体主题函数的直接耦合。
    function createThemeManager() {
        return {
            // 根据设置应用主题。
            // 当全局 applyThemeFromSettings 不存在时静默跳过，
            // 让调用方无需额外做函数存在性判断。
            applyFromSettings(settings) {
                if (typeof global.applyThemeFromSettings === 'function') {
                    global.applyThemeFromSettings(settings || {});
                }
            }
        };
    }

    // 导出主题管理工厂到 shared 命名空间。
    global.AEShared = global.AEShared || {};
    global.AEShared.createThemeManager = createThemeManager;
})(window);
