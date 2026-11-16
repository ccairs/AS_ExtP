(function (global) {
    'use strict';
    // 团队域工具注册（teamTools schema 契约）：
    //   `read_workspace`（**只读**，读团队工作区里的文本文件，缺省 brief.md）；
    //   `write_workspace`（写工作区，replace 覆盖 / append 追加）
    //     + `dispatch_task`（把一件工作派给另一条 lane，实现由 orchestrator 注入）；
    //   `spawn_subagent`（派生子 Agent）/ `list_agents`（名册+状态）。
//   `send_message`（lane / 子 Agent 一个入口；团队主通道已移除）。
    //
    // 为什么 team 域就**必须**有工具：三条 lane 的工具身份是集合，成员里都带 'team'
    //（lanes.js：导演/AE 执行 [agent,team]、GLSL [shader,team]）。域为空时，「并联身份把 team
    // 工具放进投放清单」这类断言会**空转**（拿不到任何东西可断言），工具集合就失去可观测性。
    //
    // 注册形状与 shared/platformTools.js 的 initXxxTools 同款：**由装配侧调用**，本文件不自执行
    // 注册——模块加载即注册会让审计与单测无法控制注册时机，
    // 也没法注入假工作区/假会话 id。登记同步：新 team 域工具必须进
    // 装配级注册点清单，否则注册点一致性检查会失败。
    //
    // opts 契约：
    //   toolRegistry      — 必填。缺则**显式失败**（不静默跳过：装配侧必须知道工具没进去）。
    //   workspace         — 必填，team/workspace.js 的实例（AEAgentTeam.createWorkspace 产出）。
    //                       缺则整件工具不注册——向 LLM 暴露一件永远报错的工具，比不暴露更糟
    //                       （模型会反复重试，还把"内部没装配"误读成"路径写错了"）。
    //   getTeamSessionId  — 当前团队会话 id 的来源（函数或字符串）。团队会话 id 是工作区的定位
    //                       依据（<数据Dir>/agent/team/<id>/），由 sessionBinder/orchestrator 侧
    //                       提供；拿不到时工具**显式报错**，绝不去猜一个目录读文件。
    //   dispatch          — 派单实现（`dispatchTask`，由 engine/bootstrap 注入；实现住在
    //                       缺席时对应的工具**不注册**：暴露一件永远报错的工具比
    //                       不暴露更糟（模型会反复重试，还把"内部没装配"误读成"参数写错了"）。
    //                       handler 只做**参数形态**校验后原样委托 `dispatch(args, ctx)`——
    //                       lane 合法性（含"不能派给自己"）由 dispatch 实现判，工具层再列一份
    //                       lane 白名单就是第二个判据源。
    //   subagents         — 子 Agent 池实例（`createSubagentPool` 产出，由
    //                       engine/bootstrap 装配期建并注入）。缺席（S1 未落地 / 装配失败）时
    //                       `spawn_subagent` **不注册**
    //                       ——同上：不暴露永远报错的工具。handler 不自行判权限、不自行判并发
    //                       （并发闸/保活/id 规则全在池里那一份），也不回落"当前 lane"：
    //                       来源 lane 只认 ctx.laneId。
    // 注册结果如实返回 { ok, registered:[…] }：少一件就是少一件（不假装三件都在）。
    //
    // 权限：handler **不自行判权限**，也不绕过任何闸。可见性/收窄由 toolRegistry（scope +
    // lane 收窄判据）与 toolExecutor.checkAccess（执行侧最后防线）负责，handler 只做"读工作区"
    // 这一件事——在 handler 里再判一遍权限只会造出第二个判据源（面板放行、工具拒绝之类的分叉）。
    // handler 的第二参 ctx（toolExecutor 传的 {moduleId, moduleIds, callerId, laneId}）本工具
    // 不需要：它读的文件由**团队会话**决定，与调用 lane 无关（三条 lane 共享同一工作区）。

    // 失败原因的**面向模型**文案：模型据此自我纠正（尤其越界那条——它必须知道"绝对路径不行、
    // 要用相对路径"，否则会拿着上一次回执里的绝对路径反复重试）。
    // 文案里的工作区文件名一律留**槽位**（FILE_SLOT），调用时用装配期从工作区文件表派生的值填充
    //（见 _fillFileName）：文件名只在 workspace.js 那张表里写一次，文案里不抄第二份。
    var FILE_SLOT = '{缺省文件}';
    var FILE_SLOT_OPTIONAL = '（如 ' + FILE_SLOT + '）';

    // 填充文件名槽位：拿到派生值就填；拿不到（桩实例/旧实例）就把整个可选括号片段去掉——
    // 绝不把 undefined 拼进模型可见文案（显示「如 undefined」比不显示更糟）。
    function _fillFileName(text, defName) {
        if (typeof text !== 'string' || text.indexOf(FILE_SLOT) < 0) return text;
        if (defName) return text.split(FILE_SLOT).join(defName);
        return text.split(FILE_SLOT_OPTIONAL).join('');
    }

    var FAIL_TEXT = {
        out_of_bounds: '路径越界：read_workspace 只接受工作区内的相对路径' + FILE_SLOT_OPTIONAL + '，'
            + '绝对路径与含 .. 的路径一律拒绝。请改用相对路径重试。',
        bad_path: '路径形态非法',
        bad_session_id: '团队会话 id 非法或缺失（工作区无法定位）',
        no_data_dir: '数据目录不可用（面板还没拿到数据根）',
        no_fs: '文件系统不可用（AEFS 未注入）',
        no_read: '文件系统不可用（AEFS 缺读取能力）',
        not_found: '工作区里没有这个文件（文件不存在，不是空文件）',
        not_allowed: '不在工作区文件表里',
        rejected: '路径被数据层拒绝',
        read_failed: '文件读取失败',
        // 队列层：enqueueWrite 的第二参不是函数（core 层回 bad_handler，工具层不会走到，但域要齐）
        bad_handler: '写入回调必须是函数（工作区队列的契约）'
    };

    function _failureText(reason, reqPath, detail, defName) {
        var head = _fillFileName(FAIL_TEXT[reason] || ('读取失败（' + reason + '）'), defName);
        return head + (detail ? '：' + detail : '')
            + ((typeof reqPath === 'string' && reqPath) ? ('（请求的 path: ' + reqPath + '）') : '');
    }

    // 写面的失败文案（同款口径，另加**写面特有**的可自纠项：内容类型 / 超限 / mode）。
    // 写面比读面更需要「改用什么重试」——一次写错就是白写一遍文件；而「超限」这类失败
    // 模型自己想不到出路（拆成多次 append 或分文件），必须由文案给出。
    var WRITE_FAIL_TEXT = {
        out_of_bounds: '路径越界：write_workspace 只接受工作区内的相对路径' + FILE_SLOT_OPTIONAL + '，'
            + '绝对路径与含 .. 的路径一律拒绝。请改用相对路径重试。',
        bad_path: '路径形态非法（空路径、纯点段，或段里含 : < > " | ? * 等非法字符）',
        bad_session_id: '团队会话 id 非法或缺失（工作区无法定位）',
        no_data_dir: '数据目录不可用（面板还没拿到数据根）',
        no_fs: '文件系统不可用（AEFS 未注入）',
        no_write: '文件系统不可用（AEFS 缺写能力）',
        no_read: '文件系统不可用（append 需要先读回现有内容，而 AEFS 缺读取能力）',
        no_mkdir: '文件系统不可用（AEFS 缺 mkdir，无法保证父目录存在）',
        bad_mode: 'mode 只接受 replace（覆盖，缺省）或 append（追加）',
        bad_content: 'content 必须是字符串，不接受数字/数组/对象/null',
        too_large: '内容超过单次写入上限',
        mkdir_failed: '写前建父目录失败（目录不可写 / 盘满 / 路径被拒）',
        write_failed: '文件写入失败',
        rejected: '路径被数据层拒绝（写入未发生）',
        read_failed: 'append 前读回现有内容失败（这次写入没有发生）',
        not_found: '工作区内没有这个文件',
        not_allowed: '不在工作区文件表里',
        read_only: '这个工作区文件是只读的（表里 writable=false）'
    };

    function _writeFailureText(reason, reqPath, detail, defName) {
        var head = _fillFileName(WRITE_FAIL_TEXT[reason] || ('写入失败（' + reason + '）'), defName);
        return head + (detail ? '：' + detail : '')
            + ((typeof reqPath === 'string' && reqPath) ? ('（请求的 path: ' + reqPath + '）') : '');
    }


    // null/undefined → ''：不写 'null'/'undefined' 这类会把模型引到错误结论上的字面量
    //（与 taskBoard 的 _itemStr 同口径；本文件不引用 UI 层的 helper）。
    function _statusStr(v) {
        return (v === null || v === undefined) ? '' : String(v);
    }



    // 工作区写能力的**装配期**判据：ws.write 在位 +（若实例带探测口）canWrite() 为真。
    // 没有探测口（旧实例/桩实例）时不越权替它下结论——调用时 write() 自己会显式 no_write。
    // 这一处只是「别注册一件永远报错的工具」，真判据仍在 workspace 的 _writeCap。
    function _workspaceWritable(ws) {
        if (!ws || typeof ws.write !== 'function') return false;
        if (typeof ws.canWrite === 'function') {
            try { return ws.canWrite() === true; } catch (_) { return false; }
        }
        return true;
    }

    // 工作区**缺省文件名**（read_workspace 省略 path 时读哪个）：同样从工作区文件表派生
    //（defaultRead 那一行，见 workspace.js 的表），表给不出时回退实例自报的 DEFAULT_FILE。
    // 两者都拿不到（桩实例 / 旧实例）返回 ''，由调用方各自给一句中性措辞——工作区文件名只在
    // 那张表里写一次：模型可见文案里不抄字面量，也不把 undefined 拼进去。
    function _workspaceDefaultFile(ws) {
        var name = '';
        try {
            if (ws && typeof ws.listFiles === 'function') {
                var files = ws.listFiles() || [];
                for (var i = 0; i < files.length; i++) {
                    var f = files[i];
                    if (f && f.defaultRead === true && typeof f.name === 'string' && f.name) { name = f.name; break; }
                }
            }
            if (!name && ws && typeof ws.DEFAULT_FILE === 'string') name = ws.DEFAULT_FILE;
        } catch (_) { name = ''; }
        return name;
    }

    // 写面「缺 path」的文案：读面的缺省文件名是**派生的**，这里按派生结果拼（拿不到时用中性措辞，
    // 文案里不留字面量、也不留 undefined）。
    function _writePathRequiredText(defName) {
        var head = 'path 必填：write_workspace 不替调用方猜目标文件';
        if (defName) {
            return head + '（读面缺省 ' + defName + '，写面照抄该缺省就会误覆盖任务书）。'
                + '请显式给出工作区内的相对路径（如 ' + defName + '）。';
        }
        return head + '（读面另有一个缺省文件，写面照抄那个缺省就会误覆盖任务书）。'
            + '请显式给出工作区内的相对路径。';
    }

    function _json(payload) {
        return JSON.stringify(payload);
    }

    function _errorResult(code, message, extra) {
        var payload = { status: 'error', code: code, message: message };
        if (extra) {
            for (var k in extra) {
                if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
            }
        }
        return { success: false, result: _json(payload) };
    }

    // 当前团队会话 id：函数（每次调用都问一次——会话可以在两轮之间被切换）或字符串（单测）都接受。
    function _currentSessionId(src) {
        if (typeof src === 'function') {
            try { src = src(); } catch (_) { return ''; }
        }
        return (typeof src === 'string') ? src.trim() : '';
    }

    // read_workspace 的 handler 工厂。
    // 签名固定为 handler(args, ctx)——ctx 是 toolExecutor 透传的执行上下文
    //（{ moduleId, moduleIds, callerId, laneId }）。本工具**不需要** ctx：读哪个文件由
    // 团队会话决定（三条 lane 共享同一工作区，与调用 lane 无关）。参数保留是为了让契约显式：
    // 接入方按 ctx 语义调用即可，写工具会在这里消费 laneId/callerId 做占用与分账。    // read_workspace 的 handler 工厂。
    // 签名固定为 handler(args, ctx)——ctx 是 toolExecutor 透传的执行上下文
    //（{ moduleId, moduleIds, callerId, laneId }）。本工具**不需要** ctx：读哪个文件由
    // 团队会话决定（三条 lane 共享同一工作区，与调用 lane 无关）。参数保留是为了让契约显式：
    // 接入方按 ctx 语义调用即可，写工具会在这里消费 laneId/callerId 做占用与分账。
    function buildReadWorkspaceHandler(opts) {
        var o = opts || {};
        // 失败文案里的文件名示例按工作区层派生（文件名只在工作区那张表里写一次）。
        var defName = _workspaceDefaultFile(o.workspace);
        return function (args, ctx) {   // ctx 见上：有意不消费（签名保留是为了契约显式）
            var ws = o.workspace || null;
            if (!ws || typeof ws.read !== 'function') {
                return _errorResult('infra_error', '团队工作区未装配（workspace 未注入），read_workspace 当前不可用。');
            }
            var sid = _currentSessionId(o.getTeamSessionId);
            if (!sid) {
                return _errorResult('no_team_session',
                    '团队会话尚未建立：工作区还没有定位依据（<数据目录>/agent/team/<团队会话id>/）。'
                    + '请先在团队面板创建或切换一个团队会话，再读取工作区。');
            }
            // path 缺省由工作区层落实（undefined/null/空串 ⇒ 表里的缺省文件）；这里只做透传，
            // 不在工具层再造一份缺省值（两处缺省就是两个真相源）。
            var reqPath = (args && args.path !== undefined && args.path !== null) ? args.path : '';
            return Promise.resolve(ws.read(reqPath, sid)).then(function (r) {
                if (!r || r.ok !== true) {
                    var reason = (r && r.reason) || 'read_failed';
                    return _errorResult(reason, _failureText(reason, reqPath, r && r.message, defName),
                        { path: (r && r.path) || '' });
                }
                var payload = {
                    status: 'success',
                    // path 是**绝对路径**（人/其它工具用）；rel 是**相对路径**——下次调 read_workspace
                    // 必须继续用它（回执里给出绝对路径，模型很容易拿它回填而撞上"绝对路径被拒"）。
                    path: r.path,
                    rel: r.rel,
                    content: r.content,
                    truncated: r.truncated === true,
                    size: r.size
                };
                if (payload.truncated) {
                    payload.message = '内容超过单次读取上限，已截断：本次只返回文件前 ' + r.content.length
                        + ' 个字符（文件共 ' + r.size + ' 个字符，truncated=true）。';
                }
                return { success: true, result: _json(payload) };
            });
        };
    }

    // write_workspace 的 handler 工厂。与读面同款：handler **不自行判权限**，
    // 只把 args 翻译成工作区层的一次调用，再把 Result 翻成 LLM 回执。
    // 与读面**唯一的有意差别**：path 必填。读面缺省 brief.md；写面照抄那个缺省就会把任务书
    // 误覆盖成别的内容——写面绝不去"猜一个目标"。
    function buildWriteWorkspaceHandler(opts) {
        var o = opts || {};
        // 缺省文件名按工作区层派生（读面缺省哪个文件由那张表说了算）：文案里不抄字面量。
        var defName = _workspaceDefaultFile(o.workspace);
        return function (args, ctx) {   // ctx 同读面：同样不消费（工作区由团队会话定位，与 lane 无关）
            var ws = o.workspace || null;
            if (!ws || typeof ws.write !== 'function') {
                return _errorResult('infra_error', '团队工作区写面未装配（workspace.write 不在），write_workspace 当前不可用。');
            }
            var sid = _currentSessionId(o.getTeamSessionId);
            if (!sid) {
                return _errorResult('no_team_session',
                    '团队会话尚未建立：工作区还没有定位依据（<数据目录>/agent/team/<团队会话id>/）。'
                    + '请先在团队面板创建或切换一个团队会话，再写工作区。');
            }
            var a = args || {};
            if (typeof a.path !== 'string' || !a.path.trim()) {
                return _errorResult('bad_path', _writePathRequiredText(defName));
            }
            // content / mode 的判据都在工作区层（唯一判据源）：这里只透传，不在工具层再造一份。
            return Promise.resolve(ws.write(a.path, a.content, { mode: a.mode, teamSessionId: sid })).then(function (r) {
                if (!r || r.ok !== true) {
                    var reason = (r && r.reason) || 'write_failed';
                    return _errorResult(reason, _writeFailureText(reason, a.path, r && r.message, defName),
                        { path: (r && r.path) || '' });
                }
                return {
                    success: true,
                    result: _json({
                        status: 'success',
                        // path 是绝对路径（人/其它工具用）；rel 是相对路径——下次写同一个文件继续用
                        // rel（拿回执里的绝对路径回填会撞上"绝对路径被拒"）。
                        path: r.path,
                        rel: r.rel,
                        bytes: r.bytes,
                        mode: r.mode
                    })
                };
            });
        };
    }

    // spawn 回执的构造（两条路径共用）：`done` 为 null = 未阻塞（wait 缺省）；否则是池的终态结果。
    // parentLane 由调用方传（池的成功回执只有 { ok, id, state }，不回 parentLane——工具层有权威值，
    // 就不该再从池的返回体里读一个可能缺席的字段）。
    function _spawnPayload(spawnRes, done, wait, parentLane) {
        var d = done || {};
        var state = (typeof d.state === 'string' && d.state) ? d.state : spawnRes.state;
        var payload = { status: 'success', id: spawnRes.id, state: state, parentLane: parentLane };
        var summary = (typeof d.summary === 'string' && d.summary) ? d.summary : '';
        payload.waited = !!(wait && summary);
        if (summary) payload.summary = summary;
        if (d.tokens !== undefined) payload.tokens = d.tokens;
        if (done && done.ok === false) {
            // 阻塞等到了失败：如实回失败体（不把它当成功回执——模型会以为子 Agent 干完了）。
            // state 也如实带上：failed 是终态，重试要重新 spawn。
            var reason = (typeof d.reason === 'string' && d.reason) ? d.reason : 'error';
            return _errorResult(reason, _subagentFailureText(reason, d.message, 'id: ' + spawnRes.id + '，state: ' + state));
        }
        if (payload.waited) {
            payload.hint = '子 Agent 已完成：上面就是它的结论。需要继续追问就用 send_message（target 填它的 id，保活窗口内）。';
        } else if (wait) {
            payload.hint = 'wait=true 但池未返回摘要（子 Agent 可能仍在跑）：用 list_agents 查状态、send_message 追问。';
        } else {
            payload.hint = '已派出：它在后台跑，跑完会自动把结论回投给你。'
                + '需要它继续做事用 send_message（target 填它的 id）。';
        }
        return { success: true, result: _json(payload) };
    }

    // list_agents 的 handler 工厂：**名册 + 状态一个出口**。
    // 三段数据各有唯一来源：lane 行 ← 注入的 roster()（编排面 getBoardSnapshot().lanes，与任务板
    // 同一份判据）；子 Agent 行 ← 池的 list()（字段原样透传）。在途消息段随完成回投
    // 下线一起删除（消息不再有「等结论回来」的状态）。
    // 池缺席 ⇒ agents 只有 lane 行（不整件失败：名册本身仍然有用）。
    function buildListAgentsHandler(opts) {
        var o = opts || {};
        return function () {
            if (typeof o.roster !== 'function') {
                return _errorResult('infra_error', '团队名册读取口未注入（opts.roster 未注入），list_agents 当前不可用。');
            }
            var st = null;
            try {
                st = o.roster();
            } catch (e) {
                return _errorResult('error', 'list_agents 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
            }
            if (!st || st.ok !== true) {
                return _errorResult((st && st.reason) || 'error', (st && st.message) || '团队名册不可用。');
            }
            var lanes = (st.lanes && st.lanes.length) ? st.lanes : [];
            var agents = [];
            for (var i = 0; i < lanes.length; i++) {
                var L = lanes[i] || {};
                agents.push({
                    target: _statusStr(L.id), kind: 'agent', name: _statusStr(L.label) || _statusStr(L.id),
                    status: _statusStr(L.status), busy: _statusStr(L.busyText), tool: _statusStr(L.toolName),
                    elapsedMs: (typeof L.elapsedMs === 'number' && L.elapsedMs > 0) ? L.elapsedMs : 0,
                    subagents: (typeof L.subagentCount === 'number' && L.subagentCount > 0) ? L.subagentCount : 0
                });
            }
            var subs = [];
            var pool = o.subagents || null;
            if (pool && typeof pool.list === 'function') {
                try { subs = pool.list() || []; } catch (_) { subs = []; }
            }
            for (var j = 0; j < subs.length; j++) {
                var r = subs[j] || {};
                var row = { target: _statusStr(r.id), kind: 'subagent', parent: _statusStr(r.parentLane), state: _statusStr(r.state) };
                if (r.title !== undefined) row.title = _statusStr(r.title);
                if (typeof r.elapsedMs === 'number') row.elapsedMs = r.elapsedMs;
                if (r.tokens !== undefined) row.tokens = r.tokens;
                agents.push(row);
            }
            return {
                success: true,
                result: _json({
                    status: 'success', agents: agents,
                    hint: '各条 Agent 那几行 status：idle 空闲 / thinking 在想 / tool 在调工具 / confirm 等用户确认 / error 上轮报错。'
                        + '各条子 Agent 那几行 state：queued（排队）/ running / waiting（保活中，可追问）/ done / failed / stopped。'
                        + 'target 就是 send_message 的收件人。消息只投一次，结论不会自动回来——对方要回你，会自己用 send_message 发。'
                })
            };
        };
    }

    // send_message 的 handler 工厂：**唯一的沟通入口**。
    // 目标分两类，分流一次：① 子 Agent（池里有这个 id）⇒ 走池的追问（那是一条已有的续跑链）；
    // ② 其余（三条 lane）⇒ 走注入的 sendMessage（编排面的统一投递；main 已不是目标）。
    // 回执是「邮局收据」：给出投递 id + 事实（对方下一轮能读到），**不带正文**。
    // 完成回投下线——消息只投一次，对方的结论**不会**自动回到这条对话；
    // 需要答复就让对方在完成时自己 send_message 回来（派单文本会写明收件人）。
    function _isPoolId(pool, target) {
        if (!pool || typeof pool.list !== 'function') return false;
        try {
            var rows = pool.list() || [];
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] && rows[i].id === target) return true;
            }
        } catch (_) { return false; }
        return false;
    }

    function buildSendMessageHandler(opts) {
        var o = opts || {};
        return function (args, ctx) {
            var a = args || {};
            var target = (typeof a.target === 'string') ? a.target.replace(/^\s+|\s+$/g, '') : '';
            var message = (typeof a.message === 'string') ? a.message.replace(/^\s+|\s+$/g, '') : '';
            if (!target) {
                return _errorResult('bad_target',
                    'target 必填：可用目标 director / ae-exec / glsl / asset-gen，'
                    + '或 list_agents 给出的子 Agent id。');
            }
            if (!message) {
                return _errorResult('bad_message', 'message 必须是非空字符串：写清要对方做什么。');
            }
            // 团队主通道移除 ⇒ `target:'main'` 返回 main_removed
            // 并列出可用目标。历史会话里的旧调用得到同一条错误，不静默改投、不猜收件人。
            if (target === 'main') {
                return _errorResult('main_removed',
                    '团队主通道已移除：没有名为 main 的收件人。可用目标：director / ae-exec / glsl / asset-gen'
                    + '（或 list_agents 给出的子 Agent id）。历史调用不会送达。');
            }
            // ① 子 Agent：复用池的追问链（同一 ctx 续跑一轮，结论照旧回投给它的上级 lane）
            // origin: 'agent' —— 这条追问是**上级 Agent 的 send_message**，与「用户在面板弹窗直接追问」
            // （AEEngine.askSubagent，origin: 'user'，不回投）是两条来源，运行器与回投侧都按它分流。
            if (_isPoolId(o.subagents, target)) {
                var pendingAsk = null;
                try {
                    pendingAsk = o.subagents.ask(target, message, { origin: 'agent' });
                } catch (e) {
                    return _errorResult('error', 'send_message 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
                }
                return Promise.resolve(pendingAsk).then(function (r) {
                    if (!r || r.ok !== true) {
                        return _errorResult((r && r.reason) || 'error', (r && r.message) || '发给子 Agent 的消息没送到。');
                    }
                    var st = (typeof r.state === 'string') ? r.state : '';
                    if (st === 'failed' || st === 'stopped') {
                        return _errorResult(st, _subagentFailureText(st, '', 'id: ' + target));
                    }
                    return {
                        success: true,
                        result: _json({
                            status: 'success', messageId: target, state: st,
                            hint: '已交给它：这一轮的结论会作为消息回投给它的上级 Agent，不必轮询。'
                        })
                    };
                }, function (e) {
                    return _errorResult('error', 'send_message 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
                });
            }
            // ② lane：编排面的统一投递（校验、投一次；结论不自动回投）。
            // 团队主通道已移除，`main` 在上方直接返回 main_removed（不再进入投递链）。
            if (typeof o.sendMessage !== 'function') {
                return _errorResult('infra_error', '消息通道未注入（opts.sendMessage 未注入），send_message 当前不可用。');
            }
            var pending = null;
            try {
                pending = o.sendMessage(target, message, ctx || {});
            } catch (e) {
                return _errorResult('error', 'send_message 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
            }
            return Promise.resolve(pending).then(function (r) {
                if (!r || r.ok !== true) {
                    return _errorResult((r && r.reason) || 'error', (r && r.message) || '消息被拒绝了。');
                }
                return {
                    success: true,
                    result: _json({
                        status: 'success', messageId: r.id,
                        hint: '已送到：对方下一轮就能读到。结论不会自动回来——需要答复时，对方会在完成时用 '
                            + 'send_message 发给你；不要轮询。'
                    })
                };
            }, function (e) {
                return _errorResult('error', 'send_message 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
            });
        };
    }

    // 子 Agent 工具的失败文案：reason 由**池**给出，这里只负责翻成模型能
    // 自我纠正的话。域按公开契约写；池若给出域外的 reason，回落句会把 reason 与池的
    // message 原样带出（池的 message 才是权威细节，工具层不替它编原因）。
    var SUBAGENT_FAIL_TEXT = {
        limit_zero: '子 Agent 并发上限为 0（团队设置里把闸关掉了）：不会排队、也不会静默忽略。'
            + '请把「模块设置 → 团队 → 子 Agent 并发上限」调到 1 以上再 spawn，或者这一件活自己直接做。',
        not_team: '当前调用不在团队模式的各条 Agent 内（拿不到来源 Agent 身份）：单 Agent 路径不能派生/追问子 Agent。',
        no_parent_lane: '上级 Agent 未装配（没有 runtime/controller）：子 Agent 无法继承它的工具集与权限档。'
            + '请先在团队面板确认各条 Agent 起来了。',
        bad_id: '子 Agent id 形态非法：id 由 spawn_subagent 的回执给出（形如 sub_1），照抄它，不要自己拼。',
        unknown_id: '没有这个子 Agent id：它可能从未创建、或已被回收/停止。'
            + '请先用 list_agents 看当前在跑的子 Agent 再决定。',
        expired: '保活窗口已过（子 Agent 已被回收）：追问只能在它跑完后的保活窗口内进行；'
            + '超时后请重新 spawn_subagent（保活时长在团队设置里）。',
        stopped: '该子 Agent 已停止（stopped 是终态，不会复活）：需要继续就重新 spawn_subagent。',
        not_waiting: '该子 Agent 当前不是 waiting（跑完且仍在保活窗口内），只有 waiting 能追问：'
            + 'running 的等它跑完、queued 的等它起跑；done/failed/stopped 是终态，只能重新 spawn_subagent。',
        bad_task: 'task 必须是非空字符串：目标 Agent 看不到你的对话，任务要自包含。',
        bad_message: 'message 必须是非空字符串（消息正文）：写清要它补什么、交付到哪。',
        bad_title: 'title 必须是非空字符串（子 Agent 的名字，任务板与卡片靠它认人）。',
        bad_tools: 'tools 形态非法：只接受对象，且 allow/deny 必须是字符串数组（工具名）。',
        failed: '该子 Agent 本轮失败（failed 是终态）：看 message 里的原因，修正后重新 spawn_subagent。',
        busy: '该子 Agent 正在跑：追问会排在它本轮之后；也可以等它跑完再用 list_agents 查看。',
        error: '子 Agent 操作失败'
    };

    function _subagentFailureText(reason, detail, extra) {
        var head = SUBAGENT_FAIL_TEXT[reason] || ('子 Agent 操作失败（' + reason + '）');
        return head + (detail ? '：' + detail : '') + (extra ? ('（' + extra + '）') : '');
    }

    // 来源 lane（子 Agent 的 parentLane）：**只认执行上下文里的 laneId**（与 dispatch_task 同源
    // ——执行侧给的本次调用身份）。拿不到 ⇒ 显式失败，绝不回落「当前 lane」：团队开着时用户可能
    // 正停在导演 lane 看，而这次调用其实来自别处 ⇒ 猜出来的 parentLane 会让停止级联停错人。
    function _parentLaneOf(ctx) {
        return (ctx && typeof ctx.laneId === 'string' && ctx.laneId) ? ctx.laneId : '';
    }

    // 空 allow 名单的载体（防 fail-open）。为什么需要它、为什么是这个形态，见 _toolsSpecOf
    // 末尾那段注释：注册表强制工具名匹配 /^[a-zA-Z_][a-zA-Z0-9_]*$/（shared/toolRegistry.js:50），
    // 这个名字带括号与空格 ⇒ 永远不可能等于任何真实工具名 ⇒ 判据 `allow[name] !== true` 对每一件
    // 工具都成立 ⇒ 一件都不放行。它只出现在「交给池的 spec」里（不进任何模型可见文案）。
    var NO_TOOL_ALLOWED = '(allow 为空名单：不放行任何工具)';

    // 工具集收窄参数的**形态**校验（值语义归池）：缺省 = 全继承；给了必须是对象，
    // allow/deny 必须是字符串数组。不做 String() 静默转换——把 [1,2] 当名字用会让子 Agent
    // 拿到一件工具都没有的工具集，而回执里看不出原因。
    function _toolsSpecOf(v) {
        if (v === undefined || v === null) return { ok: true, spec: null };
        if (typeof v !== 'object' || Array.isArray(v)) {
            return { ok: false, message: 'tools 必须是对象（如 {"allow":["read_workspace"]} 或 {"deny":["executeExtendScript"]}）。' };
        }
        var out = {};
        var keys = ['allow', 'deny'];
        for (var i = 0; i < keys.length; i++) {
            var k = keys[i];
            var arr = v[k];
            if (arr === undefined || arr === null) continue;
            if (!Array.isArray(arr)) return { ok: false, message: 'tools.' + k + ' 必须是字符串数组。' };
            var list = [];
            for (var j = 0; j < arr.length; j++) {
                if (typeof arr[j] !== 'string' || !arr[j].trim()) {
                    return { ok: false, message: 'tools.' + k + ' 里的每一项都必须是非空字符串（工具名）。' };
                }
                list.push(arr[j].trim());
            }
            out[k] = list;
        }
        // 显式空 allow ⇒ 按空名单处理（fail-closed）：工具描述的口径是「allow = 只放行名单内的工具」，
        // 空名单就是空集；而收窄判据那一侧（bootstrap._toolNameSet）把**空数组**一律读成「这一侧没有
        // 约束」，裸 [] 交出去会被当成「不限」（实测 tools:{allow:[]} 的子 Agent 拿到父 lane 的全量
        // 工具，含 readFile/writeFile —— 与描述相反，是 fail-open）。故这里把空名单翻成
        // NO_TOOL_ALLOWED：判据读到的是一份**非空**名单，但里面那个名字永远命不中任何工具 ⇒ 全拒。
        // 与 {}（未给限制 ⇒ spec=null ⇒ 继承父 lane 的收窄）区分开；deny:[] 语义不变（不额外禁任何件）。
        // 依赖的是「工具名不可能带括号/空格」这条注册表硬规则，故对**以后新注册**的工具同样成立
        //（不用注册表快照，也就不会漏掉后加的工具）。
        if (Array.isArray(out.allow) && out.allow.length === 0) out.allow = [NO_TOOL_ALLOWED];
        return { ok: true, spec: (out.allow || out.deny) ? out : null };
    }

    // spawn_subagent 的 handler 工厂。三件事：① 参数**形态**校验（缺/空/类型不对
    // 当场给可纠正文案，不去惊动池）；② 把 wait 原样交给池（缺省 false = 立即返回句柄）；
    // ③ 把池的 Result 翻成回执。
    // 口径：**两条路径都在**——
    //   · 缺省（异步）：立即返回句柄；子 Agent 跑完由引擎把结论**回投**给上级
    //     （bootstrap._deliverSubagentResult → injectSystemResult：卡片 + 唤醒一轮），不用轮询；
    //   · wait:true（阻塞）：等到它跑完/失败，回执里直接带结论摘要——**立刻要用结论**时才用。
    //     阻塞路径的回投会被跳过（结论已经在回执里，再投一次就是重复信息 + 白唤醒一轮）。
    // 为什么留着这个选项：「默认异步」不等于「不该能等」，
    // 需要串行依赖时等它是对的；真正的问题是**描述不该诱导模型默认去等**——所以描述里写明
    // 「缺省异步、跑完自动回投」，把 wait 定位成「确有必要才用」。
    function buildSpawnSubagentHandler(opts) {
        var o = opts || {};
        return function (args, ctx) {
            var pool = o.subagents || null;
            if (!pool || typeof pool.spawn !== 'function') {
                return _errorResult('infra_error', '子 Agent 池未装配（opts.subagents 未注入），spawn_subagent 当前不可用。');
            }
            // 团队没开 ⇒ 当场拒：异步路径下 runner 的失败不再能从回执里看到（回执先返回、失败经完成
            // 回投送回来），故可预判的错误必须在这里挡下——否则模型会以为「派上了」，而那条 lane
            // 其实一条都不存在。
            if (typeof o.isTeamMode === 'function' && o.isTeamMode() !== true) {
                return _errorResult('not_team', '团队模式未开启：子 Agent 只在团队模式下可用（先在模块设置里开启团队模式）。');
            }
            var a = args || {};
            var title = (typeof a.title === 'string') ? a.title.trim() : '';
            if (!title) {
                return _errorResult('bad_title', 'title 必填（非空）：它是子 Agent 的名字，任务板与卡片都靠它认人。');
            }
            var task = (typeof a.task === 'string') ? a.task.trim() : '';
            if (!task) {
                return _errorResult('bad_task', 'task 必填（非空）：目标 Agent 看不到你的对话——'
                    + '写清「要做什么 + 交付物 + 验收判据」。');
            }
            var specRes = _toolsSpecOf(a.tools);
            if (specRes.ok !== true) return _errorResult('bad_tools', specRes.message);
            var parentLane = _parentLaneOf(ctx);
            if (!parentLane) {
                return _errorResult('not_team', SUBAGENT_FAIL_TEXT.not_team);
            }
            // wait 只认 true（缺省 false）：其余形态（"true"/1/对象）不猜——猜错就是「模型以为
            // 阻塞等到了摘要、其实拿到的是句柄」，而两者回执形状不同，模型会照错的理解继续。
            var wait = (a.wait === true);
            var pending;
            try {
                pending = pool.spawn({ title: title, task: task, tools: specRes.spec, wait: wait, parentLane: parentLane });
            } catch (e) {
                return _errorResult('error', 'spawn_subagent 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
            }
            return Promise.resolve(pending).then(function (r) {
                if (!r || r.ok !== true) {
                    var reason = (r && r.reason) || 'error';
                    return _errorResult(reason, _subagentFailureText(reason, r && r.message));
                }
                if (typeof r.id !== 'string' || !r.id || typeof r.state !== 'string' || !r.state) {
                    // 成功回执缺 id/state：模型拿到的是一件**追踪不到**的子 Agent（后续追问、停止、
                    // 任务板都对不上号），比当场报错更糟 → 按基础设施错显式暴露。
                    return _errorResult('infra_error', '子 Agent 回执不完整（缺 id 或 state）：' + _json(r));
                }
                // wait:true：池给的 `done` 是「跑完」的句柄（池自己不阻塞，调用方 await）。
                // 等它 → 用终态结果补 state/summary（**权威值**来自池，不是工具层猜的）。
                if (wait && r.done && typeof r.done.then === 'function') {
                    return Promise.resolve(r.done).then(function (done) { return _spawnPayload(r, done, true, parentLane); },
                        function (e) {
                            return _errorResult('error', 'spawn_subagent 等待失败: '
                                + ((e && e.message) ? String(e.message) : String(e)));
                        });
                }
                return _spawnPayload(r, null, wait, parentLane);
            }, function (e) {
                return _errorResult('error', 'spawn_subagent 异常: ' + ((e && e.message) ? String(e.message) : String(e)));
            });
        };
    }

    // 装配入口：注册团队域工具。返回 { ok, registered:[…] } 或 { ok:false, reason, … }。
    function initTeamTools(opts) {
        var o = opts || {};
        var toolRegistry = o.toolRegistry;
        if (!toolRegistry || typeof toolRegistry.register !== 'function') {
            console.warn('[teamTools] 缺少 toolRegistry，团队工具未注册（read_workspace 将不可用）');
            return { ok: false, reason: 'no_registry', registered: [] };
        }
        var ws = o.workspace;
        if (!ws || typeof ws.read !== 'function') {
            console.warn('[teamTools] 缺少 workspace（team/workspace.js 实例），团队工具未注册');
            return { ok: false, reason: 'no_workspace', registered: [] };
        }

        // 工作区文件枚举：从 workspace.listFiles() 派生（**唯一真相源**是工作区层那张表）。
        // 以后加工作区文件类型只改那张表，工具 schema 在注册时自动带上新的 enum 值。
        var wfiles = [];
        try {
            wfiles = (ws && typeof ws.listFiles === 'function') ? (ws.listFiles() || []) : [];
        } catch (_) { wfiles = []; }
        if (!wfiles.length) console.warn('[teamTools] workspace.listFiles() 为空：工作区文件枚举缺席（schema 里不给 enum）');
        var wNames = [];
        var wWritable = [];
        for (var wi = 0; wi < wfiles.length; wi++) {
            var wf = wfiles[wi] || {};
            if (typeof wf.name === 'string' && wf.name) wNames.push(wf.name);
            if (wf.writable === true && typeof wf.name === 'string' && wf.name) wWritable.push(wf.name);
        }
        // 描述里的缺省文件名同样从表派生（缺省值本体由工作区层落实，见 buildReadWorkspaceHandler）。
        // 表/实例都给不出时用一句中性措辞：模型可见文案里不抄字面量，也不出现 undefined。
        var wDefault = _workspaceDefaultFile(ws);
        var wDefaultName = wDefault || '工作区文件表里的缺省文件';
        // 缺省文件的用途也取表里的 label（加文件类型/改语义名只改表，描述不另抄一份概念名）。
        var wDefaultLabel = '';
        for (var wk = 0; wk < wfiles.length; wk++) {
            var wfk = wfiles[wk] || {};
            if (wfk.name === wDefault && typeof wfk.label === 'string' && wfk.label) {
                wDefaultLabel = wfk.label;
                break;
            }
        }
        var wDefaultFact = wDefault
            ? (wDefault + (wDefaultLabel ? ' 是' + wDefaultLabel : ' 是缺省文件'))
            : '缺省文件由工作区文件表给出';

        var readPathSchema = { type: 'string', description: '工作区文件；缺省 ' + wDefaultName + '。' };
        if (wNames.length) readPathSchema.enum = wNames;
        var res = toolRegistry.register({
            name: 'read_workspace',
            description: '读取团队工作区里的文件（只读）。工作区是本次团队会话的共享目录，'
                + '可读的文件由工作区文件表限定（见 path 的取值），' + wDefaultFact + '（导演写，执行读）。'
                + 'path 缺省 ' + wDefaultName + '。回执的 rel 是文件名，后续调用继续用它。'
                + '单次最多返回 64KB（65536 字符），超过则截断且 truncated=true，size 是文件总字符数；'
                + '文件不存在时明确报错，不返回空内容。',
            input_schema: {
                type: 'object',
                properties: {
                    path: readPathSchema
                }
            },
            handler: buildReadWorkspaceHandler(o),
            scope: { type: 'module', moduleIds: ['team'] },
            stub: false,
            category: 'team',
            readOnly: true,
            source: 'team'
        });
        if (!res || res.ok !== true) {
            console.warn('[teamTools] read_workspace 注册失败: ' + JSON.stringify(res));
            return { ok: false, reason: 'register_failed', detail: res, registered: [] };
        }
        console.log('[teamTools] read_workspace 工具已注册 (module:team, readOnly)');
        var registered = ['read_workspace'];

        // write_workspace。workspace 缺写能力时不注册——不暴露一件永远报错的工具。
        if (!_workspaceWritable(ws)) {
            console.warn('[teamTools] workspace 无写能力（write/canWrite），write_workspace 未注册');
        } else {
            var writePathSchema = { type: 'string', description: '工作区文件；必填。' };
            if (wWritable.length) writePathSchema.enum = wWritable;
            var resW = toolRegistry.register({
                name: 'write_workspace',
                description: '在工作区里写文件（覆盖或追加）。工作区是本次团队会话的共享目录，'
                    + '可写的文件由工作区文件表限定（见 path 的取值），' + wDefaultFact + '。'
                    + 'mode=replace（缺省，覆盖原内容）或 append（追加到末尾，文件不存在则新建）。'
                    + 'content 必须是字符串，单次最多 256KB（262144 字符）：超限请拆成多次 append；非字符串会报错。'
                    + '同一文件的并发写按调用顺序串行。回执给出 path（绝对）/rel（相对）/bytes/mode。',
                input_schema: {
                    type: 'object',
                    properties: {
                        path: writePathSchema,
                        content: {
                            type: 'string',
                            description: '要写入的完整文本（字符串）。单次最多 262144 字符。'
                        },
                        mode: {
                            type: 'string',
                            enum: ['replace', 'append'],
                            description: 'replace = 覆盖原内容（缺省）；append = 追加到末尾（文件不存在则新建）。'
                        }
                    },
                    required: ['path', 'content']
                },
                handler: buildWriteWorkspaceHandler(o),
                scope: { type: 'module', moduleIds: ['team'] },
                stub: false,
                category: 'team',
                readOnly: false,
                source: 'team'
            });
            if (!resW || resW.ok !== true) {
                console.warn('[teamTools] write_workspace 注册失败: ' + JSON.stringify(resW));
                return { ok: false, reason: 'register_failed', detail: resW, registered: registered };
            }
            console.log('[teamTools] write_workspace 工具已注册 (module:team, 写工具)');
            registered.push('write_workspace');
        }

        // send_message：**唯一的沟通入口**。目标是三条 lane 或子 Agent id
        // （后者走池的追问链）；团队主通道移除后 `main` 不再是目标。
        // scope 是 ['agent', 'team']：三条 lane 的 moduleIds 都含 'team'（lanes.js：导演/AE 执行
        // [agent,team]、GLSL [shader,team]），主 Agent 是 'agent'。**不拿 'shader' 去凑 GLSL lane**
        // ——面板的 Shader 档身份就是 'shader'，加进去会把团队工具漏给它；脚本档（'script'）与外接
        // 同样拿不到。'agent' 同时是**单 Agent 档**的身份，团队关闭时上表会把这两件漏给
        // Agent 档（真机：Agent 档工具清单出现 send_message/list_agents）。收窄点在 controller 的
        // `_buildRoundTools`（无 lane 身份且团队关闭 ⇒ 按 source='team' 剔除，执行侧同拒），
        // 本文件的 scope 不再承担这层区分。
        // 子 Agent 那条路径由 SUBAGENT_TOOL_NAMES 剔除；能力缺席（装配面没给 sendMessage）时不注册。
        if (typeof o.sendMessage !== 'function') {
            console.warn('[teamTools] 缺少 sendMessage（消息通道未注入），send_message 未注册');
        } else {
            var resM = toolRegistry.register({
                name: 'send_message',
                description: '给团队里的各个 Agent 发一条消息（团队模式开着时可用）。'
                    + 'target 取 director / ae-exec / glsl / asset-gen（各条常驻 Agent），'
                    + '或 list_agents 给出的子 Agent id。'
                    + '对方正忙时会在它那一轮结束后收到。消息只投一次：结论不会自动回到这条对话，'
                    + '需要对方回复时，它完成/需要你处理时会自己用 send_message 发给你；不要轮询。'
                    + '如果你在派活，写明「完成后用 send_message 回给谁、回报什么」。'
                    + 'message 要自包含——对方看不到你的对话。需要素材、方向、验收标准时用它问清楚，'
                    + '不要靠猜。团队主通道已移除：没有 main 这个收件人。',
                input_schema: {
                    type: 'object',
                    properties: {
                        target: {
                            type: 'string',
                            description: '收件人：director / ae-exec / glsl / asset-gen，或子 Agent id（list_agents 取）。'
                        },
                        message: {
                            type: 'string',
                            description: '消息正文（必填）：要对方做什么、有什么约束、期望的产出。'
                        }
                    },
                    required: ['target', 'message']
                },
                handler: buildSendMessageHandler(o),
                scope: { type: 'module', moduleIds: ['agent', 'team'] },
                stub: false,
                category: 'team',
                readOnly: false,
                source: 'team'
            });
            if (!resM || resM.ok !== true) {
                console.warn('[teamTools] send_message 注册失败: ' + JSON.stringify(resM));
                return { ok: false, reason: 'register_failed', detail: resM, registered: registered };
            }
            console.log('[teamTools] send_message 工具已注册 (module:agent,team)');
            registered.push('send_message');
        }

        // 子 Agent 三件。池缺席（装配失败 / 归一值取不到）时**三件都不注册**
        // ——同上：不暴露永远报错的工具。三件的注册是**一起**的：只注册一半（比如只有 list）会让
        // 模型看到「能看不能派」的工具面，它会反复试 spawn 并撞 infra_error。
        if (!o.subagents || typeof o.subagents.spawn !== 'function') {
            console.warn('[teamTools] opts.subagents 未注入（子 Agent 池缺席），spawn_subagent 未注册');
        } else {
            var resS = toolRegistry.register({
                name: 'spawn_subagent',
                description: '派生一个子 Agent 做一件独立的事。缺省异步：立即返回 id 与状态，它在后台跑，'
                    + '跑完会自动把结论回投给你，无需轮询。'
                    + '子 Agent 不继承你的对话历史，所以 task 要写清要做什么、交付物、验收判据。'
                    + '它继承你的工具集与权限档，不能再派生子 Agent。'
                    + 'wait:true 阻塞本轮直到它跑完或失败，回执里直接带摘要；只在必须等它才能继续时用。'
                    + '并发满额时回执 state=queued（排队，不是丢弃）；并发上限为 0 时 spawn 显式失败，不排队。',
                input_schema: {
                    type: 'object',
                    properties: {
                        title: { type: 'string', description: '子 Agent 的名字（非空）：任务板与卡片靠它认人。' },
                        task: { type: 'string', description: '任务描述（非空）：要做什么、交付物是什么、怎么验收。' },
                        tools: {
                            type: 'object',
                            description: '可选：收窄子 Agent 的工具集（缺省 = 全继承你的 Agent）。'
                                + 'allow = 只放行名单内的工具；deny = 剔除名单内的工具（优先于 allow）。',
                            properties: {
                                allow: { type: 'array', items: { type: 'string' }, description: '只放行这些工具名（缺省 = 不限）。' },
                                deny: { type: 'array', items: { type: 'string' }, description: '剔除这些工具名（优先级高于 allow）。' }
                            }
                        },
                        wait: {
                            type: 'boolean',
                            description: 'true = 等到它跑完或失败再返回；缺省 false = 立即返回。'
                        }
                    },
                    required: ['title', 'task']
                },
                handler: buildSpawnSubagentHandler(o),
                scope: { type: 'module', moduleIds: ['team'] },
                stub: false,
                category: 'team',
                readOnly: false,
                source: 'team'
            });
            if (!resS || resS.ok !== true) {
                console.warn('[teamTools] spawn_subagent 注册失败: ' + JSON.stringify(resS));
                return { ok: false, reason: 'register_failed', detail: resS, registered: registered };
            }
            console.log('[teamTools] spawn_subagent 工具已注册 (module:team, 写工具)');
            registered.push('spawn_subagent');


        }

        // list_agents：**名册 + 状态一个出口**（合并原 list_subagents + team_status）。
        // scope 与 send_message 同口径 ['agent', 'team']：主 Agent（'agent'）也要能查名册（它要用
        // send_message 找收件人），三条 lane 各自含 'team'；脚本档/面板 Shader 档与外接拿不到它。
        // 子 Agent 由 SUBAGENT_TOOL_NAMES 剔除（一层边界）。
        // 池缺席不整件不注册（lane 行与在途消息仍有价值）：只有全无名册源时才不注册。
        if (typeof o.roster !== 'function') {
            console.warn('[teamTools] 缺少 roster（名册读取口未注入），list_agents 未注册');
        } else {
            var resL = toolRegistry.register({
                name: 'list_agents',
                description: '列出团队里所有的 Agent（只读）：各条常驻 Agent（director / ae-exec / glsl / asset-gen）'
                    + '各自在忙什么（状态、正在调用的工具、已耗时、名下在跑的子 Agent 数），'
                    + '以及各条子 Agent（排队 / 在跑 / 保活 / 已结束，带归属上级）。'
                    + '发消息或派活前先用它确认收件人是谁、是不是正忙；它不改变任何状态、不唤醒任何 Agent。',
                input_schema: { type: 'object', properties: {} },
                handler: buildListAgentsHandler(o),
                scope: { type: 'module', moduleIds: ['agent', 'team'] },
                stub: false,
                category: 'team',
                readOnly: true,
                source: 'team'
            });
            if (!resL || resL.ok !== true) {
                console.warn('[teamTools] list_agents 注册失败: ' + JSON.stringify(resL));
                return { ok: false, reason: 'register_failed', detail: resL, registered: registered };
            }
            console.log('[teamTools] list_agents 工具已注册 (module:agent,team, 只读)');
            registered.push('list_agents');
        }

        return { ok: true, registered: registered };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.initTeamTools = initTeamTools;
    global.AEAgentTeam.buildReadWorkspaceHandler = buildReadWorkspaceHandler;
    global.AEAgentTeam.buildWriteWorkspaceHandler = buildWriteWorkspaceHandler;
    global.AEAgentTeam.buildSpawnSubagentHandler = buildSpawnSubagentHandler;
    global.AEAgentTeam.buildListAgentsHandler = buildListAgentsHandler;
    global.AEAgentTeam.buildSendMessageHandler = buildSendMessageHandler;
    // 三件 subagent 工具名的**定义源**（一层边界要用它做剔除）：运行器收窄工具集时按这份
    // 名单剔除，不许在别处再抄一份字面量（两处名单漂移的表现是「子 Agent 能派生孙子」——
    // 静默的嵌套，与「只做一层」的边界直接冲突）。
    global.AEAgentTeam.SUBAGENT_TOOL_NAMES = ['spawn_subagent', 'send_message', 'list_agents'];
})(typeof window !== 'undefined' ? window : globalThis);
