/**
 * extPolicy.js — 外接模式策略层：档位 / 组开关 / 确认表 / 激活态
 *
 * 职责：
 *   - externalMcpPermissionTier：外部权限档位（auto/balanced/conservative，默认 balanced；
 *     当前 conservative ≡ balanced——面板侧确认取消，档位实际语义为 auto / 需确认两级）
 *   - externalToolGroups：模块组对外开关（组 OFF ⇒ 全组隐藏；组 ON ⇒ per-tool 开关生效）
 *   - per-tool 对外开关：默认态来自 TOOL_DEFAULT_DISABLED（记忆写四件默认关），
 *     显式记录（true/false）优先，未记录的键跟随默认
 *   - 外部确认表：七组（创建/覆盖 AE 工具、记忆写四件、素材文件夹删除、效果库删除、
 *     技能写面、脚本入库写、MCP 管理双工具）
 *     （与面板内部确认面**分叉**——asset 写非删/shader save/ComfyUI 外部放行，面板行为不变；
 *     MCP 管理双工具与面板 permissions.js 同口径补确认，
 *     仅 mcp_ 前缀的网关投影工具（第三方 MCP 工具）仍外部放行）
 *   - 外接模式激活态：内存态（面板生命周期内持久，重载即失效需重新激活——通道开关语义）
 *
 * 存储约定：档位与组开关持久化到 localStorage（CEP 面板持久存储）；激活态不持久化。
 * 变更通知：组/per-tool 开关切换后调用方应触发 extBridgeClient.notifyToolsChanged()。
 */
