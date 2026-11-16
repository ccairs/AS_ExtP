(function (global) {

    // 自动压缩触发阈值（**唯一一份**）：loop 内与发送前的闸都从这里取，不再各写一个字面量
    // （「取整后再判闸」与「三处硬编码」一并收口）。
    // 触发阈值 90 → 85（附业界对照）：同类的分歧点是**分母口径**——原始窗口还是
    // 可用预算。90% **原始窗口**且不留输出余量属晚触发档（Codex 正是此档：原始窗口 ×90%，
    // 叠加可用窗口仅 95% 后落在可用空间 94.7% 处，压缩请求自身逼近窗口，openai/codex#40095）；
    // 85% 折算到原始窗口与 Cline 同档（可用预算 0.9 × 窗口 0.9 ≈ 81%），给在途工具结果、
    // 回复与摘要请求留出 15% 余量。本仓分子已含 system prompt/tools 开销（比 Codex 保守），
    // 故不再沿用 90。
    var COMPACT_TRIGGER_PCT = 85;
    // 模型自报窗口的**采纳下限**：低于此值不视为可信窗口。
    // 为什么需要：提供方未上报窗口时可能给出**单次输出上限**一类的小数字（旧代码在
    // model-manager 里兜底填过 4096），照单采纳会把「窗口未知」误当「4K 模型」，触发闸
    // 掉到约 3.5K（4096 × 85%）—— 比不采纳严重得多。真实小窗口靠用户手填的兜底值自行调低。
    var MODEL_WINDOW_MIN_APPLY = 32000;
    // 兜底默认上限（256k）：**只在服务商未上报窗口、且用户
    // 从未设置过**时生效。已存盘的设置值一律原样保留（升级不重置，见 app 侧 normalize）。
    // 注意：这是「未上报时的兜底值」，不是「上限」——服务商报了就完全按窗口走，不再取 min。
    var DEFAULT_MAX_CONTEXT_TOKENS = 256000;
    // dataURL 图片的**下界** token 常数：图片以 image_url 分片进请求
    // （controller.js:863 / :833）或由视觉代理转成中文描述追加进 user 内容（controller.js:822），
    // 两者都不在上下文存储里，估值侧看不到 → 按张数记一个保守下界，宁可偏低也不当 0。
    // 取值依据：主流视觉接口对 1024×1024 级图片的计费区间约 0.7K~1.1K token（低/高档位），
    // 取 800 作为**下界**；面板侧无法精确计算（依赖分辨率/档位/供应商实现）。
    var VISION_MEDIA_TOKEN_FLOOR = 800;

    // 读模型自报上下文窗口（**唯一一份实现**，controller / bootstrap 都调它）：
    // 数据源 = providerRegistry 的模型条目 `contextWindow`（model-manager 发现模型时写入，
    // 见 model-manager/controller.js:198-217）。返回 0 = 未知/不可信 ⇒ 调用方用手填兜底值。
    function readModelContextWindow(providerId, modelId) {
        if (!modelId) return 0;
        try {
            var pr = global.AE_LLM && global.AE_LLM.providerRegistry;
            if (!pr || typeof pr.getModel !== 'function') return 0;
            var m = pr.getModel(providerId, modelId);
            if (!m) return 0;
            var w = Number(m.contextWindow || m.max_context_length || 0);
            if (!isFinite(w) || w <= 0) return 0;
            w = Math.floor(w);
            return w >= MODEL_WINDOW_MIN_APPLY ? w : 0;
        } catch (_) { return 0; }
    }

    // 附件路径解析（会话图片等）：**持久化的相对路径** → 当前数据目录绝对路径。
    // 只用于「发出去的请求」与「回给 LLM 的归档文本」；存储/归档一律保持相对路径，
    // 这样数据目录迁移（temp 随整份迁移，见 dataDir.js 的迁移排除清单）后历史消息仍有效。
    // dataURL 与已是绝对的路径（盘符 / file:/// / UNC）原样返回。
    // 数据目录不可用时原样返回并告警一次，不阻断请求（否则整轮对话会因路径问题发不出去）。
    var _warnedNoDataDir = false;
    function absAttachmentPath(p) {
        if (typeof p !== 'string' || !p) return p;
        if (p.indexOf('data:') === 0) return p;
        if (/^[a-zA-Z]:[\\/]/.test(p) || /^file:\/+/i.test(p) || /^(?:\\\\|\/\/)[^\\/]/.test(p)) return p;
        var base = '';
        try {
            if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                var dd = global.AEShared.getDataDir();
                base = (dd && typeof dd.dir === 'string') ? dd.dir.replace(/\\+$/, '') : '';
            }
        } catch (_) { base = ''; }
        if (!base) {
            if (!_warnedNoDataDir) {
                _warnedNoDataDir = true;
                console.warn('[Agent] 数据目录不可用：附件路径按原样发送，工具可能无法读取相对路径');
            }
            return p;
        }
        return base + '\\' + p.replace(/^[\\/]+/, '');
    }

    function createContextManager(options) {
        const opts = options || {};
        var sessionId = opts.sessionId || 'default';
        let maxContextTokens = Number(opts.maxContextTokens) || DEFAULT_MAX_CONTEXT_TOKENS;
        // 模型自报窗口 = **优先分母**（取代原 min 口径）：
        //   服务商上报了窗口 ⇒ 生效上限 = 窗口（用户手填值**不再参与**）；
        //   未上报（0）⇒ 生效上限 = 用户手填值（没设置过则是默认 256K）。
        // 为什么要反转：设置项的初衷是「拿不到模型窗口时的兜底」，不是用户二次限制；
        // 而 min(设置, 窗口) 会让「填 1M + 128K 模型」被窗口压住（看似一致），
        // 但也让「填小了」永久压住大窗口模型 —— 现在设置项只负责未上报场景。
        // 残留风险（已知取舍，勿自行加限）：若服务商**报错**（例如把单次输出上限
        // 当窗口报上来）而数值又 ≥ MODEL_WINDOW_MIN_APPLY，用户将没有自救手段——
        // 设置项不再能把生效上限压下来。需要自救只能在 model-manager 侧修正该条目的
        // contextWindow（或引入显式覆盖开关，见交付说明「建议（未实现）」）。
        let modelWindowLimit = 0;
        // 实际生效分母 = 模型窗口（可信）> 手填兜底值。裁剪 / 预算回填 / percentUsed /
        // retainBudget **全部**走它，口径只有一处（不许有的地方用设置值、有的地方用窗口值）。
        function effectiveMaxTokens() {
            return modelWindowLimit > 0 ? modelWindowLimit : maxContextTokens;
        }
        // 请求固定开销（system prompt + tools 定义的 token 估算）：由 controller 在每次
        // 构建请求时写入。真实请求大小 = 历史消息 + 该开销——percentUsed / 裁剪 /
        // 预算回填统一按此口径，否则自动压缩触发滞后、回填预算偏大（口径分裂修复）
        let overheadTokens = 0;
        // 硬上限裁剪事件：pruneByTokens 因 total > 生效上限而删除时记一条，供 loop
        // 如实上报（不记事件时用户只会在请求里看到「已裁剪 N 条」提示行）。
        let storageCapEvents = [];
        // 「待压缩」标记：total ≥ 触发阈值即置位；压缩成功或回落到阈值下自然清除。
        let needsCompactFlag = false;
        // thinking 模式声明（非持久化，controller 每次构建请求时写入，同 overheadTokens 口径）：
        // true 表示当前 provider 开了思考模式 → 带 tool_calls 但思考为空的轮次要补空
        // reasoning_content 字段（DeepSeek 协议要求字段存在，见 toLlmMessages 的「回传策略」段）。
        // 默认 false：非思考 provider 行为完全不变（不会多出该字段）。
        let reasoningReplay = false;
        // 会话是否出现过思考内容（粘性，压缩后不清）。
        // 判定是否需要补 reasoning_content 不能只扫描存储消息：压缩会把带思考的旧消息
        // 折进摘要，存储列表随之丢失证据；保留窗口内若只有空思考的工具调用轮，扫描会
        // 误判为非思考会话，带 tool_calls 的轮次因此缺 reasoning_content（thinking 协议
        // 要求字段存在，缺字段即 400）。置位来源：新增带思考的 assistant 消息、controller
        // 声明 thinking、恢复含思考的历史会话。
        let thinkingSeen = false;

        var messages = [];

        function normalizeMessage(msg) {
            return {
                role: msg.role || 'assistant',
                text: msg.text || '',
                // UI 渲染用原始文本（含 chip token），与 text（LLM 用转换文本）分离；持久化保证跨会话恢复后聊天框仍显示 chip 标签
                displayText: typeof msg.displayText === 'string' ? msg.displayText : null,
                detail: msg.detail || null,
                toolCalls: Array.isArray(msg.toolCalls) ? msg.toolCalls : null,
                toolCallId: msg.toolCallId || null,
                toolName: msg.toolName || null,
                // 工具入参（持久化）：工具卡片「查看详情」的入参栏展示；executeExtendScript 的
                // 「执行: <action>」标签也从这里回落取（action 不单独持久化）。
                // 不参与 LLM 报文（toLlmMessages 按 role/content/tool_call_id 显式构造）
                args: msg.args || null,
                reasoningContent: msg.reasoningContent || '',
                // 工具结果附加标记（可选，持久化）：success 恢复图标态，reviewRejected 区分「审查未通过」
                success: typeof msg.success === 'boolean' ? msg.success : null,
                reviewRejected: !!msg.reviewRejected,
                // 图片路径（持久化）：ComfyUI 生成结果等，恢复后缩略图仍可显示
                images: Array.isArray(msg.images) ? msg.images : null,
                // 视频路径（持久化）：用户引用视频后聊天框预览，恢复后仍可播放
                videos: Array.isArray(msg.videos) ? msg.videos : null,
                // 文件/文件夹引用（持久化）：用户引用文档/文件夹后的标签，恢复后聊天框仍显示
                fileRefs: Array.isArray(msg.fileRefs) ? msg.fileRefs : null,
                // 图层引用（持久化）：「当前选中」点击建的引用 chip，恢复后聊天框仍显示
                createdAt: msg.createdAt || Date.now(),
                // 隐藏标记（持久化）：消息进 contextManager 供 LLM 使用，但 UI 不渲染（如压缩上下文摘要前缀）
                _hidden: !!msg._hidden,
                // 压缩摘要标记（持久化）：标识该 assistant 消息是上下文压缩产物，
                // UI 据此渲染顶部细线 + "已压缩早期对话" 提示，与普通助手回复视觉区分
                _compactSummary: !!msg._compactSummary,
                // 压缩摘要上记录的会话思考属性（持久化）：摘要卡片是压缩后思考历史的唯一
                // 载体，恢复会话时据此还原 sticky 判定
                thinkingUsed: msg.thinkingUsed === true,
                // LLM 回复标记（持久化）：标识真正的 LLM 回复；程序生成的提示消息（"已停止"等）无此标记
                _llm: !!msg._llm,
                // system-result 专用字段（持久化）：标题 + 常显区/细节区，每区可含文本/图片/视频/文件
                title: msg.title || '',
                // LLM 上下文角色映射：'user' | 'assistant'（不开放 system）
                llmRole: msg.llmRole || 'user',
                visibleText: typeof msg.visibleText === 'string' ? msg.visibleText : '',
                visibleImages: Array.isArray(msg.visibleImages) ? msg.visibleImages : null,
                visibleVideos: Array.isArray(msg.visibleVideos) ? msg.visibleVideos : null,
                visibleFiles: Array.isArray(msg.visibleFiles) ? msg.visibleFiles : null,
                detailText: typeof msg.detailText === 'string' ? msg.detailText : '',
                detailImages: Array.isArray(msg.detailImages) ? msg.detailImages : null,
                detailVideos: Array.isArray(msg.detailVideos) ? msg.detailVideos : null,
                detailFiles: Array.isArray(msg.detailFiles) ? msg.detailFiles : null
            };
        }

        function estimateTextTokens(text) {
            if (!text) return 0;
            var tokens = 0;
            for (var i = 0; i < text.length; i++) {
                var c = text.charCodeAt(i);
                // CJK 字符约 1 char/token，英文约 4 char/token
                if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) ||
                    (c >= 0x3000 && c <= 0x303F) || (c >= 0xFF00 && c <= 0xFFEF)) {
                    tokens += 1;
                } else {
                    tokens += 0.25;
                }
            }
            return Math.ceil(tokens);
        }

        // ── 「实际发送面」的唯一真相源 ──────────────────────────
        // 估值与 toLlmMessages **共用**下面这组拼装函数：任何字段进不进请求、进多少，
        // 只在这里决定一次。失效面漏一处、估值虚高与
        // 偏低——根因都是「估值一份口径、发送一份口径」。所以不再抄一份相似代码，
        // 而是让两侧调同一函数；并在 context-caliber-fixes 套件加差分对拍
        //（估值总量 vs 实际发送体的等价估算），任一侧改坏即红。
        function _userSendContent(m) {
            // 与 toLlmMessages 的 user 分支逐字同源（detail 经 summarizeDetail 截断、
            // dataURL 只跳过文本路径——它由视觉通道以 image_url 出去，见 _visionFloorTokens）
            var userContent = m.text || '';
            if (m.detail) {
                var userDetail = summarizeDetail(m.detail);
                if (userDetail) userContent += '\n\n' + userDetail;
            }
            if (m.images && m.images.length > 0) {
                userContent += (userContent ? '\n\n' : '') + '[附件图片路径]';
                for (var ui = 0; ui < m.images.length; ui++) {
                    var _ip = m.images[ui];
                    if (typeof _ip === 'string' && _ip.indexOf('data:') === 0) continue;
                    // 发出去的请求用绝对路径（AEFS/ComfyUI 工具只认绝对路径）；存储仍是相对
                    userContent += '\n' + absAttachmentPath(_ip);
                }
            }
            if (m.videos && m.videos.length > 0) {
                userContent += (userContent ? '\n\n' : '') + '[附件视频路径]';
                for (var vj = 0; vj < m.videos.length; vj++) {
                    var _vv = m.videos[vj];
                    if (typeof _vv === 'string' && _vv.indexOf('data:') === 0) continue;
                    userContent += '\n' + _vv;
                }
            }
            return userContent;
        }

        function _assistantSendContent(m) {
            // 与 toLlmMessages 的 assistant 分支同源：有 detail 时 content = text + 分隔符 + 摘要
            if (!m.detail) return m.text || '';
            return (m.text || '') + '\n---\n' + summarizeDetail(m.detail) + '\n---';
        }

        // dataURL 媒体的**下界**（进 image_url 分片 / 视觉代理描述的图片，都不在存储里）。
        // 位置语义：只有**当前轮那条 user 消息**的图会被真正注入请求（controller 的
        // `_injectUserImagesIntoMessages` 往最后一条 user 消息追加 image_url / 代理描述），
        // 历史轮次的图片不会再进请求 —— 所以这里只对「最后一条 user」计下界（多计会变成
        // **虚高 ⇒ 提前压缩**，与修复方向相反）。
        // 为什么**不**把视频一起计：
        // ① 本函数只数 `data:` 开头的条目，而用户附件的视频在 cm 里存的是**路径**
        //    （`m.videos` = 文件路径，见 messageHelpers.addMessage 的 extra.videos），
        //    即便把它接进来也不会触发下界——不是「省了一条」，是根本没有 dataURL 可数；
        // ② 请求侧也证实：用户附加视频在当前轮**不**以 video_url 进请求（只有
        //    `_userSendContent` 落成的路径文本，已计入）。全仓唯一的 video_url 注入点是
        //    `visionProxy.buildVideoUrlPart`（visionProxy.js:186/190），其调用方只有
        //    `injectVideoViaReadVideo`（controller.js:1697，**read_video 工具结果**路径），
        //    注入目标是**请求局部 messages**（非存储消息）。
        // 已知缺口（低估方向、cm 层不可观测，均不在存储消息里）——「为什么不给视频加下界」
        // 不等于「视频成本已计全」，下列三项仍是缺口，改到相关代码时请一并知悉：
        //   ① `read_video` 的**内联回退**：视频 ≤ 上限时走 `blobToDataUrl` 出 data:video/… 的
        //      video_url 分片（visionProxy.js:185-186）——体积可达 MB 级，估值完全看不到；
        //   ② 同一路径的非内联分支：`ms://<fileId>` 引用（visionProxy.js:189-190），
        //      引用本身很短，但服务端会据此取回视频 → 真实成本同样不在估值里；
        //   ③ 视觉代理生成的中文描述（视频与图片两条：controller.js:1721 等处直接 push 进
        //      请求局部 messages；图片代理见 `_injectUserImagesIntoMessages`），体积取决于
        //      代理模型输出，cm 无从得知。
        // 结论：图片按当前轮「dataURL 张数 × 下界常数」保守计入；视频与代理描述只能记为
        // 已知下界缺口（本条与 controller 的 `_injectUserImagesIntoMessages` 同源）。
        function _visionFloorTokens(list) {
            if (!Array.isArray(list) || !list.length) return 0;
            var n = 0;
            for (var i = 0; i < list.length; i++) {
                if (typeof list[i] === 'string' && list[i].indexOf('data:') === 0) n++;
            }
            return n * VISION_MEDIA_TOKEN_FLOOR;
        }

        // 思考是否随本条回传：带 tool_calls 的轮次（协议要求）或当前窗口内最后一条 assistant
        function _reasoningSent(m, isLastAssistant) {
            return !!(m.reasoningContent
                && ((m.toolCalls && m.toolCalls.length > 0) || isLastAssistant));
        }
        function _hasToolCalls(m) { return !!(m.toolCalls && m.toolCalls.length > 0); }

        // 按**消息对象**记忆化 token 估值。
        // 为什么：`totalStoredTokens()` 每次都把**全部**历史逐字符重算（`estimateTextTokens` 是
        // 逐字符 `charCodeAt` 循环），而 `addMessage` **每条**都调 `pruneByTokens()` ⇒ 累计 O(N²)。
        // 主会话独立复核（真模块、关裁剪）：1KB/条 n=200/400/800/1600 → 累计 65/195/793/3237ms，
        // **n 翻倍 ⇒ ×3.0 / ×4.1 / ×4.1**；4KB/条单条成本在 100→800 条历史由 873µs 升到 6873µs。
        // 本步只做「同一对象不重算」——失效经**两条**路径：
        //   ① `updateMessage`（改 `messages[idx].text`）内部 `_tokCache.delete(...)`；
        //   ② `invalidateTokens(msg)` 显式入口——**必须存在**：`list()` 是浅拷贝、消息对象
        //      为**同一引用**（依赖关系见 controller/apiActions.js 的注释），任何消费方
        //      都可能原地改 `detail`/`visibleText` 等计入用量的字段
        //      （实例：apiActions.js `clearReflectDrafts` 每次关面板把 `detail` 置 null）。
        //   原注释断言「失效面只有一个（updateMessage）」已被该实例证伪：
        //   漏失效 ⇒ 用量虚高 ⇒ percentUsed 偏高 ⇒ **提前自动压缩**（用户上下文早丢）。
        //   其余写入点都是**增删消息对象**（push/splice/concat/`messages = []`），对象不复用 ⇒ 无需失效。
        // 缓存的是**与位置无关的分量**（base / reasoning / 空字段信封），
        // 「最后一条 assistant 才回传思考」这类**位置相关**的差异在命中缓存后按位叠加，
        // 所以缓存语义不变（仍是「同一对象只逐字符算一次」），而估值随位置正确。
        // ── 缓存跨装配正确的**契约**──────────────────
        // 前提 A：缓存里绝不烘入「按位置算好的最终值」。位置相关分量只有三个——
        //   `reasoningIfLast`、`visionFloor`、`emptyReasoningField`——必须由
        //   `estimateMessageTokens` 每次按**本次装配的 list** 现算后叠加（见该函数）。
        //   反例（禁止）：把 `isLastAssistant` 后的总 token 直接写进 `_tokCache`，
        //   那么同一对象在窗口/全量两种装配里就会取到旧位置的旧值（估值随位置静默失真）。
        // 前提 B：窗口装配必须是全量装配的**后缀**。窗口选择从尾部成组回填，位置标志
        //   （lastAssistantIdx / lastUserId）在窗口里与在全量里指向**同一条**消息；
        //   唯一的前插是「摘要卡兜底」（`toLlmMessages` 里把 `messages[0]` 补到最前），
        //   它只改头部、不动尾部，故不破坏后缀性。
        //   反例（禁止）：将来做「中间取段」式装配（取 messages[a..b] 而 b < 末尾）——
        //   那时窗口里的「最后一条 assistant」不是会话最后一条，`reasoningIfLast` 会算错
        //   且与发送面背离；真要做，必须同时按新语义重算位置分量并同步改差分对拍语料。
        //   本契约由测试 `context-caliber-fixes` 看守（同一对象换位置后估值必须随位重算）。
        var _tokCache = new WeakMap();
        // 原地写后的失效入口：传对象 = 只失效该条（保住 A-2 的增量收益）；不传 = 保守全清。
        function invalidateTokens(msg) {
            if (msg && typeof msg === 'object') {
                try { _tokCache.delete(msg); } catch (_) { /* 非对象/冻结等：忽略 */ }
                return true;
            }
            _tokCache = new WeakMap();
            return true;
        }
        // 逐字段镜像 toLlmMessages 的**每条**消息估值；ctx = {isLastAssistant, isLastUser, needReasoningField}
        function estimateMessageTokens(m, ctx) {
            var isLastAssistant = !!(ctx && ctx.isLastAssistant);
            var needField = !!(ctx && ctx.needReasoningField);
            var p = _msgTokenParts(m);
            if (p === null) return 0;
            var t = p.base;
            // 带 tool_calls 的思考恒回传（已计入 base）；无 tool_calls 的思考只有「最后一条
            // assistant」回传 —— 位置相关分量在这里叠加
            if (isLastAssistant) t += p.reasoningIfLast;
            // 当前轮那条 user 消息的 dataURL 图（视觉通道下界）
            if (ctx && ctx.isLastUser) t += p.visionFloor;
            if (needField) t += p.emptyReasoningField;
            return t;
        }
        function _msgTokenParts(m) {
            var cached = _tokCache.get(m);
            if (cached !== undefined) return cached;
            var p = _computeMsgTokenParts(m);
            try { _tokCache.set(m, p); } catch (_) { /* 非对象等异常：不缓存，照常返回 */ }
            return p;
        }
        function _computeMsgTokenParts(m) {
            if (!m) return null;
            var parts = { base: 0, reasoningIfLast: 0, emptyReasoningField: 0, visionFloor: 0 };
            if (m.role === 'user') {
                parts.base = estimateTextTokens(_userSendContent(m));
                parts.visionFloor = _visionFloorTokens(m.images);   // 仅最后一条 user 计入（见上）
                return parts;
            }
            if (m.role === 'system-result') {
                // 与发送侧同一函数：含 visibleText/detailText/visible*Images/visibleVideos
                // **以及 visibleFiles**（低偏差点）
                parts.base = estimateTextTokens(_systemResultContent(m));
                return parts;
            }
            // tool / system：字段清单与成本都取自 _plainSendEntry（唯一一份，不再手抄）
            var plain = _plainSendEntry(m);
            if (plain) {
                parts.base = _plainSendEntryTokens(plain);
                return parts;
            }
            if (m.role === 'assistant') {
                var hasToolCalls = _hasToolCalls(m);
                var content = _assistantSendContent(m);
                if (!content && !hasToolCalls) {
                    // toLlmMessages：无正文且无 tool_calls 的整条不发（有思考则补占位句）
                    if (!m.reasoningContent) return null;
                    content = '【本回合思考被中断，未生成回复】';
                }
                parts.base = estimateTextTokens(content);
                if (m.toolCalls) parts.base += estimateTextTokens(JSON.stringify(m.toolCalls));
                var rt = m.reasoningContent ? estimateTextTokens(m.reasoningContent) : 0;
                if (rt) {
                    // 判据与发送侧共用 _reasoningSent（谓词不再只活在注释里）：
                    // 带 tool_calls ⇒ 恒回传；否则只在该条是「最后一条 assistant」时回传
                    if (_reasoningSent(m, false)) parts.base += rt;
                    else parts.reasoningIfLast = rt;
                } else if (hasToolCalls) {
                    // 思考模式协议：带 tool_calls 但思考为空时字段必须存在（空串信封）
                    parts.emptyReasoningField = estimateTextTokens('"reasoning_content":""');
                }
                return parts;
            }
            // 其余（未知 role）：发送侧不产出 entry（_plainSendEntry 返回 null 且非上述角色）⇒ 不计
            return parts;
        }

        // 存量大口径的位置上下文（最后一条 assistant / 最后一条 user 下标 + 是否会补空思考字段）：
        // 一次扫描 O(N)，供 totalStoredTokens / findRetainIndex / 预算选择共用同一口径。
        function _tokenCtx() {
            var last = -1;
            var lastUser = -1;
            var any = reasoningReplay || thinkingSeen;
            for (var i = 0; i < messages.length; i++) {
                if (messages[i].role === 'assistant') {
                    last = i;
                    if (messages[i].reasoningContent) any = true;
                } else if (messages[i].role === 'user') {
                    lastUser = i;
                }
            }
            return { lastAssistantIdx: last, lastUserId: lastUser, needReasoningField: any };
        }
        function _estimateAt(idx, ctx) {
            return estimateMessageTokens(messages[idx], {
                isLastAssistant: idx === ctx.lastAssistantIdx,
                isLastUser: idx === ctx.lastUserId,
                needReasoningField: ctx.needReasoningField
            });
        }

        // ── tool / system 两支的 entry 字段清单：唯一一份 ──────────────────────
        // 发送侧（_assembleSend）直接把它 push 进报文；估值侧（_computeMsgTokenParts）
        // 只读它的字段算成本。**加字段只需要改这里一处**——「字段清单棘轮」
        // 会把「发送侧出现新字段但估值侧没跟上」打成红。
        function _plainSendEntry(m) {
            if (m.role === 'tool') {
                return { role: 'tool', content: m.text || '', tool_call_id: m.toolCallId || '', name: m.toolName || '' };
            }
            if (m.role === 'system') {
                return { role: 'system', content: m.text || '' };
            }
            return null;
        }
        // tool 信封常数（+10/+5）：tool_call_id/name 的实际字段文本之外，服务端报文还有
        // JSON 键名与分隔符的成本，历史实现一直按 +10/+5 记（差分对拍的容差就是它）。
        function _plainSendEntryTokens(e) {
            var t = estimateTextTokens(e.content || '');
            if (e.role === 'tool') {
                if (e.tool_call_id) t += estimateTextTokens(e.tool_call_id) + 10;
                if (e.name) t += estimateTextTokens(e.name) + 5;
            }
            return t;
        }

        // ── 发送体装配（唯一一份）：集合级「增 / 删」只发生在这里 ──────────────
        // 为什么必须共用：**字段级**拼装已收口（user/assistant/system-result 共用
        // 内容函数），但 toLlmMessages 还会做**集合级**变换——
        //   增：缺响应的 tool_call 会**合成占位 tool 响应**（不合成则服务端 400）；
        //   删：孤儿 tool 消息、重复 tool 响应、无正文无思考的空 assistant 在发送面被丢弃。
        // 估值如果只遍历存储消息，就会与实际发送面背离。差分对拍用「同一套差分
        // 规则」跑出的反例即为明证：
        //   X4 孤儿 tool（半成品 assistant 打断后响应后到）：估值 4312 / 发送面 302（虚高 4010）
        //   X5 孤儿 tool + 4 万字符结果：              估值 10139 / 发送面 117（虚高 10022）
        //   X2 缺 1 个响应：                            估值 118  / 发送面 131（偏低 13）
        // 偏差方向一致（虚高 ⇒ percentUsed 偏高 ⇒ 提前自动压缩）。
        // 现在：估值与发送共用本函数的产物——`totalStoredTokens()` 装配**全部存储消息**，
        // `toLlmMessages()` 装配**预算选中的窗口**，两者只差「选哪些消息」，不再各有一套口径。
        // 每条 entry 的估算成本挂在**不可枚举**属性 `__tok` 上：JSON.stringify 不会把它带给
        // 服务端，装配途中的丢弃/合成也自然反映到 tokens（没进 entries 的就没被计）。
        function _tagEntryTokens(entry, n) {
            try {
                Object.defineProperty(entry, '__tok', { value: n, enumerable: false, writable: true, configurable: true });
            } catch (_) { /* 冻结对象等：不挂标签，tokens 少算这一条（不会虚高） */ }
            return entry;
        }
        function _entryTokens(entry) {
            return (entry && typeof entry.__tok === 'number') ? entry.__tok : 0;
        }
        // 「已裁剪 N 条…」提示行的文本：唯一一份（窗口装配与实际报文用它，成本上界也用它）
        function _droppedNoticeText(droppedCount) {
            return '[已裁剪 ' + droppedCount + ' 条更早的对话消息。这些消息已归档保存，'
                + '如需回顾早期聊天历史（如之前的决策、代码、用户要求），可调用 read_early_history 工具读取。]';
        }
        // 提示行成本的**上界**（按 6 位数条数算；真实条数位数更少 ⇒ 文本更短 ⇒ 成本更低）。
        // 惰性求值一次（模块级常量），避免每次 add 都重新逐字符算。
        var _droppedNoticeMaxTokens = -1;
        function _droppedNoticeTokensMax() {
            if (_droppedNoticeMaxTokens < 0) {
                _droppedNoticeMaxTokens = estimateTextTokens(_droppedNoticeText(999999));
            }
            return _droppedNoticeMaxTokens;
        }
        // 逐条消息的估算之和（与窗口选择的**同一口径**：孤儿也按其单条成本计入，
        // 与 `_assembleSend` 的「丢弃后总量」不同——这是判断窗口是否会裁剪的依据）
        function _perMessageTokenSum() {
            var c = _tokenCtx();
            var sum = 0;
            for (var i = 0; i < messages.length; i++) sum += _estimateAt(i, c);
            return sum;
        }
        // 本会话是否会补空 reasoning_content 字段（思考模式声明或历史出现过思考）。
        // 扫全部存储消息，并以会话级粘性标记兜底：压缩会丢弃带思考的旧消息，存储列表
        // 不再保留证据时，只要本会话见过思考或 controller 声明 thinking，仍判定需要补
        // 字段（空串合法，缺字段即 400）。
        function _needReasoningField() {
            if (reasoningReplay || thinkingSeen) return true;
            for (var i = 0; i < messages.length; i++) {
                if (messages[i].role === 'assistant' && messages[i].reasoningContent) return true;
            }
            return false;
        }
        // 装配发送体：list = 要装配的消息（全部存储消息 / 预算选中的窗口）
        // opts.droppedCount > 0 时在报文最前插入「已裁剪 N 条」提示行（它也是要发的内容，计入成本）。
        // 该提示行**不是死分支**（曾按 4 组压力判为不可达）：当某条消息的
        // 单条估值超过剩余预算、而组装口径的总量仍在上限内时就会触发——典型形态是「发送面
        // 会被丢弃的真孤儿 tool（不再抬高总量）+ 其后另有一条 assistant 切断归拢扫描」，
        // 实测 存储 6 条 / 发送 2 条（测试 `context-caliber-fixes` 有正向钉）。
        // 返回 { entries: 真正发出去的报文, tokens: 该报文的 token 估算 }
        function _assembleSend(list, opts) {
            var needReasoningField = !!(opts && opts.needReasoningField);
            var droppedCount = Math.max(0, (opts && opts.droppedCount) || 0);
            var lastAssistantIdx = -1;
            for (var la = list.length - 1; la >= 0; la--) {
                if (list[la].role === 'assistant') { lastAssistantIdx = la; break; }
            }
            var lastUserId = -1;
            for (var lu = 0; lu < list.length; lu++) {
                if (list[lu].role === 'user') lastUserId = lu;
            }

            // ── 1) 逐条换算成 LLM 报文条目（字段级拼装与估值同源）──
            var raw = [];
            if (droppedCount > 0) {
                var noticeText = _droppedNoticeText(droppedCount);
                raw.push(_tagEntryTokens({ role: 'user', content: noticeText }, estimateTextTokens(noticeText)));
            }
            for (var j = 0; j < list.length; j++) {
                var m = list[j];
                var isLast = j === lastAssistantIdx;
                // 该条消息在发送面的成本（字段级镜像；惰性缓存，见 estimateMessageTokens）
                var cost = estimateMessageTokens(m, {
                    isLastAssistant: isLast,
                    isLastUser: j === lastUserId,
                    needReasoningField: needReasoningField
                });
                if (m.role === 'user') {
                    // 内容拼装与估值**同一函数**（_userSendContent）：detail 截断 / 附件路径
                    // dataURL 跳过，两处只有一份实现
                    raw.push(_tagEntryTokens({ role: 'user', content: _userSendContent(m) }, cost));
                } else if (m.role === 'system-result') {
                    raw.push(_tagEntryTokens({ role: m.llmRole === 'assistant' ? 'assistant' : 'user', content: _systemResultContent(m) }, cost));
                } else if (m.role === 'assistant') {
                    var hasToolCalls = _hasToolCalls(m);
                    // content 与估值**同一函数**（_assistantSendContent：含 detail 经 summarizeDetail 的截断）
                    var entry = { role: 'assistant', content: _assistantSendContent(m) };
                    if (m.toolCalls) entry.tool_calls = m.toolCalls;
                    // reasoning_content 回传（策略与依据见上方「回传策略」段）：
                    // ① 带 tool_calls：字段必须存在，思考为空则补空串；
                    // ② 不带 tool_calls：仅当前轮内最后一条 assistant（半成品回合）回传。
                    // 判据与估值侧共用 _reasoningSent（单点实现，两侧不得各写一份）。
                    if (m.reasoningContent) {
                        if (_reasoningSent(m, isLast)) entry.reasoning_content = m.reasoningContent;
                    } else if (hasToolCalls && needReasoningField) {
                        entry.reasoning_content = '';
                    }
                    // 空正文且无工具调用的 assistant 消息（如「仅思考/被打断」的半成品回合）：
                    // Agent 模块把空回复也推进历史以保持 UI 下标对齐，但部分模型（如 Kimi）
                    // 拒绝 content 为空的 assistant 消息（400 must not be empty）。填充简短占位
                    // 说明；完全无内容（无正文且无思考）的占位消息整条丢弃（cost 已为 0）。
                    if (!entry.content && !hasToolCalls) {
                        if (m.reasoningContent) {
                            entry.content = '【本回合思考被中断，未生成回复】';
                        } else {
                            continue;
                        }
                    }
                    raw.push(_tagEntryTokens(entry, cost));
                } else {
                    var plain = _plainSendEntry(m);
                    if (plain) raw.push(_tagEntryTokens(plain, cost));
                }
            }

            // ── 2) 工具组归拢 + 完整性兜底（请求层 fail-safe）──
            // 严格服务端（DeepSeek/OpenAI）要求：带 tool_calls 的 assistant 之后，每个
            // tool_call_id 都必须有对应 tool 响应，否则 400。而历史里「组被劈开」是**可达**的：
            // 工具执行中点「立刻发送」，打断消息（在点击瞬间落库）会插进该组成员之间，
            // 其后的 tool 响应会被下方 orphan 清理整组丢掉 → 请求里只剩光秃秃的 tool_calls。
            // 处置：把落在组后面的、属于该组的 tool 响应**归拢**到 assistant 之后（保住真实结果），
            // 缺失的 id 再补占位响应。
            // 组内顺序保持；非 tool 消息（打断的用户消息等）在归拢后按原序输出。
            // 两条收紧（否则归拢本身会制造非法报文）：
            //   · 组范围内**不属于本组**的 tool 消息一律丢弃——按定义它是孤儿（前一组在组头之前、
            //     后一组的 assistant 尚未出现），搬到组内会被 orphan 清理当成合法响应放行，
            //     服务端会因「tool 响应无对应 tool_call」报 400；
            //   · 同一 tool_call_id 只保留第一条响应（重复响应同属非法形态）。
            // 匹配按字符串化 id 比较：`toolCallId` 缺省被规范化为 ''，与 tool_calls 侧空 id 对齐，
            // 避免把合法的空 id 响应误判为孤儿。
            // ⚠ 丢弃的条目**必须**计入下方 gi 的推进量，否则外层循环会把
            // 它们当新条目再 push 回来（重复响应实际没被丢掉，注释与实现不符）。
            // `gi += 1 + strays.length + rest.length` 漏掉了「被丢弃的孤儿/重复」。
            var grouped = [];
            var gi = 0;
            while (gi < raw.length) {
                var gEntry = raw[gi];
                grouped.push(gEntry);
                if (gEntry.role !== 'assistant' || !gEntry.tool_calls || !gEntry.tool_calls.length) {
                    gi++;
                    continue;
                }
                // 该组的成员：直到下一条 assistant 之前的 tool 消息（可能在非 tool 消息之后）
                var wantIds = {};
                for (var wi = 0; wi < gEntry.tool_calls.length; wi++) {
                    wantIds[String(gEntry.tool_calls[wi].id || '')] = true;
                }
                var foundIds = {};
                var strays = [];
                var rest = [];
                var scanned = 0;
                for (var gj = gi + 1; gj < raw.length && raw[gj].role !== 'assistant'; gj++) {
                    scanned++;
                    if (raw[gj].role !== 'tool') { rest.push(raw[gj]); continue; }
                    var _gid = String(raw[gj].tool_call_id || '');
                    if (wantIds[_gid] && !foundIds[_gid]) {
                        foundIds[_gid] = true;
                        strays.push(raw[gj]);
                    }
                    // 其余 tool 消息：孤儿或重复响应 → 丢弃（见上方两条收紧）
                }
                for (var si = 0; si < strays.length; si++) grouped.push(strays[si]);
                for (var mi = 0; mi < gEntry.tool_calls.length; mi++) {
                    var mid = String(gEntry.tool_calls[mi].id || '');
                    if (!foundIds[mid]) {
                        var _phContent = '[已中断] 该工具未执行完成';
                        grouped.push(_tagEntryTokens(
                            { role: 'tool', tool_call_id: mid, name: '', content: _phContent },
                            estimateTextTokens(_phContent) + (mid ? estimateTextTokens(mid) + 10 : 0)
                        ));
                    }
                }
                for (var ri = 0; ri < rest.length; ri++) grouped.push(rest[ri]);
                gi = gi + 1 + scanned;   // 扫描过的（含被丢弃的孤儿/重复）一律不再回看
            }

            // ── 3) 孤儿 tool 消息清理：只留下「有 open tool_calls 的 assistant 之后」的 tool 响应 ──
            var entries = [];
            var tokens = 0;
            var hasOpenToolCall = false;
            for (var k = 0; k < grouped.length; k++) {
                var gk = grouped[k];
                if (gk.role === 'assistant') {
                    hasOpenToolCall = !!(gk.tool_calls && gk.tool_calls.length > 0);
                } else if (gk.role === 'tool') {
                    if (!hasOpenToolCall) continue;         // 孤儿响应：丢
                } else {
                    hasOpenToolCall = false;
                }
                entries.push(gk);
                tokens += _entryTokens(gk);
            }
            return { entries: entries, tokens: tokens };
        }

        function totalStoredTokens() {
            // 分子 = 发送面估算（含合成占位、不含被丢弃的孤儿/重复），不再是「存储量」
            var max = effectiveMaxTokens();
            var total = overheadTokens + _assembleSend(messages, {
                needReasoningField: _needReasoningField(),
                droppedCount: 0
            }).tokens;
            // 窗口装配一旦裁剪，发送面首条就是「已裁剪 N 条…」提示行，
            // 而它只存在于**窗口**装配里（上面的全量装配传 droppedCount:0）⇒ 裁剪发生时估值会
            // 漏掉提示行自身的成本（复核最小复现 cap=1000、存储 6→发送 3：估值 803 / 发送面 864，
            // 偏低 61；上界就是提示行成本 64 token ≈ 128K 窗口的 0.05%）。
            // 修法（保守计入，不引入窗口选择回路）：**可能**发生裁剪时就把提示行成本按上界加上。
            // 判定条件取「逐条之和 > 上限」——它比「组装总量 > 上限」更贴近窗口选择的口径
            //（窗口选择按逐条 `_estimateAt` 累加，孤儿也照算），是裁剪的**必要条件**而非充分条件：
            // 唯一多记的情形是「只有最后一个组、且该组自身超预算」（此时窗口不裁、也就没有提示行），
            // 代价是 ≤64 token 的保守高估；方向与该反例相反，符合「宁可略高不漏记」。
            if (total > max || overheadTokens + _perMessageTokenSum() > max) {
                total += _droppedNoticeTokensMax();
            }
            return total;
        }

        // 生效分母的下界判定（「待压缩」标记与事件上报）
        function _refreshCompactFlag(total) {
            needsCompactFlag = total >= effectiveMaxTokens() * (COMPACT_TRIGGER_PCT / 100);
            return needsCompactFlag;
        }

        // Check if message at index is part of a tool call group:
        // an assistant message with toolCalls, or a tool result following one.
        function isPartOfToolGroup(idx) {
            if (messages[idx].role === 'tool') return true;
            if (messages[idx].toolCalls && messages[idx].toolCalls.length > 0) return true;
            return false;
        }

        // Find the start index of the group that idx belongs to.
        // A group = consecutive assistant-with-toolCalls + tool messages.
        function groupStart(idx) {
            var i = idx;
            while (i > 0 && isPartOfToolGroup(i - 1)) {
                i--;
            }
            return i;
        }

        // Find the end index (exclusive) of the group starting at startIdx.
        function groupEnd(startIdx) {
            var i = startIdx;
            while (i < messages.length && isPartOfToolGroup(i)) {
                i++;
            }
            return i;
        }

        // 压缩摘要卡识别：新数据带 _compactSummary 标记；旧会话数据无此标记，
        // 以 role=system-result + title='上下文压缩'（compactWithSummary 的固定标题）兜底识别
        function isCompactSummaryCard(m) {
            if (!m) return false;
            if (m._compactSummary) return true;
            return m.role === 'system-result' && m.title === '上下文压缩';
        }

        // ── 压缩摘要卡的会话图片清单 ─────────────────────────
        // 旧消息被压缩后，图片路径只剩这张摘要卡能带进后续请求。清单由程序按被压缩消息
        // 的结构生成（不依赖摘要模型复述），**持久化为相对路径**，发送装配时经
        // absAttachmentPath 转当前数据目录绝对路径。
        // 扫描字段覆盖三类引用（与清理器 _collectChatImgRefs 同口径）：user.images /
        // system-result.visibleImages / detailImages；并随消息顺序递归保留先前摘要卡里的
        // 清单（二次压缩不丢更早的图，摘要卡本身也受清理器 visibleImages 引用保护）。
        var MANIFEST_MAX_REFS = 40;
        var MANIFEST_MAX_CHARS = 4000;
        function _isSessionImageRef(p) {
            return typeof p === 'string' && p.indexOf('data:') !== 0 && p.indexOf('chat_img_') >= 0;
        }
        // 清单持久化优先用相对路径。旧数据里的绝对路径若位于
        // 当前数据目录下，压缩时转成相对；不在当前目录下的原样保留（迁移后由 AEFS 报缺失，
        // 不做猜测替换）。绝对形态含盘符、file:/// 与 UNC（数据根可为已登记 UNC）。
        function _manifestStoredRef(p) {
            if (typeof p !== 'string') return p;
            var norm = p.replace(/\\/g, '/');
            if (/^file:\/+/i.test(norm)) {
                var stripped = norm.replace(/^file:\/+/i, '');
                if (!/^[a-zA-Z][:\|]\//.test(stripped)) return p;
                norm = stripped.replace('|', ':');
            }
            if (!/^[a-zA-Z]:\//.test(norm) && !/^\/\/[^\/]/.test(norm)) return p;
            var base = '';
            try {
                if (global.AEShared && typeof global.AEShared.getDataDir === 'function') {
                    var dd = global.AEShared.getDataDir();
                    base = (dd && typeof dd.dir === 'string') ? dd.dir.replace(/\\/g, '/').replace(/\/+$/, '') : '';
                }
            } catch (_) { base = ''; }
            if (!base) return p;
            var lowNorm = norm.toLowerCase();
            var lowBase = base.toLowerCase();
            if (lowNorm.indexOf(lowBase + '/') !== 0) return p;
            // 与既有持久化口径一致用反斜杠（temp\agent\...）
            return norm.slice(base.length + 1).replace(/\//g, '\\');
        }
        function _collectSessionImageRefs(list) {
            var seen = {};
            var out = [];
            function addAll(arr) {
                if (!Array.isArray(arr)) return;
                for (var i = 0; i < arr.length; i++) {
                    var p = arr[i];
                    if (!_isSessionImageRef(p)) continue;
                    var stored = _manifestStoredRef(p);
                    var key = stored.replace(/\\/g, '/').toLowerCase();
                    if (seen[key]) continue;
                    seen[key] = true;
                    out.push(stored);
                }
            }
            for (var j = 0; j < list.length; j++) {
                var m = list[j];
                if (!m) continue;
                addAll(m.images);
                addAll(m.visibleImages);
                addAll(m.detailImages);
            }
            return out;
        }
        // 超上限时保留最早与最近两段（表情包/临时图挤不掉开头的设定图），中间省略并计数
        function _capSessionImageRefs(refs) {
            if (refs.length <= MANIFEST_MAX_REFS && refs.join('\n').length <= MANIFEST_MAX_CHARS) {
                return { refs: refs.slice(), omitted: 0 };
            }
            var head = [];
            var tail = [];
            var used = 0;
            var maxHead = Math.ceil(MANIFEST_MAX_REFS / 2);
            var maxTail = MANIFEST_MAX_REFS - maxHead;
            var i = 0;
            for (; i < refs.length && head.length < maxHead; i++) {
                if (used + refs[i].length + 1 > MANIFEST_MAX_CHARS) break;
                head.push(refs[i]);
                used += refs[i].length + 1;
            }
            var j = refs.length - 1;
            for (; j >= i && tail.length < maxTail; j--) {
                if (used + refs[j].length + 1 > MANIFEST_MAX_CHARS) break;
                tail.unshift(refs[j]);
                used += refs[j].length + 1;
            }
            var kept = head.concat(tail);
            return { refs: kept, omitted: Math.max(0, refs.length - kept.length) };
        }

        // Token-based pruning: remove oldest messages (by groups) until within budget.
        // Always keeps at least the last message.
        // 压缩摘要卡（头部 _compactSummary 消息）不参与裁剪：它是被压缩早期记忆的唯一载体，
        // 溢出时若被最先删掉，LLM 将彻底失忆且无任何提示（read_early_history 大结果页极易触发）。
        // 溢出时从摘要卡之后开始删；至少保留 [摘要卡 + 最后一条消息]。
        // 被裁剪消息经 onPrune 回调归档（与 compressContext 的 saveArchive 链路对齐）：
        // 否则 toLlmMessages 的「已归档保存」提示指向不存在的归档，且超预算旧会话载入后
        // 首条消息触发的 prune 删史会被防抖保存直接覆盖，早期历史永久丢失。
        var onPruneCallback = null;
        function pruneByTokens() {
            var maxTokens = effectiveMaxTokens();
            var total = totalStoredTokens();
            _refreshCompactFlag(total);
            var pruned = [];
            while (total > maxTokens && messages.length > 1) {
                var headProtected = isCompactSummaryCard(messages[0]);
                // 头部摘要卡受保护时无可删区间（只剩摘要卡+最后一条），停止
                if (headProtected && messages.length <= 2) break;
                var start = headProtected ? 1 : 0;
                // Find the first removable group
                var removeEnd = start + 1;
                if (isPartOfToolGroup(start)) {
                    // Remove the entire tool group at the start
                    removeEnd = groupEnd(start);
                }
                // Remove messages [start, removeEnd)
                pruned = pruned.concat(messages.splice(start, removeEnd - start));
                total = totalStoredTokens();
            }
            // 硬上限裁剪**不再静默** —— 记一条事件，由 loop 在下一轮如实告知用户。
            // 为什么不把 prune 阈值也降到触发线：
            // 那会让**静默删除**提前到触发线就发生（在摘要压缩有机会运行之前），是用更激进的丢数据
            // 掩盖时序问题；采纳的是第二个方案（先置「待压缩」标记 + 如实上报），触发交错的根因由
            // 「loop 起点先判触发阈值再决定是否压缩」保证摘要优先。
            if (pruned.length) {
                storageCapEvents.push({
                    at: Date.now(),
                    count: pruned.length,
                    overTokens: Math.max(0, total - maxTokens),
                    maxTokens: maxTokens
                });
                if (storageCapEvents.length > 20) storageCapEvents.shift();
            }
            // 循环结束后一次性回调（而非每次 splice 回调）：saveArchive 是读-改-写，
            // 多次并发回调会互相覆盖丢失前一批归档
            if (pruned.length && typeof onPruneCallback === 'function') {
                try { onPruneCallback(pruned); } catch (_) {}
            }
        }

        // 会话持久化已由文件 sessionStore 承担（store.save 落盘 JSON），不再写入 localStorage。
        // 保留这两个方法仅作为兼容钩子（controller.js 仍调用 cm.restore()/cm.persist()），内部为 no-op。
        function persist() {
        }

        function restore() {
        }

        function summarizeDetail(detail) {
            if (!detail) return '';
            try {
                const raw = typeof detail === 'string' ? detail : JSON.stringify(detail);
                const text = String(raw).trim();
                if (!text) return '';
                return text.length > 4000 ? text.slice(0, 4000) + '\n// ... (截断)' : text;
            } catch (_) {
                return '';
            }
        }

        // 组装 system-result 消息的 LLM 文本内容（常显文本 + 细节文本 + 各类媒体路径）。
        // dataURL 跳过：媒体已通过视觉/视频通道注入，base64 文本进上下文只会爆 token。
        function _systemResultContent(m) {
            var parts = [];
            if (m.visibleText) parts.push(m.visibleText);
            if (m.detailText) parts.push(m.detailText);
            if (m.visibleImages && m.visibleImages.length) {
                var imgs = m.visibleImages.filter(function (p) { return typeof p === 'string' && p.indexOf('data:') !== 0; });
                if (imgs.length) {
                    // 同 _userSendContent：发出去的请求用绝对路径（压缩摘要卡的图片清单也走这里）
                    var _imgsAbs = [];
                    for (var imi = 0; imi < imgs.length; imi++) _imgsAbs.push(absAttachmentPath(imgs[imi]));
                    parts.push('[附件图片路径]\n' + _imgsAbs.join('\n'));
                }
            }
            if (m.visibleVideos && m.visibleVideos.length) {
                var vids = m.visibleVideos.filter(function (p) { return typeof p === 'string' && p.indexOf('data:') !== 0; });
                if (vids.length) parts.push('[附件视频路径]\n' + vids.join('\n'));
            }
            if (m.visibleFiles && m.visibleFiles.length) {
                parts.push('[附件文件路径]\n' + m.visibleFiles.map(function (f) { return (f && f.path) || ''; }).join('\n'));
            }
            return parts.join('\n\n');
        }

        function addMessage(role, text, detail, extra) {
            var msg = normalizeMessage({
                role: role,
                text: text || '',
                displayText: extra && typeof extra.displayText === 'string' ? extra.displayText : null,
                detail: detail || null,
                toolCalls: extra && extra.toolCalls ? extra.toolCalls : null,
                reasoningContent: extra && extra.reasoningContent ? extra.reasoningContent : '',
                images: extra && Array.isArray(extra.images) ? extra.images : null,
                videos: extra && Array.isArray(extra.videos) ? extra.videos : null,
                fileRefs: extra && Array.isArray(extra.fileRefs) ? extra.fileRefs : null,
                _hidden: extra && extra._hidden,
                _llm: !!(extra && extra._llm)
            });
            messages.push(msg);
            if (msg.reasoningContent && msg.role === 'assistant') thinkingSeen = true;
            pruneByTokens();
            persist();
        }

        // 更新指定下标消息的文本（消息编辑用）。token 统计由 getTokenStats 实时重算，随之更新。
        // 第三参 newDisplayText：编辑后 UI 显示文本（含 chip token 的原始输入），与 text（LLM 用转换文本）分离
        function updateMessage(index, newText, newDisplayText) {
            var idx = Number(index);
            if (!isFinite(idx) || idx < 0 || idx >= messages.length) return false;
            // **原地编辑点之一**：token 缓存必须在此失效（A-2 第一步）。
            // 另一类是消费方经 `list()` 原地写（见 `invalidateTokens` 的注释）。
            try { _tokCache.delete(messages[idx]); } catch (_) {}
            messages[idx].text = String(newText == null ? '' : newText);
            if (typeof newDisplayText === 'string') messages[idx].displayText = newDisplayText;
            persist();
            return true;
        }

        // 截断：删除从下标 index 起（含）的所有消息（编辑用）。
        function truncateFrom(index) {
            var idx = Number(index);
            if (!isFinite(idx)) return false;
            idx = Math.max(0, Math.min(messages.length, Math.floor(idx)));
            messages.splice(idx);
            persist();
            return true;
        }

        return {
            setMaxContextTokens(limit) {
                // 兜底值（未上报时生效）；钳制上限仍是 1M（允许手填到 1M，钳制区间不变）
                maxContextTokens = Math.max(2000, Math.min(1000000, Number(limit) || DEFAULT_MAX_CONTEXT_TOKENS));
                pruneByTokens();
                persist();
            },
            // 模型自报窗口 = 优先分母（0 = 未知 ⇒ 用设置项兜底值）。
            // 生效后裁剪/预算回填/percentUsed/retainBudget 全部跟随（口径只有一处）；
            // 手动压缩的保留基数取 min(窗口, 已用历史)，窗口仍作为该基数的上限随之变化。
            setModelWindowLimit(tokens) {
                var v = Math.floor(Number(tokens) || 0);
                if (!isFinite(v) || v < 0) v = 0;
                modelWindowLimit = v;
                pruneByTokens();
                persist();
                return modelWindowLimit;
            },
            getModelWindowLimit() { return modelWindowLimit; },
            // 用户手填的兜底值（**只在模型未上报窗口时生效**）——UI 要区分「生效值来自谁」时用
            getConfiguredMaxTokens() { return maxContextTokens; },
            // 实际生效的触发阈值（唯一一份，见 COMPACT_TRIGGER_PCT）
            getCompactTriggerPct() { return COMPACT_TRIGGER_PCT; },
            needsCompaction() { return needsCompactFlag; },
            // pruneByTokens 删除的消息批量回调（bootstrap 在对应 sessionStore 就绪后注入，
            // 回调内将 removed 写入 <sid>.archive.json，与 compressContext 归档同链路）
            setOnPrune(fn) {
                onPruneCallback = typeof fn === 'function' ? fn : null;
            },
            getMaxContextTokens() {
                return effectiveMaxTokens();
            },
            // 写入请求固定开销（system prompt + tools 的 token 估算）。
            // controller 每次构建请求时更新——工具集/规则/skill 变化会在下轮请求
            // 自动刷新该值。0 表示尚未构建过请求（保持旧行为：仅统计历史消息）
            setOverheadTokens(tokens) {
                overheadTokens = Math.max(0, Math.floor(Number(tokens) || 0));
                pruneByTokens();
            },
            // **只记值不裁剪**的预热入口 —— 会话恢复时用上次已知开销，让「发送前的自动压缩闸」
            // 与用量条不再按 overhead=0 的低值判断；真正的裁剪仍只发生在首次请求构建
            //（setOverheadTokens）与消息变更时，避免在归档回调接好之前就删消息。
            primeOverheadTokens(tokens) {
                overheadTokens = Math.max(0, Math.floor(Number(tokens) || 0));
                _refreshCompactFlag(totalStoredTokens());
                return overheadTokens;
            },
            getOverheadTokens() {
                return overheadTokens;
            },
            // 硬上限裁剪事件（如实上报用）。consumeXxx 读后清空（loop 每轮最多提示一次）。
            getStorageCapEvents() { return storageCapEvents.slice(); },
            consumeStorageCapEvents() {
                var ev = storageCapEvents;
                storageCapEvents = [];
                return ev;
            },
            // thinking 模式声明：controller 在构建请求前按 provider 配置调用
            //（见 toLlmMessages 的「reasoning_content 回传策略」）。缺省 false。
            setReasoningReplay(on) {
                reasoningReplay = !!on;
                if (reasoningReplay) thinkingSeen = true;
            },
            getReasoningReplay() {
                return reasoningReplay;
            },
            add(role, text, detail, extra) {
                addMessage(role, text, detail, extra);
            },
            addToolCallAssistant(text, toolCalls, reasoningContent) {
                addMessage('assistant', text, null, {
                    toolCalls: toolCalls || null,
                    reasoningContent: reasoningContent || ''
                });
            },
            // 在指定下标处插入一条消息（下标非法/越界则追加，返回实际插入位置）。
            // 用途单一：打断（停止 / 立刻发送）时补写「被中断那一轮的半成品 assistant」。
            // 它逻辑上属于被中断的那一轮，实际落库却晚于打断时写入的用户消息
            //（sendInjectItem 在点击瞬间就落库）——按追加会让 UI 与 LLM 上下文同时出现
            //「user(打断者) → assistant(被打断)」的错序。调用方传**当前轮开始时**记录的下标
            //（见 processToolLoop 的 _roundStart*Idx），把半成品插回它本来该在的位置。
            insertAt(at, role, text, detail, extra) {
                var msg = normalizeMessage({
                    role: role,
                    text: text || '',
                    detail: detail || null,
                    reasoningContent: (extra && extra.reasoningContent) || '',
                    _llm: !!(extra && extra._llm)
                });
                var idx = Number(at);
                if (!isFinite(idx)) idx = messages.length;
                idx = Math.max(0, Math.min(messages.length, Math.floor(idx)));
                messages.splice(idx, 0, msg);
                if (msg.reasoningContent && msg.role === 'assistant') thinkingSeen = true;
                pruneByTokens();
                persist();
                return idx;
            },
            addToolResult(toolCallId, toolName, text, detail, extra) {
                var msg = normalizeMessage({
                    role: 'tool',
                    text: text || '',
                    detail: detail || null,
                    toolCallId: toolCallId || '',
                    toolName: toolName || '',
                    args: extra && extra.args ? extra.args : null,
                    success: extra && typeof extra.success === 'boolean' ? extra.success : null,
                    reviewRejected: !!(extra && extra.reviewRejected),
                    images: extra && Array.isArray(extra.images) ? extra.images : null
                });
                messages.push(msg);
                pruneByTokens();
                persist();
                return msg;
            },
            // 在指定下标插入一条 tool 结果（下标非法/越界则追加，返回插入的消息对象）。
            // 用途单一：打断（立刻发送 / 停止）时当前轮剩余工具结果的**锚位落库**——
            // 打断用的用户消息在点击瞬间就落库到尾部（apiActions.sendInjectItem），
            // 按追加会让工具结果排到它之后（cm 与 state.messages 双错序：面板上
            // 「已停止」的工具卡显示在打断消息下方）。请求层 toLlmMessages 会把劈开的
            // 工具组归拢回 assistant 之后（报文合法，见 context-tool-group-integrity），
            // 但历史顺序应就地正确，而不是靠请求层每次修复。调用方传当前轮工具组的锚位
            //（见 processToolLoop 的 _grp* 变量）。
            insertToolResultAt(at, toolCallId, toolName, text, detail, extra) {
                var msg = normalizeMessage({
                    role: 'tool',
                    text: text || '',
                    detail: detail || null,
                    toolCallId: toolCallId || '',
                    toolName: toolName || '',
                    args: extra && extra.args ? extra.args : null,
                    success: extra && typeof extra.success === 'boolean' ? extra.success : null,
                    reviewRejected: !!(extra && extra.reviewRejected),
                    images: extra && Array.isArray(extra.images) ? extra.images : null
                });
                var idx = Number(at);
                if (!isFinite(idx)) idx = messages.length;
                idx = Math.max(0, Math.min(messages.length, Math.floor(idx)));
                messages.splice(idx, 0, msg);
                pruneByTokens();
                persist();
                return msg;
            },
            addSystemResult(opts) {
                var msg = normalizeMessage({
                    role: 'system-result',
                    title: opts.title || '',
                    llmRole: opts.llmRole || 'user',
                    // 压缩摘要卡标记（可选）：标记后受 pruneByTokens/预算选择保护
                    _compactSummary: !!(opts && opts._compactSummary),
                    visibleText: opts.visibleText,
                    visibleImages: opts.visibleImages,
                    visibleVideos: opts.visibleVideos,
                    visibleFiles: opts.visibleFiles,
                    detailText: opts.detailText,
                    detailImages: opts.detailImages,
                    detailVideos: opts.detailVideos,
                    detailFiles: opts.detailFiles
                });
                messages.push(msg);
                pruneByTokens();
                persist();
                return msg;
            },
            updateMessage: updateMessage,
            // 原地写（不经 updateMessage）后的失效入口：见函数头注释
            invalidateTokens: invalidateTokens,
            truncateFrom: truncateFrom,
            clear() {
                messages = [];
                // 粘性标记是会话属性：清空对话即复位，恢复消息后由 importMessages 重新推断
                thinkingSeen = false;
                persist();
            },
            list() {
                return messages.slice();
            },
            toLlmMessages() {
                // Fill from newest messages backward until token budget is exhausted.
                // Keep tool call groups intact.
                // 预算扣除请求固定开销（system prompt + tools）：与 totalStoredTokens/
                // percentUsed 同口径，防止历史消息回填满额后加上固定开销超出模型窗口。
                // 分母用**生效上限**（min(设置, 模型窗口)），否则模型窗口 128K 而设置 1M 时
                // 这里也不裁，请求直接撞服务端窗口。
                var budget = Math.max(0, effectiveMaxTokens() - overheadTokens);
                var selCtx = _tokenCtx();          // 与估值侧同一位置口径（最后一条 assistant / 空思考信封）
                var selected = [];
                var usedTokens = 0;

                // Iterate from the end, adding groups
                var i = messages.length;
                while (i > 0) {
                    // Determine the group: if current message is part of a tool group, find the group boundaries
                    var groupEndIdx = i;
                    var groupStartIdx = i - 1;

                    if (isPartOfToolGroup(groupStartIdx)) {
                        // Find the start of this tool group
                        groupStartIdx = groupStart(groupEndIdx - 1);
                    }

                    // Calculate tokens for this group（估值与发送面同源，见 estimateMessageTokens）
                    var groupTokens = 0;
                    for (var g = groupStartIdx; g < groupEndIdx; g++) {
                        groupTokens += _estimateAt(g, selCtx);
                    }

                    // If adding this group would exceed budget and we already have messages, stop
                    if (usedTokens + groupTokens > budget && selected.length > 0) {
                        break;
                    }

                    // Prepend this group to selected
                    var group = [];
                    for (var g2 = groupStartIdx; g2 < groupEndIdx; g2++) {
                        group.push(messages[g2]);
                    }
                    selected = group.concat(selected);
                    usedTokens += groupTokens;
                    i = groupStartIdx;
                }

                // 压缩摘要卡兜底：预算从尾部回填时若头部摘要卡被挤出选择集，仍强制带上
                // （摘要是被压缩记忆的唯一载体，宁可略超预算也不能让 LLM 失忆）
                if (messages.length > 0 && isCompactSummaryCard(messages[0]) && selected[0] !== messages[0]) {
                    selected.unshift(messages[0]);
                }

                // ── 窗口外的消息：token-budget 裁剪最旧消息时，在保留内容最前插入一条提示，
                // 让 LLM 知道有更早对话被裁剪，避免其误以为对话从未提过那些内容；
                // 被裁剪消息已归档为副本，可经 read_early_history 按需回看早期历史。
                // （提示行也是要发的内容 ⇒ 计入成本，见 _assembleSend）
                // ── reasoning_content 回传策略（DeepSeek thinking 模式 + tools 的协议要求）──
                // 官方 thinking-mode 文档：凡有工具调用的轮次，其 reasoning_content 必须在
                // **后续所有请求**中完整回传，且「即使该轮模型没有发起工具调用」也要回传；
                // 不回传则 400（"The reasoning_content in the thinking mode must be passed back
                // to the API."）——回传条件收窄为「带 tool_calls 且思考非空」会漏：
                // 两个缺口都会命中该 400：
                //   ① 带 tool_calls 但思考为空（模型整轮没吐思考，或服务端返回空串）→ 字段被整个
                //      省略。协议要求是**字段必须存在**，空串是合法值；
                //   ② 不带 tool_calls 但处在当前轮内（被停止/出错的半成品回合）→ 思考被丢弃，
                //      而它正是当前轮里那一环。
                // 空串注入需先判定「本会话是思考模型」：按**全部历史**是否出现过思考内容推断
                //（非思考模型永远不会产出 reasoningContent，故不会误注入），或由 controller 经
                // setReasoningReplay 显式声明（providers 配置里 thinking 已启用）。扫全部历史
                // 而非仅当前窗口：思考模型是会话属性，窗口裁剪不该改变它——与估值侧
                // `_needReasoningField()` 同一判据（共用 _assembleSend）。
                //
                // 装配（字段级拼装 + 集合级增删）统一走 _assembleSend：本次只传「选中的窗口」，
                // 估值侧传「全部存储消息」，两边共用同一份实现（见 _assembleSend 注释）。
                return _assembleSend(selected, {
                    needReasoningField: _needReasoningField(),
                    droppedCount: messages.length - selected.length
                }).entries;
            },
            estimateTokens: function(text) {
                return estimateTextTokens(text);
            },
            getTokenStats: function() {
                var used = totalStoredTokens();
                var maxTokens = effectiveMaxTokens();
                // 判闸必须用**未取整**的值（89.5% 取整成 90 就会直接触发压缩）。
                // percentUsed 保留取整（UI 显示/测试口径不变），percentUsedRaw 供三处闸门使用。
                var rawPct = maxTokens > 0 ? (used / maxTokens) * 100 : 0;
                return {
                    totalTokens: used,
                    maxTokens: maxTokens,
                    // 手填兜底值（**只在模型未上报窗口时生效**）——UI 据此说明「生效值来自谁」
                    configuredMaxTokens: maxContextTokens,
                    modelWindowLimit: modelWindowLimit,
                    // 生效值来源：'model' = 服务商自报窗口；'fallback' = 手填兜底值（未上报）。
                    // UI 必须把来源显示出来（否则「用户填了却没起作用」就是一处失真面）。
                    maxTokensSource: modelWindowLimit > 0 ? 'model' : 'fallback',
                    // 请求固定开销（system prompt + tools），已含在 totalTokens 内
                    overheadTokens: overheadTokens,
                    messageCount: messages.length,
                    lastUpdated: Date.now(),
                    percentUsed: Math.round(rawPct),
                    percentUsedRaw: rawPct,
                    compactTriggerPct: COMPACT_TRIGGER_PCT,
                    needsCompaction: needsCompactFlag || rawPct >= COMPACT_TRIGGER_PCT
                };
            },
            // 导出 system-result 的 LLM 文本拼装逻辑，供 controller 在忙时 drain 时
            // 复用同一份完整格式（常显文本 + 细节文本 + 各类媒体路径），避免与 toLlmMessages 分叉
            systemResultContent: function (m) {
                return _systemResultContent(m);
            },
            getSessionId: function () {
                return sessionId;
            },
            setSessionId: function (newId) {
                persist();
                sessionId = newId;
                messages = [];
                // 粘性标记是会话属性：换会话先复位，恢复消息后由 importMessages 重新推断
                thinkingSeen = false;
            },
            exportMessages: function () {
                return JSON.parse(JSON.stringify(messages));
            },
            importMessages: function (msgs) {
                messages = Array.isArray(msgs) ? JSON.parse(JSON.stringify(msgs)) : [];
                for (var _ti = 0; _ti < messages.length; _ti++) {
                    var _tm = messages[_ti];
                    if (!_tm) continue;
                    if (_tm.thinkingUsed === true) { thinkingSeen = true; break; }
                    if (_tm.role === 'assistant' && _tm.reasoningContent) {
                        thinkingSeen = true;
                        break;
                    }
                }
            },
            // 两阶段压缩 - 阶段1：计算保留边界（从末尾向前按工具组回填，直到耗尽 budgetTokens）
            // 返回 retainFromIdx，[retainFromIdx, messages.length) 范围的消息将原样保留
            findRetainIndex(budgetTokens) {
                var budget = Math.max(0, Number(budgetTokens) || 0);
                var retCtx = _tokenCtx();       // 与估值/发送面同一位置口径
                var usedTokens = 0;
                var i = messages.length;
                while (i > 0) {
                    var groupEndIdx = i;
                    var groupStartIdx = i - 1;
                    if (isPartOfToolGroup(groupStartIdx)) {
                        groupStartIdx = groupStart(groupEndIdx - 1);
                    }
                    var groupTokens = 0;
                    for (var g = groupStartIdx; g < groupEndIdx; g++) {
                        groupTokens += _estimateAt(g, retCtx);
                    }
                    // 已有积累且加入此组会超预算 → 停止
                    if (usedTokens + groupTokens > budget && i < messages.length) {
                        break;
                    }
                    usedTokens += groupTokens;
                    i = groupStartIdx;
                }
                return i;
            },
            // 两阶段压缩 - 阶段2：折叠 [0, retainFromIdx) 范围内的工具组为文本摘要消息
            // 工具组（assistant+tool_calls + 后续 tool 结果）折叠为一条 user 文本：
            //   [工具调用] toolName({"arg":"..."}) → [toolName] 结果摘要
            // 非工具组消息原样保留。不修改 messages 数组，返回折叠后的旧消息数组
            // 用于构建 LLM 摘要请求（降 token，保留工具调用关键信息而非全丢）
            foldOldToolGroups(retainFromIdx) {
                var end = Math.max(0, Math.min(Number(retainFromIdx) || 0, messages.length));
                var result = [];
                var i = 0;
                while (i < end) {
                    if (isPartOfToolGroup(i)) {
                        var gEnd = groupEnd(i);
                        var lines = [];
                        for (var g = i; g < gEnd; g++) {
                            var m = messages[g];
                            if (m.role === 'assistant' && m.toolCalls) {
                                for (var j = 0; j < m.toolCalls.length; j++) {
                                    var tc = m.toolCalls[j];
                                    // 兼容 OpenAI 嵌套结构 { function: { name, arguments } } 与
                                    // 扁平 { name, arguments }（与 foldArchiveMessage 取值方式对齐）：
                                    // cm 内 toolCalls 由 finalizeOpenAiToolCalls 产出嵌套结构，
                                    // 顶层取 tc.name/tc.arguments 恒为 undefined → 全部折叠成 unknown()
                                    var tcName = tc.name || (tc.function && tc.function.name) || 'unknown';
                                    var tcArgs = tc.arguments !== undefined ? tc.arguments : (tc.function && tc.function.arguments);
                                    var argsStr = tcArgs !== undefined ? JSON.stringify(tcArgs) : '';
                                    if (argsStr.length > 200) argsStr = argsStr.slice(0, 200) + '...';
                                    lines.push('[工具调用] ' + tcName + '(' + argsStr + ')');
                                }
                            } else if (m.role === 'tool') {
                                var resultStr = m.text || '';
                                if (resultStr.length > 300) resultStr = resultStr.slice(0, 300) + '...';
                                lines.push('  → [' + (m.toolName || 'tool') + '] ' + resultStr);
                            }
                        }
                        if (lines.length > 0) {
                            result.push({ role: 'user', text: lines.join('\n') });
                        }
                        i = gEnd;
                    } else {
                        // system-result 消息（如 ComfyUI 结果卡、上次压缩的摘要卡）不能原样透传：
                        // 其 role 非法会被 API 400 秒拒（摘要失败 → 压缩静默失败），且 text 为空
                        // （内容在 visibleText/detailText）。转成合法角色文本再进摘要请求，
                        // 角色遵循创建时指定的 llmRole（与 toLlmMessages 的正常对话路径一致）。
                        if (messages[i].role === 'system-result') {
                            var _srContent = _systemResultContent(messages[i]);
                            if (_srContent) result.push({
                                role: messages[i].llmRole === 'assistant' ? 'assistant' : 'user',
                                text: _srContent
                            });
                        } else {
                            result.push(messages[i]);
                        }
                        i++;
                    }
                }
                return result;
            },
            // 压缩摘要请求的消息面：与发送面同一内容函数，
            // 带上附件图片路径。只取 m.text 时摘要模型完全看不到会话图片信息。
            buildSummaryMessages(retainFromIdx) {
                var folded = this.foldOldToolGroups(retainFromIdx);
                var out = [];
                for (var i = 0; i < folded.length; i++) {
                    var m = folded[i];
                    if (!m) continue;
                    var content = '';
                    if (m.role === 'user') content = _userSendContent(m);
                    else if (m.role === 'assistant') content = _assistantSendContent(m);
                    else content = m.text || '';
                    if (!content) continue;
                    out.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: content });
                }
                return out;
            },
            // 两阶段压缩 - 阶段3：用摘要 + 保留的最近消息重组 messages 数组
            // 清空 [0, retainFromIdx) 范围，前置注入 [隐藏 user 引导 + assistant 摘要]
            // [retainFromIdx, end) 范围的消息原样保留（含工具组配对、_llm 等所有字段）
            compactWithSummary(summaryText, retainFromIdx) {
                var retainStart = Math.max(0, Math.min(Number(retainFromIdx) || 0, messages.length));
                // 清单须在重写 messages 之前从「被压缩的旧消息」收集（含先前摘要卡里的旧清单）
                var _manifest = _capSessionImageRefs(_collectSessionImageRefs(messages.slice(0, retainStart)));
                var retained = messages.slice(retainStart);
                messages = [];
                if (summaryText) {
                    // 压缩摘要以 system-result 卡片呈现（标题 + 常显区摘要），上下文以 assistant 角色承载
                    // _compactSummary：pruneByTokens/toLlmMessages 据此识别并保护该卡（token 溢出时不裁剪）
                    // visibleImages 承载会话图片清单：持久化为相对路径（迁移安全），发送时由
                    // _systemResultContent 经 absAttachmentPath 转绝对；清理器的引用集也扫该字段，
                    // 因此清单里的图不会被 7 天/预算清理误删。UI 侧摘要卡不展开缩略图（见 view.js）。
                    var _detailText = '已压缩早期对话，保留最近的消息。';
                    if (_manifest.refs.length) {
                        _detailText += '附件为压缩前的会话图片清单（绝对路径，可直接用于 file_path）。';
                        if (_manifest.omitted > 0) {
                            _detailText += '另有 ' + _manifest.omitted + ' 张未列出，可用 read_early_history 回看。';
                        }
                    }
                    messages.push(normalizeMessage({
                        role: 'system-result',
                        llmRole: 'assistant',
                        title: '上下文压缩',
                        visibleText: summaryText,
                        detailText: _detailText,
                        visibleImages: _manifest.refs.length ? _manifest.refs : null,
                        _compactSummary: true,
                        // 压缩前的会话思考属性随摘要卡持久化：重载恢复后仍能补空 reasoning_content
                        thinkingUsed: thinkingSeen
                    }));
                }
                for (var i = 0; i < retained.length; i++) {
                    messages.push(retained[i]);
                }
                pruneByTokens();
                persist();
            },
            restore: restore,
            persist: persist
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createContextManager = createContextManager;
    // 附件路径解析（相对 → 当前数据目录绝对）：context 装配、归档折叠（contextCompression.js）
    // 共用同一实现，避免两处各写一份拼接。
    global.AEEngine.absAttachmentPath = absAttachmentPath;
    // 对外暴露的单一真相源：
    //   readModelContextWindow — 模型窗口读取（controller/bootstrap 都调它，不各写一份）
    //   COMPACT_TRIGGER_PCT    — 自动压缩触发闸的唯一常量（三处判闸不再硬编码）
    //   MODEL_WINDOW_MIN_APPLY — 窗口采纳下限（防「输出上限/假 4096」被误采纳）
    //   VISION_MEDIA_TOKEN_FLOOR — dataURL 图的下界常数
    //   DEFAULT_MAX_CONTEXT_TOKENS — 未上报窗口且用户未设置时的兜底默认（256K）
    global.AEEngine.readModelContextWindow = readModelContextWindow;
    global.AEEngine.CONTEXT_COMPACT_TRIGGER_PCT = COMPACT_TRIGGER_PCT;
    global.AEEngine.CONTEXT_MODEL_WINDOW_MIN_APPLY = MODEL_WINDOW_MIN_APPLY;
    global.AEEngine.CONTEXT_VISION_MEDIA_TOKEN_FLOOR = VISION_MEDIA_TOKEN_FLOOR;
    global.AEEngine.CONTEXT_DEFAULT_MAX_TOKENS = DEFAULT_MAX_CONTEXT_TOKENS;
})(window);
