// clickBounce.js — 点击弹跳反应
(function (global) {
    'use strict';

    // 被戳（连击 <5）的轻反应（20 条）：短促、调皮、不生气——狂怒由 clickRage 接管，
    // 气泡只挂 2s，故每条都控制在十来个字内。
    // 台词在读取时按当前语言求值：装载期不求值，切换语言后立即生效
    function bubbleLines() {
        return [
            AEI18n.t('呼休~！'),
            AEI18n.t('别戳我啦~'),
            AEI18n.t('嗯？呼~'),
            AEI18n.t('干嘛啦呼休~'),
            AEI18n.t('嘿！呼~'),
            AEI18n.t('啊呀！呼休~'),
            AEI18n.t('呼~ 痒痒的'),
            AEI18n.t('戳到痒痒肉啦！'),
            AEI18n.t('唔！干嘛呀~'),
            AEI18n.t('呼休~ 我在呢我在呢'),
            AEI18n.t('再戳我就跳走啦~'),
            AEI18n.t('呼~ 逗我玩是吧'),
            AEI18n.t('哎呀，吓我一跳~'),
            AEI18n.t('呼休~ 手指头不老实'),
            AEI18n.t('嘿咻~ 我躲！'),
            AEI18n.t('嗯嗯？呼休~'),
            AEI18n.t('呼~ 又是我呀'),
            AEI18n.t('轻点戳嘛~'),
            AEI18n.t('呼休~ 陪你玩一下下'),
            AEI18n.t('戳一下，回你一句~')
        ];
    }

    function createClickBounce() {
        return {
            id: 'clickBounce',
            type: 'click',
            priority: 10,
            condition: function (ctx) {
                return ctx.clickCount < 5;
            },
            action: function (petApi) {
                // 先弹气泡，让用户立即得到反馈；动画完整播放后再结束 behavior
                // click 序列帧 97 帧 / 24fps ≈ 4s，原 wait(1500) 会在帧 36 处被打断
                var pool = bubbleLines();
                var line = pool[Math.floor(Math.random() * pool.length)];
                petApi.showBubble(line, 2000);
                // playAnim('click') 对非 loop 动画返回 Promise，动画播完才 resolve
                // 加 catch：动画被 interrupt 时 reject，仍走 wait(300) 让 _finishBehavior 正常结束
                return petApi.playAnim('click').then(function () {
                    return petApi.wait(300);  // 结束后留 300ms 缓冲再切 idle
                }).catch(function () {
                    // 动画被打断（如 crashOverride 强制接管）：直接结束 behavior，让 _finishBehavior 走状态恢复
                    return petApi.wait(0);
                });
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.clickBounce = createClickBounce;
})(window);
