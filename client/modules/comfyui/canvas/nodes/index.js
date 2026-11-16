(function (global) {
    // 节点定义注册表：把各节点 def 收集，供 nodeSystem.registerNodeDef + executor.handlers 用
    function getNodeDefs() {
        var defs = global.AEComfyUI.nodeDefs || {};
        var list = [];
        Object.keys(defs).forEach(function (key) {
            list.push(defs[key]);
        });
        return list;
    }

    function getHandlers() {
        var defs = global.AEComfyUI.nodeDefs || {};
        var handlers = {};
        Object.keys(defs).forEach(function (key) {
            var d = defs[key];
            if (typeof d.execute === 'function') {
                handlers[d.type] = d.execute;
            }
        });
        return handlers;
    }

    // 把所有 nodeDefs 注册到 graph 实例（启用端口真校验，告别骨架阶段的 'any' 占位）
    function registerAllNodeDefs(graph) {
        var defs = global.AEComfyUI.nodeDefs || {};
        Object.keys(defs).forEach(function (key) {
            graph.registerNodeDef(defs[key].type, defs[key]);
        });
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.getNodeDefs = getNodeDefs;
    global.AEComfyUI.getHandlers = getHandlers;
    global.AEComfyUI.registerAllNodeDefs = registerAllNodeDefs;
})(window);
