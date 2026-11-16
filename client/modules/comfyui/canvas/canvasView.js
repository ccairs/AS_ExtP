(function (global) {
    // 缩放档位（spec：25% / 50% / 75% / 100% / 150% / 200%）
    var ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2];

    // 视口状态机（纯逻辑，便于单测；不碰 DOM）
    function createViewport() {
        var state = { x: 0, y: 0, scale: 1 };

        function panBy(dx, dy) {
            state.x += dx;
            state.y += dy;
        }

        // 以画布坐标 (cx, cy) 为锚点缩放到 targetScale，锚点屏幕坐标保持不变
        function zoomAt(targetScale, cx, cy) {
            var prevScale = state.scale;
            var sx = cx * prevScale + state.x;
            var sy = cy * prevScale + state.y;
            state.scale = targetScale;
            state.x = sx - cx * targetScale;
            state.y = sy - cy * targetScale;
        }

        function clampToStep(s) {
            var best = ZOOM_STEPS[0];
            var bestDist = Math.abs(s - best);
            for (var i = 1; i < ZOOM_STEPS.length; i++) {
                var d = Math.abs(s - ZOOM_STEPS[i]);
                if (d < bestDist) { best = ZOOM_STEPS[i]; bestDist = d; }
            }
            return best;
        }

        function zoomToClamped(s, cx, cy) {
            zoomAt(clampToStep(s), cx, cy);
        }

        function wheelZoom(delta, cx, cy) {
            // 放大找第一个大于当前值的档，缩小找最后一个小于当前值的档。
            // 若用"第一个大于当前值的档 - 1"定位：scale < 最小档（fitViewport 可缩到 0.1）
            // 时缩小操作会钳到 0 档反而放大；非档位值会跳档。
            var target = null;
            var i;
            if (delta > 0) {        // 缩小
                for (i = ZOOM_STEPS.length - 1; i >= 0; i--) {
                    if (ZOOM_STEPS[i] < state.scale - 1e-9) { target = ZOOM_STEPS[i]; break; }
                }
            } else {                // 放大
                for (i = 0; i < ZOOM_STEPS.length; i++) {
                    if (ZOOM_STEPS[i] > state.scale + 1e-9) { target = ZOOM_STEPS[i]; break; }
                }
            }
            if (target === null) return;   // 已到端点，保持不动
            zoomAt(target, cx, cy);
        }

        function toTransform() {
            return 'translate(' + state.x + 'px,' + state.y + 'px) scale(' + state.scale + ')';
        }

        return {
            panBy: panBy,
            zoomAt: zoomAt,
            zoomToClamped: zoomToClamped,
            wheelZoom: wheelZoom,
            toTransform: toTransform,
            setPan: function (x, y) { state.x = x; state.y = y; },
            get x() { return state.x; },
            get y() { return state.y; },
            get scale() { return state.scale; }
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createViewport = createViewport;

    function createCanvasView(canvasEl, worldEl) {
        var vp = createViewport();
        var panning = false;
        var lastX = 0;
        var lastY = 0;
        var spaceDown = false;
        var onTransformCb = null;

        function applyTransform() {
            worldEl.style.transform = vp.toTransform();
            // 网格背景跟随 pan/zoom：background-position 跟平移，background-size 跟缩放
            // 网格基础尺寸 24px / 120px，乘 scale 保持视觉格大小随缩放变化
            canvasEl.style.backgroundPosition = vp.x + 'px ' + vp.y + 'px';
            var s = vp.scale;
            canvasEl.style.backgroundSize =
                (24 * s) + 'px ' + (24 * s) + 'px, ' + (24 * s) + 'px ' + (24 * s) + 'px, ' +
                (120 * s) + 'px ' + (120 * s) + 'px, ' + (120 * s) + 'px ' + (120 * s) + 'px';
            if (onTransformCb) onTransformCb();
        }

        // pan：左键拖空白处 / 中键 / 空格+左键。
        // 点中节点/端口/连线 hit 线时不 pan（各自处理），但空格按下时无视目标强制 pan。
        function onCanvasMouseDown(e) {
            if (e.button !== 0 && e.button !== 1) return;
            if (e.ctrlKey) return;  // Ctrl+拖拽留给框选，不 pan
            // 空格+左键 → 强制 pan（无视下方节点/端口/连线）
            if (e.button === 0 && spaceDown) {
                panning = true;
                lastX = e.clientX;
                lastY = e.clientY;
                canvasEl.classList.add('panning');
                e.preventDefault();
                return;
            }
            // 中键始终 pan（不管下面有没有节点），左键才检查避免跟节点拖拽/连线冲突
            if (e.button === 0) {
                var t = e.target;
                if (t && t.closest && (t.closest('.ng-node') || t.closest('.ng-port') || t.closest('.ng-gen-input-container') || t.classList.contains('ng-edge-hit'))) return;
            }
            panning = true;
            lastX = e.clientX;
            lastY = e.clientY;
            canvasEl.classList.add('panning');
            e.preventDefault();
        }
        canvasEl.addEventListener('mousedown', onCanvasMouseDown);

        function onMouseMove(e) {
            if (!panning) return;
            vp.panBy(e.clientX - lastX, e.clientY - lastY);
            lastX = e.clientX;
            lastY = e.clientY;
            applyTransform();
        }

        function onMouseUp() {
            panning = false;
            canvasEl.classList.remove('panning');
        }

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);

        // ── 空格键拖拽视口 ──
        function onKeyDown(e) {
            if (e.key === ' ' && !e.repeat) {
                if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT')) return;
                e.preventDefault();
                spaceDown = true;
                canvasEl.style.cursor = 'grab';
            }
        }
        function onKeyUp(e) {
            if (e.key === ' ') {
                spaceDown = false;
                if (!panning) canvasEl.style.cursor = '';
                if (panning) { panning = false; canvasEl.classList.remove('panning'); canvasEl.style.cursor = ''; }
            }
        }
        window.addEventListener('keydown', onKeyDown);
        window.addEventListener('keyup', onKeyUp);

        // zoom：滚轮逐档，以鼠标位置为锚点（屏幕坐标→世界坐标）
        // 若鼠标在可滚动容器内，放行原生滚动，不接管缩放
        function onWheel(e) {
            var el = e.target;
            while (el && el !== canvasEl) {
                var style = window.getComputedStyle(el);
                var ovY = style.overflowY;
                if (ovY === 'auto' || ovY === 'scroll') return;  // 可滚动区域内，不接管
                el = el.parentElement;
            }
            e.preventDefault();
            var rect = canvasEl.getBoundingClientRect();
            var sx = e.clientX - rect.left;
            var sy = e.clientY - rect.top;
            var wx = (sx - vp.x) / vp.scale;
            var wy = (sy - vp.y) / vp.scale;
            vp.wheelZoom(e.deltaY, wx, wy);
            applyTransform();
        }
        canvasEl.addEventListener('wheel', onWheel, { passive: false });

        applyTransform();
        return {
            viewport: vp,
            screenToWorld: function (sx, sy) {
                return { x: (sx - vp.x) / vp.scale, y: (sy - vp.y) / vp.scale };
            },
            applyTransform: applyTransform,
            onTransform: function (cb) { onTransformCb = cb; },
            destroy: function () {
                window.removeEventListener('mousemove', onMouseMove);
                window.removeEventListener('mouseup', onMouseUp);
                window.removeEventListener('keydown', onKeyDown);
                window.removeEventListener('keyup', onKeyUp);
                canvasEl.removeEventListener('mousedown', onCanvasMouseDown);
                canvasEl.removeEventListener('wheel', onWheel);
                panning = false;
                spaceDown = false;
            }
        };
    }

    global.AEComfyUI.createCanvasView = createCanvasView;
})(window);
