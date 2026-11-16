// 目标（goal）状态机单一实现：相位迁移 / CAS（revision）/ 轮次准入的唯一判据都在本文件。
// 纯函数——无 DOM、无 IO、无定时器（`now` 由调用方注入，缺省 Date.now() 仅作时间戳来源），
// controller、工具层与 UI 只调用本文件，不复制判据。
(function (global) {
    'use strict';

    var DEFAULT_MAX_ROUNDS = 25;
    var MAX_ROUNDS_CAP = 500;
    var MIN_ROUNDS = 1;
    var PHASES = { active: true, paused: true, blocked: true, complete: true };

    function _err(code, message) { return { ok: false, code: code, message: message }; }

    // 失败原因按当前界面语言输出：AEI18n 就绪时查词典（zh 原样返回源文），
    // 未装载时按源文与 {x} 参数格式化，状态机可脱离面板环境单独运行。
    function t(str, params) {
        if (global.AEI18n && typeof global.AEI18n.t === 'function') return global.AEI18n.t(str, params);
        var s = String(str == null ? '' : str);
        if (!params) return s;
        return s.replace(/\{(\w+)\}/g, function (m, k) {
            return Object.prototype.hasOwnProperty.call(params, k) ? String(params[k]) : m;
        });
    }

    // 轮数上限归一：缺失/不可解析（undefined、null、空串、'abc'、Infinity）取 fallback；
    // 可解析的一律四舍五入后夹 1..500（正安全整数——0 与负数夹到下限 1，
    // 与设置项归一语义一致）。
    function _clampRounds(v, fallback) {
        var n = Number(v);
        if (v == null || v === '' || !isFinite(n)) n = Number(fallback);
        n = Math.round(n);
        if (!isFinite(n)) n = MIN_ROUNDS;
        if (n < MIN_ROUNDS) n = MIN_ROUNDS;
        if (n > MAX_ROUNDS_CAP) n = MAX_ROUNDS_CAP;
        return n;
    }

    function _text(v) { return typeof v === 'string' ? v.replace(/^\s+|\s+$/g, '') : ''; }

    // 变更一律产生**新对象**（不改入参）：revision + 1，updatedAt 换成本次时间戳。
    function _nextRevision(g, now) {
        return { id: g.id, revision: (g.revision || 0) + 1, objective: g.objective, phase: g.phase,
            roundsStarted: g.roundsStarted || 0, maxGoalRounds: g.maxGoalRounds,
            blockedReason: g.blockedReason, pausedBy: g.pausedBy,
            createdAt: g.createdAt, updatedAt: now };
    }

    // 创建：空目标拒绝；已有 phase != 'complete' 的目标拒绝（GOAL_EXISTS）；
    // 上限缺省取 DEFAULT_MAX_ROUNDS 并夹 1..500。
    function create(req) {
        var r = req || {};
        var objective = _text(r.objective);
        if (!objective) return _err('GOAL_INVALID_ARGS', t('目标内容不能为空'));
        var prev = r.previous;
        if (prev && prev.phase !== 'complete') return _err('GOAL_EXISTS', t('已存在未完成的目标，请先编辑、暂停或清除'));
        var now = Number(r.now) || Date.now();
        return { ok: true, goal: {
            id: _text(r.id) || ('goal_' + now + '_' + Math.floor(Math.random() * 1e6)),
            revision: 1, objective: objective, phase: 'active', roundsStarted: 0,
            maxGoalRounds: _clampRounds(r.maxGoalRounds, DEFAULT_MAX_ROUNDS),
            createdAt: now, updatedAt: now
        } };
    }

    // CAS：请求必须带与当前 goal 相同的 revision，陈旧视图一律拒绝（不静默覆盖）。
    function _checkRef(goal, ref) {
        if (!goal) return _err('GOAL_NOT_FOUND', t('当前没有目标'));
        var rev = Number(ref);
        if (rev !== goal.revision) return _err('GOAL_STALE_REVISION',
            t('目标是更新版本（当前 revision {revision}），请重新读取后再改', { revision: goal.revision }));
        return null;
    }

    // 编辑：objective 省略 = 只改轮数上限（人 `/goal limit` 与模型 edit 都要能单改上限）；
    // 显式传了但为空白仍拒绝（那不是「省略」，是错参数）。两者都没给 → 无意义的 edit，拒。
    function edit(goal, req) {
        var r = req || {};
        var stale = _checkRef(goal, r.ref); if (stale) return stale;
        var omittedObjective = (r.objective === undefined || r.objective === null);
        if (omittedObjective && r.maxGoalRounds == null) {
            return _err('GOAL_INVALID_ARGS', t('edit 至少要改目标内容或轮数上限'));
        }
        var objective = omittedObjective ? goal.objective : _text(r.objective);
        if (!objective) return _err('GOAL_INVALID_ARGS', t('目标内容不能为空'));
        var next = _nextRevision(goal, Number(r.now) || Date.now());
        next.objective = objective;
        if (r.maxGoalRounds != null) next.maxGoalRounds = _clampRounds(r.maxGoalRounds, goal.maxGoalRounds);
        return { ok: true, goal: next };
    }

    // 暂停：pausedBy 只有 'stop'（引擎在用户点停止时写）与 'human'（人/UI 发起）两种，
    // 模型没有 pause 权限（模型侧只有 blocked）。
    function pause(goal, req) {
        var r = req || {};
        var stale = _checkRef(goal, r.ref); if (stale) return stale;
        if (goal.phase === 'complete') return _err('GOAL_INVALID_ACTION', t('目标已完成'));
        var next = _nextRevision(goal, Number(r.now) || Date.now());
        next.phase = 'paused';
        next.pausedBy = (r.pausedBy === 'stop') ? 'stop' : 'human';
        return { ok: true, goal: next };
    }

    // 恢复：active/complete 不能恢复；轮数已用尽时拒绝（人须先 edit 提高上限）。
    function resume(goal, req) {
        var r = req || {};
        var stale = _checkRef(goal, r.ref); if (stale) return stale;
        if (goal.phase === 'active') return _err('GOAL_INVALID_ACTION', t('目标已在运行'));
        if (goal.phase === 'complete') return _err('GOAL_INVALID_ACTION', t('目标已完成，不能再恢复'));
        var cap = (r.maxGoalRounds != null) ? _clampRounds(r.maxGoalRounds, goal.maxGoalRounds) : goal.maxGoalRounds;
        if (goal.roundsStarted >= cap) return _err('GOAL_ROUND_LIMIT', t('轮数上限已用尽，请先提高上限'));
        var next = _nextRevision(goal, Number(r.now) || Date.now());
        next.phase = 'active';
        next.maxGoalRounds = cap;
        delete next.blockedReason; delete next.pausedBy;
        return { ok: true, goal: next };
    }

    function complete(goal, req) {
        var r = req || {};
        var stale = _checkRef(goal, r.ref); if (stale) return stale;
        var next = _nextRevision(goal, Number(r.now) || Date.now());
        next.phase = 'complete';
        return { ok: true, goal: next };
    }

    // 阻塞：原因必填（写清具体阻塞条件）；模型侧唯一的「停下来」通道。
    function block(goal, req) {
        var r = req || {};
        var stale = _checkRef(goal, r.ref); if (stale) return stale;
        var reason = _text(r.reason);
        if (!reason) return _err('GOAL_INVALID_ARGS', t('blocked 必须说明阻塞原因'));
        var next = _nextRevision(goal, Number(r.now) || Date.now());
        next.phase = 'blocked';
        next.blockedReason = reason;
        return { ok: true, goal: next };
    }

    // 清除：移除当前目标（持久侧是索引条目置 null，由 sessionStore.setGoal 落盘）。
    function clear(goal) { return null; }

    // 轮次准入：仅 active 可消耗；到上限拒绝（调用方据此转 blocked(round-limit)）。
    function consumeRound(goal, req) {
        var r = req || {};
        if (!goal) return _err('GOAL_NOT_FOUND', t('当前没有目标'));
        if (goal.phase !== 'active') return _err('GOAL_INVALID_ACTION', t('目标不在运行态'));
        if ((goal.roundsStarted || 0) >= goal.maxGoalRounds) return _err('GOAL_ROUND_LIMIT', t('轮数上限已用尽'));
        var next = _nextRevision(goal, Number(r.now) || Date.now());
        next.roundsStarted = (goal.roundsStarted || 0) + 1;
        return { ok: true, goal: next, round: next.roundsStarted };
    }

    // 续轮判据的唯一实现：active + armed + 还有额度。
    function canStartRound(goal, activation) {
        return !!(goal && goal.phase === 'active' && activation === 'armed'
            && (goal.roundsStarted || 0) < goal.maxGoalRounds);
    }

    // 旧数据/坏数据归一：相位非法、目标为空 → null（视为无目标，不迁移不补写）；
    // 合法数据保留相位并夹取轮数字段。
    function normalizeGoal(raw) {
        if (!raw || typeof raw !== 'object') return null;
        if (!PHASES[raw.phase]) { return null; }
        var objective = _text(raw.objective);
        if (!objective) return null;
        return {
            id: _text(raw.id), revision: Math.max(1, Math.round(Number(raw.revision) || 1)),
            objective: objective, phase: raw.phase,
            roundsStarted: Math.max(0, Math.round(Number(raw.roundsStarted) || 0)),
            maxGoalRounds: _clampRounds(raw.maxGoalRounds, DEFAULT_MAX_ROUNDS),
            blockedReason: _text(raw.blockedReason) || undefined,
            pausedBy: raw.pausedBy, createdAt: Number(raw.createdAt) || 0,
            updatedAt: Number(raw.updatedAt) || 0
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.goalState = {
        DEFAULT_MAX_ROUNDS: DEFAULT_MAX_ROUNDS, MAX_ROUNDS_CAP: MAX_ROUNDS_CAP,
        create: create, edit: edit, pause: pause, resume: resume, complete: complete,
        block: block, clear: clear, consumeRound: consumeRound,
        canStartRound: canStartRound, normalizeGoal: normalizeGoal
    };
})(typeof window !== 'undefined' ? window : globalThis);
