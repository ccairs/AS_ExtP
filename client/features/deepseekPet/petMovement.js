// petMovement.js — 随机漫游状态机，requestAnimationFrame 驱动
(function (global) {
    'use strict';

    function createMovement(eventBus, container, ctx) {
        var _state = 'idle';
        var _targetX = 0;
        var _rafId = null;
        var _idleTimer = null;
        var _moveToInterval = null;  // moveTo 的轮询句柄，destroy 时清理
        var _moveToResolve = null;   // moveTo Promise 的 resolve，destroy 时调用避免悬挂
        var _petSize = 120;  // 默认尺寸，由 controller 注入
        var _paused = false;
        var _speed = 1.5;
        // 单次走动视为"太短看不出在走"的阈值（px）：仅用于边界夹紧后的反向判断
        var MIN_WALK_DIST = 40;
        // 走动三阶段时间表（与序列帧结构对齐，24fps 帧数换算；单位 ms）
        //   delay 起手不位移 / uniform 匀速位移 / decel 线性减速位移 / stationary 站定不位移
        // 位移预算 _maxWalkDist 与 _setState('walk') 共用此表 —— 两处各写一份数字曾漂移出
        // "走完预算才停下、动画还在播"的现象（调用方给的远点超出序列帧能走的距离）
        var _WALK_TIMING = {
            left:  { delay: 1300, uniform: 1610, decel: 1170, stationary: 500 },  // walkLeft  110 帧 ≈ 4.58s
            right: { delay: 200,  uniform: 2420, decel: 1020, stationary: 400 }   // walkRight  97 帧 ≈ 4.04s
        };
        // 行走三阶段时间表（与序列帧结构对齐）：
        // phase1: 起手（_walkDelay 秒）— 不位移，让序列帧起手动画播完
        // phase2: 匀速（_walkDuration 秒）— 以 _speed 位移
        // phase3: 停下（_stopDuration 秒）— 速度从 _speed 线性缓动到 0
        // 序列帧总长 = _walkDelay + _walkDuration + _stopDuration，单次播放完毕桌宠完全停下
        var _walkStartTime = 0;
        var _walkDelay = 0;
        var _walkDuration = 0;
        var _stopDuration = 0;
        var _stationaryDuration = 0;  // _stopDuration 最后阶段不位移，让桌宠站定播放停下动作
        // 左/右行走提前停止位移的时间（用户对左右停止时机的差异化需求）
        // walkLeft 提前 0.5s 停止位移（保持缓动），walkRight 提前 0.4s 停止位移（保持缓动）
        var _totalWalkTime = 0;  // = _walkDelay + _walkDuration + _stopDuration
        // 走动方向：'left' / 'right'
        var _walkDirection = 'right';
        // pause 时记录的 walk 剩余时长，resume 时据此调整 _walkStartTime 接续 walk
        var _pausedWalkRemaining = 0;
        // 本次 walk 是否已到达目标点：到达后停止位移（动画继续播完，由 anim:done 切 idle）
        var _reachedTarget = false;

        function setPetSize(size) { _petSize = size || 120; }

        function init() {
            _scheduleIdle();
            _startLoop();
            // 拖拽开始时主动 settle moveTo Promise 并切 idle
            // 否则 idleWander 的 moveTo 永不 resolve → behaviorLock 卡死
            // 后续 click/longpress/drag 事件全被 _dispatchBehaviors 的 behaviorLock 拦截
            eventBus.on('drag:start', _onDragStart);
            // 监听 idle:enter 重新调度走动：drag:end 后 _finishBehavior emit idle:enter，
            // 此时 isDragging=false，_scheduleIdle 可正常调度
            eventBus.on('idle:enter', _onIdleEnter);
            // 监听序列帧 anim:done：walkLeft/walkRight (loop:false) 播完后切 idle
            // 若用 _totalWalkTime 主动切 idle 会打断序列帧的结束动画（play('idle') 覆盖了 walkLeft/walkRight）
            eventBus.on('anim:done', _onAnimDone);
        }

        function _onAnimDone(data) {
            var state = data && data.state;
            // 只处理 walkLeft/walkRight 的 anim:done，其他 state 由 controller 处理
            if (state === 'walkLeft' || state === 'walkRight') {
                if (_state === 'walk') {
                    _setState('idle');
                    _scheduleIdle();
                    // resolve 挂起的 moveTo Promise（若有）
                    if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
                    if (_moveToResolve) { _moveToResolve(); _moveToResolve = null; }
                }
            }
        }

        function _onDragStart() {
            if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
            if (_moveToResolve) { _moveToResolve(); _moveToResolve = null; }
            _state = 'idle';  // 直接改状态，不 emit idle:enter（避免触发新一轮 idle 调度）
        }

        function _onIdleEnter() {
            // 同步状态并重新调度走动；_scheduleIdle 内部会检查 isDragging，
            // 拖拽期间不会调度，drag:end 后才会真正调度
            _state = 'idle';
            _scheduleIdle();
        }

        function _scheduleIdle() {
            if (_idleTimer) clearTimeout(_idleTimer);
            // 拖拽期间不调度走动，drag:end 后由 _onIdleEnter 重新调度
            if (ctx.isDragging) return;
            // idle 为主：5-12 秒触发一次 idle 行为，避免桌宠频繁动作影响观感
            var delay = 5000 + Math.random() * 7000;
            _idleTimer = setTimeout(function () {
                // appearing 期间不触发（appear 动画未结束时桌宠贴底部，动作会穿帮）
                // behaviorLock 期间不触发：crashOverride 等系统 behavior 运行时不插入 idle 动作
                // paused（shutdown/面板隐藏/睡眠）期间不触发：pause 已清 _idleTimer，此处兜底
                // （shutdown 走 pause 的 settle 链可能异步补挂新 timer，见 _onIdleEnter）
                if (_state === 'idle' && !_paused && !ctx.isDragging && !ctx.inSleepMode && !ctx.appearing && !ctx.behaviorLock) {
                    // 不直接 _setState('walk')，而是 emit 'idle:tick' 让 controller dispatch idle behaviors
                    // 这样三个 idle 行为（idleStretch / idlePotHead / idleEat 各按自身概率掷骰）
                    // 与 idleWander 按优先级竞争，都没命中才走动
                    // idle:enter 仍不 dispatch，避免"桌宠频繁走动"bug
                    eventBus.emit('idle:tick');
                }
                // 若条件不满足（如 appear 期间），不重新调度；
                // appear 结束后 controller emit idle:enter 会触发 _onIdleEnter 重新调度
            }, delay);
        }

        function _pickRandomTarget() {
            var bounds = ctx.activityBounds;
            var baseX = ctx.petPos.x;
            var minX, maxX;
            if (bounds) {
                minX = bounds.x;
                maxX = bounds.x + Math.max(0, bounds.w - _petSize);
            } else {
                minX = 0;
                maxX = window.innerWidth - _petSize;
            }

            // 先随机选方向，再在该方向的位移预算内随机一个目标距离
            // 距离取预算的 80%~100%：序列帧的位移就发生在"匀速 + 减速"两段，距离小于预算
            // 就会提前到达、站着把剩下的动画播完（用户报过"走到一半停下、序列帧还在播"）
            var goLeft = Math.random() < 0.5;
            var maxDist = _maxWalkDist(goLeft ? 'left' : 'right');
            var dist = maxDist * (0.8 + Math.random() * 0.2);
            var targetX = goLeft ? baseX - dist : baseX + dist;

            // 超出 bounds 时夹紧到边界（若夹紧后距离太短则反向）
            if (targetX < minX) {
                targetX = minX;
                if (Math.abs(targetX - baseX) < MIN_WALK_DIST) {
                    targetX = Math.min(maxX, baseX + dist);  // 反向走
                }
            } else if (targetX > maxX) {
                targetX = maxX;
                if (Math.abs(targetX - baseX) < MIN_WALK_DIST) {
                    targetX = Math.max(minX, baseX - dist);  // 反向走
                }
            }
            _targetX = targetX;
        }

        // 随机散步一次：目标点由本模块按位移预算选取，调用方不要自己算坐标
        // （给超出预算的远点 → 走完预算就停下、序列帧还在播；给过近的点 → 几乎原地播完）
        function wander() {
            _pickRandomTarget();
            return moveTo(_targetX);
        }

        // 单次走动位移预算（px）：匀速段全速 + 减速段平均速度（_speed/2）
        // _speed=1.5/tick、30fps 限帧 → 匀速 45px/s、减速 22.5px/s
        //   left : 1.61s*45 + 1.17s*22.5 ≈ 98px
        //   right: 2.42s*45 + 1.02s*22.5 ≈ 132px
        function _maxWalkDist(direction) {
            var t = _WALK_TIMING[direction] || _WALK_TIMING.right;
            return (t.uniform * _speed * 30 + t.decel * _speed * 15) / 1000;
        }

        function _setState(state) {
            _state = state;
            ctx.petState = state;
            if (state === 'idle') {
                eventBus.emit('idle:enter');
            } else if (state === 'walk') {
                _reachedTarget = false;
                // 根据方向设置三阶段时间表，与序列帧结构对齐
                // phase1: 起手延迟（不位移）
                // phase2: 匀速位移
                // phase3: 缓动到停止（前半段线性减速到 0.3/tick，后段完全停止播放站定动作）
                //   - phase3 总时长 = _stopDuration - _stationaryDuration（前 0.25s 不位移播放站定动作）
                //   - phase3 前段线性减速持续 _stopDuration - 250ms
                _walkDirection = _targetX < ctx.petPos.x ? 'left' : 'right';
                var _t = _WALK_TIMING[_walkDirection];
                _walkDelay = _t.delay;
                _walkDuration = _t.uniform;
                _stopDuration = _t.decel + _t.stationary;
                _stationaryDuration = _t.stationary;
                _totalWalkTime = _t.delay + _t.uniform + _t.decel + _t.stationary;
                _walkStartTime = Date.now();
                // 携带 targetX/currentX 让 controller 选择 walkRight/walkLeft
                eventBus.emit('walk:enter', {
                    targetX: _targetX,
                    currentX: ctx.petPos.x
                });
            }
        }

        var _FRAME_INTERVAL = 1000 / 30;  // 全域锁 30fps
        var _lastTickTime = 0;

        function _startLoop() {
            if (_rafId) cancelAnimationFrame(_rafId);
            _lastTickTime = 0;
            _rafId = requestAnimationFrame(_tick);
        }

        function _tick(timestamp) {
            if (_paused) { _rafId = null; return; }
            // 30fps 限帧：跳过过早的帧
            if (_lastTickTime && timestamp - _lastTickTime < _FRAME_INTERVAL) {
                _rafId = requestAnimationFrame(_tick);
                return;
            }
            _lastTickTime = timestamp;

            if (_state === 'walk' && !ctx.isDragging && !ctx.inSleepMode) {
                var elapsed = Date.now() - _walkStartTime;
                var dir = _walkDirection === 'left' ? -1 : 1;
                // phase3 总时长 = _stopDuration
                // phase3 前段（_stopDuration - _stationaryDuration）= 线性减速位移
                // phase3 后段（_stationaryDuration）= 不位移，桌宠站定播放序列帧的停下动作
                var phase3DecelDuration = _stopDuration - _stationaryDuration;
                var walkEnd = _walkDelay + _walkDuration;
                if (elapsed < _walkDelay) {
                    // phase1: 起手阶段，不位移，等序列帧起手动画播完
                } else if (!_reachedTarget) {
                    // phase2/phase3 位移：到达目标后停止位移（_reachedTarget），
                    // 动画继续播完由 anim:done 切 idle，避免越过 targetX 和活动边界
                    var step;
                    if (elapsed < walkEnd) {
                        // phase2: 匀速位移阶段
                        step = _speed;
                    } else if (elapsed < walkEnd + phase3DecelDuration) {
                        // phase3 前段：速度从 _speed 线性缓动到 0
                        // 与序列帧的停下动作前段同步，桌宠逐步减速直到接近停止
                        var stopElapsed = elapsed - walkEnd;
                        var speedRatio = 1 - (stopElapsed / phase3DecelDuration);  // 1 → 0
                        if (speedRatio < 0) speedRatio = 0;
                        step = _speed * speedRatio;
                        // 至少保持 0.3px/tick 的最小速度，避免减速过快卡住
                        if (step < 0.3 && speedRatio > 0) step = 0.3;
                    } else {
                        // phase3 后段：不位移，让桌宠站定播放停下动作
                        step = 0;
                    }
                    if (step > 0) {
                        // 沿行走方向剩余距离：本帧会到达/越过目标时 clamp 到目标并停止后续位移
                        // （无停止逻辑时实际位移由动画时长决定，常越过目标点甚至活动边界）
                        var remaining = (_targetX - ctx.petPos.x) * dir;
                        if (remaining <= step) {
                            ctx.petPos.x = _targetX;
                            _reachedTarget = true;
                        } else {
                            ctx.petPos.x += dir * step;
                        }
                    }
                }
                // phase3 后段（elapsed >= walkEnd + phase3DecelDuration）：不位移，让桌宠站定播放停下动作
                // 不主动切 idle：等序列帧播完触发 anim:done 由 _onAnimDone 切 idle，
                // 否则 play('idle') 会覆盖 walkLeft/walkRight 的结束动画
                _updateContainerPos();
            }
            _rafId = requestAnimationFrame(_tick);
        }

        function _updateContainerPos() {
            if (container) {
                container.style.left = Math.round(ctx.petPos.x) + 'px';
                container.style.top = Math.round(ctx.petPos.y) + 'px';
            }
        }

        function moveTo(x, y) {
            return new Promise(function (resolve) {
                // 清理上一次未完成的轮询句柄，避免多个 interval 并发
                if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
                // 若上一 Promise 还未 resolve，先 resolve 掉避免悬挂
                if (_moveToResolve) { _moveToResolve(); _moveToResolve = null; }
                // 只走 x 轴，y 忽略
                _targetX = x;
                _setState('walk');
                _moveToResolve = resolve;
                _moveToInterval = setInterval(function () {
                    if (_state === 'idle') {
                        if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
                        _moveToResolve = null;
                        resolve();
                    }
                }, 100);
            });
        }

        function setState(state) { _setState(state); }
        function getState() { return _state; }

        // 用户点击/长按时调用：取消挂起的 idle 调度 + 停止当前 walk 位移
        // 否则会出现两个问题：
        //   1) _idleTimer 到期时检查 _state==='idle' 成立（click 期间没人改 movement._state）
        //      → 触发新一轮 walk → emit walk:enter → play('walkLeft') 覆盖 click 动画
        //   2) 走动期间被点击：_tick 仍按 walk 三阶段位移，桌宠在 click 动画播放时继续飘移
        // 不 emit idle:enter（避免触发新一轮调度），由 click behavior 的 _finishBehavior
        // emit idle:enter 后 _onIdleEnter → _scheduleIdle 重新调度
        function interruptWalk() {
            if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
            if (_state === 'walk') {
                _state = 'idle';
                if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
                if (_moveToResolve) { _moveToResolve(); _moveToResolve = null; }
            }
        }

        function pause() {
            _paused = true;
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            // 暂停时清掉挂起的 idle 调度：否则 shutdown/面板隐藏期间 _idleTimer 到期会
            // emit idle:tick → idleWander → moveTo 的 setInterval 永不退出
            // （sprites 已 pause，anim:done 不触发，_state 回不到 idle），每 100ms 空转
            if (_idleTimer) { clearTimeout(_idleTimer); _idleTimer = null; }
            // 暂停时若 moveTo 进行中，主动 settle 其 Promise，避免睡眠期间永久悬挂
            // （唤醒后若需继续漫游，由 _scheduleIdle 重新调度）
            if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
            if (_moveToResolve) { _moveToResolve(); _moveToResolve = null; }
            // 记录 pause 时的剩余 walk 时间，resume 时据此调整 _walkStartTime
            // 避免 pause 期间的真实时间被计入 elapsed，导致 walk 阶段计算错乱（瞬间跳到 phase3 末段）
            if (_state === 'walk') {
                var elapsed = Date.now() - _walkStartTime;
                _pausedWalkRemaining = Math.max(0, _totalWalkTime - elapsed);
            }
        }
        function resume() {
            _paused = false;
            // 若 pause 前在 walk 状态，调整 _walkStartTime 让 resume 后的 elapsed 接续 pause 前
            // 否则 elapsed 会包含 pause 时长（可能数分钟），_tick 瞬间判定 walk 已结束
            if (_state === 'walk' && _pausedWalkRemaining > 0) {
                _walkStartTime = Date.now() - (_totalWalkTime - _pausedWalkRemaining);
            }
            _pausedWalkRemaining = 0;
            _startLoop();
            // pause 清了 _idleTimer，resume 需重新调度 idle：否则面板隐藏再显示
            // （visibilitychange 只调 pause/resume，不 emit idle:enter）后桌宠永不再走动
            _scheduleIdle();
        }

        function destroy() {
            // 注销 eventBus 监听器，避免销毁后幽灵事件和定时器
            eventBus.off('drag:start', _onDragStart);
            eventBus.off('idle:enter', _onIdleEnter);
            eventBus.off('anim:done', _onAnimDone);
            if (_rafId) cancelAnimationFrame(_rafId);
            if (_idleTimer) clearTimeout(_idleTimer);
            if (_moveToInterval) { clearInterval(_moveToInterval); _moveToInterval = null; }
            // 主动 resolve 挂起的 moveTo Promise，避免调用方永久 await
            if (_moveToResolve) { _moveToResolve(); _moveToResolve = null; }
            _rafId = null;
            _idleTimer = null;
        }

        return {
            init: init,
            setPetSize: setPetSize,
            moveTo: moveTo,
            wander: wander,
            setState: setState,
            getState: getState,
            pause: pause,
            resume: resume,
            interruptWalk: interruptWalk,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createMovement = createMovement;
})(window);
