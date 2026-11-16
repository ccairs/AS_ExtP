// idleStretch.js — 偶尔伸懒腰
(function (global) {
    'use strict';

    function createIdleStretch() {
        return {
            id: 'idleStretch',
            type: 'idle',
            // priority 高于 idleWander(10)：condition 10% 成立时赢 idleWander，
            // 90% 不成立时 idleWander 接管 → 10% 伸懒腰 / 90% 走动
            priority: 15,
            condition: function (ctx) {
                return ctx.petState === 'idle' && !ctx.inSleepMode && Math.random() < 0.1;
            },
            action: function (petApi) {
                petApi.showBubble(AEI18n.t('呼休~ 伸个懒腰~'), 2000);
                // 等序列帧播完再结束 behavior（stretch 49 帧 / 24fps ≈ 2.04s）
                // 若用 wait(2000)，可能在动画未播完时就 _finishBehavior 触发 idle:enter
                // 加 catch：动画被 interrupt 时 reject，仍让 _finishBehavior 正常结束
                return petApi.playAnim('stretch').then(function () {
                    return petApi.wait(300);  // 结束后留 300ms 缓冲再切 idle
                }).catch(function () {
                    // 动画被打断：直接结束 behavior
                    return petApi.wait(0);
                });
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.idleStretch = createIdleStretch;
})(window);
