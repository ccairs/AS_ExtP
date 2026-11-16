// timerAnnounce.js — 定时闲时播报
(function (global) {
    'use strict';

    // 气泡缺失时的兜底停留时长（petBubble 未装载的降级环境）：与原写死的 4s 一致
    var FALLBACK_BUBBLE_MS = 4000;

    // 气泡停留时长与行为占用时长必须同源：气泡由 petBubble.bubbleDurationMs 按台词
    // 长度自适应（短台词 4s 起、长台词最多 12s），行为锁也按同一时长 wait——
    // 否则气泡还在、行为已收尾（或被下一个行为顶掉）。
    function _bubbleMs(text) {
        if (global.AEDeepseekPet && typeof global.AEDeepseekPet.bubbleDurationMs === 'function') {
            return global.AEDeepseekPet.bubbleDurationMs(text);
        }
        return FALLBACK_BUBBLE_MS;
    }

    function createTimerAnnounce() {
        // 执行序号：打断/新一次执行都会自增，使旧实例迟到的 LLM 结果失效
        var _runId = 0;

        return {
            id: 'timerAnnounce',
            type: 'timer',
            priority: 10,
            condition: function (ctx) {
                return !ctx.inSleepMode && !ctx.isDragging;
            },
            action: function (petApi) {
                var myRun = ++_runId;
                if (global.AEDeepseekPet && global.AEDeepseekPet.idleAnnounce) {
                    return global.AEDeepseekPet.idleAnnounce.getContent().then(function (msg) {
                        // 已被打断或被新执行取代：丢弃过时结果，
                        // 避免最长 15s 后迟到的闲聊气泡覆盖当前交互（如 clickBounce 的气泡）
                        if (myRun !== _runId) return;
                        // 无台词也走 wait：与原语义一致（空内容不弹气泡但照样占用一次节奏）
                        if (msg) petApi.showBubble(msg, _bubbleMs(msg));
                        return petApi.wait(_bubbleMs(msg || ''));
                    });
                }
                return petApi.wait(100);
            },
            onInterrupt: function () {
                // 使未决的 getContent 回调失效
                _runId++;
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.timerAnnounce = createTimerAnnounce;
})(window);
