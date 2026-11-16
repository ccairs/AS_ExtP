(function (global) {
    'use strict';
    function createToolHistory(opts) {
        // opts 注入：{ state, agentContextManager }

        // 从历史 messages 重建 searchedTools：扫描 agentContextManager 中所有 tool_search 的
        // 成功结果，提取 tools[].name。解决会话重载后 searchedTools 丢失导致 LLM 被迫重复
        // tool_search 的问题——tool_search 结果已持久化在 messages，LLM 上下文可见，闸门应放行。
        // 从原始 messages（list()）读取，保留完整 content。
        function rebuildSearchedToolsFromHistory(ctxMgr) {
            opts.state.searchedTools = new Set();
            var cm = ctxMgr || opts.agentContextManager;
            if (!cm || typeof cm.list !== 'function') return;
            var histMsgs = cm.list();
            for (var i = 0; i < histMsgs.length; i++) {
                var m = histMsgs[i];
                if (!m || m.role !== 'tool' || m.toolName !== 'tool_search') continue;
                if (m.success === false) continue; // 失败的 tool_search 不解锁
                try {
                    var parsed = JSON.parse(m.text || '{}');
                    if (parsed && Array.isArray(parsed.tools)) {
                        for (var j = 0; j < parsed.tools.length; j++) {
                            if (parsed.tools[j] && parsed.tools[j].name) {
                                opts.state.searchedTools.add(parsed.tools[j].name);
                            }
                        }
                    }
                } catch (_) {}
            }
        }

        return { rebuildSearchedToolsFromHistory: rebuildSearchedToolsFromHistory };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createToolHistory = createToolHistory;
})(typeof global !== 'undefined' ? global : window);