(function (global) {
    'use strict';

    var STORAGE_KEY = 'AS_ExtP_extMcpSettings_v1';

    // ── 模块组定义 ──
    // fixed: 静态白名单工具名清单；gateway: mcp_ 前缀动态投影（默认关）
    // label 读时才翻译：本文件会整份加载进无 AEI18n 的沙箱，顶层求值会抛 ReferenceError
    var TOOL_GROUPS = {
        ae_data: {
            get label() { return AEI18n.t('AE 工程数据'); },
            // 补参数式保存工具 saveProject（与 importFile 同族）。外接是
            // 缺口的来源场景——file 域关时外接 agent 的 `new File(...)` 被门拒，没有参数式
            // 保存工具就只能停下求用户开域；漏登记本组 = 工具建了但外接看不到。
            fixed: ['queryProject', 'queryDetails', 'queryEnvironment', 'executeExtendScript',
                    'importFile', 'replaceFootage', 'saveProject', 'listFolderFiles', 'getPreviewFrame',
                    // 参数式图片分析（文件模式只回指标；抓帧模式随结果内联图像块）
                    'analyzeImage',
                    // 内建工具掉进自定义 AE 工具组：renderComp 的 source 也是
                    // ae-tools，未登记任何 fixed 组就被动态组按 source 捞走。内建工具必须显式登记
                    // fixed；动态组只收 createAETool 落盘的用户工具。
                    'renderComp'],
            defaultOn: true
        },
        ae_meta: {
            get label() { return AEI18n.t('AE 元工具'); },
            // createAETool 对外接开放（它与 deleteAETool 不同：后者
            // 只属工具管理面、不对外）。放开的三处配套：① 注册 scope 加 'external-mcp'
            //（aeToolCreator.js，否则 scopeAllowsExternal 仍拒）；② 本组收它；③ 确认表必确认
            //（见 evaluateExternalConfirmation——面板侧本就是 FORCE_CONFIRM、每次必确认）。
            // **deleteAETool 不放开**（不可逆：删用户工具）；它仍留在 AE_META_TOOLS 排除表里，
            // 无组 ⇒ NOT_IN_EXTERNAL_WHITELIST。
            fixed: ['undoLastOperation', 'createAETool'],
            defaultOn: true
        },
        // 自定义 AE 工具（createAETool 落盘到 ae_tools.json 的用户工具）。成员是运行期
        // 动态的，故 fixed 只作占位（保留空数组而非省略：外接设置页的 per-tool 循环会直接
        // 读 group.fixed.length）、判别走 dynamic。归属与去重的实现只有 isDynamicGroupMember
        // 一份，外部模块经导出的 groupOfTool 取用——投影层/UI 层不得另写 source 过滤
        //（重写一份即两个真相源）。
        // 默认开：文档意图即「自动对外供给」；自定义工具本质是
        // executeExtendScript（比它更宽、且已默认开）的子集，反过来要求额外授权自相矛盾。
        ae_tools: {
            get label() { return AEI18n.t('自定义 AE 工具'); },
            fixed: [],
            dynamic: 'ae-tools',
            defaultOn: true
        },
        engine: {
            get label() { return AEI18n.t('Agent 引擎'); },
            fixed: ['queryAeApi', 'guide',
                    // 内建工具掉进自定义 AE 工具组：shader_params 同为面板侧
                    // 内建工具（source: ae-tools），必须显式登记 fixed；动态组只收 createAETool
                    // 落盘的用户工具。
                    'shader_params'],
            defaultOn: true
        },
        script: {
            get label() { return AEI18n.t('脚本模式'); },
            fixed: ['script_manager', 'submit_script', 'get_current_script'],
            defaultOn: true
        },
        shader: {
            get label() { return AEI18n.t('Shader 模式'); },
            fixed: ['submit_shader', 'get_current_shader', 'shader_library',
                    'getShaderPreview', 'get_render_error', 'submit_js_effect'],
            defaultOn: true
        },
        memory: {
            get label() { return AEI18n.t('记忆'); },
            fixed: ['memory_list', 'memory_read', 'memory_search', 'memory_create',
                    'memory_update', 'memory_delete', 'get_rule', 'set_rule'],
            defaultOn: true
        },
        comfyui: {
            get label() { return AEI18n.t('ComfyUI 生成'); },
            fixed: ['comfyui_generate', 'comfyui_check_status', 'comfyui_list_params',
                    'comfyui_list_checkpoints', 'comfyui_search_official_templates',
                    'comfyui_run_official_template', 'comfyui_run_workflow', 'comfyui_list_nodes'],
            defaultOn: true
        },
        assets: {
            get label() { return AEI18n.t('素材库'); },
            // 三工具已合并为单工具（library + mode）
            fixed: ['asset_library'],
            defaultOn: true
        },
        skill: {
            label: 'Skill',
            // Skill = 注入工具（读 skill.prompt/body，纯读直接执行）
            fixed: ['Skill', 'skill_manager', 'search_skill_store'],
            defaultOn: true
        },
        // 外接任务查询：dispatch 墙钟超时（EXT_TASK_PENDING）后
        // 按 taskId 查询迟到结果（ext_task_get）。只读、免确认（确认表 default 放行）——
        // 工具由 extBridgeClient 在装配期注册（scope module[external-mcp]）。
        ext_tasks: {
            get label() { return AEI18n.t('外接任务'); },
            fixed: ['ext_task_get'],
            defaultOn: true
        },
        gateway: {
            get label() { return AEI18n.t('网关（其他 MCP 服务器）'); },
            fixed: [],
            gateway: true,   // mcp_* 动态投影
            defaultOn: false  // 网关默认关
        }
    };

    // ── 外接 per-tool 默认关名单 ──
    // 症状：外接 Agent（ZCode 等）把**不属于本项目的记忆**写进记忆库。原有作用域约束只写在
    // 工具描述里（extTools.js 的 MEMORY_SCOPE_NOTE），靠模型自觉；auto 档又整体跳过确认表
    //（见 needsConfirmation），写入口等于没有硬闸。
    // 改法：**记忆写四件默认不对外投影**（读三件 + get_rule 照常暴露——外接仍需 memory_search
    // 查重/查经验）。要放开就在外接设置页把该工具的勾选框打开，勾开写显式 false 覆盖默认，
    // 重启不丢（见 setToolDisabled）。
    // 名单与确认表的「一组：memory 写四件」共用 MEMORY_WRITE_TOOLS 一份，防两处漂移。
    var MEMORY_WRITE_TOOLS = ['memory_create', 'memory_update', 'memory_delete', 'set_rule'];
    // 用 Object.create(null) 建表：键名来自工具名，裸对象会命中原型链上的名字（如 constructor）
    var TOOL_DEFAULT_DISABLED = Object.create(null);
    MEMORY_WRITE_TOOLS.forEach(function (n) { TOOL_DEFAULT_DISABLED[n] = true; });

    // ── 动态组归属判定 ──
    // 工具管理面元工具：source 同为 'ae-tools'，但属「创建/删除工具」的管理面，不对外暴露
    //（调研 :424 口径：createAETool/deleteAETool 在 scope 层被拦，档位无关）。
    // listAeFunctions 已随其工具删除（库函数整链清理）——原注释里「它另有
    // ae_meta.fixed 归属、本表只保证不被 ae_tools 组重复捞一份」随之作废。
    // 用 Object.create(null) 建表：工具名来自注册表，裸对象会命中原型链上的名字（如 constructor）。
    var AE_META_TOOLS = Object.create(null);
    AE_META_TOOLS.createAETool = true;
    AE_META_TOOLS.deleteAETool = true;

    function getToolRegistry() {
        return global.AE_LLM && global.AE_LLM.toolRegistry;
    }

    // 名字是否已列在某个 fixed 名单里（动态组不抢既有组成员）
    function isInAnyFixedList(toolName) {
        var groupIds = Object.keys(TOOL_GROUPS);
        for (var i = 0; i < groupIds.length; i++) {
            var g = TOOL_GROUPS[groupIds[i]];
            if (g.fixed && g.fixed.indexOf(toolName) >= 0) return true;
        }
        return false;
    }

    // 动态组成员判定（归属与去重的唯一实现；跨模块消费者经导出的 groupOfTool 取用）。三条排除规则：
    //   ① 已列在任一 fixed 名单里 → 归原组（否则 undoLastOperation 会在两个组各出现一次）。
    //      该规则在 groupOfTool 里已由「先查 fixed 名单」的顺序实现，故当前调用路径下
    //      这一行恒不命中；此处仍保留一份，是为了让本判据不依赖调用方顺序——将来被直接
    //      调用或调用顺序调整后依然正确（审查已确认保留它是正确取舍，不要删）
    //   ② 工具管理面元工具 → 恒不归属
    //   ③ mcp_ 前缀 → 恒归 gateway
    // 末位查注册表 source：与 group.dynamic 声明值一致才算成员。
    // 注册表不可用/条目缺失一律返回 false（fail-closed：宁可不暴露，不得误判为成员）。
    function isDynamicGroupMember(groupId, toolName) {
        var group = TOOL_GROUPS[groupId];
        if (!group || !group.dynamic) return false;
        if (!toolName) return false;
        if (toolName.indexOf('mcp_') === 0) return false;
        if (AE_META_TOOLS[toolName]) return false;
        if (isInAnyFixedList(toolName)) return false;
        var registry = getToolRegistry();
        if (!registry || typeof registry.get !== 'function') return false;
        var tool = registry.get(toolName);
        return !!(tool && tool.source === group.dynamic);
    }

    // ── 外部确认表（七组；与面板 permissions.js 语义分叉，独立维护）──
    // 确认走 elicitation（Agent 软件内）；auto 档全部放行。
    // ext_task_get（超时任务查询）为只读工具 → 落 default 放行，不单列分支。
    var SCRIPT_WRITE_MODES = { create: true, write: true, rename: true, move: true,
                               createFolder: true, renameFolder: true, removeFolder: true,
                               cleanNonScript: true, delete: true };
    var SKILL_WRITE_MODES = { create: true, update: true, setEnabled: true,
                              install: true, delete: true };
    // 六组：MCP 管理双工具纳入外接确认表——若落 default
    // {confirm:false}，外部客户端可无确认地增删改 MCP 服务器（含 remove）与
    // start/stop/restart/autoStartAll。mode 分类与面板 permissions.js 的
    // _mcpServersNeedsConfirm/_mcpControlNeedsConfirm 同口径；args.mode 缺失/未知
    // 一律保守确认（参数异常不得成为放行通道）。
    var MCP_SERVERS_READ_MODES = { list: true, get: true };
    var MCP_SERVERS_WRITE_MODES = { add: true, update: true, setAutoStart: true };
    var MCP_CONTROL_READ_MODES = { getStatus: true, getAllStatuses: true };
    var MCP_CONTROL_MODES = { start: true, stop: true, restart: true, autoStartAll: true };

    function evaluateExternalConfirmation(toolName, args) {
        var m = args && args.mode;
        switch (toolName) {
            // 零组：创建/覆盖 AE 工具——写盘 + 改变后续
            // **可被调用的工具面**（外接创建的工具有机会出现在它自己的 tools/list 里），属
            // 「不可逆或影响面大」，与面板侧 FORCE_CONFIRM 同口径（permissions.js 的
            // createAETool: true，每次都必须用户确认）。
            // 注：不支持 elicitation 的客户端 → 需确认操作**默认拒绝**（ext-mcp-server.js 的
            // 收紧），即这类客户端无法建工具；要放开到「无确认」需另行决定。
            case 'createAETool':
                return { confirm: true, reason: '创建/覆盖 AE 工具（写盘并改变后续可调用的工具面）' };
            // 一组：memory 写四件（名单见顶部 MEMORY_WRITE_TOOLS，与 per-tool 默认关同一份）
            // 二组：asset 删 mode（写非删已放行）。
            // 三工具合并为 asset_library；archive/restore（删除=归档，可恢复）
            // 归"写非删"口径放行——不新增 FORCE（本工具已无不可逆操作）
            case 'asset_library':
                if (m === 'removeFolder') return { confirm: true, reason: '磁盘硬删除素材文件夹，无回收站' };
                return { confirm: false };
            // 三组：shader_library delete（save 已放行）
            case 'shader_library':
                if (m === 'delete') return { confirm: true, reason: '删除效果库文件，不可逆' };
                return { confirm: false };
            // 四组：Skill 写面（createSkill 已并入 skill_manager 粗粒度工具，无独立条目）
            case 'skill_manager':
                if (SKILL_WRITE_MODES[m]) return { confirm: true, reason: 'Skill 库写操作（' + m + '）' };
                return { confirm: false };
            // 五组：script_manager 写 mode
            case 'script_manager':
                if (SCRIPT_WRITE_MODES[m]) return { confirm: true, reason: '脚本库写操作（' + m + '）' };
                return { confirm: false };
            // 六组：MCP 管理双工具——读 mode 不弹；
            // 写/控制 mode 弹；remove 对齐面板 FORCE 口径（不可逆）。缺 mode/未知 mode
            // 保守确认（与面板 _mcpServersNeedsConfirm 的 `if (!m) return true` 同款）。
            case 'mcp_servers':
                if (MCP_SERVERS_READ_MODES[m]) return { confirm: false };
                if (m === 'remove') return { confirm: true, reason: '删除 MCP 服务器配置，不可逆' };
                if (MCP_SERVERS_WRITE_MODES[m]) return { confirm: true, reason: '改 MCP 服务器配置（' + m + '）' };
                return { confirm: true, reason: '改 MCP 服务器配置（未识别的 mode）' };
            case 'mcp_control':
                if (MCP_CONTROL_READ_MODES[m]) return { confirm: false };
                if (MCP_CONTROL_MODES[m]) return { confirm: true, reason: 'MCP 服务器运行控制（' + m + '）' };
                return { confirm: true, reason: 'MCP 服务器运行控制（未识别的 mode）' };
            default:
                // 一组：记忆写四件（MEMORY_WRITE_TOOLS 是唯一名单，默认关名单同源）——
                // 放在 default 里而不是四个 case，是为了让「加一个记忆写工具」只改一处
                if (MEMORY_WRITE_TOOLS.indexOf(toolName) >= 0) {
                    return { confirm: true, reason: '写入共享记忆（memory_delete 不可逆）' };
                }
                return { confirm: false };
        }
    }

    // ── 设置存取 ──
    var settings = null;
    var listeners = [];   // 变更回调（UI 刷新 / tools_changed 推送）

    function loadSettings() {
        var raw = null;
        try { raw = localStorage.getItem(STORAGE_KEY); } catch (_) {}
        var s = {};
        try { s = raw ? JSON.parse(raw) : {}; } catch (_) { s = {}; }
        // 档位归一：conservative ≡ balanced，保留三值兼容配置（行为按两级映射）
        if (['auto', 'balanced', 'conservative'].indexOf(s.tier) < 0) s.tier = 'balanced';
        // 组开关：缺省按组定义默认值
        s.groups = s.groups || {};
        var groupIds = Object.keys(TOOL_GROUPS);
        for (var i = 0; i < groupIds.length; i++) {
            var gid = groupIds[i];
            if (typeof s.groups[gid] !== 'boolean') s.groups[gid] = TOOL_GROUPS[gid].defaultOn;
        }
        // 网关 per-server 开关：双默认关（组开后仍需逐 server 显式开启）
        s.servers = s.servers || {};
        // per-tool 禁用表：并入本层持久化设置（与该页档位/组/per-server 同一
        // localStorage 键）。只写 toolRegistry._disabledModules（纯内存，无落盘）时，
        // 用户排除的工具重启面板即恢复暴露。
        // 键空间 toolName → true（对外禁用）/ false（用户显式打开；只有默认关的键会写，
        // 见 setToolDisabled）；**缺省 = 跟随 TOOL_DEFAULT_DISABLED**。只认布尔值：其它脏值
        // 一律丢弃（不得当禁用；false 是宽松方向，保留它才记得住「用户要开」）。
        s.disabledTools = (s.disabledTools && typeof s.disabledTools === 'object') ? s.disabledTools : {};
        var dtKeys = Object.keys(s.disabledTools);
        for (var t = 0; t < dtKeys.length; t++) {
            if (typeof s.disabledTools[dtKeys[t]] !== 'boolean') delete s.disabledTools[dtKeys[t]];
        }
        // 放行路径 toast（透明度补偿 + 粒度化）：
        //   'risky'（默认）= 确认被跳过 + auto 档确认表命中（高危）放行提醒
        //   'all'          = 全部成功调用提醒
        //   'off'          = 关闭
        // 旧布尔 toast 迁移：false → 'off'，true/缺省 → 'risky'
        if (['all', 'risky', 'off'].indexOf(s.toastLevel) < 0) {
            s.toastLevel = (s.toast === false) ? 'off' : 'risky';
        }
        return s;
    }

    function persist() {
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)); } catch (_) {}
    }

    function ensureLoaded() {
        if (!settings) settings = loadSettings();
        return settings;
    }

    function notifyListeners(change) {
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](change); } catch (e) { console.warn('[ext-policy] listener error: ' + e.message); }
        }
    }

    // ── 对外 API ──
    var api = {
        TOOL_GROUPS: TOOL_GROUPS,
        // 默认关名单（记忆写四件）：UI 据此在设置页点明「默认关」，测试据此断言默认态
        TOOL_DEFAULT_DISABLED: TOOL_DEFAULT_DISABLED,

        // 激活态（内存态：面板重载归零，需在状态卡重新拨开——显式授权语义）。
        // 唯一写入口是状态卡总开关（view.renderStatusCard）；模式切换（含进出外接档）
        // 不读写本状态——授权与档位解耦。
        _active: false,
        isActive: function () { return api._active; },
        setActive: function (on) {
            api._active = !!on;
            notifyListeners({ kind: 'active', value: api._active });
        },

        getTier: function () { return ensureLoaded().tier; },
        setTier: function (tier) {
            if (['auto', 'balanced', 'conservative'].indexOf(tier) < 0) return;
            ensureLoaded().tier = tier;
            persist();
            notifyListeners({ kind: 'tier', value: tier });
        },

        // 实际确认判定档位：conservative 与 balanced 等同（面板确认已取消）
        effectiveTier: function () {
            return ensureLoaded().tier === 'auto' ? 'auto' : 'balanced';
        },

        isGroupEnabled: function (groupId) {
            var s = ensureLoaded();
            return s.groups[groupId] === true;
        },
        setGroupEnabled: function (groupId, on) {
            if (!TOOL_GROUPS[groupId]) return;
            var s = ensureLoaded();
            s.groups[groupId] = !!on;
            persist();
            notifyListeners({ kind: 'group', groupId: groupId, value: !!on });
        },

        // 工具名 → 组归属。顺序即优先级：
        //   ① mcp_ 前缀 → gateway（既有）
        //   ② fixed 名单精确命中 → 该组（既有；也是「动态组不抢既有组成员」的实现点）
        //   ③ 动态组成员 → 该动态组
        // 未命中返回 null，调用方据此拒绝（NOT_IN_EXTERNAL_WHITELIST）
        groupOfTool: function (toolName) {
            if (toolName && toolName.indexOf('mcp_') === 0) return 'gateway';
            var groupIds = Object.keys(TOOL_GROUPS);
            for (var i = 0; i < groupIds.length; i++) {
                var g = TOOL_GROUPS[groupIds[i]];
                if (g.fixed && g.fixed.indexOf(toolName) >= 0) return groupIds[i];
            }
            for (var j = 0; j < groupIds.length; j++) {
                if (isDynamicGroupMember(groupIds[j], toolName)) return groupIds[j];
            }
            return null;
        },

        // 网关 per-server 开关（双默认关：组开关之外的第二道门）
        isServerEnabled: function (serverId) {
            return ensureLoaded().servers[serverId] === true;
        },
        setServerEnabled: function (serverId, on) {
            if (!serverId) return;
            var s = ensureLoaded();
            s.servers[serverId] = !!on;
            persist();
            notifyListeners({ kind: 'server', serverId: serverId, value: !!on });
        },

        // ── per-tool 禁用──
        // 真相源 = 本策略层的持久化设置（disabledTools）；无记录时跟随 TOOL_DEFAULT_DISABLED
        //（记忆写四件默认关）。registry.isModuleDisabled 只作运行期投影/执行期复检的镜像
        //（setToolDisabled 同步、applyToolSettings 回放）。
        // 外部语义恒为 'external-mcp' 模块（与 extTools/view 的既有口径一致）。
        isToolDisabled: function (toolName) {
            if (!toolName) return false;
            var v = ensureLoaded().disabledTools[toolName];
            if (typeof v === 'boolean') return v;
            return TOOL_DEFAULT_DISABLED[toolName] === true;
        },
        setToolDisabled: function (toolName, disabled) {
            if (!toolName) return;
            var s = ensureLoaded();
            if (disabled) {
                s.disabledTools[toolName] = true;
            } else if (TOOL_DEFAULT_DISABLED[toolName] === true) {
                // 默认关的键：写显式 false 记住「用户要开」。删键会落回默认关 —— 默认关的工具
                // 只能靠显式覆盖才对外，这是刻意的（换机器/清缓存后仍是关，不会静默放开记忆写）
                s.disabledTools[toolName] = false;
            } else {
                delete s.disabledTools[toolName];   // 非默认关：清键不留历史
            }
            persist();
            // 同步注册表镜像：外部投影（extTools）/执行期复检/toolExecutor 都读
            // registry.isModuleDisabled，不同步则 UI 关了但投影仍暴露、直到重启回放。
            // 注册表不可用时静默——持久化已生效，下次装配回放补齐。
            var registry = getToolRegistry();
            if (registry && typeof registry.setModuleEnabled === 'function') {
                try { registry.setModuleEnabled(toolName, 'external-mcp', !disabled); } catch (_) {}
            }
            notifyListeners({ kind: 'tool', toolName: toolName, value: !!disabled });
        },
        // 装配/重启回放（bootstrap.js 调用）：把 per-tool 禁用态灌进注册表。
        // 优先复用 toolRegistry.deserialize（注册表自身的 null-prototype 重建逻辑，不新造
        // 第二套存储/解析）；不可用或返回 false 时逐条 setModuleEnabled 兜底。
        // 注意：deserialize 会整体替换 _disabledModules（本表即真相源），当前全仓只有外接
        // 通道使用该表，回放即真相源的语义成立。
        // 回放名单 = 持久化表的键 ∪ 默认关名单的键（默认关的键可能从未落盘），逐名走
        // isToolDisabled 取判定 —— 显式 false 的记录因此不会被当成禁用。
        applyToolSettings: function (registry) {
            var reg = registry || getToolRegistry();
            if (!reg) return;
            var s = ensureLoaded();
            var names = Object.keys(s.disabledTools);
            var defaultNames = Object.keys(TOOL_DEFAULT_DISABLED);
            for (var d = 0; d < defaultNames.length; d++) {
                if (names.indexOf(defaultNames[d]) < 0) names.push(defaultNames[d]);
            }
            var dm = {};
            for (var i = 0; i < names.length; i++) {
                if (api.isToolDisabled(names[i])) dm[names[i]] = { 'external-mcp': true };
            }
            if (typeof reg.deserialize === 'function') {
                try {
                    if (reg.deserialize({ tools: {}, _disabledModules: dm })) return;
                } catch (_) {}
            }
            if (typeof reg.setModuleEnabled === 'function') {
                // 兜底路径按判定结果逐条写（第三个参数是 enabled）：对表里每个键一律写
                // false=禁用，表里一旦出现显式 false 的记录就会把它错误地禁掉
                for (var j = 0; j < names.length; j++) {
                    try {
                        reg.setModuleEnabled(names[j], 'external-mcp', !api.isToolDisabled(names[j]));
                    } catch (_) {}
                }
            }
        },

        // 放行路径 toast 粒度（透明度补偿）：'risky'（默认）/ 'all' / 'off'
        getToastLevel: function () { return ensureLoaded().toastLevel; },
        setToastLevel: function (level) {
            if (['all', 'risky', 'off'].indexOf(level) < 0) return;
            ensureLoaded().toastLevel = level;
            persist();
            notifyListeners({ kind: 'toast', value: level });
        },

        // 档位无关的确认表查询（auto 档高危放行 toast 判定——不看当前档位，
        // 直接查确认表；「若在 balanced 档会弹确认」的操作即高危）
        wouldConfirm: function (toolName, args) {
            return evaluateExternalConfirmation(toolName, args);
        },

        // 外部确认入口：auto 档全部放行（日志留痕）；balanced/conservative 查确认表
        needsConfirmation: function (toolName, args) {
            if (api.effectiveTier() === 'auto') return { confirm: false, reason: '' };
            return evaluateExternalConfirmation(toolName, args);
        },

        onSettingsChange: function (fn) { listeners.push(fn); },

        getSettings: function () {
            var s = ensureLoaded();
            return {
                tier: s.tier,
                groups: JSON.parse(JSON.stringify(s.groups)),
                servers: JSON.parse(JSON.stringify(s.servers)),
                disabledTools: JSON.parse(JSON.stringify(s.disabledTools)),
                toastLevel: s.toastLevel
            };
        }
    };

    global.AEExternal = global.AEExternal || {};
    global.AEExternal.policy = api;
})(window);
