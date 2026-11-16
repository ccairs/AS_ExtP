// petSprites.js - 序列帧管理与动画播放
// 使用 canvas drawImage 切片绘制 sprite sheet，兼容 CEP Chrome 88
// 关键优化：
//   1. canvas drawImage 同步绘制，无 background-image 异步解码闪烁
//   2. _preloadImages 预加载 Image + 逐行预热 GPU 纹理，避免首次 drawImage 卡顿
//   3. _tick 追帧循环：RAF 跳帧时（elapsed > 2*interval）按时间比例补帧，避免动画末尾被吃掉
//   4. playQueued：非交互事件切动画时排队等当前非循环动画 anim:done，避免覆盖
//   5. _settlePendingCallbacks：交互事件 play() 打断时清空 pending 队列，避免悬挂
(function (global) {
    'use strict';

    function createSprites(eventBus) {
        var _container = null;
        var _canvas = null;
        var _ctx2d = null;
        var _manifest = null;
        var _basePath = '';
        var _loaded = false;
        var _fallbackEmoji = '🐳';

        // 显示尺寸（CSS px），canvas 内部分辨率 = manifest.frameWidth × frameHeight
        var _displayWidth = 120;
        var _displayHeight = 120;

        var _currentState = null;
        var _currentFrame = 0;
        var _rafId = null;
        var _lastFrameTime = 0;
        var _animDoneCallbacks = [];
        var _paused = false;

        // 预加载的 Image 对象映射：state name -> Image
        var _images = {};
        var _imagesLoading = 0;
        // 加载失败的 state（onerror）：_applyFrame 据此走 emoji 兜底而不停在旧帧（见 _applyFrame）
        var _failedImages = {};

        // 排队的非交互动画：当前在播非循环动画时，playQueued 把下一个动画存这里
        var _pendingAnim = null;
        var _pendingAnimResolve = null;

        var _fpsOverride = null;
        // 低性能模式：关闭 GPU 预热（按需上传纹理）+ 抽帧（每 _frameSkip 帧只画 1 帧）
        var _lowPerfMode = false;
        // 抽帧系数：1 = 每帧都画（24fps），2 = 每 2 帧画 1 帧（视觉 12fps）
        // 关键：只跳过绘制，不跳过 _currentFrame++，所以动作时长不变（不是降 fps）
        var _frameSkip = 1;

        function mount(container) {
            _container = container;
            _canvas = document.createElement('canvas');
            _canvas.className = 'dspet-sprite';
            _ctx2d = _canvas.getContext('2d');
            if (_ctx2d) _ctx2d.imageSmoothingEnabled = false;  // pixelated，保持像素风
            container.appendChild(_canvas);
            return _canvas;
        }

        function getElement() { return _canvas; }

        function setBasePath(p) { _basePath = p; }

        function setDisplaySize(w, h) {
            _displayWidth = w;
            _displayHeight = h;
        }

        // manifest 加载：CEP file:// 协议下 fetch 相对路径不可靠，优先用 AEFS.readFile
        function loadManifest(manifestPath) {
            var readFn = (typeof AEFS !== 'undefined' && AEFS.readFile) ? AEFS.readFile : null;
            if (!readFn) {
                console.warn('[petSprites] AEFS 不可用，manifest 加载失败');
                _loaded = false;
                return Promise.resolve(null);
            }
            return readFn(manifestPath).then(function (text) {
                if (!text) {
                    console.warn('[petSprites] manifest 文件为空或不存在');
                    _loaded = false;
                    return null;
                }
                try {
                    _manifest = JSON.parse(text);
                    _loaded = true;
                    _preloadImages();
                    _syncCanvasSize();
                    return _manifest;
                } catch (e) {
                    console.warn('[petSprites] manifest JSON 解析失败: ' + (e && e.message ? e.message : e));
                    _loaded = false;
                    return null;
                }
            }).catch(function (e) {
                console.warn('[petSprites] manifest 加载失败，使用 emoji 兜底: ' + (e && e.message ? e.message : e));
                _loaded = false;
                return null;
            });
        }

        // 预加载所有 sprite PNG 到 Image 对象，保存引用防 GC
        // 加载完成后 _applyFrame 即可同步 drawImage，无解码延迟
        function _preloadImages() {
            if (!_manifest || typeof Image === 'undefined') return;
            var states = _manifest.states || {};
            _images = {};
            _imagesLoading = 0;
            _failedImages = {};   // 重新预加载（manifest 重载）时清掉上一轮的失败标记，给文件补回留机会
            // 离屏 canvas 用于预热 GPU 纹理：Image.onload 后图片只是解码到 CPU 内存，
            // 首次 drawImage 才会上传到 GPU 纹理。对于大图首次 drawImage 会卡顿 50-200ms。
            // 预热策略：每个 sprite 加载后立即在离屏 canvas 逐行画首帧，强制 GPU 纹理上传。
            // 逐行画首帧覆盖整张图的垂直区域，确保末尾帧也不需要重新上传。
            var warmupCanvas = document.createElement('canvas');
            var warmupCtx = warmupCanvas.getContext('2d');
            if (warmupCtx) warmupCtx.imageSmoothingEnabled = false;
            for (var name in states) {
                if (states.hasOwnProperty(name)) {
                    _imagesLoading++;
                    var img = new Image();
                    (function (stateName, imageObj, stateDef) {
                        imageObj.onload = function () {
                            _imagesLoading--;
                            _images[stateName] = imageObj;
                            // 预热 GPU 纹理：在离屏 canvas 画每一行的首帧，强制整张图 GPU 纹理上传
                            // 低性能模式跳过预热，改为按需上传（首次 drawImage 时才上传该图），
                            // 避免启动时一次性占用 ~425MB 显存，代价是首次播放某动画时可能卡顿 1-2 帧
                            if (!_lowPerfMode) {
                                try {
                                    var fw = _manifest.frameWidth || 320;
                                    var fh = _manifest.frameHeight || 320;
                                    var cols = stateDef.cols || stateDef.frames || 1;
                                    var rows = Math.ceil(stateDef.frames / cols);
                                    warmupCanvas.width = fw;
                                    warmupCanvas.height = fh;
                                    for (var r = 0; r < rows; r++) {
                                        var frameIdxForRow = r * cols;
                                        if (frameIdxForRow >= stateDef.frames) break;
                                        var sx = (frameIdxForRow % cols) * fw;
                                        var sy = Math.floor(frameIdxForRow / cols) * fh;
                                        warmupCtx.clearRect(0, 0, fw, fh);
                                        warmupCtx.drawImage(imageObj, sx, sy, fw, fh, 0, 0, fw, fh);
                                    }
                                } catch (e) {
                                    console.warn('[petSprites] warmup failed for ' + stateName + ': ' + e);
                                }
                            }
                            // 若当前正在播放该 state，立即重绘一帧（避免首帧延迟）
                            if (_currentState === stateName && _ctx2d) {
                                _applyFrame(_currentState, _currentFrame);
                            }
                        };
                        imageObj.onerror = function () {
                            _imagesLoading--;
                            // 标记该 state 永久不可用：若正是当前在播的动画，立即改画 emoji 兜底——
                            // 只 warn 不重绘会让画布冻结在上一张图，而状态机/anim:done 照常推进
                            _failedImages[stateName] = true;
                            console.warn('[petSprites] sprite 加载失败: ' + stateName + ' (' + imageObj.src + ')');
                            if (_currentState === stateName && _ctx2d) {
                                _applyFrame(_currentState, _currentFrame);
                            }
                        };
                    })(name, img, states[name]);
                    img.src = _basePath + '/' + states[name].file;
                }
            }
        }

        // 同步 canvas 内部分辨率到当前 manifest.frameWidth × frameHeight
        function _syncCanvasSize() {
            if (!_canvas || !_manifest) return;
            var fw = _manifest.frameWidth || 320;
            var fh = _manifest.frameHeight || 320;
            if (_canvas.width !== fw || _canvas.height !== fh) {
                _canvas.width = fw;
                _canvas.height = fh;
                if (_ctx2d) _ctx2d.imageSmoothingEnabled = false;
            }
        }

        function _getFrameInterval(state) {
            if (_fpsOverride) return 1000 / _fpsOverride;
            var def = _manifest && _manifest.states ? _manifest.states[state] : null;
            var fps = (def && def.fps) || 6;
            return 1000 / fps;
        }

        function _getFrameCount(state) {
            var def = _manifest && _manifest.states ? _manifest.states[state] : null;
            return (def && def.frames) || 1;
        }

        function _isLoop(state) {
            var def = _manifest && _manifest.states ? _manifest.states[state] : null;
            return !!(def && def.loop);
        }

        // emoji 兜底上屏（canvas 无法直接画 emoji 文本，用 fillText）：_loaded/_manifest 缺失
        // 与单张 sprite **加载失败**（文件缺失/半更新，见 _failedImages）两条路径共用
        function _drawEmojiFallback() {
            if (!_canvas || !_ctx2d) return;
            if (_canvas.width !== 120) { _canvas.width = 120; _canvas.height = 120; }
            _ctx2d.clearRect(0, 0, 120, 120);
            _ctx2d.font = '80px sans-serif';
            _ctx2d.textAlign = 'center';
            _ctx2d.textBaseline = 'middle';
            _ctx2d.fillText(_fallbackEmoji, 60, 60);
        }

        function _applyFrame(state, frameIdx) {
            if (!_canvas || !_ctx2d) return;
            if (!_loaded || !_manifest) {
                _drawEmojiFallback();   // emoji fallback：canvas 无法直接画 emoji 文本，用 fillText
                return;
            }
            var def = _manifest.states[state];
            if (!def) return;
            var img = _images[state];
            if (!img) {
                // 图片还没加载完：先不画（避免空白），onload 时会重绘。
                // 但**已确认加载失败**的 state（sprite 文件缺失/半更新）不能停在旧帧上——
                // 否则画布冻结在上一张图而状态机照常推进，看起来像"卡死"；按模块既有
                // emoji 兜底呈现（onerror 已即时重绘，此处覆盖 tick 的后续帧）
                if (_failedImages[state]) _drawEmojiFallback();
                return;
            }
            var fw = _manifest.frameWidth || 320;
            var fh = _manifest.frameHeight || 320;
            var cols = def.cols || def.frames || 1;
            var row = Math.floor(frameIdx / cols);
            var col = frameIdx % cols;
            // drawImage 同步：从源图 (col*fw, row*fh, fw, fh) 切片绘制到 canvas (0, 0, fw, fh)
            _ctx2d.clearRect(0, 0, _canvas.width, _canvas.height);
            _ctx2d.drawImage(
                img,
                col * fw, row * fh, fw, fh,
                0, 0, fw, fh
            );
            // 同步 container 显示尺寸，保证点击/拖拽区域与视觉尺寸一致
            var displayWStr = _displayWidth + 'px';
            var displayHStr = _displayHeight + 'px';
            if (_canvas.style.width !== displayWStr) {
                _canvas.style.width = displayWStr;
                _canvas.style.height = displayHStr;
            }
            if (_container) {
                if (_container.style.width !== displayWStr) _container.style.width = displayWStr;
                if (_container.style.height !== displayHStr) _container.style.height = displayHStr;
            }
        }

        function _tick(timestamp) {
            if (_paused || !_currentState) { _rafId = null; return; }
            if (!_lastFrameTime) _lastFrameTime = timestamp;
            var elapsed = timestamp - _lastFrameTime;
            var interval = _getFrameInterval(_currentState);

            // 追帧循环：RAF 一次跳跃 elapsed=200ms 应切 4-5 帧，循环追帧直到 elapsed < interval
            // 避免动画末尾被吃掉（只切 1 帧会让 24fps 动画实际播 50fps）
            var advanced = false;
            while (elapsed >= interval) {
                _lastFrameTime += interval;
                _currentFrame++;
                advanced = true;
                elapsed = timestamp - _lastFrameTime;
            }

            if (advanced) {
                var total = _getFrameCount(_currentState);
                if (_currentFrame >= total) {
                    if (_isLoop(_currentState)) {
                        _currentFrame = _currentFrame % total;
                        _applyFrame(_currentState, _currentFrame);
                    } else {
                        // 非循环动画结束：强制画最后一帧（即使抽帧模式漏画，最后一帧也要呈现）
                        _applyFrame(_currentState, total - 1);
                        var callbacks = _animDoneCallbacks;
                        _animDoneCallbacks = [];
                        var doneState = _currentState;
                        _currentState = null;
                        _rafId = null;
                        eventBus.emit('anim:done', { state: doneState });
                        for (var i = 0; i < callbacks.length; i++) {
                            try { callbacks[i](); } catch (e) {}
                        }
                        // 非交互事件在当前非循环动画期间排队的下一个动画，anim:done 后切换
                        // 交互事件调 play() 会清空 _pendingAnim，不会被这里覆盖
                        if (_pendingAnim) {
                            var nextName = _pendingAnim;
                            var nextResolve = _pendingAnimResolve;
                            _pendingAnim = null;
                            _pendingAnimResolve = null;
                            play(nextName).then(nextResolve);
                        }
                        return;
                    }
                } else {
                    // 抽帧：_frameSkip=2 时只画偶数帧（_currentFrame % 2 === 0）
                    // 时间基准（_lastFrameTime）仍按 24fps 推进，动作时长不变
                    // 只减少 drawImage 次数，降低 GPU/CPU 负载
                    var shouldDraw = (_frameSkip <= 1) || (_currentFrame % _frameSkip === 0);
                    if (shouldDraw) {
                        _applyFrame(_currentState, _currentFrame);
                    }
                }
            }
            _rafId = requestAnimationFrame(_tick);
        }

        function play(name, onDone) {
            if (!_loaded) {
                if (_canvas && _ctx2d) {
                    _ctx2d.clearRect(0, 0, _canvas.width, _canvas.height);
                    _ctx2d.font = '80px sans-serif';
                    _ctx2d.textAlign = 'center';
                    _ctx2d.textBaseline = 'middle';
                    _ctx2d.fillText(_fallbackEmoji, _canvas.width / 2, _canvas.height / 2);
                }
                // 兜底播放同样广播 anim:done（对齐非循环动画播完的正常路径）。
                // 兜底分支若立即 resolve 但不发 anim:done，petMovement._onAnimDone
                // 收不到事件 → _state 永远停在 'walk' → moveTo 的 100ms 轮询永不退出
                // （行为链/behaviorLock 卡死、轮询定时器空转泄漏），idle 调度也随之死亡
                eventBus.emit('anim:done', { state: name });
                if (onDone) onDone();
                return Promise.resolve();
            }
            if (_currentState === name && _isLoop(name)) return Promise.resolve();

            // 切换状态时取消未完成的 RAF，并 settle 旧动画的 pending Promise（避免悬挂）
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            _settlePendingCallbacks();

            _currentState = name;
            _currentFrame = 0;
            _lastFrameTime = 0;
            _applyFrame(name, 0);

            if (onDone) _animDoneCallbacks.push(onDone);

            if (_isLoop(name)) {
                var resolveImmediately = Promise.resolve();
                _rafId = requestAnimationFrame(_tick);
                return resolveImmediately;
            }

            return new Promise(function (resolve) {
                _animDoneCallbacks.push(resolve);
                _rafId = requestAnimationFrame(_tick);
            });
        }

        // 主动调用并清空所有 pending 回调，防止动画被打断时 Promise 永久悬挂
        // 同时清掉排队中的非交互 pending 动画（交互事件 play() 触发时调用）
        function _settlePendingCallbacks() {
            if (!_animDoneCallbacks.length && !_pendingAnimResolve) return;
            var old = _animDoneCallbacks;
            _animDoneCallbacks = [];
            for (var i = 0; i < old.length; i++) {
                try { old[i](); } catch (e) { /* 忽略回调错误 */ }
            }
            // 交互事件打断时清空 pending 队列并 resolve（避免悬挂）
            _pendingAnim = null;
            if (_pendingAnimResolve) {
                var resolve = _pendingAnimResolve;
                _pendingAnimResolve = null;
                try { resolve(); } catch (e) {}
            }
        }

        // 非交互事件（idle:enter/walk:enter/pet:sleep/pet:wake 等）切动画时调用：
        // - 当前在播非循环动画（如 stretch/click 等）-> 排队等 anim:done 后再切，避免覆盖
        // - 当前空闲或循环动画（idle/sleep/crash）-> 立即切（循环没有"结束"概念）
        // 交互事件（click/longpress/drag）走 play() 立即切，会清空 pending 队列
        function playQueued(name) {
            if (!_loaded) return play(name);
            // 当前在播非循环动画 -> 排队
            if (_currentState && !_isLoop(_currentState)) {
                // 替换之前的 pending（后来的优先，旧的直接 resolve 避免悬挂）
                if (_pendingAnimResolve) {
                    var oldResolve = _pendingAnimResolve;
                    _pendingAnimResolve = null;
                    try { oldResolve(); } catch (e) {}
                }
                _pendingAnim = name;
                return new Promise(function (resolve) {
                    _pendingAnimResolve = resolve;
                });
            }
            // 当前空闲或循环动画 -> 立即播
            return play(name);
        }

        function pause() { _paused = true; if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; } }
        function resume() { _paused = false; if (_currentState && !_rafId) { _lastFrameTime = 0; _rafId = requestAnimationFrame(_tick); } }

        function setFpsOverride(fps) { _fpsOverride = fps; }
        function clearFpsOverride() { _fpsOverride = null; }

        // 低性能模式：关闭 GPU 预热 + 抽帧（每 2 帧画 1 帧，视觉 12fps）
        // 关键：只跳过 drawImage，不改变 _getFrameInterval，时间基准保持 24fps
        // 所以动作时长不变，只是帧率视觉上变低（卡一点）
        // 在 manifest 加载前调用，影响 _preloadImages 的预热行为
        // 在 manifest 加载后调用，仅影响 _frameSkip（已加载的图不会重新预热）
        function setLowPerfMode(enabled) {
            _lowPerfMode = !!enabled;
            _frameSkip = _lowPerfMode ? 2 : 1;  // 24fps / 2 = 视觉 12fps
        }

        function getCurrentState() { return _currentState; }
        function isLoaded() { return _loaded; }

        function setFallbackEmoji(emoji) { _fallbackEmoji = emoji || '🐳'; }

        function destroy() {
            if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
            // settle 挂起的 Promise，避免调用方永久 await
            if (_pendingAnimResolve) { _pendingAnimResolve(); _pendingAnimResolve = null; }
            var cbs = _animDoneCallbacks;
            _animDoneCallbacks = [];
            for (var i = 0; i < cbs.length; i++) {
                try { cbs[i](); } catch (_) {}
            }
            _pendingAnim = null;
            _currentState = null;
            _manifest = null;
            _loaded = false;
            _images = {};
            _failedImages = {};
            if (_canvas && _canvas.parentNode) _canvas.parentNode.removeChild(_canvas);
            _canvas = null;
            _ctx2d = null;
            _container = null;
        }

        // 返回显示尺寸（CSS px），供漫游 bounds/命中检测等使用；
        // 显示尺寸由 setDisplaySize 维护（如 160），不再返回 manifest 帧分辨率（320）
        function getFrameSize() {
            if (!_manifest) return 120;
            return _displayWidth || _manifest.frameWidth || _manifest.frameHeight || 120;
        }

        // 像素级透明度命中检测：判断屏幕坐标 (clientX, clientY) 是否命中桌宠非透明像素
        // 用于点击/拖拽交互：透明区域（如桌宠四周的留白）不响应交互
        // 阈值 alphaThreshold：0-255，小于等于此值视为透明（默认 30，过滤掉抗锯齿边缘）
        function hitTest(clientX, clientY, alphaThreshold) {
            // manifest 未加载时 canvas 是空白透明，hitTest 会判定所有点击为透明 -> 拒绝交互
            // 此时应该放行，让用户在 manifest 加载延迟期间仍能点击/拖拽桌宠
            if (!_loaded || !_canvas || !_ctx2d) return true;
            var rect = _canvas.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return true;
            // 屏幕坐标转 canvas 内部分辨率坐标（canvas.width 可能 ≠ rect.width）
            var sx = (clientX - rect.left) / rect.width;
            var sy = (clientY - rect.top) / rect.height;
            if (sx < 0 || sx > 1 || sy < 0 || sy > 1) return false;  // 超出 canvas 范围
            var px = Math.floor(sx * _canvas.width);
            var py = Math.floor(sy * _canvas.height);
            try {
                // getImageData 1x1 像素读 alpha 通道
                var data = _ctx2d.getImageData(px, py, 1, 1).data;
                var alpha = data[3];
                return alpha > (alphaThreshold != null ? alphaThreshold : 30);
            } catch (e) {
                // 跨域或 canvas 被清空时 fallback 放行
                return true;
            }
        }

        return {
            mount: mount,
            getElement: getElement,
            setBasePath: setBasePath,
            setDisplaySize: setDisplaySize,
            loadManifest: loadManifest,
            play: play,
            playQueued: playQueued,
            pause: pause,
            resume: resume,
            setFpsOverride: setFpsOverride,
            clearFpsOverride: clearFpsOverride,
            setLowPerfMode: setLowPerfMode,
            getCurrentState: getCurrentState,
            isLoaded: isLoaded,
            getFrameSize: getFrameSize,
            hitTest: hitTest,
            setFallbackEmoji: setFallbackEmoji,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createSprites = createSprites;
})(window);
