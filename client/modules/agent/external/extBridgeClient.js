/**
 * extBridgeClient.js — 面板侧外接模式 Bridge 客户端
 *
 * 职责：
 *   - WS 常连 Bridge（127.0.0.1:9877 起，端口经 Bridge.getBridgePort 发现；断线 5s 重连）
 *   - onopen 发 ext_panel_hello 注册面板身份（面板在线 ≠ 已授权——授权按调用检查激活态）
 *   - 收 ext_tools_request → 组白名单投影 → 回 ext_tools_result
 *   - 收 ext_check_request → 外部确认表判定 → 回 ext_check_result
 *   - 收 ext_dispatch → 门控链（激活态 → 白名单 → 组/per-tool 开关 → 回环防护）
 *     → toolExecutor.execute(name, args, 'external-mcp') → 回 ext_result
 *     （单次执行有 30min 墙钟上限，对齐 relay 绝对闸门——挂起 handler 不再堵死队列；
 *      到点回 EXT_TASK_PENDING + taskId，底层调用继续挂着、迟到结果落任务表，
 * 外部客户端事后用 ext_task_get 查）
 *   - 策略变更（组/per-tool 开关）→ ext_tools_changed 推送（外部进程转发 tools/list_changed）
 * - 调用日志环形缓冲（放行路径透明度补偿，唯一补偿载体 → 外接模式管理台展示）
 */
