// petController.js — 桌宠主控制器，协调各子模块、调度行为、路由工具调用
(function (global) {
    'use strict';

    function createController() {
        var _eventBus = global.AEDeepseekPet.createEventBus();
        var _sprites = global.AEDeepseekPet.createSprites(_eventBus);
        var _movement = null;
        var _bubble = null;
        var _chat = null;
        var _history = null;
        var _memory = null;
        var _webSearch = null;
        var _historyPanel = null;
        var _idleAnnounce = null;
        var _autoReply = null;
        var _sleepManager = null;
        var _dragHandler = null;
        var _activityZone = null;
        var _behaviorRegistry = null;
        var _settings = null;

        var _container = null;
        var _ctx = {
            petState: 'idle',
            lastClickTime: 0,
            clickCount: 0,
            lastActiveTime: Date.now(),
            inSleepMode: false,
            appearing: false,
            activityBounds: null,
            petPos: { x: 100, y: 100 },
            isDragging: false,
            dragPhase: null,
            bridgeStatus: 'ready',
            currentAnim: 'idle',
            behaviorLock: false
        };

        var _bridgeCheckTimer = null;
        var _resizeHandler = null;
        var _visibilityHandler = null;
        // sleepManager 是否已 init：关闭态启动时启动闸门会跳过 init，
        // startup() 需按此补 init（重复 init 会叠加事件监听与定时器）
        var _sleepManagerInited = false;
        // resize 过渡定时器（_bindEvents 内使用；提升到 createController 顶层，
        // 供 destroy 清理，避免作用域外引用抛 ReferenceError 中断销毁链）
        var _resizeTransitionTimer = null;
        var _contextMenuEl = null;
        var _contextMenuHideHandler = null;

        function init(opts) {
            opts = opts || {};
            _container = document.createElement('div');
            _container.className = 'dspet-container';
            _container.style.left = (_ctx.petPos.x) + 'px';
            _container.style.top = (_ctx.petPos.y) + 'px';
            document.body.appendChild(_container);

            // 暴露 eventBus 到全局，供 petEasterEgg 等外部模块使用
            global.AEDeepseekPet.eventBus = _eventBus;

            // settings 先建：首帧是否显示由磁盘上的 showPet 同步决定（见下方启动闸门）
            if (global.AEDeepseekPet.createSettings) {
                _settings = global.AEDeepseekPet.createSettings();
                _settings.init();
                // 暴露到全局，供 petIdleAnnounce/petWebSearch/petIndex 读取
                global.AEDeepseekPet.settings = _settings;
            }
            // 启动闸门（同步）：已关闭的桌宠不得先出现在面板上。以下两处运行时在 init 内
            // 会立刻产生可见动作，必须等闸门结论——bridge 离线检测会派发 crashOverride
            // （crash 动画 + 气泡），夜间 sleepManager.init 会 emit pet:sleep（sleep 动画）；
            // 而 showPet 的异步读在 Bridge 半死/慢通道下可能迟迟不 resolve
            var _closedAtStartup = false;
            try {
                _closedAtStartup = !!(_settings && typeof _settings.readShowPetSync === 'function'
                    && _settings.readShowPetSync() === false);
            } catch (e) { _closedAtStartup = false; }

            _sprites.mount(_container);
            // basePath 用相对路径：sprite 图通过 CSS background-image url() 加载，
            // 与 <img>/<video> 同走 HTML 资源解析，相对路径基于 document.baseURI 正常工作。
            _sprites.setBasePath('features/deepseekPet/sprites');
            // 读取全局低性能模式设置：在 manifest 加载前应用，影响 _preloadImages 的预热行为
            // lowPerfMode 由 main.js 从 settingsStore 加载后挂到 global.AE_ExtP_LowPerfMode（全局通用，非桌宠专属）
            try {
                if (global.AE_ExtP_LowPerfMode) {
                    _sprites.setLowPerfMode(true);
                    console.log('[petController] 低性能模式已启用：关闭GPU预热 + 12fps');
                }
            } catch (e) {
                console.warn('[petController] 读取 lowPerfMode 失败: ' + e);
            }
            // manifest 用绝对路径走 AEFS.readFile（标准文件读取通道，三层回退）：
            // 直接 fetch 相对路径在 CEP file:// 协议下不可靠——aefs.js 明确写
            // "CEF file:// 协议下相对路径会丢盘符，需构造完整 file:/// URL"。
            var extRoot = (typeof window !== 'undefined' && window.__ext_root) ? String(window.__ext_root).replace(/\\/g, '/') : '';
            _sprites.loadManifest(extRoot + '/client/features/deepseekPet/sprites/manifest.json').then(function () {
                // manifest 加载完成后，设置显示尺寸并同步 petSize 到各模块
                var applyDisplaySize = function () {
                    var DEFAULT_PET_SIZE = 160;
                    var sizeFromSettings = 0;
                    try {
                        if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                            var s = global.AEDeepseekPet.settings.getSettings();
                            if (s && typeof s.petSize === 'number' && s.petSize >= 80 && s.petSize <= 320) {
                                sizeFromSettings = s.petSize;
                            }
                        }
                    } catch (e) {}
                    var DISPLAY_SIZE = sizeFromSettings || DEFAULT_PET_SIZE;
                    _sprites.setDisplaySize(DISPLAY_SIZE, DISPLAY_SIZE);
                    var sz = DISPLAY_SIZE;
                    if (_dragHandler) _dragHandler.setPetSize(sz);
                    if (_movement) _movement.setPetSize(sz);
                    if (_activityZone) _activityZone.setPetSize(sz);
                    // 同步气泡/聊天框 bottom（避免压在桌宠身上）
                    if (_bubble && typeof _bubble.setPetSize === 'function') _bubble.setPetSize(sz);
                    // 出场动画贴屏幕底部播放（动画设计为从下方向上腾空入场）
                    // appear 期间容器 y = 屏幕高度 - 桌宠高度，避免动画下半身露出网页内容穿帮
                    var appearY = Math.max(0, window.innerHeight - sz);
                    _ctx.petPos.y = appearY;
                    if (_container) _container.style.top = appearY + 'px';
                    // 已关闭（showPet=false 的 whenReady 检查先于 manifest 完成）：
                    // 尺寸仍需应用，但跳过出场动画与调度，等 startup() 恢复 idle
                    if (_shutdown) return;
                    // appear 期间屏蔽交互，避免点击/拖拽打断动画导致 _checkActivityZone 永不调用
                    _ctx.appearing = true;
                    _ctx.behaviorLock = true;
                    function _onAppearDone() {
                        _ctx.appearing = false;
                        _ctx.behaviorLock = false;
                        // 出场期间被 shutdown（如设置面板关闭开关）：不再切动画/调度，
                        // 避免 shutdown 状态下 emit idle:enter 重启行为链
                        if (_shutdown) return;
                        // 深夜出场：sleepManager.init() 期间已 emit pet:sleep 设置 inSleepMode=true，
                        // 但当时 manifest 未加载完成，sleep 动画没真正播放。
                        // appear 完成后检测 inSleepMode，若已入睡则播 sleepStart→sleep，
                        // 不切 idle 也不 emit idle:enter（避免触发 walk 调度覆盖睡眠）
                        if (_ctx.inSleepMode) {
                            _sprites.play('sleepStart').then(function () {
                                if (!_ctx.inSleepMode) return; // 期间已唤醒则不切循环
                                _sprites.play('sleep');
                            });
                            _checkActivityZone();
                            return;
                        }
                        _sprites.play('idle');
                        _ctx.petState = 'idle';
                        // emit idle:enter 让 petMovement 重新调度走动
                        // （appear 期间 _scheduleIdle 可能已触发但因 appearing 检查失败，需重新调度）
                        _eventBus.emit('idle:enter');
                        _checkActivityZone();
                    }
                    // 播放出场动画，结束后切 idle（位置保持在底部贴边，作为后续 idleWander 的起始点）
                    _sprites.play('appear').then(_onAppearDone, _onAppearDone);
                };
                // 等待设置读盘完成再取 petSize：loadManifest 与 settings.init 是两个并发异步操作，
                // manifest 先 resolve 时同步读到的是默认值 160，用户持久化的尺寸会被忽略
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings &&
                    typeof global.AEDeepseekPet.settings.whenReady === 'function') {
                    global.AEDeepseekPet.settings.whenReady().then(applyDisplaySize, applyDisplaySize);
                } else {
                    applyDisplaySize();
                }
            }).catch(function(e) {
                // manifest 加载失败时重置状态，避免 behaviorLock 永久卡死
                _ctx.appearing = false;
                _ctx.behaviorLock = false;
                console.error('[petController] loadManifest failed:', e);
            });

            if (global.AEDeepseekPet.createMovement) {
                _movement = global.AEDeepseekPet.createMovement(_eventBus, _container, _ctx);
                _movement.init();
            }
            if (global.AEDeepseekPet.createBubble) {
                _bubble = global.AEDeepseekPet.createBubble(_eventBus, _container);
                _bubble.init();
            }
            if (global.AEDeepseekPet.createActivityZone) {
                _activityZone = global.AEDeepseekPet.createActivityZone();
                // 注入保存回调：委托 petSettings 统一写盘
                if (global.AEDeepseekPet.createSettings) {
                    _activityZone.setSaveCallback(function (patch) {
                        if (_settings) _settings.updateSettings(patch);
                    });
                }
                _activityZone.init();
                // bounds 读取在 _checkActivityZone 中通过 whenReady 异步处理，避免此处同步读到 null
            }
            if (global.AEDeepseekPet.createDragHandler) {
                _dragHandler = global.AEDeepseekPet.createDragHandler(_eventBus, _container, _sprites.getElement(), _ctx, _sprites);
                _dragHandler.init();
            }
            if (global.AEDeepseekPet.createSleepManager) {
                _sleepManager = global.AEDeepseekPet.createSleepManager(_eventBus, _ctx);
                // 不在此处 init：sleepManager.init 内会 emit pet:sleep，
                // 此时 controller 的 _bindEvents 还未调用，pet:sleep 监听器未注册
                // 推迟到 _bindEvents() 之后调用 init，确保事件监听就绪
            }
            if (global.AEDeepseekPet.createHistory) {
                _history = global.AEDeepseekPet.createHistory(_eventBus);
                _history.init();
            }
            if (global.AEDeepseekPet.createMemory) {
                _memory = global.AEDeepseekPet.createMemory(_eventBus);
                _memory.init();
            }
            if (global.AEDeepseekPet.createWebSearch) {
                _webSearch = global.AEDeepseekPet.createWebSearch();
                _webSearch.init();
            }
            if (global.AEDeepseekPet.createChat) {
                _chat = global.AEDeepseekPet.createChat(_eventBus, _history, _memory);
                _chat.setControllerApi(getPetApi());
                _chat.init();
            }
            if (global.AEDeepseekPet.createHistoryPanel) {
                _historyPanel = global.AEDeepseekPet.createHistoryPanel(_eventBus, _history, _memory);
                _historyPanel.init();
            }
            if (global.AEDeepseekPet.createIdleAnnounce) {
                _idleAnnounce = global.AEDeepseekPet.createIdleAnnounce(_eventBus, _chat);
                _idleAnnounce.init();
                // 暴露到全局，供 timerAnnounce 行为读取
                global.AEDeepseekPet.idleAnnounce = _idleAnnounce;
            }
            if (global.AEDeepseekPet.createAutoReply) {
                _autoReply = global.AEDeepseekPet.createAutoReply(_eventBus, _chat, _ctx);
                _autoReply.init();
            }
            if (global.AEDeepseekPet.createBehaviorRegistry) {
                _behaviorRegistry = global.AEDeepseekPet.createBehaviorRegistry(_eventBus);
                _behaviorRegistry.setPetApi(getPetApi());
                _behaviorRegistry.setCtx(_ctx);
                _behaviorRegistry.init();
                _registerDefaultBehaviors();
            }

            _bindEvents();
            // 关闭态启动不启动运行时：bridge 离线检测会立刻 dispatch crashOverride
            // （crash 动画 + 「连接断了」气泡），夜间 sleepManager.init 会 emit pet:sleep，
            // 两者都会在首帧把桌宠画上面板，随后才被 shutdown 收走
            if (!_closedAtStartup) {
                _startBridgeCheck();
                // sleepManager.init 推迟到 _bindEvents 之后：
                // init 内夜间检测会 emit pet:sleep，此时 controller 的 pet:sleep 监听器已注册
                _startSleepManager();
            }

            // 异步复核：同步闸门无法判定（null，如无 readFileSync 通道）时以磁盘读取结果兜底；
            // 同步闸门已判定关闭时在下方立即 shutdown（shutdown 幂等，此处不会重复执行）。
            // 读盘本身是异步的，同步闸门不可判定时只能等它落定后再决定
            try {
                if (global.AEDeepseekPet && global.AEDeepseekPet.settings) {
                    global.AEDeepseekPet.settings.whenReady().then(function () {
                        var s = global.AEDeepseekPet.settings.getSettings();
                        if (s && s.showPet === false) {
                            shutdown();
                        }
                    });
                }
            } catch (e) {}
            if (_closedAtStartup) shutdown();
        }

        function _startSleepManager() {
            if (!_sleepManager || typeof _sleepManager.init !== 'function') return;
            _sleepManager.init();
            _sleepManagerInited = true;
        }

        function _checkActivityZone() {
            if (!_activityZone) return;
            // 等待异步加载完成后再判断，避免磁盘已有 bounds 但 readFile 未完成时误触发框选
            _activityZone.whenReady().then(function () {
                if (!_activityZone.getBounds()) {
                    // 首次启动，提示用户框选活动区域（可跳过）
                    _activityZone.startSelection(function () {
                        var b = _activityZone.getBounds();
                        if (b) _ctx.activityBounds = b;
                    });
                } else {
                    _ctx.activityBounds = _activityZone.getBounds();
                }
            });
        }

        function _registerDefaultBehaviors() {
            var behaviors = global.AEDeepseekPet.defaultBehaviors || {};
            var ids = ['idleWander', 'idleStretch', 'idlePotHead', 'idleEat', 'clickBounce', 'clickRage', 'dragFollow', 'longpressChat', 'timerAnnounce', 'crashOverride', 'sleepTalk'];
            for (var i = 0; i < ids.length; i++) {
                if (typeof behaviors[ids[i]] === 'function') {
                    _behaviorRegistry.register(behaviors[ids[i]]());
                }
            }
        }

        function _bindEvents() {
            _eventBus.on('pet:sleep', function () {
                _ctx.inSleepMode = true;
                // 睡眠视觉提示：半透明 + 默认光标（配合 pet.css 的 .dspet-sprite.sleeping）
                try {
                    var sleepEl = _sprites.getElement();
                    if (sleepEl) sleepEl.classList.add('sleeping');
                } catch (e) {}
                // 先停行走：清空 _idleTimer、重置 _state，避免 walkLeft 播完后 emit walk:enter
                // 又触发 playQueued('walkLeft') 覆盖 sleepStart（walkLeft 是非循环，playQueued 会排队）
                if (_movement && typeof _movement.interruptWalk === 'function') {
                    _movement.interruptWalk();
                }
                // 先 interruptCurrent：若当前是 silent behavior，会 emit 'silent:action:done'
                // 让 controller resume movement，随后 movement.pause() 覆盖 resume 保证睡眠期间 movement 暂停
                if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                    _behaviorRegistry.interruptCurrent();
                }
                if (_movement) _movement.pause();
                // 入睡序列：sleepStart（一次性）-> sleep（循环）
                // 用 play 强制立即切：右键菜单/自动睡眠都是用户/系统意图，应打断当前动画
                // （若用 playQueued，walkLeft 非循环要等播完才切，体验差且可能被 walk:enter 覆盖）
                _sprites.play('sleepStart').then(function () {
                    if (!_ctx.inSleepMode) return; // 期间已唤醒则不切循环
                    _sprites.play('sleep');
                });
                // 暂停闲时播报 timer，避免休眠期间无用轮询和 LLM 调用浪费
                if (_idleAnnounce && typeof _idleAnnounce.pause === 'function') _idleAnnounce.pause();
                // 暂停主动回复：睡眠期间不触发主动回复
                if (_autoReply && typeof _autoReply.pause === 'function') _autoReply.pause();
                // dispatch sleep behaviors：触发 sleepTalk 等睡眠期间行为
                _dispatchBehaviors('sleep');
            });
            _eventBus.on('pet:wake', function () {
                _ctx.inSleepMode = false;
                // 移除睡眠视觉提示
                try {
                    var wakeEl = _sprites.getElement();
                    if (wakeEl) wakeEl.classList.remove('sleeping');
                } catch (e) {}
                // 唤醒序列：wakeUp（一次性）→ idle（循环）
                // 用 playQueued：sleep 是循环动画会立即切 wakeUp，无需排队
                // 关键：movement.resume() 推迟到 wakeUp 动画播完后才执行
                // 否则 _movement.resume() 立即恢复 _tick，但 _idleTimer 可能在 wakeUp 期间到期
                // → emit('idle:tick') → idleWander → _setState('walk') → _tick 走 walk 位移
                // 但序列帧还在播 wakeUp（playQueued 排队等 anim:done），导致"还没播完就开始移动"
                _sprites.playQueued('wakeUp').then(function () {
                    if (_ctx.inSleepMode) return; // 期间又入睡则不切 idle
                    // wakeUp 播放窗口内被交互 play() 打断时（点击/长按等），
                    // sprites 的 _settlePendingCallbacks 提前 settle 本 Promise，此刻
                    // getCurrentState 已是交互动画——不得 play('idle') 吞掉交互动画；
                    // 自然播完时 _currentState 已被 petSprites 置 null（或排队中的
                    // idle 已开播），照常切 idle 循环。后续 movement 恢复/idle:enter
                    // 调度不受影响（idle:enter 的 playQueued('idle') 排队等交互动画
                    // 播完，不覆盖）
                    var _wakeCur = _sprites.getCurrentState ? _sprites.getCurrentState() : null;
                    if (!_wakeCur || _wakeCur === 'idle') {
                        _sprites.play('idle');
                    }
                    // wakeUp 播完后才恢复 movement：此时序列帧已切到 idle，再触发 walk 不会冲突
                    if (_movement && typeof _movement.interruptWalk === 'function') {
                        _movement.interruptWalk();  // 清空 _idleTimer，重置 _state='idle'
                    }
                    if (_movement) _movement.resume();
                    // emit idle:enter 让 _scheduleIdle 重新调度下一次 idle 行为
                    _eventBus.emit('idle:enter');
                });
                // 恢复闲时播报 timer（不依赖动画，可立即恢复）
                if (_idleAnnounce && typeof _idleAnnounce.resume === 'function') _idleAnnounce.resume();
                // 恢复主动回复：唤醒后重新调度计时
                if (_autoReply && typeof _autoReply.onWake === 'function') _autoReply.onWake();
                // 唤醒时打断 sleepTalk 等睡眠行为，清空 behaviorLock
                if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                    _behaviorRegistry.interruptCurrent();
                }
            });
            _eventBus.on('drag:start', function () {
                _ctx.isDragging = true;
                _ctx.dragPhase = 'start';
                // 强制打断当前 behavior（如 idleWander 的 moveTo 未 resolve），
                // 否则 behaviorLock 卡死，dragFollow 会被跳过，拖拽序列帧不播放
                if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                    _behaviorRegistry.interruptCurrent();
                }
                _dispatchBehaviors('drag');
            });
            _eventBus.on('drag:end', function () {
                _ctx.isDragging = false;
                _ctx.dragPhase = 'end';
                _dispatchBehaviors('drag');
                _ctx.dragPhase = null;
            });
            _eventBus.on('click:pet', function (data) {
                // 出场动画期间屏蔽点击（_ctx.appearing 由 petController 设置）
                if (_ctx.appearing) return;
                // 点击桌宠时关闭聊天输入框（若正在显示）
                if (_bubble && typeof _bubble.hideChatInput === 'function') {
                    _bubble.hideChatInput();
                }
                // 在点击位置生成扩散圆涟漪动画（无论后续是否触发 behavior 都显示）
                if (data && typeof data.x === 'number' && typeof data.y === 'number') {
                    _spawnClickRipple(data.x, data.y);
                }
                // 睡眠期间点击/长按：只唤醒，不触发 click behavior
                // 避免睡眠期间 click 行为覆盖 sleep 动画 / 触发 idleWander
                if (_ctx.inSleepMode) {
                    if (_sleepManager && typeof _sleepManager.forceWake === 'function') {
                        _sleepManager.forceWake();
                    } else if (_sleepManager && typeof _sleepManager.wake === 'function') {
                        _sleepManager.wake();
                    } else {
                        _eventBus.emit('pet:wake');
                    }
                    return;
                }
                // 取消挂起的 idle 调度 + 停止当前 walk 位移：
                // 否则 _idleTimer 到期会触发新一轮 walk → play('walkLeft') 覆盖 click 动画；
                // 走动期间被点击时 _tick 仍按三阶段位移，桌宠在 click 动画播放时继续飘移
                if (_movement && typeof _movement.interruptWalk === 'function') {
                    _movement.interruptWalk();
                }
                // 点击触发前先打断当前 behavior（同 longpress 的修复逻辑，防 behaviorLock 卡死）
                if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                    _behaviorRegistry.interruptCurrent();
                }
                var now = Date.now();
                if (now - _ctx.lastClickTime < 500) {
                    _ctx.clickCount++;
                } else {
                    _ctx.clickCount = 1;
                }
                _ctx.lastClickTime = now;
                _dispatchBehaviors('click');
            });
            _eventBus.on('click:reset', function () {
                _ctx.clickCount = 0;
            });
            _eventBus.on('longpress:pet', function () {
                // 出场动画期间屏蔽长按
                if (_ctx.appearing) return;
                // 睡眠期间长按：同 click，只唤醒不触发 longpress behavior
                if (_ctx.inSleepMode) {
                    if (_sleepManager && typeof _sleepManager.forceWake === 'function') {
                        _sleepManager.forceWake();
                    } else if (_sleepManager && typeof _sleepManager.wake === 'function') {
                        _sleepManager.wake();
                    } else {
                        _eventBus.emit('pet:wake');
                    }
                    return;
                }
                // 长按同样取消 walk 调度（同 click 的修复逻辑，避免长按弹框期间被 walk 打断）
                if (_movement && typeof _movement.interruptWalk === 'function') {
                    _movement.interruptWalk();
                }
                // 长按触发前先打断当前 behavior（idleWander 的 moveTo 可能卡住 behaviorLock）
                // 否则 _dispatchBehaviors 第 309 行 behaviorLock 检查会直接 return，长按永远不弹框
                if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                    _behaviorRegistry.interruptCurrent();
                }
                _dispatchBehaviors('longpress');
            });
            _eventBus.on('idle:enter', function () {
                _ctx.petState = 'idle';
                // 拖拽期间不切 idle 动画：drag:start 时 settle idleWander 的 Promise 会
                // 触发 emit('idle:enter')，若此时 play('idle') 会覆盖 dragFollow 的 dragStart 动画
                if (!_ctx.isDragging) {
                    // 用 playQueued：若当前在播非循环动画（如 stretch），排队等 anim:done 再切 idle
                    _sprites.playQueued('idle');
                }
                // 不再 dispatch('idle')：避免 idleWander 立即触发 moveTo，
                // 覆盖 petMovement._scheduleIdle 的 5-12s 延迟，导致桌宠不停走动。
                // 走动时机由 petMovement._scheduleIdle 通过 emit('idle:tick') 触发下方 handler。
            });
            // _scheduleIdle 的 setTimeout 到期后触发：dispatch idle behaviors
            // 让 idleStretch（priority 15, 30% 概率）和 idleWander（priority 10）按优先级竞争
            _eventBus.on('idle:tick', function () {
                _dispatchBehaviors('idle');
            });
            // silent behavior（LLM 触发的动作）结束/被打断时 resume movement
            // triggerAction 中 movement.pause() 了，这里负责配对的 resume
            _eventBus.on('silent:action:done', function () {
                // 若 silent 仍为 true，表示新 silent behavior 正在执行（LLM 连发动作场景）
                // 此时不能 resume movement，否则会覆盖新 silent behavior 的 pause
                // 只有 silent=false（真正结束）时才 resume
                if (_ctx.silent) return;
                if (_movement && typeof _movement.resume === 'function') {
                    _movement.resume();
                }
            });
            _eventBus.on('walk:enter', function (data) {
                // 根据 targetX vs currentX 选择左右走动画
                var d = data || {};
                var cx = d.currentX != null ? d.currentX : _ctx.petPos.x;
                var tx = d.targetX != null ? d.targetX : cx;
                // 用 playQueued：若当前在播非循环动画，排队等 anim:done 再切 walk
                // idle 是循环动画会立即切，不影响 idleWander 触发的 walk
                _sprites.playQueued(tx >= cx ? 'walkRight' : 'walkLeft');
            });
            _eventBus.on('timer:announce', function () {
                _dispatchBehaviors('timer');
            });

            // 右键菜单：在点击位置显示自定义菜单，菜单外点击或 Esc 关闭
            _eventBus.on('pet:contextmenu', function (data) {
                if (data && typeof data.x === 'number' && typeof data.y === 'number') {
                    _showContextMenu(data.x, data.y);
                }
            });

            // resize 时桌宠位置按窗口尺寸比例缩放，保持相对位置不变
            // 例如：原面板宽 800、桌宠 x=400（中间），拖宽到 1200，桌宠 x=600（仍在中间）
            // bounds 也由 activityZone.clampToWindow 按相同比例缩放，保证相对位置不漂移
            _resizeHandler = function () {
                var newW = window.innerWidth;
                var newH = window.innerHeight;
                // 计算 sx/sy：优先用 activityZone 的 _lastWinSize，保证和 bounds 缩放比例一致
                // activityZone 未初始化时 fallback 到 _ctx 内的记录
                var oldW = 0, oldH = 0;
                if (_activityZone && typeof _activityZone.getLastWinSize === 'function') {
                    var sz = _activityZone.getLastWinSize();
                    oldW = sz.w; oldH = sz.h;
                }
                if (oldW <= 0 || oldH <= 0) {
                    oldW = newW; oldH = newH;
                }
                // 尺寸没变就不处理
                if (oldW === newW && oldH === newH) return;
                var sx = newW / oldW;
                var sy = newH / oldH;
                // 按比例缩放桌宠位置（保持相对位置）
                _ctx.petPos.x = Math.round(_ctx.petPos.x * sx);
                _ctx.petPos.y = Math.round(_ctx.petPos.y * sy);
                // bounds 按相同比例缩放（内部会更新 _lastWinW/_lastWinH）
                if (_activityZone) _activityZone.clampToWindow();
                // 给容器加 transition 让位置变化平滑过渡，避免瞬移感
                if (_container) {
                    _container.style.transition = 'left 0.18s ease-out, top 0.18s ease-out';
                }
                _clampToWindow();
                // 重置 transition 移除定时器，避免影响后续行走动画
                if (_resizeTransitionTimer) clearTimeout(_resizeTransitionTimer);
                _resizeTransitionTimer = setTimeout(function () {
                    if (_container) _container.style.transition = '';
                    _resizeTransitionTimer = null;
                }, 200);
            };
            window.addEventListener('resize', _resizeHandler);

            _visibilityHandler = function () {
                if (document.hidden) {
                    _sprites.pause();
                    if (_movement) _movement.pause();
                    // 闲时播报/主动回复一并暂停：否则面板隐藏期间仍照常发起 LLM 调用
                    if (_idleAnnounce && typeof _idleAnnounce.pause === 'function') _idleAnnounce.pause();
                    if (_autoReply && typeof _autoReply.pause === 'function') _autoReply.pause();
                } else {
                    // shutdown 状态下保持暂停：否则切回面板会重启 RAF/idle 调度，
                    // 桌宠在隐藏状态下继续跑行为链（位移/播报/气泡）
                    if (_shutdown) return;
                    _sprites.resume();
                    if (_movement && !_ctx.inSleepMode) _movement.resume();
                    // 恢复闲时播报/主动回复计时（两模块 pause 清 timer、resume 重新调度，
                    // 重复 pause/resume 无害；睡眠期间维持暂停，与 pet:sleep/pet:wake 语义一致）
                    if (!_ctx.inSleepMode) {
                        if (_idleAnnounce && typeof _idleAnnounce.resume === 'function') _idleAnnounce.resume();
                        if (_autoReply && typeof _autoReply.resume === 'function') _autoReply.resume();
                    }
                }
            };
            document.addEventListener('visibilitychange', _visibilityHandler);
            // 同步初始隐藏态。面板以隐藏态加载时 visibilitychange 不会触发，
            // 而闲时播报/主动回复的 timer 已在各自 init() 中启动（先于 _bindEvents），
            // 隐藏期间将照常到期发起 LLM 调用（违背「面板隐藏期间不发起 LLM 调用」的
            // 设计意图）。仅在初始隐藏时补一次同步（等价于初始 visibilitychange），
            // 可见态启动不执行，避免多余的 resume 副作用
            if (document.hidden) _visibilityHandler();
        }

        function _clampToWindow() {
            if (!_container) return;
            // 优先用 container 实际显示尺寸（用户设置的 petSize）；
            // getFrameSize 现返回显示尺寸（setDisplaySize 同步维护），与 container 一致
            var petSize = 120;
            if (_container.offsetWidth > 0) {
                petSize = _container.offsetWidth;
            } else if (_sprites && _sprites.isLoaded && _sprites.isLoaded() && _sprites.getFrameSize) {
                petSize = _sprites.getFrameSize();
            }
            var maxX = window.innerWidth - petSize;
            var maxY = window.innerHeight - petSize;
            if (_ctx.petPos.x > maxX) _ctx.petPos.x = maxX;
            if (_ctx.petPos.y > maxY) _ctx.petPos.y = maxY;
            if (_ctx.petPos.x < 0) _ctx.petPos.x = 0;
            if (_ctx.petPos.y < 0) _ctx.petPos.y = 0;
            _container.style.left = _ctx.petPos.x + 'px';
            _container.style.top = _ctx.petPos.y + 'px';
        }

        // 在点击位置生成扩散圆涟漪动画（400ms 扩散淡出）
        // 用 position:fixed 追踪视口坐标，动画结束自动移除 DOM
        function _spawnClickRipple(x, y) {
            var ripple = document.createElement('div');
            ripple.className = 'dspet-click-ripple';
            ripple.style.left = x + 'px';
            ripple.style.top = y + 'px';
            document.body.appendChild(ripple);
            setTimeout(function () {
                if (ripple.parentNode) ripple.parentNode.removeChild(ripple);
            }, 450);
        }

        // 显隐状态落盘（关闭桌宠）：persistNow 立即写并回报结果；无该接口的设置实例
        // 退回防抖写。false 只记日志——读取失败的保护态提示由 petSettings 统一发出，
        // 这里不重复弹窗
        function _persistShowPet(showPet) {
            var settings = global.AEDeepseekPet && global.AEDeepseekPet.settings;
            if (!settings) return;
            var pending = null;
            if (typeof settings.persistNow === 'function') {
                pending = settings.persistNow({ showPet: showPet });
            } else if (typeof settings.updateSettings === 'function') {
                settings.updateSettings({ showPet: showPet });
            }
            if (pending && typeof pending.then === 'function') {
                pending.then(function (ok) {
                    if (!ok) console.warn('[petController] showPet=' + showPet + ' 未能落盘：重新打开面板时状态可能不保持');
                }, function (e) {
                    console.warn('[petController] showPet=' + showPet + ' 落盘异常: ' + (e && e.message ? e.message : e));
                });
            }
        }

        // 右键菜单：在指定位置显示自定义菜单
        // 菜单项：打开聊天框 / 进入睡眠 / 唤醒 / 关闭桌宠
        // 菜单外点击、Esc、或选中某项后自动关闭
        function _showContextMenu(x, y) {
            _hideContextMenu();
            var menu = document.createElement('div');
            menu.className = 'dspet-context-menu';

            // 菜单项定义（根据当前睡眠状态动态切换）
            var items = [
                { id: 'chat', label: AEI18n.t('打开聊天框'), action: function () {
                    if (_bubble) _bubble.showChatInput();
                } },
                { separator: true },
                { id: 'settings', label: AEI18n.t('桌宠设置'), action: function () {
                    if (global.AEDeepseekPet && global.AEDeepseekPet.settings && typeof global.AEDeepseekPet.settings.openModal === 'function') {
                        global.AEDeepseekPet.settings.openModal();
                    }
                } },
                { separator: true }
            ];
            if (_ctx.inSleepMode) {
                items.push({ id: 'wake', label: AEI18n.t('唤醒'), action: function () {
                    if (_sleepManager && typeof _sleepManager.forceWake === 'function') {
                        _sleepManager.forceWake();
                    } else if (_sleepManager && typeof _sleepManager.wake === 'function') {
                        _sleepManager.wake();
                    } else {
                        _eventBus.emit('pet:wake');
                    }
                } });
            } else {
                items.push({ id: 'sleep', label: AEI18n.t('进入睡眠'), action: function () {
                    // 强制睡眠：不响应 mousemove/click 唤醒，必须再次从菜单唤醒
                    if (_sleepManager && typeof _sleepManager.forceSleep === 'function') {
                        _sleepManager.forceSleep();
                    } else {
                        _eventBus.emit('pet:sleep');
                        _ctx.inSleepMode = true;
                        _ctx.petState = 'sleep';
                    }
                    // 取消挂起的 walk/idle 调度，避免睡眠期间被插入
                    if (_movement && typeof _movement.interruptWalk === 'function') {
                        _movement.interruptWalk();
                    }
                    if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                        _behaviorRegistry.interruptCurrent();
                    }
                } });
            }
            items.push({ separator: true });
            items.push({ id: 'close', label: AEI18n.t('关闭桌宠'), danger: true, action: function () {
                // 立即关闭，不弹确认弹窗。
                // 先落盘再关运行时：关闭状态决定下次打开面板时桌宠是否出现，不能停在
                // 500ms 防抖里（用户紧接着关面板时只剩卸载 flush 一条通道），也不能放在
                // shutdown() 之后（子模块收尾一旦抛错，菜单点击的 try/catch 会吞掉写盘）。
                // 落盘同步抛错时 finally 仍执行 shutdown，右键「关闭桌宠」不会整项失效
                try {
                    _persistShowPet(false);
                } finally {
                    shutdown();
                }
                // 若设置面板已打开，同步开关 UI 状态
                try {
                    var showInput = document.querySelector('#petSettingShow');
                    if (showInput) showInput.checked = false;
                } catch (e) {}
            } });

            for (var i = 0; i < items.length; i++) {
                var item = items[i];
                if (item.separator) {
                    var sep = document.createElement('div');
                    sep.className = 'dspet-context-menu-separator';
                    menu.appendChild(sep);
                    continue;
                }
                (function (it) {
                    var el = document.createElement('div');
                    el.className = 'dspet-context-menu-item' + (it.danger ? ' danger' : '');
                    el.textContent = it.label;
                    el.addEventListener('click', function () {
                        _hideContextMenu();
                        try { it.action(); } catch (e) {}
                    });
                    menu.appendChild(el);
                })(item);
            }

            document.body.appendChild(menu);
            // position:fixed 追踪视口坐标，先 display 再测量尺寸以避免溢出
            var menuW = menu.offsetWidth;
            var menuH = menu.offsetHeight;
            var px = x, py = y;
            if (px + menuW > window.innerWidth) px = window.innerWidth - menuW - 4;
            if (py + menuH > window.innerHeight) py = window.innerHeight - menuH - 4;
            menu.style.left = px + 'px';
            menu.style.top = py + 'px';
            // 下一帧添加 visible 类触发淡入动画
            requestAnimationFrame(function () { menu.classList.add('visible'); });
            _contextMenuEl = menu;

            // 菜单外 mousedown 关闭（捕获阶段，先于 click 事件触发）
            _contextMenuHideHandler = function (e) {
                if (menu.contains(e.target)) return;
                _hideContextMenu();
            };
            // 延迟绑定避免触发本次 contextmenu 的事件链立即关闭
            setTimeout(function () {
                document.addEventListener('mousedown', _contextMenuHideHandler, true);
            }, 0);
            // Esc 关闭
            var escHandler = function (e) {
                if (e.key === 'Escape') {
                    _hideContextMenu();
                    document.removeEventListener('keydown', escHandler);
                }
            };
            document.addEventListener('keydown', escHandler);
            menu._escHandler = escHandler;
        }

        function _hideContextMenu() {
            if (!_contextMenuEl) return;
            var menu = _contextMenuEl;
            menu.classList.remove('visible');
            if (_contextMenuHideHandler) {
                document.removeEventListener('mousedown', _contextMenuHideHandler, true);
                _contextMenuHideHandler = null;
            }
            if (menu._escHandler) {
                document.removeEventListener('keydown', menu._escHandler);
                menu._escHandler = null;
            }
            // 等动画完成再移除
            setTimeout(function () {
                if (menu && menu.parentNode) menu.parentNode.removeChild(menu);
            }, 160);
            _contextMenuEl = null;
        }

        function _dispatchBehaviors(type) {
            if (!_behaviorRegistry) return;
            if (_ctx.behaviorLock && type !== 'event') return;
            _behaviorRegistry.dispatch(type, _ctx);
        }

        function _startBridgeCheck() {
            if (_bridgeCheckTimer) clearInterval(_bridgeCheckTimer);
            // 首次立即检查，避免启动后 10 秒内 Bridge 已离线却未触发 crashOverride
            _checkBridgeOnce();
            _bridgeCheckTimer = setInterval(_checkBridgeOnce, 10000);
        }

        function _checkBridgeOnce() {
            // Bridge.isAvailable() 可能抛错（Bridge 对象异常状态），需 try/catch
            // 对齐 main.js / aefs.js 的 Bridge 探测模式，避免 setInterval 回调持续抛错
            var online = false;
            try {
                online = !!(typeof Bridge !== 'undefined' && Bridge.isAvailable && Bridge.isAvailable());
            } catch (_) {
                online = false;
            }
            var newStatus = online ? 'ready' : 'offline';
            if (newStatus !== _ctx.bridgeStatus) {
                _ctx.bridgeStatus = newStatus;
                if (newStatus === 'offline') {
                    _eventBus.emit('bridge:offline');
                    // 系统事件优先：若当前是 LLM 触发的 silent behavior，清除 silent 状态
                    // 让 crashOverride 的"连接断了"提示气泡正常显示
                    if (_ctx.silent) {
                        _ctx.silent = false;
                        if (_movement && typeof _movement.resume === 'function') {
                            _movement.resume();
                        }
                    }
                    if (_behaviorRegistry) _behaviorRegistry.dispatch('event', _ctx, 'crashOverride');
                } else {
                    _eventBus.emit('bridge:online');
                }
            }
        }

        function getPetApi() {
            return {
                playAnim: function (name) {
                    return _sprites.play(name);
                },
                showBubble: function (text, duration) {
                    if (_bubble) _bubble.show(text, duration);
                },
                hideBubble: function () {
                    if (_bubble) _bubble.hide(true);
                },
                moveTo: function (x, y) {
                    if (_movement) return _movement.moveTo(x, y);
                    return Promise.resolve();
                },
                getState: function () {
                    return JSON.parse(JSON.stringify(_ctx));
                },
                setState: function (state) {
                    _ctx.petState = state;
                    if (_movement) _movement.setState(state);
                },
                // 随机散步一次（距离由 movement 按序列帧位移预算选取）；
                // 不要用 moveTo 自己算远点：超出预算会走完就停下、动画还在播
                wander: function () {
                    if (_movement && typeof _movement.wander === 'function') return _movement.wander();
                    return Promise.resolve();
                },
                wait: function (ms) {
                    return new Promise(function (resolve) { setTimeout(resolve, ms); });
                },
                on: function (event, cb) { _eventBus.on(event, cb); },
                off: function (event, cb) { _eventBus.off(event, cb); },
                emit: function (event, data) { _eventBus.emit(event, data); },
                openChat: function () {
                    if (_bubble) _bubble.showChatInput();
                },
                openHistoryPanel: function () {
                    if (_historyPanel) _historyPanel.show();
                },
                sendChat: function (text) {
                    // 用户在聊天框发消息 = 明确要交互：睡眠中先唤醒（对齐 click/longpress 的口径）。
                    // 自动睡眠时 chat:userSend 已会唤醒，这里补的是右键「进入睡眠」的强制睡眠——
                    // 该模式下 sleepManager 的 _onActivity 直接 return，不显式唤醒就会「睡着了还在回话」
                    if (_ctx.inSleepMode) {
                        if (_sleepManager && typeof _sleepManager.forceWake === 'function') {
                            _sleepManager.forceWake();
                        } else if (_sleepManager && typeof _sleepManager.wake === 'function') {
                            _sleepManager.wake();
                        } else {
                            _eventBus.emit('pet:wake');
                        }
                    }
                    if (_chat) return _chat.send(text);
                    return Promise.resolve('');
                },
                isChatActive: function () {
                    return _chat ? _chat.isActive() : false;
                },
                executeTool: executeTool
            };
        }

        function executeTool(name, params) {
            return new Promise(function (resolve) {
                var timeout = setTimeout(function () {
                    resolve({ error: '工具执行超时: ' + name });
                }, 10000);
                try {
                    if (name === 'save_memory' && _memory) {
                        // 拒绝空内容保存——畸形 tool_call 参数解析失败降级 {}
                        // 后 content 为 undefined，save(undefined) 会产出空字符串
                        // 记忆条目落盘（脏数据）
                        if (!params || params.content == null || String(params.content).trim() === '') {
                            clearTimeout(timeout);
                            resolve({ error: 'save_memory 缺少有效 content 参数' });
                            return;
                        }
                        _memory.save(params.content, params.tags, params.importance).then(function (entry) {
                            clearTimeout(timeout);
                            resolve({ success: true, id: entry.id });
                        }).catch(function (e) {
                            clearTimeout(timeout);
                            resolve({ error: '保存失败: ' + (e && e.message ? e.message : e) });
                        });
                    } else if (name === 'delete_memory' && _memory) {
                        _memory.delete(params.id).then(function () {
                            clearTimeout(timeout);
                            resolve({ success: true });
                        }).catch(function (e) {
                            clearTimeout(timeout);
                            resolve({ error: '删除失败: ' + (e && e.message ? e.message : e) });
                        });
                    } else if (name === 'recall_memory' && _memory) {
                        // 缺失/空 query 显式报错——search(undefined) 会被
                        // petMemory 当「返回全部」处理，全部记忆塞进 LLM 上下文
                        var _recallQ = (params && typeof params.query === 'string') ? params.query.trim() : '';
                        if (!_recallQ) {
                            clearTimeout(timeout);
                            resolve({ error: 'recall_memory 缺少有效 query 参数' });
                            return;
                        }
                        var results = _memory.search(_recallQ);
                        clearTimeout(timeout);
                        resolve({ success: true, memories: results });
                    } else if (name === 'search_web') {
                        // search_web 工具分支保留（仍有 LLM 通过 tool_call 调用此工具的场景）
                        if (!_webSearch) {
                            console.warn('[petController] search_web: _webSearch not initialized');
                            clearTimeout(timeout);
                            resolve({ error: '搜索功能未初始化' });
                        } else {
                            _webSearch.search(params.query, params.num).then(function (results) {
                                clearTimeout(timeout);
                                resolve({ success: true, results: results });
                            }).catch(function (e) {
                                clearTimeout(timeout);
                                console.warn('[petController] search_web failed: ' + (e && e.message ? e.message : e));
                                resolve({ error: '搜索失败: ' + (e && e.message ? e.message : e) });
                            });
                        }
                    } else {
                        clearTimeout(timeout);
                        resolve({ error: '未知工具: ' + name });
                    }
                } catch (e) {
                    clearTimeout(timeout);
                    resolve({ error: String(e) });
                }
            });
        }

        // LLM 回复中的 [action:xxx] 标识符触发的动作：
        // 走 behavior 系统的强制派发（dispatch forceId='event'），复用 behavior 的
        // condition/onInterrupt/状态恢复逻辑；同时设置 ctx.silent=true 让 _wrapApi
        // 屏蔽 behavior 内的 showBubble，避免覆盖 LLM 的回复气泡
        function triggerAction(behaviorId) {
            if (!_behaviorRegistry || !_behaviorRegistry.getById(behaviorId)) return;
            // 睡眠守卫（对齐 click/longpress 的 inSleepMode 守卫）——睡眠中
            // LLM 动作标识符直接顶替会打断睡眠序列（sleepStart/sleep 循环错乱数秒）
            if (_ctx.inSleepMode) return;
            // 拖拽中守卫：顶掉 dragFollow 会连人带动画一起断（拖拽序列帧停在半路、
            // 松手时 dragEnd 的监听器已被 onInterrupt 摘掉没人补播，动作若先播完
            // 则姿势冻结到下一次 idle 调度）；松手后下一次回复照常触发
            if (_ctx.isDragging) return;
            // 出场守卫（对齐 click/longpress 的 appearing 口径）：出场期间
            // behaviorLock/appearing 由 _onAppearDone 收尾，它随后 play('idle')
            // 并复位 behaviorLock，与抢跑的动作互相覆盖只剩一次闪烁
            if (_ctx.appearing) return;
            // 暂停 movement：避免动画播放期间 walk 触发位移
            if (_movement && typeof _movement.interruptWalk === 'function') _movement.interruptWalk();
            if (_movement && typeof _movement.pause === 'function') _movement.pause();
            // 标记 silent：本次 dispatch 触发的 behavior 内 showBubble 会被屏蔽
            _ctx.silent = true;
            // forceId 走 dispatch 内部强制派发分支：跳过 type/condition/behaviorLock 检查
            _behaviorRegistry.dispatch('event', _ctx, behaviorId);
        }

        function show() {
            if (_container) _container.style.display = '';
        }

        function hide() {
            if (_container) _container.style.display = 'none';
        }

        // 暂时关闭桌宠：停止所有子模块的运行时（timer/RAF/活动检测），
        // 隐藏 DOM 和所有弹出的 UI（气泡/聊天框/历史面板/右键菜单）
        // 与 destroy 不同：保留实例和已注册的 behavior/event，可被 startup() 恢复
        var _shutdown = false;
        function shutdown() {
            if (_shutdown) return;
            _shutdown = true;
            // 复位出场中标记：否则 shutdown 期间 appearing=true 滞留，
            // startup() 后点击/长按仍被 appearing 检查永久屏蔽
            _ctx.appearing = false;
            // 隐藏桌宠本体和所有 UI
            if (_container) _container.style.display = 'none';
            if (_bubble) _bubble.hideChatInput();
            if (_bubble) _bubble.hide(true);
            if (_historyPanel) _historyPanel.hide();
            _hideContextMenu();
            // 暂停所有运行时模块
            if (_sprites) _sprites.pause();
            if (_movement) _movement.pause();
            if (_sleepManager && typeof _sleepManager.pause === 'function') _sleepManager.pause();
            if (_idleAnnounce) _idleAnnounce.pause();
            if (_autoReply) _autoReply.pause();
            // 暂停 bridge 状态轮询：隐藏期间断线会 dispatch crashOverride 持有
            // behaviorLock，startup 后 idle 调度全部被锁死直到 bridge 恢复
            if (_bridgeCheckTimer) { clearInterval(_bridgeCheckTimer); _bridgeCheckTimer = null; }
            // 打断当前 behavior，避免 behaviorLock 卡住
            if (_behaviorRegistry && typeof _behaviorRegistry.interruptCurrent === 'function') {
                _behaviorRegistry.interruptCurrent();
            }
        }

        // 从 shutdown 状态恢复：恢复所有子模块运行时 + 显示 DOM
        function startup() {
            if (!_shutdown) return;
            _shutdown = false;
            if (_container) _container.style.display = '';
            if (_sprites) _sprites.resume();
            // 恢复 bridge 状态轮询（shutdown 时已暂停；内部自带防重与立即首检）
            _startBridgeCheck();
            // 关闭态启动时启动闸门跳过了 sleepManager.init：此处补 init。
            // init 在夜间会 emit pet:sleep 并播过入睡序列，下方睡眠分支不得再播一遍；
            // resume 兼两个目的——已 init 的恢复计时；刚 init 的清掉 shutdown 期间
            // pause() 置的 _paused（init 不重置它，留着会让用户交互不再重置入睡计时）
            var _sleepStartedByInit = false;
            if (_sleepManager) {
                if (!_sleepManagerInited) {
                    _startSleepManager();
                    _sleepStartedByInit = _ctx.inSleepMode;
                }
                if (typeof _sleepManager.resume === 'function') _sleepManager.resume();
            }
            // 恢复活动区域上下文：shutdown 先于出场动画完成时（showPet=false 启动路径），
            // _onAppearDone 未执行过，活动区域需在此初始化。
            _checkActivityZone();
            // shutdown 前处于睡眠态：保持睡眠序列（movement/idleAnnounce/autoReply 维持暂停，
            // 与 pet:sleep 处理一致），避免 inSleepMode=true 与 idle 动画并存
            // （idle 调度会被 inSleepMode 全部拦截，桌宠"假死"不动；点击还会播错乱的起床动画）
            if (_ctx.inSleepMode) {
                _ctx.petState = 'sleep';
                if (!_sleepStartedByInit) {
                    _sprites.play('sleepStart').then(function () {
                        if (_ctx.inSleepMode) _sprites.play('sleep');
                    });
                    _dispatchBehaviors('sleep');
                }
                return;
            }
            // 恢复模块运行时
            if (_movement) _movement.resume();
            if (_idleAnnounce) _idleAnnounce.resume();
            if (_autoReply && typeof _autoReply.onWake === 'function') _autoReply.onWake();
            // 切到 idle 动画并 emit idle:enter 重新调度
            if (_sprites) _sprites.play('idle');
            _ctx.petState = 'idle';
            _eventBus.emit('idle:enter');
        }

        // 面板卸载前统一 flush 桌宠各库防抖窗口（main.js beforeunload → petIndex.flush → 本函数）：
        // ① activityZone 的 bounds 防抖先经 _onSaveCallback 合入 settings（须在 settings.flush 前）；
        // ② settings/history/memory 三库 flush 优先 AEFS 同步原子写
        //    （writeFileSync→renameFileSync，Bridge 同步 XHR/cep.fs 原生同步调用，
        //    beforeunload 内可完成），同步通道不可用时各库自回落异步写（边界见各库 flush 注释）。
        // 不销毁任何子模块——beforeunload 可能被取消（用户取消关闭面板），模块须保持可用；
        // 显式卸载仍走 destroy()。返回值仅供诊断（false 含「同步未落盘/回落异步」），
        // 调用方不据此阻断卸载
        function flush() {
            var ok = true;
            try {
                if (_activityZone && typeof _activityZone.flush === 'function') _activityZone.flush();
            } catch (e) { ok = false; }
            var mods = [_settings, _history, _memory];
            for (var i = 0; i < mods.length; i++) {
                var m = mods[i];
                if (m && typeof m.flush === 'function') {
                    try { if (m.flush() === false) ok = false; } catch (e) { ok = false; }
                }
            }
            return ok;
        }

        function destroy() {
            if (_bridgeCheckTimer) { clearInterval(_bridgeCheckTimer); _bridgeCheckTimer = null; }
            if (_resizeHandler) window.removeEventListener('resize', _resizeHandler);
            if (_visibilityHandler) document.removeEventListener('visibilitychange', _visibilityHandler);
            // 隐藏可能残留的右键菜单 + 清理 resize 过渡定时器（与 shutdown 行为一致）
            _hideContextMenu();
            if (_resizeTransitionTimer) { clearTimeout(_resizeTransitionTimer); _resizeTransitionTimer = null; }
            // 清理所有子模块，避免 timer/event listener/DOM 泄漏
            // chat 先于 history/memory 销毁：销毁后飞行中的流式请求回调
            // 会因 chat.destroy 置位而丢弃结果，不再写入已销毁的 history
            if (_chat && typeof _chat.destroy === 'function') _chat.destroy();
            if (_idleAnnounce) _idleAnnounce.destroy();
            if (_autoReply) _autoReply.destroy();
            if (_historyPanel) _historyPanel.destroy();
            if (_dragHandler) _dragHandler.destroy();
            if (_sleepManager) _sleepManager.destroy();
            if (_bubble) _bubble.destroy();
            if (_movement) _movement.destroy();
            if (_sprites) _sprites.destroy();
            if (_history) _history.destroy();
            if (_memory) _memory.destroy();
            if (_webSearch && _webSearch.destroy) _webSearch.destroy();
            // activityZone 先于 settings 销毁：其 destroy 会 flush 防抖窗口内未落盘的
            // bounds 修改（经 _onSaveCallback 委托 settings 写盘），须在 settings 尚存活时
            // 执行，随后 settings.destroy 统一 flush 落盘，避免销毁后复活写盘定时器
            if (_activityZone && _activityZone.destroy) _activityZone.destroy();
            if (_settings) _settings.destroy();
            // behaviorRegistry 最后 destroy：清空注册表 + onInterrupt 清理当前 behavior
            // 避免 behavior Promise 回调访问已销毁的 _petApi/_ctx
            if (_behaviorRegistry && typeof _behaviorRegistry.destroy === 'function') {
                _behaviorRegistry.destroy();
            }
            if (_container && _container.parentNode) _container.parentNode.removeChild(_container);
            _eventBus.clear();
            // 清理全局引用（api 由 petIndex 挂载，一并清掉避免外部持有已销毁的控制面）
            global.AEDeepseekPet.settings = null;
            global.AEDeepseekPet.idleAnnounce = null;
            global.AEDeepseekPet.eventBus = null;
            global.AEDeepseekPet.api = null;
            global.AEDeepseekPet.controller = null;
        }

        return {
            init: init,
            getEventBus: function () { return _eventBus; },
            getCtx: function () { return _ctx; },
            getPetApi: getPetApi,
            executeTool: executeTool,
            // 由 petChat 在 LLM 回复中检测到 [action:xxx] 标识符时调用，触发对应动作动画
            triggerAction: triggerAction,
            show: show,
            hide: hide,
            shutdown: shutdown,
            startup: startup,
            isShutdown: function () { return _shutdown; },
            // 实时切换低性能模式（FPS 降级，GPU 预热不可逆故不处理）
            setLowPerfMode: function (enabled) {
                if (_sprites && typeof _sprites.setLowPerfMode === 'function') {
                    _sprites.setLowPerfMode(enabled);
                }
            },
            // 面板卸载前统一 flush 各库防抖窗口（main.js beforeunload → petIndex.flush）
            flush: flush,
            destroy: destroy,
            getBehaviorRegistry: function () { return _behaviorRegistry; },
            getActivityZone: function () { return _activityZone; },
            // 供 petSettings 在用户清除/重选活动区域后同步到 controller 上下文
            setActivityBounds: function (b) {
                _ctx.activityBounds = b;
                if (b) _clampToWindow();
            },
            // 供 petSettings 在用户调整桌宠大小后实时应用：更新 sprites + dragHandler + movement + activityZone + bubble
            // 并将当前 petPos 重新 clamp 到新的活动区域边界，避免桌宠溢出视口
            applyPetSize: function (size) {
                if (typeof size !== 'number' || size < 80 || size > 320) return;
                if (_sprites && typeof _sprites.setDisplaySize === 'function') {
                    _sprites.setDisplaySize(size, size);
                }
                if (_dragHandler && typeof _dragHandler.setPetSize === 'function') _dragHandler.setPetSize(size);
                if (_movement && typeof _movement.setPetSize === 'function') _movement.setPetSize(size);
                if (_activityZone && typeof _activityZone.setPetSize === 'function') _activityZone.setPetSize(size);
                // 同步气泡/聊天框 bottom（避免压在桌宠身上）
                if (_bubble && typeof _bubble.setPetSize === 'function') _bubble.setPetSize(size);
                // 重新 clamp 当前位置到视口内（用新尺寸）
                var maxX = window.innerWidth - size;
                var maxY = window.innerHeight - size;
                var newX = Math.max(0, Math.min(maxX, _ctx.petPos.x));
                var newY = Math.max(0, Math.min(maxY, _ctx.petPos.y));
                _ctx.petPos.x = newX;
                _ctx.petPos.y = newY;
                if (_container) {
                    _container.style.left = newX + 'px';
                    _container.style.top = newY + 'px';
                }
            },
            getSettings: function () { return _settings; }
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createController = createController;
})(window);
