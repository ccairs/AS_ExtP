/**
 * extTools.js — 外部工具投影：组白名单 + per-tool 开关 → tools/list 定义
 *
 * 职责：
 *   组开关（extPolicy，投影层过滤）→ 单点可见性判定 isToolExposed（enabled / per-tool
 *   开关 / scope 外接白名单——投影与执行共用同一判据）→
 *   toolRegistry.get(name) 取定义 → MCP tool def（name/description/inputSchema）
 *
 *   组的成员来源按 TOOL_GROUPS 的声明分三类，投影各走一个分支：
 *     - fixed 组：按 group.fixed 名单逐个取名（名单是源码里的静态清单）；
 * - 网关组（gateway）：mcp_* 动态投影（source==='mcp' 且 enabled），默认关；
 *     - 动态组（group.dynamic）：按注册项 source 与组声明值比对动态取成员，当前只有
 *       ae_tools 组（source==='ae-tools'，即 createAETool 落盘的用户工具），名单运行期可变。
 *   回环防护：serverManager 配置里 command 指向本扩展自身 ext-mcp-server.js 的 server
 *   其工具不投影（防「外部 Agent → 本扩展 → mcp 工具 → 本扩展」无限套娃）。
 */
(function (global) {
    'use strict';

    var LOOP_MARKER = 'ext-mcp-server.js';   // 回环特征：server command 含本标识即拒投影

    function getRegistry() {
        return global.AE_LLM && global.AE_LLM.toolRegistry;
    }

    // 网关回环检测：server 配置的 command/args 是否指向本扩展自身的 ext-mcp-server
    function isLoopServer(serverId) {
        try {
            var sm = global.AE_LLM && global.AE_LLM.serverManager;
            if (!sm || !sm.getServerConfig) return false;
            var cfg = sm.getServerConfig(serverId);
            if (!cfg) return false;
            var cmd = String(cfg.command || '');
            if (cmd.indexOf(LOOP_MARKER) !== -1) return true;
            var args = cfg.args || [];
            for (var i = 0; i < args.length; i++) {
                if (String(args[i]).indexOf(LOOP_MARKER) !== -1) return true;
            }
        } catch (_) {}
        return false;
    }

    // ── 外接 description 覆写表 ──
    // 只放「本通道与面板行为不同」的差异注记。与各模块的共享描述**分开维护**：共享描述讲的是
    // 面板行为，外接差异写进去会污染它——例：comfyui_generate 的「结果会自动发送到对话中……
    // 无需手动查询」对面板正确（面板有 _backgroundPoll 注入会话），对外接是反向指引
    //（该件现在是源头分叉，见下）。
    // 本表另承载**外接专属的作用域限定**（记忆六个入口，见下 MEMORY_SCOPE_NOTE）：
    // 它不是「两侧行为不同」，而是「只对外接成立」——外接 Agent 常身处本扩展代码库，面板侧
    // Agent 不会。放这里而非 L1 的原因：instructions 已 1781/2048，且这条是工具级作用域契约
    //（同层已有 type 枚举等「怎么用这个工具」的约定）。
    // **追加语义**（只追加、不覆写正文），故对 JSON 定义的工具同样有效——如
    // client/seed/ae-tools/ae_tools.json 的 getPreviewFrame 承载不了 buildDescription 函数。
    // 键 = 工具名，与 extPolicy.TOOL_GROUPS 的 fixed 名单一致；一处即可看出某工具有无外接注记。
    // 措辞原则：读者对本站系统一无所知，故不用「外接/本通道」这类需要上下文的词，
    // 一律以「注意：」开头直接陈述可观察差异。
    // comfyui 两件（comfyui_generate / comfyui_run_official_template）改由工具
    // 自身的 buildDescription(reader) 在源头分叉——正文与差异句同源，不再一正一反互相打脸；
    // 本表不再承载它们的注记。新工具 comfyui_run_workflow 同口径自带分叉；
    // comfyui_list_nodes 无送达差异（纯查询），单版描述。
    // 记忆作用域限定：外接 Agent 常在本扩展代码库里工作，L1 第 7 条的
    // 三类门槛原文均无限定词（「本工程约定/结构/进展」「可复用的 API 实测行为」「用户偏好」），
    // 实测被读成「这个代码库的开发约定」，把「改代码前先全局 grep 所有引用」这类与本扩展使用
    // 无关的通用工程规范记进了记忆库。此处按入口收紧作用域：只记操作本扩展与 AE 工程相关
    // 的可复用事实，并把「本扩展代码库的开发规范」显式指回用户规则与仓库文档。
    // 六个记忆入口共用同一句，避免多处漂移；L1 第 7 条保持类别门槛不动（instructions
    // 不再加内容，预算见头注）。
    // 扩到全部六个入口并点明归属：原只挂 create/update，读侧无归属信号——实测外部
    // Agent 在无关会话里先 memory_search 后拟写入。首句写明本库属 AS_ExtP（AE 扩展面板），
    // 未知本站的读者据此即可判断它不服务自己的项目。
    var MEMORY_SCOPE_NOTE = '注意：本记忆库属 AS_ExtP（AE 扩展面板），只记本 AE 工程的约定与进展、本扩展工具的实测与踩坑、用户对本扩展与 AE 工作流的偏好；本扩展代码库的开发规范归用户规则或仓库文档，通用编程经验不记。';

    var EXTERNAL_DESC_NOTES = {
        getPreviewFrame: '注意：截图随结果一并送达为图像块（传 region/zoom 时送达的是裁切放大图，整帧路径在 fullFramePath 或 frames[].filePath），见结果里的 imageAttached 字段；imageAttached=false 表示图片未送达，此时需自行读取 filePath 指向的 PNG。',
        analyzeImage: '注意：传 filePath 时只返回指标、结果不含图像块；不传 filePath（抓帧模式）时结果含图像块，见 imageAttached 字段，指标在 analysis 字段。',
        getShaderPreview: '注意：结果含图像数据可直接分析；图片可能已被转为 JPEG 并按 4096×2160 等比缩小，见结果中的 imageTranscoded 字段。',
        get_render_error: '注意：该结果只反映 AE 宿主的渲染日志（effects/error.log），不反映提交时的编译校验结果；日志为空也可能是尚未触发渲染。',
        shader_library: '注意：mode=save 写入效果库目录后，该文件才可被 AE 中的 AS_Effect Host 效果实例选中渲染。',
        executeExtendScript: '注意：用本工具挂载 AS_Effect Host 效果时，其参数可用参数 matchName 寻址（文件索引 AS_Effect_Host-0210、uniform 槽位 AS_Effect_Host-0(500+4i+c)）；序号形式仅作回退，且索引会随效果库增删整体位移。',
        // Skill 的共享描述末尾写「See <available_skills> in system prompt for details」——
        // 该块由面板 promptBuilder 注入（skill-manager/bootstrap.js 的 hook），外部客户端
        // 收不到；且它有 buildDescription 分叉（skillInjector 以调用方模块裁剪名单），
        // 只改共享正文会连带改掉面板侧的指引。故在此改指到实际可查的入口。
        Skill: '注意：技能详情不在系统提示词中，须用 skill_manager 查询（mode=list 列出全部，mode=get 读取单个，含完整正文）。',
        memory_list: MEMORY_SCOPE_NOTE,
        memory_read: MEMORY_SCOPE_NOTE,
        memory_search: MEMORY_SCOPE_NOTE,
        memory_create: MEMORY_SCOPE_NOTE,
        memory_update: MEMORY_SCOPE_NOTE,
        memory_delete: MEMORY_SCOPE_NOTE,
        // createAETool 的外接差异注记：**创建成功 ≠ 外接可调用**——
        // 未传 scope 时的默认口径由 resolveAeScope 决定（非只读→仅 agent、只读→global），
        // 非只读工具要被外接调用，须在创建时显式声明含 external-mcp 的 scope；只读工具注册为全局，外接可直接调用。
        createAETool: '注意：未显式传 scope 时，只读工具注册为全局（脚本 / Shader / 外接均可调用），非只读工具仅 Agent 可用；要让外接也能调用非只读工具，创建时须传含 external-mcp 的 scope，如 {type:"module",moduleIds:["agent","external-mcp"]}。'
    };

    // 单工具 → MCP tool def（description 取 buildDescription('external-mcp') 或静态 description，
    // 再按覆写表追加外接差异注记）。注意 desc 是局部变量，绝不回写 tool.description——
    // 否则面板通道的描述会被外接注记污染。
    //
    // 【键名必须是 inputSchema（camelCase）】内部注册表沿用
    // `input_schema`（Anthropic 风格，见 toolRegistry.js 的 `parameters: tool.input_schema`），
    // 而 MCP 规范的 Tool 对象要求 `inputSchema`。宽松客户端（curl / 部分 CLI）不做 schema
    // 校验故长期潜伏；ZCode 内置 MCP 客户端严格校验，整份 tools/list 被判无效并逐工具报
    // "Invalid input: expected object, received undefined"。内部格式保持不变，只在本投影层
    // （MCP 边界）改名——这正是本层存在的意义。
    // 外接投影的描述上限：客户端对工具描述有 **2048 字符静默
    // 截断**（无日志、/mcp UI 显示全文）。面板自有的描述实测最长 802、外接投影最长 1462，
    // 但**网关（第三方 MCP）**的描述由对方提供、原样入库（toolDiscovery.js），实测 5000 字符
    // 一路下发到客户端 → 被静默截断，而参数说明常写在尾部。这里在**投影层**显式有界化：
    // 超限时截断并标注原长度（不静默），且**先给尾部注记留位**——注记是指路句，丢了就等于把模型
    // 指去不存在的地方。
    var EXTERNAL_DESC_MAX = 2048;
    function toToolDef(tool) {
        var desc = tool.description || '';
        var descBuildFailed = false;
        if (typeof tool.buildDescription === 'function') {
            try { desc = tool.buildDescription('external-mcp') || desc; }
            catch (e) {
                // 这里若静默吞掉（0 日志、0 兜底）——外接模型会拿到
                // **面板口径**描述，而 comfyui 两件的外接差异已从 EXTERNAL_DESC_NOTES 移出、只剩
                // buildDescription 这一条通路，一抛错就没有任何兜底注记（/mcp UI 仍显示全文，无从察觉）。
                descBuildFailed = true;
                console.warn('[extTools] buildDescription 失败，回退面板描述（外接可能读到不适用的口径）: '
                    + tool.name + ' — ' + (e && e.message ? e.message : e));
            }
        }
        if (descBuildFailed) {
            var caution = '注意：本工具在本通道的差异说明生成失败，实际行为可能与面板不同，以工具返回结果为准。';
            desc = desc ? (desc + '\n' + caution) : caution;
        }
        var note = EXTERNAL_DESC_NOTES[tool.name];
        var budget = EXTERNAL_DESC_MAX - (note ? note.length + 1 : 0);
        if (desc.length > budget) {
            var originalLen = desc.length;
            var marker = '…（描述超长已截断，原 ' + originalLen + ' 字符）';
            desc = desc.slice(0, Math.max(0, budget - marker.length)) + marker;
            console.warn('[extTools] 工具描述超过 ' + EXTERNAL_DESC_MAX + ' 字符上限，已在投影层显式截断: '
                + tool.name + '（原 ' + originalLen + ' 字符）');
        }
        if (note) desc = desc ? (desc + '\n' + note) : note;
        return {
            name: tool.name,
            description: desc,
            inputSchema: tool.input_schema || { type: 'object', properties: {} }
        };
    }

    // 外接作用域闸门（工具抽屉「外接」勾选的唯一消费点；投影与执行共用）。
    // 语义：工具 scope 是「该工具可被哪些模块调用」的白名单，external-mcp 是合法成员之一
    // （view.js 抽屉的「外接」框写入/移除的就是它）——
    //   · scope 缺失（旧工具/未声明）→ 放行：向后兼容，行为与接入本闸门前一致；
    //   · scope.type === 'global'    → 放行：全局工具对所有模块可用；
    //   · scope.type === 'module'    → moduleIds 必须显式含 'external-mcp'，否则外接不投影、
    //     执行也被拒（moduleId 单数形式按 toolRegistry.parseScope 口径折成单项再比）。
    // 缺这条检查时的症状：抽屉里「外接」没勾的工具照样出现在 tools/list，并且能被外部客户端
    // 调用（extBridgeClient 以 scope.moduleIds[0] 原生 moduleId 执行，scope 检查形同虚设）。
    function scopeAllowsExternal(tool) {
        if (!tool || !tool.scope) return true;
        if (tool.scope.type !== 'module') return true;
        var ids = (Array.isArray(tool.scope.moduleIds) && tool.scope.moduleIds.length)
            ? tool.scope.moduleIds
            : (tool.scope.moduleId ? [tool.scope.moduleId] : []);
        for (var i = 0; i < ids.length; i++) {
            if (ids[i] === 'external-mcp') return true;
        }
        return false;
    }

    // 工具对外可见性单点判定（tools/list 投影与 ext_dispatch 执行期校验共用，双门）
    function isToolExposed(toolName) {
        var registry = getRegistry();
        if (!registry) return { exposed: false, error: 'REGISTRY_UNAVAILABLE' };

        var policy = global.AEExternal && global.AEExternal.policy;
        var groupId = policy ? policy.groupOfTool(toolName) : null;
        if (!groupId) return { exposed: false, error: 'NOT_IN_EXTERNAL_WHITELIST' };
        if (!policy.isGroupEnabled(groupId)) return { exposed: false, error: 'TOOL_GROUP_DISABLED' };

        var tool = registry.get(toolName);
        if (!tool) return { exposed: false, error: 'TOOL_NOT_REGISTERED' };
        if (tool.enabled === false) return { exposed: false, error: 'TOOL_DISABLED' };
        // per-tool 对外开关取**并集**（任一判禁即禁）：
        //   · 策略层（policy.isToolDisabled）是真相源——含默认关名单（记忆写四件）
        //     与用户显式记录；
        //   · 注册表镜像（isModuleDisabled + 'external-mcp'）由 applyToolSettings 回放产生，
        //     保持既有调用面（其它模块直写 setModuleEnabled 的排除项）不变。
        // 只查镜像会让「默认关」在回放窗口内失效（投影先于 applyToolSettings 执行时漏一档），
        // 只查策略层则会漏掉非 extPolicy 来源的禁用记录。
        if (typeof policy.isToolDisabled === 'function' && policy.isToolDisabled(toolName)) {
            return { exposed: false, error: 'TOOL_DISABLED_FOR_EXTERNAL' };
        }
        if (registry.isModuleDisabled && registry.isModuleDisabled(toolName, 'external-mcp')) {
            return { exposed: false, error: 'TOOL_DISABLED_FOR_EXTERNAL' };
        }
        // 工具抽屉「外接」勾选：scope 白名单未显式收录 external-mcp 即拒（投影与执行同一判据）
        if (!scopeAllowsExternal(tool)) {
            return { exposed: false, error: 'TOOL_SCOPE_EXCLUDES_EXTERNAL' };
        }
        if (tool.source === 'mcp') {
            // 网关工具三道门：回环防护 → per-server 开关（双默认关第二道）
            if (isLoopServer(tool.serverId)) return { exposed: false, error: 'GATEWAY_LOOP_REJECTED' };
            if (policy.isServerEnabled && !policy.isServerEnabled(tool.serverId)) {
                return { exposed: false, error: 'SERVER_DISABLED' };
            }
        }
        return { exposed: true };
    }

    // 动态组成员枚举（配置态）：只按「本源 + 归属」判定，不过滤 enabled / per-tool 开关——
    // UI 要给被禁用的成员画勾选框，故过滤留给投影层（buildExternalToolDefs）做。
    // 归属判定复用 extPolicy.groupOfTool（唯一实现），因此三条排除规则（既有 fixed 名单 /
    // 工具管理面元工具 / mcp_ 前缀）在这里自动生效；本文件不得按固定字面量（如
    // source === 'ae-tools'）或名字黑名单另写一份判据——判据复制成两份就是两个真相源。
    function listDynamicGroupTools(groupId) {
        var registry = getRegistry();
        var policy = global.AEExternal && global.AEExternal.policy;
        if (!registry || !policy || typeof registry.getAll !== 'function') return [];
        if (typeof policy.groupOfTool !== 'function') return [];
        var group = policy.TOOL_GROUPS && policy.TOOL_GROUPS[groupId];
        if (!group || !group.dynamic) return [];
        var out = [];
        var all = registry.getAll();
        for (var i = 0; i < all.length; i++) {
            var t = all[i];
            // 冗余预筛：与组声明值（而非硬编码字面量）比对，不是本文件自造的判据副本。
            // groupOfTool 命中已蕴含 source === group.dynamic（isDynamicGroupMember 末位
            // 判据），故当前调用路径下恒不命中、单独删它 0 FAIL；留着是为了不依赖调用方
            // 顺序与外部实现：实测把 isDynamicGroupMember 末位判据脱成 `return !!tool` 后，
            // 异源工具正是被这一行挡在枚举外的（此时删掉它才报红）。不要删。
            if (!t || t.source !== group.dynamic) continue;
            if (policy.groupOfTool(t.name) !== groupId) continue;
            out.push(t);
        }
        return out;
    }

    // tools/list 全量投影。过滤统一走 isToolExposed（投影与执行共用的单点判据）：
    // 投影若另抄一份子集（enabled + per-tool 开关），后加的闸门（如 scope 外接检查）
    // 只落在执行侧 → 投影照列、调用才拒（view.js 抽屉注释点名的「列着但一调就拒」形态）。
    // 现在三支成员枚举（fixed / gateway / dynamic）全部经同一判据，闸门新增即两侧同时生效。
    function buildExternalToolDefs() {
        var registry = getRegistry();
        var policy = global.AEExternal && global.AEExternal.policy;
        if (!registry || !policy) return [];

        var defs = [];
        var groupIds = Object.keys(policy.TOOL_GROUPS);

        for (var i = 0; i < groupIds.length; i++) {
            var groupId = groupIds[i];
            var group = policy.TOOL_GROUPS[groupId];
            if (!policy.isGroupEnabled(groupId)) continue;

            if (group.gateway) {
                // 网关组：mcp_* 动态投影（source==='mcp' + enabled + per-tool 开关 + 回环防护 + per-server 开关）
                var all = registry.getAll();
                for (var k = 0; k < all.length; k++) {
                    var t = all[k];
                    if (t.source !== 'mcp' || t.name.indexOf('mcp_') !== 0) continue;
                    if (!isToolExposed(t.name).exposed) continue;
                    defs.push(toToolDef(registry.get(t.name) || t));
                }
            } else if (group.dynamic) {
                // 自定义 AE 工具：按 source 动态投影。归属/去重/元工具排除全部由
                // groupOfTool 单点决定（见 listDynamicGroupTools）；可见性过滤统一走 isToolExposed
                var members = listDynamicGroupTools(groupId);
                for (var m = 0; m < members.length; m++) {
                    if (!isToolExposed(members[m].name).exposed) continue;
                    defs.push(toToolDef(members[m]));
                }
            } else {
                for (var j = 0; j < group.fixed.length; j++) {
                    var name = group.fixed[j];
                    // 未注册/被禁用/被外接开关或 scope 拒绝：静默跳过（清单收缩，与既有语义一致）
                    if (!registry.get(name)) continue;
                    if (!isToolExposed(name).exposed) continue;
                    defs.push(toToolDef(registry.get(name)));
                }
            }
        }
        return defs;
    }

    global.AEExternal = global.AEExternal || {};
    global.AEExternal.tools = {
        buildExternalToolDefs: buildExternalToolDefs,
        listDynamicGroupTools: listDynamicGroupTools,
        isToolExposed: isToolExposed,
        // 覆写表对外暴露供测试遍历（防键名笔误导致注记静默不生效）
        EXTERNAL_DESC_NOTES: EXTERNAL_DESC_NOTES
    };
})(window);
