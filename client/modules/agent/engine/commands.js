(function (global) {
    var ns = global.AEEngine || {};

    function parseSlashCommand(text) {
        if (!text || text.charAt(0) !== '/') return null;
        var rest = text.slice(1);
        var spaceIdx = rest.search(/[\s:]/);
        var cmdName, args;
        if (spaceIdx === -1) {
            cmdName = rest;
            args = '';
        } else {
            cmdName = rest.slice(0, spaceIdx);
            args = rest.slice(spaceIdx + 1).trim();
        }
        return { name: cmdName.toLowerCase(), args: args, raw: text };
    }

    var COMMANDS = [];

    function register(name, config) {
        var cmd = typeof name === 'object' ? name : { name: name };
        var cfg = typeof name === 'object' ? config || {} : config;
        cmd.name = (cmd.name || '').replace(/^\//, '').toLowerCase();
        cmd.category = cfg.category || 'general';
        cmd.description = cfg.description || '';
        cmd.usage = cfg.usage || ('/' + cmd.name);
        cmd.onSelect = typeof cfg.onSelect === 'function' ? cfg.onSelect : null;
        cmd.onExecute = typeof cfg.onExecute === 'function' ? cfg.onExecute : null;
        // 参数（子命令）补全表（可选）：[{ name, description, insert }]。
        // insert = 选中后插入到命令名之后的内容（带尾空格表示"还要继续填参数"，如 edit / limit）。
        // 只用于输入区补全提示，不参与 execute 解析（执行语义仍在 onExecute）。
        cmd.params = Array.isArray(cfg.params) ? cfg.params.map(function (p) {
            return {
                name: String((p && p.name) || ''),
                description: String((p && p.description) || ''),
                insert: String((p && p.insert) || ((p && p.name) || ''))
            };
        }).filter(function (p) { return !!p.name; }) : [];
        for (var i = 0; i < COMMANDS.length; i++) {
            if (COMMANDS[i].name === cmd.name) {
                COMMANDS[i] = cmd;
                return;
            }
        }
        COMMANDS.push(cmd);
    }

    // 参数补全候选：命令 → 其 params 里按输入前缀过滤（大小写不敏感、忽略首尾空白）。
    // 只对「命令名已精确输入」的情况生效（`/goal `、`/goal pa`）；命令名不完整时返回 []，
    // 由调用方回落到命令名补全。无参数表的命令恒返回 []。
    function matchParams(name, query) {
        var cmd = getByExactName(name);
        if (!cmd || !cmd.params || !cmd.params.length) return [];
        var q = String(query == null ? '' : query).replace(/^\s+|\s+$/g, '').toLowerCase();
        var out = [];
        for (var i = 0; i < cmd.params.length; i++) {
            var p = cmd.params[i];
            if (!q || p.name.toLowerCase().indexOf(q) === 0) out.push(p);
        }
        return out;
    }

    function match(partial) {
        var parsed = parseSlashCommand(partial);
        if (!parsed) return [];
        var results = [];
        for (var i = 0; i < COMMANDS.length; i++) {
            if (COMMANDS[i].name.indexOf(parsed.name) === 0) {
                results.push(COMMANDS[i]);
            }
        }
        return results;
    }

    function getByExactName(name) {
        var lower = (name || '').toLowerCase();
        for (var i = 0; i < COMMANDS.length; i++) {
            if (COMMANDS[i].name === lower) return COMMANDS[i];
        }
        return null;
    }

    function execute(text, controller) {
        var parsed = parseSlashCommand(text);
        if (!parsed) return text;
        var cmd = getByExactName(parsed.name);
        if (!cmd) return text;
        if (typeof cmd.onExecute === 'function') {
            var result = cmd.onExecute({ command: cmd, args: parsed.args, raw: parsed.raw }, controller);
            if (result === null || result === undefined) return null;
            if (typeof result === 'string') return result;
            if (result && typeof result === 'object' && result._silent) return result;
            return text;
        }
        return text;
    }

    register('/reflect', {
        category: 'session',
        description: '回顾本轮对话，提炼可复用的经验并生成草稿供审阅',
        usage: '/reflect [关注重点]',
        onExecute: function (ctx, controller) {
            // 附带文本保留下来随消息一起发送，controller 端会把关注重点传给提炼 LLM
            return '/reflect' + (ctx.args ? ' ' + ctx.args : '');
        }
    });

    register('/clear', {
        category: 'session',
        description: '清空当前对话，开始新会话',
        usage: '/clear',
        onExecute: function (ctx, controller) {
            if (controller && typeof controller.clearConversation === 'function') {
                controller.clearConversation();
            }
            return { _silent: true };
        }
    });

    register('/help', {
        category: 'general',
        description: '显示所有可用命令',
        usage: '/help',
        onExecute: function (ctx, controller) {
            // 本地消息走 markdown 渲染（view.appendLocalMessage → md.render），用 MD 排版便于阅读
            var lines = ['## ' + AEI18n.t('可用命令') + '\n'];
            for (var i = 0; i < COMMANDS.length; i++) {
                var c = COMMANDS[i];
                var usageHint = (c.usage && c.usage !== ('/' + c.name)) ? ' `' + AEI18n.t(c.usage) + '`' : '';
                lines.push('- `/' + c.name + '`' + usageHint + ' — ' + AEI18n.t(c.description));
            }
            // 本地消息：作为 assistant 提示显示，不进 contextManager（不污染对话历史/LLM 上下文），
            // 也不走 syncView 全量重渲染（不打扰在途流式气泡）。
            if (controller && typeof controller.addLocalMessage === 'function') {
                controller.addLocalMessage('assistant', lines.join('\n'));
            }
            return { _silent: true };
        }
    });

    register('/plan', {
        category: 'session',
        description: '让 AI 先制定执行计划再动手',
        usage: '/plan [需求描述]',
        onExecute: function (ctx, controller) {
            var extra = ctx.args || '';
            if (!extra) return null; // 没输描述，提示用户
            return '请只做分析规划，不要直接执行。先理解需求，列出具体的分步计划，说明每步要做什么、用什么方法。等我明确说「确认」或「开始」后再动手。\n\n需求：' + extra;
        }
    });

    register('/compress', {
        category: 'session',
        description: '压缩当前对话上下文，释放 token 空间',
        usage: '/compress',
        onExecute: function (ctx, controller) {
            if (!controller || typeof controller.compressContext !== 'function') {
                return { _silent: true };
            }
            if (typeof controller.addLocalMessage === 'function') {
                controller.addLocalMessage('assistant', AEI18n.t('正在压缩上下文...'));
            }
            controller.compressContext({ manual: true }).then(function (res) {
                if (res && res.success) {
                    if (typeof controller.addLocalMessage === 'function') {
                        controller.addLocalMessage('assistant',
                            AEI18n.t('上下文已压缩，摘要长度 {n} 字符。', { n: res.summaryLength || 0 }));
                    }
                } else {
                    var reason = (res && res.error) || 'unknown';
                    // 文案唯一一份（apiActions.describeCompressFailure）：本文件、bootstrap
                    // 用量条、发送前自动压缩三处各写一套映射，同一情形三种说法。
                    var tip = typeof controller.describeCompressFailure === 'function'
                        ? controller.describeCompressFailure(reason)
                        : AEI18n.t('压缩失败，请稍后再试。');
                    if (typeof controller.addLocalMessage === 'function') {
                        controller.addLocalMessage('assistant', tip);
                    }
                }
            }).catch(function () {
                if (typeof controller.addLocalMessage === 'function') {
                    controller.addLocalMessage('assistant', AEI18n.t('压缩失败，请稍后再试。'));
                }
            });
            return { _silent: true };
        }
    });

    // ── /goal：会话级长期目标 ────────────────────────────
    // 控制词只在**整段输入恰好等于控制词**时识别；其余非空后缀一律当目标文本
    // （`/goal pause after verification` = 目标就是这个字面串）。
    function _goalLocal(controller, text) {
        if (controller && typeof controller.addLocalMessage === 'function') {
            controller.addLocalMessage('assistant', text);
        }
    }
    // 命令本地执行、输入框
    // 清空后聊天区没有任何用户输入痕迹。人面提供/修改目标文本时把它回显为一条**可见 user
    // 消息**（只进会话历史与 LLM 上下文，不触发 LLM；失败不阻断命令）。
    // 创建走创建分支、修改走 edit 分支；控制类命令（pause/resume/clear/limit）仍用本地回执。
    function _goalEchoUser(controller, text) {
        if (!controller || typeof controller.addUserMessage !== 'function') return;
        if (!text) return;
        try { controller.addUserMessage(String(text)); } catch (_) { /* 回显失败不阻断命令 */ }
    }
    function _goalStatusText(goal, armed) {
        if (!goal) {
            return AEI18n.t('当前没有目标。\n\n用法：\n- `/goal <目标>` 创建\n- `/goal edit <目标>` 修改\n- `/goal pause` / `/goal resume`\n- `/goal clear` 清除');
        }
        var lines = [AEI18n.t('**当前目标**（{phase}，第 {started}/{max} 轮，续轮{state}）', {
            phase: goal.phase,
            started: goal.roundsStarted,
            max: goal.maxGoalRounds,
            state: armed ? AEI18n.t('已启用') : AEI18n.t('未启用')
        }), '', goal.objective];
        if (goal.blockedReason) lines.push('', AEI18n.t('阻塞原因：{reason}', { reason: goal.blockedReason }));
        var next = (goal.phase === 'active' && armed) ? '/goal pause'
            : (goal.phase === 'complete' ? '/goal <新目标>' : '/goal resume');
        lines.push('', AEI18n.t('下一步可用：`{next}` / `/goal edit <目标>` / `/goal clear`', { next: next }));
        return lines.join('\n');
    }
    function _goalApply(res, controller, okText) {
        if (res && res.ok) { _goalLocal(controller, okText); } else {
            _goalLocal(controller, AEI18n.t('未执行：{reason}', {
                reason: (res && res.message) || AEI18n.t('未知错误')
            }));
        }
    }

    register('/goal', {
        category: 'session',
        description: '设置、查看、暂停、恢复或清除本会话的长期目标（自动续轮）',
        usage: '/goal [目标 | edit 目标 | limit N | pause | resume | clear]',
        // 参数补全：输入 `/goal ` 后列出；
        // insert 带尾空格的项表示还要继续填内容（edit → 新目标文本、limit → 轮数）。
        // 列表只在「命令名已精确输入」时出现，`/goal` 回车仍然是状态查询；继续输入自由目标
        // （如「把片头做完」）会因前缀不匹配自动收起，不影响创建。
        params: [
            { name: 'edit', description: '修改目标文本：/goal edit <新目标>', insert: 'edit ' },
            { name: 'pause', description: '暂停目标（不再自动续轮）' },
            { name: 'resume', description: '恢复目标并重新启用续轮' },
            { name: 'clear', description: '清除本会话目标' },
            { name: 'limit', description: '修改轮数上限：/goal limit <1-500>', insert: 'limit ' }
        ],
        onExecute: function (ctx, controller) {
            var g = controller && controller.goal;
            if (!g || typeof g.create !== 'function') {
                _goalLocal(controller, AEI18n.t('当前通道不支持目标。'));
                return { _silent: true };
            }
            if (typeof g.supported === 'function' && !g.supported()) {
                _goalLocal(controller, AEI18n.t('仅单 Agent 的 Agent/Script/Shader 档与导演支持目标。'));
                return { _silent: true };
            }
            var args = ((ctx && ctx.args) || '').replace(/^\s+|\s+$/g, '');
            if (!args) {
                _goalLocal(controller, _goalStatusText(g.get(), g.isArmed()));
                return { _silent: true };
            }
            var m = args.match(/^(\S+)(?:\s+([\s\S]*))?$/);
            var first = (m && m[1] ? m[1] : '').toLowerCase();
            var rest = (m && m[2]) ? m[2].replace(/^\s+|\s+$/g, '') : '';
            var cur = g.get();
            var ref = cur ? cur.revision : 0;
            // 控制词只在**整段输入恰好等于控制词**时生效（`/goal pause after verification`
            // 是目标文本，不是暂停）；edit 例外——它必须带内联替换内容。
            var whole = args.toLowerCase();

            if (whole === 'pause') {
                _goalApply(g.pause({ ref: ref, pausedBy: 'human' }), controller, AEI18n.t('目标已暂停。'));
                return { _silent: true };
            }
            if (whole === 'resume') {
                _goalApply(g.resume({ ref: ref }), controller, AEI18n.t('目标已恢复，续轮已启用。'));
                return { _silent: true };
            }
            if (whole === 'clear') {
                g.clear();
                _goalLocal(controller, AEI18n.t('已清除目标。'));
                return { _silent: true };
            }
            if (first === 'edit') {
                if (!rest) { _goalLocal(controller, AEI18n.t('用法：`/goal edit <新目标>`')); return { _silent: true }; }
                var editRes = g.edit({ ref: ref, objective: rest });
                // 回显新目标文本（成功才算；聊天区保持「用户说 → 已更新」的阅读顺序）
                if (editRes && editRes.ok) _goalEchoUser(controller, rest);
                _goalApply(editRes, controller, AEI18n.t('目标已更新。'));
                return { _silent: true };
            }
            // 轮数上限：blocked(round-limit) 后人类唯一能解除的死锁出口（改完顺带恢复）
            if (first === 'limit') {
                var lim = parseInt(rest, 10);
                if (!isFinite(lim) || lim <= 0) {
                    _goalLocal(controller, AEI18n.t('用法：`/goal limit <轮数上限>`（1–500）'));
                    return { _silent: true };
                }
                var edited = g.edit({ ref: ref, maxGoalRounds: lim });
                if (!edited || !edited.ok) {
                    _goalLocal(controller, AEI18n.t('未执行：{reason}', {
                        reason: (edited && edited.message) || AEI18n.t('未知错误')
                    }));
                    return { _silent: true };
                }
                var after = g.get();
                if (after && after.phase === 'blocked') {
                    _goalApply(g.resume({ ref: after.revision }), controller,
                        AEI18n.t('轮数上限已改为 {n}，目标已恢复。', { n: lim }));
                } else {
                    _goalLocal(controller, AEI18n.t('轮数上限已改为 {n}。', { n: lim }));
                }
                return { _silent: true };
            }
            // 其余一律当目标文本
            var created = g.create({ objective: args });
            if (created && created.ok) {
                // 把**目标文本**回显为一条可见 user 消息（不触发 LLM；第 1 轮仍走隐藏注入），
                // 聊天历史保留用户意图，自动标题也取自这段文本。放在 toast/arm 之前：
                // 消息先落、再提示、再开工，顺序读起来自然。
                _goalEchoUser(controller, args);
                // 首次发目标不落系统卡，续轮才需要：创建回执不再
                // addLocalMessage 落聊天卡（chat 区保持干净），状态确认交给顶栏目标条 +
                // 一条会自动消失的轻提示。回执/提示仍排在 arm 之前：arm 在空闲时会立刻
                // 评估起轮，读起来才是「设定完 → 开工」。
                var _cap = created.goal ? created.goal.maxGoalRounds : '?';
                if (global.AEToast && typeof global.AEToast.show === 'function') {
                    try {
                        global.AEToast.show(AEI18n.t('目标已设定（上限 {n} 轮），续轮已启用', { n: _cap }), 'info');
                    } catch (_) { /* 提示失败不影响目标建立 */ }
                }
                g.arm();
            } else {
                _goalLocal(controller, AEI18n.t('未执行：{reason}', {
                    reason: (created && created.message) || AEI18n.t('未知错误')
                }));
            }
            return { _silent: true };
        }
    });

    ns.slashCommands = {
        parseSlashCommand: parseSlashCommand,
        register: register,
        match: match,
        matchParams: matchParams,
        getByExactName: getByExactName,
        execute: execute,
        COMMANDS: COMMANDS
    };

    global.AEEngine = ns;
})(window);
