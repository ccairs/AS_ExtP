(function (global) {
    // 画布控制器：右键菜单加节点、连线、节点右键菜单、调 executor
    // opts: { canvasEl, worldEl, graph, nodeDefs, viewport, callbacks }
    //   callbacks: { onAddNode, onConnect, onConnectBatch, getSelectedNodeIds,
    //                onRemove, onCopy, onColorChange, onNoteChange, onEdit }

    // ── 多选批量接线判定（纯函数，不碰 DOM；拖新线与拖线右键「创建并连线」共用）──
    // 选中集按「同端口名 + 类型兼容」复制拖线端点的连接：
    //   · 拖线端点所在节点在选中集里 → 复制该端（输出端起拖 = 选中集全部接入同一目标口；
    //     输入端起拖 = 同一上游接入选中集各节点的同名输入口）；
    //   · 起点不在选中集、松手落点在时按落点端复制（从目标口反向拖向选中的媒体节点）。
    // 返回 { conns, primary, fallback }：
    //   conns 按选中先后排列（primary 指向拖线本身的连接），该顺序即 imageOrder/videoOrder 的初始序；
    //   fallback='single-port' 表示目标输入口只收一条入边（端口类型非 []），只接拖出的那一条。
    // 单值输入口沿用 graph.connect 的替换语义：批量派生到各节点单值口时，该口既有上游会被替换。
    function planMultiConnect(graph, nodeDefs, selectedIds, anchor, hit) {
        var out = { conns: [], primary: 0, fallback: '' };
        if (!graph || !nodeDefs || !anchor || !hit || !anchor.nodeId || !hit.nodeId) return out;
        // 拖线两端：up=上游（输出端）、down=下游（输入端）
        var up = anchor.side === 'right'
            ? { nodeId: anchor.nodeId, portName: anchor.portName }
            : { nodeId: hit.nodeId, portName: hit.portName };
        var down = anchor.side === 'right'
            ? { nodeId: hit.nodeId, portName: hit.portName }
            : { nodeId: anchor.nodeId, portName: anchor.portName };
        var single = { from: up.nodeId, fromPort: up.portName, to: down.nodeId, toPort: down.portName };
        out.conns = [single];
        out.primary = 0;

        var sel = normalizeSelectedIds(graph, selectedIds);
        if (sel.length < 2) return out;
        var rep = '';
        if (sel.indexOf(anchor.nodeId) >= 0) rep = anchor.side === 'right' ? 'up' : 'down';
        else if (sel.indexOf(hit.nodeId) >= 0) rep = anchor.side === 'right' ? 'down' : 'up';
        if (!rep) return out;

        var portRules = global.AEComfyUI && global.AEComfyUI.ports;
        if (!portRules || !portRules.canConnect) return out;
        var upType = graph.portTypeOf(up.nodeId, up.portName);
        var downType = graph.portTypeOf(down.nodeId, down.portName);
        var byId = {};
        var singleAt = -1;
        for (var i = 0; i < sel.length; i++) {
            var sid = sel[i];
            if (sid === up.nodeId || sid === down.nodeId) {
                if (singleAt < 0) singleAt = i;
                continue;
            }
            var port = findPortDef(graph, nodeDefs, sid, rep === 'up' ? 'out' : 'in',
                rep === 'up' ? up.portName : down.portName);
            if (!port) continue;
            if (rep === 'up') {
                if (!portRules.canConnect(port.type, downType)) continue;
                byId[sid] = { from: sid, fromPort: up.portName, to: down.nodeId, toPort: down.portName };
            } else {
                if (!portRules.canConnect(upType, port.type)) continue;
                byId[sid] = { from: up.nodeId, fromPort: up.portName, to: sid, toPort: down.portName };
            }
        }
        if (rep === 'up' && Object.keys(byId).length > 0 && String(downType).indexOf('[]') === -1) {
            out.fallback = 'single-port';
            return out;
        }
        // sel 含拖线端点（rep 判定前提），循环必命中端点 → singleAt 必被置位
        var conns = [];
        var primary = 0;
        for (var j = 0; j < sel.length; j++) {
            if (j === singleAt) {
                primary = conns.length;
                conns.push(single);
                continue;
            }
            if (byId[sel[j]]) conns.push(byId[sel[j]]);
        }
        out.conns = conns;
        out.primary = primary;
        return out;
    }

    // 选中 id 归一化：去重、剔除分组 id（g_ 前缀）与图上不存在的节点
    function normalizeSelectedIds(graph, selectedIds) {
        var out = [];
        var seen = {};
        if (!selectedIds) return out;
        for (var i = 0; i < selectedIds.length; i++) {
            var id = selectedIds[i];
            if (!id || seen[id]) continue;
            if (String(id).indexOf('g_') === 0) continue;
            if (!graph.getNode(id)) continue;
            seen[id] = true;
            out.push(id);
        }
        return out;
    }

    // 查节点某侧的同名端口定义；不存在返回 null（端口名不同或该节点无此端口都不参与批量）
    function findPortDef(graph, nodeDefs, nodeId, side, portName) {
        var node = graph.getNode(nodeId);
        if (!node) return null;
        var def = null;
        for (var i = 0; i < nodeDefs.length; i++) {
            if (nodeDefs[i].type === node.type) { def = nodeDefs[i]; break; }
        }
        if (!def) return null;
        var list = side === 'in' ? (def.inputs || []) : (def.outputs || []);
        for (var p = 0; p < list.length; p++) {
            if (list[p].name === portName) return list[p];
        }
        return null;
    }

    // 框选读序（纯函数）：用节点左上角分行，top 差 ≤ ROW_TOL 视为同一行，行内按 left。
    // 框选命中集经此排序后写入选中集，多选批量接线的「选中先后」在框选场景才是可见、可复现的。
    var READING_ORDER_ROW_TOL = 24;
    function sortCanvasReadingOrder(items) {
        var list = [];
        var src = items || [];
        for (var i = 0; i < src.length; i++) {
            if (!src[i] || src[i].id == null) continue;
            list.push(src[i]);
        }
        list.sort(function (a, b) { return (a.top - b.top) || (a.left - b.left); });
        var rows = [];
        for (var j = 0; j < list.length; j++) {
            var row = rows[rows.length - 1];
            if (!row || list[j].top - row.top > READING_ORDER_ROW_TOL) {
                row = { top: list[j].top, items: [] };
                rows.push(row);
            }
            row.items.push(list[j]);
        }
        var out = [];
        for (var r = 0; r < rows.length; r++) {
            rows[r].items.sort(function (a, b) { return a.left - b.left; });
            for (var k = 0; k < rows[r].items.length; k++) out.push(rows[r].items[k].id);
        }
        return out;
    }

    // 批量计划中被替换的既有上游条数（纯函数，连接前调用）：单值输入口只允许一条入边，
    // graph.connect 会静默替换该口既有入边；数组端口（类型名含 []）可多入边，不计替换。
    // 完全相同的边由 graph.connect 去重（返回旧边 id、不替换），不计入。
    function countReplacedUpstreams(graph, conns) {
        if (!graph || !conns || !conns.length) return 0;
        var edges = graph.edges ? graph.edges() : [];
        var seenPorts = {};
        var n = 0;
        for (var i = 0; i < conns.length; i++) {
            var c = conns[i];
            if (!c) continue;
            var portKey = c.to + '|' + c.toPort;
            if (seenPorts[portKey]) continue;
            seenPorts[portKey] = true;
            var toType = graph.portTypeOf ? graph.portTypeOf(c.to, c.toPort) : '';
            if (String(toType).indexOf('[]') >= 0) continue;
            for (var j = 0; j < edges.length; j++) {
                var e = edges[j];
                if (e.to !== c.to || e.toPort !== c.toPort) continue;
                if (e.from === c.from && e.fromPort === c.fromPort) continue;
                n++;
                break;
            }
        }
        return n;
    }

    // 按计划逐条连线（纯逻辑，不碰 DOM）：applied=新增边，existing=图上已存在的同一条边
    // （graph.connect 对完全重复的边返回旧 id、不新增），error=最后一次失败原因。
    function applyConnectPlan(graph, conns) {
        var applied = [];
        var existing = [];
        var lastErr = null;
        var before = {};
        var pre = graph && graph.edges ? graph.edges() : [];
        for (var b = 0; b < pre.length; b++) before[pre[b].id] = true;
        for (var i = 0; i < (conns || []).length; i++) {
            try {
                var eid = graph.connect(conns[i].from, conns[i].fromPort, conns[i].to, conns[i].toPort);
                if (eid != null && before[eid]) existing.push(conns[i]);
                else applied.push(conns[i]);
            } catch (err) {
                lastErr = err;
                console.warn('[ComfyUI Canvas] 连线失败:', err.message);
            }
        }
        return { applied: applied, existing: existing, error: lastErr };
    }

    function createCanvasController(opts) {
        opts = opts || {};
        var canvasEl = opts.canvasEl;
        var worldEl = opts.worldEl;
        var graph = opts.graph;
        var nodeDefs = opts.nodeDefs || [];
        var viewport = opts.viewport;
        var callbacks = opts.callbacks || {};
        var nodeEls = {};

        // 空白处右键菜单（加节点）
        var menu = document.createElement('div');
        menu.className = 'ng-context-menu ng-hidden';
        document.body.appendChild(menu);

        // 节点右键菜单（变色/复制/删除/备注/编辑）
        var nodeMenu = document.createElement('div');
        nodeMenu.className = 'ng-context-menu ng-hidden';
        document.body.appendChild(nodeMenu);

        // 连线 SVG 层：挂 canvasEl（固定覆盖层），屏幕坐标，不随 world 变换。
        // 之前挂 worldEl + world 局部坐标换算受 0 尺寸/transform 影响致临时线不可见。
        var edgeLayer = global.AEComfyUI.createEdgeLayer(canvasEl, viewport);

        // 当前选中节点 id 列表：顺序即选中先后（canvasIndex 按选中写入的对象键插入序返回，
        // 分组 id 已在该侧过滤）。
        function _selectedIds() {
            return callbacks.getSelectedNodeIds ? (callbacks.getSelectedNodeIds() || []) : [];
        }

        function redrawEdges() {
            if (dragging) return;   // 拖线中跳过，防 redrawAll 把 #ng-temp-edge 清掉
            edgeLayer.redrawAll(graph, nodeEls, _selectedIds());
        }

        // 只切换可见线上的选中高亮类，不重画整层：选中状态变化时即时生效，拖线中调用也不影响临时线。
        function refreshSelectionHighlight() {
            var selIds = _selectedIds();
            var byId = {};
            var edges = graph.edges();
            for (var i = 0; i < edges.length; i++) byId[edges[i].id] = edges[i];
            var paths = edgeLayer.svg.querySelectorAll('.ng-edge');
            var hit = global.AEComfyUI && global.AEComfyUI.edgeInSelection;
            for (var j = 0; j < paths.length; j++) {
                var on = hit ? hit(byId[paths[j].id], selIds) : false;
                if (on) paths[j].classList.add('ng-edge-sel');
                else paths[j].classList.remove('ng-edge-sel');
            }
        }

        // ── 多选批量连线：拖线预览 / 落图 / 收尾 ──
        var TEMP_EDGE_ID = 'ng-temp-edge';

        // 临时预览线整体清除（primary + 批量派生线；按 id 前缀扫，防残留）
        function _clearTempEdges() {
            var temps = edgeLayer.svg.querySelectorAll('[id^="ng-temp-edge"]');
            for (var i = 0; i < temps.length; i++) temps[i].remove();
        }

        // 画拖线预览：startPos 锚在起点节点（anchorId）一侧、endPos 锚在落点节点（hitId）一侧，
        // 派生连接按各自端点取锚点；端点落在起点/落点节点上时复用这两个锚点位置（与真实连线同向）。
        function _drawTempLines(conns, primaryIdx, startPos, endPos, portType, anchorId, hitId) {
            edgeLayer.drawEdge(TEMP_EDGE_ID, startPos, endPos, portType, false);
            var keep = {};
            keep[TEMP_EDGE_ID] = true;
            if (conns && conns.length > 1) {
                for (var i = 0; i < conns.length; i++) {
                    if (i === primaryIdx) continue;
                    var c = conns[i];
                    var fromEl = nodeEls[c.from];
                    var toEl = nodeEls[c.to];
                    if (!fromEl || !toEl) continue;
                    var fromPos = c.from === anchorId ? startPos
                        : (c.from === hitId ? endPos : edgeLayer.portPos(fromEl, c.fromPort, 'out', 0, 1));
                    var toPos = c.to === anchorId ? startPos
                        : (c.to === hitId ? endPos : edgeLayer.portPos(toEl, c.toPort, 'in', 0, 1));
                    var id = TEMP_EDGE_ID + '-' + i;
                    keep[id] = true;
                    edgeLayer.drawEdge(id, fromPos, toPos, portType, false);
                }
            }
            // 多余的旧预览线（目标切换/选中变化后派生线变少）
            var stale = edgeLayer.svg.querySelectorAll('[id^="ng-temp-edge"]');
            for (var s = 0; s < stale.length; s++) {
                if (!keep[stale[s].id]) stale[s].remove();
            }
        }

        // 拖线判定：选中集 + 拖线端点 → 批量连接计划（无判定能力时返回 null，调用方退回单条）
        function _planDragConnects(nodeId, side, fromPort, ti) {
            var planner = global.AEComfyUI && global.AEComfyUI.planMultiConnect;
            if (!planner || !ti || !ti.nodeId) return null;
            var selIds = callbacks.getSelectedNodeIds ? callbacks.getSelectedNodeIds() : [];
            return planner(graph, nodeDefs, selIds,
                { nodeId: nodeId, side: side, portName: fromPort },
                { nodeId: ti.nodeId, portName: ti.portName });
        }

        // 连线收尾：单条走 onConnect（既有语义），多条走 onConnectBatch（一次落盘/一条历史）
        function _emitConnects(conns) {
            if (!conns || !conns.length) return;
            if (conns.length === 1) {
                if (callbacks.onConnect) callbacks.onConnect(conns[0].from, conns[0].to);
                return;
            }
            if (callbacks.onConnectBatch) { callbacks.onConnectBatch(conns); return; }
            for (var i = 0; i < conns.length; i++) {
                if (callbacks.onConnect) callbacks.onConnect(conns[i].from, conns[i].to);
            }
        }

        // 目标输入口只收一条边（非 [] 类型端口）：计划已回退单条，给用户可见提示
        function _warnSinglePortFallback(plan) {
            if (!plan || plan.fallback !== 'single-port') return;
            console.warn('[ComfyUI Canvas] 目标输入口只支持一条连线，仅接入拖出的那一个');
            if (global.AEToast) AEToast.warn(AEI18n.t('该输入口只能接 1 条线，已只接入拖出的那一个'));
        }

        // 批量接线替换既有上游：单值输入口只有一条入边，graph.connect 会替换该口既有连线；
        // 发生替换时提示一次被替换的输入口数量（单条连线替换由用户直接可见，不提示）。
        function _warnReplacedUpstreams(plan, replaced) {
            if (!plan || !plan.conns || plan.conns.length < 2 || !replaced) return;
            console.warn('[ComfyUI Canvas] 批量接线替换既有上游：' + replaced + ' 个输入口');
            if (global.AEToast) AEToast.warn(AEI18n.t('已替换 ') + replaced + AEI18n.t(' 个输入口的上游连线'));
        }

        // 批量落图部分失败：如实报已接入（新增 + 已存在）与未接入条数（否则用户以为全部接入）
        function _warnPartialConnect(plan, res) {
            if (!plan || !res || !plan.conns || !plan.conns.length) return;
            var ok = (res.applied ? res.applied.length : 0) + (res.existing ? res.existing.length : 0);
            if (ok >= plan.conns.length) return;
            console.warn('[ComfyUI Canvas] 批量连线部分失败：' + ok + '/' + plan.conns.length);
            if (global.AEToast && ok) {
                AEToast.warn(AEI18n.t('已接入 ') + ok + AEI18n.t(' 条，') + (plan.conns.length - ok) + AEI18n.t(' 条未接入'));
            }
        }

        // 框选（Ctrl+左键在空白处拖拽拉框）
        var rb = document.createElement('div');
        rb.className = 'ng-rubber-band ng-hidden';
        canvasEl.appendChild(rb);
        var rbStart = null;
        var rbActive = false;

        function _rectsOverlap(a, b) {
            return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
        }

        function onRbMouseDown(e) {
            if (!e.ctrlKey || e.button !== 0) return;
            var t = e.target;
            if (t && t.closest && (t.closest('.ng-node') || t.closest('.ng-port') || t.closest('.ng-gen-input-container') || t.classList.contains('ng-edge-hit'))) return;
            e.preventDefault();
            var cr = canvasEl.getBoundingClientRect();
            rbStart = { x: e.clientX - cr.left, y: e.clientY - cr.top };
            rbActive = true;
            rb.classList.remove('ng-hidden');
            rb.style.left = rbStart.x + 'px';
            rb.style.top = rbStart.y + 'px';
            rb.style.width = '0px';
            rb.style.height = '0px';
        }

        function onRbMouseMove(e) {
            if (!rbActive) return;
            var cr = canvasEl.getBoundingClientRect();
            var cx = e.clientX - cr.left;
            var cy = e.clientY - cr.top;
            var x = Math.min(rbStart.x, cx);
            var y = Math.min(rbStart.y, cy);
            var w = Math.abs(cx - rbStart.x);
            var h = Math.abs(cy - rbStart.y);
            rb.style.left = x + 'px';
            rb.style.top = y + 'px';
            rb.style.width = w + 'px';
            rb.style.height = h + 'px';
        }

        function onRbMouseUp(e) {
            if (!rbActive) return;
            rbActive = false;
            var rbRect = rb.getBoundingClientRect();
            rb.classList.add('ng-hidden');
            rb.style.width = '0px';
            rb.style.height = '0px';
            var sel = [];
            // 框选节点：命中集先按视觉读序（上→下、同行左→右）排，再写入选中集。
            // 多选批量接线按选中先后接入，顺序在该链路里即 imageOrder/videoOrder 的初始序。
            var picked = [];
            var allNodes = canvasEl.querySelectorAll('.ng-node');
            for (var i = 0; i < allNodes.length; i++) {
                var nr = allNodes[i].getBoundingClientRect();
                if (_rectsOverlap(rbRect, nr)) {
                    picked.push({ id: allNodes[i].dataset.nodeId, top: nr.top, left: nr.left });
                }
            }
            if (global.AEComfyUI && global.AEComfyUI.sortCanvasReadingOrder) {
                sel = global.AEComfyUI.sortCanvasReadingOrder(picked);
            } else {
                for (var p0 = 0; p0 < picked.length; p0++) sel.push(picked[p0].id);
            }
            // 框选分组：只认标题栏，拖背景不算选中
            var allGroupHeads = canvasEl.querySelectorAll('.ng-group-head');
            for (var j = 0; j < allGroupHeads.length; j++) {
                if (_rectsOverlap(rbRect, allGroupHeads[j].getBoundingClientRect())) {
                    var gbox = allGroupHeads[j].closest('.ng-group-box');
                    if (gbox && gbox.dataset.groupId) sel.push(gbox.dataset.groupId);
                }
            }
            if (callbacks.onMultiSelect) callbacks.onMultiSelect(sel);
            rbStart = null;
        }

        canvasEl.addEventListener('mousedown', onRbMouseDown);
        window.addEventListener('mousemove', onRbMouseMove);
        window.addEventListener('mouseup', onRbMouseUp);

        // 鼠标悬停连线 hit 线时，高亮对应可见线（提示可 Ctrl+删除）
        edgeLayer.svg.addEventListener('mouseover', function (e) {
            var hit = e.target.classList && e.target.classList.contains('ng-edge-hit') ? e.target : null;
            if (!hit) return;
            var path = edgeLayer.svg.querySelector('#' + hit.dataset.edgeId);
            if (path) path.classList.add('ng-edge-hover');
        });
        edgeLayer.svg.addEventListener('mouseout', function (e) {
            var hit = e.target.classList && e.target.classList.contains('ng-edge-hit') ? e.target : null;
            if (!hit) return;
            var path = edgeLayer.svg.querySelector('#' + hit.dataset.edgeId);
            if (path) path.classList.remove('ng-edge-hover');
        });

        // Ctrl+左键点连线删除该边（事件委托到 svg，hit 线动态创建无需逐条绑）
        edgeLayer.svg.addEventListener('click', function (e) {
            if (!e.ctrlKey || e.button !== 0) return;
            var hit = e.target.classList && e.target.classList.contains('ng-edge-hit') ? e.target : null;
            if (!hit) return;
            var eid = hit.dataset.edgeId;
            if (!eid) return;
            e.preventDefault();
            e.stopPropagation();
            try {
                // 删前取边信息，供 callback 刷新缩略图
                var allEdges = graph.edges();
                var removedFrom = null, removedTo = null;
                for (var ei = 0; ei < allEdges.length; ei++) {
                    if (allEdges[ei].id === eid) { removedFrom = allEdges[ei].from; removedTo = allEdges[ei].to; break; }
                }
                graph.removeEdge(eid);
                redrawEdges();
                if (callbacks.onDeleteEdge) callbacks.onDeleteEdge(removedFrom, removedTo);
            } catch (err) {
                console.warn('[ComfyUI Canvas] 删边失败:', err.message);
            }
        });

        // 普通左键在连线上按下 → 拖拽重连（非 Ctrl，与删线区分）
        // 位移阈值：超过 4px 才真正断边进入重连——左键单击（不拖动）不得删边/产生历史
        edgeLayer.svg.addEventListener('mousedown', function (e) {
            if (e.ctrlKey || e.button !== 0) return;
            var hit = e.target.classList && e.target.classList.contains('ng-edge-hit') ? e.target : null;
            if (!hit) return;
            var eid = hit.dataset.edgeId;
            if (!eid) return;
            e.preventDefault();
            e.stopPropagation();

            // 找到被点击的边
            var allEdges = graph.edges();
            var edge = null;
            for (var ei = 0; ei < allEdges.length; ei++) {
                if (allEdges[ei].id === eid) { edge = allEdges[ei]; break; }
            }
            if (!edge) return;

            var removedFrom = edge.from, removedTo = edge.to, removedFromPort = edge.fromPort;
            var fromPort = null, fromPortType = null, startPos = null;
            var startClientX = e.clientX, startClientY = e.clientY;
            var rewired = false;   // 超阈值后置位：已断边 + 拖线 UI 就绪

            function beginRewire() {
                if (rewired) return;
                rewired = true;
                // 断边
                graph.removeEdge(eid);
                redrawEdges();
                if (callbacks.onDeleteEdge) callbacks.onDeleteEdge(removedFrom, removedTo);

                // 从来源节点输出端口起拖（跟拉新线一致）
                var srcEl = canvasEl.querySelector('[data-node-id="' + removedFrom + '"]');
                var srcNode = graph.getNode(removedFrom);
                if (!srcEl || !srcNode) return;
                var srcDef = _findDef(srcNode.type);
                if (!srcDef || !srcDef.outputs || !srcDef.outputs.length) return;

                fromPort = removedFromPort || srcDef.outputs[0].name;
                for (var pi = 0; pi < srcDef.outputs.length; pi++) {
                    if (srcDef.outputs[pi].name === fromPort) { fromPortType = srcDef.outputs[pi].type; break; }
                }
                if (!fromPortType) fromPortType = srcDef.outputs[0].type;

                var nr = srcEl.getBoundingClientRect();
                var cr = canvasEl.getBoundingClientRect();
                startPos = { x: nr.right - cr.left, y: (nr.top - cr.top + nr.bottom - cr.top) / 2 };

                // 隐藏圆圈
                clearTimeout(hoverCircle._retTimer);
                hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
                hoverCircle._returning = false;
                hoverCircle._nodeEl = null; hoverCircle._side = null;
                hoverCircle._retX = null; hoverCircle._retY = null;

                edgeLayer.drawEdge(TEMP_EDGE_ID, startPos, startPos, null, false);
                dragging = true;
                dragInfo = { nodeId: removedFrom, side: 'right', fromPort: fromPort, startPos: startPos, rewire: true };
                hoverCircle._dragging = true;
                _dragMouseClient = { x: startClientX, y: startClientY };
                _startEdgePan();

                // 不可连接节点变暗
                var wantSide = 'left';
                var allNodes = canvasEl.querySelectorAll('.ng-node');
                for (var j = 0; j < allNodes.length; j++) {
                    if (allNodes[j] === srcEl) continue;
                    var dnid = allNodes[j].dataset.nodeId;
                    var dn = graph.getNode(dnid);
                    var ddef = dn ? _findDef(dn.type) : null;
                    if (!_canConnectTo(ddef, wantSide, fromPortType, 'right')) {
                        allNodes[j].classList.add('ng-node-dimmed');
                    }
                }
            }

            function onMove(ev) {
                if (!rewired) {
                    if (Math.abs(ev.clientX - startClientX) < 4 && Math.abs(ev.clientY - startClientY) < 4) return;
                    beginRewire();
                    if (!dragging) return;   // 源节点/端口缺失，断边已发生但不进入拖线
                }
                if (!dragging) return;
                _dragMouseClient = { x: ev.clientX, y: ev.clientY };
                var cr2 = canvasEl.getBoundingClientRect();
                var mx2 = ev.clientX - cr2.left;
                var my2 = ev.clientY - cr2.top;
                _updateTargetCircle(mx2, my2, 'right', fromPortType);
                var ti2 = targetCircle._targetInfo;
                var newTarget = ti2 ? ti2.nodeEl : null;
                if (onMove._prevTarget !== newTarget) {
                    if (onMove._prevTarget) onMove._prevTarget.classList.remove('ng-node-highlight');
                    if (newTarget) newTarget.classList.add('ng-node-highlight');
                    onMove._prevTarget = newTarget;
                }
                var endPos;
                if (ti2) {
                    var existEdges = graph.edges();
                    var existCount = 0;
                    for (var ek = 0; ek < existEdges.length; ek++) {
                        // 按端口计数（与 redrawAll 按端口分组对齐），多端口节点临时拖线 snap 才准
                        if (existEdges[ek].to === ti2.nodeId && existEdges[ek].toPort === ti2.portName) existCount++;
                    }
                    var snapPos = edgeLayer.portPos(ti2.nodeEl, ti2.portName, 'in', existCount, existCount + 1);
                    endPos = { x: snapPos.x, y: snapPos.y };
                } else {
                    endPos = { x: mx2, y: my2 };
                }
                // 临时线颜色跟随起点端口（与 hover 圆圈同色），不随目标变
                edgeLayer.drawEdge(TEMP_EDGE_ID, startPos, endPos, fromPortType, false);
            }
            onMove._prevTarget = null;
            function onUp(ev) {
                if (ev.button !== 0) return;  // 只响应左键松手，右键不干扰拖线
                if (!rewired) {
                    // 单击未超阈值：保留原边，无任何副作用（不删边、不推历史）
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    return;
                }
                if (!dragging) {           // 源节点缺失等：断边已发生，收尾监听
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    return;
                }
                if (ev.target && ev.target.closest && ev.target.closest('.ng-context-menu')) return; // 点菜单项 → 留给菜单 click 收尾
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                _stopEdgePan();
                dragging = false;
                dragInfo = null;
                hoverCircle._dragging = false;
                _dragOnMove = null;
                _dragOnUp = null;
                _clearTempEdges();
                if (onMove._prevTarget) onMove._prevTarget.classList.remove('ng-node-highlight');
                onMove._prevTarget = null;
                var prevTarget = targetCircle._targetInfo ? targetCircle._targetInfo.nodeEl : null;
                if (prevTarget) prevTarget.classList.remove('ng-node-highlight');
                var dimmed = canvasEl.querySelectorAll('.ng-node-dimmed');
                for (var j2 = 0; j2 < dimmed.length; j2++) dimmed[j2].classList.remove('ng-node-dimmed');
                var ti = targetCircle._targetInfo;
                targetCircle._targetInfo = null;
                clearTimeout(hoverCircle._retTimer);
                hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
                hoverCircle._returning = false;
                hoverCircle._nodeEl = null; hoverCircle._side = null;
                hoverCircle._retX = null; hoverCircle._retY = null;
                if (!ti || ti.nodeId === removedFrom) { redrawEdges(); return; }
                // 重连是把既有的一条边改接新目标，保持单条：不做多选批量
                try {
                    graph.connect(removedFrom, fromPort, ti.nodeId, ti.portName);
                    redrawEdges();
                    if (callbacks.onConnect) callbacks.onConnect(removedFrom, ti.nodeId);
                } catch (err) {
                    console.warn('[ComfyUI Canvas] 重连失败:', err.message);
                    if (global.AEToast) AEToast.warn(AEI18n.t('重连失败: ') + err.message);
                }
            }
            _dragOnMove = onMove;
            _dragOnUp = onUp;
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        // ── 悬浮圆圈连线系统 ──
        // 鼠标靠近节点边缘 → 圆圈跟随鼠标 XY 弹出 → 空心点按变实心 → 拖线 → 目标吸附 → 松手连接
        // 脱离范围后圆圈滑回端点消失。圆圈颜色按端口类型：image #3b9eff / video #b06bff / text #4dd08a
        var PROXIMITY = 40;  // 距离节点边缘多少 px 内显示圆圈
        var EDGE_GAP = 4;    // 圆圈与节点边缘的间距，防贴边

        // 创建两个漂浮圆圈：hover（预拖）和目标吸附
        var hoverCircle = document.createElement('div');
        hoverCircle.className = 'ng-conn-circle';
        canvasEl.appendChild(hoverCircle);
        var targetCircle = document.createElement('div');
        targetCircle.className = 'ng-conn-circle';
        canvasEl.appendChild(targetCircle);

        var dragging = false;
        var movingNode = false;  // 节点拖拽移动中，抑制 hover 圆圈
        var dragInfo = null;  // { nodeId, side, fromPort, startPos }
        var _dragOnMove = null;   // 当前拖线的 window mousemove 监听器引用，供菜单处理收尾
        var _dragOnUp = null;     // 当前拖线的 window mouseup 监听器引用，供菜单处理收尾
        var dragFrozen = false;   // 拖线右键冻结态：线挂起停在菜单位置，等菜单 click 连线；松开左键不断
        var RETURN_MS = 250; // 返回动画时长，与 CSS .ng-conn-returning transition 对齐
        var _dragMouseClient = null;  // 拖线时鼠标 client 坐标，供边缘自动平移 tick 读
        var _edgePanRAF = null;       // 边缘自动平移 rAF id
        var EDGE_PAN_MARGIN = 36;     // 触发边缘自动平移的边距(px)
        var EDGE_PAN_SPEED = 14;      // 每帧平移最大像素

        // 拖线时鼠标靠近画布边缘 → 自动平移视口，方便连到画布外的节点。
        // 平移后真实边用 redrawAll 重画（绕过 redrawEdges 的 dragging guard，否则 temp-edge 会被清），
        // 起点 startPos 同步偏移（dragInfo.startPos 与 onMove 闭包 startPos 同引用），再借 _dragOnMove 重画临时线 + 重算目标。
        function _edgePanTick() {
            _edgePanRAF = null;
            if (!dragging || !dragInfo || !_dragMouseClient || dragFrozen) return;
            var cr = canvasEl.getBoundingClientRect();
            var mx = _dragMouseClient.x - cr.left;
            var my = _dragMouseClient.y - cr.top;
            var w = cr.width, h = cr.height;
            // 各侧进入边缘的深度比 0~1（clamp 防鼠标超出画布时比值爆表）
            var rL = mx < EDGE_PAN_MARGIN ? Math.min(1, (EDGE_PAN_MARGIN - mx) / EDGE_PAN_MARGIN) : 0;
            var rR = mx > w - EDGE_PAN_MARGIN ? Math.min(1, (mx - (w - EDGE_PAN_MARGIN)) / EDGE_PAN_MARGIN) : 0;
            var rT = my < EDGE_PAN_MARGIN ? Math.min(1, (EDGE_PAN_MARGIN - my) / EDGE_PAN_MARGIN) : 0;
            var rB = my > h - EDGE_PAN_MARGIN ? Math.min(1, (my - (h - EDGE_PAN_MARGIN)) / EDGE_PAN_MARGIN) : 0;
            // 平方曲线：边缘入口速度趋 0（平缓启动），越深入越接近最大速度。
            // 左/上边缘 → 视口往该方向平移看外部（dx/dy 为正）；右/下边缘 → 反向（为负）
            var dx = EDGE_PAN_SPEED * (rL * rL - rR * rR);
            var dy = EDGE_PAN_SPEED * (rT * rT - rB * rB);
            if (dx !== 0 || dy !== 0) {
                viewport.viewport.panBy(dx, dy);
                viewport.applyTransform();
                edgeLayer.redrawAll(graph, nodeEls, _selectedIds());  // 绕过 dragging guard 重画真实边
                dragInfo.startPos.x += dx; dragInfo.startPos.y += dy;  // 起点跟随平移
                if (_dragOnMove) _dragOnMove({ clientX: _dragMouseClient.x, clientY: _dragMouseClient.y });
            }
            if (dragging && !dragFrozen) _edgePanRAF = requestAnimationFrame(_edgePanTick);
        }
        function _startEdgePan() {
            if (_edgePanRAF == null && typeof requestAnimationFrame === 'function') {
                _edgePanRAF = requestAnimationFrame(_edgePanTick);
            }
        }
        function _stopEdgePan() {
            if (_edgePanRAF != null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(_edgePanRAF);
            _edgePanRAF = null;
        }

        // 找 nodeDef by type
        function _findDef(type) {
            for (var di = 0; di < nodeDefs.length; di++) {
                if (nodeDefs[di].type === type) return nodeDefs[di];
            }
            return null;
        }

        // 端口类型 → 颜色（image #3b9eff / video #b06bff / text #4dd08a）
        function _typeColor(t) {
            if (t === 'text') return '#4dd08a';
            if (t === 'video') return '#b06bff';
            return '#3b9eff'; // image / image[] / 未知
        }
        function _portTypeColor(def, side) {
            var ports;
            if (side === 'right') ports = (def && def.outputs) ? def.outputs : [];
            else ports = (def && def.inputs) ? def.inputs : [];
            if (!ports || !ports.length) return '#3b9eff'; // 默认蓝
            return _typeColor(ports[0].type);
        }

        // 端口锚点 Y 走 nodeSystem.ports.anchorY（唯一真相源，与 edgeRenderer 共用）。
        // text/video 输入锚顶部、image/输出锚中部。单端口节点锚中部，行为不变。
        // scale 缩放时 text/video 的固定偏移随之调整（世界坐标偏移 × scale = 屏幕坐标）。
        // viewport 是 view 对象（canvasIndex 传 _view），scale 在 view.viewport.scale。
        var _ports = global.AEComfyUI && global.AEComfyUI.ports;
        function _portScale() {
            return viewport ? (viewport.viewport ? viewport.viewport.scale : viewport.scale) || 1 : 1;
        }
        function _portAnchorY(port, dir, nTop, nBottom) {
            return _ports ? _ports.anchorY(port, dir, nTop, nBottom, _portScale()) : (nTop + (nBottom - nTop) / 2);
        }

        // 按鼠标 Y 在节点指定侧选最近端口（自适应多端口）。
        // 返回 { port, anchorY } 或 null。单端口节点退化为该端口。
        // my: 鼠标 canvas Y 坐标；cr: canvasEl.getBoundingClientRect()。
        function _pickPortByY(def, side, nodeEl, my, cr) {
            if (!def) return null;
            var ports = side === 'left' ? (def.inputs || []) : (def.outputs || []);
            if (!ports.length) return null;
            var nr = nodeEl.getBoundingClientRect();
            var nTop = nr.top - cr.top;
            var nBottom = nr.bottom - cr.top;
            // 约束 my 到节点纵向范围内（防超出节点时选错）
            var cy = Math.max(nTop, Math.min(my, nBottom));
            var best = null;
            var bestDist = Infinity;
            for (var p = 0; p < ports.length; p++) {
                var ay = _portAnchorY(ports[p], side === 'left' ? 'in' : 'out', nTop, nBottom);
                var d = Math.abs(cy - ay);
                if (d < bestDist) { bestDist = d; best = { port: ports[p], anchorY: ay }; }
            }
            return best;
        }

        // 给圆圈上类型色（color 属性供 CSS currentColor 用，border-color 继承）
        function _setCircleColor(circle, color) {
            circle.style.color = color;
            circle.style.borderColor = color;
        }

        // 检查节点在指定侧是否有可用端口（不检查类型兼容性，hover 圆圈用）
        function _hasPortOnSide(def, side) {
            if (!def) return false;
            if (side === 'left') return def.inputs && def.inputs.length > 0;
            return def.outputs && def.outputs.length > 0;
        }

        // 检查节点在指定侧是否有兼容端口（含类型匹配，拖线目标/变暗用）
        // side 是目标节点被连接的那一侧；dragSide 是拖线起始侧（'left'=从输入拖→连输出）
        function _canConnectTo(def, side, fromType, dragSide) {
            if (!def || !fromType) return false;
            var targetPorts = side === 'left' ? (def.inputs || []) : (def.outputs || []);
            for (var p = 0; p < targetPorts.length; p++) {
                // 从输出拖线：fromType 是输出端类型 → 连到输入，canConnect(output, input)
                // 从输入拖线：fromType 是输入端类型 → 连到输出，canConnect(output, input)
                var src = dragSide === 'left' ? targetPorts[p].type : fromType;
                var dst = dragSide === 'left' ? fromType : targetPorts[p].type;
                if (global.AEComfyUI.ports.canConnect(src, dst)) return true;
            }
            return false;
        }

        // 查找目标节点上第一个兼容端口名
        function _findCompatiblePort(def, side, fromType, dragSide) {
            var targetPorts = side === 'left' ? (def.inputs || []) : (def.outputs || []);
            for (var p2 = 0; p2 < targetPorts.length; p2++) {
                var src2 = dragSide === 'left' ? targetPorts[p2].type : fromType;
                var dst2 = dragSide === 'left' ? fromType : targetPorts[p2].type;
                if (global.AEComfyUI.ports.canConnect(src2, dst2)) return targetPorts[p2].name;
            }
            return null;
        }

        // 按鼠标 Y 选最近的兼容端口（自适应多端口）：遍历兼容端口取锚点 Y 最近者。
        // 单兼容端口退化为该端口（等价 _findCompatiblePort）。my: canvas Y。
        function _nearestCompatiblePort(def, side, fromType, dragSide, nodeEl, my, cr) {
            var targetPorts = side === 'left' ? (def.inputs || []) : (def.outputs || []);
            var nr = nodeEl.getBoundingClientRect();
            var nTop = nr.top - cr.top;
            var nBottom = nr.bottom - cr.top;
            var cy = Math.max(nTop, Math.min(my, nBottom));
            var best = null;
            var bestDist = Infinity;
            for (var p = 0; p < targetPorts.length; p++) {
                var src = dragSide === 'left' ? targetPorts[p].type : fromType;
                var dst = dragSide === 'left' ? fromType : targetPorts[p].type;
                if (!global.AEComfyUI.ports.canConnect(src, dst)) continue;
                var ay = _portAnchorY(targetPorts[p], side === 'left' ? 'in' : 'out', nTop, nBottom);
                var d = Math.abs(cy - ay);
                if (d < bestDist) { bestDist = d; best = targetPorts[p].name; }
            }
            return best;  // 无兼容端口返 null（调用方 _canConnectTo 已挡，此处必有值）
        }

        // 更新 hover 圆圈：节点内部优先（显示该节点端点），节点外部才检测边缘吸附
        function _updateHoverCircle(mx, my) {
            if (dragging || movingNode) return;
            // 鼠标在 resize 手柄上 → 不显示圆圈，优先 resize
            var allResize = worldEl.querySelectorAll('.ng-group-resize, .ng-node-resize');
            for (var ri = 0; ri < allResize.length; ri++) {
                var rr = allResize[ri].getBoundingClientRect();
                var rcr = canvasEl.getBoundingClientRect();
                var rLeft = rr.left - rcr.left, rRight = rr.right - rcr.left;
                var rTop = rr.top - rcr.top, rBottom = rr.bottom - rcr.top;
                if (mx >= rLeft - 2 && mx <= rRight + 2 && my >= rTop - 2 && my <= rBottom + 2) {
                    _hideHoverCircle(); return;
                }
            }
            // 鼠标在 gen 输入容器内 → 不显示连线端点圆圈
            var genContainer = canvasEl.querySelector('.ng-gen-input-container');
            if (genContainer && genContainer.style.display !== 'none') {
                var gcr = genContainer.getBoundingClientRect();
                var cr0 = canvasEl.getBoundingClientRect();
                var gcLeft = gcr.left - cr0.left, gcRight = gcr.right - cr0.left;
                var gcTop = gcr.top - cr0.top, gcBottom = gcr.bottom - cr0.top;
                if (mx >= gcLeft && mx <= gcRight && my >= gcTop && my <= gcBottom) { _hideHoverCircle(); return; }
            }
            var allNodes = canvasEl.querySelectorAll('.ng-node');
            // 先查鼠标是否在某个节点内部 → 显示该节点端点（最高优先级）
            // 倒序遍历：后加入的节点在 DOM 上层，重叠时优先匹配
            for (var i = allNodes.length - 1; i >= 0; i--) {
                var nr = allNodes[i].getBoundingClientRect();
                var cr = canvasEl.getBoundingClientRect();
                var nLeft = nr.left - cr.left;
                var nRight = nr.right - cr.left;
                var nTop = nr.top - cr.top;
                var nBottom = nr.bottom - cr.top;
                if (mx >= nLeft && mx <= nRight && my >= nTop - 4 && my <= nBottom + 4) {
                    var nodeId2 = allNodes[i].dataset.nodeId;
                    var node2 = graph.getNode(nodeId2);
                    var def2 = node2 ? _findDef(node2.type) : null;
                    // 找最近的有端口边
                    var dl = nLeft - mx;
                    var dr = mx - nRight;
                    var nearSide, nearEdgeX;
                    if (dl >= dr) { nearSide = 'left'; nearEdgeX = nLeft; }
                    else { nearSide = 'right'; nearEdgeX = nRight; }
                    if (!_hasPortOnSide(def2, nearSide)) {
                        // 该侧无端口，试另一侧
                        var otherSide = nearSide === 'left' ? 'right' : 'left';
                        var otherEdgeX = otherSide === 'left' ? nLeft : nRight;
                        if (_hasPortOnSide(def2, otherSide)) { nearSide = otherSide; nearEdgeX = otherEdgeX; }
                        else return; // 两侧都没端口，不显示
                    }
                    // 按鼠标 Y 选最近端口（自适应多端口）；单端口节点退化为该端口
                    var picked = _pickPortByY(def2, nearSide, allNodes[i], my, cr);
                    var anchorY = picked ? picked.anchorY : (nTop + nBottom) / 2;
                    var pickedPort = picked ? picked.port : null;
                    // 显示圆圈在边缘外侧
                    clearTimeout(hoverCircle._retTimer);
                    hoverCircle._returning = false;
                    hoverCircle.classList.remove('ng-conn-returning');
                    var cx2 = nearSide === 'left' ? nearEdgeX - 18 - EDGE_GAP : nearEdgeX + EDGE_GAP;
                    hoverCircle.style.left = cx2 + 'px';
                    hoverCircle.style.top = (anchorY - 9) + 'px';
                    var color2 = pickedPort ? _typeColor(pickedPort.type) : _portTypeColor(def2, nearSide);
                    _setCircleColor(hoverCircle, color2);
                    hoverCircle.classList.add('ng-conn-active');
                    hoverCircle._nodeEl = allNodes[i];
                    hoverCircle._side = nearSide;
                    hoverCircle._port = pickedPort ? pickedPort.name : null;  // 供 mousedown 取起点端口
                    hoverCircle._retX = cx2;
                    hoverCircle._retY = anchorY - 9;
                    return; // 节点内命中，不再检测外部边缘
                }
            }
            // 鼠标在所有节点外部 → 检测靠近的外部边缘，圆圈吸附鼠标
            var best = null;
            var bestDist = PROXIMITY;
            for (var j = 0; j < allNodes.length; j++) {
                var nr2 = allNodes[j].getBoundingClientRect();
                var cr2 = canvasEl.getBoundingClientRect();
                var nLeft2 = nr2.left - cr2.left;
                var nRight2 = nr2.right - cr2.left;
                var nTop2 = nr2.top - cr2.top;
                var nBottom2 = nr2.bottom - cr2.top;
                if (my < nTop2 - 8 || my > nBottom2 + 8) continue;
                var nodeId2 = allNodes[j].dataset.nodeId;
                var node2 = graph.getNode(nodeId2);
                var def2 = node2 ? _findDef(node2.type) : null;
                var dl2 = nLeft2 - mx;
                if (dl2 > 0 && dl2 < bestDist && dl2 < PROXIMITY && _hasPortOnSide(def2, 'left')) {
                    bestDist = dl2;
                    best = { nodeEl: allNodes[j], side: 'left', edgeX: nLeft2, nTop: nTop2, nBottom: nBottom2 };
                }
                var dr2 = mx - nRight2;
                if (dr2 > 0 && dr2 < bestDist && dr2 < PROXIMITY && _hasPortOnSide(def2, 'right')) {
                    bestDist = dr2;
                    best = { nodeEl: allNodes[j], side: 'right', edgeX: nRight2, nTop: nTop2, nBottom: nBottom2 };
                }
            }
            var HALF = 9;  // 18px 圆圈半宽
            if (best) {
                // 取消返回动画
                clearTimeout(hoverCircle._retTimer);
                hoverCircle._returning = false;
                hoverCircle.classList.remove('ng-conn-returning');
                // 按鼠标 Y 选最近端口（自适应多端口）
                var nodeId3 = best.nodeEl.dataset.nodeId;
                var node3 = graph.getNode(nodeId3);
                var def3 = node3 ? _findDef(node3.type) : null;
                var picked2 = _pickPortByY(def3, best.side, best.nodeEl, my, cr2);
                var pickedPort2 = picked2 ? picked2.port : null;
                var retAnchorY = picked2 ? picked2.anchorY : null;
                // 圆圈居中在鼠标上
                hoverCircle.style.left = (mx - HALF) + 'px';
                hoverCircle.style.top = (my - HALF) + 'px';
                // 圆圈按鼠标 Y 选中的端口类型上色（与节点内命中段一致）
                var color = pickedPort2 ? _typeColor(pickedPort2.type) : _portTypeColor(def3, best.side);
                _setCircleColor(hoverCircle, color);
                hoverCircle.classList.add('ng-conn-active');
                hoverCircle._nodeEl = best.nodeEl;
                hoverCircle._side = best.side;
                hoverCircle._port = pickedPort2 ? pickedPort2.name : null;
                // 返回端点：边缘外侧 + 选中端口锚点 Y（含间隙）；无选中端口回退节点中部
                var retX = best.side === 'left' ? best.edgeX - 18 - EDGE_GAP : best.edgeX + EDGE_GAP;
                var retY = (retAnchorY != null ? retAnchorY : (best.nTop + best.nBottom) / 2) - HALF;
                hoverCircle._retX = retX;
                hoverCircle._retY = retY;
            } else {
                // 鼠标脱离范围 → 滑回端点后消失
                _hideHoverCircle();
            }
        }

        // 拖线时更新目标吸附圆圈
        function _updateTargetCircle(cx, cy, dragSide, fromType) {
            var wantSide = dragSide === 'right' ? 'left' : 'right';
            var allNodes = canvasEl.querySelectorAll('.ng-node');
            var best = null;
            var bestDist = PROXIMITY;
            for (var i = 0; i < allNodes.length; i++) {
                // 排除源节点（拖线起点），防止连线吸附到自己身上
                if (dragInfo && allNodes[i].dataset.nodeId === dragInfo.nodeId) continue;
                if (allNodes[i] === hoverCircle._nodeEl) continue;
                var nr = allNodes[i].getBoundingClientRect();
                var cr = canvasEl.getBoundingClientRect();
                var nLeft = nr.left - cr.left;
                var nRight = nr.right - cr.left;
                var nTop = nr.top - cr.top;
                var nBottom = nr.bottom - cr.top;
                if (cy < nTop - 8 || cy > nBottom + 8) continue;
                var targetX = wantSide === 'left' ? nLeft : nRight;
                var dist = Math.abs(cx - targetX);
                // 鼠标在节点内部时保持高亮，不因深入节点而丢失目标
                if (cx >= nLeft && cx <= nRight) dist = 0;
                var nid3 = allNodes[i].dataset.nodeId;
                var n3 = graph.getNode(nid3);
                var def3 = n3 ? _findDef(n3.type) : null;
                if (dist < bestDist && _canConnectTo(def3, wantSide, fromType, dragSide)) {
                    bestDist = dist;
                    var tcY = Math.max(nTop + 12, Math.min(cy, nBottom - 12));
                    // 按鼠标 Y 选最近兼容端口（自适应多端口）；回退首个兼容端口
                    var portName = _nearestCompatiblePort(def3, wantSide, fromType, dragSide, allNodes[i], cy, cr);
                    best = { nodeEl: allNodes[i], side: wantSide, cx: targetX, cy: tcY, nodeId: nid3, portName: portName };
                }
            }
            if (best) {
                // 只记目标数据供 onMove 高亮节点用，不显示绿色圆圈
                targetCircle._targetInfo = best;
            } else {
                targetCircle._targetInfo = null;
            }
        }

        // hover 圆圈 mousedown → 开始拖新线
        hoverCircle.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            if (!hoverCircle._nodeEl || !hoverCircle._side) return;
            e.stopPropagation();
            e.preventDefault();

            hoverCircle._dragging = true;

            var nodeEl = hoverCircle._nodeEl;
            var side = hoverCircle._side;
            var nodeId = nodeEl.dataset.nodeId;
            var node = graph.getNode(nodeId);
            if (!node) return;
            var def = _findDef(node.type);
            if (!def) return;

            // 确定起点端口：右侧=output，左侧=input。优先用 hover 圆圈按鼠标 Y 选中的端口
            // （自适应多端口），回退 ports[0]（圆圈状态丢失时兜底）。
            var ports;
            if (side === 'right') ports = def.outputs;
            else ports = def.inputs;
            if (!ports || !ports.length) return;
            var fromPort = null;
            var fromPortType = null;
            if (hoverCircle._port) {
                for (var fp = 0; fp < ports.length; fp++) {
                    if (ports[fp].name === hoverCircle._port) { fromPort = ports[fp].name; fromPortType = ports[fp].type; break; }
                }
            }
            if (!fromPort) { fromPort = ports[0].name; fromPortType = ports[0].type; }

            // 点击扩散波纹（鼠标点击位置，起点端口类型色）
            var ripple = document.createElement('div');
            ripple.className = 'ng-conn-ripple ng-conn-ripple-go';
            ripple.style.left = (e.clientX - canvasEl.getBoundingClientRect().left) + 'px';
            ripple.style.top = (e.clientY - canvasEl.getBoundingClientRect().top) + 'px';
            ripple.style.color = _typeColor(fromPortType);
            canvasEl.appendChild(ripple);
            setTimeout(function () { if (ripple.parentNode) ripple.parentNode.removeChild(ripple); }, 460);

            // 线条从选中端口锚点出发（多端口时对齐到具体端口 Y，而非节点中心）
            var nr = nodeEl.getBoundingClientRect();
            var cr = canvasEl.getBoundingClientRect();
            var nLeft = nr.left - cr.left;
            var nRight = nr.right - cr.left;
            var nTop = nr.top - cr.top;
            var nBottom = nr.bottom - cr.top;
            var startY = _portAnchorY({ name: fromPort, type: fromPortType }, side === 'left' ? 'in' : 'out', nTop, nBottom);
            var startPos;
            if (side === 'left') {
                startPos = { x: nLeft, y: startY };
            } else {
                startPos = { x: nRight, y: startY };
            }
            // 拖线时隐藏圆圈
            clearTimeout(hoverCircle._retTimer);
            hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
            hoverCircle._returning = false;
            hoverCircle._nodeEl = null;
            hoverCircle._side = null;
            hoverCircle._port = null;
            hoverCircle._retX = null;
            hoverCircle._retY = null;

            edgeLayer.drawEdge(TEMP_EDGE_ID, startPos, startPos, null, false);
            dragging = true;
            dragInfo = { nodeId: nodeId, side: side, fromPort: fromPort, startPos: startPos };
            _dragMouseClient = { x: e.clientX, y: e.clientY };
            _startEdgePan();

            // 不可连接节点变暗；选中集是批量接线的来源节点，不按"不可连接目标"压暗
            var wantSide = side === 'right' ? 'left' : 'right';
            var selIds0 = callbacks.getSelectedNodeIds ? callbacks.getSelectedNodeIds() : [];
            var selMap0 = {};
            for (var s0 = 0; s0 < selIds0.length; s0++) selMap0[selIds0[s0]] = true;
            var allNodes2 = canvasEl.querySelectorAll('.ng-node');
            for (var i2 = 0; i2 < allNodes2.length; i2++) {
                if (allNodes2[i2] === nodeEl) continue;
                var dnid = allNodes2[i2].dataset.nodeId;
                if (selMap0[dnid]) continue;
                var dn = graph.getNode(dnid);
                var ddef = dn ? _findDef(dn.type) : null;
                if (!_canConnectTo(ddef, wantSide, fromPortType, side)) {
                    allNodes2[i2].classList.add('ng-node-dimmed');
                }
            }

            function onMove(ev) {
                if (!dragging) return;
                _dragMouseClient = { x: ev.clientX, y: ev.clientY };
                var mx2 = ev.clientX - cr.left;
                var my2 = ev.clientY - cr.top;
                _updateTargetCircle(mx2, my2, side, fromPortType);
                var ti2 = targetCircle._targetInfo;
                var newTarget = ti2 ? ti2.nodeEl : null;
                // 目标节点高亮切换
                if (onMove._prevTarget !== newTarget) {
                    if (onMove._prevTarget) onMove._prevTarget.classList.remove('ng-node-highlight');
                    if (newTarget) newTarget.classList.add('ng-node-highlight');
                    onMove._prevTarget = newTarget;
                }
                // 计算线终点：有目标节点时吸附到分布位置，无目标跟鼠标
                var endPos;
                if (ti2) {
                    var allEdges = graph.edges();
                    var existCount = 0;
                    // snap 方向：从输入口拖(side=left)→目标输出口(dir=out，右边缘)；
                    // 从输出口拖(side=right)→目标输入口(dir=in，左边缘)
                    var snapDir = side === 'left' ? 'out' : 'in';
                    // 计数已有边：目标作输入端(dir=in)按 to/toPort，目标作输出端(dir=out)按 from/fromPort
                    for (var ei = 0; ei < allEdges.length; ei++) {
                        if (snapDir === 'in') {
                            if (allEdges[ei].to === ti2.nodeId && allEdges[ei].toPort === ti2.portName) existCount++;
                        } else {
                            if (allEdges[ei].from === ti2.nodeId && allEdges[ei].fromPort === ti2.portName) existCount++;
                        }
                    }
                    var snapPos = edgeLayer.portPos(ti2.nodeEl, ti2.portName, snapDir, existCount, existCount + 1);
                    endPos = { x: snapPos.x, y: snapPos.y };
                } else {
                    endPos = { x: mx2, y: my2 };
                }
                // 预览线：单条与批量共用同一路径，批量时按计划把选中集接入的每条都画出来
                var plan2 = ti2 ? _planDragConnects(nodeId, side, fromPort, ti2) : null;
                _drawTempLines(plan2 ? plan2.conns : null, plan2 ? plan2.primary : 0,
                    startPos, endPos, fromPortType, nodeId, ti2 ? ti2.nodeId : null);
            }
            onMove._prevTarget = null;
            function onUp(ev) {
                if (ev.button !== 0) return;  // 只响应左键松手，右键不干扰拖线
                if (!dragging) return;        // 已被菜单 click 收尾 → 跳过
                if (ev.target && ev.target.closest && ev.target.closest('.ng-context-menu')) return; // 点菜单项 → 留给菜单 click 收尾
                window.removeEventListener('mousemove', onMove);
                window.removeEventListener('mouseup', onUp);
                _stopEdgePan();
                dragging = false;
                dragInfo = null;
                hoverCircle._dragging = false;
                _dragOnMove = null;
                _dragOnUp = null;
                _clearTempEdges();
                // 清理目标节点高亮
                if (onMove._prevTarget) onMove._prevTarget.classList.remove('ng-node-highlight');
                onMove._prevTarget = null;
                var prevTarget2 = targetCircle._targetInfo ? targetCircle._targetInfo.nodeEl : null;
                if (prevTarget2) prevTarget2.classList.remove('ng-node-highlight');
                // 移除所有变暗
                var dimmed = canvasEl.querySelectorAll('.ng-node-dimmed');
                for (var j2 = 0; j2 < dimmed.length; j2++) dimmed[j2].classList.remove('ng-node-dimmed');
                var ti = targetCircle._targetInfo;
                targetCircle._targetInfo = null;
                // 重置 hover 圆圈状态（下次 mousemove 时 _updateHoverCircle 从干净态重算）
                clearTimeout(hoverCircle._retTimer);
                hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
                hoverCircle._returning = false;
                hoverCircle._nodeEl = null;
                hoverCircle._side = null;
                hoverCircle._port = null;
                hoverCircle._retX = null;
                hoverCircle._retY = null;
                if (!ti || ti.nodeId === nodeId) { redrawEdges(); return; }   // 未命中也要重绘：拖线中滚轮缩放被 dragging guard 跳过，松手后真实边需按新缩放重算
                var plan = _planDragConnects(nodeId, side, fromPort, ti);
                if (!plan) {
                    // 兜底（无批量判定能力）：保持单条
                    plan = {
                        conns: [side === 'right'
                            ? { from: nodeId, fromPort: fromPort, to: ti.nodeId, toPort: ti.portName }
                            : { from: ti.nodeId, fromPort: ti.portName, to: nodeId, toPort: fromPort }],
                        primary: 0,
                        fallback: ''
                    };
                }
                var replaced = countReplacedUpstreams(graph, plan.conns);
                var res = applyConnectPlan(graph, plan.conns);
                redrawEdges();
                if (!res.applied.length && !res.existing.length) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('连线失败') + (res.error ? ': ' + res.error.message : ''));
                    return;
                }
                _emitConnects(res.applied);
                _warnSinglePortFallback(plan);
                _warnReplacedUpstreams(plan, replaced);
                _warnPartialConnect(plan, res);
            }
            _dragOnMove = onMove;
            _dragOnUp = onUp;
            window.addEventListener('mousemove', onMove);
            window.addEventListener('mouseup', onUp);
        });

        // ── 拖线时右键 → 过滤创建兼容节点并自动连线 ──
        function onDragContextMenu(e) {
            if (!dragging || !dragInfo) return;
            e.preventDefault();
            e.stopPropagation();
            // 冻结态（创建菜单已弹出）再次右键 = 取消拖线：此时 _cancelFrozenDrag 会清空 dragInfo，
            // 继续走下方创建流程会读到空引用。
            if (dragFrozen) { hideMenu(); hideNodeMenu(); return; }
            hideMenu(); hideNodeMenu();

            var fromPortType = dragInfo.fromPort;
            // 从 nodeDef 反向查端口类型
            var srcNode = graph.getNode(dragInfo.nodeId);
            if (srcNode) {
                var srcDef = _findDef(srcNode.type);
                if (srcDef) {
                    var srcPorts = dragInfo.side === 'right' ? (srcDef.outputs || []) : (srcDef.inputs || []);
                    for (var sp = 0; sp < srcPorts.length; sp++) {
                        if (srcPorts[sp].name === dragInfo.fromPort) { fromPortType = srcPorts[sp].type; break; }
                    }
                }
            }
            var wantSide = dragInfo.side === 'right' ? 'left' : 'right';
            var html = '<div class="ng-menu-group-title">'
                + AEI18n.t('创建并连线（兼容 {type}）', { type: fromPortType }) + '</div>';
            for (var d = 0; d < nodeDefs.length; d++) {
                if (_canConnectTo(nodeDefs[d], wantSide, fromPortType, dragInfo.side)) {
                    html += '<div class="ng-menu-item" data-drag-type="' + nodeDefs[d].type + '">' + (nodeDefs[d].title || nodeDefs[d].type) + '</div>';
                }
            }
            if (html.indexOf('ng-menu-item') < 0) {
                html += AEI18n.html('<div class="ng-menu-item ng-menu-disabled">无可创建节点</div>');
            }
            menu.innerHTML = html;
            menu.classList.remove('ng-hidden');
            menu._dragInfo = dragInfo;
            menu._dragFromType = fromPortType;  // 收尾连线按源端口类型选兼容端口用
            var rect2 = canvasEl.getBoundingClientRect();
            menu._dragX = e.clientX - rect2.left;
            menu._dragY = e.clientY - rect2.top;
            var w2 = menu.offsetWidth, h2 = menu.offsetHeight;
            menu.style.left = Math.min(e.clientX, window.innerWidth - w2 - 4) + 'px';
            menu.style.top = Math.min(e.clientY, window.innerHeight - h2 - 4) + 'px';

            // 冻结拖线：移除 window 监听 → 松开左键不再走 onUp 清理（不会断线），
            // temp-edge 终点钉在菜单位置，dragging 保留以挡住 redrawAll 清临时线。
            // 等用户点菜单项时由 menu click 收尾连线，或点外部由 hideMenu 取消冻结。
            dragFrozen = true;
            _stopEdgePan();
            if (_dragOnMove) { window.removeEventListener('mousemove', _dragOnMove); _dragOnMove = null; }
            if (_dragOnUp)   { window.removeEventListener('mouseup',   _dragOnUp);   _dragOnUp = null; }
            // 冻结态只保留拖线本身（批量派生预览线清掉，菜单项点击后重新按计划落图）
            _clearTempEdges();
            edgeLayer.drawEdge(TEMP_EDGE_ID, dragInfo.startPos, { x: menu._dragX, y: menu._dragY }, fromPortType, false);
        }
        window.addEventListener('contextmenu', onDragContextMenu, true);
        function _hideHoverCircle() {
            if (dragging || hoverCircle._returning || !hoverCircle.classList.contains('ng-conn-active')) return;
            hoverCircle._returning = true;
            hoverCircle.classList.add('ng-conn-returning');
            var rx = hoverCircle._retX != null ? hoverCircle._retX : parseInt(hoverCircle.style.left) || 0;
            var ry = hoverCircle._retY != null ? hoverCircle._retY : parseInt(hoverCircle.style.top) || 0;
            hoverCircle.style.left = rx + 'px';
            hoverCircle.style.top = ry + 'px';
            clearTimeout(hoverCircle._retTimer);
            hoverCircle._retTimer = setTimeout(function () {
                hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
                hoverCircle._returning = false;
                hoverCircle._nodeEl = null;
                hoverCircle._side = null;
                hoverCircle._retX = null;
                hoverCircle._retY = null;
            }, RETURN_MS);
        }

        // canvas 全局 mousemove → 更新 hover 圆圈
        canvasEl.addEventListener('mousemove', function (e) {
            // 鼠标在连线上（任意位置）→ 不显示圆圈，留空间给拖拽重连
            if (e.target.classList && e.target.classList.contains('ng-edge-hit')) {
                _hideHoverCircle();
                return;
            }
            var cr = canvasEl.getBoundingClientRect();
            _updateHoverCircle(e.clientX - cr.left, e.clientY - cr.top);
        });

        // mouseleave canvas → 返回动画后隐藏圆圈
        canvasEl.addEventListener('mouseleave', function () {
            _hideHoverCircle();
        });

        // 兼容旧接口：index.js renderNode 后仍会调这个，保持空实现
        function bindPortInteractions() {}

        var COLOR_SWATCHES = [
            '', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6',
            '#1abc9c', '#e91e63', '#ff5722', '#8bc34a', '#00bcd4', '#ff9800', '#673ab7'
        ];

        // 颜色选择器弹出面板
        var colorPicker = document.createElement('div');
        colorPicker.className = 'ng-color-picker ng-hidden';
        document.body.appendChild(colorPicker);

        // 拆分多宫格格数选择器（2×2/3×3/4×4）
        var gridMenu = document.createElement('div');
        gridMenu.className = 'ng-context-menu ng-hidden';
        document.body.appendChild(gridMenu);

        function showColorPicker(screenX, screenY, nid) {
            var html = '';
            for (var c = 0; c < COLOR_SWATCHES.length; c++) {
                var sw = COLOR_SWATCHES[c];
                if (sw) {
                    html += '<span class="ng-color-swatch" data-color="' + sw + '" style="background:' + sw + '" title="' + sw + '"></span>';
                } else {
                    html += AEI18n.html('<span class="ng-color-swatch ng-color-swatch-default" data-color="" title="重置为默认"></span>');
                }
            }
            colorPicker.innerHTML = html;
            colorPicker._nodeId = nid;
            colorPicker.classList.remove('ng-hidden');
            var pw = colorPicker.offsetWidth, ph = colorPicker.offsetHeight;
            colorPicker.style.left = Math.min(screenX, window.innerWidth - pw - 4) + 'px';
            colorPicker.style.top = Math.min(screenY, window.innerHeight - ph - 4) + 'px';
        }
        function hideColorPicker() { colorPicker.classList.add('ng-hidden'); }

        colorPicker.addEventListener('click', function (e) {
            var swatch = e.target.closest('.ng-color-swatch');
            if (!swatch) return;
            var color = swatch.dataset.color;
            var isGroup = nodeMenu._colorIsGroup;
            var targetId = colorPicker._nodeId;
            hideColorPicker(); hideMenu(); hideNodeMenu();
            nodeMenu._colorIsGroup = false;
            if (isGroup && callbacks.onGroupSetColor) {
                callbacks.onGroupSetColor(targetId, color);
            } else if (callbacks.onSetColor) {
                callbacks.onSetColor(targetId, color);
            }
        });

        // 节点右键菜单：重命名/选色/复制/备注/…
        function showNodeMenu(node, nodeEl, screenX, screenY) {
            var items = [
                { act: 'rename', label: AEI18n.t('重命名'), cb: callbacks.onRename },
                { act: 'color', label: AEI18n.t('变色'), cb: function (nid) { nodeMenu._colorIsGroup = false; showColorPicker(screenX, screenY, nid); } },
                { act: 'copy', label: AEI18n.t('复制'), cb: callbacks.onCopy },
                { act: 'note', label: AEI18n.t('编辑备注'), cb: callbacks.onNoteChange }
            ];
            if (node.type === 'imageEdit') {
                items.push({ act: 'edit', label: AEI18n.t('编辑图片'), cb: callbacks.onEdit });
                var hasEditResult = node.params && (node.params.editedPath || node.params._result);
                if (callbacks.onExport) items.push({ act: 'export', label: AEI18n.t('导出到 AE'), cb: callbacks.onExport, disabled: !hasEditResult });
            }
            if (node.type === 'imageGen' || node.type === 'videoGen') {
                var hasResult = node.params && node.params._result;
                var hasImgs = hasResult && node.params._result.images && node.params._result.images.length > 0;
                var hasVid = hasResult && !!(node.params._result.videoOut || node.params._result.video);  // videoOut 新 key，兼容旧 .video
                items.push({ act: 'export', label: AEI18n.t('导出到 AE'), cb: callbacks.onExport, disabled: !hasImgs && !hasVid });
                items.push({ act: 'split', label: AEI18n.t('拆分数组'), cb: callbacks.onSplit, disabled: !hasImgs });
            }
            items.push({ act: 'remove', label: AEI18n.t('删除'), cb: callbacks.onRemove, danger: true });

            var selImgs = callbacks.getSelectedImages ? callbacks.getSelectedImages() : [];
            if (selImgs.length === 1) {
                items.push({ act: 'splitGrid', label: AEI18n.t('拆分多宫格'), cb: callbacks.onSplitGrid });
            } else if (selImgs.length >= 2) {
                items.push({ act: 'composeGrid', label: AEI18n.t('组成多宫格'), cb: callbacks.onComposeGrid });
            }

            var html = '';
            for (var i = 0; i < items.length; i++) {
                var cls = 'ng-menu-item';
                if (items[i].danger) cls += ' ng-menu-danger';
                if (items[i].disabled) cls += ' ng-menu-disabled';
                html += '<div class="' + cls + '" data-act="' + items[i].act + '">' + items[i].label + '</div>';
            }
            nodeMenu.innerHTML = html;
            nodeMenu._items = items;
            nodeMenu._nodeId = node.id;
            nodeMenu.classList.remove('ng-hidden');
            var w = nodeMenu.offsetWidth, h = nodeMenu.offsetHeight;
            nodeMenu.style.left = Math.min(screenX, window.innerWidth - w - 4) + 'px';
            nodeMenu.style.top = Math.min(screenY, window.innerHeight - h - 4) + 'px';
        }
        function hideNodeMenu() { nodeMenu.classList.add('ng-hidden'); hideGridMenu(); }

        function showGridSizePicker(screenX, screenY) {
            // act = 拆分列数（_onSplitGrid 只接受 2/3/4），与 label 的 n×n 一致
            var items = [
                { act: '2', label: AEI18n.t('2×2（四宫格）') },
                { act: '3', label: AEI18n.t('3×3（九宫格）') },
                { act: '4', label: AEI18n.t('4×4（十六宫格）') }
            ];
            var html = '';
            for (var i = 0; i < items.length; i++) {
                html += '<div class="ng-menu-item" data-grid="' + items[i].act + '">' + items[i].label + '</div>';
            }
            gridMenu.innerHTML = html;
            gridMenu.classList.remove('ng-hidden');
            var w = gridMenu.offsetWidth, h = gridMenu.offsetHeight;
            gridMenu.style.left = Math.min(screenX, window.innerWidth - w - 4) + 'px';
            gridMenu.style.top = Math.min(screenY, window.innerHeight - h - 4) + 'px';
        }
        function hideGridMenu() { gridMenu.classList.add('ng-hidden'); }

        gridMenu.addEventListener('click', function (e) {
            var item = e.target.closest('.ng-menu-item');
            if (!item) return;
            var grid = item.dataset.grid;
            if (!grid) return;
            var nid = nodeMenu._nodeId;
            hideMenu(); hideNodeMenu();
            if (callbacks.onSplitGrid) callbacks.onSplitGrid(nid, parseInt(grid, 10));
        });

        nodeMenu.addEventListener('click', function (e) {
            var item = e.target.closest('.ng-menu-item');
            if (!item || item.classList.contains('ng-menu-disabled')) return;
            var grpAct = item.dataset.grpAct;
            if (grpAct) {
                var grp = nodeMenu._grpData;
                hideMenu(); hideNodeMenu();
                if (grpAct === 'rename' && callbacks.onGroupRename) { callbacks.onGroupRename(grp); }
                if (grpAct === 'color') {
                    showColorPicker(parseInt(nodeMenu.style.left) || 0, parseInt(nodeMenu.style.top) || 0, grp.id);
                    nodeMenu._colorIsGroup = true;
                }
                if (grpAct === 'note' && callbacks.onGroupNote) callbacks.onGroupNote(grp);
                if (grpAct === 'ungroup' && callbacks.onGroupUngroup) callbacks.onGroupUngroup(grp);
                return;
            }
            var act = item.dataset.act;
            var nid = nodeMenu._nodeId;
            hideMenu();
            hideNodeMenu();
            if (act === 'splitGrid') {
                showGridSizePicker(parseInt(nodeMenu.style.left) || 0, parseInt(nodeMenu.style.top) || 0);
                return;
            }
            if (act === 'composeGrid') {
                if (callbacks.onComposeGrid) callbacks.onComposeGrid();
                return;
            }
            var items = nodeMenu._items || [];
            for (var i = 0; i < items.length; i++) {
                if (items[i].act === act && items[i].cb) { items[i].cb(nid); return; }
            }
        });

        // 节点右键：绑在 nodeEls 上（index.js renderNode 后调 bindNodeContextMenu）
        function bindNodeContextMenu(nodeEl, node) {
            nodeEl.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                e.stopPropagation();
                hideMenu();
                // 右键未选中节点 → 单选它（已选中的多选保持，供「组成多宫格」使用）
                if (callbacks.onContextSelect) callbacks.onContextSelect(node.id);
                showNodeMenu(node, nodeEl, e.clientX, e.clientY);
            });
        }

        // 节点 category 是节点定义里的数据字段（分组名），显示层按字面量 key 翻译；
        // 未登记的 category 原样输出（节点数据与分组键不变）。
        function categoryLabel(cat) {
            if (cat === '输入') return AEI18n.t('输入');
            if (cat === '生成') return AEI18n.t('生成');
            if (!cat || cat === '其他') return AEI18n.t('其他');
            return String(cat);
        }

        // 空白处右键菜单（加节点）
        function buildMenuItems() {
            var groups = {};
            nodeDefs.forEach(function (def) {
                var cat = def.category || '其他';
                if (!groups[cat]) groups[cat] = [];
                groups[cat].push(def);
            });
            return groups;
        }

        function showMenu(screenX, screenY, worldX, worldY) {
            var groups = buildMenuItems();
            var html = '';
            // 空白处右键 → 始终可创建分组（选中节点则套入，无选中则建空组）
            html += AEI18n.html('<div class="ng-menu-group-title">分组</div>');
            html += AEI18n.html('<div class="ng-menu-item" data-act="group-nodes">创建分组</div>');
            Object.keys(groups).forEach(function (cat) {
                html += '<div class="ng-menu-group-title">' + categoryLabel(cat) + '</div>';
                groups[cat].forEach(function (def) {
                    html += '<div class="ng-menu-item" data-type="' + def.type + '">' + (def.title || def.type) + '</div>';
                });
            });
            menu.innerHTML = html;
            menu.classList.remove('ng-hidden');
            var w = menu.offsetWidth, h = menu.offsetHeight;
            menu.style.left = Math.min(screenX, window.innerWidth - w - 4) + 'px';
            menu.style.top = Math.min(screenY, window.innerHeight - h - 4) + 'px';
            menu._worldX = worldX;
            menu._worldY = worldY;
        }

        function hideMenu() {
            menu.classList.add('ng-hidden');
            // 菜单关闭时若拖线处于右键冻结态，取消冻结并清理临时线（用户没点菜单项的情况）
            _cancelFrozenDrag();
        }
        // 取消拖线冻结态：清临时线 + 拖线状态，不动真实连线。
        // 非冻结态调用为 no-op（守卫），故 hideMenu 各处调用安全。
        function _cancelFrozenDrag() {
            if (!dragFrozen) return;
            _stopEdgePan();
            dragFrozen = false;
            dragging = false;
            dragInfo = null;
            hoverCircle._dragging = false;
            _clearTempEdges();
            var hl = canvasEl.querySelectorAll('.ng-node-highlight');
            for (var i = 0; i < hl.length; i++) hl[i].classList.remove('ng-node-highlight');
            var dm = canvasEl.querySelectorAll('.ng-node-dimmed');
            for (var j = 0; j < dm.length; j++) dm[j].classList.remove('ng-node-dimmed');
            targetCircle._targetInfo = null;
            clearTimeout(hoverCircle._retTimer);
            hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
            hoverCircle._returning = false;
            hoverCircle._nodeEl = null;
            hoverCircle._side = null;
            hoverCircle._port = null;
            hoverCircle._retX = null;
            hoverCircle._retY = null;
        }

        function onContextMenu(e) {
            if (dragging) return;  // 拖线右键菜单已处理
            e.preventDefault();
            hideNodeMenu();
            var rect = canvasEl.getBoundingClientRect();
            var sx = e.clientX - rect.left;
            var sy = e.clientY - rect.top;
            var world = viewport.screenToWorld(sx, sy);
            showMenu(e.clientX, e.clientY, world.x, world.y);
        }
        canvasEl.addEventListener('contextmenu', onContextMenu);

        // 空白处双击左键也召唤菜单（与右键菜单一致）
        canvasEl.addEventListener('dblclick', function (e) {
            if (dragging) return;
            // 点在节点/端口/分组等元素上不触发
            var t = e.target;
            if (t && t.closest && (t.closest('.ng-node') || t.closest('.ng-port') || t.closest('.ng-group-box') || t.closest('.ng-context-menu') || t.classList.contains('ng-edge-hit'))) return;
            e.preventDefault();
            hideNodeMenu();
            var rect = canvasEl.getBoundingClientRect();
            var sx = e.clientX - rect.left;
            var sy = e.clientY - rect.top;
            var world = viewport.screenToWorld(sx, sy);
            showMenu(e.clientX, e.clientY, world.x, world.y);
        });

        menu.addEventListener('click', function (e) {
            var item = e.target.closest('.ng-menu-item');
            if (!item) return;
            // "创建分组" 菜单项
            if (item.dataset.act === 'group-nodes') {
                hideMenu();
                if (callbacks.onGroupCreate) callbacks.onGroupCreate(menu._worldX, menu._worldY);
                return;
            }
            // 拖线右键 → 创建节点并自动连线
            var dragType = item.dataset.dragType;
            if (dragType) {
                hideMenu();
                var di = menu._dragInfo;
                if (!di) return;
                var wpt = viewport.screenToWorld(menu._dragX, menu._dragY);
                var nid = graph.addNode(dragType, { x: wpt.x, y: wpt.y });
                var ndef = null;
                for (var d2 = 0; d2 < nodeDefs.length; d2++) {
                    if (nodeDefs[d2].type === dragType) { ndef = nodeDefs[d2]; break; }
                }
                if (ndef && ndef.defaultParams) {
                    var nn = graph.getNode(nid);
                    if (nn) nn.params = JSON.parse(JSON.stringify(ndef.defaultParams));
                }
                // 创建+连线是"一次交互"，包成一条历史（否则撤销要先断线再删节点两步）
                if (callbacks.onStructureBatch) callbacks.onStructureBatch('start');
                if (callbacks.onAddNode) callbacks.onAddNode(nid, ndef);
                // 先清拖线标记，让 redrawEdges 的 dragging guard 放行
                dragging = false; dragInfo = null;
                // 自动连线：与拖线松手同一套批量计划（新建节点作为落点参与），
                // 从源端口类型选新节点上第一个兼容端口（不能硬取 inputs[0]/outputs[0]——
                // videoGen 的 inputs 顺序是 image/text/video，从视频输入节点拖线时 inputs[0]='image'
                // 类型不兼容会被 graph.connect 拒绝，导致视频生成节点不自动连）。
                var fromType = menu._dragFromType;
                var wantPort = (ndef && fromType) ? _findCompatiblePort(ndef, 'left', fromType, di.side) : null;
                wantPort = wantPort || ((ndef && ndef.inputs && ndef.inputs.length) ? ndef.inputs[0].name : 'in');
                var outPort = (ndef && fromType) ? _findCompatiblePort(ndef, 'right', fromType, di.side) : null;
                outPort = outPort || ((ndef && ndef.outputs && ndef.outputs.length) ? ndef.outputs[0].name : 'out');
                // 重连起拖（di.rewire）的右键创建只连单条，与重连松手语义一致
                var plan = di.rewire ? null : _planDragConnects(di.nodeId, di.side, di.fromPort,
                    { nodeId: nid, portName: di.side === 'right' ? wantPort : outPort });
                if (!plan) {
                    plan = {
                        conns: [di.side === 'right'
                            ? { from: di.nodeId, fromPort: di.fromPort, to: nid, toPort: wantPort }
                            : { from: nid, fromPort: outPort, to: di.nodeId, toPort: di.fromPort }],
                        primary: 0,
                        fallback: ''
                    };
                }
                var replaced = countReplacedUpstreams(graph, plan.conns);
                var res = applyConnectPlan(graph, plan.conns);
                redrawEdges();
                if (res.applied.length || res.existing.length) {
                    _emitConnects(res.applied);
                    _warnSinglePortFallback(plan);
                    _warnReplacedUpstreams(plan, replaced);
                    _warnPartialConnect(plan, res);
                } else if (global.AEToast) {
                    AEToast.warn(AEI18n.t('连线失败') + (res.error ? ': ' + res.error.message : ''));
                }
                if (callbacks.onStructureBatch) callbacks.onStructureBatch('end');
                // 清理拖线 UI 残迹（菜单 click 收尾，onUp 已 skip）
                hoverCircle._dragging = false;
                targetCircle._targetInfo = null;
                _clearTempEdges();
                var dim2 = canvasEl.querySelectorAll('.ng-node-dimmed');
                for (var d3 = 0; d3 < dim2.length; d3++) dim2[d3].classList.remove('ng-node-dimmed');
                // 移除 window 上的拖线监听器（onUp 已 skip，此处兜底清理防泄漏）
                if (_dragOnMove) { window.removeEventListener('mousemove', _dragOnMove); _dragOnMove = null; }
                if (_dragOnUp)   { window.removeEventListener('mouseup',   _dragOnUp);   _dragOnUp = null; }
                _stopEdgePan();
                // 重置 hover 圆圈
                clearTimeout(hoverCircle._retTimer);
                hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
                hoverCircle._returning = false;
                hoverCircle._nodeEl = null; hoverCircle._side = null; hoverCircle._port = null;
                hoverCircle._retX = null; hoverCircle._retY = null;
                return;
            }
            var type = item.dataset.type;
            hideMenu();
            var def = null;
            for (var i = 0; i < nodeDefs.length; i++) {
                if (nodeDefs[i].type === type) { def = nodeDefs[i]; break; }
            }
            if (!def) return;
            var id = graph.addNode(type, { x: menu._worldX, y: menu._worldY });
            var node = graph.getNode(id);
            if (node && def.defaultParams) {
                node.params = JSON.parse(JSON.stringify(def.defaultParams));
            }
            if (callbacks.onAddNode) callbacks.onAddNode(id, def);
        });

        function hideAllMenus() { hideMenu(); hideNodeMenu(); hideGridMenu(); hideColorPicker(); }
        function onDocClick(e) {
            // 点菜单项或颜色格子弹窗内部不关菜单（依赖菜单项自己的关闭逻辑）
            if (e.target.closest('.ng-context-menu') || e.target.closest('.ng-color-picker')) return;
            hideAllMenus();
        }
        document.addEventListener('click', onDocClick);
        // 拖动画布/点击空白时也收菜单
        function onCanvasMouseDownHideMenus(e) {
            if (e.button === 0 || e.button === 1) hideAllMenus();
            // 点击空白处取消 textarea/input 聚焦状态（文本节点等）
            if (e.button === 0 && document.activeElement && document.activeElement !== document.body) {
                var ae = document.activeElement;
                if ((ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT') && !e.target.closest('.ng-node')) {
                    ae.blur();
                }
            }
        }
        function onCanvasWheelHideMenus() { hideAllMenus(); }
        canvasEl.addEventListener('mousedown', onCanvasMouseDownHideMenus);
        canvasEl.addEventListener('wheel', onCanvasWheelHideMenus);

        function destroy() {
            _stopEdgePan();
            canvasEl.removeEventListener('contextmenu', onContextMenu);
            window.removeEventListener('contextmenu', onDragContextMenu, true);
            canvasEl.removeEventListener('mousedown', onRbMouseDown);
            canvasEl.removeEventListener('mousedown', onCanvasMouseDownHideMenus);
            canvasEl.removeEventListener('wheel', onCanvasWheelHideMenus);
            window.removeEventListener('mousemove', onRbMouseMove);
            window.removeEventListener('mouseup', onRbMouseUp);
            if (rb.parentNode) rb.parentNode.removeChild(rb);
            document.removeEventListener('click', onDocClick);
            if (menu.parentNode) menu.parentNode.removeChild(menu);
            if (nodeMenu.parentNode) nodeMenu.parentNode.removeChild(nodeMenu);
            if (colorPicker.parentNode) colorPicker.parentNode.removeChild(colorPicker);
            if (gridMenu.parentNode) gridMenu.parentNode.removeChild(gridMenu);
            menu.classList.add('ng-hidden');
            nodeMenu.classList.add('ng-hidden');
            if (edgeLayer && edgeLayer.svg && edgeLayer.svg.parentNode) {
                edgeLayer.svg.parentNode.removeChild(edgeLayer.svg);
            }
        }

        return {
            showMenu: showMenu,
            hideMenu: hideMenu,
            menu: menu,
            destroy: destroy,
            redrawEdges: redrawEdges,
            refreshSelectionHighlight: refreshSelectionHighlight,
            bindPortInteractions: bindPortInteractions,
            bindNodeContextMenu: bindNodeContextMenu,
            nodeEls: nodeEls,
            setNodeDragging: function (v) {
                movingNode = v;
                if (v) {
                    // 开始拖拽/缩放节点 → 立刻隐藏端点圆圈
                    clearTimeout(hoverCircle._retTimer);
                    hoverCircle.classList.remove('ng-conn-active', 'ng-conn-returning');
                    hoverCircle._returning = false;
                    hoverCircle._nodeEl = null;
                    hoverCircle._side = null;
                    hoverCircle._retX = null;
                    hoverCircle._retY = null;
                }
            },
            // 分组框右键菜单
            showGroupMenu: function (group, screenX, screenY) {
                var items = [
                    { act: 'rename', label: AEI18n.t('重命名') },
                    { act: 'color', label: AEI18n.t('变色') },
                    { act: 'note', label: AEI18n.t('备注') },
                    { act: 'ungroup', label: AEI18n.t('解散分组'), danger: true }
                ];
                var html = '';
                for (var i = 0; i < items.length; i++) {
                    var cls2 = 'ng-menu-item';
                    if (items[i].danger) cls2 += ' ng-menu-danger';
                    html += '<div class="' + cls2 + '" data-grp-act="' + items[i].act + '">' + items[i].label + '</div>';
                }
                nodeMenu.innerHTML = html;
                nodeMenu._grpItems = items;
                nodeMenu._grpData = group;
                nodeMenu.classList.remove('ng-hidden');
                var w2 = nodeMenu.offsetWidth, h2 = nodeMenu.offsetHeight;
                nodeMenu.style.left = Math.min(screenX, window.innerWidth - w2 - 4) + 'px';
                nodeMenu.style.top = Math.min(screenY, window.innerHeight - h2 - 4) + 'px';
            }
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createCanvasController = createCanvasController;
    global.AEComfyUI.planMultiConnect = planMultiConnect;
    global.AEComfyUI.sortCanvasReadingOrder = sortCanvasReadingOrder;
    global.AEComfyUI.countReplacedUpstreams = countReplacedUpstreams;
    global.AEComfyUI.applyConnectPlan = applyConnectPlan;
})(window);
