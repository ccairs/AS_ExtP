(function(global) {

    /**
     * MCP 工具 shortDescription 自动生成器。
     * 通过 llmChannel.sendJson 调用轻量 LLM，批量生成工具的简短中文描述。
     * 不依赖 agent 模块，无工具调用，纯文本生成。
     */
    function createShortDescGenerator() {

        // 从 globalSettings 中按 providerId 解析对应的 apiKey 字段
        // 与 petChat.js / agent/engine/controller.js 的 resolveApiKeyForPlatform 逻辑保持一致
        function _resolveApiKey(globals, providerId) {
            if (!providerId || !globals) return '';
            var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
            var apiKeyField = null;
            if (registry && typeof registry.getApiKeyField === 'function') {
                try { apiKeyField = registry.getApiKeyField(providerId); } catch (e) {}
            }
            if (!apiKeyField || providerId === 'siliconflow') {
                return String(globals.apiKey || globals.siliconflowApiKey || '').trim();
            }
            return String(globals[apiKeyField] || globals.apiKey || '').trim();
        }

        // 异步读取全局设置，失败时返回空对象，保证不阻塞生成流程
        function _readGlobalSettings() {
            return new Promise(function (resolve) {
                if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                    try {
                        var appCtx = global.AEAppContainer.getContext();
                        if (appCtx && appCtx.settingsStore && typeof appCtx.settingsStore.getGlobalSettings === 'function') {
                            appCtx.settingsStore.getGlobalSettings({}).then(resolve).catch(function () { resolve({}); });
                            return;
                        }
                    } catch (e) {}
                }
                resolve({});
            });
        }

        /**
         * 批量生成工具的 shortDescription。
         * @param {Array} tools - 工具列表 [{ name, description }, ...]
         * @returns {Promise<Object>} - { toolName: shortDesc, ... }，失败时 reject
         */
        async function generate(tools) {
            if (!tools || tools.length === 0) return {};

            var llmChannel = global.AE_LLM && global.AE_LLM.llmChannel;
            if (!llmChannel || typeof llmChannel.sendJson !== 'function') {
                throw new Error('LLM 通道不可用');
            }

            // 构造工具清单文本
            var toolListText = '';
            for (var i = 0; i < tools.length; i++) {
                var t = tools[i];
                var desc = (t.description || '').substring(0, 200);
                toolListText += (i + 1) + '. ' + t.name + ': ' + desc + '\n';
            }

            // jsonMode 且模型声明支持 JSON 模式时，llmChannel 会带 response_format:
            // {type:'json_object'}，要求响应根节点是单个 JSON 对象——数组会被平台拒绝
            // 或被模型改写成对象。提示词与解析统一按 {"tools":[...]} 对象契约；
            // 未强制 JSON 模式的平台返回顶层数组时同样接受。
            var systemPrompt = '你是 MCP 工具描述生成助手。根据工具名称和完整描述，为每个工具生成简短的中文描述（不超过30字），说明工具的核心功能。只返回一个 JSON 对象，不要输出其他内容。';

            var userPrompt = '请为以下 MCP 工具生成简短描述：\n\n' + toolListText + '\n返回格式（JSON 对象，tools 为数组）：\n{"tools":[{"name":"工具名","short":"简短描述"},...]}';

            var context = {
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ],
                jsonMode: true,
                options: { timeoutMs: 60000 }
            };

            // 解析 API Key：sendJson 内部 resolveLlmConfig 只解析 provider/model，
            // 不会自动取 apiKey，必须在此显式注入，否则 Authorization header 为空 → 401
            var globals = await _readGlobalSettings();
            var providerId = context.providerId
                || globals.defaultProviderId
                || globals.defaultPlatform
                || 'deepseek';
            var apiKey = _resolveApiKey(globals, providerId);
            if (apiKey) context.apiKey = apiKey;
            if (globals.defaultProviderId) context.providerId = globals.defaultProviderId;
            if (globals.defaultModelId) context.modelId = globals.defaultModelId;

            var result = await llmChannel.sendJson(context);

            if (result.error) {
                throw new Error(result.message || result.error);
            }

            var content = result.content || '';
            if (!content) {
                throw new Error('LLM 返回为空');
            }

            // 解析 JSON 文本（json_object 契约对象或兼容的顶层数组）
            var parsed;
            try {
                // 兼容模型可能返回的 ```json 包裹
                var jsonStr = content.trim();
                if (jsonStr.startsWith('```')) {
                    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
                }
                parsed = JSON.parse(jsonStr);
            } catch (e) {
                throw new Error('LLM 返回的 JSON 解析失败: ' + e.message);
            }

            // 工具描述列表三种形态：json_object 契约 {"tools":[...]}、模型只回一条时的
            // 单个 {name,short}、未强制 JSON 模式平台的顶层数组。
            var items = null;
            if (Array.isArray(parsed)) items = parsed;
            else if (parsed && Array.isArray(parsed.tools)) items = parsed.tools;
            else if (parsed && parsed.name && typeof parsed.short === 'string' && parsed.short) items = [parsed];
            if (!items) {
                throw new Error('LLM 返回的 JSON 不含工具描述列表');
            }
            // 空列表按失败交回调用方：needGen 非空时没有任何条目可落缓存，
            // 按成功返回会让上层记「已生成」但工具描述仍缺
            if (items.length === 0) {
                throw new Error('LLM 返回的工具描述列表为空');
            }

            // 转换为 { toolName: shortDesc } 映射。
            // LLM 回显的 name 可能带 mcp_ 前缀（与注册名混淆）或是纯幻觉错名。
            // 按请求的工具原始名对齐：原名或「mcp_+原名」能对上的以原始名落 key，
            // 对不上的纯幻觉键直接丢弃——否则幻觉键写入缓存后工具本体仍无描述，
            // 下次重连 needGen 判定再次命中，每次重连重复调用 LLM 烧 token
            var nameLookup = {};
            for (var k = 0; k < tools.length; k++) {
                var reqToolName = tools[k].name;
                if (!reqToolName) continue;
                nameLookup[reqToolName] = reqToolName;
                if (reqToolName.indexOf('mcp_') !== 0) nameLookup['mcp_' + reqToolName] = reqToolName;
            }
            var mapping = {};
            for (var j = 0; j < items.length; j++) {
                var item = items[j];
                // short 只收字符串：字符串化对象会写出 "[object Object]" 并被当成工具描述
                if (item && item.name && typeof item.short === 'string' && item.short) {
                    var origName = nameLookup[String(item.name)];
                    if (origName) mapping[origName] = item.short.substring(0, 60);
                }
            }
            // 一条都对不上（条目形态不合法 / 名称全是幻觉）时按失败交回：
            // 空映射按成功返回会让上层记「已生成」但没有任何描述落缓存
            if (Object.keys(mapping).length === 0) {
                throw new Error('LLM 返回的工具描述无有效条目');
            }

            return mapping;
        }

        return {
            generate: generate
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createShortDescGenerator = createShortDescGenerator;

})(window);
