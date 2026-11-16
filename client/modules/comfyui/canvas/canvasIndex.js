(function (global) {
    // 画布入口 API 工厂（替代原入口模块）
    // 挂载: canvasIndex.mount({ controller, hostApi, dataDir, outputDir })
    // 卸载: canvasIndex.unmount()
    // 依赖: AEComfyUI 命名空间下的所有 canvas 组件 + controller
    //
    // ── 画布模块文件职责（client/modules/comfyui/canvas/）──
    //   canvasIndex.js     本文件：画布入口，挂载/卸载/事件接线/持久化/gen 容器管理
    //   canvasView.js      视口/平移/缩放/DOM 容器
    //   canvasController.js 连线交互：hover 圆圈、拖线、吸附、右键创建节点
    //   nodeSystem.js      图数据模型（节点/边/参数）+ 端口规则（canConnect/anchorY 唯一真相源）
    //   nodeRenderer.js    节点 DOM 创建
    //   edgeRenderer.js    连线 SVG 渲染（portPos 端点坐标）
    //   graphExecutor.js   图执行：BFS 上游遍历 + 拓扑排序 + collectInputs 喂上游输出
    //   sharedUtils.js     runGenWorkflow：gen 节点公共生成流（上传→渲染 workflow→提交→落盘）
    //   nodegenStore.js    graph.json 读写（持久化）
    //   nodes/*.js         各节点 def（type/inputs/outputs/execute/renderEditor）
    //   ../templateEngine.js  workflow 渲染（pipeline 占位符替换 vs non-pipeline 动态拼）
    //   ../models/template-list.json  模型元数据（classType/imageInputKeys/videoInputKeys 等）
    //   ../templates/*.json    workflow 定义（pipeline 模板的占位符结构）
    //
    // ── 核心调用链 1：点"生成"执行一个 gen 节点 ──
    //   canvasIndex._runGen(nodeId)
    //     → graphExecutor.runNodeAsync(nodeId)
    //         → collectUpstream + topoSort → 逐节点 handler
    //         → collectInputs(nodeId) 按 toPort 累加上游输出（image[] 累加，其余覆盖）
    //         → nodeDef.execute(inputs, params, ctx)   [nodes/imageGenNode.js / videoGenNode.js]
    //             → sharedUtils.runGenWorkflow(def, inputs, params, ctx, opts)
    //                 → 上传上游图(imageNames)/视频(videoNames)/文本(覆盖 prompt)
    //                 → def.buildParamValues(effParams, imageNames, model, upPaths, videoNames)
    //                 → templateEngine.renderWorkflow(modelId, paramValues, imageNames, videoNames)
    //                     → pipeline: 模板 {{key}} 占位符替换
    //                     → non-pipeline: buildDynamicWorkflow（建 LoadImage/LoadVideo + 主节点 + Save*）
    //                 → controller.generateRaw(wf) → 等 ae:canvas-generation-done → 落盘
    //             → 返回 { images:[paths] } / { video:path }
    //
    // ── 核心调用链 2：拖线连接两个节点 ──
    //   canvasController._updateHoverCircle(mx,my)
    //     → _pickPortByY(def, side, nodeEl, my) 按鼠标 Y 选最近端口（自适应多端口）
    //     → 圆圈定位到 ports.anchorY(port, dir, nTop, nBottom)（nodeSystem 唯一真相源）
    //   mousedown → fromPort = hoverCircle._port（选中端口）
    //   拖动 → _updateTargetCircle → _nearestCompatiblePort 按鼠标 Y 选最近兼容端口
    //   松手 → graph.connect(from, fromPort, to, toPort)
    //     → nodeSystem.connect 校验 ports.canConnect(fromType, toType)
    //   重绘 → edgeRenderer.redrawAll → portPos 用 ports.anchorY 算端点 Y
    //   端口锚点 Y 唯一真相源：nodeSystem.ports.anchorY（gen 节点无常驻端口标记，锚点仅连线落点体现）

    function createCanvasIndex() {
        var _mounted = false;
        var _view = null;          // canvasView
        var _graph = null;         // nodeSystem graph
        var _ctrl = null;          // canvasController（交互）
        var _gridOrphanSet = {};   // path -> Date.now()，节点删除时标记的 grid 临时文件
        var _gridCleanTimer = null;
        var _store = null;         // nodegenStore
        var _executor = null;      // graphExecutor
        var _panel = null;         // floatingPanel
        var _panelChat = null;     // panelChat
        var _panelCtx = null;      // contextManager（nodegen_panel_session_v1）
        var _panelStore = null;    // 文件 sessionStore（替代 localStorage 持久化面板历史）
        var _panelSaveTimer = null; // 面板历史防抖写盘定时器
        // 画布模块未就绪锁——**仅注册表（canvases.json）级**读取/解析失败时置位：
        // 此时无法确定该画哪些画布，故中止加载流程并禁止一切注册表落盘，直到本次会话重启。
        // 粒度修正：单个画布文件（graph.json / canvas_<id>.json）的解析失败或通道故障
        // **不得**置位本锁——只标记/重置该画布（见 _handleCanvasFileFailure），否则一个坏
        // 文件会把切换/新建/改名/删除全部静默锁死，重启后 activeId 仍指向坏文件 → 永久不可用。
        var _canvasReadFailed = false;
        // 粒度修正：文件级不可用标记 canvasId → { code, message, at }。
        // 某画布文件通道故障（可能文件完好、只是读不到）时只记在这里：不渲染空态、
        // 不覆盖它的文件；切换/新建/改名/删除与其它画布照常。再次切回该画布会重试加载，
        // 成功即清除标记（通道恢复/手工修好文件的用户出口），无需重启面板。
        var _unusableCanvases = {};
        // 面板历史读取失败锁——load 返回 __readFailed 哨兵时置位，
        // 不再按空历史渲染，并禁止覆盖性落盘（下一条消息的防抖 save 会整包覆盖原文件）。
        var _panelHistoryReadFailed = false;
        // 面板历史「加载落定」标记——sessionStore._readFailedIds 只在 load
        // **落定后**才置位（sessionStore.js _trackLoadResult）；store.init() 完成、load 未
        // 落定的窗口里 _panelCtx.list() 仍为 []，此窗口内 beforeunload 同步写 / 防抖 save
        // 会用空快照整包覆盖既有历史（vm 已复现）。load 落定（成功/哨兵/异常）才置 true；
        // 失败分支另有 _panelHistoryReadFailed 拦截。每次 _initFloatingPanel 重新加载前复位。
        var _panelHistoryLoaded = false;
        // 面板历史防抖写盘与落盘（模块级，供 _initFloatingPanel 与 unmount 共用）。
        function _schedulePanelSave() {
            if (_panelSaveTimer) clearTimeout(_panelSaveTimer);
            _panelSaveTimer = setTimeout(function () {
                _panelSaveTimer = null;
                _persistPanel();
            }, 400);
        }
        function _persistPanel() {
            if (_panelHistoryReadFailed) {
                console.warn('[ComfyUI Canvas] 面板历史读取失败，已禁止覆盖写（防原历史被空/新内容覆盖）');
                return;
            }
            // 加载未落定不写——_panelCtx.list() 尚为空/不完整，写盘会整包覆盖原历史
            if (!_panelHistoryLoaded) {
                console.warn('[ComfyUI Canvas] 面板历史尚未加载完成，跳过写盘（防未加载快照覆盖原历史）');
                return;
            }
            if (_panelStore && _panelCtx && typeof _panelCtx.list === 'function') {
                var _msgs = _panelCtx.list();
                // 确保 store 索引已初始化（_doSave 迭代 _index.sessions），避免首写竞态抛错
                _panelStore.whenReady().then(function () {
                    _panelStore.save('nodegen_panel', _msgs);
                });
            }
        }
        var _streamingMsg = null;  // 流式占位 DOM
        var _panelOnModel = null;  // ae:default-llm-changed 回调（unmount 摘除）
        var _panelOnSettingsObserver = null;  // #settingsModal 显隐监听（unmount 断开）
        var _activeEditor = null;  // imageEditor
        var _comfyController = null;  // comfyui controller（引用）
        var _canvasContainer = null; // .comfyui-canvas-view（画布容器，拖拽事件绑定在此）
        var _worldEl = null;       // #ngWorld
        var _canvasEl = null;      // #ngCanvas
        var _topbarEl = null;      // .ng-topbar
        var _hostApi = null;
        var _dataDir = '';
        var _outputDir = '';
        var _onCanvasDragOver = null;
        var _onCanvasDragEnter = null;
        var _onCanvasDragLeave = null;
        var _onCanvasDrop = null;
        var _dragEnterCount = 0;
        var _onDocDragOver = null;     // document 级 dragover 兜底
        var _onDocDrop = null;         // document 级 drop 兜底
        var _onKeyDown = null;
        var _onNodeResized = null;
        var _minimap = null;           // 左下角缩略图 DOM
        var _minimapUpdate = null;     // 缩略图刷新函数
        var _topbarZoomLbl = null;     // 顶栏缩放比例标签
        var _connLbl = null;           // 顶栏连接地址标签
        var _lastContextNodeId = null;  // 最后右键的节点，Del 键删除用
        var _activeGenNodeId = null;   // 当前展开容器的 gen 节点 ID，null = 无展开
        var _generatingNodeMap = {};  // 正在生成节点：promptId → {canvasFile, nodeId}（节点 ID 不再随 reload 变化）
        var _genTokens = {};          // _runGen 实例令牌（复合键 → token）：防止旧 _runGen finally 误清新 promptId 映射
        var _runningNodes = {};       // _runGen 同步在跑标记（复合键 → 引用计数）：promptId 映射要等 HTTP 提交后才写入，
                                      // 空窗内连点"生成"会穿透 _isNodeGenerating 守卫 → createSession 销毁在跑 session

        // 生成态复合键（canvasFile::nodeId）：跨画布 nodeId 冲突隔离——nodeSystem idCounter
        // 重启重置后两个画布文件的 id 区间可重叠，裸 nodeId 键会让 A 画布在跑的
        // session/令牌/在跑标记被 B 画布同 id 节点互相污染。
        // canvasFile 为空时归一 '__default__'（与 genSessionManager._sessKey 同口径）。
        function _genKey(canvasFile, nodeId) {
            return (canvasFile || '__default__') + '::' + nodeId;
        }
        function _curCanvasFile() {
            return (_store ? _store.getFile() : null) || '__default__';
        }
        var _genInputEl = null;        // 容器 DOM 元素（懒创建，复用）
        var _genInputAnimRaf = null;   // 容器入场动画 rAF id（关闭/卸载时需 cancel，防止回调操作已隐藏的 DOM）
        var _selectedNodes = {};       // { nodeId: true } 当前选中节点
        var _topZIndex = 1;            // 节点 z-index 递增计数器：最后操作的节点在最上层
        var _ZINDEX_CEILING = 9999;   // z-index 归一化阈值：超过后重排所有节点 z-index

        // 递增 z-index 计数器，超过阈值时归一化防无限增长
        function _bumpZIndex() {
            _topZIndex++;
            if (_topZIndex > _ZINDEX_CEILING) _normalizeZIndex();
            return _topZIndex;
        }

        // 归一化：按当前 z-index 升序重新分配连续小值
        function _normalizeZIndex() {
            if (!_worldEl) return;
            var nodes = _worldEl.querySelectorAll('.ng-node');
            var arr = [];
            for (var i = 0; i < nodes.length; i++) {
                arr.push({ el: nodes[i], z: parseInt(nodes[i].style.zIndex) || 0 });
            }
            arr.sort(function (a, b) { return a.z - b.z; });
            for (var j = 0; j < arr.length; j++) {
                arr[j].el.style.zIndex = String(j + 1);
            }
            _topZIndex = arr.length;
        }

        var _groups = [];             // 分组列表 [{id,title,x,y,w,h,color,note,childIds}]
        var _groupOrigins = {};       // 分组拖拽原始位置记录
        var _groupRenderer = null;    // 分组框渲染器
        var _ctx = null;              // 编辑器上下文，传给各节点 renderEditor
        var _history = null;          // 画布 undo/redo 历史栈
        var _hDebounce = null;        // 参数编辑防抖 push 定时器
        var _canvases = [];           // 画布注册表 [{id,name,file,createdAt,updatedAt}]
        var _activeCanvasId = null;   // 当前画布 id
        var _canvasBtnEl = null;      // 顶栏画布切换按钮
        var _canvasMenuEl = null;     // 画布下拉菜单
        var _onCanvasMenuOutside = null;  // 画布菜单外部点击监听器（unmount 移除）
        var _loadToken = 0;               // 画布加载令牌：快速切换时丢弃乱序完成的旧 load 回调
        var _genSessionMgr = null;        // Generation Session 管理器（全局单例，跨画布/模块切换存活）


        // ── 退出落盘─────────────────────────────────────────────
        // 4b 收口：卸载写改走同步入口（nodegenStore.flushSyncNow / sessionStore.flushSync）
        // 面板直接关闭（关窗/刷新）不走 unmount：画布节点图（nodegenStore 1.5s 防抖）与
        // 悬浮聊天历史（_schedulePanelSave 400ms 防抖 + sessionStore 写）在防抖窗口内
        // 未落盘即丢。main.js 的 beforeunload 只触达桌宠，画布模块
        // 自注册退出钩子。安全边界如实记录：
        //   · 画布图：调用 flushSyncNow()——无视在途异步写计数，同步原子写
        //     （writeFileSync→renameFileSync，Bridge 同步 XHR / cep.fs 原生同步）把当前
        //     快照落盘。若调 flush()：有在途写时只排队一次异步写，该异步链
        // （Bridge fetch）随页面销毁中断 → 最后一次编辑丢（半修收口）。
        //   · 浮聊：调用 sessionStore.flushSync('nodegen_panel', 当前消息快照)——同步写
        //     （AEFS.writeFileSync 内部含 cep.fs 同步回退）。若用 _persistPanel()+
        //     flush() 只能发起异步写，卸载窗口内不保证完成。同步通道不可用（降级 fs/
        //     旧 store）时退回异步 persist+flush（尽力而为，不阻塞退出）。
        // 幂等注册/解绑：重复 mount 不叠加；unmount 必须解绑（否则模块销毁后钩子仍持有
        // 旧闭包引用，重复 flush 已置空的数据）。
        var _onBeforeUnload = null;
        // 关面板耗时埋点（只测量）：本「退出落盘块」会被卸载钩子回归测试截取到
        // 无 global 标识符的沙箱里执行，
        // 故块内不得引用裸 global，只用 window 安全取全局。
        function _unloadTraceApi() {
            try {
                var g = (typeof window !== 'undefined') ? window : null;
                return (g && g.AEUnloadTrace) ? g.AEUnloadTrace : null;
            } catch (_) { return null; }
        }
        function _flushPendingOnUnloadInner() {
            _restoreBatchSizesBeforeFlush();   // 先恢复队列处理中的临时 batch_size（对齐 unmount）
            // 画布图：卸载专用同步落盘（无该入口的旧 store 退回 flush）
            if (_store) {
                if (typeof _store.flushSyncNow === 'function') _store.flushSyncNow();
                else _store.flush();
            }
            var _ut = _unloadTraceApi();
            if (_ut) _ut.mark('canvas.nodegen');
            if (_panelSaveTimer) { clearTimeout(_panelSaveTimer); _panelSaveTimer = null; }
            // 历史读取失败时不得写（挂起/同步写会整包覆盖读不出的原历史）
            if (_panelHistoryReadFailed) return;
            // load 未落定（store.init 完成后的加载窗口）同样不得写——
            // _readFailedIds 是 load 落定后才置位，此窗口 flushSync('nodegen_panel', [])
            // 会用空快照覆盖既有历史。落定前一律跳过浮聊写（画布图已在上方独立落盘）。
            if (!_panelHistoryLoaded) {
                console.warn('[ComfyUI Canvas] 面板历史尚未加载完成，跳过卸载同步写（防未加载快照覆盖原历史）');
                return;
            }
            // 浮聊：优先同步兜底；同步写失败或旧 store 无该接口时退回既有异步路径
            var _panelSyncOk = false;
            if (_panelStore && _panelCtx && typeof _panelCtx.list === 'function' &&
                typeof _panelStore.flushSync === 'function') {
                try {
                    _panelSyncOk = _panelStore.flushSync('nodegen_panel', _panelCtx.list()) === true;
                } catch (e) { _panelSyncOk = false; }
            }
            if (_ut) _ut.mark('canvas.panelChat');
            if (!_panelSyncOk) {
                if (_panelCtx && _panelStore) _persistPanel();
                if (_panelStore && typeof _panelStore.flush === 'function') _panelStore.flush();
            }
        }
        // 关面板耗时埋点（只测量）：包装既有卸载写，异常路径也落一条记录；
        // 包装不改变 inner 的返回值/副作用（inner 无返回值）。
        function _flushPendingOnUnload() {
            var ut = _unloadTraceApi();
            if (!ut) { _flushPendingOnUnloadInner(); return; }
            ut.begin('canvas');
            try {
                _flushPendingOnUnloadInner();
            } finally {
                ut.mark('canvas.end');
                ut.commit();
            }
        }
        function _bindUnloadFlush() {
            if (_onBeforeUnload) return;   // 幂等：已注册不重复叠加
            _onBeforeUnload = function () { _flushPendingOnUnload(); };
            window.addEventListener('beforeunload', _onBeforeUnload);
        }
        function _unbindUnloadFlush() {
            if (_onBeforeUnload) {
                window.removeEventListener('beforeunload', _onBeforeUnload);
                _onBeforeUnload = null;
            }
        }
        // ── 退出落盘块结束 ──

        // ============ mount / unmount ============

        function mount(containerContext) {
            if (_mounted) return;
            var cc = containerContext || {};
            _comfyController = cc.controller;
            _hostApi = cc.hostApi;

            // dataDir：优先用传入值 → AEShared.getDataDir() → 空串
            // containerContext 不含 dataDir（context.js 未注册该字段），故此处自行兜底
            _dataDir = cc.dataDir || '';
            if (!_dataDir && typeof global.AEShared !== 'undefined' && typeof global.AEShared.getDataDir === 'function') {
                var dd = global.AEShared.getDataDir();
                _dataDir = (dd && dd.dir) || '';
            }

            // 初始化 Generation Session 全局单例（跨画布/模块切换存活）
            if (!global.AEComfyUI._genSessionManager) {
                global.AEComfyUI._genSessionManager = global.AEComfyUI.createGenSessionManager();
            }
            _genSessionMgr = global.AEComfyUI._genSessionManager;

            // 创建画布 DOM（注入到 #comfyuiPanel 画布容器）
            var panel = document.getElementById('comfyuiPanel');
            if (!panel) return;

            // 查找或创建画布容器
            var canvasContainer = panel.querySelector('.comfyui-canvas-view');
            if (!canvasContainer) {
                canvasContainer = document.createElement('div');
                canvasContainer.className = 'comfyui-canvas-view';
                canvasContainer.style.cssText = 'width:100%;height:100%;position:relative;overflow:hidden;';
                panel.appendChild(canvasContainer);
            }
            canvasContainer.innerHTML = '';
            _canvasContainer = canvasContainer;

            // 构建画布 DOM
            _buildTopbar(canvasContainer);

            _canvasEl = document.createElement('div');
            _canvasEl.className = 'ng-canvas';
            _canvasEl.id = 'ngCanvas';
            _canvasEl.style.cssText = 'width:100%;height:calc(100% - 34px);position:relative;overflow:hidden;';
            canvasContainer.appendChild(_canvasEl);

            _worldEl = document.createElement('div');
            _worldEl.className = 'ng-world';
            _worldEl.id = 'ngWorld';
            _canvasEl.appendChild(_worldEl);

            // 挂载画布组件
            _view = global.AEComfyUI.createCanvasView(_canvasEl, _worldEl);
            // 平移/缩放时实时刷新连线
            _view.onTransform(function () {
                if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                if (_minimapUpdate) _minimapUpdate();
                if (_topbarZoomLbl && _view && _view.viewport) {
                    _topbarZoomLbl.textContent = Math.round(_view.viewport.scale * 100) + '%';
                }
                if (_activeGenNodeId) _positionGenInput();
            });
            _graph = global.AEComfyUI.createGraph();
            global.AEComfyUI.registerAllNodeDefs(_graph);

            _ctrl = global.AEComfyUI.createCanvasController({
                canvasEl: _canvasEl,
                worldEl: _worldEl,
                viewport: _view,
                graph: _graph,
                nodeDefs: global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : [],
                callbacks: {
                    onAddNode: _onAddNode,
                    onRemove: _onRemove,
                    onConnect: _onConnect,
                    onConnectBatch: _onConnectBatch,
                    onStructureBatch: function (phase) {
                        // 复合结构操作（拖线右键"创建并连线"）：begin 抑制子步骤历史，end 补一条合并历史
                        if (phase === 'start') _historyTxnBegin(); else _historyTxnEnd();
                    },
                    onDeleteEdge: _onDeleteEdge,
                    onCopy: _onCopy,
                    onMultiSelect: _onMultiSelect,
                    onRename: function (nid) { _startInlineRename(nid); },
                    onSetColor: function (nid, color) {
                        // 多选时批量变色：如果 nid 在选中列表中，对所有选中节点变色
                        var targets = [nid];
                        var selIds = Object.keys(_selectedNodes);
                        if (selIds.length > 1 && _selectedNodes[nid]) {
                            targets = selIds.filter(function (id) { return _graph.getNode(id); });
                        }
                        for (var ti = 0; ti < targets.length; ti++) {
                            var tid = targets[ti];
                            var cn = _graph.getNode(tid);
                            if (!cn) continue;
                            cn.color = color;
                            var el2 = _worldEl.querySelector('[data-node-id="' + tid + '"]');
                            if (el2) {
                                el2.style.borderColor = color || 'var(--border)';
                                el2.style.backgroundColor = color ? _hexToRgba(color, 0.08) : '';
                            }
                        }
                        if (_store) _store.markDirty();
                    },
                    onNoteChange: function (nid) {
                        var el2 = _worldEl.querySelector('[data-node-id="' + nid + '"]');
                        if (el2 && el2._startNoteEdit) el2._startNoteEdit();
                    },
                    onEdit: _onEditCallback,
                    onExport: _onExportNode,
                    onSplit: _onSplitNode,
                    onComposeGrid: _onComposeGrid,
                    onSplitGrid: function (nid, cols) { _onSplitGrid(nid, cols); },
                    getSelectedImages: _collectSelectedImages,
                    onContextSelect: function (nid) {
                        // 右键未选中节点 → 单选它（已选中的多选保持，供「组成多宫格」使用）
                        if (nid && !_selectedNodes[nid]) _selectNode(nid, null);
                    },
                    getSelectedCount: function () { return Object.keys(_selectedNodes).length; },
                    // 多选批量接线：controller 取选中节点 id（顺序即接入顺序），分组 id 与不存在节点由它归一化
                    getSelectedNodeIds: function () {
                        var out = [];
                        var ids = Object.keys(_selectedNodes);
                        for (var i = 0; i < ids.length; i++) {
                            if (ids[i].indexOf('g_') === 0) continue;
                            if (!_graph.getNode(ids[i])) continue;
                            out.push(ids[i]);
                        }
                        return out;
                    },
                    onGroupCreate: _onGroupCreate,
                    onGroupRename: _onGroupRename,
                    onGroupColor: _onGroupColor,
                    onGroupSetColor: function (gid, color) {
                        for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === gid) { _groups[gx].color = color; break; } }
                        if (_groupRenderer) _groupRenderer.setColor(gid, color);
                        _store && _store.markDirty();
                    },
                    onGroupNote: _onGroupNote,
                    onGroupUngroup: _onGroupUngroup
                }
            });

            // 初始化输出目录
            _outputDir = cc.outputDir || '';

            // 初始化存储
            _store = global.AEComfyUI.createNodegenStore({
                dir: _dataDir,
                graph: _graph
            });
            _store.setGroupsRef(_groups);

            // ── undo/redo 历史栈 ──
            // 快照 = snapshotForHistory（nodes+edges+groups 按引用拼装，不做深拷贝）+ 栈内
            // 一次 JSON.stringify/parse 解耦（见 canvasHistory.push：一次序列化即解耦，
            // 避免深拷贝后再被去重键二次 stringify）；
            // restore = 全量重建（applyToGraph 灌回）。
            // markDirty 时 onDirty 触发防抖 push（参数编辑兜底）；结构操作额外立即 _pushHistory。
            _history = global.AEComfyUI.createCanvasHistory({
                serialize: function () { return _store.snapshotForHistory(_graph, _groups); },
                restore: _restoreSnapshot,
                maxSize: 50
            });
            _store.setOnDirty(_scheduleHistoryPush);

            // ── 编辑器上下文：renderEditor(el, node, ctx) 各节点从 ctx 拿能力 ──
            var self = {};
            self.graph = _graph;
            self.store = _store;
            self.controller = _comfyController;
            self.view = _view;
            self.ctrl = _ctrl;
            self.hostApi = _hostApi;
            Object.defineProperty(self, 'outputDir', { get: function () { return _outputDir; } });
            self.mounted = function () { return _mounted; };
            self.getNode = function (nid) { return _graph.getNode(nid); };
            self.renderNode = _renderNode;
            self.invalidateCache = _invalidateCache;
            self.setInputNodePath = _setInputNodePath;
            self.refreshActiveGenInput = _refreshActiveGenInput;
            self.writeBlobToInputNode = _writeBlobToInputNode;
            self.saveBlobToInputPath = _saveBlobToInputPath;
            self.checkOutputReady = _checkOutputReady;
            self.openImageEditor = _openImageEditor;
            self.resolveUpstreamImage = _resolveUpstreamImage;
            self.readClipboardImage = _readClipboardImage;
            self.runGen = _runGen;
            self.disconnectEdge = _disconnectEdge;
            self.markDirty = function () { _store && _store.markDirty(); };
            self.pushHistory = function () { _pushHistory && _pushHistory(); };  // 离散结构操作（如缩略图排序）立即推历史
            self.redrawEdges = function () { _ctrl && _ctrl.redrawEdges && _ctrl.redrawEdges(); };
            self.minimapUpdate = function () { _minimapUpdate && _minimapUpdate(); };
            self.getNodeDefs = function () { return global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : []; };
            self.getEngine = function () { return _comfyController && _comfyController.getEngine ? _comfyController.getEngine() : null; };
            self.getService = function () { return _comfyController && _comfyController.getService ? _comfyController.getService() : null; };
            self.getController = function () { return _comfyController; };
            self.positionGenInput = function () { if (_activeGenNodeId) _positionGenInput(); };
            self.checkImageOverflow = _checkImageOverflow;
            self.checkVideoOverflow = _checkVideoOverflow;
            self.getGroups = function () { return _groups; };
            self.renderGroup = _renderGroup;
            self.moveGroupChildren = _moveGroupChildren;
            _ctx = self;

            // ── 分组框渲染器 ──
            if (global.AEComfyUI.createGroupRenderer) {
                // 先声明递归拖拽函数（需要自引用）
                var _grpMoveGroup = function (gid, dx, dy, _visited) {
                    _visited = _visited || {};
                    if (_visited[gid]) return;
                    _visited[gid] = true;
                    var grp = null;
                    for (var gi = 0; gi < _groups.length; gi++) { if (_groups[gi].id === gid) { grp = _groups[gi]; break; } }
                    if (!grp) return;
                    if (!_groupOrigins[gid]) _groupOrigins[gid] = { x: grp.x, y: grp.y, nodes: {} };
                    var orig = _groupOrigins[gid];
                    grp.x = orig.x + dx; grp.y = orig.y + dy;
                    var gEl = _groupRenderer.getEl(gid);
                    if (gEl) { gEl.style.left = grp.x + 'px'; gEl.style.top = grp.y + 'px'; }
                    var ids = grp.childIds || [];
                    for (var ci = 0; ci < ids.length; ci++) {
                        if (!orig.nodes[ids[ci]]) orig.nodes[ids[ci]] = { x: (_graph.getNode(ids[ci]) || {}).x || 0, y: (_graph.getNode(ids[ci]) || {}).y || 0 };
                        var cn = _graph.getNode(ids[ci]);
                        if (cn) { cn.x = orig.nodes[ids[ci]].x + dx; cn.y = orig.nodes[ids[ci]].y + dy; var cel = _worldEl.querySelector('[data-node-id="' + ids[ci] + '"]'); if (cel) { cel.style.left = cn.x + 'px'; cel.style.top = cn.y + 'px'; } }
                    }
                    var subIds = grp.childGroupIds || [];
                    for (var si = 0; si < subIds.length; si++) {
                        _grpMoveGroup(subIds[si], dx, dy, _visited);
                    }
                };

                _groupRenderer = global.AEComfyUI.createGroupRenderer({
                    worldEl: _worldEl,
                    graph: _graph,
                    viewport: _view && _view.viewport,
                    callbacks: {
                        onMoveEnd: function () { _ctrl && _ctrl.redrawEdges && _ctrl.redrawEdges(); if (_minimapUpdate) _minimapUpdate(); },
                        // 分组 resize 中每帧 mousemove 也调本回调（无 gid）——只有 mouseup（带 gid）才推历史，
                        // 否则一次缩放刷出上百条历史、直接打穿 50 条上限
                        onResizeEnd: function (gid) { if (_minimapUpdate) _minimapUpdate(); _checkAllMembership(gid); if (gid) _pushHistory(); },
                        onContextMenu: function (group, sx, sy) { _ctrl.showGroupMenu(group, sx, sy); },
                        markDirty: function () { _store && _store.markDirty(); },
                        onDragEnd: function (gid) { _groupOrigins = {}; _checkNodeGroupMembership(gid); _pushHistory(); },
                        onSelect: function (gid, shiftKey) {
                            var gEl = _groupRenderer.getEl(gid);
                            if (!gEl) return;
                            if (shiftKey) {
                                if (_selectedNodes[gid]) {
                                    delete _selectedNodes[gid];
                                    gEl.classList.remove('ng-group-selected');
                                } else {
                                    _selectedNodes[gid] = true;
                                    gEl.classList.add('ng-group-selected');
                                }
                            } else {
                                var wasSelected = gEl.classList.contains('ng-group-selected');
                                _deselectAll();
                                if (!wasSelected) {
                                    gEl.classList.add('ng-group-selected');
                                    _selectedNodes[gid] = true;
                                }
                            }
                            _refreshEdgeSelection();
                        },
                        onMoveGroup: _grpMoveGroup,
                        moveChildren: function (gid, dx, dy, skipIds) {
                            for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === gid) { _moveGroupChildren(_groups[gx], dx, dy, skipIds); break; } }
                        },
                        getMultiDragItems: function (gid) {
                            if (!_selectedNodes[gid]) return null;
                            var selKeys = Object.keys(_selectedNodes);
                            if (selKeys.length < 2) return null;
                            var items = [];
                            for (var sk = 0; sk < selKeys.length; sk++) {
                                var sid = selKeys[sk];
                                if (sid.indexOf('g_') === 0) {
                                    var g = null;
                                    for (var gx2 = 0; gx2 < _groups.length; gx2++) { if (_groups[gx2].id === sid) { g = _groups[gx2]; break; } }
                                    var ge = _groupRenderer.getEl(sid);
                                    if (g && ge) items.push({ group: g, el: ge, origX: g.x, origY: g.y });
                                } else {
                                    var n = _graph.getNode(sid);
                                    var ne = _worldEl.querySelector('[data-node-id="' + sid + '"]');
                                    if (n && ne) items.push({ node: n, el: ne, origX: n.x, origY: n.y });
                                }
                            }
                            return items;
                        }
                    }
                });
            }

            // 异步初始化输出目录 + 执行器
            _ensureOutputDir().then(function () {
                if (!_mounted) return;
                _initExecutor();
                // 清理定时器：挂载即启动（首次清理等 graph 加载完成后进行，见下）
                if (_gridCleanTimer) clearInterval(_gridCleanTimer);
                _gridCleanTimer = setInterval(function () {
                    if (!_mounted) return;
                    _cleanGridTemp().catch(function (_) {});
                    _cleanNodegenTemp().catch(function (_) {});
                }, 30 * 60 * 1000);
            });

            // 加载画布注册表 → 激活当前画布 → 渲染
            _loadRegistry(function (regErr) {
                if (!_mounted) return;   // 异步回调：unmount 后不得再写注册表/触达已清空的 _store
                _bootstrapAfterRegistry(regErr);
            });

            // 初始化浮动面板
            _initFloatingPanel(canvasContainer);

            // 初始化小地图
            _initMinimap(canvasContainer);

            // 空白处点选 → 取消所有选中（先确认进行中的内联编辑）
            _canvasEl.addEventListener('mousedown', function (e) {
                var activeInput = _worldEl.querySelector('.ng-node-title-input, .ng-note-input, .ng-group-note-input, .ng-group-title-input');
                if (activeInput) activeInput.blur();
                if (e.button !== 0 || e.ctrlKey) return;
                var t = e.target;
                if (t && t.closest && (t.closest('.ng-node') || t.closest('.ng-port') || t.closest('.ng-gen-input-container') || t.closest('.ng-group-head') || t.classList.contains('ng-edge-hit'))) return;
                if (_activeGenNodeId) _closeGenInput();
                _deselectAll();
            });
            // 生成中节点的取消按钮（进度区 HTML 会随渲染重建，委托挂画布根一次）
            _canvasEl.addEventListener('click', _onGenCancelClick);

            // 全局拖图入画布：拖文件到空白处自动创建 input 节点
            // 绑定到 canvasContainer（覆盖全区域，含顶栏），位置计算仍以 _canvasEl 坐标系为准
            _bindCanvasDrag(canvasContainer, _canvasEl);
            // 同时注册 document 级 dragover/drop 作为兜底（CEF 环境下事件可能不穿透 overflow:hidden 的子层）
            _bindDocDragFallback();
            // Del 键删除选中节点
            _bindKeyboard();

            // 节点内容撑开后自动调整大小 → 重绘连线
            _onNodeResized = function (e) {
                if (!_ctrl || !_ctrl.redrawEdges) return;
                _ctrl.redrawEdges();
                var detail = e && e.detail;
                if (detail && detail.nodeId && _ctrl.nodeEls && _ctrl.nodeEls[detail.nodeId]) {
                    _refreshNodeThumbnails(_ctrl.nodeEls[detail.nodeId], detail.nodeId);
                }
                // gen 节点尺寸变了（autoFitNode / resize） → 容器跟随
                if (detail && detail.nodeId && _activeGenNodeId === detail.nodeId) _positionGenInput();
            };
            window.addEventListener('ae:node-resized', _onNodeResized);

            // 注册退出落盘钩子（关面板不走 unmount，beforeunload 兜底防抖窗口内丢数据）
            _bindUnloadFlush();

            _mounted = true;
        }

        function unmount() {
            if (!_mounted) return;
            // 使 mount 的异步加载链（_loadRegistry/_store.load 回调）全部失效，
            // 防 unmount 后晚到的回调覆写注册表/解引用已清空的 _graph/_store
            ++_loadToken;
            // 落盘未保存改动（先恢复队列处理中临时修改的 batch_size，避免持久化错误值）
            _restoreBatchSizesBeforeFlush();
            if (_store) _store.flush();
            // 关掉可能开着的预览放大 lightbox（document.body 级，不随画布卸载消失）
            if (global.AEComfyUI && global.AEComfyUI.closeLightbox) global.AEComfyUI.closeLightbox();
            // 官方模板库 overlay 同样挂在 document.body：画布卸载时兜底关闭
            if (global.AEComfyUI && global.AEComfyUI.officialTemplateModal) global.AEComfyUI.officialTemplateModal.close();
            // 清理 gen 输入容器（不调 redrawEdges，_ctrl 可能已销毁或即将销毁）
            if (_genInputAnimRaf !== null) {
                cancelAnimationFrame(_genInputAnimRaf);
                _genInputAnimRaf = null;
            }
            if (_genInputEl) { _genInputEl.style.display = 'none'; }
            _activeGenNodeId = null;
            // 清理定时器
            if (_topbarEl && _topbarEl._statusInterval) {
                clearInterval(_topbarEl._statusInterval);
            }
            if (_gridCleanTimer) { clearInterval(_gridCleanTimer); _gridCleanTimer = null; }
            // 销毁画布控制器（解绑全局事件、移除 menu DOM）
            if (_ctrl && typeof _ctrl.destroy === 'function') _ctrl.destroy();
            // 销毁视图（解绑全局 mousemove/mouseup/wheel）
            if (_view && typeof _view.destroy === 'function') _view.destroy();
            // 清理浮动面板事件监听
            if (_panelOnModel) { window.removeEventListener('ae:default-llm-changed', _panelOnModel); _panelOnModel = null; }
            if (_panelOnSettingsObserver) { _panelOnSettingsObserver.disconnect(); _panelOnSettingsObserver = null; }
            // 仅解除引用：不调 _panelCtx.clear()——clear() 会 persist 空数组到 localStorage，
            // 导致切模块后再切回 comfyui 时历史对话丢失。聊天记录由 createPanelChat 流程持久化，
            // 用户主动「清空对话」按钮走 onClearChat 单独调用 _panelCtx.clear()。
            // 文件持久化：卸载前落盘挂起的防抖写入，避免切走丢尾（_panelStore 跨挂载复用）。
            if (_panelSaveTimer) { clearTimeout(_panelSaveTimer); _panelSaveTimer = null; }
            if (_panelCtx && _panelStore) _persistPanel();
            // 历史读取失败时不得 flush——挂起的防抖写会整包覆盖读不出的原历史
            if (_panelStore && !_panelHistoryReadFailed) _panelStore.flush();
            _panelCtx = null; _streamingMsg = null;
            // 清理浮动面板
            if (_panel && typeof _panel.destroy === 'function') _panel.destroy();
            if (_panelChat && typeof _panelChat.destroy === 'function') _panelChat.destroy();
            // 清理 imageEditor（createImageEditor 返回 {save, close, forceClose}，无
            // destroy 方法——检查 destroy 永不命中会泄漏全屏 mask、文档级监听并困住用户；
            // forceClose 不经未保存确认直接关，内部 onClose 清 _activeEditor）
            if (_activeEditor && typeof _activeEditor.forceClose === 'function') _activeEditor.forceClose();
            _activeEditor = null;
            // 清理全局拖拽 / 键盘事件
            if (_canvasContainer) {
                if (_onCanvasDragOver) _canvasContainer.removeEventListener('dragover', _onCanvasDragOver);
                if (_onCanvasDragEnter) _canvasContainer.removeEventListener('dragenter', _onCanvasDragEnter);
                if (_onCanvasDragLeave) _canvasContainer.removeEventListener('dragleave', _onCanvasDragLeave);
                if (_onCanvasDrop) _canvasContainer.removeEventListener('drop', _onCanvasDrop);
            }
            _onCanvasDragOver = _onCanvasDragEnter = _onCanvasDragLeave = _onCanvasDrop = null;
            if (_onDocDragOver) { document.removeEventListener('dragover', _onDocDragOver); _onDocDragOver = null; }
            if (_onDocDrop) { document.removeEventListener('drop', _onDocDrop); _onDocDrop = null; }
            if (_onKeyDown) { window.removeEventListener('keydown', _onKeyDown); _onKeyDown = null; }
            if (_onNodeResized) { window.removeEventListener('ae:node-resized', _onNodeResized); _onNodeResized = null; }
            // 解绑退出落盘钩子（防 unmount 后旧闭包引用重复 flush 已置空的数据）
            _unbindUnloadFlush();
            // 清理历史栈防抖定时器（避免 unmount 后触发 push 访问已 null 的 _graph/_store）
            if (_hDebounce) { clearTimeout(_hDebounce); _hDebounce = null; }
            if (_history) { _history.reset(); _history = null; }
            // 清理画布切换器外部点击监听 + 引用
            if (_onCanvasMenuOutside) { document.removeEventListener('click', _onCanvasMenuOutside); _onCanvasMenuOutside = null; }
            _canvases = []; _activeCanvasId = null; _canvasBtnEl = null; _canvasMenuEl = null;
            if (_minimap) { _minimap.remove(); _minimap = null; _minimapUpdate = null; }
            if (_groupRenderer) { _groupRenderer.destroy(); _groupRenderer = null; }
            _groups = [];

            // 清理画布 DOM
            var panel = document.getElementById('comfyuiPanel');
            var canvasContainer = panel && panel.querySelector('.comfyui-canvas-view');
            if (canvasContainer) canvasContainer.innerHTML = '';
            // 重置引用
            _view = null; _graph = null; _ctrl = null; _store = null;
            _executor = null; _panel = null; _panelChat = null;
            // 不清空 _generatingNodeMap：切模块后 WebSocket 仍在运行，进度回调需要映射来路由到 session。
            // 旧 promptId 由 _runGen finally 中的 _cleanupGenMapping 自然清理。
            // 切模块时脱绑所有 session（session 数据在全局 manager 中存活，切回来时 reattach）
            if (_genSessionMgr) _genSessionMgr.detachAll();
            _canvasContainer = null; _worldEl = null; _canvasEl = null; _topbarEl = null;
            _mounted = false;
        }

        // ============ Topbar ============

        function _buildTopbar(container) {
            _topbarEl = document.createElement('div');
            _topbarEl.className = 'ng-topbar';
            _topbarEl.style.cssText = 'height:34px;display:flex;align-items:center;padding:0 8px;background:var(--surface-1);border-bottom:1px solid var(--border);gap:8px;';

            // 标题
            var title = document.createElement('span');
            title.textContent = AEI18n.t('ComfyUI 画布');
            title.style.cssText = 'font-weight:600;font-size:13px;color:var(--text-main);';
            _topbarEl.appendChild(title);

            // 画布切换器（按钮 + 下拉菜单，内容由 _renderCanvasBar 填充）
            var switcher = document.createElement('div');
            switcher.className = 'ng-canvas-switcher';
            _canvasBtnEl = document.createElement('button');
            _canvasBtnEl.className = 'ng-canvas-btn';
            _canvasBtnEl.type = 'button';
            _canvasBtnEl.innerHTML = AEI18n.html('<span class="ng-canvas-name">画布</span><span class="ng-canvas-caret">▾</span>');
            _canvasMenuEl = document.createElement('div');
            _canvasMenuEl.className = 'ng-canvas-menu ng-hidden';
            switcher.appendChild(_canvasBtnEl);
            switcher.appendChild(_canvasMenuEl);
            _topbarEl.appendChild(switcher);
            _bindCanvasSwitcherEvents(switcher);

            // 官方模板库入口：与表单模式共用同一份 modal；添加成功后模板注册并广播，
            // 已展开的 gen 容器模型下拉由既有监听重建
            var officialTplBtn = document.createElement('button');
            officialTplBtn.type = 'button';
            officialTplBtn.className = 'ng-canvas-btn ng-official-tpl-btn';
            officialTplBtn.textContent = AEI18n.t('☁ 官方模板');
            officialTplBtn.title = AEI18n.t('浏览/添加官方模板（添加后表单与画布模型下拉同步可用）');
            officialTplBtn.addEventListener('click', function () {
                var modal = global.AEComfyUI && global.AEComfyUI.officialTemplateModal;
                if (!modal) return;
                modal.open({
                    controller: _comfyController,
                    status: function (msg, kind) {
                        if (!global.AEToast) return;
                        if (kind === 'success') global.AEToast.success(msg);
                        else global.AEToast.warn(msg);
                    }
                });
            });
            _topbarEl.appendChild(officialTplBtn);

            // 提示文字
            var hint = document.createElement('span');
            hint.style.cssText = 'font-size:10px;color:var(--text-muted);margin-left:4px;';
            hint.textContent = AEI18n.t('右键加节点 · 拖端口连线 · 拖空白平移 · 滚轮缩放 · Ctrl+点线删除');
            _topbarEl.appendChild(hint);

            // 弹性空白
            var spacer = document.createElement('span');
            spacer.style.cssText = 'flex:1;';
            _topbarEl.appendChild(spacer);

            // 连接状态灯
            var statusDot = document.createElement('span');
            statusDot.className = 'ng-status-dot';
            statusDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:var(--text-muted);transition:background .2s ease,box-shadow .2s ease;';
            _topbarEl.appendChild(statusDot);

            // 连接地址
            _connLbl = document.createElement('span');
            _connLbl.style.cssText = 'font-size:10px;color:var(--text-muted);';
            _connLbl.textContent = '127.0.0.1:8188';
            _topbarEl.appendChild(_connLbl);

            // 状态用 REST ping 探活（isConnected 只反映 WS，闲置时恒 false → 灯一直灰）。
            // ping 异步且可能比轮询间隔慢，用 _statusPinging 防重叠；地址同步从 service 读。
            var _statusPinging = false;
            function updateStatus() {
                if (!_mounted) return;
                var svc = _comfyController && _comfyController.getService();
                if (_connLbl && svc) {
                    var addr = (svc.getHost ? svc.getHost() : '127.0.0.1') + ':' + (svc.getPort ? svc.getPort() : '8188');
                    _connLbl.textContent = addr;
                }
                if (!svc || _statusPinging) return;
                _statusPinging = true;
                Promise.resolve(svc.ping ? svc.ping() : Promise.resolve(svc.isConnected && svc.isConnected())).then(function (ok) {
                    _statusPinging = false;
                    if (!_mounted) return;
                    statusDot.style.background = ok ? '#4caf50' : 'var(--text-muted)';
                    statusDot.style.boxShadow = ok ? '0 0 6px rgba(76,175,80,0.7)' : 'none';
                    statusDot.title = ok ? AEI18n.t('已连接') : AEI18n.t('未连接');
                });
            }
            updateStatus();
            var statusInterval = setInterval(updateStatus, 5000);

            // 缩放比例
            _topbarZoomLbl = document.createElement('span');
            _topbarZoomLbl.style.cssText = 'font-size:10px;color:var(--text-muted);min-width:36px;text-align:right;';
            _topbarZoomLbl.textContent = '100%';
            _topbarEl.appendChild(_topbarZoomLbl);

            container.appendChild(_topbarEl);
            _topbarEl._statusInterval = statusInterval;
        }

        // ============ 执行器初始化 ============

        function _initExecutor() {
            var service = _comfyController.getService();
            var engine = _comfyController.getEngine();
            var handlers = global.AEComfyUI.getHandlers ? global.AEComfyUI.getHandlers() : {};

            _executor = global.AEComfyUI.createGraphExecutor({
                graph: _graph,
                handlers: handlers,
                controller: _comfyController,
                templateEngine: engine,
                service: service,
                outputDir: _outputDir,
                onMapPrompt: function (promptId, nodeId, canvasFile) {
                    // 复合键路由：提交时刻记录所属画布，进度回调按画布+节点查 session，
                    // 跨画布同 id 节点的进度不再串线
                    // 优先用调用方（_runGen → runNodeAsync → runGenWorkflow）在提交前
                    // 快照的 canvasFile——提交 HTTP 往返窗口内切画布时，实时 _curCanvasFile()
                    // 已是新画布，进度路由错记画布 → 旧画布节点的进度反馈丢失（结果本身不受影响）
                    _generatingNodeMap[promptId] = { canvasFile: canvasFile || _curCanvasFile(), nodeId: nodeId };
                }
            });
        }

        // ============ 输出目录 ============

        async function _ensureOutputDir() {
            if (_outputDir) return _outputDir;
            // 输出目录一律在数据目录内：temp/nodegen（缓存/临时产物不写系统临时目录——
            // 那边没有清扫覆盖）
            if (_dataDir) {
                var ddFwd = _dataDir.replace(/\\/g, '/').replace(/\/+$/, '');
                var tempBase = ddFwd + '/temp';
                _outputDir = tempBase + '/nodegen';
                // AEFS.mkdir 走 cep.fs 回退时不递归，需逐层创建
                if (typeof AEFS !== 'undefined' && AEFS.mkdir) {
                    try { await AEFS.mkdir(tempBase); } catch (_) {}
                    try { await AEFS.mkdir(_outputDir); } catch (_) {}
                }
                return _outputDir;
            }
            console.warn('[ComfyUI Canvas] 数据目录不可用，输出功能不可用（不写系统临时目录）');
            _outputDir = '';
            return _outputDir;
        }

        // ── 小地图（minimap）：左下角缩略图，显示全部节点 + 视口框 ──
        function _initMinimap(container) {
            var box = document.createElement('div');
            box.className = 'ng-minimap';
            box.id = 'ngMinimap';
            box.innerHTML =
                '<div class="ng-minimap-canvas"></div>' +
                '<div class="ng-minimap-viewport"></div>';
            container.appendChild(box);
            _minimap = box;

            _minimapUpdate = function () {
                if (!_minimap || !_graph || !_view) return;
                var cv = _minimap.querySelector('.ng-minimap-canvas');
                var vp = _minimap.querySelector('.ng-minimap-viewport');
                var ns = _graph.nodes();
                if (!ns.length) { cv.innerHTML = ''; vp.style.display = 'none'; return; }
                var minX = 0, minY = 0, maxX = 0, maxY = 0;
                for (var i = 0; i < ns.length; i++) {
                    var n = ns[i];
                    if (i === 0) { minX = n.x; minY = n.y; maxX = n.x + 200; maxY = n.y + 100; }
                    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
                    maxX = Math.max(maxX, n.x + 200); maxY = Math.max(maxY, n.y + 120);
                }
                var cr = _canvasEl.getBoundingClientRect();
                var tl = _view.screenToWorld(0, 0);
                var br = _view.screenToWorld(cr.width, cr.height);
                minX = Math.min(minX, tl.x); minY = Math.min(minY, tl.y);
                maxX = Math.max(maxX, br.x); maxY = Math.max(maxY, br.y);
                var pad = 100;
                minX -= pad; minY -= pad; maxX += pad; maxY += pad;
                var w = maxX - minX, h = maxY - minY;
                var MW = 140, MH = 90;
                var scale = Math.min(MW / w, MH / h);
                cv.innerHTML = '';
                for (var k = 0; k < ns.length; k++) {
                    var d = document.createElement('div');
                    d.className = 'ng-minimap-node';
                    d.style.left = ((ns[k].x - minX) * scale) + 'px';
                    d.style.top = ((ns[k].y - minY) * scale) + 'px';
                    cv.appendChild(d);
                }
                vp.style.display = 'block';
                vp.style.left = ((tl.x - minX) * scale) + 'px';
                vp.style.top = ((tl.y - minY) * scale) + 'px';
                vp.style.width = ((br.x - tl.x) * scale) + 'px';
                vp.style.height = ((br.y - tl.y) * scale) + 'px';
                _minimap._bounds = { minX: minX, minY: minY, scale: scale };
            };

            // 点击缩略图 → 跳转视口
            _minimap.addEventListener('click', function (e) {
                if (!_minimap._bounds || !_view) return;
                var rect = _minimap.getBoundingClientRect();
                var mx = e.clientX - rect.left;
                var my = e.clientY - rect.top;
                var b = _minimap._bounds;
                var wx = mx / b.scale + b.minX;
                var wy = my / b.scale + b.minY;
                var cr = _canvasEl.getBoundingClientRect();
                var vp2 = _view.viewport;
                vp2.setPan(cr.width / 2 - wx * vp2.scale, cr.height / 2 - wy * vp2.scale);
                _view.applyTransform();
                _minimapUpdate();
                if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            });

            _minimapUpdate();
        }

        // ── 全局拖图入画布：拖文件到空白处 → 按类型创建 input 节点 ──
        // bindEl: 拖拽事件绑定的 DOM 元素（容器，覆盖全画布区域含顶栏）
        // positionEl: 用于计算放置坐标的参考元素（画布本体）
        // 按扩展名/MIME 白名单分类拖入文件。若只按 file.type 前缀分
        // video/image，其余一律当图片建 imageInput 节点——拖入 .txt/.pdf 等生成
        // 不可用节点。返回 'imageInput' / 'videoInput' / null（不支持）。
        var _DROP_IMAGE_EXT = { png: 1, jpg: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, tif: 1, tiff: 1, avif: 1, heic: 1 };
        var _DROP_VIDEO_EXT = { mp4: 1, mov: 1, webm: 1, m4v: 1, avi: 1, mkv: 1, mpg: 1, mpeg: 1 };
        function _classifyDroppedFile(file) {
            if (!file) return null;
            var mime = String(file.type || '').toLowerCase();
            var base = String(file.name || file.path || '');
            var slash = Math.max(base.lastIndexOf('/'), base.lastIndexOf('\\'));
            base = base.slice(slash + 1);
            var dot = base.lastIndexOf('.');
            var ext = dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
            if (mime.indexOf('image/') === 0 || _DROP_IMAGE_EXT[ext]) return 'imageInput';
            if (mime.indexOf('video/') === 0 || _DROP_VIDEO_EXT[ext]) return 'videoInput';
            return null;
        }
        function _bindCanvasDrag(bindEl, positionEl) {
            _onCanvasDragOver = function (e) {
                // 内部拖拽（缩略图排序等）不触发画布高亮
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                e.preventDefault();
            };
            _onCanvasDragEnter = function (e) {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                e.preventDefault();
                _dragEnterCount++;
                bindEl.classList.add('ng-canvas-dragover');
            };
            _onCanvasDragLeave = function (e) {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                e.preventDefault();
                _dragEnterCount--;
                if (_dragEnterCount <= 0) {
                    _dragEnterCount = 0;
                    bindEl.classList.remove('ng-canvas-dragover');
                }
            };
            _onCanvasDrop = function (e) {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                e.preventDefault();
                _dragEnterCount = 0;
                bindEl.classList.remove('ng-canvas-dragover');
                var file = e.dataTransfer.files[0];
                if (!file) return;
                // CEF Chrome 88 dropped File 暴露 .path（绝对路径）
                var path = file.path || file.name;
                // 非图片/视频文件不入画布（一律建 imageInput，节点不可用）
                var type = _classifyDroppedFile(file);
                if (!type) {
                    if (global.AEToast) AEToast.warn(AEI18n.t('仅支持拖入图片/视频文件（如 png/jpg/mp4），已忽略: ') + (file.name || path));
                    return;
                }
                // 落在同类型 input 节点上 → 填该节点
                var nodeEl = (e.target && e.target.closest) ? e.target.closest('.ng-node') : null;
                if (nodeEl) {
                    var nid = nodeEl.dataset.nodeId;
                    var n = _graph.getNode(nid);
                    if (n && n.type === type) {
                        _setInputNodePath(nid, path);
                        return;
                    }
                }
                // 空白处 → 按文件类型创建 input 节点
                var rect = positionEl.getBoundingClientRect();
                var sx = e.clientX - rect.left, sy = e.clientY - rect.top;
                var world = _view.screenToWorld(sx, sy);
                var id = _graph.addNode(type, { x: world.x, y: world.y });
                var newNode = _graph.getNode(id);
                if (newNode) newNode.params = { path: path };
                _renderNode(id);
                _store && _store.markDirty();
                if (_minimapUpdate) _minimapUpdate();
                _pushHistory();   // 结构操作：立即推历史（拖文件建节点）
            };
            bindEl.addEventListener('dragover', _onCanvasDragOver);
            bindEl.addEventListener('dragenter', _onCanvasDragEnter);
            bindEl.addEventListener('dragleave', _onCanvasDragLeave);
            bindEl.addEventListener('drop', _onCanvasDrop);
        }

        // ── document 级拖拽兜底：CEF 环境下 overflow:hidden 子层可能不触发事件 ──
        // 在 document 上监听 dragover/drop，当鼠标位于画布容器内时确保 preventDefault 被调用，
        // 并将 drop 转发给 _onCanvasDrop 处理。
        function _bindDocDragFallback() {
            _onDocDragOver = function (e) {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                if (!_canvasContainer || !_mounted) return;
                var r = _canvasContainer.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                    e.preventDefault();
                }
            };
            _onDocDrop = function (e) {
                if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
                if (!_canvasContainer || !_mounted) return;
                // 如果容器级处理器已经调用了 preventDefault，说明 drop 已被处理，不重复处理
                if (e.defaultPrevented) return;
                var r = _canvasContainer.getBoundingClientRect();
                if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
                    if (_onCanvasDrop) _onCanvasDrop(e);
                }
            };
            document.addEventListener('dragover', _onDocDragOver);
            document.addEventListener('drop', _onDocDrop);
        }

        // ── Del 键删除选中节点（拾取右键菜单最后操作的节点） ──
        function _bindKeyboard() {
            _onKeyDown = function (e) {
                // 图片编辑器全屏模态激活时，画布快捷键全部让位（editor 有自有 document 级处理，
                // 且从不 stopPropagation——不拦截会在模态背后静默删节点/复制/撤销）
                if (document.querySelector('.ng-edit-mask')) return;
                // 输入框中不拦截
                var inInput = e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT');
                // ── Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y：画布 undo/redo ──
                // 图片编辑器激活时让位（它有自己的 document 级撤回，mask 全屏覆盖）。
                if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z' || e.key === 'y' || e.key === 'Y') && !inInput) {
                    if (document.querySelector('.ng-edit-mask')) return;  // 图片编辑器激活，让位
                    if (!_history) return;
                    e.preventDefault();
                    var wantRedo = e.shiftKey || e.key === 'y' || e.key === 'Y';
                    var ok = wantRedo ? _history.redo() : _history.undo();
                    if (!ok && global.AEToast) AEToast.info(wantRedo ? AEI18n.t('没有可重做的操作') : AEI18n.t('没有可撤销的操作'));
                    return;
                }
                // Ctrl+D → 复制选中节点 / 分组
                if ((e.key === 'd' || e.key === 'D' || e.keyCode === 68) && e.ctrlKey && !inInput) {
                    e.preventDefault();
                    try {
                    var selIds = Object.keys(_selectedNodes);
                    if (!selIds.length && _lastContextNodeId) selIds = [_lastContextNodeId];
                    if (selIds.length) {
                        // ── 分离节点 ID 和分组 ID ──
                        var nodeSelIds = [], groupSelIds = [];
                        for (var si = 0; si < selIds.length; si++) {
                            if (selIds[si].indexOf('g_') === 0) groupSelIds.push(selIds[si]);
                            else nodeSelIds.push(selIds[si]);
                        }
                        // 分组内的子节点纳入复制范围（穿透嵌套分组）
                        var seen = {};
                        for (var gi = 0; gi < groupSelIds.length; gi++) {
                            var grp = null;
                            for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === groupSelIds[gi]) { grp = _groups[gx]; break; } }
                            if (!grp) continue;
                            var childIds = _collectAllChildIds(grp);
                            for (var ci = 0; ci < childIds.length; ci++) { if (!seen[childIds[ci]]) { seen[childIds[ci]] = true; nodeSelIds.push(childIds[ci]); } }
                        }
                        var uniqNodeIds = [], dedup = {};
                        for (var di = 0; di < nodeSelIds.length; di++) {
                            if (!dedup[nodeSelIds[di]]) { dedup[nodeSelIds[di]] = true; uniqNodeIds.push(nodeSelIds[di]); }
                        }

                        var newIds = [], idMap = {};
                        for (var s = 0; s < uniqNodeIds.length; s++) {
                            var src = _graph.getNode(uniqNodeIds[s]);
                            if (!src) continue;
                            var nid = _graph.addNode(src.type, { x: src.x + 30, y: src.y + 30 });
                            idMap[uniqNodeIds[s]] = nid;
                            var nn = _graph.getNode(nid);
                            if (nn) {
                                nn.params = JSON.parse(JSON.stringify(src.params || {}));
                                // 清生成结果与批量/多图簿记（残留会让副本重载后"复活"源节点旧结果）
                                delete nn.params._result;
                                delete nn.params._frameHTMLs;
                                delete nn.params._placeholders;
                                delete nn.params._batchCurIdx;
                                delete nn.params._multiImgs;
                                delete nn.params._multiCurIdx;
                                nn.note = src.note || '';
                                nn.color = src.color || '';
                            }
                            newIds.push(nid);
                        }
                        var allEdges = _graph.edges();
                        for (var ei = 0; ei < allEdges.length; ei++) {
                            var nf = idMap[allEdges[ei].from], nt = idMap[allEdges[ei].to];
                            if (nf && nt) { try { _graph.connect(nf, allEdges[ei].fromPort, nt, allEdges[ei].toPort); } catch (er) {} }
                        }
                        for (var ni = 0; ni < newIds.length; ni++) _renderNode(newIds[ni]);

                        // ── 复制分组（含嵌套子分组）──
                        var newGroupIds = [];
                        var grpIdMap = {};
                        var allGrpsToCopy = [];
                        var grpVisited = {};
                        function collectNested(gid) {
                            if (grpVisited[gid]) return;
                            grpVisited[gid] = true;
                            var sg = null;
                            for (var gx3 = 0; gx3 < _groups.length; gx3++) { if (_groups[gx3].id === gid) { sg = _groups[gx3]; break; } }
                            if (!sg) return;
                            allGrpsToCopy.push(sg);
                            var subGids = sg.childGroupIds || [];
                            for (var sgi = 0; sgi < subGids.length; sgi++) collectNested(subGids[sgi]);
                        }
                        for (var gii = 0; gii < groupSelIds.length; gii++) collectNested(groupSelIds[gii]);
                        function grpDepth(gid) {
                            for (var gx4 = 0; gx4 < allGrpsToCopy.length; gx4++) {
                                if ((allGrpsToCopy[gx4].childGroupIds || []).indexOf(gid) >= 0) return grpDepth(allGrpsToCopy[gx4].id) + 1;
                            }
                            return 0;
                        }
                        allGrpsToCopy.sort(function (a, b) { return grpDepth(a.id) - grpDepth(b.id); });

                        for (var gii = 0; gii < allGrpsToCopy.length; gii++) {
                            var srcGrp = allGrpsToCopy[gii];
                            var ngId = 'g_' + new Date().getTime() + '_' + gii;
                            grpIdMap[srcGrp.id] = ngId;
                            var newGrp = {
                                id: ngId, title: srcGrp.title,
                                x: srcGrp.x + 30, y: srcGrp.y + 30,
                                w: srcGrp.w, h: srcGrp.h,
                                color: srcGrp.color, note: srcGrp.note,
                                childIds: [], childGroupIds: []
                            };
                            for (var cj = 0; cj < (srcGrp.childIds || []).length; cj++) {
                                var mapped = idMap[srcGrp.childIds[cj]];
                                if (mapped) newGrp.childIds.push(mapped);
                            }
                            newGrp._oldChildGroupIds = (srcGrp.childGroupIds || []).slice();
                            _groups.push(newGrp);
                            _renderGroup(newGrp);
                            if (groupSelIds.indexOf(srcGrp.id) >= 0) newGroupIds.push(ngId);
                        }
                        for (var gii2 = 0; gii2 < allGrpsToCopy.length; gii2++) {
                            var ngId2 = grpIdMap[allGrpsToCopy[gii2].id];
                            var newGrp2 = null;
                            for (var gx5 = 0; gx5 < _groups.length; gx5++) { if (_groups[gx5].id === ngId2) { newGrp2 = _groups[gx5]; break; } }
                            if (!newGrp2) continue;
                            var oldCids = newGrp2._oldChildGroupIds || [];
                            delete newGrp2._oldChildGroupIds;
                            for (var oci = 0; oci < oldCids.length; oci++) {
                                var mappedGid = grpIdMap[oldCids[oci]];
                                if (mappedGid) newGrp2.childGroupIds.push(mappedGid);
                            }
                        }

                        _deselectAll();
                        for (var nj = 0; nj < newIds.length; nj++) {
                            _selectedNodes[newIds[nj]] = true;
                            var nel = _worldEl.querySelector('[data-node-id="' + newIds[nj] + '"]');
                            if (nel) nel.classList.add('ng-node-selected');
                        }
                        for (var ngj = 0; ngj < newGroupIds.length; ngj++) {
                            _selectedNodes[newGroupIds[ngj]] = true;
                            var gel = _groupRenderer && _groupRenderer.getEl(newGroupIds[ngj]);
                            if (gel) gel.classList.add('ng-group-selected');
                        }
                        _store && _store.markDirty();
                        if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                        _refreshEdgeSelection();
                        if (_minimapUpdate) _minimapUpdate();
                        _pushHistory();   // 结构操作：立即推历史（复制节点/分组）
                    }
                    } catch (err) {
                        console.error('[ComfyUI Canvas] Ctrl+D 失败:', (err && err.message) || err);
                    }
                    return;
                }
                // ESC → 关 gen 容器
                if (e.key === 'Escape') {
                    if (inInput) return;
                    if (_activeGenNodeId) {
                        _closeGenInput();
                        _deselectAll();
                        return;
                    }
                }
                // Del → 删除选中节点 / 解散选中分组
                if (e.key !== 'Delete' && e.key !== 'Del') return;
                if (inInput) return;
                var delIds = Object.keys(_selectedNodes);
                if (delIds.length) {
                    // 画布消费了 Delete：preventDefault 阻止键事件冒泡到 AE 宿主，
                    // 避免 AE 把本机选中的素材一并删除（CEP 面板与原宿主共享键盘）。
                    e.preventDefault();
                    e.stopPropagation();
                    for (var i = 0; i < delIds.length; i++) {
                        if (delIds[i].indexOf('g_') === 0) {
                            // 分组：解散分组（不移除子节点）
                            _onGroupUngroup({ id: delIds[i] });
                        } else {
                            _onRemove(delIds[i]);
                        }
                    }
                } else if (_lastContextNodeId) {
                    e.preventDefault();
                    e.stopPropagation();
                    _onRemove(_lastContextNodeId);
                }
            };
            window.addEventListener('keydown', _onKeyDown);
        }

        // 容器定位：跟随活跃 gen 节点，屏幕坐标（容器在 canvasEl 上）
        function _positionGenInput() {
            if (!_genInputEl || !_activeGenNodeId) return;
            var nodeEl = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[_activeGenNodeId];
            if (!nodeEl) return;
            var nr = nodeEl.getBoundingClientRect();
            var cr = _canvasEl.getBoundingClientRect();
            var left = nr.left - cr.left + (nr.width - (_genInputEl.offsetWidth || 520)) / 2;
            var top = nr.bottom - cr.top + 8;
            _genInputEl.style.left = left + 'px';
            _genInputEl.style.top = top + 'px';
            // 入场动画偏移
            var ty = _genInputEl._slideY || 0;
            _genInputEl.style.transform = 'translateY(' + ty + 'px)';
            _genInputEl.style.transformOrigin = 'top left';
        }

        // 展开 gen 节点的输入容器
        function _openGenInput(nodeId) {
            if (_activeGenNodeId === nodeId) return;  // 已在展开，无操作
            if (_activeGenNodeId) _closeGenInput();   // 先关旧的

            var node = _graph.getNode(nodeId);
            if (!node) return;
            var nodeDefs = global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : [];
            var def = null;
            for (var d = 0; d < nodeDefs.length; d++) {
                if (nodeDefs[d].type === node.type) { def = nodeDefs[d]; break; }
            }
            if (!def || (def.type !== 'imageGen' && def.type !== 'videoGen')) return;

            // 懒创建容器 DOM（挂在 canvasEl，屏幕坐标，不受 worldEl 层级限制）
            if (!_genInputEl) {
                _genInputEl = document.createElement('div');
                _genInputEl.className = 'ng-gen-input-container';
                _genInputEl.style.display = 'none';
                _canvasEl.appendChild(_genInputEl);
            }

            // 渲染内容
            var renderer = global.AEComfyUI._renderGenInputContainer;
            if (renderer) renderer(_genInputEl, node, _ctx);

            _genInputEl.style.display = '';
            _genInputEl.classList.add('ng-gen-input-open');
            // JS 入场动画：translateY 从 -6 → 0，约 0.2s
            var startY = -6, endY = 0, duration = 180, startT = null;
            _genInputEl._slideY = startY;
            _positionGenInput();
            function animStep(ts) {
                if (!startT) startT = ts;
                var p = Math.min(1, (ts - startT) / duration);
                var ease = 1 - Math.pow(1 - p, 3);  // ease-out
                _genInputEl._slideY = startY + (endY - startY) * ease;
                _positionGenInput();
                if (p < 1) {
                    _genInputAnimRaf = requestAnimationFrame(animStep);
                } else {
                    _genInputAnimRaf = null;
                }
            }
            _genInputAnimRaf = requestAnimationFrame(animStep);
            _activeGenNodeId = nodeId;

            // 重绘边线
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
        }

        // 关闭 gen 节点输入容器
        function _closeGenInput() {
            if (_genInputAnimRaf !== null) {
                cancelAnimationFrame(_genInputAnimRaf);
                _genInputAnimRaf = null;
            }
            if (_genInputEl) {
                _genInputEl.classList.remove('ng-gen-input-open');
                _genInputEl.style.display = 'none';
            }
            _activeGenNodeId = null;
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
        }

        // ============ 节点渲染 ============

        // 节点标题内联编辑（替代 showPrompt 弹窗）
        function _startInlineRename(nodeId) {
            var node = _graph.getNode(nodeId);
            if (!node) return;
            var nodeEl = _worldEl.querySelector('[data-node-id="' + nodeId + '"]');
            if (!nodeEl) return;
            var titleEl = nodeEl.querySelector('.ng-node-title');
            if (!titleEl || titleEl.querySelector('input')) return;  // 已在编辑中

            // 默认显示标题 = nodeDef.title（中文，如"图片输入"），与 nodeRenderer 的 title.textContent 保持一致。
            // node.title 为空时以此为回退，避免清空/取消后回退到英文 node.type。
            var defs = global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : [];
            var def = null;
            for (var i = 0; i < defs.length; i++) {
                if (defs[i].type === node.type) { def = defs[i]; break; }
            }
            var defaultTitle = (def && def.title) || node.type;

            var oldTitle = node.title || defaultTitle;
            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'ng-node-title-input';
            input.value = oldTitle;
            titleEl.innerHTML = '';
            titleEl.appendChild(input);
            input.focus();
            input.select();

            var cancelled = false;  // Escape 置位：移除聚焦 input 可能触发 blur，防 cancel 后 commit 抢跑
            function commit() {
                if (cancelled) return;
                var newTitle = input.value.trim() || defaultTitle;
                titleEl.innerHTML = '';
                titleEl.textContent = newTitle;
                node.title = newTitle;
                if (_store) _store.markDirty();
            }
            function cancel() {
                cancelled = true;
                titleEl.innerHTML = '';
                titleEl.textContent = oldTitle;
            }
            input.addEventListener('blur', commit);
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            });
        }

        function _renderNode(nodeId, opts) {
            var node = _graph.getNode(nodeId);
            if (!node) return;
            var defs = global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : [];
            var def = null;
            for (var i = 0; i < defs.length; i++) {
                if (defs[i].type === node.type) { def = defs[i]; break; }
            }
            if (!def) return;

            // 重渲染：先移除旧 DOM（输入节点 path 变更时 _setInputNodePath 会调 _renderNode）
            var oldEl = _worldEl.querySelector('[data-node-id="' + nodeId + '"]');
            if (oldEl) oldEl.remove();

            // 登场动画：opts.appear 显式优先；未指定时按「是否已有旧 DOM」判定——
            // 无旧 DOM（新建/首次进入画布）才播，重渲染不播。
            var appear = (opts && typeof opts.appear === 'boolean') ? opts.appear : !oldEl;
            var el = global.AEComfyUI.createNodeEl(def, node, _worldEl, {
                onDragStart: function () { _store && _store.markDirty(); },
                onResize: function () { _store && _store.markDirty(); },
                onParamChange: function () { _store && _store.markDirty(); },
                onSelect: function (nodeId, ev) { _selectNode(nodeId, ev); },
                onRename: function (nid) { _startInlineRename(nid); },
                onColorChange: function (nid) {
                    var colors = ['', '#e74c3c', '#e67e22', '#f1c40f', '#2ecc71', '#3498db', '#9b59b6'];
                    // 框选多节点时批量变色：取第一个选中节点的当前色为基准，统一切到下一个色
                    var targets = [];
                    var selIds = Object.keys(_selectedNodes);
                    if (selIds.length > 1 && _selectedNodes[nid]) {
                        for (var si = 0; si < selIds.length; si++) {
                            if (_graph.getNode(selIds[si])) targets.push(selIds[si]);
                        }
                    } else {
                        targets.push(nid);
                    }
                    var baseNode = _graph.getNode(targets[0]);
                    var idx = colors.indexOf((baseNode && baseNode.color) || '');
                    var newColor = colors[(idx + 1) % colors.length];
                    for (var ti = 0; ti < targets.length; ti++) {
                        var tn = _graph.getNode(targets[ti]);
                        if (!tn) continue;
                        tn.color = newColor;
                        var tel = _worldEl.querySelector('[data-node-id="' + targets[ti] + '"]');
                        if (tel) tel.style.borderColor = newColor || 'var(--border)';
                    }
                    if (_store) _store.markDirty();
                },
                onNoteChange: function (nodeId, note) { _store && _store.markDirty(); },
                onToggle: function () {
                    if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                }
            }, { appear: appear });
            el.setAttribute('data-node-id', nodeId);
            _worldEl.appendChild(el);

            // 重渲染后恢复选中高亮
            if (_selectedNodes[nodeId]) el.classList.add('ng-node-selected');

            // 注册到 canvasController（供连线重绘 + 节点右键菜单 + 拖拽抑制）
            if (_ctrl) {
                _ctrl.nodeEls[nodeId] = el;
                _ctrl.bindNodeContextMenu(el, node);
                // 记录最后右键的节点（Del 键删除用）
                el.addEventListener('contextmenu', function () { _lastContextNodeId = nodeId; });
            }

            // 绑定节点拖拽（mousedown 在头部 → 平移节点）
            _bindNodeDrag(el, node);

            // 绑定右下角 resize 手柄拖拽
            _bindNodeResize(el, node);

            // 用正确的 editor callbacks 填充编辑器内容
            // createNodeEl 只建 DOM 壳，renderEditor 在此处首次调用
            _editNode(nodeId);

            // ── 节点尺寸持久化 ──
            // ⚠️ 必须在 _editNode（renderEditor）之后——编辑器填充内容后 offsetHeight 才反映真实高度
            node.params = node.params || {};
            var isGen = node.type === 'imageGen' || node.type === 'videoGen';
            // gen 节点布局尺寸存 _layoutWidth/_layoutHeight，避免与模板参数 width/height（图像分辨率）冲突
            var layoutW = isGen ? node.params._layoutWidth : node.params.width;
            var layoutH = isGen ? node.params._layoutHeight : node.params.height;
            if (layoutW) {
                el.style.width = layoutW + 'px';
            } else if (node.params.width > 600 && isGen) {
                // 旧数据回退：width 是模板参数（如 1024）而非布局值
                el.style.width = '280px';
            } else {
                var w0 = Math.max(210, Math.min(el.offsetWidth || 260, 600));
                if (isGen) node.params._layoutWidth = w0;
                else node.params.width = w0;
                el.style.width = w0 + 'px';
            }
            if (layoutH) {
                el.style.height = layoutH + 'px';
            } else if (node.params.height > 700 && isGen) {
                el.style.height = '300px';
            } else {
                var h0 = Math.max(180, Math.min(el.offsetHeight || 250, 700));
                if (isGen) node.params._layoutHeight = h0;
                else node.params.height = h0;
                el.style.height = h0 + 'px';
            }

            // 刷新上游缩略图行
            _refreshNodeThumbnails(el, nodeId);
        }

        // 节点拖拽：mousedown 在头部 → 平移节点位置（多选时一起移动）
        function _bindNodeDrag(el, node) {
            var head = el.querySelector('.ng-node-head');
            if (!head) return;

            head.addEventListener('mousedown', function (e) {
                // 不拦截按钮/折叠钮的点击（它们自己处理，不拖拽）
                if (e.button !== 0) return;
                var t = e.target;
                if (t && (t.closest('button') || t.closest('.ng-node-toggle') || t.closest('.ng-node-resize'))) return;

                e.preventDefault();
                e.stopPropagation();

                var startX = e.clientX;
                var startY = e.clientY;
                var scale = _view && _view.viewport ? _view.viewport.scale : 1;

                // 通知 canvasController 拖拽中（抑制连线圆圈弹出）
                if (_ctrl && _ctrl.setNodeDragging) _ctrl.setNodeDragging(true);

                // 拖拽的节点提到最上层（递增 z-index，松开后保持）
                _bumpZIndex();
                el.style.zIndex = String(_topZIndex);

                // 拖动活跃 gen 节点 → 先隐藏容器，避免跟手晃动
                var wasGenActive = (_activeGenNodeId === node.id);
                if (wasGenActive && _genInputEl) _genInputEl.style.display = 'none';

                // ── 多选拖拽：记录所有选中项原始位置 ──
                var multiDrag = _selectedNodes[node.id] && Object.keys(_selectedNodes).length > 1;
                var dragItems = [];  // [{node,el,origX,origY}] + [{group,origX,origY}]
                if (multiDrag) {
                    var selKeys = Object.keys(_selectedNodes);
                    for (var sk = 0; sk < selKeys.length; sk++) {
                        var sid = selKeys[sk];
                        if (sid.indexOf('g_') === 0) {
                            var grp = null;
                            for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === sid) { grp = _groups[gx]; break; } }
                            var gel = _groupRenderer && _groupRenderer.getEl(sid);
                            if (grp && gel) dragItems.push({ group: grp, el: gel, origX: grp.x, origY: grp.y });
                        } else {
                            var sn = _graph.getNode(sid);
                            var sel = _worldEl.querySelector('[data-node-id="' + sid + '"]');
                            if (sn && sel) dragItems.push({ node: sn, el: sel, origX: sn.x, origY: sn.y });
                        }
                    }
                } else {
                    dragItems.push({ node: node, el: el, origX: parseFloat(el.style.left) || 0, origY: parseFloat(el.style.top) || 0 });
                }
                // 所有拖拽项提到最上层（共用当前 _topZIndex）
                for (var di = 0; di < dragItems.length; di++) {
                    dragItems[di].el.style.zIndex = String(_topZIndex);
                }

                var _rafPending = false;
                var _lastChildDx = 0, _lastChildDy = 0;  // 子项移动用增量位移（_moveGroupChildren 内部 +=）
                function onMove(ev) {
                    var dx = (ev.clientX - startX) / scale;
                    var dy = (ev.clientY - startY) / scale;
                    for (var di = 0; di < dragItems.length; di++) {
                        var item = dragItems[di];
                        var nx = item.origX + dx, ny = item.origY + dy;
                        item.el.style.left = nx + 'px';
                        item.el.style.top = ny + 'px';
                        if (item.node) { item.node.x = nx; item.node.y = ny; }
                        if (item.group) { item.group.x = nx; item.group.y = ny; }
                    }
                    // 多选中有分组时，连带移动其子节点/子分组（跳过已在 dragItems 中的）
                    // _skipIds 同时含分组与节点 id：节点被选中时又挂在选中分组下，不能两种路径各移一次
                    var _skipIds = {};
                    for (var di2 = 0; di2 < dragItems.length; di2++) {
                        if (dragItems[di2].group) _skipIds[dragItems[di2].group.id] = true;
                        if (dragItems[di2].node) _skipIds[dragItems[di2].node.id] = true;
                    }
                    var _incDx = dx - _lastChildDx, _incDy = dy - _lastChildDy;
                    _lastChildDx = dx; _lastChildDy = dy;
                    for (var di = 0; di < dragItems.length; di++) {
                        if (dragItems[di].group) _moveGroupChildren(dragItems[di].group, _incDx, _incDy, _skipIds);
                    }
                    if (!_rafPending) {
                        _rafPending = true;
                        requestAnimationFrame(function () {
                            _rafPending = false;
                            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                        });
                    }
                }

                function onUp(ev) {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);

                    if (_ctrl && _ctrl.setNodeDragging) _ctrl.setNodeDragging(false);

                    // z-index 不重置：拖拽后的节点保持在最上层

                    // 最终坐标落定到所有拖拽项（0 是合法坐标，不能用 || 回退；x/y 统一 parseFloat）
                    for (var di = 0; di < dragItems.length; di++) {
                        var item = dragItems[di];
                        var fnx = parseFloat(item.el.style.left);
                        if (isNaN(fnx)) fnx = item.origX;
                        var fny = parseFloat(item.el.style.top);
                        if (isNaN(fny)) fny = item.origY;
                        if (item.node) { item.node.x = fnx; item.node.y = fny; }
                        if (item.group) { item.group.x = fnx; item.group.y = fny; }
                    }

                    if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                    if (_minimapUpdate) _minimapUpdate();
                    if (_store) _store.markDirty();

                    // 拖动完成 → 恢复 gen 输入容器并重定位
                    if (wasGenActive && _genInputEl) {
                        _genInputEl.style.display = '';
                        _positionGenInput();
                    }

                    // 若移动的节点连到活跃 gen 节点 → 刷新缩略图
                    if (_activeGenNodeId && _genInputEl && _genInputEl.style.display !== 'none') {
                        var allEdges = _graph.edges();
                        for (var ei = 0; ei < allEdges.length; ei++) {
                            if (allEdges[ei].from === node.id && allEdges[ei].to === _activeGenNodeId && allEdges[ei].toPort === 'image') {
                                var genNode = _graph.getNode(_activeGenNodeId);
                                var topRow = _genInputEl.querySelector('.ng-gen-input-top');
                                if (topRow && genNode && global.AEComfyUI._refreshInputThumb) {
                                    global.AEComfyUI._refreshInputThumb(topRow, genNode, _ctx);
                                }
                                if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                                break;
                            }
                        }
                    }

                    var moved = Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3;
                    if (moved) {
                        el.addEventListener('click', function _suppressClick(e) {
                            e.stopPropagation();
                            e.stopImmediatePropagation();
                            el.removeEventListener('click', _suppressClick, true);
                        }, true);
                    }

                    // 拖拽完成 → 检查所有被拖项的进出分组
                    if (moved) {
                        for (var di = 0; di < dragItems.length; di++) {
                            var idToCheck = dragItems[di].node ? dragItems[di].node.id : (dragItems[di].group ? dragItems[di].group.id : null);
                            if (idToCheck) _checkNodeGroupMembership(idToCheck);
                        }
                        _pushHistory();   // 结构操作：立即推历史（节点/分组移动落定）
                    }
                }

                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });
        }

        // 右下角 resize 手柄：mousedown → 拖拽调宽高
        function _bindNodeResize(el, node) {
            var handle = el.querySelector('.ng-node-resize');
            if (!handle) return;

            handle.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();

                var startX = e.clientX;
                var startY = e.clientY;
                var minW = 200;
                var minH = 80;
                var maxW = 500;
                var maxH = 650;
                var origW = parseFloat(el.style.width) || el.offsetWidth || minW;
                var origH = parseInt(el.style.height) || el.offsetHeight || minH;
                var scale = _view && _view.viewport ? _view.viewport.scale : 1;

                if (_ctrl && _ctrl.setNodeDragging) _ctrl.setNodeDragging(true);

                function onResizeMove(ev) {
                    var dw = (ev.clientX - startX) / scale;
                    var dh = (ev.clientY - startY) / scale;
                    var newW = Math.max(minW, Math.min(origW + dw, maxW));
                    var newH = Math.max(minH, Math.min(origH + dh, maxH));
                    el.style.width = newW + 'px';
                    el.style.height = newH + 'px';
                    node.params = node.params || {};
                    var isGen = node.type === 'imageGen' || node.type === 'videoGen';
                    if (isGen) {
                        node.params._layoutWidth = newW;
                        node.params._layoutHeight = newH;
                    } else {
                        node.params.width = newW;
                        node.params.height = newH;
                    }
                    if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                    // gen 节点缩放 → 容器跟随（高度变了 top 要重算）
                    if (_activeGenNodeId === node.id) _positionGenInput();
                }

                function onResizeUp(ev) {
                    window.removeEventListener('mousemove', onResizeMove);
                    window.removeEventListener('mouseup', onResizeUp);

                    if (_ctrl && _ctrl.setNodeDragging) _ctrl.setNodeDragging(false);

                    var finalW = parseFloat(el.style.width) || minW;
                    var finalH = parseInt(el.style.height) || minH;
                    node.params = node.params || {};
                    var isGen2 = node.type === 'imageGen' || node.type === 'videoGen';
                    if (isGen2) {
                        node.params._layoutWidth = finalW;
                        node.params._layoutHeight = finalH;
                    } else {
                        node.params.width = finalW;
                        node.params.height = finalH;
                    }

                    if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
                    if (_minimapUpdate) _minimapUpdate();
                    if (_store) _store.markDirty();
                    _pushHistory();   // 结构操作：立即推历史（节点缩放落定）
                }

                window.addEventListener('mousemove', onResizeMove);
                window.addEventListener('mouseup', onResizeUp);
            });
        }

        // 输出目录就绪检查：_outputDir 由 _ensureOutputDir 异步设置，未就绪时拦截所有写操作
        function _checkOutputReady() {
            if (!_outputDir) {
                if (global.AEToast) AEToast.warn(AEI18n.t('输出目录未就绪，请稍候再试'));
                return false;
            }
            return true;
        }

        // ── 输入节点路径改写的公共链路：设 path → 重渲染 → markDirty → 清缓存 ──
        function _setInputNodePath(nid, path) {
            var node = _graph.getNode(nid);
            if (!node) return;
            node.params = node.params || {};
            node.params.path = path;
            _renderNode(nid, { appear: false });
            _store && _store.markDirty();
            _invalidateCache(nid);
            // 导入图片/视频后按媒体宽高比自适应节点尺寸（仅 imageInput/videoInput）
            if (path) _fitNodeToMedia(nid, path, node.type);
            // 若活跃 gen 节点连了此输入 → 刷新容器缩略图（image 端口刷新图行，video 端口刷新视频行）
            _refreshActiveGenInput(nid);
        }

        // 刷新活跃 gen 节点输入容器中、与 inputNodeId 相连端口的缩略图行。
        // 设路径 / 清空内容 / 截帧 / 粘贴 等改变输入节点内容的操作都调它，保证容器缩略图与输入节点同步。
        // 不在此处判断 _activeGenNodeId 是否连了 nid——内部按 toPort 分发，未连则无操作。
        function _refreshActiveGenInput(inputNodeId) {
            if (!_activeGenNodeId || !_genInputEl || _genInputEl.style.display === 'none') return;
            var allEdges = _graph.edges();
            var activeNode = _graph.getNode(_activeGenNodeId);
            var topRow = _genInputEl.querySelector('.ng-gen-input-top');
            if (!topRow || !activeNode) return;
            for (var ei = 0; ei < allEdges.length; ei++) {
                if (allEdges[ei].from !== inputNodeId || allEdges[ei].to !== _activeGenNodeId) continue;
                if (allEdges[ei].toPort === 'image') {
                    if (global.AEComfyUI._refreshInputThumb) global.AEComfyUI._refreshInputThumb(topRow, activeNode, _ctx);
                } else if (allEdges[ei].toPort === 'video') {
                    if (global.AEComfyUI._refreshVideoThumb) global.AEComfyUI._refreshVideoThumb(topRow, activeNode, _ctx);
                }
            }
        }

        // ── 节点按媒体宽高比自适应尺寸 ──
        // 探活媒体真实尺寸（image 用 Image.naturalWidth，video 用 videoWidth），再交 _applyMediaFit 落地。
        // 不重建节点 DOM（避免清掉刚写入的预览），直接改 el 尺寸 + params + 触发 ae:node-resized。
        // 异步探针竞态防护：每节点维护递增 token，晚触发的旧探针丢弃，避免旧媒体尺寸覆盖当前节点。
        // unmount 后 _graph=null，_applyMediaFit 入口守卫挡住晚触发探针的 null 解引用。
        var _fitTokens = {};
        function _nextFitToken(nid) { _fitTokens[nid] = (_fitTokens[nid] || 0) + 1; return _fitTokens[nid]; }
        var _toFileUrl = function (p) {
            return (global.AEComfyUI.toFileUrl)
                ? global.AEComfyUI.toFileUrl(p)
                : ('file:///' + String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, ''));
        };
        // HTML 属性值转义：防止路径/文件名中的特殊字符导致 XSS（defense in depth）
        function _escapeAttr(s) {
            return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
        // 给 file:/// URL 附加时间戳查询参数，防浏览器缓存旧图（同路径文件覆盖写入时生效）
        function _cacheBustUrl(p) {
            var base = _toFileUrl(p);
            if (!base || !/^file:\/\//i.test(base)) return base;
            var sep = base.indexOf('?') >= 0 ? '&' : '?';
            return base + sep + '_cb=' + Date.now();
        }
        function _fitNodeToMedia(nid, path, nodeType) {
            var node = _graph.getNode(nid);
            if (!node || !path) return;
            var t = nodeType || node.type;
            if (t !== 'imageInput' && t !== 'videoInput') return;
            var tok = _nextFitToken(nid);
            var url = _toFileUrl(path);
            if (t === 'imageInput') {
                var img = new Image();
                img.onload = function () { if (_fitTokens[nid] !== tok) return; _applyMediaFit(nid, img.naturalWidth, img.naturalHeight); };
                img.onerror = function () {};
                img.src = url;
            } else {
                var v = document.createElement('video');
                v.preload = 'metadata';
                v.onloadedmetadata = function () { if (_fitTokens[nid] !== tok) return; _applyMediaFit(nid, v.videoWidth, v.videoHeight); };
                v.onerror = function () {};
                v.src = url;
            }
        }
        // 已知媒体像素尺寸 → 算节点宽高（保持预览区宽高比）→ 写 params + 改 el + 重绘连线
        function _applyMediaFit(nid, mw, mh) {
            if (!_mounted || !_graph) return;   // 防卸载后晚触发探针 null 解引用
            var node = _graph.getNode(nid);
            if (!node || !mw || !mh) return;
            var aspect = mw / mh;
            var MIN_W = 220, MAX_W = 420, MIN_H = 150, MAX_H = 600;
            // 预览区目标宽：按 aspect 在 200~400 间取（横图偏宽、竖图偏窄），sqrt 防极端比例拉爆
            var previewW = Math.round(Math.max(200, Math.min(400, 260 * Math.sqrt(aspect))));
            var w = previewW + 20;                              // +边距
            // gen 节点头栏/端口占位更多，多留 chrome 高度
            var chromeH = (node.type === 'imageGen' || node.type === 'videoGen') ? 64 : 48;
            var h = Math.round(previewW / aspect) + chromeH;
            w = Math.max(MIN_W, Math.min(w, MAX_W));
            h = Math.max(MIN_H, Math.min(h, MAX_H));
            node.params = node.params || {};
            var isGen = node.type === 'imageGen' || node.type === 'videoGen';
            if (isGen) {
                node.params._layoutWidth = w;
                node.params._layoutHeight = h;
            } else {
                node.params.width = w;
                node.params.height = h;
            }
            var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nid];
            if (el) {
                el.style.width = w + 'px';
                el.style.height = h + 'px';
            } else {
                _renderNode(nid, { appear: false });
            }
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            _store && _store.markDirty();
            try { window.dispatchEvent(new CustomEvent('ae:node-resized', { detail: { nodeId: nid } })); } catch (_) {}
        }

        // 断开指定端口的连线（供节点缩略图 × 按钮 & gen 输入容器缩略图 × 按钮共用）
        function _disconnectEdge(fromId, fromPort, toId, toPort) {
            var allEdges = _graph.edges();
            var eid = null;
            for (var ei = 0; ei < allEdges.length; ei++) {
                if (allEdges[ei].from === fromId && allEdges[ei].to === toId &&
                    allEdges[ei].fromPort === fromPort && allEdges[ei].toPort === toPort) {
                    eid = allEdges[ei].id; break;
                }
            }
            if (!eid) return;
            try { _graph.removeEdge(eid); } catch (e) { return; }
            _invalidateCache(toId);
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            if (_store) _store.markDirty();
            if (_ctrl && _ctrl.nodeEls && _ctrl.nodeEls[toId]) _refreshNodeThumbnails(_ctrl.nodeEls[toId], toId);
            if (_ctrl && _ctrl.nodeEls && _ctrl.nodeEls[fromId]) _refreshNodeThumbnails(_ctrl.nodeEls[fromId], fromId);
            _pushHistory();   // 结构操作：立即推历史（× 断开连线）
        }

        // ── 节点体内上游缩略图行（.ng-thumbs）──
        function _refreshNodeThumbnails(nodeEl, nodeId) {
            var thumbs = nodeEl.querySelector('.ng-thumbs');
            if (!thumbs) return;
            thumbs.innerHTML = '';

            var edges = _graph.edges();
            var items = [];
            for (var i = 0; i < edges.length; i++) {
                if (edges[i].to !== nodeId) continue;
                var upId2 = edges[i].from;
                var upNode = _graph.getNode(upId2);
                var roots = [];
                if (upNode && upNode.params) {
                    // 生成类节点 / merge 等有 _result 的先取，再 fallback path/editedPath
                    if (upNode.params._result) {
                        var rImgs = upNode.params._result.images;
                        var rImg = upNode.params._result.image;
                        if (rImgs && rImgs.length) roots = roots.concat(rImgs);
                        else if (rImg) roots = roots.concat(Array.isArray(rImg) ? rImg : [rImg]);
                    }
                    if (!roots.length && upNode.params.editedPath) roots.push(upNode.params.editedPath);
                    if (!roots.length && upNode.params.path) roots.push(upNode.params.path);
                }
                if (!roots.length && _executor && _executor.getResult) {
                    var res2 = _executor.getResult(upId2);
                    if (res2) {
                        if (res2.image) roots = roots.concat(Array.isArray(res2.image) ? res2.image : [res2.image]);
                        if (res2.images && res2.images.length) roots = roots.concat(res2.images);
                    }
                }
                if (roots.length) {
                    for (var j = 0; j < roots.length; j++) {
                        items.push({ path: roots[j], edgeFrom: upId2, edgeFromPort: edges[i].fromPort, edgeToPort: edges[i].toPort });
                    }
                } else {
                    items.push({ placeholder: true, edgeFrom: upId2, edgeFromPort: edges[i].fromPort, edgeToPort: edges[i].toPort });
                }
            }

            if (!items.length) { thumbs.classList.add('ng-hidden'); return; }
            thumbs.classList.remove('ng-hidden');

            function _disconnectThumb(fromId, fromPort, toId, toPort) {
                _disconnectEdge(fromId, fromPort, toId, toPort);
            }

            for (var k = 0; k < items.length; k++) {
                (function (item) {
                    var wrap = document.createElement('div');
                    wrap.className = 'ng-thumb-wrap';
                    if (item.placeholder) {
                        var ph = document.createElement('div');
                        ph.className = 'ng-thumb ng-thumb-placeholder';
                        ph.title = AEI18n.t('等待上游生成…');
                        wrap.appendChild(ph);
                    } else {
                        var p3 = item.path;
                        // 统一走 _toFileUrl（既有 URL 前缀直通 + ?#% 编码），
                        // 手搓 file:/// 拼接漏编码，文件名含 #/%/? 时缩略图破图（与 S14 口径统一）
                        var src = p3 ? _toFileUrl(p3) : '';
                        var img = document.createElement('img');
                        img.className = 'ng-thumb';
                        img.draggable = false;
                        img.src = src;
                        img.title = p3 || '';
                        wrap.appendChild(img);

                        // hover 大预览（上方弹出）
                        var preview = document.createElement('div');
                        preview.className = 'ng-thumb-preview';
                        var preImg = document.createElement('img');
                        preImg.className = 'ng-thumb-preview-img';
                        preImg.draggable = false;
                        preImg.src = src;
                        preview.appendChild(preImg);
                        wrap.appendChild(preview);
                    }

                    // × 断开连线按钮（占位符和实际图都有）
                    var btn = document.createElement('button');
                    btn.className = 'ng-thumb-close';
                    btn.textContent = '×';
                    btn.title = AEI18n.t('断开连线');
                    btn.addEventListener('click', function (ev) {
                        ev.stopPropagation();
                        _disconnectThumb(item.edgeFrom, item.edgeFromPort, nodeId, item.edgeToPort);
                    });
                    wrap.appendChild(btn);

                    thumbs.appendChild(wrap);
                })(items[k]);
            }
        }

        // 输入变了 → 清该节点及所有下游 executor 缓存，防 stale 生成
        // visited 防环：gen 节点经 image[] 端口可互连成环（A→B→A），无防环 BFS 会死循环卡死 UI
        function _invalidateCache(nodeId) {
            if (!_executor) return;
            _executor.clearResult(nodeId);
            var edges = _graph.edges();
            var queue = [nodeId];
            var visited = {};
            visited[nodeId] = true;
            while (queue.length) {
                var cur = queue.shift();
                for (var i = 0; i < edges.length; i++) {
                    if (edges[i].from === cur && !visited[edges[i].to]) {
                        visited[edges[i].to] = true;
                        _executor.clearResult(edges[i].to);
                        queue.push(edges[i].to);
                    }
                }
            }
        }

        // 连线到新上游时清 imageEdit 节点的旧 editedPath（上游变了，旧编辑结果无效）
        function _clearEditedPathOnNewUpstream(nodeId) {
            var node = _graph.getNode(nodeId);
            if (!node || !node.params || !node.params.editedPath) return;
            node.params.editedPath = null;
            _renderNode(nodeId, { appear: false });
            _invalidateCache(nodeId);
        }

        // 找 nodeId 的直接上游输入节点的图片路径（imageEdit 用）
        function _resolveUpstreamImage(nodeId) {
            var edges = _graph.edges();
            for (var i = 0; i < edges.length; i++) {
                if (edges[i].to === nodeId) {
                    var upNode = _graph.getNode(edges[i].from);
                    if (!upNode) continue;
                    if (upNode.params) {
                        if (upNode.params.editedPath) return upNode.params.editedPath;
                        if (upNode.params.path) return upNode.params.path;
                    }
                    if (_executor && _executor.getResult) {
                        var res = _executor.getResult(edges[i].from);
                        if (res) {
                            if (res.image) return res.image;
                            if (res.images && res.images.length) return res.images[0];
                        }
                    }
                }
            }
            return null;
        }

        // 节点当前可用的单张图片文件路径；无则返回 null
        function _resolveNodeImage(nid) {
            var node = _graph.getNode(nid);
            if (!node || !node.params) return null;
            if (node.type === 'imageInput') return node.params.path || null;
            if (node.type === 'imageEdit') {
                if (node.params.editedPath) return node.params.editedPath;
                if (_executor && _executor.getResult) {
                    var er = _executor.getResult(nid);
                    if (er && er.image) return er.image;
                }
                return null;
            }
            if (node.type === 'imageGen') {
                var imgs = node.params._result && node.params._result.images;
                return (imgs && imgs.length) ? imgs[0] : null;
            }
            return null;
        }

        // 收集选中节点里可解析为单张图片的：返回 [{id, path, cx, cy}]
        function _collectSelectedImages() {
            var out = [];
            var selIds = Object.keys(_selectedNodes);
            for (var i = 0; i < selIds.length; i++) {
                var path = _resolveNodeImage(selIds[i]);
                if (!path) continue;
                var el = _worldEl.querySelector('[data-node-id="' + selIds[i] + '"]');
                var cx = 0, cy = 0;
                if (el) {
                    var r = el.getBoundingClientRect();
                    cx = r.left + r.width / 2;
                    cy = r.top + r.height / 2;
                }
                out.push({ id: selIds[i], path: path, cx: cx, cy: cy });
            }
            return out;
        }

        // 刷新 imageEdit 节点的编辑预览（无 .ng-thumbs，上游出图/连线变更后单独调）。
        // 有 editedPath 显示编辑结果，否则回退上游图（与 execute 一致）。nodeEl 可省略。
        function _syncImageEditPreview(nodeId, nodeEl) {
            var node = _graph.getNode(nodeId);
            if (!node || node.type !== 'imageEdit') return;
            if (!nodeEl) nodeEl = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
            if (!nodeEl) return;
            var editBox = nodeEl.querySelector('.ng-node-editor');
            if (editBox && typeof editBox._syncEditThumb === 'function') editBox._syncEditThumb();
        }

        // 输入文件落盘路径：_outputDir 下（_ensureOutputDir 保证绝对路径，调用者 _checkOutputReady 守卫）
        function _saveBlobToInputPath(blob, ext) {
            var name = 'in_' + new Date().getTime() + '.' + (ext || 'png');
            return _outputDir + '\\' + name;
        }

        function _gridTempDir() {
            var base = _dataDir || (_outputDir ? _outputDir.replace(/\\nodegen$/i, '') : '');
            if (!base) return '';
            return base.replace(/\\/g, '/').replace(/\/+$/, '') + '/temp/grid';
        }
        function _outputGridPath(prefix, index) {
            var dir = _gridTempDir();
            var name = prefix + '_' + new Date().getTime() + (index !== undefined ? '_' + index : '') + '.png';
            return dir ? dir + '/' + name : name;
        }
        function _isGridTempFile(p) {
            if (!p) return false;
            var dir = _gridTempDir();
            if (!dir) return false;
            var norm = p.replace(/\\/g, '/');
            if (norm.indexOf(dir) !== 0) return false;
            var base = norm.slice(dir.length + 1);
            return /^(grid|gridcell)_\d+.*\.png$/i.test(base);
        }

        // 清理 grid 临时文件：只删「未被任何存活节点引用 且 (孤儿标记超龄 或 mtime 超 24h)」的 grid_*/gridcell_*.png。
        async function _cleanGridTemp() {
            var dir = _gridTempDir();
            if (!dir) return;
            var exists = false;
            try { exists = await AEFS.exists(dir); } catch (_) {}
            if (exists !== true) return;
            var names = [];
            try { names = await AEFS.listFiles(dir); } catch (_) { return; }
            if (!Array.isArray(names)) return;
            // 收集存活节点引用
            var referenced = {};
            var nodes = _graph.nodes ? _graph.nodes() : [];
            for (var i = 0; i < nodes.length; i++) {
                var p = _resolveNodeImage(nodes[i].id);
                if (p) referenced[p.replace(/\\/g, '/')] = true;
            }
            // 其余画布磁盘快照 + running session 的 grid 引用同样收集，
            // 防止当前画布的清理误删其他画布引用的 grid 临时文件
            // 任一快照读/解析失败 → refs 不完整，整轮跳过删除（fail-closed）
            var _refsOk = await _collectDiskCanvasRefs(_normPath(dir), referenced);
            if (!_refsOk) {
                console.warn('[ComfyUI Canvas] 画布快照引用收集失败，跳过本轮 grid 临时清理（防误删其他画布产物）');
                return;
            }
            _collectRunningSessionRefs(_normPath(dir), referenced);
            var now = Date.now();
            for (var k = 0; k < names.length; k++) {
                var full = dir + '/' + names[k];
                var fullNorm = full.replace(/\\/g, '/');
                if (!_isGridTempFile(full)) continue;
                if (referenced[fullNorm]) continue;   // 被引用 → 绝不删
                var orphanTs = _gridOrphanSet[fullNorm];
                var deletable = false;
                if (orphanTs && (now - orphanTs) >= 60 * 60 * 1000) deletable = true;   // 孤儿标记超 1h
                if (!deletable) {
                    try {
                        var st = await AEFS.stat(full);
                        if (st && st.mtimeMs && (now - st.mtimeMs) >= 24 * 60 * 60 * 1000) deletable = true;
                    } catch (_) {}
                }
                if (!deletable) continue;
                try { await AEFS.deleteFile(full); } catch (_) {}
                delete _gridOrphanSet[fullNorm];
            }
        }

        // 归一化路径（\\ → /，去尾斜杠）
        function _normPath(p) {
            return p ? String(p).replace(/\\/g, '/').replace(/\/+$/, '') : '';
        }

        // 持久化形态是数据根相对路径（见 nodegenStore.serializeForSave）——
        // 磁盘快照里的相对路径先还原成绝对再比对前缀，否则引用收集会漏收 → 24h 清理误删。
        function _absFromStored(p) {
            return (global.AEShared && typeof global.AEShared.fromDataRelPath === 'function')
                ? global.AEShared.fromDataRelPath(_dataDir, p)
                : p;
        }

        // 深搜对象，收集所有指向 nodegen 输出目录的字符串路径（图片/视频/任意产物）。
        function _collectParamsRefs(obj, dirNorm, refs) {
            if (!obj) return;
            // 数组元素直存路径字符串（_result.images / results.videos 均为 string[]），
            // 顶层守卫只放行 object → 数组递归进来的字符串被丢弃 → gen 产物（含画布快照/
            // session 里的 images/videos）全部漏收，被 24h 清理误删
            if (typeof obj === 'string') {
                var s = _normPath(_absFromStored(obj));
                if (s.indexOf(dirNorm + '/') === 0) refs[s] = true;
                return;
            }
            if (typeof obj !== 'object') return;
            if (Array.isArray(obj)) {
                for (var a = 0; a < obj.length; a++) _collectParamsRefs(obj[a], dirNorm, refs);
                return;
            }
            for (var k in obj) {
                var v = obj[k];
                if (typeof v === 'string') {
                    var norm = _normPath(_absFromStored(v));
                    if (norm.indexOf(dirNorm + '/') === 0) refs[norm] = true;
                } else if (v && typeof v === 'object') {
                    _collectParamsRefs(v, dirNorm, refs);
                }
            }
        }

        // 收集所有存活节点 params 中引用到 nodegen 目录的文件路径（规范化键）。
        function _collectNodegenRefs() {
            var dirNorm = _normPath(_outputDir);
            var refs = {};
            if (!dirNorm) return refs;
            var nodes = _graph && _graph.nodes ? _graph.nodes() : [];
            for (var i = 0; i < nodes.length; i++) {
                _collectParamsRefs(nodes[i].params, dirNorm, refs);
            }
            return refs;
        }

        // 磁盘画布引用收集——所有画布共享同一 temp/nodegen 输出目录，
        // 引用只看当前 _graph 时，其他画布的 nodegen/grid 产物不在当前画布 refs 中，
        // 当前画布活跃超 24h 后会被清理物理删除（不可恢复）。扫注册表全部画布快照
        // （graph.json / canvas_*.json）深搜引用。
        // 返回值 = 快照是否全部可读（true=refs 完整）。若单文件读/解析
        // 失败静默跳过该画布（视同「零引用」）→ _cleanGridTemp/_cleanNodegenTemp 把该
        // 画布的产物当孤儿删除（不可恢复）。改为 fail-closed：任一失败返回 false，
        // 调用方整轮跳过删除（与 refs 收集抛错时调用方 .catch 中止清理同口径）。
        // AEFS 无 readFile 通道（降级环境）维持原语义返回 true（不阻塞清理）。
        async function _collectDiskCanvasRefs(dirNorm, refs) {
            if (!dirNorm || !_dataDir || !global.AEFS || !AEFS.readFile) return true;
            for (var i = 0; i < _canvases.length; i++) {
                var entry = _canvases[i];
                if (!entry || !entry.file) continue;
                try {
                    var text = await AEFS.readFile(_dataDir + '/nodegen/' + entry.file);
                    if (!text) return false;   // 空内容无法验证引用 → fail-closed
                    _collectParamsRefs(JSON.parse(text), dirNorm, refs);
                } catch (_) {
                    return false;   // 读/解析失败：该画布引用未知 → 整轮跳过删除
                }
            }
            return true;
        }

        // running session 的在途产物引用——存 genSessionManager（不在
        // _graph 也不在磁盘快照：detached 画布上的 writeResult 只进 session.results）。
        // getActiveSessions() 不带画布参数 → 收集全部画布的 running session。
        function _collectRunningSessionRefs(dirNorm, refs) {
            if (!dirNorm || !_genSessionMgr) return;
            // ③：改用全部 session（含 done 未销毁的）——done session 的产物同受
            // 保护；getActiveSessions 只含 running 时，生成完成后产物即失去引用，
            // 24h 被 _cleanNodegenTemp 误删（graph.json 未落盘的窗口期内不可恢复）
            var actives = (typeof _genSessionMgr.getAllSessions === 'function')
                ? _genSessionMgr.getAllSessions()
                : (typeof _genSessionMgr.getActiveSessions === 'function' ? _genSessionMgr.getActiveSessions() : null);
            if (!actives) return;
            for (var i = 0; i < actives.length; i++) {
                _collectParamsRefs(actives[i].results, dirNorm, refs);   // images/videos/finalResult
                _collectParamsRefs(actives[i].batch, dirNorm, refs);     // 批次在途帧 placeholders[].path
            }
        }

        // 全量 nodegen 引用 = 当前画布内存图 + 磁盘全部画布快照 + running session。
        // 任一快照不可读 → 返回 null（refs 不完整，调用方跳过当前轮删除）
        async function _collectNodegenRefsAll() {
            var dirNorm = _normPath(_outputDir);
            var refs = _collectNodegenRefs();
            if (!dirNorm) return refs;
            if (!(await _collectDiskCanvasRefs(dirNorm, refs))) return null;
            _collectRunningSessionRefs(dirNorm, refs);
            return refs;
        }

        // 清理 nodegen 临时文件：只删「未被任何存活节点引用 且 mtime 超 24h」的文件。
        async function _cleanNodegenTemp() {
            var dir = _normPath(_outputDir);
            if (!dir) return;
            var exists = false;
            try { exists = await AEFS.exists(dir); } catch (_) {}
            if (exists !== true) return;
            var names = [];
            try { names = await AEFS.listFiles(dir); } catch (_) { return; }
            if (!Array.isArray(names)) return;
            var refs = await _collectNodegenRefsAll();   // 全部画布 + running session 引用
            // refs 不完整（任一快照读/解析失败）→ 整轮跳过删除（fail-closed）
            if (!refs) {
                console.warn('[ComfyUI Canvas] 画布快照引用收集失败，跳过本轮 nodegen 临时清理（防误删其他画布产物）');
                return;
            }
            var now = Date.now();
            for (var k = 0; k < names.length; k++) {
                var fullNorm = _normPath(dir + '/' + names[k]);
                if (refs[fullNorm]) continue;   // 被引用 → 绝不删
                var deletable = false;
                try {
                    var st = await AEFS.stat(dir + '/' + names[k]);
                    if (st && st.mtimeMs && (now - st.mtimeMs) >= 24 * 60 * 60 * 1000) deletable = true;
                } catch (_) {}
                if (!deletable) continue;
                try { await AEFS.deleteFile(dir + '/' + names[k]); } catch (_) {}
            }
        }

        // File/Blob 无 .path 时 → writeBlobToFile → 设 path → 重渲染
        function _writeBlobToInputNode(nid, file) {
            if (!_checkOutputReady()) return;
            if (!_comfyController) { if (global.AEToast) AEToast.warn(AEI18n.t('AE IO 未就绪')); return; }
            var ext = (file.type && file.type.split('/')[1]) || 'bin';
            ext = ext.replace(/[^a-zA-Z0-9]/g, '') || 'bin';
            var path = _saveBlobToInputPath(file, ext);
            _comfyController.writeBlobToFile(file, path).then(function () {
                if (!_mounted) return;
                _setInputNodePath(nid, path);
            }).catch(function (e) {
                console.warn('[ComfyUI Canvas] 落盘失败:', e && e.message);
                if (global.AEToast) AEToast.error(AEI18n.t('加载失败: ') + (e && e.message || ''));
            });
        }

        function _editNode(nodeId) {
            var node = _graph.getNode(nodeId);
            if (!node) return;
            var defs = global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : [];
            var def = null;
            for (var i = 0; i < defs.length; i++) {
                if (defs[i].type === node.type) { def = defs[i]; break; }
            }
            if (!def || typeof def.renderEditor !== 'function') return;
            var el = _worldEl.querySelector('[data-node-id="' + nodeId + '"]');
            if (!el) return;
            var editorBox = el.querySelector('.ng-editor-box');
            if (!editorBox) return;
            try {
                def.renderEditor(editorBox, node, _ctx);
            } catch (e) {
                console.error('[ComfyUI Canvas] renderEditor 失败 (type=' + node.type + ', id=' + nodeId + '):', (e && e.message) || e);
            }
        }

        // 从剪贴板读图片/视频。返回约定：{ file: File } 或 { path: 绝对路径 }。
        // 优先 AEFS/Bridge 原生通道（免 Ctrl+V）：Node/PowerShell 直读 Windows 剪贴板。
        // Bridge 不可用或读取失败时回退浏览器通道（navigator.clipboard → Ctrl+V 监听）。
        function _readClipboardImage() {
            if (global.AEFS && typeof global.AEFS.readClipboard === 'function') {
                return global.AEFS.readClipboard().then(function (r) {
                    if (r && r.ok && r.kind === 'image' && r.base64) {
                        return { file: _base64ToFile(r.base64, r.mime || 'image/png') };
                    }
                    if (r && r.ok && r.kind === 'files' && r.files && r.files.length) {
                        // Explorer 复制的文件：直接给路径，省去字节复制
                        return { path: r.files[0] };
                    }
                    // 剪贴板确定无内容：直接报错，不再引导用户按 Ctrl+V
                    if (r && r.ok === false && r.error === 'empty') {
                        throw new Error('剪贴板无图片/视频');
                    }
                    if (r && r.ok === false) {
                        console.warn('[ComfyUI Canvas] bridge 剪贴板读取失败:', r.error, r.detail || '');
                    }
                    // bridge 未启动（null）/读取失败：回退浏览器通道
                    return _readClipboardViaBrowser();
                });
            }
            return _readClipboardViaBrowser();
        }

        function _base64ToFile(b64, mime) {
            var bin = atob(b64);
            var bytes = new Uint8Array(bin.length);
            for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            var ext = (mime.split('/')[1] || 'png').replace(/[^a-zA-Z0-9]/g, '');
            return new File([bytes], 'pasted_' + Date.now() + '.' + ext, { type: mime });
        }

        // 浏览器通道：navigator.clipboard.read → 失败回退 paste 事件监听 Ctrl+V
        function _readClipboardViaBrowser() {
            return new Promise(function (resolve, reject) {
                if (!navigator.clipboard || typeof navigator.clipboard.read !== 'function') {
                    _fallbackPaste(resolve, reject);
                    return;
                }
                var settled = false;
                var timeout = setTimeout(function () {
                    if (settled) return;
                    settled = true;
                    _fallbackPaste(resolve, reject);
                }, 800);
                navigator.clipboard.read().then(function (items) {
                    if (settled) return;
                    // 不预置 settled=true：循环未找到图片时必须落到 reject，否则 Promise 悬挂、按钮零反馈
                    clearTimeout(timeout);
                    for (var i = 0; i < items.length; i++) {
                        var types = items[i].types;
                        for (var t = 0; t < types.length; t++) {
                            var ty = types[t];
                            if (ty.indexOf('image/') === 0 || ty.indexOf('video/') === 0) {
                                var capturedType = ty;
                                settled = true;
                                items[i].getType(ty).then(function (blob) {
                                    var ext = (capturedType.split('/')[1] || 'bin').replace(/[^a-zA-Z0-9]/g, '');
                                    resolve(new File([blob], 'pasted_' + Date.now() + '.' + ext, { type: capturedType }));
                                }).catch(function (e) { reject(e); });
                                return;
                            }
                        }
                    }
                    settled = true;
                    reject(new Error('剪贴板无图片/视频'));
                }).catch(function (e) {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timeout);
                    // Clipboard API 拒绝（权限不足等），回退到 paste 事件
                    _fallbackPaste(resolve, reject);
                });
            });
        }

        function _fallbackPaste(resolve, reject) {
            // 隐藏 contenteditable：程序化 execCommand('paste') 需要可编辑元素聚焦
            var pasteTarget = document.createElement('div');
            pasteTarget.contentEditable = 'true';
            pasteTarget.setAttribute('tabindex', '-1');
            pasteTarget.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;';
            document.body.appendChild(pasteTarget);
            // 延迟聚焦：click 事件还在处理中，等当前事件循环完再聚
            setTimeout(function () { pasteTarget.focus(); }, 0);

            var settled = false;
            var toastHandle = null;

            function onPaste(e) {
                if (settled) return;
                var items = (e.clipboardData && e.clipboardData.items);
                if (items) {
                    for (var i = 0; i < items.length; i++) {
                        var it = items[i];
                        if (it.kind === 'file' && it.type && (it.type.indexOf('image/') === 0 || it.type.indexOf('video/') === 0)) {
                            var blob = it.getAsFile();
                            if (blob) {
                                settled = true;
                                e.preventDefault();
                                cleanup();
                                resolve(blob);
                                return;
                            }
                        }
                    }
                }
                var files = (e.clipboardData && e.clipboardData.files);
                if (files && files.length) {
                    var file = files[0];
                    if (file.type && (file.type.indexOf('image/') === 0 || file.type.indexOf('video/') === 0)) {
                        settled = true;
                        e.preventDefault();
                        cleanup();
                        resolve(file);
                        return;
                    }
                }
            }

            function cleanup() {
                clearTimeout(timer);
                pasteTarget.removeEventListener('paste', onPaste);
                document.removeEventListener('paste', onPaste);
                if (pasteTarget.parentNode) pasteTarget.parentNode.removeChild(pasteTarget);
                if (toastHandle) toastHandle.close();
            }

            pasteTarget.addEventListener('paste', onPaste);
            document.addEventListener('paste', onPaste);

            // 超时计时器（总超时 10s：execCommand 可能同步触发，若不同步就等用户手动 Ctrl+V）
            var timer = setTimeout(function () {
                if (settled) return;
                settled = true;
                cleanup();
                reject(new Error('粘贴超时'));
            }, 10000);

            // 尝试程序化粘贴（CEF Chrome 88 可能支持 execCommand('paste')）
            try {
                var didPaste = document.execCommand('paste');
                // 如果 execCommand 同步触发了 paste 事件，settled 会变成 true，cleanup 已执行
                // 如果没触发（返回 false 或不产生事件），继续等用户手动 Ctrl+V
                if (!didPaste && !settled) {
                    if (global.AEToast) {
                        toastHandle = global.AEToast.info(AEI18n.t('请按 Ctrl+V 粘贴图片'), { autoHideMs: 10000 });
                    } else {
                        console.warn('[ComfyUI Canvas] Clipboard API 不可用，请按 Ctrl+V 粘贴');
                    }
                }
            } catch (execErr) {
                console.warn('[ComfyUI Canvas] execCommand(\'paste\') 异常:', execErr && execErr.message);
                if (!settled) {
                    if (global.AEToast) {
                        toastHandle = global.AEToast.info(AEI18n.t('请按 Ctrl+V 粘贴图片'), { autoHideMs: 10000 });
                    }
                }
            }
        }

        // ============ 事件回调（canvasController 回调接口） ============

        function _onAddNode(id, def) {
            _renderNode(id);
            _store && _store.markDirty();
            _pushHistory();   // 结构操作：立即推历史
            if (_minimapUpdate) _minimapUpdate();
        }

        function _onRemove(nid) {
            if (_activeGenNodeId === nid) _closeGenInput();
            var el = _worldEl.querySelector('[data-node-id="' + nid + '"]');
            if (el) el.remove();
            // 从所有分组中清除此节点
            for (var gi = 0; gi < _groups.length; gi++) {
                _groups[gi].childIds = _groups[gi].childIds.filter(function (c) { return c !== nid; });
            }
            // 标记 grid 临时文件为孤儿（不立即删，交给 _cleanGridTemp 定时兜底，避免撤销后指向空文件）
            var orphanPath = _resolveNodeImage(nid);
            if (orphanPath && _isGridTempFile(orphanPath)) {
                _gridOrphanSet[orphanPath.replace(/\\/g, '/')] = Date.now();
            }
            // removeNode 会隐式删除该节点的所有边：先收集下游邻居，删后对其级联失效缓存
            // （与 _onDeleteEdge 的 _invalidateCache 一致），否则下游仍复用已删节点的旧结果
            var _downIds = {};
            var _preEdges = _graph.edges();
            for (var _dei = 0; _dei < _preEdges.length; _dei++) {
                if (_preEdges[_dei].from === nid) _downIds[_preEdges[_dei].to] = true;
            }
            _graph.removeNode(nid);
            if (_executor) _executor.clearResult(nid);
            for (var _dk in _downIds) _invalidateCache(_dk);
            if (_genSessionMgr) _genSessionMgr.removeSession(nid, _curCanvasFile());  // 清理该节点的 Generation Session
            // 同步清理 token 和 promptId 映射，避免残留引用指向已删除节点。
            // 均按当前画布复合键清理：其他画布同 id 节点的映射不受影响
            var _rmKey = _genKey(_curCanvasFile(), nid);
            delete _genTokens[_rmKey];
            delete _runningNodes[_rmKey];   // 在跑标记一并清（旧实例 finally 有存在性守卫，不会误减新实例计数）
            var _pids = Object.keys(_generatingNodeMap);
            for (var _pi = 0; _pi < _pids.length; _pi++) {
                var _pv = _generatingNodeMap[_pids[_pi]];
                if (_pv && _pv.nodeId === nid && _pv.canvasFile === _curCanvasFile()) delete _generatingNodeMap[_pids[_pi]];
            }
            if (_ctrl && _ctrl.nodeEls) delete _ctrl.nodeEls[nid];
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            delete _selectedNodes[nid];
            _refreshEdgeSelection();
            if (_lastContextNodeId === nid) _lastContextNodeId = null;
            _store && _store.markDirty();
            _pushHistory();   // 结构操作：立即推历史
            if (_minimapUpdate) _minimapUpdate();
        }

        // 检查 gen 节点已连图片数是否超出模型容量，超出弹 toast 提醒
        function _hexToRgba(hex, alpha) {
            if (!hex || hex[0] !== '#') return '';
            return 'rgba(' + parseInt(hex.slice(1,3), 16) + ',' + parseInt(hex.slice(3,5), 16) + ',' + parseInt(hex.slice(5,7), 16) + ',' + alpha + ')';
        }

        function _checkImageOverflow(nid) {
            var node = _graph.getNode(nid);
            if (!node || (node.type !== 'imageGen' && node.type !== 'videoGen')) return;
            var engine = _comfyController && _comfyController.getEngine ? _comfyController.getEngine() : null;
            var modelId = node.params && node.params.modelId;
            if (!engine || !modelId) return;
            var model = engine.getById ? engine.getById(modelId) : null;
            if (!model) return;
            var edges = _graph.edges();
            var imgCount = 0;
            for (var i = 0; i < edges.length; i++) {
                if (edges[i].to === nid && edges[i].toPort === 'image') imgCount++;
            }
            if (imgCount === 0) return;
            // 容量提示：pipeline 模板按 imageInputKeys 逐键收图，超出键数的图不会进入模板。
            // 可选图槽（optionalImage）与必需图槽（needsImage）模板同一判定——needsImage 只表示
            // 必需图槽，不决定模板能消费几张图。
            var notice = global.AEComfyUI.imageOverflowNotice
                ? global.AEComfyUI.imageOverflowNotice(model, imgCount) : null;
            if (notice && global.AEToast) AEToast.warn(notice);
            // 非 pipeline：动态拼 workflow，imageFilenames 逐 key 建 LoadImage，无硬上限，不拦
        }

        // 检查 videoGen 接了视频但当前模板没有可用的视频输入槽。
        // canConnect 允许 video→video[]，但 videoInputKeys 为空时 runGenWorkflow 不会把视频填进模板
        // → 连线时即提示，免得用户接完线生成时才发现视频被丢弃。
        // 提示区分「模板没有视频输入槽（引擎未派生可用 key）」与「不支持视频参考」，
        // 判定依据见 sharedUtils.videoOverflowNotice。仅在 gen 容器 ctx 里有 checkVideoOverflow 时由 UI 复用。
        function _checkVideoOverflow(nid) {
            var node = _graph.getNode(nid);
            if (!node || node.type !== 'videoGen') return;
            var engine = _comfyController && _comfyController.getEngine ? _comfyController.getEngine() : null;
            var modelId = node.params && node.params.modelId;
            if (!engine || !modelId) return;
            var model = engine.getById ? engine.getById(modelId) : null;
            if (!model) return;
            var edges = _graph.edges();
            var vidCount = 0;
            for (var i = 0; i < edges.length; i++) {
                if (edges[i].to === nid && edges[i].toPort === 'video') vidCount++;
            }
            if (vidCount === 0) return;
            var tpl = null;
            try {
                if (engine.getTemplate) tpl = engine.getTemplate(model.templateId || modelId);
            } catch (_) { tpl = null; }
            var notice = global.AEComfyUI.videoOverflowNotice
                ? global.AEComfyUI.videoOverflowNotice(model, tpl && tpl.parameters, vidCount) : null;
            if (notice && global.AEToast) AEToast.warn(notice);
        }

        // canvasController 已通过 graph.connect() 加边，此处仅做副作用
        // pairs: [{ from, to }]（单条连线也走批量收尾：一次落盘、一条撤销历史）
        function _onConnectBatch(pairs) {
            if (!pairs || !pairs.length) return;
            var fromIds = {}, toIds = {}, allIds = {};
            for (var i = 0; i < pairs.length; i++) {
                fromIds[pairs[i].from] = true;
                toIds[pairs[i].to] = true;
                allIds[pairs[i].from] = true;
                allIds[pairs[i].to] = true;
            }
            _store && _store.markDirty();
            // 活跃 gen 节点连线变更 → 关容器（避免输入参考图与实际连线不同步）
            if (_activeGenNodeId && allIds[_activeGenNodeId]) {
                _closeGenInput();
            }
            var tids = Object.keys(toIds);
            var fids = Object.keys(fromIds);
            for (var t = 0; t < tids.length; t++) {
                _invalidateCache(tids[t]);   // 新输入 → 目标及下游 executor 缓存失效（防 stale 生成）
                _clearEditedPathOnNewUpstream(tids[t]);
                _refreshDownstreamPreviews(tids[t]);
            }
            for (var f = 0; f < fids.length; f++) {
                if (_ctrl && _ctrl.nodeEls && _ctrl.nodeEls[fids[f]]) _refreshNodeThumbnails(_ctrl.nodeEls[fids[f]], fids[f]);
            }
            for (var t2 = 0; t2 < tids.length; t2++) {
                if (_ctrl && _ctrl.nodeEls && _ctrl.nodeEls[tids[t2]]) _refreshNodeThumbnails(_ctrl.nodeEls[tids[t2]], tids[t2]);
            }
            // imageEdit 无 .ng-thumbs，连上游后单独刷新其编辑预览（显示上游图）
            for (var t3 = 0; t3 < tids.length; t3++) _syncImageEditPreview(tids[t3]);
            // 检查 gen 节点输入是否超出模型容量（每节点一次，批量接入不重复提示）
            var nids = Object.keys(allIds);
            for (var c = 0; c < nids.length; c++) {
                _checkImageOverflow(nids[c]);
                _checkVideoOverflow(nids[c]);
            }
            _pushHistory();   // 结构操作：立即推历史
        }
        function _onConnect(fromId, toId) {
            _onConnectBatch([{ from: fromId, to: toId }]);
        }

        // canvasController 已通过 graph.removeEdge() 删边，此处仅做副作用
        function _onDeleteEdge(fromId, toId) {
            _store && _store.markDirty();
            // 活跃 gen 节点连线变更 → 关容器
            if (_activeGenNodeId && (_activeGenNodeId === toId || _activeGenNodeId === fromId)) {
                _closeGenInput();
            }
            if (toId) _invalidateCache(toId);   // 输入断开 → 目标及下游 executor 缓存失效（防 stale 生成）
            _clearEditedPathOnNewUpstream(toId);
            if (fromId && _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[fromId]) _refreshNodeThumbnails(_ctrl.nodeEls[fromId], fromId);
            if (toId && _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[toId]) _refreshNodeThumbnails(_ctrl.nodeEls[toId], toId);
            _pushHistory();   // 结构操作：立即推历史
        }

        function _onCopy(nid) {
            var selIds = Object.keys(_selectedNodes);
            if (selIds.length <= 1) selIds = [nid];
            // ── 分离节点 ID 和分组 ID ──
            var nodeSelIds = [], groupSelIds = [];
            for (var si = 0; si < selIds.length; si++) {
                if (selIds[si].indexOf('g_') === 0) groupSelIds.push(selIds[si]);
                else nodeSelIds.push(selIds[si]);
            }
            // 分组内的子节点纳入复制范围
            for (var gi = 0; gi < groupSelIds.length; gi++) {
                var grp = null;
                for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === groupSelIds[gi]) { grp = _groups[gx]; break; } }
                if (!grp) continue;
                var childIds = _collectAllChildIds(grp);
                for (var ci = 0; ci < childIds.length; ci++) { nodeSelIds.push(childIds[ci]); }
            }
            // 去重
            var uniqNodeIds = [], dedup = {};
            for (var di = 0; di < nodeSelIds.length; di++) {
                if (!dedup[nodeSelIds[di]]) { dedup[nodeSelIds[di]] = true; uniqNodeIds.push(nodeSelIds[di]); }
            }
            // 复制节点
            var newIds = [], idMap = {};
            for (var s = 0; s < uniqNodeIds.length; s++) {
                var src = _graph.getNode(uniqNodeIds[s]);
                if (!src) continue;
                var nid2 = _graph.addNode(src.type, { x: src.x + 30, y: src.y + 30 });
                idMap[uniqNodeIds[s]] = nid2;
                var newNode = _graph.getNode(nid2);
                if (newNode) {
                    newNode.params = JSON.parse(JSON.stringify(src.params || {}));
                    // 清生成结果与批量/多图簿记（残留会让副本重载后"复活"源节点旧结果）
                    delete newNode.params._result;
                    delete newNode.params._frameHTMLs;
                    delete newNode.params._placeholders;
                    delete newNode.params._batchCurIdx;
                    delete newNode.params._multiImgs;
                    delete newNode.params._multiCurIdx;
                    newNode.note = src.note || '';
                    newNode.color = src.color || '';
                }
                newIds.push(nid2);
            }
            // 复制内部连线
            var allEdges = _graph.edges();
            for (var ei = 0; ei < allEdges.length; ei++) {
                var nf = idMap[allEdges[ei].from], nt = idMap[allEdges[ei].to];
                if (nf && nt) {
                    try { _graph.connect(nf, allEdges[ei].fromPort, nt, allEdges[ei].toPort); } catch (er) {}
                }
            }
            for (var ni = 0; ni < newIds.length; ni++) _renderNode(newIds[ni]);
            // 复制分组（含嵌套子分组）
            var grpIdMap = {};
            var allGrpsToCopy = [];
            var grpVisited = {};
            function _collectNested(gid) {
                if (grpVisited[gid]) return;
                grpVisited[gid] = true;
                var sg = null;
                for (var gx3 = 0; gx3 < _groups.length; gx3++) { if (_groups[gx3].id === gid) { sg = _groups[gx3]; break; } }
                if (!sg) return;
                allGrpsToCopy.push(sg);
                var subGids = sg.childGroupIds || [];
                for (var sgi = 0; sgi < subGids.length; sgi++) _collectNested(subGids[sgi]);
            }
            for (var gii = 0; gii < groupSelIds.length; gii++) _collectNested(groupSelIds[gii]);
            function _grpDepth(gid) {
                for (var gx4 = 0; gx4 < allGrpsToCopy.length; gx4++) {
                    if ((allGrpsToCopy[gx4].childGroupIds || []).indexOf(gid) >= 0) return _grpDepth(allGrpsToCopy[gx4].id) + 1;
                }
                return 0;
            }
            allGrpsToCopy.sort(function (a, b) { return _grpDepth(a.id) - _grpDepth(b.id); });

            for (var gii = 0; gii < allGrpsToCopy.length; gii++) {
                var srcGrp = allGrpsToCopy[gii];
                var ngId = 'g_' + new Date().getTime() + '_' + gii;
                grpIdMap[srcGrp.id] = ngId;
                var newGrp = {
                    id: ngId, title: srcGrp.title,
                    x: srcGrp.x + 30, y: srcGrp.y + 30,
                    w: srcGrp.w, h: srcGrp.h,
                    color: srcGrp.color, note: srcGrp.note,
                    childIds: [], childGroupIds: []
                };
                for (var cj = 0; cj < (srcGrp.childIds || []).length; cj++) {
                    var mapped = idMap[srcGrp.childIds[cj]];
                    if (mapped) newGrp.childIds.push(mapped);
                }
                newGrp._oldChildGroupIds = (srcGrp.childGroupIds || []).slice();
                _groups.push(newGrp);
                _renderGroup(newGrp);
            }
            for (var gii2 = 0; gii2 < allGrpsToCopy.length; gii2++) {
                var ngId2 = grpIdMap[allGrpsToCopy[gii2].id];
                var newGrp2 = null;
                for (var gx5 = 0; gx5 < _groups.length; gx5++) { if (_groups[gx5].id === ngId2) { newGrp2 = _groups[gx5]; break; } }
                if (!newGrp2) continue;
                var oldCids = newGrp2._oldChildGroupIds || [];
                delete newGrp2._oldChildGroupIds;
                for (var oci = 0; oci < oldCids.length; oci++) {
                    var mappedGid = grpIdMap[oldCids[oci]];
                    if (mappedGid) newGrp2.childGroupIds.push(mappedGid);
                }
            }
            _store && _store.markDirty();
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            if (_minimapUpdate) _minimapUpdate();
            _pushHistory();   // 结构操作：立即推历史（右键复制）
        }

        // 选中节点集变化后即时切换连线高亮（只切类，不重画整层）。
        function _refreshEdgeSelection() {
            if (_ctrl && typeof _ctrl.refreshSelectionHighlight === 'function') _ctrl.refreshSelectionHighlight();
        }

        function _selectNode(nodeId, ev) {
            var node = _graph.getNode(nodeId);
            var shift = ev && ev.shiftKey;

            // gen 节点：如果已经是活跃容器节点，无操作
            if (node && (node.type === 'imageGen' || node.type === 'videoGen') && _activeGenNodeId === nodeId && !shift) {
                return;
            }
            // 当前有活跃 gen 节点容器且不是本次点击的节点 → 关容器
            if (_activeGenNodeId && _activeGenNodeId !== nodeId) {
                _closeGenInput();
            }

            if (shift) {
                // Shift+点击：切换选中状态
                if (_selectedNodes[nodeId]) {
                    delete _selectedNodes[nodeId];
                    var sEl = _worldEl.querySelector('[data-node-id="' + nodeId + '"]');
                    if (sEl) { sEl.classList.remove('ng-node-selected'); }
                } else {
                    _selectedNodes[nodeId] = true;
                    var aEl = _worldEl.querySelector('[data-node-id="' + nodeId + '"]');
                    _bumpZIndex();
                    if (aEl) { aEl.classList.add('ng-node-selected'); aEl.style.zIndex = String(_topZIndex); }
                    _lastContextNodeId = nodeId;
                }
            } else {
                _deselectAll();
                _selectedNodes[nodeId] = true;
                var el = _worldEl.querySelector('[data-node-id="' + nodeId + '"]');
                _bumpZIndex();
                if (el) { el.classList.add('ng-node-selected'); el.style.zIndex = String(_topZIndex); }
                _lastContextNodeId = nodeId;
            }

            // gen 节点：弹出容器（仅在非 Shift 单选时）
            if (!shift && node && (node.type === 'imageGen' || node.type === 'videoGen')) {
                _openGenInput(nodeId);
            }
            _refreshEdgeSelection();
        }

        function _deselectAll() {
            var ids = Object.keys(_selectedNodes);
            for (var i = 0; i < ids.length; i++) {
                if (ids[i].indexOf('g_') === 0) {
                    var gel = _groupRenderer && _groupRenderer.getEl(ids[i]);
                    if (gel) gel.classList.remove('ng-group-selected');
                } else {
                    var el = _worldEl.querySelector('[data-node-id="' + ids[i] + '"]');
                    if (el) { el.classList.remove('ng-node-selected'); }
                }
                delete _selectedNodes[ids[i]];
            }
            _refreshEdgeSelection();
        }

        // ── undo/redo：立即 push（结构操作用，取消 pending 防抖）──
        var _hDefer = 0;   // 历史推入抑制计数：复合操作（拖线右键"创建并连线"）期间子步骤不单独入栈
        function _pushHistory() {
            if (!_history) return;
            if (_hDefer > 0) return;
            if (_hDebounce) { clearTimeout(_hDebounce); _hDebounce = null; }
            _history.push();
        }
        // 复合结构操作包装：begin 抑制子步骤历史，end 解除并补一条合并历史
        function _historyTxnBegin() { _hDefer++; }
        function _historyTxnEnd() {
            if (_hDefer > 0) _hDefer--;
            if (_hDefer === 0) _pushHistory();
        }
        // ── undo/redo：防抖 push（参数编辑用，连续打字合并为一步）──
        function _scheduleHistoryPush() {
            if (!_history) return;
            if (_hDebounce) clearTimeout(_hDebounce);
            _hDebounce = setTimeout(function () { _hDebounce = null; _history.push(); }, 800);
        }

        // 清空运行时（graph + DOM + nodeEls + 分组 + 执行器缓存 + 选中/容器状态）。
        // undo restore / 切换画布共用。保留引用对象本身（_groups / _ctrl.nodeEls）只清内容，
        // 因 store.setGroupsRef 与 canvasController 私有 nodeEls 持有同一引用。
        function _clearRuntime(optCanvasKey) {
            if (_activeGenNodeId) _closeGenInput();   // id 会变，旧容器引用失效
            _deselectAll();
            _lastContextNodeId = null;
            if (_executor) {
                // 切画布时脱绑该画布所有 session（session 数据在全局 manager 中存活，切回来时 reattach 全量恢复）
                var canvasKey = optCanvasKey || (_store && _store.getFile ? _store.getFile() : '__default__');
                if (_genSessionMgr) _genSessionMgr.detachCanvas(canvasKey);
                // ①：改调 invalidateAllForSwitch——不再递增 _paramGen（写回防护只
                // 拦「参数被改」不拦「画布切换」），切画布/切模块窗口期完成的在途生成仍能
                // 送达 session.writeResult（产物已落盘；原 invalidateAll 代次整体递增使
                // runNodeAsync 返回 undefined → writeResult 跳过 → 结果永久丢失）。
                // 跨画布污染由 executor 内 _switchEpoch 孤儿化机制防回归（切换后
                // 完成的结果只进当次调用私有表，不落共享缓存，新画布同 id 节点读不到）
                if (typeof _executor.invalidateAllForSwitch === 'function') _executor.invalidateAllForSwitch();
                else if (typeof _executor.invalidateAll === 'function') _executor.invalidateAll();
                else _executor.clearResult();
                // 在途互斥表一并清（同上"id 全变"语义）：跨画布同 id 是不同逻辑节点，
                // 旧画布在途表项残留会让新画布同 id 上游共享旧画布执行、拿到旧画布结果
                if (typeof _executor.clearInFlight === 'function') _executor.clearInFlight();
            }
            // 清空 graph
            var allNodes = _graph.nodes();
            for (var i = 0; i < allNodes.length; i++) _graph.removeNode(allNodes[i].id);
            // 清空节点 DOM + nodeEls 引用
            // ⚠️ 不能 _ctrl.nodeEls = {} 重新赋值：canvasController 内部私有 nodeEls（edgeLayer.redrawAll 用）
            //    与 _ctrl.nodeEls 同引用，重新赋值会让 controller 仍指向旧空对象 → redrawAll 读不到节点。
            //    改为删 key，保留原引用对象，_renderNode 重新填充同一对象。
            var nodeEls = _worldEl.querySelectorAll('.ng-node');
            for (var j = 0; j < nodeEls.length; j++) nodeEls[j].remove();
            if (_ctrl && _ctrl.nodeEls) {
                var _ne = _ctrl.nodeEls;
                for (var nek in _ne) { if (_ne.hasOwnProperty(nek)) delete _ne[nek]; }
            }
            // 清空分组 DOM + _groups
            // ⚠️ 选择器必须是 .ng-group-box（groupRenderer 创建的 class），
            // 用 .ng-group 永不命中 → 快照外的分组框成"幽灵框"残留画布
            var grpEls = _worldEl.querySelectorAll('.ng-group-box');
            for (var ge = 0; ge < grpEls.length; ge++) grpEls[ge].remove();
            // groupRenderer 内部 _groupEls 映射同步清空（否则 getEl 仍返回已脱离 DOM 的旧框）
            if (_groupRenderer && typeof _groupRenderer.destroy === 'function') _groupRenderer.destroy();
            _groups.length = 0;
        }

        // ── 视口适配：加载后自动平移缩放以显示全部节点 ──
        // 外层作用域（createCanvasIndex），供 _renderLoadedCanvas 调用。
        // 不能留在 mount() 内部——_renderLoadedCanvas 是 mount 的兄弟，看不到嵌套函数。
        function _fitViewportToNodes() {
            var ns = _graph.nodes();
            if (!ns.length) return;
            var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (var i = 0; i < ns.length; i++) {
                minX = Math.min(minX, ns[i].x);
                minY = Math.min(minY, ns[i].y);
                maxX = Math.max(maxX, ns[i].x + 200);
                maxY = Math.max(maxY, ns[i].y + 120);
            }
            if (!isFinite(minX)) return;
            var pad = 80;
            minX -= pad; minY -= pad; maxX += pad; maxY += pad;
            var w = maxX - minX, h = maxY - minY;
            if (w <= 0 || h <= 0) return;
            var cr = _canvasEl.getBoundingClientRect();
            var cw = cr.width, ch = cr.height;
            if (!cw || !ch) return;
            var fitScale = Math.min(cw / w, ch / h, 1);  // 最大不超 100%
            var centerX = (minX + maxX) / 2, centerY = (minY + maxY) / 2;
            var vp = _view.viewport;
            vp.setPan(cw / 2 - centerX * fitScale, ch / 2 - centerY * fitScale);
            vp.zoomAt(fitScale, 0, 0);
            _view.applyTransform();
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            if (_minimapUpdate) _minimapUpdate();
        }

        // 从 params._result 恢复 gen 节点的缩略图预览（切换画布后 executor 缓存已清，需从持久化的 _result 重建）
        function _restoreGenNodePreview(nodeId) {
            var genNode = _graph.getNode(nodeId);
            if (!genNode || (genNode.type !== 'imageGen' && genNode.type !== 'videoGen')) return;
            // _frameHTMLs 不落盘（渲染缓存，内含绝对 file:// URL）——
            // 从 _placeholders（在途批次）或 _result.images（已完成批次）重建
            if (genNode.params && !(genNode.params._frameHTMLs && genNode.params._frameHTMLs.length)) {
                var _rebuiltFrames = _rebuildFrameHTMLs(genNode);
                if (_rebuiltFrames && _rebuiltFrames.length) genNode.params._frameHTMLs = _rebuiltFrames;
            }
            // 如果有多帧车架数据，直接用 carousel 渲染器还原
            var fhtmls = genNode.params && genNode.params._frameHTMLs;
            if (fhtmls && fhtmls.length > 0) {
                // 防御：过滤掉可能的无效帧数据
                var validFrames = [];
                for (var fi = 0; fi < fhtmls.length; fi++) {
                    if (typeof fhtmls[fi] === 'string') validFrames.push(fhtmls[fi]);
                }
                genNode.params._frameHTMLs = validFrames;
                if (validFrames.length > 1 && _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId]) {
                    try {
                        _renderBatchFrameAt(nodeId, genNode.params._batchCurIdx || 0);
                    } catch (e) {
                        console.warn('[ComfyUI Canvas] 还原车架预览失败:', e);
                    }
                }
                return;
            }
            var result = genNode.params && genNode.params._result;
            if (!result) return;
            // 归一化单数 image → 复数 images
            if (result.image && !(result.images && result.images.length)) {
                result = { images: [result.image], text: result.text, video: result.video };
            }
            var genEl = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
            if (!genEl) return;
            var genPreview = genEl.querySelector('.ng-result-preview');
            if (!genPreview) return;
            var imgPaths = result.images || (result.image ? [result.image] : []) || [];
            if (imgPaths.length > 0) {
                var _curIdx = 0;
                var _totalImgs = imgPaths.length;
                var _renderImgAt = function(i) {
                    var path = imgPaths[i];
                    var fname = _escapeAttr(path.split('/').pop());
                    var url = _escapeAttr(_cacheBustUrl(path));
                    var cleanUrl = _toFileUrl(path);
                    var navHtml = _totalImgs > 1 ?
                        '<div class="ng-result-nav">' +
                            '<button class="ng-result-prev" title="' + AEI18n.t('上一张') + '">‹</button>' +
                            '<span class="ng-result-count">' + (i + 1) + '/' + _totalImgs + '</span>' +
                            '<button class="ng-result-next" title="' + AEI18n.t('下一张') + '">›</button>' +
                        '</div>' : '';
                    genPreview.innerHTML =
                        '<img class="ng-result-thumb" src="' + url + '" alt="' + fname + '" draggable="false" ' +
                        AEI18n.html('onerror="this.parentElement.innerHTML=\'<div class=\\\'ng-preview-error\\\'>预览加载失败</div>\'" />') +
                        navHtml;
                    var fitTok = _nextFitToken(nodeId);
                    var fitImg = genPreview.querySelector('img');
                    if (fitImg) {
                        var fit = function () { if (_fitTokens[nodeId] !== fitTok) return; _applyMediaFit(nodeId, fitImg.naturalWidth, fitImg.naturalHeight); };
                        if (fitImg.complete && fitImg.naturalWidth) fit();
                        else fitImg.addEventListener('load', fit);
                        fitImg.addEventListener('click', function (e) {
                            e.stopPropagation();
                            if (global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(cleanUrl);
                        });
                    }
                    if (_totalImgs > 1) {
                        var prevBtn = genPreview.querySelector('.ng-result-prev');
                        var nextBtn = genPreview.querySelector('.ng-result-next');
                        if (prevBtn) prevBtn.addEventListener('click', function (e) {
                            e.stopPropagation();
                            _curIdx = (_curIdx - 1 + _totalImgs) % _totalImgs;
                            _renderImgAt(_curIdx);
                        });
                        if (nextBtn) nextBtn.addEventListener('click', function (e) {
                            e.stopPropagation();
                            _curIdx = (_curIdx + 1) % _totalImgs;
                            _renderImgAt(_curIdx);
                        });
                    }
                }
                _renderImgAt(_curIdx);
            } else if (result.videoOut || result.video) {
                // videoGen 输出端口改名 videoOut 后，_result 单值 key 随之变为 videoOut；兼容旧落盘的 .video
                var vidPath = result.videoOut || result.video;
                var vidUrl = _escapeAttr(_toFileUrl(vidPath));
                genPreview.innerHTML = '<video class="ng-result-thumb" src="' + vidUrl + '" muted preload="metadata" draggable="false" title="' + AEI18n.t('点击放大查看') + '"></video>';
                var vidTok = _nextFitToken(nodeId);
                var fitVid = genPreview.querySelector('video');
                if (fitVid) {
                    fitVid.addEventListener('loadedmetadata', function () {
                        if (_fitTokens[nodeId] !== vidTok) return;
                        _applyMediaFit(nodeId, fitVid.videoWidth, fitVid.videoHeight);
                    });
                    fitVid.addEventListener('click', function (e) {
                        e.stopPropagation();
                        if (global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(vidUrl, true);
                    });
                }
            }
        }

        // 遍历所有 gen 节点，从 params._result 恢复缩略图预览
        function _restoreAllGenResultPreviews(skipIds) {
            var skip = {};
            if (skipIds) for (var si = 0; si < skipIds.length; si++) skip[skipIds[si]] = true;
            var nodes = _graph.nodes();
            for (var i = 0; i < nodes.length; i++) {
                if (skip[nodes[i].id]) continue;  // 已被 session reattach 恢复，跳过
                _restoreGenNodePreview(nodes[i].id);
            }
        }

        // 把 store.load / applyToGraph 产出的 ids+groups 渲染到画布（undo restore / 切换画布 / 初次加载共用）。
        // fit：是否自动适配视口（初次加载/切换时 true，undo restore 时 false 保持视口）。
        // 整屏批量重建一律不播放入场动画：逐节点渲染显式传 appear:false。
        function _renderLoadedCanvas(result, fit, skipHistoryReset) {
            var ids = (result && result.ids) || [];
            var groups = (result && result.groups) || [];

            var failedCount = 0;
            for (var i = 0; i < ids.length; i++) {
                try {
                    var node = _graph.getNode(ids[i]);
                    if (node) _renderNode(node.id, { appear: false });
                } catch (e) {
                    failedCount++;
                    console.error('[ComfyUI Canvas] 渲染节点 ' + ids[i] + ' 失败:', (e && e.message) || e);
                }
            }
            if (failedCount > 0) console.warn('[ComfyUI Canvas] ' + failedCount + '/' + ids.length + ' 个节点渲染失败，已跳过');
            if (groups && groups.length) {
                for (var g = 0; g < groups.length; g++) _groups.push(groups[g]);
                _store && _store.setGroupsRef(_groups);
                try { _renderAllGroups(); } catch (e) { console.error('[ComfyUI Canvas] 渲染分组失败:', (e && e.message) || e); }
            }
            if (_minimapUpdate) { try { _minimapUpdate(); } catch (e) {} }
            if (_ctrl && _ctrl.redrawEdges) { try { _ctrl.redrawEdges(); } catch (e) {} }
            if (fit) { try { _fitViewportToNodes(); } catch (e) { console.error('[ComfyUI Canvas] 视口适配失败:', (e && e.message) || e); } }
            // 历史栈重置：清旧栈，push 当前状态作 s0（undo 回退底线）。
            // undo/redo restore 路径跳过（否则每次撤回都清空栈，导致只能撤回一步）。
            if (_history && !skipHistoryReset) { _history.reset(); _pushHistory(); }
            // Generation Session 重绑：把切画布前脱绑的 session 重新挂载到新 DOM，全量恢复预览/进度/队列
            // 返回已恢复的 nodeId 列表，供 _restoreAllGenResultPreviews 跳过（避免重复渲染）
            var canvasFile = _store ? _store.getFile() : '__default__';
            var restoredIds = _genSessionMgr ? _genSessionMgr.reattachCanvas(canvasFile, _createRenderFns()) : [];
            // ②：reattach 恢复的 _result/帧数据已写入 node.params（内存），全链路
            // 无 markDirty → graph.json 无记录，重启后恢复的结果丢失。恢复过 session
            // 即标脏（空恢复不误标，磁盘加载的 _result 本就在 graph.json 里）。
            // undo/redo restore 路径（skipHistoryReset=true）走 markDirtySilent
            // ——markDirty 的 onDirty → 防抖 push 会清空 redoStack（去重因 id 重分配失效）；
            // 加载路径历史栈刚 reset+push s0，防抖 push 被去重拦截，保持 markDirty。
            if (restoredIds && restoredIds.length > 0 && _store) {
                if (skipHistoryReset) _store.markDirtySilent();
                else _store.markDirty();
            }
            // 从持久化的 _result 恢复无 session 的 gen 节点缩略图预览（从磁盘加载的旧结果）
            _restoreAllGenResultPreviews(restoredIds);
            // 恢复被画布切换中断的队列：session 有待处理队列且节点不在生成中 → 仅恢复队列
            if (_genSessionMgr) {
                var activeSessions = _genSessionMgr.getActiveSessions(canvasFile);
                for (var asi = 0; asi < activeSessions.length; asi++) {
                    var asid = activeSessions[asi].nodeId;
                    if (activeSessions[asi].hasQueued() && !_isNodeGenerating(asid)) {
                        _runGen(asid, true);
                    }
                }
            }
        }

        // ── 多画布注册表 ──
        // canvases.json: { activeId, canvases: [{id,name,file,createdAt,updatedAt}] }
        // 默认画布复用既有 graph.json（零迁移）；新建画布用 canvas_<id>.json。
        function _registryPath() { return _dataDir + '/nodegen/canvases.json'; }
        function _canvasFilePath(entry) { return _dataDir + '/nodegen/' + entry.file; }

        function _createCanvasEntry(name, file) {
            var id = 'c' + Date.now() + Math.floor(Math.random() * 1000);
            var now = Date.now();
            return { id: id, name: name || '画布', file: file || ('canvas_' + id + '.json'), createdAt: now, updatedAt: now };
        }

        function _getActiveCanvas() {
            for (var i = 0; i < _canvases.length; i++) {
                if (_canvases[i].id === _activeCanvasId) return _canvases[i];
            }
            return null;
        }

        // 加载 canvases.json 注册表。回调 cb(err, reg)——err 非空 = 读取失败（三态读的
        // 失败支），调用方须中止加载流程（不建默认画布、不 _saveRegistry）。
        // 单用 AEFS.readFile 时（NOT_FOUND 与 CHANNEL_FAILURE 都折叠成
        // null）→ 读失败当「空注册表」→ 立即建默认画布并 _saveRegistry 覆盖，
        // 用户自建画布列表从 UI 消失（canvas_*.json 仍在盘上但只能手工改 JSON 找回）。
        // 三态：NOT_FOUND（真没有）→ 空注册表旧语义；CHANNEL_FAILURE/REJECTED（拿不到/
        // 不该读）→ 上抛错误；JSON 解析失败 → 先留 .corrupt.bak 再上抛（不覆盖）。
        function _loadRegistry(cb) {
            var reg = null;
            function done(err) { if (cb) cb(err || null); }
            function applyReg() {
                if (reg && Array.isArray(reg.canvases)) {
                    _canvases = reg.canvases;
                    _activeCanvasId = reg.activeId || (_canvases[0] ? _canvases[0].id : null);
                }
                done(null);
            }
            function parseFailed(e) {
                console.warn('[ComfyUI Canvas] canvases.json 解析失败，已保留损坏文件为 ' + _registryPath() + '.corrupt.bak，中止本次加载:', e.message);
                global.AEComfyUI.backupCorruptFile(_registryPath()).then(function () {
                    done({ code: 'PARSE_FAILED', message: 'canvases.json 解析失败: ' + ((e && e.message) || e), channel: null });
                }, function () {
                    done({ code: 'PARSE_FAILED', message: 'canvases.json 解析失败: ' + ((e && e.message) || e), channel: null });
                });
            }
            function consume(text) {
                if (!text) { applyReg(); return; }   // 空文件/真不存在 → 空注册表（旧语义，建默认画布）
                try { reg = JSON.parse(text); applyReg(); }
                catch (e) { parseFailed(e); }
            }
            if (!global.AEFS || (!AEFS.readFile && !AEFS.readFileResult)) { done(null); return; }
            if (typeof AEFS.readFileResult === 'function') {
                var pr = AEFS.readFileResult(_registryPath());
                if (!pr || typeof pr.then !== 'function') { done(null); return; }
                pr.then(function (r) {
                    if (!r || r.ok !== true) {
                        var e = r && r.error;
                        var code = (e && e.code) || 'CHANNEL_FAILURE';
                        if (code === 'NOT_FOUND') { applyReg(); return; }   // 真不存在 → 空注册表（旧语义）
                        done({ code: code, message: (e && e.message) || '注册表读取通道失败', channel: (e && e.channel) || null });
                        return;
                    }
                    consume(r.data);
                }, function (err) {
                    done({ code: 'CHANNEL_FAILURE', message: (err && err.message) || err || '注册表读取异常', channel: null });
                });
                return;
            }
            // 旧式折叠路径（无 readFileResult 的降级 AEFS/mock）：reject 按读失败上抛；
            // null 维持旧「空注册表」语义（该路径无法区分 NOT_FOUND 与通道故障）
            var p = AEFS.readFile(_registryPath());
            if (!p || typeof p.then !== 'function') { done(null); return; }
            p.then(function (text) { consume(text); }, function () { done(null); });
        }

        // 注册表写串行链——两次调用（建/切/删画布连续操作）的原子写会共用
        // 同一 <file>.tmp 交错（前者 rename 消费 tmp 后者的 rename 因 tmp 缺失失败）。
        // canvases.json 无 dirty 自愈机制，串行化从源头消除交错；快照在入链时同步捕获，
        // 后写者携带最新数据。
        // 返回本次写入的 Promise<boolean>（成功 true）——只 console.warn 时，
        // create/rename/delete 调用点无条件 toast success：写失败时重启后新建画布消失/
        // 删除的画布复活，回执撒谎。透传后由调用点给可见失败提示（成功语义不变）。
        var _registrySaveChain = Promise.resolve();
        function _saveRegistry() {
            // 画布读取失败后注册表进入只读（未就绪）——任何写回都是基于
            // 「读不出的空注册表」覆盖 canvases.json，用户画布列表不可恢复
            if (_canvasReadFailed) { console.warn('[ComfyUI Canvas] 画布未就绪（读取失败），跳过注册表写入'); return Promise.resolve(false); }
            if (!global.AEFS || !AEFS.writeFile) return Promise.resolve(false);
            try {
                // 原子写（.tmp → rename，助手来自 nodegenStore.js）——写盘窗口内
                // 进程中断不再截断 canvases.json（否则损坏 → 空注册表 → 覆盖，画布列表全丢）
                var payload = JSON.stringify({
                    activeId: _activeCanvasId,
                    canvases: _canvases
                });
                var target = _registryPath();
                _registrySaveChain = _registrySaveChain.then(function () {
                    return global.AEComfyUI.atomicWriteFile(target, payload);
                }).then(function (ok) {
                    if (!ok) console.warn('[ComfyUI Canvas] 注册表存盘失败(原子写), 保留旧文件');
                    return ok === true;
                }, function () {
                    console.warn('[ComfyUI Canvas] 注册表存盘失败(原子写), 保留旧文件');
                    return false;
                });
            } catch (e) { console.warn('[ComfyUI Canvas] 注册表存盘失败:', e.message); return Promise.resolve(false); }
            return _registrySaveChain;
        }

        // 注册表加载完成后的画布引导（挂载链与回归测试共用）。
        // 注册表读取失败 → 中止加载流程：不建默认画布、不 _saveRegistry（若按空
        // 注册表重建并立即回写，用户自建画布列表从 UI 消失），store 置只读/未就绪
        // 直到重启；成功或 NOT_FOUND（真不存在）→ 建默认画布（首次运行）并加载画布文件。
        function _bootstrapAfterRegistry(regErr) {
            if (regErr) {
                _canvasReadFailed = true;
                if (_store) _store.setReadOnly('画布注册表读取失败: ' + (regErr.message || regErr.code));
                console.error('[ComfyUI Canvas] 画布注册表读取失败，本次未加载，未做任何写入:', regErr.message || regErr.code);
                if (global.AEToast) {
                    AEToast.error(AEI18n.t('画布读取失败，本次未加载，未做任何写入。请重启面板或检查 bridge 后重试'));
                }
                return;
            }
            var active = _getActiveCanvas();
            if (!active) {
                // 注册表空（首次运行）→ 建默认画布（复用既有 graph.json，零迁移）
                active = _createCanvasEntry('默认画布', 'graph.json');
                _canvases.push(active);
                _activeCanvasId = active.id;
                _saveRegistry();
            }
            if (!_store) return;
            _store.setFile(_canvasFilePath(active));
            _activeCanvasId = active.id;
            var tok0 = ++_loadToken;
            _store.load(_graph, function (result, loadErr) {
                if (tok0 !== _loadToken) return;
                if (!_mounted) return;
                if (loadErr) {
                    // 粒度修正：文件级失败只作用于该画布（损坏且原文已备份 →
                    // 重置为空画布继续；通道故障/备份失败 → 标记该画布不可用 + 如实 toast），
                    // 不再置模块级 _canvasReadFailed（那会把整个画布模块锁成只读）
                    _handleCanvasFileFailure(active, loadErr, true);
                    return;
                }
                delete _unusableCanvases[active.id];   // 重试成功 → 清除不可用标记
                _renderLoadedCanvas(result, true);
                // graph 加载完成后才做首次清理：确保 grid 引用已知，避免误删被引用文件
                _cleanGridTemp().catch(function (_) {});
                _cleanNodegenTemp().catch(function (_) {});
            });
            _renderCanvasBar();
        }

        // ── 文件级失败处理（粒度修正）──
        // 判据边界：
        //   模块级（_canvasReadFailed）= canvases.json 通道故障/解析失败——无法确定该画
        //     哪些画布，维持既有「只读 + 不写 + 如实 toast + 守卫拦操作」。
        //   文件级（本函数）= 单个画布文件（graph.json / canvas_<id>.json）读失败——只作用于
        //     该画布，模块级锁不动，切换/新建/改名/删除与其它画布照常。
        // 返回 true = 已走「损坏已备份 → 重置为空画布」恢复出口（可继续编辑落盘）；
        //        false = 该画布本次不可用（未渲染、未覆盖；已标记 + 如实 toast）。
        function _handleCanvasFileFailure(entry, loadErr, renderEmpty) {
            var code = (loadErr && loadErr.code) || 'CHANNEL_FAILURE';
            // 恢复出口选型：沿用仓库既有 .corrupt 惯例（nodegenStore.backupCorruptFile →
            // <file>.corrupt.bak，恢复指引已固定为该名）——损坏原文已被 load 侧
            // 备份，且 backupOk（备份成功）才放行：rename 成功时原名已让给新内容，按空画布
            // 继续，新编辑正常落盘、原文可手工从 .corrupt.bak 恢复。
            // 不另立 .corrupt-<ts> 新命名（避免同一致命场景两套恢复路径分叉）。
            // 备份失败（backupOk=false）时原文件是损坏内容唯一副本，绝不覆盖 → 走不可用分支。
            if (code === 'PARSE_FAILED' && loadErr && loadErr.backupOk) {
                delete _unusableCanvases[entry.id];
                if (_store && typeof _store.clearReadFailure === 'function') {
                    _store.clearReadFailure('画布文件损坏，原文已备份为 .corrupt.bak，按空画布重置');
                }
                if (renderEmpty) _renderLoadedCanvas({ ids: [], idMap: {}, groups: [] }, true);
                console.warn('[ComfyUI Canvas] 画布「' + entry.name + '」文件损坏，已重置为空画布（原文保留在 ' + entry.file + '.corrupt.bak）');
                if (global.AEToast) {
                    AEToast.warn(AEI18n.t('画布「') + entry.name + AEI18n.t('」文件损坏，已备份为 ') + entry.file + AEI18n.t('.corrupt.bak 并重置为空画布'));
                }
                // 统一在出口回渲菜单栏——bootstrap 失败路径的 _renderCanvasBar 在
                // 异步 load 回调之前就执行完了，此处不补渲则菜单不会出现 ⚠；本分支还会清掉
                // 既有标记（陈旧标记同需回渲消失）
                _renderCanvasBar();
                return true;
            }
            // 通道故障（文件可能完好，只是读不到）/ APPLY_FAILED（JSON 合法、填充失败）/
            // 备份失败：不得折叠成空画布回写覆盖（前一批修复的真问题）。只标记该画布，
            // 再次切回会重试加载——通道恢复/手工修好文件即自愈，无需重启面板。
            _unusableCanvases[entry.id] = { code: code, message: (loadErr && loadErr.message) || '', at: Date.now() };
            console.error('[ComfyUI Canvas] 画布「' + entry.name + '」读取失败（' + code + '），本次未加载、未写入，已标记该画布不可用:', (loadErr && loadErr.message) || code);
            if (global.AEToast) {
                AEToast.error(AEI18n.t('画布「') + entry.name + AEI18n.t('」读取失败（') + code + AEI18n.t('），本次未加载、未写入；可切到其它画布继续，修复后切回重试'));
            }
            // 本函数是文件级失败的唯一汇聚点（bootstrap / 切换 / 回退 / 删除 /
            // 画布点自身重试），末尾统一回渲菜单栏，保证"标记不可用"立刻在菜单里可见 ⚠
            _renderCanvasBar();
            return false;
        }

        // 模块级未就绪（注册表读取失败）时被守卫拦下的操作不再静默（四处裸 return 会让
        // 界面毫无反应）——统一给一条 toast 说明失败原因与可做的动作。
        function _notifyCanvasUnavailable() {
            if (global.AEToast) {
                AEToast.warn(AEI18n.t('画布注册表读取失败，画布功能本次不可用（切换/新建/改名/删除已停用）；请重启面板或修复 bridge 后重试'));
            }
        }

        // 切换到指定画布：落盘当前 → 改 store 文件 → 清运行时 → 加载目标 → 渲染。
        // 粒度修正：目标画布文件失败只标记/重置该画布（_handleCanvasFileFailure），
        // 不置模块级锁；目标不可用且原画布存在时自动回退加载原画布，不让用户停在空白画布。
        function _switchCanvas(id) {
            if (_canvasReadFailed) { _notifyCanvasUnavailable(); return; }   // 注册表级未就绪 → 只读
            var entry = null;
            for (var i = 0; i < _canvases.length; i++) { if (_canvases[i].id === id) { entry = _canvases[i]; break; } }
            if (!entry) return;
            if (id === _activeCanvasId) {
                // 点"当前激活的不可用画布"= 重试加载（菜单行标题即"点击重试加载"）。
                // 若在此直接 return——点自己既无重试也无提示，坏画布只能靠切到别的画布再
                // 切回来自愈。仅带不可用标记时重试；正常激活画布点自己保持无操作（原语义）。
                // 重试失败仍由 _handleCanvasFileFailure 更新标记 + toast + 回渲菜单栏。
                if (!_unusableCanvases[id]) return;
                var tokRetry = ++_loadToken;
                _store.load(_graph, function (result, loadErr) {
                    if (tokRetry !== _loadToken) return;   // 已被更晚的切换/重试作废
                    if (loadErr) {
                        _handleCanvasFileFailure(entry, loadErr, true);
                        return;
                    }
                    delete _unusableCanvases[entry.id];   // 重试成功 → 清除不可用标记（自愈出口）
                    _renderLoadedCanvas(result, true);
                });
                _renderCanvasBar();
                return;
            }
            _restoreBatchSizesBeforeFlush();        // 恢复队列处理中临时修改的 batch_size
            // flush 同步失败（AEFS 不可用/写通道失败）时旧画布未保存改动不再被
            // setFile 静默吞掉——提示用户但不阻塞切换
            if (_store && !_store.flush()) {
                if (global.AEToast) AEToast.warn(AEI18n.t('旧画布存盘失败，未保存改动可能丢失'));
            }
            var oldEntry = _getActiveCanvas();   // 文件级失败时的回退目标
            // 捕获旧画布文件路径，_clearRuntime 用它对 session detachCanvas 正确分 key
            var oldCanvasKey = _store ? _store.getFile() : '__default__';
            _store.setFile(_canvasFilePath(entry));
            _activeCanvasId = id;
            _clearRuntime(oldCanvasKey);
            var tok = ++_loadToken;
            _store.load(_graph, function (result, loadErr) {
                if (tok !== _loadToken) return;   // 已被更晚的切换作废
                if (loadErr) {
                    // 可恢复（损坏已备份）→ 空画布继续；否则标记该画布并回退原画布
                    if (!_handleCanvasFileFailure(entry, loadErr, true) && oldEntry && oldEntry.id !== entry.id) {
                        _revertCanvasLoad(oldEntry, entry);
                    }
                    return;
                }
                delete _unusableCanvases[entry.id];   // 重试成功 → 清除不可用标记（自愈出口）
                _renderLoadedCanvas(result, true);
            });
            _saveRegistry();
            _renderCanvasBar();
        }

        // 目标画布文件不可用时的回退加载：目标切换已清运行时并把 activeId/注册表改到目标，
        // 不回退用户会停在空白画布且注册表 activeId 指向坏画布。回退本身再失败时只标记
        // 该画布（不再二次回退，防递归）。
        function _revertCanvasLoad(entry, failedEntry) {
            console.warn('[ComfyUI Canvas] 目标画布「' + (failedEntry && failedEntry.name) + '」不可用，回退到「' + entry.name + '」');
            var fromKey = _store ? _store.getFile() : '__default__';
            _store.setFile(_canvasFilePath(entry));
            _activeCanvasId = entry.id;
            _clearRuntime(fromKey);
            _saveRegistry();
            _renderCanvasBar();
            var tok = ++_loadToken;
            _store.load(_graph, function (result, loadErr) {
                if (tok !== _loadToken) return;
                if (loadErr) {
                    _handleCanvasFileFailure(entry, loadErr, true);
                    _renderCanvasBar();
                    return;
                }
                delete _unusableCanvases[entry.id];
                _renderLoadedCanvas(result, true);
            });
        }

        // 新建画布：注册表加项 → 切换过去（空画布）。
        function _createCanvas(name) {
            if (_canvasReadFailed) { _notifyCanvasUnavailable(); return; }   // 注册表级未就绪 → 只读
            var entry = _createCanvasEntry(name);
            _canvases.push(entry);
            _activeCanvasId = entry.id;   // 先置 active，_switchCanvas 内 flush 旧画布后切到它
            _saveRegistry();
            // 切换：flush 旧画布 → setFile 新画布（空）→ 清运行时 → 渲染空状态
            _restoreBatchSizesBeforeFlush();        // 恢复队列处理中临时修改的 batch_size
            // 对齐 _switchCanvas——flush 同步失败时提示旧画布未保存改动可能丢失
            if (_store && !_store.flush()) {
                if (global.AEToast) AEToast.warn(AEI18n.t('旧画布存盘失败，未保存改动可能丢失'));
            }
            var oldCanvasKey = _store ? _store.getFile() : '__default__';
            // setFile 已复位文件级读失败锁（粒度修正）——新文件无内容可毁，
            // 若沿用上一画布的 _readFailed，新画布的首批编辑会被 _writeBlocked 静默拒绝落盘
            delete _unusableCanvases[entry.id];
            // 新建画布文件全新、无内容可毁且不发起 load → 显式就绪，
            // 否则 store 停在加载态，关面板同步兜底会拒绝落盘新画布的最后改动
            _store.setFile(_canvasFilePath(entry), { ready: true });
            _clearRuntime(oldCanvasKey);
            ++_loadToken;   // 作废任何飞行中的旧 load 回调（防其把旧画布节点渲染进新空画布）
            _renderLoadedCanvas({ ids: [], idMap: {}, groups: [] }, true);   // 空画布直接渲染空状态 + 历史 s0
            _renderCanvasBar();
            // 回执等落盘结果——写失败时如实提示（无条件 success 会让重启后新建画布消失）
            _saveRegistry().then(function (ok) {
                if (!ok) {
                    if (global.AEToast) AEToast.error(AEI18n.t('画布注册表保存失败，新建的「') + entry.name + AEI18n.t('」可能在重启面板后丢失'));
                    return;
                }
                if (global.AEToast) AEToast.success(AEI18n.t('已创建画布「') + entry.name + AEI18n.punct('」', '"', '」', '“', '”', ' »', '»'));
            });
        }

        function _renameCanvas(id, name) {
            if (_canvasReadFailed) { _notifyCanvasUnavailable(); return; }   // 注册表级未就绪 → 禁写注册表
            name = (name || '').trim();
            if (!name) return;
            for (var i = 0; i < _canvases.length; i++) {
                if (_canvases[i].id === id) { _canvases[i].name = name; _canvases[i].updatedAt = Date.now(); break; }
            }
            // 改名成功保持无 toast 的原语义；写失败给可见提示（重启后改名丢失）
            _saveRegistry().then(function (ok) {
                if (!ok && global.AEToast) AEToast.error(AEI18n.t('画布注册表保存失败，重命名可能在重启面板后丢失'));
            });
            _renderCanvasBar();
        }

        function _deleteCanvas(id) {
            if (_canvasReadFailed) { _notifyCanvasUnavailable(); return; }   // 注册表级未就绪 → 只读
            if (_canvases.length <= 1) {
                if (global.AEToast) AEToast.warn(AEI18n.t('至少保留一个画布'));
                return;
            }
            var entry = null, idx = -1;
            for (var i = 0; i < _canvases.length; i++) { if (_canvases[i].id === id) { entry = _canvases[i]; idx = i; break; } }
            if (!entry) return;
            // 删画布文件（默认画布 graph.json 不删——保留作下次默认）
            if (entry.file !== 'graph.json' && global.AEFS && AEFS.deleteFile) {
                try { AEFS.deleteFile(_canvasFilePath(entry)); } catch (e) {}
            }
            delete _unusableCanvases[id];   // 文件级不可用标记随画布删除一并清理
            _canvases.splice(idx, 1);
            if (_activeCanvasId === id) {
                // 删的是当前画布 → 切到第一个
                var target = _canvases[0];   // 捕获目标条目：回调按它判失败/清标记，防期间注册表再变
                _activeCanvasId = target.id;
                var oldCanvasKey = _store ? _store.getFile() : '__default__';
                _store.setFile(_canvasFilePath(target));
                _clearRuntime(oldCanvasKey);
                var tok = ++_loadToken;
                _store.load(_graph, function (result, loadErr) {
                    if (tok !== _loadToken) return;
                    if (loadErr) {
                        // 粒度修正：文件级失败只标记/重置目标画布，不锁模块
                        _handleCanvasFileFailure(target, loadErr, true);
                        _renderCanvasBar();
                        return;
                    }
                    delete _unusableCanvases[target.id];
                    _renderLoadedCanvas(result, true);
                });
            }
            // 回执等落盘结果——写失败时如实提示（无条件 success 会让重启后删除的画布复活）
            _saveRegistry().then(function (ok) {
                if (!ok) {
                    if (global.AEToast) AEToast.error(AEI18n.t('画布注册表保存失败，已删除的「') + entry.name + AEI18n.t('」可能在重启面板后恢复'));
                    return;
                }
                if (global.AEToast) AEToast.success(AEI18n.t('已删除画布「') + entry.name + AEI18n.punct('」', '"', '」', '“', '”', ' »', '»'));
            });
            _renderCanvasBar();
        }

        // 渲染画布切换按钮 + 下拉菜单
        function _renderCanvasBar() {
            if (!_canvasBtnEl || !_canvasMenuEl) return;
            var active = _getActiveCanvas();
            var nameEl = _canvasBtnEl.querySelector('.ng-canvas-name');
            if (nameEl) nameEl.textContent = active ? active.name : AEI18n.t('画布');
            // 菜单项
            _canvasMenuEl.innerHTML = '';
            for (var i = 0; i < _canvases.length; i++) {
                var c = _canvases[i];
                var row = document.createElement('div');
                row.className = 'ng-canvas-row' + (c.id === _activeCanvasId ? ' ng-canvas-row-active' : '');
                // 粒度修正：文件级不可用（通道故障等）在菜单里如实标出——
                // 该行仍可点（切过去即重试加载，成功自愈），不是禁用项
                var bad = _unusableCanvases[c.id];
                if (bad) row.className += ' ng-canvas-row-unavailable';
                row.dataset.id = c.id;
                var nm = document.createElement('span');
                nm.className = 'ng-canvas-row-name';
                nm.textContent = c.name;
                nm.title = bad
                    ? AEI18n.punct('「', '"', '「', '„', '“', '« ', '«') + c.name + AEI18n.t('」上次读取失败（') + bad.code + AEI18n.t('），点击重试加载')
                    : AEI18n.t('切换到「') + c.name + AEI18n.punct('」', '"', '」', '“', '”', ' »', '»');
                row.appendChild(nm);
                var actions = document.createElement('span');
                actions.className = 'ng-canvas-row-actions';
                var rn = document.createElement('button');
                rn.className = 'ng-canvas-icon ng-canvas-rename';
                rn.type = 'button';
                rn.textContent = '✎';
                rn.title = AEI18n.t('重命名');
                var del = document.createElement('button');
                del.className = 'ng-canvas-icon ng-canvas-delete';
                del.type = 'button';
                del.textContent = '✕';
                del.title = AEI18n.t('删除');
                actions.appendChild(rn);
                actions.appendChild(del);
                row.appendChild(actions);
                _canvasMenuEl.appendChild(row);
            }
            var divider = document.createElement('div');
            divider.className = 'ng-canvas-divider';
            _canvasMenuEl.appendChild(divider);
            var newBtn = document.createElement('div');
            newBtn.className = 'ng-canvas-new';
            newBtn.textContent = AEI18n.t('＋ 新建画布');
            _canvasMenuEl.appendChild(newBtn);
        }

        // 绑定切换器事件（按钮开关、行切换/重命名/删除、新建、外部点击关闭）
        function _bindCanvasSwitcherEvents(switcher) {
            _canvasBtnEl.addEventListener('click', function (e) {
                e.stopPropagation();
                _canvasMenuEl.classList.toggle('ng-hidden');
            });
            _canvasMenuEl.addEventListener('click', function (e) {
                var t = e.target;
                var row = t.closest('.ng-canvas-row');
                if (row) {
                    var id = row.dataset.id;
                    if (t.closest('.ng-canvas-rename')) {
                        e.stopPropagation();
                        _promptRename(id);
                        return;
                    }
                    if (t.closest('.ng-canvas-delete')) {
                        e.stopPropagation();
                        _confirmDelete(id);
                        return;
                    }
                    // 点行名 → 切换
                    _canvasMenuEl.classList.add('ng-hidden');
                    _switchCanvas(id);
                    return;
                }
                if (t.closest('.ng-canvas-new')) {
                    _canvasMenuEl.classList.add('ng-hidden');
                    _promptCreate();
                }
            });
            // 外部点击关闭菜单（命名引用，供 unmount 移除）
            _onCanvasMenuOutside = function (e) {
                if (!_canvasMenuEl || _canvasMenuEl.classList.contains('ng-hidden')) return;
                if (!switcher.contains(e.target)) _canvasMenuEl.classList.add('ng-hidden');
            };
            document.addEventListener('click', _onCanvasMenuOutside);
        }

        function _promptRename(id) {
            if (typeof global.showPrompt !== 'function') return;
            var cur = null;
            for (var i = 0; i < _canvases.length; i++) { if (_canvases[i].id === id) { cur = _canvases[i]; break; } }
            if (!cur) return;
            global.showPrompt(AEI18n.t('重命名画布'), cur.name).then(function (name) {
                if (name == null) return;
                _renameCanvas(id, name);
                _renderCanvasBar();
            });
        }

        function _promptCreate() {
            if (typeof global.showPrompt !== 'function') return;
            // 默认名「画布 N」：取现有"画布 X"最大编号 +1
            var maxN = 0;
            for (var i = 0; i < _canvases.length; i++) {
                var m = /^画布\s*(\d+)$/.exec(_canvases[i].name);
                if (m) maxN = Math.max(maxN, parseInt(m[1]));
            }
            global.showPrompt(AEI18n.t('新建画布'), AEI18n.t('画布 ') + (maxN + 1)).then(function (name) {
                if (name == null) return;
                _createCanvas(name);
            });
        }

        function _confirmDelete(id) {
            var cur = null;
            for (var i = 0; i < _canvases.length; i++) { if (_canvases[i].id === id) { cur = _canvases[i]; break; } }
            if (!cur) return;
            if (typeof global.showConfirm !== 'function') { _deleteCanvas(id); return; }
            global.showConfirm(AEI18n.t('删除画布'), AEI18n.t('确定删除画布「{name}」吗？该画布的节点和连线将丢失，不可恢复。', { name: cur.name }), 'confirm').then(function (ok) {
                if (ok) _deleteCanvas(id);
            });
        }

        // 全量重建画布到 snap 状态（undo/redo restore）。
        // applyToGraph 会 mutate 传入 snap 的 groups（重映射 childIds 为新 node id），
        // 故先深拷贝，保留原快照供 redo 复用。id 全变（同 load 路径），执行器缓存全清。
        function _restoreSnapshot(snap) {
            if (!snap) return;
            _clearRuntime();
            // 灌回（深拷贝避免 applyToGraph mutate 原快照）
            var snapCopy = JSON.parse(JSON.stringify(snap));
            var result;
            try { result = _store.applyToGraph(snapCopy, _graph); }
            catch (e) { console.error('[ComfyUI Canvas] restore applyToGraph 失败:', (e && e.message) || e); return; }
            // snapCopy.groups 已被 applyToGraph 重映射为新 node id；fit=false 保持视口
            _renderLoadedCanvas(result, false, true);   // skipHistoryReset: undo/redo restore 不重置栈
            // restore 后显式落盘——undo/redo 的 suppress 只抑制历史栈回灌 push，
            // restore 链若不加 markDirty，撤销/重做的结构变更不落盘（graph.json 仍是
            // 撤销前内容），重启后被撤销的操作复活。
            // 改走 markDirtySilent——markDirty 触发的 onDirty → 800ms 防抖
            // push 会清空 redoStack 并污染 undo 栈（restore 重建后节点/边 id 与 _topKey
            // 必然不等，去重失效）；静默置脏只调度落盘，历史栈零副作用。
            if (_store) _store.markDirtySilent();
        }

        function _onMultiSelect(ids) {
            if (_activeGenNodeId) _closeGenInput();
            _deselectAll();
            for (var i = 0; i < ids.length; i++) {
                _selectedNodes[ids[i]] = true;
                // 可能是节点 ID（n…）或分组 ID（g_…）
                if (ids[i].indexOf('g_') === 0) {
                    var gel = _groupRenderer && _groupRenderer.getEl(ids[i]);
                    if (gel) gel.classList.add('ng-group-selected');
                } else {
                    var el = _worldEl.querySelector('[data-node-id="' + ids[i] + '"]');
                    if (el) el.classList.add('ng-node-selected');
                }
            }
            if (ids.length === 1) _lastContextNodeId = ids[0];
            _refreshEdgeSelection();
        }

        function _onEditCallback(nid) {
            var n = _graph.getNode(nid);
            if (!n) return;
            if (n.type === 'imageEdit') { _openImageEditor(nid); }
            else { _editNode(nid); }
        }

        // gen 节点右键 → 导出到 AE
        function _onExportNode(nid) {
            var node = _graph.getNode(nid);
            if (!node) return;
            var stash = node.params && node.params._result;
            var imgs = stash && stash.images;
            // videoGen 输出端口改名 videoOut 后单值 key 为 videoOut；兼容旧落盘的 .video
            var video = stash && (stash.videoOut || stash.video);
            var videos = (stash && stash.videos && stash.videos.length) ? stash.videos : (video ? [video] : []);
            // imageEdit：从 params.editedPath 或 executor 结果取
            if (!imgs && !video && node.type === 'imageEdit') {
                var editPath = node.params && node.params.editedPath;
                if (editPath) imgs = [editPath];
                else if (_executor && _executor.getResult) {
                    var er = _executor.getResult(nid);
                    if (er && er.image) imgs = [er.image];
                }
            }
            if ((!imgs || !imgs.length) && !videos.length) { if (global.AEToast) AEToast.warn(AEI18n.t('没有可导出的结果，先生成')); return; }
            if (!_comfyController) { if (global.AEToast) AEToast.warn(AEI18n.t('AE IO 未就绪')); return; }
            var paths = [];
            if (imgs && imgs.length) paths = paths.concat(imgs);
            paths = paths.concat(videos);
            if (global.AEToast) AEToast.info(AEI18n.t('导出 ') + paths.length + AEI18n.t(' 项到 AE…'));
            var tasks = paths.map(function (p, pi) {
                // readBlob 二进制通道直接拿 Blob（免 base64/atob 解码，支持视频/大文件）
                return AEFS.readBlob(p).then(function (r) {
                    if (!r || !r.success || !r.blob) throw new Error('读取失败: ' + p);
                    return _comfyController.importToAE({
                        blob: r.blob, filename: p.split('\\').pop().split('/').pop(),
                        promptId: nid, index: pi
                    });
                });
            });
            Promise.all(tasks).then(function (results) {
                if (global.AEToast) AEToast.success(AEI18n.t('导出完成，') + (results && results.length || 0) + AEI18n.t(' 项'));
            }).catch(function (e) {
                console.warn('[ComfyUI Canvas] 导出失败:', e && e.message);
                if (global.AEToast) AEToast.error(AEI18n.t('导出失败: ') + (e && e.message || ''));
            });
        }

        // gen 节点右键 → 拆分数组（多图结果拆成独立 imageInput 节点）
        function _onSplitNode(nid) {
            var node = _graph.getNode(nid);
            if (!node) return;
            var imgs = node.params && node.params._result && node.params._result.images;
            if (!imgs || !imgs.length) { if (global.AEToast) AEToast.warn(AEI18n.t('无可拆分结果（需先生成）')); return; }
            var defs = global.AEComfyUI.getNodeDefs ? global.AEComfyUI.getNodeDefs() : [];
            var inputDef = null;
            for (var d = 0; d < defs.length; d++) {
                if (defs[d].type === 'imageInput') { inputDef = defs[d]; break; }
            }
            if (!inputDef) return;
            for (var k = 0; k < imgs.length; k++) {
                var pid = _graph.addNode('imageInput', { x: node.x + 240, y: node.y + k * 120 });
                var pn = _graph.getNode(pid);
                pn.params = { path: imgs[k] };
                _renderNode(pid);
            }
            if (_store) _store.markDirty();
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            if (_minimapUpdate) _minimapUpdate();
            _pushHistory();   // 结构操作：立即推历史（拆分节点）
            if (global.AEToast) AEToast.success(AEI18n.t('已拆分 ') + imgs.length + AEI18n.t(' 个图片输入节点'));
        }

        // 右键 → 组成多宫格：选中恰好 4/9/16 张同比例图，按几何象限合成一张图，生成图片输入节点
        async function _onComposeGrid() {
            var imgs = _collectSelectedImages();
            if (imgs.length !== 4 && imgs.length !== 9 && imgs.length !== 16) {
                if (global.AEToast) AEToast.warn(AEI18n.t('组成多宫格需选中 4/9/16 张图片'));
                return;
            }
            var cols = Math.round(Math.sqrt(imgs.length));
            var ordered = global.AEComfyUI.mapNodesToGrid(imgs, cols);
            var paths = ordered.map(function (o) { return o.path; });
            var blob;
            try {
                blob = await global.AEComfyUI.composeGridImages(paths, cols, {
                    maxPx: 8192,
                    toFileUrl: function (p) { return global.AEComfyUI.toFileUrl ? global.AEComfyUI.toFileUrl(p) : p; }
                });
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('组成多宫格失败: ') + (e && e.message || e));
                return;
            }
            if (!_checkOutputReady()) return;
            var outPath = _outputGridPath('grid');
            try { await AEFS.mkdir(_gridTempDir()); } catch (_) {}
            try {
                await _comfyController.writeBlobToFile(blob, outPath);
            } catch (e) {
                if (global.AEToast) AEToast.error(AEI18n.t('多宫格落盘失败: ') + (e && e.message || e));
                return;
            }
            // 新节点放选中图包围盒右下（屏幕坐标 → 世界坐标，需经 screenToWorld 换算）
            var minX = Infinity, maxY = -Infinity;
            for (var i = 0; i < imgs.length; i++) {
                var el = _worldEl.querySelector('[data-node-id="' + imgs[i].id + '"]');
                if (!el) continue;
                var r = el.getBoundingClientRect();
                var cr = _canvasEl.getBoundingClientRect();
                var wx = r.left - cr.left, wy = r.top - cr.top;
                if (wx < minX) minX = wx;
                if (wy > maxY) maxY = wy;
            }
            var nx = 40, ny = 40;
            if (minX !== Infinity && _view && _view.screenToWorld) {
                var pt = _view.screenToWorld(minX + 40, maxY + 40);
                nx = pt.x; ny = pt.y;
            }
            var cid = _graph.addNode('imageInput', { x: nx, y: ny });
            var cn = _graph.getNode(cid);
            if (cn) cn.params = { path: outPath };
            _renderNode(cid);
            if (_store) _store.markDirty();
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            if (_minimapUpdate) _minimapUpdate();
            _pushHistory();
            if (global.AEToast) AEToast.success(AEI18n.t('已组成 ') + cols + '×' + cols + AEI18n.t(' 多宫格'));
        }

        // 右键 → 拆分多宫格：单张图切成 cols×cols 个子图，各自生成图片输入节点
        async function _onSplitGrid(nid, cols) {
            var path = _resolveNodeImage(nid);
            if (!path) { if (global.AEToast) AEToast.warn(AEI18n.t('该节点无可拆分的图片')); return; }
            if (!cols || (cols !== 2 && cols !== 3 && cols !== 4)) { if (global.AEToast) AEToast.warn(AEI18n.t('请选择 2×2/3×3/4×4')); return; }
            var blobs;
            try {
                blobs = await global.AEComfyUI.splitGridImage(path, cols, {
                    minCell: 256,
                    toFileUrl: function (p) { return global.AEComfyUI.toFileUrl ? global.AEComfyUI.toFileUrl(p) : p; }
                });
            } catch (e) {
                if (e && e.code === 'RESOLUTION') { if (global.AEToast) AEToast.warn(AEI18n.t('分辨率不足，无法拆分成 ') + cols + '×' + cols); return; }
                if (global.AEToast) AEToast.error(AEI18n.t('拆分失败: ') + (e && e.message || e));
                return;
            }
            if (!_checkOutputReady()) return;
            var node = _graph.getNode(nid);
            var baseX = node ? node.x + 240 : 0;
            var baseY = node ? node.y : 0;
            try { await AEFS.mkdir(_gridTempDir()); } catch (_) {}
            var ts = new Date().getTime();
            // 两阶段——先把全部子图写盘，全部成功后才建节点。若在循环内
            // 落盘失败直接 return，已建的前几个节点留在屏幕上，但 _store.markDirty()/
            // _pushHistory() 在循环之后 → 未持久化、不进撤销栈，重启/切画布后消失。
            var outPaths = [];
            for (var i = 0; i < blobs.length; i++) {
                var outPath = _gridTempDir() + '/gridcell_' + ts + '_' + i + '.png';
                try {
                    await _comfyController.writeBlobToFile(blobs[i], outPath);
                } catch (e) {
                    // 半截落盘**补偿清理**——已写出的 gridcell_*.png 此时没有任何节点
                    // 引用（节点循环在全部写盘成功后才跑），不删就只能等 mtime 超 24h 被
                    // _cleanGridTemp 回收。删除失败仍由该清理流程兜底（不阻塞错误回执）
                    for (var ci = 0; ci <= i; ci++) {
                        try { await AEFS.deleteFile(_gridTempDir() + '/gridcell_' + ts + '_' + ci + '.png'); } catch (_) {}
                    }
                    if (global.AEToast) AEToast.error(AEI18n.t('拆分落盘失败: ') + (e && e.message || e));
                    return;   // 未建任何节点：画布/历史/磁盘三方一致（本次已落盘文件已就地回收）
                }
                outPaths.push(outPath);
            }
            for (var j = 0; j < outPaths.length; j++) {
                var col = j % cols, row = Math.floor(j / cols);
                var cid = _graph.addNode('imageInput', { x: baseX + col * 260, y: baseY + row * 260 });
                var cn = _graph.getNode(cid);
                if (cn) cn.params = { path: outPaths[j] };
                _renderNode(cid);
            }
            if (_store) _store.markDirty();
            if (_ctrl && _ctrl.redrawEdges) _ctrl.redrawEdges();
            if (_minimapUpdate) _minimapUpdate();
            _pushHistory();
            if (global.AEToast) AEToast.success(AEI18n.t('已拆分成 ') + cols + '×' + cols + AEI18n.t(' 个图片输入节点'));
        }

        // ============ 分组 ============

        function _findGroupContaining(nodeId) {
            for (var i = 0; i < _groups.length; i++) {
                if (_groups[i].childIds.indexOf(nodeId) >= 0) return _groups[i];
            }
            return null;
        }

        // 检查 ancestorId 是否是 descendantId 的祖先（往上追父分组链）
        function _groupIsAncestor(ancestorId, descendantId) {
            var visited = {};
            var queue = [descendantId];
            while (queue.length) {
                var cur = queue.shift();
                if (cur === ancestorId) return true;
                if (visited[cur]) continue;
                visited[cur] = true;
                for (var i = 0; i < _groups.length; i++) {
                    var cgIds = _groups[i].childGroupIds || [];
                    if (cgIds.indexOf(cur) >= 0) queue.push(_groups[i].id);
                }
            }
            return false;
        }

        function _findGroupContainingGroup(groupId) {
            for (var i = 0; i < _groups.length; i++) {
                if ((_groups[i].childGroupIds || []).indexOf(groupId) >= 0) return _groups[i];
            }
            return null;
        }

        // 仅移动分组的子节点/子分组，不动分组框本身（供多选拖拽用）
        // dx/dy 为【增量】位移（调用方逐帧传增量）：内部 += 累加，传手势总位移会二次函数漂移
        // _skipIds: 已在 dragItems 中的分组/节点 ID 集合（这些由拖拽主循环绝对定位，跳过避免二次移动）
        function _moveGroupChildren(grp, dx, dy, _skipIds, _visited) {
            _skipIds = _skipIds || {};
            _visited = _visited || {};
            if (_visited[grp.id]) return;
            _visited[grp.id] = true;
            var ids = grp.childIds || [];
            for (var i = 0; i < ids.length; i++) {
                if (_skipIds[ids[i]]) continue;   // 节点本身也被选中（在 dragItems 中），跳过
                var cn = _graph.getNode(ids[i]);
                if (!cn) continue;
                cn.x += dx; cn.y += dy;
                var cel = _worldEl.querySelector('[data-node-id="' + ids[i] + '"]');
                if (cel) { cel.style.left = cn.x + 'px'; cel.style.top = cn.y + 'px'; }
            }
            var cgIds = grp.childGroupIds || [];
            for (var j = 0; j < cgIds.length; j++) {
                if (_skipIds[cgIds[j]]) continue;
                var cg = null;
                for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === cgIds[j]) { cg = _groups[gx]; break; } }
                if (!cg) continue;
                cg.x += dx; cg.y += dy;
                var cgEl = _groupRenderer && _groupRenderer.getEl(cgIds[j]);
                if (cgEl) { cgEl.style.left = cg.x + 'px'; cgEl.style.top = cg.y + 'px'; }
                _moveGroupChildren(cg, dx, dy, _skipIds, _visited);
            }
        }

        function _collectAllChildIds(group, _visited) {
            _visited = _visited || {};
            if (_visited[group.id]) return [];
            _visited[group.id] = true;
            var ids = (group.childIds || []).slice();
            var subIds = group.childGroupIds || [];
            for (var i = 0; i < subIds.length; i++) {
                var sg = null;
                for (var g = 0; g < _groups.length; g++) { if (_groups[g].id === subIds[i]) { sg = _groups[g]; break; } }
                if (sg) ids = ids.concat(_collectAllChildIds(sg, _visited));
            }
            return ids;
        }

        // 节点布局尺寸（分组判定/包围盒用）：gen 节点存 _layoutWidth/_layoutHeight，
        // 其 params.width/height 是模板分辨率参数（如 1024），误用会让分组框按分辨率算
        function _nodeLayoutW(n) {
            if (!n || !n.params) return 200;
            if (n.type === 'imageGen' || n.type === 'videoGen') return n.params._layoutWidth || 200;
            return n.params.width || 200;
        }
        function _nodeLayoutH(n) {
            if (!n || !n.params) return 100;
            if (n.type === 'imageGen' || n.type === 'videoGen') return n.params._layoutHeight || 100;
            return n.params.height || 100;
        }

        function _isInsideGroup(nodeId, group) {
            var n = _graph.getNode(nodeId);
            if (n) {
                // 节点：中心点判断
                var nw = _nodeLayoutW(n);
                var nh = _nodeLayoutH(n);
                var cx = n.x + nw / 2, cy = n.y + nh / 2;
                return cx >= group.x && cx <= group.x + group.w && cy >= group.y && cy <= group.y + group.h;
            }
            // 分组：四条边都在目标内才算容纳
            var grp = null;
            for (var g = 0; g < _groups.length; g++) { if (_groups[g].id === nodeId) { grp = _groups[g]; break; } }
            if (!grp) return false;
            return grp.x >= group.x && grp.x + grp.w <= group.x + group.w &&
                   grp.y >= group.y && grp.y + grp.h <= group.y + group.h;
        }

        function _renderGroup(group) {
            if (_groupRenderer) _groupRenderer.render(group);
            // 把子孙分组 DOM 全部挪到本分组后面
            _liftChildrenAbove(group);
        }

        function _liftChildrenAbove(grp, _visited) {
            _visited = _visited || {};
            if (_visited[grp.id]) return;
            _visited[grp.id] = true;
            var parentEl = _groupRenderer && _groupRenderer.getEl(grp.id);
            if (!parentEl || !parentEl.parentNode) return;
            var subIds = grp.childGroupIds || [];
            for (var i = 0; i < subIds.length; i++) {
                if (_visited[subIds[i]]) continue;
                var subEl = _groupRenderer && _groupRenderer.getEl(subIds[i]);
                if (subEl && subEl.parentNode) {
                    parentEl.parentNode.insertBefore(subEl, parentEl.nextSibling);
                    var sub = null;
                    for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === subIds[i]) { sub = _groups[gx]; break; } }
                    if (sub) _liftChildrenAbove(sub, _visited);
                }
            }
        }

        // 递归将所有子孙分组的 DOM 提到 _worldEl 末尾
        function _liftChildGroupDOM(grp, _visited) {
            _visited = _visited || {};
            var subIds = grp.childGroupIds || [];
            for (var i = 0; i < subIds.length; i++) {
                if (_visited[subIds[i]]) continue;
                _visited[subIds[i]] = true;
                var sub = null;
                for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === subIds[i]) { sub = _groups[gx]; break; } }
                if (sub) {
                    var subEl = _groupRenderer && _groupRenderer.getEl(subIds[i]);
                    if (subEl && subEl.parentNode) subEl.parentNode.appendChild(subEl);
                    _liftChildGroupDOM(sub, _visited);
                }
            }
        }

        function _renderAllGroups() {
            for (var i = 0; i < _groups.length; i++) {
                if (_groupRenderer) _groupRenderer.render(_groups[i]);
            }
            // 把所有子孙分组提到父分组上方
            for (var pi = 0; pi < _groups.length; pi++) {
                _liftChildrenAbove(_groups[pi]);
            }
        }

        function _onGroupCreate(wx, wy) {
            var selKeys = Object.keys(_selectedNodes);
            // 分离节点 ID 和分组 ID
            var ids = [];
            var childGroupIds = [];
            for (var sk = 0; sk < selKeys.length; sk++) {
                if (selKeys[sk].indexOf('g_') === 0) childGroupIds.push(selKeys[sk]);
                else ids.push(selKeys[sk]);
            }
            if (ids.length >= 1 || childGroupIds.length > 0) {
                // 选中节点 → 套入分组
                var movedFrom = 0;
                // 先收集移出的子分组所包含的所有节点 ID
                var removeFromChildIds = {};
                for (var cg = 0; cg < childGroupIds.length; cg++) {
                    var cgObj = null;
                    for (var cx = 0; cx < _groups.length; cx++) { if (_groups[cx].id === childGroupIds[cg]) { cgObj = _groups[cx]; break; } }
                    if (cgObj) { var cids = _collectAllChildIds(cgObj); for (var ci = 0; ci < cids.length; ci++) removeFromChildIds[cids[ci]] = true; }
                }
                for (var g = 0; g < _groups.length; g++) {
                    var before = _groups[g].childIds.length;
                    _groups[g].childIds = _groups[g].childIds.filter(function (cid) { return ids.indexOf(cid) < 0 && !removeFromChildIds[cid]; });
                    // 从其他分组中移出子分组
                    _groups[g].childGroupIds = (_groups[g].childGroupIds || []).filter(function (gid) { return childGroupIds.indexOf(gid) < 0; });
                    if (_groups[g].childIds.length < before) movedFrom++;
                }
                var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (var i = 0; i < ids.length; i++) {
                    var n = _graph.getNode(ids[i]);
                    if (!n) continue;
                    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
                    maxX = Math.max(maxX, n.x + _nodeLayoutW(n));
                    maxY = Math.max(maxY, n.y + _nodeLayoutH(n));
                }
                // 含子分组时扩展包围盒
                for (var cg = 0; cg < childGroupIds.length; cg++) {
                    for (var gk = 0; gk < _groups.length; gk++) {
                        if (_groups[gk].id === childGroupIds[cg]) {
                            minX = Math.min(minX, _groups[gk].x); minY = Math.min(minY, _groups[gk].y);
                            maxX = Math.max(maxX, _groups[gk].x + _groups[gk].w);
                            maxY = Math.max(maxY, _groups[gk].y + _groups[gk].h);
                        }
                    }
                }
                if (!isFinite(minX)) minX = wx || 100;
                if (!isFinite(minY)) minY = wy || 100;
                var group = {
                    id: 'g_' + Date.now(),
                    title: AEI18n.t('分组'),
                    x: minX - 32, y: minY - 42,
                    w: Math.max(160, maxX - minX + 64),
                    h: Math.max(100, maxY - minY + 70),
                    color: '', note: '',
                    childIds: ids.slice(),
                    childGroupIds: childGroupIds.slice()
                };
                _groups.push(group);
                // 先渲染父分组，再渲染子分组以保证子在上层
                _renderGroup(group);
                _store && _store.markDirty();
                var total = ids.length + childGroupIds.length;
                var msg = movedFrom > 0
                    ? AEI18n.t('已创建分组（{total} 项，从 {moved} 个旧分组中移出）', { total: total, moved: movedFrom })
                    : AEI18n.t('已创建分组（{total} 项）', { total: total });
                if (global.AEToast) AEToast.success(msg);
            } else {
                // 无选中 / 单节点 → 在右键位置创建空分组
                var x = (wx != null) ? wx : 100;
                var y = (wy != null) ? wy : 100;
                var group = {
                    id: 'g_' + Date.now(),
                    title: AEI18n.t('分组'),
                    x: x, y: y, w: 300, h: 200,
                    color: '', note: '',
                    childIds: [], childGroupIds: []
                };
                _groups.push(group);
                _renderGroup(group);
                _store && _store.markDirty();
                if (global.AEToast) AEToast.success(AEI18n.t('已创建空分组'));
            }
            _deselectAll();
            if (_minimapUpdate) _minimapUpdate();
            _pushHistory();   // 结构操作：立即推历史（创建分组）
        }

        function _onGroupRename(group) {
            var el = _groupRenderer && _groupRenderer.getEl(group.id);
            if (el) {
                var titleSpan = el.querySelector('.ng-group-title');
                if (titleSpan) titleSpan.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            }
        }

        function _onGroupColor(group) {
            // 颜色选择器由 canvasController 直接弹出，此处不处理
        }

        function _onGroupNote(group) {
            var el = _groupRenderer && _groupRenderer.getEl(group.id);
            if (el) {
                var noteEl = el.querySelector('.ng-group-note');
                if (noteEl) noteEl.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
            }
        }

        function _onGroupUngroup(group) {
            // 收集本分组的子节点和子分组，解散后上浮到祖先分组
            var childNodeIds = _collectAllChildIds(group);
            var childGroupIds = group.childGroupIds || [];
            // 找直接父分组
            var parent = _findGroupContainingGroup(group.id);
            // 从所有分组中移除此分组的引用
            for (var i = 0; i < _groups.length; i++) {
                _groups[i].childGroupIds = (_groups[i].childGroupIds || []).filter(function (gid) { return gid !== group.id; });
            }
            _groupRenderer && _groupRenderer.remove(group.id);
            _groups = _groups.filter(function (g) { return g.id !== group.id; });
            // 子节点和子分组上浮到父分组
            if (parent) {
                for (var ci = 0; ci < childNodeIds.length; ci++) {
                    if (parent.childIds.indexOf(childNodeIds[ci]) < 0) parent.childIds.push(childNodeIds[ci]);
                }
                for (var cgi = 0; cgi < childGroupIds.length; cgi++) {
                    if ((parent.childGroupIds || []).indexOf(childGroupIds[cgi]) < 0) {
                        parent.childGroupIds = parent.childGroupIds || [];
                        parent.childGroupIds.push(childGroupIds[cgi]);
                    }
                }
                _renderGroup(parent);
            }
            _store && _store.setGroupsRef(_groups);
            delete _selectedNodes[group.id];
            _refreshEdgeSelection();
            _store && _store.markDirty();
            if (_minimapUpdate) _minimapUpdate();
            if (global.AEToast) AEToast.success(AEI18n.t('已解散分组'));
            _pushHistory();   // 结构操作：立即推历史（解散分组）
        }

        // 分组 resize 后扫描所有节点和子分组是否进入了该分组
        function _checkAllMembership(gid) {
            var grp = null;
            for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === gid) { grp = _groups[gx]; break; } }
            if (!grp) return;
            // 先检查所有子分组（归属确定后再处理节点）
            for (var gi = 0; gi < _groups.length; gi++) {
                if (_groups[gi].id === gid) continue;
                var cgid = _groups[gi].id;
                var curP = _findGroupContainingGroup(cgid);
                if (curP && curP.id === gid) continue;
                if (_isInsideGroup(cgid, grp) && !_groupIsAncestor(cgid, gid)) {
                    if (curP) { curP.childGroupIds = (curP.childGroupIds || []).filter(function (c) { return c !== cgid; }); }
                    grp.childGroupIds = grp.childGroupIds || [];
                    grp.childGroupIds.push(cgid);
                    var ocids = _collectAllChildIds(_groups[gi]);
                    grp.childIds = grp.childIds.filter(function (c) { return ocids.indexOf(c) < 0; });
                } else if (curP && curP.id === gid) {
                    grp.childGroupIds = (grp.childGroupIds || []).filter(function (c) { return c !== cgid; });
                    var ocids = _collectAllChildIds(_groups[gi]);
                    for (var oi = 0; oi < ocids.length; oi++) {
                        if (_isInsideGroup(ocids[oi], grp) && grp.childIds.indexOf(ocids[oi]) < 0) {
                            grp.childIds.push(ocids[oi]);
                        }
                    }
                }
            }
            // 再检查所有节点（跳过已属于子分组的节点）
            var childGrpNodeIds = {};
            for (var cgi = 0; cgi < (grp.childGroupIds || []).length; cgi++) {
                var cg = null;
                for (var cx = 0; cx < _groups.length; cx++) { if (_groups[cx].id === grp.childGroupIds[cgi]) { cg = _groups[cx]; break; } }
                if (cg) { var cids = _collectAllChildIds(cg); for (var cii = 0; cii < cids.length; cii++) childGrpNodeIds[cids[cii]] = true; }
            }
            var allNodes = _graph.nodes();
            for (var ni = 0; ni < allNodes.length; ni++) {
                var nid = allNodes[ni].id;
                if (childGrpNodeIds[nid]) continue;
                var cur = _findGroupContaining(nid);
                if (cur && cur.id === gid) continue;
                if (_isInsideGroup(nid, grp)) {
                    if (cur) { cur.childIds = cur.childIds.filter(function (c) { return c !== nid; }); }
                    grp.childIds.push(nid);
                } else if (cur && cur.id === gid) {
                    grp.childIds = grp.childIds.filter(function (c) { return c !== nid; });
                }
            }
            _renderGroup(grp);
            _store && _store.markDirty();
        }

        function _checkNodeGroupMembership(nodeId) {
            var isNode = !!_graph.getNode(nodeId);
            // 离开旧组
            var curGroup = isNode ? _findGroupContaining(nodeId) : _findGroupContainingGroup(nodeId);
            if (curGroup && !_isInsideGroup(nodeId, curGroup)) {
                if (isNode) {
                    curGroup.childIds = curGroup.childIds.filter(function (cid) { return cid !== nodeId; });
                } else {
                    curGroup.childGroupIds = (curGroup.childGroupIds || []).filter(function (gid) { return gid !== nodeId; });
                    // 子分组拖出时，连带移除其所有子节点
                    var outGroup = null;
                    for (var gx = 0; gx < _groups.length; gx++) { if (_groups[gx].id === nodeId) { outGroup = _groups[gx]; break; } }
                    if (outGroup) {
                        var allChildIds = _collectAllChildIds(outGroup);
                        curGroup.childIds = curGroup.childIds.filter(function (cid) { return allChildIds.indexOf(cid) < 0; });
                    }
                }
                _renderGroup(curGroup);
                _store && _store.markDirty();
            }
            // 进入新组（拖动的项是否落入其他组）
            for (var i = 0; i < _groups.length; i++) {
                var g = _groups[i];
                if (g.id === nodeId || g === curGroup) continue;
                if (_isInsideGroup(nodeId, g)) {
                    if (isNode) {
                        if (g.childIds.indexOf(nodeId) < 0) g.childIds.push(nodeId);
                    } else {
                        g.childGroupIds = g.childGroupIds || [];
                        if (g.childGroupIds.indexOf(nodeId) < 0) g.childGroupIds.push(nodeId);
                    }
                    _renderGroup(g);
                    _store && _store.markDirty();
                    break;
                }
            }
            // 如果是分组拖拽，检查是否有其他分组/节点落入了本分组
            if (!isNode) {
                var thisGrp = null;
                for (var gx2 = 0; gx2 < _groups.length; gx2++) { if (_groups[gx2].id === nodeId) { thisGrp = _groups[gx2]; break; } }
                if (thisGrp) {
                    // 先检查其他分组（子分组归属先确定，后续节点检查才能正确跳过子分组内的节点）
                    for (var gi2 = 0; gi2 < _groups.length; gi2++) {
                        var og = _groups[gi2];
                        if (og.id === nodeId) continue;
                        if ((thisGrp.childGroupIds || []).indexOf(og.id) >= 0) continue;
                        var existParent = _findGroupContainingGroup(og.id);
                        if (existParent && existParent.id === nodeId) continue;
                        if (_isInsideGroup(og.id, thisGrp) && !_groupIsAncestor(og.id, nodeId)) {
                            if (existParent) existParent.childGroupIds = (existParent.childGroupIds || []).filter(function (cg) { return cg !== og.id; });
                            thisGrp.childGroupIds = thisGrp.childGroupIds || [];
                            thisGrp.childGroupIds.push(og.id);
                            // 子分组的节点从本分组的 childIds 移除（通过嵌套管理）
                            var ocids = _collectAllChildIds(og);
                            thisGrp.childIds = thisGrp.childIds.filter(function (c) { return ocids.indexOf(c) < 0; });
                        }
                    }
                    // 再检查节点（跳过已属于本分组子分组的节点）
                    var childGrpNodeIds = {};
                    for (var cgi = 0; cgi < (thisGrp.childGroupIds || []).length; cgi++) {
                        var cg = null;
                        for (var cx = 0; cx < _groups.length; cx++) { if (_groups[cx].id === thisGrp.childGroupIds[cgi]) { cg = _groups[cx]; break; } }
                        if (cg) { var cids = _collectAllChildIds(cg); for (var cii = 0; cii < cids.length; cii++) childGrpNodeIds[cids[cii]] = true; }
                    }
                    var allNodes = _graph.nodes();
                    for (var ni = 0; ni < allNodes.length; ni++) {
                        var nid = allNodes[ni].id;
                        if (thisGrp.childIds.indexOf(nid) >= 0) continue;
                        if (childGrpNodeIds[nid]) continue;
                        var existGrp = _findGroupContaining(nid);
                        if (existGrp && existGrp.id === nodeId) continue;
                        if (_isInsideGroup(nid, thisGrp)) {
                            if (existGrp) existGrp.childIds = existGrp.childIds.filter(function (c) { return c !== nid; });
                            thisGrp.childIds.push(nid);
                        }
                    }
                    _renderGroup(thisGrp);
                    _store && _store.markDirty();
                }
            }
        }

        // 开全屏图片编辑器（imageEdit 节点点"编辑"按钮 → onEdit 回调 → 此处）
        function _openImageEditor(nodeId) {
            if (!_checkOutputReady()) return;
            if (!global.AEComfyUI.createImageEditor) return;
            if (!_comfyController) { if (global.AEToast) AEToast.warn(AEI18n.t('AE IO 未就绪')); return; }
            var node = _graph.getNode(nodeId);
            if (!node) return;
            var imagePath = (node.params && node.params.editedPath) || _resolveUpstreamImage(nodeId);
            if (!imagePath) { if (global.AEToast) AEToast.warn(AEI18n.t('无上游图可编辑（先接 image 输入并生成）')); return; }
            // 已开编辑器先关
            if (_activeEditor && _activeEditor.forceClose) _activeEditor.forceClose();
            _activeEditor = global.AEComfyUI.createImageEditor({
                imagePath: imagePath,
                outputDir: _outputDir,
                aeIO: _comfyController,
                node: node,
                onSave: function (outPath) {
                    var n = _graph.getNode(nodeId);
                    if (!n) return;
                    n.params = n.params || {};
                    n.params.editedPath = outPath;
                    _renderNode(nodeId, { appear: false });
                    _invalidateCache(nodeId);
                    if (_store) _store.markDirty();
                    if (global.AEToast) AEToast.success(AEI18n.t('已保存编辑结果'));
                },
                // imageEditor 读上游图失败时携带 reason 关闭（toast 由编辑器侧给，
                // 此处仅归因记录，避免重复提示）
                onClose: function (reason) {
                    _activeEditor = null;
                    if (reason === 'LOAD_FAILED') console.warn('[ComfyUI Canvas] 图片编辑器因读图失败关闭: ' + imagePath);
                }
            });
        }

        // ============ 生成执行 ============

        // 更新 gen 节点的 .ng-result-preview 内容（生成中/错误/结果）
        function _updateGenResultPreview(nodeId, html) {
            var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
            if (!el) return;
            var preview = el.querySelector('.ng-result-preview');
            if (!preview) return;
            preview.innerHTML = html;
        }

        // gen 节点自身预览区设"生成中…"占位（含进度条）
        function showPreviewGenerating(nodeId) {
            if (nodeId) {
                var genNode = _graph.getNode(nodeId);
                if (genNode && (genNode.type === 'imageGen' || genNode.type === 'videoGen')) {
                    var isGenerating = _isNodeGenerating(nodeId);
                    var batchN = parseInt((genNode.params && genNode.params.batch_size)) || 1;
                    if (!isGenerating) {
                        genNode.params._result = null;
                        genNode.params._placeholders = null;
                        genNode.params._frameHTMLs = null;
                        genNode.params._multiImgs = null;
                        genNode.params._multiCurIdx = null;
                    }
                    // 批次模式（batchN > 1）的占位帧由 session.initBatch 创建，此处不重复渲染
                    if (batchN <= 1) {
                        _updateGenResultPreview(nodeId,
                            '<div class="ng-preview-progress">' +
                                '<div class="comfyui-progress-text">' + AEI18n.t('计算中…') + '</div>' +
                                '<div class="comfyui-executing-node"></div>' +
                                '<div class="comfyui-progress-container">' +
                                    '<div class="comfyui-progress-bar" style="width:0%"></div>' +
                                '</div>' +
                                _genCancelBtnHTML() +   // 生成中节点的取消入口
                            '</div>');
                    }
                }
            }
        }

        function _isNodeGenerating(nodeId) {
            // 按当前画布复合键判定：其他画布同 id 节点在跑不拦截本画布的生成
            var cf = _curCanvasFile();
            var keys = Object.keys(_generatingNodeMap);
            for (var i = 0; i < keys.length; i++) {
                var v = _generatingNodeMap[keys[i]];
                if (v && v.nodeId === nodeId && v.canvasFile === cf) return true;
            }
            return false;
        }

        // 单帧占位符 HTML；isWaiting=true 时显示"等待中"（无进度条和转圈）
        function _phFrameHTML(pct, nodeName, isWaiting) {
            if (isWaiting) {
                return '<div class="ng-batch-placeholder ng-batch-waiting">' +
                    '<div class="comfyui-progress-text">' + AEI18n.t('等待中…') + '</div>' +
                '</div>';
            }
            return '<div class="ng-batch-placeholder">' +
                '<div class="ng-batch-ph-spinner"></div>' +
                '<div class="comfyui-progress-text">' + AEI18n.t('计算中…') + '</div>' +
                (nodeName ? '<div class="comfyui-executing-node">' + _escapeAttr(nodeName) + '</div>' : '') +
                '<div class="ng-batch-ph-progress">' +
                    '<div class="ng-batch-ph-bar" style="width:' + _escapeAttr(pct || '0%') + '"></div>' +
                '</div>' +
                _genCancelBtnHTML() +   // 批量生成中当前帧的取消入口
            '</div>';
        }

        // 实图帧 HTML（视频路径产 <video>：<img> 渲染 mp4 是破图，videoGen 批量帧会用到）
        function _imgFrameHTML(path) {
            var fname = _escapeAttr(String(path).split('/').pop().split('\\').pop());
            var ext = (String(path).split('.').pop() || '').toLowerCase();
            if (/^(mp4|mov|webm|avi|mkv|m4v|mpg|mpeg|wmv|flv)$/.test(ext)) {
                var vurl = _escapeAttr(_toFileUrl(path));
                return '<video class="ng-result-thumb ng-result-thumb-video" src="' + vurl + '" muted preload="metadata" ' +
                    'data-clean-url="' + vurl + '"></video>';
            }
            var url = _escapeAttr(_cacheBustUrl(path));
            var cleanUrl = _escapeAttr(_toFileUrl(path));
            return '<img class="ng-result-thumb" src="' + url + '" alt="' + fname + '" draggable="false" ' +
                AEI18n.html('onerror="this.parentElement.innerHTML=\'<div class=\\\'ng-preview-error\\\'>预览加载失败</div>\'" ') +
                'data-clean-url="' + cleanUrl + '" />';
        }

        // 从 _placeholders / _result 重建帧 HTML 缓存。
        // _frameHTMLs 内含绝对 file:// URL，不落盘（见 nodegenStore.serializeForSave）；
        // 加载后按与 initBatch/_fillBatchFrame 相同的索引对齐（frames[ph.idx]）重建。
        function _rebuildFrameHTMLs(node) {
            var p = (node && node.params) || {};
            var phs = p._placeholders;
            var frames = [];
            var i;
            if (phs && phs.length) {
                for (i = 0; i < phs.length; i++) {
                    var ph = phs[i];
                    if (!ph) continue;
                    var idx = (typeof ph.idx === 'number') ? ph.idx : i;
                    frames[idx] = ph.path ? _imgFrameHTML(ph.path) : _phFrameHTML(ph.pct, ph.nodeName, false);
                }
                // 补洞（占位符 idx 不连续时）——避免 _renderBatchFrameAt 把 undefined 渲染进 innerHTML
                for (i = 0; i < frames.length; i++) {
                    if (!frames[i]) frames[i] = _phFrameHTML('0%', '', false);
                }
                return frames;
            }
            var res = p._result;
            var imgs = (res && res.images) || (res && res.image ? [res.image] : []);
            if (imgs && imgs.length) {
                for (i = 0; i < imgs.length; i++) frames[i] = _imgFrameHTML(imgs[i]);
                return frames;
            }
            return null;
        }

        // 翻到第 idx 帧并渲染
        function _renderBatchFrameAt(nodeId, idx) {
            var node = _graph.getNode(nodeId);
            if (!node || !node.params || !node.params._frameHTMLs) return;
            var frames = node.params._frameHTMLs;
            var total = frames.length;
            if (idx < 0) idx = total - 1;
            if (idx >= total) idx = 0;
            node.params._batchCurIdx = idx;
            var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
            var preview = el && el.querySelector('.ng-result-preview');
            if (!preview) return;
            var navHtml = total > 1 ?
                '<div class="ng-result-nav">' +
                    '<button class="ng-result-prev" title="' + AEI18n.t('上一张') + '">‹</button>' +
                    '<span class="ng-result-count">' + (idx + 1) + '/' + total + '</span>' +
                    '<button class="ng-result-next" title="' + AEI18n.t('下一张') + '">›</button>' +
                '</div>' : '';
            preview.innerHTML = navHtml + frames[idx];
            // 绑定事件
            if (total > 1) {
                var prevBtn = preview.querySelector('.ng-result-prev');
                var nextBtn = preview.querySelector('.ng-result-next');
                if (prevBtn) prevBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    try {
                        var n = _graph.getNode(nodeId);
                        _renderBatchFrameAt(nodeId, ((n && n.params && n.params._batchCurIdx) || 0) - 1);
                    } catch (err) { console.error('[ComfyUI Canvas] batchPrev 点击异常:', nodeId, err); }
                });
                if (nextBtn) nextBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    try {
                        var n = _graph.getNode(nodeId);
                        _renderBatchFrameAt(nodeId, ((n && n.params && n.params._batchCurIdx) || 0) + 1);
                    } catch (err) { console.error('[ComfyUI Canvas] batchNext 点击异常:', nodeId, err); }
                });
            }
            // 点击图片放大
            var img = preview.querySelector('img');
            if (img) {
                img.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var cu = img.getAttribute('data-clean-url');
                    if (cu && global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(cu);
                });
            }
        }

        // 多图结果翻页（非批量 batch_size>1 路径）：状态存 node.params，与批量轮播统一
        function _renderMultiImgAt(nodeId, idx) {
            var node = _graph.getNode(nodeId);
            if (!node || !node.params || !node.params._multiImgs) return;
            var imgPaths = node.params._multiImgs;
            var total = imgPaths.length;
            if (idx < 0) idx = total - 1;
            if (idx >= total) idx = 0;
            node.params._multiCurIdx = idx;
            var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
            var genPreview = el && el.querySelector('.ng-result-preview');
            if (!genPreview) return;
            var path = imgPaths[idx];
            var fname = _escapeAttr(path.split('/').pop());
            var url = _escapeAttr(_cacheBustUrl(path));
            var cleanUrl = _toFileUrl(path);
            var navHtml = total > 1 ?
                '<div class="ng-result-nav">' +
                    '<button class="ng-result-prev" title="' + AEI18n.t('上一张') + '">‹</button>' +
                    '<span class="ng-result-count">' + (idx + 1) + '/' + total + '</span>' +
                    '<button class="ng-result-next" title="' + AEI18n.t('下一张') + '">›</button>' +
                '</div>' : '';
            genPreview.innerHTML =
                '<img class="ng-result-thumb" src="' + url + '" alt="' + fname + '" draggable="false" ' +
                AEI18n.html('onerror="this.parentElement.innerHTML=\'<div class=\\\'ng-preview-error\\\'>预览加载失败</div>\'" />') +
                navHtml;
            // 加载后自适应尺寸
            var fitTok = _nextFitToken(nodeId);
            var fitImg = genPreview.querySelector('img');
            if (fitImg) {
                var fit = function () { if (_fitTokens[nodeId] !== fitTok) return; _applyMediaFit(nodeId, fitImg.naturalWidth, fitImg.naturalHeight); };
                if (fitImg.complete && fitImg.naturalWidth) fit();
                else fitImg.addEventListener('load', fit);
                fitImg.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(cleanUrl);
                });
            }
            // 翻页按钮：从 node.params 读当前索引，与闭包脱钩避免竞态
            if (total > 1) {
                var prevBtn = genPreview.querySelector('.ng-result-prev');
                var nextBtn = genPreview.querySelector('.ng-result-next');
                if (prevBtn) prevBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var n = _graph.getNode(nodeId);
                    var cur = (n && n.params && n.params._multiCurIdx) || 0;
                    _renderMultiImgAt(nodeId, cur - 1);
                });
                if (nextBtn) nextBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    var n = _graph.getNode(nodeId);
                    var cur = (n && n.params && n.params._multiCurIdx) || 0;
                    _renderMultiImgAt(nodeId, cur + 1);
                });
            }
        }

        // onBatchIteration 回调 → 更新对应帧为实图
        function _fillBatchFrame(nodeId, batchIdx, paths) {
            var node = _graph.getNode(nodeId);
            if (!node || !node.params) return;
            var phs = node.params._placeholders;
            var frames = node.params._frameHTMLs;
            if (!phs || !frames) return;
            // 模型原生批量参数（如 gpt_image2 的 n）→ 单次迭代返回多张图，填充连续帧
            for (var pi = 0; pi < paths.length; pi++) {
                var frameIdx = batchIdx + pi;
                for (var i = 0; i < phs.length; i++) {
                    if (phs[i].idx === frameIdx) {
                        phs[i].path = paths[pi] || null;
                        phs[i].pct = '100%';
                        var path = paths[pi];
                        if (path && frames[frameIdx]) {
                            frames[frameIdx] = _imgFrameHTML(path);
                        }
                        break;
                    }
                }
            }
            // 渲染当前帧（如果在本次填充范围内）
            var curIdx = node.params._batchCurIdx;
            if (curIdx >= batchIdx && curIdx < batchIdx + paths.length) {
                _renderBatchFrameAt(nodeId, curIdx);
            }
        }

        // 更新占位符进度条（progress/executing 回调用）。增量更新 DOM 避免 CSS 动画重启。
        // pct 和 nodeName 分两次调用（onProgress/onExecuting），各自非空时才更新，避免互相覆盖
        function _updatePlaceholderProgress(nodeId, pct, nodeName) {
            var node = _graph.getNode(nodeId);
            if (!node || !node.params) return;
            var phs = node.params._placeholders;
            var frames = node.params._frameHTMLs;
            if (!phs || !frames) return;
            for (var i = 0; i < phs.length; i++) {
                if (!phs[i].path) {
                    if (pct) phs[i].pct = pct;
                    if (nodeName) phs[i].nodeName = nodeName;
                    if (frames[phs[i].idx]) {
                        // 更新帧 HTML 缓存（供后续 _renderBatchFrameAt 翻页时使用）
                        frames[phs[i].idx] = _phFrameHTML(phs[i].pct, phs[i].nodeName, false);
                        if (node.params._batchCurIdx === phs[i].idx) {
                            // 尝试增量更新 DOM（进度条已存在时），失败则完整渲染（等待中→生成中转换）
                            if (!_updateBatchFrameDOM(nodeId, phs[i].pct, phs[i].nodeName)) {
                                _renderBatchFrameAt(nodeId, phs[i].idx);
                            }
                        }
                    }
                    break; // 只更新第一个未完成的
                }
            }
        }

        // 增量更新当前显示的占位帧 DOM（不重建，避免 CSS spinner 动画重启）
        // 返回 true 表示成功增量更新，false 表示需要完整渲染
        function _updateBatchFrameDOM(nodeId, pct, nodeName) {
            var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
            var preview = el && el.querySelector('.ng-result-preview');
            if (!preview) return false;
            var bar = preview.querySelector('.ng-batch-ph-bar');
            // 当前 DOM 中无进度条（显示的是"等待中"或已是实图），需要完整渲染
            if (!bar) return false;
            bar.style.width = (pct || '0%');
            var text = preview.querySelector('.comfyui-progress-text');
            if (text) text.textContent = AEI18n.t('计算中…');
            var nodeEl = preview.querySelector('.comfyui-executing-node');
            if (nodeEl) nodeEl.textContent = nodeName || '';
            return true;
        }

        // 更新 gen 节点预览区进度条
        function updateGenProgress(nodeId, pctStr) {
            if (nodeId) {
                var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
                if (!el) return;
                var bar = el.querySelector('.comfyui-progress-bar');
                var text = el.querySelector('.comfyui-progress-text');
                if (bar) bar.style.width = pctStr;
                if (text) text.textContent = AEI18n.t('生成中… ') + pctStr;
            }
        }

        // 更新 gen 节点预览区当前执行节点名称
        function updateGenExecuting(nodeId, nodeName) {
            if (nodeId) {
                var el = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[nodeId];
                if (!el) return;
                var nt = el.querySelector('.comfyui-executing-node');
                if (nt) nt.textContent = nodeName || '';
            }
        }

        // gen 节点自身预览区显示错误
        function showPreviewError(nodeId, errMsg) {
            if (nodeId) {
                var genNode = _graph.getNode(nodeId);
                if (genNode && (genNode.type === 'imageGen' || genNode.type === 'videoGen')) {
                    _updateGenResultPreview(nodeId, '<div class="ng-preview-error">' + _escapeAttr(errMsg || '生成失败') + '</div>');
                }
            }
        }

        // 注册进度回调（_runGen 和队列处理共用）
        function _setupProgressCallback() {
            _comfyController.setCanvasProgressCallback({
                onProgress: function (pctStr, promptId) {
                    var entry = (promptId && _generatingNodeMap[promptId]) || null;
                    var nid = entry ? entry.nodeId : null;
                    if (!nid) return;
                    // 优先通过 session 路由（session 处理 attached/detached 两种情况）；
                    // 按提交时刻记录的画布查 session，跨画布同 id 不串线
                    var session = _genSessionMgr && _genSessionMgr.getSession(nid, entry.canvasFile);
                    if (session) { session.writeProgress(pctStr, ''); return; }
                    // 无 session（遗留路径）：直接更新 DOM
                    updateGenProgress(nid, pctStr);
                },
                onExecuting: function (nodeName, promptId) {
                    var entry = (promptId && _generatingNodeMap[promptId]) || null;
                    var nid = entry ? entry.nodeId : null;
                    if (!nid) return;
                    var session = _genSessionMgr && _genSessionMgr.getSession(nid, entry.canvasFile);
                    if (session) { session.writeProgress('', nodeName); return; }
                    updateGenExecuting(nid, nodeName);
                }
            });
        }

        // 检测模型原生批量参数（如 gpt_image2 的 n）：单次请求生成多张图
        // 返回每次迭代的图片数，无此参数则 1
        // batchParamKey 由 template-list.json 中模型定义声明，新增带批量参数的模型只需加字段，无需改代码
        function _getNPerIter(node) {
            if (!node || !node.params) return 1;
            var modelId = node.params.modelId;
            if (!modelId) return 1;
            var engine = _comfyController && _comfyController.getEngine ? _comfyController.getEngine() : null;
            if (!engine || !engine.getById) return 1;
            var model = engine.getById(modelId);
            if (!model || !model.batchParamKey) return 1;
            var n = parseInt(node.params[model.batchParamKey]);
            return n > 0 ? n : 1;
        }

        async function _runGen(nodeId, resumeOnly) {
            if (!_executor) { if (global.AEToast) AEToast.warn(AEI18n.t('执行器未就绪，请稍候')); return; }
            var node = _graph.getNode(nodeId);
            if (!node) return;

            var canvasFile = _store ? _store.getFile() : '__default__';
            var session = _genSessionMgr ? _genSessionMgr.getSession(nodeId, canvasFile) : null;
            var isGenerating = _isNodeGenerating(nodeId);
            // 令牌/在跑标记按 canvasFile+nodeId 复合键隔离：跨画布同 id 节点互不干扰
            var myKey = _genKey(canvasFile, nodeId);

            // 正在生成中 → 加入队列（resumeOnly 时不走此分支）
            // 注意：此处不递增 token，旧 _runGen 实例仍持有有效 token，主批次完成后继续处理队列
            // 守卫含 _runningNodes 同步标记：promptId 映射要等 HTTP 提交返回才写入，
            // 空窗内连点"生成"只凭 _isNodeGenerating 会穿透 → createSession 销毁在跑 session
            if (!resumeOnly && (isGenerating || _runningNodes[myKey])) {
                var qn = parseInt((node.params && node.params.batch_size)) || 1;
                var qNPerIter = _getNPerIter(node);
                if (session) {
                    // 主批次 batchN=1（无帧）时，追加前补建帧容纳已有结果
                    if (session.batch.frameHTMLs.length === 0 && session.results.images.length > 0) {
                        session.initBatch(0, session.results.images.length, false);
                        for (var k = 0; k < session.results.images.length; k++) {
                            session.writeBatch(k, [session.results.images[k]]);
                        }
                    }
                    // 帧基址随批次入队：FIFO 下先出队的批次帧在前段，
                    // 出队时现算 base 会让多个队列批次写同一批帧/落盘文件名互相覆盖
                    var qBase = session.batch.frameHTMLs.length;
                    // 主批次在途且尚未建帧（totalFrames==1 时 initBatch 被跳过）——
                    // 先补建主批次占位帧再定 qBase（队列帧偏移主批次 totalFrames）。
                    // 若 1x 在途追加 3x 时 qBase=0 与主批次 writeBatch(0) 同索引空间：
                    // 主批次结果帧被队列批次覆盖、队列占位帧又被主批次结果反向覆盖。
                    // finalResult 判空排除队列恢复场景（主批次已收尾，base 语义不变）
                    if (qBase === 0 && session.results.images.length === 0 && session.results.finalResult == null) {
                        session.initBatch(0, 1, false);
                        qBase = 1;
                    }
                    session.enqueue({ n: qn, base: qBase });
                    // 追加占位帧（session.initBatch append 模式，替代旧 _renderBatchCarousel append）
                    session.initBatch(qBase, qn * qNPerIter, true);
                }
                if (global.AEToast) AEToast.info(AEI18n.t('已加入生成队列 (') + qn + 'x)');
                return;
            }

            // resumeOnly 但旧实例仍在跑 → 队列归旧实例处理，不另起实例
            if (resumeOnly && _runningNodes[myKey]) return;

            // 仅在实际启动生成（或恢复队列）时递增 token，使旧实例失效
            var myToken = (_genTokens[myKey] = (_genTokens[myKey] || 0) + 1);  // 按复合键分离的令牌
            // 同步在跑标记改为「令牌所有权」（原引用计数）——取消时标记被
            // _cancelNodeGeneration 主动让位（删除）后，旧实例 finally 若按计数递减会误清
            // 新实例的标记（生成守卫穿透）；按令牌比对则只清自己的。
            _runningNodes[myKey] = myToken;
            // 本实例的取消判定——令牌被 _cancelNodeGeneration bump（或新实例
            // 接管）即失效。经 runNodeAsync → ctx.isCancelled 透传到 handler/runGenWorkflow，
            // 取消后迟到产物不落盘、不写会话。
            var _isCancelled = function () { return myToken !== _genTokens[myKey]; };

            try {

            // 创建或复用 session
            // skipMainBatch: session 有 finalResult 且有队列 → 队列被画布切换中断，仅恢复队列
            var skipMainBatch = resumeOnly || (session && session.status === 'running' && session.hasQueued() && session.results.finalResult);
            if (!session || !skipMainBatch) {
                session = _genSessionMgr.createSession(nodeId, canvasFile);
                session.attach(_createRenderFns());
                // 记录本次生成时的参数指纹（剔除会话簿记键），undo 恢复后节点参数
                // 与生成时不一致时，session reattach 不再把 finalResult 回填 executor
                // 缓存（防下游复用与已撤销参数不一致的缓存结果）
                if (session.markGenParams) session.markGenParams(node.params);
            } else if (!session.isAttached) {
                session.attach(_createRenderFns());
            }

            // ── 主批次 ──
            if (!skipMainBatch) {
                if (global.AEToast) AEToast.info(AEI18n.t('生成中…'));
                var batchN = parseInt((node.params && node.params.batch_size)) || 1;
                var nPerIter = _getNPerIter(node);  // 模型原生批量参数（如 gpt_image2 的 n）
                var totalFrames = batchN * nPerIter;
                // showPreviewGenerating 必须在 initBatch 之前，否则 initBatch 渲染会覆盖占位状态
                showPreviewGenerating(nodeId);
                if (totalFrames > 1) {
                    session.initBatch(0, totalFrames, false);
                }
                _setupProgressCallback();
                _executor.clearResult(nodeId);

                var _batchCallback = function (nid, batchIdx, iterPaths) {
                    if (nid !== nodeId) return;
                    session.writeBatch(batchIdx * nPerIter, iterPaths);
                };

                try {
                    // canvasFile 提交前快照传入（提交往返窗口内切画布时进度路由不错记画布）
                    // isCancelled 透传（取消后 runGenWorkflow 停止落盘）
                    var result = await _executor.runNodeAsync(nodeId, { onBatchIteration: _batchCallback, batchOffset: 0, canvasFile: canvasFile, isCancelled: _isCancelled });
                    // 已取消/被取代——迟到结果丢弃（不写 session/不标脏/不 toast，
                    // 本地「已取消生成」终态由 _cancelNodeGeneration 写入；见 session.writeError）
                    if (myToken !== _genTokens[myKey]) return;
                    if (result) {
                        session.writeResult(result);
                        // 副作用仅作用于当前画布，避免切画布后误刷新旧画布节点
                        if (session.canvasFile === (_store ? _store.getFile() : '__default__')) {
                            _refreshDownstreamThumbnails(nodeId);
                            if (_store) _store.markDirty();
                        }
                        if (global.AEToast) {
                            if (session.hasQueued()) AEToast.info(AEI18n.t('本批完成，继续生成队列'));
                            else AEToast.success(AEI18n.t('生成完成'));
                        }
                    } else {
                        // result undefined = 生成中改参数（clearResult 参数代次失效）被
                        // 写回防护拦截（画布切换路径走孤儿化，不产生 undefined）。
                        // 静默无终态反馈时：预览停留"计算中"且 toast 谎报"生成完成"误导用户
                        session.writeError(AEI18n.t('参数已变更，本次生成结果已丢弃，请重新生成'));
                        if (global.AEToast) AEToast.warn(AEI18n.t('参数已变更，本次生成结果已丢弃，请重新生成'));
                    }
                } catch (e) {
                    // 取消后的迟到错误静默丢弃——不覆盖本地「已取消生成」终态、
                    // 不弹「生成失败」误导 toast（令牌失配 = 已取消或被新实例取代）
                    if (myToken !== _genTokens[myKey]) {
                        console.warn('[ComfyUI Canvas] 已取消生成的迟到错误已丢弃:', e && e.message);
                    } else {
                        console.warn('[ComfyUI Canvas] 生成失败:', e && e.message);
                        if (global.AEToast) AEToast.error(AEI18n.t('生成失败: ') + (e && e.message ? e.message : AEI18n.t('未知错误')));
                        session.writeError(e && e.message ? e.message : '生成失败');
                    }
                } finally {
                    if (myToken === _genTokens[myKey]) _cleanupGenMapping(nodeId, canvasFile);
                    if (!session.hasQueued()) session.markDone();
                }
            }
            // ── 队列处理 ──
            // 仅最新 _runGen 实例处理队列；旧实例（token 不匹配）直接返回，队列由新实例接管
            var _queueRan = false;
            if (myToken !== _genTokens[myKey]) return;
            while (session.hasQueued()) {
                if (!_graph) break;
                // 画布已切换 → 停止处理队列，保留队列等切回来恢复
                if (session.canvasFile !== (_store ? _store.getFile() : '__default__')) break;
                // 仅最新 _runGen 实例处理队列；旧实例（token 不匹配）退出
                if (myToken !== _genTokens[myKey]) break;
                var pNode = _graph.getNode(nodeId);
                if (!pNode) break;   // 节点不存在（画布已切换），保留队列等切回来恢复
                _queueRan = true;
                var pending = session.dequeue();
                // 队列项为 { n, base }（enqueue 时记录的帧基址）；兼容旧数值项
                var pendingN = (pending && typeof pending === 'object') ? pending.n : pending;
                var qNPerIter2 = _getNPerIter(pNode);
                var totalQueuedFrames = pendingN * qNPerIter2;
                // enqueue 的 initBatch 已创建 totalQueuedFrames 个占位帧，此处不再重复创建
                // newBase 用入队时记录的基址（FIFO 下先出队的帧在前段，现算末段会错位）
                var newBase = (pending && typeof pending === 'object' && typeof pending.base === 'number')
                    ? pending.base
                    : (session.batch.frameHTMLs.length - totalQueuedFrames);
                session.batch.batchBase = newBase;

                // 临时设 batch_size 供 runGenWorkflow 读取，用完恢复避免持久化污染
                var savedBatchSize = pNode.params.batch_size;
                pNode.params.batch_size = pendingN;
                session._savedBatchSize = savedBatchSize;  // 供 flush 前恢复（切画布时 _store.flush 在 finally 之前执行）
                _setupProgressCallback();
                _executor.clearResult(nodeId);
                // 不再 setResult 恢复已有图片——setResult 会让 runNodeAsync 内部 isReady() 返回 true，
                // 导致该节点被跳过、根本不发送给 ComfyUI。已有 images 由 session.results 累积，writeResult 时合并。

                var _qBatchCallback = function (nid, batchIdx, iterPaths) {
                    if (nid !== nodeId) return;
                    session.writeBatch(newBase + batchIdx * qNPerIter2, iterPaths);
                };

                try {
                    // canvasFile 提交前快照传入（同主批次）
                    // isCancelled 透传（取消后停止落盘）
                    var result2 = await _executor.runNodeAsync(nodeId, { onBatchIteration: _qBatchCallback, batchOffset: newBase, canvasFile: canvasFile, isCancelled: _isCancelled });
                    // 已取消——迟到队列结果丢弃（不写 session/不标脏）
                    if (myToken !== _genTokens[myKey]) break;
                    if (result2) {
                        session.writeResult(result2);
                        // 副作用仅作用于当前画布
                        if (session.canvasFile === (_store ? _store.getFile() : '__default__')) {
                            _refreshDownstreamThumbnails(nodeId);
                            if (_store) _store.markDirty();
                        }
                    } else {
                        // 队列批次同款终态反馈——批间参数变更被写回防护拦截时不再静默
                        session.writeError(AEI18n.t('参数已变更，本批次生成结果已丢弃，请重新生成'));
                        if (global.AEToast) AEToast.warn(AEI18n.t('参数已变更，本批次生成结果已丢弃，请重新生成'));
                    }
                } catch (e2) {
                    // 取消后的迟到队列错误静默丢弃（不覆盖「已取消生成」终态）
                    if (myToken !== _genTokens[myKey]) break;
                    console.warn('[ComfyUI Canvas] 队列生成失败:', e2 && e2.message);
                    session.writeError(e2 && e2.message ? e2.message : '生成失败');
                    session.clearQueue();  // 队列失败时清空，避免无限重试
                    break;
                } finally {
                    // 恢复原始 batch_size（仅当前画布匹配时才操作，避免跨画布 nodeId 冲突）
                    if (session.canvasFile === (_store ? _store.getFile() : '__default__')) {
                        var rn = _graph && _graph.getNode(nodeId);
                        if (rn && rn.params) rn.params.batch_size = savedBatchSize;
                    }
                    session._savedBatchSize = null;
                    if (myToken === _genTokens[myKey]) _cleanupGenMapping(nodeId, canvasFile);
                }
            }
            // 仅在队列真正跑完且无错误时才提示"全部完成"
            if (_queueRan && global.AEToast && !session.hasQueued() && !session.results.error) AEToast.success(AEI18n.t('全部生成完成'));
            if (!session.hasQueued()) session.markDone();
            } finally {
                // 同步在跑标记按令牌所有权清理——取消时已由 _cancelNodeGeneration
                // 让位（删除）；旧实例 finally 只清自己的标记，不会误清新实例的（原引用计数
                // 递减会把取消后立刻重入的新实例标记一起清掉 → 生成守卫穿透）
                if (_runningNodes[myKey] === myToken) delete _runningNodes[myKey];
            }
        }

        // flush 前恢复当前画布活跃 session 对应节点的临时 batch_size 修改
        // 防止队列处理中临时修改的 batch_size 被 _store.flush 持久化到磁盘
        // 按当前画布文件过滤，避免跨画布 nodeId 冲突时误改其他画布节点的 batch_size
        function _restoreBatchSizesBeforeFlush() {
            if (!_genSessionMgr || !_graph) return;
            var canvasFile = _store ? _store.getFile() : '__default__';
            var sessions = _genSessionMgr.getActiveSessions(canvasFile);
            for (var i = 0; i < sessions.length; i++) {
                var s = sessions[i];
                if (s._savedBatchSize !== null && s._savedBatchSize !== undefined) {
                    var n = _graph.getNode(s.nodeId);
                    if (n && n.params) n.params.batch_size = s._savedBatchSize;
                }
            }
        }

        // 清除指定节点（限 canvasFile 所属画布，复合键口径）的 promptId 映射；无生成中节点时清进度回调
        function _cleanupGenMapping(nodeId, canvasFile) {
            var cf = canvasFile || '__default__';
            var promptIds = Object.keys(_generatingNodeMap);
            for (var pi = 0; pi < promptIds.length; pi++) {
                var v = _generatingNodeMap[promptIds[pi]];
                if (v && v.nodeId === nodeId && v.canvasFile === cf) {
                    delete _generatingNodeMap[promptIds[pi]];
                }
            }
            if (Object.keys(_generatingNodeMap).length === 0 && _comfyController) {
                _comfyController.setCanvasProgressCallback(null);
            }
        }

        // ── 画布生成取消────────────────────────────────────
        // 背景：画布 gen 节点生成中没有任何取消入口，只能等超时（图片 600s / 视频 1800s，
        // sharedUtils.runGenWorkflow 的 _genWaitMs）。本块复用表单进度卡既有的取消样式
        // （.comfyui-cancel-btn 的 btn btn-slice danger-btn）与调用语义（按 promptId
        // 精确取消，不用全局 currentPromptId，画布/表单并发时不打错对象），不新造组件。
        // 进度区 HTML 随批次帧/进度回调反复重建（_renderBatchFrameAt / _updateGenResultPreview），
        // 故按钮渲染在 HTML 模板里、点击经 _canvasEl 事件委托路由（逐个绑定会随重建丢失）。

        // 生成中进度区的取消按钮（只在生成中的进度区 HTML 里渲染，空闲节点不会出现）
        function _genCancelBtnHTML() {
            return '<button class="btn btn-slice danger-btn comfyui-cancel-btn ng-gen-cancel" title="' + AEI18n.t('取消该节点的生成') + '">' + AEI18n.t('取消') + '</button>';
        }

        // 该节点当前全部在途 promptId（复合键口径：只认当前画布，跨画布同 id 不误伤）
        function _nodePromptIds(nodeId) {
            var cf = _curCanvasFile();
            var ids = [];
            var keys = Object.keys(_generatingNodeMap);
            for (var i = 0; i < keys.length; i++) {
                var v = _generatingNodeMap[keys[i]];
                if (v && v.nodeId === nodeId && v.canvasFile === cf) ids.push(keys[i]);
            }
            return ids;
        }

        // 取消某节点当前生成：先 clearQueue(pid)（从队列移除，若在排队）再 interrupt(pid)
        // （若在运行）——与表单进度卡取消同序。UI 收尾走既有渲染路径：session.clearQueue
        // 丢弃尚未提交的后续批次，session.writeError → showPreviewError 立即收掉"计算中"
        // 进度区并清除取消入口（服务端中断事件的迟到回包经 _runGen 的 catch/finally 走
        // 同一条 writeError/清理路径）。本地收尾不等网络往返；网络回执另算：
        // 两步请求全 .catch 吞空后无条件 toast"已取消生成"——ComfyUI 老版本无该
        // API、超时或 5xx 时用户看到"已取消"，实际服务端仍在排队执行/扣费。现在收集
        // 全部请求结果，全部成功才给原 toast；部分/全部失败报失败数并给检查指引。
        function _cancelNodeGeneration(nodeId) {
            var ids = _nodePromptIds(nodeId);
            if (!ids.length) {
                if (global.AEToast) AEToast.warn(AEI18n.t('该节点当前没有可取消的生成任务'));
                return;
            }
            var svc = (_comfyController && typeof _comfyController.getService === 'function')
                ? _comfyController.getService() : null;
            if (!svc) {
                // 服务实例缺失（未初始化/已销毁）时不虚报"已取消"
                if (global.AEToast) AEToast.warn(AEI18n.t('ComfyUI 服务未就绪，无法取消'));
                return;
            }
            // 注：HTTP 提交在途（promptId 尚未写进 _generatingNodeMap）的极短窗口内点取消会走到
            // 上面的"没有可取消的任务"分支——此窗内没有可靠的目标 id，不退回无参 interrupt
            //（那会打错到并发表单/其它节点的"最后一次提交"，与按 promptId 取消的语义冲突）。
            var calls = [];
            function _issue(method, pid) {
                if (typeof svc[method] !== 'function') return;
                try {
                    calls.push(Promise.resolve(svc[method](pid)).then(function () { return true; }, function () { return false; }));
                } catch (_) { calls.push(Promise.resolve(false)); }
            }
            for (var i = 0; i < ids.length; i++) {
                _issue('clearQueue', ids[i]);   // 先移出队列（若在排队）
                _issue('interrupt', ids[i]);    // 再中断运行（若在运行）
            }
            var cf = _curCanvasFile();
            // 本地终止在途 _runGen——只发服务端请求，等待 runGenWorkflow
            // 的旧实例仍会在迟到 done 时 session.writeResult/落盘/标脏并把「已取消」覆盖成
            // 「生成完成」（迟到 error 覆盖成「生成失败」）；_generatingNodeMap 不清还会让
            // 立刻再生成只得到「已加入生成队列」。三步收尾（沿用既有取消=错误终态语义）：
            // ① 令牌 bump：旧 _runGen 实例失效——其 await 结算后按令牌失配丢弃结果/错误
            //    （不写 session/不落盘/不标脏/不 toast，见 _runGen 各处检查）；
            // ② 在跑标记让位 + 清 promptId 映射：立刻可重新生成（不落队列）；
            // ③ 按既有 error 事件通道派发本地取消终态：runGenWorkflow 的在途等待立即
            //    结算并移除 listener（不等服务端迟到回包/超时）；_runGen catch 令牌失配
            //    静默丢弃，不会覆盖本函数写入的「已取消生成」。
            var myKey = _genKey(cf, nodeId);
            _genTokens[myKey] = (_genTokens[myKey] || 0) + 1;
            if (_runningNodes[myKey] !== undefined) delete _runningNodes[myKey];
            _cleanupGenMapping(nodeId, cf);
            for (var ci = 0; ci < ids.length; ci++) {
                try {
                    window.dispatchEvent(new CustomEvent('ae:canvas-generation-error', {
                        detail: { promptId: ids[ci], error: '已取消生成' }
                    }));
                } catch (_) { /* 无 DOM 事件环境（单测提取块）：本地收尾已生效，跳过结算派发 */ }
            }
            var session = _genSessionMgr ? _genSessionMgr.getSession(nodeId, cf) : null;
            if (session) {
                session.clearQueue();
                session.writeError(AEI18n.t('已取消生成'));
            } else {
                showPreviewError(nodeId, AEI18n.t('已取消生成'));
            }
            if (!calls.length) {
                if (global.AEToast) AEToast.error(AEI18n.t('取消请求发送失败：取消接口不可用，服务端任务可能仍在运行；')
                    + AEI18n.t('请到 ComfyUI 网页端检查队列/重启服务后重试'));
                return Promise.resolve();
            }
            return Promise.all(calls).then(function (marks) {
                var failed = 0;
                for (var m = 0; m < marks.length; m++) if (!marks[m]) failed++;
                if (failed === 0) {
                    if (global.AEToast) AEToast.info(AEI18n.t('已取消生成'));
                    return;
                }
                if (global.AEToast) AEToast.error(AEI18n.t('取消未完全成功：') + failed + '/' + calls.length
                    + AEI18n.t(' 项取消请求失败，服务端可能仍在排队或执行；请到 ComfyUI 网页端检查队列/重启服务后重试'));
            });
        }

        // 取消按钮事件委托（mount 里绑到 _canvasEl 一次）：从按钮回溯节点 id 再路由。
        // 单独抽成函数便于回归测试直接驱动（不依赖真实 DOM 事件冒泡）。
        function _onGenCancelClick(e) {
            var t = e && e.target;
            var btn = (t && typeof t.closest === 'function') ? t.closest('.ng-gen-cancel') : null;
            if (!btn) return;
            if (typeof e.stopPropagation === 'function') e.stopPropagation();   // 不触发画布空白点选/节点选中
            var nodeEl = (typeof btn.closest === 'function') ? btn.closest('.ng-node') : null;
            var nid = (nodeEl && nodeEl.dataset) ? nodeEl.dataset.nodeId : null;
            if (nid) return _cancelNodeGeneration(nid);   // 透出 promise，回执在请求结果落定后给出
        }
        // ── 画布生成取消块结束 ──

        // 刷新下游节点缩略图行 + imageEdit 编辑预览（仅在画布 attached 时有效）
        function _refreshDownstreamThumbnails(fromNodeId) {
            if (!_graph || !_ctrl || !_ctrl.nodeEls) return;
            var edges = _graph.edges();
            for (var ei = 0; ei < edges.length; ei++) {
                if (edges[ei].from === fromNodeId && _ctrl.nodeEls[edges[ei].to]) {
                    _refreshNodeThumbnails(_ctrl.nodeEls[edges[ei].to], edges[ei].to);
                    var downNode = _graph.getNode(edges[ei].to);
                    if (downNode && downNode.type === 'imageEdit') {
                        _syncImageEditPreview(edges[ei].to, _ctrl.nodeEls[edges[ei].to]);
                    }
                }
            }
        }

        // 创建 session 渲染回调集合（依赖反转：session 通过此对象调用 canvasIndex 的渲染函数）
        function _createRenderFns() {
            return {
                getNode: function (nodeId) { return _graph ? _graph.getNode(nodeId) : null; },
                phFrameHTML: _phFrameHTML,
                imgFrameHTML: _imgFrameHTML,
                fillBatchFrame: _fillBatchFrame,
                renderBatchFrameAt: _renderBatchFrameAt,
                updatePlaceholderProgress: _updatePlaceholderProgress,
                updateGenProgress: updateGenProgress,
                updateGenExecuting: updateGenExecuting,
                showPreviewGenerating: showPreviewGenerating,
                showPreviewError: showPreviewError,
                refreshDownstreamPreviews: _refreshDownstreamPreviews,
                setExecutorResult: function (nodeId, result) {
                    if (_executor) _executor.setResult(nodeId, result);
                }
            };
        }

        // 刷新 gen 节点自身预览（生成完成后调）：读结果 → 存 _result → 渲染缩略图
        function _refreshDownstreamPreviews(fromNodeId) {
            var result = _executor ? _executor.getResult(fromNodeId) : null;
            if (!result) return;
            // 归一化单数 image → 复数 images
            if (result.image && !(result.images && result.images.length)) {
                result = { images: [result.image], text: result.text, video: result.video };
            }
            // 写回 gen 节点自身的 .ng-result-preview
            var genNode = _graph.getNode(fromNodeId);
            if (genNode && (genNode.type === 'imageGen' || genNode.type === 'videoGen')) {
                genNode.params = genNode.params || {};
                genNode.params._result = result;
                // 如果已有批量帧（session.initBatch 创建的），只存 result 不覆盖 carousel
                if (genNode.params._frameHTMLs && genNode.params._frameHTMLs.length > 1) {
                    // 检查是否所有帧都已完成（无 path 为 null 的占位符），才清空占位符
                    var allDone = true;
                    var phs = genNode.params._placeholders;
                    if (phs) {
                        for (var pi = 0; pi < phs.length; pi++) {
                            if (!phs[pi].path) { allDone = false; break; }
                        }
                    }
                    // 兜底：并发场景下 callback 可能丢失，用 result.images 补填未完成的帧。
                    // 仅在 imgs.length === frames.length 时按位置对齐——有批次失败时 writeResult
                    // 是压缩式 concat，idx 与数组下标已错位，按位置填会张冠李戴（不如留占位/错误态）
                    if (!allDone && result.images && phs && genNode.params._frameHTMLs &&
                        result.images.length === genNode.params._frameHTMLs.length) {
                        var imgs = result.images;
                        var frames = genNode.params._frameHTMLs;
                        for (var pi2 = 0; pi2 < phs.length; pi2++) {
                            if (!phs[pi2].path && imgs[phs[pi2].idx] !== undefined) {
                                phs[pi2].path = imgs[phs[pi2].idx];
                                phs[pi2].pct = '100%';
                                frames[phs[pi2].idx] = _imgFrameHTML(imgs[phs[pi2].idx]);
                            }
                        }
                        // 重新检查
                        allDone = true;
                        for (var pi3 = 0; pi3 < phs.length; pi3++) {
                            if (!phs[pi3].path) { allDone = false; break; }
                        }
                    }
                    if (allDone) {
                        genNode.params._placeholders = null;
                    }
                    _renderBatchFrameAt(fromNodeId, genNode.params._batchCurIdx || 0);
                    return;
                }
                // 渲染结果缩略图
                var genEl = _ctrl && _ctrl.nodeEls && _ctrl.nodeEls[fromNodeId];
                if (genEl) {
                    var genPreview = genEl.querySelector('.ng-result-preview');
                    if (genPreview) {
                        var imgPaths = result.images || (result.image ? [result.image] : []) || [];
                        if (imgPaths.length > 0) {
                            // 多图支持：状态存 node.params._multiImgs/_multiCurIdx，避免闭包竞态
                            genNode.params._multiImgs = imgPaths;
                            genNode.params._multiCurIdx = 0;
                            _renderMultiImgAt(fromNodeId, 0);
                        } else if (result.videoOut || result.video) {
                            // 单值 key 随输出端口名改为 videoOut；兼容 executor 中旧格式
                            var vidPath2 = result.videoOut || result.video;
                            var vidUrl = _escapeAttr(_toFileUrl(vidPath2));
                            genPreview.innerHTML = '<video class="ng-result-thumb" src="' + vidUrl + '" muted preload="metadata" draggable="false" title="' + AEI18n.t('点击放大查看') + '"></video>';
                            // 视频元数据加载后按宽高比自适应 gen 节点尺寸（带 token 防竞态）
                            var vidTok = _nextFitToken(fromNodeId);
                            var fitVid = genPreview.querySelector('video');
                            if (fitVid) {
                                fitVid.addEventListener('loadedmetadata', function () {
                                    if (_fitTokens[fromNodeId] !== vidTok) return;
                                    _applyMediaFit(fromNodeId, fitVid.videoWidth, fitVid.videoHeight);
                                });
                                // 点预览视频 → 放大查看（带 controls 播放控件，与输入节点 lightbox 一致）
                                fitVid.addEventListener('click', function (e) {
                                    e.stopPropagation();
                                    if (global.AEComfyUI && global.AEComfyUI.openLightbox) global.AEComfyUI.openLightbox(vidUrl, true);
                                });
                            }
                        } else {
                            genPreview.innerHTML = AEI18n.html('<div class="ng-preview-placeholder">等待生成</div>');
                        }
                    }
                }
            }
        }

        // ============ 浮动 LLM 面板 ============

        function _initFloatingPanel(container) {
            if (!global.AEComfyUI.createFloatingPanel) return;
            if (!global.AEEngine || !global.AEEngine.createContextManager) {
                console.warn('[ComfyUI Canvas] contextManager 不可用，悬浮面板停用');
                return;
            }

            // contextManager：面板历史改由文件 sessionStore 承载（不再写 localStorage）。
            // 面板为单会话，用固定 session id。
            _panelCtx = global.AEEngine.createContextManager({
                storageKey: 'nodegen_panel_session_v1',
                maxContextTokens: 60000
            });

            // 文件持久化：首次进入时创建 comfyui 专属 sessionStore（模块级变量，跨挂载复用）。
            // 消息写入走 sessionStore 的防抖落盘，卸载时 flush 兜底。
            if (!_panelStore) {
                var _panelDataDir = 'comfyui';
                try {
                    if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                        var _pdd = global.AEShared.getDataDir().dir;
                        if (_pdd) _panelDataDir = (_pdd + '/comfyui').replace(/\\/g, '/');
                    }
                } catch (_) {}
                _panelStore = global.AEEngine.createSessionStore({
                    fs: global.AEFS,
                    dataDir: _panelDataDir,
                    mode: 'comfyui',
                    debounceMs: 0  // 由 _schedulePanelSave 统一防抖，store 直接写
                });
            }
            // 变更回调：panelChat 内部经 contextManager.add/addToolCallAssistant/addToolResult 入库，
            // 包装这些方法在每次变更后防抖写盘；clear 同样落盘（清空后保存空历史）。
            (function () {
                var _a = _panelCtx.add, _tc = _panelCtx.addToolCallAssistant,
                    _tr = _panelCtx.addToolResult, _cl = _panelCtx.clear;
                _panelCtx.add = function () { var r = _a.apply(_panelCtx, arguments); _schedulePanelSave(); return r; };
                _panelCtx.addToolCallAssistant = function () { var r = _tc.apply(_panelCtx, arguments); _schedulePanelSave(); return r; };
                _panelCtx.addToolResult = function () { var r = _tr.apply(_panelCtx, arguments); _schedulePanelSave(); return r; };
                _panelCtx.clear = function () { var r = _cl.apply(_panelCtx, arguments); _schedulePanelSave(); return r; };
            })();

            var llmChannel = (global.AE_LLM && global.AE_LLM.llmChannel) || null;
            var toolExecutor = (global.AE_LLM && global.AE_LLM.toolExecutor) || null;
            var toolRegistry = (global.AE_LLM && global.AE_LLM.toolRegistry) || null;
            var promptBuilder = (global.AE_LLM && global.AE_LLM.promptBuilder) || null;

            function getFilteredTools() {
                if (!toolRegistry) return [];
                var defs = toolRegistry.getLlmToolDefinitions('comfyui');
                return global.AEComfyUI.filterPanelTools ? global.AEComfyUI.filterPanelTools(defs) : defs;
            }

            function buildSystemPrompt() {
                var base = '你是 ComfyUI 画布的 AI 助手，帮用户创作图片/视频生成的提示词（prompt）。' +
                    '回答简洁，可直接用于粘贴进生成节点的提示词框。可调用 Skill 加载技能、MCP 工具查资料。';
                // noUserRules：规则三档（script/agent/shader）无 comfyui 档，显式声明
                // 不注入（防 script 档规则跨模块泄漏；注入器静默跳过不告警）
                // noAeInfo：画布助手是独立上下文，不接收主对话的 AE 环境行
                //（画布助手也需要不被 ae 信息影响）
                if (promptBuilder) return promptBuilder.build(base, { moduleId: 'comfyui', noUserRules: true, noAeInfo: true });
                return base;
            }

            // 解析当前默认平台 apiKey（与 agent engine resolveApiKeyForPlatform 同款逻辑）。
            // sendStream 不解析 apiKey，panelChat 必须传入，否则空串发请求报错。
            async function resolvePanelApiKey() {
                try {
                    var appCtx = global.AEAppContainer && global.AEAppContainer.getContext &&
                        global.AEAppContainer.getContext();
                    var store = appCtx && appCtx.settingsStore;
                    if (!store || !store.getGlobalSettings) return '';
                    var gs = await store.getGlobalSettings({});
                    var resolved = global.AE_LLM && global.AE_LLM.resolveLlmConfig
                        ? await global.AE_LLM.resolveLlmConfig({})
                        : { platform: gs.defaultProviderId || gs.defaultPlatform || '' };
                    var providerId = resolved.platform || gs.defaultProviderId || gs.defaultPlatform || '';
                    var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
                    var apiKeyField = registry && registry.getApiKeyField ? registry.getApiKeyField(providerId) : null;
                    if (!apiKeyField || providerId === 'siliconflow') {
                        return String(gs.apiKey || gs.siliconflowApiKey || '').trim();
                    }
                    return String(gs[apiKeyField] || gs.apiKey || '').trim();
                } catch (e) {
                    return '';
                }
            }

            var _cachedModelLabel = AEI18n.t('默认模型');
            function getModelLabel() { return _cachedModelLabel; }
            function refreshModelLabel() {
                try {
                    var store = global.AEAppContainer && global.AEAppContainer.getContext &&
                        global.AEAppContainer.getContext().settingsStore;
                    if (!store || !store.getGlobalSettings) return;
                    Promise.resolve(store.getGlobalSettings({})).then(function (gs) {
                        _cachedModelLabel = (gs && (gs.defaultModel || gs.defaultModelId)) || AEI18n.t('默认模型');
                        if (_panel) _panel.updateModelLabel();
                    }).catch(function () {});
                } catch (e) {}
            }

            _panelChat = global.AEComfyUI.createPanelChat({
                contextManager: _panelCtx,
                llmChannel: llmChannel,
                toolExecutor: toolExecutor,
                getTools: getFilteredTools,
                buildSystemPrompt: buildSystemPrompt,
                resolveApiKey: resolvePanelApiKey,
                maxLoops: 8,
                onToken: function (tok, full) {
                    if (_panel && !_streamingMsg) _streamingMsg = _panel.appendMsg('assistant', '');
                    if (_panel && _streamingMsg) _panel.streamToMsg(_streamingMsg, tok);
                },
                onToolCall: function (tc) {
                    _streamingMsg = null;
                    if (_panel) _panel.appendMsg('assistant', '⏳ 调用工具: ' +
                        (tc.function ? tc.function.name : tc.name));
                },
                onDone: function (text) {
                    if (!_streamingMsg && text && _panel) _panel.appendMsg('assistant', text);
                    _streamingMsg = null;
                    if (_panel) _panel.setBusy(false);
                },
                onError: function (err) {
                    _streamingMsg = null;
                    if (_panel) _panel.setBusy(false);
                    if (global.AEToast) AEToast.error(AEI18n.t('聊天失败: ') +
                        (err && err.message ? err.message : ''));
                }
            });

            _panel = global.AEComfyUI.createFloatingPanel({
                panelRoot: container,
                getModelLabel: getModelLabel,
                onClearChat: function () {
                    if (_panelCtx && typeof _panelCtx.clear === 'function') _panelCtx.clear();
                    var msgs = _panel._expandedEl && _panel._expandedEl.querySelector('.ng-float-msgs');
                    if (msgs) msgs.innerHTML = '';
                    _streamingMsg = null;
                }
            });

            // 渲染历史对话：从文件 sessionStore 异步加载并回灌 user/assistant 消息到 UI。
            // panelChat 的 tool 类消息（addToolResult）不直接渲染——恢复时跳过避免重复。
            function _renderPanelHistory() {
                var hist = _panelCtx && typeof _panelCtx.list === 'function' ? _panelCtx.list() : [];
                try {
                    for (var hi = 0; hi < hist.length; hi++) {
                        var hm = hist[hi];
                        if (!hm) continue;
                        if (hm.role === 'user' || hm.role === 'assistant') {
                            _panel.appendMsg(hm.role, hm.text || '');
                        }
                    }
                } catch (e) {
                    // 渲染历史失败不影响后续新对话流程
                }
            }
            // 每次挂载重新走 load 前复位「加载落定」标记——重挂载的加载窗口内
            // 旧 true 值会让空/未加载快照通过守卫（_panelStore 跨挂载复用）。
            _panelHistoryLoaded = false;
            if (_panelStore) {
                _panelStore.init().then(function () {
                    return _panelStore.load('nodegen_panel');
                }).then(function (msgs) {
                    // 落定即置位（含哨兵分支）：守卫只看「load 是否已有结论」，读失败由
                    // _panelHistoryReadFailed 另行拦截，二者叠加保证窗口内零覆盖写。
                    _panelHistoryLoaded = true;
                    // sessionStore.load 读失败时返回 {__readFailed:true} 哨兵
                    //（文件在但读不出）——认不出哨兵就按空历史渲染，下一条消息的
                    // 防抖 save 即整包覆盖原历史文件（聊天记录不可恢复）。此处按失败处理：
                    // 不导入、不按空渲染可写状态，并禁止后续覆盖写直到重启。
                    if (msgs && msgs.__readFailed) {
                        _panelHistoryReadFailed = true;
                        console.error('[ComfyUI Canvas] 面板历史读取失败，本次未加载，已禁止覆盖写');
                        if (global.AEToast) AEToast.warn(AEI18n.t('面板历史读取失败，本次未加载，不会覆盖原历史'));
                        return;
                    }
                    if (Array.isArray(msgs) && msgs.length && _panelCtx && typeof _panelCtx.importMessages === 'function') {
                        _panelCtx.importMessages(msgs);
                    }
                    _renderPanelHistory();
                }).catch(function () {
                    // 读取通道 reject（异常）同为读失败：不按空历史渲染并禁止覆盖写
                    _panelHistoryLoaded = true;
                    _panelHistoryReadFailed = true;
                    console.error('[ComfyUI Canvas] 面板历史读取异常，本次未加载，已禁止覆盖写');
                    if (global.AEToast) AEToast.warn(AEI18n.t('面板历史读取失败，本次未加载，不会覆盖原历史'));
                });
            } else {
                _renderPanelHistory();
            }

            _wirePanelInput();

            // 设置弹窗（#settingsModal，z-index:20）盖不住悬浮球（z-index:9000）。
            // 监听其显隐，打开时给悬浮球降 z-index 到遮罩之下，让遮罩自然盖住（连带模糊变暗）。
            var settingsMask = document.getElementById('settingsModal');
            if (settingsMask && typeof MutationObserver !== 'undefined') {
                var _settingsObserver = new MutationObserver(function () {
                    var open = settingsMask.style.display !== 'none' && settingsMask.style.display !== '';
                    _setFloatDimmed(open);
                });
                _settingsObserver.observe(settingsMask, { attributes: true, attributeFilter: ['style'] });
                _panelOnSettingsObserver = _settingsObserver;
            }
            function _setFloatDimmed(dimmed) {
                if (!_panel) return;
                var box = _panel._box, ex = _panel._expandedEl;
                if (box) box.classList.toggle('ng-float-dimmed', dimmed);
                if (ex) ex.classList.toggle('ng-float-dimmed', dimmed);
            }

            // 默认模型变更时刷新面板指示器
            function onModelChanged() { if (_panel) refreshModelLabel(); }
            window.addEventListener('ae:default-llm-changed', onModelChanged);
            _panelOnModel = onModelChanged;

            refreshModelLabel();
        }

        // 连接面板输入 → panelChat 发送
        function _wirePanelInput() {
            if (!_panel || !_panelChat || !_panel._expandedEl) return;
            var sendBtn = _panel._expandedEl.querySelector('.ng-float-send');
            var stopBtn = _panel._expandedEl.querySelector('.ng-float-stop');
            var input = _panel._expandedEl.querySelector('.ng-float-input');
            if (sendBtn) {
                sendBtn.addEventListener('click', function () { _sendPanelChat(); });
            }
            if (input) {
                input.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _sendPanelChat(); }
                });
            }
            if (stopBtn) {
                stopBtn.addEventListener('click', function () {
                    // 同步复位流式指针——只调 stop() 时 _streamingMsg 仍指向
                    // 被停止的气泡；下一条回复的 onToken 见指针非空就继续往旧气泡追加。
                    // 停止后旧循环的迟到 token/工具结果/onDone 由 panelChat 代际判定丢弃。
                    _streamingMsg = null;
                    if (_panelChat && _panelChat.stop) _panelChat.stop();
                    if (_panel) _panel.setBusy(false);
                });
            }
        }

        function _sendPanelChat() {
            if (!_panel || !_panelChat) return;
            // 生成中（busy）拦截第二个 chat 循环——Enter 与发送按钮两条入口
            // 都汇聚到这里，一处守卫即可全覆盖。busy 时 textarea 仍可输入，Enter 仍会
            // 触发本函数，不拦则两路 onToken 共享同一条流式消息节点、双流交错写入。
            if (_panel.isBusy && _panel.isBusy()) return;
            var text = (_panel.getInput && _panel.getInput().trim()) || '';
            if (!text) return;
            _panel.appendMsg('user', text);
            _panel.clearInput && _panel.clearInput();
            _panel.setBusy(true);
            _panelChat(text);
        }

        return {
            mount: mount,
            unmount: unmount
        };
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.createCanvasIndex = createCanvasIndex;
})(window);
