(function (global) {
    // 模块管理器：负责模块的注册、激活切换、启动默认模块与查询。
    function createModuleManager() {
        // modules: 以模块 id 为键的定义表。
        const modules = {};
        // order: 记录注册顺序，用于 start() 时选择默认模块。
        const order = [];
        // 当前激活模块 id，空字符串表示尚未激活。
        let activeModuleId = '';

        // 确保模块存在并返回模块定义。
        // 不存在时抛错，防止后续 mount/unmount 调用落空。
        function ensureModule(id) {
            if (!id || !modules[id]) {
                throw new Error('模块不存在: ' + id);
            }
            return modules[id];
        }

        return {
            // 注册模块：
            // 1) 校验模块定义合法性（必须有 id 与 mount）；
            // 2) 校验 id 不重复；
            // 3) 写入模块表并记录顺序。
            register(moduleDef) {
                if (!moduleDef || !moduleDef.id || typeof moduleDef.mount !== 'function') {
                    throw new Error('非法模块定义');
                }
                if (modules[moduleDef.id]) {
                    throw new Error('重复模块ID: ' + moduleDef.id);
                }
                modules[moduleDef.id] = moduleDef;
                order.push(moduleDef.id);
            },

            // 停用当前模块（仅 unmount，不 mount 新模块）。
            deactivate() {
                if (!activeModuleId) return;
                var prevId = activeModuleId;
                const prev = modules[prevId];
                try {
                    if (prev && typeof prev.unmount === 'function') {
                        prev.unmount();
                    }
                } finally {
                    // 无论 unmount 是否抛异常，都清空 activeModuleId，避免双重卸载
                    activeModuleId = '';
                }
            },

            // 激活目标模块：
            // 1) 若目标已激活则直接返回；
            // 2) 若有旧模块则先执行其 unmount；
            // 3) 再 mount 新模块并更新 activeModuleId。
            activate(moduleId, context) {
                const next = ensureModule(moduleId);
                if (activeModuleId === moduleId) {
                    return;
                }
                var prevId = activeModuleId;
                try {
                    if (prevId) {
                        const prev = ensureModule(prevId);
                        if (typeof prev.unmount === 'function') {
                            prev.unmount();
                        }
                    }
                    // unmount 成功后立即清空 activeModuleId，防止 mount 失败时仍指向已卸载的旧模块
                    activeModuleId = '';
                    next.mount(context || {});
                    activeModuleId = moduleId;
                } catch (e) {
                    // 异常时确保 activeModuleId 不指向半挂载模块
                    activeModuleId = '';
                    throw e;
                }
            },

            // 启动模块系统：若尚未激活任何模块，则按注册顺序激活第一个模块。
            start(context) {
                if (!activeModuleId && order.length > 0) {
                    this.activate(order[0], context);
                }
            },

            // 返回按注册顺序排列的模块定义数组。
            list() {
                return order.map((id) => modules[id]);
            },

            // 根据 id 查询模块定义，不存在时返回 null。
            getById(moduleId) {
                return modules[moduleId] || null;
            },

            // 获取当前激活模块 id。
            getActiveId() {
                return activeModuleId;
            }
        };
    }

    // 导出模块管理器工厂。
    global.AECore = global.AECore || {};
    global.AECore.createModuleManager = createModuleManager;
})(window);