(function (global) {
    'use strict';

    var BRIDGE_HOST = '127.0.0.1';
    var RECONNECT_MS = 5000;
    var LOG_RING_MAX = 1000;  // 调用日志环形缓冲上限（含 input/output 详情后的安全存量）
    var LOG_TEXT_MAX = 4000;  // 单条 input/output 文本截断上限（防大参数/大结果撑爆环形缓冲）

    var ws = null;
    var connected = false;
    var reconnectTimer = null;
    var callLog = [];         // 环形缓冲：{seq, ts, tool, clientId, ok, error, confirm, durationMs, detail, input, output}
    var logSeq = 0;           // 单调递增序号（条目 DOM 身份键，环形淘汰时视图可对位移除）
    var logListeners = [];
    var statusListeners = [];

    function getPort() {
        if (global.Bridge && typeof global.Bridge.getBridgePort === 'function') {
            return global.Bridge.getBridgePort();
        }
        return 9877;
    }

    function send(obj) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return false;
        try {
            ws.send(JSON.stringify(obj));
            return true;
        } catch (e) {
            console.warn('[ext-bridge] send failed: ' + e.message);
            return false;
        }
    }

    // ── 调用日志（环形缓冲 + 监听器）──
    // input/output 详情文本化 + 截断：mcpResult 取 content[].text 拼接，对象 JSON 化；
    // 超长截断并标注原始长度（外部 Agent 可能提交整段脚本/贴大结果）
    function logText(v) {
        var s;
        try {
            if (v == null) s = '';
            else if (typeof v === 'string') s = v;
            else if (typeof v === 'object' && Array.isArray(v.content)) {
                s = v.content.map(function (c) {
                    return c && typeof c === 'object' && typeof c.text === 'string' ? c.text : JSON.stringify(c);
                }).join('\n');
            } else s = JSON.stringify(v, null, 2);
        } catch (_) { s = String(v); }
        if (s.length > LOG_TEXT_MAX) {
            // 强制扁平拷贝：
            // `slice` 产出 SlicedString 会保留**父串**，于是「日志单条 4K 上限」并不界内存——
            // 实测灌 1000 次 dispatch 时 args 195K → 常驻 **191.3MB**（≈100% 原始），
            // 环形缓冲按条数淘汰救不回来。先扁平化再拼「原始 N 字符」标注。
            return _flattenStr(s.slice(0, LOG_TEXT_MAX) + '\n…（截断，原始 ' + s.length + ' 字符）');
        }
        return s;
    }
    // 见上：split('')/join('') 一趟产出新的扁平字符串（无环境依赖；只作用于已截断的 ≤4K 文本）
    function _flattenStr(str) { return str.split('').join(''); }

    function appendLog(entry) {
        entry.ts = Date.now();
        entry.seq = ++logSeq;
        callLog.push(entry);
        if (callLog.length > LOG_RING_MAX) callLog.shift();
        for (var i = 0; i < logListeners.length; i++) {
            try { logListeners[i](entry); } catch (_) {}
        }
    }

    function notifyStatus() {
        var st = { bridgeConnected: connected, active: !!(global.AEExternal && global.AEExternal.policy && global.AEExternal.policy.isActive()) };
        for (var i = 0; i < statusListeners.length; i++) {
            try { statusListeners[i](st); } catch (_) {}
        }
    }

    // ── 预览区覆盖保护（已删除）──
    // 原机制：进入外接模式时对 script/shader 预览区拍基线快照，外部 submit 覆盖「脏」内容
    // 前强制 elicitation 确认。删除理由：① 触发条件只比对快照，分不清「手改」与「遗留旧
    // 内容/面板内模式写入」，实测误报为主；② 与外接「无人值守」定位冲突——不支持
    // elicitation 的客户端被直接拒绝，保护器变成功能阻断器；③ auto 档语义自洽——显式
    // 授权全放行，不应存在绕过档位的第二道门。若将来真发生「覆盖丢内容」，正解是
    // 「提交前自动备份」（可恢复）而非阻断。
    // 同类地，提交目标预览区路由提示也已移除（涉及
    // SHADER_SUBMIT_TOOLS + shaderSubmitHint + isPendingShaderSubmit 出口）：它存在的理由
    // 是写入侧当年按面板 runtimeMode 选预览区、外接无法区分 script/shader 提交，故在派发期
    // 挂一个全局提示供写入侧补判。写入目标现由**提交工具族显式声明**（controller 注入
    // { area: 'shader' }，service.js 只认 area），提示没有生产消费方，留着等于留第二个目标
    // 来源（漏传即静默错区）。

    // ── 库 origin 登记表（origin=external 标记贯通库列表）──
    // 外部 script_manager / shader_library 写库成功 → 按「文件名（小写）」记录来源；
    // Script 树（script-tree.js renderFile）与效果库（shaderUI.js refreshLibrary）
    // 渲染时查表挂「外」徽标。delete 成功即移除登记。纯 UI 便利性标记，非安全机制
    //（外部写库的确认/放行语义由 extPolicy 确认表把守）。
    var LIB_ORIGIN_KEY = 'extLibOrigin';
    var LIB_ORIGIN_MAX = 300;
    var libOrigin = null;

    function loadLibOrigin() {
        if (libOrigin) return libOrigin;
        try {
            libOrigin = JSON.parse(global.localStorage.getItem(LIB_ORIGIN_KEY) || '{}') || {};
        } catch (_) { libOrigin = {}; }
        return libOrigin;
    }

    function saveLibOrigin() {
        try { global.localStorage.setItem(LIB_ORIGIN_KEY, JSON.stringify(libOrigin)); } catch (_) {}
    }

    function setLibOrigin(fileName, clientId) {
        if (!fileName) return;
        var m = loadLibOrigin();
        m[String(fileName).toLowerCase()] = { ts: Date.now(), clientId: clientId || '' };
        var keys = Object.keys(m);
        if (keys.length > LIB_ORIGIN_MAX) {
            keys.sort(function (a, b) { return (m[a].ts || 0) - (m[b].ts || 0); });
            while (keys.length > LIB_ORIGIN_MAX) delete m[keys.shift()];
        }
        saveLibOrigin();
        refreshLibraryLists();
    }

    function clearLibOrigin(fileName) {
        var m = loadLibOrigin();
        if (delete m[String(fileName).toLowerCase()]) {
            saveLibOrigin();
            refreshLibraryLists();
        }
    }

    // 外部写库/删库后同步刷新库列表——面板不感知外部写库，
    // 脚本树/效果库不刷新则「外」徽标与新条目要等用户手动刷新才可见。
    // 守卫式调用（模块未挂载/沙箱测试环境静默跳过）；在 dispatch 执行段内
    // （FIFO 串行）同步触发，无并发刷新交错。
    function refreshLibraryLists() {
        try {
            if (global.ScriptTree && typeof global.ScriptTree.refresh === 'function') global.ScriptTree.refresh();
        } catch (_) {}
        try {
            var su = global.AEShaderUIInstance;
            if (su && typeof su.refreshLibrary === 'function') su.refreshLibrary();
        } catch (_) {}
    }

    function getLibOrigin(fileName) {
        return loadLibOrigin()[String(fileName).toLowerCase()] || null;
    }

    function _basename(p) {
        return String(p || '').replace(/[\\\/]+$/, '').split(/[\\\/]/).pop() || '';
    }

    // 写库成功后登记（create 的实际落盘名可能因去重改名 → 从结果报文 path= 段解析）
    function recordLibOrigin(toolName, args, result, clientId) {
        var text = (result && result.content && result.content[0] && result.content[0].text) || '';
        if (toolName === 'script_manager') {
            if (args.mode === 'create') {
                // path= 恒为结果报文末段（bootstrap.js _createScript 拼接顺序）——匹配须到
                // 行尾：\S+ 在首个空格截断（Windows 用户名含空格 → 数据目录路径含空格；
                // validateName 亦放行含空格脚本名），登记错误键名致「外」徽标永不显示。
                // 脚本名含 "path=" 时首个匹配虽落在名字段，但 _basename 取末斜杠后一段
                // 仍是真实文件名（路径段禁止斜杠，真实路径恒居末）
                var m = String(text).match(/\bpath=(.+)$/);
                if (m) setLibOrigin(_basename(m[1]), clientId);
            } else if (args.mode === 'write' && args.path) {
                setLibOrigin(_basename(args.path), clientId);
            } else if (args.mode === 'delete' && args.path) {
                clearLibOrigin(_basename(args.path));
            } else if (args.mode === 'rename' && args.path) {
                // 文件重命名 → origin 键随迁（旧键清除 + 新键登记）；文件夹重命名不影响
                // 文件名键（键=basename），dst 无脚本扩展名时仅清不登。无 path= 段
                //（如「名称未变化」no-op）不动 origin。move 保留文件名，键不变无需处理
                var rm = String(text).match(/\bpath=(.+)$/);
                if (rm) {
                    clearLibOrigin(_basename(args.path));
                    var dst = _basename(rm[1]);
                    if (/\.(jsx|jsxbin)$/i.test(dst)) setLibOrigin(dst, clientId);
                }
            }
        } else if (toolName === 'shader_library') {
            var ext = args.type === 'js' ? 'js' : 'glsl';
            if (args.mode === 'save' && args.name) setLibOrigin(args.name + '.' + ext, clientId);
            else if (args.mode === 'delete' && args.name) clearLibOrigin(args.name + '.' + ext);
        }
    }

    // ── 截图结果内联（图片投递链补齐）──
    // getPreviewFrame 的结果只有 filePath + 尺寸元数据；面板内通道由 controller 的 vision hook
    // 读文件后注入图片（读完不删：进保留池留最新 30 张），外部通道没有等价环节
    // ——客户端必须自己读磁盘才能看图，而它的工具面里并没有"读图"这一步（实测反馈：）。
    // 这里在**发给外部客户端之前**把该 PNG 读成 data URL 挂进结果，接上既有图片链：
    // transcodeResultImages 转 JPEG（>4096×2160 等比缩放）→ ext-mcp-server 的 hoistInlineImages
    // 提升为 MCP image block（图片载荷与文本预算分离）。
    // analyzeImage：只在抓帧模式（attachImage:true）内联；给了 filePath 的
    // 文件模式按设计只回指标，不回图。
    // 读失败只置 imageAttached:false，filePath 原样保留供客户端自读；不删临时帧
    // （外部客户端可能仍去读该路径；temp/ae-tools 的 ae_preview_* 由 tempSweep 按龄 7 天
    //  + 保留池最新 30 张兜底）。
    var INLINE_IMAGE_TOOLS = { getPreviewFrame: true, analyzeImage: true };
    function inlineScreenshotImage(toolName, result) {
        if (!INLINE_IMAGE_TOOLS[toolName] || !result || !Array.isArray(result.content)) return Promise.resolve(result);
        var first = result.content[0];
        if (!first || first.type !== 'text' || typeof first.text !== 'string') return Promise.resolve(result);
        var parsed = null;
        try { parsed = JSON.parse(first.text); } catch (_) { return Promise.resolve(result); }
        if (!parsed || typeof parsed !== 'object' || !parsed.filePath) return Promise.resolve(result);
        if (toolName === 'analyzeImage' && parsed.attachImage !== true) return Promise.resolve(result);
        if (typeof global.AEFS === 'undefined' || typeof global.AEFS.readImageBase64 !== 'function') return Promise.resolve(result);
        return Promise.resolve(global.AEFS.readImageBase64(parsed.filePath)).then(function (r) {
            if (r && r.success === true && r.base64) {
                parsed.imageDataUrl = 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64;
                parsed.imageAttached = true;
            } else {
                parsed.imageAttached = false;
            }
            first.text = JSON.stringify(parsed);
            return result;
        }, function () {
            parsed.imageAttached = false;
            first.text = JSON.stringify(parsed);
            return result;
        });
    }

    // ── ext_dispatch 门控链 + 执行 ──
    // 面板侧派发串行化：stdio 与 HTTP 两路外部客户端并存时，
    // relay 各帧独立转发、两个 dispatch 的 handler 可能交错执行——AE 执行顺序不确定。
    // 与 ext-mcp-server / ext-mcp-http 的 FIFO 对齐：dispatch 入队，reply 终态放行下一个
    //（reply 是全部路径的唯一出口，早期拒绝/成功/失败均经此）。
    var dispatchQueue = [];
    var dispatchBusy = false;
    var inFlightId = '';                    // 当前执行中的 requestId（进展心跳取数源之一）
    var progressTimer = null;
    var PROGRESS_INTERVAL_MS = 20 * 1000;   // 进展心跳周期（relay 相对超时 90s / stdio 等待 100s 的 1/4 量级）
    // 单次 dispatch 墙钟上限：对齐 relay 侧 pending **绝对上限**
    //（ext-mcp-relay.js EXT_CALL_MAX_MS = 30min，心跳不得续命）。挂起的工具 handler
    //（executor promise 永不 settle）会永久占住 dispatchBusy——整条外接链路静默排队，
    // 而心跳还让 relay 持续续期。到点按终态回错误并放行队列；AE evalScript 不可取消，
    // 迟到结果由 settled 守卫丢弃（不二次回包）。
    var DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;
    var inFlightTimer = null;               // 当前执行项的墙钟上限句柄（队列串行，单飞）

    // ── 超时任务表 ──
    // 到墙钟上限时不再只回泛化错误：登记任务并回 EXT_TASK_PENDING + taskId，底层 executor
    // promise **继续挂着**（AE evalScript 不可取消），其迟到结果经 settled 守卫改落本表
    //（成功/失败都存，不再被丢弃）；外部客户端随后用 ext_task_get 按 taskId 取结果。
    // 上限：保留最近 TASK_KEEP_MAX 条 + 已终态条目超 TASK_TTL_MS 清理；纯内存级——
    // 面板重载即清空（工具描述如实说明，勿当成持久任务账本）。
    var TASK_KEEP_MAX = 32;
    var TASK_TTL_MS = 30 * 60 * 1000;
    var taskTable = [];                     // 插入序（旧→新）：{taskId, tool, clientId, status, result, error, startedAt, finishedAt}
    var _taskSeq = 0;

    // taskId：短、不可枚举即可（面板内存级，非安全凭据）：时间戳 + 随机段 + 递增序
    function newTaskId() {
        _taskSeq++;
        return 't' + Date.now().toString(36) + '-' + _taskSeq.toString(36) +
            Math.random().toString(36).slice(2, 6);
    }

    // 清理：① 已终态且超过 TTL 的条目移除（pending 不受 TTL 影响——还没出结果）；
    // ② 超上限先淘汰最老的已终态条目（FIFO 串行下 pending 至多与超时次数同阶），
    // 极端溢出（全表 pending）才淘汰最老条目——有界内存优先。
    function pruneTasks(nowTs) {
        var now = (typeof nowTs === 'number') ? nowTs : Date.now();
        var kept = [];
        for (var i = 0; i < taskTable.length; i++) {
            var t = taskTable[i];
            if (t.finishedAt && (now - t.finishedAt) > TASK_TTL_MS) continue;
            kept.push(t);
        }
        taskTable = kept;
        while (taskTable.length > TASK_KEEP_MAX) {
            var victim = -1;
            for (var j = 0; j < taskTable.length; j++) {
                if (taskTable[j].finishedAt) { victim = j; break; }
            }
            if (victim < 0) victim = 0;
            taskTable.splice(victim, 1);
        }
    }

    function registerPendingTask(toolName, clientId, startedAt) {
        var entry = {
            taskId: newTaskId(),
            tool: toolName || '',
            clientId: clientId || '',
            status: 'pending',
            result: null,
            error: '',
            startedAt: startedAt || Date.now(),
            finishedAt: 0
        };
        taskTable.push(entry);
        pruneTasks();
        return entry;
    }

    // 迟到结果落地（成功/失败都存；仅对仍 pending 的条目生效，防重复结算）
    function settleTask(entry, ok, result, errorText) {
        if (!entry || entry.status !== 'pending') return;
        entry.status = ok ? 'done' : 'failed';
        entry.result = ok ? (result || null) : null;
        entry.error = ok ? '' : (errorText || '');
        entry.finishedAt = Date.now();
        pruneTasks();
    }

    // 任务视图（ext_task_get 载荷）：pending 无 result/error、finishedAt=null
    function getTaskView(taskId) {
        var id = String(taskId == null ? '' : taskId);
        for (var i = 0; i < taskTable.length; i++) {
            var t = taskTable[i];
            if (t.taskId !== id) continue;
            var view = {
                taskId: t.taskId,
                tool: t.tool,
                status: t.status,
                startedAt: t.startedAt,
                finishedAt: t.finishedAt || null
            };
            if (t.status === 'done') view.result = t.result;
            if (t.status === 'failed') view.error = t.error;
            return view;
        }
        return null;
    }

    // ext_task_get handler：未知 id → 明确错误（EXT_TASK_UNKNOWN）；done 附原结果内容块
    //（图片继续走既有 hoistInlineImages 链以图像块送达——base64 不塞进文本，该缺陷 同款口径）
    function queryTaskResult(args) {
        var id = args && args.taskId;
        var view = getTaskView(id);
        if (!view) {
            return {
                success: false,
                isError: true,
                content: [{
                    type: 'text',
                    text: 'EXT_TASK_UNKNOWN: 未找到任务「' + (id == null ? '' : String(id)) + '」'
                        + '（taskId 取自 EXT_TASK_PENDING 回包；面板重载后任务表清空，仅保留最近 '
                        + TASK_KEEP_MAX + ' 条、完成 30 分钟后清理）'
                }]
            };
        }
        var meta = {
            taskId: view.taskId,
            tool: view.tool,
            status: view.status,
            startedAt: view.startedAt,
            finishedAt: view.finishedAt
        };
        if (view.status === 'failed') meta.error = view.error;
        var content = [{ type: 'text', text: JSON.stringify(meta, null, 2) }];
        if (view.status === 'done' && view.result && Array.isArray(view.result.content)) {
            content = content.concat(view.result.content);
        } else if (view.status === 'done' && view.result) {
            content.push({ type: 'text', text: JSON.stringify(view.result, null, 2) });
        }
        return { success: true, isError: false, content: content };
    }

    // ── ext_task_get 工具注册──
    // 只读 → 确认表 default 放行（不单列分支）。scope 必须是显式 module[external-mcp]：
    //   ① extTools.isToolExposed 的 scope 闸门要求 module 作用域显式含 'external-mcp'；
    //   ② extBridgeClient 对 module-scope 工具以 moduleIds[0] 作执行 moduleId（checkAccess），
    //      故首项必须是 'external-mcp'。handler 只读面板内存，不经 AE（AE 阻塞期间仍可回答）。
    // 装配：bootstrap.js initExternalModule 调用（registry 运行期已存在）。
    // 源码定位式（name 字面量 + 紧随的 scope 字面量）供「固定名单每件都有声明源」
    // 检查使用（BUILTIN_JS_DECLS）。
    function registerExtTaskTool(toolRegistry) {
        if (!toolRegistry || typeof toolRegistry.register !== 'function') {
            return { ok: false, error: 'MISSING_TOOL_REGISTRY' };
        }
        if (typeof toolRegistry.hasTool === 'function' && toolRegistry.hasTool('ext_task_get')) {
            return { ok: true, skipped: true };
        }
        var reg = toolRegistry.register({
            name: 'ext_task_get',
            description: '查询外部调用超时任务的结果（只读）。单次调用超过 30 分钟墙钟上限时回包错误码 EXT_TASK_PENDING 并附 taskId；面板未重载期间用本工具按 taskId 查询：status=pending（仍在执行）| done（其后的内容块为原工具结果）| failed（error 为失败原因）。任务表仅保留最近 ' + TASK_KEEP_MAX + ' 条、完成后 30 分钟清理，面板重载即清空；未知 taskId 返回 EXT_TASK_UNKNOWN。',
            input_schema: {
                type: 'object',
                properties: {
                    taskId: { type: 'string', description: AEI18n.t('任务 ID（取自 EXT_TASK_PENDING 回包中的 taskId）') }
                },
                required: ['taskId']
            },
            handler: function (args) { return queryTaskResult(args); },
            scope: { type: 'module', moduleIds: ['external-mcp'] },
            stub: false,
            source: 'agent',
            category: 'utility'
        });
        return (reg && reg.ok) ? { ok: true } : { ok: false, error: (reg && reg.error) || 'REGISTER_FAILED' };
    }

    function handleDispatch(msg) {
        dispatchQueue.push(msg);
        ensureProgressTimer();
        drainDispatchQueue();
    }

    // ── 进展心跳 ──
    // 队列非空期间定期告诉 relay「这些 requestId 还在我这儿」：relay 刷新 pending 相对计时，
    // 并把心跳转给发起方刷新其等待计时。没有它，超过 relay 90s / stdio 客户端 100s 的长调用
    // （渲染、长脚本）会被判成失联——外部白等、面板随后算出的真结果迟到被当「陈旧回包」丢弃。
    // 只报在飞 + 排队的 id：已收尾的不报，真丢回包时仍会按相对超时老实报错。
    function outstandingRequestIds() {
        var ids = [];
        if (inFlightId) ids.push(inFlightId);
        for (var i = 0; i < dispatchQueue.length; i++) {
            if (dispatchQueue[i] && dispatchQueue[i].requestId) ids.push(dispatchQueue[i].requestId);
        }
        return ids;
    }

    function ensureProgressTimer() {
        if (progressTimer) return;
        progressTimer = setInterval(function () {
            var ids = outstandingRequestIds();
            if (!ids.length) {          // 队列已空：自我收尾（不发空帧）
                clearInterval(progressTimer);
                progressTimer = null;
                return;
            }
            send({ type: 'ext_progress', ids: ids });
        }, PROGRESS_INTERVAL_MS);
    }

    function drainDispatchQueue() {
        if (dispatchBusy || !dispatchQueue.length) return;
        dispatchBusy = true;
        var next = dispatchQueue.shift();
        inFlightId = (next && next.requestId) ? next.requestId : '';
        try {
            runDispatch(next);
        } catch (e) {
            // 同步抛错（进不了下方 promise 链）：这是 reply 之外唯一会把 dispatchBusy 永久卡在
            // true 的路径，必须照样回包 + 放行，否则整条外接通道从此静默排队
            failDispatchSync(next, e);
        }
    }

    function failDispatchSync(msg, e) {
        var m = (msg && msg.requestId) ? msg.requestId : '';
        var em = 'EXEC_ERROR: ' + ((e && e.message) ? e.message : String(e));
        // 同步抛错走的是 reply 之外的终态出口：墙钟句柄必须一并回收，否则迟到触发会二次回包
        if (inFlightTimer) { clearTimeout(inFlightTimer); inFlightTimer = null; }
        if (inFlightId === m) {     // 尚未收尾（reply 已经跑过就不再补发）
            try {
                appendLog({
                    tool: String((msg && msg.tool) || ''), clientId: (msg && msg.clientId) || '',
                    ok: false, error: em, confirm: '', durationMs: 0,
                    detail: null, input: '', output: ''
                });
            } catch (_) {}
            send({ type: 'ext_result', requestId: m, ok: false, result: null, error: em });
        }
        inFlightId = '';
        dispatchBusy = false;
        drainDispatchQueue();
    }

    function runDispatch(msg) {
        var policy = global.AEExternal && global.AEExternal.policy;
        var tools = global.AEExternal && global.AEExternal.tools;
        var registry = global.AE_LLM && global.AE_LLM.toolRegistry;
        var executor = global.AE_LLM && global.AE_LLM.toolExecutor;
        var toolName = msg.tool || '';
        var startedAt = Date.now();
        // 确认留痕：'granted'=elicitation 已确认 / 'skipped'=客户端不支持确认但放行
        var confirmState = msg.confirm === 'granted' || msg.confirm === 'skipped' ? msg.confirm : '';
        // 库写调用的目标摘要（审阅队列「载入预览」按钮数据源——仅存
        // 少量定长字段，避免环形缓冲被大参数撑爆）
        var libDetail = null;
        if (toolName === 'script_manager' || toolName === 'shader_library') {
            var _a = msg.args || {};
            libDetail = { mode: _a.mode || '', path: _a.path || '', name: _a.name || '', type: _a.type || '' };
        }

        var settled = false;    // 终态唯一出口标记（墙钟超时后迟到的结果/异常不得二次回包）
        var timedOutTask = null;    // 墙钟超时登记的任务（迟到结果落表用；正常路径恒 null）
        function reply(ok, result, error, taskId) {
            if (settled) return;
            settled = true;
            if (inFlightTimer) { clearTimeout(inFlightTimer); inFlightTimer = null; }
            appendLog({
                tool: toolName,
                clientId: msg.clientId,
                ok: ok,
                error: error || '',
                confirm: confirmState,
                durationMs: Date.now() - startedAt,
                detail: libDetail,
                input: logText(msg.args || {}),
                output: logText(result)
            });
            // 放行路径 toast（透明度补偿 + 粒度化）：
            //   'risky'（默认）= 确认被跳过（客户端不支持 elicitation）+ auto 档确认表命中
            //   'all'          = 全部成功调用
            //   'off'          = 关闭；'granted'（用户已确认）不弹
            if (ok && confirmState !== 'granted' && policy && policy.getToastLevel) {
                var level = policy.getToastLevel();
                if (level !== 'off') {
                    var toastMsg = '';
                    if (confirmState === 'skipped') {
                        toastMsg = '外部调用已放行执行：' + toolName + '（客户端不支持确认）';
                    } else if (level === 'all') {
                        toastMsg = '外部调用已执行：' + toolName;
                    } else if (policy.wouldConfirm && policy.wouldConfirm(toolName, msg.args || {}).confirm) {
                        toastMsg = '外部调用已直接执行：' + toolName + '（auto 档高危放行）';
                    }
                    if (toastMsg) {
                        try {
                            if (global.AEToast && typeof global.AEToast.show === 'function') {
                                global.AEToast.show(toastMsg, 'warn');
                            }
                        } catch (_) {}
                    }
                }
            }
            var frame = { type: 'ext_result', requestId: msg.requestId, ok: ok, result: result || null, error: error || '' };
            // taskId：超时回包附任务 ID。relay routePanelReply 只转发
            // ok/error/result——外部客户端从 error 文本中的 taskId= 取值；本字段供面板侧
            // 消费与协议扩展，不改 relay 转发面。
            if (taskId) frame.taskId = taskId;
            send(frame);
            // 派发 FIFO 放行（reply 是终态唯一出口，此处放行下一个 dispatch）
            inFlightId = '';
            dispatchBusy = false;
            drainDispatchQueue();
        }

        // 墙钟上限：到点登记一个任务并回
        // EXT_TASK_PENDING + taskId（错误码从泛化 EXT_TIMEOUT 收敛为「仍在执行、可事后
        // 查询」），FIFO 照旧放行；底层 executor promise 继续挂着，迟到结果落任务表
        //（见下方 timedOutTask 处理与 settleTask）。超时数值不变（仍对齐 relay 绝对闸门）。
        inFlightTimer = setTimeout(function () {
            inFlightTimer = null;
            timedOutTask = registerPendingTask(toolName, msg.clientId, startedAt);
            reply(false, null, 'EXT_TASK_PENDING: 面板执行超过 ' + Math.round(DISPATCH_TIMEOUT_MS / 60000) +
                ' 分钟上限，任务仍在执行；taskId=' + timedOutTask.taskId +
                '，用 ext_task_get 查询结果（勿盲目重试）', timedOutTask.taskId);
        }, DISPATCH_TIMEOUT_MS);

        if (!policy || !tools || !executor) {
            reply(false, null, 'EXT_PANEL_NOT_READY: panel external module not initialized');
            return;
        }
        // 门 1：外部访问授权总开关（显式授权语义——与模式档位解耦，
        // 进入外接档不再自动授权，须在状态卡显式拨开；两种未放行情形同码同因不同指引）
        if (!policy.isActive()) {
            reply(false, null, 'EXTERNAL_MODE_OFF: 外部访问未授权（面板 Agent 模块 → 外接档 → 管理台状态卡「外部访问授权」开关）');
            return;
        }
        // 门 2-5：白名单 / 组开关 / per-tool 开关 / 回环防护（双门之执行期复检）
        var exposed = tools.isToolExposed(toolName);
        if (!exposed.exposed) {
            reply(false, null, 'ACCESS_DENIED: Tool "' + toolName + '" not exposed externally (' + exposed.error + ')');
            return;
        }

        // ── 门 6：authored 代码过 AST 编译门（外接跟随面板 Agent 模式）──
        // 面板 Agent 模式的同一处理在 toolExecutionPipeline.js:174-221（source=agent-tool）：
        //   空/非字符串 code → 拒；过门 → 被拒则回结构化理由；通过则把 `args.code` 换成
        //   **重发射产物**（校验与执行同一份，TOCTOU 消失）；门缺席时 fail-closed。
        // 为什么必须有：缺了门 6，外接就只有门 1-5（只看工具名/来源，不看 args 内容）+ 运行时守卫 ⇒
        // authored 代码唯一防线是守卫，而守卫可被 `__aeSGDn()` 拆掉（实测：
        // system 域关闭也能在帧内执行命令）；而面板侧的静态门/逃逸形态检测外接这台机器上从不跑。
        // source 用 'agent-tool'（不是新造 'external-mcp'）＝与 Agent 工具调用**同一套表与
        // bypass 语义**（`bypass['agent-tool']` 开则同样免打扰但门照跑）。
        var execArgs = msg.args || {};
        var _agLineMap = null;
        if (toolName === 'executeExtendScript') {
            var _gateFn = global.AE_LLM && global.AE_LLM._runSandboxedScript;
            if (typeof _gateFn !== 'function') {
                // 对**模型**的文案只写操作事实与可行动作（不引源码行号、不写「与面板同口径」这类元话术）
                reply(false, null, 'AST_GATE_UNAVAILABLE: AST 编译门未就绪（ast-gate 模块加载失败），本次未执行。'
                    + '请刷新面板后重试。');
                return;
            }
            var _agCode = (execArgs && typeof execArgs === 'object') ? execArgs.code : undefined;
            if (typeof _agCode !== 'string' || !_agCode.trim()) {
                reply(false, null, 'NO_EXECUTABLE_CODE: executeExtendScript 缺少可执行代码'
                    + '（code 缺失、为空或非字符串），本次未执行。请补齐 code 后重新调用。');
                return;
            }
            var _agGate = _gateFn(String(_agCode), { source: 'agent-tool' });
            if (!_agGate || _agGate.ok !== true) {
                var _agText = (_agGate && (_agGate.llmText || _agGate.displayText)) || '未知拒绝原因';
                var _agDom = (_agGate && _agGate.error && _agGate.error.domain)
                    ? '（能力域未开启：' + _agGate.error.domain + '）' : '';
                reply(false, null, 'AST_GATE_REJECTED: ' + _agText + _agDom);
                return;
            }
            if (_agGate.noExecutableStatement === true) {
                reply(false, null, 'NO_EXECUTABLE_CODE: executeExtendScript 的代码没有可执行语句'
                    + '（空块、空循环，或只含注释/分号），本次未执行。请给出实际要执行的语句后重新调用。');
                return;
            }
            // 重发射产物替换（浅拷贝，不污染调用方对象）——与面板 toolExecutionPipeline.js:216 同款
            execArgs = (execArgs && typeof execArgs === 'object')
                ? Object.assign({}, execArgs, { code: _agGate.emitted })
                : { code: _agGate.emitted };
            _agLineMap = (_agGate.lineMap && _agGate.lineMap.length) ? _agGate.lineMap : null;
        }

        // 执行 moduleId 解析（关键修复）：module-scope 工具（shader 六件 / script 三件 /
        // search_skill_store / queryAeApi 等）以其原生 moduleId 执行——传 'external-mcp' 会被
        // toolExecutor.checkAccess 的 scope 匹配拒绝（外部权限已由 isToolExposed 双门把守，
        // 此处仅恢复工具的原生执行语义）；global-scope 工具保持 'external-mcp'
        //（Skill 等按调用方模块裁剪作用域的 handler 依赖它）
        var execModuleId = 'external-mcp';
        try {
            var toolDef = registry && registry.get(toolName);
            if (toolDef && toolDef.scope && toolDef.scope.type === 'module') {
                execModuleId = (Array.isArray(toolDef.scope.moduleIds) && toolDef.scope.moduleIds.length)
                    ? toolDef.scope.moduleIds[0]
                    : (toolDef.scope.moduleId || 'external-mcp');
            }
        } catch (_) {}

        // （原「外接模式 submit 路由提示」的置位在此处，随机制删除——写入目标现由提交
        //   工具族声明 { area }，见文件头说明）

        // 置顶提示条滚动显示「调用了什么」。
        // 位置是刻意的：门 1-5 全通过、即将执行——被白名单/组开关拒掉的调用不改变
        // AE 状态，且外部客户端反复试探时会刷屏；那些调用由管理台日志留痕。
        // 放在执行前而非 reply 后：执行可能耗时数秒，提示应与动作开始对齐。
        // 异常隔离：指示器模块未加载/未挂载/内部抛错都不得影响派发主流程。
        try {
            if (global.AEExtIndicator && typeof global.AEExtIndicator.notifyToolCall === 'function') {
                global.AEExtIndicator.notifyToolCall(toolName);
            }
        } catch (_) {}

        // callerId 透传：预览区快照守卫按调用方分账——外接写入只刷新
        // 本客户端的读账，面板内 Agent 的陈旧读不会被外接的写入「洗白」（反之亦然）。
        // 按 clientId 细分：多客户端并发时各自记账，A 的写入不顶替 B 的读账。
        // （外接**不镜像 LLM 审查层**）
        // 面板侧的 `agentScriptReview`（UI 标签「工具代码审查」）是「AST 门之后、执行之前」的
        // 一次性 LLM 审查。外接曾接过一层（门 6b），但该层依赖**面板自己的 LLM 配置**：外接的设计
        // 前提是「外接客户端自带模型、面板不需要 LLM key」，一旦面板没配 key 或调用失败，外接的
        // executeExtendScript 就被一个它无关的依赖卡死。故回退为：
        // **外接只镜像确定性层（门 6 = AST 静态门 + 各工具 handler 自带的静态预检），
        //   不镜像 LLM 审查层。**
        // 与「面板缺 key 时面板自己 fail-closed」不冲突：面板用户就在 UI 前，能立刻处理。
        // 外接通道**没有面板停止语义**（面板的「停止」只 abort 面板自己那轮的 controller），
        // 故显式下发恒假判据：提交类工具（submit_script / submit_shader）的
        // handler 会优先读执行上下文里的停止判据——工具注册表 last-wins，若落到某条已停止
        // 的 runtime（团队 lane / 子 Agent）注册的那份 handler 且 ctx 缺判据，外接提交会被
        // 它的残留停止态误拒成 stopped（与面板内同族缺陷，见 toolExecutor.js 的 ctx 注释）。
        Promise.resolve(executor.execute(toolName, execArgs, execModuleId, 'ext:' + (msg.clientId || ''), {
            getStopRequested: function () { return false; },
            getAbortSignal: function () { return null; }
        })).then(function (result) {
            // 截图内联（getPreviewFrame / analyzeImage 抓帧模式）：读文件 → data URL 挂结果，
            // 失败不阻断（见上方注释）
            return inlineScreenshotImage(toolName, result);
        }).then(function (result) {
            // 外接结果图片对齐：结果里带 PNG data URL 时，在**发给外部客户端前**经
            // 共享转码（shared/imageTranscode.js）换成 JPEG（含超 4096×2160 等比缩放），
            // 与面板内 Agent 的图片投递同口径——不转码时同一个大图两条路
            // 拿到的大小/质量不同（外接直接送原始 PNG base64）。AE 截图即 PNG，故规则等价于
            // 面板内"读文件 → 转 JPEG"。只就地替换字符串，不动 result 其余字段与判据；
            // 转码失败/异常原样返回，绝不吞掉工具结果、不阻断执行链。
            var tx = global.AEImageTranscode;
            if (tx && typeof tx.transcodeResultImages === 'function' && result) {
                return tx.transcodeResultImages(result).then(
                    function () { return result; },
                    function () { return result; }
                );
            }
            return result;
        }).then(function (result) {
            // result 为 toolExecutor mcpResult 形态 {success, isError, content}
            // executeExtendScript 运行时错误行号：与面板管线镜像——回执 line 是重发射产物行，
            // 有 lineMap 时映射回原文行；content JSON 内的 line/lineBasis 同步改写。
            if (toolName === 'executeExtendScript' && _agLineMap && result
                && typeof result.line === 'number' && isFinite(result.line)) {
                var _xlSource = 0;
                if (global.AEGate && typeof global.AEGate.mapProductLine === 'function') {
                    try { _xlSource = global.AEGate.mapProductLine(_agLineMap, result.line); } catch (_) { _xlSource = 0; }
                    if (typeof _xlSource !== 'number' || !isFinite(_xlSource)) _xlSource = 0;
                }
                var _xlLine = _xlSource > 0 ? _xlSource : result.line;
                var _xlBasis = _xlSource > 0 ? 'source' : 'emitted';
                result.line = _xlLine;
                if (result.content && result.content[0] && typeof result.content[0].text === 'string') {
                    try {
                        var _xlParsed = JSON.parse(result.content[0].text);
                        if (_xlParsed && typeof _xlParsed === 'object' && !Array.isArray(_xlParsed)
                            && typeof _xlParsed.line === 'number') {
                            _xlParsed.line = _xlLine;
                            _xlParsed.lineBasis = _xlBasis;
                            result.content[0].text = JSON.stringify(_xlParsed);
                        }
                    } catch (_) {}
                }
            }
            var ok = !!(result && result.success !== false);
            var errText = '';
            // 错误文本上限（由 200 放宽到 2000）。
            // 原 200 字符是**头部截断**，而工具层刻意把诊断现场放在消息**末尾**——例：
            // getPreviewFrame 的 IEND 失败消息结尾是 `last: open=? len=? tail=?`，
            // aeTools.jsx 的注释明说加它是"使下次失败能自证机制"。头部截断正好把这段
            // 切掉，服务端又只用 msg.error（见 ext-mcp-server.js settleRelay），
            // 结果：该诊断自加入起从未被人看到过一次（实测收到的一律是
            // `…; las` 断在 `last: ` 前 4 个字符处）。
            // 错误消息本就有界（工具层自己构造，通常数百字符），2000 足以留全现场，
            // 同时仍是防止异常长文本撑爆通道的上限。日志侧另有 LOG_TEXT_MAX=4000。
            var ERR_TEXT_MAX = 2000;
            if (!ok && result && result.content && result.content[0] && result.content[0].text) {
                var et = String(result.content[0].text);
                errText = (et.length > ERR_TEXT_MAX)
                    ? (et.slice(0, ERR_TEXT_MAX) + '…（截断，原始 ' + et.length + ' 字符）')
                    : et;
            }
            // 库写成功 → origin=external 登记（库列表「外」徽标数据源）
            if (ok && libDetail) {
                try { recordLibOrigin(toolName, msg.args || {}, result, msg.clientId); } catch (_) {}
            }
            // 墙钟超时后迟到的结果不再被丢弃——写入已登记任务（成功/失败都存），
            // 外部客户端经 ext_task_get 取；不再二次回包（settled 终态唯一，reply 也会拦）。
            if (timedOutTask) { settleTask(timedOutTask, ok, result, errText); return; }
            reply(ok, result, errText);
        }).catch(function (e) {
            var em = 'EXEC_ERROR: ' + (e && e.message ? e.message : String(e));
            // 超时后迟到的异常同样落表（任务从 pending → failed，不再是无声挂起）
            if (timedOutTask) { settleTask(timedOutTask, false, null, em); return; }
            reply(false, null, em);
        });
    }

    // ── ext_check_request：外部确认表判定（两阶段确认之第一阶段）──
    function handleCheck(msg) {
        var policy = global.AEExternal && global.AEExternal.policy;
        if (!policy) {
            send({ type: 'ext_check_result', requestId: msg.requestId, ok: false, error: 'EXT_PANEL_NOT_READY' });
            return;
        }
        var verdict = policy.needsConfirmation(msg.tool, msg.args || {});
        send({
            type: 'ext_check_result',
            requestId: msg.requestId,
            ok: true,
            confirm: verdict.confirm === true,
            reason: verdict.reason || ''
        });
    }

    // ── ext_tools_request：组白名单投影（tools/list 数据源）──
    function handleToolsRequest(msg) {
        var tools = global.AEExternal && global.AEExternal.tools;
        var defs = tools ? tools.buildExternalToolDefs() : [];
        var instructions = '';
        try {
            if (global.AEExternalGuidelines && typeof global.AEExternalGuidelines.getInstructions === 'function') {
                instructions = global.AEExternalGuidelines.getInstructions();
            }
        } catch (_) {}
        send({
            type: 'ext_tools_result',
            requestId: msg.requestId,
            ok: true,
            tools: defs,
            instructions: instructions
        });
    }

    // ── 消息分发 ──
    function onMessage(event) {
        var msg;
        try { msg = JSON.parse(event.data); } catch (e) { return; }
        switch (msg.type) {
            case 'connected':            // Bridge 欢迎帧 → 注册面板身份
                send({ type: 'ext_panel_hello' });
                return;
            case 'ext_panel_ack':
                return;
            case 'ext_tools_request':
                handleToolsRequest(msg);
                return;
            case 'ext_check_request':
                handleCheck(msg);
                return;
            case 'ext_dispatch':
                handleDispatch(msg);
                return;
        }
    }

    // ── 连接生命周期 ──
    function connect() {
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try {
            // WS URL 附加 token query（浏览器
            // WebSocket 不能设自定义头，bridge 侧 upgrade 校验 URL query）。同步读
            // 上次缓存的 token（首次可能 null——首连被拒后重连即带上），并
            // fire-and-forget 刷新缓存（bridge 重启换新 token，下次连接生效）；
            // 无 token（AE 不可达/开发模式）不附加。
            var wsUrl = 'ws://' + BRIDGE_HOST + ':' + getPort();
            if (global.Bridge) {
                var _cachedT = (typeof global.Bridge.getCachedBridgeToken === 'function')
                    ? global.Bridge.getCachedBridgeToken() : null;
                if (_cachedT) wsUrl += '?token=' + encodeURIComponent(_cachedT);
                if (typeof global.Bridge.refreshBridgeToken === 'function') {
                    global.Bridge.refreshBridgeToken();   // 异步刷新，不阻塞本次连接
                }
            }
            ws = new WebSocket(wsUrl);
        } catch (e) {
            console.warn('[ext-bridge] create failed: ' + e.message);
            reconnectTimer = setTimeout(connect, RECONNECT_MS);
            return;
        }
        var selfWs = ws;

        ws.onopen = function () {
            if (ws !== selfWs) return;
            connected = true;
            notifyStatus();
        };
        ws.onmessage = onMessage;
        ws.onclose = function () {
            if (ws !== selfWs) return;
            connected = false;
            notifyStatus();
            reconnectTimer = setTimeout(connect, RECONNECT_MS);
        };
        ws.onerror = function () {
            try { selfWs.close(); } catch (_) {}
        };
    }

    // 策略变更 → 推送 ext_tools_changed（外部进程据此发 notifications/tools/list_changed）
    function notifyToolsChanged() {
        if (connected) send({ type: 'ext_tools_changed' });
    }

    global.AEExternal = global.AEExternal || {};
    global.AEExternal.bridgeClient = {
        connect: connect,
        notifyToolsChanged: notifyToolsChanged,
        isConnected: function () { return connected; },
        getCallLog: function () { return callLog.slice(); },
        clearCallLog: function () { callLog = []; },
        onLog: function (fn) { logListeners.push(fn); },
        // 环形上限 / 截断行为（视图增量渲染依赖 seq 单调递增）
        LOG_RING_MAX: LOG_RING_MAX,
        LOG_TEXT_MAX: LOG_TEXT_MAX,
        // 单次 dispatch 墙钟上限（对齐 relay EXT_CALL_MAX_MS）
        DISPATCH_TIMEOUT_MS: DISPATCH_TIMEOUT_MS,
        // 超时任务查询（ext_task_get 数据源）与工具注册（bootstrap 装配调用）
        registerExtTaskTool: registerExtTaskTool,
        getTaskView: getTaskView,
        getTaskList: function () { return taskTable.slice(); },
        TASK_KEEP_MAX: TASK_KEEP_MAX,
        TASK_TTL_MS: TASK_TTL_MS,
        // 清理注入 now（TTL 判据不依赖真实等待）
        _pruneTasks: pruneTasks,
        onStatus: function (fn) { statusListeners.push(fn); notifyStatus(); },
        // 库 origin 登记（外部写库条目标记，库列表「外」徽标数据源）
        getLibOrigin: getLibOrigin
    };
})(window);
