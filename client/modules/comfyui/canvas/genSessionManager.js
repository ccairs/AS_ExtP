// Generation Session 管理器
// 将生成状态从画布 DOM 中抽离，存入全局持久化的 Session 对象。
// WebSocket 回调写入 Session，Session 在 attached 时渲染 DOM、detached 时缓存数据。
// 自包含：不依赖 graph、DOM、executor 等外部模块。
(function (global) {
    'use strict';

    function createGenerationSession(nodeId, canvasFile) {
        // ── 持久状态（跨画布/模块切换存活）──
        var state = {
            nodeId: nodeId,
            canvasFile: canvasFile,
            status: 'running',           // 'running' | 'done' | 'error'
            batch: {
                frameHTMLs: [],           // 每帧 HTML（占位符 or 实图）
                placeholders: [],         // Array<{idx, path, pct, nodeName}>
                batchCurIdx: 0,           // 当前显示帧
                batchBase: 0,             // 队列批次偏移量
            },
            multi: {
                images: null,             // 多图路径列表（null 表示非多图模式）
                curIdx: 0,
            },
            results: {
                images: [],               // 所有批次图片路径（累积）
                videos: [],               // 所有批次视频路径（与 images 同语义累积）——只存
                                          // 最后一轮，videoGen 批量/队列多批时前批视频从 session 与
                                          // _result.videos 丢失（「导出到 AE」只导出最后一批，且文件
                                          // 因无节点引用会被 24h 临时清理误删）
                finalResult: null,        // executor 最终返回
                error: null,
            },
            queue: [],                    // 待执行批次大小列表
            progress: {
                pct: '',
                nodeName: '',
            },
            genParamsFp: null,            // 生成时参数指纹（attach 回填 executor 缓存前比对）
        };

        // ── 瞬态（不持久化）──
        var _attached = false;
        var _renderFns = null;
        var _phFrameHTML = null;   // 占位帧 HTML 生成函数（attach 后保存，detach 后保留）
        var _imgFrameHTML = null;  // 实图帧 HTML 生成函数（同上）

        // ── 内部方法 ──

        // 将 session 状态同步到 node.params，让现有 render 函数无感运行
        function _syncToNode(node) {
            if (!node || !node.params) return;
            node.params._frameHTMLs = state.batch.frameHTMLs.slice();
            node.params._placeholders = state.batch.placeholders.map(function (p) {
                return { idx: p.idx, path: p.path, pct: p.pct, nodeName: p.nodeName };
            });
            node.params._batchCurIdx = state.batch.batchCurIdx;
            if (state.multi.images) {
                node.params._multiImgs = state.multi.images.slice();
                node.params._multiCurIdx = state.multi.curIdx;
            } else {
                node.params._multiImgs = null;
                node.params._multiCurIdx = null;
            }
        }

        // 尝试获取 graph 节点（仅在 attached 时可用）
        function _getNode() {
            if (!_attached || !_renderFns || !_renderFns.getNode) return null;
            try { return _renderFns.getNode(state.nodeId); } catch (e) { return null; }
        }

        // ── 生成参数指纹 ──
        // attach 回填 executor 缓存（setExecutorResult）前比对：undo 恢复后的节点参数
        // 与生成时不一致（如生成→改参再生成→undo 回原参数）则不回填，防下游执行
        // 复用与已撤销参数不一致的缓存结果。指纹剔除会话/显示簿记键（_syncToNode 写入
        // 的轮播状态与 _result 预览缓存，均非生成输入），key 排序后序列化保证稳定。
        // batch_size 不参与指纹——队列批次处理中 canvasIndex._runGen 会临时把
        // node.params.batch_size 改写为出队批次数（finally 才恢复），而 writeResult 发生在
        // 恢复之前，参与比对会把所有队列批次的缓存回填误判为参数不一致
        var _TRANSIENT_KEYS = ['_frameHTMLs', '_placeholders', '_batchCurIdx', '_multiImgs', '_multiCurIdx', '_result', 'batch_size'];
        function _paramsFingerprint(params) {
            if (!params) return 'null';
            var keys = [];
            for (var k in params) {
                if (!params.hasOwnProperty(k)) continue;
                if (_TRANSIENT_KEYS.indexOf(k) >= 0) continue;
                keys.push(k);
            }
            keys.sort();
            var sorted = {};
            for (var i = 0; i < keys.length; i++) sorted[keys[i]] = params[keys[i]];
            try { return JSON.stringify(sorted); } catch (e) { return 'unserializable'; }
        }
        // 生成启动时调用（_runGen 在 createSession 后）：记录本次生成参数指纹
        function markGenParams(params) {
            state.genParamsFp = _paramsFingerprint(params);
        }
        // attach 回填前校验：节点当前参数与生成时一致（或未记录指纹——兼容未走 markGenParams
        // 的路径，如队列恢复）才回填。node 缺失（同 id 节点已不存在）时视为不匹配。
        function _paramsMatchNode(node) {
            if (state.genParamsFp === null || state.genParamsFp === undefined) return true;
            if (!node) return false;
            return _paramsFingerprint(node.params) === state.genParamsFp;
        }

        // 在 _syncToNode 之前调用：保留用户通过 _renderBatchFrameAt 切换的帧索引
        // 防止 write 回调的 _syncToNode 用旧 state.batch.batchCurIdx 覆盖用户选择
        function _preserveBatchCurIdx(node) {
            if (node && node.params && node.params._batchCurIdx !== undefined) {
                state.batch.batchCurIdx = node.params._batchCurIdx;
            }
        }

        // 从 node.params 读回状态（renderFns 可能修改了 node.params，如 refreshDownstreamPreviews 的补填逻辑）
        function _syncFromNode(node) {
            if (!node || !node.params) return;
            if (node.params._frameHTMLs) {
                state.batch.frameHTMLs = node.params._frameHTMLs.slice();
            }
            if (node.params._placeholders) {
                state.batch.placeholders = node.params._placeholders.map(function (p) {
                    return { idx: p.idx, path: p.path, pct: p.pct, nodeName: p.nodeName };
                });
            } else if (state.batch.placeholders.length > 0) {
                // refreshDownstreamPreviews 清空了 _placeholders（allDone）— 同步到 session，
                // 防止 writeProgress 找到陈旧的 path:null 条目而覆盖已填充的实图帧
                state.batch.placeholders = [];
            }
            if (node.params._batchCurIdx !== undefined) {
                state.batch.batchCurIdx = node.params._batchCurIdx;
            }
            if (node.params._multiImgs) {
                state.multi.images = node.params._multiImgs.slice();
                state.multi.curIdx = node.params._multiCurIdx || 0;
            }
        }

        // ── 公开方法 ──

        // 初始化批次帧数组（替代 _renderBatchCarousel）
        function initBatch(base, count, isAppend) {
            if (!isAppend) {
                state.batch.frameHTMLs = [];
                state.batch.placeholders = [];
                state.batch.batchCurIdx = 0;
            }
            state.batch.batchBase = base;
            var startIdx = state.batch.frameHTMLs.length;
            for (var i = 0; i < count; i++) {
                var isWaiting = isAppend || i > 0;
                state.batch.frameHTMLs.push(_phFrameHTML ? _phFrameHTML('0%', '', isWaiting) : '');
                state.batch.placeholders.push({ idx: startIdx + i, path: null, pct: '0%', nodeName: '' });
            }
            // 渲染
            if (_attached) {
                var node = _getNode();
                if (node) {
                    _syncToNode(node);
                    var renderIdx = isAppend ? state.batch.batchCurIdx : 0;
                    if (_renderFns.renderBatchFrameAt) {
                        _renderFns.renderBatchFrameAt(state.nodeId, renderIdx);
                    }
                }
            }
        }

        // 批次回调：填充实图帧（替代 _fillBatchFrame 调用）
        // batchIdx: 起始帧索引；paths: 本次迭代的所有图片路径（模型原生批量参数 n>1 时可能多张）
        function writeBatch(batchIdx, paths) {
            // 更新 session 内部状态：填充 paths.length 个连续帧
            for (var pi = 0; pi < paths.length; pi++) {
                var frameIdx = batchIdx + pi;
                for (var i = 0; i < state.batch.placeholders.length; i++) {
                    if (state.batch.placeholders[i].idx === frameIdx) {
                        state.batch.placeholders[i].path = paths[pi] || null;
                        state.batch.placeholders[i].pct = '100%';
                        break;
                    }
                }
                if (paths[pi] && frameIdx >= 0 && frameIdx < state.batch.frameHTMLs.length) {
                    state.batch.frameHTMLs[frameIdx] = _imgFrameHTML ? _imgFrameHTML(paths[pi]) : '';
                }
            }
            // 注意：图片累积由 writeResult 独占负责，writeBatch 仅更新帧数据，避免重复累积
            // 渲染
            if (_attached) {
                var node = _getNode();
                if (node) {
                    _preserveBatchCurIdx(node);
                    _syncToNode(node);
                    if (_renderFns.fillBatchFrame) {
                        _renderFns.fillBatchFrame(state.nodeId, batchIdx, paths);
                    }
                }
            }
        }

        // 进度回调：更新占位符进度（替代 _updatePlaceholderProgress）
        // pct 和 nodeName 分两次调用（onProgress/onExecuting），各自非空时才更新，避免互相覆盖
        function writeProgress(pct, nodeName) {
            if (pct) state.progress.pct = pct;
            if (nodeName) state.progress.nodeName = nodeName;
            if (state.batch.frameHTMLs.length > 0) {
                // 批次模式：更新第一个未完成的占位符
                for (var i = 0; i < state.batch.placeholders.length; i++) {
                    if (!state.batch.placeholders[i].path) {
                        if (pct) state.batch.placeholders[i].pct = pct;
                        if (nodeName) state.batch.placeholders[i].nodeName = nodeName;
                        var idx = state.batch.placeholders[i].idx;
                        if (idx >= 0 && idx < state.batch.frameHTMLs.length) {
                            state.batch.frameHTMLs[idx] = _phFrameHTML ?
                                _phFrameHTML(state.batch.placeholders[i].pct, state.batch.placeholders[i].nodeName, false) : '';
                        }
                        break;
                    }
                }
                // 渲染
                if (_attached) {
                    var node = _getNode();
                    if (node) {
                        _preserveBatchCurIdx(node);
                        _syncToNode(node);
                        if (_renderFns.updatePlaceholderProgress) {
                            _renderFns.updatePlaceholderProgress(state.nodeId, pct, nodeName);
                        }
                    }
                }
            } else if (_attached) {
                // 单帧模式：直接更新进度条 DOM（pct 和 nodeName 分两次调用，各自非空时才更新）
                if (pct && _renderFns.updateGenProgress) {
                    _renderFns.updateGenProgress(state.nodeId, pct);
                }
                if (nodeName && _renderFns.updateGenExecuting) {
                    _renderFns.updateGenExecuting(state.nodeId, nodeName);
                }
            }
        }

        // 存最终结果（替代 _runGen 中的 setResult + refreshDownstream）
        function writeResult(result) {
            if (!result) return;
            // 归一化 image → images（部分 handler 只返回 image 字段）
            if (result.image && !(result.images && result.images.length)) {
                result = { images: [result.image], text: result.text, video: result.video, image: result.image };
            }
            // 累积 images（队列场景：已有 images + 新 images）
            // 使用 Object.assign 保留 result 中其他非标准字段（如 gif 等）
            if (result.images && state.results.images.length > 0) {
                var merged = state.results.images.filter(function (p) { return p !== null; });
                result = Object.assign({}, result, { images: merged.concat(result.images) });
            }
            // videos 同语义累积（videoGen 每轮 execute 返回 {videos:[单批]}，
            // 只存最后一轮会让批量/队列的前批视频从 session/_result.videos 丢失）
            if (result.videos && state.results.videos.length > 0) {
                result = Object.assign({}, result, { videos: state.results.videos.concat(result.videos) });
            }
            if (result.images) {
                state.results.images = result.images.slice();
            }
            if (result.videos) {
                state.results.videos = result.videos.slice();
            }
            state.results.finalResult = result;
            state.results.error = null;
            // 错误后恢复：新结果到达时重置状态为 running（markDone 会设为 done）
            if (state.status === 'error') state.status = 'running';

            // 非批次路径：初始化 multi 状态
            if (state.batch.frameHTMLs.length === 0) {
                var imgPaths = result.images || (result.image ? [result.image] : []) || [];
                if (imgPaths.length > 0) {
                    state.multi.images = imgPaths;
                    state.multi.curIdx = 0;
                }
            }

            // 渲染
            if (_attached) {
                var node = _getNode();
                if (node) {
                    // 指纹校验提前到 _syncToNode 之前——指纹只拦 setExecutorResult 时，
                    // _syncToNode 仍无条件把迟到结果的轮播帧/多图槽写进 undo 恢复后节点的
                    // params 并渲染旧图，随 markDirty 落盘污染快照。参数不一致时节点回填块跳过；
                    // refreshDownstreamPreviews 保留不拦（语义：预览刷新尝试不走门禁，
                    // 且 setExecutorResult 未回填时下游无旧结果可刷）
                    var _paramsOk = _paramsMatchNode(node);
                    if (_paramsOk) {
                        _preserveBatchCurIdx(node);
                        _syncToNode(node);
                    }
                    if (_renderFns.setExecutorResult) {
                        // 与 attach 同口径做指纹校验——undo 恢复（或生成中改参）后
                        // 节点参数与生成时不一致时，迟到的 writeResult 不得回填 executor 缓存
                        // （否则绕过 executor 的代次守卫，下游 isReady 命中并静默复用与
                        // 当前参数不一致的旧结果）
                        if (_paramsOk) {
                            _renderFns.setExecutorResult(state.nodeId, result);
                        }
                    }
                    if (_renderFns.refreshDownstreamPreviews) {
                        _renderFns.refreshDownstreamPreviews(state.nodeId);
                        // refreshDownstreamPreviews 可能补填未完成的帧（兜底逻辑），读回修改
                        _syncFromNode(node);
                    }
                }
            }
        }

        // 存错误
        function writeError(msg) {
            state.results.error = msg || '生成失败';
            state.status = 'error';
            if (_attached) {
                if (_renderFns && _renderFns.showPreviewError) {
                    _renderFns.showPreviewError(state.nodeId, msg || '生成失败');
                }
            }
        }

        // 队列操作
        function enqueue(batchSize) {
            state.queue.push(batchSize);
        }
        function dequeue() {
            return state.queue.shift();
        }
        function hasQueued() {
            return state.queue.length > 0;
        }
        function clearQueue() {
            state.queue = [];
        }

        // 绑定渲染回调，全量恢复 DOM
        function attach(renderFns) {
            _attached = true;
            _renderFns = renderFns;
            // 保存 HTML 生成函数（纯函数，detach 后保留）
            if (renderFns.phFrameHTML) _phFrameHTML = renderFns.phFrameHTML;
            if (renderFns.imgFrameHTML) _imgFrameHTML = renderFns.imgFrameHTML;

            var node = _getNode();
            if (!node) return;
            _syncToNode(node);

            // 全量恢复 DOM
            if (state.batch.frameHTMLs.length > 0) {
                // 批次模式：渲染当前帧
                if (_renderFns.renderBatchFrameAt) {
                    _renderFns.renderBatchFrameAt(state.nodeId, state.batch.batchCurIdx);
                }
                // 批次模式下若发生错误，优先恢复错误状态（而非 finalResult）
                if (state.results.error) {
                    if (_renderFns.showPreviewError) {
                        _renderFns.showPreviewError(state.nodeId, state.results.error);
                    }
                } else if (state.results.finalResult) {
                    // 批次已完成（有 finalResult）时，还需恢复 executor 缓存 + 刷新下游预览
                    // 参数与生成时不一致（undo 恢复）则不回填缓存——下游须按当前参数重新执行
                    if (_renderFns.setExecutorResult && _paramsMatchNode(node)) {
                        _renderFns.setExecutorResult(state.nodeId, state.results.finalResult);
                    }
                    if (_renderFns.refreshDownstreamPreviews) {
                        _renderFns.refreshDownstreamPreviews(state.nodeId);
                        // refreshDownstreamPreviews 可能补填未完成的帧（兜底逻辑），读回修改
                        _syncFromNode(node);
                    }
                }
            } else if (state.results.error) {
                // 错误状态
                if (_renderFns.showPreviewError) {
                    _renderFns.showPreviewError(state.nodeId, state.results.error);
                }
            } else if (state.results.finalResult) {
                // 完成状态：恢复 executor 缓存 + 渲染预览
                // 参数与生成时不一致（undo 恢复）则不回填缓存——下游须按当前参数重新执行
                if (_renderFns.setExecutorResult && _paramsMatchNode(node)) {
                    _renderFns.setExecutorResult(state.nodeId, state.results.finalResult);
                }
                if (_renderFns.refreshDownstreamPreviews) {
                    _renderFns.refreshDownstreamPreviews(state.nodeId);
                    _syncFromNode(node);
                }
            } else if (state.status === 'running') {
                // 仍在生成中：显示生成中占位
                if (_renderFns.showPreviewGenerating) {
                    _renderFns.showPreviewGenerating(state.nodeId);
                }
                // 恢复缓存的进度（单帧模式：进度条；批次模式：占位符已通过 _syncToNode 恢复）
                if (state.batch.frameHTMLs.length === 0) {
                    if (state.progress.pct && _renderFns.updateGenProgress) {
                        _renderFns.updateGenProgress(state.nodeId, state.progress.pct);
                    }
                    if (state.progress.nodeName && _renderFns.updateGenExecuting) {
                        _renderFns.updateGenExecuting(state.nodeId, state.progress.nodeName);
                    }
                }
            }
        }

        // 解绑渲染回调
        function detach() {
            _attached = false;
            _renderFns = null;
            // 保留 _phFrameHTML / _imgFrameHTML 供 detached 写入使用
        }

        function markDone() {
            if (state.status !== 'error') state.status = 'done';
        }

        // ── 返回 session 对象 ──
        return {
            initBatch: initBatch,
            writeBatch: writeBatch,
            writeProgress: writeProgress,
            writeResult: writeResult,
            writeError: writeError,
            enqueue: enqueue,
            dequeue: dequeue,
            hasQueued: hasQueued,
            clearQueue: clearQueue,
            attach: attach,
            detach: detach,
            markDone: markDone,
            markGenParams: markGenParams,   // 生成启动时记录参数指纹
            // 只读属性
            get nodeId() { return state.nodeId; },
            get canvasFile() { return state.canvasFile; },
            get status() { return state.status; },
            get batch() { return state.batch; },
            get multi() { return state.multi; },
            get results() { return state.results; },
            get queue() { return state.queue; },
            get progress() { return state.progress; },
            get isAttached() { return _attached; },
        };
    }

    function createGenSessionManager() {
        var _sessions = {};  // 复合键（canvasFile::nodeId）→ session

        // 复合键：跨画布 nodeId 冲突隔离。节点 id 仅在单次应用会话内唯一
        // （nodeSystem idCounter 重启重置，重启后向 id 较小的画布新增节点即产生区间重叠），
        // 裸 nodeId 键会让 A 画布 running 的 session 被 B 画布同 id 节点的
        // createSession 直接删除、进度/队列/在跑标记互相污染。
        // canvasFile 为空（画布未保存等）时归一为 '__default__'，保证键空间一致。
        function _sessKey(canvasFile, nodeId) {
            return (canvasFile || '__default__') + '::' + nodeId;
        }

        function createSession(nodeId, canvasFile) {
            var key = _sessKey(canvasFile, nodeId);
            // 如果已存在同键（同画布同节点）的 session，先移除（前一次生成已完成）
            if (_sessions[key]) {
                delete _sessions[key];
            }
            var session = createGenerationSession(nodeId, canvasFile);
            _sessions[key] = session;
            return session;
        }

        function getSession(nodeId, canvasFile) {
            return _sessions[_sessKey(canvasFile, nodeId)] || null;
        }

        function removeSession(nodeId, canvasFile) {
            delete _sessions[_sessKey(canvasFile, nodeId)];
        }

        function hasActive(canvasFile) {
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) {
                var s = _sessions[keys[i]];
                if (s.status === 'running') {
                    if (!canvasFile || s.canvasFile === canvasFile) return true;
                }
            }
            return false;
        }

        function getActiveSessions(canvasFile) {
            var result = [];
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) {
                var s = _sessions[keys[i]];
                if (s.status === 'running') {
                    if (!canvasFile || s.canvasFile === canvasFile) result.push(s);
                }
            }
            return result;
        }

        // ③：全部 session（含 done/error 未销毁的）——供 nodegen 引用收集：
        // done session 的产物不在 getActiveSessions（只含 running）中时无人引用 →
        // 24h 被 _cleanNodegenTemp 物理删除（session 存活期间产物必须仍受保护）
        function getAllSessions() {
            var result = [];
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) result.push(_sessions[keys[i]]);
            return result;
        }

        // 切画布：脱绑该画布所有 session
        function detachCanvas(canvasFile) {
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) {
                var s = _sessions[keys[i]];
                if (s.canvasFile === canvasFile) {
                    s.detach();
                }
            }
        }

        // 切回：重绑 + 恢复 DOM，返回已恢复 nodeId 列表
        function reattachCanvas(canvasFile, renderFns) {
            // 先清理其他画布的已完成 session（防止堆积）
            clearCompleted(canvasFile);
            var restoredIds = [];
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) {
                var s = _sessions[keys[i]];
                if (s.canvasFile === canvasFile) {
                    s.attach(renderFns);
                    restoredIds.push(s.nodeId);
                }
            }
            return restoredIds;
        }

        // 切模块：全部脱绑（session 存活）
        function detachAll() {
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) {
                _sessions[keys[i]].detach();
            }
        }

        // 切回模块：重绑
        function reattachAll(canvasFile, renderFns) {
            return reattachCanvas(canvasFile, renderFns);
        }

        // 移除 done/error 的 session
        // keepCanvasFile: 指定则仅清理非该画布的已完成 session
        function clearCompleted(keepCanvasFile) {
            var keys = Object.keys(_sessions);
            for (var i = 0; i < keys.length; i++) {
                var s = _sessions[keys[i]];
                if (s.status !== 'running') {
                    if (keepCanvasFile && s.canvasFile === keepCanvasFile) continue;
                    delete _sessions[keys[i]];
                }
            }
        }

        return {
            createSession: createSession,
            getSession: getSession,
            removeSession: removeSession,
            hasActive: hasActive,
            getActiveSessions: getActiveSessions,
            getAllSessions: getAllSessions,   // ③
            detachCanvas: detachCanvas,
            reattachCanvas: reattachCanvas,
            detachAll: detachAll,
            reattachAll: reattachAll,
            clearCompleted: clearCompleted,
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createGenSessionManager = createGenSessionManager;
})(window);
