// petDragHandler.js - 拖拽/点击/长按交互判定 + 拖拽惯性旋转
(function (global) {
    'use strict';

    function createDragHandler(eventBus, container, spriteEl, ctx, sprites) {
        var _mousedownX = 0, _mousedownY = 0;
        var _mousedownTime = 0;
        var _isDragging = false;
        var _longpressFired = false;
        var _longpressTimer = null;
        // 交互进行中标志：mousedown 后置 true、mouseup 收尾后置 false，
        // 供 mousemove buttons 自愈与 window blur 强制收尾判定"是否有未收尾的按下"
        var _interactionActive = false;
        var _moveThreshold = 2;
        var _longpressThreshold = 600;
        var _longpressRingDelay = 200;
        var _petSize = 120;
        var _longpressRing = null;
        var _longpressRingShowTimer = null;
        // 抓取偏移：mousedown 时鼠标相对桌宠中心的位移，拖拽中保持，避免起拖跳变
        var _grabOffsetX = 0, _grabOffsetY = 0;

        // ── 透明像素穿透 ──
        // canvas 的命中区是整块矩形，而桌宠只占其中约三分之一像素。点透明区域
        // 不会触发桌宠交互（对），但事件被 canvas 吞掉后也不会传给下层元素——
        // 背后的按钮点不到（错）。
        // 做法：跟踪指针位置，指针落在**不透明**像素上时让 canvas 保持可命中
        // （桌宠保有拖拽/点击/右键与 pointer/grabbing 光标），落在透明像素上时把
        // canvas 的 pointer-events 置 none——之后的 mousedown/click/hover 与光标
        // 由浏览器原生穿透到下层元素。不合成重放事件：重放拿不到 focus 等默认行为，
        // 还要自己防双发。
        var _hitThrough = null;   // 上次下发给 canvas 的可命中态（null = 还没下发过）
        var _pointerX = null, _pointerY = null;   // 最近一次指针位置（未进入面板时为 null）
        var _pointerProbeTimer = null;
        // 补帧间隔：指针不动而桌宠在走/在播动画时，同一坐标的透明与否会翻转，
        // 只靠 mousemove 会停在旧状态（120ms 粒度对视觉与点击判定都无感）
        var _pointerProbeMs = 120;

        // === 惯性旋转状态 ===
        var _lastMoveX = 0, _lastMoveY = 0, _lastMoveTime = 0;
        var _currentRotation = 0;       // 当前旋转角度（deg）
        var _mouseVelX = 0;             // 鼠标水平速度（带衰减平滑，px/ms）
        var _dragRaf = null;            // 拖拽期间 RAF id（每帧更新旋转）
        var _inertiaRaf = null;         // 松手后惯性减速 RAF id
        var _maxRotation = 90;          // 最大倾斜角度（拖拽+惯性期间均 clamp 到 ±90°）
        var _velToRotation = 55;        // 鼠标速度 -> 旋转角度的转换系数
        var _mouseVelDecay = 0.85;      // 鼠标速度每帧衰减系数（不移动时趋向 0）
        var _rotSmoothing = 0.22;       // 旋转角度插值系数（越小越平滑）
        var _inertiaDecay = 0.94;       // 松手后惯性衰减系数

        function setPetSize(size) {
            _petSize = size || 120;
            // 读条 ring 的 bottom 跟随桌宠高度（CSS 默认 170px 按 160px 尺寸设计），
            // 避免 petSize 调整后读条悬空或压在桌宠身上
            if (_longpressRing) _longpressRing.style.bottom = (_petSize + 10) + 'px';
        }

        function _showLongpressRing() {
            if (_longpressRing || !container) return;
            var ring = document.createElement('div');
            ring.className = 'dspet-longpress-ring';
            // bottom 跟随当前桌宠尺寸（petSize + 10px 间隙），与气泡定位规则一致
            ring.style.bottom = (_petSize + 10) + 'px';
            // SVG 圆环：track 底圈 + progress 圈，progress 通过 stroke-dashoffset
            // 从满偏移（空）动画到 0（满），实现橙色填满整个圆圈的读条效果
            ring.innerHTML =
                '<svg viewBox="0 0 36 36">' +
                  '<circle class="dspet-ring-track" cx="18" cy="18" r="15.9" fill="none"/>' +
                  '<circle class="dspet-ring-progress" cx="18" cy="18" r="15.9" fill="none"/>' +
                '</svg>';
            container.appendChild(ring);
            _longpressRing = ring;
        }

        function _hideLongpressRing() {
            if (_longpressRing && _longpressRing.parentNode) {
                _longpressRing.parentNode.removeChild(_longpressRing);
            }
            _longpressRing = null;
            if (_longpressRingShowTimer) {
                clearTimeout(_longpressRingShowTimer);
                _longpressRingShowTimer = null;
            }
        }

        // 应用旋转到 sprite canvas
        function _applyRotation(angle) {
            if (spriteEl) {
                spriteEl.style.transform = 'rotate(' + angle.toFixed(2) + 'deg)';
            }
        }

        // 拖拽期间每帧更新旋转：鼠标速度 -> 目标角度 -> 平滑插值
        // 鼠标停下时 _mouseVelX 自动衰减到 0，目标角度归 0，桌宠平滑回正
        function _dragTick() {
            // 鼠标速度衰减（不移动时趋向 0）
            _mouseVelX *= _mouseVelDecay;
            // 目标旋转角度 = 速度 * 系数，限制在 ±_maxRotation
            var target = _mouseVelX * _velToRotation;
            if (target > _maxRotation) target = _maxRotation;
            if (target < -_maxRotation) target = -_maxRotation;
            // 平滑插值到目标角度
            _currentRotation += (target - _currentRotation) * _rotSmoothing;
            _applyRotation(_currentRotation);
            _dragRaf = requestAnimationFrame(_dragTick);
        }

        function _stopDragTick() {
            if (_dragRaf) {
                cancelAnimationFrame(_dragRaf);
                _dragRaf = null;
            }
        }

        // 松手后惯性减速：用最后的鼠标速度作为初始角速度，衰减到 0 后弹簧回正
        function _inertiaTick() {
            // 用 _currentRotation 和目标 0 之间的差做弹簧回正
            // 同时叠加惯性速度
            _currentRotation += (_mouseVelX * _velToRotation) * 0.3;
            // 惯性期间也限制在 ±_maxRotation，避免高速甩动超过最大角度
            if (_currentRotation > _maxRotation) _currentRotation = _maxRotation;
            if (_currentRotation < -_maxRotation) _currentRotation = -_maxRotation;
            _mouseVelX *= _inertiaDecay;
            // 弹簧拉向 0
            _currentRotation *= 0.88;
            if (Math.abs(_currentRotation) < 0.2 && Math.abs(_mouseVelX) < 0.001) {
                _currentRotation = 0;
                _applyRotation(0);
                _inertiaRaf = null;
                return;
            }
            _applyRotation(_currentRotation);
            _inertiaRaf = requestAnimationFrame(_inertiaTick);
        }

        function _stopInertia() {
            if (_inertiaRaf) {
                cancelAnimationFrame(_inertiaRaf);
                _inertiaRaf = null;
            }
        }

        function init() {
            if (!spriteEl) return;
            spriteEl.addEventListener('mousedown', _onMouseDown);
            spriteEl.addEventListener('touchstart', _onTouchStart, { passive: false });
            spriteEl.addEventListener('touchmove', _onTouchMove, { passive: false });
            spriteEl.addEventListener('touchend', _onTouchEnd);
            spriteEl.addEventListener('touchcancel', _onTouchEnd);
            spriteEl.addEventListener('contextmenu', _onContextMenu);
            // 窗口失焦时 mouseup 可能永久丢失（如系统弹窗抢焦点），挂 blur 兜底强制收尾
            window.addEventListener('blur', _onWindowBlur);
            // 透明像素穿透：指针位置变化即时判定 + 补帧兜底（指针不动时桌宠在动）。
            // 挂 window 而不是 document：拖拽/自愈用的 document move/up 监听是"按下才挂、
            // 收尾即摘"，两者混在同一张监听表里会互相干扰；指针跟踪要覆盖整面板，
            // window 与 document 等价（事件冒泡到 window）。
            window.addEventListener('mousemove', _onPointerMove, true);
            window.addEventListener('mouseout', _onPointerOut);
            // 降级环境（测试沙箱/精简单页）无 setInterval：退化为只在 mousemove 时判定
            if (typeof setInterval === 'function') {
                _pointerProbeTimer = setInterval(_syncHitThrough, _pointerProbeMs);
            }
        }

        // 与 mousedown 的命中判据同源（sprites.hitTest：矩形外 false、未加载时放行）
        function _isPetPixel(x, y) {
            if (sprites && typeof sprites.hitTest === 'function') return !!sprites.hitTest(x, y);
            return true;
        }

        // 指针未知（还没进过面板）或交互进行中 → 保持默认可命中：
        // 拖拽中切换会让 grabbing 光标闪烁，且此时事件已由 window/document 上的
        // move/up 监听承接，切换没有收益
        function _syncHitThrough() {
            if (!spriteEl || _interactionActive) return;
            var hit = (_pointerX === null) ? true : _isPetPixel(_pointerX, _pointerY);
            if (hit === _hitThrough) return;
            _hitThrough = hit;
            spriteEl.style.pointerEvents = hit ? '' : 'none';
        }

        function _onPointerMove(e) {
            _pointerX = e.clientX;
            _pointerY = e.clientY;
            _syncHitThrough();
        }

        // 指针移出面板（mouseout 且无 relatedTarget）：位置信息失效，
        // 恢复默认可命中（下次 mousemove 重新判定），不按陈旧坐标长期禁用桌宠
        function _onPointerOut(e) {
            if (e && e.relatedTarget) return;   // 面板内部元素之间的移动，不算离开
            _pointerX = null;
            _pointerY = null;
            _syncHitThrough();
        }

        function _onContextMenu(e) {
            e.preventDefault();
            if (ctx.appearing || _isDragging) return;
            eventBus.emit('pet:contextmenu', { x: e.clientX, y: e.clientY });
        }

        function _onTouchStart(e) {
            if (e.touches.length > 0) {
                e.preventDefault();
                _onMouseDown({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY, preventDefault: function() {} });
            }
        }

        function _onTouchMove(e) {
            if (e.touches.length > 0) {
                e.preventDefault();
                _onMouseMove({ clientX: e.touches[0].clientX, clientY: e.touches[0].clientY });
            }
        }

        function _onTouchEnd(e) {
            var t = (e.changedTouches && e.changedTouches[0]) || {};
            _onMouseUp({ clientX: t.clientX || 0, clientY: t.clientY || 0 });
        }

        function _onMouseDown(e) {
            if (ctx.appearing) return;
            // e.button: 0=左键, undefined=touch 事件模拟（_onTouchStart 传的对象无 button 字段）
            // touch 事件应放行；非左键鼠标点击拒绝
            if (e.button !== 0 && e.button !== undefined) return;
            // 像素级透明度命中检测：点击桌宠透明区域（如四周留白）不触发交互。
            // 与穿透判定同源（_isPetPixel）——透明区在正常情况下已由 canvas 的
            // pointer-events:none 让给下层元素，这里是兜底（指针态尚未判定的首次点击）
            if (!_isPetPixel(e.clientX, e.clientY)) {
                return;  // 命中透明像素，忽略本次 mousedown
            }
            // 多指触摸会连续触发 _onMouseDown：先清上一轮未触发的长按定时器，
            // 避免句柄被直接覆盖泄漏、longpress:pet 双发
            _cancelLongpress();
            _hideLongpressRing();
            _mousedownX = e.clientX;
            _mousedownY = e.clientY;
            _mousedownTime = Date.now();
            _isDragging = false;
            _longpressFired = false;
            ctx.lastActiveTime = Date.now();

            // 记录抓取偏移：hitTest 可命中精灵任意不透明像素（如脚部），
            // 拖拽中保持鼠标相对桌宠中心的偏移，避免起拖瞬间桌宠跳变到鼠标中心
            _grabOffsetX = e.clientX - (ctx.petPos.x + _petSize / 2);
            _grabOffsetY = e.clientY - (ctx.petPos.y + _petSize / 2);

            // 初始化惯性旋转追踪
            _lastMoveX = e.clientX;
            _lastMoveY = e.clientY;
            _lastMoveTime = Date.now();
            _mouseVelX = 0;
            _stopInertia();  // 停止之前的惯性

            // 延迟显示读条 ring：避免快速点击也出现转圈
            _longpressRingShowTimer = setTimeout(function () {
                if (!_isDragging && !_longpressFired) {
                    _showLongpressRing();
                }
            }, _longpressRingDelay);

            _longpressTimer = setTimeout(function () {
                if (!_isDragging) {
                    _cancelLongpress();
                    _hideLongpressRing();
                    _longpressFired = true;
                    eventBus.emit('longpress:pet');
                }
            }, _longpressThreshold);

            _interactionActive = true;
            document.addEventListener('mousemove', _onMouseMove);
            document.addEventListener('mouseup', _onMouseUp);
        }

        function _onMouseMove(e) {
            if (_longpressFired) return;

            // 自愈：mouseup 在面板窗口外丢失（如拖出面板边界后松开）时，
            // 后续 mousemove 的 buttons 已无左键——视为丢失的 mouseup 走同一收尾路径，
            // 否则 drag:end 永不发、ctx.isDragging 永久残留，行为链假死
            // （含未起拖/长按未触发的按下态；touch 转发的 mousemove 无 buttons 字段，
            //  undefined 视为未知不触发自愈）
            if (_interactionActive && e.buttons !== undefined && (e.buttons & 1) === 0) {
                _onMouseUp(e);
                return;
            }

            var dx = e.clientX - _mousedownX;
            var dy = e.clientY - _mousedownY;
            var dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > _moveThreshold && !_isDragging) {
                _isDragging = true;
                _cancelLongpress();
                _hideLongpressRing();
                // 拖拽视觉反馈：grabbing 光标（配合 pet.css 的 .dspet-sprite.dragging）
                if (spriteEl) spriteEl.classList.add('dragging');
                ctx.dragPhase = 'start';
                eventBus.emit('drag:start');
                // 启动拖拽 RAF 循环：每帧根据鼠标速度更新旋转
                _stopDragTick();
                _dragRaf = requestAnimationFrame(_dragTick);
            }

            if (_isDragging) {
                ctx.dragPhase = 'move';

                // 更新鼠标水平速度（带平滑），旋转由 _dragTick RAF 每帧计算
                var now = Date.now();
                var dt = now - _lastMoveTime;
                if (dt > 0) {
                    var moveDx = e.clientX - _lastMoveX;
                    var instVel = moveDx / dt;  // 瞬时速度 px/ms
                    // 指数平滑：新速度 = 旧速度 * 0.4 + 瞬时速度 * 0.6
                    _mouseVelX = _mouseVelX * 0.4 + instVel * 0.6;
                }
                _lastMoveX = e.clientX;
                _lastMoveY = e.clientY;
                _lastMoveTime = now;

                // 位置更新：扣除抓取偏移，桌宠跟随鼠标的相对位置而非强制中心对齐
                var half = _petSize / 2;
                var newX = e.clientX - half - _grabOffsetX;
                var newY = e.clientY - half - _grabOffsetY;
                var clamped = _clampToZone(newX, newY);
                ctx.petPos.x = clamped.x;
                ctx.petPos.y = clamped.y;
                container.style.left = Math.round(clamped.x) + 'px';
                container.style.top = Math.round(clamped.y) + 'px';
            }
        }

        function _clampToZone(x, y) {
            var bounds = ctx.activityBounds;
            var maxX, maxY, minX, minY;
            if (bounds) {
                minX = bounds.x;
                minY = bounds.y;
                maxX = bounds.x + Math.max(0, bounds.w - _petSize);
                maxY = bounds.y + Math.max(0, bounds.h - _petSize);
            } else {
                minX = 0;
                minY = 0;
                maxX = window.innerWidth - _petSize;
                maxY = window.innerHeight - _petSize;
            }
            if (x < minX) x = minX;
            if (y < minY) y = minY;
            if (x > maxX) x = maxX;
            if (y > maxY) y = maxY;
            return { x: x, y: y };
        }

        function _onMouseUp(e) {
            _cancelLongpress();
            _hideLongpressRing();
            document.removeEventListener('mousemove', _onMouseMove);
            document.removeEventListener('mouseup', _onMouseUp);
            // 移除拖拽视觉反馈
            if (spriteEl) spriteEl.classList.remove('dragging');

            var elapsed = Date.now() - _mousedownTime;

            if (_isDragging) {
                ctx.dragPhase = 'end';
                eventBus.emit('drag:end');
                ctx.dragPhase = null;
                // 停止拖拽 RAF，启动松手惯性（用最后的鼠标速度）
                _stopDragTick();
                _stopInertia();
                if (Math.abs(_mouseVelX) > 0.002) {
                    _inertiaRaf = requestAnimationFrame(_inertiaTick);
                } else {
                    // 速度太小直接回正
                    _currentRotation = 0;
                    _applyRotation(0);
                }
            } else if (elapsed < _longpressThreshold && !_longpressFired) {
                eventBus.emit('click:pet', { x: e.clientX, y: e.clientY });
            }
            _isDragging = false;
            _longpressFired = false;
            _interactionActive = false;
            // 交互结束：按指针当前位置重算穿透态（拖拽期间被 _interactionActive 冻结）
            _syncHitThrough();
        }

        // 窗口失焦（如系统弹窗/切换应用抢焦点）时 mouseup 可能永久丢失：
        // 交互进行中则强制走 _onMouseUp 收尾，避免 isDragging 残留导致行为链假死
        function _onWindowBlur() {
            if (!_interactionActive) return;
            _onMouseUp({ clientX: _lastMoveX, clientY: _lastMoveY });
        }

        function _cancelLongpress() {
            if (_longpressTimer) { clearTimeout(_longpressTimer); _longpressTimer = null; }
        }

        function destroy() {
            _cancelLongpress();
            _hideLongpressRing();
            _stopDragTick();
            _stopInertia();
            // 透明像素穿透：摘监听、停补帧、把 canvas 恢复成默认可命中
            window.removeEventListener('mousemove', _onPointerMove, true);
            window.removeEventListener('mouseout', _onPointerOut);
            if (_pointerProbeTimer && typeof clearInterval === 'function') {
                clearInterval(_pointerProbeTimer);
                _pointerProbeTimer = null;
            }
            _pointerX = null;
            _pointerY = null;
            _hitThrough = null;
            if (spriteEl) spriteEl.style.pointerEvents = '';
            if (spriteEl) {
                spriteEl.removeEventListener('mousedown', _onMouseDown);
                spriteEl.removeEventListener('touchstart', _onTouchStart);
                spriteEl.removeEventListener('touchmove', _onTouchMove);
                spriteEl.removeEventListener('touchend', _onTouchEnd);
                spriteEl.removeEventListener('touchcancel', _onTouchEnd);
                spriteEl.removeEventListener('contextmenu', _onContextMenu);
                spriteEl.style.transform = '';
            }
            document.removeEventListener('mousemove', _onMouseMove);
            document.removeEventListener('mouseup', _onMouseUp);
            window.removeEventListener('blur', _onWindowBlur);
            if (spriteEl) {
                spriteEl.classList.remove('dragging');
                spriteEl.classList.remove('sleeping');
            }
        }

        return { init: init, setPetSize: setPetSize, destroy: destroy };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createDragHandler = createDragHandler;
})(window);
