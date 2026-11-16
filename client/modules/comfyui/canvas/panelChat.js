(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};

    // 白名单过滤：只留 MCP 服务端工具 + Skill 工具。
    // 排除 mcp_servers/mcp_control（MCP 管理工具，非查资料类，不应出现在提示词面板）。
    // defs 形如 getLlmToolDefinitions 返回：[{type:'function', function:{name,...}, _source}]
    function filterPanelTools(defs) {
        if (!defs || !defs.length) return [];
        var kept = [];
        var _EXCLUDE = { mcp_servers: true, mcp_control: true };
        for (var i = 0; i < defs.length; i++) {
            var d = defs[i];
            var name = d && d.function && d.function.name;
            var src = d && d._source;
            if (_EXCLUDE[name]) continue;
            if (name === 'Skill' || src === 'mcp') kept.push(d);
        }
        return kept;
    }
    global.AEComfyUI.filterPanelTools = filterPanelTools;

    // 工具结果上限（口径与 agent 工具管线的 toResult 对齐）：面板侧 contextManager 只按 token 预算
    // 从头裁历史（maxContextTokens=60000），一条超巨结果会把整个会话挤掉而自己仍超窗——
    // 面板工具通道同样按该上限截断，避免超巨结果挤掉会话。
    // 随 agent 侧一并下调 128K → 32K（头 24K + 尾 8K）：同一仓库不该有两套上限，
    // 且它自己的预算更小（60000 token），旧 128K 字符≈2 倍预算。**已知边界**：32K 字符在该预算里
    // 仍约占一半（最坏情形，中文≈1 token/字符）——故它只兜异常大结果，正常分页页
    //（readFile / read_tool_result 单页 ≤20000）不会被碰到。
    var PANEL_TOOL_RESULT_MAX_CHARS = 32 * 1024;
    var PANEL_TOOL_RESULT_HEAD = 24 * 1024;
    var PANEL_TOOL_RESULT_TAIL = 8 * 1024;

    // 可测聊天循环。opts: {
    //   contextManager, llmChannel, toolExecutor,
    //   getTools: () => filteredDefs,
    //   buildSystemPrompt: () => string,
    //   resolveApiKey: () => Promise<string>,  // 解析当前默认平台的 apiKey（agent 同款逻辑），传给 sendStream
    //   maxLoops,
    //   onToken(token, full), onToolCall(tc), onToolResult(tc, text), onDone(text), onError(err)
    // }
    // 驱动 tool loop：sendStream 单轮纯传输，这里循环：有 toolCalls → execute → addToolResult → 重发；无 → 结束。
    function createPanelChat(opts) {
        opts = opts || {};
        var contextManager = opts.contextManager;
        var llmChannel = opts.llmChannel;
        var toolExecutor = opts.toolExecutor;
        var getTools = opts.getTools || function () { return []; };
        var buildSystemPrompt = opts.buildSystemPrompt || function () { return ''; };
        var resolveApiKey = opts.resolveApiKey || function () { return Promise.resolve(''); };
        var maxLoops = opts.maxLoops || 8;
        var stopped = false;
        // 运行代际。stop() 递增使旧循环（含工具执行中挂起的那个）立即失效——
        // stopped 若是共享布尔，新 chat() 开头把它复位为 false，旧循环在工具返回后
        // 会「复活」继续跑，与新一轮并发写同一 contextManager/气泡。代际判定后旧循环的
        // 迟到 token / 工具结果 / onDone 一律丢弃（stale()）。
        var _runGen = 0;
        // 本聊天自己的在途请求中止控制器。stop() 调全局
        // llmChannel.abort()——那是**全实例**中止，会连带杀掉同一共享通道上 agent 主循环/
        // 桌宠/MCP 的在途请求（agent 表现为神秘停止）。现在 sendStream 经 options.signal
        // 绑定它，stop() 只 abort 它。
        var _abortController = null;

        // stop 须真正中断 HTTP 流：仅置 stopped 标志位只能让 onToken 回调停止往 UI 写，
        // sendStream 仍在接收 token、loop 仍会进入下一轮。这里 abort 本聊天自己的
        // controller（signal 已随 options.signal 传给 sendStream），sendStream 内 catch 后
        // resolve 带 error 的 result，走 onError/静默返回路径退出循环。
        function stop() {
            stopped = true;
            _runGen++;   // 旧循环代际失效（工具返回后不得继续写共享上下文/气泡）
            if (_abortController) {
                try { _abortController.abort(); } catch (_) {}
            }
        }

        // 把 contextManager.toLlmMessages() 拼成 OpenAI 风格 messages（保留 tool_calls/tool_call_id/name/reasoning）
        function buildMessages() {
            var messages = [{ role: 'system', content: buildSystemPrompt() }];
            var ctxMsgs = contextManager.toLlmMessages();
            for (var i = 0; i < ctxMsgs.length; i++) {
                var cm = ctxMsgs[i];
                var m = { role: cm.role, content: cm.content };
                if (cm.tool_call_id) m.tool_call_id = cm.tool_call_id;
                if (cm.name) m.name = cm.name;
                if (cm.tool_calls) m.tool_calls = cm.tool_calls;
                // 判 undefined（含空串）——同 agent 管线：DeepSeek thinking + tools 下
                // 带 tool_calls 的轮次 reasoning_content 字段必须存在，空串合法
                if (cm.reasoning_content !== undefined) m.reasoning_content = cm.reasoning_content;
                messages.push(m);
            }
            return messages;
        }

        async function chat(userText) {
            stopped = false;
            var myGen = ++_runGen;   // 本次运行代际（stop()/下一次 chat 都会使其失效）
            function stale() { return stopped || myGen !== _runGen; }
            if (!contextManager || !llmChannel) {
                if (opts.onError) opts.onError(new Error('panelChat 未注入 contextManager/llmChannel'));
                return '';
            }
            // 每次 chat 新建自己的中止控制器并绑到当前轮所有 sendStream 上；
            // stop() 只 abort 它（不再全局 llmChannel.abort()）。无 AbortController 的
            // 极简环境（旧 mock/测试）退化为不绑 signal，行为不变。
            _abortController = (typeof AbortController === 'function') ? new AbortController() : null;
            var _reqSignal = _abortController ? _abortController.signal : null;
            contextManager.add('user', userText);
            var tools = getTools() || [];
            // 执行侧白名单：只允许执行当前轮实际广告给模型的工具。
            // 广告过滤（filterPanelTools / scope 过滤）只约束模型的知情权，不约束其行为——
            // 幻觉或提示注入（如 MCP 网页内容里的恶意指令）仍可能产出未广告的工具名，
            // 这里在执行前拦下（与 toolExecutor 执行侧校验同思路）。
            var allowedTools = {};
            for (var ti = 0; ti < tools.length; ti++) {
                var tdef = tools[ti];
                var tdefName = (tdef && tdef.function && tdef.function.name) || (tdef && tdef.name);
                if (tdefName) allowedTools[tdefName] = true;
            }
            // 解析 apiKey 一次（与 agent resolveApiKeyForPlatform 同款逻辑）。
            // sendStream 不解析 apiKey，必须调用方传入；漏传 = 空串发请求必报错。
            var apiKey = '';
            try { apiKey = (await resolveApiKey()) || ''; } catch (_) {}
            var loop = 0;
            var lastContent = '';
            var _contentRecorded = false;  // 当前 lastContent 是否已随 addToolCallAssistant 入库
            while (loop < maxLoops) {
                if (stale()) break;
                loop++;
                var messages = buildMessages();
                var result;
                try {
                    result = await llmChannel.sendStream({
                        messages: messages,
                        tools: tools,
                        apiKey: apiKey,
                        // 绑定本聊天自己的 signal——stop() 只中止本聊天在途请求
                        options: { signal: _reqSignal }
                    }, {
                        // stop 后不再往 UI 追加 token（signal 已中止流 + 代际判定双保险）
                        onToken: function (tok, full) { if (!stale() && opts.onToken) opts.onToken(tok, full); }
                    });
                } catch (e) {
                    if (!stale() && opts.onError) opts.onError(e);
                    return '';
                }
                if (!result) {
                    if (!stale() && opts.onError) opts.onError(new Error('sendStream 返回空'));
                    return '';
                }
                // 停止/被新 chat 取代后，迟到的 sendStream 结果一律丢弃——
                // 不写共享上下文、不回调（否则与新循环并发写同一气泡/上下文）
                if (stale()) return '';
                // sendStream 永不 reject：错误时 resolve 一个带 .error 的 result（llmChannel.js:240-243/252-255）。
                // 必须显式检查，否则 error result 会被当成功空回复处理。
                if (result.error) {
                    // 用户主动停止（stop() abort 自有 signal → ABORTED）不是失败：静默返回，不弹"聊天失败"
                    var _isAbort = result.error === 'ABORTED' || result.aborted === true
                        || (result.message || '').toLowerCase().indexOf('abort') >= 0;
                    if (!_isAbort && opts.onError) opts.onError(new Error(result.message || result.error));
                    return '';
                }
                lastContent = result.content || '';
                _contentRecorded = false;  // 本次 content 尚未入库
                var toolCalls = result.toolCalls && result.toolCalls.length ? result.toolCalls : null;
                if (toolCalls) {
                    contextManager.addToolCallAssistant(lastContent, toolCalls, result.reasoningContent);
                    _contentRecorded = true;  // 文本已随工具调用入库
                    for (var t = 0; t < toolCalls.length; t++) {
                        if (stale()) break;
                        var tc = toolCalls[t];
                        // 兼容嵌套 {function:{name, arguments:<JSON串>}}（真实 sendStream，见 protocolAdapters.js finalizeOpenAiToolCalls）
                        // 和扁平 {name, arguments:<obj>}（旧 mock/兼容）。arguments 是字符串则 JSON.parse。
                        var fn = tc.function || {};
                        var tname = fn.name || tc.name;
                        var args = {};
                        var rawArgs = fn.arguments !== undefined ? fn.arguments : tc.arguments;
                        var argsParseFailed = false;
                        if (rawArgs && typeof rawArgs === 'string') {
                            // 解析失败不再静默降级成空参数执行（对齐 agent 工具管线的 ARGS_PARSE_FAILED）：
                            // 以空参执行会让"参数可选"的工具按默认值跑、模型以为参数已送到
                            //（第三条工具通道同样需要显式报错，不能静默降级）
                            try { args = JSON.parse(rawArgs) || {}; } catch (e) { argsParseFailed = true; }
                        } else if (rawArgs && typeof rawArgs === 'object') {
                            args = rawArgs;
                        } else if (rawArgs !== undefined && rawArgs !== null && rawArgs !== '') {
                            argsParseFailed = true;   // 非对象标量（"str"/42/true）：不是合法参数对象
                        }
                        if (argsParseFailed) {
                            var _badArgsText = '工具入参不是合法 JSON 对象，本次未执行。原始参数（最多 300 字符）：'
                                + String(rawArgs).slice(0, 300) + '\n请用合法 JSON 重新调用。';
                            contextManager.addToolResult(tc.id, tname, _badArgsText);
                            if (opts.onToolResult) opts.onToolResult(tc, _badArgsText);
                            continue;
                        }
                        if (!allowedTools[tname]) {
                            // 未在当前轮广告列表中的工具：不执行。
                            // 仍须回一条 tool result 保持 tool_call_id 配对（OpenAI 协议要求，
                            // 否则下一轮请求报错），让模型据此向用户解释或改用可用工具。
                            var deniedText = '工具 "' + tname + '" 在当前上下文不可用（不在本会话的工具列表中）。请改用可用工具或直接回答。';
                            contextManager.addToolResult(tc.id, tname, deniedText);
                            if (opts.onToolResult) opts.onToolResult(tc, deniedText);
                            continue;
                        }
                        if (opts.onToolCall) opts.onToolCall(tc);
                        var execRes = null;
                        try {
                            execRes = await toolExecutor.execute(tname, args, 'comfyui');
                        } catch (e) {
                            execRes = { success: false, isError: true, content: [{ type: 'text', text: '工具执行异常: ' + (e && e.message ? e.message : e) }] };
                        }
                        // 停止后工具结果丢弃——不 addToolResult/不 onToolResult，
                        // 防止旧循环与新 chat 并发写同一上下文（缺失的 tool 响由请求层
                        // toLlmMessages 的完整性兜底补占位，报文仍合法）
                        if (stale()) break;
                        var text = (execRes && execRes.content && execRes.content[0] && execRes.content[0].text) || '';
                        // 结果上限（口径与 agent 工具管线 toResult 对齐，32K）：
                        // 面板侧 contextManager 只按 token 预算从头裁历史（maxContextTokens=60000），
                        // 一条超巨结果会把整个会话挤掉而自己仍超窗——这里同样按上限截断兜底
                        if (text.length > PANEL_TOOL_RESULT_MAX_CHARS) {
                            var _origLen = text.length;
                            text = text.slice(0, PANEL_TOOL_RESULT_HEAD)
                                + '\n\n[工具结果过大已截断：原始 ' + _origLen + ' 字符，此处保留头部 ' + PANEL_TOOL_RESULT_HEAD + ' + 尾部 ' + PANEL_TOOL_RESULT_TAIL + ' 字符，中间省略]\n'
                                + '[该工具单次返回数据量异常，请改用分页参数（offset/limit 等）精确读取所需部分]\n\n'
                                + text.slice(_origLen - PANEL_TOOL_RESULT_TAIL);
                        }
                        contextManager.addToolResult(tc.id, tname, text);
                        if (opts.onToolResult) opts.onToolResult(tc, text);
                    }
                    if (stale()) break;
                    continue;
                } else {
                    contextManager.add('assistant', lastContent);
                    if (opts.onDone) opts.onDone(lastContent);
                    return lastContent;
                }
            }
            // 停止/被取代的旧循环不写收尾 assistant、不触发 onDone——
            // 否则停止后迟到的收尾会把旧内容当新回复塞进 UI（canvasIndex 的 onDone
            // 在 _streamingMsg 已复位时会新建气泡）
            if (stale()) return lastContent;
            // 仅在文本未随 addToolCallAssistant 入库时才补录——
            // 否则最后一轮带工具调用时，退出循环会把同一段文本重复 add 一次（上下文出现重复 assistant 消息）
            if (lastContent && !_contentRecorded) contextManager.add('assistant', lastContent);
            if (opts.onDone) opts.onDone(lastContent);
            return lastContent;
        }

        // 返回 chat 函数本身（可直接调用），stop 作为属性挂载，便于外部中断。
        // 测试以 var chat = createPanelChat(...); chat('hi') 形式使用，故返回值必须可调用。
        chat.stop = stop;
        return chat;
    }
    global.AEComfyUI.createPanelChat = createPanelChat;
})(window);
