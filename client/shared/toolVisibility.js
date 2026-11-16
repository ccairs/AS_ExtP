(function (global) {
    'use strict';
    // ── 工具可见性闸口（唯一决策模块）──────────────────────────
    // 面板内所有 Agent（单 Agent 三档 + 团队四条 lane + 子 Agent）的「某个工具对本视图是否可见」
    // 只由本模块判定：投放（gate.defsFor）、执行闸（gate.allReasons → roundGateReasons）、
    // tool_search（gate.fullDef / gate.names）、执行器复核（gate.allows，经 pipeline 下发授权）
    // 四处读同一份判定、同一个 filter 函数对象（gate.filterFor）。四处各写一份就是「看得见调不动」
    // 或「看不见能直调」（同源约束）。
    //
    // 本模块**无状态、无 DOM**：每次判定现算（设置与注册表都经注入 getter 取，运行期可变——
    // runtimeMode / 团队开关 / 保存设置下一轮即生效）。工厂依赖：
    //   getRegistry()                → toolRegistry（须有 filter-only 查询面）
    //   getSettings()                → 本 runtime 的设置（子 Agent = 派生时冻结快照）
    //   getLanes()                   → AEAgentTeam.lanes（只提供 lane 的 moduleIds / filter 展示）
    //   getLaneFilter(viewId)        → 该 lane 视图的收窄判据（生产 = lanes.js 里的同一个函数对象）
    //   isTeamMode()                 → 团队开关（决定单 Agent 的 Agent 视图是否剔 source==='team'）
    // 决策顺序（fail-closed）固定；原因码优先级：闸口原因优先于语义门控（toolGating 补空位）。

    var VIEW_IDS_FIXED = ['agent', 'script', 'shader'];
    var FIXED_IDENTITY = {
        agent: ['agent'],
        script: ['script'],
        shader: ['shader']
    };

    // 分类表：锁定工具（`VIEW_LOCKS` 是**唯一**名单，不写进各工具注册代码）。
    // views = 允许本工具出现的视图 id 集合；空数组 = 无面板视图（仅外接客户端可调，面板内恒不可见）。
    // 清单固定 33 件 = 锁定 24 件 + 多视图限定 8 件 + 单视图专属 1 件：
    //   · 机器可判的 24 件（team 6 / external 2 / Shader 7 / AE 执行族 9）由覆盖测试按注册表元数据核对；
    //   · 多视图限定 8 件（askUser / goal 3 / plan 3 / script_manager）靠测试内名单快照断言；
    //   · 单视图专属 1 件（panel_theme，只在 Agent 模式提供）。
    // 增删清单只改这里；改完跑分类覆盖测试。
    //
    // 文案契约：text / short 都是 zh-CN 源文（词典 key），本模块不做语言判断、不拼接、不解析文案。
    //   · text  = 完整原因，显示层（设置面板的 title 与提示）经 AEI18n.t(text) 取当前语言；
    //   · short = 徽标短句，显示层经 AEI18n.t(short) 取；只有短句与完整原因前缀不同的条目
    //     （AE 执行族的「仅特定视图可用」、外接专用固定句）需要单独写，其余与 text 去掉括注后的前缀一致。
    // 新增/修改条目只改字面量：scan-keys 按字面量收 key（tools/i18n/scan-keys.js 的 lockReasonKeys），
    // 显示层不做字符串切片或正则捕获，避免「翻译后不再命中中文形态」。
    function _lock(views, text, short) {
        return { views: views, text: text, short: short || text };
    }
    var VIEW_LOCKS = {
        // ── Shader 专属（7）：依赖 GLSL 预览区与宿主编译/效果库链 ──
        submit_shader: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖 GLSL 预览区与编译链）', '仅 Shader / Shader 执行可用'),
        get_current_shader: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖 GLSL 预览区）', '仅 Shader / Shader 执行可用'),
        getShaderPreview: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖 GLSL 预览区）', '仅 Shader / Shader 执行可用'),
        get_render_error: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖 GLSL 预览区）', '仅 Shader / Shader 执行可用'),
        shader_contract: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖 GLSL 契约文档）', '仅 Shader / Shader 执行可用'),
        shader_library: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖效果库）', '仅 Shader / Shader 执行可用'),
        submit_js_effect: _lock(['shader', 'glsl'], '仅 Shader / Shader 执行可用（依赖宿主编译/效果库链）', '仅 Shader / Shader 执行可用'),
        // ── 团队专属（6）：依赖团队名册 / 工作区 / lane 身份；无团队时 handler 明确失败 ──
        send_message: _lock(['director', 'ae-exec', 'glsl', 'asset-gen'], '仅团队 lane 可用（依赖团队名册与派单通道）', '仅团队 lane 可用'),
        list_agents: _lock(['director', 'ae-exec', 'glsl', 'asset-gen'], '仅团队 lane 可用（依赖团队名册）', '仅团队 lane 可用'),
        spawn_subagent: _lock(['director', 'ae-exec', 'glsl', 'asset-gen'], '仅团队 lane 可用（依赖子 Agent 池）', '仅团队 lane 可用'),
        read_workspace: _lock(['director', 'ae-exec', 'glsl', 'asset-gen'], '仅团队 lane 可用（依赖团队工作区）', '仅团队 lane 可用'),
        write_workspace: _lock(['director', 'ae-exec', 'glsl', 'asset-gen'], '仅团队 lane 可用（依赖团队工作区）', '仅团队 lane 可用'),
        updateTeamTasks: _lock(['director', 'ae-exec', 'glsl', 'asset-gen'], '仅团队 lane 可用（依赖团队任务清单）', '仅团队 lane 可用'),
        // ── 外接专用（2）：只对外接客户端提供，面板内不可见 ──
        guide: _lock([], '仅外接客户端可用，面板内不可见', '仅外接客户端可用，面板内不可见'),
        ext_task_get: _lock([], '仅外接客户端可用，面板内不可见', '仅外接客户端可用，面板内不可见'),
        // ── AE 执行族（9，对 Script 锁定）：Script 模式只产出代码、不直接操作 AE ──
        executeExtendScript: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        undoLastOperation: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        importFile: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        replaceFootage: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        saveProject: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        renderComp: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        createAETool: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        deleteAETool: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        shader_params: _lock(['agent', 'shader', 'director', 'ae-exec', 'glsl', 'asset-gen'], 'Script 视图不可用（Script 模式只产出代码，不直接操作 AE）', '仅特定视图可用'),
        // ── 多视图限定（8）：依赖面板，只在有对应面板面的视图可见 ──
        askUser: _lock(['agent', 'script', 'shader', 'director'], '仅 Agent / Script / Shader / 导演可用（依赖输入区问答面板）', '仅 Agent / Script / Shader / 导演可用'),
        // goal 三件放开到 Script/Shader 档（三档共用同一顶栏目标条与目标驱动器；
        // Script 档的续轮落点同批补上，见 controller._goalSupported）。
        get_goal: _lock(['agent', 'script', 'shader', 'director'], '仅 Agent / Script / Shader / 导演可用（依赖顶栏目标条与目标驱动器）', '仅 Agent / Script / Shader / 导演可用'),
        create_goal: _lock(['agent', 'script', 'shader', 'director'], '仅 Agent / Script / Shader / 导演可用（依赖顶栏目标条与目标驱动器）', '仅 Agent / Script / Shader / 导演可用'),
        update_goal: _lock(['agent', 'script', 'shader', 'director'], '仅 Agent / Script / Shader / 导演可用（依赖顶栏目标条与目标驱动器）', '仅 Agent / Script / Shader / 导演可用'),
        trackSteps: _lock(['agent', 'director', 'ae-exec', 'glsl', 'asset-gen'], '仅 Agent 与团队 lane 可用（依赖侧栏计划树）', '仅 Agent 与团队 lane 可用'),
        getPlanStatus: _lock(['agent', 'director', 'ae-exec', 'glsl', 'asset-gen'], '仅 Agent 与团队 lane 可用（依赖侧栏计划树）', '仅 Agent 与团队 lane 可用'),
        updatePlan: _lock(['agent', 'director', 'ae-exec', 'glsl', 'asset-gen'], '仅 Agent 与团队 lane 可用（依赖侧栏计划树）', '仅 Agent 与团队 lane 可用'),
        script_manager: _lock(['script'], '仅 Script 可用（依赖脚本树）', '仅 Script 可用'),
        // ── 单视图专属（1）：面板主题工具只属于 Agent 模式 ──
        panel_theme: _lock(['agent'], '仅 Agent 可用（面板主题工具只在 Agent 模式提供）', '仅 Agent 可用')
    };

    // 原因码：闸口只产出这四种；enabled=false 走 toolExecutor 的 ACCESS_DENIED（不进本表）
    var REASON = {
        VIEW_LOCKED: 'VIEW_LOCKED',
        USER_DISABLED: 'USER_DISABLED',
        NOT_IN_VIEW: 'NOT_IN_VIEW',
        LANE_TOOL_DENIED: 'LANE_TOOL_DENIED',
        DEPENDENCY_HIDDEN: 'DEPENDENCY_HIDDEN'
    };

    function _copy(arr) {
        var out = [];
        for (var i = 0; i < arr.length; i++) out.push(arr[i]);
        return out;
    }

    function createToolVisibility(deps) {
        deps = deps || {};
        var getRegistry = (typeof deps.getRegistry === 'function') ? deps.getRegistry : function () { return null; };
        var getSettings = (typeof deps.getSettings === 'function') ? deps.getSettings : function () { return null; };
        var getLanes = (typeof deps.getLanes === 'function') ? deps.getLanes : function () { return null; };
        var getLaneFilter = (typeof deps.getLaneFilter === 'function') ? deps.getLaneFilter : null;
        var isTeamMode = (typeof deps.isTeamMode === 'function') ? deps.isTeamMode : function () { return false; };

        // 告警去重：依赖缺失是配置/装配错误，同一视图只报一次（不刷日志、不静默）
        var _warned = Object.create(null);
        function _warnOnce(key, msg) {
            if (_warned[key]) return;
            _warned[key] = true;
            try { console.warn('[ToolVisibility] ' + msg); } catch (_) { /* 诊断失败不影响判定 */ }
        }

        function _registry() {
            try { return getRegistry() || null; } catch (_) { return null; }
        }

        // ── 视图枚举与身份 ────────────────────────────────────────────────────
        function _laneList() {
            try {
                var lanes = getLanes && getLanes();
                if (lanes && typeof lanes.list === 'function') {
                    var list = lanes.list() || [];
                    return Array.isArray(list) ? list : [];
                }
            } catch (_) { /* fall through */ }
            return [];
        }

        function _laneDef(viewId) {
            try {
                var lanes = getLanes && getLanes();
                if (lanes && typeof lanes.get === 'function') return lanes.get(viewId) || null;
            } catch (_) { /* fall through */ }
            return null;
        }

        function views() {
            var out = VIEW_IDS_FIXED.slice();
            var lanes = _laneList();
            for (var i = 0; i < lanes.length; i++) {
                var id = lanes[i] && lanes[i].id;
                if (typeof id === 'string' && id && out.indexOf(id) < 0) out.push(id);
            }
            return out;
        }

        function isLaneView(viewId) {
            if (!viewId || VIEW_IDS_FIXED.indexOf(viewId) >= 0) return false;
            return true;
        }

        function identityOf(viewId) {
            if (FIXED_IDENTITY[viewId]) return { moduleIds: FIXED_IDENTITY[viewId].slice() };
            var def = _laneDef(viewId);
            if (def && Array.isArray(def.moduleIds) && def.moduleIds.length) {
                return { moduleIds: def.moduleIds.slice() };
            }
            // 未知视图：fail-closed（空身份 = 什么都不匹配），不静默回落 agent
            _warnOnce('identity:' + viewId, '视图 "' + viewId + '" 的身份集合取不到（lanes.get 缺席或是未知键）：按 fail-closed 处理');
            return { moduleIds: [] };
        }

        // ── 设置读取（运行时只认已保存设置；缺段/非法一律视为空配置）────────────
        function _viewCfg(viewId) {
            var tv = null;
            try {
                var s = getSettings();
                tv = (s && s.toolVisibility) || null;
            } catch (_) { tv = null; }
            var viewsCfg = (tv && tv.views) || null;
            var seg = (viewsCfg && viewsCfg[viewId]) || null;
            var disabled = (seg && Array.isArray(seg.disabled)) ? seg.disabled : [];
            var enabled = (seg && Array.isArray(seg.enabled)) ? seg.enabled : [];
            return { disabled: _toSet(disabled), enabled: _toSet(enabled) };
        }

        function _toSet(list) {
            var set = Object.create(null);
            for (var i = 0; i < list.length; i++) {
                if (typeof list[i] === 'string' && list[i]) set[list[i]] = true;
            }
            return set;
        }

        // ── 默认判定（defaultVisible）─────────────────────────────────────────
        function _scopeIncludesAny(entry, ids) {
            if (!entry) return false;
            var scope = entry.scope;
            // 注册表条目恒有 scope（parseScope 缺省 global）；测试桩/旧条目缺字段按 global 语义处理
            if (!scope || scope.type === 'global') return true;
            if (scope.type !== 'module') return false;
            var scoped = (Array.isArray(scope.moduleIds) && scope.moduleIds.length)
                ? scope.moduleIds
                : (scope.moduleId ? [scope.moduleId] : []);
            for (var i = 0; i < scoped.length; i++) {
                if (ids.indexOf(scoped[i]) >= 0) return true;
            }
            return false;
        }

        // lane 视图的收窄判据来源：注入的 getLaneFilter（生产 = lanes.js 同一个函数对象）。
        // 返回值语义：函数 = 收窄判据；null = 该视图明确「无收窄」；undefined = 依赖取不到（fail-closed）。
        function _laneFilterOf(viewId) {
            if (!isLaneView(viewId)) return null;
            if (typeof getLaneFilter !== 'function') {
                _warnOnce('nolanefilter:' + viewId, 'lane 视图 "' + viewId + '" 的收窄判据来源缺席（getLaneFilter 未注入）：fail-closed');
                return undefined;
            }
            var f;
            try { f = getLaneFilter(viewId); } catch (_) { f = undefined; }
            if (f === undefined) {
                _warnOnce('lanefilter:' + viewId, 'lane 视图 "' + viewId + '" 的收窄判据取不到：按 fail-closed 处理');
            }
            return f;
        }

        function _moduleDisabledForView(entry, ids) {
            var reg = _registry();
            if (!reg || !entry || !Array.isArray(ids) || !ids.length) return false;
            try {
                if (typeof reg.isModuleDisabledAnywhere === 'function') {
                    return !!reg.isModuleDisabledAnywhere(entry.name, ids);
                }
                if (typeof reg.isModuleDisabled === 'function') {
                    for (var i = 0; i < ids.length; i++) {
                        if (reg.isModuleDisabled(entry.name, ids[i])) return true;
                    }
                }
            } catch (_) { /* 判不出来按未禁用（enabled 仍由执行器查） */ }
            return false;
        }

        function defaultVisible(viewId, entry) {
            if (!entry) return false;
            var ids = identityOf(viewId).moduleIds;
            // 身份集合取不到（未知视图 / lanes 依赖缺席）⇒ fail-closed：连 global 工具也不放行。
            // lane 默认判据依赖取不到时不得回落成「不过滤」。
            if (!ids.length) return false;
            if (!_scopeIncludesAny(entry, ids)) return false;
            // 模块级停用（AE 工具抽屉按模块关掉）沿用现状：投放侧不出现（执行侧另有 ACCESS_DENIED）
            if (_moduleDisabledForView(entry, ids)) return false;
            if (isLaneView(viewId)) {
                var f = _laneFilterOf(viewId);
                if (f === undefined) return false;                  // 取不到 → fail-closed；null = 该视图显式无收窄
                if (typeof f === 'function' && !f(entry)) return false;
            }
            // 单 Agent 的 Agent 视图在团队关闭时剔除团队来源（现状 _standaloneTeamFilter）
            if (viewId === 'agent' && !_teamMode() && entry.source === 'team') return false;
            return true;
        }

        function _defaultReason(viewId, entry) {
            var ids = identityOf(viewId).moduleIds;
            if (!ids.length) return REASON.NOT_IN_VIEW;           // 身份取不到：fail-closed（同上）
            if (!_scopeIncludesAny(entry, ids)) return REASON.NOT_IN_VIEW;
            // 团队关闭时 Agent 视图的团队来源剔除与 lane 收窄同码（既有断言 LANE_TOOL_DENIED 不漂）
            if (viewId === 'agent' && !_teamMode() && entry.source === 'team') return REASON.LANE_TOOL_DENIED;
            if (isLaneView(viewId)) {
                var f = _laneFilterOf(viewId);
                if (f === undefined || (typeof f === 'function' && !f(entry))) return REASON.LANE_TOOL_DENIED;
            }
            return REASON.NOT_IN_VIEW;
        }

        function _teamMode() {
            try { return !!isTeamMode(); } catch (_) { return false; }
        }

        // ── 分类表 ────────────────────────────────────────────────────────────
        function _lockDef(name) {
            return (typeof name === 'string' && VIEW_LOCKS[name]) ? VIEW_LOCKS[name] : null;
        }

        function lockInfo(viewId, name) {
            var def = _lockDef(name);
            if (!def) return { locked: false, reason: '', short: '' };
            if (def.views.indexOf(viewId) >= 0) return { locked: false, reason: '', short: '' };
            return { locked: true, reason: def.text, short: def.short };
        }

        function _lockedOut(viewId, name) {
            return lockInfo(viewId, name).locked;
        }

        // ── 依赖联动：tool_search 关闭时本视图 stub 工具自动不可见 ─────────
        // 判据必须与本视图的 tool_search **有效可见性**同源：
        // 只看 registry.enabled + 用户 disabled 会漏掉 lane filter / scope / 分类锁 / extraFilter，
        // 将来 tool_search 被收窄时会出现「stub 仍注入而前置工具不可见」；直接复用 _decide。
        function _toolSearchAvailable(viewId) {
            var reg = _registry();
            var entry = null;
            try { entry = (reg && typeof reg.get === 'function') ? reg.get('tool_search') : null; } catch (_) { entry = null; }
            if (!entry) return true;                       // 注册表尚未装配：不误伤（enabled 由执行器查）
            return _decide(viewId, entry).allow;
        }

        // ── 决策（唯一判定入口）────────────────────────────────────────
        function _decide(viewId, entry, extraFilter) {
            if (!entry || typeof entry.name !== 'string' || !entry.name) {
                return { allow: false, reason: null };
            }
            // 1. 全局停用：直调由 toolExecutor.checkAccess 的 enabled 检查拒（ACCESS_DENIED），不进 gateReasons
            if (entry.enabled === false) return { allow: false, reason: null };
            var cfg = _viewCfg(viewId);
            // 2. 用户在本视图关闭
            if (cfg.disabled[entry.name]) return { allow: false, reason: REASON.USER_DISABLED };
            // 3. 默认判定
            var defaultOk = defaultVisible(viewId, entry);
            var defaultReason = defaultOk ? null : _defaultReason(viewId, entry);
            // 4. 分类表锁定（锁在用户 enabled 之前：放宽越不过分类表）
            if (_lockedOut(viewId, entry.name)) {
                return { allow: false, reason: defaultReason || REASON.VIEW_LOCKED };
            }
            // 5. 依赖联动：stub 且它**本来可见/被用户放宽**、而 tool_search 不可见 → 前置工具缺席。
            //    只对本可注入的 stub 记 DEPENDENCY_HIDDEN，否则会把
            //    「本视图根本不可见」的 stub 的原因码从 NOT_IN_VIEW/LANE_TOOL_DENIED 盖掉（审计噪音）。
            var _widened = cfg.enabled[entry.name] === true;
            if (entry.stub === true && (defaultOk || _widened) && !_toolSearchAvailable(viewId)) {
                return { allow: false, reason: REASON.DEPENDENCY_HIDDEN };
            }
            // 6. 用户 enabled 在默认判定之后生效（可放宽 scope 与 lane 默认策略）。
            //    但模块级停用是全局状态：用户放宽不能把它「捞回来」（
            //    否则投放会注入、执行器仍按 isModuleDisabledAnywhere 拒 →「看得见调不动」）。
            if (_widened && _moduleDisabledForView(entry, identityOf(viewId).moduleIds)) _widened = false;
            var ok = _widened ? true : defaultOk;
            // 7. 子 Agent 剔除判据（只收窄、不放宽；为假沿用 LANE_TOOL_DENIED）
            if (typeof extraFilter === 'function' && !extraFilter(entry)) {
                return { allow: false, reason: REASON.LANE_TOOL_DENIED };
            }
            return ok ? { allow: true, reason: null } : { allow: false, reason: defaultReason };
        }

        function allows(viewId, entry, extraFilter) {
            return _decide(viewId, entry, extraFilter).allow;
        }

        function reason(viewId, entry, extraFilter) {
            return _decide(viewId, entry, extraFilter).reason;
        }

        // filterFor 是**唯一 filter 构造函数**：投放 / 执行闸 / tool_search / 执行器复核共用同一对象。
        // 同一 (view, extraFilter) 复用缓存（判据内部现算设置与注册表，缓存不会过期）。
        var _filterCache = [];
        function filterFor(viewId, extraFilter) {
            var ef = (typeof extraFilter === 'function') ? extraFilter : null;
            for (var i = 0; i < _filterCache.length; i++) {
                var c = _filterCache[i];
                if (c.view === viewId && c.extra === ef) return c.fn;
            }
            var fn = function (entry) { return _decide(viewId, entry, ef).allow; };
            _filterCache.push({ view: viewId, extra: ef, fn: fn });
            return fn;
        }

        // ── 条目源（不过滤全集：含不可见 / 锁定 / 停用项）─────────────────────
        function _allEntries() {
            var reg = _registry();
            if (!reg) return [];
            try {
                if (typeof reg.getEntriesByFilter === 'function') {
                    var list = reg.getEntriesByFilter();
                    return Array.isArray(list) ? list : [];
                }
                if (typeof reg.getAll === 'function') {
                    var all = reg.getAll();
                    return Array.isArray(all) ? all : [];
                }
            } catch (_) { /* fall through */ }
            return [];
        }

        function _entriesPassing(viewId, extraFilter) {
            var all = _allEntries();
            var out = [];
            for (var i = 0; i < all.length; i++) {
                if (allows(viewId, all[i], extraFilter)) out.push(all[i]);
            }
            return out;
        }

        function _moduleLabelOf(viewId) {
            var ids = identityOf(viewId).moduleIds;
            return ids.length ? ids[0] : '';
        }

        // ── 对外查询面 ────────────────────────────────────────────────────
        // defsFor：生产注册表走 filter-only 装配面（支持放宽到 scope 之外）；旧注册表/测试桩
        // 没有该面时退回旧装配入口（scope 先行 + filter，放宽不可用）——保持既有调用方语义，
        // 但判定仍由闸口 filter 决定（不形成第二套可见性真相源）。
        function defsFor(viewId, extraFilter) {
            var reg = _registry();
            var filter = filterFor(viewId, extraFilter);
            var ids = identityOf(viewId).moduleIds;
            if (reg && typeof reg.getLlmToolDefsByFilter === 'function') {
                return reg.getLlmToolDefsByFilter(filter, _moduleLabelOf(viewId));
            }
            if (reg && typeof reg.getLlmToolDefsFor === 'function') {
                return reg.getLlmToolDefsFor(ids.length ? ids : [''], filter);
            }
            if (reg && typeof reg.getLlmToolStubs === 'function') {
                _warnOnce('defs-legacy:' + viewId, '注册表缺 filter-only 装配面：按旧装配入口投放（不支持放宽）');
                return reg.getLlmToolStubs(ids.length ? ids[0] : '');
            }
            _warnOnce('defs:' + viewId, '注册表缺装配面（getLlmToolDefsByFilter / getLlmToolDefsFor 均缺席）：本视图不投放工具');
            return [];
        }

        function names(viewId, extraFilter) {
            var list = _entriesPassing(viewId, extraFilter);
            var out = [];
            for (var i = 0; i < list.length; i++) out.push(list[i].name);
            return out;
        }

        function fullDef(viewId, name, extraFilter) {
            var reg = _registry();
            if (!reg) return null;
            var entry = null;
            try { entry = (typeof reg.get === 'function') ? reg.get(name) : null; } catch (_) { entry = null; }
            if (!entry) return null;
            if (!allows(viewId, entry, extraFilter)) return null;
            var filter = filterFor(viewId, extraFilter);
            var ids = identityOf(viewId).moduleIds;
            if (typeof reg.getToolFullDefByFilter === 'function') {
                return reg.getToolFullDefByFilter(name, filter, _moduleLabelOf(viewId));
            }
            // 旧注册表兜底（与 defsFor 同口径）
            if (typeof reg.getToolFullDefFor === 'function') {
                return reg.getToolFullDefFor(name, ids.length ? ids : [''], filter);
            }
            if (typeof reg.getToolFullDef === 'function') {
                return reg.getToolFullDef(name, ids.length ? ids[0] : '');
            }
            return null;
        }

        // UI 用全量条目（不过滤全集 + 闸口状态合成）。extraFilter 为可选扩展：
        // tool_search 的「当前可用工具/分组」提示要按子 Agent 的剔除去重。
        function entriesFor(viewId, extraFilter) {
            var ef = (typeof extraFilter === 'function') ? extraFilter : null;
            var all = _allEntries();
            var out = [];
            for (var i = 0; i < all.length; i++) {
                var e = all[i];
                var st = _decide(viewId, e, ef);
                var lk = lockInfo(viewId, e.name);
                out.push({
                    name: e.name,
                    source: e.source || '',
                    category: e.category || 'general',
                    stub: e.stub === true,
                    defaultVisible: defaultVisible(viewId, e),
                    locked: lk.locked,
                    lockedReason: lk.reason,
                    lockedShort: lk.short,
                    disabled: e.enabled === false,
                    reason: st.reason
                });
            }
            return out;
        }

        function allReasons(viewId, extraFilter) {
            var all = _allEntries();
            var out = Object.create(null);
            for (var i = 0; i < all.length; i++) {
                var e = all[i];
                if (!e || typeof e.name !== 'string' || !e.name) continue;
                var r = _decide(viewId, e, extraFilter).reason;
                if (r) out[e.name] = r;
            }
            return out;
        }

        return {
            VIEW_IDS_FIXED: VIEW_IDS_FIXED.slice(),
            REASON: REASON,
            views: views,
            identityOf: identityOf,
            allows: allows,
            reason: reason,
            defsFor: defsFor,
            names: names,
            fullDef: fullDef,
            entriesFor: entriesFor,
            allReasons: allReasons,
            filterFor: filterFor,
            defaultVisible: defaultVisible,
            lockInfo: lockInfo,
            isLaneView: isLaneView
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createToolVisibility = createToolVisibility;
    global.AE_LLM.TOOL_VISIBILITY_REASONS = REASON;

})(typeof window !== 'undefined' ? window : globalThis);
