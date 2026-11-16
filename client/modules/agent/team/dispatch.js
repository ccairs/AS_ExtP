(function (global) {
    'use strict';
    // 团队消息（`send_message`）的**纯逻辑**：入参校验 + 投递文本 + **一次投递**。
    //
    // **完成回投下线**。消息只投一次，结论**不自动**回到发起方——
    // 谁要结论，谁在完成后自己 `send_message` 回去（派单文本末条写明收件人与要报什么）。
    // 为什么下线：回投让每一条消息都长出一条自动答复，两条 Agent 互相派单时形成自动往返，
    // 白烧 token；而目标 lane 忙成一串时所有在途记录会在**一次**忙→闲里批量结算，每条都拿
    // 「最后一条 assistant 文本」，一段结论被复制 N 份（实测：7+3 张同文卡）。
    //
    // 本文件因此**不持有任何状态**：校验 → 投递一次 → 回执（成功/失败都如实）。
    // 不存在 queued / 懒重试 / 在途表 / 配对记录——投不出去就是投不出去，让模型改参数重来。
    //
    // 为什么单独成文件、依赖全部注入：这条链要能被**直驱**才可验证 —— lane 定义、目标 runtime、
    // 投递通道全部当参数传进来，单测就能用假 deliver 的成败直接断言。一旦碰 document / 定时器 /
    // 全局单例，就只能靠真机复现。
    //
    // 与 orchestrator 的分工（谁也别越界）：
    //   · 本文件：入参校验、投递文本；
    //   · orchestrator：团队会话 id（本文件的 getTeamSessionId 就是它闭包里的绑定值）、目标 lane
    //     controller 的 injectSystemMessage 调用（**唯一投递落点**）。
    //
    // opts 契约（缺项一律**显式失败**，不猜）：
    //   lanes            lane 定义访问器（须有 list()；缺省回落 global.AEAgentTeam.lanes）——
    //                    「哪几条 lane 合法」的唯一判据源，本文件不硬编码 id 数组
    //   getLaneRuntime   (id) => runtime|null（投递前确认目标 lane 与它的投递通道都在）
    //   getTeamSessionId () => string，团队会话 id 的唯一来源（拿不到 ⇒ not_team，不猜当前会话）
    //   deliver          (req) => Result，投递通道（req = { item, text, detail }）；orchestrator 注入

    // 投递文本（面向目标 lane 的模型）。必须项：来源/目标 label、摘要、先 read_workspace、
    // 工作区两件文件的用途（计划书 / 文字分镜——分镜已从计划书剥离，不点它执行侧不知道去读）、
    // 以及**完成后用 send_message 回报发起方**（回投下线后这是结论唯一的回路）。
    // **纯函数**（出参只由入参决定），单测才能逐项钉「少一句就红」；label 由调用方查好传进来。
    function buildDispatchText(item, fromLabel, toLabel) {
        var it = item || {};
        var fromName = fromLabel || it.from || '';
        var lines = [
            '【团队消息】来自「' + fromName + '」，交给「' + (toLabel || it.to || '') + '」。',
            '摘要：' + (it.summary || ''),
            '请先 read_workspace(\'brief.md\') 读计划书；文字分镜在 storyboard.md。再按摘要动手。',
            '完成后用 send_message 把结论发回给「' + fromName + '」（target: \'' + (it.from || '') + '\'）：'
                + '做了什么、产物在哪、怎么验证、有哪些存疑或偏离。',
            '引擎不会自动转交结论：不回报，发起方就收不到。'
        ];
        return lines.join('\n');
    }

    function createDispatch(opts) {
        var d = opts || {};
        var seq = 0;         // 投递号：只增不减、不重复使用（日志/warn 里指认是哪一次投递）

        function _api() {
            if (d.lanes) return d.lanes;
            return (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
        }

        function _defs() {
            var api = _api();
            if (!api || typeof api.list !== 'function') return [];
            try {
                var list = api.list();
                return (list && list.length) ? list : [];
            } catch (_) { return []; }
        }

        // 合法 lane id：**只**取自定义源的 `id` 字段（`lanes.list()` 的每一项）。
        // 这里曾经**优先**问 `lanes.listIds()`，而真 lanes.js 的 listIds()
        // 返回的是**容器 DOM id**（`aeAgentLane_*`，lanes.js:189-192，UI 的链接委托/宽度锁按它遍历），
        // 不是 lane id ⇒ 每一次 send_message 都在来源校验处 unknown_lane，**一条都投不出去**
        //（真机复现：lane→lane / main→lane 全拒，deliverToMain 调用 0 次）。
        // sessionBinder.js:23-24 早就写明这个坑；lanes.js 的 listIds() 语义（容器 id）**不许改**（UI 依赖它），
        // 所以修的是**这一侧的问法**：lane 名册 = list().map(l => l.id)，唯一来源，不再有第二个候选。
        function _laneIds() {
            var out = [];
            var defs = _defs();
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].id) out.push(defs[i].id);
            }
            return out;
        }

        // 合法 **来源 / 目标**：缺省 = 各条 lane；`allowMain` 时并上 `'main'`（面板上的主 Agent：
        // 它不是 lane、没有 runtime，但同样是"人"，同样该被 send_message 找到）。
        // 每次现算（lane 定义源可能变），不缓存。
        function _idsPlus() {
            var base = _laneIds();
            if (d.allowMain !== true) return base;
            if (base.indexOf('main') < 0) base.push('main');
            return base;
        }

        function _labelOf(id) {
            var defs = _defs();
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].id === id) return defs[i].label || id;
            }
            return id;   // 定义里查不到时回落 id：宁可显示 id，不可缺口（与 getBoardSnapshot 同口径）
        }

        function _fail(reason, message) { return { ok: false, reason: reason, message: message }; }

        function _mkDelivery(from, to, summary) {
            seq++;
            return { id: 'd_' + seq, from: from, to: to, summary: summary };
        }

        // 团队消息：校验 → 投递**一次**。
        // `summary` 与 `message` 是同一件事的两个名字（派单叫摘要、送信叫正文），归一后走同一条链。
        // 成功即结束（state=delivered）；失败如实回报且不重试（重试是「模型决定再来一次」的事）。
        function dispatch(req) {
            try {
                var r = req || {};
                var to = r.to;
                var from = r.from;
                var summary = (typeof r.summary === 'string') ? r.summary : r.message;
                var ids = _idsPlus();

                if (typeof to !== 'string' || !to) {
                    return _fail('bad_target', 'target 必须是非空的收件人名字（可用目标：' + _laneIds().join('/') + '）。');
                }
                if (typeof from !== 'string' || !from) {
                    return _fail('not_team', '消息必须带来源（from）：各条团队 Agent 用各自的 Agent id'
                    + '（director / ae-exec / glsl / asset-gen）；面板上的主 Agent 用 main（仅来源兼容）。');
                }
                // summary 的空判据与**投出去的正文**同源：先归一（首尾空白不承载语义），再判空，
                // 否则会出现「校验通过、投递文本里却是一行空白」。
                var text = (typeof summary === 'string') ? summary.replace(/^\s+|\s+$/g, '') : null;
                if (!text) {
                    return _fail('bad_summary', 'message 必须是非空字符串（收件人看不到你的对话，只读得到这句话）。');
                }
                if (ids.indexOf(from) < 0) {
                    return _fail('unknown_lane', '来源「' + from + '」不存在（合法值：' + ids.join('/') + '）。');
                }
                // 团队主通道移除 ⇒ `'main'` 不再是投递目标。
                // 历史会话里的旧调用得到同一条错误（不静默改投、不猜收件人）；`from:'main'` 仍合法
                // （来源侧兼容，`allowMain` 保留，见 _idsPlus）。
                if (to === 'main') {
                    return _fail('main_removed', '团队主通道已移除：没有名为 main 的收件人。可用目标：'
                        + _laneIds().join('/') + '（历史调用不会送达）。');
                }
                if (ids.indexOf(to) < 0) {
                    return _fail('unknown_lane', '收件人「' + to + '」不存在（可用目标：' + _laneIds().join('/')
                        + '；子 Agent 用 list_agents 里的 id）。');
                }
                if (to === from) {
                    return _fail('bad_target', '不能发给自己（' + from + ' → ' + to + '）：要干的活直接做，别绕一圈回到自己。');
                }
                // 团队会话：**唯一来源**是注入的 getter（orchestrator 的团队会话绑定）。拿不到就
                // 显式失败——绝不用「当前会话」猜：单 Agent 会话与团队会话是两套域，猜错会把消息
                // 投进用户当前的普通会话里，而且没有任何报错信号。
                var sid = '';
                try {
                    sid = (typeof d.getTeamSessionId === 'function') ? d.getTeamSessionId() : '';
                } catch (e) {
                    return _fail('error', '团队会话读取失败：' + String((e && e.message) || e));
                }
                if (typeof sid !== 'string' || !sid) {
                    return _fail('not_team', '团队会话尚未建立：消息要按团队会话定位，请先创建或切换一个团队会话。');
                }
                // 目标**按类型分叉校验**（main 已在上方直接返回 main_removed）：
                // 目标是 lane ⇒ 必须已装配：没有 runtime 就没有 controller，投递无处可落。
                // main 不是 lane、没有 runtime；它已不再是合法目标，故这里只剩 lane 预检。
                var rt = null;
                try {
                    rt = (typeof d.getLaneRuntime === 'function') ? d.getLaneRuntime(to) : null;
                } catch (e) {
                    return _fail('error', '目标 Agent 的 runtime 查询失败：' + String((e && e.message) || e));
                }
                if (!rt) {
                    return _fail('no_controller', '收件人「' + to + '」还没装配（没有 runtime/controller）：'
                        + '团队未启动或该条 Agent 装配失败，先用 list_agents 确认它起来了。');
                }
                if (!rt.controller || typeof rt.controller.injectSystemMessage !== 'function') {
                    return _fail('no_controller', '收件人「' + to + '」的 controller 没有 injectSystemMessage 通道（投递落点缺席），无法投递。');
                }
                if (typeof d.deliver !== 'function') {
                    return _fail('error', '投递通道缺席（deliver 未注入）');
                }

                var item = _mkDelivery(from, to, text);
                var req2 = {
                    item: item,
                    text: buildDispatchText(item, _labelOf(from), _labelOf(to)),
                    detail: {
                        team: 'dispatch',
                        id: item.id,
                        from: item.from,
                        to: item.to,
                        summary: item.summary
                    }
                };
                var res = null;
                try {
                    res = d.deliver(req2);
                } catch (e) {
                    return _fail('error', String((e && e.message) || e));
                }
                if (!res || typeof res !== 'object') return _fail('error', '投递通道无返回值');
                if (res.ok !== true) {
                    // 如实回报：不重试（重试是「模型决定再来一次」的事，不是引擎的暗动作）。
                    return _fail(res.reason || 'error', res.message || '投递被拒绝');
                }
                return { ok: true, id: item.id, to: item.to, state: 'delivered' };
            } catch (e) {
                // 派单是模型的工具调用入口：**绝不向上抛**（抛出去就是一次工具执行失败 + 栈信息），
                // 一律收敛成可判定的失败体。
                return _fail('error', '消息内部错误：' + String((e && e.message) || e));
            }
        }

        return {
            dispatch: dispatch
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.createDispatch = createDispatch;
    // 文本构造单列导出：单测直驱「哪几句必须在」，不必先造一条完整投递链。
    global.AEAgentTeam.buildDispatchText = buildDispatchText;
})(typeof window !== 'undefined' ? window : globalThis);
