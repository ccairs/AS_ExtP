(function(global) {


    function createAEToolsController(context) {
        var ctx = context || {};
        var toolRegistry = ctx.toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry);

        function getAllTools() {
            var data = global.AE_LLM && global.AE_LLM._aeToolsData;
            return data ? data.slice() : [];
        }

        function searchTools(query, category) {
            var all = getAllTools();
            var q = (query || '').toLowerCase();
            var cat = category || 'all';
            return all.filter(function(t) {
                if (cat !== 'all' && t.category !== cat) return false;
                if (q) {
                    var nameMatch = (t.name || '').toLowerCase().indexOf(q) >= 0;
                    var descMatch = (t.description || '').toLowerCase().indexOf(q) >= 0;
                    if (!nameMatch && !descMatch) return false;
                }
                return true;
            });
        }

        function getTool(toolName) {
            var all = getAllTools();
            for (var i = 0; i < all.length; i++) {
                if (all[i].name === toolName) return all[i];
            }
            return null;
        }

        // 该名字是否已被「非 ae-tools 来源」的注册表条目占用（其它模块 bootstrap 注册的
        // 内建工具）。用户工具与内建同名时 register 按名覆盖 → 用户代码在内建名下执行，
        // 而外接暴露后外部 Agent 按内建名调用会执行用户代码（外部看不到面板的覆盖确认框）。
        // 判据取注册表里的 source 事实而非硬编码名单：名单会随模块增删漂移，来源不会。
        // 自家工具（source==='ae-tools'，含 seed 预置）与 createAETool 等元工具都不在此列——
        // 前者走 view 的「确认覆盖」流程，后者由 RESERVED_TOOL_NAMES 在上游硬拦。
        // 返回命中的注册表条目（调用方要报来源）或 null。注册表无查询能力时返回 null
        //（fail-open：此判据是纵深防护的补充，缺它不得把正常保存路径整个打死）。
        function isNameTakenByBuiltin(toolName) {
            if (!toolName || !toolRegistry) return null;
            var entry = (typeof toolRegistry.get === 'function') ? toolRegistry.get(toolName) : null;
            if (!entry && typeof toolRegistry.hasTool === 'function' && toolRegistry.hasTool(toolName)) {
                entry = { name: toolName, source: null };
            }
            if (!entry) return null;
            if (entry.source === 'ae-tools') return null;
            return entry;
        }

        // 解析工具作用域：优先用显式保存的 scope（支持多模块并集），缺失时回退 readOnly 推导。
        // 复用 bootstrap 的 resolveAeScope，测试环境无注入时本地回退。
        function resolveScope(toolDef) {
            if (toolDef && toolDef.scope) return toolDef.scope;
            if (global.AE_LLM && typeof global.AE_LLM._aeResolveScope === 'function') {
                return global.AE_LLM._aeResolveScope(toolDef);
            }
            return (toolDef && toolDef.readOnly)
                ? { type: 'global' }
                : { type: 'module', moduleIds: ['agent'] };
        }

        // 保留名：防止用户工具覆盖 LLM 元工具/内建撤回工具（与 aeToolCreator 的 RESERVED 保持一致）
        var RESERVED_TOOL_NAMES = { createAETool: true, deleteAETool: true, undoLastOperation: true, shader_params: true };

        // 重注册透传 getUndoName（对齐 bootstrap.js 注册路径的 createHandler opts）——
        // 漏传会让 executeExtendScript 的撤销组名退化为 defaultUndoName（工具名），AE 撤销菜单
        // 无法辨识操作内容（Ctrl+Z 时应显示 action 描述而非工具名）
        // 同步 bootstrap.js 注册面的 bypassSource——热重注册
        //（saveTool 编辑 executeExtendScript 的 extendScript 后）漏传会丢失 agent-tool
        // bypass 核开接线直至面板重载（方向 fail-closed 无安全洞，但违反 bypass 契约：
        // bypass ON 时门照跑、帧载荷三域全开）
        function createHandlerOpts(toolDef) {
            return {
                name: toolDef.name,
                wrapUndo: !toolDef.readOnly,
                // executeExtendScript（authored 代码执行核）撤销组入核
                //（授权帧载荷 undoName 传核内模板——与 bootstrap.js 注册路径同款）
                undoInCore: toolDef.name === 'executeExtendScript',
                // executeExtendScript 是 agent-tool 通道的注册执行端点
                //（bypassSource 注册面声明——与 bootstrap.js registerToolsFromConfig 同款）
                bypassSource: toolDef.name === 'executeExtendScript' ? 'agent-tool' : null,
                // executeExtendScript 撤销组名联动 action：用户 Ctrl+Z 时显示操作目的而非工具名
                getUndoName: (toolDef.name === 'executeExtendScript')
                    ? function(args) { return args && typeof args.action === 'string' ? args.action : null; }
                    : null,
                // 多帧抓帧执行超时（对齐 bootstrap.js registerToolsFromConfig 的同名接线——
                // 漏传会让用户在 AE Tools UI 里编辑/保存 getPreviewFrame 后，多帧调用回落到
                // 全局「执行超时」）。解析函数单一真相源在 bootstrap。
                timeoutMs: (toolDef.name === 'getPreviewFrame' || toolDef.name === 'analyzeImage')
                    ? ((global.AE_LLM && typeof global.AE_LLM._aePreviewBatchTimeoutMs === 'function')
                        ? global.AE_LLM._aePreviewBatchTimeoutMs : undefined)
                    : undefined,
                // 结果后处理：getPreviewFrame 的多时间点抓帧在面板侧拼联系表；analyzeImage
                // 在面板侧解码 PNG 并计算像素指标（对齐 bootstrap.js registerToolsFromConfig
                // 的同名接线——漏传会让用户在 AE Tools UI 里编辑/保存任意工具后，
                // getPreviewFrame / analyzeImage 静默失去后处理）
                postProcess: (toolDef.name === 'getPreviewFrame' && global.AEPreviewSheet
                    && typeof global.AEPreviewSheet.postProcessPreviewFrames === 'function')
                    ? global.AEPreviewSheet.postProcessPreviewFrames
                    : ((toolDef.name === 'analyzeImage' && global.AEImageAnalysis
                        && typeof global.AEImageAnalysis.postProcessAnalyzeImage === 'function')
                        ? global.AEImageAnalysis.postProcessAnalyzeImage
                        : null)
            };
        }

        // 工具注册过程（_saveTool 前向注册与失败回滚共用），返回 register 结果——
        // register 返回值不检查时，校验失败（如描述为空 MISSING_DESCRIPTION）会被静默吞掉：
        // 落盘成功 + toast 成功，但工具已被上方 unregister 从注册表剔除（编辑场景原工具被
        // 反注册，LLM 侧静默消失）。handler 不可用（非 CEP 环境无 _aeCreateHandler）返回
        // null，调用方按旧语义静默跳过注册、不触发回滚。
        function _registerToolDef(def) {
            var code = (def.extendScript && typeof def.extendScript === 'string' && def.extendScript.trim())
                ? def.extendScript
                : def.name + '(__args)';
            var handler = (global.AE_LLM && global.AE_LLM._aeCreateHandler)
                ? global.AE_LLM._aeCreateHandler(code, createHandlerOpts(def))
                : null;
            if (!handler) return null;
            // queryEnvironment 重新注册须保留 availableEffects 缓存通道（与 bootstrap 注册路径同款共享包装）：
            // 裸注册会把 LLM 的 availableEffects 查询直通 jsx 层被拒绝（aeTools.jsx 限定由 handler 层缓存处理）
            if (def.name === 'queryEnvironment' && global.AEEffectsCache && typeof global.AEEffectsCache.wrapQueryEnvironmentHandler === 'function') {
                handler = global.AEEffectsCache.wrapQueryEnvironmentHandler(handler);
            }
            // getPreviewFrame / analyzeImage 重新注册同款：调用前预建预览帧目录（AE 侧
            // Folder.create 在被沙箱拒时建不出来，见 bootstrap.js ensurePreviewDir 注释；
            // analyzeImage 抓帧模式复用 getPreviewFrame 落盘，同样需要目录先在位）
            if ((def.name === 'getPreviewFrame' && global.AE_LLM && typeof global.AE_LLM._aeEnsurePreviewDir === 'function')
                || (def.name === 'analyzeImage' && global.AE_LLM && typeof global.AE_LLM._aeEnsurePreviewDir === 'function')) {
                var _inner = handler;
                handler = function (args, ctx) {
                    try { global.AE_LLM._aeEnsurePreviewDir(); } catch (_) {}
                    return _inner(args, ctx);
                };
            }
            return toolRegistry.register({
                name: def.name,
                description: def.description,
                // 外接短描述分叉：与 bootstrap.registerToolsFromConfig 同款，
                // 否则 UI 保存/启停后注册条目丢失 buildDescription，外接又拿长文被 2048 截断。
                buildDescription: (global.AE_LLM && typeof global.AE_LLM._aeBuildExternalDescription === 'function')
                    ? global.AE_LLM._aeBuildExternalDescription(def) : null,
                shortDescription: def.shortDescription || '',
                input_schema: def.input_schema || { type: 'object', properties: {} },
                handler: handler,
                scope: resolveScope(def),
                stub: def.stub !== undefined ? !!def.stub : !def.readOnly,
                // readOnly 必须写显式布尔（导演 lane 收窄的
                // 元数据判据是 `readOnly !== true` ⇒ 剔除；undefined 会把只读工具误伤成写工具）。
                // 取值 = 工具定义里的 readOnly，缺失按写工具处理（与 bootstrap.registerToolsFromConfig
                // 同款判据——同一份 JSON 的两条注册路径不得分叉）。
                readOnly: def.readOnly === true,
                category: def.category || 'ae',
                source: 'ae-tools'
            });
        }

        // 写操作串行化：与 aeToolCreator 的 createAETool/deleteAETool 共享同一条
        // Promise 链（经 global.AE_LLM._aeWriteQueue），避免并发写互相覆盖
        // （如 LLM 审查等待期间的 UI 增删改被陈旧快照回滚）。
        function _serializedWrite(fn) {
            var prev = (global.AE_LLM && global.AE_LLM._aeWriteQueue) || Promise.resolve();
            var run = prev.then(fn);
            var next = run.then(function () {}, function () {});
            if (global.AE_LLM) global.AE_LLM._aeWriteQueue = next;
            return run;
        }

        // 外接清单同步（与本文件三个公开写入口配对）：自定义工具的增删改都改变了
        // 对外工具集，须推送 tools/list_changed。放在公开入口而非内层
        // 各 unregister/register 点：内层有 6 处改写点（含失败路径上的回滚重注册），
        // 逐点接线容易漏；入口层一处覆盖全部，且「动作后可能已变 → 请求重拉」
        // 在未真正变更时只是一次幂等重拉，无副作用。
        // 异常隔离：外接模块未加载/未连接/通知抛错都不得影响写操作本身。
        function notifyExternalToolsChanged() {
            try {
                var bc = global.AEExternal && global.AEExternal.bridgeClient;
                if (bc && typeof bc.notifyToolsChanged === 'function') bc.notifyToolsChanged();
            } catch (e) {
                console.warn('[AE Tools] 外接清单通知失败: ' + e);
            }
        }

        async function saveTool(toolDef, oldName) {
            try {
                return await _serializedWrite(function () { return _saveTool(toolDef, oldName); });
            } finally {
                // 同 bootstrap.hotReload：写操作抛异常时注册表也可能已改（_saveTool 在
                // 注册失败前已 unregister 过旧名），不能跳过通知
                notifyExternalToolsChanged();
            }
        }

        async function _saveTool(toolDef, oldName) {
            // 名称校验：格式 + 保留名（防止覆盖 createAETool/undoLastOperation 等元工具）
            if (!toolDef || !toolDef.name) return false;
            var newName = String(toolDef.name);
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newName)) {
                if (global.AEToast) global.AEToast.show(AEI18n.t('工具名称格式无效：只能包含字母、数字、下划线，以字母或下划线开头'), 'error');
                return false;
            }
            if (RESERVED_TOOL_NAMES[newName]) {
                if (global.AEToast) global.AEToast.show('"' + newName + AEI18n.t('" 是系统保留名称，不能用作工具名'), 'error');
                return false;
            }
            // 内建工具名一律拒绝（不改名也一样拒绝：编辑一个历史遗留的同名条目同样会把
            // 用户代码重新顶上内建名）。这条与 view 的预检查是同一判据的两道门——
            // view 负责给用户及时提示，本处负责「绕过 UI 也拦得住」。
            var takenEntry = isNameTakenByBuiltin(newName);
            if (takenEntry) {
                if (global.AEToast) {
                    global.AEToast.show('"' + newName + AEI18n.t('" 已被内建工具占用')
                        + (takenEntry.source ? AEI18n.t('（来源 ') + takenEntry.source + AEI18n.punct('）', ')') : '')
                        + AEI18n.t('，不能创建或覆盖同名工具。请换一个名称。'), 'error');
                }
                return false;
            }
            var original = getAllTools();   // 失败时回滚
            var all = original.slice();
            if (oldName && oldName !== toolDef.name) {
                all = all.filter(function(t) { return t.name !== oldName; });
            }
            var found = false;
            for (var i = 0; i < all.length; i++) {
                if (all[i].name === toolDef.name) {
                    all[i] = toolDef;
                    found = true;
                    break;
                }
            }
            if (!found) {
                all.push(toolDef);
            }
            global.AE_LLM._aeToolsData = all;

            // 先持久化，成功后再操作 toolRegistry（保证存盘失败时 toolRegistry 完全未变，回滚只需恢复 _aeToolsData）
            // 动态取当前 json 路径：数据目录支持运行时切换
            var jsonPath = (global.AE_LLM && typeof global.AE_LLM._aeToolsJsonPathFn === 'function')
                ? global.AE_LLM._aeToolsJsonPathFn() : global.AE_LLM._aeToolsJsonPath;
            try {
                // jsonPath 为空（数据目录初始化竞态返回空串）与保存失败同等对待：
                // 静默跳过会只改内存并返回成功，重启后丢失
                if (!jsonPath) throw new Error('数据目录未就绪');
                // _aeSaveJson 未注入（bootstrap.js 装配失败）同样按失败对待：
                // 条件跳过会让 UI 只改内存并提示成功，重启后全部丢失
                if (!global.AE_LLM._aeSaveJson) throw new Error('AE 工具持久化通道未就绪');
                await global.AE_LLM._aeSaveJson(jsonPath, all);
            } catch (e) {
                global.AE_LLM._aeToolsData = original;
                if (global.AEToast) global.AEToast.show(AEI18n.t('保存失败：') + e, 'error');
                return false;
            }

            // 持久化成功，增量操作 toolRegistry（与 deleteTool/toggleToolEnabled 风格一致）
            if (toolRegistry) {
                if (oldName && oldName !== toolDef.name) {
                    toolRegistry.unregister(oldName);
                }
                // 同名且仍启用时**不**注销：register 按名原地覆盖已足够，而「注销再注册」
                // 会把该名字挪到注册表键序末尾 → getLlmToolStubs 输出的 tools 顺序漂移 →
                // 该轮请求体从首个 token 起与历史不同，整段前缀缓存失效。
                // 改名（旧名必须注销）与禁用（须从注册表移除）两条路径仍照旧注销。
                if (!(oldName === toolDef.name && toolDef.enabled)) {
                    toolRegistry.unregister(toolDef.name);
                }
                if (toolDef.enabled) {
                    var regResult = _registerToolDef(toolDef);
                    // 检查 register 返回值——校验失败（如描述为空 MISSING_DESCRIPTION）
                    // 时回滚内存/磁盘/注册表三处状态，不再 toast 成功而工具静默从 LLM 侧消失
                    if (regResult && regResult.ok === false) {
                        global.AE_LLM._aeToolsData = original;
                        var rbJsonPath = (global.AE_LLM && typeof global.AE_LLM._aeToolsJsonPathFn === 'function')
                            ? global.AE_LLM._aeToolsJsonPathFn() : global.AE_LLM._aeToolsJsonPath;
                        try {
                            if (rbJsonPath && global.AE_LLM._aeSaveJson) await global.AE_LLM._aeSaveJson(rbJsonPath, original);
                        } catch (e2) {
                            console.warn('[AE Tools] 回滚持久化失败（磁盘与内存暂不一致，待下次保存覆盖）: ' + e2);
                        }
                        // 注册表回滚：按名恢复注册表原状——编辑场景重注册原定义，改名场景
                        // oldName 与新名一并恢复；原名不存在（新建）或原为禁用则确保不在册
                        var rbNames = (oldName && oldName !== toolDef.name) ? [oldName, toolDef.name] : [toolDef.name];
                        for (var rbi = 0; rbi < rbNames.length; rbi++) {
                            var rbDef = null;
                            for (var obi = 0; obi < original.length; obi++) {
                                if (original[obi].name === rbNames[rbi]) { rbDef = original[obi]; break; }
                            }
                            if (rbDef && rbDef.enabled) {
                                var rbReg = _registerToolDef(rbDef);
                                if (rbReg && rbReg.ok === false) {
                                    console.warn('[AE Tools] 回滚重注册失败: ' + rbDef.name + ' (' + (rbReg.error || '') + ')');
                                }
                            } else {
                                toolRegistry.unregister(rbNames[rbi]);
                            }
                        }
                        if (global.AEToast) global.AEToast.show(AEI18n.t('工具注册失败（') + (regResult.error || AEI18n.t('未知错误')) + AEI18n.t('），已回滚保存'), 'error');
                        return false;
                    }
                }
            }
            return true;
        }

        async function deleteTool(toolName) {
            try {
                return await _serializedWrite(function () { return _deleteTool(toolName); });
            } finally {
                notifyExternalToolsChanged();
            }
        }

        async function _deleteTool(toolName) {
            var original = getAllTools();   // 失败时回滚
            var filtered = original.filter(function(t) { return t.name !== toolName; });
            global.AE_LLM._aeToolsData = filtered;

            // 保持原路径（_aeSaveJson + unregister），不引入 hotReload
            // hotReload 会注销所有工具再重注册，影响面过大，不适合单工具删除
            // 动态取当前 json 路径：数据目录支持运行时切换
            var jsonPath = (global.AE_LLM && typeof global.AE_LLM._aeToolsJsonPathFn === 'function')
                ? global.AE_LLM._aeToolsJsonPathFn() : global.AE_LLM._aeToolsJsonPath;
            try {
                // jsonPath 为空（数据目录初始化竞态返回空串）与保存失败同等对待：
                // 静默跳过会只改内存并返回成功，重启后丢失
                if (!jsonPath) throw new Error('数据目录未就绪');
                // _aeSaveJson 未注入（bootstrap.js 装配失败）同样按失败对待：
                // 条件跳过会让 UI 只改内存并提示成功，重启后全部丢失
                if (!global.AE_LLM._aeSaveJson) throw new Error('AE 工具持久化通道未就绪');
                await global.AE_LLM._aeSaveJson(jsonPath, filtered);
            } catch (e) {
                global.AE_LLM._aeToolsData = original;
                if (global.AEToast) global.AEToast.show(AEI18n.t('删除失败：') + e, 'error');
                return false;
            }
            if (toolRegistry) {
                toolRegistry.unregister(toolName);
            }
            // 僵尸 per-tool 键回收：
            // 外接的 per-tool 禁用键**只按名字**保存（extPolicy 的 `disabledTools` ← localStorage），
            // 删除工具只做 unregister 时，键永远留下。危害不止占地方：
            //   `extPolicy.isToolDisabled(name)`（extPolicy.js:345）与装配回放构造的 `dm`
            //   （:371-375）都**按名**判定 ⇒ 之后**同名**的新工具（LLM 再建同名工具 / seed 被
            //   `mergeSeedTools` 重新追加 / 改名撞名）会**静默继承禁用**：用户从未禁用它，外接
            //   投影与执行期复检却都当它关着。
            // 修法选择「删除即清键」而不是「装配早期按注册表扫未知名」——后者会在工具尚未注册时
            // 误删用户的有效设置（装配顺序不可依赖）。setToolDisabled(name,false) 同时完成
            // 删键 + 落盘 + 注册表镜像复位（:347-361），无需第二套写入。
            try {
                var _extPolicy = global.AEExternal && global.AEExternal.policy;
                if (_extPolicy && typeof _extPolicy.setToolDisabled === 'function') {
                    _extPolicy.setToolDisabled(toolName, false);
                }
            } catch (_) { /* 外接未装配：无键可清，不阻断删除主流程 */ }
            return true;
        }

        async function toggleToolEnabled(toolName) {
            try {
                return await _serializedWrite(function () { return _toggleToolEnabled(toolName); });
            } finally {
                notifyExternalToolsChanged();
            }
        }

        async function _toggleToolEnabled(toolName) {
            var tool = getTool(toolName);
            if (!tool) return false;
            // 保留名工具（历史手编 JSON 残留）：启用会经直接注册路径遮蔽内建/元工具，
            // 禁止切换；删除不受限（属清理路径）
            if (RESERVED_TOOL_NAMES[toolName]) {
                if (global.AEToast) global.AEToast.show('"' + toolName + AEI18n.t('" 是系统保留名称，不能启用（会覆盖内建工具）。如不再需要请删除它。'), 'warn');
                return tool.enabled;
            }
            var originalEnabled = tool.enabled;
            tool.enabled = !tool.enabled;

            if (toolRegistry) {
                if (tool.enabled) {
                    // 复用 _registerToolDef 单点注册并检查返回值——register
                    // 校验失败（如手编 ae_tools.json 留下空描述 MISSING_DESCRIPTION）时
                    // enabled=true 已置位且随后持久化，但工具未入册：开关状态与注册表
                    // 静默脱节、无任何提示（与所修 _saveTool 同族）。失败时
                    // 回滚 enabled 并报错（在持久化之前返回，磁盘保持原状态）
                    var regResult = _registerToolDef(tool);
                    if (regResult && regResult.ok === false) {
                        tool.enabled = originalEnabled;
                        if (global.AEToast) global.AEToast.show(AEI18n.t('工具注册失败（') + (regResult.error || AEI18n.t('未知错误')) + AEI18n.t('），已回滚启用状态'), 'error');
                        return false;
                    }
                } else {
                    toolRegistry.unregister(toolName);
                }
            }

            // 持久化失败时回滚 UI 状态 + toolRegistry
            // 动态取当前 json 路径：数据目录支持运行时切换
            var jsonPath = (global.AE_LLM && typeof global.AE_LLM._aeToolsJsonPathFn === 'function')
                ? global.AE_LLM._aeToolsJsonPathFn() : global.AE_LLM._aeToolsJsonPath;
            try {
                // jsonPath 为空（数据目录初始化竞态返回空串）与保存失败同等对待：
                // 静默跳过会只改内存并返回成功，重启后丢失
                if (!jsonPath) throw new Error('数据目录未就绪');
                // _aeSaveJson 未注入（bootstrap.js 装配失败）同样按失败对待：
                // 条件跳过会让 UI 只改内存并提示成功，重启后全部丢失
                if (!global.AE_LLM._aeSaveJson) throw new Error('AE 工具持久化通道未就绪');
                await global.AE_LLM._aeSaveJson(jsonPath, getAllTools());
            } catch (e) {
                    // 回滚内存 + registry
                    tool.enabled = originalEnabled;
                    if (toolRegistry) {
                        if (originalEnabled) {
                            // 原本启用 → 现在需重新注册
                            toolRegistry.unregister(toolName);
                            var code2 = (tool.extendScript && typeof tool.extendScript === 'string' && tool.extendScript.trim())
                                ? tool.extendScript
                                : tool.name + '(__args)';
                            var handler2 = (global.AE_LLM && global.AE_LLM._aeCreateHandler)
                                ? global.AE_LLM._aeCreateHandler(code2, createHandlerOpts(tool))
                                : null;
                            if (handler2) {
                            // queryEnvironment 重新注册须保留 availableEffects 缓存通道（与 bootstrap 注册路径同款共享包装）：
                            // 裸注册会把 LLM 的 availableEffects 查询直通 jsx 层被拒绝（aeTools.jsx 限定由 handler 层缓存处理）
                            if (tool.name === 'queryEnvironment' && global.AEEffectsCache && typeof global.AEEffectsCache.wrapQueryEnvironmentHandler === 'function') {
                                handler2 = global.AEEffectsCache.wrapQueryEnvironmentHandler(handler2);
                            }
                                toolRegistry.register({
                                    name: tool.name,
                                    description: tool.description,
                                    // 回滚重注册路径同样保留外接短描述分叉（漏写会让一次失败的
                                    // 启停切换把外接描述退回长文，被客户端 2048 截断）。
                                    buildDescription: (global.AE_LLM && typeof global.AE_LLM._aeBuildExternalDescription === 'function')
                                        ? global.AE_LLM._aeBuildExternalDescription(tool) : null,
                                    shortDescription: tool.shortDescription || '',
                                    input_schema: tool.input_schema || { type: 'object', properties: {} },
                                    handler: handler2,
                                    scope: resolveScope(tool),
                                    stub: tool.stub !== undefined ? !!tool.stub : !tool.readOnly,
                                    // 回滚重注册路径同样写显式布尔
                                    //（漏写会让一次失败的启用切换把只读工具在导演 lane 里静默降级）
                                    readOnly: tool.readOnly === true,
                                    category: tool.category || 'ae',
                                    source: 'ae-tools'
                                });
                            }
                        } else {
                            // 原本禁用 → 现在需注销
                            toolRegistry.unregister(toolName);
                        }
                    }
                    if (global.AEToast) global.AEToast.show(AEI18n.t('切换状态失败：') + e, 'error');
                    return originalEnabled;
            }

            return tool.enabled;
        }

        function getCategories() {
            return global.AE_LLM && global.AE_LLM.AE_CATEGORIES || [];
        }

        function getAeFunctions() {
            var funcs = global.AE_LLM && global.AE_LLM._aeFunctions;
            return funcs ? funcs.slice() : [];
        }

        // type: 'all' | 'direct' | 'helper'
        // direct = 首参为 args（可直接调用）；helper = 其他（辅助函数）
        function searchAeFunctions(query, type) {
            var all = getAeFunctions();
            var q = (query || '').toLowerCase();
            var t = type || 'all';
            return all.filter(function(f) {
                var isDirect = (f.rawParams === 'args' || f.rawParams.indexOf('args,') === 0);
                if (t === 'direct' && !isDirect) return false;
                if (t === 'helper' && isDirect) return false;
                if (q) {
                    var nameMatch = (f.name || '').toLowerCase().indexOf(q) >= 0;
                    var paramsMatch = (f.params || []).join(' ').toLowerCase().indexOf(q) >= 0;
                    if (!nameMatch && !paramsMatch) return false;
                }
                return true;
            });
        }

        // 源码热重载：读取 aeTools.jsx → 注入 AE → 扫描 → 合并 → 持久化 → 热重载
        function reloadFromSource() {
            if (!global.AE_LLM || !global.AE_LLM._aeReloadFromSource) {
                return Promise.resolve({ ok: false, error: 'RELOAD_FUNCTION_UNAVAILABLE' });
            }
            return global.AE_LLM._aeReloadFromSource({ toolRegistry: toolRegistry });
        }

        return {
            getAllTools: getAllTools,
            searchTools: searchTools,
            getTool: getTool,
            isNameTakenByBuiltin: isNameTakenByBuiltin,
            saveTool: saveTool,
            deleteTool: deleteTool,
            toggleToolEnabled: toggleToolEnabled,
            getCategories: getCategories,
            getAeFunctions: getAeFunctions,
            searchAeFunctions: searchAeFunctions,
            reloadFromSource: reloadFromSource
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createAEToolsController = createAEToolsController;

})(window);
