// idleEat.js — 偶尔干饭（端碗吃一大口）
(function (global) {
    'use strict';

    // 干饭气泡（12 条）：吃相可爱、含糊的"唔姆"腔，气泡挂 2.5s。
    // 台词在读取时按当前语言求值：装载期不求值，切换语言后立即生效
    function bubbleLines() {
        return [
            AEI18n.t('干饭啦！干饭啦！'),
            AEI18n.t('唔姆唔姆~ 好吃…'),
            AEI18n.t('呼休~ 这碗饭好大…'),
            AEI18n.t('呼~ 今天这碗格外香…'),
            AEI18n.t('唔姆~ 一口接一口…'),
            AEI18n.t('呼休~ 饭饭是我的好朋友…'),
            AEI18n.t('开动啦，谁也别抢~'),
            AEI18n.t('呼~ 吃得饱饱的才有力气…'),
            AEI18n.t('唔…有点烫，吹一吹…'),
            AEI18n.t('呼休~ 碗底还有一颗米…'),
            AEI18n.t('干完这碗继续加油~'),
            AEI18n.t('呼~ 嘴角沾到饭粒了…')
        ];
    }

    function createIdleEat() {
        return {
            id: 'idleEat',
            type: 'idle',
            // 三个 idle 行为里优先级最低（idleStretch 15 > idlePotHead 14 > 本行为 13 > idleWander 10），
            // 条件各按自身概率掷骰，同时成立时优先级高的先执行
            // （伸懒腰 10% / 戴锅 8% / 干饭 8% / 其余走动）
            priority: 13,
            condition: function (ctx) {
                return ctx.petState === 'idle' && !ctx.inSleepMode && Math.random() < 0.08;
            },
            action: function (petApi) {
                var pool = bubbleLines();
                var line = pool[Math.floor(Math.random() * pool.length)];
                petApi.showBubble(line, 2500);
                // eat 121 帧 / 24fps ≈ 5.04s：等序列帧播完再结束 behavior
                // 加 catch：动画被 interrupt 时 reject，仍让 _finishBehavior 正常结束
                return petApi.playAnim('eat').then(function () {
                    return petApi.wait(300);  // 结束后留 300ms 缓冲再切 idle
                }).catch(function () {
                    return petApi.wait(0);
                });
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.idleEat = createIdleEat;
})(window);
