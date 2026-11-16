// petActivityZone.js — 活动区域框选与边界约束
(function (global) {
    'use strict';

    var SETTINGS_FILE = 'deepseekPet/settings.json';
    var _bounds = null;
    var _onSaveCallback = null;  // 由 petController 注入，委托 petSettings 写盘
    var _petSize = 120;  // 默认尺寸，由 controller 注入
    var _activeOverlay = null;  // 当前进行中的选择 overlay，避免多次 startSelection 创建多个
    var _lastWinW = 0;  // 上次窗口宽度，用于 resize 时等比例缩放 bounds
    var _lastWinH = 0;  // 上次窗口高度

    function createActivityZone() {
        var _loadPromise = null;
        var _saveDebounceTimer = null;  // resize 写盘防抖句柄

        function init() {
            _lastWinW = window.innerWidth;
            _lastWinH = window.innerHeight;
            _loadPromise = _loadBounds();
            return _loadPromise;
        }

        function whenReady() {
            return _loadPromise || Promise.resolve();
        }

        function setSaveCallback(cb) {
            _onSaveCallback = cb;
        }

        function setPetSize(size) { _petSize = size || 120; }

        function _debouncedSaveBounds() {
            if (_saveDebounceTimer) clearTimeout(_saveDebounceTimer);
            _saveDebounceTimer = setTimeout(function () {
                _saveDebounceTimer = null;
                if (_onSaveCallback) {
                    _onSaveCallback({ activityBounds: _bounds });
                }
            }, 500);
        }

        function _getDataDir() {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                return global.AEShared.getDataDir().dir;
            }
            return '';
        }

        function _getSettingsPath() {
            var dir = _getDataDir();
            if (!dir) return null;
            return dir.replace(/\\/g, '/') + '/' + SETTINGS_FILE;
        }

        function _loadBounds() {
            var p = _getSettingsPath();
            if (!p) return Promise.resolve();
            try {
                if (typeof AEFS !== 'undefined' && AEFS.readFile) {
                    return AEFS.readFile(p).then(function (content) {
                        if (content) {
                            var data = JSON.parse(content);
                            if (data.activityBounds) {
                                _bounds = data.activityBounds;
                            }
                        }
                    }).catch(function (e) {
                        console.warn('[petActivityZone] load bounds failed: ' + e);
                    });
                }
            } catch (e) {
                console.warn('[petActivityZone] load bounds failed: ' + e);
            }
            return Promise.resolve();
        }

        function _saveBounds(bounds) {
            _bounds = bounds;
            // 委托 petSettings 统一写盘，避免互相覆盖
            if (_onSaveCallback) {
                _onSaveCallback({ activityBounds: bounds });
            }
        }

        function startSelection(onComplete) {
            // 已有进行中的选择 overlay 时先移除，避免多次调用创建多个叠加
            if (_activeOverlay) {
                _removeOverlay(_activeOverlay);
                _activeOverlay = null;
            }
            var overlay = document.createElement('div');
            overlay.className = 'dspet-zone-selector';
            _activeOverlay = overlay;

            // 初始框：优先继承上次保存的 bounds，没有则用窗口中央 60% 宽 × 60% 高
            // 继承的 bounds 可能因窗口缩放超出当前窗口，需钳制到窗口内
            var winW = window.innerWidth;
            var winH = window.innerHeight;
            var initX, initY, initW, initH;
            if (_bounds && _bounds.w > 0 && _bounds.h > 0) {
                initX = _bounds.x;
                initY = _bounds.y;
                initW = _bounds.w;
                initH = _bounds.h;
                // 钳制到当前窗口内（窗口可能已缩小）
                if (initX < 0) initX = 0;
                if (initY < 0) initY = 0;
                if (initX + initW > winW) initW = winW - initX;
                if (initY + initH > winH) initH = winH - initY;
                if (initW < 100) initW = 100;
                if (initH < 100) initH = 100;
                // 窗口大幅缩小后继承的 x/y 可能整体位于窗外（initX >= winW 时上面的
                // 裁剪只影响 w），钳制回窗口内，避免初始框完全不可见
                if (initX > winW - initW) initX = Math.max(0, winW - initW);
                if (initY > winH - initH) initY = Math.max(0, winH - initH);
            } else {
                initW = Math.max(200, Math.round(winW * 0.6));
                initH = Math.max(200, Math.round(winH * 0.6));
                initX = Math.round((winW - initW) / 2);
                initY = Math.round((winH - initH) / 2);
            }

            var box = document.createElement('div');
            box.className = 'dspet-zone-box';
            box.style.left = initX + 'px';
            box.style.top = initY + 'px';
            box.style.width = initW + 'px';
            box.style.height = initH + 'px';
            overlay.appendChild(box);

            // 4 个角的调整柄
            var handles = [
                { cls: 'nw', dx: -1, dy: -1 },  // 左上
                { cls: 'ne', dx:  1, dy: -1 },  // 右上
                { cls: 'sw', dx: -1, dy:  1 },  // 左下
                { cls: 'se', dx:  1, dy:  1 }   // 右下
            ];
            for (var i = 0; i < handles.length; i++) {
                var h = document.createElement('div');
                h.className = 'dspet-zone-handle ' + handles[i].cls;
                h.dataset.dx = handles[i].dx;
                h.dataset.dy = handles[i].dy;
                box.appendChild(h);
            }

            // 顶部 hint：操作说明 + 确认/取消按钮
            var hint = document.createElement('div');
            hint.className = 'dspet-zone-hint';
            hint.innerHTML = AEI18n.html('<span>拖拽四角调整大小，拖拽框内移动位置</span>') +
                AEI18n.html('<label class="dspet-zone-blur-toggle"><input type="checkbox" id="dspetZoneBlur" checked><span>模糊背景</span></label>') +
                AEI18n.html('<button type="button" data-act="confirm">确认</button>') +
                AEI18n.html('<button type="button" data-act="skip">跳过</button>');
            overlay.appendChild(hint);

            // 默认开启模糊压暗背景
            overlay.classList.add('blur');
            // 复选框控制：切换 overlay 的 .blur 类
            var blurCheckbox = hint.querySelector('#dspetZoneBlur');
            if (blurCheckbox) {
                blurCheckbox.addEventListener('change', function () {
                    if (this.checked) overlay.classList.add('blur');
                    else overlay.classList.remove('blur');
                });
            }

            // 拖拽状态：mode=move 移动整体, mode=resize 调整大小
            var dragMode = null;
            var dragHandle = null;
            var startMx = 0, startMy = 0;
            var startBox = { x: 0, y: 0, w: 0, h: 0 };

            function _readBox() {
                return {
                    x: parseInt(box.style.left, 10) || 0,
                    y: parseInt(box.style.top, 10) || 0,
                    w: parseInt(box.style.width, 10) || 0,
                    h: parseInt(box.style.height, 10) || 0
                };
            }
            function _applyBox(b) {
                box.style.left = b.x + 'px';
                box.style.top = b.y + 'px';
                box.style.width = b.w + 'px';
                box.style.height = b.h + 'px';
            }

            // 拖拽事件绑定到 document：鼠标移出扩展区域（如拖到面板外）仍能持续追踪
            // 若绑在 overlay 上 + mouseleave 清状态，鼠标移出再回来就不跟手
            function _onDragMove(e) {
                if (!dragMode) return;
                var dx = e.clientX - startMx;
                var dy = e.clientY - startMy;
                var b = { x: startBox.x, y: startBox.y, w: startBox.w, h: startBox.h };
                // 窗口边界：选区框不允许拖出可视区域
                var winW = window.innerWidth;
                var winH = window.innerHeight;
                if (dragMode === 'move') {
                    b.x = startBox.x + dx;
                    b.y = startBox.y + dy;
                    // 钳制：x/y 不允许让选区框超出窗口边界
                    if (b.x < 0) b.x = 0;
                    if (b.y < 0) b.y = 0;
                    if (b.x + b.w > winW) b.x = winW - b.w;
                    if (b.y + b.h > winH) b.y = winH - b.h;
                    // 极端情况：选区比窗口还大时，左上角对齐到 0
                    if (b.w > winW) b.x = 0;
                    if (b.h > winH) b.y = 0;
                } else if (dragMode === 'resize' && dragHandle) {
                    var hdx = parseInt(dragHandle.dataset.dx, 10);
                    var hdy = parseInt(dragHandle.dataset.dy, 10);
                    // 左侧/上侧柄拖动时，x/y 跟随鼠标，w/h 反向增减
                    if (hdx === -1) {
                        b.x = startBox.x + dx;
                        b.w = startBox.w - dx;
                    } else {
                        b.w = startBox.w + dx;
                    }
                    if (hdy === -1) {
                        b.y = startBox.y + dy;
                        b.h = startBox.h - dy;
                    } else {
                        b.h = startBox.h + dy;
                    }
                    // 最小尺寸限制：小于 100×100 时不继续收缩
                    if (b.w < 100) {
                        if (hdx === -1) b.x = startBox.x + (startBox.w - 100);
                        b.w = 100;
                    }
                    if (b.h < 100) {
                        if (hdy === -1) b.y = startBox.y + (startBox.h - 100);
                        b.h = 100;
                    }
                    // 边界钳制：选区框不允许超出窗口
                    // 右下溢出：裁剪 w/h 到窗口边界
                    if (b.x + b.w > winW) b.w = winW - b.x;
                    if (b.y + b.h > winH) b.h = winH - b.y;
                    // 左上溢出：x/y 归 0，w/h 扣减溢出量
                    if (b.x < 0) { b.w += b.x; b.x = 0; }
                    if (b.y < 0) { b.h += b.y; b.y = 0; }
                    // 钳制后再次保证最小尺寸（极端窗口比 100×100 还小时不强制）
                    // 强制最小尺寸后回缩 x/y：否则确认的 bounds 可越出窗口并被持久化
                    if (b.w < 100 && winW >= 100) {
                        b.w = 100;
                        if (b.x + b.w > winW) b.x = Math.max(0, winW - b.w);
                    }
                    if (b.h < 100 && winH >= 100) {
                        b.h = 100;
                        if (b.y + b.h > winH) b.y = Math.max(0, winH - b.h);
                    }
                }
                _applyBox(b);
            }

            function _endDrag() {
                dragMode = null;
                dragHandle = null;
                // 解绑 document 监听，避免内存泄漏
                document.removeEventListener('mousemove', _onDragMove);
                document.removeEventListener('mouseup', _endDrag);
            }

            overlay.addEventListener('mousedown', function (e) {
                // 点击按钮/复选框/label 时不启动拖拽
                if (e.target.tagName === 'BUTTON' || e.target.tagName === 'INPUT' || e.target.tagName === 'LABEL') return;
                startMx = e.clientX;
                startMy = e.clientY;
                startBox = _readBox();
                if (e.target.classList.contains('dspet-zone-handle')) {
                    dragMode = 'resize';
                    dragHandle = e.target;
                } else if (e.target === box || box.contains(e.target)) {
                    dragMode = 'move';
                } else {
                    return;
                }
                e.preventDefault();
                // 绑定到 document：鼠标移出 overlay/扩展区域仍能持续追踪
                // 清理函数挂到 overlay 上：拖拽进行中 overlay 被移除（destroy/确认）时
                // 由 _removeOverlay 解绑，避免 document 监听器残留
                overlay._dspetDragCleanup = function () {
                    document.removeEventListener('mousemove', _onDragMove);
                    document.removeEventListener('mouseup', _endDrag);
                };
                document.addEventListener('mousemove', _onDragMove);
                document.addEventListener('mouseup', _endDrag);
            });

            // 按钮点击：确认 / 跳过
            hint.addEventListener('click', function (e) {
                if (e.target.tagName !== 'BUTTON') return;
                var act = e.target.dataset.act;
                if (act === 'confirm') {
                    var b = _readBox();
                    if (b.w >= 100 && b.h >= 100) {
                        var bounds = { x: b.x, y: b.y, w: b.w, h: b.h };
                        _saveBounds(bounds);
                        _removeOverlay(overlay);
                        _activeOverlay = null;
                        if (onComplete) onComplete(bounds);
                    }
                } else if (act === 'skip') {
                    _bounds = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
                    _saveBounds(_bounds);
                    _removeOverlay(overlay);
                    _activeOverlay = null;
                    if (onComplete) onComplete(_bounds);
                }
            });

            document.body.appendChild(overlay);
        }

        function _removeOverlay(overlay) {
            if (!overlay) return;
            // 解绑选区拖拽期间绑到 document 的监听（拖拽进行中移除 overlay 的场景）
            if (typeof overlay._dspetDragCleanup === 'function') {
                overlay._dspetDragCleanup();
                overlay._dspetDragCleanup = null;
            }
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        }

        function getBounds() { return _bounds; }

        // 暴露/设置上次窗口尺寸：让 controller 在 resize 时先读取计算 sx/sy 缩放桌宠位置，
        // 再调 clampToWindow 缩放 bounds，保证 petPos 和 bounds 用同一个比例
        function getLastWinSize() {
            return { w: _lastWinW, h: _lastWinH };
        }
        function setLastWinSize(w, h) {
            _lastWinW = w;
            _lastWinH = h;
        }

        function clampToBounds(x, y) {
            if (!_bounds) return { x: x, y: y };
            var maxX = _bounds.x + _bounds.w - _petSize;
            var maxY = _bounds.y + _bounds.h - _petSize;
            var minX = _bounds.x;
            var minY = _bounds.y;
            return {
                x: Math.max(minX, Math.min(maxX, x)),
                y: Math.max(minY, Math.min(maxY, y))
            };
        }

        // 窗口 resize 时按比例缩放 bounds，让活动区域跟随面板大小变化
        // 桌宠位置也由 controller 按相同比例缩放，保持相对位置不变（视觉上不瞬移）
        function clampToWindow() {
            var curW = window.innerWidth;
            var curH = window.innerHeight;
            // 首次或旧尺寸为 0 时只记录，不缩放
            if (_lastWinW <= 0 || _lastWinH <= 0) {
                _lastWinW = curW;
                _lastWinH = curH;
                return;
            }
            // 尺寸没变就不处理
            if (_lastWinW === curW && _lastWinH === curH) return;
            // bounds 未加载时仍需更新 _lastWinW/_lastWinH，否则下次 resize 用错基准
            // （controller 的 _resizeHandler 已根据旧 _lastWinW/H 缩放了 petPos，此处只更新基准）
            if (!_bounds) {
                _lastWinW = curW;
                _lastWinH = curH;
                return;
            }
            // 按比例缩放 bounds
            var sx = curW / _lastWinW;
            var sy = curH / _lastWinH;
            _bounds.x = Math.round(_bounds.x * sx);
            _bounds.y = Math.round(_bounds.y * sy);
            _bounds.w = Math.round(_bounds.w * sx);
            _bounds.h = Math.round(_bounds.h * sy);
            // 边界保护：不超过窗口、不小于 100x100
            if (_bounds.x < 0) { _bounds.w += _bounds.x; _bounds.x = 0; }
            if (_bounds.y < 0) { _bounds.h += _bounds.y; _bounds.y = 0; }
            if (_bounds.x + _bounds.w > curW) _bounds.w = curW - _bounds.x;
            if (_bounds.y + _bounds.h > curH) _bounds.h = curH - _bounds.y;
            // 强制最小尺寸后回缩 x/y，避免 bounds 越出窗口
            if (_bounds.w < 100) {
                _bounds.w = 100;
                if (_bounds.x + _bounds.w > curW) _bounds.x = Math.max(0, curW - _bounds.w);
            }
            if (_bounds.h < 100) {
                _bounds.h = 100;
                if (_bounds.y + _bounds.h > curH) _bounds.y = Math.max(0, curH - _bounds.h);
            }
            _lastWinW = curW;
            _lastWinH = curH;
            _debouncedSaveBounds();
        }

        function reset() {
            _bounds = null;
        }

        // 面板卸载/flush 前把防抖窗口内未落盘的 bounds 修改交给 _onSaveCallback
        // （委托 petSettings.updateSettings → 随后的 settings.flush 同步落盘）。
        // 返回是否曾有待落盘修改；不清 _bounds 内存态——flush 可被取消（beforeunload
        // 被用户取消），模块须保持可用
        function flush() {
            if (!_saveDebounceTimer) return false;
            clearTimeout(_saveDebounceTimer);
            _saveDebounceTimer = null;
            if (_onSaveCallback) {
                _onSaveCallback({ activityBounds: _bounds });
                return true;
            }
            return false;
        }

        function destroy() {
            if (_activeOverlay) {
                _removeOverlay(_activeOverlay);
                _activeOverlay = null;
            }
            // 先 flush 防抖窗口内未落盘的 bounds 修改，再清理定时器
            // （对齐 petHistory/petMemory/petSettings 的 destroy flush 模式，否则 resize 后
            //  500ms 内销毁会静默丢失该次 bounds 修改；须在 petSettings.destroy 之前调用，
            //  让 flush 经 _onSaveCallback 委托 settings 写盘并由其 destroy 一并落盘）
            flush();
        }

        return {
            init: init,
            whenReady: whenReady,
            setSaveCallback: setSaveCallback,
            setPetSize: setPetSize,
            startSelection: startSelection,
            getBounds: getBounds,
            getLastWinSize: getLastWinSize,
            setLastWinSize: setLastWinSize,
            clampToBounds: clampToBounds,
            clampToWindow: clampToWindow,
            reset: reset,
            flush: flush,
            destroy: destroy
        };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createActivityZone = createActivityZone;
})(window);
