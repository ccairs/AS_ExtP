// idlePotHead.js — 偶尔把锅扣在头上（戴锅）
(function (global) {
    'use strict';

    // 戴锅气泡（12 条）：自嘲背锅、卖萌，气泡挂 2.5s。
    // 台词在读取时按当前语言求值：装载期不求值，切换语言后立即生效
    function bubbleLines() {
        return [
            AEI18n.t('呼休~ 锅扣头上，暖呼呼~'),
            AEI18n.t('唔…这锅有点重…'),
            AEI18n.t('呼~ 顶锅鲸鲸，参上！'),
            AEI18n.t('呼休~ 这口锅正好合头…'),
            AEI18n.t('唔…顶着锅也能走路…'),
            AEI18n.t('呼~ 锅里有昨天的小失误…'),
            AEI18n.t('呼休~ 锅盖一扣，安静了…'),
            AEI18n.t('这锅我背了，别担心~'),
            AEI18n.t('呼~ 顶锅的时候最有安全感…'),
            AEI18n.t('唔姆…锅边有点凉…'),
            AEI18n.t('呼休~ 扮成小蘑菇，可爱吧…'),
            AEI18n.t('呼~ 锅在头上，气就消了…')
        ];
    }

    function createIdlePotHead() {
        return {
            id: 'idlePotHead',
            type: 'idle',
            // priority 夹在 idleStretch(15) 与 idleEat(13) 之间：三个 idle 行为各自按
            // 自身概率掷骰，优先级只在同一次 idle:tick 里多个条件同时成立时决定谁赢
            // （伸懒腰 10% / 戴锅 8% / 干饭 8% / 其余走动）
            priority: 14,
            condition: function (ctx) {
                return ctx.petState === 'idle' && !ctx.inSleepMode && Math.random() < 0.08;
            },
            action: function (petApi) {
                var pool = bubbleLines();
                var line = pool[Math.floor(Math.random() * pool.length)];
                petApi.showBubble(line, 2500);
                // potHead 97 帧 / 24fps ≈ 4.04s：等序列帧播完再结束 behavior
                // 加 catch：动画被 interrupt 时 reject，仍让 _finishBehavior 正常结束
                return petApi.playAnim('potHead').then(function () {
                    return petApi.wait(300);  // 结束后留 300ms 缓冲再切 idle
                }).catch(function () {
                    return petApi.wait(0);
                });
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.idlePotHead = createIdlePotHead;
})(window);
