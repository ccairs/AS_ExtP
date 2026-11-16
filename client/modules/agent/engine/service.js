(function (global) {
    const prompts = global.AEEngine && global.AEEngine.prompts ? global.AEEngine.prompts : null;

    // ── token 统计存储（团队模式）─────────────────────────
    // 这份对象字面量是**方法集/形状模板**，不参与运行期记账：records/sessionId 只作占位，
    // 真实状态由 createTokenStatsStore() 逐实例新开（见下方工厂）。为什么保留模板而不是
    // 把方法搬进工厂函数体：① 缺省实例的键序与方法集与改动前的单例**逐字一致**（沿用它复制）；
    // ② 既有断言覆盖单例时代的两种形态（含
    // 对 reset() 清归属的断言）继续成立。
    var _tokenStatsMethods = {
        records: [],
        // 这批记录**属于哪个会话**（记录不随会话隔离——一条 lane 的实例跨会话复用，故必须显式记归属）。
        // 由 recordStreamUsage（记一轮时adopt）与 restoreTokenStats（恢复某会话的记录时）写入，
        // reset()/clear() 一并清空。保存前用它校验目标会话，防「cm 已指向别处」时写错文件。
        sessionId: null,
        // timing: 可选 { firstTokenMs, llmDurationMs }——主循环 LLM 流式调用的计时指标。
        // 审查/摘要等辅助调用不传 timing，不计入「轮次」。
        // 返回新记录引用，供控制器在主循环工具执行完毕后回填 toolCalls/toolDurationMs。
        addRecord(stage, usage, timing) {
            if (!usage) return null;
            var rec = {
                stage: stage,
                promptTokens: usage.prompt_tokens || 0,
                completionTokens: usage.completion_tokens || 0,
                totalTokens: usage.total_tokens || 0,
                cacheHitTokens: usage.cache_hit_tokens || 0,
                timestamp: Date.now(),
                firstTokenMs: null,
                llmDurationMs: null,
                toolCalls: 0,
                toolDurationMs: 0
            };
            if (timing) {
                if (typeof timing.firstTokenMs === 'number') rec.firstTokenMs = timing.firstTokenMs;
                if (typeof timing.llmDurationMs === 'number') rec.llmDurationMs = timing.llmDurationMs;
            }
            this.records.push(rec);
            return rec;
        },
        // 回填某一轮的工具执行指标（工具执行在主循环 LLM 调用之后，故单独回填到该轮记录）
        attachToolMetrics(rec, toolCount, toolMs) {
            if (!rec) return;
            rec.toolCalls = toolCount || 0;
            rec.toolDurationMs = toolMs || 0;
        },
        getSummary() {
            var summary = {};
            this.records.forEach(function (r) {
                if (!summary[r.stage]) {
                    summary[r.stage] = { count: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0 };
                }
                summary[r.stage].count += 1;
                summary[r.stage].promptTokens += r.promptTokens;
                summary[r.stage].completionTokens += r.completionTokens;
                summary[r.stage].totalTokens += r.totalTokens;
            });
            return summary;
        },
        getFormattedSummary() {
            var summary = this.getSummary();
            var lines = ['=== Token 使用统计 ==='];
            var stages = Object.keys(summary);
            if (!stages.length) return '暂无 token 使用记录。';
            var sorted = stages.sort(function (a, b) {
                return summary[b].totalTokens - summary[a].totalTokens;
            });
            var grandTotal = 0;
            sorted.forEach(function (stage) {
                var s = summary[stage];
                lines.push(stage + ': ' + s.count + '次调用, 输入=' + s.promptTokens + ', 输出=' + s.completionTokens + ', 合计=' + s.totalTokens);
                grandTotal += s.totalTokens;
            });
            lines.push('---');
            lines.push('总消耗: ' + grandTotal + ' tokens');
            lines.push('最耗token环节: ' + sorted[0] + ' (' + summary[sorted[0]].totalTokens + ')');
            return lines.join('\n');
        },
        // 返回当前会话累计的发送/接收 token 总数、缓存命中率及性能指标。
        // 用于 UI 显示。无记录时返回 null，调用方可据此显示占位符（如 '--'）
        getTotal() {
            if (!this.records || !this.records.length) return null;
            var promptTokens = 0;
            var completionTokens = 0;
            var totalTokens = 0;
            var cacheHitTokens = 0;
            // 性能指标：仅统计带 timing 的主循环记录（轮次），辅助调用（审查/摘要）不计入
            var llmCalls = 0;        // LLM 轮次
            var toolCalls = 0;       // 工具步数
            var firstTokenSum = 0;   // 首token 延迟累计（ms）
            var firstTokenCount = 0;
            var totalLlmMs = 0;      // LLM 运行时间累计（ms）
            var totalToolMs = 0;     // 工具运行时间累计（ms）
            var timedCompletion = 0; // 参与速度计算的接收 token 累计
            var genSec = 0;          // 生成耗时累计（首token→完成，秒）
            for (var i = 0; i < this.records.length; i++) {
                var r = this.records[i];
                promptTokens += r.promptTokens || 0;
                completionTokens += r.completionTokens || 0;
                totalTokens += r.totalTokens || 0;
                cacheHitTokens += r.cacheHitTokens || 0;
                if (typeof r.llmDurationMs === 'number') {
                    llmCalls++;
                    totalLlmMs += r.llmDurationMs;
                    timedCompletion += r.completionTokens || 0;
                }
                if (typeof r.firstTokenMs === 'number') {
                    firstTokenSum += r.firstTokenMs;
                    firstTokenCount++;
                    if (typeof r.llmDurationMs === 'number') {
                        var gen = r.llmDurationMs - r.firstTokenMs;
                        if (gen > 0) genSec += gen / 1000;
                    }
                }
                toolCalls += r.toolCalls || 0;
                totalToolMs += r.toolDurationMs || 0;
            }
            return {
                promptTokens: promptTokens,
                completionTokens: completionTokens,
                totalTokens: totalTokens,
                cacheHitTokens: cacheHitTokens,
                cacheHitRate: promptTokens > 0 ? cacheHitTokens / promptTokens : 0,
                llmCalls: llmCalls,
                toolCalls: toolCalls,
                avgFirstTokenMs: firstTokenCount ? firstTokenSum / firstTokenCount : null,
                totalLlmMs: totalLlmMs,
                totalToolMs: totalToolMs,
                avgTokPerSec: genSec > 0 ? timedCompletion / genSec : null
            };
        },
        clear() {
            this.records = [];
            this.sessionId = null;
        },
        // 重置当前会话累计的 token 统计（会话切换/清空对话时调用）
        reset() {
            this.records = [];
            this.sessionId = null;
        }
    };

    // 一份**全新的**统计存储实例：方法集与缺省实例完全相同，records/sessionId 各自独立。
    // 为什么必须 per-lane：三条 lane 共写一份数组时，一条 lane 的「清空对话」
    // （apiActions 的 clear → reset）会清掉三条 lane 的全部统计，各自保存时又把「三 lane 之和」
    // 写进自己的 token 文件并互相覆盖；顶栏/任务板的用量也会串。
    function createTokenStatsStore() {
        var inst = Object.assign({}, _tokenStatsMethods);
        inst.records = [];      // 覆盖模板里的数组引用：状态必须自持，不能与模板/其它实例共享
        inst.sessionId = null;
        return inst;
    }

    // 缺省实例：单 Agent 路径的历史入口（global.AEEngine.tokenStats），语义与方法集不变
    var defaultTokenStats = createTokenStatsStore();
    // laneId -> 实例（惰性创建并登记；键统一转字符串，数字型 laneId 不会与字符串型分家）
    var _tokenStatsByLane = {};

    // 取某 lane 的统计存储实例。laneId 为空/falsy → 缺省实例（单 Agent 路径）；
    // 未注册的 laneId → **惰性创建并登记**（保证调用方永远拿不到 undefined）。
    function tokenStatsFor(laneId) {
        if (!laneId) return defaultTokenStats;
        var key = String(laneId);
        if (!_tokenStatsByLane[key]) _tokenStatsByLane[key] = createTokenStatsStore();
        return _tokenStatsByLane[key];
    }

    // 显式登记某 lane 的实例（orchestrator/测试用）。缺省槽**不接受替换**：它是单 Agent 路径的
    // 历史入口，global.AEEngine.tokenStats 的引用必须稳定（controller.js/apiActions.js 多处直读）。
    // 未传有效实例时按「未注册」处理（惰性创建），返回值恒为可用实例。
    function setTokenStatsFor(laneId, stats) {
        if (!laneId) return defaultTokenStats;
        if (stats && typeof stats === 'object') _tokenStatsByLane[String(laneId)] = stats;
        return tokenStatsFor(laneId);
    }

    function safeJsonParse(raw) {
        if (!raw) return null;
        var str = String(raw).trim();
        if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
        var fenceMatch = str.match(/^```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```$/);
        if (fenceMatch) {
            str = fenceMatch[1].trim();
            var _l = global.AEAgentApp && global.AEAgentApp.debugLog || function () {};
            _l('safeJsonParse-strip-fence', { originalLength: String(raw).length, strippedLength: str.length });
        }
        try {
            return JSON.parse(str);
        } catch (_) {
            var maybe = str.match(/\{[\s\S]*\}/);
            if (maybe) {
                try {
                    return JSON.parse(maybe[0]);
                } catch (_) {}
            }
            var arrMatch = str.match(/\[[\s\S]*\]/);
            if (arrMatch) {
                try {
                    return JSON.parse(arrMatch[0]);
                } catch (_) {}
            }
            var _l2 = global.AEAgentApp && global.AEAgentApp.debugLog || function () {};
            _l2('safeJsonParse-failed', { inputPreview: str.substring(0, 300) });
            return null;
        }
    }

    function normalizeReview(raw) {
        const riskRaw = raw && typeof raw.riskLevel === 'string' ? raw.riskLevel.toLowerCase() : 'medium';
        const riskLevel = riskRaw === 'low' || riskRaw === 'medium' || riskRaw === 'high' ? riskRaw : 'medium';
        const normalizeIssueList = (list, fallbackCode) => {
            if (!Array.isArray(list)) return [];
            return list
                .map((item) => {
                    const code = item && item.code ? String(item.code) : fallbackCode;
                    const message = item && item.message ? String(item.message) : '';
                    if (!message.trim()) return null;
                    return { code, message };
                })
                .filter(Boolean);
        };
        const errors = normalizeIssueList(raw && raw.errors, 'REVIEW_ERROR');
        const warnings = normalizeIssueList(raw && raw.warnings, 'REVIEW_WARN');
        const valid = !!(raw && raw.valid) && errors.length === 0;
        return {
            valid,
            riskLevel,
            errors,
            warnings
        };
    }

    async function requestChat(options, _llmChannel) {
        const opts = options || {};
        const channel = _llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel) || null;

        if (channel) {
            // 透传外部 signal 给 llmChannel（sendJson 现经 options.signal 转发到
            // 内部 AbortController）。sendJson 不接受 signal 时，这里只能在 abort 时调
            // channel.abort()——那是**全局**中止，会连带杀掉桌宠/ComfyUI/MCP 共享通道的
            // 在途请求；现在只中止本审查请求。已中止的 signal 维持同步抛出的旧行为。
            var signal = opts.signal;
            if (signal && signal.aborted) {
                throw new Error('aborted');
            }

            var result = await channel.sendJson({
                messages: opts.messages || [],
                apiKey: opts.apiKey || '',
                model: opts.model || '',
                platform: opts.platform || '',
                jsonMode: opts.jsonMode !== false,
                reasoningEffort: opts.reasoningEffort || null,
                options: { timeoutMs: opts.timeoutMs || 120000, signal: signal || null }
            });

            if (result && result.error) {
                throw new Error(result.message || 'API请求失败');
            }

            if (result && result.usage && typeof result.usage.total_tokens !== 'undefined') {
                // 审查/摘要等辅助调用不带 lane 身份（调用方 options 里没有 lane 字段），
                // 一律记入缺省实例——与改动前写模块级单例的行为一致；lane 内的记账
                // （主循环/压缩）走 controller 注入的 per-lane 实例。
                defaultTokenStats.addRecord(opts.stage || 'unknown', result.usage);
            }

            var content = (result && result.content) || '';
            if (!content) {
                throw new Error('模型返回内容为空');
            }
            return { content, reasoningContent: (result && result.reasoningContent) || '' };
        }

        throw new Error('LLM_CHANNEL_UNAVAILABLE: llmChannel 未注入且全局不可用');
    }

    // 将 toLlmMessages 返回的上下文消息无损映射到 API messages，保留 tool_call_id / tool_calls 等字段。
    // 之前的逐条只会拷 role+content，tool 消息缺 tool_call_id → API 400（DeepSeek 严格校验）。
    function mapContextMessages(contextMessages) {
        var result = [];
        if (!Array.isArray(contextMessages)) return result;
        for (var ci = 0; ci < contextMessages.length; ci++) {
            var m = contextMessages[ci];
            if (!m || !m.role || !m.content) continue;
            var entry = { role: String(m.role), content: String(m.content) };
            if (m.tool_call_id) entry.tool_call_id = m.tool_call_id;
            if (m.name) entry.name = m.name;
            if (m.tool_calls) entry.tool_calls = m.tool_calls;
            // 判 undefined 而非真值：上下文层会主动下发空串（带 tool_calls 的轮次字段必须存在，
            // DeepSeek thinking 模式 + tools 的协议要求），真值判断会把空串丢掉导致 400
            if (m.reasoning_content !== undefined) entry.reasoning_content = m.reasoning_content;
            result.push(entry);
        }
        return result;
    }

    function createService(deps) {
        var llmChannel = (deps && deps.llmChannel) || (global.AE_LLM && global.AE_LLM.llmChannel) || null;
        var promptBuilder = (deps && deps.promptBuilder) || (global.AE_LLM && global.AE_LLM.promptBuilder) || null;

        // agent 内部调用统一显式携带 moduleId（契约：不传=未知调用方，仅有全局可见性），
        // 使 available_skills / aeContext 等 promptBuilder 钩子拿到正确的模块身份。
        // noUserRules：本服务的审查提示词均为独立安全评审上下文，显式声明不注入
        // 用户规则（防行为引导内容软化评审独立性，注入器据此静默跳过不告警）
        // noAeInfo/noSkills（审查员的提示词应该保持干净）：
        // 审查上下文只保留审查口径——主对话的 AE 环境行与技能清单都不进（审查员不调工具，
        // 两者在独立上下文里只是无关噪声；与 noUserRules 同一子任务口径，注入器各自静默跳过）。
        // 人格同理不进审查上下文：四个审查 system prompt 组装器一律不接人格参数
        // （口径与缘由见 prompts.js 审查段头注释）
        function withModuleId(opts) {
            return Object.assign({}, opts, {
                moduleId: (opts && opts.moduleId) || 'agent',
                noUserRules: true,
                noAeInfo: true,
                noSkills: true
            });
        }

        return {
            async reviewScript(options) {
                const opts = options || {};
                // 审查任务专用 system prompt：聚焦"安全审查员"角色，不带 Script/Agent overlay 的工具使用/决策流程等无关内容。
                // mode='shader'：审查 shader 模式 JS 效果代码，走专用 prompt（面板侧 JS，非 ExtendScript）。
                // 否则：ExtendScript 审查。sysCallBlocked 注入 system prompt（现读 AST 门
                // config 即时生效）——Agent 模式（executeExtendScript 审查）随 bypass['agent-tool']
                // ∪ domains.system；Script 模式随 bypass['llm-preview'] ∪ domains.system。
                // config 缺席（模块未载）回退未开启口径（fail-safe）。
                if (opts.mode === 'shader') {
                    const shaderBase = prompts && prompts.buildShaderJsReviewSystemPrompt
                        ? prompts.buildShaderJsReviewSystemPrompt()
                        : 'You are a shader JS effect reviewer. Return JSON only.';
                    const shaderSystemPrompt = promptBuilder ? promptBuilder.build(shaderBase, withModuleId(opts)) : shaderBase;
                    const shaderUserPrompt = prompts
                        ? prompts.buildShaderJsReviewUserPrompt(opts)
                        : 'Review shader JS effect for safety:\n' + (opts.script || '');
                    var shaderMessages = [{ role: 'system', content: shaderSystemPrompt }];
                    shaderMessages = shaderMessages.concat(mapContextMessages(opts.contextMessages));
                    shaderMessages.push({ role: 'user', content: shaderUserPrompt });
                    const shaderResult = await requestChat({
                        apiKey: opts.apiKey,
                        model: opts.model,
                        platform: opts.platform,
                        messages: shaderMessages,
                        signal: opts.signal,
                        stage: '审查shader JS效果',
                        jsonMode: true,
                        reasoningEffort: opts.reasoningEffort || null,
                        timeoutMs: opts.timeoutMs
                    }, llmChannel);
                    const shaderParsed = safeJsonParse(shaderResult.content);
                    if (!shaderParsed || typeof shaderParsed !== 'object') {
                        return {
                            valid: false,
                            riskLevel: 'high',
                            errors: [{ code: 'REVIEW_PARSE_FAILED', message: '模型审查结果解析失败' }],
                            warnings: [],
                            reasoningContent: shaderResult.reasoningContent || ''
                        };
                    }
                    var shaderNorm = normalizeReview(shaderParsed);
                    shaderNorm.reasoningContent = shaderResult.reasoningContent || '';
                    return shaderNorm;
                }
                // 能力域三布尔：现读 AST 门 config（domains ∪ 通道 bypass）注入
                // 审查 prompt——Agent 模式随 bypass['agent-tool']，Script 模式随
                // bypass['llm-preview']。config 缺席（模块未载）按全部未开启（fail-safe）。
                let sysCallBlocked = true, sockBlocked = true, fileBlocked = true;
                if (global.AEGate && global.AEGate.config) {
                    const _srcBypass = global.AEGate.config.isBypassed(opts.mode === 'agent' ? 'agent-tool' : 'llm-preview');
                    const _doms = global.AEGate.config.read().domains;
                    sysCallBlocked = !(_doms.system === true || _srcBypass);
                    sockBlocked = !(_doms.socket === true || _srcBypass);
                    fileBlocked = !(_doms.file === true || _srcBypass);
                }
                const basePrompt = prompts && prompts.buildReviewSystemPrompt
                    ? prompts.buildReviewSystemPrompt(sysCallBlocked, sockBlocked, fileBlocked)
                    : 'You are a script reviewer. Return JSON only.';
                const systemPrompt = promptBuilder ? promptBuilder.build(basePrompt, withModuleId(opts)) : basePrompt;
                const userPrompt = prompts
                    ? prompts.buildReviewUserPrompt(opts)
                    : 'Review script for safety and runtime risks:\n' + (opts.script || '');
                var messages = [{ role: 'system', content: systemPrompt }];
                messages = messages.concat(mapContextMessages(opts.contextMessages));
                messages.push({ role: 'user', content: userPrompt });
                const { content, reasoningContent } = await requestChat({
                    apiKey: opts.apiKey,
                    model: opts.model,
                    platform: opts.platform,
                    messages: messages,
                    signal: opts.signal,
                    stage: '审查脚本',
                    jsonMode: true,
                    reasoningEffort: opts.reasoningEffort || null,
                    timeoutMs: opts.timeoutMs
                }, llmChannel);
                const parsed = safeJsonParse(content);
                if (!parsed || typeof parsed !== 'object') {
                    return {
                        valid: false,
                        riskLevel: 'high',
                        errors: [{ code: 'REVIEW_PARSE_FAILED', message: '模型审查结果解析失败' }],
                        warnings: [],
                        reasoningContent: reasoningContent || ''
                    };
                }
                var result = normalizeReview(parsed);
                result.reasoningContent = reasoningContent || '';
                return result;
            },

            // 审查 createAETool 创建的自定义工具代码
            // 与 reviewScript 区别：禁止弹窗 API；含代码质量规则；能力域口径随
            // ae-tool 通道（三布尔现读注入）
            async reviewAeTool(options) {
                const opts = options || {};
                // 审查任务专用 system prompt：聚焦"安全审查员"角色，不带 Script overlay 的无关内容。
                // 能力域三布尔（现读 AST 门 config 即时生效）——ae-tool 审查
                // 口径随 bypass['ae-tool'] ∪ domains；config 缺席（模块未载）system 回退
                // opts.allowAEToolsSystemCall（mirror——面板端由 config 单点维护），sock/
                // file 按未开启。
                let sysCallBlocked, sockBlocked = true, fileBlocked = true;
                if (global.AEGate && global.AEGate.config) {
                    const _aeBypass = global.AEGate.config.isBypassed('ae-tool');
                    const _aeDoms = global.AEGate.config.read().domains;
                    sysCallBlocked = !(_aeDoms.system === true || _aeBypass);
                    sockBlocked = !(_aeDoms.socket === true || _aeBypass);
                    fileBlocked = !(_aeDoms.file === true || _aeBypass);
                } else {
                    sysCallBlocked = !opts.allowAEToolsSystemCall;
                }
                const basePrompt = prompts && prompts.buildAeToolReviewSystemPrompt
                    ? prompts.buildAeToolReviewSystemPrompt(sysCallBlocked, sockBlocked, fileBlocked)
                    : 'You are a script reviewer. Return JSON only.';
                const systemPrompt = promptBuilder ? promptBuilder.build(basePrompt, withModuleId(opts)) : basePrompt;
                const userPrompt = prompts
                    ? prompts.buildAeToolReviewUserPrompt(opts)
                    : 'Review AE tool script for safety:\n' + (opts.script || '');
                var messages = [{ role: 'system', content: systemPrompt }];
                messages.push({ role: 'user', content: userPrompt });
                const { content, reasoningContent } = await requestChat({
                    apiKey: opts.apiKey,
                    model: opts.model,
                    platform: opts.platform,
                    messages: messages,
                    signal: opts.signal,
                    stage: '审查AE工具',
                    jsonMode: true,
                    reasoningEffort: opts.reasoningEffort || null,
                    timeoutMs: opts.timeoutMs
                }, llmChannel);
                const parsed = safeJsonParse(content);
                if (!parsed || typeof parsed !== 'object') {
                    return {
                        valid: false,
                        riskLevel: 'high',
                        errors: [{ code: 'REVIEW_PARSE_FAILED', message: '模型审查结果解析失败' }],
                        warnings: [],
                        reasoningContent: reasoningContent || ''
                    };
                }
                var result = normalizeReview(parsed);
                result.reasoningContent = reasoningContent || '';
                return result;
            },

            // 补表提议审查（reviewAeTool 同款架构：独立上下文 + JSON mode +
            // fail-closed 三连——审查员未注入/请求失败/解析失败均拒绝提议）。
            // 共用 reviewAeTool 的模型配置（apiKey/model/platform 由调用方注入同一
            // 来源）；审查对象是类型表条目而非代码（prompts 专用构建器）。
            async reviewTableProposal(options) {
                const opts = options || {};
                const basePrompt = prompts && prompts.buildTableProposalReviewSystemPrompt
                    ? prompts.buildTableProposalReviewSystemPrompt()
                    : 'You are a whitelist entry reviewer. Return JSON only.';
                const systemPrompt = promptBuilder ? promptBuilder.build(basePrompt, withModuleId(opts)) : basePrompt;
                const userPrompt = prompts
                    ? prompts.buildTableProposalReviewUserPrompt(opts)
                    : 'Review whitelist entry: ' + (opts.memberName || '');
                var messages = [{ role: 'system', content: systemPrompt }];
                messages.push({ role: 'user', content: userPrompt });
                // fail-closed 三连②：请求失败（通道异常/超时）返回拒绝形态而非抛出——
                // 与 reviewAeTool 的差异（后者由调用方 catch）是有意的：本方法的消费方
                // 是工具编排层（tableTools），拒绝形态让回喂文案统一走 result 链
                var content = '', reasoningContent = '';
                try {
                    var _resp = await requestChat({
                        apiKey: opts.apiKey,
                        model: opts.model,
                        platform: opts.platform,
                        messages: messages,
                        signal: opts.signal,
                        stage: '审查补表提议',
                        jsonMode: true,
                        reasoningEffort: opts.reasoningEffort || null,
                        timeoutMs: opts.timeoutMs
                    }, llmChannel);
                    content = _resp.content;
                    reasoningContent = _resp.reasoningContent;
                } catch (e) {
                    return {
                        valid: false,
                        riskLevel: 'high',
                        errors: [{ code: 'REVIEW_REQUEST_FAILED', message: '审查请求失败: ' + (e && e.message ? e.message : String(e)) }],
                        warnings: [],
                        reasoningContent: ''
                    };
                }
                const parsed = safeJsonParse(content);
                if (!parsed || typeof parsed !== 'object') {
                    return {
                        valid: false,
                        riskLevel: 'high',
                        errors: [{ code: 'REVIEW_PARSE_FAILED', message: '模型审查结果解析失败' }],
                        warnings: [],
                        reasoningContent: reasoningContent || ''
                    };
                }
                var result = normalizeReview(parsed);
                result.reasoningContent = reasoningContent || '';
                return result;
            }
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createService = createService;
    // 统计存储（团队模式）：工厂 + per-lane 分发 + 缺省实例。
    // 缺省实例 = 单 Agent 路径的历史入口，方法集/行为与改动前的模块级单例逐字一致。
    global.AEEngine.createTokenStatsStore = createTokenStatsStore;
    global.AEEngine.tokenStatsFor = tokenStatsFor;
    global.AEEngine.setTokenStatsFor = setTokenStatsFor;
    global.AEEngine.tokenStats = defaultTokenStats;
})(window);
