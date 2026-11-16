// AS_ExtP 脚本加载清单（· W3 脚本清单化）
// loader.js 按本清单顺序注入（index.html 只引 scripts.manifest.js 与 loader.js）；修改加载顺序请直接编辑本文件。
// loader.js 以 document.write 同步注入，语义与静态标签等价（保持零构建）。
(function (global) {
    global.SCRIPTS_MANIFEST = {
        files: [
            'vendor/anime/anime.min.js',
            'vendor/prism/prism-core.min.js',
            'vendor/prism/prism-clike.min.js',
            'vendor/prism/prism-javascript.min.js',
            'vendor/marked/marked.min.js',
            'vendor/xss/xss.min.js',
            'core/moduleManager.js',
            'core/context.js',
            'core/appContainer.js',
            'vendor/CSInterface.js',
            'platform/cepBridge.js',
            'platform/hostApi.js',
            // i18n：i18nCore 消费 pending 语言包后初始化并翻译静态 DOM。
            // 必须晚于 vendor/CSInterface.js（读 appLocale）、早于一切模块渲染。
            // 语言包（locales/<id>.js）按语言 id 排在本组最前，用 pending 队列把字典交给 i18nCore。
            'shared/i18n/locales/en-US.js',
            'shared/i18n/locales/ja-JP.js',
            'shared/i18n/locales/de-DE.js',
            'shared/i18n/locales/ko-KR.js',
            'shared/i18n/locales/fr-FR.js',
            'shared/i18n/locales/ru-RU.js',
            'shared/i18n/errorCodes.js',
            'shared/i18n/hostErrors.js',
            'shared/i18n/i18nCore.js',
            'shared/i18n/i18nHtml.js',
            'shared/i18n/gateReasons.js',
            // diagLog 必须先于 logger：logger 在加载期就会调 AEDiagLog.start()
            'shared/diagLog.js',
            'shared/logger.js',
            'shared/utils.js',
            'shared/cryptoStore.js',
            'shared/settingsStore.js',
            'shared/status.js',
            'shared/theme-presets.js',
            'shared/theme.js',
            'shared/panelTheme.js',
            'shared/panelThemeTools.js',
            'shared/uiEffects.js',
            'shared/notice.js',
            'shared/toast.js',
            'shared/ffmpegMovPlayer.js',
            'modules/skill-manager/skillRegistry.js',
            'modules/skill-manager/skillLoader.js',
            // 多文件技能（目录化）支撑：skillFs 本地技能树操作（附件读取/整树复制/递归删除/
            // 整包写盘）、skillRemote GitHub/jsDelivr 技能包解析与下载。均须先于
            // skillInjector/llmTools 装载（运行时按 global.AE_LLM 惰性读取）
            'modules/skill-manager/skillFs.js',
            'modules/skill-manager/skillRemote.js',
            'modules/skill-manager/skillInjector.js',
            'modules/skill-manager/skillCreator.js',
            'modules/skill-manager/llmTools.js',
            'modules/skill-manager/bootstrap.js',
            'modules/skill-manager/view.js',
            'shared/toolRegistry.js',
            // 工具可见性闸口：纯决策模块，无 DOM。
            // 载序：依赖 shared/toolRegistry.js 的 filter-only 查询面（运行时惰性取），
            // lane 定义与设置都经注入（team/lanes.js 晚于本文件、engine/settings.js 更晚），
            // 故只需早于 engine/controller.js / engine/bootstrap.js。
            'shared/toolVisibility.js',
            // 全量契约的按主题切分（**两个读者面共用**）：
            // prompts 的 shader 轮、guide('shader')/guide('shader:<id>')、shaderTools 描述的外接
            // 分支都经 global 惰性读取本模块；**不含契约正文**（正文只住 glslApiReference.txt）。
            // 早于 engine 模块与 guideContent 装载即可（两者都惰性读取）。
            'shared/glslContractTopics.js',
            // guide 内容源（自主出片 MVP）：随版本分发，与工具面同步
            'shared/guideContent.js',
            'shared/toolExecutor.js',
            'shared/customSelect.js',
            'shared/bridge.js',
            'shared/aefs.js',
            // 关面板耗时测量（只测量）：beforeunload 里 begin/mark/commit 写 localStorage，
            // 启动后 reportOnce 转存 temp/logs/unload-timing.log。依赖 AEFS（转存同步写）
            // 与 Bridge（同步 XHR 统计），故排在两者之后；三个 beforeunload 钩子按名取用。
            'shared/unloadTrace.js',
            'shared/imageTranscode.js',
            'shared/tempSweep.js',
            'shared/videoPreview.js',
            'shared/platformTools.js',
            'shared/dataDir.js',
            // 宿主 param-map（uniform → AE 参数索引）纯解析：两个消费者共用一份寻址语义——
            // modules/ae-tools/bootstrap.js 的内建工具 shader_params 与
            // modules/agent/engine/shaderTools.js 的 buildSetParamScript。无文件 I/O，
            // 但必须早于这两个文件装载（后者按 global.AEShaderParamMap 惰性取用）。
            'shared/shaderParamMap.js',
            // 本地路径 → OS 文件管理器定位（Bridge /api/reveal-path + ExtendScript 目录回退）。
            // 聊天区路径链接（agent/utils/localPaths.js + engine/bootstrap.js）按名取用；
            // 依赖 bridge.js/dataDir.js（都在它之前），运行期惰性读取。
            'shared/revealPath.js',
            'shared/pickGuard.js',
            'shared/scopePicker.js',
            'modules/mcp-manager/protocol.js',
            'modules/mcp-manager/serverLifecycle.js',
            'modules/mcp-manager/toolDiscovery.js',
            'modules/mcp-manager/mcpTaskStore.js',
            'modules/mcp-manager/communicationProvider.js',
            'modules/mcp-manager/serverManager.js',
            'modules/mcp-manager/shortDescGenerator.js',
            'modules/mcp-manager/view.js',
            'modules/mcp-manager/bootstrap.js',
            'modules/mcp-manager/llmTools.js',
            // AST 编译门（+ 配置层）：acorn → ast-gate 四件 → config（
            // 通道信任 bypass + 能力域矩阵）→ run（共享门入口）。
            // 必须先于 ae-tools/bootstrap.js——createHandler 执行期过门读这些全局
            'vendor/es3-parser/acorn.js',
            'modules/ast-gate/preprocess.js',
            'modules/ast-gate/reemit.js',
            'modules/ast-gate/tables.js',
            // 用户增补表（dataDir 存储 + 预审）——紧随 tables（依赖其 TYPES/
            // HARD_DENY_MEMBERS；加载窗口内 seed-only = fail-closed 方向）
            'modules/ast-gate/userTable.js',
            'modules/ast-gate/validate.js',
            'modules/ast-gate/config.js',
            'modules/ast-gate/run.js',
            'modules/ae-tools/aeToolCreator.js',
            // 联系表合成（getPreviewFrame 多时间点）：bootstrap 注册 getPreviewFrame 时按名取用
            'modules/ae-tools/previewSheet.js',
            // analyzeImage 结果后处理（canvas 解码 + 纯像素统计）：bootstrap/controller/view
            // 三处 postProcess 接线按名取用，必须早于 bootstrap.js
            'modules/ae-tools/imageAnalysis.js',
            // AE 引擎调用的 FIFO 串行队列（面板常开）：bootstrap 的 createHandler
            // 执行期按名取用 global.AEExecQueue，必须先在位——面板内所有通道共用同一条 FIFO。
            'modules/ae-tools/execQueue.js',
            // 外接（external-mcp）短描述：bootstrap 注册工具时按名取用挂 buildDescription，
            // 必须早于 bootstrap.js（客户端对 MCP 工具描述有 2048 硬顶，短版保证外接完整可见）。
            'modules/ae-tools/externalDescriptions.js',
            'modules/ae-tools/bootstrap.js',
            'modules/ae-tools/effectsCache.js',
            'llm/providerRegistry.js',
            'llm/protocolAdapters.js',
            'llm/providerPresets.js',
            'llm/llmChannel.js',
            'llm/promptBuilder.js',
            'shared/uniformParser.js',
            'shared/glslValidator.js',
            'shared/jsExecutor.js',
            // 统一增量高亮引擎（script/shader 预览共用；须先于 app/service.js 与 shader/glslHighlight.js 加载）
            'modules/agent/engine/hl-engine.js',
            'modules/agent/utils/modules.js',
            'modules/agent/utils/highlighter.js',
            'modules/agent/utils/particles.js',
            'modules/agent/utils/markdown.js',
            // 输入区 chip token 语法单一真源（代码行号引用 + 图层引用）：app/main.js 的
            // overlay/原子编辑/发送解析、engine/view.js 的气泡标签、chatViewHelpers 的
            // 编辑重发解析都经 global.AEAgentApp.chipTokens 取，须先于 app 与 engine 装载
            'modules/agent/utils/chipTokens.js',
            // 聊天区本地路径识别（绝对路径 + 数据根相对路径）：engine/view.js 渲染后 linkify，
            // 点击委托在 engine/bootstrap.js。须先于 view.js 装载（运行期按 global 取用）。
            'modules/agent/utils/localPaths.js',
            'modules/agent/app/state.js',
            'modules/agent/app/statusBar.js',
            'modules/agent/app/modals.js',
            // 工具可见性设置子面板：必须早于
            // app/settings.js（入口段按钮绑定按 AE_LLM.ToolVisibilityPanel 的存在性接线）。
            // 视图/条目运行时经 AE_LLM.createToolVisibility 现取（shared/toolVisibility.js 已在前面
            // 装载）；team/lanes.js 与 engine/settings.js 都晚于它，故本文件只做惰性读取，不依赖载序。
            'modules/agent/app/toolVisibilityPanel.js',
            'modules/agent/app/settings.js',
            'modules/agent/app/service.js',
            'modules/agent/app/bridge.js',
            'modules/agent/scripts/scriptSecurity.js',
            // 审计确认层：user-library dangers 记忆 + 确认弹窗编排
            //（挂 AE_LLM._scriptDangerMemory——quickBar/脚本树共用；载序在 service.js
            //  之后无碍——service 仅运行期引用，脚本执行晚于全页加载）
            'modules/agent/scripts/scriptDangerMemory.js',
            'modules/agent/app/script-tree.js',
            'modules/agent/scripts/utils.js',
            'modules/agent/scripts/bootstrap.js',
            'modules/agent/app/imageLightbox.js',
            'modules/agent/app/themeApplier.js',
            'modules/agent/app/reflectReviewPanel.js',
            'modules/agent/app/bindEvents/chatDocParse.js',
            'modules/agent/app/bindEvents/slashAutocomplete.js',
            // @ 文件引用补全（候选 = 输入区附件 chip，插入的是 file chip token）：
            // 工厂由 app/main.js 的 bindEvents 取用，须先于它装载
            'modules/agent/app/bindEvents/fileMentions.js',
            'modules/agent/app/bindEvents/runtimeModeSwitch.js',
            // 团队模式的 UI 段（团队开关 / lane 切换条 / 左抽屉「团队任务」tab / 全停入口）。
            // 位置：紧贴 app/main.js 之前——它只挂 DOM 与事件，对 AEAgentTeam.* 的取用全在**运行期**
            //（点击/轮询），不依赖 team/*.js 此刻已在场，故放在 app 层这段即可；
            // 若装配顺序需要更早/更晚，改这一行即可（登记点唯一）。
            'modules/agent/app/teamUI.js',
            'modules/agent/app/main.js',
            // 顶栏目标条：index.js 的 _ensureTopbar 直接用
            'modules/agent/app/goalBar.js',
            'modules/agent/index.js',
            'modules/agent/engine/state.js',
            'modules/agent/engine/settings.js',
            'modules/agent/engine/prompts.js',
            'modules/agent/engine/commands.js',
            'modules/agent/engine/service.js',
            'modules/agent/engine/context.js',
            'modules/agent/engine/validator.js',
            'modules/agent/engine/permissions.js',
            'modules/agent/engine/executor.js',
            'modules/agent/engine/view.js',
            'modules/agent/shader/shaderPreviewRenderer.js',
            'modules/agent/shader/glslHighlight.js',
            'modules/agent/app/shaderUI.js',
            // 预览区快照守卫：先于读写工具加载（shaderTools / controller/scriptTools
            // 惰性解析 global.AEEngine.previewSnapshot）
            'modules/agent/engine/previewSnapshot.js',
            // 内容锚定文本编辑：局部编辑的唯一实现——先于两个提交工具
            // 加载（shaderTools / controller/scriptTools 调用期解析 global.AEEngine.textEdits）
            'modules/agent/engine/textEdits.js',
            // 代码读取查询：search / startLine-endLine / segments 的唯一实现
            // ——先于三个消费点加载（shaderTools 两处 + controller/scriptTools 的 get_current_script
            // 调用期解析 global.AEEngine.codeQuery）
            'modules/agent/engine/codeQuery.js',
            'modules/agent/engine/guideTool.js',
            'modules/agent/engine/shaderContractTool.js',
            'modules/agent/engine/shaderTools.js',
            'modules/agent/engine/controller/scriptTranscode.js',
            'modules/agent/engine/controller/argParsing.js',
            'modules/agent/engine/controller/tokenStats.js',
            'modules/agent/engine/controller/toolHistory.js',
            'modules/agent/engine/controller/sessionLoadingUi.js',
            'modules/agent/engine/controller/chatViewHelpers.js',
            'modules/agent/engine/controller/messageHelpers.js',
            'modules/agent/engine/controller/webSearchTool.js',
            'modules/agent/engine/controller/readUrlTool.js',
            'modules/agent/engine/controller/skillStoreTool.js',
            'modules/agent/engine/controller/earlyHistoryTool.js',
            // 大工具结果暂存 + 分页读取（超限结果存全文 → read_tool_result 翻页，执行类工具不重跑）
            'modules/agent/engine/controller/toolResultStore.js',
            'modules/agent/engine/controller/toolResultReaderTool.js',
            'modules/agent/engine/controller/scriptTools.js',
            // 补表工具（propose_table_entry——预审→审核→确认→落表编排）
            'modules/agent/engine/controller/tableTools.js',
            'modules/agent/engine/controller/toolExecutionPipeline.js',
            'modules/agent/engine/controller/toolGating.js',
            'modules/agent/engine/controller/intentValidation.js',
            'modules/agent/engine/controller/planTracking.js',
            'modules/agent/engine/controller/contextCompression.js',
            'modules/agent/engine/controller/mediaReaders.js',
            'modules/agent/engine/controller/visionProxy.js',
            'modules/agent/engine/controller/streamAccumulator.js',
            // LLM 请求失败自动重试的唯一实现：先于 controller 加载（两个工具循环共用）
            'modules/agent/engine/controller/llmRetry.js',
            'modules/agent/engine/controller/inputDispatch.js',
            'modules/agent/engine/controller/apiActions.js',
            'modules/agent/engine/pendingInput.js',
            // 会话级 goal：状态机 → 三工具 → 续轮驱动器，都必须先于 controller
            'modules/agent/engine/goalState.js',
            'modules/agent/engine/goalTools.js',
            'modules/agent/engine/goalDriver.js',
            // 提问工具 askUser：工厂在 controller 构造期调用，必须先于 controller
            'modules/agent/engine/askUserTool.js',
            'modules/agent/engine/controller.js',
            'modules/agent/engine/aeContext.js',
            'modules/agent/engine/sessionStore.js',
            'modules/agent/engine/sessionSwitcher.js',
            'modules/agent/engine/apiReference.js',
            // 团队模式：lane 定义 / 团队设置访问器 / lane 提示词注入器 / 编排面。
            // 必须在 engine/bootstrap.js 之前——装配期要 setProvider、注册提示词注入器，并
            // 创建 orchestrator（AEAgentTeam.createOrchestrator）；晚于它就会出现「第一条 lane
            // 请求不带角色段」或「团队开关打开却拿不到编排面」的偶发。
            'modules/agent/team/lanes.js',
            'modules/agent/team/settings.js',
            'modules/agent/team/promptInjector.js',
            'modules/agent/team/orchestrator.js',
            // 团队模式：会话 binder / 只读工作区 / team 域工具 / 任务板纯函数。
            // 四条都必须在 engine/bootstrap.js **之前**（装配期就要拿到工厂：binder 是
            // orchestrator 的 sessions 注入项、workspace+teamTools 在 mount 期注册 read_workspace，
            // 晚一步就是「团队起来了但会话方法 not_wired / read_workspace 不可用」）。
            'modules/agent/team/sessionBinder.js',
            'modules/agent/team/workspace.js',
            // 团队任务清单（三条 Agent **共用一份**，落在团队工作区的
            // tasks.json）。必须在 engine/bootstrap.js 之前——装配期就要建实例并把 onChange 接到
            // 任务板刷新；晚一步就是「工具写了清单、面板不刷新」。
            'modules/agent/team/taskList.js',
            'modules/agent/team/teamTools.js',
            'modules/agent/team/taskBoard.js',
            // 派单纯逻辑。orchestrator 是**懒解析**它（真派单时才取工厂），故载序错位
            // 不会打穿装配；仍登记在 bootstrap 之前——否则派单显式失败 error、工作项段恒空。
            'modules/agent/team/dispatch.js',
            // 子 Agent 池。**必须在 engine/bootstrap.js 之前**——装配期就要
            // `AEAgentTeam.createSubagentPool` 建池并注入 orchestrator/initTeamTools；
            // 晚一步就是「三件 subagent 工具不注册、任务板子 Agent 段恒空」（池缺席是显式降级，
            // 不报错，所以载序错了只会安静地少功能——故登记必须与 bootstrap 同批）。
            'modules/agent/team/subagent.js',
            'modules/agent/engine/bootstrap.js',
            'modules/skill-manager/controller.js',
            'modules/skill-manager/index.js',
            'modules/mcp-manager/controller.js',
            'modules/mcp-manager/index.js',
            'modules/ae-tools/controller.js',
            'modules/ae-tools/view.js',
            'modules/ae-tools/index.js',
            'modules/memory/memoryStore.js',
            'modules/memory/memoryRegistry.js',
            'modules/memory/controller.js',
            'modules/memory/view.js',
            'modules/memory/index.js',
            'modules/memory/bootstrap.js',
            'modules/model-manager/controller.js',
            'modules/model-manager/view.js',
            'modules/model-manager/index.js',
            'features/cube3d.js',
            'features/easterEgg.js',
            'features/pixelSandbox.js',
            'features/bootSequence.js',
            // 首次打开阻隔弹窗（AI 免责声明闸门）：无依赖，**先于 bootstrap 运行**——
            // main.js 尾部的 startWithDisclaimerGate 拿到它放行后才调 bootstrap（未确认 = 扩展不加载）
            'features/firstRunDisclaimer.js',
            'features/deepseekPet/petEventBus.js',
            'features/deepseekPet/petSprites.js',
            'features/deepseekPet/petMovement.js',
            'features/deepseekPet/petActivityZone.js',
            'features/deepseekPet/petDragHandler.js',
            'features/deepseekPet/petSleepManager.js',
            'features/deepseekPet/petBehaviors/behaviorRegistry.js',
            'features/deepseekPet/petBehaviors/behaviors/idleWander.js',
            'features/deepseekPet/petBehaviors/behaviors/idleStretch.js',
            'features/deepseekPet/petBehaviors/behaviors/idlePotHead.js',
            'features/deepseekPet/petBehaviors/behaviors/idleEat.js',
            'features/deepseekPet/petBehaviors/behaviors/clickBounce.js',
            'features/deepseekPet/petBehaviors/behaviors/clickRage.js',
            'features/deepseekPet/petBehaviors/behaviors/dragFollow.js',
            'features/deepseekPet/petBehaviors/behaviors/longpressChat.js',
            'features/deepseekPet/petBehaviors/behaviors/timerAnnounce.js',
            'features/deepseekPet/petBehaviors/behaviors/crashOverride.js',
            'features/deepseekPet/petBehaviors/behaviors/sleepTalk.js',
            'features/deepseekPet/petBubble.js',
            'features/deepseekPet/petHistory.js',
            'features/deepseekPet/petMemory.js',
            'features/deepseekPet/petWebSearch.js',
            'features/deepseekPet/petChat.js',
            'features/deepseekPet/petIdleAnnounce.js',
            'features/deepseekPet/petAutoReply.js',
            'features/deepseekPet/petHistoryPanel.js',
            'features/deepseekPet/petSettings.js',
            'features/deepseekPet/petEasterEgg.js',
            'features/deepseekPet/petController.js',
            'features/deepseekPet/petIndex.js',
            'features/quickBar/quickBarScanner.js',
            'features/quickBar/quickBarExecutor.js',
            'features/quickBar/quickBarIndex.js',
            'features/extIndicator/extIndicator.js',
            'shared/fileUrl.js',
            'modules/comfyui/comfyuiService.js',
            'modules/comfyui/unetModels.js',
            'modules/comfyui/templateEngine.js',
            'modules/comfyui/modelRegistry.js',
            'modules/comfyui/controller.js',
            'modules/comfyui/view.js',
            'modules/comfyui/canvas/canvasView.js',
            'modules/comfyui/canvas/nodeSystem.js',
            'modules/comfyui/canvas/sharedUtils.js',
            'modules/comfyui/canvas/nodeRenderer.js',
            'modules/comfyui/canvas/edgeRenderer.js',
            'modules/comfyui/canvas/groupRenderer.js',
            'modules/comfyui/canvas/canvasController.js',
            'modules/comfyui/canvas/nodegenStore.js',
            'modules/comfyui/canvas/canvasHistory.js',
            'modules/comfyui/canvas/graphExecutor.js',
            'modules/comfyui/canvas/panelChat.js',
            'modules/comfyui/canvas/floatingPanel.js',
            'modules/comfyui/canvas/imageEditor.js',
            'modules/comfyui/canvas/imageGrid.js',
            'modules/comfyui/canvas/nodes/textNode.js',
            'modules/comfyui/canvas/nodes/imageInputNode.js',
            'modules/comfyui/canvas/nodes/videoInputNode.js',
            'modules/comfyui/canvas/nodes/imageGenNode.js',
            'modules/comfyui/canvas/nodes/videoGenNode.js',
            'modules/comfyui/canvas/nodes/imageEditNode.js',
            'modules/comfyui/canvas/nodes/index.js',
            'modules/comfyui/canvas/genSessionManager.js',
            'modules/comfyui/canvas/canvasIndex.js',
            'modules/comfyui/index.js',
            'modules/comfyui/uiToApi.js',
            'modules/comfyui/customWorkflow.js',
            'modules/comfyui/partnerDiscovery.js',
            'modules/comfyui/templateDeriver.js',
            'modules/comfyui/officialTemplates.js',
            'modules/comfyui/officialTemplateModal.js',
            'modules/comfyui/bootstrap.js',
            'modules/assets/shared/treeView.js',
            'modules/assets/shared/cardStack.js',
            'modules/assets/shared/folderStoreMixin.js',
            'modules/assets/shared/folderViewMixin.js',
            'modules/assets/shared/previewStore.js',
            'modules/assets/assetRefs/refStore.js',
            'modules/assets/projectAssets/projectAssetStore.js',
            'modules/assets/presets/ffxMeta.js',
            'modules/assets/presets/presetStore.js',
            'modules/assets/presets/presetView.js',
            'modules/assets/assetRefs/refView.js',
            'modules/assets/projectAssets/projectAssetView.js',
            'modules/assets/index.js',
            'modules/assets/bootstrap.js',
            // 外接模式（EXT-MCP）：对外 MCP Server 的面板侧——策略/投影/Bridge 客户端/装配。
            // 依赖 toolRegistry(37)/bridge(40)/serverManager(50) 先行加载（运行期经 global 引用）
            'shared/external-guidelines.js',
            'modules/agent/external/extPolicy.js',
            'modules/agent/external/extTools.js',
            'modules/agent/external/extBridgeClient.js',
            'modules/agent/external/view.js',
            'modules/agent/external/bootstrap.js',
            'main.js',
        ]
    };
})(window);
