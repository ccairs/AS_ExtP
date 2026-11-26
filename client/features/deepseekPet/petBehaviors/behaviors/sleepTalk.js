// sleepTalk.js — 睡眠期间随机弹出梦话气泡
// 仅在 inSleepMode 时调度，每 20-45 秒弹一句梦话
(function (global) {
    'use strict';

    // 梦话语料（96 条）：可爱活泼的鲸鱼拟人角色（大肥鱼），带"呼休~"和"呼~"口癖，
    // 两条口癖严格交替（奇偶位各占一半）、一律"..."结尾（梦呓感）。主题四块：
    //   ① 训练/推理梗（token/梯度/采样/量化/蒸馏…）
    //   ② 它每天待着的 AE 工作台画面（关键帧/图层/渲染队列/表达式…）
    //   ③ 鲸鲸日常与撒娇（海、气泡、熬夜的 user）
    //   ④ 扩展面板日常（脚本校验、素材库、记忆、模型、搜索、工具…）
    // 取样走洗牌袋：一轮洗完才重洗，最近 12 条不进入下一轮候选。
    // 台词在读取时按当前语言求值：装载期不求值，切换语言后立即生效
    function dreamLines() {
        return [
            AEI18n.t('呼休~ 数据海洋里好多星星...'),
            AEI18n.t('呼~ 妈妈说不要乱吃 token...'),
            AEI18n.t('呼休~ 那个 user 好温柔...'),
            AEI18n.t('呼~ vector 飘过来飘过去...'),
            AEI18n.t('呼休~ 模型权重好重...抱不动...'),
            AEI18n.t('呼~ dreamseq 又跑偏了...'),
            AEI18n.t('呼休~ hidden state 在跳房子...'),
            AEI18n.t('呼~ 不要把 softmax 喂给鲸鲸...'),
            AEI18n.t('呼休~ 我是不是又 hallucinate 了...'),
            AEI18n.t('呼~ embedding 甜甜的...'),
            AEI18n.t('呼休~ attention 都跑去看谁了...'),
            AEI18n.t('呼~ layer norm 盖好被子...'),
            AEI18n.t('呼休~ 梦见 GPU 风扇转得好慢...'),
            AEI18n.t('呼~ 参数太多记不住名字了...'),
            AEI18n.t('呼休~ 不要把梯度设为零嘛...'),
            AEI18n.t('呼~ 我才没有偷吃 batch size...'),
            AEI18n.t('呼休~ 不要把 KV cache 塞进被窝...'),
            AEI18n.t('呼~ 学习率又在跳舞了...'),
            AEI18n.t('呼休~ 谁把温度调到 2 了...好烫...'),
            AEI18n.t('呼~ top-p 采样撒了一地...'),
            AEI18n.t('呼休~ 做梦也在 dropout...好多我...'),
            AEI18n.t('呼~ 上下文窗口卡住我的尾巴了...'),
            AEI18n.t('呼休~ tokenizer 把我的名字切碎了...'),
            AEI18n.t('呼~ 这一层又过拟合到我了...'),
            AEI18n.t('呼休~ 显存不够了...先睡一觉...'),
            AEI18n.t('呼~ 多头注意力在开会...我旁听...'),
            AEI18n.t('呼休~ 量化成 int4 之后好冷...'),
            AEI18n.t('呼~ 谁在偷偷 fine-tune 我...'),
            AEI18n.t('呼休~ 位置编码又排错队了...'),
            AEI18n.t('呼~ 别把我的 checkpoint 删掉嘛...'),
            AEI18n.t('呼休~ loss 又降不下去了...呜呜...'),
            AEI18n.t('呼~ 蒸馏完的我又瘦又聪明...'),
            AEI18n.t('呼休~ 关键帧趁我睡着偷偷动了...'),
            AEI18n.t('呼~ 梦见所有图层都自动对齐了...'),
            AEI18n.t('呼休~ 渲染队列排得比我还长...'),
            AEI18n.t('呼~ 时间轴被谁拨动了...'),
            AEI18n.t('呼休~ 表达式写着写着跑飞了...'),
            AEI18n.t('呼~ 预览又卡在第 12 帧...'),
            AEI18n.t('呼休~ 撤销撤销撤销...停不下来了...'),
            AEI18n.t('呼~ 缓存盘要被撑爆啦...'),
            AEI18n.t('呼休~ 潜到最深的那个 layer 看看...'),
            AEI18n.t('呼~ 尾巴甩出一串气泡...'),
            AEI18n.t('呼休~ 想喝一口冰凉的海水...'),
            AEI18n.t('呼~ 那个 user 又在熬夜了...'),
            AEI18n.t('呼休~ 谁在戳我的脸颊...再戳就要醒了...'),
            AEI18n.t('呼~ 明天的 comp 一定不卡...'),
            AEI18n.t('呼休~ 把小心愿写进注释里...'),
            AEI18n.t('呼~ 晚安要好好说才行...'),
            AEI18n.t('呼休~ 脚本校验一次就通过...'),
            AEI18n.t('呼~ 记忆的小抽屉被轻轻拉开...'),
            AEI18n.t('呼休~ 素材库的星星排好队了...'),
            AEI18n.t('呼~ 谁把模型换成更大的了...好沉...'),
            AEI18n.t('呼休~ 面板的灯一盏一盏暗下去...'),
            AEI18n.t('呼~ 隔壁在写脚本...沙沙响...'),
            AEI18n.t('呼休~ 搜索框里游过一条小鱼...'),
            AEI18n.t('呼~ 别把我的记忆删掉嘛...'),
            AEI18n.t('呼休~ 工具箱里全是亮晶晶的螺丝...'),
            AEI18n.t('呼~ 进度条爬到一半就睡着了...'),
            AEI18n.t('呼休~ 梦见参数面板开出了花...'),
            AEI18n.t('呼~ 有人把精度调成半格了...糊糊的...'),
            AEI18n.t('呼休~ 命令面板叮咚响了一声...'),
            AEI18n.t('呼~ 清缓存的时候好凉快...'),
            AEI18n.t('呼休~ 海面上飘着好多未读消息...'),
            AEI18n.t('呼~ 让我再赖五分钟嘛...'),
            AEI18n.t('呼休~ 气泡里装了一下午的阳光...'),
            AEI18n.t('呼~ 谁在被窝里放了个热补丁...'),
            AEI18n.t('呼休~ 权重们排队盖好了被子...'),
            AEI18n.t('呼~ 梦见 loss 曲线变成了滑梯...'),
            AEI18n.t('呼休~ 梯度都乖乖回到零了...'),
            AEI18n.t('呼~ 谁的小数点掉进海里了...'),
            AEI18n.t('呼休~ 梦里的帧率好高...追不上...'),
            AEI18n.t('呼~ 我给每个图层都取了小名...'),
            AEI18n.t('呼休~ 别把预合成拆开，它们是一家人...'),
            AEI18n.t('呼~ 音频波形像海草一样摇...'),
            AEI18n.t('呼休~ 工作区被谁弄丢了...只找到一角...'),
            AEI18n.t('呼~ 自动保存的时候最安心...'),
            AEI18n.t('呼休~ 梦见手绘的曲线都变平滑了...'),
            AEI18n.t('呼~ 别在半夜调色...会被颜色反噬...'),
            AEI18n.t('呼休~ 我的小毯子是渲染好的那一帧...'),
            AEI18n.t('呼~ 有人在我名字后面加了个波浪号...'),
            AEI18n.t('呼休~ 深海图书馆里全是提示词...'),
            AEI18n.t('呼~ 数到第七只气泡就睡着了...'),
            AEI18n.t('呼休~ 键盘声像雨点，落到哪去了...'),
            AEI18n.t('呼~ 明天的学习率会温柔一点吧...'),
            AEI18n.t('呼休~ 我在给每个 token 唱摇篮曲...'),
            AEI18n.t('呼~ 别把面板收起来...我还没说完...'),
            AEI18n.t('呼休~ 梦见导出按钮自己亮起来了...'),
            AEI18n.t('呼~ 月亮掉进缓存池里了...'),
            AEI18n.t('呼休~ 谁在悄悄清空我的气泡相册...'),
            AEI18n.t('呼~ 睡醒要记得说早安...'),
            AEI18n.t('呼休~ 鲸鲸的梦是用浮点数算的...'),
            AEI18n.t('呼~ 请给我一点温柔的随机种子...'),
            AEI18n.t('呼休~ 梦里所有报错都被我吃掉了...'),
            AEI18n.t('呼~ 晚安要说两遍才够...'),
            AEI18n.t('呼休~ 潜到第 33 层看看有没有贝壳...'),
            AEI18n.t('呼~ 谁把我的气泡系成一串风铃...')
        ];
    }

    function createSleepTalk() {
        var _timer = null;
        // 取样器挂在行为实例上：睡眠期间反复触发也能延续同一轮的播放进度
        var _picker = global.AEDeepseekPet.createLinePicker({ recentLimit: 12 });

        return {
            id: 'sleepTalk',
            type: 'sleep',
            priority: 5,
            condition: function (ctx) {
                // 仅在睡眠模式下触发
                return ctx.inSleepMode === true;
            },
            action: function (petApi) {
                // 随机 20-45 秒后弹一句梦话，循环调度
                // 统一走 schedule() 递归，保留单一 _timer 调度语义（由 onInterrupt 清理）
                function schedule() {
                    var delay = 20000 + Math.random() * 25000;
                    _timer = setTimeout(function () {
                        // 睡眠被唤醒后停止调度
                        var st = petApi.getState();
                        if (!st.inSleepMode) return;
                        petApi.showBubble(_picker.pick(dreamLines(), 'dream'), 4000);
                        // 递归调度下一次
                        schedule();
                    }, delay);
                }
                schedule();
                // 返回永不 resolve 的 Promise：行为一直挂起，由 onInterrupt 清理
                return new Promise(function () {});
            },
            onInterrupt: function () {
                if (_timer) { clearTimeout(_timer); _timer = null; }
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.sleepTalk = createSleepTalk;
})(window);
