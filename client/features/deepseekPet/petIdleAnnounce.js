// petIdleAnnounce.js — 闲时播报管理（70%预设台词 / 30% LLM生成）
// 21:00-07:00 的深夜加班窗口改用专属台词池（lateNightLines()），白天走 presetLines()
(function (global) {
    'use strict';

    // 闲时播报预设台词（60 条）：与 LLM 现生成的台词走同一出口——气泡停留时长
    // 按台词长度自适应（petBubble.bubbleDurationMs，一行短台词约 4s），
    // 因此句式向那条 prompt 看齐——一句话、口语化、不点具体时间（任何时段都可能播）、
    // ≤21 字（气泡内容宽 254px / 12px 字号，一行放得下）。
    // 每条至少带一处口癖"呼休~"/"呼~"（人格标识，位置在句首/句中/句尾之间轮换）。主题四块：
    //   ① 关心与提醒（保存/休息/护眼/久坐/吃饭喝水）16 条
    //   ② AE 工作台观察（渲染队列/关键帧/图层/蒙版/缓存/工程命名）18 条
    //   ③ 鼓励与进度反馈（做完了、卡住时、慢工出细活）6 条
    //   ④ 撒娇求关注与自我介绍（摸头、夸夸、我叫鲸鲸）10 条
    // 两池台词都在读取时按当前语言求值：装载期不求值，切换语言后立即生效
    function presetLines() {
        return [
            AEI18n.t('呼休~ 今天也在认真工作呢~'),
            AEI18n.t('别忘了保存工程哦，呼~'),
            AEI18n.t('呼休~ 需要我帮忙吗？'),
            AEI18n.t('坐久了站起来活动一下吧，呼~'),
            AEI18n.t('这效果做得真不错！呼休~'),
            AEI18n.t('呼~ 要不要来杯咖啡？'),
            AEI18n.t('呼休~ 我在这看着你写代码呢'),
            AEI18n.t('加油加油~ 呼休~'),
            AEI18n.t('呼~ 休息一下吧，别太累了'),
            AEI18n.t('呼休~ 今天的你也很努力呢'),
            AEI18n.t('呼休~ 保存一下再继续嘛'),
            AEI18n.t('呼~ 眼睛离屏幕远一点点嘛'),
            AEI18n.t('呼休~ 腰背挺直一点，好不好'),
            AEI18n.t('呼~ 喝口水吧，杯子都快空啦'),
            AEI18n.t('呼休~ 肩膀是不是又僵住了'),
            AEI18n.t('呼~ 手速慢一点也没关系'),
            AEI18n.t('呼休~ 起来转两圈再坐下'),
            AEI18n.t('呼~ 再忙也要按时吃饭哦'),
            AEI18n.t('呼休~ 累了就眯一小会儿'),
            AEI18n.t('呼~ 别一直绷着，放松一下'),
            AEI18n.t('呼休~ 坐太久了，脚趾头都麻了吧'),
            AEI18n.t('呼~ 深呼吸，跟我一起，吸气——'),
            AEI18n.t('呼休~ 眨眨眼，眼睛干干的了吧'),
            AEI18n.t('呼~ 手腕转一转，别硬撑着'),
            AEI18n.t('呼休~ 天塌下来也先喝口热水'),
            AEI18n.t('呼~ 要不要开个小窗透透气'),
            AEI18n.t('呼休~ 渲染队列我帮你盯着呢'),
            AEI18n.t('呼~ 这个关键帧调得真顺滑'),
            AEI18n.t('呼休~ 图层又多了好几层呢'),
            AEI18n.t('呼~ 预览跑起来了，快看快看'),
            AEI18n.t('呼休~ 表达式没报错，厉害'),
            AEI18n.t('呼~ 这个缓动看着好舒服'),
            AEI18n.t('呼休~ 合成又长大了一点点'),
            AEI18n.t('呼~ 时间轴拖得好快，我跟不上啦'),
            AEI18n.t('呼休~ 蒙版画得比我圆呢'),
            AEI18n.t('呼~ 效果堆这么多，电脑在喘气'),
            AEI18n.t('呼休~ 你的工程整理得好干净'),
            AEI18n.t('呼~ 又在跟关键帧较劲呀'),
            AEI18n.t('呼休~ 这个转场好丝滑'),
            AEI18n.t('呼~ 缓存嗖嗖地就渲完了'),
            AEI18n.t('呼休~ 颜色调得真好看'),
            AEI18n.t('呼~ 这个粒子效果好漂亮'),
            AEI18n.t('呼休~ 我数着你的图层呢，别漏啦'),
            AEI18n.t('呼~ 别忘了给合成起个好名字'),
            AEI18n.t('呼休~ 这么快就做完了，好厉害'),
            AEI18n.t('呼~ 这一步做对了，我看见了'),
            AEI18n.t('呼休~ 进展好顺利呢，继续加油'),
            AEI18n.t('呼~ 卡住的时候最需要一杯热的'),
            AEI18n.t('呼休~ 慢工出细活，不着急'),
            AEI18n.t('呼~ 你比昨天更熟练了呢'),
            AEI18n.t('呼休~ 摸摸头好不好，就一下'),
            AEI18n.t('呼~ 我乖乖待着，不打扰你'),
            AEI18n.t('呼休~ 夸夸我嘛，我今天很乖'),
            AEI18n.t('呼~ 两个人一起加班就不累啦'),
            AEI18n.t('呼休~ 要不要看看我在干什么'),
            AEI18n.t('呼~ 我叫鲸鲸，记住我了吗'),
            AEI18n.t('呼休~ 我把自己缩成一小团啦'),
            AEI18n.t('呼~ 有事就喊我，我耳朵很灵'),
            AEI18n.t('呼休~ 尾巴摇一摇，给你加点好运'),
            AEI18n.t('呼~ 忙完记得回来跟我说说话')
        ];
    }

    // 深夜加班专属台词（36 条）：21:00 起、07:00 前——这时段用户多半在赶工，
    // 口气偏关心/劝睡/陪伴。窗口横跨 10 小时，所以一条都不许点具体钟点（"十一点了"跨窗口就会说错）、
    // 不许假设临近天亮（21:00 才刚入夜，"天快亮了"在窗口前段就是假话），
    // 也不能假设用户正要睡（21:00 可能才刚开工）。句式与白天池同规格：含口癖、≤21 字
    function lateNightLines() {
        return [
            AEI18n.t('呼休~ 夜深了，别熬太狠哦'),
            AEI18n.t('呼~ 该收工啦，明天再战'),
            AEI18n.t('呼休~ 熬太晚我会心疼的'),
            AEI18n.t('呼~ 早点睡，梦里也有进度条'),
            AEI18n.t('呼休~ 深夜的班，加不完就明天加'),
            AEI18n.t('呼~ 别硬撑，困了就休息'),
            AEI18n.t('呼休~ 这个点了，先保存再走吧'),
            AEI18n.t('呼~ 熬夜的账，白天要还的'),
            AEI18n.t('呼休~ 我陪你到你想睡为止'),
            AEI18n.t('呼~ 夜里冷，记得加件外套'),
            AEI18n.t('呼休~ 困了就先眯一会儿嘛'),
            AEI18n.t('呼~ 别在困的时候调参数'),
            AEI18n.t('呼休~ 夜里的世界好安静呀'),
            AEI18n.t('呼~ 我也有点困了…呼'),
            AEI18n.t('呼休~ 陪你加班，我不吵你'),
            AEI18n.t('呼~ 夜深了，气泡也变小了'),
            AEI18n.t('呼休~ 整个面板只剩我们俩啦'),
            AEI18n.t('呼~ 要不要泡杯热的东西喝'),
            AEI18n.t('呼休~ 熬夜的时候我最黏人'),
            AEI18n.t('呼~ 数着你的关键帧陪你熬'),
            AEI18n.t('呼休~ 夜晚的进度条走得特别慢'),
            AEI18n.t('呼~ 我打个小盹，有事喊我'),
            AEI18n.t('呼休~ 这么晚还在，辛苦啦'),
            AEI18n.t('呼~ 夜里做的效果，白天再看一遍'),
            AEI18n.t('呼休~ 渲染放后台，人先去睡'),
            AEI18n.t('呼~ 这么晚还没睡，我陪着你'),
            AEI18n.t('呼休~ 夜里的灵感要记下来'),
            AEI18n.t('呼~ 渲染慢慢跑，别盯着它'),
            AEI18n.t('呼休~ 深夜的按键声格外清楚'),
            AEI18n.t('呼~ 明早还要开工程，早点睡'),
            AEI18n.t('呼休~ 夜里的时间跑得飞快'),
            AEI18n.t('呼~ 屏幕再亮，也不如白天'),
            AEI18n.t('呼休~ 熬夜做的效果，记得存档'),
            AEI18n.t('呼~ 把今天收个尾就休息吧'),
            AEI18n.t('呼休~ 陪你把这一版收完，就睡觉'),
            AEI18n.t('呼~ 明天的你会感谢今晚早睡的你')
        ];
    }

    // 深夜窗口边界（左闭右开）：hour ≥ 21 或 hour < 7
    var NIGHT_START_HOUR = 21;
    var NIGHT_END_HOUR = 7;

    function _isLateNight(now) {
        var h = now.getHours();
        return h >= NIGHT_START_HOUR || h < NIGHT_END_HOUR;
    }

    function _pick(pool) {
        return pool[Math.floor(Math.random() * pool.length)];
    }

    function createIdleAnnounce(eventBus, chat) {
        // 移入闭包：避免多次 createIdleAnnounce 实例间共享 timer 互相覆盖
        var _timer = null;

        function init() {
            _scheduleNext();
        }

        // 每次调度实时读 settings，确保用户改设置后立即生效
        function _getIntervals() {
            var min = 30, max = 300;
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    var s = global.AEDeepseekPet.settings.getSettings();
                    if (s && s.announceInterval) {
                        min = s.announceInterval.min || 30;
                        max = s.announceInterval.max || 300;
                        if (max < min) max = min;
                    }
                }
            } catch (e) {}
            return { min: min, max: max };
        }

        function _scheduleNext() {
            if (_timer) clearTimeout(_timer);
            var iv = _getIntervals();
            var interval = (iv.min + Math.random() * (iv.max - iv.min)) * 1000;
            _timer = setTimeout(function () {
                eventBus.emit('timer:announce');
                _scheduleNext();
            }, interval);
        }

        // 台词池按当前时段选：深夜窗口取专属池，其余时间取白天池（两池各自随机，不混抽）
        function getContent() {
            return new Promise(function (resolve) {
                var pool = _isLateNight(new Date()) ? lateNightLines() : presetLines();
                if (Math.random() < 0.7) {
                    resolve(_pick(pool));
                } else {
                    _generateLlmLine().then(function (msg) {
                        resolve(msg || _pick(pool));
                    }).catch(function () {
                        resolve(_pick(pool));
                    });
                }
            });
        }

        // 从 globalSettings 中按 providerId 解析对应的 apiKey 字段
        // 与 petChat.js / petHistory.js 的 _resolveApiKey 逻辑保持一致
        function _resolveApiKey(globals, providerId) {
            var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
            var apiKeyField = null;
            if (registry && typeof registry.getApiKeyField === 'function') {
                try { apiKeyField = registry.getApiKeyField(providerId); } catch (e) {}
            }
            if (!apiKeyField || providerId === 'siliconflow') {
                return String(globals.apiKey || globals.siliconflowApiKey || '').trim();
            }
            return String(globals[apiKeyField] || globals.apiKey || '').trim();
        }

        // 当前时间（事实，HH:MM）注入 LLM 分支：与 petChat._buildSystemPromptWithTime 同口径。
        // 缺了它，30% 的 LLM 台词在任何时段都是同一种口吻——凌晨说出白天的话，与深夜专属池自相矛盾
        function _timeFact() {
            var now = new Date();
            var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
            return '当前时间：' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + '。';
        }

        // 用户界面语言事实行：复用 petChat.buildLanguageFact（petChat 先于本文件装载）；
        // 该实现缺席时按简体中文陈述，保证提示词始终带语言事实
        function _languageFact() {
            var build = global.AEDeepseekPet && global.AEDeepseekPet.buildLanguageFact;
            if (typeof build === 'function') {
                try { return build(); } catch (e) {}
            }
            return '用户当前界面语言：简体中文（zh-CN）。请使用该语言与用户交流。';
        }

        function _generateLlmLine() {
            return new Promise(function (resolve, reject) {
                var llmChannel = null;
                if (global.AE_LLM && global.AE_LLM.llmChannel) {
                    llmChannel = global.AE_LLM.llmChannel;
                } else if (global.AEAppContainer) {
                    try {
                        var ctx = global.AEAppContainer.getContext();
                        if (ctx && ctx.llmChannel) llmChannel = ctx.llmChannel;
                    } catch (e) {}
                }
                if (!llmChannel) { reject(new Error('no llmChannel')); return; }

                var context = {
                    messages: [
                        {
                            role: 'system',
                            content: _timeFact() + _languageFact() + '\n' +
                                '你是一个住在 AE 扩展里的桌面小助手大肥鱼。说一句简短的闲聊台词（不超过15字），像朋友聊天一样自然。只输出台词，不要加引号或其他标记。'
                        },
                        { role: 'user', content: '说一句闲聊台词' }
                    ],
                    options: { timeoutMs: 15000 }
                };

                // apiKey 解析需异步读 globalSettings（与 petChat.js 一致）：
                // 缺失时 context.apiKey 为空，sendStream 发出空 Authorization 恒 401，LLM 台词生成静默失效
                var proceed = function () {
                    llmChannel.sendStream(context, {}).then(function (result) {
                        if (result && result.content) {
                            resolve(result.content.trim());
                        } else {
                            reject(new Error('empty response'));
                        }
                    }).catch(reject);
                };
                try {
                    if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                        var appCtx = global.AEAppContainer.getContext();
                        if (appCtx && appCtx.settingsStore && typeof appCtx.settingsStore.getGlobalSettings === 'function') {
                            appCtx.settingsStore.getGlobalSettings({}).then(function (globals) {
                                var providerId = globals.defaultProviderId || globals.defaultPlatform || 'deepseek';
                                var apiKey = _resolveApiKey(globals, providerId);
                                if (apiKey) context.apiKey = apiKey;
                            }).catch(function () {}).then(proceed);
                            return;
                        }
                    }
                } catch (_) {}
                proceed();
            });
        }

        function setInterval(min, max) {
            // 兼容旧接口：直接更新 settings，下次调度会自动读取
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    global.AEDeepseekPet.settings.updateSettings({ announceInterval: { min: min, max: max } });
                }
            } catch (e) {}
            _scheduleNext();
        }

        function destroy() {
            if (_timer) clearTimeout(_timer);
            _timer = null;
        }

        function pause() {
            if (_timer) { clearTimeout(_timer); _timer = null; }
        }

        function resume() {
            _scheduleNext();
        }

        return {
            init: init,
            getContent: getContent,
            setInterval: setInterval,
            pause: pause,
            resume: resume,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createIdleAnnounce = createIdleAnnounce;
    global.AEDeepseekPet.idleAnnounce = null;
})(window);
