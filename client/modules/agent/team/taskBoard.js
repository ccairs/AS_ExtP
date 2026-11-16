(function (global) {
    'use strict';
    // 任务板快照组装：**纯函数** ——
    // lane 定义 + 各 lane runtime + 时钟 → 快照对象。无 DOM、无 IO、无全局读写（除取一次判据函数）。
    //
    // 为什么必须是纯函数：任务板是「哪个 Agent 在跑、在跑什么、跑多久」的唯一数据源，
    // 单测要能构造三种假态直接断言（不必起 orchestrator、不必碰 DOM、不必等定时器）。
    //
    // 为什么状态判据**必须复用** orchestrator 的 deriveLaneStatus（`opts.deriveStatus` 注入，
    // 缺省取 `global.AEAgentTeam.deriveLaneStatus`）：另写一份必然漂移——例如一处把 lastError
    // 优先于 busy、另一处相反，任务板与停止按钮就会互相打脸（同一时刻两种「在跑」判定）。
    //
    // 快照形状（契约冻结）：
    //   { lanes: [{ id, label, status, busyText, toolName, elapsedMs, subagentCount }],
    //     subagents: [] }  // 子 Agent 段；items 段已下线
    // 另：判据函数缺失时**不假装空闲**，而是给出 `degraded: true`（见下）——任务板显示
    // 「状态不可用」比显示「全部空闲」诚实：后者会让用户以为三条 lane 都没在跑。

    // 读时才翻译：顶层求值会在无 AEI18n 的沙箱抛 ReferenceError。
    var FALLBACK_ROW = { status: 'idle', get busyText() { return AEI18n.t('空闲'); }, toolName: '', elapsedMs: 0, subagentCount: 0 };

    function _deriveOf(input) {
        if (input && typeof input.deriveStatus === 'function') return input.deriveStatus;
        if (global.AEAgentTeam && typeof global.AEAgentTeam.deriveLaneStatus === 'function') {
            return global.AEAgentTeam.deriveLaneStatus;
        }
        return null;
    }

    // 「本 lane 的在跑子 Agent 数」：**从入参的池行现算**。
    // 为什么必须在这里算（而不是读运行时的 `runtime.subagents`）：那条路**全仓没有赋值点** ⇒
    // 恒 0；而 UI 的计数格读的正是本函数产出的这一行（`orch.getBoardSnapshot().lanes` 在生产里
    // **无人消费**——上一轮把修复打在了那个产出上，UI 依旧恒空）。判据复用 `isSubagentActive`
    // 这一份（同一文件），不写第二张活跃表。
    function _countSubagentsForLane(subs, laneId) {
        if (!laneId || !subs || !subs.length) return 0;
        var n = 0;
        for (var i = 0; i < subs.length; i++) {
            var r = subs[i] || {};
            if (r.parentLane !== laneId) continue;
            if (!isSubagentActive(r)) continue;
            n++;
        }
        return n;
    }

    function _row(def, st, subs) {
        var s = st || FALLBACK_ROW;
        return {
            id: def.id,
            label: def.label || def.id,
            status: s.status,
            busyText: s.busyText,
            toolName: s.toolName || '',
            elapsedMs: (typeof s.elapsedMs === 'number' && isFinite(s.elapsedMs) && s.elapsedMs > 0) ? s.elapsedMs : 0,
            // 计数以**池行**为准（入参 subs）；运行时的 subagentCount 只作为兼容兜底
            //（老调用方若仍给 runtime.subagents，这里也认——但它恒 0，故不作为主来源）。
            subagentCount: _countSubagentsForLane(subs, def.id)
                || ((typeof s.subagentCount === 'number' && s.subagentCount > 0) ? s.subagentCount : 0)
        };
    }

    function buildBoardSnapshot(input) {
        var o = input || {};
        var derive = _deriveOf(o);
        var now = (typeof o.now === 'number') ? o.now : Date.now();
        var defs = o.lanes || [];
        var runtimes = o.runtimes || {};
        var subs = o.subagents || [];
        var rows = [];
        for (var i = 0; i < defs.length; i++) {
            var def = defs[i] || {};
            // 未启动的 lane（runtimes 里没有）也出一行：UI 上三条 lane 恒在，
            // 缺行会让「切到某 lane」的索引与展示错位。
            rows.push(_row(def, derive ? derive(runtimes[def.id], now) : null, subs));
        }
        var snapshot = {
            lanes: rows,
            // 副本：任务板与调用方（UI/测试）不得共享同一数组，否则一处 push 会污染另一处
            subagents: subs.slice()
        };
        if (!derive) snapshot.degraded = true;   // 判据缺失：UI 应显示「状态不可用」而不是「全部空闲」
        return snapshot;
    }

    // 耗时文案的唯一格式化处（快照只给 elapsedMs 字段，秒数由这里拼——两处格式化必然不同步）。
    // 0 / 非法 ⇒ '--'：**不编造**耗时（「正在跑 0s」比「没有时间」更容易被误读）。
    function formatElapsed(ms) {
        if (typeof ms !== 'number' || !isFinite(ms) || ms <= 0) return '--';
        var s = Math.floor(ms / 1000);
        if (s < 60) return s + 's';
        var m = Math.floor(s / 60);
        if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
        var h = Math.floor(m / 60);
        return h + 'h' + String(m % 60).padStart(2, '0') + 'm';
    }

    // ── 工作项视图**已下线** ────────────────────
    // 派单不再有状态机（一次投递 + 对方完成后自己 send_message 回来），任务板也没有工作项段了 ⇒ 那张
    // ITEM_STATES 文案表与 deriveItemView 一并删除：没有消费者时留着它只会让下一个人以为
    // 「工作项还有状态可显示」。下面的 _itemStr 仍被子 Agent 视图用，故保留。

    // null/undefined → ''：不写 'null'/'undefined' 这类会把用户引到错误结论上的字面量
    function _itemStr(v) {
        return (v === null || v === undefined) ? '' : String(v);
    }

    // ── 子 Agent 视图 ─────────────
    // 子 Agent 的状态 → 文案 / 类名：**唯一一份**。两个渲染面（发起者 lane 消息流里的内联卡片、
    // 任务板第 3 段）都经这里取文案，谁都不再写第二张表。
    var SUBAGENT_STATES = {
        queued: { get text() { return AEI18n.t('排队中'); }, cls: 'is-queued' },
        running: { get text() { return AEI18n.t('执行中'); }, cls: 'is-running' },
        waiting: { get text() { return AEI18n.t('保活中'); }, cls: 'is-waiting' },
        done: { get text() { return AEI18n.t('已完成'); }, cls: 'is-done' },
        failed: { get text() { return AEI18n.t('已失败'); }, cls: 'is-failed' },
        stopped: { get text() { return AEI18n.t('已停止'); }, cls: 'is-stopped' }
    };

    // token 计数 → 一行文本。契约：`tokens` 是总数（number）或 `{ prompt, completion }`。
    // 两种形态都如实展示；拿不到 ⇒ 空串——**不编造计数**：
    //   · 数字形态的 0 视同「还没有计数」（池里的初值就是 0）：显示「0」会被读成「已经用了 0 个」；
    //   · 对象形态只要给了数字字段就照原样（包括 0）——那是明确的数据，不是缺失。
    function _tokensText(tokens) {
        if (typeof tokens === 'number') {
            return (isFinite(tokens) && tokens > 0) ? String(tokens) : '';
        }
        if (tokens && typeof tokens === 'object') {
            var up = (typeof tokens.prompt === 'number' && isFinite(tokens.prompt)) ? tokens.prompt : null;
            var down = (typeof tokens.completion === 'number' && isFinite(tokens.completion)) ? tokens.completion : null;
            if (up === null && down === null) {
                return (typeof tokens.total === 'number' && isFinite(tokens.total) && tokens.total > 0)
                    ? String(tokens.total) : '';
            }
            return '↑' + (up || 0) + ' ↓' + (down || 0);
        }
        return '';
    }

    // 子 Agent → 卡片/一行的视图（**纯函数**）：key（子 Agent id，节点复用的判据）/
    // title / stateText / stateClass / elapsedText / tokensText。卡片与任务板行都由它派生——
    // 两处各取一半字段就会出现「卡片写了耗时、板上没有」这类没人能一眼看穿的漂移。
    // 耗时走 formatElapsed（全项目唯一那处格式化），本函数不自己拼 '12s'。
    function deriveSubagentView(row) {
        var r = row || {};
        var state = _itemStr(r.state);
        var known = Object.prototype.hasOwnProperty.call(SUBAGENT_STATES, state);
        return {
            key: _itemStr(r.id),
            title: _itemStr(r.title),
            // 未知 state **显示原值**（不抛错、也不猜成某个已知态）：猜错会把用户引到错的处置上
            stateText: known ? SUBAGENT_STATES[state].text : state,
            // 未知/缺失 ⇒ is-unknown：视觉上不冒充任何已知态（已知态各有专用色，见 agent.css）
            stateClass: known ? SUBAGENT_STATES[state].cls : 'is-unknown',
            elapsedText: formatElapsed(r.elapsedMs),
            tokensText: _tokensText(r.tokens)
        };
    }

    // 「这一行算不算**在跑 / 保活中**」——字面口径（表格只列在跑与保活中的
    // 子 Agent）。**判据放在这里**（与状态文案同一处）：UI 若自己写一份「哪些 state 算活跃」，
    // 就成了第二份判据源——将来加状态（比如「等待用户确认」）必然一处改、一处漏。
    // 卡片**不过滤**（消息流里的历史要有终态卡片），只有任务板那一段用它。
    var SUBAGENT_ACTIVE_STATES = { queued: true, running: true, waiting: true };
    function isSubagentActive(row) {
        var state = _itemStr((row || {}).state);
        return SUBAGENT_ACTIVE_STATES[state] === true;
    }

    // ── 任务变化 → 导演通知 ─────────────────────────────
    // 纯函数：装配层把「谁改了什么」交给这里，返回通知卡的内容；null = 不通知。
    // 通知时机（决定是否值得唤醒导演一轮）：
    //   · 发起者是导演 ⇒ null（自己改的不自唤醒，否则每次维护清单都白跑一轮）；
    //   · set_status 只报**终态**变更（done / failed）：开工标 running 不唤醒——
    //     那是执行侧照分工自己标记，导演不需要为此跑一轮；
    //   · add / replace 是结构变化（新增条目 / 整表重写），一并通知；
    //   · 无有效变化 ⇒ null。
    // 状态用工具的枚举原文（done / failed / pending / running），不另造一套文案。
    var TASK_TERMINAL_STATUSES = { done: true, failed: true };
    var TASK_CHANGE_MAX_LINES = 8;
    function _taskChangeLine(item) {
        var it = item || {};
        var num = (typeof it.number === 'number' && it.number > 0) ? ('#' + it.number) : '#?';
        var st = (typeof it.status === 'string' && it.status) ? it.status : '';
        var desc = (typeof it.description === 'string') ? it.description : '';
        return num + (st ? ' ' + st : '') + (desc ? ' · ' + desc : '');
    }
    function _taskChangeLines(items) {
        var out = [];
        for (var i = 0; i < items.length && i < TASK_CHANGE_MAX_LINES; i++) out.push(_taskChangeLine(items[i]));
        if (items.length > TASK_CHANGE_MAX_LINES) {
            out.push(AEI18n.t('…（另 {n} 条）', { n: items.length - TASK_CHANGE_MAX_LINES }));
        }
        return out.join('\n');
    }
    function buildTaskChangeNotice(change) {
        var c = change || {};
        var action = (typeof c.action === 'string') ? c.action : '';
        var by = (typeof c.by === 'string') ? c.by : '';
        if (!action || !by || by === 'director') return null;
        var byLabel = (typeof c.byLabel === 'string' && c.byLabel) ? c.byLabel : by;
        if (action === 'set_status') {
            var items = Array.isArray(c.items) ? c.items : [];
            var terminal = [];
            for (var i = 0; i < items.length; i++) {
                var it = items[i] || {};
                if (TASK_TERMINAL_STATUSES[String(it.status)] === true) terminal.push(it);
            }
            if (!terminal.length) return null;
            return {
                title: AEI18n.t('团队任务更新'),
                text: AEI18n.t('「{by}」更新了团队任务状态：\n{lines}', { by: byLabel, lines: _taskChangeLines(terminal) })
            };
        }
        if (action === 'add') {
            var added = Array.isArray(c.items) ? c.items : [];
            if (!added.length) return null;
            return {
                title: AEI18n.t('团队任务更新'),
                text: AEI18n.t('「{by}」新增 {n} 条团队任务：\n{lines}', { by: byLabel, n: added.length, lines: _taskChangeLines(added) })
            };
        }
        if (action === 'replace') {
            var count = (typeof c.count === 'number' && c.count >= 0) ? c.count : 0;
            return { title: AEI18n.t('团队任务更新'), text: AEI18n.t('「{by}」重写了团队任务清单（{n} 条）。', { by: byLabel, n: count }) };
        }
        return null;
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.buildBoardSnapshot = buildBoardSnapshot;
    global.AEAgentTeam.buildTaskChangeNotice = buildTaskChangeNotice;
    global.AEAgentTeam.deriveSubagentView = deriveSubagentView;
    global.AEAgentTeam.isSubagentActive = isSubagentActive;
    // 活跃状态表也导出：判据面缺席时 orchestrator 要**复用同一张表**，
    // 不允许它再列一遍三态白名单（两份名单必然在加状态时分叉）。
    global.AEAgentTeam.SUBAGENT_ACTIVE_STATES = SUBAGENT_ACTIVE_STATES;
    global.AEAgentTeam.formatElapsed = formatElapsed;
    // 团队任务（updateTeamTasks 写的那份清单）的状态文案：**唯一一份**，放在这里而不是 UI 里
    // ——teamUI 有静态校验（「面板源码里不得出现第二份状态文案」，防子 Agent 状态
    // 文案被整份复制），任务文案同样是「谁显示谁负责」的形态，统一收在这张表里。
    global.AEAgentTeam.TASK_STATUS_TEXT = {
        get pending() { return AEI18n.t('待办'); },
        get running() { return AEI18n.t('进行中'); },
        get done() { return AEI18n.t('已完成'); },
        get failed() { return AEI18n.t('失败'); }
    };
})(typeof global !== 'undefined' ? global : window);
