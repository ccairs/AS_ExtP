(function (global) {
    'use strict';
    // Script 模式工具实现层拆分。由 controller.js 组装区经 AEEngine.createScriptTools() 创建。
    // 纯迁移自 controller.js 内联在工具注册处的 submit_script / get_current_script 两个 handler。
    // 提供两个工厂方法，返回 handler 供 controller.js 注册时调用。
    // opts 注入（对应 controller.js createController 作用域闭包变量）：
    //   getStopRequested / getActiveAbortController：stopRequested / activeAbortController 为可变 let，
    //     经惰性 getter 注入，运行时读取以保持原逻辑。
    // scriptTranscode / argParsing / scriptContextManager / validator：引擎已拆或注入的依赖
    //   getCurrentScript / onScriptReady / getSettings：controller 注入的回调
    //   isInfrastructureError：controller 作用域辅助函数
    function createScriptTools(opts) {
        // ── 写前快照守卫（陈旧读→写拦截）──
        // 语义与生命周期见 engine/previewSnapshot.js 头注：get_current_script 读到即留
        // 快照，submit_script 落笔前比对当前预览区——不一致（用户在读取后手改/他处写入）
        // 即拒绝写入并回喂「重新读取」指引，防按旧内容局部合并或整份覆盖掉用户改动。
        // 快照按调用方分账（面板内 vs 外接客户端），别人写完不顶替本调用方的读账——
        // 面板内的写入照样拦。store 缺席（旧装配/测试沙箱未载 previewSnapshot.js）时
        // 守卫缺席，行为同接入前。
        var PREVIEW_AREA = 'script';
        var STALE_PREVIEW_MESSAGE = '预览区内容在最近一次读取之后已被修改（用户手动编辑，或由其他调用方写入），'
            + '为避免按旧内容写入覆盖这些改动，本次提交已被拒绝、未写入。'
            + '请先调用 get_current_script 重新读取预览区最新内容，确认后再基于最新内容重新提交。';
        var READ_REQUIRED_MESSAGE = '预览区已有内容，但你尚未读取过它。'
            + '为避免在不知情的情况下覆盖现有代码，本次提交已被拒绝、未写入。'
            + '请先调用 get_current_script 读取预览区当前内容，确认后再提交。';
        // 空预览区不再放行（「写前必读，就算是首次提交也要」）：
        // 面板重载会回填草稿，空与否以读取结果为准；空读同样留账，读一次即解
        var READ_REQUIRED_EMPTY_MESSAGE = '预览区当前为空，但你尚未读取过它。'
            + '按"写前必读"规则，每次提交（含首次生成）前都要先读取一次预览区'
            + '（面板重载可能回填草稿，空与否须以读取结果为准）。'
            + '本次提交已被拒绝、未写入。请先调用 get_current_script 读取，再提交。';
        // 行号定位已移除：局部编辑一律内容锚定（见
        // engine/textEdits.js 头注）。传 startLine/endLine 的陈旧调用必须显式拒绝——
        // 若按"不传 oldText/edits 即整份提交"静默处理，只想改一处的调用会变成整份覆盖，
        // 把预览区其余内容吃掉。
        var LEGACY_LINE_EDIT_MESSAGE = 'startLine/endLine 局部编辑已移除（行号会随内容规整与模型计数漂移而改错行，且改错得静默）。'
            + '局部编辑请改用内容锚定：oldText（要替换的原文，须与预览区当前内容逐字符一致、且在其中唯一）+ newText（替换文本，空串=删除）；'
            + '多段一次改完用 edits:[{oldText,newText}, ...]。整份提交不传 oldText/edits。本次未写入预览区。';
        // 本实例所属 lane（团队模式）：每 lane 一个 controller ⇒ 每 lane 一份
        // scriptTools，lane 由 controller 装配时注入。两种命名（laneId / laneKey）的字符串或 getter
        // 形态都接受——controller 侧现有的 getLaneId() / getLaneKey() 两个名字都能直接接上。
        // 取不到（单 Agent 路径）⇒ 空串 ⇒ 缺省 lane，读写落缺省槽，行为与分槽前逐字节一致。
        function previewLane() {
            var cands = [opts.laneId, opts.laneKey,
                opts.lane && opts.lane.id, opts.lane && opts.lane.laneKey,
                opts.getLaneId, opts.getLaneKey];
            for (var i = 0; i < cands.length; i++) {
                var v = cands[i];
                if (typeof v === 'function') { try { v = v(); } catch (_) { continue; } }
                if (typeof v === 'string' && v) return v;
            }
            return '';
        }
        // 预览区账本解析（**唯一的 previewSnapshot 回退点**，按 lane 参数化）：
        //   ① 注入的 store（测试/旧装配）优先；② 否则全局单例（engine/previewSnapshot.js）。
        // 两者都按 lane 取视图（store.forLane(lane)）：只做槽位与会话指针的分槽，
        // 账本仍是同一份单例——同一 lane 的读写命中同一账本，不同 lane 各记自己的账；
        // 单 Agent 路径 lane 为空 ⇒ 原样返回 store，零包装、零行为变化。
        // state（= previewWriter 的返回）带执行侧 lane 时以它为准（与 shader 侧同因同解）。
        function snapshotStore(state) {
            var injected = (opts.previewSnapshot && typeof opts.previewSnapshot.check === 'function') ? opts.previewSnapshot : null;
            var store = injected || ((global.AEEngine && global.AEEngine.previewSnapshot) || null);
            var lane = (state && typeof state.lane === 'string') ? state.lane : previewLane();
            if (store && lane && typeof store.forLane === 'function') return store.forLane(lane);
            return store;
        }
        // 内容锚定编辑库（engine/textEdits.js）：局部编辑的唯一实现，script/shader 两个
        // 提交工具共用。缺席（旧装配 / 遗留沙箱未载该文件）时局部编辑报 infra_error 并
        // 指引整份提交——**不做第二份实现兜底**：匹配语义属正确性核心，双实现必然漂移。
        function textEditLib() {
            return (global.AEEngine && global.AEEngine.textEdits) || null;
        }
        // 代码读取查询（engine/codeQuery.js）：search / startLine-endLine / segments 的校验与
        // 执行的唯一实现，本文件的 get_current_script 与 shader 侧两处（get_current_shader、
        // shader_library get）共用同一份实现。
        // 缺席时如实报 infra_error，**不退回整篇读取**（静默退回正是要消掉的形态：模型以为
        // 读的是它要的区间/检索页，回执却是一整篇）。
        function codeQueryLib() {
            return (global.AEEngine && global.AEEngine.codeQuery) || null;
        }
        function codeQueryUnavailable() {
            return { success: false, result: JSON.stringify({ status: 'infra_error', message: '内部装配缺失（codeQuery 未加载）：代码读取查询不可用，请在 AE 中重新打开扩展面板后重试。' }) };
        }
        // 片段规整（局部编辑的 newText）：与整份提交共用 cleanScriptContent，但——
        //   ① 只在整串被围栏包住时剥围栏（中部围栏是正文，剥了会把替换范围缩到围栏体）；
        //   ② 补回被 cleanScriptContent 结尾 .trim() 吃掉的片段边界空白（首行缩进/尾换行）：
        //      片段合并进文档时缩进丢失会错位、尾换行丢失会让末行与后文粘连。shader 侧用
        //      stripFencesSoft 规避同一问题（见 shaderTools.js 同名注释）。
        // newText 若直接过 cleanScriptContent，实测
        // '    return a * 2;' 落库成 'return a * 2;'（缩进丢失）、尾换行丢失导致 '}' 上提。
        function cleanEditFragment(te, su, raw) {
            var s = String(raw == null ? '' : raw);
            if (!s.trim()) return '';                       // 纯空白 = 删除（对齐整份提交的空判据）
            var state = te.fenceState(s);
            if (state === 'inner') return s;                // 中部围栏：原样落库（不做文档级规整）
            var body = (state === 'wrapped' || state === 'open') ? te.stripEditFences(s) : s;
            var cleaned = su.cleanScriptContent(body);
            if (!cleaned) return '';
            var leadWs = (/^\s*/.exec(body) || [''])[0];
            var tailWs = (/\s*$/.exec(body) || [''])[0];
            if (leadWs && !/^\s/.test(cleaned)) cleaned = leadWs + cleaned;
            if (tailWs && !/\s$/.test(cleaned)) cleaned = cleaned + tailWs;
            return cleaned;
        }
        // oldText 的 refine（未命中时的第二遍匹配）：先按围栏规则剥壳，再走 cleanScriptContent
        // （ES6→ES3 等）。中部围栏不 refine——cleanScriptContent 只取第一段围栏，会把锚点缩到
        // 围栏体，可能命中更小的跨度并静默改错范围（实测）。
        function refineScriptFragment(te, su, raw) {
            var s = String(raw == null ? '' : raw);
            var state = te.fenceState(s);
            if (state === 'inner') return s;
            var body = (state === 'wrapped' || state === 'open') ? te.stripEditFences(s) : s;
            return su.cleanScriptContent(body);
        }
        // 调用方身份（toolExecutor 透传的执行上下文）：面板内为空串＝'panel' 账；
        // 外接 dispatch 传 'ext:<clientId>'，各自记账互不顶替。
        // 与 shader 侧同因同解：返回 {callerId, lane}——lane 取**执行者**的
        // execLane（单 Agent 为空串；旧装配/外接无该键时为 null ⇒ 回落 previewLane()）。
        function previewWriter(execCtx) {
            return {
                callerId: String((execCtx && execCtx.callerId) || ''),
                lane: (execCtx && typeof execCtx.execLane === 'string') ? execCtx.execLane : null
            };
        }
        // 停止态判据：**执行侧优先**（与 shader 侧同因同解）。
        // 工具注册表只有一份且 last-wins ⇒ 本 handler 可能是另一条 runtime（团队 lane /
        // 子 Agent）注册的那一份，它闭包里的停止 getter 指向的不是本次执行者——真机后果：
        // 进过一次团队模式（关团队 = 三条 lane 全停，其 stopRequested 永久为真）后切回
        // script 档，submit_script 每次都在入口回 {status:'stopped'}（最小脚本也一样），
        // 而当前轮脚本流程照常跑（它问的是真正在跑的那条 controller）。
        // execCtx 里的判据由 toolExecutionPipeline 随每次调用下发；取不到时回落到注入的
        // getter（旧装配 / 测试沙箱直接调 handler 的路径，行为同接入前）。
        function stopRequestedForCtx(execCtx) {
            try {
                if (typeof opts.getStopRequested === 'function' && opts.getStopRequested(execCtx)) return true;
            } catch (_) { return false; }
            try {
                var ac = typeof opts.getActiveAbortController === 'function' ? opts.getActiveAbortController(execCtx) : null;
                return !!(ac && ac.signal && ac.signal.aborted);
            } catch (_) { return false; }
        }
        function currentPreviewText() {
            try {
                var cur = opts.getCurrentScript();
                return String(cur == null ? '' : cur);
            } catch (_) { return ''; }
        }
        // 拒绝则返回回喂 LLM 的结果（两种：陈旧读 / 未读），可写则返回 null
        // state = previewWriter 的返回（{callerId, lane}）：账本槽位与调用方分账都按执行侧取。
        function stalePreviewRejection(state) {
            var store = snapshotStore(state);
            if (!store) return null;
            var r;
            try { r = store.check(PREVIEW_AREA, currentPreviewText(), (state && state.callerId) || ''); } catch (_) { return null; }
            if (!r || r.ok) return null;
            if (r.code === 'READ_REQUIRED') {
                return {
                    success: false,
                    result: JSON.stringify({
                        status: 'read_required',
                        message: r.currentEmpty ? READ_REQUIRED_EMPTY_MESSAGE : READ_REQUIRED_MESSAGE,
                        currentHash: r.currentHash,
                        currentLines: r.currentLines
                    })
                };
            }
            return {
                success: false,
                result: JSON.stringify({
                    status: 'stale_preview',
                    message: STALE_PREVIEW_MESSAGE,
                    readHash: r.readHash,
                    currentHash: r.currentHash,
                    currentLines: r.currentLines
                })
            };
        }
        // 读取留存 / 写入后刷新。写入侧按实际落库内容记——script 侧写入要过
        // cleanScriptContent 规整，与提交原文可能不同，故统一读回预览区取值。
        function recordPreviewRead(state) {
            var store = snapshotStore(state);
            if (store) { try { store.recordRead(PREVIEW_AREA, currentPreviewText(), (state && state.callerId) || ''); } catch (_) {} }
        }
        function recordPreviewWrite(state) {
            var store = snapshotStore(state);
            if (store) { try { store.recordWrite(PREVIEW_AREA, currentPreviewText(), (state && state.callerId) || ''); } catch (_) {} }
        }

        function buildSubmitScriptHandler() {
            return async function(args, execCtx) {
                args = args || {};
                var writer = previewWriter(execCtx);
                // 用户已点 stop：直接返回，避免阻塞 validator.validate（可能耗时数秒）
                if (stopRequestedForCtx(execCtx)) {
                    return { success: false, result: JSON.stringify({ status: 'stopped', message: '已停止。' }) };
                }
                // 陈旧行号调用显式拒绝（早于守卫：这是参数形态错误，不该先答"陈旧读"）。
                // 判「参数存在」而非 typeof==='number'：字符串
                // "3"/null/true/数组/对象形态穿透时，落进「无 oldText/edits → 整份提交」
                // 分支，把只想改一处的调用变成整份覆盖（实测预览区被整体替换）。
                if (args.startLine !== undefined || args.endLine !== undefined) {
                    return { success: false, result: JSON.stringify({ status: 'error', message: LEGACY_LINE_EDIT_MESSAGE }) };
                }
                // 写前快照守卫（早拦）：预览区在读取后被改过 → 直接拒绝，不进 AST 门
                // 与 validator，省掉白跑一遍审查的开销
                var staleEarly = stalePreviewRejection(writer);
                if (staleEarly) return staleEarly;
                var te = textEditLib();
                // 装配缺失 + 调用带编辑参数：报 infra_error——静默按整份提交处理会让带
                // oldText 的调用变成整份覆盖（与 startLine 陈旧调用同一条红线）
                if (!te && (args.oldText != null || args.newText != null || args.edits != null)) {
                    return { success: false, result: JSON.stringify({ status: 'infra_error', message: '内部装配缺失（textEdits 未加载）：局部编辑不可用，请改用整份提交，或在 AE 中重新打开扩展面板后重试。' }) };
                }
                var req = te ? te.parseRequest(args, 'script') : { mode: 'full' };
                if (req.error) {
                    return { success: false, result: JSON.stringify({ status: 'error', message: req.error.message }) };
                }
                var isEdit = req.mode === 'edit';
                var rawScript = String(args.script == null ? '' : args.script);
                // LLM 提交链路与预览区统一走 AEAgentApp.scriptUtils（scripts/
                // utils.js 单一实现；scripts.manifest.js 加载顺序 utils.js 先于本文件，
                // 调用时已就绪）——opts.scriptTranscode 仅作 utils.js 未注入的测试沙箱
                // 兜底（其转译函数已委托/同步 utils.js，行为等价）。
                var _su = (global.AEAgentApp && global.AEAgentApp.scriptUtils) || opts.scriptTranscode;
                var cleanedScript = _su.cleanScriptContent(rawScript);
                var finalScript = cleanedScript;
                var editResults = null;
                var docCleanNote = '';
                if (isEdit) {
                    // 局部编辑（内容锚定）：读预览区当前代码，按 oldText 唯一
                    // 命中做替换/删除（newText 空串即删除），合并后整体校验再写回。
                    var current = opts.getCurrentScript();
                    if (!current || !current.trim()) {
                        return { success: false, result: JSON.stringify({ status: 'error', message: '预览区为空，无法局部编辑。请先整份提交一次 submit_script。' }) };
                    }
                    // newText 走片段规整（cleanEditFragment）：与整份提交共用 cleanScriptContent，
                    // 但补回被它结尾 trim 吃掉的片段边界空白；oldText 先按原文匹配，未命中时由
                    // applyEditsWithRefine 过同一规整再试（模型凭记忆写出的 oldText 可能是
                    // ES6/带围栏的"改写前"形态）。
                    var editList = [];
                    for (var ei = 0; ei < req.edits.length; ei++) {
                        editList.push({
                            oldText: req.edits[ei].oldText,
                            newText: cleanEditFragment(te, _su, req.edits[ei].newText)
                        });
                    }
                    var applied = te.applyEditsWithRefine(current, editList, function (t) { return refineScriptFragment(te, _su, t); });
                    if (!applied.ok) {
                        return { success: false, result: JSON.stringify({ status: 'error', message: te.formatFailure(applied, 'get_current_script') }) };
                    }
                    // 合并结果补一次**文档级**规整：写回侧（service.js）还会再跑一次
                    // cleanScriptContent，若预览区本身含规整会改写的内容（围栏/压缩单行/跨行
                    // alert 串），不先规整就会「门/校验/回执看的是 A、落库的是 B」——回执行数
                    // 与实际落库对不上（实测：回执 4 行、落库 2 行）。
                    // 规整后门/校验/回执/落库同源，写回侧那次变成幂等。
                    finalScript = _su.cleanScriptContent(applied.content);
                    editResults = applied.results;
                    // 文档级规整若改变了总行数（围栏提取/压缩重排等），在回执里说明——否则
                    // 回执只讲"替换了 1 处"，模型对整篇被改写毫无察觉。
                    if (te.countLines(finalScript) !== te.countLines(applied.content)) {
                        docCleanNote = '（注意：写入前的文档级规整把总行数从 ' + te.countLines(applied.content)
                            + ' 变为 ' + te.countLines(finalScript) + '——预览区其它部分可能被规整改写，建议读回确认）';
                    }
                } else if (!cleanedScript) {
                    // 整份提交：脚本必填非空
                    return { success: false, result: JSON.stringify({ status: 'error', code: 'EMPTY_CODE', message: '脚本内容为空，无法提交。' }) };
                }
                // 提交期门预检（validate-only）：只校验不写回
                //（预览区写入原文 cleanedScript，reemit 丢注释「所存即所见」保持；
                // 运行时 runScript 过门产出瞬态重发射产物执行）。拒绝以工具结果错误
                // 形态回喂 LLM 自改写（对齐 validator 拒绝回喂既有形态）；bypass
                // ['llm-preview'] ON 时 run.js 内部已把 policy 四域全开（门照跑
                // ——免打扰不是免检），调用方无需特殊处理。门缺席（ast-gate 未载）
                // 时跳过——validator 语义审查仍在（另一层）。
                if (global.AE_LLM && typeof global.AE_LLM._runSandboxedScript === 'function') {
                    var _gatePre = global.AE_LLM._runSandboxedScript(finalScript, { source: 'llm-preview' });
                    if (!_gatePre.ok) {
                        return { success: false, result: JSON.stringify({ status: 'error', message: 'AST 门拒绝提交：' + _gatePre.displayText }) };
                    }
                }
                // 审查层：**外接通道跳过**。
                // 该层是**面板自己的 LLM 审查**（`validator.validate` = 纯 LLM 层，见 validator.js:1-8
                // 与 :74-94；AST 门在上面 :229 已独立跑过，**不受影响**）。理由与 executeExtendScript
                // 那条相同：外接客户端自带模型、面板不必配 LLM，接了会把外接卡在面板配置上。
                // 判据：toolExecutor 传进来的 `callerId` 前缀 `'ext:'`（extBridgeClient.js 的
                // `'ext:' + clientId`）；面板路径 callerId 为空 ⇒ 照旧强制审查（缺模型时 fail-closed）。
                var _isExtCall = !!(execCtx && typeof execCtx.callerId === 'string'
                    && execCtx.callerId.indexOf('ext:') === 0);
                var validateResult = { valid: true, warnings: [] };
                if (_isExtCall) {
                    console.warn('[submit_script] 外接通道：跳过面板 LLM 审查（外接自带模型；AST 门与快照守卫仍生效）');
                } else {
                    // 校验：从上下文提取最近 user 消息作为 userMessage。
                    // 上下文 cm 取**执行者**当前档位的 cm（同类 last-wins 收口）
                    // （ctx.getActiveCm）——注册表里本 handler 可能属于另一条 runtime（团队
                    // lane / 子 Agent），用它的 scriptContextManager 会把审查上下文换成另一
                    // 条会话的历史（审查质量退化且跨会话串味）。取不到才回落本实例那一份。
                    var _reviewCm = null;
                    try {
                        if (execCtx && typeof execCtx.getActiveCm === 'function') _reviewCm = execCtx.getActiveCm();
                    } catch (_) { _reviewCm = null; }
                    if (!_reviewCm) _reviewCm = opts.scriptContextManager;
                    var ctxMsgs = opts.argParsing.filterContextForReview(_reviewCm.toLlmMessages());
                    var lastUserMsg = '';
                    for (var i = ctxMsgs.length - 1; i >= 0; i--) {
                        if (ctxMsgs[i].role === 'user') { lastUserMsg = ctxMsgs[i].content || ''; break; }
                    }
                    var _ssSettings = typeof opts.getSettings === 'function' ? (opts.getSettings() || {}) : {};
                    validateResult = await opts.validator.validate(finalScript, {
                        userMessage: lastUserMsg,
                        contextMessages: ctxMsgs,
                        timeoutMs: _ssSettings.executionTimeoutMs,
                        signal: opts.getActiveAbortController(execCtx) && opts.getActiveAbortController(execCtx).signal
                    });
                }
                // signal abort 导致的 MODEL_REVIEW_FAILED 不应让 LLM 重试脚本：
                // 区分"用户停止"与"真实校验失败"，避免 LLM 误判为脚本错误去重新提交。
                if (stopRequestedForCtx(execCtx)) {
                    return { success: false, result: JSON.stringify({ status: 'stopped', message: '已停止。' }) };
                }
                if (validateResult.valid) {
                    // 二次守卫：堵住校验（异步窗口，可能数秒）期间用户对预览区的改动
                    var staleLate = stalePreviewRejection(writer);
                    if (staleLate) return staleLate;
                    // 校验通过后再写入预览区（用户可查看/编辑）。
                    // 写入目标按**工具族**显式声明（{ area: 'script' }）：外接可在任意面板模式
                    // 下调本工具，只按面板模式选目标会把脚本写进 GLSL 区。返回 false = 写入
                    // 入口未接受本次写入（目标编辑区缺失、装配未接线，或当前身份没有预览区
                    // 写入通道）→ 报错，绝不回"已写入"（回执描述的内容不在预览区属静默失败）。
                    var wrote = opts.onScriptReady(finalScript, { area: 'script' });
                    if (wrote === false) {
                        return { success: false, result: JSON.stringify({ status: 'error', message: '写入预览区失败：写入入口未接受本次写入（脚本编辑区缺失、装配未接线，或当前运行身份没有预览区写入通道——如团队子 Agent）。本次未交付——请先重开扩展面板后重试；若当前是团队子 Agent，请把产出交回上级 Agent 再提交。' }) };
                    }
                    recordPreviewWrite(writer);
                    var warningText = (Array.isArray(validateResult.warnings) && validateResult.warnings.length > 0)
                        ? ' 风险提示: ' + validateResult.warnings.map(function(w) { return w.message || w.code || ''; }).join('; ')
                        : '';
                    // 回执带行数：写前只有"ok"没有坐标系，模型想知道自己写成
                    // 多少行只能靠数——正是"数错行"的来源。totalLines 按落库内容计；编辑另给
                    // 每处明细（line=该处锚点命中行号，坐标系为应用该处时的内容；多段编辑时是
                    // 中间坐标，不是最终坐标——要最终坐标请用读取工具重读）。
                    var totalLines = te ? te.countLines(finalScript) : finalScript.split('\n').length;
                    var editDetail = (editResults && editResults.length <= 3) ? ('（' + te.describeEdit(editResults) + '）') : '';
                    // 多段编辑时 edits[].anchorLine 是各步应用时的坐标（非最终坐标）——回执说清，
                    // 免得模型拿它当改动后的位置去做行号推理
                    var coordNote = (editResults && editResults.length > 1)
                        ? '（多段编辑：edits[].anchorLine 为各步锚点命中行，非最终坐标；要最终坐标请用 get_current_script 重读）'
                        : '';
                    var passMsg = isEdit
                        ? ('已按内容锚定替换 ' + editResults.length + ' 处' + editDetail + '，合并后校验通过，已写入预览区（共 ' + totalLines + ' 行）。' + coordNote + docCleanNote + warningText)
                        : ('脚本校验通过，已写入预览区（共 ' + totalLines + ' 行）。' + warningText);
                    var passPayload = { status: 'passed', message: passMsg, totalLines: totalLines };
                    if (isEdit) passPayload.edits = editResults;
                    return {
                        success: true,
                        result: JSON.stringify(passPayload)
                    };
                }
                // 基础设施错误
                if (validateResult.errors && validateResult.errors.some(function(e) { return opts.isInfrastructureError(e && e.message); })) {
                    return { success: false, result: JSON.stringify({ status: 'infra_error', message: '检测到 CEP/CSInterface 未就绪（CSINTERFACE_UNAVAILABLE），请在 AE 中重新打开扩展面板后重试。' }) };
                }
                // 校验失败：返回错误供 LLM 修正
                var errorLines = (validateResult.errors || []).map(function(e) { return '- ' + (e.message || e.code || ''); });
                return {
                    success: false,
                    result: JSON.stringify({ status: 'failed', message: '脚本校验失败，请修正后重新提交。', errors: errorLines })
                };
            };
        }

        function buildGetCurrentScriptHandler() {
            return function(args, execCtx) {
                args = args || {};
                var writer = previewWriter(execCtx);
                var current = opts.getCurrentScript();
                // 参数校验必须在记账之前：被拒的读不算"读过"——一次参数错误的调用若留下读账，
                // 会把「从未读过 + 预览区非空 → 拒绝写入」那道防线永久解除。
                // 判据与 shader 侧同一份实现（engine/codeQuery.js，两侧必须同源）。
                var cq = codeQueryLib();
                if (!cq) return codeQueryUnavailable();
                var _qErr = cq.validateCodeQueryArgs(args);
                if (_qErr) return _qErr;
                // 空预览区：读回的就是"当前为空"这一事实，空读同样留账（供 submit_script 的
                // 写前比对，也解「写前必读」——空与否以读取结果为准）。
                if (!current || !current.trim()) {
                    recordPreviewRead(writer);
                    return { success: true, result: JSON.stringify({ status: 'empty', message: '预览区当前为空。' }) };
                }
                // 只有真正交付了内容的读才留账：search 未命中、offset 越界这类没有返回任何
                // 内容的读不算"读过"——否则一次无效读就解除了「从未读过 → 拒绝写入」的防线。
                var _su = (global.AEAgentApp && global.AEAgentApp.scriptUtils) || null;
                var _st = opts.scriptTranscode || null;
                // 四种查询（search / segments / startLine-endLine / 整篇）与 shader 侧共用同一实现。
                // segments 分段器是语言特定的：ES3 走 scriptTranscode（engine 侧实现），GLSL 侧走
                // shaderTools 的分段器；截断提示的主语按语言取「脚本」。
                // 取值顺序：**谁真有 buildSegments 就用谁**——`AEAgentApp.scriptUtils` 只导出
                // restoreNewlines/transpileEs6ToEs3/cleanScriptContent，按"scriptUtils 优先"
                // 取会把 undefined 传进 codeQuery，segments 全链报「内部装配缺失」。
                var res = cq.runCodeQuery(current, args, {
                    buildSegments: (_su && _su.buildSegments) || (_st && _st.buildSegments),
                    subject: '脚本'
                });
                var delivered = false;
                try {
                    var p = JSON.parse(res && res.result);
                    delivered = !!res && res.success !== false && p && p.status === 'ok';
                } catch (_) {}
                if (delivered) recordPreviewRead(writer);
                return res;
            };
        }

        return { buildSubmitScriptHandler: buildSubmitScriptHandler, buildGetCurrentScriptHandler: buildGetCurrentScriptHandler };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createScriptTools = createScriptTools;
})(typeof global !== 'undefined' ? global : window);