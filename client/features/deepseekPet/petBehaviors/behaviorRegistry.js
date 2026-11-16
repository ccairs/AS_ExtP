// behaviorRegistry.js — 行为注册中心，按类型+优先级+条件调度
(function (global) {
    'use strict';

    function createBehaviorRegistry(eventBus) {
        var _behaviors = [];
        var _petApi = null;
        var _ctx = null;
        var _currentBehaviorId = null;
        // 执行序号：_execute 每次执行自增，使同 id 重入时旧实例迟到的 Promise 回调失效
        var _execSeq = 0;

        function setPetApi(api) { _petApi = api; }
        function setCtx(ctx) { _ctx = ctx; }

        function init() {}

        function register(behavior) {
            if (!behavior || !behavior.id) return;
            unregister(behavior.id);
            _behaviors.push(behavior);
        }

        function unregister(id) {
            for (var i = _behaviors.length - 1; i >= 0; i--) {
                if (_behaviors[i].id === id) _behaviors.splice(i, 1);
            }
        }

        function replace(id, behavior) {
            for (var i = 0; i < _behaviors.length; i++) {
                if (_behaviors[i].id === id) {
                    behavior.id = id;
                    _behaviors[i] = behavior;
                    return;
                }
            }
            register(behavior);
        }

        function dispatch(type, ctx, forceId) {
            if (!_petApi || !ctx) return;

            if (forceId) {
                var forced = _findById(forceId);
                if (forced) {
                    _execute(forced, ctx);
                }
                return;
            }

            // 非 forceId 分支：检测并通知 silent behavior 被打断
            // triggerAction 走 forceId 时设置 silent=true 屏蔽 showBubble + movement.pause()；
            // 若 silent behavior 执行期间用户/系统触发了新的普通 dispatch（如 click），
            // 此处 emit 事件让 controller resume movement，并复位 silent 让新 behavior showBubble 正常
            if (ctx.silent) {
                eventBus.emit('silent:action:done');
            }
            ctx.silent = false;

            var candidates = [];
            for (var i = 0; i < _behaviors.length; i++) {
                var b = _behaviors[i];
                if (b.type !== type) continue;
                if (type === 'event') {
                    candidates.push(b);
                    continue;
                }
                if (ctx.behaviorLock && b.priority < 100) continue;
                try {
                    if (!b.condition || b.condition(ctx)) {
                        candidates.push(b);
                    }
                } catch (e) {
                    console.warn('[behaviorRegistry] condition error for "' + b.id + '": ' + e);
                }
            }

            if (candidates.length === 0) return;

            candidates.sort(function (a, b) {
                if (b.priority !== a.priority) return b.priority - a.priority;
                return 0;
            });

            var winner = candidates[0];
            _execute(winner, ctx);
        }

        function _execute(behavior, ctx) {
            // 强制打断前一个行为：若当前已有行为在执行，标记为被打断，跳过其 _finishBehavior 的状态恢复逻辑
            var interruptedId = _currentBehaviorId;
            // 执行序号：同 id 重入时（如 crashOverride 执行中 bridge 真断线、_checkBridgeOnce
            // 再次 forceId 派发同一 behavior），下方 then 回调里 _currentBehaviorId === behavior.id
            // 的身份检查无法区分新旧实例，旧 Promise 迟到 settle 会误触发 _finishBehavior
            // （提前解锁 behaviorLock / 篡改 crashOverride 的 bridgeStatus）。序号自增使旧实例回调失效
            var myExec = ++_execSeq;
            // 触发被打断 behavior 的 onInterrupt 钩子，让其清理监听器/Promise（防止泄漏）
            // 同 id 重入也必须清理：旧实例的 timer/事件监听若不卸载会残留并干扰新执行
            if (interruptedId) {
                var oldBehavior = _findById(interruptedId);
                if (oldBehavior && typeof oldBehavior.onInterrupt === 'function') {
                    try { oldBehavior.onInterrupt(_petApi); } catch (e) {
                        console.warn('[behaviorRegistry] onInterrupt error for "' + oldBehavior.id + '": ' + e);
                    }
                }
                // 广播行为代际中断——被打断行为的 duration=0 常驻气泡
                // （如 crashOverride 断连提示）依赖 _finishBehavior 收尾 hide，而
                // 打断会跳过收尾（.then 守卫失败），petBubble 据此降级兜底定时
                eventBus.emit('behavior:interrupted', { id: interruptedId });
                // 若被打断的是 silent behavior（LLM 触发的动作），需 emit 事件让 controller resume movement
                // triggerAction 中 movement.pause() 了，正常结束走 _finishBehavior emit，
                // 被 forceId 二次打断（如 LLM 连续触发两个动作）时不会进入 _finishBehavior，需在此处补发
                // 同 id 重入不补发：silent 标志属于新执行的上下文，resume 会覆盖新 behavior 的 pause
                if (interruptedId !== behavior.id && ctx.silent) {
                    eventBus.emit('silent:action:done');
                }
            }
            var prevState = ctx.petState;
            var usedSetState = false;
            ctx.behaviorLock = true;
            ctx.petState = 'action';
            _currentBehaviorId = behavior.id;

            var api = _wrapApi(behavior, ctx, function () { usedSetState = true; });

            try {
                var result = behavior.action(api);
                if (result && typeof result.then === 'function') {
                    result.then(function () {
                        // 仅当当前行为仍是自己（避免被后续 crashOverride 二次打断时重复结束），
                        // 且执行序号仍最新（同 id 重入时旧实例 Promise 迟到 settle 不得触发收尾）才结束
                        if (_execSeq === myExec && _currentBehaviorId === behavior.id) {
                            _finishBehavior(behavior, ctx, usedSetState, prevState);
                        }
                    }).catch(function (e) {
                        console.warn('[behaviorRegistry] action rejected for "' + behavior.id + '": ' + e);
                        if (_execSeq === myExec && _currentBehaviorId === behavior.id) {
                            _finishBehavior(behavior, ctx, usedSetState, prevState);
                        }
                    });
                } else {
                    _finishBehavior(behavior, ctx, usedSetState, prevState);
                }
            } catch (e) {
                console.warn('[behaviorRegistry] action threw for "' + behavior.id + '": ' + e);
                _finishBehavior(behavior, ctx, usedSetState, prevState);
            }
        }

        function _wrapApi(behavior, ctx, markSetState) {
            var api = _petApi;
            var wrappedSetState = function (state) {
                markSetState();
                api.setState(state);
            };
            // silent 模式：LLM 触发场景下屏蔽 showBubble，避免覆盖 LLM 回复气泡
            // hideBubble 仍允许调用，便于 silent behavior 主动清理旧气泡
            var wrappedShowBubble = function (text, duration) {
                if (ctx.silent) return;
                api.showBubble(text, duration);
            };
            return Object.assign({}, api, {
                setState: wrappedSetState,
                showBubble: wrappedShowBubble
            });
        }

        function _finishBehavior(behavior, ctx, usedSetState, prevState) {
            ctx.behaviorLock = false;
            _currentBehaviorId = null;
            // 记录是否为 silent behavior，便于结束后通知 controller resume movement
            var wasSilent = !!ctx.silent;
            // 复位 silent 标志：本次 behavior 是 LLM 触发的静默执行，结束后恢复正常 showBubble
            ctx.silent = false;
            if (behavior.id === 'crashOverride') {
                ctx.bridgeStatus = 'ready';
                // 清除 crash 气泡（showBubble(duration=0) 的气泡不会自动消失）
                if (typeof _petApi !== 'undefined') {
                    _petApi.hideBubble();
                }
                if (ctx.inSleepMode) {
                    // 睡眠期间 Bridge 断线恢复：crashOverride 收尾必须回到 sleep 态
                    // （与下方 inSleepMode 分支同语义），否则强制 idle 会让桌宠"睁眼"、
                    // 且不重派发 sleep 导致 sleepTalk 整个睡眠期永久死亡
                    // （crashOverride 非 sleep 类型，重派发不会无限同步递归）
                    ctx.petState = 'sleep';
                    if (typeof _petApi !== 'undefined') {
                        _petApi.playAnim('sleep');
                    }
                    dispatch('sleep', ctx);
                } else {
                    ctx.petState = 'idle';
                    eventBus.emit('idle:enter');
                    // 恢复 idle 动画
                    if (typeof _petApi !== 'undefined') {
                        _petApi.playAnim('idle');
                    }
                }
            } else if (usedSetState) {
                // 保持 setState 设置的目标状态
            } else if (ctx.inSleepMode) {
                // 睡眠期间 behavior 结束时保持 sleep 状态，不切 idle
                // 否则 dragFollow 睡眠分支结束后会 emit idle:enter -> play('idle') 覆盖 sleep 循环
                ctx.petState = 'sleep';
                if (typeof _petApi !== 'undefined') {
                    _petApi.playAnim('sleep');
                }
                // 重新派发睡眠行为：强制睡眠中被拖拽会打断 sleepTalk（interruptCurrent），
                // dragFollow 收尾后若不重新 dispatch，整个睡眠期不再有梦话调度
                // （_finishBehavior 开头已清 behaviorLock/_currentBehaviorId，此处 dispatch 安全）
                // 仅对非 sleep 类型重派发：sleep 行为自身同步抛错时
                // _execute catch → _finishBehavior → dispatch 会无限同步递归
                if (behavior.type !== 'sleep') {
                    dispatch('sleep', ctx);
                }
            } else {
                ctx.petState = 'idle';
                eventBus.emit('idle:enter');
            }
            // silent behavior 结束后通知 controller：triggerAction 中 movement.pause() 了，
            // 需要由 controller 监听此事件 resume movement
            if (wasSilent) {
                eventBus.emit('silent:action:done');
            }
        }

        function _findById(id) {
            for (var i = 0; i < _behaviors.length; i++) {
                if (_behaviors[i].id === id) return _behaviors[i];
            }
            return null;
        }

        // 强制打断当前正在执行的 behavior（如 idleWander 的 moveTo 未 resolve 时被拖拽打断）
        // 调用其 onInterrupt 钩子清理监听器/Promise，并清 behaviorLock 释放后续 dispatch
        function interruptCurrent() {
            if (!_currentBehaviorId) return;
            var b = _findById(_currentBehaviorId);
            if (b && typeof b.onInterrupt === 'function') {
                try { b.onInterrupt(_petApi); } catch (e) {
                    console.warn('[behaviorRegistry] interruptCurrent onInterrupt error for "' + b.id + '": ' + e);
                }
            }
            // 广播行为代际中断（拖拽/睡眠/点击/唤醒等打断路径）——
            // duration=0 常驻气泡依赖 _finishBehavior 收尾 hide，而 interruptCurrent
            // 置空 _currentBehaviorId 后 .then 收尾守卫失败、永不 hide；petBubble
            // 监听此事件将粘性气泡降级 30s 兜底定时，防止永久滞留
            eventBus.emit('behavior:interrupted', { id: _currentBehaviorId });
            // 若被打断的是 silent behavior，需通知 controller resume movement
            // （triggerAction 中 pause 了 movement，正常结束走 _finishBehavior，
            //   被打断时不会进入 _finishBehavior，需在此处补发事件）
            var wasSilent = _ctx && _ctx.silent;
            _currentBehaviorId = null;
            if (_ctx) {
                _ctx.behaviorLock = false;
                _ctx.petState = 'idle';
                _ctx.silent = false;
            }
            if (wasSilent) {
                eventBus.emit('silent:action:done');
            }
        }

        function list() { return _behaviors.slice(); }
        function getById(id) { return _findById(id); }
        function getCurrentBehaviorId() { return _currentBehaviorId; }

        // destroy：清空注册表 + 打断当前 behavior 的 onInterrupt 清理（不 emit 事件）
        // 避免 controller.destroy 后 behavior Promise 回调访问已销毁的 _petApi/_ctx
        // 注意：不调 interruptCurrent（它会 emit silent:action:done 触发已销毁模块的回调），
        // 直接调 onInterrupt 清理监听器，settle Promise 由 behavior 自己的 catch 处理
        function destroy() {
            if (_currentBehaviorId && _ctx) {
                var b = _findById(_currentBehaviorId);
                if (b && typeof b.onInterrupt === 'function') {
                    try { b.onInterrupt(_petApi); } catch (e) {}
                }
            }
            _currentBehaviorId = null;
            _behaviors = [];
            _petApi = null;
            _ctx = null;
        }

        return {
            setPetApi: setPetApi,
            setCtx: setCtx,
            init: init,
            register: register,
            unregister: unregister,
            replace: replace,
            dispatch: dispatch,
            interruptCurrent: interruptCurrent,
            list: list,
            getById: getById,
            getCurrentBehaviorId: getCurrentBehaviorId,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createBehaviorRegistry = createBehaviorRegistry;
})(window);
