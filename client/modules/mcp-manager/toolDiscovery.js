(function(global) {

    function createToolDiscovery(config) {
        config = config || {};
        var protocol = config.protocol || null;
        var communicationProvider = config.communicationProvider || null;
        var toolRegistry = config.toolRegistry || null;
        var _disabledToolNames = config.disabledTools || [];
        // 长调用转后台：面板内调用超过 waitMs 未返回时不再报错——
        // 登记任务、回执 taskId，MCP 响应继续在后台等，结果到达后由 serverManager 注入
        // 对话（injectSystemResult + 既有后台结果唤起）。契约（由 serverManager 提供）：
        //   { waitMs, hardMs, beginTask(info)->taskId, settleTask(taskId, errText, text),
        //     getSessionId()->string }
        // 缺省 null：不转后台，90s 超时报错。两条不转后台的边界：
        //   ① 外接调用（ctx.callerId 非空）——外接通道自带 ext_progress 心跳续期，
        //      且转后台会把结果错投进面板对话；
        //   ② 非 Agent 轮次（ctx.moduleId 不在 agent/script/shader）——后台结果的
        //      消费方（injectSystemResult + 后台结果唤起）只存在于 Agent 会话，
        //      其他调用方（ComfyUI 画布助手 moduleId='comfyui'、工具测试按钮等）
        //      转后台只会拿到一张回执、结果投进 Agent 会话，不如保持旧的同步报错
        var longCall = config.longCall || null;
        var LONG_CALL_MODULES = { agent: true, script: true, shader: true };

        // 同 server 的 tools/list 请求序号（按 serverId 递增）：并发请求（onConnected
        // 与面板保存触发的 notifyToolsChanged 等）在 HTTP/SSE 并发 POST 下响应可能
        // 乱序到达，后发先至时，较旧请求的迟到响应会把注册表回退到旧快照（scope/
        // descs/stubs 是发请求时的闭包捕获值，用户刚保存的短描述/Stub 会被回滚）。
        // 响应到达时序号已非最新 → 丢弃（不注销不注册不回调），注册表始终反映
        // 最新一次请求的快照。
        var _fetchSeq = Object.create(null);

        // 本 server 最近一次 registerTools 的注册失败明细（sanitize 后
        // 仍失败的残余场景，如保留名/超长截断后仍非法），供面板展示——若仅
        // console.warn 静默吞掉，用户看到「已连接」但工具不可用零提示。
        // 扩展：tools/list 拉取失败（整批未注册）也写入同一明细通道，条目带
        // phase='fetch' + 错误消息 + 发生时间——否则拉取失败的 server 工具数恒 0，
        // UI 无法区分"服务器本来没工具"与"拉取失败"
        var _lastRegisterErrors = Object.create(null);
        // serverId → { 注册名: 原始名 } 映射。短描述/Stub 缓存键改用
        // 原始名（稳定标识，不随同名冲突改名漂移），面板编辑渲染/保存需据此取回
        // 原始名；注册表 entry 无原始名字段（toolRegistry 字段白名单），由此表承载
        var _originalNames = Object.create(null);

        // tools/list 拉取失败明细落表（整表覆盖：明细只反映最近一次拉取结果，
        // 后续成功注册时 registerTools 会重置整表把失败清掉）。面板经
        // getLastRegisterErrors 读取，在 Server 列表（重启/重试按钮旁）、工具 tab
        // 空态、编辑弹窗展示，不改变连接状态机（仍为 connected）
        function recordFetchError(serverId, message) {
            _lastRegisterErrors[serverId] = [{
                phase: 'fetch',
                name: '',
                regName: '',
                error: message,
                time: Date.now()
            }];
        }

        function fetchAndRegister(serverId, scope, toolDescriptions, toolStubs, callback) {
            if (!communicationProvider || typeof communicationProvider.send !== 'function') {
                recordFetchError(serverId, 'tools/list 请求失败: 无可用通信通道');
                if (callback) callback(new Error('No communication provider available'));
                return;
            }
            if (!protocol || typeof protocol.createRequest !== 'function') {
                recordFetchError(serverId, 'tools/list 请求失败: 无可用协议实现');
                if (callback) callback(new Error('No protocol available'));
                return;
            }

            var toolsReq = protocol.createRequest('tools/list', {});
            var mySeq = (_fetchSeq[serverId] || 0) + 1;
            _fetchSeq[serverId] = mySeq;

            communicationProvider.send(serverId, JSON.stringify(toolsReq), function(err, rawResp) {
                if (err) {
                    // 迟到请求的失败不落表：更新的请求已发出/已注册，旧请求失败不代表
                    // 当前状态（与下方迟到响应丢弃同口径）
                    if ((_fetchSeq[serverId] || 0) === mySeq) {
                        recordFetchError(serverId, 'tools/list 请求失败: ' + (err.message || String(err)));
                    }
                    if (callback) callback(err);
                    return;
                }
                // 迟到响应丢弃：本请求发出后又有更新的 tools/list 在途/已注册，
                // 旧快照不得回写注册表（见 _fetchSeq 注释）
                if ((_fetchSeq[serverId] || 0) !== mySeq) return;
                try {
                    var resp = JSON.parse(rawResp);
                    if (!protocol.isSuccess(resp)) {
                        var errorMsg = resp.error ? (resp.error.message || 'Unknown error') : 'Invalid response';
                        recordFetchError(serverId, 'tools/list 失败: ' + errorMsg);
                        if (callback) callback(new Error('tools/list failed: ' + errorMsg));
                        return;
                    }
                    var tools = Array.isArray(resp.result.tools) ? resp.result.tools : [];
                    // 注册前先清理本 server 已注册的全部工具（unregisterByServer
                    // 按 serverId 精确匹配，不碰其他 server 的工具）。HTTP/SSE 并发
                    // POST 响应乱序时，迟到的响应 register 时 hasTool('mcp_foo') 为真，
                    // 会以 mcp_foo_2 改名注册残留幽灵工具；先清空再按最新响应注册，
                    // 注册表始终反映该 server 最近一次 tools/list 快照
                    unregisterByServer(serverId);
                    registerTools(serverId, tools, scope, toolDescriptions, toolStubs);
                    if (callback) callback(null, tools);
                } catch (e) {
                    recordFetchError(serverId, 'tools/list 响应解析失败: ' + e.message);
                    if (callback) callback(new Error('Failed to parse tools/list response: ' + e.message));
                }
            });
        }

        function callTool(serverId, toolName, args, callback, opts) {
            if (!communicationProvider || typeof communicationProvider.send !== 'function') {
                callback(new Error('No communication provider available'));
                return;
            }
            if (!protocol || typeof protocol.createRequest !== 'function') {
                callback(new Error('No protocol available'));
                return;
            }

            var callReq = protocol.createRequest('tools/call', {
                name: toolName,
                arguments: args || {}
            });

            // opts 透传给 send（timeoutMs：长调用模式把 90s 推后到硬上限，
            // 否则超时回调会先清理 pending，迟到响应被当"未知 id"丢弃）
            communicationProvider.send(serverId, JSON.stringify(callReq), function(err, rawResp) {
                if (err) {
                    callback(err);
                    return;
                }
                try {
                    var resp = JSON.parse(rawResp);
                    if (!protocol.isSuccess(resp)) {
                        var errorMsg = resp.error ? (resp.error.message || 'Unknown error') : 'Invalid response';
                        callback(new Error('tools/call failed: ' + errorMsg));
                        return;
                    }
                    var result = resp.result || {};
                    callback(null, result);
                } catch (e) {
                    callback(new Error('Failed to parse tools/call response: ' + e.message));
                }
            }, opts);
        }

        function registerTools(serverId, tools, scopeOverride, toolDescriptions, toolStubs) {
            if (!toolRegistry) return;
            var descMap = toolDescriptions || {};
            var stubMap = toolStubs || {};
            // 每轮注册前重置失败明细（与 unregisterByServer → registerTools
            // 的整批刷新语义对齐，明细只反映最近一次快照）
            _lastRegisterErrors[serverId] = [];
            // 注册名 → 原始名映射按当前轮快照整体重建
            _originalNames[serverId] = Object.create(null);

            // agent 模块作用域可按模式(agentModes)收窄：存在时仅展开所选模式；
            // 未指定 agentModes（全部模式）时展开为 agent/script/shader 三个 moduleId，
            // 与 toolRegistry 的 moduleIds 数组作用域机制对齐。
            var finalScope = scopeOverride || { type: 'global' };
            if (finalScope && finalScope.type === 'module') {
                var smods = finalScope.moduleIds || (finalScope.moduleId ? [finalScope.moduleId] : []);
                var expanded = [];
                for (var mi = 0; mi < smods.length; mi++) {
                    var sm = smods[mi];
                    if (sm === 'agent') {
                        var smodes = finalScope.agentModes || (finalScope.mode ? [finalScope.mode] : []);
                        if (smodes.length) {
                            for (var mj = 0; mj < smodes.length; mj++) expanded.push(smodes[mj]);
                        } else {
                            expanded.push('agent', 'script', 'shader');
                        }
                    } else {
                        expanded.push(sm);
                    }
                }
                // 外接通道口径：展开结果固定补 'external-mcp'（去重、
                // 追加在末尾）。原因：extTools 的单点闸门对 module 作用域要求 moduleIds
                // 显式含 'external-mcp' 才对外投影/执行；MCP 服务器的范围选择器描述的是
                // **内部模式可见性**，外接通道的可见性由外接管理台的 per-server / 分组开关
                // （及逐工具「外接」勾选）管理——内部可见性收窄不得连带把该服务器的工具
                // 挤出外接投影（不补此项时用户把服务器限定到
                // agent/script/shader 就会静默关掉其外接通道）。
                // 选择器的 Agent 模式列表含「外接模式」（写 agentModes:
                // ['external-mcp']，展开即本行的 external-mcp），用户可显式限定成「仅外接」；
                // 补项保持不变——外接侧的反向排除（不让某台服务器对外可见）仍走外接管理台
                // 的服务器开关，不由这里的缺项表达。
                if (expanded.indexOf('external-mcp') < 0) expanded.push('external-mcp');
                finalScope = { type: 'module', moduleIds: expanded };
                if (scopeOverride && scopeOverride.agentModes) finalScope.agentModes = scopeOverride.agentModes.slice();
            }

            for (var i = 0; i < tools.length; i++) {
                var tool = tools[i];
                if (!tool || !tool.name) continue;

                var serverRef = serverId;
                // 来源标识：MCP 工具统一加 'mcp_' 前缀，让 LLM 从工具名即可识别来源。
                // 仅未加前缀时添加，避免 server 工具名本身已带 mcp_ 时产生重复前缀。
                var regName = tool.name;
                if (regName.indexOf('mcp_') !== 0) {
                    regName = 'mcp_' + regName;
                }
                // 注册名 sanitize——kebab-case 等社区命名（my-tool）直接注册
                // 会被 toolRegistry.validateToolId（[a-zA-Z_][a-zA-Z0-9_]*）拒绝且仅
                // console.warn 静默吞掉，用户看到「已连接」但工具不可用零提示。非法字符
                // 统一替换为 '_'；handler 仍以 server 原始名（tool.name）调用不受影响
                regName = regName.replace(/[^a-zA-Z0-9_]/g, '_');
                // 同名冲突去重：多个 server 可能暴露同名工具，直接 register 会互相覆盖；
                // unregisterByServer 按 serverId 精确清理，前提是各 server 的工具名互不冲突。
                // 仅当注册名已被占用（本 server 或其他 server/内置工具）时才追加序号改名，
                // 不冲突时保持带前缀的名字。
                if (toolRegistry.hasTool(regName)) {
                    var n = 2;
                    while (n < 1000 && toolRegistry.hasTool(regName + '_' + n)) n++;
                    regName = regName + '_' + n;
                }
                // 记录注册名 → 原始名映射。短描述/Stub 缓存键以原始名为
                // 稳定标识——同名冲突导致的注册名漂移（mcp_foo → mcp_foo_2 → mcp_foo）
                // 不再让面板保存的用户配置失联；注册表 entry 无原始名字段，由此表承载
                _originalNames[serverId][regName] = tool.name;
                // disabled 名单按原始名与改名后名都匹配（面板禁用可能存的是任一名字）
                var isDisabled = _disabledToolNames.indexOf(tool.name) !== -1 || _disabledToolNames.indexOf(regName) !== -1;
                // MCP 工具走 stub 模式：LLM 只看到 shortDescription + 空 schema，省 token。
                // 调用前必须先 tool_search 获取完整参数定义（stub 闸门拦截未 search 的调用）。
                // shortDescription 为空时由 getLlmToolStubs 回退到 description 截断 60 字符，LLM 不会失明。
                // stub 状态由 per-tool 缓存控制（默认 stub=true），用户可在编辑面板逐工具切换。
                // 短描述缓存可能存原始名（自动生成落 key）或带 mcp_ 前缀的注册名（编辑面板保存落 key）。
                // 注册名优先：面板手动编辑的值须覆盖同工具原始名下的旧自动生成缓存，否则有序
                // 查找会让手动描述被永久遮蔽；注册名键不存在时回退原始名（兼容存量自动生成数据）。
                var shortDesc = descMap[regName] || descMap[tool.name] || '';
                var isStub = !(stubMap[tool.name] === false || stubMap[regName] === false); // 默认 stub=true，仅显式 false 时关闭
                var regResult = toolRegistry.register({
                    name: regName,
                    description: tool.description || '',
                    shortDescription: shortDesc,
                    input_schema: tool.inputSchema || { type: 'object', properties: {} },
                    handler: createToolHandler(serverRef, tool.name),
                    scope: finalScope,
                    serverId: serverRef,
                    category: 'mcp-server',
                    source: 'mcp',
                    stub: isStub,
                    enabled: !isDisabled
                });
                // 注册失败（sanitize 后仍失败的残余场景：保留名/空名等）不能静默吞掉：
                // 记入 _lastRegisterErrors 供面板展示「已连接但以下工具不可用」明细，
                // 用户不再面对零提示的静默失联
                if (regResult && regResult.ok === false) {
                    console.warn('[MCP] 工具注册失败: "' + tool.name + '" -> ' + regName +
                        ' err=' + (regResult.error || ''));
                    // 失败明细落表（面板经 serverManager.getLastRegisterErrors 读取展示）
                    _lastRegisterErrors[serverId].push({
                        name: tool.name,
                        regName: regName,
                        error: regResult.error || 'unknown'
                    });
                }
            }
        }

        function unregisterByServer(serverId) {
            // 失败明细归属该 server 的**当前连接**——服务器被停止/
            // 删除/崩溃收口（onStopping → 本函数）后明细随之失效，不清则 Server
            // 列表徽标、工具 tab 空态、编辑弹窗对已停止的服务器长期显示
            // 「工具列表拉取失败（时间…）」，用户以为还需重试。清空须先于
            // registry 守卫：明细与 registry 是否可用无关（fetch 失败在无
            // registry 时也会落表）。重注册路径（fetchAndRegister /
            // notifyToolsChanged 先调本函数）随后由 registerTools 重建明细，不受影响
            delete _lastRegisterErrors[serverId];
            if (!toolRegistry) return;
            var tools = toolRegistry.getByServerId(serverId);
            for (var i = 0; i < tools.length; i++) {
                toolRegistry.unregister(tools[i].name);
            }
        }

        function createToolHandler(serverId, toolName) {
            return function(args, ctx) {
                return new Promise(function(resolve) {
                    // 长调用转后台判定：仅 Agent 引擎轮次（agent/script/shader，且非外接
                    // callerId）且 serverManager 提供了任务表接线时启用（见上方两条边界）
                    var isAgentRound = !!(ctx && !ctx.callerId && LONG_CALL_MODULES[ctx.moduleId] === true);
                    var useLong = !!(longCall && isAgentRound
                        && typeof longCall.beginTask === 'function'
                        && typeof longCall.settleTask === 'function'
                        && longCall.waitMs > 0);
                    // 硬上限必须晚于同步等待窗，否则等待窗尚未触发、超时回调已先清理 pending
                    var hardMs = useLong
                        ? ((longCall.hardMs && longCall.hardMs > longCall.waitMs) ? longCall.hardMs : (longCall.waitMs + 60000))
                        : 0;

                    var taskId = null;
                    var handedOff = false;   // 已回执"转后台"
                    var syncResolved = false; // 同步路径已 resolve（Promise 已结）
                    var timer = null;

                    function finishSync(err, result) {
                        if (syncResolved) return;
                        syncResolved = true;
                        if (timer) { clearTimeout(timer); timer = null; }
                        if (err) {
                            resolve(protocol.formatToolResult(false, err.message || 'Tool execution failed', true));
                            return;
                        }
                        if (result.isError) {
                            resolve(protocol.formatToolResult(false, protocol.extractErrorText(result.content), true));
                            return;
                        }
                        var text = protocol.extractResultText(result.content);
                        resolve(protocol.formatToolResult(true, text || 'Tool executed'));
                    }

                    callTool(serverId, toolName, args, function(err, result) {
                        if (handedOff) {
                            // 迟到结果：归一为文本后交任务表 settle（失败/成功同路），
                            // 注入由 serverManager 接线（结果富文本、卡片形态都在那边）
                            var errText = null;
                            var text = null;
                            if (err) {
                                errText = err.message || 'Tool execution failed';
                            } else if (result.isError) {
                                errText = protocol.extractErrorText(result.content) || 'Tool execution failed';
                            } else {
                                text = protocol.extractResultText(result.content) || 'Tool executed';
                            }
                            try {
                                longCall.settleTask(taskId, errText, text);
                            } catch (e) {
                                console.warn('[MCP] 长调用任务落表失败（' + taskId + '）: ' + (e && e.message ? e.message : e));
                            }
                            return;
                        }
                        finishSync(err, result);
                    }, useLong ? { timeoutMs: hardMs } : undefined);

                    if (useLong && !syncResolved) {
                        timer = setTimeout(function() {
                            timer = null;
                            if (syncResolved || handedOff) return;
                            var sessionId = null;
                            try {
                                if (typeof longCall.getSessionId === 'function') sessionId = longCall.getSessionId() || null;
                            } catch (_) {}
                            try {
                                taskId = longCall.beginTask({ serverId: serverId, toolName: toolName, sessionId: sessionId });
                            } catch (e) {
                                taskId = null;
                            }
                            if (!taskId) {
                                // 登记失败：不转后台（回退旧行为，硬上限超时仍兜底报错）
                                return;
                            }
                            handedOff = true;
                            // 可观测性：转后台在面板日志留一行（排障时"工具为什么没回"的唯一线索）
                            console.log('[MCP] 长调用转后台: ' + serverId + '/' + toolName
                                + ' taskId=' + taskId + '（等待窗 ' + Math.round(longCall.waitMs / 1000) + 's）');
                            var waitSec = Math.max(1, Math.round(longCall.waitMs / 1000));
                            var hardSec = Math.max(waitSec, Math.round(hardMs / 1000));
                            // 上界按人话给：整分钟用"分钟"，否则用秒（生产配置 = 30 分钟）
                            var hardLabel = (hardMs >= 60000 && hardMs % 60000 === 0)
                                ? (hardMs / 60000) + ' 分钟' : hardSec + 's';
                            // 措辞不宣称"仍在继续"（服务器静默丢包时无法判定）——只给事实与上界
                            resolve(protocol.formatToolResult(true,
                                '已转后台执行（taskId=' + taskId + '）：本次调用超过 ' + waitSec +
                                's 未返回，仍在等待结果（上限 ' + hardLabel + '，超时会以失败回报）；' +
                                '完成后结果会自动出现在对话里，请不要重复调用本工具或轮询。'));
                        }, longCall.waitMs);
                    }
                });
            };
        }

        function notifyChanged(serverId, scope, toolDescriptions, toolStubs) {
            // fetchAndRegister 的响应回调内已完成 unregisterByServer +
            // registerTools（见上方），直接复用其注册结果即可——若此处再叠加
            // 一轮全量注销+注册，每次面板保存触发两轮 registry 抖动、CPU 冗余。
            // 错误路径静默（调用方无错误通道）
            fetchAndRegister(serverId, scope, toolDescriptions, toolStubs, null);
        }

        // 供面板读取最近一轮工具可用性失败明细（注册失败 + tools/list
        // 拉取失败；未注册成功即 LLM 与面板均不可见）
        function getLastRegisterErrors(serverId) {
            return _lastRegisterErrors[serverId] || [];
        }

        // 注册名 → 原始名查询（面板编辑器以原始名为稳定缓存键）
        function getOriginalToolName(serverId, regName) {
            var map = _originalNames[serverId];
            return (map && Object.prototype.hasOwnProperty.call(map, regName)) ? map[regName] : null;
        }

        return {
            fetchAndRegister: fetchAndRegister,
            registerTools: registerTools,
            callTool: callTool,
            unregisterByServer: unregisterByServer,
            notifyChanged: notifyChanged,
            setDisabledTools: function(list) { _disabledToolNames = list || []; },
            getLastRegisterErrors: getLastRegisterErrors,
            getOriginalToolName: getOriginalToolName
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createToolDiscovery = createToolDiscovery;

})(window);
