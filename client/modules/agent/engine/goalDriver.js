(function (global) {
    'use strict';
    // 会话级 goal 的续轮驱动器。
    // 本文件只做「时机 → 判据 → 开轮」的编排，所有状态读写都经注入的 goalApi；
    // 判据只有这一份实现，controller 与 bootstrap 不复制。
    //
    // 开轮判据（全部满足）：
    //   1) 通道支持（单 Agent 主通道 / 团队导演 lane）
    //   2) phase=active 且 activation=armed
    //   3) 收尾是自然的（非用户停止、非 maxLoops、非错误收尾）——该闸门只对
    //      'round-end' / 'dispatch-end' 两个时机生效；瞬时失败（超时/网络）由 controller
    //      延迟后以 'error-retry' 时机补评估，不经本闸门（失败轮本身仍算 unclean）
    //   4) 会话一致（团队档：binder 会话未变、未分叉、不在切换）
    //   5) 让行：其它 lane（AE 执行 / Shader 执行）不忙
    //   6) 让行：导演名下没有活跃子 Agent
    //   7) 还有轮数额度；用尽则把目标转 blocked(round-limit)
    //   8) 起轮时刻真的空闲（轮内 / 会话切换 / 编辑互斥 / 用户消息派发锁期间都不算）
    // 唤醒时机（时机只由 controller / bootstrap 给，判据全在本文件）：
    //   本 controller 一轮收尾、本 controller 派发锁释放（onDispatchEnd）、arm/resume、
    //   瞬时失败后的延迟补评估（'error-retry'）、其它 lane 忙→闲（bootstrap 接线）。

    function buildRoundText(goal, round) {
        var max = (goal && goal.maxGoalRounds) || '?';
        return '<goal_round>\nObjective: ' + JSON.stringify(goal ? goal.objective : '') + '\nRound: '
            + round + '/' + max + '\n\n'
            + 'Continue working toward the objective in this same session. Treat the current workspace, '
            + 'tool results, and durable session state as authoritative; inspect them instead of assuming '
            + 'earlier narration is still current. Make concrete progress and verify the result. Before '
            + 'claiming completion, gather evidence that the whole objective is achieved, read the current '
            + 'goal, and mark it complete. If work remains and is actionable now, leave the goal active for '
            + 'the next round. If you must wait for another agent or a human, wait inside the round when it '
            + 'is short, or mark the goal blocked with the concrete condition.\n</goal_round>';
    }

    function createGoalDriver(deps) {
        var d = deps || {};
        var _evaluating = false;
        var _pending = false;

        function _warn(msg) {
            if (typeof d.warn === 'function') { d.warn(msg); } else { console.warn('[GoalDriver] ' + msg); }
        }
        function _safe(fn, fallback) {
            try { return fn(); } catch (e) {
                _warn('判据异常: ' + ((e && e.message) || e));
                return fallback;
            }
        }

        function _evaluateOnce(reason) {
            var api = d.goalApi;
            if (!api) return { started: false, why: 'no-api' };
            if (typeof d.isSupported === 'function' && !d.isSupported()) return { started: false, why: 'unsupported' };
            var goal = api.get();
            if (!goal) return { started: false, why: 'no-goal' };
            if (goal.phase !== 'active') return { started: false, why: 'phase:' + goal.phase };
            if (!api.isArmed()) return { started: false, why: 'disarmed' };
            if (typeof d.isStopped === 'function' && d.isStopped()) return { started: false, why: 'stopped' };
            // 「当前轮是否自然收尾」只在**轮刚收尾**的两个时机有意义（round-end / 派发锁释放）。
            // arm / resume / 其它 lane 忙→闲这些 kick 面前可能根本没有刚结束的轮：把上一个
            // 停止/限额轮留下的 unclean 套到它们身上，会让人工 resume 永不生效
            //（真机：/goal pause 再 resume 后不动——上一轮是 stop 收尾）。
            // 'error-retry'（瞬时失败延迟补评估）同属「不是刚收尾」的时机，故不经过本闸门。
            var _roundEndReason = (reason === 'round-end' || reason === 'dispatch-end');
            if (_roundEndReason && typeof d.isRoundClean === 'function' && !d.isRoundClean()) return { started: false, why: 'unclean' };
            if (typeof d.getSessionInfo === 'function') {
                var si = _safe(d.getSessionInfo, { ok: false });
                if (!si || !si.ok) return { started: false, why: 'session' };
            }
            if (_safe(d.getOtherLanesBusy, false)) return { started: false, why: 'lanes-busy' };
            if ((Number(_safe(d.getActiveSubagentCount, 0)) || 0) > 0) return { started: false, why: 'subagents' };
            // 8) 起轮时刻必须真的空闲。轮次在注入**之前**消耗，而注入通道在派发锁/切换窗口内
            //    会改为入队（不落卡、不唤起）——那时若已消耗，目标就停在「第 N/M 轮·进行中」
            //    却永远等不到这一轮（真机缺陷：用户消息轮收尾时派发锁仍被
            //    submitUserInput 持有）。不空闲一律不消耗，等派发结束/下一轮收尾再评估。
            if (typeof d.isIdle === 'function' && !_safe(d.isIdle, false)) {
                return { started: false, why: 'busy' };
            }
            if (!api.canStartRound()) {
                var blk = _safe(function () { return d.blockForLimit(goal); }, null);
                return { started: false, why: 'limit', blocked: !!(blk && blk.ok) };
            }
            var consumed = _safe(function () { return d.consumeRound(); }, null);
            if (!consumed || !consumed.ok) return { started: false, why: 'consume', detail: consumed };
            var g2 = api.get() || goal;
            var text = buildRoundText(g2, consumed.round);
            _safe(function () { d.injectGoalRound(text, consumed.round); }, null);
            return { started: true, round: consumed.round };
        }

        // 同步评估一次；重入时只置 pending，在当前这次结束后 setTimeout 补一次（不递归开轮）。
        function evaluate(reason) {
            if (_evaluating) { _pending = true; return { started: false, why: 'busy' }; }
            _evaluating = true;
            try {
                return _evaluateOnce(reason);
            } finally {
                _evaluating = false;
                if (_pending) {
                    _pending = false;
                    setTimeout(function () {
                        try { evaluate('pending'); } catch (e) {
                            _warn('pending 评估失败: ' + ((e && e.message) || e));
                        }
                    }, 0);
                }
            }
        }

        return { evaluate: evaluate, buildRoundText: buildRoundText };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createGoalDriver = createGoalDriver;
})(typeof window !== 'undefined' ? window : globalThis);
