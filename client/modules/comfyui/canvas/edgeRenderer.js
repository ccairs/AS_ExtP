(function (global) {
    // 连线 SVG 渲染：端口间贝塞尔曲线。
    // SVG 挂在 canvasEl（固定覆盖层，不随 world 变换），坐标全用屏幕坐标。
    // 之前挂在 worldEl 内 + world 局部坐标换算，受 worldEl 0 尺寸 / transform 影响，
    // 临时线画出来了但渲染在错误位置或不可见 → 连线"拖不出"。改屏幕坐标最稳健。
    // 裁剪链：SVG 内联 overflow:visible 只放开自身视口外的绘制，越界内容由
    // .ng-canvas（overflow:hidden）与 .comfyui-canvas-view（overflow:hidden）裁掉，
    // 画布可见区内不出现越界连线。
    var TEMP_EDGE_PREFIX = 'ng-temp-edge';   // 拖线临时预览线 id 前缀

    // 端口分布 Y（纯函数，不碰 DOM）：同一端口 total 条边里第 idx 条的端点 Y。
    // 以 anchorY 为中心、间距 22*scale 展开；展开高度超过节点可用高度时按可用高度压缩间距。
    // 结果恒落在 [nTop+margin, nBottom-margin]；可用高度不足两倍边距时全部取节点垂直中点。
    // total<=1 返回锚点 Y（越界时夹回边界）。floorTopY 为分布顶端下限（image 输入口相对
    // video 锚点的约束），与节点边界冲突时以边界为准。
    function edgeFanY(anchorY, idx, total, nTop, nBottom, scale, margin, floorTopY) {
        var sc = scale > 0 ? scale : 1;
        var mg = margin >= 0 ? margin : 12 * sc;
        var minY = nTop + mg;
        var maxY = nBottom - mg;
        if (maxY < minY) minY = maxY = (nTop + nBottom) / 2;
        total = total || 1;
        idx = idx || 0;
        if (idx < 0) idx = 0;
        if (idx > total - 1) idx = total - 1;
        if (total <= 1) {
            if (anchorY < minY) return minY;
            if (anchorY > maxY) return maxY;
            return anchorY;
        }
        var gap = 22 * sc;
        var avail = maxY - minY;
        var span = (total - 1) * gap;
        if (span > avail) {
            gap = avail / (total - 1);
            span = avail;
        }
        var topY = anchorY - span / 2;
        if (floorTopY != null && topY < floorTopY) topY = floorTopY;
        if (topY > maxY - span) topY = maxY - span;
        if (topY < minY) topY = minY;
        return topY + idx * gap;
    }

    // 选中关联边判定（纯函数）：边的任一端点在选中集内即命中。
    // 拖线临时预览线（id 前缀 ng-temp-edge）不参与高亮。
    function edgeInSelection(edge, selectedIds) {
        if (!edge || !selectedIds || !selectedIds.length) return false;
        var id = String(edge.id == null ? '' : edge.id);
        if (id.indexOf(TEMP_EDGE_PREFIX) === 0) return false;
        for (var i = 0; i < selectedIds.length; i++) {
            var sid = selectedIds[i];
            if (sid != null && (sid === edge.from || sid === edge.to)) return true;
        }
        return false;
    }

    function createEdgeLayer(canvasEl, viewport) {
        var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.classList.add('ng-edge-layer');
        svg.style.position = 'absolute';
        svg.style.left = '0';
        svg.style.top = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.overflow = 'visible';
        // z-index 由 CSS .ng-edge-layer{z-index:1} 管（< .ng-world 的 2），
        // 连线在节点层之下，避免整层 SVG 盖住节点。内联 zIndex:10 会把连线层提到节点上方。
        // svg 自身 pointer-events:none：空白区域让事件穿透到下方 canvasEl（pan 拖动画布）。
        // hit path 子元素显式设 pointer-events:stroke 仍能接收点击（SVG 特性，不受父级 none 屏蔽）。
        svg.style.pointerEvents = 'none';
        canvasEl.appendChild(svg);

        // 连线端点坐标：锚在节点边缘（输出=右边缘、输入=左边缘），不连到端口圆圈。
        // 多条连到同侧时按端口均匀分布 Y 坐标，避免线全叠在一个点上；分布受节点上下边界约束。
        // idx: 当前边在该端口所有边中的序号（0-based），total: 该端口总边数。
        // 端口锚点 Y 走 nodeSystem.ports.anchorY（唯一真相源），text/video 输入锚顶部、image 锚中部。
        // gen 节点不渲染常驻端口标记，锚点仅由连线落点体现。
        var ports = global.AEComfyUI && global.AEComfyUI.ports;
        function portPos(nodeEl, portName, dir, idx, total) {
            var cr = canvasEl.getBoundingClientRect();
            var nr = nodeEl.getBoundingClientRect();
            idx = idx || 0;
            total = total || 1;
            // 锚点 Y：输入侧 text/video 锚顶部带，其余锚中部。scale 缩放时偏移随之调整。
            // viewport 可能是 view 对象（含 .viewport.scale）或 viewport 本身（含 .scale）。
            var nTop = nr.top, nBottom = nr.top + nr.height;
            var sc = viewport ? (viewport.viewport ? viewport.viewport.scale : viewport.scale) || 1 : 1;
            var anchorY = ports ? ports.anchorY(portName, dir, nTop, nBottom, sc) : (nTop + nr.height / 2);
            // 输入侧 image 端口聚拢下限：分布顶端不低于 video 锚点 + 间距，避免窜入 video 顶部区域交叉。
            // 单条边不设下限（保持锚点位置）。
            var floorTopY = null;
            if (total > 1 && dir === 'in' && portName !== 'text' && portName !== 'video' && ports && ports.anchorOffset) {
                floorTopY = nTop + ports.anchorOffset.video * sc + 24 * sc;
            }
            var y = edgeFanY(anchorY, idx, total, nTop, nBottom, sc, 12 * sc, floorTopY) - cr.top;
            var x;
            if (dir === 'out') x = nr.right - cr.left;       // 右边缘
            else x = nr.left - cr.left;                       // 左边缘
            return { x: x, y: y };
        }

        // 画一条边（屏幕坐标）。每条边两个 path：
        //   可见线（ng-edge，pointer-events:none）+ 透明粗 hit 线（ng-edge-hit，pointer-events:stroke）。
        // hit 线加宽命中区，Ctrl+左键点击它删除该边。
        // selected: 端点节点在选中集内 → 可见线加 ng-edge-sel（hit 线不加类，删除/悬停路径不受影响）。
        function drawEdge(edgeId, fromPos, toPos, portType, withHit, selected) {
            if (withHit === undefined) withHit = true;
            var path = svg.querySelector('#' + edgeId);
            var hit = svg.querySelector('#' + edgeId + '-hit');
            if (!path) {
                path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.id = edgeId;
                path.classList.add('ng-edge');
                svg.appendChild(path);
            }
            // 临时拖线不建 hit path：hit path 是 pointer-events:stroke 的透明粗线，
            // 会挡住 elementFromPoint 命中目标端口 → 拖线时/松手时连不上。
            if (withHit) {
                if (!hit) {
                    hit = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    hit.id = edgeId + '-hit';
                    hit.classList.add('ng-edge-hit');
                    hit.style.fill = 'none';
                    hit.style.stroke = 'transparent';
                    hit.style.strokeWidth = '16';
                    hit.style.pointerEvents = 'stroke';
                    hit.style.cursor = 'pointer';
                    svg.appendChild(hit);
                }
            } else if (hit) {
                hit.remove();
                hit = null;
            }
            // 按端口类型上色：image/image[]→img, video→vid, text→txt
            var typeClass = 'ng-edge';
            if (portType === 'image' || portType === 'image[]') typeClass = 'ng-edge ng-edge-img';
            else if (portType === 'video') typeClass = 'ng-edge ng-edge-vid';
            else if (portType === 'text') typeClass = 'ng-edge ng-edge-txt';
            path.setAttribute('class', selected ? typeClass + ' ng-edge-sel' : typeClass);
            if (hit) hit.setAttribute('class', 'ng-edge-hit ng-edge-hit-' + (portType || ''));
            var dx = (toPos.x - fromPos.x) * 0.5;
            var d = 'M ' + fromPos.x + ' ' + fromPos.y +
                ' C ' + (fromPos.x + dx) + ' ' + fromPos.y +
                ', ' + (toPos.x - dx) + ' ' + toPos.y +
                ', ' + toPos.x + ' ' + toPos.y;
            path.setAttribute('d', d);
            if (hit) hit.setAttribute('d', d);
            if (hit) hit.dataset.edgeId = edgeId;
            return path;
        }

        // 重画所有边（节点移动/缩放后调）。出口收拢中点，入口按端口 Y 均匀分布。
        // selectedIds: 选中节点 id 列表；端点命中的边带 ng-edge-sel（重绘后高亮保持）。
        function redrawAll(graph, nodeEls, selectedIds) {
            var old = svg.querySelectorAll('.ng-edge, .ng-edge-hit');
            for (var i = 0; i < old.length; i++) old[i].remove();
            var edges = graph.edges();
            // 入口侧按端口分组（key: "nodeId|portName"），不同端口的边各自分布，不混在一起
            var inGroups = {};  // key: "nodeId|portName" → edge[]
            for (var j = 0; j < edges.length; j++) {
                var e = edges[j];
                if (!nodeEls[e.from] || !nodeEls[e.to]) continue; // 无 DOM 的边不计入分布
                var tk = e.to + '|' + e.toPort;
                if (!inGroups[tk]) inGroups[tk] = [];
                inGroups[tk].push(e);
            }
            // 排序：imageOrder / videoOrder 为唯一顺序来源（按端口名取对应 order；无则回退 ID 序）
            var groupKeys2 = Object.keys(inGroups);
            for (var g = 0; g < groupKeys2.length; g++) {
                inGroups[groupKeys2[g]].sort(function (a, b) {
                    var toNode = graph.getNode(a.to);
                    // image 端口→imageOrder，video 端口→videoOrder，其余端口无 order
                    var orderKey = a.toPort === 'image' ? 'imageOrder'
                        : (a.toPort === 'video' ? 'videoOrder' : null);
                    var order = orderKey && toNode && toNode.params && toNode.params[orderKey];
                    if (order && order.length) {
                        var ai = order.indexOf(a.id), bi = order.indexOf(b.id);
                        if (ai >= 0 && bi >= 0) return ai - bi;
                        if (ai >= 0) return -1;
                        if (bi >= 0) return 1;
                    }
                    // 回退：按连线先后（取 ID 数字部分）
                    var an2 = parseInt(a.id.replace(/\D/g, '')) || 0;
                    var bn2 = parseInt(b.id.replace(/\D/g, '')) || 0;
                    return an2 - bn2;
                });
            }
            for (var k = 0; k < edges.length; k++) {
                var e2 = edges[k];
                var fromEl = nodeEls[e2.from];
                var toEl = nodeEls[e2.to];
                if (!fromEl || !toEl) continue;
                var toGroup = inGroups[e2.to + '|' + e2.toPort];
                var toIdx = toGroup ? toGroup.indexOf(e2) : -1;
                if (toIdx < 0) toIdx = 0; // 防御：边不在分组（不应发生）回退到首位置
                // 出口全部收拢到节点边缘中点（idx=0, total=1），入口按端口均匀分布
                var fp = portPos(fromEl, e2.fromPort, 'out', 0, 1);
                var tp = portPos(toEl, e2.toPort, 'in', toIdx, toGroup ? toGroup.length : 1);
                if (fp && tp) {
                    // 取输出端口类型给连线上色（img/vid/txt）：从 graph 查端口类型，
                    // 从 .ng-port DOM 取时该 DOM 从不创建 → 永远空 → 边全无类型色。改走 graph。
                    var ptype = graph.portTypeOf ? graph.portTypeOf(e2.from, e2.fromPort) : '';
                    drawEdge(e2.id, fp, tp, ptype, true, edgeInSelection(e2, selectedIds));
                }
            }
        }

        return { portPos: portPos, drawEdge: drawEdge, redrawAll: redrawAll, svg: svg };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.edgeFanY = edgeFanY;
    global.AEComfyUI.edgeInSelection = edgeInSelection;
    global.AEComfyUI.createEdgeLayer = createEdgeLayer;
})(window);
