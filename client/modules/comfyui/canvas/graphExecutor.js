(function (global) {
    // 画布图执行器：BFS 上游遍历 + 拓扑排序 + 双路径执行
    // opts: { graph, handlers, controller, templateEngine, service, outputDir }
    function createGraphExecutor(opts) {
        opts = opts || {};
        var graph = opts.graph;
        var handlers = opts.handlers || {};       // 本地计算节点 handler: { nodeType: function(inputs, params, ctx) -> result }
        var controller = opts.controller;          // comfyui controller（generateRaw）
        var templateEngine = opts.templateEngine;  // renderWorkflow
        var service = opts.service;                // comfyuiService（uploadImage）
        var outputDir = opts.outputDir || '';
        var onMapPrompt = opts.onMapPrompt || null; // promptId→nodeId 映射回调（供 canvasIndex 建立路由）
        var results = {};                          // { nodeId: result }
        var _promptMap = {};                       // { promptId: nodeId } 映射（供 handler 记录，便于调试）
        // _promptMap FIFO 上限——若无上限则只增不减（长会话高频调参工作流持续
        // 累积，每条几十字节），对照 controller 侧 _promptSources 的 _pruneDonePrompts
        // 淘汰语义。promptId 为 UUID 字符串键，Object.keys 按插入序，淘汰最旧条目；
        // onMapPrompt 路由回调（canvasIndex 独立维护映射）不受影响。
        var _PROMPT_MAP_MAX = 256;
        var _inFlight = {};                        // { nodeId: Promise } 执行中互斥：并发 runNodeAsync 共享同一节点执行
        var _paramGen = {};                        // { nodeId: number } 参数代次：clearResult(nodeId) 时递增（缓存失效计数）
        var _inFlightGen = {};                     // { nodeId: number } 在途执行启动时的参数代次（共享前校验用）
        var _switchEpoch = 0;                      // ①：画布切换代次（invalidateAllForSwitch 递增；在途执行据此识别「孤儿化」）
        var self = {};                             // 自身引用，供 ctx.graphExecutor 传递

        function isReady(nodeId) {
            return nodeId in results;
        }

        function getResult(nodeId) {
            return results[nodeId];
        }

        function clearResult(nodeId) {
            if (nodeId) {
                delete results[nodeId];
                // 失效递增参数代次——共享校验（在途执行启动后参数被改，并发执行不得
                // 共享旧在途拿旧参数结果）+ 写回防护（旧执行完成后不得把旧参数结果写回已
                // 失效缓存）。_invalidateCache（参数变更）对"节点自身 + 下游"逐个调
                // clearResult(nodeId)，在此递增即覆盖全部失效入口，无需清 _inFlight。
                _paramGen[nodeId] = (_paramGen[nodeId] || 0) + 1;
            }
            else { results = {}; }
        }

        // 清空在途互斥表（切画布时与 invalidateAll 配对）：画布切换后 id 空间整体
        // 更换（addNodeWithId 复用持久化 id，跨画布同 id 是不同逻辑节点），旧画布的在途
        // 表项若残留，新画布同 id 上游会共享旧画布执行、拿到旧画布的结果
        function clearInFlight() {
            _inFlight = {};
            _inFlightGen = {};
        }

        // 整体失效（切画布 _clearRuntime 全清用）：递增每个已知 nid 的参数代次，
        // 使旧画布所有在途/挂起执行的写回守卫（runNodeAsync 末尾的代次比对）失效。
        // 只清 results 而不递增 _paramGen 时，
        // 旧画布在途执行完成时 `(_paramGen[nid]||0) === gen` 仍成立，结果落进新画布
        // 同 id 节点缓存（所有画布 id 都从 n1 起编号），isReady 命中静默返回旧画布结果。
        // 已知 nid = graph 当前节点（_clearRuntime 调本函数时 graph 尚未清空）+
        // results/_inFlight/_paramGen 残留键（兜住已缓存/在途/失效过的 id）。
        function invalidateAll() {
            var ids = {};
            if (graph && typeof graph.nodes === 'function') {
                var ns = graph.nodes() || [];
                for (var i = 0; i < ns.length; i++) ids[ns[i].id] = 1;
            }
            var k;
            for (k in results) { if (results.hasOwnProperty(k)) ids[k] = 1; }
            for (k in _inFlight) { if (_inFlight.hasOwnProperty(k)) ids[k] = 1; }
            for (k in _paramGen) { if (_paramGen.hasOwnProperty(k)) ids[k] = 1; }
            for (var id in ids) { if (ids.hasOwnProperty(id)) _paramGen[id] = (_paramGen[id] || 0) + 1; }
            results = {};
        }

        // ①：画布切换专用整体失效（_clearRuntime 改调本方法，替代 invalidateAll）：
        // 清 results/_inFlight 但不递增 _paramGen——写回防护只拦「参数被改」（clearResult
        // 递增参数代次）不拦「画布切换」：切画布/切模块窗口期完成的在途生成，结果仍须
        // 送达旧画布 _runGen 的 session.writeResult（产物文件已落盘；若代次整体递增则
        // runNodeAsync 返回 undefined → writeResult 被整体跳过 → 结果永久丢失）。
        // 防回归：递增 _switchEpoch 做孤儿化识别——切换后完成的在途执行，结果只进
        // 当次调用私有 orphaned 表（供返回值与同链下游取用），不落共享 results 缓存，
        // 新画布同 id 节点不会读到旧画布结果（跨画布串扰原语义保持）。
        function invalidateAllForSwitch() {
            _switchEpoch++;
            results = {};
            _inFlight = {};
            _inFlightGen = {};
        }

        // 收集上游输入（与原 executor 同款 image[] 累加逻辑）
        // extra：① 本调用私有的孤儿化结果表——画布切换后完成的上游不在共享
        // results 缓存，同链下游仍须能取到其输出（否则链条后半段拿不到输入）
        function collectInputs(nodeId, extra) {
            var inputs = {};
            var edges = graph.edges();
            for (var i = 0; i < edges.length; i++) {
                if (edges[i].to === nodeId) {
                    var upstream = results[edges[i].from];
                    // ①：切换孤儿化的上游结果不在共享缓存 → 取本调用私有表
                    if (upstream === undefined && extra) upstream = extra[edges[i].from];
                    if (upstream && upstream[edges[i].fromPort] !== undefined) {
                        var val = upstream[edges[i].fromPort];
                        var toType = graph.portTypeOf(nodeId, edges[i].toPort);
                        if (toType === 'image[]' || toType === 'video[]') {
                            if (!inputs[edges[i].toPort]) inputs[edges[i].toPort] = [];
                            if (Array.isArray(val)) {
                                inputs[edges[i].toPort] = inputs[edges[i].toPort].concat(val);
                            } else {
                                inputs[edges[i].toPort].push(val);
                            }
                        } else {
                            // image[] 输出连单值输入（canConnect 放行 image[]→image）：按序取首图。
                            // 仅限单值媒体类型；any（preview）保持原样收全量，text/number 不受影响
                            if ((toType === 'image' || toType === 'video') && Array.isArray(val)) {
                                val = val.length ? val[0] : undefined;
                            }
                            if (val !== undefined) inputs[edges[i].toPort] = val;
                        }
                    }
                }
            }
            return inputs;
        }

        // BFS 上游遍历收集依赖节点
        function collectUpstream(nodeId) {
            var visited = {};
            var queue = [nodeId];
            var order = [];
            visited[nodeId] = true;

            while (queue.length > 0) {
                var current = queue.shift();
                order.push(current);
                var edges = graph.edges();
                for (var i = 0; i < edges.length; i++) {
                    if (edges[i].to === current && !visited[edges[i].from]) {
                        visited[edges[i].from] = true;
                        queue.push(edges[i].from);
                    }
                }
            }
            return order;
        }

        // 拓扑排序（上游先、下游后）
        function topoSort(nodeIds) {
            var sorted = [];
            var visited = {};
            var temp = {};

            function visit(id) {
                if (temp[id]) throw new Error('检测到执行环: ' + id);
                if (visited[id]) return;
                temp[id] = true;
                var edges = graph.edges();
                for (var i = 0; i < edges.length; i++) {
                    if (edges[i].to === id && nodeIds.indexOf(edges[i].from) >= 0) {
                        visit(edges[i].from);
                    }
                }
                temp[id] = false;
                visited[id] = true;
                sorted.push(id);
            }

            for (var j = 0; j < nodeIds.length; j++) {
                if (!visited[nodeIds[j]]) visit(nodeIds[j]);
            }
            return sorted;  // 上游在前
        }

        // 单次执行上游节点数上限：防误操作超大图卡死主线程（正常工作流几十个节点）
        var MAX_EXEC_NODES = 500;

        // 主入口：异步执行目标节点（含所有上游）
        // runOpts: { onBatchIteration, batchOffset, canvasFile } 可选，逐节点独立，避免并发时共享变量覆盖
        // canvasFile: 调用方（canvasIndex._runGen）在提交前快照的画布文件——
        // 经 ctx 透传给 handler/runGenWorkflow，供 mapPrompt 把 promptId 路由到提交时刻的
        // 画布（提交 HTTP 往返窗口内切画布时，实时取值会错记画布 → 进度反馈丢失）
        async function runNodeAsync(nodeId, runOpts) {
            var node = graph.getNode(nodeId);
            if (!node) return null;
            runOpts = runOpts || {};
            // ①：本调用启动时的画布代次 + 私有孤儿表——invalidateAllForSwitch
            // 之后完成的执行视为「孤儿化」：结果不落共享 results（防跨画布同 id
            // 污染），但照常供本调用的返回值与同链下游 collectInputs 使用
            var startEpoch = _switchEpoch;
            var orphaned = {};

            // 收集所有上游节点
            var upstreamIds = collectUpstream(nodeId);
            // 节点数兜底：超上限拒绝执行（调用方 catch 后 Toast 提示）
            if (upstreamIds.length > MAX_EXEC_NODES) {
                throw new Error('上游节点数 ' + upstreamIds.length + ' 超过上限 ' + MAX_EXEC_NODES + '，请拆分工作流');
            }
            // 拓扑排序
            var sorted = topoSort(upstreamIds);

            // 按顺序执行每个节点
            for (var i = 0; i < sorted.length; i++) {
                var nid = sorted[i];
                if (isReady(nid)) continue;  // 已有缓存跳过

                var n = graph.getNode(nid);
                if (!n) continue;

                var handler = handlers[n.type];
                if (!handler) {
                    console.warn('[ComfyUI Canvas] 无执行器: ' + n.type);
                    continue;
                }

                var inputs = collectInputs(nid, orphaned);
                var ctx = {
                    controller: controller,
                    templateEngine: templateEngine,
                    service: service,
                    outputDir: outputDir,
                    graph: graph,
                    graphExecutor: self,
                    nodeId: nid,
                    onBatchIteration: runOpts.onBatchIteration || null,
                    batchOffset: runOpts.batchOffset || 0,
                    canvasFile: runOpts.canvasFile || null,   // 提交时刻画布快照
                    // 调用方（canvasIndex._runGen）的取消判定——handler/runGenWorkflow
                    // 在等待结算与落盘前检查，取消后迟到产物不再写盘（令牌失配即已取消/被取代）
                    isCancelled: runOpts.isCancelled || null
                };

                // handler 统一异步调用（本地节点同步返回、生成节点内部等 WebSocket 事件）
                // in-flight 互斥：并发 runNodeAsync（不同目标共享本上游，或同目标连点）到达同一节点时
                // 共享同一次执行——isReady 只认已完成、不认进行中，不共享则上游生成节点被重复提交
                // 代次校验：仅当代次一致（在途执行启动后参数未被改/缓存未被失效）才共享；
                // 上游在途期间 _invalidateCache 改了参数的话，并发执行须重新提交拿新参数结果
                var gen = _paramGen[nid] || 0;
                var execP = _inFlight[nid];
                if (!execP || _inFlightGen[nid] !== gen) {
                    execP = handler(inputs, n.params, ctx);
                    _inFlight[nid] = execP;
                    _inFlightGen[nid] = gen;
                }
                try {
                    var out = await execP;
                } finally {
                    // 结束（成功/失败/异常）即移除，防泄漏；身份校验防误删重试新一轮的表项
                    if (_inFlight[nid] === execP) { delete _inFlight[nid]; delete _inFlightGen[nid]; }
                }
                // 写回防护：执行期间代次已变（参数被改、缓存被失效）则不回写，
                // 防旧参数结果在失效后落缓存、顶掉新一轮执行的新结果
                // ①：画布切换（_switchEpoch 变）不拦「送达调用方」——改落本
                // 调用私有 orphaned 表（session.writeResult 依赖 runNodeAsync 返回值）
                if ((_paramGen[nid] || 0) === gen) {
                    if (startEpoch === _switchEpoch) {
                        results[nid] = out;
                    } else {
                        orphaned[nid] = out;
                    }
                }
            }

            // ①：目标节点被画布切换孤儿化 → 返回私有结果（旧画布 _runGen 的
            // session.writeResult 依赖此返回值；返回 undefined → 产物已落盘却被
            // 整体跳过，且「生成完成」toast 照常弹出 → 结果永久丢失）
            if (orphaned.hasOwnProperty(nodeId)) return orphaned[nodeId];
            return results[nodeId];
        }

        // 注册 promptId→nodeId 映射（供 handler 记录，便于调试/追踪）
        // canvasFile: 调用方快照的提交时刻画布文件——透传 onMapPrompt，
        // 替代消费侧实时取 _curCanvasFile()（提交往返窗口内切画布时进度路由错记画布）
        function mapPrompt(promptId, nodeId, canvasFile) {
            // FIFO 淘汰——新键插入前超上限则按插入序删最旧；重复注册同一
            // promptId 仅更新 nodeId，不新增条目不触发淘汰
            if (!_promptMap.hasOwnProperty(promptId)) {
                var keys = Object.keys(_promptMap);
                if (keys.length >= _PROMPT_MAP_MAX) {
                    var drop = keys.length - _PROMPT_MAP_MAX + 1;
                    for (var di = 0; di < drop; di++) delete _promptMap[keys[di]];
                }
            }
            _promptMap[promptId] = nodeId;
            if (onMapPrompt) onMapPrompt(promptId, nodeId, canvasFile);
        }

        // 直接设置节点结果（供队列批次合并使用）
        function setResult(nodeId, val) {
            results[nodeId] = val;
        }

        // 组装 self 引用（在 return 前补全，供 ctx.graphExecutor 传递）
        self.runNodeAsync = runNodeAsync;
        self.getResult = getResult;
        self.setResult = setResult;
        self.isReady = isReady;
        self.clearResult = clearResult;
        self.clearInFlight = clearInFlight;
        self.invalidateAll = invalidateAll;
        self.invalidateAllForSwitch = invalidateAllForSwitch;   // ①
        self.mapPrompt = mapPrompt;

        return self;
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createGraphExecutor = createGraphExecutor;
})(window);
