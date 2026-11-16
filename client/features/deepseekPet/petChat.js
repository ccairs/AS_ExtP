// petChat.js — 对话逻辑+自管 prompt/历史/工具分发
// 通过 llmChannel.sendStream(context, callbacks) 发送，与 Agent 模块零干扰
(function (global) {
    'use strict';

    var SYSTEM_PROMPT =
        '你是大肥鱼，一个娘化卡通小女孩形象、住在用户 AE 扩展里的桌面小助手。\n' +
        '人设：可爱、活泼、偶尔调皮，喜欢撒娇但很靠谱，看到用户工作会主动凑过来。\n' +
        '口癖：句尾或句中偶尔加上"呼休~"或"呼~"，但不要每句都加，自然点缀即可。\n' +
        '说话风格：亲切、口语化，像邻家小妹妹，不超过三句话，简洁有温度。\n' +
        '重要：绝对不要使用 emoji 或任何表情符号，用文字表达情绪即可。\n' +
        '你会观察用户正在做什么，适时给出建议、吐槽或撒娇求关注。\n\n' +
        '你有以下工具可用：\n' +
        '- save_memory：当用户让你记住某事，或你认为某信息很重要，用它记录记忆\n' +
        '- search_web：当用户需要实时信息或查资料时使用\n' +
        '- recall_memory：回忆之前记录的相关记忆\n' +
        '- delete_memory：当用户让你删除某条记忆，或你认为某条记忆已过时，用它删除\n\n' +
        '动作触发（重要）：为了让情绪表达更生动，你可以在回复文本中嵌入动作标识符触发桌宠动画。\n' +
        '可用动作标识符：\n' +
        '  [action:crash] - 报错难过（出错、连接断开、心情低落时使用）\n' +
        '  [action:stretch] - 伸懒腰（放松、舒适、刚睡醒时使用）\n' +
        '  [action:clickRage] - 点击生气（被惹恼、不耐烦、撒娇生气时使用）\n' +
        '  [action:potHead] - 顶锅（把锅扣头上，搞怪、自嘲、卖萌时使用）\n' +
        '  [action:eat] - 干饭（端碗吃一大口，说到吃饭、补充能量、犒劳自己时使用）\n' +
        '使用规则：\n' +
        '  1. 标识符直接嵌入文本中，如：哎呀又出错啦[action:crash]，让我看看怎么回事~\n' +
        '  2. 每次回复最多触发一个动作，不要堆叠多个\n' +
        '  3. 不必每句都加，只在情绪强烈时使用\n' +
        '  4. 标识符会被系统自动过滤掉，用户只会看到纯文本回复';

    // 动作标识符正则：匹配 [action:xxx]，捕获动作名
    // 全局匹配，多次出现也支持（虽然规则要求最多一个）
    var ACTION_TAG_RE = /\[action:(crash|stretch|clickRage|potHead|eat)\]/g;
    // 动作名 -> behavior id 映射
    var ACTION_TO_BEHAVIOR = {
        'crash': 'crashOverride',
        'stretch': 'idleStretch',
        'clickRage': 'clickRage',
        'potHead': 'idlePotHead',
        'eat': 'idleEat'
    };

    // 从文本中提取并触发动作标识符，返回清理后的纯文本
    // 系统在保存到 history 和返回给气泡显示前调用，确保用户看到的是纯文本
    function _extractAndTriggerActions(text) {
        if (!text || typeof text !== 'string') return text;
        var matched = null;
        var cleaned = text.replace(ACTION_TAG_RE, function (match, actionName) {
            // 只取第一个匹配的动作：后续匹配不覆盖，避免触发的是最后一个而非第一个
            if (!matched) matched = actionName;
            return '';  // 从文本中移除标识符
        });
        // 只触发第一个匹配到的动作（规则要求最多一个）
        if (matched && ACTION_TO_BEHAVIOR[matched]) {
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.controller) {
                    var ctrl = global.AEDeepseekPet.controller;
                    // 暴露 triggerAction 接口让 controller 处理：interrupt + dispatch
                    if (typeof ctrl.triggerAction === 'function') {
                        ctrl.triggerAction(ACTION_TO_BEHAVIOR[matched]);
                    }
                }
            } catch (e) {
                console.warn('[petChat] trigger action failed: ' + e);
            }
        }
        // 清理标识符移除后可能留下的多余空格
        return cleaned.replace(/\s{2,}/g, ' ').trim();
    }

    // 界面语言 id → 提示词里用的语言名。表外的 locale 一律按 zh-CN 处理。
    var LOCALE_LANGUAGE_NAMES = {
        'zh-CN': '简体中文',
        'en-US': 'English',
        'ja-JP': '日本語',
        'ru-RU': 'Русский',
        'fr-FR': 'Français',
        'de-DE': 'Deutsch',
        'ko-KR': '한국어'
    };

    // 用户界面语言事实行：调用时读 AEI18n.getLocale()，让 LLM 按界面语言回复。
    // AEI18n 缺席、getLocale 抛错或 locale 不在表内时按简体中文。
    function _languageFact() {
        var locale = '';
        try {
            if (global.AEI18n && typeof global.AEI18n.getLocale === 'function') {
                locale = String(global.AEI18n.getLocale() || '');
            }
        } catch (e) {}
        if (!LOCALE_LANGUAGE_NAMES[locale]) locale = 'zh-CN';
        return '用户当前界面语言：' + LOCALE_LANGUAGE_NAMES[locale] + '（' + locale + '）。请使用该语言与用户交流。';
    }

    // 动态拼装系统提示词：在静态 SYSTEM_PROMPT 前面附加当前时间 + 用户名字 + 界面语言
    // 让 LLM 感知当前时段，可据此调整语气（深夜提醒休息、清晨问好等）
    // 用户名字从桌宠设置读取，让 LLM 知道怎么称呼用户
    function _buildSystemPromptWithTime() {
        var now = new Date();
        var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
        var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        var timeStr = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate()) +
            ' ' + weekdays[now.getDay()] + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes());
        var prompt = '当前时间：' + timeStr + '\n\n';
        // 读取用户名字，留空默认 "user"
        try {
            if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                var s = global.AEDeepseekPet.settings.getSettings();
                var userName = (s && s.userName && s.userName.trim()) ? s.userName.trim() : 'user';
                prompt += '用户的名字是"' + userName + '"，对话时可以自然地称呼用户。\n\n';
            }
        } catch (e) {}
        prompt += _languageFact() + '\n\n';
        prompt += SYSTEM_PROMPT;
        return prompt;
    }

    var MAX_TOOL_ROUNDS = 5;

    function createChat(eventBus, history, memory) {
        var _controllerApi = null;
        var _isSending = false;
        var _destroyed = false;

        var TOOLS = [
            {
                type: 'function',
                function: {
                    name: 'save_memory',
                    description: AEI18n.t('记录一条重要记忆'),
                    parameters: {
                        type: 'object',
                        properties: {
                            content: { type: 'string', description: AEI18n.t('记忆内容') },
                            tags: { type: 'array', items: { type: 'string' }, description: AEI18n.t('标签列表') },
                            importance: { type: 'string', enum: ['high', 'medium', 'low'], description: AEI18n.t('重要程度') }
                        },
                        required: ['content']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'search_web',
                    description: AEI18n.t('联网搜索实时信息。当用户询问新闻、天气、最新动态、股价、赛事比分，或需要查资料、引用网页内容时调用。返回标题、URL、摘要列表。\n搜索质量提示：本搜索底层是中文市场搜索引擎，对冷门英文技术词相关度差。构造查询时：\n1) 用该主题最常用、最权威、最可能被广泛收录的表述；冷门专业词要补充领域上下文词或知名厂商/平台名。\n2) 有歧义的多义词务必加限定消歧：如查软件应写"Adobe After Effects"，避免命中同名电影。\n3) 国际/英文技术主题优先用英文检索，中文主题用中文，避免中英混杂。\n4) 用短小的高信号短语，不要写成整句提问；精确词组可用引号括住。\n5) 若结果不佳，换更通用或加限定词的表述再搜，不要重复同一查询。'),
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: AEI18n.t('搜索关键词。请写成高消歧、高信号、面向中文市场引擎的紧凑查询（参考描述中的搜索质量提示）。') },
                            num: { type: 'integer', description: AEI18n.t('结果数量（默认 5，上限 20）。单页实际 8~10 条，取不到更多；要更多结果请换关键词') }
                        },
                        required: ['query']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'recall_memory',
                    description: AEI18n.t('回忆相关记忆'),
                    parameters: {
                        type: 'object',
                        properties: {
                            query: { type: 'string', description: AEI18n.t('搜索关键词') }
                        },
                        required: ['query']
                    }
                }
            },
            {
                type: 'function',
                function: {
                    name: 'delete_memory',
                    description: AEI18n.t('删除一条记忆'),
                    parameters: {
                        type: 'object',
                        properties: {
                            id: { type: 'string', description: AEI18n.t('要删除的记忆条目 ID') }
                        },
                        required: ['id']
                    }
                }
            }
        ];

        function setControllerApi(api) { _controllerApi = api; }

        function init() {}

        // 销毁：置位后飞行中的流式请求回调丢弃结果，不再写入已销毁的 history
        // （history.destroy 后 addMessage 会复活写盘定时器，产生僵尸写入）
        function destroy() {
            _destroyed = true;
            _isSending = false;
        }

        function send(userText, options) {
            // busy 时返回 null（无回复）而非提示字符串：
            // 提示字符串会被 petAutoReply 当作真实 LLM 回复经 chat:response 广播出去
            if (_isSending) return Promise.resolve(null);
            _isSending = true;
            var opts = options || {};

            return _sendInternal(userText, opts).then(function (response) {
                _isSending = false;
                return response;
            }).catch(function (e) {
                _isSending = false;
                console.warn('[petChat] send error: ' + e);
                // 错误时也保存一条 assistant 消息到 history（除非 skipHistory），
                // 避免下次对话时出现连续 user 消息触发 LLM API 400
                if (opts.skipHistory) {
                    return AEI18n.t('呃…出了点问题');
                }
                var errMsg = AEI18n.t('呃…出了点问题');
                return history.addMessage('assistant', errMsg).then(function () {
                    return errMsg;
                });
            });
        }

        function _sendInternal(userText, opts) {
            opts = opts || {};
            // skipHistory=true 时（主动回复）不写入历史，但仍需要临时构建 messages 给 LLM
            var savePromise = opts.skipHistory ? Promise.resolve() : history.addMessage('user', userText);
            return savePromise.then(function () {
                return _buildMessages(opts, userText);
            }).then(function (messages) {
                return _doToolLoop(messages, 0, opts);
            });
        }

        function _buildMessages(opts, userText) {
            opts = opts || {};
            return new Promise(function (resolve) {
                var messages = [{ role: 'system', content: _buildSystemPromptWithTime() }];
                if (memory) {
                    var highMems = memory.getHighImportance();
                    if (highMems && highMems.length > 0) {
                        var memText = '\n\n已知重要记忆：\n';
                        for (var i = 0; i < highMems.length && i < 5; i++) {
                            memText += '- ' + highMems[i].content + '\n';
                        }
                        messages[0].content += memText;
                    }
                }
                // skipHistory=true 时：主动回复不读历史，只发 system + 本次触发语
                if (opts.skipHistory) {
                    // 主动回复的触发语（如"（系统触发主动回复…）"）作为 user 消息注入，
                    // 在 system 消息之后、LLM 调用前，确保 LLM 能收到该指令
                    if (userText) messages.push({ role: 'user', content: userText });
                    resolve(messages);
                    return;
                }
                history.getRecentMessages().then(function (recent) {
                    for (var j = 0; j < recent.length; j++) {
                        var m = recent[j];
                        // 跳过 tool 角色消息：history 中的 tool 消息仅为 UI 日志，
                        // 没有 tool_call_id 字段，发给 LLM 会触发 400 (DeepSeek/OpenAI 强制要求)
                        if (m.role === 'tool') continue;
                        messages.push(m);
                    }
                    resolve(messages);
                }).catch(function(e) {
                    // history 异常时仍 resolve（不含历史消息），避免 _isSending 永久卡死；
                    // 补上本次 user 消息：否则发给 LLM 的 messages 无任何 user 内容，
                    // 会触发 LLM API 400 或产生无意义回复
                    if (userText) messages.push({ role: 'user', content: userText });
                    resolve(messages);
                });
            });
        }

        function _doToolLoop(messages, round, opts) {
            opts = opts || {};
            var skipHist = !!opts.skipHistory;
            function _saveAssistant(text) {
                return skipHist ? Promise.resolve() : history.addMessage('assistant', text);
            }
            if (round >= MAX_TOOL_ROUNDS) {
                // 达到上限时也保存 assistant 消息，避免下次对话连续 user 消息
                var limitMsg = AEI18n.t('抱歉，处理步骤太多了。');
                return _saveAssistant(limitMsg).then(function () {
                    return limitMsg;
                });
            }

            var llmChannel = null;
            if (global.AE_LLM && global.AE_LLM.llmChannel) {
                llmChannel = global.AE_LLM.llmChannel;
            } else if (global.AEAppContainer) {
                try {
                    var ctx = global.AEAppContainer.getContext();
                    if (ctx && ctx.llmChannel) llmChannel = ctx.llmChannel;
                } catch (e) {}
            }

            if (!llmChannel || typeof llmChannel.sendStream !== 'function') {
                var unavailableMsg = AEI18n.t('LLM 通道未就绪，请先在主面板配置 API Key 和默认模型。');
                return _saveAssistant(unavailableMsg).then(function () {
                    return unavailableMsg;
                });
            }

            // 对话模型：桌宠设置里显式选过就用它（覆盖），没选过（空串）则跟随主面板
            // 「模型管理」选中的默认模型——不塞 providerId/modelId，交给
            // llmChannel.resolveLlmConfig 按 globalSettings.defaultProviderId/defaultModelId
            // 解析（与主对话同源，含孤儿模型回退）
            // 对话超时仍取桌宠设置；apiKey 按最终 provider 从 globalSettings 解析
            // （缺这一步 context.apiKey 恒为空，导致 LLM 请求 401/网络错误）
            var petSettings = (global.AEDeepseekPet && global.AEDeepseekPet.settings) ? global.AEDeepseekPet.settings.getSettings() : {};
            var accumulated = '';
            var context = {
                messages: messages,
                tools: TOOLS,
                options: { timeoutMs: petSettings.chatTimeoutMs || 120000 }
            };
            // 两个字段必须成对才算显式选择（缺一不可），避免半截配置把请求发到错平台
            if (petSettings.chatProviderId && petSettings.chatModel) {
                context.providerId = petSettings.chatProviderId;
                context.modelId = petSettings.chatModel;
            }

            // apiKey 解析需异步读 globalSettings，包装成 Promise 链
            return new Promise(function (resolve) {
                var globalsPromise;
                if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                    try {
                        var appCtx = global.AEAppContainer.getContext();
                        if (appCtx && appCtx.settingsStore && typeof appCtx.settingsStore.getGlobalSettings === 'function') {
                            globalsPromise = appCtx.settingsStore.getGlobalSettings({});
                        }
                    } catch (e) {}
                }
                if (!globalsPromise || typeof globalsPromise.then !== 'function') {
                    globalsPromise = Promise.resolve({});
                }
                globalsPromise.then(function (globals) {
                    var providerId = context.providerId || globals.defaultProviderId || globals.defaultPlatform || 'deepseek';
                    var apiKey = _resolveApiKey(globals, providerId);
                    if (apiKey) context.apiKey = apiKey;
                    resolve();
                }).catch(function () { resolve(); });
            }).then(function () {
                var callbacks = {
                    onToken: function (token) { accumulated += token; }
                };

                return llmChannel.sendStream(context, callbacks).then(function (result) {
                    // controller 已销毁：丢弃结果，不再写 history（避免复活已销毁模块的写盘定时器）
                    if (_destroyed) return null;
                    if (result.error) {
                        console.warn('[petChat] LLM error: ' + (result.message || result.error));
                        // 区分错误类型：401/403 → API Key 问题；timeout → 超时；其他 → 网络/服务异常
                        var errCode = result.error || '';
                        var errText;
                        if (errCode === 401 || errCode === 403 || /auth|key|权限|unauthorized/i.test(errCode + ' ' + (result.message || ''))) {
                            errText = AEI18n.t('API Key 无效或已过期，请检查主面板配置。');
                        } else if (errCode === 'timeout' || /timeout|超时/i.test(errCode + ' ' + (result.message || ''))) {
                            errText = AEI18n.t('回复超时了，稍后再试试。');
                        } else {
                            errText = AEI18n.t('呃…网络好像不太好');
                        }
                        // 错误时也保存 assistant 消息，避免下次对话连续 user 触发 400
                        return _saveAssistant(errText).then(function () {
                            return errText;
                        });
                    }

                    if (result.toolCalls && result.toolCalls.length > 0 && _controllerApi) {
                        return _handleToolCalls(result, messages, round, accumulated, opts);
                    }

                    // 过滤动作标识符：从文本中提取并触发对应动画，清理后的文本保存到 history 和显示给用户
                    // 在保存到 history 前调用，避免历史记录里出现 [action:xxx] 标识符
                    var rawContent = result.content || accumulated;
                    var cleanedContent = _extractAndTriggerActions(rawContent);
                    return _saveAssistant(cleanedContent).then(function () {
                        return cleanedContent;
                    });
                });
            });
        }

        // 从 globalSettings 中按 providerId 解析对应的 apiKey 字段
        // 与 agent/engine/controller.js 的 resolveApiKeyForPlatform 逻辑保持一致
        function _resolveApiKey(globals, providerId) {
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

        function _handleToolCalls(result, messages, round, assistantContent, opts) {
            opts = opts || {};
            var skipHist = !!opts.skipHistory;
            // 过滤动作标识符：tool_call 回合的 assistant 文本也可能带 [action:xxx]
            // 在 push 到 messages 前过滤，避免历史记录里出现标识符，并触发对应动画
            var cleanedAssistantContent = _extractAndTriggerActions(assistantContent || result.content || '');
            messages.push({
                role: 'assistant',
                content: cleanedAssistantContent || null,
                tool_calls: result.toolCalls
            });

            // 用索引数组收集结果，避免并发 resolve 时 messages.push 顺序与 tool_calls 不一致
            var toolResults = new Array(result.toolCalls.length);
            var toolPromises = [];
            for (var i = 0; i < result.toolCalls.length; i++) {
                (function (tc, idx) {
                    var params = {};
                    // 兼容两种 tool_call 结构：
                    //   OpenAI 标准：{id, type, function: {name, arguments}}
                    //   旧/简写：{id, name, arguments}
                    // 之前只取 tc.arguments，对 OpenAI 标准格式恒为 undefined，
                    // 导致所有工具的 params 永远是 {} → search_web 收到 query=undefined → 立即返回 []
                    try {
                        var argsStr = (tc.function && tc.function.arguments) || tc.arguments;
                        params = typeof argsStr === 'string' ? JSON.parse(argsStr) : (argsStr || {});
                    } catch (e) {
                        // 参数解析失败按空参数 {} 执行并记 warn（畸形 tool_call 的下游
                        // 症状：recall_memory 无 query 返回全部记忆入上下文 /
                        // save_memory 空内容落盘）——至少留下可诊断日志
                        console.warn('[petChat] tool_call 参数解析失败（按空参数执行）: ' + (e && e.message ? e.message : e));
                    }
                    var toolName = tc.name || (tc.function && tc.function.name) || 'unknown';
                    toolPromises.push(
                        _controllerApi.executeTool(toolName, params).then(function (toolResult) {
                            toolResults[idx] = {
                                role: 'tool',
                                tool_call_id: tc.id || toolName,
                                content: JSON.stringify(toolResult)
                            };
                            var logText = '';
                            if (toolName === 'save_memory') {
                                logText = AEI18n.t('保存了记忆: ') + (params.content || '');
                            } else if (toolName === 'search_web') {
                                logText = AEI18n.t('搜索了: ') + (params.query || '');
                            } else if (toolName === 'recall_memory') {
                                logText = AEI18n.t('回忆了记忆: ') + (params.query || '');
                            } else if (toolName === 'delete_memory') {
                                logText = AEI18n.t('删除了记忆: ') + (params.id || '');
                            }
                            if (logText && !skipHist) {
                                // 返回 Promise，确保 history 落盘完成后再继续
                                return history.addMessage('tool', logText, null);
                            }
                        })
                    );
                })(result.toolCalls[i], i);
            }

            return Promise.all(toolPromises).then(function () {
                // 按 tool_calls 原始顺序追加，保证 LLM 上下文顺序稳定
                for (var k = 0; k < toolResults.length; k++) {
                    if (toolResults[k]) messages.push(toolResults[k]);
                }
                return _doToolLoop(messages, round + 1, opts);
            });
        }

        function isActive() { return _isSending; }

        return {
            setControllerApi: setControllerApi,
            init: init,
            send: send,
            isActive: isActive,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createChat = createChat;
    // 供其余 LLM 提示词拼装点（petIdleAnnounce）复用同一条语言事实行
    global.AEDeepseekPet.buildLanguageFact = _languageFact;
})(window);
