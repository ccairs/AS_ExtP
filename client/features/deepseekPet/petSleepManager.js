// petSleepManager.js — 休眠/唤醒管理
// 夜间（凌晨 0-9 点）自动进入睡眠模式，激活后保持 3 分钟活跃再睡
// 白天保持 5 分钟无操作才睡眠
// 唤醒/重置计时只认交互行为：click / drag / 聊天发送
// 不监听 mousemove/keydown，避免鼠标划过扩展面板就唤醒
(function (global) {
    'use strict';

    var SLEEP_TIMEOUT_DAY = 5 * 60 * 1000;     // 白天 5 分钟无操作
    var SLEEP_TIMEOUT_NIGHT = 3 * 60 * 1000;   // 夜间 3 分钟无操作
    var NIGHT_START_HOUR = 0;                   // 0 点开始算夜间
    var NIGHT_END_HOUR = 9;                     // 9 点之后算白天
    // 每小时检查一次时间变化：白天→夜间时主动 sleep（夜间→白天不主动唤醒，避免打扰用户）
    var HOUR_CHECK_INTERVAL = 60 * 60 * 1000;

    function createSleepManager(eventBus, ctx) {
        var _activityTimer = null;
        var _lastResetTime = 0;  // 上次 reset 时间，节流避免频繁 clearTimeout/setTimeout
        var _resetThrottleMs = 5000;  // 5秒内不重复 reset，除非从 sleep 唤醒
        var _hourCheckTimer = null;

        function init() {
            _resetTimer();
            // 只监听真正的交互行为：点击、拖拽、聊天发送
            // 不监听 mousemove/keydown：避免鼠标划过面板就唤醒/重置计时
            document.addEventListener('click', _onActivity);
            eventBus.on('drag:start', _onActivity);
            // drag:end 也算交互：超长拖拽（超过睡眠超时）期间 timer 到期被 isDragging 跳过且耗尽，
            // 若不重设，拖拽结束后桌宠要等下一次交互才重新获得入睡计时
            eventBus.on('drag:end', _onActivity);
            eventBus.on('chat:userSend', _onActivity);
            // 启动时若处于夜间，直接进入睡眠（非 force，用户点击即可唤醒）
            if (_isNightTime()) {
                _sleep();
            }
            // 每小时检查时间：白天进入夜间时主动 sleep
            _hourCheckTimer = setInterval(_onHourCheck, HOUR_CHECK_INTERVAL);
        }

        function _isNightTime() {
            var h = new Date().getHours();
            return h >= NIGHT_START_HOUR && h < NIGHT_END_HOUR;
        }

        function _getSleepTimeout() {
            return _isNightTime() ? SLEEP_TIMEOUT_NIGHT : SLEEP_TIMEOUT_DAY;
        }

        function _resetTimer() {
            if (_activityTimer) clearTimeout(_activityTimer);
            _lastResetTime = Date.now();
            _activityTimer = setTimeout(function () {
                if (!ctx.inSleepMode && !ctx.isDragging) {
                    _sleep();
                }
            }, _getSleepTimeout());
        }

        // 每小时检查：白天→夜间时主动 sleep
        // 夜间→白天不主动唤醒，让用户自然交互唤醒
        function _onHourCheck() {
            // shutdown 期间不触发：pause() 已清掉 interval，此处双保险
            if (_paused) return;
            if (_isNightTime() && !ctx.inSleepMode && !_forceSleep) {
                _sleep();
            }
        }

        function _sleep() {
            ctx.inSleepMode = true;
            ctx.petState = 'sleep';
            eventBus.emit('pet:sleep');
        }

        function _wake() {
            ctx.inSleepMode = false;
            ctx.petState = 'idle';
            eventBus.emit('pet:wake');
        }

        // 强制进入睡眠（右键菜单"进入睡眠"）：
        // 与自动 _sleep 不同的是设置 _forceSleep 标记，_onActivity 不会自动唤醒
        // 必须用户再次从右键菜单点击"唤醒"或点击桌宠才能退出
        var _forceSleep = false;

        function forceSleep() {
            _forceSleep = true;
            // 取消自动唤醒计时器（避免 5 分钟后被自动唤醒）
            if (_activityTimer) clearTimeout(_activityTimer);
            _sleep();
        }

        function forceWake() {
            _forceSleep = false;
            _wake();
            _resetTimer();
        }

        var _paused = false;  // shutdown 期间暂停活动检测，避免触发 sleep/wake

        function _onActivity() {
            if (_paused) return;
            ctx.lastActiveTime = Date.now();
            // 强制睡眠模式下不响应交互唤醒，必须显式 forceWake
            if (_forceSleep) return;
            if (ctx.inSleepMode) {
                _wake();
                // 唤醒后立即重置，确保从 sleep 恢复后重新计时
                _resetTimer();
                return;
            }
            // 非睡眠状态下节流重置，避免每次点击都 clearTimeout/setTimeout
            var now = Date.now();
            if (now - _lastResetTime > _resetThrottleMs) {
                _resetTimer();
            }
        }

        function pause() {
            _paused = true;
            if (_activityTimer) { clearTimeout(_activityTimer); _activityTimer = null; }
            // hourly 检查一并暂停：shutdown 期间触发 pet:sleep 会重新激活
            // sleepTalk 等睡眠行为链（隐藏状态下无人打断，形成永久定时器循环）
            if (_hourCheckTimer) { clearInterval(_hourCheckTimer); _hourCheckTimer = null; }
        }

        function resume() {
            _paused = false;
            _resetTimer();
            // 重建被 pause 清掉的 hourly 检查
            if (!_hourCheckTimer) {
                _hourCheckTimer = setInterval(_onHourCheck, HOUR_CHECK_INTERVAL);
            }
        }

        function destroy() {
            if (_activityTimer) clearTimeout(_activityTimer);
            if (_hourCheckTimer) { clearInterval(_hourCheckTimer); _hourCheckTimer = null; }
            document.removeEventListener('click', _onActivity);
            eventBus.off('drag:start', _onActivity);
            eventBus.off('drag:end', _onActivity);
            eventBus.off('chat:userSend', _onActivity);
        }

        return { init: init, wake: _wake, forceSleep: forceSleep, forceWake: forceWake, pause: pause, resume: resume, destroy: destroy };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createSleepManager = createSleepManager;
})(window);

