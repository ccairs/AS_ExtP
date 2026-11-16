(function(global) {

    // MCP 长调用任务表（面板侧，纯内存，随面板生命周期；面板重载即清空）。
    // 语义对齐外接侧 （extBridgeClient 的任务表）：保留最近 32 条**已完成**条目
    // （pending 一律保留，见 _sweep）/ 完成后 30 分钟惰性清理；结果文本按 32K 字符
    // 头+尾截断（见 clipTaskResult），表内存上界 ≈ 32 × 32K。
    // 触发场景：面板内 LLM 调用 MCP 工具超过同步等待窗（默认 90s）未返回 → 登记任务、
    // 回执 taskId，MCP 响应继续在后台等，结果到达后由 serverManager 注入对话。
    function createMcpTaskStore(config) {
        config = config || {};
        var maxEntries = (typeof config.maxEntries === 'number' && config.maxEntries > 0)
            ? config.maxEntries : 32;
        var completedTtlMs = (typeof config.completedTtlMs === 'number' && config.completedTtlMs > 0)
            ? config.completedTtlMs : 30 * 60 * 1000;
        var nowFn = (typeof config.now === 'function') ? config.now : function() { return Date.now(); };

        var _seq = 0;
        var _order = [];                             // 插入序的 taskId 列表（淘汰/清理用）
        var _tasks = Object.create(null);

        // 惰性清扫：完成超过 TTL 的条目删除；超出上限时**只淘汰已完成条目**——
        // pending 条目是纯元数据（结果尚未落表），且必在硬上限内 settle（send 超时兜底），
        // 淘汰它们等于静默丢结果（调用方已收到过"转后台"回执，永远等不到结果）。
        // 全是 pending 时不淘汰：表长受在途调用数约束（每个在途调用都有 settle 兜底）。
        // 与 （extBridgeClient）的刻意差异：那边极端溢出时连 pending 也淘汰（有界内存优先）；
        // 面板侧工具调用是**串行 await**（controller.js 的 toolCalls 循环逐条 await），
        // pending 至多 1 条量级，故宁可留元数据也不静默丢结果。
        function _sweep() {
            var now = nowFn();
            for (var i = _order.length - 1; i >= 0; i--) {
                var t = _tasks[_order[i]];
                if (t && t.status !== 'pending' && t.finishedAt && (now - t.finishedAt) >= completedTtlMs) {
                    delete _tasks[_order[i]];
                    _order.splice(i, 1);
                }
            }
            while (_order.length > maxEntries) {
                var victim = -1;
                for (var j = 0; j < _order.length; j++) {
                    var cand = _tasks[_order[j]];
                    if (cand && cand.status !== 'pending') { victim = j; break; }
                }
                if (victim < 0) break;
                delete _tasks[_order[victim]];
                _order.splice(victim, 1);
            }
        }

        function create(info) {
            info = info || {};
            _sweep();
            var id = 'mcptask_' + nowFn() + '_' + (++_seq);
            _tasks[id] = {
                id: id,
                status: 'pending',
                serverId: info.serverId || '',
                toolName: info.toolName || '',
                sessionId: info.sessionId || null,
                createdAt: nowFn(),
                finishedAt: 0,
                error: null,
                resultText: null
            };
            _order.push(id);
            _sweep();
            return id;
        }

        // 幂等：已完成任务重复 settle 不改写（迟到重复响应/超时与响应撞车时只认第一次）
        function settle(id, errText, text) {
            var t = _tasks[id];
            if (!t) return null;
            if (t.status !== 'pending') return t;
            t.status = errText ? 'failed' : 'done';
            t.finishedAt = nowFn();
            t.error = errText || null;
            // 落表即截断（与卡片同一策略）：表最多 32 条，条目文本上限 32K 字符 → 最坏 ~1MB；
            // 完整结果无处可读（无暂存通道），故不做"存全文但读不到"的假保留
            t.resultText = (typeof text === 'string') ? clipTaskResult(text) : null;
            _sweep();
            return t;
        }

        function get(id) {
            _sweep();
            return _tasks[id] || null;
        }

        function size() {
            _sweep();
            return _order.length;
        }

        return {
            create: create,
            settle: settle,
            get: get,
            size: size
        };
    }

    // 结果上限与截断策略：与 agent 工具结果同口径（`toolExecutionPipeline.js` 的
    // MAX_TOOL_RESULT_CHARS = 32*1024 **字符**、头 24K + 尾 8K）——这条通道绕过了工具
    // 管线（结果经 injectSystemResult 直接进上下文），上限只能自己把；不一致会往上下文里
    // 灌进数倍于其它工具结果的文本。尾部保留是刻意的：转写/日志类结果的有用信息常在结尾。
    var RESULT_MAX_CHARS = 32 * 1024;
    var RESULT_HEAD_CHARS = 24 * 1024;
    var RESULT_TAIL_CHARS = 8 * 1024;

    // 幂等：输出总长恒 ≤ 上限（头/尾按说明长度回收），故已截断文本再次调用原样返回
    function clipTaskResult(text) {
        var s = (typeof text === 'string') ? text : '';
        if (s.length <= RESULT_MAX_CHARS) return s;
        var note = '\n\n[MCP 后台结果过大已截断：原始 ' + s.length + ' 字符，此处保留头部 '
            + RESULT_HEAD_CHARS + ' + 尾部 ' + RESULT_TAIL_CHARS + ' 字符，中间省略；完整内容未保留]\n\n';
        var head = RESULT_HEAD_CHARS;
        var tail = RESULT_TAIL_CHARS;
        var overflow = (head + note.length + tail) - RESULT_MAX_CHARS;
        if (overflow > 0) {
            // 从头部扣（尾部语义更重要），头部扣完再扣尾部
            var cutHead = Math.min(head, overflow);
            head -= cutHead;
            overflow -= cutHead;
            if (overflow > 0) tail -= Math.min(tail, overflow);
        }
        return s.slice(0, head) + note + s.slice(s.length - tail);
    }

    // 结果卡片组装（纯函数，供 serverManager 注入与单测）：
    // 返回 { title, visible: { text }, detail: { text } | null }
    // - visible：常显区人话摘要（含 taskId 关联，截断）
    // - detail：完整结果（超上限按 clipTaskResult 头+尾截断并如实标注；LLM 读到的文本 =
    //   visible + detail，见 context.js「组装 system-result 消息的 LLM 文本内容」）
    var DEFAULT_LIMITS = {
        visibleMax: 400
    };

    function _clip(text, max) {
        var s = (typeof text === 'string') ? text : '';
        if (s.length <= max) return s;
        // 措辞只声明"保留了多少"，不声明总长（说明本身也会计入文本）
        return s.slice(0, max) + '\n…（结果过长，共 ' + s.length + ' 字符，仅显示前 ' + max + ' 字符）';
    }

    function formatTaskResultPayload(task, errText, text, limits) {
        var lim = limits || DEFAULT_LIMITS;
        var toolLabel = (task && task.toolName) ? task.toolName : '(未知工具)';
        var serverLabel = (task && task.serverId) ? ('[' + task.serverId + '] ') : '';
        if (errText) {
            return {
                title: AEI18n.t('MCP 工具后台执行失败'),
                visible: { text: serverLabel + toolLabel + '：' + _clip(errText, lim.visibleMax) },
                detail: null
            };
        }
        var body = clipTaskResult((typeof text === 'string') ? text : '');
        return {
            title: AEI18n.t('MCP 工具后台执行完成'),
            visible: {
                text: serverLabel + toolLabel + '（后台完成'
                    + (task && task.id ? '，taskId=' + task.id : '')
                    + '）：' + _clip(body, lim.visibleMax)
            },
            detail: { text: body }
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createMcpTaskStore = createMcpTaskStore;
    global.AE_LLM.formatMcpTaskResultPayload = formatTaskResultPayload;
    global.AE_LLM.clipMcpTaskResult = clipTaskResult;

})(window);
