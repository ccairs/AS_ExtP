// petAutoReply.js - 主动回复：定时让桌宠主动说一句话
// 触发条件：
//   1. settings.autoReply.enabled === true（默认开启）
//   2. 非睡眠模式
//   3. 距上次用户发送消息 >= settings.autoReply.intervalSec（默认 900s = 15 分钟）
// 用户主动发送消息后重置计时器
(function (global) {
    'use strict';

    function createAutoReply(eventBus, chat, ctx) {
        var _timer = null;
        var _lastUserSendTime = Date.now();
        // 用户正在输入框编辑但未发送时为 true，主动回复到期时推迟，避免突兀插入
        var _userComposing = false;
        // 当前 _timer 是否处于"composing 推迟轮询"（2 分钟重试）状态
        var _composingWait = false;
        // 推迟重试间隔：用户正在输入时每 2 分钟检查一次是否还活着
        var _composingRetryMs = 2 * 60 * 1000;
        // 保存 eventBus 监听器引用，destroy 时才能正确 off
        var _onUserSend = function () {
            _lastUserSendTime = Date.now();
            _userComposing = false;
            _reschedule();
        };
        var _onComposingStart = function () { _userComposing = true; };
        var _onComposingEnd = function () {
            if (!_userComposing) return;
            _userComposing = false;
            // 输入结束且正处于 composing 推迟轮询：取消挂起的 retry timer 后立即评估，
            // 否则要等下一个 2 分钟 tick（过度推迟），且不取消的话 _onTimerFired
            // 置 _timer=null 会让 retry timer 遗留，稍后再触发一次 → 主动回复双发
            if (_composingWait && _timer) {
                clearTimeout(_timer);
                _timer = null;
                _onTimerFired();
            }
        };
        // 设置面板切换「主动回复」开关（petSettings → 既有 petApi.emit → 本通道）：
        // 关闭时 _reschedule 清 timer 且不排（disabled 直接 return）；重新打开必须显式
        // 重排——否则 _onTimerFired 的 disabled 分支 return 后 timer 已空，要等下次
        // chat:userSend / onWake 才恢复计时。
        var _onAutoReplySettingsChanged = function () { _reschedule(); };

        function init() {
            // 监听用户发送消息：重置计时器
            eventBus.on('chat:userSend', _onUserSend);
            // 监听输入框聚焦/输入/失焦：标记 composing 状态
            eventBus.on('chat:composing:start', _onComposingStart);
            eventBus.on('chat:composing:end', _onComposingEnd);
            // 监听主动回复开关/间隔设置变化：重排计时器（关闭→清；重新打开→重排）
            eventBus.on('settings:autoReplyChanged', _onAutoReplySettingsChanged);
            _reschedule();
        }

        function _getIntervalMs() {
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    var s = global.AEDeepseekPet.settings.getSettings();
                    if (s && s.autoReply && s.autoReply.intervalSec) {
                        return Math.max(60, s.autoReply.intervalSec) * 1000;
                    }
                }
            } catch (e) {}
            return 15 * 60 * 1000;  // 默认 15 分钟
        }

        function _isEnabled() {
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    var s = global.AEDeepseekPet.settings.getSettings();
                    if (s && s.autoReply && typeof s.autoReply.enabled === 'boolean') {
                        return s.autoReply.enabled;
                    }
                }
            } catch (e) {}
            return true;  // 默认开启
        }

        function _reschedule() {
            if (_timer) { clearTimeout(_timer); _timer = null; }
            _composingWait = false;
            if (!_isEnabled()) return;
            _timer = setTimeout(_onTimerFired, _getIntervalMs());
        }

        // 到期评估：sleep/composing 检查 + 触发主动回复 + 重新调度
        function _onTimerFired() {
            _timer = null;
            _composingWait = false;
            // 设置已关闭主动回复：到期不触发（禁用后 _reschedule 不再调度，
            // 重新开启后由 chat:userSend / onWake 恢复计时）
            if (!_isEnabled()) return;
            // 睡眠期间不触发主动回复
            if (ctx.inSleepMode) {
                // 等唤醒后再重新调度
                return;
            }
            // 用户正在输入框编辑但未发送：推迟触发，避免打断用户思路
            // 每 2 分钟轮询一次 composing 状态（而非重新等待完整 interval，
            // 否则输入结束后主动回复最多被推迟 2min + interval）
            if (_userComposing) {
                _composingWait = true;
                _timer = setTimeout(_onTimerFired, _composingRetryMs);
                return;
            }
            // 调用 chat.send 触发 LLM 生成一句主动话术
            // 引导文本让 LLM 理解这是"主动开口"指令，而非用户提问
            // skipHistory: true 主动回复不写入对话历史（避免历史面板出现系统触发语）
            if (chat && typeof chat.send === 'function') {
                chat.send('（系统触发主动回复，请按你的人设主动说一句话，不需要回答这条指令）', { skipHistory: true }).then(function (response) {
                    if (response) {
                        eventBus.emit('chat:response', { msg: response });
                    }
                }).catch(function (e) {
                    console.warn('[petAutoReply] send failed: ' + e);
                });
            }
            // 递归调度下一次
            _reschedule();
        }

        // 唤醒时重新调度（若睡眠期间 timer 已被清除）
        function onWake() {
            _lastUserSendTime = Date.now();
            _reschedule();
        }

        function pause() {
            if (_timer) { clearTimeout(_timer); _timer = null; }
        }

        function resume() {
            if (!_timer) _reschedule();
        }

        function destroy() {
            if (_timer) clearTimeout(_timer);
            _timer = null;
            // 注销 eventBus 监听器，避免 destroy 后回调仍被触发
            eventBus.off('chat:userSend', _onUserSend);
            eventBus.off('chat:composing:start', _onComposingStart);
            eventBus.off('chat:composing:end', _onComposingEnd);
            eventBus.off('settings:autoReplyChanged', _onAutoReplySettingsChanged);
        }

        return { init: init, onWake: onWake, pause: pause, resume: resume, destroy: destroy };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createAutoReply = createAutoReply;
})(window);
