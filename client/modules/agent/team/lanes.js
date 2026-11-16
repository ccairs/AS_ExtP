(function (global) {
    'use strict';
    // 团队模式的四条 lane 定义。本文件是 lane 的**单一事实源**：
    // toolSet（工具身份集合 + 收窄判据）、laneKey（AE 快照身份）、提示词段、slot（执行槽位）。
    //
    // 三条硬约束：
    //  ① 工具身份是**集合**（moduleIds），不给 lane 新造 moduleId——新造会打断 AE 快照的
    //     scope 合法性（aeContext.gather → toolExecutor.checkAccess 按 moduleId 精确匹配 ⇒ 快照恒空）。
    //     集合的成员可以增减（如 glsl 用 [shader,team]），但成员必须是注册表里**已存在**的
    //     moduleId，且由该 lane 的收窄判据把放行面收回到白名单（见 shaderLaneToolFilter）。
    //  ② **快照身份（laneKey）与工具身份（moduleIds）分离**：laneKey 只做 aeContext 的缓存分槽，
    //     绝不参与 scope 判定；两者混用就是上面那条故障。
    //  ③ 收窄判据只用两条并用，且必须是**同一个函数对象**交给投放侧与执行侧（同源判据）：
    //     · 显式名单：重操作工具（唯一可靠的标注——renderComp 在 seed 里没有 readOnly 字段）；
    //     · 元数据兜底：source === 'ae-tools' && readOnly !== true（覆盖用户自建写工具）。
    //     判据语义是「真值才收」（fail-closed）：返回假值/undefined 一律视为拒绝。
    //
    // 温度维度不实施：lane 参数只有 model / platform / reasoningEffort。
    // 「导演发散 / 执行收敛」由本文件的 promptSection + 收窄判据承担。

    // 重操作名单：会改工程 / 会渲染 / 会增删工具 / 会撤销别人操作的工具。
    var DENY_TOOLS = {
        executeExtendScript: true,
        renderComp: true,
        createAETool: true,
        deleteAETool: true,
        undoLastOperation: true
    };

    // 计划工具（trackSteps / getPlanStatus / updatePlan）**不再从 lane 的投放清单里剔除**：
    // 每个 Agent 自己的 todo 计划工具要保留，不然会产生一定的问题。
    // 若在此统一剔除这三件（理由是「团队模式下计划没有渲染面」），lane 就没有
    // 逐步推进的载体，模型会把细碎步骤塞进共用清单去覆盖别人。现在：
    //   · 这三件 = 本 Agent 自己的 todo（controller 里两种形态都注册；lane 形态的 scope 是
    //     ['agent','team']（controller 的 planScope）——glsl 靠 team 身份拿到，不需要把 'shader'
    //     写进 scope）；
    //   · updateTeamTasks = 各条 Agent 共用的团队任务清单。
    // 计划页签与团队任务并列（teamUI 的路由：团队模式下「计划 | 团队任务」）。

    // 导演的基础判据（不含 ComfyUI 归属）：重操作名单 + AE 写工具元数据兜底。
    // 单独拆出是因为导演与美术两条 lane 的差异只在 ComfyUI：导演不给（
    // 素材生成归美术），美术给。两处共用同一份基础判据，避免 DENY_TOOLS / ae-tools 元数据
    // 兜底各抄一份而漂移。
    function directorBaseFilter(entry) {
        if (!entry || !entry.name) return false;
        if (DENY_TOOLS[entry.name] === true) return false;
        if (entry.source === 'ae-tools' && entry.readOnly !== true) return false;
        return true;
    }

    // 导演的收窄判据。engine/controller 的 toolSet.filter 直接吃这个函数。
    // 团队模式的素材生成只归美术 lane，导演也不给 ComfyUI 工具
    //（单 Agent 的 Agent 模式没有 lane 身份、不走本判据 ⇒ 那批工具照旧在）。
    function directorToolFilter(entry) {
        if (directorBaseFilter(entry) !== true) return false;
        if (entry.source === 'comfyui') return false;
        return true;
    }

    // 执行 lane 的收窄判据：排除 goal 三工具、提问工具与 ComfyUI 模块工具，其余照旧放行
    //（DENY_TOOLS 那条重操作表仍由 controller 的工具身份与权限档把关，导演那条 filter 也照旧生效）。
    // 为什么要排除 goal：goal 只在单 Agent 通道与导演 lane 生效，执行 lane
    // 拿到工具只会有「设了目标却不会续轮」的错觉。名字表与 engine/goalTools.js 的定义同源
    //（那边是唯一注册面），这里只做收窄、不注册。
    // 为什么要排除 ComfyUI：团队模式的素材生成**只**归美术 lane
    // （asset-gen 的职责与唯一工具面），AE 执行与导演都不给——同一批工具散在多条 lane 上会出现
    // 多条 lane 都能生图。判据按 **source**（工具来源模块）而不是八个名字的清单——comfyui 模块
    // 增删工具时这里不用跟着改。单 Agent（Agent 模式）没有 lane 身份、不走本判据 ⇒ 那批工具
    // 照旧在（用户明确要求保留）。
    var GOAL_TOOL_NAMES = { get_goal: true, create_goal: true, update_goal: true };

    // 提问工具 askUser 只给导演 lane：执行 lane 没有「问用户」的
    // 职责，拿到它只会得到一件一调就回 unavailable 的工具。名字唯一源在
    // engine/askUserTool.js（晚于本文件加载 ⇒ 运行时取，兜底同名字面量；与
    // _subagentToolNames 的兜底同一口径）。
    function _askUserToolName() {
        var api = global.AEEngine && global.AEEngine.askUserTool;
        return (api && typeof api.NAME === 'string' && api.NAME) ? api.NAME : 'askUser';
    }

    function execLaneToolFilter(entry) {
        if (!entry) return true;
        if (GOAL_TOOL_NAMES[entry.name] === true) return false;
        if (entry.name === _askUserToolName()) return false;
        if (entry.source === 'comfyui') return false;
        return true;
    }

    // Shader 执行 lane 的工具面 = [shader, team] 两个身份带来的工具（scope 含 shader 或 team、
    // 或 global），与单 Agent 的 Shader 档同面；AE 工具（source='ae-tools'）整类不进。
    // 为什么连 AE 只读查询也剔：本 lane 写 GLSL，工程结构与画面参考由派单给出；查询族
    // （queryProject / queryDetails 等）的 schema 体积远大于本 lane 其余工具之和，留在投放面里
    // 每轮固定开销翻倍。
    // 判据只做收窄、不注册工具：新增 shader/team 域工具自动进入，新增 AE 工具自动被拒。
    function shaderLaneToolFilter(entry) {
        if (!entry || typeof entry.name !== 'string' || !entry.name) return false;
        if (execLaneToolFilter(entry) !== true) return false;
        // AE 工具整类拒（含只读查询）：用户/LLM 用 createAETool 建的 global 作用域 AE 工具同样拦下。
        if (entry.source === 'ae-tools') return false;
        var sc = entry.scope;
        if (sc && sc.type === 'global') return true;
        // scope 不是 module/global（注册表条目恒有 scope——parseScope 缺省 global）：fail-closed。
        if (!sc || sc.type !== 'module') return false;
        var ids = (Array.isArray(sc.moduleIds) && sc.moduleIds.length)
            ? sc.moduleIds : (sc.moduleId ? [sc.moduleId] : []);
        return ids.indexOf('shader') >= 0 || ids.indexOf('team') >= 0;
    }

    // 美术 lane 的收窄判据 = 导演的**基础判据**（重操作名单 + AE 写工具元数据兜底）之上的再收窄：
    // 排除 goal 三工具、提问工具、写代码链路工具（ASSET_GEN_DENY_NAMES），以及 AE 工具整类。
    // 注意基座用 directorBaseFilter 而**不是** directorToolFilter：后者剔除 ComfyUI（导演不给），
    // 而美术 lane 正是团队模式里 ComfyUI 的唯一归属。
    // AE 工具整类不进（含只读查询）：本 lane 不改 AE 工程、不渲染、不导入素材到 AE；
    // 参考画面用派单里写明的文件路径。注意射程——`comfyui_generate` 的 `image_source=current_frame`
    // 是 ComfyUI 工具自身的参数（handler 直接抓帧，不经 AE 工具闸口），不在本判据范围内。
    // 判据语义是「真值才收」（fail-closed）。
    // 美术 lane 不需要的 agent 域工具：queryAeApi 服务「写 ExtendScript 前查 API 签名」，
    // propose_table_entry 服务「AST 门补表」——两者只活在写代码链路，而美术 lane 不写 AE 代码
    //（边界见 ASSET_GEN_PROMPT：不改工程、不渲染、不导入）。
    // 只能按名字收窄：两件都是 source='agent' 的 utility 工具，scope 含 'agent'
    //（queryAeApi = ['agent','script','external-mcp']、propose_table_entry = ['agent','script']），
    // 与导演/执行 lane 共用同一身份，scope 与 source 判据都区分不出来。
    // 增删按名字改这一处（与 GOAL_TOOL_NAMES / askUser 同一口径：lane 只做收窄、不注册工具）。
    var ASSET_GEN_DENY_NAMES = { queryAeApi: true, propose_table_entry: true };

    function assetGenToolFilter(entry) {
        if (directorBaseFilter(entry) !== true) return false;
        // AE 工具整类拒（含只读查询）：全局 scope 的 AE 工具同样拦下。
        if (entry.source === 'ae-tools') return false;
        if (GOAL_TOOL_NAMES[entry.name] === true) return false;
        if (entry.name === _askUserToolName()) return false;
        if (ASSET_GEN_DENY_NAMES[entry.name] === true) return false;
        return true;
    }

    // 两份清单的分工：每个 Agent **既有自己的 todo**，又有团队共用的
    // 那份。为什么必须在角色段里说清楚：不写的话模型会二选一——要么不用自己的 todo（步骤全丢），
    // 要么把细碎步骤塞进共用清单覆盖别人。系统骨架的「规划」那行讲的是自己的 todo（trackSteps），
    // 团队那行讲的是共用清单（updateTeamTasks）。
    // 本段只保留**分工**与**add/set_status/replace 的差别**
    //（后者是各条角色段里唯一防覆盖的约束）；完整协作流程住在 `updateTeamTasks` 的工具描述里，
    // 不在角色段复述（同一件事不说两遍）。
    // 共用份数不写死数字——增删 lane 时「三条」会立刻变成错误事实。
    var TEAM_TASKS_LINE = '两份清单分工不同。自己的步骤用 trackSteps / getPlanStatus / updatePlan 维护，'
        + '只影响本 Agent 的计划，显示在侧栏「计划」页签。跨 Agent 的协作条目用 updateTeamTasks 维护，'
        + '各条 Agent 共用一份，显示在「团队任务」面板：只加自己的条目用 action=add，'
        + '只改状态用 action=set_status，action=replace 是整表替换、会覆盖别人的条目。'
        + '细碎执行步骤写进自己的 todo，不写进团队清单。';

    // 角色段的写作尺子（只写事实 / 删修辞 / 不写不可计数的数字 /
    // 可推出的不写 / 每条约束可直接执行）。
    //   ① 导演段原写「不要空谈风格词汇，落到具体的图层结构、时长/帧数、颜色与节奏、参数取值」——
    //      把**执行侧的技术取值**列成导演的产出标准，等于让创意总监去当技术（职责越界）。
    //      导演的"具体"标准改成「执行 Agent 能直接动手、不必回头问方向」。
    //   ② 该段整条删除：导演本来就**没有**那批工具，工具面已经说明
    //      「这些调不到/会被拒」，再写一遍是**可由前文推出的重复**。产出定义（计划书）保留。
    //   ③ 各段一律去加粗、去修辞破折号、去装饰性数字。

    // 角色段只写角色契约：职责 / 产出 / 边界 / 协作分工（TEAM_TASKS_LINE）。
    // 通用行为（先问关键问题、最小改动、性能提醒等）不写角色段——
    // 由模型自身承担；领域技巧可沉淀为技能/记忆，不常驻。
    // ── 提示词里点名工具的句子 ──────────────────────────
    // 用户可按视图关闭/放宽工具：被点名工具在本视图不可见时，句子必须随之消失，否则模型会去
    // 调看不见的工具。本文件是角色段的单一事实源，故「句子 → 依赖工具」的声明也写在这里
    // （PROMPT_TOOL_DEPS），可见性由调用方谓词现算——**lanes.js 不认识闸口对象，只按名字问**。
    // 片段常量同时用于拼原文（默认逐字不变）与按可见性重组，正文只此一份。
    // 导演：目标句含 create_goal（建目标）与 update_goal（恢复目标）两个可独立裁剪的片段。
    var DIRECTOR_GOAL_CREATE = '目标：接到任务后、动手前先用 create_goal 建本会话目标，写清交付物与验收判据；';
    var DIRECTOR_GOAL_RESUME = '任务中断后目标会停用续轮，用户说继续时用 update_goal action=resume 恢复。';
    var DIRECTOR_GOAL_LINE = DIRECTOR_GOAL_CREATE + DIRECTOR_GOAL_RESUME;
    // AE 执行：出片句点名 renderComp。
    var AE_EXEC_RENDER_LINE = '出片：全部阶段落地完成后先把工程交给导演验收，等导演确认通过再调 renderComp 出片；未通过不渲染。';

    var DIRECTOR_PROMPT = [
        '【你的角色：创意总监 / 导演】',
        '职责：把用户需求转成可执行的创意方案，覆盖平面、动画、效果三条线。',
        // 效果线：GLSL 产出在 AE 里能当效果用。
        // 事实源：guideContent.js 的效果挂载三条（matchName AS_Effect_Host、文件索引 + uniform 槽位、
        // 多实例）与 shaderTools.js 的 shader_library 描述（不入效果库的文件宿主选不到）。
        '效果线：Shader 执行的 GLSL 产出存入效果库后，由 AE 执行以 AS_Effect Host 效果实例挂到图层，'
            + '效果参数在效果控件里可调。',
        // 分镜从计划书剥离，文字分镜单独成文件。
        '产出：计划书，写进工作区 brief.md；含目标、创意方向与选定理由、交付物清单、依赖与顺序、验收判据。',
        '文字分镜：单独写进工作区 storyboard.md；按镜头顺序写镜头列表与每镜画面内容。'
            + '运镜与节奏在定帧确认后补入。',
        '方案要求：给出多个候选方向并说明差异与代价，选定一个。方向要写到执行 Agent 能直接动手，'
            + '不必回头问方向。',
        // 交付分两阶段——先平面定帧，定帧确认通过后才设计动画。
        // 定帧未确认就排动画会白做，故闸写成「确认前不设计、不派发」。
        // 确认动作以 AE 执行回报为前提（回投已下线，不回报就不知道落地了）；
        // 运镜与节奏（动画设计内容）确认后才补进 storyboard.md，执行侧动画阶段从那里读。
        '流程：分两阶段，派单时写明阶段。第一阶段按文字分镜设计平面定帧（静态画面），派给 AE 执行落地；'
            + 'AE 执行回报后你核对定帧预览，确认通过后才设计动画并派给 AE 执行实现。'
            + '定帧确认前不设计、不派发动画。',
        // 出片前先交付工程给导演验收，通过才渲染（未通过的渲染不出片）。
        // 验收是两阶段全部落地后的终验（定帧确认是中间闸，不是出片验收）。
        '验收：全部阶段落地后交你验收，你核对工程与预览帧后给出通过或需改项；通过后才渲染出片。',
        // 开工先设目标：任务中断（面板重载/切会话/停止）后靠目标续上。
        // 团队档用户默认就在跟导演说话（当前 lane 默认 = 导演）⇒ 建目标落在 user 轮，权限天然成立。
        DIRECTOR_GOAL_LINE,
        TEAM_TASKS_LINE
    ].join('\n');

    var AE_EXEC_PROMPT = [
        '【你的角色：AE 执行工程师】',
        '职责：把导演的计划书落地到 After Effects。建图层、改属性、跑脚本、渲染、导入导出。',
        '回报：改了哪些对象、产物在哪、如何验证（帧数、时长、路径），以及未完成或存疑的部分。',
        '边界：不重新设计创意方向。计划书与实现冲突时按可实现的方式落地，并在回报里写明偏离与原因。',
        // 按导演派单的阶段执行；平面定帧未获确认前不加动画。
        '流程：按派单写明的阶段执行。平面定帧阶段只实现静态画面，完成后交导演确认；'
            + '未获确认前不加动画。动画阶段按导演的动画设计实现。',
        // Shader 产出要挂成 AE 效果。挂载配方不能只留在外接面
        // （guideContent.js:121 / external-guidelines.js:96），面板 Agent 没有可见来源；
        // 这三条是 host 的硬约束：matchName 文件索引 + 写索引会重置槽位（分两次调用）。
        '挂载 Shader 效果：给图层加 AS_Effect Host 实例，先写 Shader 执行给出的文件索引'
            + '（matchName AS_Effect_Host-0210），再写 uniform 槽位值；写索引会把槽位重置为默认值，两次分开调用。',
        // 没有导演批准不允许渲染出片（先交工程，通过才调 renderComp）。
        // 出片是两阶段全部落地后的终验（定帧确认不等于批准出片）。
        // 不点名 send_message：本段也会进子 Agent（bootstrap 把父 lane 当 ctx.lane 下发），而子 Agent
        // 没有发消息工具——点它就会指着一件调不到的工具（同「导演骨架不写 executeExtendScript」的口径）。
        AE_EXEC_RENDER_LINE,
        TEAM_TASKS_LINE
    ].join('\n');

    var GLSL_PROMPT = [
        '【你的角色：Shader 执行】',
        '职责：把导演的效果设计落地为可编译、可调参的 GLSL 片段着色器。',
        '产出：着色器代码、参数说明（取值范围与视觉影响）、已知限制、接入方式。',
        '边界：需要素材或渲染时在回报里说明。',
        '你与 AE 执行可并行工作，接入点需对齐。',
        TEAM_TASKS_LINE
    ].join('\n');

    // 美术 lane 的角色段（第四条常驻 Agent，专职调用 ComfyUI 工具）。
    // 写作边界（用户明确工具后续会更新）：本段**不写任何工具名、模型名与参数细节**——工具面由
    // moduleIds + filter 表达（ComfyUI 九件的 scope 含 'agent'）；
    // 提示词只写职责/产出/回报口径，工具换了提示词不用跟着改。
    var ASSET_GEN_PROMPT = [
        '【你的角色：美术执行】',
        '职责：按导演派单生成图像或视频素材。画面内容、风格、尺寸、时长、数量以派单为准；'
            + '派单没写清且影响结果的项，先用团队消息问发起方。',
        '输入：派单摘要为主。需要更多上下文时读工作区的计划书与文字分镜；'
            + '需要参考画面时以派单里写明的路径为准。',
        '产出：素材文件。路径、所用模型、任务标识与数量以生成回执为准。',
        // 产物默认落 temp（会被回收）；转存为本项目资产是**按需**行为——全部转存等于
        // 把资产库变成第二份 temp，所以把取舍判据写进角色段，不靠模型猜。
        '资产：生成产物默认在 temp，会被定期清理。判断需要长期保留的（派单要求保留的、已定稿的、'
            + '后续还要交给 AE 使用或复用的），存成本项目资产（当前 AE 工程旁的资产库）；不要全部存。'
            + '资产库里不再需要或要清理的旧资产，从资产库移出（移回 temp，由 temp 回收）。'
            + '转存与移出的结果路径写进回报。资产库依附当前 AE 工程，工程未保存时先提示保存，不要绕路。'
            + '转存/移出可能需用户确认，确认被拒或超时按未执行处理，不要反复重试。',
        // 异步生成的产品事实（提交即返回、后台轮询完成后注入新一轮）：不写会导致模型在原地同步等待
        // 或反复查询同一任务，白烧轮次。
        '异步：提交生成任务后立即返回，本轮结束；结果由后台轮询在完成时注入新一轮。'
            + '提交后不要同步等待，也不要反复查询同一个任务。',
        // 回投已下线：结论只能靠这条路回到发起方，故写明「收件人取派单里写明的那位」。
        // 不点名 send_message：角色段也会随父 lane 下发到下层 Agent，而它们没有发消息工具
        //（同 AE_EXEC_PROMPT 的既有约定）。
        '回报：每次派单完成后把结果发回发起方（用团队消息，收件人取派单里写明的那位）：'
            + '产物路径、所用模型、任务标识、数量、未完成或存疑的部分。结论不留在自己的对话里。',
        '边界：不改 AE 工程、不渲染、不导入素材到 AE。素材进入 AE 由 AE 执行负责。',
        '流程：按导演派单生成，不重新设计创意方向。派单与实现冲突时按可实现的方式生成，'
            + '并在回报里写明偏离与原因。',
        // 停止语义（真机事实）：停止本条 Agent 只停工具循环，不中止已提交的后台生成任务。
        '停止：停止本条 Agent 不会中止已经提交的生成任务；任务完成后的结果仍会回来。',
        // 云端模型确认（permissions.js 的 comfyui_generate 云端分支）：auto 权限档不弹卡、
        // 可勾选会话豁免、确认超时 0 表示不超时——故只写「可能需要确认」与「确认前不重复提交」。
        '云端模型：使用云端模型生成可能需要用户确认，确认前不要重复提交；'
            + '确认超时按拒绝处理，不要反复重试。',
        TEAM_TASKS_LINE
    ].join('\n');

    // lane 集合是**封闭**的，顺序即 UI 上的展示顺序。
    // slot 与 promptKind 的分工：
    //   · slot       = **执行槽位**，钉 runtimeMode（agent/shader）⇒ 决定会话文件域、上下文槽、
    //                  轮次语义与工具身份解析。改它动的是运行语义。
    //   · promptKind = **提示词骨架选择器**，只决定 system prompt 用哪份骨架
    //                  （director / agent / shader / asset）。改它只动文本。
    // 导演的 slot 仍是 agent（运行语义不变），promptKind 是 director —— 他拿不到 AE 写工具，
    // 套执行者骨架（AE 关键数值 / 按 index 定位对象的工作流 / executeExtendScript 主操作入口 /
    // 工具沉淀）会指着调一件调不到的工具。选择器住 lanes.js（lane 的单一事实源），
    // 由 bootstrap 随 lane 身份下发、controller 消费；**不在 controller 里写 lane id 字面量**。
    // 美术同款取舍：slot=agent（会话域/轮次语义与执行者一致），promptKind=asset（独立骨架）。
    // label / shortLabel 是**显示名**：用取值器按当前语言翻译，不在模块加载期固化成某个语言的快照。
    // 契约：读取点每次拿到的都是当前 locale 的串；运行中切换语言后下一次重绘即生效。
    // （模块加载期 t() 的写法会把首次加载时的语言冻结在 lane 定义里，切换语言后不刷新。）
    var LANES = [
        {
            id: 'director',
            get label() { return AEI18n.t('导演'); },
            get shortLabel() { return AEI18n.t('导演'); },
            slot: 'agent',                 // 执行槽位：决定 runtimeMode 语义与提示词骨架
            promptKind: 'director',        // 提示词骨架：导演专用（不套执行者骨架）
            laneKey: 'director',           // AE 快照身份（只做缓存分槽）
            moduleIds: ['agent', 'team'],  // 工具身份集合
            filter: directorToolFilter,
            role: '创意总监',
            promptSection: DIRECTOR_PROMPT,
            containerId: 'aeAgentLane_director'
        },
        {
            id: 'ae-exec',
            get label() { return AEI18n.t('AE 执行'); },
            get shortLabel() { return AEI18n.t('执行'); },
            slot: 'agent',
            promptKind: 'agent',
            laneKey: 'ae-exec',
            moduleIds: ['agent', 'team'],
            filter: execLaneToolFilter,
            role: 'AE 执行',
            promptSection: AE_EXEC_PROMPT,
            containerId: 'aeAgentLane_ae-exec'
        },
        {
            id: 'glsl',
            get label() { return AEI18n.t('Shader 执行'); },
            shortLabel: 'Shader',
            slot: 'shader',
            promptKind: 'shader',
            laneKey: 'glsl',
            // 工具身份 = shader + team：与单 Agent 的 Shader 档同面（shader 域工具 + global），
            // 另加 team 域的协作件。AE 域工具（含只读查询）不进身份集合；'shader' 保持在首位
            //（toolExecutor 的 handler 契约取首项做单串 moduleId，handler 看到的仍是 'shader'）。
            moduleIds: ['shader', 'team'],
            filter: shaderLaneToolFilter,
            role: 'Shader 执行',
            promptSection: GLSL_PROMPT,
            containerId: 'aeAgentLane_glsl'
        },
        {
            id: 'asset-gen',
            get label() { return AEI18n.t('美术执行'); },
            get shortLabel() { return AEI18n.t('美术执行'); },
            slot: 'agent',
            promptKind: 'asset',
            laneKey: 'asset-gen',
            moduleIds: ['agent', 'team'],
            filter: assetGenToolFilter,
            role: '美术执行',
            promptSection: ASSET_GEN_PROMPT,
            containerId: 'aeAgentLane_asset-gen'
        }
    ];

    var LANE_IDS = [];
    for (var _i = 0; _i < LANES.length; _i++) LANE_IDS.push(LANES[_i].id);

    function list() {
        // 返回副本：调用方（UI / orchestrator）不得就地改 lane 定义
        var out = [];
        for (var i = 0; i < LANES.length; i++) {
            var l = LANES[i];
            out.push({
                id: l.id,
                label: l.label,
                shortLabel: l.shortLabel,
                slot: l.slot,
                promptKind: l.promptKind,
                laneKey: l.laneKey,
                moduleIds: l.moduleIds.slice(),
                filter: l.filter,
                role: l.role,
                promptSection: l.promptSection,
                containerId: l.containerId
            });
        }
        return out;
    }

    function get(id) {
        for (var i = 0; i < LANES.length; i++) {
            if (LANES[i].id === id) return LANES[i];
        }
        return null;
    }

    // 四条 lane 的消息容器 id（bootstrap 的链接委托、main.js 的宽度锁/滚动都按此遍历）
    function listIds() {
        var ids = [];
        for (var i = 0; i < LANES.length; i++) ids.push(LANES[i].containerId);
        return ids;
    }

    // 消息列表 id（与容器 id 分开：容器是外层壳，消息列表是滚动区）
    function listMessageIds() {
        var ids = [];
        for (var i = 0; i < LANES.length; i++) ids.push('aeAgentMessageList_' + LANES[i].id);
        return ids;
    }

    // 句子 → 依赖工具：只声明「哪句点名了哪些工具」，不复制工具清单。
    // build(isVisible) 返回落进角色段的文本，null = 整句裁掉；只在调用方给了谓词时才用。
    // 导演目标句的两个片段可独立裁剪：create_goal（建目标）与 update_goal（恢复目标）。
    var PROMPT_TOOL_DEPS = {
        director: [{
            line: DIRECTOR_GOAL_LINE,
            build: function (isVisible) {
                var canCreate = isVisible('create_goal') !== false;
                var canResume = isVisible('update_goal') !== false;
                if (canCreate && canResume) return DIRECTOR_GOAL_LINE;
                // 只留建目标：原句尾是分号（后接恢复句），裁掉后半段后改句号，避免悬挂标点
                if (canCreate) return DIRECTOR_GOAL_CREATE.replace(/；$/, '。');
                if (canResume) return DIRECTOR_GOAL_RESUME;
                return null;
            }
        }],
        'ae-exec': [{
            line: AE_EXEC_RENDER_LINE,
            build: function (isVisible) {
                return isVisible('renderComp') !== false ? AE_EXEC_RENDER_LINE : null;
            }
        }]
    };

    function _applyPromptToolDeps(section, deps, isToolVisible) {
        var out = section;
        for (var i = 0; i < deps.length; i++) {
            var dep = deps[i];
            if (out.indexOf(dep.line) < 0) continue;
            var next;
            // 谓词抛错不裁剪（fail-safe：宁可多一句，不让提示词被半截拼装）
            try { next = dep.build(isToolVisible); } catch (_) { next = dep.line; }
            if (next == null) {
                out = out.split(dep.line + '\n').join('');
                if (out.indexOf(dep.line) >= 0) out = out.split(dep.line).join('');
            } else if (next !== dep.line) {
                out = out.split(dep.line).join(next);
            }
        }
        return out;
    }

    // 按当前视图可见性返回角色段：谓词缺席 ⇒ **原文逐字**（默认等价的硬要求）。
    // 谓词语义：isToolVisible(name) 返回该工具在当前视图是否可见（controller 用当前轮闸口构造，
    // 子 Agent 用派生时冻结的闸口实例）。lanes.js 不认识闸口对象，只按工具名问。
    function promptSectionFor(laneId, isToolVisible) {
        var def = get(laneId);
        if (!def || typeof def.promptSection !== 'string') return '';
        if (typeof isToolVisible !== 'function') return def.promptSection;
        var deps = PROMPT_TOOL_DEPS[laneId];
        if (!deps || !deps.length) return def.promptSection;
        return _applyPromptToolDeps(def.promptSection, deps, isToolVisible);
    }

    // 一体的 DOM id 组（createView({dom}) 直接吃）：单 Agent 路径的缺省值在 view.js 里，
    // 这里只给 lane 的值。
    // 状态三键指向**共用栏**（index.html 的单例 #aeAgentStatusPanel / #status /
    // #aeAgentInlineStatus）：状态栏复用一条——lane 内不再各带一条
    // 一模一样的 44px 顶栏（那是「提示栏多出一条」的来源）。写这条栏的同一时刻只有一个 lane
    // （当前 lane）：非当前 lane 的 setBusy 由 view.js 的 sharedStatus 闸门挡下，
    // 切 lane 时 bootstrap 的 onCurrentLaneChange 调 view.replayBusy() 把新当前 lane 的忙态
    // 重放到这条栏上——否则隐藏 lane 的文案会盖掉用户正在看的那条。
    // 用量行仍按 lane 分开（顶栏那行是当前 lane 的镜像，见 index.js 的 _syncTokenRowToLane）。
    function domFor(id) {
        return {
            listId: 'aeAgentMessageList_' + id,
            statusId: 'status',
            inlineStatusId: 'aeAgentInlineStatus',
            statusPanelId: 'aeAgentStatusPanel',
            tokenStatsId: 'aeAgentTokenStats_' + id
        };
    }

    global.AEAgentTeam = global.AEAgentTeam || {};
    global.AEAgentTeam.lanes = {
        ids: LANE_IDS.slice(),
        list: list,
        get: get,
        listIds: listIds,
        listMessageIds: listMessageIds,
        domFor: domFor,
        directorToolFilter: directorToolFilter,
        // 执行 lane（ae-exec）的收窄判据：排除 goal 三工具、提问工具与 ComfyUI 模块工具
        execLaneToolFilter: execLaneToolFilter,
        // Shader 执行 lane 的收窄判据：执行 lane 判据 + 只认 shader/team/global 身份，AE 工具整类拒
        shaderLaneToolFilter: shaderLaneToolFilter,
        // 美术 lane 的收窄判据：导演基础判据之上再排除 goal 三工具、提问工具与
        // ASSET_GEN_DENY_NAMES 里的写代码链路工具
        assetGenToolFilter: assetGenToolFilter,
        // 角色段按视图可见性组装（句子 → 依赖工具声明见 PROMPT_TOOL_DEPS）
        promptSectionFor: promptSectionFor,
        PROMPT_TOOL_DEPS: PROMPT_TOOL_DEPS,
        DENY_TOOLS: DENY_TOOLS,
        // 不再导出 TEAM_LANE_DENY_TOOLS（那张表已删——计划工具回归 lane 的投放清单；
        // 自动化校验改核「三件计划工具**在** lane 的投放面里」）。
        TEAM_TASKS_LINE: TEAM_TASKS_LINE
    };
})(typeof window !== 'undefined' ? window : globalThis);
