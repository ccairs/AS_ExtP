// petBubble.js — 对话气泡 UI（文本气泡 + 对话输入框）
(function (global) {
    'use strict';

    // ── 气泡停留时长：按内容长度自适应 ──
    // 固定时长对长短文本都不合适：一行短台词 4s 够看，主动回复/LLM 台词写满三句
    // （数十字）时 5s 内读不完就被定时器收走。
    // 按阅读速度换算（中文约 5.5 字/秒，即每字 0.18s）并夹在上下限内：
    //   下限两档 —— 闲时播报的一行短台词沿用 4s；对话回复（用户提问 / 主动回复）
    //               沿用原 5s（用户在读这条回复，不为统一规则改动既有观感）
    //   上限 12000ms —— 防止长回复把气泡长期占屏（鼠标悬停本就会暂停计时，见 hover 处理）
    // 半角 ASCII 按半字计（视觉宽度约一半），空白不计（换行/缩进不占阅读时间）。
    var BUBBLE_MS_PER_CHAR = 180;
    var BUBBLE_MIN_MS = 4000;
    var CHAT_REPLY_MIN_MS = 5000;
    var BUBBLE_MAX_MS = 12000;

    function bubbleDurationMs(text, minMs) {
        var floor = (typeof minMs === 'number' && minMs > 0) ? minMs : BUBBLE_MIN_MS;
        var s = (text == null) ? '' : String(text);
        var units = 0;
        for (var i = 0; i < s.length; i++) {
            var c = s.charCodeAt(i);
            if (c === 32 || c === 9 || c === 10 || c === 13) continue;
            units += (c < 0x2E80) ? 0.5 : 1;   // 半角 ASCII 半字，其余（含 CJK/全角）一字
        }
        var ms = Math.round(units * BUBBLE_MS_PER_CHAR);
        if (ms < floor) ms = floor;
        if (ms > BUBBLE_MAX_MS) ms = BUBBLE_MAX_MS;
        return ms;
    }

    function createBubble(eventBus, container) {
        var _bubbleEl = null;
        var _chatEl = null;
        var _hideTimer = null;
        var _hideAnimTimer = null;  // hide() 内嵌的 300ms 延迟 timer，destroy 时清理
        var _focusTimer = null;     // showChatInput() 内嵌的 100ms focus timer，destroy 时清理
        var _chatMode = false;
        var _onInputKeydown = null;  // input keydown handler 引用，destroy 时移除监听
        var _docClickTimer = null;  // showChatInput 延迟绑定 document 监听的 timer，destroy/hide 时清理

        var _bubbleHideHandlers = null;  // hover mouseenter/mouseleave 引用，destroy 时移除监听

        var _stickyBubble = false;  // duration=0 常驻气泡标志（无自动隐藏定时器）

        function init() {
            _bubbleEl = document.createElement('div');
            _bubbleEl.className = 'dspet-bubble';
            _bubbleEl.style.display = 'none';
            container.appendChild(_bubbleEl);

            // hover 取消自动消失：鼠标移入气泡时暂停 hide timer，移开后重新启动
            // _hideTimer 记录剩余 duration，mouseleave 时按剩余时间或 5s 重新计时
            _bubbleHideHandlers = {
                enter: function () {
                    if (_hideTimer) {
                        clearTimeout(_hideTimer);
                        _hideTimer = null;
                    }
                },
                leave: function () {
                    // 重新启动 hide：固定 5s（不追踪原剩余时间，简化逻辑）
                    if (_hideTimer) clearTimeout(_hideTimer);
                    _hideTimer = setTimeout(function () { hide(); }, 5000);
                }
            };
            _bubbleEl.addEventListener('mouseenter', _bubbleHideHandlers.enter);
            _bubbleEl.addEventListener('mouseleave', _bubbleHideHandlers.leave);

            _chatEl = document.createElement('div');
            _chatEl.className = 'dspet-chat-input';
            _chatEl.style.display = 'none';
            _chatEl.innerHTML =
                AEI18n.html('<input type="text" placeholder="对桌宠说点什么..." />') +
                AEI18n.html('<button class="dspet-chat-history-btn" title="对话历史">历史</button>') +
                AEI18n.html('<button class="dspet-chat-send-btn" type="button">发送</button>');
            container.appendChild(_chatEl);

            var input = _chatEl.querySelector('input');
            var sendBtn = _chatEl.querySelector('.dspet-chat-send-btn');
            var histBtn = _chatEl.querySelector('.dspet-chat-history-btn');

            sendBtn.addEventListener('click', _onSend);
            _onInputKeydown = function (e) {
                if (e.key === 'Enter') { e.preventDefault(); _onSend(); }
                if (e.key === 'Escape') { hideChatInput(); }
            };
            input.addEventListener('keydown', _onInputKeydown);
            // 监听输入框聚焦/失焦/输入：通知 petAutoReply 用户正在编辑
            // 主动回复到期时若用户正在输入则推迟，避免突兀插入打断用户思路
            input.addEventListener('focus', function () {
                eventBus.emit('chat:composing:start');
            });
            input.addEventListener('blur', function () {
                eventBus.emit('chat:composing:end');
            });
            // input 事件节流：避免每按一键就 emit
            var _lastCompEmit = 0;
            input.addEventListener('input', function () {
                var now = Date.now();
                if (now - _lastCompEmit > 5000) {
                    _lastCompEmit = now;
                    eventBus.emit('chat:composing:start');
                }
            });
            histBtn.addEventListener('click', function () {
                eventBus.emit('history:openPanel');
            });

            // 保存 eventBus 监听器引用，destroy 时可正确移除
            // 主动回复（petAutoReply → chat:response）走对话回复档：短回复下限 5s
            // （与改动前一致），长回复按长度延长，显式 duration 原样生效
            _onChatResponse = function (data) {
                if (data && data.msg) {
                    show(data.msg, (data.duration == null)
                        ? bubbleDurationMs(data.msg, CHAT_REPLY_MIN_MS)
                        : data.duration);
                }
            };
            // 闲时播报出口（历史事件通道，现由 timerAnnounce 直接调 showBubble）：短台词下限 4s
            _onAnnounceShow = function (data) {
                if (data && data.msg) show(data.msg, data.duration);
            };
            _onHistoryOpenPanel = function () {
                if (global.AEDeepseekPet && global.AEDeepseekPet.controller) {
                    var api = global.AEDeepseekPet.controller.getPetApi();
                    api.openHistoryPanel();
                }
            };
            eventBus.on('chat:response', _onChatResponse);
            eventBus.on('announce:show', _onAnnounceShow);
            eventBus.on('history:openPanel', _onHistoryOpenPanel);

            // duration=0 的常驻气泡（设计上由行为收尾 hide）在行为被打断时
            // 失去收尾方——behaviorRegistry.interruptCurrent / _execute 顶替旧行为均会
            // 跳过 _finishBehavior（.then 收尾守卫失败），气泡无定时器永久滞留。
            // 监听行为代际中断事件，将粘性气泡降级为 30s 兜底强隐藏（保留断连提示
            // 信息一段时间，同时保证最终消失）；常规定时气泡不受影响
            _onBehaviorInterrupted = function () {
                if (!_stickyBubble) return;
                _stickyBubble = false;
                if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
                _hideTimer = setTimeout(function () { hide(true); }, 30000);
            };
            eventBus.on('behavior:interrupted', _onBehaviorInterrupted);
        }

        var _chatHideTimer = null;  // hideChatInput 退场动画 timer，destroy 时清理
        var _onChatResponse = null, _onAnnounceShow = null, _onHistoryOpenPanel = null;
        var _onBehaviorInterrupted = null;  // 行为代际中断监听，destroy 时移除

        function _onSend() {
            var input = _chatEl.querySelector('input');
            var text = input.value.trim();
            if (!text) return;
            if (!global.AEDeepseekPet || !global.AEDeepseekPet.controller) {
                // controller 不可用（可能正在 destroy），避免 30 秒空等
                show(AEI18n.t('桌宠暂时不可用'), 3000);
                return;
            }
            var petApi = global.AEDeepseekPet.controller.getPetApi();
            // 上一次回复仍在生成：保留用户输入不清空（否则消息静默丢失），
            // 仅提示稍后再发
            if (petApi.isChatActive && petApi.isChatActive()) {
                show(AEI18n.t('正在回复中，请稍等...'), 3000);
                return;
            }
            input.value = '';
            // 通知 petAutoReply 重置计时器：用户主动发送了消息
            eventBus.emit('chat:userSend');
            // 不立即 display:none，走退场动画
            hideChatInput();
            // "思考中..."气泡持续时间对齐 LLM 超时（petChat.js 中 timeoutMs=chatTimeoutMs，可在桌宠设置调整），
            // 避免 LLM 还在生成时气泡先消失
            var _chatTimeoutMs = 120000;
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    _chatTimeoutMs = global.AEDeepseekPet.settings.getSettings().chatTimeoutMs || 120000;
                }
            } catch (e) {}
            show(AEI18n.t('思考中...'), _chatTimeoutMs);
            petApi.sendChat(text).then(function (response) {
                // 用户提问的回复：短回复沿用原 5s 下限，长回复按长度延长
                if (response) show(response, bubbleDurationMs(response, CHAT_REPLY_MIN_MS));
                else hide();
            }).catch(function () {
                show(AEI18n.t('呃…网络好像不太好'), 3000);
            });
        }

        function show(text, duration) {
            if (!_bubbleEl) return;
            // duration 省略/'auto' → 按内容长度自适应（bubbleDurationMs）；
            // duration===0 → 常驻气泡（crashOverride 断连提示，由行为收尾 hide）
            var hideAfter = (duration === undefined || duration === null || duration === 'auto')
                ? bubbleDurationMs(text)
                : duration;
            _bubbleEl.textContent = text;
            _bubbleEl.classList.add('visible');
            _bubbleEl.style.display = '';
            if (_hideTimer) clearTimeout(_hideTimer);
            // duration<=0 为常驻气泡（无自动隐藏定时器），标记粘性，
            // 行为代际中断时降级 30s 兜底；常规定时气泡不受打断影响
            _stickyBubble = !(hideAfter && hideAfter > 0);
            if (hideAfter && hideAfter > 0) {
                _hideTimer = setTimeout(function () { hide(); }, hideAfter);
            }
        }

        // force=true 强制隐藏（聊天框打开/关闭桌宠/行为收尾清理），不受 hover 限制；
        // 定时器到期的常规隐藏在鼠标悬停阅读时跳过（mouseleave 会重新启动隐藏计时），
        // 用 matches(':hover') 实时判断而非标志位：容器 display:none 后 mouseleave 不可靠，
        // 标志位会滞留 true 导致此后气泡永不被定时器隐藏
        function hide(force) {
            if (!_bubbleEl) return;
            if (!force && _bubbleEl.matches && _bubbleEl.matches(':hover')) return;
            _bubbleEl.classList.remove('visible');
            _stickyBubble = false;  // 气泡已隐藏，粘性标记随之失效
            if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
            if (_hideAnimTimer) { clearTimeout(_hideAnimTimer); _hideAnimTimer = null; }
            _hideAnimTimer = setTimeout(function () {
                _hideAnimTimer = null;
                if (_bubbleEl && !_bubbleEl.classList.contains('visible')) {
                    _bubbleEl.style.display = 'none';
                }
            }, 300);
        }

        function showChatInput() {
            if (!_chatEl) return;
            hide(true);
            // 清理上一次的退场动画 timer
            if (_chatHideTimer) { clearTimeout(_chatHideTimer); _chatHideTimer = null; }
            // 移除 hiding 类（若有），重置入场动画初始状态
            _chatEl.classList.remove('hiding');
            // display:flex 触发布局，下一帧加 visible 类触发入场动画
            _chatEl.style.display = '';
            // .dspet-chat-input 基础 opacity:0，加 visible 类才可见
            requestAnimationFrame(function () {
                if (_chatEl) _chatEl.classList.add('visible');
            });
            _chatMode = true;
            var input = _chatEl.querySelector('input');
            if (input) {
                if (_focusTimer) clearTimeout(_focusTimer);
                _focusTimer = setTimeout(function () {
                    _focusTimer = null;
                    if (_chatEl && _chatEl.parentNode) input.focus();
                }, 100);
            }
            // 监听 document 点击事件：点击 _chatEl 外部时关闭聊天框
            // 用 setTimeout(0) 避免捕获触发 showChatInput 的 mousedown 事件导致立即关闭
            // timer 句柄保存到 _docClickTimer：destroy/hideChatInput 时取消，
            // 否则 destroy 先 removeEventListener、timer 后 add，监听器永久残留
            if (_docClickTimer) { clearTimeout(_docClickTimer); _docClickTimer = null; }
            _docClickTimer = setTimeout(function () {
                _docClickTimer = null;
                document.addEventListener('mousedown', _onDocClickOutside, true);
            }, 0);
        }

        function hideChatInput() {
            if (!_chatEl) return;
            // 添加 hiding 类触发退场动画（opacity 0 + translateY 上移）
            _chatEl.classList.add('hiding');
            _chatEl.classList.remove('visible');
            _chatMode = false;
            // 取消尚未触发的延迟绑定，再移除 document 监听，避免关闭后还拦截点击
            if (_docClickTimer) { clearTimeout(_docClickTimer); _docClickTimer = null; }
            document.removeEventListener('mousedown', _onDocClickOutside, true);
            // 等退场动画完成后 display:none
            if (_chatHideTimer) clearTimeout(_chatHideTimer);
            _chatHideTimer = setTimeout(function () {
                _chatHideTimer = null;
                if (_chatEl) {
                    _chatEl.style.display = 'none';
                    _chatEl.classList.remove('hiding');
                }
            }, 200);
        }

        // 点击 _chatEl 外部时关闭聊天框（类 modal 行为）
        function _onDocClickOutside(e) {
            if (!_chatMode || !_chatEl) return;
            // 点击聊天框内部（input/按钮）不关闭
            if (_chatEl.contains(e.target)) return;
            // 点击桌宠 canvas/sprite 也不关闭（避免与 longpress/click 事件冲突）
            // 但点击 bubble 应该关闭聊天框：bubble 是临时提示，不应阻挡 modal 关闭行为
            var petContainer = _chatEl.parentNode;
            if (petContainer) {
                var sprite = petContainer.querySelector('.dspet-sprite');
                if (sprite && (e.target === sprite || sprite.contains(e.target))) return;
            }
            hideChatInput();
        }

        function destroy() {
            // 移除 eventBus 监听器
            eventBus.off('chat:response', _onChatResponse);
            eventBus.off('announce:show', _onAnnounceShow);
            eventBus.off('history:openPanel', _onHistoryOpenPanel);
            eventBus.off('behavior:interrupted', _onBehaviorInterrupted);
            _onChatResponse = null;
            _onAnnounceShow = null;
            _onHistoryOpenPanel = null;
            _onBehaviorInterrupted = null;
            if (_hideTimer) clearTimeout(_hideTimer);
            if (_hideAnimTimer) clearTimeout(_hideAnimTimer);
            if (_focusTimer) clearTimeout(_focusTimer);
            if (_chatHideTimer) clearTimeout(_chatHideTimer);
            if (_docClickTimer) { clearTimeout(_docClickTimer); _docClickTimer = null; }
            _hideTimer = null;
            _hideAnimTimer = null;
            _focusTimer = null;
            _chatHideTimer = null;
            // 移除气泡 hover 监听
            if (_bubbleEl && _bubbleHideHandlers) {
                _bubbleEl.removeEventListener('mouseenter', _bubbleHideHandlers.enter);
                _bubbleEl.removeEventListener('mouseleave', _bubbleHideHandlers.leave);
            }
            _bubbleHideHandlers = null;
            // 移除 document 外部点击监听（若 showChatInput 后未 hideChatInput 就 destroy）
            document.removeEventListener('mousedown', _onDocClickOutside, true);
            // 移除 sendBtn/input 上的事件监听器，避免 zombie 引用阻止 GC
            if (_chatEl) {
                var sendBtn = _chatEl.querySelector('.dspet-chat-send-btn');
                if (sendBtn) sendBtn.removeEventListener('click', _onSend);
                var input = _chatEl.querySelector('input');
                if (input && _onInputKeydown) input.removeEventListener('keydown', _onInputKeydown);
            }
            if (_bubbleEl && _bubbleEl.parentNode) _bubbleEl.parentNode.removeChild(_bubbleEl);
            if (_chatEl && _chatEl.parentNode) _chatEl.parentNode.removeChild(_chatEl);
            _bubbleEl = null;
            _chatEl = null;
        }

        // 由 controller 在桌宠大小变化时调用：同步气泡 bottom，避免压在桌宠身上
        // 聊天框用 CSS top: calc(100% + 6px) 自动跟随 container 高度，无需 JS 调整
        // bottom = petSize + 10px 间隙
        function setPetSize(size) {
            var bottomPx = (typeof size === 'number' && size > 0 ? size : 160) + 10;
            if (_bubbleEl) _bubbleEl.style.bottom = bottomPx + 'px';
        }

        return { init: init, show: show, hide: hide, showChatInput: showChatInput, hideChatInput: hideChatInput, setPetSize: setPetSize, destroy: destroy };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createBubble = createBubble;
    // 供行为层复用（timerAnnounce 需要与气泡同一时长来 wait/占用行为锁）：
    // 单一来源，避免两处各写一个魔数导致气泡与行为占用时长错位
    global.AEDeepseekPet.bubbleDurationMs = bubbleDurationMs;
})(window);
