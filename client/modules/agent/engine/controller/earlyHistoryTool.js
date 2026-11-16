(function (global) {
    'use strict';
    // 早期历史归档工具实现层拆分。由 controller.js 组装区经 AEEngine.createEarlyHistoryTool() 创建。
    // 纯迁移自 controller.js 的 _registerEarlyHistoryTool。
    // opts 注入：{ chatViewHelpers, foldArchiveMessage, matchAnyTerm }
    //   - chatViewHelpers：getActiveCm()/getActiveStore()（视图层已拆单元）
    //   - foldArchiveMessage / matchAnyTerm：仍在 controller.js 的归档折叠辅助函数（本次不动）
    function createEarlyHistoryTool(opts) {
        function registerEarlyHistoryTool(toolRegistry) {
            var llmToolReg = toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry);
            if (!llmToolReg || typeof llmToolReg.register !== 'function') return;
            // **不再用 hasTool 守卫跳过重复注册**。守卫会让注册表里只留第一个装配者
            // （单 Agent）的 handler——恰恰是「所有 runtime 共用第一个的 cm/store」那个真机 bug。
            // 现在每条 runtime 都注册自己那份，handler 记进各自的绑定表（见
            // shared/toolRegistry.js 的 createRuntimeToolRegistry），执行时按执行者解析。
            llmToolReg.register({
                name: 'read_early_history',
                description: '读取当前会话在上下文压缩时归档的早期聊天历史副本（被压缩丢弃的旧消息）。当你不确定更早的对话内容、需要回顾之前的决策/代码/用户要求时使用。支持按条数分页（limit/offset）和按关键词检索（query）。',
                input_schema: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            description: '返回的归档消息条数上限（默认 30，最大 100）。归档按时间正序排列，越早的消息越靠前',
                            minimum: 1,
                            maximum: 100
                        },
                        offset: {
                            type: 'number',
                            description: '分页偏移（默认 0），配合 limit 翻页读取后续归档（如 offset=30 读第 31-60 条）',
                            minimum: 0
                        },
                        query: {
                            type: 'string',
                            description: '可选：关键词检索（空格分隔多个词，任一匹配即返回），在消息内容/工具名中查找'
                        }
                    }
                },
                handler: function (args, execCtx) {
                    // 执行侧优先：本工具在每个 controller 都注册，
                    // 但有 hasTool 守卫 ⇒ 注册表里保留**第一个**装配的 runtime（单 Agent）那份 handler，
                    // 它闭包里的 chatViewHelpers 按**单 Agent 的设置**解析活动 cm/store。团队 lane /
                    // 子 Agent 执行时会读成别的会话域的归档（模型看到「尚无归档」或别处的历史）。
                    // 故取执行上下文下发的活动 cm/store（管线下发，见 toolExecutionPipeline）。
                    var cm = null, store = null;
                    try {
                        if (execCtx && typeof execCtx.getActiveCm === 'function' && typeof execCtx.getActiveStore === 'function') {
                            cm = execCtx.getActiveCm();
                            store = execCtx.getActiveStore();
                        }
                    } catch (_) { cm = null; store = null; }
                    if (!cm || !store) {
                        cm = cm || opts.chatViewHelpers.getActiveCm();
                        store = store || opts.chatViewHelpers.getActiveStore();
                    }
                    var sid = (cm && typeof cm.getSessionId === 'function') ? cm.getSessionId() : '';
                    if (!store || typeof store.loadArchive !== 'function' || !sid) {
                        return { success: true, isError: false, content: [{ type: 'text', text: '当前会话无可用的早期历史归档。' }] };
                    }
                    return store.loadArchive(sid).then(function (archived) {
                        // 读失败哨兵——如实报「读不出」，不谎报「尚无归档」
                        //（后者会让 LLM 认为确实没有早期历史而放弃回顾）
                        if (archived && archived.__readFailed) {
                            return { success: false, isError: true, content: [{ type: 'text', text: '[早期历史归档] 归档读取失败（磁盘或读取通道异常），请稍后重试；这不代表当前会话没有归档。' }] };
                        }
                        if (!archived || !archived.length) {
                            return { success: true, isError: false, content: [{ type: 'text', text: '当前会话尚无归档的早期历史（尚未发生过上下文压缩）。' }] };
                        }
                        var limit = Math.max(1, Math.min(100, Number(args && args.limit) || 30));
                        var offset = Math.max(0, Number(args && args.offset) || 0);
                        var query = (args && args.query && String(args.query).trim()) ? String(args.query).trim().toLowerCase() : '';
                        var terms = query ? query.split(/\s+/) : [];

                        var lines = [];
                        for (var i = 0; i < archived.length; i++) {
                            var folded = opts.foldArchiveMessage(archived[i]);
                            if (!folded) continue;
                            if (terms.length && !opts.matchAnyTerm(folded, terms)) continue;
                            lines.push(folded);
                        }

                        var total = lines.length;
                        if (total === 0) {
                            // 归档为空或关键词无命中：直接说明，避免下方区间显示「第 1-0 条」自相矛盾
                            var emptyMsg = '[早期历史归档] 无可显示的条目' + (query
                                ? '（关键词 "' + args.query + '" 无匹配，可换关键词或去掉 query 浏览全部）'
                                : '（归档为空或全部消息无正文）。');
                            return { success: true, isError: false, content: [{ type: 'text', text: emptyMsg }] };
                        }
                        // offset 越界：slice 为空且区间显示自相矛盾（如「第 31-30 条」），
                        // 续读提示还会把 LLM 引向空页死循环——显式提示正确的取值范围
                        if (offset >= total) {
                            var oob = '[早期历史归档] 共 ' + total + ' 条，offset=' + offset + ' 已超出范围（条目从 0 开始计数）。'
                                + '请使用 offset=0' + (total > limit ? ('~' + (total - 1) + ' 之间的值（配合 limit=' + limit + '）') : '') + ' 重新读取。'
                                + (query ? '（关键词: ' + (args.query) + '）' : '');
                            return { success: true, isError: false, content: [{ type: 'text', text: oob }] };
                        }
                        var slice = lines.slice(offset, offset + limit);
                        var header = '[早期历史归档] 共 ' + total + ' 条，当前显示第 ' + (offset + 1) + '-' + (offset + slice.length) + ' 条'
                            + ((offset + slice.length < total) ? '（还有更多归档，可用 offset=' + (offset + slice.length) + ' 继续读取）' : '')
                            + (query ? '（关键词: ' + (args.query) + '）' : '');
                        return { success: true, isError: false, content: [{ type: 'text', text: [header, ''].concat(slice).join('\n') }] };
                    });
                },
                scope: 'global',
                stub: false,
                source: 'agent',
                category: 'utility'
            });
        }

        return { registerEarlyHistoryTool: registerEarlyHistoryTool };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createEarlyHistoryTool = createEarlyHistoryTool;
})(typeof global !== 'undefined' ? global : window);