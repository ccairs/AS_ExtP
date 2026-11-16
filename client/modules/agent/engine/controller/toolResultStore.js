(function (global) {
    'use strict';
    // 大工具结果暂存：执行类工具（executeExtendScript、外部 MCP 工具等）**不能重跑**去取下一页
    // （重跑会二次产生副作用），故把超限的完整结果按 id 暂存在面板内存里，模型用 read_tool_result
    // 分页读暂存副本——执行一次，翻页零成本。
    // 只存内存不落盘：① 结果只在当前轮/本会话内有意义；② 落盘会带来隐私与膨胀问题。
    // 双封顶（条目数 + 总字符）防膨胀，超限淘汰最旧；单条超上限干脆不暂存（回退到只给头尾的
    // 老行为）——几 MB 以上的 dump 分页读也没有意义，该让模型改查询而不是让它一页页翻。
    // 会话隔离：条目记 sessionId，读取时必须与当前会话一致（切会话后旧结果读不到，防跨会话串味）。
    function createToolResultStore(opts) {
        var o = opts || {};
        var MAX_ENTRIES = o.maxEntries || 12;
        var MAX_TOTAL_CHARS = o.maxTotalChars || 8000000;    // 总字符上限（约 8MB 文本）
        var MAX_SINGLE_CHARS = o.maxSingleChars || 4000000;  // 单条上限，超出不暂存
        var entries = [];   // [{id, text, toolName, sessionId, at, size}]，按插入序（旧 → 新）
        var seq = 0;

        function totalChars() {
            var n = 0;
            for (var i = 0; i < entries.length; i++) n += entries[i].size;
            return n;
        }

        function evict() {
            while (entries.length > MAX_ENTRIES || totalChars() > MAX_TOTAL_CHARS) {
                if (!entries.length) break;
                entries.shift();
            }
        }

        // 暂存完整结果，返回 id；过大/空则返回 null（调用方回退到"只给头尾"的提示）
        function put(text, meta) {
            var s = typeof text === 'string' ? text : String(text == null ? '' : text);
            if (!s || s.length > MAX_SINGLE_CHARS) return null;
            seq++;
            var id = 'r' + seq;
            entries.push({
                id: id,
                text: s,
                toolName: (meta && meta.toolName) || '',
                sessionId: (meta && meta.sessionId) || '',
                at: Date.now(),
                size: s.length
            });
            evict();
            return id;
        }

        // 取条目；sessionId 传了就要求一致（不一致当作不存在，防跨会话读旧结果）
        function get(id, sessionId) {
            var want = String(id == null ? '' : id);
            for (var i = 0; i < entries.length; i++) {
                if (entries[i].id !== want) continue;
                if (sessionId && entries[i].sessionId && entries[i].sessionId !== sessionId) return null;
                return entries[i];
            }
            return null;
        }

        function clear() {
            entries = [];
        }

        function stats() {
            return { count: entries.length, totalChars: totalChars(), ids: entries.map(function (e) { return e.id; }) };
        }

        return { put: put, get: get, clear: clear, stats: stats };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createToolResultStore = createToolResultStore;
})(typeof global !== 'undefined' ? global : window);
