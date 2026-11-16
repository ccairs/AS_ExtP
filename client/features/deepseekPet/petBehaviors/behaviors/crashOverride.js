// crashOverride.js — Bridge 断连强制接管，bridge 恢复后自动结束
(function (global) {
    'use strict';

    function createCrashOverride() {
        var _cleanup = { onOnline: null, resolve: null, petApi: null, timer: null };

        return {
            id: 'crashOverride',
            type: 'event',
            priority: 100,
            condition: function () { return true; },
            action: function (petApi) {
                petApi.playAnim('crash');
                petApi.showBubble(AEI18n.t('呼休~ 连接断了…'), 0);
                // 监听 bridge:online，恢复后立即结束本行为（_finishBehavior 会切回 idle）
                return new Promise(function (resolve) {
                    var settled = false;
                    var finish = function () {
                        if (settled) return;
                        settled = true;
                        if (_cleanup.timer) { clearTimeout(_cleanup.timer); _cleanup.timer = null; }
                        petApi.off('bridge:online', onOnline);
                        resolve();
                    };
                    var onOnline = finish;
                    // 表演路径兜底：bridge 实际在线时（LLM 触发 [action:crash]），
                    // bridge:online 只在状态变化时 emit、永不来，行为会永久锁死
                    // behaviorLock 与 movement.pause；限时 6s 自动结束
                    var st = petApi.getState();
                    if (st && st.bridgeStatus !== 'offline') {
                        _cleanup.timer = setTimeout(finish, 6000);
                    }
                    _cleanup.onOnline = onOnline;
                    _cleanup.resolve = finish;
                    _cleanup.petApi = petApi;
                    petApi.on('bridge:online', onOnline);
                });
            },
            onInterrupt: function () {
                // 打断时移除监听器/超时定时器并 settle Promise，避免泄漏
                var c = _cleanup;
                if (c.onOnline && c.petApi) {
                    c.petApi.off('bridge:online', c.onOnline);
                }
                if (c.timer) { clearTimeout(c.timer); }
                if (typeof c.resolve === 'function') {
                    c.resolve();
                }
                _cleanup = { onOnline: null, resolve: null, petApi: null, timer: null };
            }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.defaultBehaviors = global.AEDeepseekPet.defaultBehaviors || {};
    global.AEDeepseekPet.defaultBehaviors.crashOverride = createCrashOverride;
})(window);
