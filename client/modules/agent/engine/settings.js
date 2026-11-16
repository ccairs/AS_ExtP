(function (global) {
    const DEFAULTS = {
        runtimeMode: 'script',
        executionTimeoutMs: 30000,
        requestTimeoutMs: 120000,
        // 上下文兜底上限：**仅在服务商未上报模型窗口时生效**（默认 256k）。
        // 已存盘的值不会被 normalize/默认值重置为 256K（见下 normalize：只在取不到数时兜底）。
        maxContextTokens: 256000,
        // Agent 模式 executeExtendScript 的 LLM 安全审查：默认关闭（开启显著降低执行速度），
        // 用户在模块设置中自行开启。接线见 controller.js executeToolCall。
        agentScriptReview: false,
        // 聊天区本地路径点击确认：true = 先弹确认框（默认），
        // false = 单击直接打开所在目录并选中文件。消费点 = engine/bootstrap.js 的链接委托。
        confirmPathOpen: true,
        // shader 模式 JS 效果（submit_js_effect / shader_library 写 .js）的 LLM 二次校验：默认开启。
        // 与静态危险代码预检（始终开启）构成双防线，拦截静态黑名单绕不过的混淆/拼接绕过。
        shaderJsReview: true,
        reasoningEffort: 'high',
        permissionMode: 'balanced',
        // 工具执行确认等待超时（ms）：balanced/conservative 档弹出确认卡片后，
        // 用户在限定时间内未点击则默认拒绝并回喂 LLM。0 表示禁用超时（无限等待）。
        permissionConfirmTimeoutMs: 30000,
        // 提问工具 askUser 的等待上限（ms）：Agent 弹出问答卡后，用户在该时间内未回答则
        // 工具返回 timeout 并回喂模型（见 engine/askUserTool.js）。0 表示禁用超时（无限等待）。
        askUserTimeoutMs: 300000,
        allowCloudModels: false,
        // Agent 联网搜索：通过自定义 search_web 工具调用 Bridge /api/web-search，默认开启
        webSearchEnabled: true,
        // 待发送消息（执行中追加）的派发时机：false = 下一轮 LLM 请求前
        // 注入（现状，默认）；true = 等当前轮 Agent 给出正式回复后，再作为新一轮发送。
        // 消费点只有 processToolLoop 的轮首 drain：开启时用户消息只在轮次起点（loopCount===1）
        // 注入，轮内留在队列，由循环出口的递归在正式回复落盘后起新一轮消费。
        // 后台异步结果（systemResult）与跨会话条目不是用户待发送消息，仍即时处理；
        // Script 模式的队列本来就在脚当前轮结束后才 drain（无轮内注入），不受本开关影响。
        deferInjectUntilReply: false,
        // 注入 LLM 的 stub 工具数量上限：上万个自定义 AE 工具默认全注入会撑爆 prompt。
        // 0 表示不限制。被裁工具仍可经 tool_search 获取完整定义。
        maxLlmStubTools: 200,
        // 工具可见性的用户覆盖配置：只存「与默认不同」的偏差，
        // `{version:1, views:{}}` 即全默认面（升级零迁移）。每视图 `{disabled:[], enabled:[]}`：
        // disabled = 在本视图隐藏（收窄），enabled = 在本视图显示（放宽）。
        // 归一唯一实现 = 本文件的 normalizeToolVisibility；app 层（main.js / app/settings.js）
        // 只转发它，不复制第二份判据（本仓 previewFps 式漂移的老账）。
        toolVisibility: { version: 1, views: {} },
        // 目标自动续轮的默认轮数上限（25）：create_goal 不带
        // max_goal_rounds 时取它；单个目标可用 max_goal_rounds 覆盖。归一夹 1..500。
        goalDefaultMaxRounds: 25,
        // 团队模式：四条常驻 lane 的模型参数与子 Agent 闸门。
        // 模型/平台/思考等级是**模块级配置**（对所有团队会话一致），
        // 会话级只存上下文与工作区。四条 lane 默认思考等级均 high。
        // 不设 per-lane 温度：默认平台的思考模式不接受
        // temperature（发了不报错也不生效），故不引入该维度；「导演发散 / 执行收敛」由
        // 提示词身份段与工具收窄承担。
        team: {
            enabled: false,
            // 团队关掉后该回到哪一档（第 5 档升格为第一等档位）。
            // **不再**是「单 Agent 的档位留在 runtimeMode 里」——runtimeMode 现在承载面板档位
            // （含 'team'），被 park 的单 Agent 档位搬到这里。一致性规则见 applyModeConsistency。
            baseMode: 'script',
            lanes: {
                director: { model: '', platform: '', reasoningEffort: 'high' },
                'ae-exec': { model: '', platform: '', reasoningEffort: 'high' },
                glsl: { model: '', platform: '', reasoningEffort: 'high' },
                'asset-gen': { model: '', platform: '', reasoningEffort: 'high' }
            },
            subagent: { maxConcurrent: 3, keepAliveMs: 600000, maxLoops: 30 }
        }
    };

    // Shader 预览解算帧率：**固定 30fps，不可配置**（「彻底移除，
    // 预览按照 30FPS」——原「Shader 预览帧率（fps）」设置项已从模块设置整体移除，
    // 连带采集/落盘/归一链路一并删除）。
    // 唯一真相源：**全仓只有这一处定义该字面量**，渲染器（shader/shaderPreviewRenderer.js）
    // 与契约定义都引用本常量，不得再开第二份（该设置正是两处归一各写一份时
    // 漂移过一次）。它折算的口径：@solve 的推进速率（每帧 N 步 × 帧率）、非 Hz 路径的
    // uDt、@solveHz 的每帧子步数推导、uFrame 的"预览帧号"。
    // 取舍（**不是缺陷**，别当 bug 追）：该设置项原本的存在理由是
    // 预览拿不到合成帧率时按 25fps 假定硬编码——设成合成帧率后预览的演化速率与帧号
    // 才与 AE 对齐。现固定 30fps ⇒ **合成帧率为 30fps 时对齐**；合成帧率为 25/60fps 等
    // 其它值时，Shader 预览的演化速率与 uFrame 帧号不再与 AE 对齐（@solveHz 的"步/秒"
    // 与帧率无关，不受此影响）。
    var PREVIEW_FPS = 30;

    // 执行超时归一（3 ~ 120 秒，默认 30 秒；UI 标签已宣称「3–120」）：面板采集
    //（app/main.js getCurrentSettingsFromUI）与落盘（app/settings.js saveSettings）
    // 都转发本实现，避免"面板只保下限、引擎夹 120s"的双口径。旧面板路径填
    // ≥ 2147484 秒时落盘值 > 2^31-1 ms，setTimeout 延迟溢出被夹成 ~1ms——
    // 脚本模式「运行」与快捷栏执行立即误报超时。
    function normalizeExecutionTimeoutMs(v) {
        var n = Number(v) || 30000;
        return Math.max(3000, Math.min(120000, n));
    }

    // Agent 请求超时归一（10 ~ 300 秒 / 10000 ~ 300000ms，默认 120000ms；UI 标签
    // 「Agent 请求超时（秒）」已宣称 10–300）：面板采集（app/main.js）、落盘/回填
    // （app/settings.js）与引擎消费共用本实现——采集若只保下限（填 600 秒落盘 600000），
    // 引擎 normalize 却夹到 300000，UI 又按原值回填显示 600，形成「显示 600、实际 300」。
    // 上限 300000 维持不变（提高上限是产品决定，不在本修复内）。
    function normalizeRequestTimeoutMs(v) {
        var n = Number(v) || 120000;
        return Math.max(10000, Math.min(300000, n));
    }

    // 团队 lane id 的唯一来源：四条 lane 的顺序与命名只写这一份，
    // 设置归一、orchestrator 装配、任务板渲染都引用它（不得各写一份字面量）。
    var TEAM_LANE_IDS = ['director', 'ae-exec', 'glsl', 'asset-gen'];
    // 合法思考等级：与下方全局 reasoningEffort 白名单同集合（low/medium/high/xhigh）。
    var REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

    // ── 面板档位清单（唯一来源）────────────────────────────────
    // 'team' 曾是**派生档**（真相源 settings.team.enabled，runtimeMode 保持原值），
    // 那个设计让「面板在哪个档」这个问题在 4 处读取点各错一次（会话名/胶囊、工具栏、
    // 白闪），故升格为第一等档位：**runtimeMode 就是面板档位**，含 'team'。
    //   · MODES        —— 旋钮五档（顺序即档位号），UI 两处写点（app/main.js 的 syncRuntimeMode
    // 与 bootstrap 的 syncModeButtons）都必须引用它。bootstrap 侧那份
    //                     只有 4 槽、且是第二份字面量，团队档下会把旋钮标签写成 'Script'（L-1）。
    //   · MODE_LABELS  —— 与 MODES 同源的显示名，同上。值是**源文**（zh）：显示点取到后
    //                     过一遍 AEI18n.t；不在本表里预翻译，否则模块加载期就把语言冻住了。
    //   · SINGLE_MODES —— 单 Agent 四档（不含 team）：4 档 dispatch 的合法域。
    //                     谁是「4 档」这件事也**只在这里定义一次**。
    var MODES = ['script', 'agent', 'shader', 'external', 'team'];
    var MODE_LABELS = { script: 'Script', agent: 'Agent', shader: 'Shader', external: '外接', team: '团队' };
    var SINGLE_MODES = ['script', 'agent', 'shader', 'external'];

    // 整数夹取：非法值（NaN/非数值）回退默认，其余向下取整后夹进区间。
    function _clampInt(v, min, max, dflt) {
        var n = Number(v);
        if (!Number.isFinite(n)) return dflt;
        n = Math.floor(n);
        return Math.max(min, Math.min(max, n));
    }

    // 目标自动续轮的默认轮数上限归一的**唯一实现**（1..500，默认 25）。
    // 设置面板的采集/回填/落盘（app/settings.js）转发本函数，不写第二份夹取口径
    //（executionTimeoutMs / requestTimeoutMs 曾出现「面板只保下限、引擎夹上限」的不一致）。
    function normalizeGoalDefaultMaxRounds(v) {
        return _clampInt(v, 1, 500, DEFAULTS.goalDefaultMaxRounds);
    }

    // ── 工具可见性配置归一（唯一实现）────────────────────
    // 数据模型：{ version: 1, views: { <viewId>: { disabled: [name], enabled: [name] } } }
    //   · disabled = 在本视图隐藏（收窄）；enabled = 在本视图显示（放宽）。
    //   · 只存偏差：空数组 / 缺段 = 跟随默认；`{version:1, views:{}}` 即全默认（升级零迁移）。
    //   · 名字是工具名字符串；未知名字**保留**（工具暂时不可用 / MCP 服务器离线 / 自建 AE 工具
    //     被删又恢复），归一只做结构清洗，不做存在性校验。
    // 合法视图键 = 3 个固定视图 + 运行期 lanes.list() 派生的 lane 视图。**不得写死 7 键字面量**：
    // 本文件装载早于 team/lanes.js（scripts.manifest.js 顺序），新增 lane 要自动成为合法键，
    // 因此合法键集合只在**调用时**惰性取（见 toolVisibilityViewIds）。
    var TOOL_VISIBILITY_FIXED_VIEWS = ['agent', 'script', 'shader'];
    // 数组清洗上限：单名长度 ≤ 128 字符、每个视图每类 ≤ 2000 条（远大于当前 73 件工具）。
    var TOOL_VIS_MAX_NAME_LEN = 128;
    var TOOL_VIS_MAX_PER_LIST = 2000;
    var TOOL_VIS_VERSION = 1;

    // 合法视图键（惰性派生）：固定 3 键 + 当前 lanes.list() 的 lane id。
    // lanes 未装配时只认固定键——每次调用都重新取，装配后自然恢复（不做一次性缓存：
    // 缓存会让「设置面板先于团队装配面打开」的那次会话永久丢掉 lane 页签的配置）。
    function toolVisibilityViewIds() {
        var out = TOOL_VISIBILITY_FIXED_VIEWS.slice();
        try {
            var lanes = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var list = (lanes && typeof lanes.list === 'function') ? (lanes.list() || []) : [];
            for (var i = 0; i < list.length; i++) {
                var id = list[i] && list[i].id;
                if (typeof id === 'string' && id && out.indexOf(id) < 0) out.push(id);
            }
        } catch (_) { /* lanes.list() 抛错：本次只认固定键（不影响其它字段的归一） */ }
        return out;
    }

    // 单类数组清洗：只收字符串、trim 后非空、长度 ≤ 128、去重、上限 2000 条（按出现顺序保留）。
    function _cleanToolVisibilityNames(raw) {
        var out = [];
        if (!Array.isArray(raw)) return out;
        for (var i = 0; i < raw.length && out.length < TOOL_VIS_MAX_PER_LIST; i++) {
            var v = raw[i];
            if (typeof v !== 'string') continue;
            var name = v.replace(/^\s+|\s+$/g, '');
            if (!name || name.length > TOOL_VIS_MAX_NAME_LEN) continue;
            if (out.indexOf(name) >= 0) continue;
            out.push(name);
        }
        return out;
    }

    // 归一（返回**新对象**，不写穿 DEFAULTS，也不改调用方传入的 raw）。
    // 未知 version 按 1 处理（忽略未知字段、不做迁移）；未来加版本时在这里加分支。
    function normalizeToolVisibility(raw) {
        var out = { version: TOOL_VIS_VERSION, views: {} };
        // 非对象 / 缺段 ⇒ 空配置（= 全默认面；老盘无此键等价于默认）。
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
        var srcViews = (raw.views && typeof raw.views === 'object' && !Array.isArray(raw.views)) ? raw.views : {};
        var viewIds = toolVisibilityViewIds();
        for (var i = 0; i < viewIds.length; i++) {
            var vid = viewIds[i];
            var seg = srcViews[vid];
            // 每段只读 disabled / enabled（未知字段不进结果），非对象段忽略。
            if (!seg || typeof seg !== 'object' || Array.isArray(seg)) continue;
            var disabled = _cleanToolVisibilityNames(seg.disabled);
            var enabled = _cleanToolVisibilityNames(seg.enabled);
            // disabled 优先：同一名字既在 disabled 又在 enabled ⇒ 视为关闭，并从 enabled 删除。
            // 归一后两数组交集恒为空（否则 UI 会同时显示「已放宽 / 已关闭」）。
            if (disabled.length && enabled.length) {
                var kept = [];
                for (var e = 0; e < enabled.length; e++) {
                    if (disabled.indexOf(enabled[e]) < 0) kept.push(enabled[e]);
                }
                enabled = kept;
            }
            // 空段不落盘：两数组都空的视图不进结果（views 只保留至少一个数组非空的视图）。
            if (!disabled.length && !enabled.length) continue;
            out.views[vid] = { disabled: disabled, enabled: enabled };
        }
        return out;
    }

    // team 段归一：缺段、缺字段、越界、非法枚举一律收敛到可用值；
    // 旧设置盘无 team 段时补默认值（升级兼容，不重置其它字段、不写穿 DEFAULTS）。
    // 未知 lane id 不进结果——lane 集合是封闭的（TEAM_LANE_IDS）；
    // lane 参数只有 model / platform / reasoningEffort（温度维度整体不实现，
    // 存量或手填的 temperature 键不进结果）。
    // 第二参 runtimeMode（可选）：`baseMode` 的**兜底来处**。老盘没有 baseMode，
    // 而它的 runtimeMode 恰好就是「被 park 的那一档」⇒ 用它兜。`'team'` 在这里兜不出东西
    //（它本身不是单 Agent 档），故落 'script'；真正的新盘/老盘判定在 applyModeConsistency。
    // **本函数不跨字段强制**（不改 runtimeMode、不按 runtimeMode 改 enabled）——它必须保持
    // 可被 lane 的槽位覆盖复用（见 normalize 的 slotOverride 与 V6）。
    function normalizeTeam(raw, runtimeMode) {
        var d = DEFAULTS.team;
        var src = (raw && typeof raw === 'object') ? raw : {};
        var srcLanes = (src.lanes && typeof src.lanes === 'object') ? src.lanes : {};
        var bm = (typeof src.baseMode === 'string' && SINGLE_MODES.indexOf(src.baseMode) >= 0) ? src.baseMode : '';
        if (!bm) {
            bm = (typeof runtimeMode === 'string' && SINGLE_MODES.indexOf(runtimeMode) >= 0) ? runtimeMode : 'script';
        }
        var out = { enabled: src.enabled === true, baseMode: bm, lanes: {}, subagent: {} };
        for (var i = 0; i < TEAM_LANE_IDS.length; i++) {
            var id = TEAM_LANE_IDS[i];
            var dl = d.lanes[id];
            var l = (srcLanes[id] && typeof srcLanes[id] === 'object') ? srcLanes[id] : {};
            out.lanes[id] = {
                model: typeof l.model === 'string' ? l.model : dl.model,
                platform: typeof l.platform === 'string' ? l.platform : dl.platform,
                reasoningEffort: REASONING_EFFORTS.indexOf(l.reasoningEffort) >= 0 ? l.reasoningEffort : dl.reasoningEffort
            };
        }
        var srcSa = (src.subagent && typeof src.subagent === 'object') ? src.subagent : {};
        out.subagent = {
            maxConcurrent: _clampInt(srcSa.maxConcurrent, 0, 8, d.subagent.maxConcurrent),
            keepAliveMs: _clampInt(srcSa.keepAliveMs, 0, 3600000, d.subagent.keepAliveMs),
            maxLoops: _clampInt(srcSa.maxLoops, 1, 500, d.subagent.maxLoops)
        };
        return out;
    }

    // ── 4 档 dispatch 的唯一入口 ─────────────────────────────────────────────
    // 「这一份设置对应的**单 Agent 档位**是谁」：面板在团队档时，单 Agent 那条 runtime 被
    // park 在 `team.baseMode`；其余档位就是 runtimeMode 本身。
    // 为什么必须有它：'team' 不是 4 档表里的值，直接把它喂给 getActiveStore /
    // getActiveCm / 恢复链 / roundModuleId 会落到各自的「兜底 script」分支——
    // 那正是本仓 previewFps 式漂移的同类（兜底悄悄生效，没人发现语义错了）。
    function effectiveMode(settings) {
        var s = settings || {};
        if (s.runtimeMode === 'team') {
            var bm = (s.team && typeof s.team === 'object') ? s.team.baseMode : '';
            return SINGLE_MODES.indexOf(bm) >= 0 ? bm : 'script';
        }
        return SINGLE_MODES.indexOf(s.runtimeMode) >= 0 ? s.runtimeMode : 'script';
    }

    // ── 老盘迁移（**只在读盘路径调用**，唯一实现）────────────────────────────────
    // 旧代码（派生档语义）写的盘长这样：`runtimeMode = <切进团队之前那一档>` + `team.enabled = true`
    // 且**没有 `team.baseMode` 字段**（那时还没有这个概念）。这一条把它一对一映射成新格式：
    //   `baseMode = 原 runtimeMode`（来处）、`runtimeMode = 'team'`。
    //
    // 为什么必须与 applyModeConsistency 分开、且**必须在 normalizeTeam 之前**跑：
    //   ① `normalizeTeam` 会给缺失的 baseMode 补默认值 ⇒ 跑在它之后就再也分不清「老盘缺字段」与
    //      「新盘就是这么写的」；
    //   ② 更要紧的是**稳态不能走迁移**：切档路径会构造 `{runtimeMode:'shader', team:{enabled:true,
    //      baseMode:'agent'}}`（runtimeMode 刚改、镜像还没同步），若在那里跑迁移判定，就会被当成
    //      「老盘」而把 runtimeMode 又写回 'team' —— 真机实测：从团队档点到 Shader，界面已是 Shader
    //      而盘上是 `runtimeMode:'team' + enabled:true`（面板重载后团队会自己回来）。
    //      判据天然可分：**新格式的盘一定带 baseMode**（旧代码从没写过它）。
    // 纯函数、幂等（迁移后再跑：baseMode 已在 ⇒ 直接返回）。
    function migrateLegacyTeam(base) {
        if (!base || typeof base !== 'object') return base;
        var t0 = (base.team && typeof base.team === 'object') ? base.team : null;
        if (!t0 || t0.enabled !== true) return base;
        if (typeof t0.baseMode === 'string' && SINGLE_MODES.indexOf(t0.baseMode) >= 0) return base;
        var r = base.runtimeMode;
        if (r === 'team') return base;
        // 浅拷贝 team 段再写：`normalize` 的展开只复制顶层引用，就地改会把调用方传进来的
        // 设置对象也改掉（单测 ③-24…③-26 钉的就是这条）。
        var t = Object.assign({}, t0);
        base.team = t;
        t.baseMode = SINGLE_MODES.indexOf(r) >= 0 ? r : 'script';
        base.runtimeMode = 'team';
        return base;
    }

    // ── 面板档位一致性（唯一实现）───────────────────────────
    // **稳态**规则（输入是已归一的新格式：team 段一定带 baseMode）：
    //   ① `runtimeMode === 'team'` —— enabled 恒真；baseMode 非法/缺失补 'script'
    //   ② 其余档位 —— enabled 恒假，baseMode 恒等于 runtimeMode（自愈：不信任残留的旧 baseMode，
    //      否则「上次从外接进团队留下的 external」会在用户早就切到 agent 之后仍被当作退出落点）
    // **注意 ② 也覆盖「runtimeMode 刚改、team.enabled 还是 true」这个过渡态**：那正是切档路径
    // 构造出来的对象，此处把镜像压回假、**不动 runtimeMode**。
    // 老盘迁移不在这里（见 migrateLegacyTeam）：那条规则必须只作用于读盘，否则会把稳态过渡态
    // 误判成旧盘而把 runtimeMode 拽回 'team'。
    // 调用点：engine/settings.js 的 normalize（全局设置）+ app/settings.js 的
    // resolveModuleSettings（转发本实现）。**lane 的槽位覆盖不得调用**（见 normalize 的
    // slotOverride：lane 的 runtimeMode 是 slot，不是面板档位）。
    function applyModeConsistency(base) {
        if (!base || typeof base !== 'object') return base;
        // **总是重建 team 段**（normalizeTeam 返回新对象）：这样本函数不会改到调用方传进来的
        // 那份 team（app 层的保存路径直接把它们从 UI 采集来的设置对象递进来），同时顺手把
        // team 段归一了一遍（与 normalize 同口径）。第二参 runtimeMode 是 baseMode 兜底来处。
        var team = normalizeTeam(base.team, base.runtimeMode);
        base.team = team;
        var r = base.runtimeMode;
        if (r === 'team') {
            team.enabled = true;
            if (SINGLE_MODES.indexOf(team.baseMode) < 0) team.baseMode = 'script';
            return base;
        }
        team.enabled = false;
        team.baseMode = SINGLE_MODES.indexOf(r) >= 0 ? r : 'script';
        return base;
    }

    // 归一（第二参 opts.slotOverride 见下）。
    function normalize(raw, opts) {
        const base = {
            ...DEFAULTS,
            ...(raw || {})
        };
        // 白名单含 'external'：外接模式加入四档开关时漏了这里——
        // controller 的 getSettings 全经本 normalize，'external' 被吞成 'script' 后
        // switchMode('script') 的 same 检查误判「已是 script」，外接→Script 永久切不过去
        //（外部 Agent 全链实测定位）。消费端 getActiveStore/getActiveCm 等对 'external'
        // 与 'script' 走同一默认分支，直通无行为差异。
        // 白名单含 'team'：第 5 档升格为第一等档位。旧白名单只认四档
        // ⇒ 写 'team' 会被折成 'script'，于是没人敢写、面板层只能读到一个语义不对的字段

        base.runtimeMode = MODES.indexOf(base.runtimeMode) >= 0 ? base.runtimeMode : 'script';
        base.executionTimeoutMs = normalizeExecutionTimeoutMs(base.executionTimeoutMs);
        base.requestTimeoutMs = normalizeRequestTimeoutMs(base.requestTimeoutMs);
        // 兜底值钳制：区间不变（2000 ~ 1000000，允许手填到 1M）；`|| 256000` 只兜「从未设置过」，
        // 已存盘的 1000000 等值原样保留 —— 升级兼容是硬要求（不得把老值重置成新默认）
        base.maxContextTokens = Math.max(2000, Math.min(1000000, Number(base.maxContextTokens) || 256000));
        base.agentScriptReview = !!base.agentScriptReview;
        base.shaderJsReview = !!base.shaderJsReview;
        // 本地路径点击确认：缺省/非法值一律视为开启（只有显式 false 才是单击直开）
        base.confirmPathOpen = base.confirmPathOpen !== false;
        base.reasoningEffort = ['low', 'medium', 'high', 'xhigh'].indexOf(base.reasoningEffort) >= 0 ? base.reasoningEffort : 'high';
        base.permissionMode = ['auto', 'balanced', 'conservative'].indexOf(base.permissionMode) >= 0 ? base.permissionMode : 'balanced';
        var _pt = Number(base.permissionConfirmTimeoutMs);
        base.permissionConfirmTimeoutMs = Number.isFinite(_pt) ? Math.max(0, Math.min(300000, _pt)) : 30000;
        // askUser 等待上限：0 = 不超时（显式合法值，只有非法数才回落默认 5 分钟）
        var _at = Number(base.askUserTimeoutMs);
        base.askUserTimeoutMs = Number.isFinite(_at) ? Math.max(0, Math.min(3600000, _at)) : 300000;
        base.allowCloudModels = !!base.allowCloudModels;
        base.webSearchEnabled = !!base.webSearchEnabled;
        // 待发送消息派发时机（见 DEFAULTS 同名注释）：非布尔值一律夹成布尔，缺省 false
        base.deferInjectUntilReply = !!base.deferInjectUntilReply;
        // 0 表示不限制：显式判别保留 0，仅非法值（NaN）回退默认 200。
        var _mt = Number(base.maxLlmStubTools);
        base.maxLlmStubTools = Number.isFinite(_mt) ? Math.max(0, Math.min(10000, _mt)) : 200;
        // 目标默认轮数上限：1..500，非数值回落默认 25（见 normalizeGoalDefaultMaxRounds）。
        base.goalDefaultMaxRounds = normalizeGoalDefaultMaxRounds(base.goalDefaultMaxRounds);
        // 老盘迁移：**必须排在团队段归一之前**——归一一旦补上 baseMode，就再也分不清
        // 「老盘缺这个字段」与「新格式本来就有」；而「有 baseMode」正是稳态与旧盘的唯一分界。
        // slotOverride 时跳过（lane 的 runtimeMode 是 slot，不是面板档位）。
        if (!(opts && opts.slotOverride)) migrateLegacyTeam(base);
        // 团队段归一（缺段补默认 = 旧设置盘升级兼容；team 不再往下传原始对象）。
        // 传入当前 runtimeMode 作 baseMode 兜底（老盘无该字段时的来处）。
        base.team = normalizeTeam(base.team, base.runtimeMode);
        // 面板档位一致性（**稳态**）。**opts.slotOverride 时跳过**：
        //   bootstrap._laneGetSettings 是唯一把 runtimeMode 换成 lane slot 再归一的地方
        //   （`merged.runtimeMode = laneDef.slot`），那里 runtimeMode 不是面板档位。
        //   若在 lane 归一里跑一致性规则，会看到「runtimeMode='agent' + team.enabled=true」
        //   而**把 lane 的 team.enabled 改成 false、baseMode 抹成 'agent'**——抹掉全局团队态
        //   与来处。lane 需要的是「全局 team 段原样透传 + slot 覆盖档位」。
        if (!(opts && opts.slotOverride)) applyModeConsistency(base);
        // 工具可见性用户覆盖：结构清洗，唯一实现在上方 normalizeToolVisibility。
        // slotOverride 时**也要**归一：它是模块级配置（与 lane 无关），lane 的 getSettings
        // （bootstrap._laneGetSettings）同样要读到已清洗的覆盖；不归一会让闸口拿到脏数组。
        // 放在最后：它不依赖其它字段，lane 视图键在调用时惰性取（本文件早于 team/lanes.js）。
        base.toolVisibility = normalizeToolVisibility(base.toolVisibility);
        // 旧盘残留键 previewFps（设置项已整体移除）：读时丢弃、不做迁移——既不得把它
        // 当生效值，也不得因它的存在影响其它字段（沿用本仓既有的死字段处置口径）。
        delete base.previewFps;
        return base;
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.settings = {
        DEFAULTS,
        normalize,
        // team 段归一与 lane id 清单：团队设置访问器（agent/team/settings.js）与
        // orchestrator 装配都引用这里，避免第二条归一实现（当年 previewFps 就是这么漂移的）
        normalizeTeam,
        TEAM_LANE_IDS,
        // 预览解算帧率的唯一真相源（固定 30fps，不可配置）——渲染器与相关判据都引用它
        PREVIEW_FPS,
        normalizeExecutionTimeoutMs,
        normalizeRequestTimeoutMs,
        // 目标默认轮数上限（1..500，默认 25）：设置面板的采集/回填/落盘转发本实现
        normalizeGoalDefaultMaxRounds,
        // ── 工具可见性（唯一实现）──
        // normalizeToolVisibility：结构清洗（合法视图键惰性派生 / 数组清洗去重 / disabled 优先 /
        //   空段不落盘 / 未知 version 按 1 / 返回新对象）。app 层（main.js、app/settings.js）
        //   的采集/回填/落盘/读设置全部**转发**本函数，不得复制第二份判据。
        // toolVisibilityViewIds：合法视图键清单（固定 3 + 当前 lanes）——设置面板/测试用它，
        //   不在别处维护第二份视图名单；调用时取值，lanes 装配前后都正确。
        normalizeToolVisibility,
        toolVisibilityViewIds,
        // ── 公开面 ──
        // MODES / MODE_LABELS：面板档位与显示名的唯一来源（UI 两处写点引用它，见定义处注释）
        MODES,
        MODE_LABELS,
        SINGLE_MODES,
        // 4 档 dispatch 的唯一入口：'team' ⇒ 被 park 的 baseMode
        effectiveMode,
        // 面板档位一致性（**稳态**：engine 的 normalize 已调用；app/settings.js
        // 的 resolveModuleSettings **转发**本实现）
        applyModeConsistency,
        // 老盘迁移（派生档 → 第一等档位）：**只在读盘路径调用**，且必须排在团队段归一之前。
        // 与 applyModeConsistency 分开是硬要求——把迁移规则用在稳态过渡态上会把 runtimeMode
        // 拽回 'team'（从团队档点到 Shader 后盘上仍是 team/on）。
        migrateLegacyTeam
    };
})(window);
