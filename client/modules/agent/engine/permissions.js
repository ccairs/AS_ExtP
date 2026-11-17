(function (global) {
    // Agent 模式三档工具权限策略
    // - auto（全自动）：所有工具直接执行（历史行为）
    // - balanced（平衡，默认）：危险工具执行前需用户在聊天流内确认
    // - conservative（保守）：仅只读工具自动执行，其余全部需确认
    var MODES = { AUTO: 'auto', BALANCED: 'balanced', CONSERVATIVE: 'conservative' };
    var MODE_LIST = ['auto', 'balanced', 'conservative'];

    // 强制确认工具：无论权限模式都需用户确认（尊重"本次会话不再询问"）
    // createAETool：创作/覆盖 AE 工具（写磁盘 + 改变后续对话的工具列表，LLM 可自我扩展能力面）
    // deleteAETool：删除 AE 工具（不可逆）
    // writeFile：写磁盘（平台侧文件写入，任何权限模式都需用户确认）
    // memory_delete：删除记忆（磁盘 .md + 索引 + backlinks，不可逆，对齐 script_manager.delete 等）
    var FORCE_CONFIRM = {
        createAETool: true,
        deleteAETool: true,
        writeFile: true,
        memory_delete: true
    };

    // 平衡档必弹（无论参数）——能力面宽或后果难逆：
    // executeExtendScript：任意 JSX 代码执行
    // 注：executeMenuCommand/startRender/purgeMemory 未注册（工具注册表里
    //     仅保留 executeExtendScript 一个执行工具），故不在必弹清单；重新注册时需回归本清单
    //     （executeMenuCommand 更进一步——宿主函数本身已删除，菜单命令改走原生
    //     app.executeCommand(app.findMenuCommandId(路径))，与 app.executeCommand 同挂 menu 域）
    // 注：createSkill 已并入 skill_manager 粗粒度工具（CONFIRM_COND.skill_manager）
    var CONFIRM_ALWAYS = {
        executeExtendScript: true,
        // memory 写工具（scope:global，落盘 .md + 索引 + 自动注入后续 system prompt）：
        // memory_create / memory_update / set_rule 在 balanced/conservative 弹（auto 不弹，允许会话跳过）
        memory_create: true,
        memory_update: true,
        set_rule: true
    };

    // 保存工程：不设库函数，代码通道走
    // executeExtendScript 写原生 app.project.save(file)——该成员名已放开 file 域闸
    //（ast-gate tables Project 表 'save' 条目），而 executeExtendScript 在平衡档
    // 恒弹（CONFIRM_ALWAYS），保存随之被确认；**零参形态另有 noArgModal 闸**：
    // 未保存过的工程 app.project.save() 会走 AE「另存为」模态（或按官方文档口径报错），
    // 故 Agent 通道只放行带参形态（gate 拒绝时回执给出
    // `if (app.project.file) app.project.save(app.project.file);`）。
    // **确认口径的边界（「批准即授权」，本注如实限定）**：上面
    // 「保存随之被确认」只对 **executeExtendScript 通道**成立。**ae-tool 通道**
    //（createAETool 自建工具 / JSON 工具）不在任何确认清单里——自建工具的代码在
    // **创建期**由用户确认一次（含 AST 门预检），此后每次调用不再逐次确认（这是自建
    // 工具一贯的设计，不针对保存）；故「建一个会保存的工具」这条路径的授权点是
    // **创建确认**，不是调用确认。file 域关闭时 `new File(...)` 被拒，故该通道实际
    // 可写目标只能是当前工程文件（`save(app.project.file)`），不能另存到任意路径。
    // 菜单命令另走原生 app.executeCommand（挂 menu 域闸，不经本表）。


    // comfyui_generate 仅在使用云端模型（消耗积分）时弹窗确认。
    // 素材库工具（asset_library，单工具按 library+mode 区分）：
    //   读 mode（list/get/search/listFolders/listEmptyFolders/listMissing/scanMissing/listArchive）→ 不弹
    //   导入 AE mode（importToAE/applyToAE）→ 不弹（导入 AE 不设防）
    //   写 mode（add/rename/move/createFolder/renameFolder/moveFolder/removeFolder/updateMeta）→ 弹
    //   归档 mode（archive/restore）= 删除语义但可恢复（7 天内 restore）→ 按写 mode 弹，不设 FORCE
    var ASSETS_READ_MODES = {
        list: true, get: true, search: true,
        listFolders: true, listEmptyFolders: true,
        listMissing: true, scanMissing: true, listArchive: true
    };
    var ASSETS_IMPORT_MODES = {
        importToAE: true, applyToAE: true
    };
    function _assetsNeedsConfirm(args) {
        var m = args && args.mode;
        if (!m) return true;                          // 缺 mode 视为写，保守弹
        if (ASSETS_READ_MODES[m])   return false;     // 读：不弹
        if (ASSETS_IMPORT_MODES[m]) return false;     // 导入 AE：不设防
        return true;                                  // 写：balanced 弹
    }

    // MCP 管理双工具按 mode 区分：
    //   mcp_servers   读 mode（list/get）→ 不弹；写 mode（add/update/setAutoStart）→ 弹；
    //                 remove → 返回 'FORCE'，由 needsConfirmation 走强制确认路径（无视 sessionSkips）
    //   mcp_control   读 mode（getStatus/getAllStatuses）→ 不弹；控制 mode（start/stop/restart/autoStartAll）→ 弹
    var MCP_SERVERS_READ_MODES = { list: true, get: true };
    var MCP_CONTROL_READ_MODES = { getStatus: true, getAllStatuses: true };
    function _mcpServersNeedsConfirm(args) {
        var m = args && args.mode;
        if (!m) return true;
        if (MCP_SERVERS_READ_MODES[m]) return false;
        if (m === 'remove') return 'FORCE';           // 任何模式都弹（含 auto）
        return true;                                  // add/update/setAutoStart
    }
    function _mcpControlNeedsConfirm(args) {
        var m = args && args.mode;
        if (!m) return true;
        if (MCP_CONTROL_READ_MODES[m]) return false;
        return true;                                  // start/stop/restart/autoStartAll
    }

    // skill_manager 单工具按 mode 区分：
    //   读 mode（list/get/search）→ 不弹
    //   写 mode（update/setEnabled）→ 弹
    //   create/install/delete → 返回 'FORCE'，任何模式都弹（创建/安装/卸载不可逆或影响范围大）
    var SKILL_READ_MODES = { list: true, get: true, search: true };
    var SKILL_FORCE_MODES = { create: true, install: true, delete: true };
    function _skillManagerNeedsConfirm(args) {
        var m = args && args.mode;
        if (!m) return true;                          // 缺 mode 视为写，保守弹
        if (SKILL_READ_MODES[m]) return false;        // 读：不弹
        if (SKILL_FORCE_MODES[m]) return 'FORCE';     // create/install/delete：任何模式都弹（含 auto）
        return true;                                  // update/setEnabled
    }

    // script_manager 单工具按 mode 区分（与素材库 _assetsNeedsConfirm 同款分层）：
    //   读 mode（list/get/search/listFolders/readContent）→ 不弹
    //   写 mode（create/write/rename/move/createFolder/renameFolder/removeFolder/cleanNonScript）→ 弹
    //   delete → 返回 'FORCE'，任何模式都弹（不可逆，对齐 skill_manager.delete / mcp_servers.remove）
    var SCRIPT_READ_MODES = {
        list: true, get: true, search: true,
        listFolders: true, readContent: true
    };
    function _scriptManagerNeedsConfirm(args) {
        var m = args && args.mode;
        if (!m) return true;                          // 缺 mode 视为写，保守弹
        if (SCRIPT_READ_MODES[m]) return false;      // 读：不弹
        if (m === 'delete') return 'FORCE';           // 任何模式都弹（含 auto）
        return true;                                  // 写：balanced 弹
    }

    // shader 工具（module:shader）按 mode 区分：
    //   shader_library 读 mode（list/get）→ 不弹；写 mode（save）→ 弹；
    //                  delete → 返回 'FORCE'，任何模式都弹（不可逆，对齐 skill_manager.delete）
    function _shaderLibNeedsConfirm(args) {
        var m = args && args.mode;
        if (m === 'list' || m === 'get') return false; // 读：不弹
        if (m === 'delete') return 'FORCE';            // 删除：任何模式都弹（含 auto）
        return true;                                   // save/缺省：写，balanced 弹
    }

    // shader 工具（module:shader）submit_js_effect 按参数区分：
    //   带 name → 落库写盘（把 JS 源码归档为效果库 <name>.js，与 shader_library save 同类写操作）
    //   → balanced/conservative 弹确认；落库可覆盖同名旧文件、可恢复，故不设 FORCE。
    //   无 name → 只写预览区、不落库 → 不弹（与历史行为一致；conservative 档仍按非只读
    //   工具确认，保持既有档位语义）。确认被拒时执行管线不触达 handler，故不会写盘
    //   （拒绝回执由 toolExecutionPipeline 如实注明；见其 submit_js_effect 分支）。
    function _submitJsEffectNeedsConfirm(args) {
        var n = args && args.name;
        return !!(n != null && String(n).trim());
    }
    // 本项目资产库（comfyui_project_asset）按 action 区分：
    //   list → 纯读（列工程目录下的资产文件），不弹
    //   save / restore → 写工程目录（复制/移动文件）→ balanced/conservative 弹确认
    // 工具级 readOnly=false（同一工具含写 action），故与 shader_library 同款列入 READ_ONLY，
    // 让 conservative 档的 list 不弹；save/restore 仍由本函数判定弹确认。
    function _projectAssetNeedsConfirm(args) {
        var a = args && args.action;
        if (a === 'list') return false;
        return true;
    }
    var CONFIRM_COND = {
        comfyui_generate: function (args) {
            var CLOUD = ['seedream','gpt_image2','nano_banana2','kling_i2v',
                'kling_i2v_legacy','kling_start_end','seedance2_i2v','seedance2_ref',
                'hailuo','happyhorse_i2v','happyhorse_r2v'];
            return !!(args && CLOUD.indexOf(args.model_id) >= 0);
        },
        comfyui_project_asset: _projectAssetNeedsConfirm,
        asset_library: _assetsNeedsConfirm,
        mcp_servers: _mcpServersNeedsConfirm,
        mcp_control: _mcpControlNeedsConfirm,
        skill_manager: _skillManagerNeedsConfirm,
        script_manager: _scriptManagerNeedsConfirm,
        shader_library: _shaderLibNeedsConfirm,
        submit_js_effect: _submitJsEffectNeedsConfirm
    };

    // 保守档只读白名单：这些工具自动执行，其余（含 MCP/自定义工具）全部需确认
    // shader_library 的 list/get 为纯读操作，conservative 档放行；save/delete
    // 仍走 CONFIRM_COND 分支（写弹、delete 强制弹）
    var READ_ONLY = {
        queryProject: true,
        queryDetails: true,
        queryEnvironment: true,
        readFile: true,
        listFolderFiles: true,
        getPreviewFrame: true,
        // 参数式图片分析——文件模式只读图片；抓帧模式只写数据目录下的临时帧
        // （与 getPreviewFrame 同族，tempSweep 统一清），不改变工程状态
        analyzeImage: true,
        shader_library: true,
        // memory 读工具：纯读（列表/详情/搜索/读规则），conservative 档放行
        memory_list: true,
        memory_read: true,
        memory_search: true,
        get_rule: true,
        // team 域的只读工作区：读团队会话的 brief.md，纯读、路径越界拒绝、
        // 64KB 截断 ⇒ conservative 档不应为「读一份说明书」弹确认
        read_workspace: true,
        // team 域的只读名册：teamTools 注册 list_agents 时 readOnly:true
        //（「它不改变任何状态、不唤醒任何 Agent」），但本白名单漏了它 ⇒ conservative 档
        // 为一件纯读工具弹确认（两个判据源分叉）。名单一致性由
        // 集合等式校验保证：凡注册表里 readOnly===true 的工具，
        // 此处必须为 true（漏一个即红）。新增只读工具时先看注册表，别只改这里。
        list_agents: true,
        // 提问工具 askUser：不改变 AE/工程/磁盘，只显示问答卡并等待用户
        // ——它本身就是「向用户要确认/选择」的通道。不加白名单的话 conservative 档会先弹
        // 一张「工具执行确认: askUser」，用户点允许之后才看到真正的问题（双重打扰）。
        askUser: true,
        // ComfyUI 节点目录查询：只读 /object_info，不改本地状态也不提交任务；
        // 注册侧 readOnly:true，此处不成对会被名单一致性校验判红。
        comfyui_list_nodes: true,
        // 本项目资产库（comfyui_project_asset）：list 是纯读；save/restore 的确认由
        // CONFIRM_COND 按 action 判定（同 shader_library 的混合工具口径——列入本表
        // 只为 conservative 档的 list 不被弹卡，不影响写 action 的弹确认）。
        comfyui_project_asset: true
    };

    function normalizeMode(v) {
        return MODE_LIST.indexOf(v) >= 0 ? v : 'balanced';
    }

    // 该次调用是否命中"强制确认且不允许'本次会话不再询问'"路径：
    // - FORCE_CONFIRM 工具（createAETool/deleteAETool/writeFile/memory_delete）：整体禁跳
    // - CONFIRM_COND 返回 'FORCE' 的调用（mcp_servers.remove / skill_manager
    //   create/install/delete / script_manager.delete / shader_library.delete）：禁跳
    // 删除/创建/写盘等不可逆或影响面大的操作，每次都必须用户确认，
    // 不可经"本次会话不再询问"豁免。
    function _isForceNoSkip(toolName, args) {
        if (FORCE_CONFIRM[toolName]) return true;
        if (CONFIRM_COND[toolName]) {
            return CONFIRM_COND[toolName](args) === 'FORCE';
        }
        return false;
    }

    // 纯函数：无会话状态的确认判定（mode/tool/args → 是否需确认）。
    // 抽取自 needsConfirmation 供两处复用：面板策略（叠加 sessionSkips）与
    // 外部 MCP 通道（modules/agent/external，独立档位与独立确认表——
    // 外部确认面与面板分叉：asset 写非删/shader save 等外部放行，面板行为不变）。
    function evaluateConfirmation(mode, toolName, args) {
        mode = normalizeMode(mode);
        // 强制确认工具：无论权限模式都需用户确认
        if (FORCE_CONFIRM[toolName]) return true;
        // CONFIRM_COND 可返回 'FORCE' 表示按参数触发的强制确认（如 mcp_servers.remove、
        // skill_manager create/install/delete 等不可逆操作）：任何权限模式都确认
        if (CONFIRM_COND[toolName]) {
            var verdict = CONFIRM_COND[toolName](args);
            if (verdict === 'FORCE') return true;
            if (verdict) {
                // balanced/conservative 走条件弹；auto 仍不弹
                return mode !== MODES.AUTO;
            }
            // 条件不满足（读 mode）：auto/balanced 不弹；conservative 仅 READ_ONLY 白名单不弹
            if (mode === MODES.CONSERVATIVE) return !READ_ONLY[toolName];
            return false;
        }
        if (mode === MODES.AUTO) return false;
        if (mode === MODES.BALANCED) {
            return !!CONFIRM_ALWAYS[toolName];
        }
        // conservative：非只读全弹
        return !READ_ONLY[toolName];
    }

    function createPermissionPolicy() {
        // 会话级"不再询问"记忆：仅存活于内存，面板重载/切换会话即清空
        var sessionSkips = {};

        function needsConfirmation(mode, toolName, args) {
            var base = evaluateConfirmation(mode, toolName, args);
            if (!base) return false;
            // 需确认但命中会话豁免：放行（FORCE 类不可能入豁免表——skipForSession
            // 经 _isForceNoSkip 拒绝记录，且此处再做一次防御性复查）
            if (sessionSkips[toolName] && !_isForceNoSkip(toolName, args)) return false;
            return true;
        }

        function skipForSession(toolName, args) {
            // 强制确认/不可逆操作不允许豁免：即使 UI 异常传了 skip 也不记录
            if (_isForceNoSkip(toolName, args)) return;
            sessionSkips[toolName] = true;
        }

        // 该次调用是否允许"本次会话不再询问"（false = 每次必须确认，UI 不应渲染 skip 选项）
        function allowSessionSkip(toolName, args) {
            return !_isForceNoSkip(toolName, args);
        }

        function resetSession() {
            sessionSkips = {};
        }

        function isReadOnly(toolName) {
            return !!READ_ONLY[toolName];
        }

        return {
            needsConfirmation: needsConfirmation,
            skipForSession: skipForSession,
            allowSessionSkip: allowSessionSkip,
            resetSession: resetSession,
            isReadOnly: isReadOnly,
            normalizeMode: normalizeMode,
            MODES: MODES,
            // 只读名单本身：暴露全量供「集合等式」校验使用——测试只抄子集时
            // 名单增删无人拦
            readOnlyNames: Object.keys(READ_ONLY).sort()
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createPermissionPolicy = createPermissionPolicy;
    global.AEEngine.evaluateConfirmation = evaluateConfirmation;   // 纯函数导出（外部通道复用）
    global.AEEngine.PERMISSION_MODES = MODES;
    global.AEEngine.normalizePermissionMode = normalizeMode;
})(window);
