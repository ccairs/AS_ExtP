(function (global) {
    'use strict';
    // 会话级 goal 的模型侧三工具：
    //   get_goal     读当前目标与续轮激活态（任何轮次来源都允许）
    //   create_goal  建目标（仅用户直接发起的轮次）
    //   update_goal  edit/pause/resume 仅用户直接发起的轮次；complete/blocked 除用户轮次外
    //                还允许本目标的自动续轮（Goal Round）
    //
    // 分层：状态机判据在 engine/goalState.js，持久化与 activation 在 controller 的 goal 门面，
    // 本文件只做「工具入参 → 门面调用 → 紧凑 JSON 结果」的翻译，不复制任何一条判据。
    // 可见性也不在这里决定：注册条件在 controller（子 Agent 不注册），三档可见性由
    // shared/toolVisibility.js 的分类表与用户配置决定，团队执行 lane 另由 team/lanes.js 的
    // execLaneToolFilter 兜底。
    //
    // 结果形态：成功 = { goal, activation }；被拒 = { ok:false, code, message }。
    // handler 返回 toolExecutor 认的 MCP 形态，content[0].text 是紧凑 JSON 文本。

    var UPDATE_ACTIONS = ['edit', 'pause', 'resume', 'complete', 'blocked'];
    // 工具身份 = [agent, team, script, shader]：单 Agent 三档（agent / script / shader，
    // Script 档也支持目标）与团队导演 lane（含 team）都可见；团队执行 lane 的可见性
    // 另由 lanes.js 收窄（与 updateTeamTasks 的 team 身份同款）。
    // 'agent' 保持在首位（toolExecutor 的 handler 契约仍取首项做单串 moduleId）。
    var GOAL_TOOL_SCOPE = { type: 'module', moduleIds: ['agent', 'team', 'script', 'shader'] };
    var AUTHORITY_TEXT = '该操作需在用户直接发起的轮次调用';

    function _trimText(v) {
        return (typeof v === 'string') ? v.replace(/^\s+|\s+$/g, '') : '';
    }
    function _hasText(v) {
        return _trimText(v) !== '';
    }
    function _isPlainObject(v) {
        return !!v && typeof v === 'object' && !Array.isArray(v);
    }
    function _invalidArgs(message) {
        return { ok: false, code: 'GOAL_INVALID_ARGS', message: message };
    }
    function _fail(code, message) {
        return { ok: false, code: code, message: message };
    }

    // 发给模型的 goal 视图：只带紧凑字段，blockedReason 只在存在时带出
    //（pausedBy / 时间戳属内部状态，不进工具结果）。
    function _compactGoal(goal) {
        if (!goal || typeof goal !== 'object') return null;
        var out = {
            id: goal.id,
            revision: goal.revision,
            objective: goal.objective,
            phase: goal.phase,
            roundsStarted: goal.roundsStarted,
            maxGoalRounds: goal.maxGoalRounds
        };
        if (_hasText(goal.blockedReason)) out.blockedReason = goal.blockedReason;
        return out;
    }

    function _toolText(payload) {
        var failed = !!(payload && payload.ok === false);
        return {
            success: !failed,
            isError: failed,
            content: [{ type: 'text', text: JSON.stringify(payload) }]
        };
    }

    // opts.goalApi：controller 的 goal 门面（get / isArmed / origin / arm / disarm /
    //   create / edit / pause / resume / complete / block / clear，变更方法返回 { ok, goal } 或
    //   { ok:false, code, message }）。
    // opts.isTeamMode：装配契约里的可选入参，工具面**不据它分流**——通道合法性只由注册条件与
    //   lanes.js 的收窄判据决定（判据单一来源；这里再读一遍就是第二套通道判据）。
    function createGoalTools(opts) {
        var o = opts || {};
        var goalApi = o.goalApi || null;
        if (!goalApi || typeof goalApi.get !== 'function' || typeof goalApi.origin !== 'function') {
            if (typeof console !== 'undefined' && console && console.warn) {
                console.warn('[Agent] goal 门面未注入（createGoalTools 的 goalApi 不完整）：goal 三工具不注册');
            }
            return [];
        }

        function _origin() {
            var origin = '';
            try { origin = goalApi.origin(); } catch (_) { origin = ''; }
            // 取不到来源时按用户轮次处理：controller 的初值就是 'user'，取不到只说明门面残缺；
            // 真正的状态校验仍在 goalState/controller 侧。
            return (typeof origin === 'string' && origin) ? origin : 'user';
        }
        function _activation() {
            try { return goalApi.isArmed() ? 'armed' : 'disarmed'; } catch (_) { return 'disarmed'; }
        }
        function _currentGoal() {
            try { return goalApi.get() || null; } catch (_) { return null; }
        }
        function _valueResult(goal) {
            return _toolText({ goal: _compactGoal(goal), activation: _activation() });
        }
        // 权限按发起方判定：create/edit 只认用户直接发起的调用
        //（团队档用户默认就在跟导演说话 ⇒ 导演开工会话就是 user 轮，不需要为派单开洞）；
        // complete/blocked 额外认本目标的 Goal Round。子 Agent / bg / system 轮一律拒绝。
        function _authorityFailure(action) {
            var origin = _origin();
            var allowed = (action === 'complete' || action === 'blocked')
                ? (origin === 'user' || origin === 'goal')
                : (origin === 'user');
            if (allowed) return null;
            return _fail('GOAL_AUTHORITY_REQUIRED',
                AUTHORITY_TEXT + '（' + action + '；当前轮次来源 ' + origin + '）。');
        }
        // 门面拒绝结果原样透传错误码（GOAL_STALE_REVISION / GOAL_EXISTS / GOAL_NOT_FOUND …）。
        function _apiFailure(res) {
            if (res && typeof res === 'object' && res.ok === false) {
                return _fail(res.code || 'GOAL_INVALID_ARGS', res.message || '目标操作被拒绝');
            }
            return _fail('GOAL_INVALID_ARGS', '目标操作没有返回结果');
        }

        function _handleGet() {
            return _valueResult(_currentGoal());
        }

        function _handleCreate(args) {
            var a = _isPlainObject(args) ? args : {};
            var denied = _authorityFailure('create');
            if (denied) return _toolText(denied);
            // blocked_reason 只属于 update_goal action=blocked；create 带上就是调用方理解错了。
            if (_hasText(a.blocked_reason)) {
                return _toolText(_invalidArgs('blocked_reason 仅用于 update_goal 的 action=blocked'));
            }
            var req = { objective: a.objective };
            // 缺省不传：由 controller 门面取模块设置里的「目标默认轮数上限」。
            if (a.max_goal_rounds !== undefined && a.max_goal_rounds !== null && a.max_goal_rounds !== '') {
                req.maxGoalRounds = a.max_goal_rounds;
            }
            var res = goalApi.create(req);
            if (!res || res.ok !== true) return _toolText(_apiFailure(res));
            // controller 的 goal.create 只落状态不 arm（人面 /goal 由命令层补 arm）；模型自建的
            // 目标要立刻进入自动续轮，否则这个目标永远等不到下一轮。
            if (typeof goalApi.arm === 'function') {
                try { goalApi.arm(); } catch (_) { /* arm 失败不影响状态本身 */ }
            }
            return _valueResult(res.goal);
        }

        function _handleUpdate(args) {
            var a = _isPlainObject(args) ? args : {};
            var action = _trimText(a.action);
            if (UPDATE_ACTIONS.indexOf(action) < 0) {
                return _toolText(_invalidArgs('action 必须是 edit / pause / resume / complete / blocked'));
            }
            var denied = _authorityFailure(action);
            if (denied) return _toolText(denied);

            // 参数互斥：objective / max_goal_rounds 仅 edit，blocked_reason 仅 blocked；
            // 空串按省略处理（模型严格 schema 下会传 "" 占位）。
            var objective = _trimText(a.objective);
            var hasRoundCap = (a.max_goal_rounds !== undefined && a.max_goal_rounds !== null
                && a.max_goal_rounds !== '');
            var hasBlockedReason = _hasText(a.blocked_reason);
            if (action !== 'edit' && (objective || hasRoundCap)) {
                return _toolText(_invalidArgs('objective 与 max_goal_rounds 仅用于 action=edit'));
            }
            if (action !== 'blocked' && hasBlockedReason) {
                return _toolText(_invalidArgs('blocked_reason 仅用于 action=blocked'));
            }
            if (action === 'blocked' && !hasBlockedReason) {
                // 阈值 1：Goal Round 里可直接报阻塞，但必须写清具体条件。
                return _toolText(_invalidArgs('action=blocked 必须给出 blocked_reason（具体阻塞条件）'));
            }

            // CAS：goal_id 认目标、revision 认版本（版本不一致的拒绝码由 goalState 给出）。
            var goalId = _trimText(a.goal_id);
            if (!goalId) return _toolText(_invalidArgs('goal_id 不能为空'));
            var revision = Number(a.revision);
            if (!isFinite(revision) || Math.floor(revision) !== revision || revision < 1) {
                return _toolText(_invalidArgs('revision 必须是正整数'));
            }
            var current = _currentGoal();
            if (!current) return _toolText(_fail('GOAL_NOT_FOUND', '当前没有目标'));
            if (current.id && goalId !== current.id) {
                return _toolText(_fail('GOAL_STALE_REVISION',
                    '目标已更换（当前 id ' + current.id + '）：请重新 get_goal 后再改'));
            }

            var req = { ref: revision };
            var res = null;
            if (action === 'edit') {
                if (objective) req.objective = objective;
                if (hasRoundCap) req.maxGoalRounds = a.max_goal_rounds;
                res = goalApi.edit(req);
            } else if (action === 'pause') {
                // 只传 ref：pausedBy 由门面按语义补（人面/工具触发 = human，引擎在用户点停止时
                // 自己写 stop），工具层不复制这份判据。
                res = goalApi.pause(req);
            } else if (action === 'resume') {
                res = goalApi.resume(req);
            } else if (action === 'complete') {
                res = goalApi.complete(req);
            } else {
                req.reason = _trimText(a.blocked_reason);
                res = goalApi.block(req);
            }
            if (!res || res.ok !== true) return _toolText(_apiFailure(res));
            return _valueResult(res.goal);
        }

        return [
            {
                name: 'get_goal',
                description: '读取当前会话的长期目标。没有目标时 goal 为 null。'
                    + '结果里的 id 与 revision 是 update_goal 必需的。',
                input_schema: { type: 'object', properties: {}, required: [] },
                handler: _handleGet,
                scope: GOAL_TOOL_SCOPE,
                category: 'goal',
                source: 'agent'
            },
            {
                name: 'create_goal',
                description: '创建一个跨轮持续的长期目标，本会话会在每轮结束后自动继续推进，'
                    + '直到完成、暂停或轮数用尽。用户直接请求是一个需要多轮才能完成的目标时使用'
                    + '（用户不必说「目标」二字）；单轮任务不要用。',
                input_schema: {
                    type: 'object',
                    properties: {
                        objective: {
                            type: 'string',
                            description: '从用户直接请求里理解出的完成目标'
                        },
                        max_goal_rounds: {
                            type: 'number',
                            description: '可选，正整数，自动续轮上限（缺省取模块设置里的目标默认轮数上限）'
                        }
                    },
                    required: ['objective']
                },
                handler: _handleCreate,
                scope: GOAL_TOOL_SCOPE,
                category: 'goal',
                source: 'agent'
            },
            {
                name: 'update_goal',
                description: '更新当前目标。edit / pause / resume 只能在用户直接发起的轮次调用；'
                    + 'complete / blocked 也可以在目标的自动续轮中调用。'
                    + 'blocked 用 blocked_reason 写清具体阻塞条件。',
                input_schema: {
                    type: 'object',
                    properties: {
                        goal_id: { type: 'string', description: 'get_goal 返回的 id' },
                        revision: { type: 'number', description: 'get_goal 返回的 revision，用于拒绝陈旧视图' },
                        action: {
                            type: 'string',
                            enum: UPDATE_ACTIONS.slice(),
                            description: 'edit/pause/resume 需用户直接发起的轮次；'
                                + 'complete/blocked 也可在目标自动续轮中调用'
                        },
                        objective: { type: 'string', description: '仅 edit：替换目标' },
                        max_goal_rounds: { type: 'number', description: '仅 edit：替换轮数上限（1–500）' },
                        blocked_reason: { type: 'string', description: '仅 blocked：具体的阻塞条件（不能为空）' }
                    },
                    required: ['goal_id', 'revision', 'action']
                },
                handler: _handleUpdate,
                scope: GOAL_TOOL_SCOPE,
                category: 'goal',
                source: 'agent'
            }
        ];
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createGoalTools = createGoalTools;
})(typeof window !== 'undefined' ? window : globalThis);
