(function (global) {
    'use strict';
    function createMessageHelpers(opts) {
        // opts 注入：{ state, getActiveCm, saveActiveSessionDebounced, syncView, getRoundModuleId }

        // 构建动态上下文前缀（时间/AE snapshot/引用文件），用 <context> 标签包裹便于 UI 剥离。
        // 持久化到 user message 后历史内容稳定，避免每轮重新注入导致前缀不一致断缓存。
        // 模型/平台信息已在 system prompt 的 buildSystemCognition 中注入，此处不重复。
        // fileCtx: 可选，用户拖入的文件引用块（[引用文件]\n文件1: path (name)...），注入到 <context> 内，
        //          UI 经 stripContextBlock 剥离不显示，LLM 能看到文件路径。
        // AE snapshot 按当前轮模块身份取（getRoundModuleId）：不调 gather 的注入通道（执行中追加
        // 队列、addUserMessage）复用上一次快照，身份过滤掉跨模式陈旧数据（shader 轮无工程快照）。
        // 上下文用量行：用量过半才注入一行**纯数字**（≤50% 不注入，平时零 token 成本）。
        // 只报「约 N%」，不解释、不预告、不给建议——该不该收着说话、要不要分页读，由模型自己判断。
        // 阈值取「大于 50」。
        // 为什么不带解释句（实测）：前缀在消息落库时就冻结，而发送前的自动压缩
        // 发生在冻结之后——实测 91% 的提示与压缩后的真实 28% 出现在同一次请求里，任何"已达阈值/
        // 已被折叠"的说法都是假数字，且与压缩摘要卡自带的「已压缩早期对话，保留最近的消息」重复。
        // 只给「约 N%」不给剩余额度：percentUsed 是启发式估算（CJK 1 char/token），分母由
        // contextManager 的生效上限决定 —— 模型自报窗口优先，未上报
        // 才用设置项「上下文 Token 兜底上限」（model-manager 的 contextWindow 已是它的数据源，
        // 见 context.js 的 readModelContextWindow；旧注释「面板侧无消费者」已过时）
        // ——报硬数字，估偏时模型据错值放开读取会直接撞裁剪。
        // pendingText：当前轮这条消息本身。前缀在落库前取值、面板的阈值判定在落库后，不补这笔
        // 就会出现「面板 91% / 模型被告知 75%」两套数（32K 档粘贴长文本即可跨档）。
        var USAGE_MIN_PCT = 50;
        function buildContextUsageLine(pendingText) {
            var cm = typeof opts.getActiveCm === 'function' ? opts.getActiveCm() : null;
            if (!cm || typeof cm.getTokenStats !== 'function') return '';
            var stats = cm.getTokenStats();
            var total = Number(stats && stats.totalTokens);
            var max = Number(stats && stats.maxTokens);
            // 字段缺失/非法一律整行不注入：宁可不说，也不把「约 NaN%」写进 prompt
            if (!isFinite(total) || !isFinite(max) || max <= 0) return '';
            var pending = 0;
            if (pendingText && typeof cm.estimateTokens === 'function') {
                pending = Number(cm.estimateTokens(pendingText)) || 0;
            }
            var pct = Math.round(((total + pending) / max) * 100);
            if (pct <= USAGE_MIN_PCT) return '';
            return '上下文用量: 约 ' + pct + '%';
        }

        function buildContextPrefix(fileCtx, pendingText) {
            var block = '';
            var now = new Date();
            var pad = function (n) { return String(n).padStart(2, '0'); };
            block += '当前本地时间: ' + now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
                + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + '（用户时区）';
            // 用量行紧随时间行（同属"当前轮处境"：先让模型看到余量，再看工程状态）
            var usageLine = buildContextUsageLine(pendingText);
            if (usageLine) block += '\n' + usageLine;
            // AE snapshot（gather 已提前到 addMessage 之前调用）
            if (global.AEEngine && global.AEEngine.aeContext && typeof global.AEEngine.aeContext.getSnapshot === 'function') {
                // 与 gather 同一对身份：moduleIds 决定作用域合法性，laneKey 只做分槽。
                // 不注入新 getter 时退回 getRoundModuleId（单 Agent 路径行为不变）。
                var _roundId = (typeof opts.getToolModuleIds === 'function') ? opts.getToolModuleIds() : null;
                if (!_roundId && typeof opts.getRoundModuleId === 'function') _roundId = opts.getRoundModuleId();
                // 槽键**只认 lane**（同 inputDispatch/controller）：单 Agent 传 undefined 落缺省槽，
                // 不得用 roundModuleId(mode) 当槽键（实测：会让跨模式陈旧快照被放行）。
                var _laneKey = (typeof opts.getLaneKey === 'function') ? opts.getLaneKey() : null;
                var snap = global.AEEngine.aeContext.getSnapshot(_roundId, _laneKey || undefined);
                if (snap) block += '\n' + snap;
            }
            // 引用文件块（用户拖入的文件路径），注入 <context> 内供 LLM 看到，UI 剥离不显示
            if (fileCtx) block += '\n' + fileCtx;
            // 引用图层块（「当前选中」点击建引用），同上
            return '<context>\n' + block + '\n</context>\n\n';
        }

        function addMessage(role, text, detail, images, extra) {
            // user 消息（非 _hidden）注入 <context> 前缀，持久化后历史内容稳定可缓存
            if (role === 'user' && !(extra && extra._hidden)) {
                text = buildContextPrefix(extra && extra.fileCtx, text) + (text || '');
            }
            var msg = { role: role, text: text, detail: detail, images: images || null, createdAt: Date.now() };
            // displayText：UI 渲染用原始文本（含 chip token），与 LLM 用 text（转换后）分离；
            // 跨会话恢复后聊天框仍能显示 chip 标签
            if (extra && extra.displayText) msg.displayText = extra.displayText;
            if (extra && Array.isArray(extra.videos) && extra.videos.length) msg.videos = extra.videos;
            if (extra && Array.isArray(extra.fileRefs) && extra.fileRefs.length) msg.fileRefs = extra.fileRefs;
            if (extra && extra.reasoningContent) msg.reasoningContent = extra.reasoningContent;
            // _llm 标记：区分 LLM 回复与程序生成的提示消息（"已停止"、"修正失败"等）。
            // view 对 _llm assistant 消息渲染时间戳操作条；程序生成的提示消息不挂操作条。
            if (extra && extra._llm) msg._llm = true;
            opts.state.messages.push(msg);
            var cmExtra = extra || {};
            if (images) cmExtra.images = images;
            if (extra && extra.displayText) cmExtra.displayText = extra.displayText;
            // 附件持久化：videos/fileRefs 也同步进 contextManager，否则重载会话后视频预览/文件标签丢失
            if (extra && Array.isArray(extra.videos) && extra.videos.length) cmExtra.videos = extra.videos;
            if (extra && Array.isArray(extra.fileRefs) && extra.fileRefs.length) cmExtra.fileRefs = extra.fileRefs;
            opts.getActiveCm().add(role, text, detail, cmExtra);
            opts.saveActiveSessionDebounced();
            opts.syncView();
            return text;
        }

        return { buildContextPrefix: buildContextPrefix, addMessage: addMessage };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createMessageHelpers = createMessageHelpers;
})(typeof global !== 'undefined' ? global : window);