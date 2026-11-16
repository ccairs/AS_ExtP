(function (global) {
    // 分组框：套住多个节点的可拖拽/缩放框体。

    function createGroupRenderer(opts) {
        opts = opts || {};
        var worldEl = opts.worldEl;
        var graph = opts.graph;
        var viewport = opts.viewport;
        var callbacks = opts.callbacks || {};  // { onMoveEnd, onResizeEnd, onContextMenu, markDirty }

        var _groupEls = {};  // groupId → el

        function build(group) {
            var el = document.createElement('div');
            el.className = 'ng-group-box';
            el.dataset.groupId = group.id;
            el.style.left = group.x + 'px';
            el.style.top = group.y + 'px';
            el.style.width = group.w + 'px';
            el.style.height = group.h + 'px';
            if (group.color) {
                el.style.borderColor = group.color;
                el.style.backgroundColor = _hexToRgba(group.color, 0.06);
            }

            // 标题栏
            var head = document.createElement('div');
            head.className = 'ng-group-head';
            var titleSpan = document.createElement('span');
            titleSpan.className = 'ng-group-title';
            titleSpan.textContent = group.title || AEI18n.t('分组');
            head.appendChild(titleSpan);
            el.appendChild(head);

            // 备注气泡
            var note = document.createElement('div');
            note.className = 'ng-group-note';
            note.textContent = group.note || '';
            if (!group.note) note.classList.add('ng-hidden');
            el.appendChild(note);

            // 右下角 resize
            var handle = document.createElement('div');
            handle.className = 'ng-group-resize';
            el.appendChild(handle);

            // ── 框拖拽 → 子节点平移，点击标题 → 选中。多选时一起移动 ──
            head.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                if (e.target.closest('button') || e.target.closest('input') || e.target.closest('textarea')) return;
                e.preventDefault();
                e.stopPropagation();
                var startX = e.clientX, startY = e.clientY;
                var shiftKey = e.shiftKey;  // 记下 Shift 状态给 onSelect 用
                var vpScale = (viewport && viewport.scale != null) ? viewport.scale : 1;

                // ── 多选拖拽：所有选中项一起移动 ──
                var multiItems = callbacks.getMultiDragItems ? callbacks.getMultiDragItems(group.id) : null;
                if (multiItems && multiItems.length > 1) {
                    var moved2 = false;
                    var _raf2Pending = false;
                    var _lastCDx = 0, _lastCDy = 0;  // 子项移动用增量位移（moveChildren 内部 += 累加）
                    function onMove2(ev) {
                        if (!moved2) {
                            if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
                            moved2 = true;
                        }
                        var dx = (ev.clientX - startX) / vpScale;
                        var dy = (ev.clientY - startY) / vpScale;
                        for (var mi = 0; mi < multiItems.length; mi++) {
                            var item = multiItems[mi];
                            var nx = item.origX + dx, ny = item.origY + dy;
                            item.el.style.left = nx + 'px';
                            item.el.style.top = ny + 'px';
                            if (item.node) { item.node.x = nx; item.node.y = ny; }
                            if (item.group) { item.group.x = nx; item.group.y = ny; }
                        }
                        // 多选中有分组时，连带移动其子节点/子分组（跳过已在列表中的）
                        // _skipIds 同时含分组与节点 id：节点被选中时又挂在选中分组下，不能两种路径各移一次
                        var _skipIds = {};
                        for (var mi2 = 0; mi2 < multiItems.length; mi2++) {
                            if (multiItems[mi2].group) _skipIds[multiItems[mi2].group.id] = true;
                            if (multiItems[mi2].node) _skipIds[multiItems[mi2].node.id] = true;
                        }
                        var incDx = dx - _lastCDx, incDy = dy - _lastCDy;
                        _lastCDx = dx; _lastCDy = dy;
                        for (var mi2 = 0; mi2 < multiItems.length; mi2++) {
                            if (multiItems[mi2].group && callbacks.moveChildren) {
                                callbacks.moveChildren(multiItems[mi2].group.id, incDx, incDy, _skipIds);
                            }
                        }
                        if (!_raf2Pending) {
                            _raf2Pending = true;
                            requestAnimationFrame(function () {
                                _raf2Pending = false;
                                if (callbacks.onMoveEnd) callbacks.onMoveEnd();
                            });
                        }
                    }
                    function onUp2() {
                        window.removeEventListener('mousemove', onMove2);
                        window.removeEventListener('mouseup', onUp2);
                        if (!moved2 && callbacks.onSelect) callbacks.onSelect(group.id, shiftKey);
                        if (moved2) {
                            for (var mi = 0; mi < multiItems.length; mi++) {
                                var item = multiItems[mi];
                                // 0 是合法坐标，不能用 || 回退；x/y 统一 parseFloat
                                var fnx = parseFloat(item.el.style.left);
                                if (isNaN(fnx)) fnx = item.origX;
                                var fny = parseFloat(item.el.style.top);
                                if (isNaN(fny)) fny = item.origY;
                                if (item.node) { item.node.x = fnx; item.node.y = fny; }
                                if (item.group) { item.group.x = fnx; item.group.y = fny; }
                            }
                            if (callbacks.markDirty) callbacks.markDirty();
                            for (var mi = 0; mi < multiItems.length; mi++) {
                                var id2 = multiItems[mi].node ? multiItems[mi].node.id : (multiItems[mi].group ? multiItems[mi].group.id : null);
                                if (id2 && callbacks.onDragEnd) callbacks.onDragEnd(id2);
                            }
                        }
                    }
                    window.addEventListener('mousemove', onMove2);
                    window.addEventListener('mouseup', onUp2);
                    return;
                }

                // ── 单选拖拽：仅移动当前分组及其子节点 ──
                var origGroupX = group.x, origGroupY = group.y;
                var origNodePos = {};
                var ids = group.childIds || [];
                for (var i = 0; i < ids.length; i++) {
                    var n = graph.getNode(ids[i]);
                    if (n) origNodePos[ids[i]] = { x: n.x, y: n.y };
                }
                var cgIds = group.childGroupIds || [];
                var moved = false;
                var _rafPending = false;
                var _lastDx = 0, _lastDy = 0;

                function onMove(ev) {
                    if (!moved) {
                        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
                        moved = true;
                    }
                    var dx = (ev.clientX - startX) / vpScale;
                    var dy = (ev.clientY - startY) / vpScale;
                    var newLeft = origGroupX + dx;
                    var newTop = origGroupY + dy;
                    el.style.left = newLeft + 'px';
                    el.style.top = newTop + 'px';
                    group.x = newLeft;
                    group.y = newTop;
                    for (var i = 0; i < ids.length; i++) {
                        var orig = origNodePos[ids[i]];
                        if (!orig) continue;
                        var cn = graph.getNode(ids[i]);
                        if (!cn) continue;
                        cn.x = orig.x + dx; cn.y = orig.y + dy;
                        var cel = worldEl.querySelector('[data-node-id="' + ids[i] + '"]');
                        if (cel) { cel.style.left = cn.x + 'px'; cel.style.top = cn.y + 'px'; }
                    }
                    if (callbacks.onMoveGroup) {
                        for (var cg = 0; cg < cgIds.length; cg++) callbacks.onMoveGroup(cgIds[cg], dx, dy);
                    }
                    // 连线/小地图用 RAF 节流，避免每帧重绘
                    _lastDx = dx; _lastDy = dy;
                    if (!_rafPending) {
                        _rafPending = true;
                        requestAnimationFrame(function () {
                            _rafPending = false;
                            if (callbacks.onMoveEnd) callbacks.onMoveEnd();
                        });
                    }
                }
                function onUp() {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    if (!moved && callbacks.onSelect) callbacks.onSelect(group.id, shiftKey);
                    if (moved) {
                        if (callbacks.markDirty) callbacks.markDirty();
                        if (callbacks.onDragEnd) callbacks.onDragEnd(group.id);
                    }
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });

            // ── resize ──
            handle.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                var sx = e.clientX, sy = e.clientY;
                var ow = parseFloat(el.style.width) || group.w;
                var oh = parseFloat(el.style.height) || group.h;
                var vpScale = (viewport && viewport.scale != null) ? viewport.scale : 1;
                var MIN = 120;
                function onMove(ev) {
                    var nw = Math.max(MIN, ow + (ev.clientX - sx) / vpScale);
                    var nh = Math.max(MIN, oh + (ev.clientY - sy) / vpScale);
                    el.style.width = nw + 'px'; el.style.height = nh + 'px';
                    group.w = nw; group.h = nh;
                    if (callbacks.onResizeEnd) callbacks.onResizeEnd();
                }
                function onUp() {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    if (callbacks.markDirty) callbacks.markDirty();
                    if (callbacks.onResizeEnd) callbacks.onResizeEnd(group.id);
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });

            // ── 标题双击重命名 ──
            function bindTitleDblClick() {
                titleSpan.addEventListener('dblclick', function (ev) {
                    ev.stopPropagation();
                    var inp = document.createElement('input');
                    inp.type = 'text';
                    inp.className = 'ng-group-title-input';
                    inp.value = group.title || '';
                    titleSpan.replaceWith(inp);
                    inp.focus(); inp.select();
                    function commit() {
                        group.title = inp.value.trim() || AEI18n.t('分组');
                        var sp = document.createElement('span');
                        sp.className = 'ng-group-title';
                        sp.textContent = group.title;
                        inp.replaceWith(sp);
                        titleSpan = sp;
                        bindTitleDblClick();
                        if (callbacks.markDirty) callbacks.markDirty();
                    }
                    inp.addEventListener('blur', commit);
                    inp.addEventListener('keydown', function (ke) {
                        if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
                    });
                });
            }
            bindTitleDblClick();

            // ── 备注双击编辑 ──
            note.addEventListener('dblclick', function (ev) {
                ev.stopPropagation();
                var inp = document.createElement('input');
                inp.type = 'text';
                inp.className = 'ng-group-note-input';
                inp.value = group.note || '';
                inp.placeholder = AEI18n.t('备注…');
                note.replaceWith(inp);
                inp.focus();
                function commit() {
                    group.note = inp.value.trim();
                    note.textContent = group.note;
                    note.classList.toggle('ng-hidden', !group.note);
                    inp.replaceWith(note);
                    if (callbacks.markDirty) callbacks.markDirty();
                }
                inp.addEventListener('blur', commit);
                inp.addEventListener('keydown', function (ke) {
                    if (ke.key === 'Enter') { ke.preventDefault(); commit(); }
                });
            });

            // ── 右键 ──
            el.addEventListener('contextmenu', function (ev) {
                ev.preventDefault();
                ev.stopPropagation();
                if (callbacks.onContextMenu) callbacks.onContextMenu(group, ev.clientX, ev.clientY);
            });

            worldEl.appendChild(el);
            _groupEls[group.id] = el;
            return el;
        }

        function render(group) {
            var old = _groupEls[group.id];
            if (old) old.remove();
            return build(group);
        }

        function remove(groupId) {
            var el = _groupEls[groupId];
            if (el) { el.remove(); delete _groupEls[groupId]; }
        }

        function _hexToRgba(hex, alpha) {
            if (!hex || hex[0] !== '#') return 'transparent';
            return 'rgba(' + parseInt(hex.slice(1,3), 16) + ',' + parseInt(hex.slice(3,5), 16) + ',' + parseInt(hex.slice(5,7), 16) + ',' + alpha + ')';
        }

        function setColor(groupId, color) {
            var el = _groupEls[groupId];
            if (el) {
                el.style.borderColor = color || 'var(--border)';
                el.style.backgroundColor = color ? _hexToRgba(color, 0.06) : '';
            }
        }

        function getEl(groupId) { return _groupEls[groupId]; }

        function destroy() {
            Object.keys(_groupEls).forEach(function (k) { _groupEls[k].remove(); });
            _groupEls = {};
        }

        return { render: render, remove: remove, setColor: setColor, getEl: getEl, destroy: destroy };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createGroupRenderer = createGroupRenderer;
})(window);
