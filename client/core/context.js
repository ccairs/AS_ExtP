(function (global) {
    // 容器上下文：冻结依赖对象，供模块以只读方式访问
    function createContainerContext(dependencies) {
        const deps = dependencies || {};
        return Object.freeze({
            status: deps.status || null,
            settingsStore: deps.settingsStore || null,
            theme: deps.theme || null,
            effects: deps.effects || null,
            bridge: deps.bridge || null,
            hostApi: deps.hostApi || null,
            utils: deps.utils || null,
            llmChannel: deps.llmChannel || null,
            toolRegistry: deps.toolRegistry || null,
            toolExecutor: deps.toolExecutor || null,
            serverManager: deps.serverManager || null,
            skillRegistry: deps.skillRegistry || null,
            promptBuilder: deps.promptBuilder || null
        });
    }

    global.AECore = global.AECore || {};
    global.AECore.createContainerContext = createContainerContext;
})(window);
