(function (global) {
    'use strict';
    function createArgParsing(opts) {
        function buildValidationSummary(validateResult) {
            const result = validateResult || {};
            const stageLabel = opts.getValidationStageLabel(result.stage);
            const risk = result.riskLevel ? `风险等级: ${result.riskLevel}` : '';
            const firstError = Array.isArray(result.errors) && result.errors[0] && result.errors[0].message
                ? `首个问题: ${result.errors[0].message}`
                : '';
            const firstWarn = Array.isArray(result.warnings) && result.warnings[0] && result.warnings[0].message
                ? `风险提示: ${result.warnings[0].message}`
                : '';
            return [stageLabel, risk, firstError, firstWarn].filter(Boolean).join(' | ');
        }

        // 为审核/修正 LLM 调用过滤上下文：去掉 tool 消息和 assistant 的 tool_calls。
        // 评审只需要用户的原始需求 + 对话，内部工具调用（memory_search 等）不相关，
        // 且带 tool 消息的上下文会触发 DeepSeek 等严格 API 校验 400。
        function filterContextForReview(allCtx) {
            if (!Array.isArray(allCtx)) return [];
            return allCtx.filter(function(m) {
                return m.role === 'user' || m.role === 'assistant' || m.role === 'system';
            }).map(function(m) {
                if (m.role === 'assistant' && m.tool_calls) {
                    return { role: 'assistant', content: m.content };
                }
                return m;
            });
        }

        // 解析工具入参并报告结果：ok=false 表示原始串非空、但两种解析都失败（LLM 输出非法 JSON）。
        // 调用方（toolExecutionPipeline）据此拒绝执行——静默降级成 {} 会让"空参也能成功"的工具
        // （executeExtendScript 最典型：空代码过 AST 门、宿主回「执行成功，未返回结果」）回成功，
        // LLM 据此以为操作已生效并在其上叠加后续操作。
        // 空/缺省串视为 ok=true 的 {}（部分 provider 对无参工具发空串，不能当解析失败）。
        function parseArgsResult(rawArgs) {
            if (!rawArgs) return { args: {}, ok: true, raw: '' };
            var raw = String(rawArgs);
            try {
                return { args: JSON.parse(raw), ok: true, raw: raw };
            } catch (_) {
                // LLM 常在参数字符串值内输出裸换行等控制字符导致 parse 失败。
                // 复用同文件的 fixJsonStringControlChars 修复控制字符后再 parse
                //（与 safeParseJson 兜底 2 一致）；仍失败才判解析失败。
                try {
                    return { args: JSON.parse(fixJsonStringControlChars(raw)), ok: true, raw: raw };
                } catch (_e) {
                    return { args: {}, ok: false, raw: raw };
                }
            }
        }

        function safeParseArgs(rawArgs) {
            return parseArgsResult(rawArgs).args;
        }

        // 修复 JSON 字符串值内的裸控制字符（\n \r \t）：
        // LLM 常在 message 字段中直接回车而非用 \n 转义，导致 JSON.parse 失败。
        // 本函数遍历字符，仅在字符串值内部（未被转义的双引号之间）将裸控制符转义。
        function fixJsonStringControlChars(text) {
            var result = '';
            var inString = false;
            var escaped = false;
            for (var i = 0; i < text.length; i++) {
                var ch = text[i];
                if (escaped) {
                    result += ch;
                    escaped = false;
                    continue;
                }
                if (ch === '\\' && inString) {
                    result += ch;
                    escaped = true;
                    continue;
                }
                if (ch === '"') {
                    inString = !inString;
                    result += ch;
                    continue;
                }
                if (inString) {
                    if (ch === '\n') { result += '\\n'; continue; }
                    if (ch === '\r') { result += '\\r'; continue; }
                    if (ch === '\t') { result += '\\t'; continue; }
                    // 其余裸控制字符（\b \f \v 等 charCode<32）统一
                    // \u00XX 转义——JSON 字符串值内 <0x20 的裸控制字符都会致 parse
                    // 失败，只修 \n\r\t 时二次 parse 仍失败、工具以空参数执行。
                    var cc = ch.charCodeAt(0);
                    if (cc < 32) { result += '\\u' + ('000' + cc.toString(16)).slice(-4); continue; }
                }
                result += ch;
            }
            return result;
        }

        function safeParseJson(text) {
            if (!text || typeof text !== 'string') return null;
            // 兜底：去掉可能的 Markdown 代码块包裹
            var t = text.trim();
            if (t.indexOf('```json') === 0 || t.indexOf('```') === 0) {
                t = t.replace(/^```json\s*\n?/, '').replace(/^```\s*\n?/, '');
                var end = t.lastIndexOf('```');
                if (end !== -1) t = t.substring(0, end).trim();
            }
            try {
                return JSON.parse(t);
            } catch (_) {
                // 兜底 1：JSON 可能被闲聊前缀/后缀包裹，提取首个 {...} 块再试
                // 防止 LLM 把 action JSON 用 ```json 围栏或 prose 包裹后漏进聊天原样展示
                var maybe = t.match(/\{[\s\S]*\}/);
                if (maybe) {
                    try { return JSON.parse(maybe[0]); } catch (e) {}
                }
                // 兜底 2：LLM 常在 message 等字符串字段中输出裸换行（非 \n 转义），
                // 导致 JSON.parse 失败。修复字符串内的控制字符后再试。
                var fixed = fixJsonStringControlChars(t);
                if (fixed !== t) {
                    try { return JSON.parse(fixed); } catch (e) {}
                    var maybeFixed = fixed.match(/\{[\s\S]*\}/);
                    if (maybeFixed) {
                        try { return JSON.parse(maybeFixed[0]); } catch (e2) {}
                    }
                }
                return null;
            }
        }

        return { buildValidationSummary: buildValidationSummary, filterContextForReview: filterContextForReview, safeParseArgs: safeParseArgs, parseArgsResult: parseArgsResult, fixJsonStringControlChars: fixJsonStringControlChars, safeParseJson: safeParseJson };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createArgParsing = createArgParsing;
})(typeof global !== 'undefined' ? global : window);