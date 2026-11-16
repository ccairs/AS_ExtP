(function (global) {
    // 应用容器：负责组装核心依赖（moduleManager + context），
    // 并向上层提供统一的模块生命周期调用接口。
    function createAppContainer(options) {
        const opts = options || {};
        const moduleManager = global.AECore.createModuleManager();
        // 将外部依赖注入为只读上下文，供模块 mount 时使用。
        const context = global.AECore.createContainerContext(opts.dependencies || {});

        return {
            // 注册模块定义。
            register(moduleDef) {
                moduleManager.register(moduleDef);
            },

            // 启动应用：
            // - 指定 defaultModuleId 时，直接激活该模块；
            // - 否则回退到 moduleManager.start 的默认启动策略。
            start(defaultModuleId) {
                if (defaultModuleId) {
                    moduleManager.activate(defaultModuleId, context);
                    return;
                }
                moduleManager.start(context);
            },

            // 切换激活模块（统一注入同一个容器上下文）。
            activate(moduleId) {
                moduleManager.activate(moduleId, context);
            },

            // 停用当前模块。
            deactivate() {
                moduleManager.deactivate();
            },

            // 列出已注册模块。
            listModules() {
                return moduleManager.list();
            },

            // 获取指定模块定义。
            getModule(moduleId) {
                return moduleManager.getById(moduleId);
            },

            // 获取当前激活模块 id。
            getActiveModuleId() {
                return moduleManager.getActiveId();
            },

            // 暴露容器上下文，便于调试或扩展场景读取。
            getContext() {
                return context;
            }
        };
    }

    // 导出应用容器工厂。
    global.AECore = global.AECore || {};
    global.AECore.createAppContainer = createAppContainer;
})(window);
