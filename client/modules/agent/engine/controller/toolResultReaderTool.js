(function (global) {
    'use strict';
    // 大工具结果分页读取工具。由 controller.js 组装区经 AEEngine.createToolResultReaderTool() 创建。
    // 为什么需要它：执行类工具（executeExtendScript、外部 MCP 工具）**不能重跑**去取下一页——重跑会
    // 二次产生副作用（重复改工程、重复写文件、重复扣费）。故超限结果由工具管线暂存（见 toolResultStore），
    // 本工具只读暂存副本，执行一次即可翻页读全。
    // opts 注入：{ store（toolResultStore 实例）, getSessionId() }
    function createToolResultReaderTool(opts) {
        var DEFAULT_CHARS = 10000;
        // 单次上限必须**低于**工具结果兜底截断阈值（toolExecutionPipeline 的
        // MAX_TOOL_RESULT_CHARS = 32K 字符，由 128K 下调），否则读出来的分页会被
        // 兜底再截一次：页中段丢失 + 结果被切成非法 JSON（结构化字段 nextOffset/total 全没）。
        // 旧值 40000 是按当时 128K 的阈值定的，阈值下调后这个等式必须跟着走。
        var MAX_CHARS = 20000;

        function err(message) {
            return { success: false, result: JSON.stringify({ status: 'error', message: message }) };
        }

        function registerReadToolResult(toolRegistry) {
            var llmToolReg = toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry);
            if (!llmToolReg || typeof llmToolReg.register !== 'function') return;
            // **不再用 hasTool 守卫跳过重复注册**（理由同 earlyHistoryTool.js）：守卫
            // 让所有 runtime 共用第一个装配者的 store/会话 id，lane 的翻页恒「不存在」。现在各
            // runtime 注册自己那份并记进各自绑定表，执行时按执行者解析。
            llmToolReg.register({
                name: 'read_tool_result',
                description: '分页读取被截断工具结果的完整内容。当工具结果里出现「完整内容已暂存为 resultId=xxx」时用它翻页：只读暂存副本，不会重新执行该工具。',
                input_schema: {
                    type: 'object',
                    properties: {
                        resultId: {
                            type: 'string',
                            description: '结果 id，取自截断提示里的 resultId=xxx（如 r3）'
                        },
                        offset: {
                            type: 'number',
                            description: '起始字符偏移（默认 0）。返回的 nextOffset 可续读下一页',
                            minimum: 0
                        },
                        maxChars: {
                            type: 'number',
                            // 描述与上限都引用常量（单一来源，防"改了值忘了改 schema"）
                            description: '单次返回字符数（默认 ' + DEFAULT_CHARS + '，上限 ' + MAX_CHARS + '）',
                            minimum: 500,
                            maximum: MAX_CHARS
                        }
                    },
                    required: ['resultId']
                },
                handler: function (args, execCtx) {
                    // 执行侧优先（同类 last-wins 收口）：本工具在**每个** controller 上
                    // 都注册，但有 hasTool 守卫 ⇒ 注册表里保留的是**第一个**装配的 runtime（单
                    // Agent）那份 handler，它闭包里的 store / getSessionId 指向单 Agent 的暂存与会话。
                    // 团队 lane / 子 Agent 执行时，超限结果暂存进的是**它自己**的 store（管线按
                    // opts.toolResultStore 存）⇒ 只认闭包会让 lane 的 read_tool_result 永远「不存在」。
                    // 故取执行上下文里下发的 store / 会话 id（管线下发，见 toolExecutionPipeline）。
                    var store = (execCtx && execCtx.toolResultStore) ? execCtx.toolResultStore : opts.store;
                    if (!store || typeof store.get !== 'function') return err('结果暂存不可用，无法读取。');
                    var id = args && args.resultId;
                    if (!id) return err('缺少 resultId（取自工具结果截断提示里的 resultId=xxx）。');
                    var sessionId = '';
                    try {
                        if (execCtx && typeof execCtx.getActiveSessionId === 'function') sessionId = execCtx.getActiveSessionId() || '';
                        else if (typeof opts.getSessionId === 'function') sessionId = opts.getSessionId() || '';
                    } catch (_) { sessionId = ''; }
                    var entry = store.get(id, sessionId);
                    if (!entry) {
                        // 只陈述事实与失效原因，不给行动建议：可走的路因工具而异（执行类重跑会二次产生
                        // 副作用、带分页参数的工具本来就不需要这条副本），替模型选一条反而误导。
                        return err('结果 ' + id + ' 不存在或已过期（暂存只保留最近若干条，随会话切换失效）。');
                    }
                    var offset = Math.max(0, Number(args.offset) || 0);
                    var maxChars = Math.min(MAX_CHARS, Math.max(500, Number(args.maxChars) || DEFAULT_CHARS));
                    // 自守预算（同 platformTools 的 readFile）：进管线的是
                    // **JSON 序列化后**的文本，转义会放大体积（引号/反斜杠/换行 ×2、控制字符 ×6）——
                    // 一条 JSON 结果本身就有大量引号，20000 字符的页很容易到 3 万+，正好越过兜底上限
                    // （32K）→ 分页读出来的页又被截一次（中段丢失 + 结构化字段全没，正是本工具要治的病）。
                    // 故按序列化后的长度自守（24K，留 8K 余量）：超了就缩短本页、nextOffset 按实际返回算。
                    var READER_PAYLOAD_BUDGET = 24 * 1024;
                    var keep = maxChars;
                    var payload = null;
                    for (var pass = 0; pass < 4; pass++) {
                        var slice = entry.text.slice(offset, offset + keep);
                        var end = offset + slice.length;
                        var hasMore = end < entry.text.length;
                        payload = JSON.stringify({
                            status: 'ok',
                            resultId: entry.id,
                            toolName: entry.toolName,
                            total: entry.text.length,
                            offset: offset,
                            returned: slice.length,
                            hasMore: hasMore,
                            nextOffset: hasMore ? end : null,
                            content: slice
                        });
                        if (payload.length <= READER_PAYLOAD_BUDGET || keep === 0) break;
                        keep = Math.max(0, keep - (payload.length - READER_PAYLOAD_BUDGET));
                    }
                    return { success: true, result: payload };
                }
            });
        }

        return { registerReadToolResult: registerReadToolResult };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createToolResultReaderTool = createToolResultReaderTool;
})(typeof global !== 'undefined' ? global : window);
