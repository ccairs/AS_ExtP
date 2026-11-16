(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};

    // 裁剪框规整
    function cropRect(x1, y1, x2, y2, cw, ch) {
        var x = Math.min(x1, x2), y = Math.min(y1, y2);
        var w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        if (x < 0) { w += x; x = 0; }
        if (y < 0) { h += y; y = 0; }
        if (x + w > cw) w = cw - x;
        if (y + h > ch) h = ch - y;
        if (w < 0) w = 0; if (h < 0) h = 0;
        return { x: x, y: y, w: w, h: h };
    }

    function colorFilter(brightness, contrast, saturation) {
        var parts = [];
        if (brightness !== 100) parts.push('brightness(' + (brightness / 100) + ')');
        if (contrast !== 100) parts.push('contrast(' + (contrast / 100) + ')');
        if (saturation !== 100) parts.push('saturate(' + (saturation / 100) + ')');
        return parts.length ? parts.join(' ') : 'none';
    }

    global.AEComfyUI.cropRect = cropRect;
    global.AEComfyUI.colorFilter = colorFilter;

    function loadImg(src) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            img.onload = function () { resolve(img); };
            img.onerror = function () { reject(new Error('图片加载失败: ' + src)); };
            img.src = src;
        });
    }
    function canvasToBlob(canvas, mime) {
        return new Promise(function (resolve, reject) {
            if (canvas.toBlob) {
                canvas.toBlob(resolve, mime);
            } else {
                var dataUrl = canvas.toDataURL(mime);
                var b64 = dataUrl.split(',')[1];
                var raw = atob(b64);
                var parts = [new Uint8Array(raw.length)];
                for (var i = 0; i < raw.length; i++) parts[0][i] = raw.charCodeAt(i);
                resolve(new Blob(parts, { type: mime }));
            }
        });
    }

    var MAX_CANVAS = 4096;
    var MAX_UNDO = 50;
    // 撤销快照是全尺寸 canvas（w*h*4 字节/张），固定 50 步在 4096² 大图下
    // ≈ 50×67MB = 3.3GB，多笔编辑即渲染进程 OOM。按当前像素面积动态下调步数：
    // 约 256MB 内存预算内取最多步数（≤1.3MP 小图仍 50 步不变），下限 5 步保证大图留有撤销余地。
    // 尺寸变化（裁剪/变换/换图）时 undoStack 会整体重置，栈内快照尺寸一致，按当前尺寸算容量即准确。
    var UNDO_MEM_BUDGET = 256 * 1024 * 1024;
    function maxUndoFor(w, h) {
        var px = (w | 0) * (h | 0);
        if (px <= 0) return MAX_UNDO;
        var steps = Math.floor(UNDO_MEM_BUDGET / (px * 4));
        return Math.max(5, Math.min(MAX_UNDO, steps));
    }

    function createImageEditor(opts) {
        opts = opts || {};
        var imagePath = opts.imagePath, outputDir = opts.outputDir, aeIO = opts.aeIO;
        var onSave = opts.onSave || function () {};
        var onClose = opts.onClose || function () {};

        // ── 模态 DOM ──
        var mask = document.createElement('div');
        mask.className = 'ng-edit-mask';
        mask.innerHTML =
            '<div class="ng-edit-modal">' +
              '<div class="ng-edit-head">' +
                AEI18n.html('<span class="ng-edit-title">图片编辑</span>') +
                AEI18n.html('<span class="ng-edit-close" title="关闭">✕</span>') +
              '</div>' +
              '<div class="ng-edit-body">' +
                '<div class="ng-edit-canvas-wrap"><div class="ng-edit-canvas-inner"><canvas class="ng-edit-canvas"></canvas></div></div>' +
                '<div class="ng-edit-tools">' +
                  '<div class="ng-edit-tool-row">' +
                    AEI18n.html('<button class="btn ng-edit-tool active" data-tool="brush">画笔</button>') +
                    AEI18n.html('<button class="btn ng-edit-tool" data-tool="eraser">橡皮</button>') +
                    AEI18n.html('<button class="btn ng-edit-tool" data-tool="crop">裁剪</button>') +
                    AEI18n.html('<button class="btn ng-edit-tool" data-tool="transform">自由变换</button>') +
                  '</div>' +
                  '<div class="ng-edit-prop">' +
                    AEI18n.html('<label>粗细 <span class="ng-edit-size-val">8px</span><input type="range" class="ng-edit-size" min="1" max="60" value="8"></label>') +
                    AEI18n.html('<label>颜色 <input type="color" class="ng-edit-color" value="#fbbf24"></label>') +
                  '</div>' +
                  '<div class="ng-edit-prop">' +
                    AEI18n.html('<label>亮度 <input type="range" class="ng-edit-bright" min="0" max="200" value="100"></label>') +
                    AEI18n.html('<label>对比 <input type="range" class="ng-edit-contrast" min="0" max="200" value="100"></label>') +
                    AEI18n.html('<label>饱和 <input type="range" class="ng-edit-sat" min="0" max="200" value="100"></label>') +
                  '</div>' +
                  '<div class="ng-edit-prop">' +
                    AEI18n.html('<label>视口缩放 <span class="ng-edit-vp-zoom-val">100%</span><input type="range" class="ng-edit-vp-zoom" min="10" max="400" value="100"></label>') +
                    AEI18n.html('<button class="btn ng-edit-vp-reset" style="margin-top:2px;">重置视口</button>') +
                  '</div>' +
                  '<div class="ng-edit-tool-row ng-edit-xform-row">' +
                    AEI18n.html('<button class="btn ng-edit-crop-apply ng-hidden">应用裁剪 (Enter)</button>') +
                    AEI18n.html('<button class="btn ng-edit-xform-apply ng-hidden">应用变换</button>') +
                    AEI18n.html('<button class="btn btn-slice ng-edit-xform-cancel ng-hidden">取消变换</button>') +
                    '<span class="ng-edit-xform-info ng-hidden"></span>' +
                  '</div>' +
                '</div>' +
              '</div>' +
              '<div class="ng-edit-foot">' +
                AEI18n.html('<button class="btn ng-edit-save">保存</button>') +
                AEI18n.html('<button class="btn btn-slice ng-edit-cancel">取消</button>') +
              '</div>' +
            '</div>';
        document.body.appendChild(mask);

        var canvas = mask.querySelector('.ng-edit-canvas');
        var canvasInner = mask.querySelector('.ng-edit-canvas-inner');
        var c2d = canvas.getContext('2d');
        var tool = 'brush';
        var brushSize = 8, brushColor = '#fbbf24';
        var bright = 100, contrast = 100, sat = 100;
        var drawing = false, lastX = 0, lastY = 0;
        var cropStart = null, cropBox = null;
        var dirty = false, processing = false;
        var baseImage = null;
        var strokesCanvas = document.createElement('canvas');
        // 创建时即取 ctx：图片恰为 canvas 默认尺寸 300×150 时 syncStrokesSize 不触发重建，
        // strokesCtx 保持 null → 首笔 stroke()/enterTransformMode 的 clearRect 空引用崩溃
        var strokesCtx = strokesCanvas.getContext('2d');

        // ── 视口状态（画布区域的缩放/平移，非图片变换）──
        var vpZoom = 1, vpPanX = 0, vpPanY = 0;
        var vpZoomSlider = mask.querySelector('.ng-edit-vp-zoom');
        var vpZoomVal = mask.querySelector('.ng-edit-vp-zoom-val');
        function applyViewport() {
            canvasInner.style.transform = 'translate(' + vpPanX + 'px,' + vpPanY + 'px) scale(' + vpZoom + ')';
            canvasInner.style.transformOrigin = '0 0';
            vpZoomVal.textContent = Math.round(vpZoom * 100) + '%';
        }
        function resetViewport() {
            vpZoom = 1; vpPanX = 0; vpPanY = 0;
            vpZoomSlider.value = '100';
            applyViewport();
        }
        function fitToScreen() {
            var wrap = mask.querySelector('.ng-edit-canvas-wrap');
            var availW = wrap.clientWidth - 28;
            var availH = wrap.clientHeight - 28;
            if (availW <= 0 || availH <= 0) { vpZoom = 1; }
            else { vpZoom = Math.min(availW / canvas.width, availH / canvas.height); }
            // 缩放从 origin (0,0) 开始会偏移视觉中心，算 pan 补偿回去
            vpPanX = canvas.width * (1 - vpZoom) / 2;
            vpPanY = canvas.height * (1 - vpZoom) / 2;
            vpZoomSlider.value = Math.round(vpZoom * 100);
            applyViewport();
        }

        // ── 撤销栈 ──
        var undoStack = [];
        function pushUndo() {
            var cap = maxUndoFor(strokesCanvas.width, strokesCanvas.height);  // 大图少存几步防 OOM
            if (undoStack.length >= cap) undoStack.shift();
            var snap = document.createElement('canvas');
            snap.width = strokesCanvas.width; snap.height = strokesCanvas.height;
            snap.getContext('2d').drawImage(strokesCanvas, 0, 0);
            undoStack.push(snap);
            dirty = true;
        }
        function undo() {
            if (!undoStack.length) return;
            strokesCanvas.width = baseImage ? canvas.width : strokesCanvas.width;
            strokesCanvas.height = baseImage ? canvas.height : strokesCanvas.height;
            strokesCtx = strokesCanvas.getContext('2d');
            strokesCtx.clearRect(0, 0, strokesCanvas.width, strokesCanvas.height);
            strokesCtx.drawImage(undoStack.pop(), 0, 0);
            redraw();
        }

        // ── 画笔光标圈 ──
        var brushCursor = document.createElement('div');
        brushCursor.className = 'ng-edit-brush-cursor';
        mask.appendChild(brushCursor);
        function updateBrushCursorVis() {
            var show = !transformState && (tool === 'brush' || tool === 'eraser');
            brushCursor.style.display = show ? 'block' : 'none';
            canvas.style.cursor = show ? 'none' : (tool === 'crop' ? 'crosshair' : '');
        }
        function updateBrushCursorSize() {
            var rect = canvas.getBoundingClientRect();
            var sx = canvas.width / rect.width;
            var r = brushSize / sx;
            brushCursor.style.width = (r * 2) + 'px';
            brushCursor.style.height = (r * 2) + 'px';
            brushCursor.style.borderColor = tool === 'eraser' ? '#ff5b5b' : brushColor;
        }
        canvasInner.addEventListener('mousemove', function (e) {
            if (transformState || (tool !== 'brush' && tool !== 'eraser')) return;
            updateBrushCursorSize();
            brushCursor.style.left = e.clientX + 'px';
            brushCursor.style.top = e.clientY + 'px';
        });
        canvasInner.addEventListener('mouseleave', function () { brushCursor.style.display = 'none'; });
        canvasInner.addEventListener('mouseenter', function () { updateBrushCursorVis(); updateBrushCursorSize(); });

        // ── 画笔大小标签 ──
        var sizeVal = mask.querySelector('.ng-edit-size-val');
        function updateSizePreview() {
            sizeVal.textContent = brushSize + 'px';
        }
        updateSizePreview();

        // ── 棋盘格填充图案（画布内透明区域显示）──
        var checkerPattern = null;
        function getCheckerPattern() {
            if (checkerPattern) return checkerPattern;
            var pc = document.createElement('canvas');
            pc.width = 16; pc.height = 16;
            var pctx = pc.getContext('2d');
            pctx.fillStyle = '#2a2a2a'; pctx.fillRect(0, 0, 16, 16);
            pctx.fillStyle = '#222'; pctx.fillRect(0, 0, 8, 8);
            pctx.fillRect(8, 8, 8, 8);
            checkerPattern = c2d.createPattern(pc, 'repeat');
            return checkerPattern;
        }

        function syncStrokesSize() {
            if (strokesCanvas.width !== canvas.width || strokesCanvas.height !== canvas.height) {
                strokesCanvas.width = canvas.width; strokesCanvas.height = canvas.height;
                strokesCtx = strokesCanvas.getContext('2d');
            }
        }

        // ── 加载上游图 ──
        // 读图走 AEFS.readBlob（二进制通道）+ objectURL（免 base64 data URL，大图省一份等大字符串内存）
        // 读失败不再静默关闭（console.warn + closeNoSave() 让全屏编辑器
        // 一闪即关，用户以为按钮失效）——给可见 toast，并把 reason 传给 onClose 供调用方归因。
        function loadFailed(detail) {
            console.warn('[ComfyUI Canvas] 编辑器读图失败:', imagePath, detail || '');
            if (global.AEToast) AEToast.error(AEI18n.t('读取图片失败，无法打开编辑器'));
            closeNoSave('LOAD_FAILED');
        }
        function loadUpstream() {
            if (!imagePath) { closeNoSave('NO_IMAGE'); return; }
            AEFS.readBlob(imagePath).then(function (r) {
                if (!r || !r.success || !r.blob) { loadFailed(); return; }
                var objUrl = URL.createObjectURL(r.blob);
                return loadImg(objUrl).then(function (img) {
                    URL.revokeObjectURL(objUrl);  // img 已解码进内存，objectURL 用完即撤
                    return img;
                }, function (e) { URL.revokeObjectURL(objUrl); throw e; });
            }).then(function (img) {
                if (!img) return;
                baseImage = img;
                var w = img.naturalWidth, h = img.naturalHeight;
                if (w > MAX_CANVAS || h > MAX_CANVAS) {
                    var s = MAX_CANVAS / Math.max(w, h);
                    w = Math.round(w * s); h = Math.round(h * s);
                }
                canvas.width = w; canvas.height = h;
                syncStrokesSize(); undoStack = [];
                fitToScreen(); redraw();
            }).catch(function (e) { loadFailed(e && e.message); });
        }

        function redraw() {
            if (!baseImage) return;
            syncStrokesSize();
            c2d.setTransform(1, 0, 0, 1, 0, 0);
            // 棋盘格背景（透明区域可见）
            c2d.fillStyle = getCheckerPattern();
            c2d.fillRect(0, 0, canvas.width, canvas.height);
            c2d.filter = colorFilter(bright, contrast, sat);
            c2d.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
            c2d.filter = 'none';
            c2d.drawImage(strokesCanvas, 0, 0);
            if (!transformState) drawCropOverlay();
        }

        function composeForExport() {
            var c = document.createElement('canvas');
            c.width = canvas.width; c.height = canvas.height;
            var cx = c.getContext('2d');
            cx.filter = colorFilter(bright, contrast, sat);
            cx.drawImage(baseImage, 0, 0, canvas.width, canvas.height);
            cx.filter = 'none';
            cx.drawImage(strokesCanvas, 0, 0);
            return c;
        }

        function drawCropOverlay() {
            if (!cropBox) return;
            c2d.save();
            c2d.fillStyle = 'rgba(0,0,0,0.5)';
            c2d.fillRect(0, 0, canvas.width, cropBox.y);
            c2d.fillRect(0, cropBox.y + cropBox.h, canvas.width, canvas.height - cropBox.y - cropBox.h);
            c2d.fillRect(0, cropBox.y, cropBox.x, cropBox.h);
            c2d.fillRect(cropBox.x + cropBox.w, cropBox.y, canvas.width - cropBox.x - cropBox.w, cropBox.h);
            c2d.strokeStyle = '#fbbf24'; c2d.lineWidth = 1;
            c2d.strokeRect(cropBox.x, cropBox.y, cropBox.w, cropBox.h);
            // 裁切尺寸标签
            c2d.fillStyle = '#fbbf24'; c2d.font = '11px sans-serif';
            var label = cropBox.w + '×' + cropBox.h;
            var tw = c2d.measureText(label).width;
            var lx = cropBox.x + cropBox.w - tw - 4, ly = cropBox.y - 6;
            if (ly < 12) ly = cropBox.y + cropBox.h + 14;
            c2d.fillText(label, Math.max(2, lx), ly);
            c2d.restore();
        }

        function toCanvas(e) {
            var rect = canvas.getBoundingClientRect();
            return { x: (e.clientX - rect.left) * canvas.width / rect.width, y: (e.clientY - rect.top) * canvas.height / rect.height };
        }

        // ── 自由变换状态 ──
        var transformState = null;
        var tfDragging = null;

        function enterTransformMode() {
            if (!baseImage || processing) return;
            processing = true;
            var composed = composeForExport();
            loadImg(composed.toDataURL('image/png')).then(function (img) {
                processing = false;
                baseImage = img;
                canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
                syncStrokesSize();
                strokesCtx.clearRect(0, 0, canvas.width, canvas.height);
                undoStack = [];
                bright = 100; contrast = 100; sat = 100;
                mask.querySelector('.ng-edit-bright').value = '100';
                mask.querySelector('.ng-edit-contrast').value = '100';
                mask.querySelector('.ng-edit-sat').value = '100';
                cropBox = null;
                transformState = { origImage: img, offsetX: 0, offsetY: 0, w: canvas.width, h: canvas.height, rotation: 0, scaleX: 1, scaleY: 1 };
                updateTransformUI(); updateBrushCursorVis(); redrawTransformPreview();
            }, function () { processing = false; if (global.AEToast) AEToast.error(AEI18n.t('进入变换失败')); });
        }

        function exitTransformMode(apply) {
            if (!transformState) return null;
            if (apply) {
                processing = true;
                var out = document.createElement('canvas');
                out.width = canvas.width; out.height = canvas.height;
                var oc = out.getContext('2d');
                var cx = canvas.width / 2 + transformState.offsetX;
                var cy = canvas.height / 2 + transformState.offsetY;
                oc.save();
                oc.translate(cx, cy);
                oc.rotate(transformState.rotation * Math.PI / 180);
                oc.scale(transformState.scaleX, transformState.scaleY);
                oc.drawImage(transformState.origImage, -transformState.w / 2, -transformState.h / 2);
                oc.restore();
                // 返回 Promise，save() 可等待应用完成再导出
                return loadImg(out.toDataURL('image/png')).then(function (img) {
                    baseImage = img;
                    canvas.width = out.width; canvas.height = out.height;
                    syncStrokesSize(); strokesCtx.clearRect(0, 0, out.width, out.height);
                    undoStack = []; transformState = null; tfDragging = null;
                    updateTransformUI(); updateBrushCursorVis();
                    tool = 'brush';
                    var tools = mask.querySelectorAll('.ng-edit-tool');
                    for (var i = 0; i < tools.length; i++) tools[i].classList.toggle('active', tools[i].dataset.tool === 'brush');
                    redraw(); dirty = true; processing = false;
                // 落图失败必须向上抛——save() 等待该 Promise 兑现后才继续导出，
                // 吞掉错误会让导出继续且导出的是变换前的旧图（与预览不符）
                }, function (err) { processing = false; throw err; });
            } else {
                baseImage = transformState.origImage;
                canvas.width = transformState.w; canvas.height = transformState.h;
                syncStrokesSize(); strokesCtx.clearRect(0, 0, canvas.width, canvas.height);
                transformState = null; tfDragging = null;
                updateTransformUI(); updateBrushCursorVis();
                tool = 'brush';
                var t2 = mask.querySelectorAll('.ng-edit-tool');
                for (var j = 0; j < t2.length; j++) t2[j].classList.toggle('active', t2[j].dataset.tool === 'brush');
                redraw();
            }
        }

        var xformInfo = mask.querySelector('.ng-edit-xform-info');
        function updateTransformUI() {
            var show = !!transformState;
            canvasInner.classList.toggle('ng-edit-transforming', show);
            mask.querySelector('.ng-edit-xform-apply').classList.toggle('ng-hidden', !show);
            mask.querySelector('.ng-edit-xform-cancel').classList.toggle('ng-hidden', !show);
            xformInfo.classList.toggle('ng-hidden', !show);
            if (!show) xformInfo.textContent = '';
            var toolBtns = mask.querySelectorAll('.ng-edit-tool');
            for (var i = 0; i < toolBtns.length; i++) {
                if (toolBtns[i].dataset.tool !== 'transform') toolBtns[i].disabled = show;
            }
            var xformBtn = mask.querySelector('.ng-edit-tool[data-tool="transform"]');
            if (xformBtn) xformBtn.classList.toggle('active', show);
            // 变换模式下禁用视口控件，避免冲突
            vpZoomSlider.disabled = show;
            mask.querySelector('.ng-edit-vp-reset').disabled = show;
        }

        function redrawTransformPreview() {
            if (!transformState || !baseImage) return;
            c2d.setTransform(1, 0, 0, 1, 0, 0);
            // 棋盘格背景
            c2d.fillStyle = getCheckerPattern();
            c2d.fillRect(0, 0, canvas.width, canvas.height);
            var cx = canvas.width / 2 + transformState.offsetX;
            var cy = canvas.height / 2 + transformState.offsetY;
            c2d.save();
            c2d.translate(cx, cy);
            c2d.rotate(transformState.rotation * Math.PI / 180);
            c2d.scale(transformState.scaleX, transformState.scaleY);
            c2d.drawImage(transformState.origImage, -transformState.w / 2, -transformState.h / 2);
            c2d.restore();
            c2d.save();
            c2d.translate(cx, cy);
            c2d.rotate(transformState.rotation * Math.PI / 180);
            var hw = transformState.w * transformState.scaleX / 2, hh = transformState.h * transformState.scaleY / 2;
            c2d.strokeStyle = '#fff'; c2d.lineWidth = 1;
            c2d.setLineDash([4, 4]); c2d.strokeRect(-hw, -hh, hw * 2, hh * 2); c2d.setLineDash([]);
            c2d.restore();
            var pct = Math.round(transformState.scaleX * 100);
            var deg = Math.round(transformState.rotation % 360);
            xformInfo.textContent = pct + '% | ' + deg + AEI18n.t('° | 拖/中键=移动 Ctrl=缩放 Shift=旋转');
        }

        // ── 视口缩放滑块（以 canvas 中心为锚点）──
        // canvas 经 flex 居中 + transformOrigin:0 0，wrap 尺寸在锚点计算中抵消，
        // 锚点直接从 canvas 坐标系算：视口中心 → flexLeft + pan + cx*s = 视口中心
        // 消去 wrap 和 flex 后：cx = (canvasW/2 - panX) / zoom
        vpZoomSlider.addEventListener('input', function () {
            var newZoom = parseInt(vpZoomSlider.value, 10) / 100;
            if (vpZoom === newZoom) return;
            var cx = canvas.width / 2;
            var cy = canvas.height / 2;
            var oldZoom = vpZoom;
            vpZoom = newZoom;
            vpPanX = vpPanX + cx * (oldZoom - vpZoom);
            vpPanY = vpPanY + cy * (oldZoom - vpZoom);
            applyViewport();
        });
        mask.querySelector('.ng-edit-vp-reset').addEventListener('click', resetViewport);

        // ── 画布鼠标交互 ──
        canvas.addEventListener('mousedown', function (e) {
            // 中键：视口平移（非变换模式）或变换移动（变换模式）
            if (e.button === 1) {
                e.preventDefault();
                if (transformState) {
                    tfDragging = { mode: 'move', startX: e.clientX, startY: e.clientY, startOffsetX: transformState.offsetX, startOffsetY: transformState.offsetY };
                } else {
                    // 视口平移
                    var vpStart = { x: e.clientX, y: e.clientY, panX: vpPanX, panY: vpPanY };
                    function onVpMove(ev) { vpPanX = vpStart.panX + ev.clientX - vpStart.x; vpPanY = vpStart.panY + ev.clientY - vpStart.y; applyViewport(); }
                    function onVpUp() { window.removeEventListener('mousemove', onVpMove); window.removeEventListener('mouseup', onVpUp); }
                    window.addEventListener('mousemove', onVpMove);
                    window.addEventListener('mouseup', onVpUp);
                }
                return;
            }
            if (e.button !== 0) return;
            if (!baseImage) return;

            if (transformState) {
                var mode = 'move';
                if (e.ctrlKey || e.metaKey) mode = 'scale';
                else if (e.shiftKey) mode = 'rotate';
                tfDragging = {
                    mode: mode, startX: e.clientX, startY: e.clientY,
                    startRotation: transformState.rotation,
                    startScaleX: transformState.scaleX, startScaleY: transformState.scaleY,
                    startOffsetX: transformState.offsetX, startOffsetY: transformState.offsetY
                };
                e.preventDefault();
                return;
            }

            if (tool === 'transform') return;
            var p = toCanvas(e);
            if (tool === 'crop') { cropStart = p; cropBox = { x: p.x, y: p.y, w: 0, h: 0 }; return; }
            drawing = true; lastX = p.x; lastY = p.y;
            pushUndo(); stroke(p.x, p.y, p.x, p.y);
        });

        function onMove(e) {
            if (transformState && tfDragging) {
                var dx = e.clientX - tfDragging.startX, dy = e.clientY - tfDragging.startY;
                if (tfDragging.mode === 'move') {
                    transformState.offsetX = tfDragging.startOffsetX + dx / vpZoom;
                    transformState.offsetY = tfDragging.startOffsetY + dy / vpZoom;
                } else if (tfDragging.mode === 'scale') {
                    var sens = 0.005;
                    transformState.scaleX = Math.max(0.1, Math.min(10, tfDragging.startScaleX + dx * sens));
                    transformState.scaleY = Math.max(0.1, Math.min(10, tfDragging.startScaleY + dx * sens));
                } else if (tfDragging.mode === 'rotate') {
                    transformState.rotation = tfDragging.startRotation + dy * 0.3;
                }
                redrawTransformPreview();
                return;
            }
            if (tool === 'crop' && cropStart) { cropBox = cropRect(cropStart.x, cropStart.y, toCanvas(e).x, toCanvas(e).y, canvas.width, canvas.height); redraw(); return; }
            if (!drawing) return;
            var p = toCanvas(e); stroke(lastX, lastY, p.x, p.y); lastX = p.x; lastY = p.y;
        }
        function onUp() {
            if (transformState && tfDragging) { tfDragging = null; return; }
            drawing = false;
            if (tool === 'crop' && cropBox && cropBox.w > 2 && cropBox.h > 2) {
                mask.querySelector('.ng-edit-crop-apply').classList.remove('ng-hidden');
            }
        }
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);

        // 单滚轮：视口缩放（以鼠标位置为锚点；变换模式下禁用）
        // canvasInner.getBoundingClientRect() 已经包含 transform 后的位移，
        // mx/my 是视觉坐标，除以 zoom 即得 canvas 坐标，不需要再减 pan
        canvas.addEventListener('wheel', function (e) {
            if (e.ctrlKey || e.metaKey || e.shiftKey) return;
            if (transformState) return;
            e.preventDefault();
            var rect = canvasInner.getBoundingClientRect();
            var mx = e.clientX - rect.left;
            var my = e.clientY - rect.top;
            var cx = mx / vpZoom;
            var cy = my / vpZoom;
            var oldZoom = vpZoom;
            var delta = e.deltaY > 0 ? -0.1 : 0.1;
            vpZoom = Math.max(0.1, Math.min(4, vpZoom + delta));
            vpPanX = vpPanX + cx * (oldZoom - vpZoom);
            vpPanY = vpPanY + cy * (oldZoom - vpZoom);
            vpZoomSlider.value = Math.round(vpZoom * 100);
            applyViewport();
        }, { passive: false });

        function stroke(x1, y1, x2, y2) {
            syncStrokesSize();
            strokesCtx.save();
            if (tool === 'eraser') { strokesCtx.globalCompositeOperation = 'destination-out'; strokesCtx.strokeStyle = 'rgba(0,0,0,1)'; }
            else { strokesCtx.globalCompositeOperation = 'source-over'; strokesCtx.strokeStyle = brushColor; }
            strokesCtx.lineWidth = brushSize; strokesCtx.lineCap = 'round';
            strokesCtx.beginPath(); strokesCtx.moveTo(x1, y1); strokesCtx.lineTo(x2, y2); strokesCtx.stroke();
            strokesCtx.restore(); redraw();
        }

        // ── 工具切换 ──
        mask.querySelector('.ng-edit-tools').addEventListener('click', function (e) {
            var t = e.target;
            if (t.classList.contains('ng-edit-tool')) {
                var newTool = t.dataset.tool;
                if (newTool === 'transform') { enterTransformMode(); return; }
                tool = newTool;
                var tools = mask.querySelectorAll('.ng-edit-tool');
                for (var i = 0; i < tools.length; i++) tools[i].classList.toggle('active', tools[i] === t);
                if (tool !== 'crop') { cropBox = null; cropStart = null; mask.querySelector('.ng-edit-crop-apply').classList.add('ng-hidden'); redraw(); }
                updateBrushCursorVis(); updateBrushCursorSize();
            }
        });

        // ── 粗细/颜色/调色 ──
        mask.querySelector('.ng-edit-size').addEventListener('input', function (e) { brushSize = parseInt(e.target.value, 10) || 8; updateSizePreview(); updateBrushCursorSize(); });
        mask.querySelector('.ng-edit-color').addEventListener('input', function (e) { brushColor = e.target.value; updateBrushCursorSize(); });
        function bindColorSlider(cls, set) {
            mask.querySelector(cls).addEventListener('input', function (e) { set(parseInt(e.target.value, 10) || 100); redraw(); dirty = true; });
        }
        bindColorSlider('.ng-edit-bright', function (v) { bright = v; });
        bindColorSlider('.ng-edit-contrast', function (v) { contrast = v; });
        bindColorSlider('.ng-edit-sat', function (v) { sat = v; });

        // ── 变换行按钮 ──
        mask.querySelector('.ng-edit-xform-row').addEventListener('click', function (e) {
            var t = e.target;
            if (t.classList.contains('ng-edit-crop-apply')) { applyCrop(); }
            else if (t.classList.contains('ng-edit-xform-apply')) {
                // 应用失败提示（exitTransformMode 的 reject 已上抛，不再静默吞掉）
                var _xa = exitTransformMode(true);
                if (_xa) _xa.catch(function () { if (global.AEToast) AEToast.error(AEI18n.t('应用变换失败')); });
            }
            else if (t.classList.contains('ng-edit-xform-cancel')) { exitTransformMode(false); }
        });

        // ── 裁剪 ──
        function applyCrop() {
            if (!cropBox || cropBox.w < 2 || cropBox.h < 2 || processing) return;
            processing = true;
            var composed = composeForExport();
            var tmp = document.createElement('canvas');
            tmp.width = cropBox.w; tmp.height = cropBox.h;
            tmp.getContext('2d').drawImage(composed, cropBox.x, cropBox.y, cropBox.w, cropBox.h, 0, 0, cropBox.w, cropBox.h);
            // 异步回调内使用局部引用：解码期间 Escape 可能把 cropBox 置 null（且 processing 会卡死）
            var cb = cropBox;
            loadImg(tmp.toDataURL('image/png')).then(function (img) {
                baseImage = img;
                canvas.width = cb.w; canvas.height = cb.h;
                syncStrokesSize(); strokesCtx.clearRect(0, 0, cb.w, cb.h);
                undoStack = [];
                bright = 100; contrast = 100; sat = 100;
                mask.querySelector('.ng-edit-bright').value = '100';
                mask.querySelector('.ng-edit-contrast').value = '100';
                mask.querySelector('.ng-edit-sat').value = '100';
                cropBox = null; cropStart = null;
                mask.querySelector('.ng-edit-crop-apply').classList.add('ng-hidden');
                resetViewport(); redraw(); dirty = true; processing = false;
            }, function () { processing = false; });
        }

        // ── 保存 ──
        // saving 防重入（双击保存只产生一个文件）；processing 在途（裁剪/变换
        // 落图未完成）时拒绝——直接 composeForExport() 会导出未裁剪/未变换旧图。
        var saving = false;
        function save() {
            if (saving) return;   // 防双击：第一次导出在途时第二次点击直接忽略
            if (!baseImage) { closeNoSave(); return; }
            if (!aeIO || !aeIO.writeBlobToFile || !outputDir) {
                console.warn('[ComfyUI Canvas] 编辑器保存缺少 aeIO/outputDir');
                if (global.AEToast) AEToast.error(AEI18n.t('保存不可用')); return;
            }
            if (processing) {
                console.warn('[ComfyUI Canvas] 编辑器处理中（裁剪/变换在途），本次保存已拒绝');
                if (global.AEToast) AEToast.warn(AEI18n.t('图片处理中，请稍候再保存'));
                return;
            }
            saving = true;
            var outPath = outputDir + '/imageEdit_' + Date.now() + '.png';
            // 有未确认的变换（移动/旋转/缩放）时先自动应用，等异步落图完成再合成导出——
            // 否则用户拖完图片直接点保存，导出的是变换前的旧图。
            var _pre = transformState ? exitTransformMode(true) : null;
            Promise.resolve(_pre).then(function () {
                canvasToBlob(composeForExport(), 'image/png').then(function (blob) {
                    return aeIO.writeBlobToFile(blob, outPath).then(function (ok) {
                        if (ok) { dirty = false; onSave(outPath); closeNoSave(); }
                        else { saving = false; console.warn('[ComfyUI Canvas] 编辑器保存失败'); if (global.AEToast) AEToast.error(AEI18n.t('保存失败')); }
                    });
                }).catch(function (e) { saving = false; console.warn('[ComfyUI Canvas] 编辑器保存异常:', e && e.message); if (global.AEToast) AEToast.error(AEI18n.t('保存失败')); });
            }).catch(function (e) {
                // 变换落图失败时中止导出（不写文件、不关闭编辑器），提示用户重试
                // 或放弃——失败被吞时 Promise 以 undefined 兑现，导出的是变换前的旧图
                saving = false;
                console.warn('[ComfyUI Canvas] 应用变换失败，已中止保存:', e && e.message);
                if (global.AEToast) AEToast.error(AEI18n.t('应用变换失败，已中止保存'));
            });
        }

        // ── 关闭 ──
        var closed = false;
        // reason 透传 onClose（如 'LOAD_FAILED' / 'NO_IMAGE'），供调用方归因；
        // 保存成功/用户取消等常规关闭为 null。
        function closeNoSave(reason) {
            if (closed) return; closed = true;
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            document.removeEventListener('keydown', onKey);
            if (mask.parentNode) mask.parentNode.removeChild(mask);
            onClose(reason || null);
        }
        function requestClose() {
            if (closed) return;
            if (!dirty) { closeNoSave(); return; }
            if (typeof global.showConfirm === 'function') {
                global.showConfirm(AEI18n.t('放弃编辑？'), AEI18n.t('有未保存的改动，确定放弃关闭吗？')).then(function (ok) { if (ok) closeNoSave(); });
            } else { closeNoSave(); }
        }

        mask.querySelector('.ng-edit-close').addEventListener('click', requestClose);
        mask.querySelector('.ng-edit-cancel').addEventListener('click', requestClose);
        mask.querySelector('.ng-edit-save').addEventListener('click', save);
        function onKey(e) {
            if (e.key === 'Escape') {
                if (transformState) { exitTransformMode(false); return; }
                if (cropBox && cropBox.w > 2) { cropBox = null; cropStart = null; mask.querySelector('.ng-edit-crop-apply').classList.add('ng-hidden'); redraw(); return; }
                requestClose();
            }
            if (e.key === 'Enter') {
                if (transformState) {
                    e.preventDefault();
                    // 应用失败提示（reject 已上抛，不再静默吞掉）
                    var _xe = exitTransformMode(true);
                    if (_xe) _xe.catch(function () { if (global.AEToast) AEToast.error(AEI18n.t('应用变换失败')); });
                    return;
                }
                if (tool === 'crop' && cropBox && cropBox.w > 2 && cropBox.h > 2) { e.preventDefault(); applyCrop(); return; }
            }
            if ((e.key === 'z' || e.key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey) { e.preventDefault(); if (!transformState) undo(); }
            if ((e.key === 't' || e.key === 'T') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); enterTransformMode(); }
            if (e.key === '0' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); resetViewport(); }
        }
        document.addEventListener('keydown', onKey);
        mask.addEventListener('click', function (e) { if (e.target === mask) requestClose(); });

        updateBrushCursorVis();
        loadUpstream();
        return { save: save, close: requestClose, forceClose: closeNoSave };
    }
    global.AEComfyUI.createImageEditor = createImageEditor;
    global.AEComfyUI.imageEditorMaxUndoFor = maxUndoFor;  // 供回归测试使用
})(window);
