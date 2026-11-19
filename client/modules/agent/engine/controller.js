(function (global) {
    // runtimeMode → 当前轮工具模块身份（'agent' / 'script' / 'shader'）。作用域过滤、轮次门控、
    // AE 上下文快照的注入权限都用这一个身份，故映射只写这一份。
    // agent 与 external 同族（外接的工具是三方合并的扁平清单，工具循环与 agent 共用，见
    // _runUserRequest 的 isAgentMode）；script 轮走脚本循环，身份是 script。
    // **'team' 显式并入 agent 族**（第 5 档升格为第一等档位后）：面板层的
    // 非 lane 路径会真的拿到 'team'；靠末尾兜底 `return 'agent'` 结果相同，但那是
    // 「碰巧」：兜底悄悄生效正是本仓反复吃亏的形态（previewFps / external 折叠都是这一课），
    // 故写成显式分支。团队档下**具体身份**由 bootstrap.roundIdentity 按当前 lane 取。
    function roundModuleId(mode) {
        if (mode === 'shader') return 'shader';
        if (mode === 'script') return 'script';
        if (mode === 'team') return 'agent';
        return 'agent';
    }

    function createController(options) {
        const opts = options || {};
        const state = opts.state;
        const view = opts.view;
        const service = opts.service;
        const validator = opts.validator;
        const scriptContextManager = opts.scriptContextManager;
        const agentContextManager = opts.agentContextManager;
        const shaderContextManager = opts.shaderContextManager;
        const scriptSessionStore = opts.scriptSessionStore;
        const agentSessionStore = opts.agentSessionStore;
        const shaderSessionStore = opts.shaderSessionStore;
        const toolExecutor = opts.toolExecutor;
        // agent 模块注册 id（见 client/modules/agent/index.js 与 engine/bootstrap.js createController 入参）
        const moduleId = opts.moduleId || 'agent';
        // ── 本 runtime 的工具 handler 绑定表（见 shared/toolRegistry.js
        // 的 createRuntimeToolRegistry 头注）：注册仍进全局注册表（LLM 清单 / tool_search / 外接
        // 投影 / UI 开关全部不变），但**handler 按 runtime 各记一份**，执行时由执行侧（pipeline →
        // toolExecutor）按「执行者自己那份」解析。全表 last-wins 时：最后装配那条 runtime 的
        // handler 与闭包状态会替所有 runtime 作答（团队 lane / 子 Agent 与单 Agent 互相串停止态、
        // 会话域、计划树、预览账本槽……逐个 ctx 化只是治症状）。
        var runtimeToolHandlers = Object.create(null);
        var toolRegistry = (global.AE_LLM && typeof global.AE_LLM.createRuntimeToolRegistry === 'function')
            ? global.AE_LLM.createRuntimeToolRegistry(opts.toolRegistry, runtimeToolHandlers)
            : opts.toolRegistry;
        // 三档工具权限策略（auto/balanced/conservative，默认 balanced；见 engine/permissions.js）
        var permissionPolicy = (global.AEEngine && typeof global.AEEngine.createPermissionPolicy === 'function')
            ? global.AEEngine.createPermissionPolicy()
            : null;
        var activePlan = { steps: [] };
        // 工具循环内部硬上限：防 LLM 无限循环烧 token。
        // 不再暴露给用户配置——实际兜底靠 stop 按钮 + requestTimeout + context 压缩。
        // 提到 500 轮，正常复杂任务不会撞到，真死循环也有最终保险。
        var MAX_TOOL_LOOPS = 500;
        // pending 交接存储单例引用：由 bootstrap 创建，见 bootstrap.js
        var pendingInput = (typeof global !== 'undefined' && global.AEEngine && global.AEEngine.pendingInput) || null;

        // ── store 就绪等待：**一律有界** ──────────────────
        // 为什么必须有界：索引读走 AEFS（裸 fetch，无超时；aefs.js 自己写明「端口被 accept 后
        // 不响应的进程占用时 fetch 会无限挂起」）。无界等待会把 `_modeSwitching` 永久置位 ⇒
        // 旋钮 / 切会话 / 删会话全部恒 busy（静默死锁，用户只能重启面板）。
        // 同文件已有同款取舍：`_adoptRestoring` 的 8s 保险（读挂住必须放闸，否则发送键永久锁死）。
        // 超时按「未就绪」返回 ⇒ 调用方走既有显式失败体（`store_not_ready`），不假装成功。
        // 可经 `opts.storeReadyTimeoutMs` 覆盖（单测用短值验证「有界」这一条）。
        var _storeReadyMs = (typeof opts.storeReadyTimeoutMs === 'number' && opts.storeReadyTimeoutMs > 0)
            ? opts.storeReadyTimeoutMs : 8000;
        function _awaitStoreReady(store, timeoutMs) {
            if (!store || typeof store.whenReady !== 'function') return Promise.resolve(false);
            var ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : _storeReadyMs;
            return new Promise(function (resolve) {
                var done = false;
                var timer = setTimeout(function () {
                    if (done) return;
                    done = true;
                    resolve(false);   // 超时 = 未就绪（调用方据此显式失败，不挂死）
                }, ms);
                Promise.resolve().then(function () { return store.whenReady(); }).then(function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(true);
                }, function () {
                    if (done) return;
                    done = true;
                    clearTimeout(timer);
                    resolve(false);
                });
            });
        }

        // 纯函数层拆分——各工厂挂 AEEngine.createXxx()，见 controller/ 目录
        // 注意：部分注入依赖（getSettings/onStateChange/_stopping 等）为 const/let，定义在下方，
        // 此处经惰性 getter 包装引用，运行时才取值，规避 TDZ。
        var scriptTranscode = global.AEEngine.createScriptTranscode();
        var argParsing = global.AEEngine.createArgParsing({ getValidationStageLabel: function (stage) { return intentValidation.getValidationStageLabel(stage); } });
        var sessionLoadingUi = global.AEEngine.createSessionLoadingUi();
        // LLM 请求失败自动重试：判定/退避/取消的唯一实现见 controller/llmRetry.js，
        // Agent 循环与 Script 循环共用这一份实例配置（默认 2 次重试、1s 起指数退避）。
        var llmRetry = global.AEEngine.createLlmRetry();
        var chatViewHelpers = global.AEEngine.createChatViewHelpers({
            getSettings: function () { return getSettings(); },
            scriptContextManager: scriptContextManager,
            agentContextManager: agentContextManager,
            shaderContextManager: shaderContextManager,
            scriptSessionStore: scriptSessionStore,
            agentSessionStore: agentSessionStore,
            shaderSessionStore: shaderSessionStore,
            state: state,
            view: view,
            onStateChange: function (s) { onStateChange(s); },
            getStopping: function () { return _stopping; },
            // 团队模式的两个键必须**转发**给 chatViewHelpers（缺这两行的后果是整条链静默失效）：
            // helper 的 syncView 用 isTeamMode() 判走团队分支还是 non-team 分支，并在团队分支里调
            // onBusyChange(busy, stopping) —— 团队分支**自己不再置灰切换器**，团队锁全靠这个上报钩子
            //（bootstrap 注入；lane 三条 + 主 Agent 各一个，见那里的 _mk*BusyChangeReporter）。
            // 这里只是原样透传 opts：不传就是「钩子接在 ctrlOpts 上、helper 永远看不到」——真机上
            // 三条 lane 与主 Agent 的 onBusyChange 一次都不会被调用（团队锁失效，
            // 而单测夹具若自己造这两个键就会假绿）。
            isTeamMode: opts.isTeamMode,
            onBusyChange: opts.onBusyChange,
            getLastSwitcherLocked: function () { return _lastSwitcherLocked; },
            setLastSwitcherLocked: function (v) { _lastSwitcherLocked = v; },
            saveActiveSessionDebounced: function () { tokenStats.saveActiveSessionDebounced(); }
        });
        // 本 lane 的 token 统计存储：三条 lane 各持一份，避免共写一份数组——
        // 否则一条 lane 的「清空对话」（apiActions 的 clear）会清掉三条 lane 的全部统计，
        // 顶栏与任务板的用量也会串。单 Agent 路径：getLaneId() 为空 ⇒ 回落缺省单例，行为不变。
        function _statsStore() {
            var laneId = getLaneId();
            if (laneId && global.AEEngine && typeof global.AEEngine.tokenStatsFor === 'function') {
                var inst = global.AEEngine.tokenStatsFor(laneId);
                if (inst) return inst;
            }
            return (global.AEEngine && global.AEEngine.tokenStats) || null;
        }
        var tokenStats = global.AEEngine.createTokenStats({
            getActiveStore: function () { return chatViewHelpers.getActiveStore(); },
            getActiveCm: function () { return chatViewHelpers.getActiveCm(); },
            // 记账/落盘/恢复的数据源（不传时 helper 回落缺省单例 = 单 Agent 路径）
            getTokenStats: function () { return _statsStore(); },
            // 消息落盘的覆盖守卫：团队 lane 的历史回读失败时拒绝覆写原文件
            //（判据实现见 _adoptWriteBlocked；单 Agent 路径该判据恒 false，行为不变）
            isSessionWriteBlocked: function () { return _adoptWriteBlocked(); },
            view: view
        });
        var toolHistory = global.AEEngine.createToolHistory({ state: state, agentContextManager: agentContextManager });
        var messageHelpers = global.AEEngine.createMessageHelpers({
            state: state,
            getActiveCm: function () { return chatViewHelpers.getActiveCm(); },
            saveActiveSessionDebounced: function () { tokenStats.saveActiveSessionDebounced(); },
            syncView: function (onDone) { return chatViewHelpers.syncView(onDone); },
            // AE 快照注入身份（当前轮模块）：不调 gather 的注入通道复用上一次快照，身份不符即
            // 跨模式陈旧数据（如切到 shader 模式后残留的 agent 轮工程/选中信息）→ 不注入。
            getRoundModuleId: function () { return roundModuleId((getSettings() || {}).runtimeMode); },
            // 并联身份与快照身份分离：moduleIds 决定 scope 合法性，laneKey 只做分槽。
            // 单 Agent 路径两者都为空 ⇒ messageHelpers 退回 getRoundModuleId，行为不变。
            getToolModuleIds: function () { return getLaneModuleIds(); },
            getLaneKey: function () { return getLaneId(); }
        });

        // 工具实现层拆分——各工厂挂 AEEngine.createXxx()，见 controller/ 目录。
        // 依赖的部分变量为后定义的 const/let（getSettings/onScriptReady/getCurrentScript/
        // stopRequested/activeAbortController）或后定义函数，此处经惰性 getter 包装引用，
        // 运行时才取值，规避 TDZ（与注入方式一致）。
        var webSearchTool = global.AEEngine.createWebSearchTool();
        var urlReadTool = global.AEEngine.createUrlReadTool();
        var skillStoreTool = global.AEEngine.createSkillStoreTool();
        var earlyHistoryTool = global.AEEngine.createEarlyHistoryTool({
            chatViewHelpers: chatViewHelpers,
            foldArchiveMessage: function (m) { return contextCompression.foldArchiveMessage(m); },
            matchAnyTerm: function (text, terms) { return contextCompression.matchAnyTerm(text, terms); }
        });
        // 大工具结果暂存 + 分页读取工具：超限结果由工具管线存全文（见 toolExecutionPipeline 的截断分支），
        // 模型用 read_tool_result 翻页——执行类工具（executeExtendScript）与外部 MCP 工具不重跑。
        var toolResultStore = global.AEEngine.createToolResultStore();
        var toolResultReaderTool = global.AEEngine.createToolResultReaderTool({
            store: toolResultStore,
            getSessionId: function () {
                var cm = chatViewHelpers.getActiveCm();
                return (cm && typeof cm.getSessionId === 'function') ? (cm.getSessionId() || '') : '';
            }
        });
        var scriptTools = global.AEEngine.createScriptTools({
            // 本 lane 的预览账本身份：scriptTools 内部唯一的 previewSnapshot 回退点
            // 按它取 store.forLane(lane)，否则团队模式下三条 lane 的预览区互相串账。
            // 单 Agent 路径返回 null ⇒ 回退点原样返回单例，行为与分槽前逐字节一致。
            getLaneId: function () { return getLaneId(); },
            // 停止态/signal 一律经 ctx 感知实现（见 stopRequestedForCtx 的注释）：共享注册表
            // last-wins ⇒ 本 handler 可能由别的 runtime 注册，闭包里的旧判据会把「那条 runtime
            // 早已停止」误当成本次被停止（真机：团队→script 后 submit_script 恒回 stopped）。
            getStopRequested: function (execCtx) { return stopRequestedForCtx(execCtx); },
            scriptTranscode: scriptTranscode,
            getCurrentScript: function () { return getCurrentScript(); },
            argParsing: argParsing,
            scriptContextManager: scriptContextManager,
            getSettings: function () { return getSettings(); },
            validator: validator,
            getActiveAbortController: function (execCtx) { return abortControllerForCtx(execCtx); },
            onScriptReady: function (s, o) { return onScriptReady(s, o); },
            isInfrastructureError: function (m) { return intentValidation.isInfrastructureError(m); }
        });

        // ── 团队 lane 的工具身份 ────────────────────────────────
        // lane 的身份是**集合**（如 ['agent','team']）+ 可选的**收窄判据** filter（入参注册表条目）。
        // 单 Agent 路径不传 opts.toolSet ⇒ 两者恒为 null，下游全部保持改动前的「单串单模块」语义。
        function getLaneToolSet() {
            var ts = opts.toolSet;
            if (!ts || !Array.isArray(ts.moduleIds) || !ts.moduleIds.length) return null;
            return ts;
        }
        function getLaneModuleIds() {
            var ts = getLaneToolSet();
            return ts ? ts.moduleIds.slice() : null;
        }
        function getLaneToolFilter() {
            var ts = getLaneToolSet();
            return (ts && typeof ts.filter === 'function') ? ts.filter : null;
        }
        // lane id（团队模式）：随 execCtx 传给工具 handler——AE 队列的等待/失败文案要写明
        // 「被哪条 lane 的哪个工具占用」（`ae-tools/bootstrap.js` 读 `ctx.laneId`，缺省 'single'
        // 覆盖单 Agent / 外接 / 手动脚本执行通道）。缺省空串 ⇒ ctx 不含该键，旧路径逐字节不变。
        function getLaneId() {
            if (typeof opts.laneId === 'string' && opts.laneId) return opts.laneId;
            if (opts.lane && typeof opts.lane.id === 'string') return opts.lane.id;
            return '';
        }

        // ── 工具可见性闸口 ────────────────────────────────────
        // 单一决策模块 = shared/toolVisibility.js。bootstrap 为每条 runtime 注入 opts.toolVisibility
        // （子 Agent 用派生时冻结的设置快照）；未注入时（测试与审计脚本
        // 等直接 createController 的装配）用**同一工厂惰性自建**，不留「未注入回退旧路径」——
        // 那会形成两条判定，违反同源约束。
        //   · 身份：lane 视图取 lanes.get(view).moduleIds（bootstrap 注入的 getLanes）；
        //     沙箱/旧装配没有 team/lanes.js 时，只为本 controller 自己的 lane 提供身份
        //     （测试直驱形态：opts.toolSet.moduleIds 就是它）。
        //   · 收窄：lane 视图优先取本 runtime 的 opts.toolSet.filter（生产与 lanes.js 同一函数对象）；
        //     其它 lane 视图取 lanes.get(view).filter。
        //   · 团队开关：getter 现取（runtimeMode / 团队开关每轮可变）。
        var _toolVisibility = opts.toolVisibility || null;   // bootstrap 注入的闸口实例（子 Agent = 冻结快照）
        var _gateWarned = false;                             // 闸口装配缺口的告警只报一次（不每轮刷日志）
        var _roundVisibility = null;                          // 当前轮闸口上下文（投放/执行/tool_search/执行器四处同源）
        function _gateLanes() {
            var api = (global.AEAgentTeam && global.AEAgentTeam.lanes) ? global.AEAgentTeam.lanes : null;
            if (api && typeof api.list === 'function') return api;
            // 无 team/lanes.js 的装配：只描述本 controller 自己的 lane（单 Agent 路径返回 null）
            var ownId = getLaneId();
            var ownIds = getLaneModuleIds();
            if (!ownId || !ownIds || !ownIds.length) return null;
            var ownFilter = getLaneToolFilter();
            return {
                list: function () { return [{ id: ownId, moduleIds: ownIds.slice(), filter: ownFilter }]; },
                get: function (viewId) {
                    return (viewId === ownId) ? { id: ownId, moduleIds: ownIds.slice(), filter: ownFilter } : null;
                }
            };
        }
        function _gateDeps() {
            return {
                getRegistry: function () { return opts.toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry) || null; },
                getSettings: function () { return getSettings(); },
                getLanes: function () { return _gateLanes(); },
                getLaneFilter: function (viewId) {
                    var ownId = getLaneId();
                    if (ownId && viewId === ownId) return getLaneToolFilter();
                    var lanes = _gateLanes();
                    var def = (lanes && typeof lanes.get === 'function') ? lanes.get(viewId) : null;
                    if (def && typeof def.filter === 'function') return def.filter;
                    return null;
                },
                isTeamMode: function () { return !!(typeof opts.isTeamMode === 'function' && opts.isTeamMode()); }
            };
        }
        function getToolVisibility() {
            if (!_toolVisibility) {
                _toolVisibility = (global.AE_LLM && typeof global.AE_LLM.createToolVisibility === 'function')
                    ? global.AE_LLM.createToolVisibility(_gateDeps())
                    : null;
            }
            return _toolVisibility;
        }
        // 当轮视图 id（派生规则）：团队 lane runtime = laneId；单 Agent = script/shader 同名，
        // 其余（agent / external / 其它）一律 agent（与 roundModuleId 同口径）。
        function _viewIdForRound(moduleId) {
            var ownId = getLaneId();
            if (ownId) {
                var lanes = _gateLanes();
                if (lanes && typeof lanes.get === 'function' && lanes.get(ownId)) return ownId;
            }
            if (moduleId === 'script') return 'script';
            if (moduleId === 'shader') return 'shader';
            return 'agent';
        }
        // 子 Agent 的剔除判据（父 lane 视图再叠加自己的 allow/deny/禁名单）：
        // 只有子 Agent 把它当 extraFilter 传入；lane / 单 Agent 路径为 null（lane 收窄由闸口内部按视图取）。
        function _roundExtraFilter() {
            return (opts.isSubagent === true) ? getLaneToolFilter() : null;
        }
        // 执行侧（pipeline）读本轮闸口上下文：投放、执行闸、tool_search、执行器复核四处同源
        function getVisibility() { return _roundVisibility; }
        // system prompt 的可见性谓词——按**当前视图**的闸口判定
        // 回答「某工具当前轮能否被看到」，供 prompts.js 裁剪 stub 铁律、lanes.js 裁剪被点名工具的句子、
        // bootstrap 的 goal 策略段按条裁剪。判据 = **闸口 ∧ goal 语义黑名单**；askUser 黑名单与
        // 视觉/视频/联网语义门控不参与（当前提示词不点名那批工具；将来若点名须把 blacklist 构造
        // 抽成同一函数，避免「谓词说可见、投放说不可见」）。
        // 不读 _roundVisibility 的缓存：提示词在投放构建**之前**生成，切模式/切视图后的首轮缓存是上一轮的。
        // 子 Agent 的 gate 是派生时冻结实例、extraFilter 是自己的剔除判据 ⇒ 与投放/执行同一判定。
        function _promptToolVisible(name) {
            if (typeof name !== 'string' || !name) return false;
            var gate = getToolVisibility();
            if (!gate) return true;                       // 闸口缺席（旧装配/测试桩）：不裁剪
            var reg = opts.toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry) || null;
            var entry = (reg && typeof reg.get === 'function') ? reg.get(name) : null;
            // 未注册的工具：提示词不该点名它。tool_search 例外——闸口对「注册表缺该条目」按
            // 依赖可用处理（toolVisibility._toolSearchAvailable 返回 true），此处同源返回 true，
            // 避免 stub 铁律被误换成「本视图均为完整定义」（生产恒注册，仅残缺装配踩到）。
            if (!entry) return name === 'tool_search';
            // goal 三件另有**语义黑名单**（_goalSupported：子 Agent / 团队非导演 lane 不给），
            // 闸口只看「可见性」不含它；提示词谓词必须与投放同口径，否则导演派生的子 Agent 骨架
            // 会点名一件工具面里没有的 goal 工具。
            if (!_goalSupported() && GOAL_TOOL_NAMES.indexOf(name) >= 0) return false;
            var mode = '';
            try { mode = (getSettings() || {}).runtimeMode || ''; } catch (_) { mode = ''; }
            return gate.allows(_viewIdForRound(roundModuleId(mode)), entry, _roundExtraFilter());
        }
        // 构建 system prompt 时传给 PromptBuilder 的 ctx：在 controller opts 上**原型叠加**当前轮
        // 可见性谓词（叠加在原型上，其它注入器读到的字段不变；不改 opts 对象、不改注册表）。
        function _promptBuildContext(runMode) {
            var ctx = Object.create(opts);
            ctx.isToolVisible = _promptToolVisible;
            // 运行模式（agent/script/shader）：面板内 controller 的
            // moduleId 恒为 'agent'，但 Script/Shader 轮的**执行侧** moduleId 分别是
            // 'script'/'shader'（toolExecutionPipeline execMode）。提示词侧注入（如
            // <available_skills>）若只看 moduleId，就会与执行侧作用域判定不一致：
            // 限某模式的技能「可调用但摘要不列」或「摘要列了却调不动」。把当前轮模式显式
            // 下发给 promptBuilder 钩子，钩子按模式过滤即可与执行侧对齐。
            // 键名用专用 runMode（而非通用的 mode）：避免与既有 opts.mode（审查上下文的
            // 模式标记，service.withModuleId 会原样带进 ctx）撞键。
            if (runMode) ctx.runMode = String(runMode);
            return ctx;
        }
        // getToolFilter 的语义：闸口判定 ∧ extraFilter 的**同一个函数对象**。
        // 轮内返回当前轮投放用的那一个；轮外按当前视图现算（缓存同一对象）。
        function getGateFilter() {
            if (_roundVisibility && _roundVisibility.filter) return _roundVisibility.filter;
            var gate = getToolVisibility();
            if (!gate) return getLaneToolFilter();
            var mode = '';
            try { mode = (getSettings() || {}).runtimeMode || ''; } catch (_) { mode = ''; }
            return gate.filterFor(_viewIdForRound(roundModuleId(mode)), _roundExtraFilter());
        }
        // 本 lane 的消息列表节点。
        // 全部改走这里——不改就会出现「停止路径的部分回复 / 思考气泡定形」写进单 Agent 的隐藏容器，
        // 随后被 renderMessages 清理 ⇒ 内容凭空消失。缺省值 = 原 id ⇒ 单 Agent 路径逐字节不变。
        // 不复用 view.getDom()：停止/收尾路径可能在 view 重挂后触发，直接按 id 取更稳。
        function _laneListEl() {
            var id = (opts.dom && opts.dom.listId) || 'aeAgentMessageList';
            return document.getElementById(id);
        }

        // 工具审查管线与工具门控拆分——各工厂挂 AEEngine.createXxx()，见 controller/ 目录。
        // executeToolCall 依赖的 stopRequested/activeAbortController/_stubToolNames/_visionModelName/
        // _visionPlatform/_hasVisionProxy/_currentUserText 为后定义可变变量，经惰性 getter 注入；
        // stopPromiseResolve 为双向共享（确认/执行写入、requestStop 读取），经 setter 注入。
        var toolExecutionPipeline = global.AEEngine.createToolExecutionPipeline({
            argParsing: argParsing,
            getModuleId: function () { return moduleId; },
            // lane 并联身份：执行侧 scope 校验按集合放行（toolExecutor 支持数组）；
            // 收窄判据随 execCtx 下发给 handler（tool_search 的第三个消费点）。
            // getToolFilter 是闸口的同一 filter 函数对象（gate.filterFor），
            // 与投放/tool_search/执行器校验同源。
            getModuleIds: function () { return getLaneModuleIds(); },
            getToolFilter: function () { return getGateFilter(); },
            // 当前轮闸口上下文（{ gate, viewId, extraFilter, filter, moduleLabel }）：pipeline 随
            // execOpts/execCtx 下发给执行器校验与 tool_search handler（四处同源）。
            getVisibility: function () { return getVisibility(); },
            // lane id：AE 队列文案的占用者归属（handler 侧 ctx.laneId）
            getLaneId: function () { return getLaneId(); },
            // 执行者是不是被派生的子 Agent（子 Agent 只能读团队任务清单）。
            // 原样透传给执行管线，由它随 execCtx 下发给 handler；lane / 单 Agent 路径恒 false。
            isSubagent: opts.isSubagent === true,
            getStubToolNames: function () { return _stubToolNames; },
            state: state,
            // 大工具结果暂存（超限结果存全文 → 模型用 read_tool_result 翻页，执行类工具不重跑）
            toolResultStore: toolResultStore,
            getActiveSessionId: function () {
                var cm = chatViewHelpers.getActiveCm();
                return (cm && typeof cm.getSessionId === 'function') ? (cm.getSessionId() || '') : '';
            },
            // 执行侧运行事实（共享注册表 last-wins ⇒ 工具 handler 可能来自
            // 另一条 runtime，凡是「本 runtime 的」可变/身份状态都得按执行者下发）：当前档位的
            // cm / 会话 store、计划处理器。见 toolExecutionPipeline 的 _execCtxOpts 注释。
            getActiveCm: function () { return chatViewHelpers.getActiveCm(); },
            getActiveStore: function () { return chatViewHelpers.getActiveStore(); },
            // planApi 是本 controller 自己的计划处理器（下方 var 声明；getter 调用期取值）
            getPlanApi: function () { return planApi; },
            // 本 runtime 的工具 handler 绑定表（**主入口**）：pipeline 每次
            // 调用随 execOpts 把执行者这份下发给 toolExecutor，执行器优先用它——从根上消灭
            // 「handler 由最后装配那条 runtime 提供、却替所有 runtime 作答」的整类缺陷。
            getRuntimeHandlers: function () { return runtimeToolHandlers; },
            getVisionModelName: function () { return _visionModelName; },
            getVisionPlatform: function () { return _visionPlatform; },
            getHasVisionProxy: function () { return _hasVisionProxy; },
            validator: validator,
            getSettings: function () { return getSettings(); },
            view: view,
            getCurrentUserText: function () { return _currentUserText; },
            // 三个模式的 contextManager 一并注入——LLM 安全审查上下文由管线
            // 按 execMode 在调用时惰性选取（只注入 agentContextManager 时，Script/
            // Shader 模式的审查请求拿到的是 agent 会话历史，跨模式污染）。
            agentContextManager: agentContextManager,
            scriptContextManager: scriptContextManager,
            shaderContextManager: shaderContextManager,
            getActiveAbortController: function () { return activeAbortController; },
            getStopRequested: function () { return stopRequested; },
            setStopPromiseResolve: function (v) { stopPromiseResolve = v; },
            permissionPolicy: permissionPolicy,
            toolExecutor: toolExecutor
        });
        var toolGating = global.AEEngine.createToolGating({
            getToolRegistry: function () { return opts.toolRegistry; },
            getSettings: function () { return getSettings(); },
            executeToolCall: toolExecutionPipeline.executeToolCall
        });

        // 媒体读取工具单轮调用上限：防 LLM 一轮并发调用几十个 read_image/read_video，
        // 瞬间产生大量视觉代理/上传请求撑爆内存与限流。超出部分拒绝执行并回喂引导信息。
        // 计数器按轮创建（每轮 tool loop 各自 new），跨轮不累计——LLM 分批读取不受影响。
        var MAX_MEDIA_TOOL_CALLS_PER_ROUND = 5;
        function createMediaCallGuard() {
            var counts = { read_image: 0, read_video: 0 };
            return function (toolName) {
                if (toolName !== 'read_image' && toolName !== 'read_video') return true;
                return (++counts[toolName] <= MAX_MEDIA_TOOL_CALLS_PER_ROUND);
            };
        }
        function mediaCallLimitResult(toolName) {
            var _msg = '单轮最多调用 ' + MAX_MEDIA_TOOL_CALLS_PER_ROUND + ' 次 ' + toolName
                + '，本次调用已被拒绝且未读取文件。请分批读取（每轮不超过 ' + MAX_MEDIA_TOOL_CALLS_PER_ROUND
                + ' 个，分析完当前批次再读下一批）。';
            return {
                success: false,
                result: JSON.stringify({ status: 'error', message: _msg }, null, 2),
                error: 'MEDIA_CALL_LIMIT',
                parsed: { status: 'error', message: _msg }
            };
        }

        // plan 持久化改用 AEFS 磁盘文件（sessionStore.savePlan/loadPlan），
        // 替代 localStorage。理由：CEP 重启/扩展升级时 localStorage 可能被清，
        // 导致 sessionStore 恢复了会话但 plan 丢失。
        // persistPlan 采用 fire-and-forget + pending Promise 模式（参照 sessionStore 防抖写），
        // 关键切换点（switchSession 切走前/beforeunload）通过 flushPlan() 等待写盘完成。
        // plan 是 agent 专属功能，始终用 agentSessionStore（不用 getActiveStore），
        // 防 script 模式下 LLM 误调 trackSteps 导致 plan 写到 scriptStore。
        var _pendingPlanSave = Promise.resolve(false);

        // 会话/上下文层拆分——各工厂挂 AEEngine.createXxx()，见 controller/ 目录。
        // activePlan/_pendingPlanSave/_injectQueue 为 createController 作用域共享可变状态
        //（restorePlan/switchSession/clearConversation 等仍直接访问），经惰性 getter/setter 注入，
        // 运行时取值以保持原逻辑（与注入方式一致）。
        var intentValidation = global.AEEngine.createIntentValidation();
        var planTracking = global.AEEngine.createPlanTracking({
            agentSessionStore: agentSessionStore,
            agentContextManager: agentContextManager,
            getActivePlan: function () { return activePlan; },
            getPendingPlanSave: function () { return _pendingPlanSave; },
            setPendingPlanSave: function (v) { _pendingPlanSave = v; }
        });
        var contextCompression = global.AEEngine.createContextCompression({
            state: state,
            showStatus: opts.showStatus,
            chatViewHelpers: chatViewHelpers,
            getInjectQueue: function () { return _injectQueue; },
            view: view
        });

        // 媒体读取层 + 视觉代理层拆分——各工厂挂 AEEngine.createXxx()，见 controller/ 目录。
        // mediaReaders（convertPngToJpegViaCanvas/readImageStable/readVideoStable）自包含；
        // visionProxy 依赖的视觉代理状态（_hasVisionProxy/_visionProxyModelId/_visionProxyProviderId）
        // 由 controller 持有并写入，此处经惰性 getter 注入；resolveApiKeyForPlatform/readVideoStable/
        // intentValidation/llmChannel 亦经注入，运行时取值以保持原逻辑（与注入方式一致）。
        var mediaReaders = global.AEEngine.createMediaReaders();
        var visionProxy = global.AEEngine.createVisionProxy({
            getHasVisionProxy: function () { return _hasVisionProxy; },
            getVisionProxyModelId: function () { return _visionProxyModelId; },
            getVisionProxyProviderId: function () { return _visionProxyProviderId; },
            resolveApiKeyForPlatform: function (p) { return resolveApiKeyForPlatform(p); },
            readVideoStable: function (fp) { return mediaReaders.readVideoStable(fp); },
            getIntentValidation: function () { return intentValidation; },
            getLlmChannel: function () { return opts.llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel); },
            // 视觉代理请求也绑当前运行轮的 signal——停止能立即中止识图/识视频
            // 在途请求（gather 阶段尚无运行轮，getter 返回 null，行为不变）
            getAbortSignal: function () { return activeAbortController ? activeAbortController.signal : null; },
            persistVisionDesc: function (t) { persistVisionDesc(t); }
        });

        // vision/video hook 注入的媒体描述若仅进局部 messages 不落 cm，
        // 循环内压缩重建 messages（从 cm 回读）时会丢失——LLM 任务中途"失忆"
        // 已看过的画面。注入时同步以隐藏 user 消息落入 contextManager（UI 不渲染），
        // 保证压缩后（及后续请求重建上下文时）描述仍在。
        function persistVisionDesc(text) {
            if (!text) return;
            try {
                chatViewHelpers.getActiveCm().add('user', text, null, { _hidden: true });
                // 隐藏消息必须同时镜像进 state.messages（合并重赋值，与
                // pushSystemResult/render 等既有模式一致），否则两套数组出现 cm 比 state
                // 多 1 条/次的持续错位——cmIndexForStateIndex 的 offset 公式只处理 cm 比
                // state 少（头部裁剪/_local 不进 cm）的方向，错位后 editUserMessage
                // 换算出的下标比真实 cm 下标偏小，cm.updateMessage
                // 会改错消息、cm.truncateFrom 连同隐藏消息及其后消息一并错删（cm 是持久化
                // 真相源，删了不可恢复）。渲染层对 _hidden 消息跳过渲染，UI 无感知。
                // 改走 syncStateFromCm 合并重赋值——直接重赋值 cm.list() 会剥离
                // state 中的 _local 本地消息（/help 提示丢失、新 system-result 卡片因
                // _renderedCount >= messages.length 早退永不渲染）。上方 add 已在 cm 尾部
                // 追加 1 条隐藏消息，同步时传入新增计数以区分头部裁剪偏移。
                chatViewHelpers.syncStateFromCm(1);
                tokenStats.saveActiveSessionDebounced();
            } catch (_) {}
        }

        // getPreviewFrame 预览帧池的保留入口（agent / script 两条视觉钩子共用）。
        // 帧读完**不删**，改为池内保留最新 30 张、超出才按最旧先删——
        // Agent 可能复读同一张图（会话里再取一次同一路径），即删会让复读拿不到文件。
        // 池口径来自 AETempSweep.previewFrameTargets（temp/ae-tools 主目录 + temp 根回退目录，
        // 两目录合计最新 30 张）；数据目录拿不到时退化为「本帧所在目录」单目标（同一命名模式）。
        // 清理是尽力而为的后台动作：不 await、不抛（失败留给 ae-tools 的兜底清扫）。
        function _retainPreviewFramePool(framePath) {
            try {
                var sweep = global.AETempSweep;
                if (!sweep || typeof sweep.retainNewest !== 'function'
                    || typeof sweep.previewFrameTargets !== 'function') return;
                var targets = null;
                try {
                    var dd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir() : null;
                    if (dd && dd.dir) targets = sweep.previewFrameTargets(dd.dir);
                } catch (_) {}
                if (!targets) {
                    var fp = String(framePath || '');
                    var dir = fp.replace(/[\\\/][^\\\/]*$/, '');
                    if (!dir || dir === fp) return;   // 无目录成分（相对名/空串）→ 不猜路径
                    targets = [{ dir: dir, match: sweep.AE_PREVIEW_MATCH }];
                }
                var p = sweep.retainNewest({ targets: targets, keep: sweep.AE_PREVIEW_KEEP });
                if (p && typeof p.catch === 'function') p.catch(function () {});
            } catch (_) {}
        }

        // SSE 增量累积器工厂引用（processScriptToolLoop 每轮创建独立累积实例，
        // 见 controller/streamAccumulator.js；processToolLoop 的累积仍内联，见报告）。
        var createStreamAccumulator = global.AEEngine.createStreamAccumulator;

        async function restorePlan(sessionId) {
            try {
                if (!agentSessionStore || typeof agentSessionStore.loadPlan !== 'function') return;
                if (!sessionId) return;
                var steps = await agentSessionStore.loadPlan(sessionId);
                if (steps && Array.isArray(steps) && steps.length > 0) {
                    // 恢复时清除运行态标记（运行态不应跨会话保留）
                    for (var ri = 0; ri < steps.length; ri++) {
                        if (steps[ri]) steps[ri]._running = false;
                    }
                    activePlan.steps = steps;
                }
            } catch (e) {
                console.warn('[Agent] restorePlan error: ' + (e && e.message || e));
            }
        }
        const getSettings = opts.getSettings;
        const onStateChange = typeof opts.onStateChange === 'function' ? opts.onStateChange : function () {};
        const onScriptReady = typeof opts.onScriptReady === 'function' ? opts.onScriptReady : function () {};
        const getCurrentScript = typeof opts.getCurrentScript === 'function' ? opts.getCurrentScript : function () { return ''; };
        // 阻断式确认（清空对话等破坏性操作前确认）；未注入时默认不确认（拒绝），防误删
        const showConfirmFn = typeof opts.showConfirm === 'function' ? opts.showConfirm : function () { return Promise.resolve(false); };
        let stopRequested = false;
        let activeAbortController = null;
        let stopPromiseResolve = null;
        let _pendingImages = null;
        // requestStop 已触发但 processToolLoop 的 abort 清理（push 部分回复/finally）尚未跑完。
        // requestStop 同步把 state.busy 置 false 以即时反馈"已停止"，但 abort 的 .catch 是微任务、
        // 旧 loop 的 816 break→994 push→finally 要等 await resolve 才执行。这之间存在窗口：
        // 用户若在此窗口发新消息，submitUserInput 见 busy=false 走正常路径起新 processToolLoop，
        // 与旧 loop 的清理交错写 state.messages/contextManager → 消息错乱。
        // 故 submitUserInput 见 _stopping 仍走入队分支，等旧 loop finally 清 _stopping 后再放行。
        let _stopping = false;
        // ── 停止态判据的**唯一实现**（供注册进共享注册表的工具 handler 复用）──────
        // 为什么需要它：工具注册表只有**一份**（global AE_LLM.toolRegistry），而每条 runtime
        // （单 Agent / 团队三条 lane / 每个子 Agent）装配 controller 时都会把同名工具**再注册
        // 一遍**（注册表 last-wins）。于是「submit_shader 的 handler」可能是**另一条** runtime
        // 注册的那一份——它闭包里的 stopRequested / activeAbortController 指向的不是本次执行者。
        // 真机后果：进过一次团队模式 → 关团队时三条 lane 被 stopAll（requestStop 把它们的
        // stopRequested 置真且此后再无一轮会复位）→ 切到 shader 档发消息，当前轮工具循环照常跑
        // （它问的是真正在跑的那条 controller），但 submit_shader / submit_js_effect 用的是最后
        // 注册的那条 lane 的 handler ⇒ 每次都在入口回 {status:'stopped'}，最小 shader 也一样。
        // 修法：handler 侧停止复查一律经这里取值——**execCtx 里带执行侧判据时以它为准**
        //（toolExecutionPipeline 每次调用随 _execCtxOpts 下发，toolExecutor 抄进 handler 第二参），
        // 取不到才回落到本 runtime 自己的状态（旧装配 / 测试沙箱直接调 handler 的路径）。
        function stopRequestedForCtx(execCtx) {
            try {
                if (execCtx && typeof execCtx.getStopRequested === 'function') {
                    if (execCtx.getStopRequested()) return true;
                    var ctxSig = (typeof execCtx.getAbortSignal === 'function') ? execCtx.getAbortSignal() : null;
                    return !!(ctxSig && ctxSig.aborted);
                }
            } catch (_) { /* ctx 判据不可用 → 回落本 runtime（下方） */ }
            if (stopRequested) return true;
            return !!(activeAbortController && activeAbortController.signal && activeAbortController.signal.aborted);
        }
        // 运行轮 signal 的同款取值：提交/审查请求要绑**执行侧**的 signal（它才是用户「停止」
        // 会 abort 的那一个），ctx 有 getAbortSignal 时返回只读壳（消费方只读 .signal/.aborted，
        // 停止动作仍由 requestStop 负责），否则回落到本 runtime。
        // 「带 ctx 就**不回落**」是必须的（与 stopRequestedForCtx 同一口径）：回落会把本
        // runtime 的旧 signal 塞给另一个执行者的调用——真机上表现为「别的 lane 停了，
        // 本轮的审查请求一起被 abort 成 MODEL_REVIEW_FAILED」（ctx 说没有 signal 就是没有）。
        function abortControllerForCtx(execCtx) {
            try {
                if (execCtx && typeof execCtx.getAbortSignal === 'function') {
                    return { signal: execCtx.getAbortSignal() || null, abort: function () {} };
                }
            } catch (_) { /* ctx 判据不可用 → 回落本 runtime（下方） */ }
            return activeAbortController;
        }
        // switchSession 并发锁：快速连点/并发调用时第二个切换直接拒绝，
        // 防两个切换流程交错写 contextManager（旧会话文件被写成新会话消息）。
        var _switching = false;
        // switchMode 自身单飞锁：其守卫链只读 _switching，
        // 而该锁仅在内层 switchSession 才置位——模式段快速双击时第二次调用会在
        // planTracking.flushPlan/curStore.flush 等首个 await 窗口内穿过守卫：两次各自
        // saveSettings('agent') 后，一个抢到 _switching 成功切会话，另一个撞锁返回 busy
        // 并按入口快照把 runtimeMode 回滚成 script → settings/UI 停在 script 而
        // state.sessionId 已是 agent 会话，getActiveCm() 按 settings 返回 script cm，
        // 下一条消息静默写进 script 会话。入口同步置位、try/finally 释放。
        var _modeSwitching = false;
        // 消息编辑互斥锁。editUserMessage
        // 入口守卫通过后的 gather/读图/showConfirm 的 await 窗口内不设 state.busy
        // （busy 要到 _runUserRequest 才置位），期间 submitUserInput 照常放行会并发
        // 起第二个工具循环、且新消息刚持久化即被编辑路径的 cm.truncateFrom 删除。
        // 置位期间 submitUserInput 等入口经 getMsgActionBusy 注入拒绝（不入队：
        // 编辑截断会清空队列，入队等于静默丢弃）。
        var _msgActionBusy = false;
        // 团队 lane 的**历史回读**状态（详细契约见 adoptSession 上方的注释块）：
        //   _adoptSeq        — 回读世代号：每次下发 +1，晚到的旧结果一律作废；
        //   _adoptRestoring  — 未落地的回读计数（>0 时 getSwitching 为真 ⇒ 提交被拒）；
        //   _adoptReadFailedSid — 读失败的会话 id：该会话一律不做覆盖性写。
        // 为什么声明在这里而不是 adoptSession 旁边：**switchSession 也要 bump 世代号**
        //（任何「同 sid 重新 import」的路径都会让迟到的旧回读把历史翻倍），
        // 而 switchSession 早于 adoptSession 的注释块；var 提升虽能让它可见，但
        // `_adoptSeq++` 在未初始化时会把 undefined 变成 NaN ⇒ 世代号比较永远为假、旧结果不再作废。
        var _adoptSeq = 0;
        var _adoptRestoring = 0;
        var _adoptReadFailedSid = null;
        // syncView 通知会话切换器 disable/enable 的防抖记忆（仅在 busy||_stopping 翻转时通知）
        var _lastSwitcherLocked = false;

        // 执行中用户追加的消息队列：不打断当前轮，下一轮 LLM 调用前注入。
        // requestStop 时若有队列，stop 不退出循环，重置后继续——让 Agent 马上看到。
        var _injectQueue = [];
        // drain 消费点（processToolLoop 循环 / Agent 与 Script 分支 finally
        // drain / _drainScriptQueueAndRecurse）共用的跨会话条目判定——入队条目携带
        // sessionId（injectSystemMessage/injectSystemResult 守卫分支写入）且不等于
        // 当前会话时，该条目须路由回原会话（apiActions.appendToSession），不得写入
        // 当前 cm 或触发当前会话 LLM（会话切换窗口内入队的结果否则会写进错误会话，
        // 原会话永久丢失该结果）。
        function _isCrossSessionInject(inj) {
            return !!(inj && inj.sessionId && inj.sessionId !== chatViewHelpers.getActiveCm().getSessionId());
        }
        // ── 会话级 goal ────────────────────────────────────
        // 持久部分落在会话索引条目（store.getGoal/setGoal）；这里只持内存快照 + 进程本地
        // activation —— 面板重载/会话边界一律 disarm，必须人 /goal resume 才继续。
        // 状态机单一实现在 engine/goalState.js，本文件只做接线，不复制判据。
        var _goal = null;
        var _goalArmed = false;
        // goal 续轮系统卡的标题前缀（唯一一份）：注入侧拼标题、队列清理侧识别陈旧卡都用它。
        var GOAL_ROUND_TITLE_PREFIX = '目标续轮 ';
        // 当前轮由谁发起：user | goal | bg | system | subagent。工具权限与停止语义按它分流。
        var _turnOrigin = (opts.isSubagent === true) ? 'subagent' : 'user';
        // 收尾方式标记：clean | stop | limit | error（driver 只对自然收尾续轮；瞬时失败另经
        // _noteRoundEndForGoal 走 'error-retry' 时机补评估）
        var _roundEndKind = 'clean';
        // _runUserRequest 运行序号：队列续轮以递归方式起新一轮，收尾音只由**最新一轮**播报
        // （判定见 Script 分支 finally）。不用「嵌套深度计数」是因为深度必须在 finally 尾部
        // 归还，finally 中部一旦抛异常就会永久泄漏 → 完成音从此静默；序号只增不还，无此风险。
        var _reqRunSeq = 0;
        var _goalDriver = null;
        function _goalState() { return global.AEEngine && global.AEEngine.goalState; }
        function _goalSupported() {
            if (opts.isSubagent === true) return false;
            if (opts.isTeamMode && opts.isTeamMode()) {
                // 团队档：只有导演 lane 有目标；主 Agent 通道也没有
                return getLaneId() === 'director';
            }
            // 单 Agent：走工具循环的三档（agent / shader / script）都能续轮。Script 档自
            // 续轮落点（见 _runUserRequest 的 Script 收尾分支调 _kickGoalDriver），
            // 该链缺失时，Script 档给了目标只会「建了但永不继续」。
            var mode = '';
            try { mode = (getSettings() || {}).runtimeMode || ''; } catch (_e) { mode = ''; }
            return mode === 'agent' || mode === 'shader' || mode === 'script';
        }
        function _goalDefaultRounds() {
            var st = null;
            try { st = getSettings(); } catch (_) { st = null; }
            var v = st && st.goalDefaultMaxRounds;
            return (typeof v === 'number' && isFinite(v)) ? v : 25;
        }
        // 目标所属存储与会话：单 Agent = 当前模式 store + 当前会话；
        // 团队导演 = 本 lane 的 store + 团队会话（binder 的 currentSid，不用 lane 私域）。
        function _goalStoreAndSid() {
            var store = chatViewHelpers.getActiveStore();
            var sid = '';
            if (opts.isTeamMode && opts.isTeamMode()) {
                var binder = (global.AEEngine && typeof global.AEEngine.getSessionBinder === 'function')
                    ? global.AEEngine.getSessionBinder() : null;
                sid = (binder && typeof binder.getCurrentSessionId === 'function')
                    ? (binder.getCurrentSessionId() || '') : '';
            } else {
                var cm = chatViewHelpers.getActiveCm();
                sid = (cm && typeof cm.getSessionId === 'function') ? (cm.getSessionId() || '') : '';
            }
            return { store: store, sid: sid };
        }
        // 起轮时刻是否真的空闲（goal 续轮唯一一份判据，注入 driver 的 isIdle）。
        // 轮内（busy）、会话切换/回读、编辑互斥窗口、停止清理、**用户消息派发锁**期间都不算空闲。
        // 派发锁在 submitUserInput 的 await 期间一直持有：轮收尾时它还没释放，此时起轮
        // 只会被 injectSystemResult 改成入队（不落卡、不唤起），所以必须等 onDispatchEnd。
        // **stopRequested 不在判据里**：它是「本轮应停」的轮内状态，空闲时也可能
        // 被残留置真（团队整队切换 stopAll 会对空闲 lane 调 requestStop；用户空闲点停止同理），
        // 而它只在轮收尾/派发器复查点复位——空闲残留不代表有活要停，唯一有意义的清理窗口是
        // _stopping（下面已判）。把它算进空闲会让 goal 在团队新会话里永久起不了轮。
        function _goalIdleNow() {
            if (state.busy || state.restoring || _stopping
                || _switching || _adoptRestoring > 0 || _msgActionBusy) return false;
            if (typeof inputDispatch !== 'undefined' && inputDispatch
                && typeof inputDispatch.getDispatching === 'function') {
                return !inputDispatch.getDispatching();
            }
            return true;
        }
        // goal 续轮评估的统一入口（时机由调用方给，判据全在 driver）。
        // 本函数只吞异常，不做任何状态判断；重复调用安全（driver 判据内建 active/armed/额度）。
        function _kickGoalDriver(reason) {
            if (!_goalDriver) return null;
            try {
                return _goalDriver.evaluate(reason || 'kick');
            } catch (e) {
                console.warn('[Agent] goal 续轮评估失败: ' + ((e && e.message) || e));
                return null;
            }
        }
        // ── 瞬时请求失败后的目标自动续轮 ─────────────────────────────────────
        // driver 只对 clean 收尾续轮（用户停止/轮数上限不续），瞬时失败（超时/网络/
        // 可重试状态码）也应让目标继续跑，否则一次 120s 超时就把目标永久卡在「进行中」。
        // 做法：延迟后以独立 reason 'error-retry' 补一次 driver 评估——该 reason 不经过
        // driver 的 clean 闸门，让行/额度/空闲等其余判据照常生效。
        // 判据「哪些失败算瞬时」在 llmRetry.isTransient（单实现）；这里只做连续失败计数、
        // 退避定时器与上限——超限把目标转 blocked（原因写明最后一次失败），避免 API 长时
        // 不可用时无限自动重试。
        // 轮次照常经 driver 消耗（目标轮数上限仍是总预算）；失败轮次已计入 roundsStarted。
        var GOAL_ERROR_RETRY_MAX = 3;
        var GOAL_ERROR_RETRY_DELAY_MS = (opts.goalErrorRetryDelayMs != null)
            ? Math.max(0, Number(opts.goalErrorRetryDelayMs) || 0) : 5000;
        var _roundErrorFailure = null;   // 最近一轮 error 收尾的失败结果（瞬时判定用；轮初清空）
        var _goalErrorStreak = 0;        // 连续瞬时失败轮数（clean 收尾或人工干预清零）
        var _goalRetryTimer = null;
        function _cancelGoalRetry() {
            if (_goalRetryTimer) { clearTimeout(_goalRetryTimer); _goalRetryTimer = null; }
        }
        function _scheduleGoalRetry() {
            _cancelGoalRetry();
            _goalRetryTimer = setTimeout(function () {
                _goalRetryTimer = null;
                if (!_goal || _goal.phase !== 'active' || !_goalArmed || !_goalSupported()) return;
                _kickGoalDriver('error-retry');
            }, GOAL_ERROR_RETRY_DELAY_MS);
        }
        // 轮收尾时调用（在 _kickGoalDriver('round-end') 之前）：clean 清零；瞬时失败计一次
        // 连续失败，未超上限则延迟续轮，超限把目标转 blocked。
        function _noteRoundEndForGoal(failure) {
            if (_roundEndKind === 'clean') {
                _goalErrorStreak = 0;
                _cancelGoalRetry();
                return;
            }
            if (_roundEndKind !== 'error') {
                // 停止 / 轮数上限属用户或预算收尾：不自动续轮
                _goalErrorStreak = 0;
                _cancelGoalRetry();
                return;
            }
            var transient = false;
            try { transient = !!(failure && llmRetry.isTransient(failure)); } catch (_) { transient = false; }
            if (!transient) {
                // 确定性失败（鉴权/请求体等）不自动续轮；计数清零，避免与瞬时失败混算成连续
                _goalErrorStreak = 0;
                _cancelGoalRetry();
                return;
            }
            _goalErrorStreak++;
            if (!_goal || _goal.phase !== 'active' || !_goalArmed || !_goalSupported()) return;
            if (_goalErrorStreak > GOAL_ERROR_RETRY_MAX) {
                _cancelGoalRetry();
                try {
                    _goalApi.block({ ref: _goal.revision,
                        reason: AEI18n.t('流式请求失败: {detail}', { detail: failure.message || failure.error || '' }) });
                } catch (_) {}
                return;
            }
            _scheduleGoalRetry();
        }
        // 作废「已排进待发送队列的 goal 续轮卡」：goal 暂停/完成/受阻/清除，或会话边界 disarm
        // 之后，旧卡不能再被 drain 起来当一轮跑——否则用户看到的是「目标已经取消了，它还在干活」
        // （真机：/goal clear 后队列里那张卡被 drain，模型接着按 <goal_round> 继续）。
        // 主路径不会再把续轮卡入队（driver 的空闲判据在消耗轮次前拦截），
        // 这里清的是旧包/竞态留下的条目。
        function _purgeQueuedGoalRounds() {
            var dropped = 0;
            for (var i = _injectQueue.length - 1; i >= 0; i--) {
                var it = _injectQueue[i];
                if (it && it.systemResult && typeof it.title === 'string'
                    && it.title.indexOf(GOAL_ROUND_TITLE_PREFIX) === 0) {
                    _injectQueue.splice(i, 1);
                    dropped++;
                }
            }
            if (dropped) {
                // 待发送抽屉/发送按钮按当前队列重绘（否则清掉的卡还挂在 UI 上）
                try { onStateChange(state); } catch (_) { /* UI 刷新失败不影响状态 */ }
            }
            return dropped;
        }
        // 人主动暂停/清除目标时，若正在跑的正是 Goal Round，连带中止当前轮（用户说停就停，
        // 不等模型自己收尾；DSH 宿主侧暂停同语义）。cause 用非 'user' 值，避免
        // requestStop 再触发一次 goal 暂停（防递归）。
        function _abortRunningGoalRound(why) {
            if (_turnOrigin !== 'goal' || !state.busy) return;
            try {
                if (_api && typeof _api.requestStop === 'function') _api.requestStop(why || 'goal-cancel');
            } catch (_) { /* 中止失败不影响状态变更 */ }
        }
        function _notifyGoalChanged() {
            try {
                if (typeof document !== 'undefined' && document.dispatchEvent && typeof CustomEvent === 'function') {
                    document.dispatchEvent(new CustomEvent('ae:goal-changed'));
                }
            } catch (_) { /* UI 通知失败不影响状态 */ }
        }
        function _persistGoal() {
            var ref = _goalStoreAndSid();
            if (!ref.store || !ref.sid || typeof ref.store.setGoal !== 'function') return;
            try { ref.store.setGoal(ref.sid, _goal); } catch (e) {
                console.warn('[Agent] goal 落盘失败: ' + ((e && e.message) || e));
            }
        }
        function _applyGoalResult(res) {
            if (!res || !res.ok) {
                return res || { ok: false, code: 'GOAL_INVALID_ARGS', message: '未知错误' };
            }
            _goal = res.goal;
            _persistGoal();
            _notifyGoalChanged();
            return res;
        }
        // 会话边界重读：一律 disarm（重开面板要 /goal resume）
        function _reloadGoal() {
            var G = _goalState();
            var ref = _goalStoreAndSid();
            _goalArmed = false;
            // 会话边界：上一会话失败轮的自动续轮定时器与连续失败计数一并作废
            _cancelGoalRetry();
            _goalErrorStreak = 0;
            // 会话边界 disarm ⇒ 已入队的续轮卡一并作废（切走会话后不能再拿旧卡的 <goal_round>
            // 在新会话/新一轮里起跑）
            _purgeQueuedGoalRounds();
            if (!G || !ref.store || !ref.sid || typeof ref.store.getGoal !== 'function') {
                _goal = null;
                _notifyGoalChanged();
                return;
            }
            var raw = null;
            try { raw = ref.store.getGoal(ref.sid); } catch (_) { raw = null; }
            _goal = G.normalizeGoal(raw);
            _notifyGoalChanged();
        }
        // 通道不支持时的统一拒绝（可见性由 _buildRoundTools 黑名单挡，这里是执行侧兜底：
        // 注册是全局共享的，别的通道注册的 handler 也可能被本通道调到）。
        function _goalUnsupportedResult() {
            return { ok: false, code: 'GOAL_AUTHORITY_REQUIRED',
                message: '当前通道不支持目标（单 Agent 的 Agent/Script/Shader 档与团队导演支持）' };
        }
        function _goalApiOf() {
            return {
                get: function () { return _goal; },
                isArmed: function () { return _goalArmed; },
                origin: function () { return _turnOrigin; },
                setOrigin: function (o) { _turnOrigin = o || 'user'; },
                // arm 语义 = 「续轮已启用」，若此刻空闲就立刻评估起轮。
                // 人面 `/goal <目标>` 在空闲时建目标后不应停在 0/25 不动；模型侧 create_goal
                // 在轮内 arm 时 isIdle 为假，评估直接让行，轮收尾后由正常时机接手。
                // arm 视为人工介入：连续失败计数清零，自动续轮预算重新给满。
                arm: function () {
                    if (_goalSupported()) {
                        _goalErrorStreak = 0;
                        _cancelGoalRetry();
                        _goalArmed = true;
                        _kickGoalDriver('goal-armed');
                    }
                },
                disarm: function () { _goalArmed = false; _cancelGoalRetry(); },
                supported: _goalSupported,
                defaultRounds: _goalDefaultRounds,
                reload: _reloadGoal,
                canStartRound: function () {
                    var G = _goalState();
                    return !!(G && G.canStartRound(_goal, _goalArmed ? 'armed' : 'disarmed'));
                },
                create: function (args) {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var G = _goalState();
                    var a = args || {};
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    return _applyGoalResult(G.create({
                        previous: _goal, objective: a.objective,
                        maxGoalRounds: (a.maxGoalRounds != null) ? a.maxGoalRounds : _goalDefaultRounds(),
                        id: a.id, now: Date.now()
                    }));
                },
                edit: function (args) {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var G = _goalState();
                    var a = args || {};
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    return _applyGoalResult(G.edit(_goal, {
                        ref: a.ref, objective: a.objective, maxGoalRounds: a.maxGoalRounds, now: Date.now()
                    }));
                },
                pause: function (args) {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var G = _goalState();
                    var a = args || {};
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    var res = _applyGoalResult(G.pause(_goal, { ref: a.ref, pausedBy: a.pausedBy, now: Date.now() }));
                    if (res.ok) {
                        _goalArmed = false;
                        _goalErrorStreak = 0;
                        _cancelGoalRetry();
                        _notifyGoalChanged();
                        _purgeQueuedGoalRounds();
                        // 引擎在用户点停止时调用的 pause（pausedBy='stop'）不要反过来再 requestStop
                        if (a.pausedBy !== 'stop') _abortRunningGoalRound('goal-paused');
                    }
                    return res;
                },
                resume: function (args) {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var G = _goalState();
                    var a = args || {};
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    var res = _applyGoalResult(G.resume(_goal, { ref: a.ref, maxGoalRounds: a.maxGoalRounds, now: Date.now() }));
                    if (res.ok) {
                        _goalArmed = true;
                        _goalErrorStreak = 0;
                        _cancelGoalRetry();
                        _notifyGoalChanged();
                        _kickGoalDriver('goal-resumed');
                    }
                    return res;
                },
                complete: function (args) {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var G = _goalState();
                    var a = args || {};
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    var res = _applyGoalResult(G.complete(_goal, { ref: a.ref, now: Date.now() }));
                    if (res.ok) {
                        _goalArmed = false;
                        _goalErrorStreak = 0;
                        _cancelGoalRetry();
                        _notifyGoalChanged();
                        _purgeQueuedGoalRounds();
                    }
                    return res;
                },
                block: function (args) {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var G = _goalState();
                    var a = args || {};
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    var res = _applyGoalResult(G.block(_goal, { ref: a.ref, reason: a.reason, now: Date.now() }));
                    if (res.ok) {
                        _goalArmed = false;
                        _goalErrorStreak = 0;
                        _cancelGoalRetry();
                        _notifyGoalChanged();
                        _purgeQueuedGoalRounds();
                    }
                    return res;
                },
                clear: function () {
                    if (!_goalSupported()) return _goalUnsupportedResult();
                    var ref = _goalStoreAndSid();
                    _goal = null;
                    _goalArmed = false;
                    _goalErrorStreak = 0;
                    _cancelGoalRetry();
                    if (ref.store && ref.sid && typeof ref.store.setGoal === 'function') {
                        try { ref.store.setGoal(ref.sid, null); } catch (_) {}
                    }
                    _purgeQueuedGoalRounds();
                    // 人点「清除」时若 Goal Round 正在跑，一并中止（用户意图是「不要了」）
                    _abortRunningGoalRound('goal-cleared');
                    _notifyGoalChanged();
                    return { ok: true, goal: null };
                }
            };
        }
        // goal 三工具的注册动作（创建时一次 + 通道切换时由 bootstrap 再抢一次 last-wins）。
        function _registerGoalTools() {
            if (opts.isSubagent === true) return 0;
            if (!global.AEEngine || typeof global.AEEngine.createGoalTools !== 'function') return 0;
            var defs = global.AEEngine.createGoalTools({ goalApi: _goalApiOf() });
            var n = 0;
            for (var i = 0; i < defs.length; i++) {
                if (defs[i] && defs[i].name) { toolRegistry.register(defs[i]); n++; }
            }
            return n;
        }
        // 在指定下标处插入（越界/非法则追加）。仅用于「打断时补写被中断那一轮的半成品」——
        // 该消息落库晚于打断时写入的用户消息，追加会造成「user(打断者) → assistant(被打断)」错序；
        // state.messages（UI 侧）与 contextManager（LLM 侧）各有一份下标，故两处分别调用。
        function _spliceAt(arr, at, msg) {
            var idx = Number(at);
            if (!isFinite(idx)) idx = arr.length;
            idx = Math.max(0, Math.min(arr.length, Math.floor(idx)));
            arr.splice(idx, 0, msg);
            return idx;
        }
        // 轮初最后一条 cm 消息的**对象引用**（引用锚），两条循环共用（同一时刻只有一条在跑）。
        // 轮内每次工具结果/追加消息落库都会 pruneByTokens（总量越过上限即从头部 splice），
        // 头部被删 K 条后轮初记的纯数字下标前移错位——中断/网络错误补写若照用会把半成品
        // 插到错误位置（甚至劈开当前轮工具组，toLlmMessages 归拢遇中间 assistant 停止扫描 →
        // 真实工具结果被 [已中断] 占位顶替）。手法与 _grpAnchorCm 同族（引用定位，不惧裁剪位移）。
        var _roundStartCmAnchor = null;
        // 打断/网络错误补写的**当前**落点：引用锚之后一位，插入时现算（不能缓存下标——同一次
        // 中断前可能已发生裁剪）。锚点引用已不在列表（轮初消息连同更早的都被删）→ 返回 0：
        // 轮初位置本就在头部，插到 0 位最接近原意（半成品仍排在打断消息之前，且不劈组）。
        function _roundStartInsertIndex(cm) {
            var l = cm.list();
            if (!_roundStartCmAnchor) return 0;
            var i = l.indexOf(_roundStartCmAnchor);
            return i >= 0 ? i + 1 : 0;
        }
        // 打断补写若落在列表**中间**（当前轮内有消息追加，典型是「立刻发送」的用户消息），
        // 必须强制全量重渲染：view.renderMessages 的增量语义是「只追加尾部」（按
        // _renderedCount 往后画），插在中间的消息画不出来，且会让已渲染的末条被重复追加
        // 一次——实测症状正是「只发了一次『等等』却显示两条 + 被打断那轮的思考块消失」。
        // 调用点：打断/网络错误补写半成品之后（见 _roundStart*Idx 定义处）。
        // 判据必须用**不受裁剪影响**的 UI 侧状态——拿 cm 侧
        // 长度与 _roundStartCmIdx 比对，而轮内 pruneByTokens 从前端删头后 cmLen 可 ≤ 轮初下标
        //（裁剪 K ≥ 当前轮新增时恒 false），长会话下中间插入的 [已中断] 段画不出来、已渲染末条
        // 被重复追加。state.messages 不参与裁剪（prune 只动 cm），轮内消息落库只增不减，故
        // 「插入前 UI 长度 > 轮初 UI 下标」精确等价于「当前轮确实追加过消息 → 插入落在中段」。
        function _forceFullRerenderIfMidList(uiLenBeforeInsert, roundStartUiIdx) {
            if (!(uiLenBeforeInsert > roundStartUiIdx)) return;   // 纯追加（无当前轮消息）→ 增量渲染本就正确
            _forceFullRerenderNow();
        }
        // 中间插入后的强制整表重渲染（同上，无条件版）——工具结果的锚位落库也走它。
        function _forceFullRerenderNow() {
            if (view && typeof view.clearStreaming === 'function') view.clearStreaming();
            if (view && typeof view.resetRenderedCount === 'function') view.resetRenderedCount();
            // 全量重建即将发生（按当前 debug 态重绘），调试开关登记的那次待重建随之作废——
            // 不清掉的话，下一条合格 syncView 会再整表重建一次（还把列表强拉到底）。
            // 本条路径多发生在 busy 中：chatViewHelpers 的闸门挡下消费，故这里显式清

            state.debugRebuildPending = false;
        }
        // ── 当前轮工具结果的锚位落库（打断错序修复，「立刻发送」的第二处）──────────
        // 「立刻发送」的用户消息在**点击瞬间**就落库到尾部（apiActions.sendInjectItem），
        // 而当前轮剩下的工具结果（打断时正在执行的那个的真实结果 + 停止后的 [已停止] 占位）
        // 是随后才落库的——按追加会让 cm 与 state.messages 出现「user(打断者) → tool 结果」
        // 的错序：面板上表现为「已停止」的工具卡显示在打断消息下方（同族的半成品 assistant
        // 错序由 _roundStart*Idx 锚位修复，见上）。
        // 修法：assistant(tool_calls) 落库后记锚点**引用**，其后每个工具结果落库时若
        // 尾部已被挤开（期望位置之后还有消息）就插回当前轮产出之后。用 indexOf 按引用定位，
        // 不受 pruneByTokens 从前端裁剪（删头部）导致的下标漂移影响；锚点引用已不在列表里
        //（被裁剪）时退化为追加——请求层归拢仍保证报文合法，只是显示顺序不会因此变差。
        function _toolGroupExpectedIndex(list, anchor, last) {
            var from = last || anchor;
            if (!from) return -1;
            var i = list.indexOf(from);
            return i < 0 ? -1 : i + 1;
        }
        // 追加或插回；返回 true 表示落在列表中段（调用方需强制整表重渲染）
        function _pushToolMsgAnchored(list, anchor, last, msg) {
            var at = _toolGroupExpectedIndex(list, anchor, last);
            if (at < 0 || at >= list.length) { list.push(msg); return false; }
            list.splice(at, 0, msg);
            return true;
        }
        // cm 侧同款（add / insertToolResultAt 二选一），返回落库后的消息对象供下一条锚位用
        function _pushToolResultToCm(cm, anchor, last, toolCallId, toolName, text, detail, extra) {
            var at = _toolGroupExpectedIndex(cm.list(), anchor, last);
            if (at < 0 || at >= cm.list().length) return cm.addToolResult(toolCallId, toolName, text, detail, extra);
            return cm.insertToolResultAt(at, toolCallId, toolName, text, detail, extra);
        }
        // "立刻发送"时暂存的其余待发送条目：打散的当前轮结束后恢复，避免循环出口整队 drain 误发。
        var _deferQueue = [];
        // "立刻发送"的该条文本：打断当前轮后，循环出口据此立即起新一轮只处理这一条。
        var _forcedInjectText = null;
        var _visionModelName = '';
        var _visionPlatform = '';
        // 视觉代理模型：非视觉主模型遇到图片/截图时，后台用此模型转中文描述
        var _visionProxyProviderId = '';
        var _visionProxyModelId = '';
        var _hasVisionProxy = false;
        // 当前工具循环的用户原始需求文本（executeExtendScript LLM 审查的上下文用）
        var _currentUserText = '';
        // stub 工具名集合：每轮工具循环构建 tools 时同步填充。
        // 判据是注册表装配时写出的 _needsToolSearch（stub 且有参数），与描述里的
        // ' [stub]' 标记同源（toolRegistry._assembleStubDefs）——无参数 stub 工具没有
        // schema 可猜、描述也不带标记，直调放行。旧定义/测试桩只有 _isStub 时回落它。
        var _stubToolNames = null;

        // 每轮工具集组装 + 轮次状态同步（agent/shader 与 script 两个轮次构建点共用）：
        //   ① buildLlmTools：作用域过滤 + 语义门控，并经出参拿到「门控报告」（被门控收起的名字→原因码）；
        //   ② _stubToolNames：executeToolCall 据此判断是否需要前置 tool_search
        //     （_needsToolSearch，旧定义回落 _isStub）；
        //   ③ state.roundToolNames / state.roundGateReasons：执行侧两道轮次闸门的数据源
        //     （toolExecutionPipeline「门控不可用」+「当前轮投放清单」）——门控口径「不可用」
        //     的落点：关掉开关不只是"模型看不见"，而是"调用被拒"。
        // goal 三工具的名字（可见性/黑名单共用；注册是 controller 级的静态动作，而
        // runtimeMode / 团队开关会变 ⇒ 可见性必须每轮现算，见 _buildRoundTools）。
        var GOAL_TOOL_NAMES = ['get_goal', 'create_goal', 'update_goal'];

        function _buildRoundTools(moduleId, tOpts) {
            tOpts = tOpts || {};
            tOpts.gateReasons = Object.create(null);
            // askUser 在团队档只给导演 lane。执行 lane 由
            // team/lanes.js 的 execLaneToolFilter 剔除；这里兜**团队主 Agent 通道**
            //（团队档下的单 Agent runtime：无 lane 身份、不走 lane filter）。不拦的话
            // 主通道会拿到一件一调就回 unavailable 的工具（handler 会 fail-closed，但模型
            // 白浪费一轮）。黑名单同时写进 gateReasons ⇒ 执行侧按 MODE_BLACKLIST 拒调用
            //（与「关掉联网搜索」同一条闸门，投放与执行读同一份报告）。
            if (typeof opts.isTeamMode === 'function' && opts.isTeamMode() && getLaneId() !== 'director') {
                var _askName = (global.AEEngine && global.AEEngine.askUserTool)
                    ? global.AEEngine.askUserTool.NAME : 'askUser';
                tOpts.blacklist = (Array.isArray(tOpts.blacklist) ? tOpts.blacklist : []).concat([_askName]);
            }
            // goal 三工具：单 Agent 三档（Agent/Script/Shader，Script 档也支持目标）与
            // 团队导演 lane 可见。注册是 controller 创建时的静态动作，
            // 但 runtimeMode（script↔agent）与团队开关会在同一条 runtime 上变 ⇒ 可见性必须每轮现算：
            // 否则启动在 Script 档就永远没有 goal 工具（切到 Agent 档也不补），团队主通道又会拿到它
            // 不该有的目标工具。
            if (!_goalSupported()) {
                tOpts.blacklist = (Array.isArray(tOpts.blacklist) ? tOpts.blacklist : [])
                    .concat(GOAL_TOOL_NAMES);
            }
            // ── 投放（第一处消费点）：可见性全部交给闸口 ────────────────────
            // 改造前这里按 lane 并联身份 + 收窄判据调 toolGating.buildLlmTools（注册表 scope 过滤 +
            // filter）；现改为 gate.defsFor(viewId, extraFilter)——scope 只是闸口的「默认」输入，
            // 用户 enabled 可放宽到 scope 之外，故不能再先按 scope 过滤。
            // toolGating 只保留语义门控（视觉/视频/联网/黑名单）与 gateReasons 补空位。
            var _gate = getToolVisibility();
            var _viewId = _viewIdForRound(moduleId);
            var _extraFilter = _roundExtraFilter();
            var _gateFilter = _gate ? _gate.filterFor(_viewId, _extraFilter) : null;
            _roundVisibility = _gate ? {
                gate: _gate,
                viewId: _viewId,
                extraFilter: _extraFilter,
                filter: _gateFilter,
                moduleLabel: _gate.identityOf(_viewId).moduleIds[0] || ''
            } : null;
            // stub 工具上限同步到注册表：防加载顺序导致上限未生效。
            // 0 表示不限制；被裁工具仍可经 tool_search 获取完整定义。
            try {
                var _llmRegForLimit = opts.toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry) || null;
                var _bt = Number(getSettings().maxLlmStubTools);
                if (_llmRegForLimit && typeof _llmRegForLimit.setMaxLlmStubTools === 'function') {
                    _llmRegForLimit.setMaxLlmStubTools(_bt > 0 ? _bt : 0);
                }
            } catch (_) {}
            // 闸口原因表先行：覆盖全部注册条目（锁定 / 用户关闭 / 默认不可见 / 依赖隐藏），
            // 语义门控只填空位（原因码优先级）——否则会把 USER_DISABLED 盖成 WEB_SEARCH_DISABLED。
            var _visReasons = _gate ? _gate.allReasons(_viewId, _extraFilter) : null;
            if (_visReasons) {
                var _vrk = Object.keys(_visReasons);
                for (var _vri = 0; _vri < _vrk.length; _vri++) tOpts.gateReasons[_vrk[_vri]] = _visReasons[_vrk[_vri]];
            }
            var _candidateDefs = _gate ? _gate.defsFor(_viewId, _extraFilter) : [];
            if (!_gate && !_gateWarned) {
                _gateWarned = true;
                try {
                    console.warn('[Agent] 工具可见性闸口未装配（AE_LLM.createToolVisibility 缺席）：本轮不投放任何工具');
                } catch (_) { /* 日志失败不影响判定 */ }
            }
            var tools = toolGating.applySemanticGating(_candidateDefs, tOpts);
            var _roundNames = new Set();
            _stubToolNames = new Set();
            for (var _rti = 0; _rti < tools.length; _rti++) {
                var _rtTool = tools[_rti];
                var _rtName = _rtTool && _rtTool.function && _rtTool.function.name;
                if (!_rtName) continue;
                _roundNames.add(_rtName);
                // 需先 tool_search 的判据与描述里的 ' [stub]' 标记同源（注册表装配时派生）；
                // 只有 _isStub 的旧定义/测试桩回落旧语义（stub 即拦）。
                var _needsSearch = (_rtTool._needsToolSearch !== undefined)
                    ? _rtTool._needsToolSearch
                    : _rtTool._isStub;
                if (_needsSearch) _stubToolNames.add(_rtName);
            }
            state.roundToolNames = _roundNames;
            state.roundGateReasons = tOpts.gateReasons;
            return tools;
        }
        // 诊断/审计查询面（各视图清单 dump；观测手段）：
        // 按指定视图现算最终投放清单，不改变当前轮状态。走同一个闸口与同一语义门控，与生产轮次同源。
        function buildViewTools(viewId, tOpts) {
            tOpts = tOpts || {};
            tOpts.gateReasons = tOpts.gateReasons || Object.create(null);
            var gate = getToolVisibility();
            if (!gate) return [];
            var extraFilter = _roundExtraFilter();
            var reasons = gate.allReasons(viewId, extraFilter);
            var keys = Object.keys(reasons);
            for (var i = 0; i < keys.length; i++) {
                if (!tOpts.gateReasons[keys[i]]) tOpts.gateReasons[keys[i]] = reasons[keys[i]];
            }
            return toolGating.applySemanticGating(gate.defsFor(viewId, extraFilter), tOpts);
        }
        function listToolViews() {
            var gate = getToolVisibility();
            return gate ? gate.views() : [];
        }
        // 固定开销（system prompt + tools）的唯一估算公式：轮内写入与启动期估算同源。
        function _estimateFixedOverheadOf(systemPrompt, tools) {
            var cm = null;
            try { cm = chatViewHelpers.getActiveCm(); } catch (_) { cm = null; }
            var est = (cm && typeof cm.estimateTokens === 'function')
                ? function (t) { return cm.estimateTokens(t); }
                : function (t) { return Math.ceil(String(t || '').length / 4); };
            return est(systemPrompt) + est(JSON.stringify(tools || []));
        }
        // 按本 controller 身份估算固定开销：不发请求、不改轮次状态。
        // bootstrap 在 lane 建出来后用它写入各自的 cm（每条 lane 的工具集/骨架不同，
        // 不能沿用别的 lane 的测量值）。
        function estimateFixedOverhead() {
            try {
                var settings = getSettings() || {};
                var model = (typeof opts.getModel === 'function') ? opts.getModel() : (settings.model || '');
                var platform = (typeof opts.getPlatform === 'function') ? opts.getPlatform() : (settings.platform || '');
                var isShaderMode = settings.runtimeMode === 'shader';
                var _prompts = global.AEEngine && global.AEEngine.prompts;
                var kind = (opts.lane && typeof opts.lane.promptKind === 'string' && opts.lane.promptKind)
                    ? opts.lane.promptKind : (isShaderMode ? 'shader' : 'agent');
                var canVision = !!(model && global.AE_LLM && global.AE_LLM.supportsVision
                    && global.AE_LLM.supportsVision(model, platform));
                var canVideo = !!(model && global.AE_LLM && global.AE_LLM.supportsVideo
                    && global.AE_LLM.supportsVideo(model, platform));
                var basePrompt = (_prompts && typeof _prompts.buildToolSystemPrompt === 'function')
                    ? _prompts.buildToolSystemPrompt(kind, settings.userPersona || '', model, canVision, canVideo,
                        _hasVisionProxy,
                        // proxyCanVideo 只在轮内解析（异步读视觉代理模型能力），启动期按 false 估：
                        // 该行差异不到一行文本，不影响开销量级。
                        { currentShader: '', teamLane: !!getLaneId(), proxyCanVideo: false,
                            isToolVisible: _promptToolVisible })
                    : '';
                var promptBuilder = opts.promptBuilder || (global.AE_LLM && global.AE_LLM.promptBuilder);
                var systemPrompt = (promptBuilder && basePrompt)
                    ? promptBuilder.build(basePrompt, _promptBuildContext(isShaderMode ? 'shader' : 'agent'))
                    : basePrompt;
                var tools = buildViewTools(_viewIdForRound(isShaderMode ? 'shader' : 'agent'));
                return _estimateFixedOverheadOf(systemPrompt, tools);
            } catch (_) { return 0; }
        }
        // 视觉代理注入图片标记（遗留收敛）：不再挂 AEEngine._，改为 controller 闭包变量。
        // 当前仅 processToolLoop 每轮起始置 false，保留为闭包变量以彻底清除 AEEngine._ 残留。
        var _visionImagesInjected = false;

        // 联网搜索：由 controller/webSearchTool.js 的 webSearchTool.handleSearchWeb 提供实现。
        // ── 计划工具（**单 Agent 路径专属**）／团队任务工具（**lane 专属**）────────────────
        // 计划工具不暴露给团队模式的 Agent，改为团队任务工具。
        // 为什么：团队模式下左抽屉只显示「团队任务」（计划页签不再显示），lane 写出来的计划用户
        // 看不见。曾写「本条 lane 的任务清单」；现为**三条 Agent 共用的
        // 团队任务清单**（数据落 `<工作区>/tasks.json`，见下面 _teamTaskListOf 注释与
        // team/taskList.js 头注）——上面这段旧口径描述已作废，别再按它理解。
        var _isLaneController = !!getLaneId();

        // ── 团队任务清单：**三条 Agent 共用一份** ────────────────
        // 数据源是 team/taskList.js 的实例（按**团队会话**隔离，落 `<工作区>/tasks.json`），
        // 经 `opts.getTeamTaskList()` 注入 —— 三条 lane 拿到的是**同一个实例**（每 lane 各建一份
        // 就退回了「三条各记各的」，那正是本次要修的东西）。
        // 校验（空表/缺 description/未知 status）**只由 taskList.normalizeTasks 一处实现**，
        // 本文件不再写第二份判据（两份必然漂移，且工具报的 reason 与 UI 渲染的判据会分叉）。
        function _teamTaskListOf() {
            var get = opts.getTeamTaskList;
            if (typeof get !== 'function') return null;
            try { return get() || null; } catch (_) { return null; }
        }

        function _taskViewOf(s) {
            return { number: s.number, description: s.description, status: s.status };
        }

        function _tasksPayload(extra, by) {
            var tl = _teamTaskListOf();
            var snap = tl ? tl.snapshot() : { sid: '', steps: [], updatedBy: '', updatedAt: 0 };
            var out = {
                status: 'ok',
                shared: true,                       // 明示「这是团队共用的一份」
                // lane = **调用方**那条（本工具三条 lane 各注册一次、注册表
                // last-wins ⇒ 闭包里的 getLaneId() 恒是最后注册那条 lane；不得用它冒充调用者）
                lane: by || getLaneId(),
                teamSessionId: snap.sid || null,
                updatedBy: snap.updatedBy || null,
                tasks: snap.steps.map(_taskViewOf)
            };
            if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
            return out;
        }

        function _taskReject(reason, extra, by) {
            var payload = {
                status: 'rejected', reason: reason, lane: by || getLaneId(),
                hint: 'tasks 必须是非空数组，每项形如 { description: "做什么", status: "pending|running|done|failed" }；'
                    + '这份清单是**各条 Agent 共用**的，改写前先用本工具读一次（不传 tasks），'
                    + '只加自己的条目用 action=add，只改状态用 action=set_status'
            };
            // 读失败保护态 / 载入未落地：把「盘上原文件没被动过」讲清楚——否则模型会以为清单真的空了，
            // 反复重试写入（而写入正是被保护挡下的那件事）。
            if (reason === 'read_failed') {
                payload.hint = '团队任务清单**这次没读到**（不是空的）：盘上的 tasks.json 未被触碰，'
                    + '本次会话内清单写入已被禁用以免覆盖它。请稍后重试，或让用户检查工作区里的 tasks.json。';
            } else if (reason === 'not_loaded') {
                payload.hint = '团队任务清单还在载入中（刚切到该团队会话），请稍后重试——'
                    + '此刻写入会与载入结果打架。';
            } else if (reason === 'subagent_read_only') {
                payload.hint = '子 Agent 只能读取团队任务清单；把结果回报给上级 Agent，由它更新清单。';
            }
            if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
            return Promise.resolve({
                success: false, isError: true,
                content: [{ type: 'text', text: JSON.stringify(payload) }]
            });
        }

        // 工具入口。action 语义（缺省 replace，与「整表替换」向后兼容）：
        //   · 不带 tasks 且不带 action ⇒ **读**（返回当前共用清单；协作前先读）
        //   · replace     ⇒ 整表替换（重建清单；会覆盖其他 Agent 的条目）
        //   · add         ⇒ 追加（并行协作的主用法：只加自己的条目，不动别人的）
        //   · set_status  ⇒ 按 number / description 改状态（不重写整表）
        // handler 第二参（execCtx）的 laneId = **调用方**那条 lane（last-wins
        // 收口）：本工具三条 lane 各注册一次，注册表只留最后注册那条的 handler ⇒ 闭包里的
        // getLaneId() 是「最后注册者」，不是调用者。协作清单的 by/更新者必须标调用者。
        function _handleUpdateTeamTasks(args, ctx) {
            var a = args || {};
            var by = (ctx && typeof ctx.laneId === 'string' && ctx.laneId) ? ctx.laneId : getLaneId();
            var tl = _teamTaskListOf();
            if (!tl) {
                return _taskReject('no_task_list', { detail: '团队任务清单未装配（team/taskList.js 缺席或团队未装配）' }, by);
            }
            if (!tl.getSessionId()) {
                return _taskReject('no_team_session', { detail: '当前没有团队会话（团队模式未开启或尚未绑定会话）' }, by);
            }
            var action = (typeof a.action === 'string' && a.action) ? a.action : (a.tasks ? 'replace' : 'read');
            if (action !== 'replace' && action !== 'add' && action !== 'set_status' && action !== 'read') {
                return _taskReject('bad_action', { action: action }, by);
            }
            if (action === 'read') {
                return Promise.resolve({
                    success: true, isError: false,
                    content: [{ type: 'text', text: JSON.stringify(_tasksPayload({ status: 'read' }, by)) }]
                });
            }
            // 子 Agent 只能读：写操作一律显式拒绝（读在上面的分支已放行）。
            // 判据来自 execCtx（toolExecutionPipeline 随调用下发），不靠 lane 身份推断——子 Agent 的
            // laneId 就是父 lane，按 lane 判分不出来。
            if (ctx && ctx.isSubagent === true) {
                return _taskReject('subagent_read_only', {
                    detail: '被上级派生的子 Agent 只能读取团队任务清单；更新由上级 Agent 执行。'
                }, by);
            }
            if (action === 'set_status') {
                var keys = { numbers: a.numbers, descriptions: a.descriptions };
                var r = null;
                try {
                    r = tl.setStatus(keys, a.status, { by: by });
                } catch (e) {
                    return _taskReject('throw', { detail: String((e && e.message) || e) }, by);
                }
                if (!r || r.ok !== true) {
                    return _taskReject((r && r.reason) || 'unknown', { index: (r && r.index === undefined ? null : r.index) }, by);
                }
                return _persistAndReport(tl, r, {
                    action: action,
                    changed: r.changed,
                    // 命中的条目（含新状态）：装配层据此生成「谁把哪几条改成了什么」的通知。
                    changedItems: r.changedItems || []
                }, by);
            }
            // replace / add 都吃 tasks
            var res = null;
            try {
                res = (action === 'add') ? tl.add(a.tasks, { by: by }) : tl.replace(a.tasks, { by: by });
            } catch (e) {
                return _taskReject('throw', { detail: String((e && e.message) || e) }, by);
            }
            if (!res || res.ok !== true) {
                return _taskReject((res && res.reason) || 'unknown', {
                    index: (res && res.index === undefined ? null : res.index),
                    status: (res && res.status) || null,
                    limit: (res && res.limit) || null
                }, by);
            }
            return _persistAndReport(tl, res, {
                action: action,
                added: res.added || 0,
                addedItems: res.addedItems || [],
                count: res.count || 0
            }, by);
        }

        // 团队任务清单变化不通知装配层（那相当于做成卡片投给导演并
        // 唤醒一轮）。清单写入与面板显示不受影响；唤醒改由 goal 在「执行 lane 忙→闲」时兜底。
        // 落盘结果如实回报（内存已更新、盘上没落地时必须让模型/用户看得见——否则「面板上有、
        // 重载后没了」是最难查的一类现象）。
        function _persistAndReport(tl, res, extra, by) {
            return Promise.resolve(res.persist).then(function (p) {
                var payload = _tasksPayload({
                    status: p && p.ok === true ? 'updated' : 'updated_memory_only',
                    persisted: !!(p && p.ok === true),
                    persistReason: (p && p.ok === true) ? null : ((p && p.reason) || 'unknown'),
                    // AEFS/workspace 的**原文**：write_failed 里「路径被数据层拒绝
                    // （改路径可解）」与「通道故障（重试才可能好）」是两种处置，workspace.js 专门
                    // 分了三态——只回一个 reason 等于把它丢了。
                    persistDetail: (p && p.ok === true) ? null : ((p && p.detail) || null)
                }, by);
                if (extra) for (var k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
                // 任务清单变化不再通知/唤醒导演（见 bootstrap 同处注释）
                // 刷新团队任务面板（taskList 的 onChange 已接；这里兜「onChange 未接/UI 缺席」的场景）
                try {
                    var ui = global.AEAgentTeamUI;
                    if (ui && typeof ui.renderBoard === 'function') ui.renderBoard();
                } catch (_) { /* UI 缺席不影响工具成功 */ }
                return {
                    success: true, isError: false,
                    content: [{ type: 'text', text: JSON.stringify(payload) }]
                };
            });
        }

        // 计划处理器的 lane 转发包装（见下面 planHandlers 的注释）：
        // 三条 lane 的注册必须语义等价 ⇒ 每次调用按 `ctx.laneId` 现解析目标 lane 的真实处理器。
        // 解析失败/没有 laneId（单 Agent、外接客户端、脚本区）⇒ 回落本地那一份（行为与改动前一致）。
        // 形状约定：`api` 面（本地的与解析出来的都一样）是 { trackSteps, getPlanStatus, updatePlan }；
        // 注册用的 handler 面是 { handleTrackSteps, handleGetPlanStatus, handleUpdatePlan }。
        function _laneAwarePlanHandlers(localApi, o) {
            function pick(ctx) {
                // **执行者**的处理器最优先（管线随 ctx 下发 getPlanApi）。
                // 只有 laneId 分支的缺口 —— 单 Agent 执行（ctx 无 laneId）会回落
                // localApi = 本 wrapper 所属那条 lane 的 plan ⇒ 用过一次团队后（lane 后注册，
                // 注册表里是最后那条 lane 的 wrapper），单 Agent 的 trackSteps / getPlanStatus /
                // updatePlan 全写进**最后那条 lane 的计划树**（同一 last-wins 缺陷的残留面）。
                try {
                    if (ctx && typeof ctx.getPlanApi === 'function') {
                        var execApi = ctx.getPlanApi();
                        if (execApi && typeof execApi.trackSteps === 'function') return execApi;
                    }
                } catch (_) { /* 执行侧解析失败 → 走 laneId / 本地回落 */ }
                var id = (ctx && typeof ctx.laneId === 'string') ? ctx.laneId : '';
                if (!id) return localApi;
                var api = null;
                try { api = o.getLanePlanHandlers(id); } catch (_) { api = null; }
                if (!api || typeof api.trackSteps !== 'function') return localApi;
                return api;
            }
            return {
                handleTrackSteps: function (args, ctx) { return pick(ctx).trackSteps(args, ctx); },
                handleGetPlanStatus: function (args, ctx) { return pick(ctx).getPlanStatus(args, ctx); },
                handleUpdatePlan: function (args, ctx) { return pick(ctx).updatePlan(args, ctx); }
            };
        }

        if (toolRegistry) {
        // ── 计划工具（trackSteps / getPlanStatus / updatePlan）：**两种形态都注册**────────
        // 「每个 Agent 自己的 todo 计划工具要保留，不然会产生一定的
        // 问题」——若把这三件对 lane 摘掉、只留共用的 updateTeamTasks，lane 就**自己没有
        // 逐步推进的载体**：模型要么不列步骤，要么把细碎步骤塞进共用清单里覆盖别人。
        // 现在两件并存，分工写进两边描述与角色段：
        //   · 这三件 = **本 Agent 自己的 todo**（侧栏计划树 / 进度显示它）；
        //   · updateTeamTasks = 三条 Agent 共用的团队任务清单（用户看得见的分工）。
        // plan 的存储全程走 opts.getActivePlan / opts.getActiveStore（planTracking.js）⇒ 每条 lane
        // 的 controller 各有一份 plan，互不覆盖（lane 的 store 本来就是按 lane 分的）。
        // scope **统一**（不再按形态分流）：{ moduleIds: ['agent','team'] }
        //   · 'agent' 覆盖单 Agent 的 agent 档 + 两条执行 lane 的 agent 身份；
        //   · 'team'  覆盖三条 lane 的公共身份（director/ae-exec=['agent','team']、glsl=['shader','team']）
        //     ——glsl 靠它拿到自己的 todo 工具，不需要把 'shader' 写进 scope；
        //   · 单 Agent 的 script/shader 档不含 agent/team ⇒ 看不到这三个工具（与分流前逐字一致）。
        // 为什么不能按形态给两份定义：同一工具名在两条 runtime 下允许不同定义，全局表 scope 就必然
        // 取决于装配顺序（last-wins）或首装+扩宽（first-wins）——两种实现都会在「开过团队」后把
        // 宽 scope 留给单 Agent（shader 档凭空多出三个计划工具）。「定义只装一次」的前提是同一工具
        // 在任何 runtime 下的定义同源，scope 也不例外。
        var planScope = { type: 'module', moduleIds: ['agent', 'team'] };
        // 计划处理器：**共享注册表是 last-wins** —— 三条 lane 的 controller 各注册一次同名
        // 工具，只留最后注册那条的 handler。若 handler 闭包捕获各自的 state/store，三条 lane 的
        // trackSteps 会全部写进**最后注册那条 lane** 的 plan（真机表现：导演列了步骤，进度出现在
        // Shader 执行那条 lane 上）。解法与 getTeamTaskList 同款：让三条 lane 注册的 handler
        // **语义等价**——按 `ctx.laneId` 解析到调用方那条 lane 的真实处理器；解析不到（单 Agent、
        // 外接、未知 lane）就用本地这一份。
        var planApi = {
            trackSteps: planTracking.handleTrackSteps,
            getPlanStatus: planTracking.handleGetPlanStatus,
            updatePlan: planTracking.handleUpdatePlan
        };
        var planHandlers = (_isLaneController && typeof opts.getLanePlanHandlers === 'function')
            ? _laneAwarePlanHandlers(planApi, opts)
            : {
                handleTrackSteps: planApi.trackSteps,
                handleGetPlanStatus: planApi.getPlanStatus,
                handleUpdatePlan: planApi.updatePlan
            };
        {
            toolRegistry.register({
                name: 'trackSteps',
                description: '创建任务清单。任务较多时调用，列出待办项跟踪进度。执行中修改清单用 updatePlan',
                input_schema: {
                    type: 'object',
                    properties: {
                        steps: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    number: { type: 'number', description: '步骤序号' },
                                    description: { type: 'string', description: '步骤描述（给用户看的）' },
                                    tool: { type: 'string', description: '计划使用的工具名' },
                                    args: { type: 'object', description: '计划传递的参数' }
                                },
                                required: ['number', 'description']
                            },
                            description: '步骤列表'
                        }
                    },
                    required: ['steps']
                },
                handler: planHandlers.handleTrackSteps,
                scope: planScope,
                category: 'plan',
                source: 'agent'
            });

            toolRegistry.register({
                name: 'getPlanStatus',
                description: '查看当前任务清单的状态，包括每步是否完成、成功或失败。用于在执行中确认进度或故障排查',
                input_schema: { type: 'object', properties: {}, required: [] },
                handler: planHandlers.handleGetPlanStatus,
                scope: planScope,
                category: 'plan',
                source: 'agent'
            });

            toolRegistry.register({
                name: 'updatePlan',
                description: '修改当前任务清单。action: replace/add/remove/mark_done/mark_running/clear。修改直接生效，无需用户确认。',
                input_schema: {
                    type: 'object',
                    properties: {
                        action: { type: 'string', enum: ['replace', 'add', 'remove', 'mark_done', 'mark_running', 'clear'], description: '操作类型' },
                        steps: { type: 'array', items: { type: 'object' }, description: '步骤列表（replace/add 时用）' },
                        numbers: { type: 'array', items: { type: 'number' }, description: '步骤序号列表（remove/mark_done 时用）' },
                        number: { type: 'number', description: '步骤序号（mark_running 时用，标记该步骤为执行中）' },
                        success: { type: 'boolean', description: 'mark_done 时用，步骤是否成功完成。默认 true，false 表示步骤失败' },
                        reason: { type: 'string', description: '修改原因，展示给用户' }
                    },
                    required: ['action']
                },
                handler: planHandlers.handleUpdatePlan,
                scope: planScope,
                category: 'plan',
                source: 'agent'
            });
        }
        // ── goal 三工具 ────────────────────────────────
        // 注册表是全局共享的（同名 last-wins），而 runtimeMode / 团队开关会变、团队里又只有导演
        // 该有 goal ⇒「注册时支持」不能代表「之后也支持」，同时后建的 controller 会把 handler
        // 盖成它自己那份。做法：
        //   · 每个非子 Agent 的 controller 创建时先注册一份（保证任何通道都至少有条目）；
        //   · 通道切换（开关团队）时由 bootstrap 调**该通道自己的** goalRegisterTools() 抢回
        //     最后一手，保证 last-wins 落在正确的 controller 上；
        //   · 可见性每轮在 _buildRoundTools 现算（不支持的通道进黑名单），执行侧另有门面
        //     supported 兜底；团队执行 lane 还有 lanes.js 的 execLaneToolFilter 一道。
        _registerGoalTools();

        // ── 提问工具 askUser ──────────────────────────────────────
        // 交互面是聊天流内联问答卡（view.appendAskUser），不是模态弹窗：模态是模块级单例、
        // 无 lane 标识、停止也不关闭，团队/多通道同时提问会串队（设计见
        // 上文所述的成因）。
        // 每个 runtime 各注册一次（handler 走逐 runtime 绑定表）：执行者身份不支持时
        // handler 返回 unavailable 且不落卡片——共享注册表 last-wins，若靠「别的 runtime
        // 不注册」来挡，回落到的那份 handler 会把卡片画进别人的会话。
        // 可见性另由三处收窄：team/lanes.js 的 execLaneToolFilter（执行 lane）、
        // engine/bootstrap.js 的 _mkSubagentToolFilter（子 Agent）、_buildRoundTools 的
        // 黑名单（团队主 Agent 通道）。
        if (toolRegistry && global.AEEngine && typeof global.AEEngine.createAskUserTool === 'function') {
            var _askDef = global.AEEngine.createAskUserTool({
                getView: function () { return view; },
                getState: function () { return state; },
                getSettings: function () { return getSettings(); },
                isTeamMode: opts.isTeamMode,
                isSubagent: opts.isSubagent === true,
                getLaneId: function () { return getLaneId(); }
            });
            if (_askDef) {
                // 注册对象写成显式字面量（不整包传工厂返回值）：审计的
                // 「生产注册点 ↔ 审计登记面」双向判据按 `name: '…'` 字面量扫描注册块，
                // 整包传参会让它看不见这件工具（登记面判据因此报残渣）。
                var _askReg = toolRegistry.register({
                    name: 'askUser',
                    description: _askDef.description,
                    shortDescription: _askDef.shortDescription,
                    input_schema: _askDef.input_schema,
                    handler: _askDef.handler,
                    scope: _askDef.scope,
                    stub: false,
                    // 只读元数据：不改变工程/磁盘状态（只显示问答卡并等待）。
                    // conservative 档据此不弹「工具执行确认」（见 permissions.READ_ONLY）。
                    readOnly: true,
                    category: 'utility',
                    source: 'agent'
                });
                if (!_askReg || !_askReg.ok) {
                    console.warn('[Agent] askUser 工具注册失败: ' + ((_askReg && _askReg.error) || 'unknown'));
                }
            }
        }

        // ── 团队任务清单工具（lane 专属；三条 lane 共用；与上面的「自己的 todo」**并存**）──────
        if (toolRegistry && _isLaneController) {
            // scope 用 moduleIds:['team']：三条 lane 的身份集合都含 team（单 Agent 路径没有）⇒
            // 只对团队模式的 Agent 可见，与 read_workspace / send_message 同一口径。
            // 清单是**三条 Agent 共用的一份**（按团队会话隔离，落工作区 tasks.json）
            // ⇒ 工具描述必须把协作规则讲清楚，否则三条 lane 会互相覆盖：
            //   · 改写前先读（不传 tasks 即返回当前清单）；
            //   · 只加自己的条目用 action=add（不动别人的）；
            //   · 只改状态用 action=set_status；
            //   · action=replace 是「重建清单」，会覆盖其他 Agent 的条目。
            // **依赖缺失就不注册**：本工具要经 `opts.getTeamTaskList` 拿共用清单，
            // 拿不到（team/taskList.js 未装配 / 装配失败）时注册它 = 暴露一件「一调就报 no_task_list」
            // 的死工具，模型会把「内部没装配」误读成「自己用错了」——与 write_workspace 的
            // 「没有写能力就别注册」同一口径。子 Agent 的 controller 也走这条分支（身份继承父 lane），
            // 装配侧因此必须给**所有** lane 形态的 controller 注入同一个 getter（见 bootstrap）。
            if (typeof opts.getTeamTaskList !== 'function') {
                console.warn('[Agent] 团队任务清单未装配（opts.getTeamTaskList 缺席）'
                    + '：updateTeamTasks 不注册（避免暴露一件永远报错的工具）');
            } else {
            toolRegistry.register({
                name: 'updateTeamTasks',
                description: '维护团队任务清单（各条 Agent 共用一份，显示在左侧「团队任务」面板）。'
                    + '不传 tasks 调用一次即读取当前清单；被上级派生的子 Agent 只能读取，不能修改。'
                    + '只加自己的条目用 action=add；只改状态用 action=set_status'
                    + '（配 numbers 或 descriptions + status）；action=replace 是整表替换，'
                    + '会覆盖其他 Agent 的条目。'
                    + '每项含 description（必填，给用户看的短句）+ status（pending/running/done/failed，缺省 pending）。'
                    + '开工时把对应条目改成 running，做完改成 done。'
                    + '分工：自己的执行步骤用 trackSteps/getPlanStatus/updatePlan（只影响自己的计划，'
                    + '显示在侧栏计划树）；这份清单放各条 Agent 都要知道的协作条目。',
                shortDescription: '维护团队共用任务清单（各条 Agent 同一份，团队任务面板显示）',
                input_schema: {
                    type: 'object',
                    properties: {
                        action: {
                            type: 'string',
                            enum: ['replace', 'add', 'set_status'],
                            description: 'replace=整表替换（缺省，会覆盖别人的条目）/ add=追加 / '
                                + 'set_status=只改状态。都不传则只读取当前清单'
                        },
                        tasks: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    description: { type: 'string', description: '任务描述（给用户看的短句）' },
                                    status: {
                                        type: 'string',
                                        enum: ['pending', 'running', 'done', 'failed'],
                                        description: '该任务的状态，缺省 pending'
                                    }
                                },
                                required: ['description']
                            },
                            description: '任务清单（action=replace/add 时用；replace 传完整清单，add 只传新增项）'
                        },
                        numbers: {
                            type: 'array', items: { type: 'number' },
                            description: 'action=set_status 时用：要改状态的任务序号（读取时返回的 number）'
                        },
                        descriptions: {
                            type: 'array', items: { type: 'string' },
                            description: 'action=set_status 时用：要改状态的任务描述（与清单里的原文一致）'
                        },
                        status: {
                            type: 'string',
                            enum: ['pending', 'running', 'done', 'failed'],
                            description: 'action=set_status 时用：目标状态'
                        }
                    },
                    required: []
                },
                handler: _handleUpdateTeamTasks,
                scope: { type: 'module', moduleIds: ['team'] },
                category: 'team',
                source: 'team'
            });
            }
        }

            // ── 联网搜索工具 ──
            // search_web：当用户需要实时信息（新闻/天气/最新动态/股价/查资料）时，
            // 通过本地 Bridge /api/web-search 搜索。无条件注册；运行时按最新
            // webSearchEnabled 设置在 toolGating.buildLlmTools 每轮过滤（设置面板开关即时生效）。
            toolRegistry.register({
                name: 'search_web',
                description: '联网搜索实时信息。当用户询问新闻、天气、最新动态、股价、赛事比分，或需要查资料、引用网页内容时调用。返回标题、URL、摘要列表。\n搜索质量提示：本搜索底层是中文市场搜索引擎，对冷门英文技术词相关度差。构造查询时：\n1) 用该主题最常用、最权威、最可能被广泛收录的表述；冷门专业词要补充领域上下文词或知名厂商/平台名。\n2) 有歧义的多义词务必加限定消歧：如查软件应写"Adobe After Effects"，避免命中同名电影。\n3) 国际/英文技术主题优先用英文检索，中文主题用中文，避免中英混杂。\n4) 用短小的高信号短语，不要写成整句提问；精确词组可用引号括住。\n5) 若结果不佳，换更通用或加限定词的表述再搜，不要重复同一查询。',
                shortDescription: '联网搜索实时信息（新闻/天气/最新动态等）',
                input_schema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '搜索关键词。请写成高消歧、高信号、面向中文市场引擎的紧凑查询（参考描述中的搜索质量提示）。' },
                        num: { type: 'integer', description: '结果数量（默认 5，上限 20）。单页实际 8~10 条，取不到更多；要更多结果请换关键词' }
                    },
                    required: ['query']
                },
                handler: webSearchTool.handleSearchWeb,
                // Script / Shader 档也要能联网搜索（写脚本时查 API/资料）。
                scope: { type: 'module', moduleIds: ['agent', 'script', 'shader'] },
                stub: true,
                category: 'utility',
                source: 'agent'
            });

            // ── 网页正文读取工具 ──
            // read_url：搜索/引用到链接后，通过 Bridge /api/fetch-page 抓取 URL 提取正文可读文本。
            // 可访问站点有效；Cloudflare 保护或被墙站点会如实报错供 LLM 感知。
            // 与 search_web 同受 webSearchEnabled 控制（toolGating 每轮过滤）。
            toolRegistry.register({
                name: 'read_url',
                description: '读取指定网页的正文内容。当 search_web 搜索结果里某链接看起来能提供所需信息、或用户给出一个网页链接想了解其内容时调用。返回页面标题与正文纯文本。\n分页：长页正文超过单次返回量时，返回含 total 与 hasMore，并提示可传 offset（字符起始位置）继续读取后续段落，直到 hasMore=false；每次默认返回约 8000 字符，可用 limit 调整单次返回的字符数上限。\n检索：传 search 时按关键词检索（大小写不敏感，支持 /正则/ 形式如 /关键词\\d+/i），返回每处命中的字符 offset 与前后文片段，每页 20 处、用 searchOffset 翻页；命中处的 offset 可直接用于本工具的 offset 参数。\n注意：脚本渲染或反爬/被墙的页面可能读不到正文（此时返回明确提示），可考虑换一个更易访问的信息来源。',
                shortDescription: '读取网页正文内容',
                input_schema: {
                    type: 'object',
                    properties: {
                        url: { type: 'string', description: '要读取的网页完整 URL（https 开头）' },
                        offset: { type: 'integer', description: '正文起始字符偏移（默认0）。返回的 hasMore=true 时传 offset+limit 继续读取后续段落' },
                        limit: { type: 'integer', description: '单次返回字符数上限（默认8000，范围500~16000）' },
                        search: { type: 'string', description: '关键词检索（大小写不敏感，支持 /正则/ 形式如 /关键词\\d+/i）：返回每处命中的字符 offset 与前后文片段，每页 20 处。传了 search 时按检索返回（忽略 offset/limit）' },
                        searchOffset: { type: 'integer', description: '检索翻页：跳过前 N 处命中（默认 0），配合 search 看后续命中' }
                    },
                    required: ['url']
                },
                handler: urlReadTool.handleReadUrl,
                // 与 search_web 一样放开到 Script / Shader 档。
                scope: { type: 'module', moduleIds: ['agent', 'script', 'shader'] },
                stub: true,
                category: 'utility',
                source: 'agent'
            });

            // ── Skill 在线目录查询工具 ──
            // search_skill_store：当用户要查找/安装可用的官方 Skill 时调用。
            // 通过本地 Bridge /api/skill-store 归一化官方 anthropics/skills 目录，
            // 返回可直接用 skill_manager install source=url 安装的裸 SKILL.md 链接，
            // 不受中文市场搜索引擎结果污染。与 search_web 同受 webSearchEnabled
            // 控制（toolGating 每轮过滤）。
            toolRegistry.register({
                name: 'search_skill_store',
                description: '查询官方 Skill 目录并返回可直接安装的链接。当用户想找或安装一个 Skill（例如文档处理、Excel、绘图、开发工具等技能）时优先调用本工具，而不是依赖 search_web 网页搜索。返回结果包含技能名、一句话描述、license 与 install_url；拿到 install_url 后，用 skill_manager 的 install mode（source=url）传入该链接即可安装。\n用法与提示：\n1) 不带 query 时列出全部可用 Skill；带 query 时按关键词过滤（会匹配技能名和描述，可多词限定）。\n2) 结果可能不止一页：返回含 total 与 hasMore，若 hasMore 为 true 需传 offset（起始偏移，第 2 页 offset=limit、第 3 页 offset=2*limit……）携带原 query 继续翻页，直到 hasMore=false。\n3) 注意：官方目录中 docx/pdf/pptx/xlsx 等文档技能是 source-available（非开源），安装前应提醒用户在遵守其 license 的前提下使用。',
                shortDescription: '查询官方 Skill 目录并返回可安装链接',
                input_schema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: '过滤关键词（可选，匹配技能名和描述；省略则列出全部）' },
                        limit: { type: 'integer', description: '返回条数上限（默认10，最大20）' },
                        offset: { type: 'integer', description: '起始偏移（默认0）。返回的 hasMore=true 时传 offset+limit 继续翻页' }
                    }
                },
                handler: skillStoreTool.handleSearchSkillStore,
                // 搜索技能工具归「技能」栏（source=skill-manager）并对全部
                // 视图放开（global）；source='agent' 会落进「Agent 引擎」组，scope 只含
                // agent/external-mcp，面板里看起来不属于技能、别的档位也调不到。
                scope: { type: 'global' },
                stub: true,
                category: 'utility',
                source: 'skill-manager'
            });

            // ── Script 模式专用工具 ──
            // submit_script：LLM 通过工具调用提交脚本，工具内完成校验。
            // 校验通过 → 写入预览区；失败 → 返回错误供 LLM 修正后重新提交。
            // 修正循环由 LLM 工具循环自然承担，无需 processScriptFlow 的 while retry。
            // 局部编辑走内容锚定：oldText 唯一命中 + newText
            // 替换/删除，多段用 edits[]；行号定位已移除（模型数错行 + 落库内容过规整管线改行数
            // → 按行号落笔会静默改错行）。实现见 engine/textEdits.js（script/shader 共用一份）。
            // 不传 oldText/edits 则整份提交。
            toolRegistry.register({
                name: 'submit_script',
                description: '提交 ExtendScript 脚本到预览区。脚本会经过校验：通过则写入预览区供用户手动运行（回执给写入后的总行数），失败则返回错误信息供你修正后重新提交。这是 Script 模式下输出脚本的唯一方式。改已有脚本用内容锚定局部编辑：oldText（要替换的原文，须与预览区当前内容逐字符一致、且在其中唯一——行号会漂移故不作定位依据，请先 get_current_script 读回原文、剥掉每行行号前缀后再复制）+ newText（替换文本，空串=删除）；多段一次改完用 edits:[{oldText,newText}, ...]（1-20 处，按序应用）。局部编辑会先合并成完整脚本再整体校验后写回；不传 oldText/edits 则整份提交。代码契约：仅 ES3 语法（禁 let/const/箭头函数/模板字符串/解构/class/for...of/Promise/Map/Set/Symbol）；完整可执行、try/catch 包裹主逻辑、catch 中用 alert 报告错误；保持正常换行不要输出单行代码；属性名和效果名必须用 matchName（中英文版通用），不确定时用 queryAeApi 查询不要编造；撤销组可自行写 beginUndoGroup/endUndoGroup 精确控制撤销粒度；不写则框架自动兜底包裹。安全边界：以下 API 无能力域开关，任何情况下拦截——BridgeTalk、$.global/$.evalFile、eval/new Function/String.fromCharCode 动态构造、__ael*/__aeS*/_cs/_OF/_OD 沙箱引用；能力域类 API（File/Folder/system.callSystem/Socket/executeCommand）默认关闭，被拦截时拒绝信息会附开启指引与参数式工具替代方案，按指引处理。',
                input_schema: {
                    type: 'object',
                    properties: {
                        script: { type: 'string', description: 'ExtendScript 代码。整份提交时须完整实现功能；用 oldText/edits 局部编辑时不需要传' },
                        message: { type: 'string', description: '给用户的说明（可选）' },
                        assumptions: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '生成时所做的假设（可选，展示给用户）'
                        },
                        oldText: { type: 'string', description: '局部编辑：要替换的原文，须与预览区当前内容逐字符一致（含缩进与空行）且在其中唯一；先用 get_current_script 读回原文再原样复制。不传则整份提交；读回内容每行开头的 "N: " 是行号标注、不属于代码，复制时去掉' },
                        newText: { type: 'string', description: '局部编辑：替换文本；空串表示删除 oldText 命中的整段' },
                        edits: { type: 'array', items: { type: 'object', properties: { oldText: { type: 'string' }, newText: { type: 'string' } } }, description: '局部编辑（1-20 处，按序应用）：与顶层 oldText/newText 互斥' }
                    },
                    required: []
                },
                handler: scriptTools.buildSubmitScriptHandler(),
                scope: { type: 'module', moduleIds: ['script', 'external-mcp'] },
                stub: false,
                category: 'utility',
                source: 'agent'
            });

            // ──  补表工具（Agent + Script 双模式）──
            // LLM 代码被表③误拒时的会话内闭环出口：预审三档（硬拒/挂域/自由）→
            // 审核员 LLM（global.AEEngine.reviewTableProposal——engine/bootstrap 接线，
            // reviewAeTool 同款配置）→ 用户确认 → 落用户增补表（dataDir，即时生效）。
            // 硬拒族在工具层拒不弹给用户；审核员缺席 fail-closed 拒（不降级直落）。
            if (global.AEAgentTableTools && typeof global.AEAgentTableTools.buildProposeTableEntryHandler === 'function') {
                toolRegistry.register({
                    name: 'propose_table_entry',
                    description: '当 AST 门以「未收录」拒绝你的代码、且该成员是 Adobe 官方 ExtendScript API（非文件写/系统执行/延迟执行类）时，提议把它加入白名单。三种提议形态：①默认=给已有类型加一个成员；②newType=true=新增一个类型（官方对象族在门内没有对应类型时用，如效果组/参数组，同一笔要给出它的一个成员）；③override=true=改写已有条目的判定（门把某个成员的返回类型记成了 u 或只读、需要补精确时用）。必须提供官方文档出处 URL。提议经过自动预审、独立安全审查（大多数情况还要你确认），即时生效。文件写语义成员收录后仍受文件能力域控制。硬拒项（scheduleTask/evalFile/execute/changePath/BridgeTalk 等）不可提议——请改用参数式工具。',
                    input_schema: {
                        type: 'object',
                        properties: {
                            typeName: { type: 'string', description: '类型名。默认与 override 形态：须是白名单已有类型（如 Layer/CompItem/Project）；newType=true 时：这是要新建的类型名（不得与已有类型/基础类型同名）' },
                            memberName: { type: 'string', description: '成员名（如 threeDPerceiver）；newType=true 时是随新类型一并声明的成员名；override=true 时须是表内已存在的成员名' },
                            returnType: { type: 'string', description: '返回类型：string/number/boolean，或类型表已有类型名（如 Property/Layer），或 array<X> 与 | 联合；newType=true 时可以直接写本次要新建的类型名' },
                            isMethod: { type: 'boolean', description: '是否为可调用方法（省略=false 属性）' },
                            writable: { type: 'boolean', description: '属性是否可写（省略=false 只读）' },
                            newType: { type: 'boolean', description: 'true=新增类型（官方对象族在门内无类型时用；名字不得与已有/基础类型撞名）' },
                            override: { type: 'boolean', description: 'true=改写已有条目的判定（返回类型/方法位/可写位）；该成员必须已存在于表中' },
                            sourceUrl: { type: 'string', description: 'Adobe 官方文档出处 URL（必填——缺失直接拒绝）' },
                            reason: { type: 'string', description: '用途与语义说明（必填——展示给用户与审查员）' }
                        },
                        required: ['typeName', 'memberName', 'returnType', 'sourceUrl', 'reason']
                    },
                    // 把本运行轮的 signal/停止标记透传给审核请求与确认框复查
                    //（对照 toolExecutionPipeline 审查路径的 opts.getActiveAbortController）
                    handler: global.AEAgentTableTools.buildProposeTableEntryHandler({
                        // 与 script/shader 两侧同款：ctx 感知（共享注册表 last-wins，handler 可能
                        // 属于另一条已停止的 runtime；见 stopRequestedForCtx 的注释）。
                        getAbortSignal: function (execCtx) {
                            var ac = abortControllerForCtx(execCtx);
                            return ac ? (ac.signal || null) : null;
                        },
                        getStopRequested: function (execCtx) { return stopRequestedForCtx(execCtx); }
                    }),
                    scope: { type: 'module', moduleIds: ['agent', 'script'] },
                    stub: false,
                    category: 'utility',
                    source: 'agent'
                });
            }

            // get_current_script：LLM 主动读取预览区当前代码，替代旧的自动注入。
            // 支持 search（文本搜索）、segments（按逻辑块拆分）、startLine/endLine（按行区间）三种查询，
            // 便于 LLM 只读取相关片段定位要修改的位置（避免大脚本全量返回浪费 token）。
            toolRegistry.register({
                name: 'get_current_script',
                description: '读取预览区当前的 ExtendScript 脚本代码。提交脚本前必调（含首次，空预览区也要读一次——写前必读，未读提交会被拒绝）；修改已有脚本或用户提到"当前脚本/第 N 行"时也用它定位。不传参数返回完整脚本（每行带行号，超过 500 行时截断为前 500 行）；search 的 context 与 segments 的 snippet 含行号或截断，不能直接当 oldText 锚点——锚点用整篇读回并剥掉行号前缀后的原文',
                input_schema: {
                    type: 'object',
                    properties: {
                        startLine: { type: 'number', description: '起始行号（1-based，含）。单次最多返回 500 行，超出则截断并标注 truncated' },
                        endLine: { type: 'number', description: '结束行号（1-based，含）' },
                        search: { type: 'string', description: '文本搜索：返回每个匹配的行号、该行内容及 ±2 行上下文，每页最多 20 个匹配，用 offset 分页。与 startLine/endLine/segments 互斥' },
                        offset: { type: 'number', description: '分页偏移：起始匹配序号（1-based，默认 1）。仅配合 search 使用，返回第 offset 个匹配起的 20 个匹配及 hasMore 标记' },
                        segments: { type: 'boolean', description: '按逻辑块拆分：返回段落列表（startLine/endLine/snippet），便于定位要修改的段。与 search/startLine/endLine 互斥' }
                    },
                    required: []
                },
                handler: scriptTools.buildGetCurrentScriptHandler(),
                scope: { type: 'module', moduleIds: ['script', 'external-mcp'] },
                stub: false,
                category: 'utility',
                source: 'agent'
            });

            // ── Shader 模式专用工具 ──
            // submit_shader/get_current_shader/shader_library 由 shaderTools.js 提供
            // （scope 统一 module:shader + external-mcp，经 toolExecutor + 权限闸门调用）。
            if (global.AEShaderTools && typeof global.AEShaderTools.createShaderTools === 'function') {
                try {
                    global.AEShaderTools.createShaderTools({
                        toolRegistry: toolRegistry,
                        // 本 lane 的预览账本身份：与 scriptTools 同款——回退点按它
                        // 取 store.forLane(lane)；单 Agent 路径返回 null ⇒ 原样返回单例。
                        getLaneId: function () { return getLaneId(); },
                        aefs: global.AEFS,
                        effectsDir: function () {
                            try {
                                // 跟随「扩展数据目录」设置：数据根目录下 effects/
                                // （与宿主 data-dir.txt 指针、shaderUI 的 effectsDir 同一真相源，
                                //  硬编码默认 APPDATA 路径会在自定义数据目录下与宿主/shaderUI 分叉）
                                if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                                    var r = global.AEShared.getDataDir();
                                    if (r && r.dir) return r.dir.replace(/\\+$/, '') + '\\effects';
                                }
                            } catch (_) {}
                            return '';
                        },
                        compileCheck: function (src) {
                            return (global.AEEffectLab && typeof global.AEEffectLab.compileCheck === 'function')
                                ? global.AEEffectLab.compileCheck(src)
                                : { ok: false, skip: true, error: '校验器未加载' };
                        },
                        // 异步编译校验（KHR_parallel_shader_compile）：LLM 提交 shader 的
                        // 工具校验走此通道，编译在驱动线程进行不阻塞扩展 UI；校验器旧版/
                        // 扩展不可用时由 compileCheckAsync 内部退化为同步语义
                        compileCheckAsync: function (src) {
                            return (global.AEEffectLab && typeof global.AEEffectLab.compileCheckAsync === 'function')
                                ? global.AEEffectLab.compileCheckAsync(src)
                                : Promise.resolve((global.AEEffectLab && typeof global.AEEffectLab.compileCheck === 'function')
                                    ? global.AEEffectLab.compileCheck(src)
                                    : { ok: false, skip: true, error: '校验器未加载' });
                        },
                        // 写入目标按**工具族**显式给出（不能只按面板 runtimeMode 推断）：
                        // shader 族直接复用 opts.onScriptReady，写入侧只按面板 runtimeMode
                        // 选预览区——外接在 script 档调 submit_shader 时 GLSL 会写进
                        // #scriptPreview（覆盖用户脚本草稿与 previewDraft），GLSL 区未变却
                        // 回 passed。带上的 { area: 'shader' } 让 service.js 强制 shader 区。
                        onShaderReady: function (code) {
                            return (typeof opts.onScriptReady === 'function') ? opts.onScriptReady(code, { area: 'shader' }) : undefined;
                        },
                        // 停止复查：异步窗口（编译/JS 执行）结束后不得再写入。
                        // 判据取 **ctx 感知**（见 stopRequestedForCtx）：注册表 last-wins ⇒
                        // 本族 handler 可能是别的 runtime 注册的那份，只认闭包会把「那条已停止」
                        // 误当成本次被停止（真机：团队→shader 后 submit_shader 恒 stopped）。
                        getStopRequested: function (execCtx) { return stopRequestedForCtx(execCtx); },
                        getActiveAbortController: function (execCtx) { return abortControllerForCtx(execCtx); },
                        // 读侧改用专用回调，恒定读 #shaderCodePreview。
                        // 复用 opts.getCurrentScript 时——其模式判定只认 runtimeMode==='shader'，
                        // 外接模式（'external'）下落回 #scriptPreview，get_current_shader 于是返回
                        // 脚本内容（写入侧当时按 isPendingShaderSubmit 提示分流，读侧漏了；
                        // 该提示随写入目标改由工具族声明而删除）。
                        // 末位回退仅为兼容未注入新回调的旧装配/测试桩，维持旧行为不炸。
                        getCurrentShader: (typeof opts.getCurrentShader === 'function')
                            ? opts.getCurrentShader
                            : opts.getCurrentScript
                    }).register();
                } catch (e) {
                    console.error('[Agent] shader 工具注册失败:', e);
                }
            }
        }

        async function resolveApiKeyForPlatform(platformOrProviderId) {
            const globals = opts.getGlobalSettings ? await opts.getGlobalSettings() : {};
            const providerId = platformOrProviderId || globals.defaultProviderId || globals.defaultPlatform || '';
            const registry = global.AE_LLM && global.AE_LLM.providerRegistry;
            // Get the API key field name from registry (supports both old and new naming)
            let apiKeyField = null;
            if (registry && typeof registry.getApiKeyField === 'function') {
                apiKeyField = registry.getApiKeyField(providerId);
            }
            // Legacy fallback: if registry returns null or we're on siliconflow, use apiKey field
            if (!apiKeyField || providerId === 'siliconflow') {
                return String(globals.apiKey || globals.siliconflowApiKey || '').trim();
            }
            // Return the registry-derived field, with apiKey fallback
            return String(globals[apiKeyField] || globals.apiKey || '').trim();
        }

        // 返回对象的延迟引用：processToolLoop/processScriptToolLoop 等闭包函数
        // 在对象方法执行时才能通过 _api 调用其他对象方法（如 compressContext）
        var _api = null;

        // 用户图片统一转码：首发与执行中追加的用户图片若不走单点（直注原图），
        // 而编辑重发（_resolveImagesForResend）与工具结果图片（Vision-HOOK）都走 imageTranscode 单点
        // ——同一张图两条路得到不同形态（原 PNG vs JPEG+4096×2160 上限），且超大图首发时 provider
        // 端可能直接报错。此处一处收口：>4096×2160 等比缩放 + PNG→JPEG（已是 JPEG 且未超尺寸的原样，
        // 见 imageTranscode 的短路口径），失败原样回退（单点保证不阻断链路）。
        // 落盘与气泡缩略图仍用原图——文件本身不动，只有送给 LLM 的那份转码（与工具链口径一致）。
        // 顺序处理：单张走 canvas 重编码，并发 10 张会卡主线程（与仓库"不做并行"的既有取向一致）。
        async function _transcodeUserImagesForLlm(list) {
            var tx = global.AEImageTranscode;
            if (!tx || typeof tx.transcodeDataUrl !== 'function' || !Array.isArray(list)) return list;
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var u = list[i];
                if (typeof u !== 'string' || u.indexOf('data:image/') !== 0) { out.push(u); continue; }
                try { out.push(await tx.transcodeDataUrl(u)); }
                catch (_) { out.push(u); }
            }
            return out;
        }

        // 用户消息视觉通道注入（imageDataUrls → messages 的最后一条 user 消息）。
        // 纯迁移自 processToolLoop 主消费点（原 632-717 内联块）的三分支逻辑，行为不变：
        // ① 配置视觉代理 → 代理模型转中文描述追加进 user 消息（全部失败且主模型支持视觉
        // 时回退直注 image_url）；② 未配代理且主模型支持视觉 → 直注 image_url 多模态分片；
        // ③ 均不支持 → 降级提示文本。抽出为独立函数供两处复用：主消费点（发送路径
        // setPendingImages 的图片）与执行中追加消息的循环内 drain 点（队列条目透传的
        // imageDataUrls——该视觉通道数据若在入队时被丢弃，LLM 永远看不到执行中
        // 追加的图片）。
        // 停止短路（②）：_injectUserImagesIntoMessages 的两个长 await——_transcodeUserImagesForLlm
        // （逐张 canvas 转码）与 describeImagesViaVisionProxy（视觉代理逐张识图，可达数十秒）——
        // 在用户已停止后继续跑没有意义：入口与转码后各查一次 stopRequested，能提前退出的都提前退出。
        // **边界**：已发出的 describeImagesViaVisionProxy 并发池请求仍无法在本层取消（池在
        // controller/visionProxy.js 内；后 llmChannel.sendJson 已支持 options.signal，
        // 但视觉代理发生在运行轮 controller 建立之前的 gather 阶段，无 signal 可绑）——这段
        // 在途等待由 drain 点 await 之后的 stop 复查兜底，停止后不再发起新一轮 sendStream
        //（僵尸轮防线）。
        async function _injectUserImagesIntoMessages(messages, imgs, model, platform) {
            if (stopRequested) return;
            // 两条消费点（首发 / 执行中追加）在此统一转码——转码只换 URL、长度不变，
            // 下方三分支与序号对齐逻辑均按位置处理，不受影响
            imgs = await _transcodeUserImagesForLlm(imgs);
            if (stopRequested) return;
            var resolved = global.AE_LLM && global.AE_LLM.resolveLlmConfig ? await global.AE_LLM.resolveLlmConfig({ model: model, platform: platform }) : { model: model, platform: platform };
            if (_hasVisionProxy) {
                // 视觉代理优先：配置了视觉代理时，无论主模型是否支持视觉，都用视觉模型生成中文描述
                console.log('[Agent] 用户附带了 ' + imgs.length + ' 张图片，使用视觉代理模型转描述。');
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('正在用视觉代理模型分析 {n} 张图片...', { n: imgs.length }), 'info', { autoHideMs: 4000 });
                }
                var _userImageItems = [];
                for (var uii = 0; uii < imgs.length; uii++) {
                    if (imgs[uii]) _userImageItems.push({ url: imgs[uii], hint: '用户上传的图片', purpose: intentValidation.extractUserRequirement(messages) });
                }
                var _userImageResults = await visionProxy.describeImagesViaVisionProxy(_userImageItems);
                // 逐项对齐原始下标（同视频路径的处理）——过滤 null 压缩重编号
                // 会使部分失败时【图片 N】序号错位、失败图凭空消失。null 项占位标注。
                var _userImageOkCount = 0;
                for (var uir = 0; uir < _userImageResults.length; uir++) {
                    if (_userImageResults[uir]) _userImageOkCount++;
                }
                if (_userImageOkCount > 0) {
                    var _uDescText = _userImageResults.length === 1
                        ? _userImageResults[0]
                        : _userImageResults.map(function (d, i) { return '【图片 ' + (i + 1) + '】\n' + (d || '[第 ' + (i + 1) + ' 张图片描述失败，视觉代理无法分析其内容]'); }).join('\n\n');
                    for (var umi = messages.length - 1; umi >= 0; umi--) {
                        if (messages[umi].role === 'user') {
                            messages[umi].content = (messages[umi].content || '') + '\n\n[用户附带的图片描述（由视觉代理模型生成）：\n' + _uDescText + '\n]';
                            break;
                        }
                    }
                } else if (global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(resolved.model, resolved.platform)) {
                    // 代理全部失败 + 主模型支持视觉：回退直接注入 image_url
                    for (var rmi = messages.length - 1; rmi >= 0; rmi--) {
                        if (messages[rmi].role === 'user') {
                            var rImageParts = [];
                            for (var rii = 0; rii < imgs.length; rii++) {
                                if (imgs[rii]) {
                                    rImageParts.push({ type: 'image_url', image_url: { url: imgs[rii] } });
                                }
                            }
                            rImageParts.push({ type: 'text', text: messages[rmi].content || '' });
                            messages[rmi].content = rImageParts;
                            break;
                        }
                    }
                    if (global.AEToast) global.AEToast.show(AEI18n.t('视觉代理分析图片失败，已回退主模型直接识别'), 'warn');
                } else {
                    // 视觉代理调用全部失败：降级为提示
                    if (typeof opts.showStatus === 'function') {
                        opts.showStatus(visionProxy.getVisionProxyFailReason() === 'no_api_key'
                            ? AEI18n.t('视觉代理平台未配置 API Key，无法分析图片')
                            : AEI18n.t('视觉代理模型分析图片失败，请检查视觉模型配置'), 'warn', { autoHideMs: 6000 });
                    }
                    for (var fmi = messages.length - 1; fmi >= 0; fmi--) {
                        if (messages[fmi].role === 'user') {
                            messages[fmi].content = (messages[fmi].content || '') + '\n\n' + visionProxy.buildVisionProxyFailMessage('系统提示：用户附带了 ' + imgs.length + ' 张图片', '图片描述');
                            break;
                        }
                    }
                }
            } else if (global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(resolved.model, resolved.platform)) {
                // 未配置视觉代理 + 主模型支持视觉：直接注入 image_url
                for (var mi = messages.length - 1; mi >= 0; mi--) {
                    if (messages[mi].role === 'user') {
                        var imageParts = [];
                        for (var ii = 0; ii < imgs.length; ii++) {
                            if (imgs[ii]) {
                                imageParts.push({ type: 'image_url', image_url: { url: imgs[ii] } });
                            }
                        }
                        imageParts.push({ type: 'text', text: messages[mi].content || '' });
                        messages[mi].content = imageParts;
                        break;
                    }
                }
            } else {
                console.log('[Agent] 用户附带了 ' + imgs.length + ' 张图片，但当前模型 ' + (resolved.model || model) + ' 不支持视觉分析，图片未发送。');
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('当前模型不支持视觉，{n} 张图片未发送 — 请切换至 Claude / Gemini / Kimi 等视觉模型，或在模型管理面板配置视觉代理模型', { n: imgs.length }), 'warn', { autoHideMs: 6000 });
                }
                // 在用户消息中注入提示，让 LLM 告知用户
                for (var mi2 = messages.length - 1; mi2 >= 0; mi2--) {
                    if (messages[mi2].role === 'user') {
                        messages[mi2].content = (messages[mi2].content || '') + '\n\n[系统提示：用户在此消息中附带了 ' + imgs.length + ' 张图片，但当前模型不支持视觉功能。请在回复中告知用户：如需分析图片，请切换至支持视觉的模型（如 Claude、Gemini、Kimi K2.5 等），或在模型管理面板顶部配置视觉代理模型。]';
                        break;
                    }
                }
            }
        }

        // ── 上下文预算口径同步（Agent/Script 两个 loop 共用这一份）──────────
    // ① 固定开销（system prompt + tools）：真实请求大小 = 历史 + 该开销（原口径只算历史→触发滞后）
    // 开销存档键：team lane 用 'lane:<id>'，单 Agent 三档仍用 agent/script/shader。
    // 不同 lane 的工具集与提示词骨架不同（导演剔除执行工具、GLSL 用 shader 骨架），
    // 共用一个键会让后一次测量的值被所有 lane 读走（真机：导演与 AE 执行 lane 都显示 19.5K）。
    function _overheadStoreKey(mode) {
        var lane = '';
        try { lane = getLaneId() || ''; } catch (_) { lane = ''; }
        return lane ? ('lane:' + lane) : mode;
    }
    // ② 模型自报窗口：生效分母 = min(设置, 窗口)；读不到/低于采纳下限时不施加
    //    —— 读窗口的唯一实现在 context.js（readModelContextWindow），此处只调不重写
    // ③ 上次已知开销落盘：会话恢复时 bootstrap 用它 prime，避免「发送前的自动压缩闸」与
    //    用量条按 overhead=0 的低值判断（重载面板后第一句话该压不压）
    var OVERHEAD_STORE_KEY = 'ae_agent_ctx_overhead_v1';
    function _rememberOverhead(modeKey, ovh) {
        try {
            if (!global.localStorage || !modeKey) return;
            var raw = global.localStorage.getItem(OVERHEAD_STORE_KEY);
            var map = raw ? JSON.parse(raw) : {};
            if (!map || typeof map !== 'object') map = {};
            map[modeKey] = Math.max(0, Math.floor(Number(ovh) || 0));
            global.localStorage.setItem(OVERHEAD_STORE_KEY, JSON.stringify(map));
        } catch (_) { /* 存储不可用/损坏：不影响当前轮 */ }
    }

    // 把模型窗口写进 cm（生效分母）；无实现/读不到即写 0 = 不施加 min()。
    // 窗口先于开销写：窗口变小可能要按新上限裁剪，顺序反了会多删一轮。
    function _applyModelWindowLimit(cm) {
        if (!cm || typeof cm.setModelWindowLimit !== 'function') return;
        if (!(global.AEEngine && typeof global.AEEngine.readModelContextWindow === 'function')) return;
        cm.setModelWindowLimit(global.AEEngine.readModelContextWindow(
            opts.getPlatform ? opts.getPlatform() : '',
            opts.getModel ? opts.getModel() : ''
        ));
    }

    // 硬上限裁剪（pruneByTokens 因 total > 生效上限而删除）不再静默——每轮最多提示一次。
    // 为什么保留 100% 的硬上限而不把 prune 阈值也降到触发线（任务里给的第一个方案）：见
    // context.js pruneByTokens 的注释——那会让静默删除提前到触发线（当时 90%，现 85%），
    // 用更激进的丢数据掩盖时序问题。
    function _reportStorageCapEvents(cm) {
        if (!cm || typeof cm.consumeStorageCapEvents !== 'function') return;
        var evs;
        try { evs = cm.consumeStorageCapEvents(); } catch (_) { return; }
        if (!evs || !evs.length) return;
        var count = 0;
        for (var i = 0; i < evs.length; i++) count += (evs[i] && evs[i].count) || 0;
        if (!count) return;
        if (typeof opts.showStatus === 'function') {
            // 只留用户能做的事与事实：删掉「本轮起优先改用摘要压缩」
            // ——那是引擎内部策略，用户既不能验证也无对应动作。
            opts.showStatus(AEI18n.t('⚠ 上下文已达上限，已裁剪 {n} 条最早的消息（已归档，可用 read_early_history 回顾）', { n: count }),
                'warn', { autoHideMs: 8000 });
        }
    }

    // ── 工具循环收尾与完成提示音 ──────────────────
    // 两套工具循环（processToolLoop / processScriptToolLoop）共用「当前轮结束、
    // 回到空闲」的收尾，Script 侧整份漏掉完成提示音（真机：「script 模式一轮跑完不响
    // 完成音，跟 Agent 不一致」）。收尾收敛到下面两个函数，音效按结局分档，口径与
    // Agent 循环既有行为一致：
    //   clean / stop → done（用户停止也提示「已回到空闲」——Agent abort 出口原本就会响）
    //   limit        → warn（撞轮次上限，对齐 Agent maxLoops 出口）
    //   error        → error（流式/网络错误）
    // 分工：_beepRoundEnd 只播音效，给「收尾时序另有讲究」的分支用（Agent maxLoops
    // 出口的 _stopping 清零必须延后到递归判定之后，那里只补音、不做完整收尾）；
    // _finalizeRound 做完整收尾，只在当前轮真正的终点调用（递归续轮由调用方抑制）。
    function _beepRoundEnd(endKind) {
        if (typeof aeBeep !== 'function') return;
        var kind = endKind || 'clean';
        aeBeep(kind === 'limit' ? 'warn' : (kind === 'error' ? 'error' : 'done'));
    }
    function _finalizeRound(endKind) {
        state.busy = false;
        _stopping = false;
        state.busyText = '';
        state.streamingContent = '';
        // 出口对称清零：与 streamingContent 一致，防下一次调用入口前的读取点
        // （含 Script 模式 fallback）拿到本条消息的思考残留。
        state.streamingReasoning = '';
        _beepRoundEnd(endKind);
        chatViewHelpers.syncView();
    }

    async function processToolLoop(userText) {
            _visionImagesInjected = false;
            _currentUserText = userText || '';
            var settings = getSettings();
            var model = opts.getModel ? opts.getModel() : '';
            var platform = opts.getPlatform ? opts.getPlatform() : '';

            // 视觉能力判断（需在构建 systemPrompt 之前完成，以便注入视觉信息）
            var visionModel = '';
            var visionPlatform = platform;
            try {
                if (global.AE_LLM && global.AE_LLM.resolveLlmConfig) {
                    var vCfg = await global.AE_LLM.resolveLlmConfig({ model: model, platform: platform });
                    visionModel = (typeof vCfg === 'string') ? vCfg : (vCfg && vCfg.model) || model || '';
                    visionPlatform = (vCfg && vCfg.platform) || platform;
                    if (typeof visionModel !== 'string') visionModel = '';
                }
            } catch (_) { visionModel = typeof model === 'string' ? model : ''; }
            if (!visionModel && typeof model === 'string') visionModel = model;
            if (typeof visionModel !== 'string') visionModel = '';
            _visionModelName = visionModel;
            _visionPlatform = visionPlatform;
            var _agentCanVision = !!(visionModel && global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(visionModel, visionPlatform));
            // 主模型是否支持视频能力（read_video 注入/过滤、提示词能力声明共用）
            var _agentCanVideo = !!(model && global.AE_LLM && global.AE_LLM.supportsVideo && global.AE_LLM.supportsVideo(model, platform));
            // 视觉代理模型配置：非视觉主模型遇到图片时，后台用此模型转描述
            try {
                var _vpGlobals = opts.getGlobalSettings ? await opts.getGlobalSettings() : {};
                _visionProxyProviderId = _vpGlobals.visionProviderId || '';
                _visionProxyModelId = _vpGlobals.visionModelId || '';
            } catch (_) { _visionProxyProviderId = ''; _visionProxyModelId = ''; }
            _hasVisionProxy = !!(_visionProxyProviderId && _visionProxyModelId);
            // 视觉代理模型是否支持视频：能力事实句据此区分「代理可看视频」与「代理只看图」。
            // 与 visionProxy.js 判定同源：先 resolveLlmConfig 再查能力位（孤儿模型 ID 按实际回退值）。
            var _visionProxyCanVideo = false;
            if (_hasVisionProxy && global.AE_LLM) {
                try {
                    var _vpCfg = global.AE_LLM.resolveLlmConfig
                        ? await global.AE_LLM.resolveLlmConfig({ model: _visionProxyModelId, platform: _visionProxyProviderId })
                        : { model: _visionProxyModelId, platform: _visionProxyProviderId };
                    var _vpCfgModel = (_vpCfg && _vpCfg.model) || _visionProxyModelId;
                    var _vpCfgPlatform = (_vpCfg && _vpCfg.platform) || _visionProxyProviderId;
                    _visionProxyCanVideo = !!(global.AE_LLM.supportsVideo
                        && global.AE_LLM.supportsVideo(_vpCfgModel, _vpCfgPlatform));
                } catch (_) { _visionProxyCanVideo = false; }
            }

            // 提示词按模式选：**仅 shader** 拿 GLSL 契约提示词；agent 与 external 走 Agent
            // 提示词。external 走 Agent 是**有意**（其工具是三方合并的扁平清单，与 Agent 的
            // 自主多步形态同族；GLSL/代码契约对外接由各工具描述承载，不在系统提示词里注入
            // 契约全文）。显式写出而非留给 else，免被读成"漏了 external"。
            var isShaderMode = settings.runtimeMode === 'shader';
            // 注入信号取预览区当前代码（与 shader 工具同一个 accessor——shaderTools
            // 的 get_current_shader / 写前比对读的都是它）。取不到就传空串 → 只常驻核心 + 索引。
            var _shaderSrcForPrompt = '';
            if (isShaderMode && typeof opts.getCurrentShader === 'function') {
                try { _shaderSrcForPrompt = String(opts.getCurrentShader() || ''); } catch (_) { _shaderSrcForPrompt = ''; }
            }
            // 骨架选择：lane 自带 promptKind（director/agent/shader，定义源在 lanes.js，
            // bootstrap 随 lane 身份下发）；单 Agent 路径没有 lane ⇒ 按 runtimeMode 折成同名字符串。
            // 选择动作住在 prompts.js 的 buildToolSystemPrompt（纯函数，单测可直驱）——
            // controller 只负责把身份翻译成 kind，**不写 lane id 字面量**（防第二份事实源）。
            var _prompts = global.AEEngine && global.AEEngine.prompts;
            var _laneKind = (opts.lane && typeof opts.lane.promptKind === 'string' && opts.lane.promptKind)
                ? opts.lane.promptKind
                : (isShaderMode ? 'shader' : 'agent');
            var basePrompt = (_prompts && typeof _prompts.buildToolSystemPrompt === 'function')
                ? _prompts.buildToolSystemPrompt(_laneKind, settings.userPersona || '', model,
                    _agentCanVision, _agentCanVideo, _hasVisionProxy,
                    // teamLane：骨架「交付边界」那行的分叉信号（团队 ⇒ 入库并交 AE 执行挂载；
                    // 单 Agent ⇒ 用户手动保存）。判据用本 controller 的 lane 身份（opts.laneId /
                    // opts.lane.id，子 Agent 拿到的是父 lane）——不在这里另写一份 lane 名单。
                    // isToolVisible：system prompt 按本视图有效可见性裁剪（stub 铁律），
                    // 谓词由闸口现算；子 Agent 用派生时冻结的闸口实例。
                    { currentShader: _shaderSrcForPrompt, teamLane: !!getLaneId(), proxyCanVideo: _visionProxyCanVideo,
                        isToolVisible: _promptToolVisible })
                : ((_prompts && _prompts.buildAgentToolSystemPrompt)
                    ? _prompts.buildAgentToolSystemPrompt(settings.userPersona || '', model, _agentCanVision, _agentCanVideo, _hasVisionProxy, _visionProxyCanVideo, _promptToolVisible)
                    : 'You are AE_Agent. Use tools to operate After Effects.');
            var promptBuilder = opts.promptBuilder || (global.AE_LLM && global.AE_LLM.promptBuilder);
            // 提示词上下文带当前轮模式：与 _buildRoundTools(isShaderMode ? 'shader' : 'agent')
            // 的执行侧身份对齐（7.11：<available_skills> 等注入按模式过滤）。
            var systemPrompt = promptBuilder
                ? promptBuilder.build(basePrompt, _promptBuildContext(isShaderMode ? 'shader' : 'agent'))
                : basePrompt;

            var apiKey = await resolveApiKeyForPlatform(platform);
            var maxLoops = MAX_TOOL_LOOPS;
            // 循环内自动压缩失败的提示闸（按轮只提示一次：每个 loop 都会重试，逐次提示会刷屏）
            var _loopCompressFailNotified = false;

            // 统一工具集组装：作用域过滤 + 语义门控 + 轮次状态同步（stub 名单 / 当前轮投放清单 /
            // 门控原因表——后两者供执行侧「门控不可用」与「当前轮投放清单」闸门读，见 _buildRoundTools）
            var tools = _buildRoundTools(isShaderMode ? 'shader' : 'agent', {
                blacklist: null,
                canVision: _agentCanVision,
                canVideo: _agentCanVideo,
                hasVisionProxy: _hasVisionProxy
            });

            // 口径统一：system prompt + tools 是每轮请求的固定开销，写入 cm 后
            // percentUsed / 裁剪 / 预算回填均按真实请求大小计（修复原口径只算
            // 历史消息导致的压缩触发滞后）。mock cm 无该方法时跳过（兼容测试桩）
            // 先按模型窗口设生效分母，再写开销并把上次值落盘。
            var _ovhCm = chatViewHelpers.getActiveCm();
            _applyModelWindowLimit(_ovhCm);
            if (_ovhCm && typeof _ovhCm.setOverheadTokens === 'function') {
                _ovhCm.setOverheadTokens(_estimateFixedOverheadOf(systemPrompt, tools));
                _rememberOverhead(_overheadStoreKey(isShaderMode ? 'shader' : 'agent'), _ovhCm.getOverheadTokens());
            }
            // thinking 模式声明：带 tool_calls 但思考为空的轮次必须补空 reasoning_content
            // 字段——thinking + tools 的协议要求，缺字段直接 400（"The reasoning_content in
            // the thinking mode must be passed back to the API."）。非思考 provider 保持
            // false：请求体里不会多出该字段。三个来源取「或」（只加不减）：
            //   ① 模型级思考模式意图：thinking.mode !== 'off'（模型管理「编辑模型能力」里选
            //      「开启/自定义」——此时请求会带原生思考参数，模型必然产出思考）；
            //   ② 模型级能力位：capabilities.thinking——给「默认就思考、无需/无法用参数声明」
            //      的模型（如火山 doubao-*-thinking-*、kimi-k3）留的声明入口；
            //   ③ provider 级逃生舱：requestOptions.extraBody.thinking.type==='enabled'
            //      （历史写法与手改预设的兼容路径）。
            // 注意「只加不减」：关掉这些开关不会解除供应商侧已开的思考（否则用户手一抖
            // 反而把保护关掉、直接踩 400）。
            // 与 setOverheadTokens 同款「每次构建请求时写入」的非持久化状态。
            if (_ovhCm && typeof _ovhCm.setReasoningReplay === 'function') {
                var _thinkingProvider = false;
                try {
                    var _provReg = global.AE_LLM && global.AE_LLM.providerRegistry;
                    if (_provReg && typeof _provReg.getModelThinking === 'function') {
                        _thinkingProvider = _provReg.getModelThinking(platform, model).mode !== 'off';
                    }
                    if (!_thinkingProvider && _provReg && typeof _provReg.supportsThinking === 'function') {
                        _thinkingProvider = _provReg.supportsThinking(platform, model);
                    }
                    if (!_thinkingProvider) {
                        var _provCfg = _provReg && typeof _provReg.getProvider === 'function'
                            ? _provReg.getProvider(platform) : null;
                        var _extraBody = _provCfg && _provCfg.requestOptions && _provCfg.requestOptions.extraBody;
                        _thinkingProvider = !!(_extraBody && _extraBody.thinking && _extraBody.thinking.type === 'enabled');
                    }
                } catch (_) { _thinkingProvider = false; }
                _ovhCm.setReasoningReplay(_thinkingProvider);
            }

            // 从历史 messages 重建 searchedTools：会话重载/编辑重发后，历史 tool_search 结果
            // 已在 contextManager 中，LLM 上下文可见，闸门应放行已搜过的工具。
            // 必须显式传当前模式的 cm（本函数 Agent/Shader 共用）：无参调用回退 agent 会话，
            // Shader 模式会拿 agent 的 tool_search 历史越权放行、本模式已搜过的被误锁
            //（对齐 apiActions 压缩链路与下方 Script 入口的传参方式）。
            toolHistory.rebuildSearchedToolsFromHistory(chatViewHelpers.getActiveCm());

            var messages = [{ role: 'system', content: systemPrompt }];
            var contextMsgs = chatViewHelpers.getActiveCm().toLlmMessages();
            for (var ci = 0; ci < contextMsgs.length; ci++) {
                var cm = contextMsgs[ci];
                var msgEntry = { role: cm.role, content: cm.content };
                if (cm.tool_call_id) msgEntry.tool_call_id = cm.tool_call_id;
                if (cm.name) msgEntry.name = cm.name;
                if (cm.tool_calls) msgEntry.tool_calls = cm.tool_calls;
                // 判 undefined（含空串）——理由见上方 agent 管线同名拷贝点
                if (cm.reasoning_content !== undefined) msgEntry.reasoning_content = cm.reasoning_content;
                messages.push(msgEntry);
            }
            // 动态上下文（模型/时间/AE snapshot）已在 addMessage 时持久化到 user message
            // （<context> 前缀），历史消息内容稳定，无需在此临时注入。
            var pendingImages = _pendingImages;
            _pendingImages = null;
            // 三分支视觉注入逻辑已外提为 _injectUserImagesIntoMessages（纯迁移），
            // 此处主消费点语义不变：发送路径 setPendingImages 的图片注入最后一条 user 消息。
            if (pendingImages && pendingImages.length > 0) {
                await _injectUserImagesIntoMessages(messages, pendingImages, model, platform);
            }
            var channel = opts.llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel);
            if (!channel || !channel.sendStream) {
                throw new Error('LLM_CHANNEL_UNAVAILABLE: llmChannel 未注入或 sendStream 不可用');
            }

            state.busy = true;
            state.streamingContent = '';
            // 入口即清（纵深防御）：streamingReasoning 与 streamingContent 同为调用级
            // 瞬态，跨调用残留无意义。当前可达路径由循环内每轮流式前清零兜底，
            // 此处显式清零保证「上一次调用的思考不泄漏进下一次调用的停止产物」
            // 不依赖循环内清零点的位置（回归测试 agent-stop-reasoning-residual 锁定）。
            state.streamingReasoning = '';
            state.toolCallInProgress = null;
            chatViewHelpers.syncView();

            var accumulatedContent = '';
            var finalToolCalls = null;
            var loopCount = 0;
            var stickyMessage = '以上工具调用已完成。请根据结果继续完成用户原始需求，如果已经完成请回复确认结果。用户原始需求: ' + userText;

            // ── Tool loop: controller 掌管循环，llmChannel 只管单次传输 ──
            while (loopCount < maxLoops) {
                if (stopRequested) break;
                loopCount++;
                // 当前轮是否已把 assistant 写入 state.messages（工具调用轮在下方 840 处写）。
                // 用于循环出口判重：避免工具轮已写过的 assistant 被末尾再写一遍 → 重复消息。
                var _assistantPushedThisRound = false;
                // 当前轮 sendStream 是否触发过 onToken（即 LLM 真的吐过字）。
                // accumulatedContent 跨轮保留——当前轮若没流式过，它仍是上一轮的值。
                // 网络错误分支据此判别能否把 accumulatedContent 当当前轮部分回复保留，避免误存上一轮内容。
                var _streamedThisRound = false;

                // ── 上下文超阈值自动压缩（loop 内）──
                // 在 drain 之前压缩：让用户追加的消息保留在最近窗口，不被压缩掉
                // 首轮（loopCount===1）不压缩：上下文刚构建，通常不会超阈值
                // 判闸用**未取整**的 percentUsedRaw（取整会把 89.5% 抬到阈值 90 而误触发），
                _reportStorageCapEvents(chatViewHelpers.getActiveCm());
                if (loopCount > 1) {
                    var _loopStats = chatViewHelpers.getActiveCm().getTokenStats();
                    // 判闸用**未取整**的 percentUsedRaw（真值 89.5% 若被 Math.round 成 90 就会触发），
                    // 阈值从 cm 取（COMPACT_TRIGGER_PCT 唯一一份）；mock cm 无该字段时回退到同值（85）
                    var _loopPct = (typeof _loopStats.percentUsedRaw === 'number')
                        ? _loopStats.percentUsedRaw : (_loopStats.percentUsed || 0);
                    var _loopTrigger = (typeof _loopStats.compactTriggerPct === 'number')
                        ? _loopStats.compactTriggerPct : 85;
                    // 「待压缩」标记（本会话撞过硬上限被裁剪过）要有**生产消费点**：
                    // 裁剪后百分比可能暂时回落而标记仍在 ⇒ 下一轮补一次摘要压缩。5% 下限与
                    // compressContext 自身判据（<5% ⇒ nothing_to_compress）对齐，避免空转。
                    var _loopFlag = _loopStats.needsCompaction === true;
                    if (_loopPct >= _loopTrigger || (_loopFlag && _loopPct >= 5)) {
                        var _compressResult = await _api.compressContext({ internal: true });
                        // 压缩 await 窗口内可能已点停止（requestStop 的 abort 只中止在途请求，
                        // 对即将发起的新 sendStream 无效）：复查后立即跳出，防停止被延迟
                        // 一整轮 LLM 调用（busy 已置 false 的"僵尸轮"继续流式输出）。
                        // 置位 _assistantPushedThisRound 防出口块用上一轮的 accumulatedContent
                        // 陈旧值再推一遍（对齐 abort 分支的同款处理）。
                        if (stopRequested) {
                            _assistantPushedThisRound = true;
                            break;
                        }
                        if (_compressResult && _compressResult.success) {
                            // 压缩改写了 cm，必须重建 messages 局部变量
                            // 否则下一轮 sendStream 用的还是旧 messages（含已删的旧消息）
                            messages = [{ role: 'system', content: systemPrompt }];
                            var _contextMsgs = chatViewHelpers.getActiveCm().toLlmMessages();
                            for (var _ci = 0; _ci < _contextMsgs.length; _ci++) {
                                var _cm = _contextMsgs[_ci];
                                var _msgEntry = { role: _cm.role, content: _cm.content };
                                if (_cm.tool_call_id) _msgEntry.tool_call_id = _cm.tool_call_id;
                                if (_cm.name) _msgEntry.name = _cm.name;
                                if (_cm.tool_calls) _msgEntry.tool_calls = _cm.tool_calls;
                                // reasoning_content 判 undefined 而非真值：上下文层会主动下发空串
                                // （带 tool_calls 的轮次字段必须存在，DeepSeek thinking 协议要求），
                                // 用真值判断会把空串再次丢掉，等于没修
                                if (_cm.reasoning_content !== undefined) _msgEntry.reasoning_content = _cm.reasoning_content;
                                messages.push(_msgEntry);
                            }
                            if (typeof opts.showStatus === 'function') {
                                // 文案里的百分比取**实际阈值**（不再硬编码 90：阈值改成别的数时文案自动跟随）
                                opts.showStatus(AEI18n.t('✓ 上下文已超 {pct}%，已自动压缩', { pct: _loopTrigger }), 'info', { autoHideMs: 3000 });
                            }
                        } else if (_compressResult && _compressResult.error && !_loopCompressFailNotified) {
                            // 循环内自动压缩失败时静默（只有成功分支有提示）：该轮继续跑，
                            // 用户看不到任何信号。按轮只提示一次（每个 loop 都会重试，逐次提示会刷屏）。
                            _loopCompressFailNotified = true;
                            if (typeof opts.showStatus === 'function') {
                                var _cfTextLoop = typeof _api.describeCompressFailure === 'function'
                                    ? _api.describeCompressFailure(_compressResult.error)
                                    : '压缩失败，请稍后再试。';
                                opts.showStatus(AEI18n.t('⚠ 自动压缩未完成：{reason}', { reason: _cfTextLoop }), 'error', { autoHideMs: 8000 });
                            }
                        }
                    }
                }

                // ── 注入执行中用户追加的消息（不打断，只是让下一轮 LLM 看到）──
                // 派发时机（settings.deferInjectUntilReply）：关闭（默认）
                // = 每轮请求前都注入，即「下一轮就发送」；开启 = 用户消息只在**轮次起点**
                //（loopCount===1，即新一轮的第一次 LLM 请求前）注入，轮内留在队列——循环出口的
                // 递归会在当前轮正式回复落盘后起新一轮消费它，即「给到正式回复才发送」。
                // 后台异步结果（systemResult）与跨会话条目不是用户待发送消息，仍每轮即时处理。
                if (_injectQueue.length > 0) {
                    var _deferUserInject = !!(settings && settings.deferInjectUntilReply);
                    var _keptForNextTurn = [];
                    var _consumedAny = false;
                    for (var qi = 0; qi < _injectQueue.length; qi++) {
                        var inj = _injectQueue[qi];
                        // 跨会话条目路由回原会话——不写入当前 cm、不进当前轮
                        // messages（不触发当前会话 LLM）。appendToSession 内部自捕获
                        // 异常，此处 fire-and-forget 即可。
                        if (_isCrossSessionInject(inj)) {
                            apiActions.appendToSession(inj.sessionId, inj);
                            _consumedAny = true;
                            continue;
                        }
                        // 后台异步结果（ComfyUI 生成完成/失败）以 system-result 卡片入历史，并作为消息发给当前轮 LLM
                        if (inj.systemResult) {
                            var _srMsg = chatViewHelpers.pushSystemResult(inj.title, inj.visible, inj.detail, inj.llmRole);
                            // 与 toLlmMessages 复用同一份完整格式（含 detailText 与媒体路径标记），
                            // 避免当前轮只喂裸 JSON、下一轮才读到完整格式的分叉。
                            messages.push({ role: inj.llmRole === 'assistant' ? 'assistant' : 'user', content: chatViewHelpers.getActiveCm().systemResultContent(_srMsg) });
                            _consumedAny = true;
                            continue;
                        }
                        // 用户消息的延后模式：轮内（loopCount>1）原样留队，由循环出口起新一轮
                        // （轮次起点 loopCount===1）时再注入。悬浮待发送 chip 在此期间保持显示。
                        if (_deferUserInject && loopCount > 1) {
                            _keptForNextTurn.push(inj);
                            continue;
                        }
                        // addMessage 内部已调 chatViewHelpers.getActiveCm().add() 持久化到 contextManager，
                        // 此处不再重复调 agentContextManager.add——否则同一条消息会被持久化两次，
                        // 重启后从会话文件恢复时重复显示。
                        // addMessage 会注入 <context> 前缀，返回持久化后的完整 text，用于发给 LLM。
                        // 附件字段（videos/fileRefs/fileCtx）随队列条目透传（busy 期间提交的附件，
                        // 与发送路径一致地持久化到历史）。
                        var persistedText = messageHelpers.addMessage('user', inj.text, inj.detail, inj.images, {
                            displayText: inj.displayText,
                            videos: inj.videos,
                            fileRefs: inj.fileRefs,
                            fileCtx: inj.fileCtx
                        });
                        messages.push({ role: 'user', content: persistedText });
                        // 执行中追加的图片消息——视觉通道（imageDataUrls）随队列
                        // 条目透传，drain 进当前轮 messages 后立即按主消费点同款三分支逻辑
                        // 注入刚 push 的这条 user 消息（helper 注入目标是 messages 末尾
                        // 最后一条 user 消息，此刻即本条），LLM 当前轮即可看到图片。
                        // 视觉通道数据若在入队时被丢弃，图片只落盘不进 LLM。
                        if (inj.imageDataUrls && inj.imageDataUrls.length > 0) {
                            await _injectUserImagesIntoMessages(messages, inj.imageDataUrls, model, platform);
                        }
                        _consumedAny = true;
                    }
                    _injectQueue.length = 0;
                    // 留队条目按原顺序放回（必须放在清空之后：循环里新的追加由下一轮再处理）
                    if (_keptForNextTurn.length) _injectQueue.push.apply(_injectQueue, _keptForNextTurn);
                    // 只有真消费了条目才更新忙碌文案并重绘；延后模式下整队留着时状态没变，
                    // 不无谓 syncView（执行中流式 token 在追加，全量重渲染会打断流式状态）
                    if (_consumedAny) {
                        state.busyText = AEI18n.t('已收到追加消息，本轮后处理...');
                        chatViewHelpers.syncView();
                    }
                }

                // ── drain 后的停止复查（对齐上方压缩分支的同款处理）──
                // drain 中 _injectUserImagesIntoMessages 的 await（图片转码 + 视觉代理识图）
                // 可达数十秒；requestStop 的 abort 只中止"此刻已登记"的 controller，对随后
                // 新建的 sendStream 无效——不复查会照样发起整轮 LLM 请求并执行该轮第一个工具
                //（用户已看到按钮变回"发送"的"僵尸轮"）。置 _assistantPushedThisRound 防出口块
                // 用上一轮的 accumulatedContent 陈旧值再推一遍（对齐压缩分支/abort 分支）。
                if (stopRequested) {
                    _assistantPushedThisRound = true;
                    break;
                }

                // ── 当前轮起点的写入位置（打断补写用）──
                // 「立刻发送」的用户消息在点击瞬间就落库（apiActions.sendInjectItem），而被中断
                // 那一轮的半成品 assistant 要等 abort 传上来才落库——按追加会让 UI 与 LLM 上下文
                // 同时出现「user(打断者) → assistant(被打断)」的错序。记录长度，打断分支据此把半成品
                // 插回它本来该在的位置。
                // **锚位在当前轮输入组装完毕之后**（压缩 → drain 之后，紧邻请求发出）：drain 进来的
                // 用户消息属于**当前轮输入**，半成品是它的响应、应排其后；打断者则是在这之后才落库的，
                // 半成品应排其前。锚位若提前到 drain 之前，半成品会被插到它本该回应的消息之前。
                // 除数字下标外再记轮初最后一条 cm 消息的**引用**——轮内工具结果/追加消息
                // 落库触发 pruneByTokens 删头后，数字下标会前移错位，补写落点一律经
                // _roundStartInsertIndex(chatViewHelpers.getActiveCm()) 现算（见该 helper）。
                var _roundStartCmIdx = chatViewHelpers.getActiveCm().list().length;
                _roundStartCmAnchor = _roundStartCmIdx > 0 ? chatViewHelpers.getActiveCm().list()[_roundStartCmIdx - 1] : null;
                var _roundStartUiIdx = state.messages.length;

                state.streamingContent = '';
                state.streamingReasoning = '';
                state.toolCallInProgress = null;

                // 当前轮 LLM 计时：首token 延迟 = 请求发出 → 首个 token（content/reasoning 谁先到）；
                // LLM 运行时间 = 请求发出 → 流结束。
                // 发生自动重试时以**最后一次请求**为基准（每次发送前重置）——退避等待属于
                // 传输开销，不该算进「模型多久吐出第一个字」。
                var _llmT0 = Date.now();
                var _firstTokenT = 0;
                var _llmRequest = {
                    messages: messages,
                    tools: tools,
                    apiKey: apiKey,
                    model: model,
                    platform: platform,
                    // 当前会话 id：声明式会话头（如 OpenCode Go 的 x-opencode-session）用它取值，
                    // 同一会话内稳定 → 服务端路由/前缀缓存可复用；无会话概念时 llmChannel 回退安装级 id
                    sessionId: chatViewHelpers.getActiveCm().getSessionId(),
                    // 绑定当前轮自己的 AbortController.signal——requestStop 只中止
                    // agent 在途请求，不再调全局 channel.abort() 误伤桌宠/ComfyUI/MCP 的
                    // 共享 LLM 通道（llmChannel.sendStream 经 options.signal 转发到内部 fetch）。
                    options: { timeoutMs: settings.requestTimeoutMs || 120000, signal: activeAbortController ? activeAbortController.signal : null },
                    reasoningEffort: settings.reasoningEffort || 'high'
                };
                // 当前轮请求是否流出过任何内容（content token 或 reasoning token）。自动重试只允许
                // 发生在「一个字都没吐出」的失败上：已经流出的内容若重发会重复展示、重复计费，
                // 故判据就取两个回调里的累计写入，不做二次推测。
                var _anyStreamOutput = false;
                // 自动重试（唯一实现见 controller/llmRetry.js）：只重试瞬时失败（网络异常/首字节前
                // 超时/429/5xx），不重试鉴权/额度/请求体这类确定性失败；用户点停止会立即中断
                // 退避等待，不再发起新请求。
                var _retryOutcome = await llmRetry.runWithRetry(function () {
                    _llmT0 = Date.now();
                    _firstTokenT = 0;
                    _anyStreamOutput = false;
                    return channel.sendStream(_llmRequest, {
                        onToken: function(token, full) {
                            _anyStreamOutput = true;
                            if (!_firstTokenT) _firstTokenT = Date.now();
                            state.streamingContent = full;
                            state.toolCallInProgress = null;
                            state.busyText = full.length > 60 ? full.slice(-60) : full;
                            accumulatedContent = full;
                            _streamedThisRound = true;
                            view.appendToken(token, full);
                        },
                        onReasoning: function(token, full) {
                            _anyStreamOutput = true;
                            if (!_firstTokenT) _firstTokenT = Date.now();
                            state.streamingReasoning = full;
                            state.busyText = AEI18n.t('思考中...');
                            view.appendReasoningToken(token, full);
                        }
                    });
                }, {
                    maxRetries: llmRetry.maxRetries,
                    baseDelayMs: llmRetry.baseDelayMs,
                    maxDelayMs: llmRetry.maxDelayMs,
                    hasOutput: function () { return _anyStreamOutput; },
                    isCancelled: function () { return stopRequested; },
                    onRetry: function (info) {
                        var _secs = Math.max(1, Math.round(info.delayMs / 1000));
                        state.busyText = AEI18n.t('请求失败（{reason}），{secs} 秒后重试...', { reason: info.reason, secs: _secs });
                        if (typeof opts.showStatus === 'function') {
                            opts.showStatus(AEI18n.t('⚠ 请求失败（{reason}），{secs} 秒后自动重试（第 {attempt}/{max} 次请求）', { reason: info.reason, secs: _secs, attempt: info.attempt, max: info.maxAttempts }), 'warn', { autoHideMs: 4000 });
                        }
                        chatViewHelpers.syncView();
                    }
                });
                var result = _retryOutcome.result;
                var _llmT1 = Date.now();
                if (_retryOutcome.retried && result && !result.error && typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('✓ 第 {n} 次请求成功', { n: _retryOutcome.attempts }), 'info', { autoHideMs: 3000 });
                }

                // 记录流式 usage（即使后续走 abort/error 分支，已经发生的请求 token 也应计入）
                // roundRec 供下方工具执行完毕后回填该轮工具耗时
                var roundRec = tokenStats.recordStreamUsage(result, 'agent-stream', {
                    firstTokenMs: _firstTokenT ? (_firstTokenT - _llmT0) : null,
                    llmDurationMs: _llmT1 - _llmT0
                });

                // ── 错误处理 ──
                if (result && result.error) {
                    // stop 触发的 abort：有排队消息->break 走结尾 replay；无消息->静默退出。
                    // 都不当失败处理，不弹"流式请求失败"。
                    var isAbort = stopRequested || result.error === 'aborted' || result.error === 'ABORTED'
                        || result.aborted === true || result.error === 'stopped'
                        // message 里的 abort 字样只在**没有状态码**的失败上采信：API_ERROR 的 message
                        // 是服务端错误体原文（网关 502/503 常见 "upstream request aborted"），按文案判
                        // 会把接口失败静默当停止——不落错误消息、不提示用户，用户只看到"没反应"。
                        || (result.error !== 'API_ERROR' && (result.message || '').toLowerCase().indexOf('abort') >= 0);
                    if (isAbort) {
                        // 清掉上一轮残留的 finalToolCalls：循环出口 996 用它判断是否要 add 到 contextManager，
                        // 若不清，非首轮 abort 时它是上一轮 toolCalls（非空）→ 出口跳过 contextManager.add，
                        // 导致 994 push 进 state.messages/UI 的部分回复没进 LLM 上下文 → UI 与上下文不一致。
                        finalToolCalls = null;
                        // 当前轮终态由本分支独占处理（有部分内容则在此推送，无则不推）。
                        // 必须无条件置位：accumulatedContent/reasoningContent 跨轮保留，
                        // 若仅在推送分支内置位，首轮后 abort 且当前轮未流式时出口块会拿
                        // 上一轮的陈旧值再推一遍 → 停止后出现重复的 assistant 消息。
                        _assistantPushedThisRound = true;
                        // 保留停止时已流式生成的部分回复 + 思考内容，折叠保存到上下文，避免凭空消失。
                        // 对齐网络错误分支的处理，但 abort 不弹"流式请求失败"。
                        var _abortReasoning = state.streamingReasoning || '';
                        var _abortContent = _streamedThisRound ? (accumulatedContent || '') : '';
                        if (_abortContent || _abortReasoning) {
                            // 把在途思考气泡定形为折叠 details，否则 renderMessages 会直接 remove 导致凭空消失
                            if (_abortReasoning && view && typeof view.finalizeReasoningStream === 'function') {
                                var _abortListEl = _laneListEl();
                                if (_abortListEl) view.finalizeReasoningStream(_abortListEl);
                            }
                            // 按当前轮起点插入而非追加：被中断这一轮属于「打断消息」之前
                            //（顺序问题与依据见 _roundStart*Idx 的定义处）
                            // 重绘判据取**插入前**的 UI 侧长度（state.messages 不参与裁剪、
                            // 重绘判据取**插入前**的 UI 侧长度（state.messages 不参与裁剪、
                            // 只增不减）与轮初 UI 下标比对——旧判据用会被裁剪的 cm 长度，长会话下
                            // 裁剪 K ≥ 当前轮新增时恒 false，中间插入画不出来、末条被重复追加；
                            // 取插入后的长度会因自身 +1 而恒真，导致纯停止也每次全量重绘。
                            var _stateLenBeforeInsert = state.messages.length;
                            _spliceAt(state.messages, _roundStartUiIdx,
                                { role: 'assistant', text: _abortContent, reasoningContent: _abortReasoning, createdAt: Date.now(), _llm: true });
                            chatViewHelpers.getActiveCm().insertAt(_roundStartInsertIndex(chatViewHelpers.getActiveCm()), 'assistant', _abortContent, null, { reasoningContent: _abortReasoning, _llm: true });
                            _forceFullRerenderIfMidList(_stateLenBeforeInsert, _roundStartUiIdx);
                            tokenStats.saveActiveSessionDebounced();
                        }
                        break;
                    }

                    state.busy = false;
                    state.busyText = '';
                    state.streamingContent = '';
                    // _stopping 的清零延后到 forced 判定之后——递归 prologue
                    // （resolveLlmConfig/getGlobalSettings 等 await → busy=true）存在
                    // 无守卫窗口，提前清守卫时 submitUserInput 直发/sendInjectItem
                    // 空闲直发/switchSession 并发放行（对齐出口 1358 递归期间保持
                    // _stopping=true 的既有正确形态）
                    // 网络错误（非 abort）时，保留当前轮已流式生成的部分回复，避免用户看到一半的内容凭空消失。
                    // 仅当当前轮流式过（_streamedThisRound）才保留——否则 accumulatedContent 是上一轮的值，
                    // 复用会变成上一轮回复的重复。push 后直接 return，不走循环出口 982，不会重复。
                    if (_streamedThisRound && accumulatedContent) {
                        // finalize reasoning 气泡，否则 syncView 后 renderMessages 会清掉 streaming 元素
                        if (state.streamingReasoning && view && typeof view.finalizeReasoningStream === 'function') {
                            var _errListEl = _laneListEl();
                            if (_errListEl) view.finalizeReasoningStream(_errListEl);
                        }
                        // 同 abort 分支：按当前轮起点插入（网络错误前若有打断消息落库，追加会错序）。
                        // UI 侧长度取插入前，理由见 abort 分支注释。
                        // UI 侧长度取插入前，理由见 abort 分支注释。
                        var _stateLenBeforeInsert = state.messages.length;
                        _spliceAt(state.messages, _roundStartUiIdx,
                            { role: 'assistant', text: accumulatedContent, reasoningContent: state.streamingReasoning || '', createdAt: Date.now(), _llm: true });
                        chatViewHelpers.getActiveCm().insertAt(_roundStartInsertIndex(chatViewHelpers.getActiveCm()), 'assistant', accumulatedContent, null, { reasoningContent: state.streamingReasoning || '', _llm: true });
                        _forceFullRerenderIfMidList(_stateLenBeforeInsert, _roundStartUiIdx);
                    } else if (state.streamingReasoning) {
                        // LLM 只流式了 reasoning 没有 content：保留思考内容，对齐 abort 分支
                        if (view && typeof view.finalizeReasoningStream === 'function') {
                            var _errListEl2 = _laneListEl();
                            if (_errListEl2) view.finalizeReasoningStream(_errListEl2);
                        }
                        var _stateLenBeforeInsert2 = state.messages.length;
                        _spliceAt(state.messages, _roundStartUiIdx,
                            { role: 'assistant', text: '', reasoningContent: state.streamingReasoning, createdAt: Date.now(), _llm: true });
                        chatViewHelpers.getActiveCm().insertAt(_roundStartInsertIndex(chatViewHelpers.getActiveCm()), 'assistant', '', null, { reasoningContent: state.streamingReasoning, _llm: true });
                        _forceFullRerenderIfMidList(_stateLenBeforeInsert2, _roundStartUiIdx);
                    }
                    chatViewHelpers.syncView();
                    // 自动重试用尽时如实标注次数：让用户知道这不是「一次就失败」，
                    // 也避免把「重试过仍失败」误读成重试机制没生效。
                    var _retryNote = (_retryOutcome && _retryOutcome.attempts > 1)
                        ? AEI18n.t('（已自动重试 {n} 次仍失败）', { n: _retryOutcome.attempts - 1 }) : '';
                    messageHelpers.addMessage('assistant', AEI18n.t('流式请求失败: {detail}', { detail: (result.message || result.error) + _retryNote }));
                    // 流式/网络错误 → 用户需重试，播放错误音效（统一分档：error）
                    _beepRoundEnd('error');
                    // 失败结果留给 goal 收尾判定：瞬时类失败（超时/网络/可重试状态码）自动续轮
                    _roundErrorFailure = result;
                    _roundEndKind = 'error';
                    // 网络错误 return 绕过出口的「立刻发送」消费点——该条已
                    // addMessage 持久化但从未送达 LLM（外层 finally 直接清空
                    // _forcedInjectText，用户看到已发而 Agent 永不响应）。对齐出口
                    // 1326 的消费形态：递归起新一轮单独处理该条（新轮再遇网络错误时
                    // _forcedInjectText 已空，自然 return，无死循环）
                    if (_forcedInjectText) {
                        stopRequested = false;
                        stopPromiseResolve = null;
                        activeAbortController = new AbortController();
                        var _forcedNext = _forcedInjectText;
                        _forcedInjectText = null;
                        // 递归处理的那条独立收尾：上一轮的失败不带给它，成功即按自然收尾判定
                        // （否则成功后的 finally 仍按 error 记 streak 并额外补一轮）。
                        _roundEndKind = 'clean';
                        _roundErrorFailure = null;
                        return processToolLoop(_forcedNext);
                    }
                    _stopping = false;
                    return;
                }

                // ── 无 tool_calls → LLM 给出了最终回复，结束 ──
                if (!result.toolCalls || result.toolCalls.length === 0) {
                    // accumulatedContent 仅在当前轮流式过时才 fallback 到旧值（onToken 设的），
                    // 否则用 ''：避免 LLM 返回空内容时把上一轮的 content 当最终回复重复推入。
                    accumulatedContent = result.content || (_streamedThisRound ? accumulatedContent : '');
                    // 捕获当前轮 reasoningContent：下方 var reasoningContent 仅在 toolCalls 分支赋值，
                    // 此处 break 后 L1360/L1364 会用到过期的上一轮值或 undefined，导致思考内容丢失/错乱。
                    reasoningContent = result.reasoningContent || state.streamingReasoning || '';
                    finalToolCalls = null;
                    break;
                }

                accumulatedContent = result.content || accumulatedContent;
                finalToolCalls = result.toolCalls;

                // 确保 reasoning 气泡已定形：LLM 可能只返回 reasoning + toolCalls 而无 content token，
                // 此时 onToken->appendToken->finalizeReasoningStream 未触发，reasoning-streaming 气泡残留。
                // syncView 前 finalize，避免 renderMessages 不清理 streaming 元素导致空气泡残留。
                if (!_streamedThisRound && view && typeof view.finalizeReasoningStream === 'function') {
                    var _aFinalizeListEl = _laneListEl();
                    if (_aFinalizeListEl) view.finalizeReasoningStream(_aFinalizeListEl);
                }

                var assistantContent = result.content || '';
                var reasoningContent = result.reasoningContent || '';

                // 推入 messages（下一轮 LLM 调用需要）
                var assistantMsg = { role: 'assistant', content: assistantContent };
                if (result.toolCalls) assistantMsg.tool_calls = result.toolCalls;
                if (reasoningContent) assistantMsg.reasoning_content = reasoningContent;
                messages.push(assistantMsg);

                // 同步 contextManager + state.messages
                chatViewHelpers.getActiveCm().addToolCallAssistant(assistantContent, result.toolCalls, reasoningContent);
                tokenStats.saveActiveSessionDebounced();
                // state.messages 与 contextManager 保持 1:1 镜像（消息编辑/截断按下标对齐两套数据的前提）：
                // 即使 assistantContent 为空也推入（渲染层会跳过空气泡），下标不错位。
                state.messages.push({ role: 'assistant', text: assistantContent, reasoningContent: reasoningContent || '', createdAt: Date.now() });
                _assistantPushedThisRound = true;

                // 工具组锚位（打断错序修复，见 _pushToolMsgAnchored）：刚落的这条
                // assistant(tool_calls) 即当前轮工具的锚点——两条引用均取自刚落库的尾条对象
                //（此刻同步执行、无 await，锚点必然就是它；后续落库用引用比对定位）。
                var _grpCmList = chatViewHelpers.getActiveCm().list();
                var _grpAnchorCm = _grpCmList[_grpCmList.length - 1];
                var _grpAnchorUi = state.messages[state.messages.length - 1];
                var _grpLastCm = null, _grpLastUi = null;

                // ── 执行当前轮所有 tool call ──
                var toolResults = [];
                // 当前轮工具耗时累计（用于回填 roundRec，统计「工具步数/工具运行时间」）
                var _roundToolMs = 0;
                var _roundToolCount = 0;
                // 媒体工具单轮上限守卫（read_image/read_video 各 ≤5 次/轮）
                var _mediaGuard = createMediaCallGuard();
                for (var ti = 0; ti < result.toolCalls.length; ti++) {
                    var tc = result.toolCalls[ti];
                    state.toolCallInProgress = tc.function.name;
                    state.busyText = AEI18n.t('调用工具: {name}...', { name: tc.function.name });
                    view.setBusy(state.busy, state.busyText);
                    if (typeof onStateChange === 'function') onStateChange(state);

                    var _toolT0 = Date.now();
                    var execResult = _mediaGuard(tc.function.name)
                        ? await toolExecutionPipeline.executeToolCall(tc, isShaderMode ? 'shader' : 'agent')
                        : mediaCallLimitResult(tc.function.name);
                    _roundToolMs += Date.now() - _toolT0;
                    _roundToolCount++;
                    var _tcArgs = argParsing.safeParseArgs(tc.function.arguments);
                    var tr = {
                        toolCallId: tc.id,
                        toolName: tc.function.name,
                        args: _tcArgs,
                        content: execResult.result || execResult.error || '',
                        success: execResult.success !== false,
                        reviewRejected: execResult.reviewRejected === true
                    };
                    toolResults.push(tr);

                    // 推入 messages + contextManager + state
                    var toolContent = execResult.result || execResult.error || '';
                    // getPreviewFrame：filePath/fileName **原样进 tool content**（口径：
                    // 「移除顶层 filePath 剔除」；旧行为是删掉这两个字段再发）。
                    // 撤回理由：Agent 要能按路径复读**同一张**帧（read_image）——剔除后模型只能重新
                    // 抓帧，而重抓是另一个文件（实测 2–4s/帧），复读、改前改后比对都做不了。且路径
                    // 随 tool content 落 cm，跨轮/重开会话仍在（vision hook 注入的 image_url 只活在
                    // 当轮请求局部 messages 里，不留存；见 context.js 的媒体下界口径）。
                    // 两笔已知代价与兜底（改动这两个字段前先读这段）：
                    //   ① 旧帧被保留池裁掉（最新 30 张，见 _retainPreviewFramePool）后路径成死链
                    //      ——read_image 有 NOT_FOUND 预检（platformTools.js），会如实回「图片文件
                    //      不存在」并引导重抓，不会闷头重试；
                    //   ② 反复 read_image 的 token 风险由单轮媒体调用上限兜住（read_image ≤5 次/轮，
                    //      见 createMediaCallGuard）——本处不再是那道闸。
                    // 多帧联系表的 frames[].filePath 从未被剔除（只删顶层两个字段会漏），这里把
                    // 顶层与之一致：两种形态都能按路径复读。

                    // getShaderPreview：从发给 LLM 的 tool content 中剔除 imageDataUrl（base64 太长浪费 token，
                    // 图片已由 vision hook 单独注入）。保留元信息让 LLM 知道截图已注入。
                    if (tr.toolName === 'getShaderPreview' && typeof toolContent === 'string') {
                        try {
                            var _gsParsed = JSON.parse(toolContent);
                            if (_gsParsed && _gsParsed.imageDataUrl) {
                                delete _gsParsed.imageDataUrl;
                                toolContent = JSON.stringify(_gsParsed);
                            }
                        } catch (_) {}
                    }
                    var toolDetail = typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent || '');

                    // 提交工具卡片不再附带缩略图：ComfyUI 生成结果改由后台完成时以 system-result 卡片形式注入
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
                    // 锚位落库：正常态等价于追加；「立刻发送」打断消息已落库到尾部时插回当前轮产出之后
                    _grpLastCm = _pushToolResultToCm(chatViewHelpers.getActiveCm(), _grpAnchorCm, _grpLastCm,
                        tr.toolCallId, tr.toolName, toolContent, toolDetail, { success: tr.success, reviewRejected: tr.reviewRejected, args: tr.args });

                    var _action = (tr.toolName === 'executeExtendScript' && tr.args && tr.args.action) ? tr.args.action : '';
                    var _uiToolMsg = {
                        role: 'tool',
                        toolName: tr.toolName,
                        detail: toolDetail,
                        success: tr.success,
                        reviewRejected: tr.reviewRejected,
                        action: _action,
                        args: tr.args
                    };
                    if (_pushToolMsgAnchored(state.messages, _grpAnchorUi, _grpLastUi, _uiToolMsg)) _forceFullRerenderNow();
                    _grpLastUi = _uiToolMsg;

                    if (stopRequested) {
                        // 补上剩余未执行 tool 的占位结果，防 API 400 报 insufficient tool messages
                        // 占位同样走锚位落库：打断消息此刻已在尾部，追加会让「已停止」卡片显示在它下方
                        for (var rj = ti + 1; rj < result.toolCalls.length; rj++) {
                            var rc = result.toolCalls[rj];
                            messages.push({ role: 'tool', tool_call_id: rc.id, content: '[stopped]' });
                            var _rcArgs = argParsing.safeParseArgs(rc.function.arguments);
                            _grpLastCm = _pushToolResultToCm(chatViewHelpers.getActiveCm(), _grpAnchorCm, _grpLastCm,
                                rc.id, rc.function.name, '[stopped]', '已停止', { success: false, args: _rcArgs });
                            var _uiStoppedMsg = { role: 'tool', toolName: rc.function.name, detail: '已停止', success: false, args: _rcArgs };
                            if (_pushToolMsgAnchored(state.messages, _grpAnchorUi, _grpLastUi, _uiStoppedMsg)) _forceFullRerenderNow();
                            _grpLastUi = _uiStoppedMsg;
                        }
                        // 占位 tool 消息已写入 cm/state——break 跳过下方的防抖保存，
                        // 2 秒防抖窗口内关面板时 flush 落盘的是缺占位消息的旧快照，重启后
                        // toLlmMessages 发出 tool_calls 无跟随 tool 响应的序列 → API 400 死局。
                        // break 前显式保存（防抖重置计时，占位消息进入待落盘快照）
                        tokenStats.saveActiveSessionDebounced();
                        break;
                    }
                    tokenStats.saveActiveSessionDebounced();
                }
                // 回填当前轮工具耗时到该轮 token 记录（工具在 LLM 调用之后执行，需单独回填）
                if (_roundToolCount > 0 && roundRec) {
                    var _loopStats = _statsStore();
                    if (_loopStats && typeof _loopStats.attachToolMetrics === 'function') {
                        _loopStats.attachToolMetrics(roundRec, _roundToolCount, _roundToolMs);
                        if (typeof view.updateTokenStats === 'function') {
                            view.updateTokenStats(_loopStats.getTotal());
                        }
                    }
                }
                if (stopRequested) break;

                // trackSteps 的返回值已含 { status: 'created', steps }，system prompt 已有
                // 「每项完成 -> updatePlan mark_done」规则，无需额外注入 system 消息。
                // （历史会话中已有的 plan_confirmed 消息由 orphan 过滤保留，不影响兼容。）

                chatViewHelpers.syncView();
                // 工具结果已通过 state.messages → renderMessages 渲染，无需额外追加 DOM。

                // ── Vision hook: 截图/读图工具触发图片注入 ──
                var _d = (global.AEAgentApp && global.AEAgentApp.debugLog) || function () {};
                var filePaths = [];
                var filePathSources = []; // 与 filePaths 一一对应：'getPreviewFrame' 或 'read_image'，用于区分注入文案
                var filePurpose = []; // 与 filePaths 一一对应：工具调用时主 LLM 传入的 purpose 需求提示词
                var directImageDataUrls = []; // getShaderPreview：canvas 截图直出 data URL，不经文件 I/O
                var directImagePurposes = []; // 与 directImageDataUrls 一一对应：本次分析该截图的需求提示词
                for (var pi = 0; pi < toolResults.length; pi++) {
                    var pr = toolResults[pi];
                    if ((pr.toolName === 'getPreviewFrame' || pr.toolName === 'read_image') && pr.success !== false) {
                        try {
                            var parsedPath = JSON.parse(pr.content || '{}');
                            _d('Vision-HOOK', 'filePath=' + (parsedPath && parsedPath.filePath) +
                                ' fileSize=' + (parsedPath && parsedPath.fileSize) +
                                ' iendVerified=' + (parsedPath && parsedPath.iendVerified));
                            if (parsedPath && parsedPath.filePath) {
                                filePaths.push(parsedPath.filePath);
                                filePathSources.push(pr.toolName);
                                filePurpose.push(intentValidation.resolvePurpose(pr.args));
                            }
                        } catch (_) {}
                    } else if (pr.toolName === 'analyzeImage' && pr.success !== false) {
                        // analyzeImage：只有抓帧模式（无 filePath）要求把图送回上下文（attachImage:true）；
                        // 文件模式只回指标，不注入图片（不占视觉 token）。
                        try {
                            var parsedAnalyze = JSON.parse(pr.content || '{}');
                            if (parsedAnalyze && parsedAnalyze.attachImage === true && parsedAnalyze.filePath) {
                                filePaths.push(parsedAnalyze.filePath);
                                filePathSources.push('analyzeImage');
                                filePurpose.push(intentValidation.resolvePurpose(pr.args));
                            }
                        } catch (_) {}
                    } else if (pr.toolName === 'getShaderPreview' && pr.success !== false) {
                        // shader 预览 canvas 截图：直接拿 imageDataUrl 注入，无需读文件
                        try {
                            var parsedShader = JSON.parse(pr.content || '{}');
                            if (parsedShader && parsedShader.imageDataUrl) {
                                directImageDataUrls.push(parsedShader.imageDataUrl);
                                directImagePurposes.push(intentValidation.resolvePurpose(pr.args));
                            }
                        } catch (_) {}
                    }
                }

                if (filePaths.length > 0) {
                    var imageParts = [];
                    var imageSources = []; // 与 imageParts 一一对应，记录来源工具名用于生成上下文文案
                    var imagePurpose = []; // 与 imageParts 一一对应：本次分析该图片的需求提示词
                    // 停止信号传播到本地媒体轮询链——旧 loop 每图烧满
                    // 30×200ms 轮询（≈6s/图），_stopping 窗口内新消息入队滞留数十秒。
                    function _visionAbortRequested() {
                        if (stopRequested) return true;
                        if (activeAbortController && activeAbortController.signal && activeAbortController.signal.aborted) return true;
                        return false;
                    }
                    var _firstTmpPreviewPath = null;   // 当前轮第一个临时预览帧：读完按池裁剪（不即删）
                    for (var fi = 0; fi < filePaths.length; fi++) {
                        // 停止后不再读取后续图片
                        if (_visionAbortRequested()) break;
                        var fp = filePaths[fi];
                        _d('Vision-HOOK', 'readImageStable, filePath=' + fp);
                        // 判定是否为临时预览帧：读完**不删**（Agent 可能复读同一张图），
                        // 改为当前轮结束后把预览帧池裁到最新 30 张（见 _retainPreviewFramePool）
                        var _fn = fp.replace(/^.*[\\\/]/, '');
                        var _isTmpPreview = /^ae_preview_\d+\.png$/i.test(_fn);
                        if (_isTmpPreview && !_firstTmpPreviewPath) _firstTmpPreviewPath = fp;
                        try {
                            var serverResult = await mediaReaders.readImageStable(fp, { shouldAbort: _visionAbortRequested });
                            if (serverResult && serverResult.success && serverResult.base64) {
                                _d('Vision-HOOK', '稳定读取完成, size=' + serverResult.size + ' mime=' + serverResult.mime);
                                var pngUrl = 'data:' + (serverResult.mime || 'image/png') + ';base64,' + serverResult.base64;
                                var finalUrl = await mediaReaders.convertPngToJpegViaCanvas(pngUrl);
                                _d('Vision-HOOK', 'Canvas→JPEG, 转换后长度: ' + finalUrl.length);
                                imageParts.push({ type: 'image_url', image_url: { url: finalUrl } });
                                imageSources.push(filePathSources[fi]);
                                imagePurpose.push(filePurpose[fi]);
                            } else {
                                _d('Vision-HOOK', '读取失败或超时');
                            }
                        } catch (e) {
                            _d('Vision-HOOK', '处理异常: ' + (e && e.message));
                        }
                    }
                    // 预览帧池裁剪：超出 30 张才删最旧的（读完即删会让 Agent 复读不到同一张图）
                    if (_firstTmpPreviewPath) _retainPreviewFramePool(_firstTmpPreviewPath);

                    if (imageParts.length > 0) {
                        var _canSee = global.AE_LLM && global.AE_LLM.supportsVision && (global.AE_LLM.supportsVision(_visionModelName, visionPlatform) || global.AE_LLM.supportsVision(model, visionPlatform));
                        _d('Vision-HOOK', '注入检查: _visionModelName=' + _visionModelName + ' model=' + model + ' platform=' + visionPlatform + ' supports=' + !!_canSee + ' images=' + imageParts.length + ' hasProxy=' + _hasVisionProxy);
                        // 根据来源工具生成上下文文案：getPreviewFrame/analyzeImage=AE 合成截图，
                        // read_image=用户读取的图片（analyzeImage 只在抓帧模式进这里，文案同截图）
                        var _imgHasCompShot = imageSources.indexOf('getPreviewFrame') >= 0
                            || imageSources.indexOf('analyzeImage') >= 0;
                        var _imgHintText = _imgHasCompShot && imageSources.indexOf('read_image') >= 0
                            ? '以上图片包含 AE 合成截图和用户读取的图片。请根据画面信息完成用户需求，如果已完成请直接回复确认结果。'
                            : (_imgHasCompShot
                                ? '以上是AE合成截图。请根据画面信息完成用户需求，如果已完成请直接回复确认结果。'
                                : '以上是用户读取的图片。请根据图片信息完成用户需求。');
                        if (_hasVisionProxy) {
                            // 视觉代理优先：配置了视觉代理时，无论主模型是否支持视觉，都用视觉模型生成中文描述
                            var _proxyItems = [];
                            for (var di = 0; di < imageParts.length; di++) {
                                if (imageParts[di] && imageParts[di].type === 'image_url' && imageParts[di].image_url) {
                                    var _imgHint = (imageSources[di] === 'getPreviewFrame' || imageSources[di] === 'analyzeImage') ? 'AE 合成截图' : '用户读取的图片';
                                    _proxyItems.push({ url: imageParts[di].image_url.url, hint: _imgHint, purpose: imagePurpose[di] });
                                }
                            }
                            var _proxyResults = await visionProxy.describeImagesViaVisionProxy(_proxyItems);
                            // 逐项对齐原始下标（同视频路径的处理）——过滤 null 压缩
                            // 重编号使部分失败时【图片 N】序号错位、失败图凭空消失。
                            var _proxyOkCount = 0;
                            for (var pri = 0; pri < _proxyResults.length; pri++) {
                                if (_proxyResults[pri]) _proxyOkCount++;
                            }
                            if (_proxyOkCount > 0) {
                                var _descText = _proxyResults.length === 1
                                    ? _proxyResults[0]
                                    : _proxyResults.map(function (d, i) { return '【图片 ' + (i + 1) + '】\n' + (d || '[第 ' + (i + 1) + ' 张图片描述失败，视觉代理无法分析其内容]'); }).join('\n\n');
                                var _descMsg = '以下是图片的视觉描述（由视觉代理模型生成）：\n\n' + _descText;
                                messages.push({ role: 'user', content: _descMsg });
                                persistVisionDesc(_descMsg);
                                _d('Vision-Proxy', '描述已注入 messages, 数量=' + _proxyOkCount);
                            } else if (_canSee) {
                                // 代理全部失败 + 主模型支持视觉：回退直接注入 image_url
                                imageParts.push({ type: 'text', text: _imgHintText });
                                messages.push({ role: 'user', content: imageParts });
                                _d('Vision-Proxy', '所有图片描述生成失败，回退主模型直接注入 image_url');
                                if (global.AEToast) global.AEToast.show(AEI18n.t('视觉代理分析图片失败，已回退主模型直接识别'), 'warn');
                            } else {
                                // 代理全部失败且主模型也不支持视觉：必须给 LLM 反馈，否则 LLM 调了 read_image/getPreviewFrame 却得不到任何信息会困惑或重复调用
                                messages.push({ role: 'user', content: visionProxy.buildVisionProxyFailMessage('图片已读取', '图片描述') });
                                _d('Vision-Proxy', '所有图片描述生成失败，已注入失败提示');
                            }
                        } else if (_canSee) {
                            // 未配置视觉代理 + 主模型支持视觉：直接注入 image_url
                            imageParts.push({ type: 'text', text: _imgHintText });
                            messages.push({ role: 'user', content: imageParts });
                        }
                    }
                }

                // ── Video hook: read_video 成功执行后上传并注入 video_url ──
                await visionProxy.injectVideoViaReadVideo(toolResults, messages, model, platform);

                // shader 预览截图直接注入（已为 JPEG，无需再转换）
                if (directImageDataUrls.length > 0) {
                    var _canSeeShader = global.AE_LLM && global.AE_LLM.supportsVision && (global.AE_LLM.supportsVision(_visionModelName, visionPlatform) || global.AE_LLM.supportsVision(model, visionPlatform));
                    _d('Vision-HOOK', 'Shader 预览注入: supports=' + !!_canSeeShader + ' images=' + directImageDataUrls.length + ' hasProxy=' + _hasVisionProxy);
                    if (_hasVisionProxy) {
                        // 视觉代理优先：配置了视觉代理时，无论主模型是否支持视觉，都用视觉模型生成中文描述
                        var _shaderProxyItems = [];
                        for (var spi = 0; spi < directImageDataUrls.length; spi++) {
                            _shaderProxyItems.push({ url: directImageDataUrls[spi], hint: 'Shader 面板实时预览截图', purpose: directImagePurposes[spi] });
                        }
                        var _shaderProxyResults = await visionProxy.describeImagesViaVisionProxy(_shaderProxyItems);
                        // 逐项对齐原始下标（同视频路径的处理）——过滤 null 压缩
                        // 重编号使部分失败时【截图 N】序号错位、失败截图凭空消失。
                        var _shaderProxyOkCount = 0;
                        for (var spri = 0; spri < _shaderProxyResults.length; spri++) {
                            if (_shaderProxyResults[spri]) _shaderProxyOkCount++;
                        }
                        if (_shaderProxyOkCount > 0) {
                            var _spDescText = _shaderProxyResults.length === 1
                                ? _shaderProxyResults[0]
                                : _shaderProxyResults.map(function (d, i) { return '【截图 ' + (i + 1) + '】\n' + (d || '[第 ' + (i + 1) + ' 张截图描述失败，视觉代理无法分析其内容]'); }).join('\n\n');
                            var _spDescMsg = '以下是 getShaderPreview 截图的视觉描述（由视觉代理模型生成）：\n\n' + _spDescText;
                            messages.push({ role: 'user', content: _spDescMsg });
                            persistVisionDesc(_spDescMsg);
                            _d('Vision-Proxy', 'Shader 描述已注入 messages, 数量=' + _shaderProxyOkCount);
                        } else if (_canSeeShader) {
                            // 代理全部失败 + 主模型支持视觉：回退直接注入 image_url
                            var shaderParts = [];
                            for (var si = 0; si < directImageDataUrls.length; si++) {
                                shaderParts.push({ type: 'image_url', image_url: { url: directImageDataUrls[si] } });
                            }
                            shaderParts.push({ type: 'text', text: '以上是 Shader 面板实时预览截图。请根据画面信息分析渲染效果，如需调整请修改代码或参数。' });
                            messages.push({ role: 'user', content: shaderParts });
                            _d('Vision-Proxy', 'Shader 所有图片描述生成失败，回退主模型直接注入 image_url');
                            if (global.AEToast) global.AEToast.show(AEI18n.t('视觉代理分析截图失败，已回退主模型直接识别'), 'warn');
                        } else {
                            messages.push({ role: 'user', content: visionProxy.buildVisionProxyFailMessage('getShaderPreview 已执行', '截图') });
                            _d('Vision-Proxy', 'Shader 所有图片描述生成失败，已注入失败提示');
                        }
                    } else if (_canSeeShader) {
                        // 未配置视觉代理 + 主模型支持视觉：直接注入 image_url
                        var shaderParts = [];
                        for (var si = 0; si < directImageDataUrls.length; si++) {
                            shaderParts.push({ type: 'image_url', image_url: { url: directImageDataUrls[si] } });
                        }
                        shaderParts.push({ type: 'text', text: '以上是 Shader 面板实时预览截图。请根据画面信息分析渲染效果，如需调整请修改代码或参数。' });
                        messages.push({ role: 'user', content: shaderParts });
                    }
                }

                // ── sticky message 推进下一轮 ──
                messages.push({ role: 'user', content: stickyMessage });
            }

            // ── 循环结束：写入最终回复 ──
            // 仅当当前轮尚未写过 assistant（自然结束/中断，未走工具调用 840 分支）才写，
            // 否则工具轮已在 840 写过，这里再写就是重复消息。
            // 「只思考不回复」：LLM 正常结束但未输出 content（700k 超长上下文下常见），
            // reasoning 气泡此刻仍是「思考中...」展开态。不折叠它，仅定形为展开的「思考过程」，
            // 并作为思考-only 的 assistant 消息持久化，避免 UI 卡在思考中且重启后思考丢失。
            var _finalReasoning = reasoningContent || state.streamingReasoning || '';
            if (_finalReasoning && !accumulatedContent && !_assistantPushedThisRound) {
                if (view && typeof view.finalizeReasoningStream === 'function') {
                    var _roListEl = _laneListEl();
                    if (_roListEl) view.finalizeReasoningStream(_roListEl, false);
                }
            }
            if ((accumulatedContent || _finalReasoning) && !_assistantPushedThisRound) {
                state.messages.push({ role: 'assistant', text: accumulatedContent || '', reasoningContent: _finalReasoning, createdAt: Date.now(), _llm: true });
                if (!finalToolCalls || finalToolCalls.length === 0) {
                    // 传 reasoningContent 给 contextManager 持久化，
                    // 否则重启后从 cm.list() 恢复时 m.reasoningContent 为空，思考折叠条不渲染。
                    chatViewHelpers.getActiveCm().add('assistant', accumulatedContent || '', null, { reasoningContent: _finalReasoning, _llm: true });
                }
                // 循环出口写入最终回复后必须触发防抖保存：cm.list() 返回浅拷贝快照，
                // 不调此方法则 store 的 _pendingSave 仍是循环内最后一次 save 时的旧快照，
                // beforeunload flush 落盘的是不含本条回复的陈旧数据，重载后遮蔽会话文件。
                tokenStats.saveActiveSessionDebounced();
            }
            chatViewHelpers.syncView();

            if (loopCount >= maxLoops) {
                // goal 续轮：撞轮次上限不算自然结束（否则会对同一个复杂目标无限重开）
                _roundEndKind = 'limit';
                state.busy = false;
                state.busyText = '';
                chatViewHelpers.syncView();
                // 用户主动停止恰逢末轮（break 于工具窗口且 loopCount 已到顶）时
                // 走静默停止语义（对齐 abort 分支）——不播 warn 音、不注入「任务复杂」
                // 归因误导消息；停止后队列/forced 的 drain 语义不受影响
                if (!stopRequested) {
                    messageHelpers.addMessage('assistant', AEI18n.t('已执行 {n} 轮工具调用，任务可能较复杂，请进一步说明需求。', { n: maxLoops }));
                    // 达到轮次上限 → 需用户进一步说明，播放提示音效（统一分档：limit）。
                    // 只播音、不做完整收尾：_stopping 的清零必须留到下方递归判定之后（见下）。
                    _beepRoundEnd('limit');
                }
                // maxLoops 直接 return 绕过下方出口 1343 的「立刻发送」
                // 消费点——末轮工具窗口内点「立刻发送」的条目已 addMessage 持久化
                // 但从未送达 LLM（外层 finally 的 _injectQueue 兜底恒空：sendInjectItem
                // 已把其余条目暂存 _deferQueue，末尾又直接清空 _forcedInjectText）。
                // 对齐 Script 模式 maxLoops 出口经 _drainScriptQueueAndRecurse 消费
                // forced 的语义 + 消费写法：递归起新一轮单独处理该条（新轮
                // loopCount 重置，再撞 maxLoops 时 forced 已空，自然 return，无死循环）
                // 递归期间保持 _stopping 守卫（清零延后到非递归路径）——
                // 递归 prologue 的 await 链到 busy=true 之间存在无守卫窗口，提前清
                // _stopping 会让 submitUserInput 直发/sendInjectItem 空闲直发/
                // switchSession 并发放行（对齐出口 1358 的既有正确形态）
                if (_forcedInjectText) {
                    stopRequested = false;
                    stopPromiseResolve = null;
                    activeAbortController = new AbortController();
                    var _forcedMaxNext = _forcedInjectText;
                    _forcedInjectText = null;
                    return processToolLoop(_forcedMaxNext);
                }
                _stopping = false;
                return;
            }

            // stop 后若有排队消息，递归起新一轮——contextManager 已含完整历史，
            // 重建 messages 不会丢，队列在新一轮开头 drain，Agent 马上看到。
            // 注：_forcedInjectText 非空表示"立刻发送"——该条已 addMessage 持久化，
            // 此处只据此起新一轮单独处理它，_deferQueue（其余待发送）不在此轮 drain。
            if (_injectQueue.length > 0 || _forcedInjectText) {
                stopRequested = false;
                stopPromiseResolve = null;
                activeAbortController = new AbortController();
                var _nextUserText = _forcedInjectText || userText;
                _forcedInjectText = null;
                return processToolLoop(_nextUserText);
            }

            // LLM 工具循环结束、最终答复已写入 → 进入 idle：统一收尾（状态复位 + 完成提醒音效）。
            // 停止走到这里（abort / 工具窗口内 break）同样收尾——提示音语义是「已回到空闲」，
            // 与既有 Agent 行为一致，不区分成功/停止。
            _finalizeRound(stopRequested ? 'stop' : 'clean');
        }

        // Script 模式停止/结束后：若有执行中追加的队列消息，取最后一条作为新 userText 递归起新一轮。
        // 对齐 Agent 模式 processToolLoop 出口 L1478 的处理，避免队列消息被遗弃。
        // - 所有队列消息通过 addMessage 持久化作历史（<context> 前缀固定，缓存前缀稳定）
        // - 最后一条作为新 userText（Script 语义：新需求覆盖原始需求）
        // - defaultReturn：队列空时返回的默认值（null 或 {content, reasoningContent}）
        async function _drainScriptQueueAndRecurse(defaultReturn) {
            // "立刻发送"：_injectQueue 为空但 _forcedInjectText 非空，表示只发该条、其余已暂存 _deferQueue。
            // 直接以该文本续跑新一轮，其余条目待整条链结束后 finally 恢复。
            if (_injectQueue.length === 0) {
                if (_forcedInjectText) {
                    state.busy = true;
                    state.busyText = AEI18n.t('处理追加消息...');
                    var _forcedScriptText = _forcedInjectText;
                    _forcedInjectText = null;
                    stopRequested = false;
                    stopPromiseResolve = null;
                    activeAbortController = new AbortController();
                    return processScriptToolLoop(_forcedScriptText, null);
                }
                return defaultReturn;
            }
            var queued = _injectQueue.slice();
            _injectQueue.length = 0;
            console.log('[Agent] Script stop 后 drain 注入队列: ' + queued.length + ' 条');
            // requestStop 已把 state.busy 置 false，drain 期间 addMessage 会触发 syncView，
            // 若不先设回 true，UI 会短暂闪烁非执行态（按钮变"发送"、模式切换解锁）。
            // _stopping 仍为 true 保护并发，但视觉体验需保持执行态连续。
            state.busy = true;
            state.busyText = AEI18n.t('处理追加消息...');
            var lastText = '';
            for (var qi = 0; qi < queued.length; qi++) {
                var inj = queued[qi];
                // 跨会话条目路由回原会话（同 processToolLoop 循环内 drain 语义）
                if (_isCrossSessionInject(inj)) {
                    apiActions.appendToSession(inj.sessionId, inj);
                    continue;
                }
                if (inj.systemResult) {
                    chatViewHelpers.pushSystemResult(inj.title, inj.visible, inj.detail, inj.llmRole);
                    continue;
                }
                messageHelpers.addMessage('user', inj.text, inj.detail, inj.images, {
                    displayText: inj.displayText,
                    videos: inj.videos,
                    fileRefs: inj.fileRefs,
                    fileCtx: inj.fileCtx
                });
                // 视觉通道回填——下方续跑轮 processScriptToolLoop 在入口
                // 消费 _pendingImages 把该条的图片带给 LLM（无用户文本不续跑时，
                // 由调用方 _runUserRequest 的 finally 清空，不会错挂到下一条消息）。
                // 多条带图条目合并累积而非单槽覆盖——覆盖会
                // 丢前条的视觉通道（图片落盘但不进 LLM）；合并后由续跑轮入口统一注入。
                if (inj.imageDataUrls && inj.imageDataUrls.length > 0) {
                    _pendingImages = (_pendingImages || []).concat(inj.imageDataUrls);
                }
                lastText = inj.text;
            }
            // 队列里只有 system-result、无用户文本：无需续跑新一轮，交给调用方 finally 复位
            if (!lastText) return defaultReturn;
            stopRequested = false;
            stopPromiseResolve = null;
            activeAbortController = new AbortController();
            return processScriptToolLoop(lastText, null);
        }

        // Script 模式工具循环：LLM 可调 memory_* / skill_* 查经验，结束后返回 action JSON
        // correctionOptions: 修正模式时传入 { failedScript, errors, warnings }，构造专用修正 prompt
        // 不注入 contextManager，避免连续 user 消息 + 上下文累积污染
        async function processScriptToolLoop(userText, correctionOptions) {
            // 入口即清（与 processToolLoop 一致）：防前置 await 窗口停止时出口/错误分支
            // 的 fallback（acc.snapshot().accumulatedReasoning || state.streamingReasoning）
            // 拿到上一次调用的思考残留。
            state.streamingReasoning = '';
            var settings = getSettings();
            var model = opts.getModel ? opts.getModel() : '';
            var platform = opts.getPlatform ? opts.getPlatform() : '';

            // 视觉能力判断（需在构建 systemPrompt 之前完成，以便注入视觉信息）
            var _d = (global.AEAgentApp && global.AEAgentApp.debugLog) || function () {};
            var _scriptVisionModel = '';
            var _scriptVisionPlatform = platform;
            try {
                if (global.AE_LLM && global.AE_LLM.resolveLlmConfig) {
                    var _svCfg = await global.AE_LLM.resolveLlmConfig({ model: model, platform: platform });
                    _scriptVisionModel = (typeof _svCfg === 'string') ? _svCfg : (_svCfg && _svCfg.model) || model || '';
                    _scriptVisionPlatform = (_svCfg && _svCfg.platform) || platform;
                    if (typeof _scriptVisionModel !== 'string') _scriptVisionModel = '';
                }
            } catch (_) { _scriptVisionModel = typeof model === 'string' ? model : ''; }
            if (!_scriptVisionModel && typeof model === 'string') _scriptVisionModel = model;
            if (typeof _scriptVisionModel !== 'string') _scriptVisionModel = '';
            _visionModelName = _scriptVisionModel;
            _visionPlatform = _scriptVisionPlatform;
            var _scriptCanSee = !!(_scriptVisionModel && global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(_scriptVisionModel, _scriptVisionPlatform));
            // 主模型是否支持视频能力（read_video 只对视频模型开放）
            var _scriptCanSeeVideo = !!(model && global.AE_LLM && global.AE_LLM.supportsVideo && global.AE_LLM.supportsVideo(model, platform));
            // 视觉代理模型配置：非视觉主模型遇到图片时，后台用此模型转描述（与 agent 模式一致）
            try {
                var _svpGlobals = opts.getGlobalSettings ? await opts.getGlobalSettings() : {};
                _visionProxyProviderId = _svpGlobals.visionProviderId || '';
                _visionProxyModelId = _svpGlobals.visionModelId || '';
            } catch (_) { _visionProxyProviderId = ''; _visionProxyModelId = ''; }
            _hasVisionProxy = !!(_visionProxyProviderId && _visionProxyModelId);
            // 视觉代理模型是否支持视频（Script 模式，与 Agent 模式同口径）
            var _visionProxyCanVideo = false;
            if (_hasVisionProxy && global.AE_LLM) {
                try {
                    var _vpCfg = global.AE_LLM.resolveLlmConfig
                        ? await global.AE_LLM.resolveLlmConfig({ model: _visionProxyModelId, platform: _visionProxyProviderId })
                        : { model: _visionProxyModelId, platform: _visionProxyProviderId };
                    var _vpCfgModel = (_vpCfg && _vpCfg.model) || _visionProxyModelId;
                    var _vpCfgPlatform = (_vpCfg && _vpCfg.platform) || _visionProxyProviderId;
                    _visionProxyCanVideo = !!(global.AE_LLM.supportsVideo
                        && global.AE_LLM.supportsVideo(_vpCfgModel, _vpCfgPlatform));
                } catch (_) { _visionProxyCanVideo = false; }
            }

            // 骨架按本视图有效可见性裁剪 stub 铁律（谓词由闸口现算，子 Agent 用冻结实例）。
            var basePrompt = (global.AEEngine && global.AEEngine.prompts && global.AEEngine.prompts.buildSystemPrompt)
                ? global.AEEngine.prompts.buildSystemPrompt(settings.userPersona || '', model, _scriptCanSee, _scriptCanSeeVideo, _hasVisionProxy, _visionProxyCanVideo, _promptToolVisible)
                : 'You are a script generator. Return JSON only.';
            var promptBuilder = opts.promptBuilder || (global.AE_LLM && global.AE_LLM.promptBuilder);
            // Script 轮：提示词上下文带 'script'，与 _buildRoundTools('script') 的执行侧身份一致。
            var systemPrompt = promptBuilder
                ? promptBuilder.build(basePrompt, _promptBuildContext('script'))
                : basePrompt;

            var apiKey = await resolveApiKeyForPlatform(platform);
            var maxLoops = MAX_TOOL_LOOPS;
            // 循环内自动压缩失败的提示闸（按轮只提示一次，与 Agent 循环同款）
            var _loopCompressFailNotified = false;

            // 统一工具集组装：作用域过滤 + 语义门控 + 轮次状态同步（与 Agent 模式同一 helper）。
            // Script 模式传 'script' 作为 moduleId：scope:module:agent 的工具（AE 操控类）
            // 会被 getEnabledForModule 自动过滤；只读 AE 工具（全局作用域）自然放行。
            var tools = _buildRoundTools('script', {
                blacklist: null,
                canVision: _scriptCanSee,
                canVideo: _scriptCanSeeVideo,
                hasVisionProxy: _hasVisionProxy
            });

            // 口径统一（与 Agent 模式一致）：system prompt + tools 计入上下文预算；
            // 同上：先按模型窗口设生效分母，再写开销并落盘（窗口读取与落盘各自只有一份实现）
            _applyModelWindowLimit(scriptContextManager);
            if (scriptContextManager && typeof scriptContextManager.setOverheadTokens === 'function') {
                scriptContextManager.setOverheadTokens(
                    scriptContextManager.estimateTokens(systemPrompt)
                    + scriptContextManager.estimateTokens(JSON.stringify(tools || []))
                );
                _rememberOverhead(_overheadStoreKey('script'), scriptContextManager.getOverheadTokens());
            }

            // 从历史 messages 重建 searchedTools（与 Agent 模式一致）
            toolHistory.rebuildSearchedToolsFromHistory(scriptContextManager);

            var messages = [{ role: 'system', content: systemPrompt }];
            var contextMsgs = scriptContextManager.toLlmMessages();
            for (var ci = 0; ci < contextMsgs.length; ci++) {
                var cm = contextMsgs[ci];
                var msgEntry = { role: cm.role, content: cm.content };
                if (cm.tool_call_id) msgEntry.tool_call_id = cm.tool_call_id;
                if (cm.name) msgEntry.name = cm.name;
                if (cm.tool_calls) msgEntry.tool_calls = cm.tool_calls;
                // 判 undefined（含空串）——理由见上方 agent 管线同名拷贝点
                if (cm.reasoning_content !== undefined) msgEntry.reasoning_content = cm.reasoning_content;
                messages.push(msgEntry);
            }
            // 不再 push userMsg——submitUserInput/
            // sendInjectItem/drain 已把当前轮 user 消息 addMessage 持久化（含 <context>
            // 前缀），toLlmMessages 从尾部回填恒含最新 user 组，此处再 push 一份
            // 「用户需求: 原文」使每个 Script 请求的用户需求（含全量 AE snapshot）
            // 双份计入 prompt token。对齐 Agent 模式 processToolLoop 不 push 的做法
            //（forced/drain 续跑轮同理：消息在 apiActions L709/L1421 已持久化）。
            // userText/correctionOptions 形参保留（调用点契约不变，correctionOptions
            // 为从未消费的预留参数——注释声称的「修正 prompt」未实现）。

            // Script 模式也注入用户粘贴/拖入的图片（与 agent 模式对齐）
            var scriptPendingImages = _pendingImages;
            _pendingImages = null;
            if (scriptPendingImages && scriptPendingImages.length > 0) {
                var scriptResolvedModel = model;
                var scriptResolvedPlatform = _scriptVisionPlatform;
                try {
                    if (global.AE_LLM && global.AE_LLM.resolveLlmConfig) {
                        var scfg = await global.AE_LLM.resolveLlmConfig({ model: model, platform: platform });
                        scriptResolvedModel = scfg.model || model;
                        scriptResolvedPlatform = scfg.platform || platform;
                    }
                } catch (_) {}
                if (_hasVisionProxy) {
                    // 视觉代理优先：配置了视觉代理时，无论主模型是否支持视觉，都用视觉模型生成中文描述
                    console.log('[Agent-Script] 用户附带了 ' + scriptPendingImages.length + ' 张图片，使用视觉代理模型转描述。');
                    if (typeof opts.showStatus === 'function') {
                        opts.showStatus(AEI18n.t('正在用视觉代理模型分析 {n} 张图片...', { n: scriptPendingImages.length }), 'info', { autoHideMs: 4000 });
                    }
                    var _scriptImgItems = [];
                    for (var sii2 = 0; sii2 < scriptPendingImages.length; sii2++) {
                        if (scriptPendingImages[sii2]) _scriptImgItems.push({ url: scriptPendingImages[sii2], hint: '用户上传的图片', purpose: intentValidation.extractUserRequirement(messages) });
                    }
                    var _scriptImgResults = await visionProxy.describeImagesViaVisionProxy(_scriptImgItems);
                    // 逐项对齐原始下标（同视频路径的处理）——过滤 null 压缩
                    // 重编号使部分失败时【图片 N】序号错位、失败图凭空消失。
                    var _scriptImgOkCount = 0;
                    for (var sir = 0; sir < _scriptImgResults.length; sir++) {
                        if (_scriptImgResults[sir]) _scriptImgOkCount++;
                    }
                    if (_scriptImgOkCount > 0) {
                        var _sDescText = _scriptImgResults.length === 1
                            ? _scriptImgResults[0]
                            : _scriptImgResults.map(function (d, i) { return '【图片 ' + (i + 1) + '】\n' + (d || '[第 ' + (i + 1) + ' 张图片描述失败，视觉代理无法分析其内容]'); }).join('\n\n');
                        for (var sumi = messages.length - 1; sumi >= 0; sumi--) {
                            if (messages[sumi].role === 'user') {
                                messages[sumi].content = (messages[sumi].content || '') + '\n\n[用户附带的图片描述（由视觉代理模型生成）：\n' + _sDescText + '\n]';
                                break;
                            }
                        }
                    } else if (global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(scriptResolvedModel, scriptResolvedPlatform)) {
                        // 代理全部失败 + 主模型支持视觉：回退直接注入 image_url
                        for (var rsmi = messages.length - 1; rsmi >= 0; rsmi--) {
                            if (messages[rsmi].role === 'user') {
                                var rsImgParts = [];
                                for (var rsii = 0; rsii < scriptPendingImages.length; rsii++) {
                                    if (scriptPendingImages[rsii]) {
                                        rsImgParts.push({ type: 'image_url', image_url: { url: scriptPendingImages[rsii] } });
                                    }
                                }
                                rsImgParts.push({ type: 'text', text: messages[rsmi].content || '' });
                                messages[rsmi].content = rsImgParts;
                                break;
                            }
                        }
                        if (global.AEToast) global.AEToast.show(AEI18n.t('视觉代理分析图片失败，已回退主模型直接识别'), 'warn');
                    } else {
                        if (typeof opts.showStatus === 'function') {
                            opts.showStatus(visionProxy.getVisionProxyFailReason() === 'no_api_key'
                                ? AEI18n.t('视觉代理平台未配置 API Key，无法分析图片')
                                : AEI18n.t('视觉代理模型分析图片失败，请检查视觉模型配置'), 'warn', { autoHideMs: 6000 });
                        }
                        for (var sfmi = messages.length - 1; sfmi >= 0; sfmi--) {
                            if (messages[sfmi].role === 'user') {
                                messages[sfmi].content = (messages[sfmi].content || '') + '\n\n' + visionProxy.buildVisionProxyFailMessage('系统提示：用户附带了 ' + scriptPendingImages.length + ' 张图片', '图片描述');
                                break;
                            }
                        }
                    }
                } else if (global.AE_LLM && global.AE_LLM.supportsVision && global.AE_LLM.supportsVision(scriptResolvedModel, scriptResolvedPlatform)) {
                    // 未配置视觉代理 + 主模型支持视觉：直接注入 image_url
                    for (var smi = messages.length - 1; smi >= 0; smi--) {
                        if (messages[smi].role === 'user') {
                            var simgParts = [];
                            for (var sii = 0; sii < scriptPendingImages.length; sii++) {
                                if (scriptPendingImages[sii]) {
                                    simgParts.push({ type: 'image_url', image_url: { url: scriptPendingImages[sii] } });
                                }
                            }
                            simgParts.push({ type: 'text', text: messages[smi].content || '' });
                            messages[smi].content = simgParts;
                            break;
                        }
                    }
                } else {
                    console.log('[Agent] 用户附带了 ' + scriptPendingImages.length + ' 张图片，但当前模型 ' + (scriptResolvedModel || model) + ' 不支持视觉分析，图片未发送。');
                    if (typeof opts.showStatus === 'function') {
                        opts.showStatus(AEI18n.t('当前模型不支持视觉，{n} 张图片未发送 — 请切换至 Claude / Gemini / Kimi 等视觉模型，或在模型管理面板配置视觉代理模型', { n: scriptPendingImages.length }), 'warn', { autoHideMs: 6000 });
                    }
                    for (var smi2 = messages.length - 1; smi2 >= 0; smi2--) {
                        if (messages[smi2].role === 'user') {
                            messages[smi2].content = (messages[smi2].content || '') + '\n\n[系统提示：用户在此消息中附带了 ' + scriptPendingImages.length + ' 张图片，但当前模型不支持视觉功能。请在回复中告知用户：如需分析图片，请切换至支持视觉的模型（如 Claude、Gemini、Kimi K2.5 等），或在模型管理面板顶部配置视觉代理模型。]';
                            break;
                        }
                    }
                }
            }

            var channel = opts.llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel);
            if (!channel || !channel.sendStream) {
                throw new Error('LLM_CHANNEL_UNAVAILABLE');
            }

            state.busy = true;
            state.streamingContent = '';
            state.toolCallInProgress = null;
            chatViewHelpers.syncView();

            // SSE 增量累积外提为 streamAccumulator 纯工具（见 controller/streamAccumulator.js），
            // 每轮维护 accumulatedContent/accumulatedReasoning/finishReason，读侧经 snapshot() 取当前累积值。
            var acc = createStreamAccumulator();
            var loopCount = 0;
            var reasoningFinalizedThisRound = false;

            // ── Script Tool loop ──
            while (loopCount < maxLoops) {
                if (stopRequested) break;
                loopCount++;

                // ── 上下文超阈值自动压缩（loop 内）──
                // 首轮不压缩：上下文刚构建
                // 判闸用未取整值 + cm 的阈值（与 Agent 循环同口径）
                _reportStorageCapEvents(chatViewHelpers.getActiveCm());
                if (loopCount > 1) {
                    var _loopStats = chatViewHelpers.getActiveCm().getTokenStats();
                    // 判闸用未取整值 + cm 的阈值（与 Agent 循环同口径）
                    var _loopPct = (typeof _loopStats.percentUsedRaw === 'number')
                        ? _loopStats.percentUsedRaw : (_loopStats.percentUsed || 0);
                    var _loopTrigger = (typeof _loopStats.compactTriggerPct === 'number')
                        ? _loopStats.compactTriggerPct : 85;
                    // 与 Agent 循环同款——「待压缩」标记也是闸门条件（5% 下限防空转）
                    var _loopFlag = _loopStats.needsCompaction === true;
                    if (_loopPct >= _loopTrigger || (_loopFlag && _loopPct >= 5)) {
                        var _compressResult = await _api.compressContext({ internal: true });
                        // 压缩 await 窗口内可能已点停止（abort 只中止在途请求，对新 sendStream
                        // 无效）：复查后立即跳出，防停止被延迟一整轮 LLM 调用（对齐 Agent 循环）。
                        if (stopRequested) break;
                        if (_compressResult && _compressResult.success) {
                            messages = [{ role: 'system', content: systemPrompt }];
                            var _contextMsgs = chatViewHelpers.getActiveCm().toLlmMessages();
                            for (var _ci = 0; _ci < _contextMsgs.length; _ci++) {
                                var _cm = _contextMsgs[_ci];
                                var _msgEntry = { role: _cm.role, content: _cm.content };
                                if (_cm.tool_call_id) _msgEntry.tool_call_id = _cm.tool_call_id;
                                if (_cm.name) _msgEntry.name = _cm.name;
                                if (_cm.tool_calls) _msgEntry.tool_calls = _cm.tool_calls;
                                // reasoning_content 判 undefined 而非真值：上下文层会主动下发空串
                                // （带 tool_calls 的轮次字段必须存在，DeepSeek thinking 协议要求），
                                // 用真值判断会把空串再次丢掉，等于没修
                                if (_cm.reasoning_content !== undefined) _msgEntry.reasoning_content = _cm.reasoning_content;
                                messages.push(_msgEntry);
                            }
                            if (typeof opts.showStatus === 'function') {
                                // 文案里的百分比取**实际阈值**（与 Agent 循环同款）
                                opts.showStatus(AEI18n.t('✓ 上下文已超 {pct}%，已自动压缩', { pct: _loopTrigger }), 'info', { autoHideMs: 3000 });
                            }
                        } else if (_compressResult && _compressResult.error && !_loopCompressFailNotified) {
                            // 循环内自动压缩失败时提示（与 Agent 循环同款，按轮只提示一次）
                            _loopCompressFailNotified = true;
                            if (typeof opts.showStatus === 'function') {
                                var _cfTextLoop2 = typeof _api.describeCompressFailure === 'function'
                                    ? _api.describeCompressFailure(_compressResult.error)
                                    : '压缩失败，请稍后再试。';
                                opts.showStatus(AEI18n.t('⚠ 自动压缩未完成：{reason}', { reason: _cfTextLoop2 }), 'error', { autoHideMs: 8000 });
                            }
                        }
                    }
                }

                // ── 轮内消费后台异步结果 / 跨会话条目（对齐 Agent 循环每轮请求前的 drain）──
                // Script 没有轮内用户消息注入：用户追加消息仍按既有语义留在队列，由轮末
                // _drainScriptQueueAndRecurse 起新一轮消费。但 systemResult（ComfyUI 生成完成、
                // 渲染后台受理回执等）与跨会话条目不是用户待发送消息——积压到轮末会让系统卡
                // 迟到一整轮。此处只消费这两类，其余条目按原顺序留队。
                if (_injectQueue.length > 0) {
                    var _scriptKeptForNextTurn = [];
                    var _scriptConsumedAny = false;
                    for (var _sqi = 0; _sqi < _injectQueue.length; _sqi++) {
                        var _sInj = _injectQueue[_sqi];
                        // 跨会话条目路由回原会话——不写入当前 cm、不进当前轮 messages
                        //（不触发当前会话 LLM）。appendToSession 内部自捕获异常，此处
                        // fire-and-forget 即可。
                        if (_isCrossSessionInject(_sInj)) {
                            apiActions.appendToSession(_sInj.sessionId, _sInj);
                            _scriptConsumedAny = true;
                            continue;
                        }
                        // 后台异步结果以 system-result 卡片入历史，并作为消息发给当前轮 LLM
                        if (_sInj.systemResult) {
                            var _sSrMsg = chatViewHelpers.pushSystemResult(_sInj.title, _sInj.visible, _sInj.detail, _sInj.llmRole);
                            // 与 toLlmMessages 复用同一份完整格式（含 detailText 与媒体路径标记），
                            // 避免当前轮只喂裸 JSON、下一轮才读到完整格式的分叉。
                            messages.push({ role: _sInj.llmRole === 'assistant' ? 'assistant' : 'user', content: chatViewHelpers.getActiveCm().systemResultContent(_sSrMsg) });
                            _scriptConsumedAny = true;
                            continue;
                        }
                        // 用户追加消息：保持 Script 现有语义（轮内留队、轮末起新一轮消费），
                        // 不改成 Agent 循环的轮内注入。
                        _scriptKeptForNextTurn.push(_sInj);
                    }
                    _injectQueue.length = 0;
                    // 留队条目按原顺序放回（必须放在清空之后：循环里新的追加由下一轮再处理）
                    if (_scriptKeptForNextTurn.length) _injectQueue.push.apply(_injectQueue, _scriptKeptForNextTurn);
                    // 只有真消费了条目才重绘：无消费时状态没变，不无谓全量重渲染
                    if (_scriptConsumedAny) chatViewHelpers.syncView();
                }

                state.streamingContent = '';
                state.streamingReasoning = '';
                state.toolCallInProgress = null;
                reasoningFinalizedThisRound = false;
                // 每轮重置 accumulated，防止跨轮累积导致内容拼接（前一轮的 content 带到下轮）
                acc.reset();

                // 当前轮起点的写入位置（打断补写用）：与 processToolLoop 同款——「立刻发送」的
                // 用户消息在点击瞬间就落库，被中断那一轮的半成品 assistant 要等 abort 传上来，
                // 追加会成「user(打断者) → assistant(被打断)」错序。压缩已在上方完成。
                // 除数字下标外再记轮初最后一条 cm 消息的**引用**（同 Agent 循环，见
                // _roundStartInsertIndex）：轮内落库触发裁剪删头时数字下标会前移错位。
                // 锚点取 scriptContextManager（与下方补写插入的目标同一实例，防 getActiveCm 分叉）。
                var _roundStartCmIdx = chatViewHelpers.getActiveCm().list().length;
                _roundStartCmAnchor = _roundStartCmIdx > 0 ? scriptContextManager.list()[_roundStartCmIdx - 1] : null;
                var _roundStartUiIdx = state.messages.length;

                // 当前轮 LLM 计时：首token 延迟 = 请求发出 → 首个 token（content/reasoning 谁先到）；
                // LLM 运行时间 = 请求发出 → 流结束。
                // 自动重试时以最后一次请求为基准（与 processToolLoop 同款：退避等待不计入响应时间）。
                var _llmT0 = Date.now();
                var _firstTokenT = 0;
                var _llmRequest = {
                    messages: messages,
                    tools: tools,
                    apiKey: apiKey,
                    model: model,
                    platform: platform,
                    // 与主循环同源：Script 模式同样按当前会话取声明式会话头值
                    sessionId: chatViewHelpers.getActiveCm().getSessionId(),
                    // 同 Agent 主循环——绑定当前轮自己的 signal，停止不再全局 abort
                    options: { timeoutMs: settings.requestTimeoutMs || 120000, signal: activeAbortController ? activeAbortController.signal : null },
                    reasoningEffort: settings.reasoningEffort || 'high'
                };
                // 是否流出过任何内容：自动重试只允许发生在「一个字都没吐出」的失败上
                // （已流出的内容重发会重复展示、重复计费），与主循环同一口径。
                var _anyStreamOutput = false;
                var _retryOutcome = await llmRetry.runWithRetry(function () {
                    _llmT0 = Date.now();
                    _firstTokenT = 0;
                    _anyStreamOutput = false;
                    return channel.sendStream(_llmRequest, {
                        onToken: function(token, full) {
                            _anyStreamOutput = true;
                            if (!_firstTokenT) _firstTokenT = Date.now();
                            // Script 模式 content 是自然语言（中间说话）或空（只调工具），
                            // 需要在首次收到 content 时把在途的思考气泡定形为折叠 details，
                            // 否则它会一直保持流式态，最终被 renderMessages 清理逻辑直接 remove 掉导致思考内容凭空消失。
                            if (!reasoningFinalizedThisRound) {
                                reasoningFinalizedThisRound = true;
                                if (view && typeof view.finalizeReasoningStream === 'function') {
                                    var listEl = _laneListEl();
                                    if (listEl) view.finalizeReasoningStream(listEl);
                                }
                            }
                            state.streamingContent = full;
                            state.toolCallInProgress = null;
                            state.busyText = AEI18n.t('正在生成脚本...');
                            acc.append('content', full);
                            // 工具协议下 Script 模式 content 为自然语言，需流式渲染到占位气泡；
                            // 循环结束/工具轮提交时由 renderMessages 移除占位、渲染落定消息（对齐 Agent 模式）。
                            view.appendToken(token, full);
                        },
                        onReasoning: function(token, full) {
                            _anyStreamOutput = true;
                            if (!_firstTokenT) _firstTokenT = Date.now();
                            state.streamingReasoning = full;
                            acc.append('reasoning', full);
                            state.busyText = AEI18n.t('思考中...');
                            view.appendReasoningToken(token, full);
                        }
                    });
                }, {
                    maxRetries: llmRetry.maxRetries,
                    baseDelayMs: llmRetry.baseDelayMs,
                    maxDelayMs: llmRetry.maxDelayMs,
                    hasOutput: function () { return _anyStreamOutput; },
                    isCancelled: function () { return stopRequested; },
                    onRetry: function (info) {
                        var _secs = Math.max(1, Math.round(info.delayMs / 1000));
                        state.busyText = AEI18n.t('请求失败（{reason}），{secs} 秒后重试...', { reason: info.reason, secs: _secs });
                        if (typeof opts.showStatus === 'function') {
                            opts.showStatus(AEI18n.t('⚠ 请求失败（{reason}），{secs} 秒后自动重试（第 {attempt}/{max} 次请求）', { reason: info.reason, secs: _secs, attempt: info.attempt, max: info.maxAttempts }), 'warn', { autoHideMs: 4000 });
                        }
                        chatViewHelpers.syncView();
                    }
                });
                var result = _retryOutcome.result;
                var _llmT1 = Date.now();
                if (_retryOutcome.retried && result && !result.error && typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('✓ 第 {n} 次请求成功', { n: _retryOutcome.attempts }), 'info', { autoHideMs: 3000 });
                }

                // 记录流式 usage
                // roundRec 供下方工具执行完毕后回填该轮工具耗时
                var roundRec = tokenStats.recordStreamUsage(result, 'script-stream', {
                    firstTokenMs: _firstTokenT ? (_firstTokenT - _llmT0) : null,
                    llmDurationMs: _llmT1 - _llmT0
                });

                if (result && result.error) {
                    // stop 触发的 abort：静默退出，不当失败处理（对齐 processToolLoop）
                    var isAbort = stopRequested || result.error === 'aborted' || result.error === 'ABORTED'
                        || result.aborted === true || result.error === 'stopped'
                        // message 里的 abort 字样只在**没有状态码**的失败上采信：API_ERROR 的 message
                        // 是服务端错误体原文（网关 502/503 常见 "upstream request aborted"），按文案判
                        // 会把接口失败静默当停止——不落错误消息、不提示用户，用户只看到"没反应"。
                        || (result.error !== 'API_ERROR' && (result.message || '').toLowerCase().indexOf('abort') >= 0);
                    if (isAbort) {
                        // 保留停止时已流式生成的部分回复 + 思考内容，折叠保存到上下文，避免凭空消失。
                        // accumulatedContent 每轮重置，非当前轮流式值即为空，可直接复用（对齐 Agent 模式）。
                        var _sAbortContent = acc.snapshot().accumulatedContent || '';
                        var _sAbortReasoning = acc.snapshot().accumulatedReasoning || state.streamingReasoning || '';
                        if (_sAbortContent || _sAbortReasoning) {
                            if (_sAbortReasoning && view && typeof view.finalizeReasoningStream === 'function') {
                                var _sAbortListEl = _laneListEl();
                                if (_sAbortListEl) view.finalizeReasoningStream(_sAbortListEl);
                            }
                            // 重绘判据取插入前 UI 侧长度（不受 cm 裁剪影响），理由见 helper 定义处
                            var _stateLenBeforeInsert = state.messages.length;
                            _spliceAt(state.messages, _roundStartUiIdx,
                                { role: 'assistant', text: _sAbortContent, reasoningContent: _sAbortReasoning, createdAt: Date.now(), _llm: true });
                            scriptContextManager.insertAt(_roundStartInsertIndex(scriptContextManager), 'assistant', _sAbortContent, null, { reasoningContent: _sAbortReasoning, _llm: true });
                            _forceFullRerenderIfMidList(_stateLenBeforeInsert, _roundStartUiIdx);
                            tokenStats.saveActiveSessionDebounced();
                        }
                        return _drainScriptQueueAndRecurse(null);
                    }
                    // 非 abort 错误（网络异常等）：保留当前轮已流式生成的部分回复 + 思考内容，对齐 Agent 模式处理。
                    // 工具协议下 Script 模式 content 为自然语言，部分回复有保留价值；
                    // accumulatedContent 每轮重置，非当前轮流式值即为空。
                    var _sErrContent = acc.snapshot().accumulatedContent || '';
                    var _sErrReasoning = acc.snapshot().accumulatedReasoning || state.streamingReasoning || '';
                    if (_sErrContent || _sErrReasoning) {
                        if (_sErrReasoning && view && typeof view.finalizeReasoningStream === 'function') {
                            var _sErrListEl = _laneListEl();
                            if (_sErrListEl) view.finalizeReasoningStream(_sErrListEl);
                        }
                        // 同 abort 分支，判据取插入前 UI 侧长度
                        var _stateLenBeforeInsert = state.messages.length;
                        _spliceAt(state.messages, _roundStartUiIdx,
                            { role: 'assistant', text: _sErrContent, reasoningContent: _sErrReasoning, createdAt: Date.now(), _llm: true });
                        scriptContextManager.insertAt(_roundStartInsertIndex(scriptContextManager), 'assistant', _sErrContent, null, { reasoningContent: _sErrReasoning, _llm: true });
                        _forceFullRerenderIfMidList(_stateLenBeforeInsert, _roundStartUiIdx);
                        tokenStats.saveActiveSessionDebounced();
                    }
                    state.busy = false;
                    _stopping = false;
                    state.busyText = '';
                    state.streamingContent = '';
                    chatViewHelpers.syncView();
                    // 自动重试用尽时如实标注次数（与 Agent 循环同款文案）
                    var _retryNote = (_retryOutcome && _retryOutcome.attempts > 1)
                        ? AEI18n.t('（已自动重试 {n} 次仍失败）', { n: _retryOutcome.attempts - 1 }) : '';
                    messageHelpers.addMessage('assistant', AEI18n.t('流式请求失败: {detail}', { detail: (result.message || result.error) + _retryNote }));
                    // 结局标记：本次请求以错误收场，由 _runUserRequest 的 Script 分支 finally
                    // 统一收尾时按 error 分档播报；不标记则整轮静默。
                    _roundErrorFailure = result;
                    _roundEndKind = 'error';
                    return null;
                }

                if (!result.toolCalls || result.toolCalls.length === 0) {
                    acc.append('content', result.content || acc.snapshot().accumulatedContent);
                    acc.append('reasoning', result.reasoningContent || acc.snapshot().accumulatedReasoning);
                    acc.append('finishReason', result.finishReason || '');
                    break;
                }

                acc.append('content', result.content || acc.snapshot().accumulatedContent);
                acc.append('reasoning', result.reasoningContent || acc.snapshot().accumulatedReasoning);

                // 确保 reasoning 气泡已定形：LLM 可能只返回 reasoning + toolCalls 而无 content token，
                // 此时 onToken 未触发、reasoningFinalizedThisRound 仍为 false，reasoning-streaming 气泡残留。
                // syncView 前 finalize，避免 renderMessages 不清理 streaming 元素导致空气泡残留。
                if (!reasoningFinalizedThisRound && view && typeof view.finalizeReasoningStream === 'function') {
                    var _sFinalizeListEl = _laneListEl();
                    if (_sFinalizeListEl) view.finalizeReasoningStream(_sFinalizeListEl);
                    reasoningFinalizedThisRound = true;
                }

                // 推入 messages
                var assistantMsg = { role: 'assistant', content: result.content || '' };
                if (result.toolCalls) assistantMsg.tool_calls = result.toolCalls;
                if (result.reasoningContent) assistantMsg.reasoning_content = result.reasoningContent;
                messages.push(assistantMsg);
                scriptContextManager.addToolCallAssistant(result.content || '', result.toolCalls, result.reasoningContent || '');
                tokenStats.saveActiveSessionDebounced();
                // 1:1 镜像：空 content 也推入 state.messages（渲染层跳过空气泡），保持与 contextManager 下标对齐
                state.messages.push({ role: 'assistant', text: result.content || '', reasoningContent: result.reasoningContent || '', createdAt: Date.now() });
                chatViewHelpers.syncView();

                // 工具组锚位（打断错序修复）——与 agent 循环同款，说明见 _pushToolMsgAnchored
                var _grpCmList = scriptContextManager.list();
                var _grpAnchorCm = _grpCmList[_grpCmList.length - 1];
                var _grpAnchorUi = state.messages[state.messages.length - 1];
                var _grpLastCm = null, _grpLastUi = null;

                // 执行 tool call（同时收集 read_image 结果用于 vision 注入）
                var sToolResults = [];
                // 当前轮工具耗时累计（用于回填 roundRec，统计「工具步数/工具运行时间」）
                var _roundToolMs = 0;
                var _roundToolCount = 0;
                // 媒体工具单轮上限守卫（read_image/read_video 各 ≤5 次/轮）
                var _mediaGuard = createMediaCallGuard();
                for (var ti = 0; ti < result.toolCalls.length; ti++) {
                    var tc = result.toolCalls[ti];
                    state.toolCallInProgress = tc.function.name;
                    state.busyText = AEI18n.t('Script 工具: {name}...', { name: tc.function.name });
                    view.setBusy(state.busy, state.busyText);
                    if (typeof onStateChange === 'function') onStateChange(state);

                    var _toolT0 = Date.now();
                    var execResult = _mediaGuard(tc.function.name)
                        ? await toolExecutionPipeline.executeToolCall(tc, 'script')
                        : mediaCallLimitResult(tc.function.name);
                    _roundToolMs += Date.now() - _toolT0;
                    _roundToolCount++;

                    var _sTcArgs = argParsing.safeParseArgs(tc.function.arguments);
                    var toolContent = execResult.result || execResult.error || '';
                    // getPreviewFrame：filePath/fileName 一并发给 LLM（口径与
                    // agent 轮逐字同源——撤回理由、两笔代价与兜底见上方 processToolLoop 该处注释）。
                    var toolDetail = typeof toolContent === 'string' ? toolContent : JSON.stringify(toolContent || '');

                    // 提交工具卡片不再附带缩略图：ComfyUI 生成结果改由后台完成时以 system-result 卡片形式注入
                    messages.push({ role: 'tool', tool_call_id: tc.id, content: toolContent });
                    // 锚位落库（同 agent 模式）：正常态等价于追加；被打断消息挤到尾部时插回当前轮产出之后
                    _grpLastCm = _pushToolResultToCm(scriptContextManager, _grpAnchorCm, _grpLastCm,
                        tc.id, tc.function.name, toolContent, toolDetail, { success: execResult.success !== false, reviewRejected: execResult.reviewRejected === true, args: _sTcArgs });
                    sToolResults.push({ toolName: tc.function.name, success: execResult.success !== false, content: execResult.result || execResult.error || '', parsed: execResult.parsed, args: _sTcArgs });

                    // 在聊天 UI 显示工具调用结果（对齐 agent 模式）
                    var _sAction = (tc.function.name === 'executeExtendScript' && _sTcArgs && _sTcArgs.action) ? _sTcArgs.action : '';
                    var _sUiToolMsg = {
                        role: 'tool',
                        toolName: tc.function.name,
                        detail: toolDetail,
                        success: execResult.success !== false,
                        reviewRejected: execResult.reviewRejected === true,
                        action: _sAction,
                        args: _sTcArgs
                    };
                    if (_pushToolMsgAnchored(state.messages, _grpAnchorUi, _grpLastUi, _sUiToolMsg)) _forceFullRerenderNow();
                    _grpLastUi = _sUiToolMsg;

                    if (stopRequested) {
                        // 补上剩余未执行 tool 的占位结果，防 API 400（锚位落库，同 agent 模式）
                        for (var rj = ti + 1; rj < result.toolCalls.length; rj++) {
                            var rc = result.toolCalls[rj];
                            messages.push({ role: 'tool', tool_call_id: rc.id, content: '[stopped]' });
                            var _sRcArgs = argParsing.safeParseArgs(rc.function.arguments);
                            _grpLastCm = _pushToolResultToCm(scriptContextManager, _grpAnchorCm, _grpLastCm,
                                rc.id, rc.function.name, '[stopped]', '已停止', { success: false, args: _sRcArgs });
                            sToolResults.push({ toolName: rc.function.name, success: false, content: '[stopped]', parsed: null });
                            // 1:1 镜像：占位结果同步进 state.messages，保持与 contextManager 下标对齐
                            var _sUiStoppedMsg = { role: 'tool', toolName: rc.function.name, detail: '已停止', success: false, args: _sRcArgs };
                            if (_pushToolMsgAnchored(state.messages, _grpAnchorUi, _grpLastUi, _sUiStoppedMsg)) _forceFullRerenderNow();
                            _grpLastUi = _sUiStoppedMsg;
                        }
                        // 对齐 Agent 循环：占位 tool 消息已写入 cm/state——
                        // break 跳过下方的逐工具防抖保存（上一次落盘快照只到 addToolCallAssistant
                        // 之后、工具执行之前），快照不含当前轮任何工具结果；纯工具轮（无 content/reasoning）
                        // 停止后 _runUserRequest 不会再有带新快照的 addMessage，磁盘上只剩 assistant 的
                        // tool_calls，重载后工具卡片与真实结果消失。break 前显式保存（防抖重置计时，
                        // 工具结果与占位消息进入待落盘快照）。
                        tokenStats.saveActiveSessionDebounced();
                        break;
                    }
                    tokenStats.saveActiveSessionDebounced();
                }
                // 回填当前轮工具耗时到该轮 token 记录（工具在 LLM 调用之后执行，需单独回填）
                if (_roundToolCount > 0 && roundRec) {
                    var _loopStats = _statsStore();
                    if (_loopStats && typeof _loopStats.attachToolMetrics === 'function') {
                        _loopStats.attachToolMetrics(roundRec, _roundToolCount, _roundToolMs);
                        if (typeof view.updateTokenStats === 'function') {
                            view.updateTokenStats(_loopStats.getTotal());
                        }
                    }
                }
                if (stopRequested) break;

                // 工具卡按轮折叠（对齐 Agent 循环）：整批工具执行完后只 syncView 一次。
                // view.renderMessages 只把「同一批未渲染的连续 tool 消息」折成一组，逐个工具
                // syncView 会让每批只剩 1 条 → 每条工具单开一张「工具调用记录 (1 次)」。
                // 工具结果仍走 _pushToolMsgAnchored；中段插入（立刻发送打断）时
                // _forceFullRerenderNow 的强制整表重渲染语义不变。
                chatViewHelpers.syncView();
                // 工具结果已通过 state.messages → renderMessages 渲染，无需额外追加 DOM。

                // ── Vision hook: read_image/getPreviewFrame 成功执行后注入图片 ──
                var sFilePaths = [];
                var sFilePathSources = []; // 与 sFilePaths 一一对应：'getPreviewFrame' 或 'read_image'，用于区分注入文案
                var sFilePurpose = []; // 与 sFilePaths 一一对应：工具调用时主 LLM 传入的 purpose 需求提示词
                for (var ri = 0; ri < sToolResults.length; ri++) {
                    var sr = sToolResults[ri];
                    var _srAttach = false;
                    if ((sr.toolName === 'read_image' || sr.toolName === 'getPreviewFrame') && sr.success && sr.parsed && sr.parsed.filePath) {
                        _srAttach = true;
                    } else if (sr.toolName === 'analyzeImage' && sr.success && sr.parsed
                        && sr.parsed.attachImage === true && sr.parsed.filePath) {
                        // analyzeImage 抓帧模式才回图；文件模式只回指标
                        _srAttach = true;
                    }
                    if (_srAttach) {
                        sFilePaths.push(sr.parsed.filePath);
                        sFilePathSources.push(sr.toolName);
                        sFilePurpose.push(intentValidation.resolvePurpose(sr.args));
                    }
                }
                if (sFilePaths.length > 0) {
                    var sImageParts = [];
                    var sImageSources = []; // 与 sImageParts 一一对应，记录来源工具名用于生成上下文文案
                    var sImagePurpose = []; // 与 sImageParts 一一对应：本次分析该图片的需求提示词
                    // 停止信号传播到本地媒体轮询链（script 模式同款）——
                    // 停止后旧 loop 不再逐图烧满轮询，_stopping 窗口内新消息不再滞留。
                    function _sVisionAbortRequested() {
                        if (stopRequested) return true;
                        if (activeAbortController && activeAbortController.signal && activeAbortController.signal.aborted) return true;
                        return false;
                    }
                    var _sFirstTmpPreviewPath = null;   // 当前轮第一个临时预览帧：读完按池裁剪（不即删）
                    for (var fi = 0; fi < sFilePaths.length; fi++) {
                        // 停止后不再读取后续图片
                        if (_sVisionAbortRequested()) break;
                        var sfp = sFilePaths[fi];
                        _d('Vision-HOOK', 'readImageStable, filePath=' + sfp);
                        // 判定是否为临时预览帧：读完**不删**（Agent 可能复读同一张图），
                        // 改为当前轮结束后把预览帧池裁到最新 30 张（见 _retainPreviewFramePool）
                        var _sfn = sfp.replace(/^.*[\\\/]/, '');
                        var _sIsTmpPreview = /^ae_preview_\d+\.png$/i.test(_sfn);
                        if (_sIsTmpPreview && !_sFirstTmpPreviewPath) _sFirstTmpPreviewPath = sfp;
                        try {
                            var sResult = await mediaReaders.readImageStable(sfp, { shouldAbort: _sVisionAbortRequested });
                            if (sResult && sResult.success && sResult.base64) {
                                _d('Vision-HOOK', '稳定读取完成, size=' + sResult.size + ' b64Len=' + sResult.base64.length + ' mime=' + sResult.mime);
                                var sPngUrl = 'data:' + (sResult.mime || 'image/png') + ';base64,' + sResult.base64;
                                var sFinalUrl = await mediaReaders.convertPngToJpegViaCanvas(sPngUrl);
                                _d('Vision-HOOK', 'Canvas→JPEG, 转换后长度: ' + sFinalUrl.length);
                                sImageParts.push({ type: 'image_url', image_url: { url: sFinalUrl } });
                                sImageSources.push(sFilePathSources[fi]);
                                sImagePurpose.push(sFilePurpose[fi]);
                            } else {
                                _d('Vision-HOOK', '读取失败或超时');
                            }
                        } catch (e) {
                            _d('Vision-HOOK', '处理异常: ' + (e && e.message));
                        }
                    }
                    // 预览帧池裁剪：超出 30 张才删最旧的（读完即删会让 Agent 复读不到同一张图）
                    if (_sFirstTmpPreviewPath) _retainPreviewFramePool(_sFirstTmpPreviewPath);
                    if (sImageParts.length > 0) {
                        var sCanSee = global.AE_LLM && global.AE_LLM.supportsVision && (global.AE_LLM.supportsVision(_visionModelName, _scriptVisionPlatform) || global.AE_LLM.supportsVision(model, _scriptVisionPlatform));
                        _d('Vision-HOOK', '注入检查: _visionModelName=' + _visionModelName + ' model=' + model + ' platform=' + _scriptVisionPlatform + ' supports=' + !!sCanSee + ' images=' + sImageParts.length + ' hasProxy=' + _hasVisionProxy);
                        // 根据来源工具生成上下文文案：getPreviewFrame/analyzeImage=AE 合成截图，
                        // read_image=用户读取的图片（analyzeImage 只在抓帧模式进这里，文案同截图）
                        var _sHasCompShot = sImageSources.indexOf('getPreviewFrame') >= 0
                            || sImageSources.indexOf('analyzeImage') >= 0;
                        var _sImgHintText = _sHasCompShot && sImageSources.indexOf('read_image') >= 0
                            ? '以上图片包含 AE 合成截图和用户读取的图片。请根据图片内容完成用户需求。'
                            : (_sHasCompShot
                                ? '以上是AE合成截图。请根据画面信息完成用户需求。'
                                : '以上是用户读取的图片。请根据图片内容完成用户需求。');
                        if (_hasVisionProxy) {
                            // 视觉代理优先：配置了视觉代理时，无论主模型是否支持视觉，都用视觉模型生成中文描述
                            var _sProxyItems = [];
                            for (var sdi = 0; sdi < sImageParts.length; sdi++) {
                                if (sImageParts[sdi] && sImageParts[sdi].type === 'image_url' && sImageParts[sdi].image_url) {
                                    var _sImgHint = (sImageSources[sdi] === 'getPreviewFrame' || sImageSources[sdi] === 'analyzeImage') ? 'AE 合成截图' : '用户读取的图片';
                                    _sProxyItems.push({ url: sImageParts[sdi].image_url.url, hint: _sImgHint, purpose: sImagePurpose[sdi] });
                                }
                            }
                            var _sPResults = await visionProxy.describeImagesViaVisionProxy(_sProxyItems);
                            // 逐项对齐原始下标（与视频路径一致）——过滤 null 压缩
                            // 重编号使部分失败时【图片 N】序号错位、失败图凭空消失。
                            var _sPOkCount = 0;
                            for (var spdi = 0; spdi < _sPResults.length; spdi++) {
                                if (_sPResults[spdi]) _sPOkCount++;
                            }
                            if (_sPOkCount > 0) {
                                var _sPDescText = _sPResults.length === 1
                                    ? _sPResults[0]
                                    : _sPResults.map(function (d, i) { return '【图片 ' + (i + 1) + '】\n' + (d || '[第 ' + (i + 1) + ' 张图片描述失败，视觉代理无法分析其内容]'); }).join('\n\n');
                                var _sPDescMsg = '以下是图片的视觉描述（由视觉代理模型生成）：\n\n' + _sPDescText;
                                messages.push({ role: 'user', content: _sPDescMsg });
                                persistVisionDesc(_sPDescMsg);
                                _d('Vision-Proxy', '描述已注入 messages, 数量=' + _sPOkCount);
                            } else if (sCanSee) {
                                // 代理全部失败 + 主模型支持视觉：回退直接注入 image_url
                                sImageParts.push({ type: 'text', text: _sImgHintText });
                                messages.push({ role: 'user', content: sImageParts });
                                _d('Vision-Proxy', '所有图片描述生成失败，回退主模型直接注入 image_url');
                                if (global.AEToast) global.AEToast.show(AEI18n.t('视觉代理分析图片失败，已回退主模型直接识别'), 'warn');
                            } else {
                                // 代理全部失败且主模型也不支持视觉：必须给 LLM 反馈，否则 LLM 调了 read_image/getPreviewFrame 却得不到任何信息会困惑或重复调用
                                messages.push({ role: 'user', content: visionProxy.buildVisionProxyFailMessage('图片已读取', '图片描述') });
                                _d('Vision-Proxy', '所有图片描述生成失败，已注入失败提示');
                            }
                        } else if (sCanSee) {
                            // 未配置视觉代理 + 主模型支持视觉：直接注入 image_url
                            sImageParts.push({ type: 'text', text: _sImgHintText });
                            messages.push({ role: 'user', content: sImageParts });
                        }
                    }
                }

                // ── Video hook: read_video 成功执行后上传并注入 video_url ──
                await visionProxy.injectVideoViaReadVideo(sToolResults, messages, model, platform);

                // tool result 已推入 messages。按 OpenAI tool_calls 标准流程，
                // 此处不追加 user 消息——LLM 自主决定下一步（继续调工具或输出 action JSON 结束）。
            }

            if (loopCount >= maxLoops) {
                state.busy = false;
                state.busyText = '';
                chatViewHelpers.syncView();
                messageHelpers.addMessage('assistant', AEI18n.t('工具调用超过最大轮次，请简化需求后重试。'));
                // 结局标记：撞轮次上限 → 收尾时播 warn（对齐 Agent 循环 maxLoops 出口）
                _roundEndKind = 'limit';
                return _drainScriptQueueAndRecurse(null);
            }

            // 正常结束：直接返回结果让 _runUserRequest 解析 action（生成脚本/回复）。
            // 不调 drain——否则会丢弃当前未解析的 content（脚本 JSON），用户看不到生成结果。
            // 队列消息的自动处理需 _runUserRequest 配合（当前版本暂不处理正常结束后的队列）。
            var _accSnap = acc.snapshot();
            return { content: _accSnap.accumulatedContent, reasoningContent: _accSnap.accumulatedReasoning, finishReason: _accSnap.finishReason };
        }

        // 预览区快照按对话分账：面板内键=（模式，会话）——换会话或换模式即换桶，
        // 上一个对话的读取不再替本对话背书；切回原对话只要内容没变仍认（比对在 store 内做）。
        // 外接调用方由 store 内部恒落独立桶，不受面板切换影响。
        // store 缺席（旧装配 / 测试沙箱未注入）静默跳过——与既有降级契约一致。
        function _syncPreviewConversation(mode, sessionId) {
            try {
                var ps = global.AEEngine && global.AEEngine.previewSnapshot;
                if (ps && typeof ps.setConversation === 'function') {
                    // lane 分槽：账本键带 lane——三条 lane 的预览区读写账本互不顶替
                    //（外接调用方由 store 内部恒落独立桶的既有语义不变）。
                    // 键里带 lane 与第 2 参**并用**：无论 store 按键分槽还是按 laneId 分槽，
                    // 都落在本 lane 的桶里；单 Agent 路径 laneId 为空 ⇒ 键与传参都与改动前一致。
                    var _pvLaneId = getLaneId();
                    var _pvKey = String(mode == null ? '' : mode) + ':' + String(sessionId == null ? '' : sessionId);
                    if (_pvLaneId) _pvKey += ':' + _pvLaneId;
                    ps.setConversation(_pvKey, _pvLaneId);
                }
            } catch (_) {}
        }

        // _internal：仅 switchMode 自身的流程调用时传 true——见下方 _modeSwitching 守卫。
        async function switchSession(sessionId, _internal) {
            var _t0 = (typeof performance === 'object' && performance.now) ? performance.now() : Date.now();
            function _t(label) { console.log('[切换耗时] ' + label + ' +' + Math.round(((typeof performance === 'object' && performance.now) ? performance.now() : Date.now()) - _t0) + 'ms'); }
            // _stopping：停止清理窗口内禁止切换，防旧 loop 的部分回复/已停止消息写入新会话
            if (state.busy || _stopping) return { ok: false, reason: 'busy' };
            // 并发切换锁：快速连点时第二个切换直接拒，防交错写 contextManager
            if (_switching) return { ok: false, reason: 'busy' };
            // 模式切换（_modeSwitching）await 窗口内的外部会话切换直接拒。
            // switchMode 在写入 settings 前后有多段 await（flushPlan/curStore.flush/save、
            // 内层 switchSession 之间的 restorePlan/restoreTokenStats），期间 _switching
            // 尚未置位——会话切换器点击可并发进入：两者交错时 switchMode 的
            // curStore.save(curCm.getSessionId(), curCm.exportMessages()) 会读到并发切换
            // 刚 setSessionId 清空的中间态 cm（空快照写进目标会话文件），且两边各自
            // 收尾写 state，最终 cm/state/settings 三者错位。内部流程（switchMode 的
            // 内层切换）传 _internal=true 放行——本守卫只拦「另一条用户路径」。
            if (_modeSwitching && !_internal) return { ok: false, reason: 'busy' };
            // _dispatching：submitUserInput 派发窗口（gather/自动压缩的 await 期间，
            // busy 尚未置位）内切换会话，addMessage 会落在 setSessionId 与 importMessages
            // 之间被覆盖丢失，或写进错误会话——对齐 sendInjectItem 守卫直接拒。
            if (inputDispatch.getDispatching()) return { ok: false, reason: 'busy' };
            // 消息编辑的 gather/读图/showConfirm await 窗口
            // （_msgActionBusy=true、busy=false）内切换，编辑路径按旧会话 messages
            // 换算的 cm.updateMessage/truncateFrom 会错写错截新会话——cm 是持久化
            // 真相源，错截消息落盘后永久丢失。对齐 submitUserInput/injectSystemMessage
            // 的守卫链直接拒。
            if (_msgActionBusy) return { ok: false, reason: 'busy' };
            var store = chatViewHelpers.getActiveStore();
            var cm = chatViewHelpers.getActiveCm();
            var curId = cm.getSessionId();
            if (curId === sessionId) return { ok: false, reason: 'same' };

            _switching = true;
            try {
            // 切走前持久化当前会话的 token 统计，否则 reset 后切回会归零。
            // 但 deleteSession 删除当前会话后会调本函数切到 next：此时 curId 已
            // 不在 store 索引中，再保存会把当前 token 写回已删会话的孤儿文件，跳过。
            var curExists = false;
            var sessions = store.listSessions();
            for (var i = 0; i < sessions.length; i++) {
                if (sessions[i].id === curId) { curExists = true; break; }
            }
            if (curExists) tokenStats.saveCurrentTokenStats();

            // 切走前确保当前会话 plan 已写盘（fire-and-forget 的 pending save 在此 await）
            await planTracking.flushPlan();
            await store.flush();
            // 切走前导出当前消息副本——setSessionId 会清空 cm 内存态，目标
            // 会话读失败中止切换时用它恢复原会话内存态。
            var _curMsgs = null;
            if (curExists) {
                _curMsgs = cm.exportMessages();
                await store.save(curId, _curMsgs);
                await store.flush();  // 切出会话立即落盘，面板随后直接关闭也不丢
            }

            cm.setSessionId(sessionId);
            // 作废在途的团队 lane 回读：任何会重新 import 消息的路径都必须让旧的
            // 异步回读结果失效——否则「切走又切回同一条会话」时，旧 load 晚到会把历史再叠一遍
            //（cm 的 sessionId 相同、seq 又没变 ⇒ 两道守卫都拦不住，消息翻倍）。
            _adoptSeq++;

            sessionLoadingUi.showSessionLoading(true);  // 异步读取会话期间显示加载指示
            _t('show loading');
            var msgs = await store.load(sessionId);
            _t('store.load 完成');
            // 读失败（文件在但读不出/通道 reject）时 load 返回哨兵——按空会话
            // 导入的话，切走时 store.save 会用空内容整包覆盖原文件，会话静默丢失。中止
            // 切换：恢复原会话内存态（setSessionId 已清 messages，重导入切走前副本）、
            // 隐藏加载指示并提示错误，目标会话文件绝不写盘。文件不存在仍返回 null
            // （新会话语义），JSON 损坏留有 .corrupt 备份（既有语义）。
            if (msgs && msgs.__readFailed) {
                cm.setSessionId(curId);
                if (_curMsgs) cm.importMessages(_curMsgs);
                sessionLoadingUi.showSessionLoading(false);
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('会话读取失败，已中止切换以保护原文件，请重试或检查磁盘'), 'error');
                }
                return { ok: false, reason: 'read_failed' };
            }
            if (msgs === null) {
                cm.restore();
                msgs = cm.list();
            }
            cm.importMessages(msgs);
            cm.persist();
            _t('importMessages');

            activePlan = { steps: [] };
            var settings = getSettings();
            if (settings && settings.runtimeMode === 'agent') {
                await restorePlan(sessionId);
            }
            // service.tokenStats 恒 undefined（createService 只返回 reviewScript/reviewAeTool，
            // tokenStats 挂在 global.AEEngine.tokenStats）——经 _statsStore() 取**本 lane** 实例，
            // 防旧会话/旧模式的 token 记录污染新会话文件（单 Agent 路径回落缺省单例，行为不变）。
            var _laneStatsSwitch = _statsStore();
            if (_laneStatsSwitch && typeof _laneStatsSwitch.reset === 'function') {
                _laneStatsSwitch.reset();
            }
            _pendingImages = null;
            if (permissionPolicy) permissionPolicy.resetSession();  // 切换/新建会话清空"本次会话不再询问"记忆
            // 补表提议的会话同键去重表同样按会话边界清空——handler 由工具注册期
            // 构建一次并跨会话复用，不清则拒绝过一次的键在本面板会话内永远不能再提议，
            // 与「如需重新提议请换会话」的拒绝回执口径矛盾
            if (global.AEAgentTableTools && typeof global.AEAgentTableTools.resetSession === 'function') {
                global.AEAgentTableTools.resetSession();
            }

            state.messages = cm.list();
            state.sessionId = sessionId;
            var sessMeta = store.getSession(sessionId);
            state.sessionTitle = (sessMeta && sessMeta.title) || '新会话';
            if (typeof view.resetRenderedCount === 'function') view.resetRenderedCount();
            view.clearStreaming();
            chatViewHelpers.syncView(function () {
                // 等分批渲染完成后再隐藏加载指示，避免长历史会话切换时转圈提前消失
                sessionLoadingUi.showSessionLoading(false);
            });
            _t('syncView 完成');

            // 切换会话后刷新任务清单侧栏（与 trackSteps/updatePlan 等路径保持一致）
            if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                try { global.AEAgent.refreshList(); } catch (e) {}
            }
            _t('refreshList 完成');

            // 切入后恢复目标会话的 token 统计并刷新 UI
            await tokenStats.restoreTokenStats(sessionId);
            _t('restoreTokenStats 完成');

            store.updateLastActive(sessionId);
            // 会话边界：goal 一律 disarm（重开/切走要 /goal resume 才继续），并按新会话重读
            _reloadGoal();
            // 换会话即换桶：上一个对话的读取不再替本对话背书（面板内键=（模式，会话））
            var _modeNow = '';
            try { _modeNow = (getSettings() || {}).runtimeMode || ''; } catch (_) {}
            _syncPreviewConversation(_modeNow, sessionId);
            return { ok: true };
            } finally {
                _switching = false;
            }
        }

        // ── 团队模式的单 lane 会话落点 ────────────────────
        // 与 switchSession（上，:2670-2805）是**两件事**，不要互相替换：
        //   · switchSession = 面板单 Agent 路径的会话切换：落盘 → await store.load → 导入消息 →
        //     await restorePlan / restoreTokenStats（异步恢复链）。
        //   · adoptSession  = **整队切换时每条 lane 的落点**：「与 switchSession 的
        //     恢复链不是一回事」——只做六步会话边界清理 + 指针落位，**同步、不 await**。
        // 为什么必须同步：调用方 binder 的 _normalizeAction（team/sessionBinder.js:274-279）按
        // `typeof res.ok === 'boolean'` 判成败；返回 Promise 会被归因 `async_unsupported`
        // （= 每次整队切换都判失败，还要回滚已切成功的 lane，见 binder 头注 :13-19）。
        //
        // 六步 ↔ switchSession 的对应行（**改任何一步都要同步改两处**，故行号钉在这里）：
        //   ① `cm.setSessionId(sid)` + store 落空会话与索引项  ← :2725（+ 索引见 _ensureSessionEntry）
        //   ② `resetRenderedCount()` / `clearStreaming()`（cm 侧与 view 侧同名方法各调一次）
        //                                                      ← :2778-2779（switchSession 只调 view 侧）
        //   ③ `store.updateLastActive(sid)`                     ← :2796
        //   ④ tokenStats 复位（**按 lane**：_statsStore()）      ← :2761-2764
        //   ⑤ previewSnapshot 指针切到 (lane, sid)               ← :2800（_syncPreviewConversation）
        //   ⑥ 权限策略与补表去重表复位                            ← :2766 + :2770-2772
        // 另含 switchSession :2753 的 plan 内存态复位、:2774-2783 的 state 同步与 syncView
        //（不渲染＝面板上等于没切）。
        //
        // **不做**的一件事（有意，别当漏项偷偷补）：
        //   · 不显式落盘（store.save(curId, exportMessages) + await flush）也不 flushPlan：
        //     调用方（binder）在切换前已 stopAll，且旧会话的消息**不会因此丢**——两条既有防线
        //     都不依赖本步：① 每条消息都会安排 store.save(id, cm.list())，sessionStore 的
        //     防抖把 (id, 消息数组引用) 一起存进 _pendingSave，cm.setSessionId 是**换引用**
        //     （context.js:1072-1076 的 messages = []）⇒ 待写盘的那份仍是旧会话的内容；
        //     ② setSessionId 自身先 persist() 一次（旧会话的 localStorage 镜像）。
        //     真需要「切走即落盘」的调用方仍可自行 await store.flush()（binder 的 done 段）。
        //
        // 失败归因（**全部同步返回 { ok:false, reason }，不抛**；reason 与 binder 头注的归因表同口径）：
        //   bad_sid    sid 非法（store 用 sid 直接拼文件名，白名单与 binder 的 _validSid 同一条）
        //   busy       state.busy / _stopping / _switching 命中——与 switchSession :2674-2676 同源
        //   no_store   拿不到本 lane 的 store；或 store 缺「按显式 id 落空会话」的出口
        //              （detail:'no_ensure_api' / 'ensure_failed' / 'ensure_noop'，见 _ensureSessionEntry）
        function _validAdoptSid(sid) {
            return typeof sid === 'string' && /^[A-Za-z0-9_-]+$/.test(sid);
        }

        // ① 的落库口：store 落一份空会话与索引项。
        // sessionStore 的**现状**只有 `createSession()`，且它自造 `sess_<ts>_<rand>` id——拿它落库会得到
        // 三条 lane 各不相同的 id（不成其为一个团队会话），故这里按能力探测一个「按显式 id 落库」的
        // 出口（本文件认可的名单见 _ENSURE_API_NAMES）。能力缺席时**显式失败**，不静默假装成功：
        // 静默成功会让整队切到一个索引里没有、重启即不可达的会话上（store 的
        // sessions/<mode>_index.json 是会话可见性的唯一来源）。
        // 调用后**复查**索引：同名空实现 / 忽略入参自造 id 的实现都能被这一步挡下（返回 ensure_noop）。
        var _ENSURE_API_NAMES = ['ensureSession', 'ensureSessionEntry', 'createSessionWithId'];
        function _ensureSessionEntry(store, sid) {
            if (!store) return { reason: 'no_store' };
            var _read = function () {
                try { return (typeof store.getSession === 'function') ? store.getSession(sid) : null; } catch (_) { return null; }
            };
            if (_read()) return null;   // 已在索引里（切回旧会话的常见路径：零副作用）
            var apiName = null;
            for (var i = 0; i < _ENSURE_API_NAMES.length; i++) {
                if (typeof store[_ENSURE_API_NAMES[i]] === 'function') { apiName = _ENSURE_API_NAMES[i]; break; }
            }
            if (!apiName) return { reason: 'no_store', detail: 'no_ensure_api' };
            try {
                store[apiName](sid);
            } catch (e) {
                return { reason: 'no_store', detail: 'ensure_failed', error: String((e && e.message) || e) };
            }
            if (!_read()) return { reason: 'no_store', detail: 'ensure_noop' };
            return null;
        }

        // ── 团队 lane 的**历史回读**（修复「切换会话后聊天历史记录消失」）──
        // 必须回读的原因：adoptSession 只做六步会话边界清理 + 指针落位，**不读消息**，
        //（启动恢复链只在面板重载时跑，切会话不走它）。
        // 真机后果：会话文件里明明有 2 条消息
        //（store.load 读得到、盘上一条不少），切过去 cm 与界面都是空的 ⇒ 用户看到「历史消失」，
        // 且**切回也永远不回来**（每次切都只是清空）。
        // 为什么不能像 switchSession 那样 await：binder 的 _normalizeAction 按
        // `typeof res.ok === 'boolean'` 判成败，返回 Promise 会被归因 async_unsupported
        //（三条 lane 全判失败还要回滚，见 team/sessionBinder.js 头注）。所以**同步落位 + 异步回读**。
        // 窗口内的两道防线：
        //   · 提交闸门：_adoptRestoring 期间 getSwitching() 为 true ⇒ inputDispatch 拒发
        //     （文案「正在切换会话，请稍候再发送」）。没有它就会「消息写进半载入的 cm，
        //     随后被 importMessages 整包覆盖丢弃」——与单 Agent switchSession 窗口同一取舍；
        //   · 世代号：连切两条会话时旧结果一律作废（seq 不等即 return），不把 A 的历史贴到 B 上。
        // 读失败（__readFailed 哨兵）：**不导入空数组**（否则下一条新消息的落盘会把唯一副本
        // 整包覆盖），置 _adoptReadFailedSid 由 tokenStats 的落盘守卫挡住覆写，并如实告警。
        // 世代号 / 闸门 / 读失败守卫的**声明**在文件上方（紧邻 _msgActionBusy，见那里的注释）——
        // switchSession 也要 bump 世代号，声明必须早于它。
        // 覆盖性写的守卫（注入 tokenStats.saveActiveSessionDebounced；见 controller/tokenStats.js）
        function _adoptWriteBlocked() {
            if (!_adoptReadFailedSid) return false;
            var cmNow = chatViewHelpers.getActiveCm();
            if (!cmNow || typeof cmNow.getSessionId !== 'function') return false;
            // 已切到别的会话 ⇒ 守卫自动失效（不永久卡住后续会话的落盘）
            if (cmNow.getSessionId() !== _adoptReadFailedSid) { _adoptReadFailedSid = null; return false; }
            return true;
        }

        // 回读落地：导入消息（历史在前，载入窗口内新增的在后）→ 渲染 → 本 lane 统计。
        function _applyAdoptedMessages(sid, cm, msgs) {
            if (cm.getSessionId() !== sid) return;   // 双保险：已不在目标会话上
            var pending = cm.list() || [];
            var merged = msgs;
            if (pending.length) {
                // 载入窗口内追加的消息（后台结果回流等）——历史在前、新消息在后，
                // 绝不能反向（否则工具结果会跑到提问前面，LLM 下一轮读到的顺序是错的）
                merged = (Array.isArray(msgs) ? msgs : []).concat(pending);
            }
            if (Array.isArray(merged) && merged.length) cm.importMessages(merged);
            if (typeof cm.persist === 'function') cm.persist();
            state.messages = cm.list();
            if (typeof view.resetRenderedCount === 'function') view.resetRenderedCount();
            if (typeof view.clearStreaming === 'function') view.clearStreaming();
            chatViewHelpers.syncView();
            // 本 lane 的用量：与 switchSession 的 restoreTokenStats 对齐（否则切回会话用量恒 '--'）
            try {
                var pr = tokenStats.restoreTokenStats(sid);
                if (pr && typeof pr.catch === 'function') pr.catch(function () {});
            } catch (_) { /* 统计恢复失败不影响历史回读（restoreTokenStats 内部另有告警） */ }
        }

        // 回读驱动：store.load 是异步的（可达数百 ms），结果按世代号落地。
        function _restoreAdoptedSession(sid, store, cm) {
            var seq = ++_adoptSeq;
            _adoptRestoring++;
            // 保险（8s）：读挂住（通道不响应、文件锁）时**必须**把提交闸门放开——否则
            // getSwitching() 恒 true ⇒ 发送键被永久锁死、文案还说「正在切换会话」（一句假话）。
            // 到点只放闸门 + 告警，不导入任何东西（宁可这次历史不显示，也不能让面板不能发消息）。
            var settled = false;
            var abandoned = false;   // 保险到点后置真：迟到的结果**不再导入**
            var timer = null;
            var done = function () {
                if (settled) return;
                settled = true;
                if (timer) { clearTimeout(timer); timer = null; }
                _adoptRestoring = Math.max(0, _adoptRestoring - 1);
            };
            timer = setTimeout(function () {
                timer = null;
                if (settled) return;
                settled = true;
                abandoned = true;
                _adoptRestoring = Math.max(0, _adoptRestoring - 1);
                console.warn('[Agent] 会话 ' + sid + ' 的历史回读超时（8s）：本次不导入（迟到结果也不再导入），提交闸门已放开');
            }, 8000);
            var p;
            try { p = store.load(sid); } catch (e) { p = Promise.reject(e); }
            Promise.resolve(p).then(function (msgs) {
                done();
                if (abandoned) return;                      // 保险已放闸：迟到结果不导入
                if (seq !== _adoptSeq) return;              // 已被更新的切换取代：结果作废
                if (cm.getSessionId() !== sid) return;      // 双保险
                if (msgs && msgs.__readFailed) {
                    _adoptReadFailedSid = sid;
                    console.warn('[Agent] 会话 ' + sid + ' 的历史读取失败：本次不导入（保护原文件），'
                        + '且新的消息不会覆盖它');
                    if (typeof opts.showStatus === 'function') {
                        opts.showStatus(AEI18n.t('会话历史读取失败：已保护原文件不被覆盖，请重试或检查磁盘'), 'error');
                    }
                    return;
                }
                if (_adoptReadFailedSid === sid) _adoptReadFailedSid = null;
                // null = 文件不存在（新会话）：界面已是空的，无需导入；非空则落地
                if (Array.isArray(msgs) && msgs.length) _applyAdoptedMessages(sid, cm, msgs);
            }, function (e) {
                done();
                if (seq !== _adoptSeq) return;
                console.warn('[Agent] 会话 ' + sid + ' 的历史读取异常: ' + ((e && e.message) || e));
            });
        }

        function adoptSession(sid) {
            if (!_validAdoptSid(sid)) return { ok: false, reason: 'bad_sid', sid: sid };
            // 与 switchSession 同一组守卫（:2674-2676）：忙 / 停止清理窗口 / 切换窗口内拒绝。
            // binder 侧另有预检（team/sessionBinder.js:321-328），这里是「直调也安全」的第二道。
            if (state.busy || _stopping || _switching) return { ok: false, reason: 'busy', sid: sid };
            var store = chatViewHelpers.getActiveStore();
            var cm = chatViewHelpers.getActiveCm();
            if (!cm) return { ok: false, reason: 'no_store', sid: sid, detail: 'no_cm' };
            if (!store) return { ok: false, reason: 'no_store', sid: sid };
            // ①-前置：落库口先探后动——能力缺席时**零副作用**返回（cm 还指在旧会话上，
            //    binder 回滚/放弃时不必再修 cm）。
            var entryErr = _ensureSessionEntry(store, sid);
            if (entryErr) {
                entryErr.ok = false;
                entryErr.sid = sid;
                return entryErr;
            }
            // ① cm.setSessionId(sid)：setSessionId 内部会清空消息内存态（对齐 :2725 之后
            //    :2745-2748 的「null = 新会话」分支）。store 的索引项已在上一步落好。
            cm.setSessionId(sid);
            // ② 渲染计数与流式态归零（cm 侧 + view 侧都试；真实 cm 没有这两个方法，
            //    真实 view 有——与 switchSession :2778-2779 逐条对应）
            if (typeof cm.resetRenderedCount === 'function') cm.resetRenderedCount();
            if (typeof cm.clearStreaming === 'function') cm.clearStreaming();
            if (typeof view.resetRenderedCount === 'function') view.resetRenderedCount();
            if (typeof view.clearStreaming === 'function') view.clearStreaming();
            // ③ state 同步（:2774-2777）+ plan 内存态复位（:2753）
            state.messages = cm.list();
            state.sessionId = sid;
            var sessMeta = store.getSession(sid);
            state.sessionTitle = (sessMeta && sessMeta.title) || '新会话';
            activePlan = { steps: [] };
            // ③-b store 索引的 lastActiveId（:2796）。
            if (typeof store.updateLastActive === 'function') store.updateLastActive(sid);
            // 会话边界：goal 一律 disarm 并按本 lane 的新会话重读（只有导演 lane 会有目标）
            _reloadGoal();
            // ④ tokenStats 复位（:2761-2764）：**按 lane** 取实例（_statsStore()），
            //    不碰缺省单例——否则一条 lane 的整队切换会把单 Agent 路径的统计清掉。
            var _laneStatsAdopt = _statsStore();
            if (_laneStatsAdopt && typeof _laneStatsAdopt.reset === 'function') _laneStatsAdopt.reset();
            // ⑤ previewSnapshot 指针切到 (lane, sid)：**本步漏掉的后果**是新会话的预览区读写
            //    被旧账本错判（读过的内容被当成「当前内容」放行 / 已变更的被当成陈旧拒绝）。
            var _modeAdopt = '';
            try { _modeAdopt = (getSettings() || {}).runtimeMode || ''; } catch (_) {}
            _syncPreviewConversation(_modeAdopt, sid);
            // ⑥ 权限策略（:2766）与补表提议去重表（:2770-2772）复位——会话边界的两张会话级表
            if (permissionPolicy && typeof permissionPolicy.resetSession === 'function') permissionPolicy.resetSession();
            if (global.AEAgentTableTools && typeof global.AEAgentTableTools.resetSession === 'function') {
                try { global.AEAgentTableTools.resetSession(); } catch (_) { /* 补表模块的复位失败不阻断会话切换 */ }
            }
            // 渲染：不 syncView 等于面板上没切（:2780-2783）。onDone 留空——本函数同步返回，
            // 分批渲染的完成信号归 view 自己的批处理（binder 不看渲染完成）。
            chatViewHelpers.syncView();
            // plan 读盘：switchSession 是 `await restorePlan(sessionId)`（:2756）。本函数不能 await，
            // 故 fire-and-forget 触发同一次恢复（restorePlan 自身 try/catch，不会产生未处理拒绝）——
            // 不触发会让计划侧栏停在上一会话的计划上。仅 agent 槽（与 :2755 的 runtimeMode 判据一致）。
            if (_modeAdopt === 'agent' && typeof restorePlan === 'function') {
                try {
                    var _pr = restorePlan(sid);
                    if (_pr && typeof _pr.catch === 'function') _pr.catch(function () {});
                } catch (_) { /* 计划恢复失败不影响会话落位（restorePlan 内部另有告警） */ }
            }
            // 清单侧栏跟随（:2786-2789）
            if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                try { global.AEAgent.refreshList(); } catch (_) {}
            }
            // ⑦ 历史回读（**异步补**，见 _restoreAdoptedSession 头注）。放在最后：
            //    界面先落到「空会话」的确定态（上面的 syncView），回读结果再覆盖上去——
            //    顺序反了会让同步渲染与异步导入交错出半屏内容。
            _restoreAdoptedSession(sid, store, cm);
            return { ok: true };
        }

        async function createSession() {
            if (state.busy || _stopping) return { ok: false, reason: 'busy' };
            var store = chatViewHelpers.getActiveStore();
            // store.init() 异步读索引完成前 createSession 会因 _index 为 null 崩溃
            // （_index.sessions.push TypeError）。等待就绪后再建，已就绪时立即放行。
            // **有界**（见 _awaitStoreReady 注释）：读挂住时不能把会话菜单也挂死。
            await _awaitStoreReady(store);
            // 就绪等待只是**尽力**：init 自身异常时 `_index` 仍是 null，此时 store 侧会显式拒绝
            // （sessionStore.createSession 的就绪守卫）。本函数对外是「返回结果体」的契约，
            // 不把异常抛给调用方（sessionSwitcher 的 .then 没有 rejection 分支，
            // 抛出去就是「点了新建没反应、控制台一条未捕获拒绝」）。
            var session = null;
            try {
                session = store.createSession();
            } catch (e) {
                return { ok: false, reason: 'store_not_ready', detail: String((e && e.message) || e) };
            }
            if (!session || typeof session.id !== 'string' || !session.id) {
                return { ok: false, reason: 'store_not_ready', detail: 'createSession_no_id' };
            }
            var r = await switchSession(session.id);
            if (!r || !r.ok) {
                // 切换失败（如并发切换锁持有中）：回滚刚创建的空会话——否则索引里留下
                // 永不被激活的幽灵会话，而调用方（sessionSwitcher）按成功处理直接关菜单
                try { await store.deleteSession(session.id); } catch (_) {}
                return r || { ok: false, reason: 'busy' };
            }
            return { ok: true, session: session };
        }

        async function deleteSession(sessionId) {
            // 补 _switching 入口守卫——删除的恰是在途切换的目标会话时（点了会话 A
            // 切换、菜单保持展开期间又点 A 的删除），await store.deleteSession 完成后
            // 在途 switchSession 会继续跑完：cm 已 setSessionId(A)，收尾 updateLastActive(A)
            // 把 lastActiveId 指向已删出索引的 A——面板停留在已删除会话上，后续消息
            // store.save 重建索引外孤儿文件（重启丢失）。切换窗口内先拒绝删除
            // （修的是内部 switchSession 撞锁后的 busy 上报，此处堵源头窗口）。
            // 模式切换窗口同理拒绝——本函数在 await store.deleteSession 之后
            // 依赖内部 switchSession 收尾；该窗口内并发删除会与 switchMode 的保存/收尾
            // 交错（文件已删而 cm 仍指向它），与既有「切换窗口拒绝删除」同一取舍。
            if (state.busy || _stopping || _switching || _modeSwitching) return { ok: false, reason: 'busy' };
            var store = chatViewHelpers.getActiveStore();
            if (store.listSessions().length <= 1) {
                return { ok: false, reason: 'last_one' };
            }
            await store.deleteSession(sessionId);
            // 同步清理 localStorage 残留：context.js 的会话镜像键（两个 contextManager
            // 的镜像键同为 ae_agent_session_<sid>_v1 格式，一次 removeItem 即覆盖）
            // 注：plan 走 AEFS 文件持久化，由 store.deleteSession 同步清理 .plan.json
            try { localStorage.removeItem('ae_agent_session_' + sessionId + '_v1'); } catch (_) {}
            if (chatViewHelpers.getActiveCm().getSessionId() === sessionId) {
                var next = store.listSessions()[0];
                // store.deleteSession 是异步 IO（百 ms 级窗口），期间用户又点了
                // 切换会让内部 switchSession 撞 _switching 锁被拒。丢弃返回值照报
                // ok——当前 cm 仍指向已删会话，后续 addMessage 会 store.save 重建索引外
                // 孤儿消息文件（重启后不可达）。对齐 createSession 的失败上报：切换失败
                // 时返回失败结果，由调用方（sessionSwitcher）提示用户重试切换。
                var r = await switchSession(next.id);
                if (!r || !r.ok) {
                    // 走到这里时 `store.deleteSession(sessionId)` **已经执行完**（见上 :2649）——
                    // 失败的是「删掉当前会话之后切到下一个」。直接透传 `r`（busy/last_one…），
                    // 而 UI 对 `busy` 的文案是「未删除该会话」，对**已删**会话正好说反
                    //（删除**前**那条 busy 已单独修，这条需要自己的原因码）。
                    return {
                        ok: false,
                        reason: 'deleted_switch_failed',
                        deleted: true,
                        switchReason: (r && r.reason) || null
                    };
                }
            }
            return { ok: true };
        }

        function renameSession(sessionId, title) {
            var store = chatViewHelpers.getActiveStore();
            // store.renameSession 现返回落盘 promise（失败经 _noteSaveFailure 发
            // 一次性可见提示），这里把结果透传——同步部分（内存标题/顶栏刷新）保持原样，
            // 调用方不 await 时行为不变；await 者可拿到 {ok:false} 感知未落盘。
            var persistP = store.renameSession(sessionId, title);
            if (chatViewHelpers.getActiveCm().getSessionId() === sessionId) {
                state.sessionTitle = title;
                chatViewHelpers.syncView();
            }
            // 顶栏会话切换器标签同步刷新（自动标题 _autoTitleIfNeeded 也走这里，
            // 不刷新则首条消息后顶栏仍显示「新会话」）。
            // **走窄接口**：`refreshSessionSwitcher` 是宽跳（= 标题 + _refreshTeamUI
            // ⇒ teamUI.mount，实测 315ms/次团队档、622ms/次单 Agent 档），而改名只要标题跟上——
            // 自动标题在**每条会话的首条消息**都会触发，用宽接口等于每开一条会话多挂一次团队 UI。
            // 窄接口缺席（旧部署）时回落宽接口，行为与改动前一致。
            if (global.AEEngine && typeof global.AEEngine.refreshSessionTitle === 'function') {
                try { global.AEEngine.refreshSessionTitle(); } catch (_) {}
            } else if (global.AEEngine && typeof global.AEEngine.refreshSessionSwitcher === 'function') {
                try { global.AEEngine.refreshSessionSwitcher(); } catch (_) {}
            }
            if (persistP && typeof persistP.then === 'function') {
                return persistP.then(function (ok) { return { ok: ok !== false }; });
            }
            return { ok: true };
        }

        async function switchMode(newMode) {
            // 启动恢复链（store.init/migrate/入场动画等待，此窗口 busy/_switching
            // 均未置位）内切模式：旧模式 cm 仍指向初始 'default' 会话，下方切走保存会把
            // 'default' 写成索引外孤儿会话文件；且 settings.runtimeMode 被持久化改写后，
            // 恢复链尾按新模式 store 恢复并与本函数内层 switchSession 交错竞争 _switching 锁
            //（败方回滚 settings 造成设置与实际数据脱节）。对齐 submitUserInput 的 restoring
            // 守卫直接拒绝（恢复完成后由下方 busy/常规守卫接管）。
            if (state.restoring) {
                if (typeof opts.showStatus === 'function') {
                    opts.showStatus(AEI18n.t('会话恢复中，请稍候再切换模式'), 'info', { autoHideMs: 3000 });
                }
                return { ok: false, reason: 'busy' };
            }
            // _switching：会话切换窗口（store.load 异步可达数百 ms）内 mode 切换会与
            // 切换中的 contextManager 导入交错写状态，对齐 switchSession 的并发锁直接拒。
            // _dispatching：submitUserInput 派发窗口（gather/自动压缩 await，busy 未置位）
            // 内切模式同理——旧模式会话数据与即将启动的 _runUserRequest 并发交错。
            // _msgActionBusy：消息编辑的 await 窗口内切模式，编辑路径
            // 按旧模式会话换算的下标会错写错截新模式会话（编辑消息与新 LLM 轮次进错
            // 模式会话）——对齐 switchSession 补上同款守卫。
            if (state.busy || _stopping || _switching || inputDispatch.getDispatching() || _msgActionBusy) return { ok: false, reason: 'busy' };
            // 模式切换单飞——本函数在下方 flushPlan/curStore.flush/save
            // 处有多段 await，第二次调用若放行会与本次写入/回滚交错（见 _modeSwitching 定义处）。
            if (_modeSwitching) return { ok: false, reason: 'busy' };
            var settings = getSettings();
            if (settings && settings.runtimeMode === newMode) return { ok: false, reason: 'same' };
            // 'team' 不归本函数：进团队的唯一落点是 teamUI.setTeamEnabled(true)
            //（它要落设置 + 装配 orchestrator + 绑团队会话，本函数一条都不做）。若放进来，
            // 会写出「runtimeMode='team' 而引擎没开团队」的半态。显式拒绝而不是靠兜底。
            if (newMode === 'team') return { ok: false, reason: 'not_single_mode' };

            _modeSwitching = true;
            try {
            // 外接模式（EXT-MCP）快路径：外接无会话语义——保存当前模式会话（与正常
            // 路径同款尾部落盘）后仅持久化 runtimeMode，不切换/不恢复会话/不碰 plan。
            // 离开外接（external → 其他）走下方正常路径：curStore 落 script 回退分支
            //（getActiveStore 对 'external' 返回 script store），重存 script 会话幂等无害。
            // 授权状态与模式切换解耦：本函数既不开启也不关闭
            // 「外部访问授权」总开关——它只归状态卡开关管理（view.renderStatusCard）。
            // 在此 setActive(true) 自动授权会导致手动关闭后被一次模式往返悄悄覆盖。
            if (newMode === 'external') {
                tokenStats.saveCurrentTokenStats();
                var _laneStats = _statsStore();
                if (_laneStats && typeof _laneStats.reset === 'function') {
                    _laneStats.reset();
                }
                await planTracking.flushPlan();
                var extCurStore = chatViewHelpers.getActiveStore();
                var extCurCm = chatViewHelpers.getActiveCm();
                await extCurStore.flush();
                await extCurStore.save(extCurCm.getSessionId(), extCurCm.exportMessages());
                await extCurStore.flush();
                var extSettings = Object.assign({}, settings || {}, { runtimeMode: 'external' });
                if (typeof opts.saveSettings === 'function') {
                    opts.saveSettings(extSettings);
                }
                // 本支同样要换桶：否则键会停在切换前那个模式的键上（外接调用方虽走独立桶，
                // 但「键=当前（模式，会话）」这条不变量不能破——它保证任何面板侧写入都不会
                // 按上一个模式的读账落笔）
                var extSid = '';
                try { extSid = extCurCm.getSessionId(); } catch (_) {}
                _syncPreviewConversation(newMode, extSid);
                return { ok: true };
            }

            var curStore = chatViewHelpers.getActiveStore();
            var curCm = chatViewHelpers.getActiveCm();
            // 切走前持久化当前模式会话的 token 统计（必须在 saveSettings 之前，
            // 否则 getActiveStore 会指向新模式 store，写到错误的目录）
            tokenStats.saveCurrentTokenStats();
            // 保存后立即清空内存：否则 switchSession/同会话分支再次 saveCurrentTokenStats
            // 时，会把旧模式 token 写到新模式会话，造成跨模式 token 污染。
            // service.tokenStats 恒 undefined（createService 只返回 reviewScript/reviewAeTool，
            // tokenStats 挂在 global.AEEngine.tokenStats）——经 _statsStore() 取**本 lane** 实例，
            // 防旧会话/旧模式的 token 记录污染新会话文件（单 Agent 路径回落缺省单例，行为不变）。
            var _laneStatsSwitch = _statsStore();
            if (_laneStatsSwitch && typeof _laneStatsSwitch.reset === 'function') {
                _laneStatsSwitch.reset();
            }
            // 切走前确保旧模式 plan 已写盘（fire-and-forget 的 pending save 在此 await）
            await planTracking.flushPlan();
            await curStore.flush();
            await curStore.save(curCm.getSessionId(), curCm.exportMessages());
            await curStore.flush();  // 同上，切出模式立即落盘

            // 切换 runtimeMode（不覆盖 state.mode--state.mode 是 'A'/'B' 语义，由 setModeByDebug 管理）
            var newSettings = Object.assign({}, settings || {}, { runtimeMode: newMode });
            // 把新档位写成**自洽**的设置对象——runtimeMode=newMode ⇒
            // team.enabled=false、team.baseMode=newMode。控制器**不自己**写这两个字段（那是第二份
            // 实现，必漂移），一律经 engine 侧唯一实现。不做这一步的后果是具体可见的：
            // 从团队档切到 agent 后，设置里仍留着 enabled=true ⇒ 引擎/UI 继续按「团队开着」裁决。
            try {
                var _consFn = global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.applyModeConsistency;
                if (typeof _consFn === 'function') _consFn(newSettings);
            } catch (_) { /* 归一缺席（旧包/测试桩）：下方读侧 normalize 还会再纠正一次 */ }
            // 离开团队档时**引擎侧的退出由 AEEngine.switchGlobalMode 在本函数成功返回后完成**
            // （那里才知道「结果是否真的成功」）。放在本函数里会有两个坑——
            //   ① 本函数有 3 处失败回滚（switchSession 失败 / store 未就绪 / busy），回滚会把设置
            //      退回团队档，而引擎已经被关掉 ⇒ 需要每处再补一次「反向镜像」，三处都得记得写；
            //   ② 边失败边镜像本身又是一种「两个真相」的修补。
            // 交给调用方在成功分支关一次，就没有中间态：失败 ⇒ 设置与引擎都还在团队档；成功 ⇒
            // 设置已是目标档、引擎随即关闭（_disableTeam 会 _syncSlots 把槽位指回单 Agent runtime）。
            if (typeof opts.saveSettings === 'function') {
                opts.saveSettings(newSettings);
            }

            var newStore = chatViewHelpers.getActiveStore();
            // 目标模式的 store 索引必须**就绪**再读：
            //   · `getLastActiveId()` 在 `_index` 还是 null 时恒 null ⇒ 把「上次会话还在」的
            //     稳态误判成「该模式没有会话」→ 凭空新建一条，用户看到的是「切个模式上次会话没了」；
            //   · 走到 `createSession()` 更糟：`_index.sessions.push` 直接抛裸 TypeError
            //     （`Cannot read property 'sessions' of null`）。
            // 窗口是真实存在的：store.init() 异步读索引（Bridge/AEFS 数百 ms），而本函数的
            // `state.restoring` 守卫挡不住「恢复链已失败收尾 / 恢复链结束但某个 store 的 init 尚未
            // 落地」这两种情况。与 createSession() 同款守卫：等就绪再读，已就绪时立即放行。
            // **有界**（见 _awaitStoreReady 注释）：无界等待会把 `_modeSwitching` 永久置位 ⇒
            // 旋钮 / 切会话 / 删会话全 busy（静默死锁）；超时按未就绪走下面的显式失败体。
            await _awaitStoreReady(newStore);
            var newCm = chatViewHelpers.getActiveCm();
            var lastId = newStore.getLastActiveId();
            if (lastId && newCm.getSessionId() === lastId) {
                // 目标模式的 cm 仍持有 lastActive 会话（切走又切回的稳态路径）：
                // 无需重载，直接同步状态并视为切换成功。否则 switchSession 返回
                // 'same' 会让 main.js 回退复选框——settings 已写入新模式，UI 与设置脱节。
                activePlan = { steps: [] };
                if (newMode === 'agent') await restorePlan(lastId);
                var _laneStats = _statsStore();
                if (_laneStats && typeof _laneStats.reset === 'function') {
                    _laneStats.reset();
                }
                _pendingImages = null;
                state.messages = newCm.list();
                state.sessionId = lastId;
                var sessMeta = newStore.getSession(lastId);
                state.sessionTitle = (sessMeta && sessMeta.title) || '新会话';
                if (typeof view.resetRenderedCount === 'function') view.resetRenderedCount();
                view.clearStreaming();
                chatViewHelpers.syncView();
                // 恢复目标模式会话的 token 统计
                await tokenStats.restoreTokenStats(lastId);
                _syncPreviewConversation(newMode, lastId);
                // 模式边界：goal disarm 并按新模式的会话重读
                _reloadGoal();
                return { ok: true };
            }
            if (lastId) {
                // 内部流程放行 _modeSwitching 守卫（本次模式切换自己的会话切换）
                var _swResult = await switchSession(lastId, true);
                // 切换失败（上方 await 窗口内 busy/停止置位，或并发切换锁被占）：回滚 runtimeMode——
                // getActiveStore()/getActiveCm() 按 settings.runtimeMode 分发，settings 停在新模式
                // 而实际激活的会话数据停在旧模式，此后保存/读取全走错目录（状态与持久化脱节）。
                if (!_swResult || !_swResult.ok) {
                    // 条件回滚——仅当 settings 仍停在本次写入的目标模式时
                    // 才按入口快照回滚。await 窗口内其他路径（并发的设置写入/切换流程）可能
                    // 改写过 runtimeMode，无条件回滚会把更新的设置覆盖回旧值（败者回滚胜者）。
                    var _curModeSettings = null;
                    try { _curModeSettings = getSettings(); } catch (_) {}
                    if (typeof opts.saveSettings === 'function' && _curModeSettings && _curModeSettings.runtimeMode === newMode) {
                        opts.saveSettings(Object.assign({}, settings, { runtimeMode: settings.runtimeMode }));
                    }
                } else {
                    // switchSession 内已按当时 settings.runtimeMode 设过桶；此处用 newMode 幂等校正，
                    // 免去依赖「settings 落盘与 getSettings 读回的先后」
                    _syncPreviewConversation(newMode, lastId);
                }
                return _swResult;
            } else {
                // 索引未就绪（上面已 await whenReady，这里兜「init 自身异常」那一种）：显式失败 +
                // 条件回滚 settings.runtimeMode（与上面 switchSession 失败分支同口径：
                // 只有 settings 仍停在本次目标模式时才回滚，免覆盖并发写入的更新值）。
                // 不回滚就是「设置说 agent、实际数据在 script 目录」的脱节。
                var session = null;
                try {
                    session = newStore.createSession();
                } catch (e) {
                    var _rs = null;
                    try { _rs = getSettings(); } catch (_) {}
                    if (typeof opts.saveSettings === 'function' && _rs && _rs.runtimeMode === newMode) {
                        opts.saveSettings(Object.assign({}, settings, { runtimeMode: settings.runtimeMode }));
                    }
                    return { ok: false, reason: 'store_not_ready', detail: String((e && e.message) || e) };
                }
                newCm.setSessionId(session.id);
                newCm.importMessages([]);
                newCm.persist();
                // 与 switchSession 对齐的清理：防旧会话 plan/token/图片泄漏进新会话
                activePlan = { steps: [] };
                if (newMode === 'agent') await restorePlan(session.id);
                var _laneStats = _statsStore();
                if (_laneStats && typeof _laneStats.reset === 'function') {
                    _laneStats.reset();
                }
                _pendingImages = null;
                // 本支不经 switchSession，会话边界清理须在此补齐（对照
                // switchSession :2551-2557）——否则切到无 lastActive 的模式时，
                // permissionPolicy 的「本次会话不再询问」记忆与补表提议的去重表
                // 残留在上一会话状态上：新会话里同键提议被拒、权限确认不再弹。
                if (permissionPolicy) permissionPolicy.resetSession();
                if (global.AEAgentTableTools && typeof global.AEAgentTableTools.resetSession === 'function') {
                    global.AEAgentTableTools.resetSession();
                }
                state.messages = [];
                state.sessionId = session.id;
                state.sessionTitle = '新会话';
                if (typeof view.resetRenderedCount === 'function') view.resetRenderedCount();
                view.clearStreaming();
                chatViewHelpers.syncView();
                // 新会话无历史 token 记录，恢复为空并刷新 UI 显示 '--'
                await tokenStats.restoreTokenStats(session.id);
                newStore.updateLastActive(session.id);
                // 本支不经 switchSession，故单独设桶（模式+新会话）
                _syncPreviewConversation(newMode, session.id);
                return { ok: true };
            }
            } finally {
                _modeSwitching = false;
            }
        }

        function _autoTitleIfNeeded() {
            if (state.sessionTitle && state.sessionTitle !== '新会话') return;
            var msgs = chatViewHelpers.getActiveCm().list();
            for (var i = 0; i < msgs.length; i++) {
                // `_hidden` 跳过：goal 第 1 轮的 `<goal_round>` 指令以隐藏 user 消息承载（UI 不渲染），
                // 它不是人类发言；不过滤会让「先 /goal 再发第一条普通消息」的新会话标题变成
                // "<goal_round> Objective: ..."（隐藏消息在 cm 里的 role 仍是 user）。
                if (msgs[i].role === 'user' && !msgs[i]._hidden && msgs[i].text) {
                    // 剥离 <context> 动态上下文前缀，避免会话标题显示为 <context> 当前使用...
                    var _titleSrc = String(msgs[i].text).replace(/^<context>[\s\S]*?<\/context>\s*\n*/, '');
                    var title = _titleSrc.slice(0, 20).replace(/\s+/g, ' ').trim();
                    if (title) {
                        renameSession(chatViewHelpers.getActiveCm().getSessionId(), title);
                    }
                    break;
                }
            }
        }

        // 发起一轮用户请求的主流程（提交输入 / 消息编辑后重发共用）。
        // 前提：用户消息已在 contextManager 与 state.messages 中（本函数不再重复添加）。
        // 主体与重构前 submitUserInput 的派发逻辑一致（含 /reflect、Agent 工具循环、Script 生成流）。
        async function _runUserRequest(effectiveText) {
            stopRequested = false;
            stopPromiseResolve = null;
            activeAbortController = new AbortController();
            // 每轮起跑复位收尾方式标记（goal 驱动只看 clean 的收尾续轮）
            _roundEndKind = 'clean';
            // 新轮开始：上一轮失败留下的自动续轮定时器与失败结果作废（收尾时重新判定）
            _cancelGoalRetry();
            _roundErrorFailure = null;
            const settings = getSettings();
            // isAgentMode = 走工具循环（processToolLoop）而非脚本循环（processScriptToolLoop）。
            // **external 显式并入**：其工具是三方合并的扁平清单，与 Agent 同族；落到
            // else 走脚本循环，却拿着 Agent 提示词（见 processToolLoop 的提示词选择）——两者
            // 自相矛盾。今天不可达（外接模式无聊天输入，submitUserInput 各调用方均为 UI
            // 处理器；后台结果唤醒门亦排除 external），故此改不改变现状，只消除未来的语义错配。
            // **'team' 显式并入**：团队属 agent 循环族（三条 lane 的 slot
            // 就是 agent/shader，走的正是工具循环）。旧形态靠「runtimeMode 保持底层 agent 档」
            // 偶然落对；升格为第一等档位后若漏这一项，团队档会掉进**脚本循环**。
            const isAgentMode = settings.runtimeMode === 'agent' || settings.runtimeMode === 'shader'
                || settings.runtimeMode === 'external' || settings.runtimeMode === 'team';

            // /reflect handling：模式无关（Agent/Script 都能提炼当前会话经验）。
            // 曾置于 isAgentMode 分支内，Script 模式下 /reflect 会被当普通消息发送——表现为"命令失效"。
            // 词边界匹配（\b）：旧 indexOf('/reflect') === 0 会把 '/reflection'、'/reflective'
            // 等以 /reflect 开头的普通消息误劫持进提炼流程（commands.js 无此命令按原文发送，
            // 用户想发的对话内容被换成"经验提炼"）。\b 保证仅在命令名后紧跟空白/冒号/结尾时命中。
            if (/^\/reflect\b/.test(effectiveText.trim())) {
                state.busy = true;
                state.busyText = AEI18n.t('正在提炼经验...');
                chatViewHelpers.syncView();
                try {
                    var reflectCtxMsgs = chatViewHelpers.getActiveCm().toLlmMessages();
                    var reflectSystem = '你是经验提炼助手。回顾以下对话，如果确实有值得记录的经验（如踩坑教训、高效操作手法、特定需求的最佳实践等），提炼1-3条。如果对话只是日常闲聊或没有可沉淀的内容，返回空数组。\n\n每条经验必须包含：\n- name: 有意义的 kebab-case 标识（如 rotate-layer-with-expression）\n- description: 一句话概括这条经验是什么\n- content: 详细说明，包含 **Why:** 为什么这样做 / **How to apply:** 怎么用\n- scope: script（仅脚本生成时适用）、agent（仅 Agent 自主操作时适用）、both（都适用）\n- type: 固定为 "project"\n\n返回纯 JSON，不要 Markdown 包裹：\n{"memories":[{"name":"xxx","description":"xxx","type":"project","content":"xxx\\n\\n**Why:** xxx\\n**How to apply:** xxx","scope":"script|agent|both"}]}';
                    var reflectMsgs = [{ role: 'system', content: reflectSystem }];
                    for (var ri = 0; ri < reflectCtxMsgs.length; ri++) {
                        reflectMsgs.push(reflectCtxMsgs[ri]);
                    }
                    reflectMsgs.push({ role: 'user', content: '提炼经验。' });
                    // /reflect 后附带的文本作为提炼关注重点传入；纯 /reflect 时保持默认提示
                    var reflectFocus = effectiveText.trim().replace(/^\/reflect\b[\s:]*/, '').trim();
                    if (reflectFocus) {
                        reflectMsgs[reflectMsgs.length - 1].content = '提炼经验，重点关注：' + reflectFocus;
                    }
                    var channel = opts.llmChannel || (global.AE_LLM && global.AE_LLM.llmChannel);
                    if (channel && !stopRequested) {
                        var reflectResult = await channel.sendJson({
                            messages: reflectMsgs,
                            apiKey: await resolveApiKeyForPlatform(opts.getPlatform()),
                            model: opts.getModel(),
                            platform: opts.getPlatform(),
                            jsonMode: true,
                            options: { timeoutMs: 60000, signal: activeAbortController.signal }
                        });
                        // sendJson 出错不抛异常而是返回 {error}（llmChannel 设计），必须显式检查，
                        // 否则 API 失败会落到兜底分支，伪装成"AI 判断没有经验可记"
                        if (reflectResult && reflectResult.error) {
                            throw new Error(reflectResult.message || reflectResult.error);
                        }
                        if (reflectResult && reflectResult.content) {
                            var draft = argParsing.safeParseJson(reflectResult.content);
                            if (draft && draft.memories && draft.memories.length > 0) {
                                state.busy = false;
                                state.busyText = '';
                                chatViewHelpers.syncView();
                                messageHelpers.addMessage('assistant', AEI18n.t('经验草稿已生成，请在审阅面板中查看和确认。'), { reflectDraft: draft.memories });
                                activeAbortController = null;
                                stopPromiseResolve = null;
                                _stopping = false;
                                return;
                            }
                        }
                    }
                    activeAbortController = null;
                    stopPromiseResolve = null;
                    _stopping = false;
                    state.busy = false;
                    state.busyText = '';
                    chatViewHelpers.syncView();
                    messageHelpers.addMessage('assistant', AEI18n.t('回顾完成，这段对话没有需要记录的经验。'));
                } catch (e) {
                    activeAbortController = null;
                    stopPromiseResolve = null;
                    _stopping = false;
                    state.busy = false;
                    state.busyText = '';
                    chatViewHelpers.syncView();
                    messageHelpers.addMessage('assistant', AEI18n.t('反思过程出错: {error}', { error: e.message || e }));
                }
                return;
            }

            // 本次运行序号（只增不还）：收尾音只由最新一轮播报。赋值放在 /reflect 分支之后——
            // 那条分支不跑工具循环、也不需要完成音。
            var _runToken = ++_reqRunSeq;
            if (isAgentMode) {
                // Agent/Shader 模式：进入循环前先置 busy，避免图片异步预处理（尤其视觉代理批量识图）
                // 期间 busy 仍为 false，用户可再次发送。与下方 Script 模式分支行为对齐。
                state.busy = true;
                state.busyText = AEI18n.t('正在理解需求...');
                chatViewHelpers.syncView();
                try {
                    // gather 已由调用方（send/editUserMessage）提前完成，此处不再重复
                    await processToolLoop(effectiveText);
                } catch (e) {
                    if (chatViewHelpers.isAbortError(e)) {
                        messageHelpers.addMessage('assistant', AEI18n.t('已停止。'));
                    } else {
                        // 非停止异常同样按 error 收尾：否则 driver 会把它当自然收尾立即续轮，
                        // 且瞬时类异常（网络文案）拿不到失败自动续轮判定。
                        _roundErrorFailure = { error: 'EXCEPTION', message: (e && e.message) || String(e || '') };
                        _roundEndKind = 'error';
                        var classified = global.AE_LLM && global.AE_LLM.classifyError
                            ? global.AE_LLM.classifyError(e)
                            : { type: 'unknown' };
                        messageHelpers.addMessage('assistant', chatViewHelpers.getErrorMessage(classified.type, e));
                    }
                } finally {
                    activeAbortController = null;
                    stopPromiseResolve = null;
                    _pendingImages = null;
                    // 本次 finally 是否又把队列里的消息递归成新一轮：递归轮在自己的 finally
                    // 里已做过收尾判定，外层不得再用陈旧的收尾方式重复记一次（会把同一次
                    // 连续失败记两遍、提前触发上限）。
                    var _continuedByRecursion = false;
                    // 队列检查：网络错误/maxLoops 分支在 processToolLoop 内直接 return，
                    // 绕过了出口的队列递归续跑（L1159），执行中追加的消息会滞留到用户
                    // 下次主动发送才被 drain。对齐 Script 分支 finally 的兜底：
                    // 持久化队列消息后递归起新一轮。
                    if (_injectQueue.length > 0) {
                        state.busy = true;
                        state.busyText = AEI18n.t('处理追加消息...');
                        var queued = _injectQueue.slice();
                        _injectQueue.length = 0;
                        chatViewHelpers.syncView();
                        var lastText = '';
                        for (var qi = 0; qi < queued.length; qi++) {
                            var inj = queued[qi];
                            // 跨会话条目路由回原会话（同 processToolLoop 循环内 drain 语义）
                            if (_isCrossSessionInject(inj)) {
                                apiActions.appendToSession(inj.sessionId, inj);
                                continue;
                            }
                            if (inj.systemResult) {
                                chatViewHelpers.pushSystemResult(inj.title, inj.visible, inj.detail, inj.llmRole);
                                continue;
                            }
                            messageHelpers.addMessage('user', inj.text, inj.detail, inj.images, {
                                displayText: inj.displayText,
                                videos: inj.videos,
                                fileRefs: inj.fileRefs,
                                fileCtx: inj.fileCtx
                            });
                            // 视觉通道回填——下方续跑轮 _runUserRequest 的
                            // processToolLoop 在主消费点消费 _pendingImages，把该条的
                            // 图片带给 LLM（否则 imageDataUrls 被丢弃）。
                            // 多条带图条目合并累积而非单槽覆盖
                            // ——覆盖会丢前条的视觉通道（图片落盘但不进 LLM）。
                            if (inj.imageDataUrls && inj.imageDataUrls.length > 0) {
                                _pendingImages = (_pendingImages || []).concat(inj.imageDataUrls);
                            }
                            lastText = inj.text;
                        }
                        if (lastText) {
                            stopRequested = false;
                            stopPromiseResolve = null;
                            activeAbortController = new AbortController();
                            _continuedByRecursion = true;
                            await _runUserRequest(lastText);
                        } else {
                            // 无续跑轮消费回填的视觉通道时清掉，
                            // 防图片错挂到用户的下一条消息
                            _pendingImages = null;
                        }
                    }
                    _stopping = false;
                    state.busy = false;
                    state.busyText = '';
                    state.streamingContent = '';
                    state.streamingReasoning = '';
                    state.toolCallInProgress = null;
                    // 恢复"立刻发送"时暂存的其余待发送条目，继续排队等待后续自然 drain。
                    // 此刻整个任务链已结束，恢复后不会触发循环出口误发其余条目。
                    // 暂存条目已在 sendInjectItem 暂存时补记 sessionId，跨会话
                    // 切换后由各 drain 消费点经 _isCrossSessionInject 路由回原会话。
                    if (_deferQueue.length) {
                        _injectQueue.push.apply(_injectQueue, _deferQueue);
                        _deferQueue.length = 0;
                    }
                    // 立即落盘防抖中的会话数据，避免面板随后关闭时 flush 仍持有旧快照
                    var _finStore = chatViewHelpers.getActiveStore();
                    if (_finStore && typeof _finStore.flush === 'function') _finStore.flush();
                    chatViewHelpers.syncView();
                    // goal 续轮评估：一轮真正收尾的单点。
                    // 让行/额度/停止/会话一致性/**此刻是否空闲**等判据全在 driver 内，这里只给时机。
                    // 注意：用户消息轮的收尾发生在 submitUserInput 的 await 期间，派发锁仍持有
                    //（isIdle 为假 ⇒ 本次不消耗、不起轮）；锁释放后由 onDispatchEnd 补评估。
                    //
                    // 停止标记归一：stopRequested 是「本轮应停」的轮内状态，收尾时
                    // 仍为真说明当前轮是被用户停止打断的（driver 只续自然收尾）→ 记成 unclean，然后
                    // 清空。不清空的话，空闲时人 arm/resume/设新目标都会被 driver 的 isStopped
                    // 误判为「还在停止」而永远起不了轮（真机：/goal pause 再 resume 后不动）。
                    if (stopRequested && _roundEndKind === 'clean') _roundEndKind = 'stop';
                    stopRequested = false;
                    if (_continuedByRecursion) {
                        // 收尾判定已由递归轮完成，外层只补一次时机（driver 判据自会挡重复起轮）
                        _kickGoalDriver('round-end');
                    } else {
                        _noteRoundEndForGoal(_roundErrorFailure);
                        _kickGoalDriver('round-end');
                    }
                    _forcedInjectText = null;
                }
                return;
            }

            state.busy = true;
            state.busyText = AEI18n.t('正在理解需求...');
            chatViewHelpers.syncView();

            try {
                // gather 已由调用方（send/editUserMessage）提前完成，此处不再重复
                var toolLoopResult = await processScriptToolLoop(effectiveText);
                if (!toolLoopResult) {
                    return; // 错误已在 processScriptToolLoop 中处理
                }
                var toolLoopContent = toolLoopResult.content || '';
                var toolLoopReasoning = toolLoopResult.reasoningContent || '';
                var trimmed = (toolLoopContent || '').trim();
                // Script 模式循环退出后，content 是 LLM 的自然语言回复（或空）。
                // 脚本提交由 submit_script 工具在循环内完成（写预览区+校验），退出循环即意味着 LLM 结束对话。
                if (!trimmed && toolLoopReasoning) {
                    var _finishReason = (toolLoopResult.finishReason || '').toLowerCase();
                    if (_finishReason === 'length') {
                        trimmed = '（思考已完成但未生成回复，可能是思考内容过长导致输出被截断，请重试或降低思考强度。）';
                    } else if (_finishReason && _finishReason !== 'stop') {
                        if (typeof opts.showStatus === 'function') {
                            opts.showStatus(AEI18n.t('LLM 响应异常（finishReason={reason}）', { reason: _finishReason }), 'warn', { autoHideMs: 6000 });
                        }
                    }
                    // 只思考无回复（超长上下文下常见）：思考气泡此刻仍是「思考中...」展开态。
                    // 不折叠它，仅定形为展开的「思考过程」并随消息持久化，避免 UI 卡在思考中
                    // 且发新消息后思考内容被 renderMessages 当 streaming 残留清掉而丢失。
                    if (view && typeof view.finalizeReasoningStream === 'function') {
                        var _sroEl = _laneListEl();
                        if (_sroEl) view.finalizeReasoningStream(_sroEl, false);
                    }
                }
                if (trimmed) {
                    messageHelpers.addMessage('assistant', trimmed, null, null, { reasoningContent: toolLoopReasoning, _llm: true });
                } else if (toolLoopReasoning) {
                    // 正常结束只思考：以思考-only 消息呈现（渲染为展开的「思考过程」块）
                    messageHelpers.addMessage('assistant', '', null, null, { reasoningContent: toolLoopReasoning, _llm: true });
                }
                state.busy = false;
                state.busyText = '';
                chatViewHelpers.syncView();
            } catch (e) {
                if (chatViewHelpers.isAbortError(e)) {
                    messageHelpers.addMessage('assistant', AEI18n.t('已停止。'));
                } else {
                    // 非停止异常（API Key 解析失败等）→ 结局按错误分档播报
                    // 记为失败结果供 goal 收尾判定：网络类异常（文案匹配）仍走瞬时自动续轮
                    _roundErrorFailure = { error: 'EXCEPTION', message: (e && e.message) || String(e || '') };
                    _roundEndKind = 'error';
                    var classified = global.AE_LLM && global.AE_LLM.classifyError
                        ? global.AE_LLM.classifyError(e)
                        : { type: 'unknown' };
                    messageHelpers.addMessage('assistant', chatViewHelpers.getErrorMessage(classified.type, e));
                }
            } finally {
                // 本层结局就地捕获：队列续轮会递归进 _runUserRequest，共享的 _roundEndKind
                // 会被内层请求在入口复位。播报只由最新一轮触发（末尾 _runToken 比对），
                // 内层用自己的捕获值、外层不再播，二者不会互相顶替。
                var _finEndKind = _roundEndKind;
                activeAbortController = null;
                _pendingImages = null;
                // 递归续跑轮已在自己的 finally 做过收尾判定：外层不得用陈旧收尾方式重复记失败
                var _continuedByRecursion = false;
                // 队列检查：递归期间用户追加的消息在此处理（对齐 Agent 模式 processToolLoop L1478 的递归）。
                // 必须在设 busy=false 之前检查并保持 busy=true，否则 UI 会闪烁非执行态。
                // 覆盖场景：
                // 1. 正常结束分支（processScriptToolLoop 直接返回 content，未调 _drainScriptQueueAndRecurse）
                // 2. abort/maxLoops 分支递归期间用户又追加的消息
                if (_injectQueue.length > 0) {
                    state.busy = true;
                    state.busyText = AEI18n.t('处理追加消息...');
                    var queued = _injectQueue.slice();
                    _injectQueue.length = 0;
                    chatViewHelpers.syncView();
                    var lastText = '';
                    for (var qi = 0; qi < queued.length; qi++) {
                        var inj = queued[qi];
                        // 跨会话条目路由回原会话（同 processToolLoop 循环内 drain 语义）
                        if (_isCrossSessionInject(inj)) {
                            apiActions.appendToSession(inj.sessionId, inj);
                            continue;
                        }
                        if (inj.systemResult) {
                            chatViewHelpers.pushSystemResult(inj.title, inj.visible, inj.detail, inj.llmRole);
                            continue;
                        }
                        messageHelpers.addMessage('user', inj.text, inj.detail, inj.images, {
                            displayText: inj.displayText,
                            videos: inj.videos,
                            fileRefs: inj.fileRefs,
                            fileCtx: inj.fileCtx
                        });
                        // 视觉通道回填——下方续跑轮 _runUserRequest 的
                        // processScriptToolLoop 在入口消费 _pendingImages（同 Agent 模式）。
                        // 多条带图条目合并累积而非单槽覆盖
                        // ——覆盖会丢前条的视觉通道（图片落盘但不进 LLM）。
                        if (inj.imageDataUrls && inj.imageDataUrls.length > 0) {
                            _pendingImages = (_pendingImages || []).concat(inj.imageDataUrls);
                        }
                        lastText = inj.text;
                    }
                    // 队列里只有 system-result、无用户文本：跳过续跑，直接走下方复位
                    if (lastText) {
                        stopRequested = false;
                        stopPromiseResolve = null;
                        activeAbortController = new AbortController();
                        _continuedByRecursion = true;
                        await _runUserRequest(lastText);
                    } else {
                        // 无续跑轮消费回填的视觉通道时清掉，
                        // 防图片错挂到用户的下一条消息
                        _pendingImages = null;
                    }
                }
                _stopping = false;
                state.busy = false;
                state.busyText = '';
                // 恢复"立刻发送"时暂存的其余待发送条目，继续排队等待后续自然 drain。
                // 此处位于 Script 分支 drain 之后，恢复后不会再次触发当前轮 drain 误发其余条目。
                if (_deferQueue.length) {
                    _injectQueue.push.apply(_injectQueue, _deferQueue);
                    _deferQueue.length = 0;
                }
                _forcedInjectText = null;
                // 立即落盘防抖中的会话数据，避免面板随后关闭时 flush 仍持有旧快照
                var _finStore2 = chatViewHelpers.getActiveStore();
                if (_finStore2 && typeof _finStore2.flush === 'function') _finStore2.flush();
                chatViewHelpers.syncView();
                // 当前轮真正结束（队列续轮已在上方递归处理完）→ 统一收尾与完成提示音。
                // 只由最新一轮播报（_runToken 比对序号）：续轮的内层请求会先把序号推大，
                // 外层收尾时不再重复响。必须放在 tryWakeBgResult 之前：唤起会立刻起新一轮
                // 并置 busy，收尾（busy=false）若排在它后面会把新轮的执行态打掉。
                if (stopRequested && _finEndKind === 'clean') _finEndKind = 'stop';
                if (_runToken === _reqRunSeq) _finalizeRound(_finEndKind);
                // goal 续轮评估（Script 档也支持目标）：时机与 Agent 分支
                // 一致（当前轮真正收尾后），判据全部在 driver 内（isSupported / 自然收尾 / 空闲 / 让行），
                // 这里只给时机。停止标记归一也必须与 Agent 分支同款——driver 的 isRoundClean 读的是
                // 共享 _roundEndKind，脚当前轮被用户停止时若仍停在 'clean'，下一轮会被误判为自然收尾。
                if (stopRequested && _roundEndKind === 'clean') _roundEndKind = 'stop';
                stopRequested = false;
                if (_continuedByRecursion) {
                    // 收尾判定已由递归轮完成，外层只补一次时机（driver 判据自会挡重复起轮）
                    _kickGoalDriver('round-end');
                } else {
                    _noteRoundEndForGoal(_roundErrorFailure);
                    _kickGoalDriver('round-end');
                }
                // 后台结果唤起：一轮跑完是安全时机（busy 已复位、_deferQueue
                // 已恢复）。兜住「唤起因守卫为真被延后」的情形；唤起轮自身收尾也会走到这里，
                // 由 apiActions 内的 _bgWakeRunning 重入守卫挡住（其 .then 里会再补一次）。
                try {
                    if (apiActions && typeof apiActions.tryWakeBgResult === 'function') apiActions.tryWakeBgResult();
                } catch (_) {}
            }
        }

        // ── 消息编辑（任务：hover 操作入口）──

        // 编辑后重发时尽量还原图片附件：data URL 直接用；文件路径读回 base64 转 data URL。
        // 读不到（临时文件已删等）静默跳过——气泡里的缩略图仍保留，仅 LLM 侧少一张图。
        async function _resolveImagesForResend(images) {
            var urls = [];
            if (!Array.isArray(images)) return urls;
            for (var i = 0; i < images.length; i++) {
                var src = images[i];
                if (!src) continue;
                if (typeof src === 'string' && src.indexOf('data:') === 0) {
                    urls.push(src);
                    continue;
                }
                // 相对路径（agent\temp\...）拼接数据目录为绝对路径（数据目录迁移后仍可读）
                if (typeof src === 'string' && !/^[a-zA-Z]:[\\/]/.test(src)) {
                    var _rd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                        ? global.AEShared.getDataDir().dir : '';
                    if (_rd) src = _rd.replace(/\\+$/, '') + '\\' + src.replace(/^[\\/]+/, '');
                }
                try {
                    if (typeof AEFS !== 'undefined' && AEFS && typeof AEFS.readImageBase64 === 'function') {
                        var r = await AEFS.readImageBase64(src);
                        if (r && r.success && r.base64) {
                            var dataUrl = 'data:' + (r.mime || 'image/png') + ';base64,' + r.base64;
                            urls.push(await mediaReaders.convertPngToJpegViaCanvas(dataUrl));
                        }
                    }
                } catch (_) {}
            }
            return urls;
        }

        // 用户消息「编辑」：更新文本 + 截断其后全部消息（含工具调用组/助手回复），重新发起循环。
        // 附件（images）保留在原消息上不动，仅文本被替换；重发时尽量把图片重新带给 LLM。
        async function editUserMessage(stateIdx, newText) {
            // _dispatching：submitUserInput 派发窗口（gather/自动压缩 await，busy 未置位）内
            // 编辑重发会与即将启动的 _runUserRequest 并发起两个工具循环——对齐 switchSession 守卫。
            // gather（多次 evalScript）/读图（文件 IO）的 await 窗口不设 busy，
            if (state.busy || _stopping || _switching || inputDispatch.getDispatching() || _msgActionBusy) {
                contextCompression.notifyMsg('当前有任务在执行，结束后再编辑消息', 'warn');
                return { ok: false, reason: 'busy' };
            }
            var idx = Number(stateIdx);
            if (!isFinite(idx) || idx < 0 || idx >= state.messages.length) return { ok: false, reason: 'invalid' };
            idx = Math.floor(idx);
            var msg = state.messages[idx];
            if (!msg || msg._local || msg.role !== 'user') return { ok: false, reason: 'not_user' };
            var text = String(newText == null ? '' : newText).trim();
            if (!text) {
                contextCompression.notifyMsg('消息内容不能为空', 'warn');
                return { ok: false, reason: 'empty' };
            }

            // gather（多次 evalScript）/读图（文件 IO）的 await 窗口不设 busy，
            // 期间 submitUserInput 放行会插入并发起第二个工具循环、且新消息刚持久化即被
            // 下方 cm.truncateFrom 删除。入口校验通过后立即置互斥标志（submitUserInput
            // 据此拒绝），finally 确保复位（含异常路径）；起循环（_runUserRequest 同步
            // 置 busy）前先行复位，避免任务执行中的正常追加入队被误拒。
            _msgActionBusy = true;
            try {
                // ①③④ 更新文本（persist + 内层账本同步在 cm API 内完成）
                // gather 提前，使 buildContextPrefix 能注入最新 AE snapshot。
                // 传当前轮模块身份（与轮次工具集同一映射）：shader 轮无 queryProject（scope 限
                // agent/script）→ 快照为空，工程/选中信息不进 shader 轮上下文。
                if (global.AEEngine && global.AEEngine.aeContext) {
                    // lane 并联身份：moduleIds **原样传集合**——它决定
                    // toolExecutor.checkAccess 的 scope 合法性（给 lane 造新 moduleId 会让
                    // 精确匹配失败 → ACCESS_DENIED → 快照恒空）；laneKey 只做缓存分槽，
                    // 绝不参与 scope 判定。单 Agent 路径 moduleIds 走 roundModuleId（身份），
                    // 但**槽键不得**跟着走 mode（见下）。
                    var _gatherModuleIds = getLaneModuleIds() || roundModuleId((getSettings() || {}).runtimeMode);
                    // 槽键**只认 lane**：单 Agent 传 undefined ⇒ 缺省槽。
                    // 为什么不能用 roundModuleId(mode) 当槽键（实测）：那会把
                    // 「跨模式的陈旧快照被身份过滤挡掉」变成「本模式的旧槽照旧放行」——
                    // gather(agent)→gather(shader)→读 agent 由 `''` 变成「上一轮 agent 旧快照」，
                    // 于是模式往返后走**不先 gather 的注入通道**（队列 drain / apiActions）时，
                    // 过期的 AE 工程/选中信息会被当当前轮上下文注入模型。
                    var _gatherLaneKey = getLaneId() || undefined;
                    await global.AEEngine.aeContext.gather(_gatherModuleIds, _gatherLaneKey);
                }
                // cmIdx 与 cm 能力检查整体移到 gather await 之后——gather 的
                // await 窗口内若并发手动压缩，compactWithSummary/pruneByTokens 会改写 cm
                //（消息条数/顺序变化），提前算好的下标过期错位，cm.updateMessage/
                // truncateFrom 会改错/错删消息（压缩侧已同步用 _msgActionBusy 拒绝非
                // internal 调用作双保险，此处后移消除残余窗口）。
                var cm = chatViewHelpers.getActiveCm();
                var cmIdx = contextCompression.cmIndexForStateIndex(idx);
                if (cmIdx < 0 || typeof cm.updateMessage !== 'function' || typeof cm.truncateFrom !== 'function') {
                    // 用户可见提示：cm 已被 pruneByTokens/压缩裁掉这条旧消息（cmIndexForStateIndex
                    // 扣除偏移后 < 0）若静默失败，面板点"编辑"像坏了。文案客观说明边界，
                    // 不暗示可恢复（cm 是持久化真相源，被裁消息无法编辑）。
                    contextCompression.notifyMsg('该消息已超出可编辑范围（已被上下文裁剪/压缩），无法编辑重发。', 'warn');
                    return { ok: false, reason: 'cm_unsupported' };
                }
                // 编辑重发与发送路径一致：LLM 文本含 chip token 时原位替换为行号引用，
                // UI 用 displayText 保留原始 token（聊天框仍显示 chip 标签）
                var llmText = chatViewHelpers.resolveChipTokensForLlm(text);
                // 编辑后重新注入 <context> 前缀（与 addMessage 格式一致，保持历史消息可缓存）
                var ctxText = messageHelpers.buildContextPrefix() + llmText;
                cm.updateMessage(cmIdx, ctxText, String(newText == null ? '' : newText));
                msg.text = ctxText;
                msg.displayText = String(newText == null ? '' : newText);
                // 截断其后全部消息（两套数组同边界）
                state.messages.splice(idx + 1);
                cm.truncateFrom(cmIdx + 1);
                // ②⑤ 落盘 + 全量重渲染（token 环随 syncView→onStateChange 刷新）
                contextCompression.persistAndRerenderAfterTruncation();

                // 附件图片尽量重新注入（与首次发送同通道：_pendingImages → processToolLoop 视觉注入）
                var resendImages = await _resolveImagesForResend(msg.images);
                _pendingImages = resendImages.length > 0 ? resendImages : null;
            } finally {
                _msgActionBusy = false;
            }

            // 用剥离 <context> 的 text 调 _runUserRequest，与 send 路径一致：
            // - Agent 模式：processToolLoop 不 push 当前轮 userMsg（user 消息已由 addMessage 持久化），
            //   _currentUserText 仅用于 validator.review 的 userMessage 参数（审查不需要 <context>）。
            // - Script 模式（后）：processScriptToolLoop 同样不 push userMsg，
            //   cm 中持久化的 ctxText（含 <context>）是 LLM 看到的当前轮唯一 user 消息，
            //   缓存前缀稳定。
            await _runUserRequest(llmText);
            return { ok: true };
        }

        // 读这两个工具也要走**本 runtime 的** handler 绑定：注册进全局表供清单/外接
        // 投影用，同时记进本 runtime 的绑定表（pipeline 下发、执行器按执行者解析）。两个工具内部
        // 原本用 hasTool 守卫只让第一个装配者注册——那恰好导致「所有 runtime 共用第一个的 handler」，
        // 与本次结构性修复相悖，故去掉了守卫（同名重复注册只覆盖全局元数据，各自绑定各记一份）。
        earlyHistoryTool.registerEarlyHistoryTool(toolRegistry);
        // read_tool_result（大工具结果分页读取）由 controller/toolResultReaderTool.js 提供。
        toolResultReaderTool.registerReadToolResult(toolRegistry);

        // ── submitUserInput 派发器 + api 门面实体动作外提（controller/）──
        // inputDispatch 持有 submitUserInput 主派发器；apiActions 持有 api 门面内联实体方法。
        // controller 闭包可变状态经 getter/setter 惰性注入（运行时才取值，规避 TDZ 与循环依赖）。
        var inputDispatch = global.AEEngine.createInputDispatch({
            view: view,
            pendingInput: pendingInput,
            state: state,
            messageHelpers: messageHelpers,
            chatViewHelpers: chatViewHelpers,
            onStateChange: opts.onStateChange,
            showStatus: opts.showStatus,
            getStopping: function () { return _stopping; },
            getSwitching: function () { return _switching || _adoptRestoring > 0; },
            getInjectQueue: function () { return _injectQueue; },
            setPendingImages: function (v) { _pendingImages = v; },
            setStopRequested: function (v) { stopRequested = v; },
            getStopRequested: function () { return stopRequested; },
            getStopPromiseResolve: function () { return stopPromiseResolve; },
            setStopPromiseResolve: function (v) { stopPromiseResolve = v; },
            getActiveAbortController: function () { return activeAbortController; },
            setActiveAbortController: function (v) { activeAbortController = v; },
            getAutoTitle: function () { return _autoTitleIfNeeded; },
            getRunUserRequest: function () { return _runUserRequest; },
            setTurnOrigin: function (o) { _turnOrigin = o || 'user'; },
            getCompressContext: function () { return _api.compressContext; },
            // 压缩失败的文案（唯一一份）——发送前的自动压缩 toast 用它，不再把内部错误码抛给用户
            getCompressFailureText: function () { return _api.describeCompressFailure; },
            // AE 上下文快照的注入身份（当前轮模块，与轮次工具集同一映射）——
            // 供 submitUserInput 的 gather 决定工程/选中信息是否进当前轮上下文
            getRoundModuleId: function () { return roundModuleId((getSettings() || {}).runtimeMode); },
            // 并联身份 / 快照身份：submitUserInput 的 gather 按集合判合法性、按 laneKey 分槽
            getToolModuleIds: function () { return getLaneModuleIds(); },
            // 附件分槽身份：pendingInput.consume 必须与 app/main.js 的写入端带同一条 lane，
            // 否则团队模式下挂起的附件会落缺省槽、被别条 lane 取走。单 Agent 路径返回 null ⇒ 缺省槽。
            getLaneId: function () { return getLaneId(); },
            getLaneKey: function () { return getLaneId(); },
            // 消息编辑的 gather/读图/确认弹窗 await 窗口互斥——
            // submitUserInput 在此窗口内须直接拒绝（不入队：编辑截断会清空队列）
            getMsgActionBusy: function () { return _msgActionBusy; },
            // goal 续轮：派发锁释放后补一次评估（触发点见 createInputDispatch 的 finally）。
            // 用户消息轮收尾时锁仍被本派发器持有，driver 的空闲判据会拦下起轮；
            // 锁一放开在这里立刻补上——缺这一跳，目标是「active + 续轮已启用」却永不续轮。
            onDispatchEnd: function () { _kickGoalDriver('dispatch-end'); },
            // 入队 toast 文案按「待发送消息派发时机」（deferInjectUntilReply）切换，
            // 与 processToolLoop 轮首 drain 的判据同源
            getSettings: function () { return getSettings(); }
        });
        var apiActions = global.AEEngine.createApiActions({
            state: state,
            view: view,
            service: service,
            chatViewHelpers: chatViewHelpers,
            messageHelpers: messageHelpers,
            planTracking: planTracking,
            toolHistory: toolHistory,
            tokenStats: tokenStats,
            // apiActions 的统计读写（清空对话 / 渲染 / 切上下文）按本 lane 的存储走，
            // 跨 store 查找：sessionId 可能属于团队 lane store（后台结果在目标
            getTokenStats: function () { return _statsStore(); },
            scriptSessionStore: scriptSessionStore,
            agentSessionStore: agentSessionStore,
            shaderSessionStore: shaderSessionStore,
            // 跨 store 查找：sessionId 可能属于团队 lane store（后台结果在目标
            // lane runtime 不在时写回原会话）；bootstrap 注入「三档 + 已装配 lane」的唯一收集点。
            // 缺席（旧装配 / 单测桩）时退化为三条单 Agent store，既有语义逐字不变。
            getSessionStores: function () {
                if (typeof opts.getSessionStores === 'function') {
                    try {
                        var extra = opts.getSessionStores();
                        if (Array.isArray(extra) && extra.length) return extra;
                    } catch (_) { /* 提供者抛错：走三档兜底 */ }
                }
                return [scriptSessionStore, agentSessionStore, shaderSessionStore];
            },
            llmChannel: opts.llmChannel,
            getModel: function () { return opts.getModel ? opts.getModel() : ''; },
            getPlatform: function () { return opts.getPlatform ? opts.getPlatform() : ''; },
            getSettings: function () { return getSettings(); },
            resolveApiKeyForPlatform: resolveApiKeyForPlatform,
            getStopping: function () { return _stopping; },
            setStopping: function (v) { _stopping = v; },
            getInjectQueue: function () { return _injectQueue; },
            getDeferQueue: function () { return _deferQueue; },
            setForcedInjectText: function (v) { _forcedInjectText = v; },
            // 连续「立刻发送」：已有未消费的 forced 文本时换行合并而非覆盖，需先读现值
            getForcedInjectText: function () { return _forcedInjectText; },
            // sendInjectItem 两条路径（空闲直发/强制注入轮）回填视觉通道用
            setPendingImages: function (v) { _pendingImages = v; },
            // 连续「立刻发送」合并前读现有 pending 图（单槽覆盖会丢前条视觉通道）
            getPendingImages: function () { return _pendingImages; },
            setStopRequested: function (v) { stopRequested = v; },
            // 手动压缩阶段 3 前的停止复查需要读 stopRequested（压缩请求返回
            // 与停止动作竞态时不得改写 cm/落盘）
            getStopRequested: function () { return stopRequested; },
            getStopPromiseResolve: function () { return stopPromiseResolve; },
            setStopPromiseResolve: function (v) { stopPromiseResolve = v; },
            getActiveAbortController: function () { return activeAbortController; },
            setActiveAbortController: function (v) { activeAbortController = v; },
            setActivePlan: function (v) { activePlan = v; },
            getRunUserRequest: function () { return _runUserRequest; },
            setTurnOrigin: function (o) { _turnOrigin = o || 'system'; },
            // goal 暂停：requestStop 在「Goal Round 中用户点停止」时把目标转 paused
            getGoalApi: function () { return _goalApi; },
            // requestStop 无条件作废挂起的失败自动续轮定时器（见 apiActions.requestStop）：
            // stopAll 停隐藏 lane 时没有在途轮，仍须阻止 5s 定时器在停用后自行起轮。
            cancelGoalRetry: _cancelGoalRetry,
            // sendInjectItem 空闲分支的并发守卫：会话切换窗口内 addMessage 会写进
            // 半初始化新会话；submitUserInput 派发窗口（gather/自动压缩 await，busy
            // 未置位）内发起会与即将启动的 _runUserRequest 并发交错写状态。
            // 会话切换窗口（含团队 lane 的历史回读窗口 _adoptRestoring，见 adoptSession 头注）内
            // 一律拒发：addMessage 会写进半初始化/半载入的 cm，随后被 importMessages 覆盖丢失。
            getSwitching: function () { return _switching || _adoptRestoring > 0; },
            getDispatching: inputDispatch.getDispatching,
            // 编辑互斥窗口内注入结果入队、sendInjectItem 拒绝——
            // 窗口内直接注入会并发起第二个工具循环（对齐 E4 守卫链）。
            getMsgActionBusy: function () { return _msgActionBusy; },
            showStatus: opts.showStatus
        });

        // ── goal 门面与续轮驱动器 ────────────────────
        var _goalApi = _goalApiOf();
        // 驱动器依赖全部注入：其它 lane 忙闲 / 子 Agent 计数 / 会话一致性由 bootstrap 提供。
        // 没有任何判据在本文件与 driver 里各写一份。
        if (global.AEEngine && typeof global.AEEngine.createGoalDriver === 'function') {
            _goalDriver = global.AEEngine.createGoalDriver({
                goalApi: _goalApi,
                isSupported: _goalSupported,
                isRoundClean: function () { return _roundEndKind === 'clean'; },
                // goal 续轮只认「有意义的停止」：_stopping（停止清理窗口）或轮内在跑的
                // stopRequested。空闲残留的 stopRequested 不算——团队整队切换（stopAll 打空闲
                // lane）与用户空闲点停止都会留下这个标记，而它没有任何 loop/派发器会消费，
                // 若按字面判真，之后 /goal arm 会被永久判停（真机：团队新会话
                // 直接发 /goal 不起轮，goalEvaluate 返回 why:'stopped'）。
                // 注意：工具 handler 的停止归属仍用原始 stopRequested（不复用本判据）——
                // 「被停 runtime 自己的提交回 stopped」是另一条既有语义，不能被削弱。
                isStopped: function () { return !!(_stopping || (stopRequested && state.busy)); },
                getOtherLanesBusy: function () {
                    return !!(opts.getOtherLanesBusy && opts.getOtherLanesBusy());
                },
                getActiveSubagentCount: function () {
                    return (opts.getActiveSubagentCount ? (Number(opts.getActiveSubagentCount()) || 0) : 0);
                },
                // 起轮时刻的空闲判据（派发锁/轮内/切换窗口）。轮次消耗在注入之前，
                // 不空闲就不消耗——否则注入口会改成入队，轮次白耗且永不续轮。
                isIdle: _goalIdleNow,
                getSessionInfo: function () {
                    if (!(opts.isTeamMode && opts.isTeamMode())) return { ok: true };
                    var binder = (global.AEEngine && typeof global.AEEngine.getSessionBinder === 'function')
                        ? global.AEEngine.getSessionBinder() : null;
                    if (!binder) return { ok: false };
                    try {
                        if (typeof binder.getSwitching === 'function' && binder.getSwitching()) return { ok: false };
                        if (typeof binder.getBindingState === 'function') {
                            var st = binder.getBindingState();
                            if (st && st.consistent === false) return { ok: false };
                        }
                        var cur = binder.getCurrentSessionId ? (binder.getCurrentSessionId() || '') : '';
                        var ref = _goalStoreAndSid();
                        return { ok: !!cur && cur === ref.sid };
                    } catch (_e) { return { ok: false }; }
                },
                consumeRound: function () {
                    var G = _goalState();
                    if (!G) return { ok: false, code: 'GOAL_INVALID_ARGS', message: 'goalState 未加载' };
                    var res = G.consumeRound(_goal, { now: Date.now() });
                    if (!res || !res.ok) return res;
                    var applied = _applyGoalResult(res);
                    if (!applied || !applied.ok) return applied;
                    return { ok: true, round: res.round };
                },
                blockForLimit: function (goal) {
                    return _goalApi.block({ ref: goal.revision,
                        reason: 'round-limit: 已达 ' + goal.maxGoalRounds + ' 轮上限' });
                },
                injectGoalRound: function (text, round) {
                    var total = _goal ? _goal.maxGoalRounds : '?';
                    // 首次发目标不要系统卡，续轮才需要。
                    // 首轮把 <goal_round> 作为隐藏 user 消息注入（进 LLM 上下文、UI 不渲染），
                    // 仍经 bg-wake 唤起一轮；后续轮才落可见的「目标续轮 第 N/M 轮」卡，
                    // 让用户明白 Agent 为何自行开工。
                    if (round === 1) {
                        var hiddenOk = false;
                        try {
                            hiddenOk = apiActions.injectHiddenUserMessage(text, null, 'goal');
                        } catch (_e) { hiddenOk = false; }
                        if (hiddenOk) return { ok: true, hidden: true, round: round };
                    }
                    return apiActions.injectSystemResult(
                        GOAL_ROUND_TITLE_PREFIX + '第 ' + round + '/' + total + ' 轮',
                        { text: text }, null, 'user', null, 'goal');
                },
                warn: function (m) { console.warn('[Agent] ' + m); }
            });
        }

        // ── api 门面薄委托化 ──
        // 实体方法体已外提至 controller/apiActions.js（createApiActions）与
        // controller/inputDispatch.js（createInputDispatch.submitUserInput），
        // 此处只保留对外契约方法签名 + 一行委托；本文件不再含实体方法体。
        var api = {
            setModeByDebug: apiActions.setModeByDebug,
            clearConversation: apiActions.clearConversation,
            submitUserInput: inputDispatch.submitUserInput,
            requestStop: apiActions.requestStop,
            render: apiActions.render,
            switchContext: apiActions.switchContext,
            getActivePlan: function () { return activePlan; },
            clearReflectDrafts: apiActions.clearReflectDrafts,
            getContextTokenStats: apiActions.getContextTokenStats,
            estimateFixedOverhead: estimateFixedOverhead,
            compressContext: apiActions.compressContext,
            // 压缩失败原因 → 用户文案（唯一一份，见 apiActions.describeCompressFailure）：
            // 供 bootstrap 的用量条路径与 commands.js 的 /compress 共用
            describeCompressFailure: apiActions.describeCompressFailure,
            // 模式 → 当前轮工具模块身份的映射（纯函数，单一真源）。暴露给 bootstrap 的
            // 「当前选中」悬停浮层：它要按同一身份判定快照会不会进当前轮上下文。
            roundModuleId: roundModuleId,
            // lane 的工具身份集合与收窄判据（团队模式）。单 Agent 路径恒为 null/空，
            // 消费方据此判断「是否处于并联身份」——AE 快照的 laneKey 与工具的 moduleIds 是两回事。
            getModuleIds: getLaneModuleIds,
            // 收窄判据 = 闸口判定 ∧ extraFilter 的同一函数对象（不再是裸 lane filter）
            getToolFilter: getGateFilter,
            // 闸口实例与当前轮上下文（诊断/审计/测试读口；执行侧经 pipeline 拿到同一实例）
            getToolVisibility: getToolVisibility,
            // 当前轮闸口上下文（{ gate, viewId, extraFilter, filter, moduleLabel }）：
            // 投放后才有值（null = 尚未构建轮次工具集）。
            getVisibility: getVisibility,
            // 提示词可见性谓词（诊断/单测读口）：prompts.js 的裁剪与 lanes.js 的角色段共用同一判定
            getPromptToolVisible: _promptToolVisible,
            buildViewTools: buildViewTools,
            listToolViews: listToolViews,
            // 计划工具的三个处理器：**注册表是 last-wins**（三条 lane 各注册一次同名工具），
            // 所以 lane 形态注册的是「按 ctx.laneId 转发」的包装器，它要拿调用方那条 lane 的真实
            // 处理器 —— 装配侧（bootstrap）用本出口建 `getLanePlanHandlers`，见那里的注释。
            planApi: {
                trackSteps: planTracking.handleTrackSteps,
                getPlanStatus: planTracking.handleGetPlanStatus,
                updatePlan: planTracking.handleUpdatePlan
            },
            addUserMessage: apiActions.addUserMessage,
            injectSystemMessage: apiActions.injectSystemMessage,
            injectSystemResult: apiActions.injectSystemResult,
            addLocalMessage: apiActions.addLocalMessage,
            syncView: chatViewHelpers.syncView,
            isBusy: function () { return state.busy; },
            // 团队锁/切换预检需要的「切换/回读在途」出口：真值就是内部两个私有态
            //（teamUI.anyLaneLocked 与 sessionBinder 的 busy 预检都按能力探测读它们）。
            isSwitching: function () { return _switching || _adoptRestoring > 0; },
            getSwitching: function () { return _switching || _adoptRestoring > 0; },
            isStopping: function () { return _stopping; },
            getStopping: function () { return _stopping; },
            // ── 执行中追加消息队列（底部弹出框用）──
            getInjectQueue: apiActions.getInjectQueue,
            // 后台结果按 sessionId 写回原会话：目标 lane runtime 不在时由
            // bootstrap 门面先校验归属，再经这里用 uniform 的卡片形状原子追加（与跨会话分支同源）。
            appendToSession: apiActions.appendToSession,
            removeInjectItem: apiActions.removeInjectItem,
            clearInjectQueue: apiActions.clearInjectQueue,
            editInjectItem: apiActions.editInjectItem,
            sendInjectItem: apiActions.sendInjectItem,
            // 后台结果唤起：_runUserRequest 收尾处已自调；此处暴露供回归
            // 测试驱动「延后唤起」路径（如模块未挂载期间入队，挂载后补唤起）
            tryWakeBgResult: apiActions.tryWakeBgResult,
            // ── 多会话管理接口 ──
            switchSession: switchSession,
            // 团队模式的单 lane 会话落点（六步；binder 的默认切换动作 = 它）
            adoptSession: adoptSession,
            createSession: createSession,
            deleteSession: deleteSession,
            renameSession: renameSession,
            switchMode: switchMode,
            getActiveStore: chatViewHelpers.getActiveStore,
            getActiveCm: chatViewHelpers.getActiveCm,
            // plan 持久化：beforeunload / 模块卸载时调用以确保写盘完成
            flushPlan: function () { return planTracking.flushPlan(); },
            // token 统计持久化：beforeunload / 模块卸载时调用（取消待触发的防抖并立即落盘）。
            // 走 tokenStats 的统一规则——空记录不写盘、归属不符不写盘（调用方自己无条件写
            // 自己无条件写 stats.records||[]，正是把好数据清成空的路径之一）。
            flushTokenStats: function () { return tokenStats.flushCurrentTokenStats(); },
            // 消息编辑（hover 操作入口，view 经 setMessageActionHandlers 接入）
            editUserMessage: editUserMessage,
            // 工具执行入口（含权限闸门与静态校验）：供测试与命令层直接驱动
            executeToolCallForLlm: toolGating.executeToolCallForLlm,
            // 本 runtime 的工具 handler 绑定表（诊断/回归用）：
            // 可据此确认「执行者自己那份 handler」覆盖了哪些工具（与全局表 last-wins 的对照）。
            getRuntimeToolHandlers: function () { return runtimeToolHandlers; },
            // 轮次工具集构建（agent/shader 与 script 两个轮次入口共用同一实现）：
            // 供测试驱动「构建 → 轮次状态（stub 名单/投放清单/门控原因表）→ 执行侧闸门」全链
            buildRoundTools: _buildRoundTools,
            // goal：命令层 /goal、工具层、顶栏条与驱动器共用同一门面；
            // goalEvaluate 供 bootstrap 在「其它 lane 忙→闲」与外层时机补评估。
            goal: _goalApi,
            // 通道切换时由 bootstrap 调一次，抢回 goal 三工具的 last-wins（见 _registerGoalTools）
            goalRegisterTools: _registerGoalTools,
            goalEvaluate: function (reason) {
                return _goalDriver ? _goalDriver.evaluate(reason) : null;
            },
            getState: function () { return state; }
        };
        _api = api;
        return api;
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createController = createController;
})(window);
