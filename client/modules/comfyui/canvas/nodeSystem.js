(function (global) {
    var PORT_TYPES = ['image', 'image[]', 'video', 'text', 'number'];

    // ── 端口锚点 Y 规则（连线落点 / 圆圈吸附 共用，唯一真相源）──
    // 多端口 gen 节点按端口分置：text 顶部、video 顶部下方，image/image[]/输出端口 中部。
    // 单端口节点（绝大多数）锚中部，行为不受影响。
    // gen 节点不渲染常驻端口标记（视觉简洁），锚点仅由连线落点 + 悬浮圆圈体现。
    // PORT_ANCHOR 是节点本地（世界）坐标偏移；调用方在屏幕坐标系用时须乘 scale。
    var PORT_ANCHOR = { text: 16, video: 40 };

    var ports = {
        canConnect: function (fromType, toType) {
            if (fromType === toType) return true;
            // 'any' 为通配接收端（preview 终端节点接收 image[]/image/text/video 等任意上游输出）
            if (toType === 'any') return true;
            if (fromType === 'image' && toType === 'image[]') return true;
            if (fromType === 'video' && toType === 'video[]') return true;
            // image[] → image 放行：gen 节点批量出图可直连单图输入（如 imageEdit），
            // 下游 collectInputs 按序取首图（生成数量在连线时不可知，类型层面只能放行）
            if (fromType === 'image[]' && toType === 'image') return true;
            return false;
        },
        wrapSingle: function (valueType, value) {
            if (valueType === 'image') return [value];
            return value;
        },
        isPortType: function (t) {
            return PORT_TYPES.indexOf(t) >= 0;
        },
        // 端口锚点 Y。dir: 'in'=输入侧 / 'out'=输出侧。
        // nTop/nBottom: 节点矩形坐标（坐标系同 scale：屏幕坐标时传屏幕值，scale>1）。
        // scale: 视图缩放，text/video 的固定偏移是世界坐标，须乘 scale 转屏幕；中部是比例不受影响。
        // port 可传端口对象 {name,type} 或端口名字符串。
        anchorY: function (port, dir, nTop, nBottom, scale) {
            var name = typeof port === 'string' ? port : (port && port.name);
            var s = scale || 1;
            if (dir === 'in' && name && PORT_ANCHOR[name] != null) return nTop + PORT_ANCHOR[name] * s;
            return nTop + (nBottom - nTop) / 2;  // 中部
        },
        anchorOffset: PORT_ANCHOR  // 供 CSS 对齐参考（nodeRenderer 注释引用）
    };

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.ports = ports;

    // 拓扑：从某节点向上游递归，返回执行顺序（上游在前，自身最后）
    // edges: [{from, to}]，from 是 to 的上游（from 输出 → to 输入）
    var topo = {
        upstreamOrder: function (nodeId, edges) {
            var visited = {};
            var inStack = {};
            var result = [];

            function visit(id) {
                if (visited[id]) return;
                if (inStack[id]) {
                    throw new Error('检测到环: ' + id);
                }
                inStack[id] = true;
                for (var i = 0; i < edges.length; i++) {
                    if (edges[i].to === id) {
                        visit(edges[i].from);
                    }
                }
                inStack[id] = false;
                visited[id] = true;
                result.push(id);
            }
            visit(nodeId);
            return result;
        }
    };

    global.AEComfyUI.topo = topo;

    var _idCounter = 1;
    function nextId(prefix) {
        return (prefix || 'n') + (_idCounter++);
    }

    // 图状态：节点 + 边 + 参数
    function createGraph() {
        var _nodes = {};
        var _edges = {};
        var _nodeDefs = {};

        function addNode(type, pos) {
            var id = nextId('n');
            _nodes[id] = {
                id: id, type: type,
                x: pos ? pos.x : 0, y: pos ? pos.y : 0,
                params: {}, note: '', color: '', title: ''
            };
            return id;
        }

        // 以指定 ID 添加节点（加载快照时复用原始 ID，避免 reload 换 ID）
        function addNodeWithId(type, id, pos) {
            // 确保 _idCounter 大于当前 id 的序号部分，避免后续 addNode 冲突
            var numPart = parseInt(String(id).replace(/\D/g, '')) || 0;
            if (numPart >= _idCounter) _idCounter = numPart + 1;
            _nodes[id] = {
                id: id, type: type,
                x: pos ? pos.x : 0, y: pos ? pos.y : 0,
                params: {}, note: '', color: '', title: ''
            };
            return id;
        }

        function removeNode(id) {
            delete _nodes[id];
            Object.keys(_edges).forEach(function (eid) {
                if (_edges[eid].from === id || _edges[eid].to === id) {
                    delete _edges[eid];
                }
            });
        }

        function connect(from, fromPort, to, toPort) {
            var fromType = portTypeOf(from, fromPort);
            var toType = portTypeOf(to, toPort);
            if (!ports.canConnect(fromType, toType)) {
                throw new Error('端口不兼容: ' + fromType + ' → ' + toType);
            }
            // 全量查重：完全相同的边（from/fromPort/to/toPort）直接返回旧边 id。
            // 数组端口无此查重会连入 N 条重复边（同一上游被重复计入 gen 节点输入）
            var dupKeys = Object.keys(_edges);
            for (var d = 0; d < dupKeys.length; d++) {
                var de = _edges[dupKeys[d]];
                if (de.from === from && de.fromPort === fromPort && de.to === to && de.toPort === toPort) {
                    return de.id;
                }
            }
            // 目标端口非数组类型（image/video/text/any）则只许一条入边
            if (toType.indexOf('[]') === -1) {
                var keys = Object.keys(_edges);
                for (var i = 0; i < keys.length; i++) {
                    var e = _edges[keys[i]];
                    if (e.to === to && e.toPort === toPort) {
                        delete _edges[keys[i]];
                        break;
                    }
                }
            }
            var eid = nextId('e');
            _edges[eid] = { id: eid, from: from, fromPort: fromPort, to: to, toPort: toPort };
            return eid;
        }

        function removeEdge(eid) { delete _edges[eid]; }

        function registerNodeDef(type, def) { _nodeDefs[type] = def; }
        function portTypeOf(nodeId, portName) {
            var node = _nodes[nodeId];
            if (!node) return 'any';
            var def = _nodeDefs[node.type];
            if (!def) return 'any';
            var inputs = def.inputs || [];
            var outputs = def.outputs || [];
            for (var i = 0; i < inputs.length; i++) {
                if (inputs[i].name === portName) return inputs[i].type;
            }
            for (var j = 0; j < outputs.length; j++) {
                if (outputs[j].name === portName) return outputs[j].type;
            }
            return 'any';
        }

        function nodes() { return Object.keys(_nodes).map(function (k) { return _nodes[k]; }); }
        function edges() { return Object.keys(_edges).map(function (k) { return _edges[k]; }); }
        function getNode(id) { return _nodes[id]; }

        function serialize() {
            // 深拷贝，避免调用方改图污染序列化结果
            return JSON.parse(JSON.stringify({ nodes: nodes(), edges: edges() }));
        }

        return {
            addNode: addNode, addNodeWithId: addNodeWithId, removeNode: removeNode,
            connect: connect, removeEdge: removeEdge,
            registerNodeDef: registerNodeDef, portTypeOf: portTypeOf,
            nodes: nodes, edges: edges, getNode: getNode,
            serialize: serialize
        };
    }

    global.AEComfyUI.createGraph = createGraph;
})(window);
