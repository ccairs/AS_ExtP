(function(global) {

    var JSON_RPC_ERRORS = {
        PARSE_ERROR: -32700,
        INVALID_REQUEST: -32600,
        METHOD_NOT_FOUND: -32601,
        INVALID_PARAMS: -32602,
        INTERNAL_ERROR: -32603,
        TOOL_NOT_FOUND: -32001,
        TOOL_EXECUTION_ERROR: -32002,
        ACCESS_DENIED: -32003
    };

    // 保留名禁止注册为工具名。
    // 恶意 MCP server 若广告名为 __proto__ 的工具，tools['__proto__']=entry 会篡改
    // 注册表原型（管理 UI 隐身但 get() 可命中执行）。配合 null-prototype 表双重防护。
    var RESERVED_TOOL_NAMES = Object.create(null);
    (function() {
        var names = ['__proto__', 'prototype', 'constructor', 'hasOwnProperty',
            'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'toLocaleString', 'valueOf'];
        for (var i = 0; i < names.length; i++) RESERVED_TOOL_NAMES[names[i]] = true;
    })();

    // 注入 LLM 的 stub 工具数量上限：上万个自定义 AE 工具默认全注入会撑爆 prompt。
    // 超出上限的 stub 工具不再进入 tools 参数，但仍可通过 tool_search 按 name/category 获取完整定义。
    var LLM_MAX_STUB_TOOLS = 200;

    // 核心工具白名单：无论是否 stub，始终完整注入、不占上限名额。
    // 这些是 Agent 运行必需的关键工具（执行/撤销/搜索/读取），被裁会导致功能瘫痪。
    // 其余工具（stub 或非 stub）统一合并计数，超过 LLM_MAX_STUB_TOOLS 则跳过（仍可经 tool_search 取回）。
    var CORE_TOOL_NAMES = Object.create(null);
    (function() {
        var names = [
            'executeExtendScript', 'undoLastOperation', 'tool_search', 'queryAeApi',
            'submit_script', 'get_current_script',
            'queryProject', 'queryDetails',
            'memory_read', 'memory_search',
            'readFile', 'writeFile', 'read_image', 'read_video', 'getPreviewFrame'
        ];
        for (var i = 0; i < names.length; i++) CORE_TOOL_NAMES[names[i]] = true;
    })();

    function createToolRegistry() {
        // null-prototype 对象：'__proto__' 赋值变为普通自有属性，不再污染原型
        var tools = Object.create(null);
        var _disabledModules = Object.create(null);

        function validateToolId(name) {
            if (typeof name !== 'string' || name.length === 0 || name.length > 128) return false;
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) return false;
            if (RESERVED_TOOL_NAMES[name]) return false;
            return true;
        }

        function register(toolDef) {
            if (!toolDef || !toolDef.name) return { ok: false, error: 'MISSING_NAME' };
            if (!validateToolId(toolDef.name)) return { ok: false, error: 'INVALID_NAME_FORMAT', detail: 'Must be alphanumeric with underscores, max 128 chars, and not a reserved name' };
            if (typeof toolDef.description !== 'string' || toolDef.description.length === 0) {
                return { ok: false, error: 'MISSING_DESCRIPTION' };
            }
            if (typeof toolDef.handler !== 'function') {
                return { ok: false, error: 'MISSING_HANDLER' };
            }

            var scope = parseScope(toolDef.scope);
            var entry = {
                name: toolDef.name,
                description: toolDef.description,
                shortDescription: typeof toolDef.shortDescription === 'string' ? toolDef.shortDescription : '',
                input_schema: toolDef.input_schema || { type: 'object', properties: {} },
                handler: toolDef.handler,
                source: toolDef.source || null,
                scope: scope,
                serverId: toolDef.serverId || null,
                moduleId: toolDef.moduleId || null,
                category: toolDef.category || 'general',
                enabled: toolDef.enabled !== false,
                stub: toolDef.stub === true,
                // 只读标记：lane 收窄的元数据判据是「source==='ae-tools' && readOnly!==true
                // 即剔除」，故五条注册路径都必须写入**显式布尔值**；serialize/deserialize/updateTool
                // 三处同步，否则序化一轮即丢（丢后判据退化成"全部当作可写"或"全部当作只读"）。
                readOnly: toolDef.readOnly === true,
                // 可选：按调用模块动态生成 LLM 可见描述（如 Skill 工具按模块列出可用技能），
                // 避免模块级资源名泄漏进其他模块共享的静态描述
                buildDescription: typeof toolDef.buildDescription === 'function' ? toolDef.buildDescription : null,
                installedAt: toolDef.installedAt || Date.now(),
                updatedAt: toolDef.updatedAt || Date.now()
            };

            tools[toolDef.name] = entry;

            if (!_disabledModules[toolDef.name]) {
                _disabledModules[toolDef.name] = Object.create(null);
            }

            return { ok: true, entry: entry };
        }

        function unregister(toolName) {
            if (!tools[toolName]) return { ok: false, error: 'NOT_FOUND' };
            delete tools[toolName];
            delete _disabledModules[toolName];
            return { ok: true };
        }

        function get(toolName) {
            return tools[toolName] || null;
        }

        function getAll() {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                list.push(tools[keys[i]]);
            }
            return list;
        }

        function getEnabledForModule(moduleId) {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var tool = tools[keys[i]];
                if (!tool.enabled) continue;
                if (!isAccessibleByModule(tool, moduleId)) continue;
                if (isModuleDisabled(tool.name, moduleId)) continue;
                list.push(tool);
            }
            return list;
        }

        function getLlmToolDefinitions(moduleId) {
            var enabled = getEnabledForModule(moduleId || '');
            var defs = [];
            for (var i = 0; i < enabled.length; i++) {
                var tool = enabled[i];
                var def = {
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: (typeof tool.buildDescription === 'function')
                            ? tool.buildDescription(moduleId || '')
                            : tool.description,
                        parameters: tool.input_schema
                    },
                    _source: tool.source || ''
                };
                defs.push(def);
            }
            return defs;
        }

        // 按需加载：核心工具（白名单）始终完整注入、不占名额；
        // 其余工具（stub 或非 stub）统一合并计数，超过上限跳过（仍可经 tool_search 取回）。
        // 完整定义（非 stub）工具优先注入，stub 工具用剩余名额——避免完整定义工具被 stub 挤掉。
        // stub 工具返回轻量定义（仅 name + 简短 desc + 空 schema），非 stub 工具返回完整定义。
        // stub 状态由各工具定义的 stub 字段逐工具控制（register 时写入）。
        function _assembleStubDefs(enabled, moduleLabel) {
            var defs = [];
            var count = 0;
            var limit = (LLM_MAX_STUB_TOOLS > 0) ? LLM_MAX_STUB_TOOLS : Infinity;
            // 第一遍：非 stub 工具（完整定义）——核心不占名额，非核心占名额
            for (var i = 0; i < enabled.length; i++) {
                var tool = enabled[i];
                if (tool.stub === true) continue;
                var isCore = CORE_TOOL_NAMES[tool.name] === true;
                if (!isCore && count >= limit) continue;
                if (!isCore) count++;
                defs.push({
                    type: 'function',
                    function: {
                        name: tool.name,
                        description: (typeof tool.buildDescription === 'function')
                            ? tool.buildDescription(moduleLabel || '')
                            : tool.description,
                        parameters: tool.input_schema
                    },
                    _source: tool.source || ''
                });
            }
            // 第二遍：stub 工具（轻量定义）——核心不占名额，非核心占剩余名额
            for (var j = 0; j < enabled.length; j++) {
                var st = enabled[j];
                if (st.stub !== true) continue;
                var isCoreSt = CORE_TOOL_NAMES[st.name] === true;
                if (!isCoreSt && count >= limit) continue;
                if (!isCoreSt) count++;
                var src = st.source || '';
                // stub：优先用 shortDescription（专为 stub 设计的简短描述，不再截断），
                // 回退到 description 截断到 60 字符。
                var stubDesc = '';
                if (st.shortDescription) {
                    stubDesc = st.shortDescription;
                } else if (st.description) {
                    stubDesc = st.description.length > 60
                        ? st.description.substring(0, 60)
                        : st.description;
                }
                // 「有参数 → 打 [stub] 标记 + 需先 tool_search」由**同一判据**派生，
                // 执行侧闸门（controller._buildRoundTools 的 _stubToolNames）读的就是这里
                // 写出的 _needsToolSearch。无参数工具没有 schema 可猜：不打标记，也免闸门
                // 直调——两边若各写一套判据，就会出现「描述没标 stub、直调却被闸门拒」的
                // 矛盾（comfyui_list_checkpoints 实例）。
                var hasParams = st.input_schema && st.input_schema.properties
                    && Object.keys(st.input_schema.properties).length > 0;
                if (hasParams) stubDesc += ' [stub]';
                defs.push({
                    type: 'function',
                    function: {
                        name: st.name,
                        description: stubDesc,
                        parameters: { type: 'object', properties: {} }
                    },
                    _source: src,
                    _isStub: true,
                    _needsToolSearch: !!hasParams
                });
            }
            return defs;
        }

        function getLlmToolStubs(moduleId) {
            return _assembleStubDefs(getEnabledForModule(moduleId || ''), moduleId || '');
        }

        // ── 工具身份并联与收窄（团队 lane）─────────────────────────
        // lane 的工具身份是**集合**（如 ['agent','team']）：可见性取并集（按工具名去重，
        // tools 以名称为键，遍历即天然去重）。filter 是**收窄判据**，入参为注册表条目
        // （含 name/source/readOnly），返回 false 即剔除。
        //
        // 「任一成员模块禁用即不可用」（fail-closed，方向与可见性的并集相反）：用户在
        // 某模块抽屉里关掉一个工具，是想在该模块语境下不再用它；lane 的成员集合里只要
        // 有一个模块关了它，就不能借另一个成员模块把它"捞回来"。
        //
        // 收窄必须与投放侧（toolGating）和执行侧（toolExecutionPipeline 的轮次闸）同判据：
        // 只在投放侧过滤时，模型可以用 tool_search 取回定义再按名直调（既有漏洞形态）。
        function _asModuleIds(moduleIds) {
            if (Array.isArray(moduleIds)) {
                var out = [];
                for (var i = 0; i < moduleIds.length; i++) {
                    // 保留空串：旧口径里 moduleId='' 是「无模块身份」的合法值（getLlmToolStubs('')
                    // 会给出 global 工具），不能在归一化阶段被丢掉——丢了会让新旧入口对同一输入
                    // 给出不同结果（'' 归零 = 该 lane 一个工具都拿不到，且静默）。
                    if (typeof moduleIds[i] === 'string') out.push(moduleIds[i]);
                }
                return out;
            }
            return (typeof moduleIds === 'string') ? [moduleIds] : [];
        }

        function scopeIncludesAny(tool, moduleIds) {
            var ids = _asModuleIds(moduleIds);
            for (var i = 0; i < ids.length; i++) {
                if (scopeIncludesModule(tool, ids[i])) return true;
            }
            return false;
        }

        function isModuleDisabledAnywhere(toolName, moduleIds) {
            var ids = _asModuleIds(moduleIds);
            for (var i = 0; i < ids.length; i++) {
                if (isModuleDisabled(toolName, ids[i])) return true;
            }
            return false;
        }

        function getEnabledForModules(moduleIds) {
            var ids = _asModuleIds(moduleIds);
            var list = [];
            if (!ids.length) return list;
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var tool = tools[keys[i]];
                if (!tool.enabled) continue;
                if (!scopeIncludesAny(tool, ids)) continue;
                if (isModuleDisabledAnywhere(tool.name, ids)) continue;
                list.push(tool);
            }
            return list;
        }

        // 并联投放：等价于 getLlmToolStubs，但作用域取 moduleIds 并集，并可施加收窄判据。
        // 收窄必须在**装配之前**：_assembleStubDefs 按上限记账，先装配后过滤会让
        // 被收窄的工具白占名额，症状是"该 lane 的工具静默消失"，且结果取决于工具注册顺序。
        // 空集合/缺省与旧入口对齐：'无模块身份' 取 [''] （= 仅 global 工具），而不是"谁都不给"。
        function getLlmToolDefsFor(moduleIds, filter) {
            var ids = _asModuleIds(moduleIds);
            if (!ids.length) ids = [''];
            var enabled = getEnabledForModules(ids);
            if (typeof filter === 'function') {
                enabled = enabled.filter(function (t) { return !!filter(t); });
            }
            return _assembleStubDefs(enabled, ids[0] || '');
        }

        // tool_search 的并联版本：集合可见性 + 收窄判据（否则收窄可被 tool_search 绕过）。
        function getToolFullDefFor(toolName, moduleIds, filter) {
            var tool = tools[toolName];
            if (!tool) return null;
            if (!tool.enabled) return null;
            var ids = _asModuleIds(moduleIds);
            if (!scopeIncludesAny(tool, ids)) return null;
            if (isModuleDisabledAnywhere(toolName, ids)) return null;
            if (typeof filter === 'function' && !filter(tool)) return null;
            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: (typeof tool.buildDescription === 'function')
                        ? tool.buildDescription(ids[0] || '')
                        : tool.description,
                    parameters: tool.input_schema
                },
                _source: tool.source || ''
            };
        }

        function getToolNamesForModules(moduleIds, filter) {
            var enabled = getEnabledForModules(moduleIds);
            var names = [];
            for (var i = 0; i < enabled.length; i++) {
                if (typeof filter === 'function' && !filter(enabled[i])) continue;
                names.push(enabled[i].name);
            }
            return names;
        }

        // ── filter-only 查询面（工具可见性闸口）──────────────────
        // 现有 getLlmToolDefsFor 先按 scope 过滤，无法表达「放宽」（scope 外的工具进不来）。
        // 这四个查询只受 filter（闸口判定）与注册表自身状态（enabled）约束，装配逻辑与
        // getLlmToolDefsFor 逐字节同源（同一个 _assembleStubDefs、同一 moduleLabel 口径）。
        // 旧 API 一律不动：外接投影、审计、增量装配仍走原入口。
        //
        // 「不过滤的全量条目」：UI 灰显 / 统计 / 原因表需要看到不可见、锁定与停用项；
        // 返回**注册表条目本身**（只读消费），顺序 = 注册顺序（Object.keys）。
        function getEntriesByFilter() {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) list.push(tools[keys[i]]);
            return list;
        }

        // 只收 enabled 且 filter 为真的条目；filter 缺席 = 不额外收窄
        function getVisibleEntriesByFilter(filter) {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var tool = tools[keys[i]];
                if (!tool.enabled) continue;
                if (typeof filter === 'function' && !filter(tool)) continue;
                list.push(tool);
            }
            return list;
        }

        // defs 装配：与 getLlmToolDefsFor 同一条 _assembleStubDefs（核心不占名额、stub 两遍装配、上限裁剪）。
        // moduleLabel 必须传视图身份首项（identityOf(view).moduleIds[0]）——buildDescription 用它，
        // 传视图 id 会让 Skill 等工具的描述漂移。
        function getLlmToolDefsByFilter(filter, moduleLabel) {
            var enabled = getVisibleEntriesByFilter(filter);
            return _assembleStubDefs(enabled, moduleLabel || '');
        }

        // tool_search / 闸口 fullDef 用：描述按 moduleLabel 现生成
        function getToolFullDefByFilter(toolName, filter, moduleLabel) {
            var tool = tools[toolName];
            if (!tool) return null;
            if (!tool.enabled) return null;
            if (typeof filter === 'function' && !filter(tool)) return null;
            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: (typeof tool.buildDescription === 'function')
                        ? tool.buildDescription(moduleLabel || '')
                        : tool.description,
                    parameters: tool.input_schema
                },
                _source: tool.source || ''
            };
        }

        // 获取单个工具的完整定义（供 tool_search 返回）
        function getToolFullDef(toolName, moduleId) {
            var tool = tools[toolName];
            if (!tool) return null;
            if (!tool.enabled) return null;
            if (!isAccessibleByModule(tool, moduleId || '')) return null;
            if (isModuleDisabled(toolName, moduleId || '')) return null;
            return {
                type: 'function',
                function: {
                    name: tool.name,
                    description: (typeof tool.buildDescription === 'function')
                        ? tool.buildDescription(moduleId || '')
                        : tool.description,
                    parameters: tool.input_schema
                },
                _source: tool.source || ''
            };
        }

        function isAccessibleByModule(tool, moduleId) {
            return scopeIncludesModule(tool, moduleId);
        }

        function setModuleEnabled(toolName, moduleId, enabled) {
            if (!tools[toolName]) return { ok: false, error: 'TOOL_NOT_FOUND' };
            if (!_disabledModules[toolName]) {
                _disabledModules[toolName] = Object.create(null);
            }
            if (enabled) {
                delete _disabledModules[toolName][moduleId];
            } else {
                _disabledModules[toolName][moduleId] = true;
            }
            return { ok: true };
        }

        function isModuleDisabled(toolName, moduleId) {
            if (!_disabledModules[toolName]) return false;
            return !!_disabledModules[toolName][moduleId];
        }

        function getModuleDisabledList(moduleId) {
            var disabled = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var toolName = keys[i];
                if (isModuleDisabled(toolName, moduleId)) {
                    disabled.push(toolName);
                }
            }
            return disabled;
        }

        function setToolEnabled(toolName, enabled) {
            if (!tools[toolName]) return { ok: false, error: 'NOT_FOUND' };
            tools[toolName].enabled = !!enabled;
            return { ok: true };
        }

        function updateTool(toolName, updates) {
            if (!tools[toolName]) return { ok: false, error: 'NOT_FOUND' };
            var tool = tools[toolName];
            if (updates.description !== undefined) tool.description = updates.description;
            if (updates.input_schema !== undefined) tool.input_schema = updates.input_schema;
            if (updates.handler !== undefined) {
                // 与 register 同标准：handler 必须是函数，防把 handler 更新成 null 后执行时静默失效
                if (typeof updates.handler !== 'function') return { ok: false, error: 'MISSING_HANDLER' };
                tool.handler = updates.handler;
            }
            if (updates.source !== undefined) tool.source = updates.source;
            if (updates.category !== undefined) tool.category = updates.category;
            if (updates.readOnly !== undefined) tool.readOnly = updates.readOnly === true;
            if (updates.scope !== undefined) tool.scope = parseScope(updates.scope);
            tool.updatedAt = Date.now();
            return { ok: true, entry: tool };
        }

        // 作用域解析：支持单模块（{ type:'module', moduleId }) 与多模块并集
        // （{ type:'module', moduleIds:['agent','script'] }）。保留 moduleId 字段作为
        // 单模块便捷引用（= moduleIds 首项），向后兼容仅读 scope.moduleId 的旧代码。
        function parseScope(scope) {
            if (!scope) return { type: 'global' };
            if (typeof scope === 'string' && scope === 'global') return { type: 'global' };
            // 对象形态的 `{type:'global'}` 是**合法声明**（历史上靠末尾兜底落 global；N-5 把兜底改成
            // fail-closed 后必须在这里显式承认，否则会把合法的全局工具收成「谁都不给」——由
            // skill-scope-enforcement 套件当场抓到）。大小写不敏感，与 `{type:'module'}` 的宽松口径一致。
            if (typeof scope === 'object' && typeof scope.type === 'string'
                && scope.type.toLowerCase() === 'global') {
                return { type: 'global' };
            }
            if (typeof scope === 'object' && scope.type === 'module') {
                if (Array.isArray(scope.moduleIds)) {
                    var ids = [];
                    for (var i = 0; i < scope.moduleIds.length; i++) {
                        if (typeof scope.moduleIds[i] === 'string' && scope.moduleIds[i]) {
                            ids.push(scope.moduleIds[i]);
                        }
                    }
                    if (ids.length) {
                        return { type: 'module', moduleIds: ids, moduleId: ids[0] };
                    }
                }
                if (scope.moduleId) {
                    return { type: 'module', moduleIds: [scope.moduleId], moduleId: scope.moduleId };
                }
            }
            // 未识别的形态 ⇒ **fail-closed**：一旦无条件
            // `return { type: 'global' }`，于是 `'agent'` / `'AGENT'` / `{moduleIds:['agent']}`（缺 type）/
            // `{type:'module', moduleIds:[]}` / `{type:'Module'}` / `{type:'module',moduleIds:'agent'}` /
            // `[]` / `true` 等畸形输入**统统落 global**（实测 18 个输入 14 个落 global）——本意 agent
            // 专用的工具变成**全模块可见**，且 `source==='ae-tools'` + 该组默认开 ⇒ **外接客户端可调**，
            // 而抽屉按原始 scope 渲染「外接」未勾 ⇒ **UI 与运行时相反**（用户在抽屉保存一次还会翻转）。
            // 口径：**声明式默认不变**（`!scope` 与 `'global'` 仍回 global，大量工具依赖它）；
            // 只有**畸形/未识别**才收口到空模块集 = 谁都不给（宁可不暴露）。
            try {
                console.warn('[ToolRegistry] 未识别的 scope 形态，按 fail-closed 收口（不授予全模块可见）: '
                    + JSON.stringify(scope));
            } catch (_) { /* JSON 失败也必须收口 */ }
            return { type: 'module', moduleIds: [], moduleId: '' };
        }

        // 判断工具是否对指定模块可见：global 全放行；module 作用域查 moduleIds 是否含该模块
        function scopeIncludesModule(tool, moduleId) {
            if (tool.scope.type === 'global') return true;
            if (tool.scope.type === 'module') {
                var ids = tool.scope.moduleIds;
                if (Array.isArray(ids)) {
                    for (var i = 0; i < ids.length; i++) {
                        if (ids[i] === moduleId) return true;
                    }
                }
            }
            return false;
        }

        function getByScope(scopeType, moduleId) {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var tool = tools[keys[i]];
                if (scopeType === 'global' && tool.scope.type === 'global') {
                    list.push(tool);
                } else if (scopeType === 'module' && tool.scope.type === 'module' && scopeIncludesModule(tool, moduleId)) {
                    list.push(tool);
                }
            }
            return list;
        }

        function getByCategory(category) {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                if (tools[keys[i]].category === category) {
                    list.push(tools[keys[i]]);
                }
            }
            return list;
        }

        function getByServerId(serverId) {
            var list = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                if (tools[keys[i]].serverId === serverId) {
                    list.push(tools[keys[i]]);
                }
            }
            return list;
        }

        function getCount() {
            return Object.keys(tools).length;
        }

        function getEnabledCount(moduleId) {
            return getEnabledForModule(moduleId || '').length;
        }

        // 获取某模块下受上限约束的非核心工具数量（stub 和非 stub 均统计，核心工具不计）。
        // 用于 Agent 模块设置面板显示“当前工具数”，让用户直观看到上限裁剪的规模。
        function getStubCount(moduleId) {
            var enabled = getEnabledForModule(moduleId || '');
            var count = 0;
            for (var i = 0; i < enabled.length; i++) {
                if (CORE_TOOL_NAMES[enabled[i].name] === true) continue;
                count++;
            }
            return count;
        }

        function hasTool(toolName) {
            return !!tools[toolName];
        }

        function findTools(filter) {
            var results = [];
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var tool = tools[keys[i]];
                var match = true;
                if (filter.source && tool.source !== filter.source) match = false;
                if (filter.category && tool.category !== filter.category) match = false;
                if (filter.serverId && tool.serverId !== filter.serverId) match = false;
                if (filter.moduleId && tool.scope.type !== 'global' && !scopeIncludesModule(tool, filter.moduleId)) match = false;
                if (match) results.push(tool);
            }
            return results;
        }

        function serialize() {
            var data = { tools: {}, _disabledModules: _disabledModules, serializedAt: Date.now() };
            var keys = Object.keys(tools);
            for (var i = 0; i < keys.length; i++) {
                var tool = tools[keys[i]];
                data.tools[keys[i]] = {
                    name: tool.name,
                    description: tool.description,
                    input_schema: tool.input_schema,
                    source: tool.source,
                    scope: tool.scope,
                    serverId: tool.serverId,
                    moduleId: tool.moduleId,
                    category: tool.category,
                    enabled: tool.enabled,
                    stub: tool.stub,
                    readOnly: tool.readOnly === true,
                    installedAt: tool.installedAt,
                    updatedAt: tool.updatedAt
                };
            }
            return data;
        }

        function deserialize(data) {
            if (!data || !data.tools) return false;
            var keys = Object.keys(data.tools);
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (tools[key]) {
                    tools[key].description = data.tools[key].description;
                    tools[key].input_schema = data.tools[key].input_schema;
                    tools[key].source = data.tools[key].source;
                    tools[key].scope = data.tools[key].scope;
                    tools[key].serverId = data.tools[key].serverId;
                    tools[key].moduleId = data.tools[key].moduleId;
                    tools[key].category = data.tools[key].category;
                    tools[key].enabled = data.tools[key].enabled;
                    tools[key].stub = data.tools[key].stub;
                    tools[key].readOnly = data.tools[key].readOnly === true;
                    tools[key].updatedAt = data.tools[key].updatedAt;
                }
            }
            if (data._disabledModules) {
                // 反序列化数据来自 JSON.parse（普通对象原型），
                // 重建为 null-prototype 结构，与运行时内部形态保持一致
                var rebuilt = Object.create(null);
                var dmKeys = Object.keys(data._disabledModules);
                for (var j = 0; j < dmKeys.length; j++) {
                    var dmKey = dmKeys[j];
                    var sub = Object.create(null);
                    var subData = data._disabledModules[dmKey];
                    if (subData && typeof subData === 'object') {
                        var subKeys = Object.keys(subData);
                        for (var k = 0; k < subKeys.length; k++) {
                            sub[subKeys[k]] = subData[subKeys[k]];
                        }
                    }
                    rebuilt[dmKey] = sub;
                }
                _disabledModules = rebuilt;
            }
            return true;
        }

        function clear() {
            tools = Object.create(null);
            _disabledModules = Object.create(null);
        }

        function getToolNamesForModule(moduleId) {
            var enabled = getEnabledForModule(moduleId || '');
            var names = [];
            for (var i = 0; i < enabled.length; i++) {
                names.push(enabled[i].name);
            }
            return names;
        }

        // 调整注入 LLM 的 stub 工具数量上限（默认 200）。传入 0 表示不限制。
        function setMaxLlmStubTools(n) {
            var v = Number(n);
            LLM_MAX_STUB_TOOLS = (isFinite(v) && v > 0) ? Math.floor(v) : 0;
        }

        return {
            register: register,
            unregister: unregister,
            get: get,
            getAll: getAll,
            getEnabledForModule: getEnabledForModule,
            getLlmToolDefinitions: getLlmToolDefinitions,
            getLlmToolStubs: getLlmToolStubs,
            getLlmToolDefsFor: getLlmToolDefsFor,
            getEnabledForModules: getEnabledForModules,
            scopeIncludesAny: scopeIncludesAny,
            isModuleDisabledAnywhere: isModuleDisabledAnywhere,
            setMaxLlmStubTools: setMaxLlmStubTools,
            getToolFullDef: getToolFullDef,
            getToolFullDefFor: getToolFullDefFor,
            getLlmToolDefsByFilter: getLlmToolDefsByFilter,
            getToolFullDefByFilter: getToolFullDefByFilter,
            getEntriesByFilter: getEntriesByFilter,
            getVisibleEntriesByFilter: getVisibleEntriesByFilter,
            getToolNamesForModule: getToolNamesForModule,
            getToolNamesForModules: getToolNamesForModules,
            setModuleEnabled: setModuleEnabled,
            isModuleDisabled: isModuleDisabled,
            getModuleDisabledList: getModuleDisabledList,
            setToolEnabled: setToolEnabled,
            updateTool: updateTool,
            getByScope: getByScope,
            getByCategory: getByCategory,
            getByServerId: getByServerId,
            findTools: findTools,
            getCount: getCount,
            getEnabledCount: getEnabledCount,
            getStubCount: getStubCount,
            // 核心工具只读判定：工具可见性子面板的「工具上限」提示要按
            // 「非核心启用数」计数，而 CORE_TOOL_NAMES 只住本文件内部。暴露只读判定而不是暴露
            // 名单本身——调用方无法据此维护第二份名单，也不会误改上限口径。
            isCoreTool: function (toolName) {
                return CORE_TOOL_NAMES[toolName] === true;
            },
            hasTool: hasTool,
            serialize: serialize,
            deserialize: deserialize,
            clear: clear,
            JSON_RPC_ERRORS: JSON_RPC_ERRORS
        };
    }

    // ── 每 runtime 的 handler 绑定视图 ──────────────────────────────
    // 背景：工具注册表只有**一份**，而每条 runtime（单 Agent /
    // 团队三条 lane / 每个子 Agent）装配 controller 时都会把同名工具**再注册一遍**。全局表是
    // last-wins：handler 只留最后注册那条 runtime 的，而它闭包捕获的是**那条 runtime**的可变/
    // 身份状态（stopRequested、cm/store、plan、lane、toolResultStore…）⇒ 别的 runtime 调同一
    // 工具时，拿到的是「别人那条 runtime 的」停止态/会话域/计划/分槽。
    // 单点补丁（把这类状态逐个经 execCtx 往下传）能治已发现的症状，但正确性依赖「每个工具作者
    // 都记得从 execCtx 取」，加一个新工具或新捕获状态就可能复发——这正是「打补丁」与「根治」
    // 的分界。
    // 本函数给出结构性解法：**定义仍进全局表**（LLM 工具清单 / tool_search / 外接投影 / UI 开关
    // 全部不变），但**handler 按 runtime 各记一份**。执行时由执行侧（toolExecutionPipeline →
    // toolExecutor）带上本 runtime 的 handler 表：
    //   · 执行者自己注册过的工具 → 用它自己的 handler（闭包里的状态天然是本 runtime 的）；
    //   · 执行者没注册过（一次性注册的全局工具 / 动态注册的 AE、MCP 工具 / 外接通道）→ 回落全局表。
    // ⇒ 「handler 问错 runtime」不再依赖作者自觉，结构上不可达；新增工具自动受益。
    // 入参：base = 全局注册表；handlers = 本 runtime 的 {toolName: handler} 容器（由调用方持有，
    // 经 pipeline 随调用下发）。返回对象以 base 为原型：get/hasTool/全部查询能力原样透传，
    // 只覆盖 register（登记到全局 + 记进本 runtime 的绑定表）。handlers 用非枚举属性挂载。
    function createRuntimeToolRegistry(base, handlers) {
        var map = handlers || Object.create(null);
        if (!base || typeof base.register !== 'function') {
            // 旧装配/测试沙箱没有注册表：保持「注册是 no-op」的原语义，但 handler 容器照收。
            return {
                register: function () { return { ok: false, error: 'NO_BASE_REGISTRY' }; },
                handlers: map
            };
        }
        // scope 归一（只做「是否更宽」的比较，与 parseScope 同口径的只读简化版）：
        //   null = global（全放行，最宽）；数组 = module 集合；[] = 未识别/fail-closed。
        function _scopeIds(scope) {
            if (!scope) return null;
            var t = (typeof scope === 'string') ? scope : scope.type;
            if (typeof t === 'string' && t.toLowerCase() === 'global') return null;
            if (scope && typeof scope === 'object' && String(scope.type || '').toLowerCase() === 'module') {
                if (Array.isArray(scope.moduleIds)) {
                    var out = [];
                    for (var i = 0; i < scope.moduleIds.length; i++) {
                        if (typeof scope.moduleIds[i] === 'string' && scope.moduleIds[i]) out.push(scope.moduleIds[i]);
                    }
                    if (out.length) return out;
                }
                if (typeof scope.moduleId === 'string' && scope.moduleId) return [scope.moduleId];
                return [];
            }
            return [];
        }
        // 同名工具的 scope 只允许**扩宽**（并集方向，**防御性**语义）：生产上的工具定义已经同源
        //（plan 工具 scope 统一为 ['agent','team']，见 controller.js 的 planScope 注），本分支正常
        // 不触发。保留它的原因：若将来又出现跨 runtime 定义差异，窄覆盖宽会让 lane 的执行侧 scope
        // 校验拒绝自己的工具；但正确修法是让定义**同源**——允许两份定义，全局 scope 就仍会随装配
        // 顺序（last-wins）或首装策略漂移，那正是本函数要消灭的缺陷类。
        function _maybeWidenScope(existing, toolDef) {
            if (!existing || toolDef.scope === undefined) return;
            var cur = _scopeIds(existing.scope);
            var next = _scopeIds(toolDef.scope);
            if (cur === null) return;                    // 已是最宽（global）
            if (next === null) {                         // 后装声明 global ⇒ 扩到 global
                if (typeof base.updateTool === 'function') base.updateTool(existing.name, { scope: { type: 'global' } });
                return;
            }
            var nextCovers = true;
            for (var i = 0; i < cur.length; i++) {
                if (next.indexOf(cur[i]) < 0) { nextCovers = false; break; }
            }
            if (nextCovers && next.length > cur.length) {
                if (typeof base.updateTool === 'function') {
                    base.updateTool(existing.name, { scope: { type: 'module', moduleIds: next } });
                }
                return;
            }
            if (!nextCovers) {
                // 互不包含：定义分叉，保留首装并留痕（当前无此场景；出现必须显式可见）
                try {
                    console.warn('[ToolRegistry] 同名工具在不同 runtime 的 scope 互不包含，保留首装定义: '
                        + existing.name);
                } catch (_) { /* 诊断失败不影响注册 */ }
            }
        }
        var facade = Object.create(base);
        facade.register = function (toolDef) {
            if (!toolDef || typeof toolDef.name !== 'string' || !toolDef.name) {
                return { ok: false, error: 'MISSING_NAME' };
            }
            var name = toolDef.name;
            // 定义只安装一次（first-wins）：已安装 ⇒ **不再走 base.register**（那会无条件重建 entry，
            // 把用户编辑的 description/schema、用户禁用的 enabled（setToolEnabled）、首装的
            // installedAt/readOnly/stub 全部重置回代码默认；且全局表 handler 变成最后装配者，
            // 无 overlay 的调用方（外接）会拿到别人 runtime 的闭包）。这里只做两件事：把本 runtime
            // 的 handler 记进绑定表、scope 允许扩宽。返回体与 base.register 同形状，调用方零改动。
            var existing = null;
            if (typeof base.hasTool === 'function' && base.hasTool(name)) {
                existing = base.get(name);
            }
            if (existing) {
                if (typeof toolDef.handler === 'function') map[name] = toolDef.handler;
                _maybeWidenScope(existing, toolDef);
                return { ok: true, skipped: true, entry: existing };
            }
            var res = base.register(toolDef);
            if (res && res.ok && typeof toolDef.handler === 'function') map[name] = toolDef.handler;
            return res;
        };
        try {
            Object.defineProperty(facade, 'handlers', { value: map, enumerable: false });
        } catch (_) { facade.handlers = map; }
        return facade;
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createToolRegistry = createToolRegistry;
    global.AE_LLM.createRuntimeToolRegistry = createRuntimeToolRegistry;
    global.AE_LLM.JSON_RPC_ERRORS = JSON_RPC_ERRORS;

})(window);
