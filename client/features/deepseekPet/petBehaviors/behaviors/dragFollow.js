// dragFollow.js - 拖拽响应：drag:start 时切循环动画并保持到 drag:end
(function (global) {
    'use strict';

    function createDragFollow() {
        // 每个实例独立持有清理状态，避免多次 createDragFollow 互相覆盖
        // （_selfCleanup 移入闭包，不再放模块作用域）
        var _selfCleanup = { _onEnd: null, _resolve: null, _petApi: null };
        // 执行序号：打断/新一次执行都会自增，使未决的 dragStart 侧链失效
        var _runId = 0;

        return {
            id: 'dragFollow',
            type: 'drag',
            priority: 10,
            condition: function (ctx) {
                // 仅在 drag:start 时触发；drag:end 时 behaviorLock 仍为 true（本行为未结束），
                // dispatch 会被跳过，由 _finishBehavior 自动 emit('idle:enter') 切回 idle
                return ctx.dragPhase === 'start';
            },
            action: function (petApi) {
                var myRun = ++_runId;
                var state = petApi.getState();
                // 睡眠期间拖拽：只更新位置（dragHandler 已处理），
                // 不播放 dragStart/drag/dragEnd 序列帧避免覆盖 sleep 动画
                if (state.inSleepMode) {
                    var sleepResolve = null;
                    var sleepOnEnd = function () {
                        petApi.off('drag:end', sleepOnEnd);
                        if (typeof sleepResolve === 'function') sleepResolve();
                    };
                    petApi.on('drag:end', sleepOnEnd);
                    _selfCleanup._onEnd = sleepOnEnd;
                    // 关键：_resolve 必须是 settle Promise 的函数，而非赋值器
                    // onInterrupt 调 c._resolve() 无参 settle Promise，避免永久悬挂
                    _selfCleanup._resolve = function () {
                        if (typeof sleepResolve === 'function') sleepResolve();
                    };
                    _selfCleanup._petApi = petApi;
                    return new Promise(function (resolve) { sleepResolve = resolve; });
                }
                // 拖拽序列：dragStart（一次性入场）-> drag（循环保持）-> drag:end 时 dragEnd（一次性收尾）
                // 加 catch：dragStart 被 interrupt 时 reject 会冒泡为 unhandledrejection
                petApi.playAnim('dragStart').then(function () {
                    // 已被打断/被新执行取代：不切 drag 循环动画，
                    // 避免覆盖打断方（如 crashOverride）正在播放的动画
                    if (myRun !== _runId) return;
                    // dragStart 结束后切循环拖拽动画；若期间 drag:end 已触发则跳过
                    if (petApi.getState().isDragging) {
                        petApi.playAnim('drag');
                    }
                }).catch(function () {
                    // dragStart 被打断（如用户快速松手触发 interruptCurrent）：忽略，主 promise 由 _onEnd 处理
                });
                // 把 onEnd 和 resolve 引用挂到 _self，便于 onInterrupt 钩子清理
                var _resolve = null;
                var _onEnd = null;
                var promise = new Promise(function (resolve) {
                    _resolve = resolve;
                    _onEnd = function () {
                        petApi.off('drag:end', _onEnd);
                        // 播放结束拖拽动画，结束后再 resolve 让 _finishBehavior 切回 idle
                        petApi.playAnim('dragEnd').then(resolve, resolve);
                    };
                    petApi.on('drag:end', _onEnd);
                });
                // 暴露给 onInterrupt 钩子使用
                _selfCleanup._onEnd = _onEnd;
                _selfCleanup._resolve = _resolve;
                _selfCleanup._petApi = petApi;
                return promise;
            },
            // behavior 被强制打断时调用，清理 drag:end 监听器并 resolve pending Promise
            // （防止监听器泄漏和 Promise 永久悬挂）
            onInterrupt: function () {
                // 使未决的 dragStart 侧链失效（不会 playAnim('drag')）
                _runId++;
                var c = _selfCleanup;
                if (c._onEnd && c._petApi) {
                    c._petApi.off('drag:end', c._onEnd);
                }
                if (typeof c._resolve === 'function') {
                    c._resolve();  // settle pending Promise
                }
                _selfCleanup._onEnd = null;
                _selfCleanup._resolve = null;
                _selfCleanup._petApi = null;
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.dragFollow = createDragFollow;
})(window);
