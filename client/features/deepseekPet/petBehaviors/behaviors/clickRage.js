// clickRage.js — 快速连击暴走
(function (global) {
    'use strict';

    function createClickRage() {
        // 执行序号：打断/新一次执行都会自增，使旧实例迟到的 wait 回调失效
        var _runId = 0;

        return {
            id: 'clickRage',
            type: 'click',
            priority: 50,
            condition: function (ctx) {
                return ctx.clickCount >= 5;
            },
            action: function (petApi) {
                var myRun = ++_runId;
                petApi.playAnim('clickRage');
                petApi.showBubble(AEI18n.t('呼休~ 别戳了别戳了！'), 3000);
                // 通过 getState() 重置 clickCount，避免引用未定义的 ctx
                return petApi.wait(3000).then(function () {
                    // 已被打断或被新一次执行取代：不 emit click:reset，
                    // 避免旧实例迟到回调清零连击计数、暴走/弹跳交替错乱
                    if (myRun !== _runId) return;
                    // 通过 petApi.emit 通知 controller 重置 clickCount
                    petApi.emit('click:reset');
                });
            },
            onInterrupt: function () {
                // 使未决的 wait 回调失效（不会 emit click:reset）
                _runId++;
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.clickRage = createClickRage;
})(window);
