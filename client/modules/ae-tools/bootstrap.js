(function(global) {

    var AE_CATEGORIES = ["project","composition","layer","animation","effect","render","utility","custom"];

    // 数据文件顶层 `migrations` 对象的键（值 = 迁移版本号）。落点与命名沿用数据文件
    // 既有风格（顶层 version/updatedAt/tools；同类标记见 petSettings.chatModelMigrationDone 等）。
    // 消费者/写入点都在本文件：loadToolsFile 读回、saveToolsToJson 续存、
    // mergeSeedTools + initAETools 落标记（详见 mergeSeedTools 的补齐段注释）。
    var MIGRATION_EXTERNAL_MCP_SCOPE = 'seedScopeExternalMcpMember';
    // 写工具 script 成员一次性移除：seed 里 5 件 AE 写工具的 scope 曾被历史
    // 迁移带上 script（补显式 scope 沿用 agent/script/external-mcp 三元组），
    // Script 模式因此可见操控 AE 的写工具。设计口径：写工具只给 Agent + 外接，只读 AE 工具
    // 才给 script。seed 改窄只对新装生效（数据目录 scope 属用户资产），已装环境靠本迁移
    // 移除 script 成员；标记落定后不再执行。
    var MIGRATION_SCRIPT_WRITE_SCOPE = 'seedScopeScriptWriteToolMember';
    var EXTERNAL_MCP_MODULE = 'external-mcp';

    function getJsonPath() {
        // 不做永久缓存：数据目录支持运行时切换（syncDataDirSetting 不重启面板），
        // 缓存会让切换后的读写仍指向旧路径，造成变更静默丢失。getDataDir 自带缓存，开销可忽略。
        var d = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
            ? global.AEShared.getDataDir().dir : '';
        if (!d) {
            console.error('[AE Bootstrap] getDataDir 为空，无法加载 ae_tools.json');
            return '';
        }
        var p = d + '\\ae-tools\\ae_tools.json';
        console.log('[AE Bootstrap] jsonPath (dataDir): ' + p);
        return p;
    }

    function getJsxPath() {
        var extRoot = (typeof window !== 'undefined' && window.__ext_root) || '';
        if (extRoot) {
            return extRoot.replace(/\\/g, '/') + '/client/modules/ae-tools/aeTools.jsx';
        }
        return null;
    }

    // ── 代码注入 ──

    function injectCodeToAE(code) {
        return new Promise(function(resolve) {
            if (typeof CSInterface === 'undefined') {
                resolve({ ok: false, error: 'CSInterface unavailable' });
                return;
            }
            if (!code || typeof code !== 'string' || code.length < 50) {
                resolve({ ok: false, error: 'Code too short' });
                return;
            }
            // 超时保护：AE 主线程被模态框/长任务占用时 evalScript 回调可能永不返回，
            // 无超时会让 init 卡死在启动流程（与 createHandler 同款防护）
            var finished = false;
            var timer = setTimeout(function() {
                if (finished) return;
                finished = true;
                console.warn('[AE Bootstrap] Code injection timeout');
                resolve({ ok: false, error: 'INJECT_TIMEOUT' });
            }, 60000);
            try {
                var cs = new CSInterface();
                cs.evalScript(code, function(result) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    var status = String(result || '');
                    if (status === 'MCP_LOADED') {
                        console.log('[AE Bootstrap] ' + 'Code injected successfully (' + code.length + ' chars)');
                        resolve({ ok: true });
                    } else {
                        console.warn('[AE Bootstrap] ' + 'Code injection returned: ' + status);
                        resolve({ ok: false, error: status || 'INJECT_UNKNOWN' });
                    }
                });
            } catch (e) {
                if (!finished) {
                    finished = true;
                    clearTimeout(timer);
                }
                console.warn('[AE Bootstrap] ' + 'injectCodeToAE error: ' + e);
                resolve({ ok: false, error: String(e) });
            }
        });
    }

    async function injectToolsCode() {
        // 直接通过 AEFS 读取 jsx 源文件注入（不再依赖构建产物）。
        // 改完 aeTools.jsx 重启面板即生效，无需构建步骤。
        var path = getJsxPath();
        if (!path) {
            console.warn('[AE Bootstrap] ' + 'Cannot determine jsx path');
            return { ok: false, error: 'JSX_PATH_UNKNOWN' };
        }
        try {
            var raw = await AEFS.readFile(path);
            if (!raw || raw.length < 200) {
                console.warn('[AE Bootstrap] AEFS read failed: ' + path);
                return { ok: false, error: 'JSX_READ_FAILED' };
            }
            return injectCodeToAE(raw);
        } catch (e) {
            console.warn('[AE Bootstrap] read aeTools.jsx exception: ' + e);
            return { ok: false, error: 'JSX_READ_EXCEPTION' };
        }
    }

    // ── Handler ──

    // queryEnvironment 的 availableEffects 缓存通道已提取到 effectsCache.js 共享
    // （wrapQueryEnvironmentHandler）：bootstrap 注册与 controller 重新注册路径
    // （saveTool/toggleToolEnabled）统一使用，防止重新注册丢失缓存通道。

    // 工具回执错误判据：createAETool 的 extendScript 文档（aeToolCreator.js）
    // 明确约定「将返回值赋给 result（如 result = {success: true}）」「错误处理：用 return
    // 返回错误信息」——文档约定写 result = {success:false, error:'...'} 或
    // return 'ERROR: ...' 时，旧判据 parsed.status === 'error' 命中不了，回执
    // success:true / isError:false 经 toolExecutor/extBridgeClient 一路放大成假成功。
    // 这里按**文档契约 + aeTools.jsx/kernel 实际错误形态**做保守扩展：status/success
    // 显式字段优先；error 字段只在没有显式成功标志时才算错；普通字符串正文
    //（非 ERROR 开头）不判错。
    function _isToolErrorPayload(value) {
        if (value === null || value === undefined) return false;
        // 文档「错误处理：用 return 返回错误信息」：return 'ERROR: ...' 落在字符串正文上
        if (typeof value === 'string') return /^\s*ERROR\b/i.test(value);
        if (typeof value !== 'object') return false;
        if (value.status === 'error') return true;      // 内核协议（aeTools.jsx 全库实际形态）
        if (value.success === false) return true;       // 文档约定成功形态 {success:true} 的镜像
        // 未给显式成功标志但带 truthy error 字段（常见形态 {'error':'...'}）；
        // 显式 success:true / status:'success' 时 error 只是正文/明细字段，不判错
        if (value.error && value.success !== true && value.status !== 'success') return true;
        return false;
    }

    // 错误正文提取：字符串错误原样透出；对象取 message/error；其余兜底 Unknown error
    function _toolErrorText(parsed) {
        var t;
        if (typeof parsed === 'string') t = parsed;
        else if (parsed && typeof parsed === 'object') t = parsed.message || parsed.error || 'Unknown error';
        else t = 'Unknown error';
        if (typeof t !== 'string') {
            try { t = JSON.stringify(t); } catch (_) { t = String(t); }
        }
        // AE 本地化错误串可能是 GBK→Latin-1 乱码，出口前修一次（见 _repairAeLocalizedText）
        return _repairAeLocalizedText(t);
    }

    // 错误回执正文出口：错误对象里除 message 外的结构化诊断字段必须原样到 LLM。
    // 背景：executeExtendScript 核 catch 在 {status,message} 上扩展了 partial（脚本抛错前可能
    // 已部分执行）与 recovery（回滚提示，如「可用 undoLastOperation 回滚本次调用产生的修改」）；
    // 同名合成歧义回执带 matchedCompositionIds / compName。这些字段若被压成散文，经
    // toolExecutionPipeline.toResult 包装后 LLM 只能看到 message，无法判断是否已部分生效、
    // 能否回滚、该改用哪个参数——正是会话里反复重试且误判项目状态的部分成因。
    // 口径：含 message 之外的字段 → 整份 JSON 原样透出（pipeline 会 parse 回对象呈现）；
    // 只含 {status,message}（或 success/error）的普通错误保持散文，既有 UI/测试兼容。
    var _PLAIN_ERROR_KEYS = { status: 1, message: 1, success: 1, error: 1 };
    function _hasStructuredErrorFields(value) {
        if (!value || typeof value !== 'object') return false;
        if (Object.prototype.toString.call(value) === '[object Array]') return false;
        for (var sk in value) {
            if (!Object.prototype.hasOwnProperty.call(value, sk)) continue;
            if (!Object.prototype.hasOwnProperty.call(_PLAIN_ERROR_KEYS, sk)) return true;
        }
        return false;
    }
    function _toolErrorContentText(parsed) {
        if (_hasStructuredErrorFields(parsed)) {
            try { return JSON.stringify(parsed); } catch (_) {}
        }
        return _toolErrorText(parsed);
    }

    // evalScript 回执归一（正常路径与渲染迟到回执投递共用）：
    // CSInterface 回调的 raw 理论上是字符串；对象/其它形态按 JSON 化后走同一解析链。
    function _rawToResultStr(raw) {
        return (typeof raw === 'string') ? raw : (raw && typeof raw === 'object' ? JSON.stringify(raw) : String(raw || ''));
    }

    // 回执解析（含双重 parse）：如果用户 extendScript 里自己写了 JSON.stringify，AE 会返回
    // 双重字符串，例如 '"{\\"status\\":\\"success\\"}"' → parse 一次得到字符串 → 再 parse。
    // 解析失败时抛错，由调用方按各自语义处理（正常路径的 success/isError 分支不变；
    // 迟到回执投递用同一解析结果判定成功/失败）。
    function _parseEvalResultStr(resultStr) {
        var parsed = JSON.parse(resultStr);
        if (typeof parsed === 'string') {
            try { parsed = JSON.parse(parsed); } catch (_) {}
        }
        return parsed;
    }

    // ── AE 本地化错误串修复（收紧 + 分段解码）─────────
    // 真机现象（renderComp 实测）：AE 抛的本地化错误经 evalScript 回传成
    // 「GBK 字节被 Latin-1 解码」的形态——「ÔÚÐèÒªÊý×Ö¡¢Êý×é…」（应为「在需要数字、
    // 数组或属性的位置…」）。该串会原样进工具回执、迟到回执卡片与会话落盘，模型和用户
    // 都读不懂，只能换参数重试。
    // 形态判据（逐段）：GBK 汉字是**双字节且两字节都 ≥0x80**，故真乱码在字符串里表现为
    // **连续的 U+0080–U+00FF 片段、长度为偶数**；工具自己拼的中文前缀（如 renderComp 的
    // 「渲染失败: 」）在片段之外，不受影响。整串含中文不再直接放弃，改为逐段解码。
    // 片段判据（_repairLatin1Run）：长度 ≥4 且偶数、GBK 严格解码成功、解出 CJK≥2 且
    // CJK×2 ≥ ASCII 字母数（真乱码解出中文句子；合法西文重音串如 Größe/naïve/État 被
    // ASCII 字母隔开或太短，全部原样保留）。
    // 应用面：正常路径与迟到回执的解析结果都修（错误回执与 success 载荷同口径，见两处调用点）。
    // 真机会话已出现 AE 异常被工具脚本 catch 后拼进 success 返回串（如
    // "noTextDoc(Error: Êý×Ö½á¹ûÎÞÐ§£¨³ýÒÔÁã£¿£©)"），success 载荷不能跳过。
    // TextDecoder 不可用（旧运行环境）时原样返回：修复是增强，不是新依赖。
    function _gbkFromLatin1(text) {
        if (typeof TextDecoder !== 'function' || typeof Uint8Array === 'undefined') return '';
        var bytes = [];
        for (var i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
        try { return new TextDecoder('gbk', { fatal: true }).decode(new Uint8Array(bytes)); }
        catch (_) { return ''; }
    }
    function _isCjkCode(code) {
        return (code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf);
    }
    function _isCjkDominant(fixed) {
        var cjk = 0, asciiLetters = 0;
        for (var k = 0; k < fixed.length; k++) {
            var fc = fixed.charCodeAt(k);
            if (_isCjkCode(fc)) cjk++;
            else if ((fc >= 0x41 && fc <= 0x5a) || (fc >= 0x61 && fc <= 0x7a)) asciiLetters++;
        }
        return cjk >= 2 && cjk * 2 >= asciiLetters;
    }
    function _repairLatin1Run(run) {
        // run 全是 U+0080–U+00FF：GBK 汉字双字节都 ≥0x80 ⇒ 只有偶数长度才可能是汉字。
        // 长度 <4（单汉字/单重音字母）不猜：宁可漏修，不把合法西文转坏。
        if (run.length < 4 || run.length % 2 !== 0) return run;
        var fixed = _gbkFromLatin1(run);
        if (!fixed || !_isCjkDominant(fixed)) return run;
        return fixed;
    }
    function _repairAeLocalizedText(text) {
        if (typeof text !== 'string' || !text) return text;
        if (!/[\u0080-\u00ff]/.test(text)) return text;   // 无高位字符 → 无需处理
        var out = '';
        var i = 0;
        var n = text.length;
        while (i < n) {
            var c = text.charCodeAt(i);
            if (c < 0x80 || c > 0xff) { out += text.charAt(i); i++; continue; }
            var j = i;
            while (j < n) {
                var cj = text.charCodeAt(j);
                if (cj < 0x80 || cj > 0xff) break;
                j++;
            }
            out += _repairLatin1Run(text.substring(i, j));
            i = j;
        }
        return out;
    }
    // 递归修复回执里的字符串值（不改键名、限深防环）：正常路径与迟到回执都对解析结果调用
    // （错误回执与 success 载荷同口径）；可见区/细节区/JSON.stringify 都消费这份解析结果，
    // 故一处修复覆盖三个出口。判据保证合法西文重音串原样（见 _repairLatin1Run 片段判据）；真机会话
    // 已出现 AE 异常被脚本 catch 后拼进 success 返回串（如 "noTextDoc(Error: Êý×Ö…)"），
    // 故 success 载荷不能跳过。
    function _repairAeLocalizedStrings(value, depth) {
        var d = (typeof depth === 'number') ? depth : 0;
        if (d > 6) return value;
        if (typeof value === 'string') return _repairAeLocalizedText(value);
        if (!value || typeof value !== 'object') return value;
        if (Object.prototype.toString.call(value) === '[object Array]') {
            for (var ai = 0; ai < value.length; ai++) value[ai] = _repairAeLocalizedStrings(value[ai], d + 1);
            return value;
        }
        for (var k in value) {
            if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
            value[k] = _repairAeLocalizedStrings(value[k], d + 1);
        }
        return value;
    }

    // opts（可选）：{ name: 工具名, wrapUndo: 是否包撤销组, undoInCore: 撤销组入核 }
    // 修改类工具调用包进以工具名命名的撤销组（AE 编辑菜单显示 "撤销 AS_ExtP: <工具名>"，
    // 用户一次 Ctrl+Z 即可回滚该次工具操作）；只读工具不传 wrapUndo（空撤销组是噪音）。
    // endUndoGroup 在内层 finally 里保证与 beginUndoGroup 成对（工具代码抛错也会闭合），
    // 否则 AE 报"撤销组不匹配"；beginUndoGroup 自身抛错时内层 try 未进入，end 不会执行，不会失配。
    // 省略 opts 时保持旧行为（不包撤销组），向后兼容既有调用方。
    // （机制在核/策略在调用方）：undoInCore 工具（authored
    // 代码执行核 executeExtendScript）的撤销组不再由 dispatcher 模板拼装——
    // 撤销组名经**授权帧载荷**（begin 的 undoName）传核（运行时字符串；显示净化在
    // 核内），核内固定模板包裹（shadow 外→undo 内→用户代码）。参数式工具（白名单
    // 宿主函数调用）保留 dispatcher 模板包裹——固定模板+转义参数=CI 铁律合法例外。
    // 撤销组名经授权帧载荷传核，不走 args.__undoName——后者是**调用方数据**，
    // authored 代码可自造该字段递归调核顶替组名；现改由面板单方写入帧载荷，且 args
    // 上的预填值一律剥除。
    // 历史注记：createHandler 原有 ESCAPE_PATTERN/SYSCALL_PATTERN 文本层预检
    // 由 AST 编译门承担（见下方 _runSandboxedScript 调用点）——文本层
    // 军备竞赛（拼接/转义/注释混淆绕过）在 AST 层归一，语义由三张表承载。

    // ── 渲染在途门 ──────────────────────────────────
    // 实测定论：AE 渲染期间 ExtendScript **完全被阻塞**（一次 17 分钟的渲染里，
    // 渲染开始 4 秒后发出的最轻 "PING" 探针也要等渲染结束才返回，与结束时刻相差
    // 2ms）。所以「渲染工具超时后重试」的真实后果是：重试请求排队到渲染结束后才
    // 执行 → 真的再排一次渲染（重复入队/重复输出）。
    // 在途信号：面板**自己发起**的渲染请求的 pending 状态（会话级——bootstrap 随
    // 面板加载重新求值，一会话一份；不引入新协议、不向 AE 侧发探针——渲染期任何
    // 探针都只会排在渲染之后，交叉验证无从谈起）：
    //   · 渲染类调用下发前置位；
    //   · evalScript 回调到达（= 渲染真正结束，含面板已超时后迟到的回执）复位；
    //   · 面板侧超时**不复位**——渲染仍在 AE 侧跑，正是要拦的窗口；迟到回执即复位。
    // 在途期间新的渲染类提交直接拒绝，不再次下发（见 createHandler 内拒绝点）。
    var _renderInFlight = false;
    // 在途渲染的发起者（{laneId, name}）：拒绝与超时文案必须
    // 能指明「谁占着 AE 引擎」，而不是沿用「AE 正弹模态框 / 操作慢」那类含糊措辞——
    // 团队模式下用户要知道该等哪条 lane。
    var _renderInFlightOwner = null;
    var RENDER_INFLIGHT_TEXT = '已有渲染在进行，请等待完成。';
    // 当前占着 AE 引擎的那一次调用（{token, laneId, name}，经 createHandler 真正下发的调用）。
    // 队列启用时同一刻至多一个（execQueue 的 _running 即互斥锁）；队列缺席/直通时可能并发，
    // 故只以 token 摘除自己那一条。用途：排队等待超时文案标占用来由。
    var _queueOccupant = null;
    // 兜底：在途位的**最长保持**看门狗。正常路径由 evalScript 迟到
    // 回执解除（= 渲染真正结束）；若 AE 侧回调永远不返回（AE 崩溃/永久模态），在途位会把
    // 后续渲染提交永久拦死——超长保持后自动解除并如实告警：宁可放行也不把渲染入口打死
    //（面板重载同样可解除，但不必劳烦用户）。
    var _renderInFlightWatchdog = null;
    var RENDER_INFLIGHT_MAX_HOLD_MS = 6 * 60 * 60 * 1000;   // 6h：真实渲染远超此值的场景不存在
    // 当前队列队头的交班函数（由 createHandler 的队列任务登记、结算时自清）。看门狗触发时
    // 一并结算它：这是「调用永不抵达」的判定，不是「按调用超时放行」（超时放行被禁止）。
    // 缺这条时队头会永久占着 AE 引擎：三条 lane 的后续调用全部排队并按各自超时失败，
    // 面板重载前 AE 不可用（实测复现）。
    var _activeQueueSettle = null;
    function _clearRenderInFlightWatchdog() {
        if (_renderInFlightWatchdog !== null) {
            clearTimeout(_renderInFlightWatchdog);
            _renderInFlightWatchdog = null;
        }
    }
    function _armRenderInFlightWatchdog() {
        if (_renderInFlightWatchdog !== null || !_renderInFlight) return;
        _renderInFlightWatchdog = setTimeout(function () {
            _renderInFlightWatchdog = null;
            if (!_renderInFlight) return;
            _renderInFlight = false;
            _renderInFlightOwner = null;
            // 队头一并放行（见 _activeQueueSettle 的说明）：先取引用再置空，防结算回调里重入
            var _headSettle = _activeQueueSettle;
            _activeQueueSettle = null;
            if (typeof _headSettle === 'function') {
                try { _headSettle(); } catch (_) {}
            }
            console.warn('[AE Bootstrap] 渲染在途位超长保持（' + (RENDER_INFLIGHT_MAX_HOLD_MS / 3600000)
                + 'h）自动解除：AE 侧回执始终未到达（AE 异常/永久模态）。后续渲染提交已放行；'
                + '若渲染其实仍在进行，请勿重复提交。');
        }, RENDER_INFLIGHT_MAX_HOLD_MS);
    }

    // 占用者标注（**半角方括号**）：渲染在途拒绝/超时文案共用。刻意不用全角括号——
    // 渲染专款超时文案有「无全角括号长注（简洁）」的既有约束。
    // 文案不暴露内部术语 lane 与裸 id，改用显示名（导演 / AE 执行 / Shader 执行）。
    // 队列常开：非 lane 归属也有了显示名——'single' → 单 Agent、'external' → 外接；
    // 入参可以是 id（字符串）或 owner 对象（{laneId, external}，外接标志优先于 id 映射）。
    function _laneNameOf(ownerOrId) {
        var id = (ownerOrId && typeof ownerOrId === 'object') ? ownerOrId.laneId : ownerOrId;
        if (ownerOrId && typeof ownerOrId === 'object' && ownerOrId.external === true) return '外接';
        if (id === 'single') return '单 Agent';
        if (id === 'external') return '外接';
        try {
            var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var def = (api && typeof api.get === 'function') ? api.get(id) : null;
            if (def && def.label) return def.label;
        } catch (_) { /* 定义源缺席：退回 id */ }
        return (id === undefined || id === null || id === '') ? '未知 Agent' : String(id);
    }
    function _ownerNote(owner) {
        if (!owner) return '';
        return ' [占用: ' + _laneNameOf(owner) + ' / 工具 ' + owner.name + ']';
    }

    // 排队等待超时文案：等待态的唯一文案源是 execQueue.occupancyText()（避免两处措辞分叉）；
    // 队列模块/该方法缺席时本地兜底成同义句（单测直调、裁剪装配）。
    function _waitOccupancyText() {
        var q = global.AEExecQueue;
        if (q && typeof q.occupancyText === 'function') {
            try {
                var t = q.occupancyText();
                if (typeof t === 'string' && t) return t;
            } catch (_) {}
        }
        var occ = _queueOccupant || _renderInFlightOwner;
        if (occ) return '等待 AE 引擎（被「' + _laneNameOf(occ) + '」的 ' + occ.name + ' 占用）';
        return '等待 AE 引擎';
    }

    // ── 多帧抓帧的执行超时 ──
    // AE 侧 _getPreviewFrames 的批预算按帧数伸缩（aeTools.jsx：min(75s, 帧数×12s+3s)，2 帧 27s）。
    // 面板「执行超时」是全局设置（默认 30s），只能覆盖单帧；≥2 个时间点时执行段必须覆盖
    // 「帧数 × 单帧等待上限 + 收尾余量」，否则批预算未走完就会被面板判超时、结果整体丢弃。
    // 单帧与其它工具仍用全局设置。
    // 上限 120s 由 createHandler 统一夹取；外接 relay 的 100s 等待由 ext_progress 心跳续期。
    // PREVIEW_FRAME_WAIT_MS 与 aeTools.jsx 的 FRAME_WAIT_BUDGET_MS 是镜像点（同为 12s），
    // PREVIEW_BATCH_TAIL_MS 覆盖 AE 侧批预算（6 帧 72s+3s）与回执传输余量——两处数字
    // 须同步改（任一上限变更后重跑用例核对）。
    var PREVIEW_FRAME_WAIT_MS = 12000;
    var PREVIEW_BATCH_TAIL_MS = 15000;
    function previewBatchTimeoutMs(args, baseTimeoutMs) {
        var n = (args && args.timesInSeconds && typeof args.timesInSeconds.length === 'number')
            ? args.timesInSeconds.length : 0;
        if (n < 2) return baseTimeoutMs;
        if (n > 6) n = 6;
        return Math.max(baseTimeoutMs, n * PREVIEW_FRAME_WAIT_MS + PREVIEW_BATCH_TAIL_MS);
    }

    function createHandler(extendScriptCode, opts) {
        var wrapUndo = !!(opts && typeof opts === 'object' && opts.wrapUndo === true);
        var undoInCore = !!(opts && typeof opts === 'object' && opts.undoInCore === true);
        // 结果后处理（opts.postProcess(parsed, args) → 新结果对象或 Promise）：只对**成功**的
        // JSON 结果生效，产出仍是同一信封（{success,isError,line,content}）。用途：
        // getPreviewFrame 的多时间点抓帧（AE 侧只出 PNG，拼联系表要有 canvas，见 previewSheet.js）
        // 与 analyzeImage 的像素指标（AE 侧无 canvas/像素读取 API，见 imageAnalysis.js）。
        // 插在本层是因为面板 agent 与外接派发共用同一 handler。后处理抛错不回滚工具
        //（AE 侧已成功），回退未处理结果。
        var postProcess = (opts && typeof opts.postProcess === 'function') ? opts.postProcess : null;
        // 工具名路径的撤销组名同样清理控制字符（对齐下方 getUndoName
        // 路径）——工具名来自 ae_tools.json（可手工编辑），含换行等控制字符时
        // beginUndoGroup 的 ES3 字符串字面量裸换行会让整条拼接脚本 SyntaxError，
        // 该工具每次调用都失败。创建侧校验（aeToolCreator /^[a-zA-Z_]\w*$/）只拦
        // 创建路径，手工编辑配置不受控。
        // U+2028/U+2029 同为 ES3 行终止符（NTFS 文件名合法字符，控制字符类
        // \x00-\x1F 覆盖不到），undoName 与下方 safeJson 数据通道同源——safeJson
        // 已显式转义而本通道漏防，含此类字符时同样整条脚本 SyntaxError。
        var defaultUndoName = wrapUndo
            ? String(opts.name || 'tool')
                .replace(/[\x00-\x1F\x7F]/g, ' ')
                .replace(/[\u2028\u2029]/g, ' ')
                .replace(/\\/g, '\\\\')
                .replace(/"/g, '\\"')
            : '';
        var getUndoName = (opts && typeof opts.getUndoName === 'function') ? opts.getUndoName : null;
        return function(args, ctx) {
            // lane 身份：团队装配后由 lane runtime 经**执行上下文**
            // 注入（toolExecutor.execute 给 handler 的第二参 {moduleId, callerId, ...}，本处读
            // ctx.laneId）。单 Agent / 外接 / 脚本区 / 单测直调都没有该字段 ⇒ 'single'。
            // 所有通道共用同一条 FIFO。外接调用靠 callerId 的 'ext:'
            // 前缀识别出**展示归属** 'external'——laneId 仍是 'single'（按 lane 取消/统计的
            // 语义不变），只有等待/占用文案改说「外接」而不是「single」。
            var _laneId = (ctx && typeof ctx.laneId === 'string' && ctx.laneId) ? ctx.laneId : 'single';
            var _isExtCaller = /^ext:/.test(String((ctx && ctx.callerId) || ''));
            var _toolLabel = (opts && opts.name) ? String(opts.name) : 'ae-tool';
            var _owner = { laneId: _laneId, name: _toolLabel, external: _isExtCaller };
            var _taskToken = {};
            // 运行时计算撤销组名：优先用 getUndoName(args) 返回值（如 executeExtendScript 的 action），回退到 defaultUndoName
            // action 是 LLM 生成文本，需严格清理：截断 30 字 + 替换 C0 控制字符/DEL/U+2028/U+2029 为空格 + 转义引号反斜杠
            //（dispatcher 模板路径——字面量拼接需转义；undoInCore 数据通道路径用 raw 串，净化在核内）
            var undoName = defaultUndoName;
            // undoInCore 数据通道值（raw 串——JSON 传输 + 核内显示净化）：
            // 回退序与 dispatcher 路径一致（getUndoName 空值 → 工具名）
            var coreUndoName = (undoInCore && wrapUndo)
                ? String(opts.name || 'tool').slice(0, 30) : '';
            if (getUndoName) {
                var custom = getUndoName(args);
                if (custom) {
                    coreUndoName = String(custom).slice(0, 30);
                    undoName = coreUndoName
                        .replace(/[\x00-\x1F\x7F]/g, ' ')
                        .replace(/[\u2028\u2029]/g, ' ')
                        .replace(/\\/g, '\\\\')
                        .replace(/"/g, '\\"');
                }
            }
            // → undoInCore 工具的撤销组名
            // 改经**授权帧载荷**传核（begin 的 undoName 字段，raw 串——JSON 传输 +
            // 核内显示净化）。经 args.__undoName 传时：authored 代码可伪造该字段
            // 递归调核顶替组名，「无条件覆盖」只挡住伪造值的生效路径、字段本身仍躺在
            // args 上被核当真相消费（同一类逃逸面，随授权位一并换载体）。
            // args 上的框架字段一律剥除：LLM 经 args 预填的 __undoName 现已零消费者，
            // 但必须清掉——拼装产物不得残留框架字段（对齐 __allow/__dataDir）。
            if (undoInCore) {
                if (!args) args = {};
                delete args.__undoName;
            }
            // 安全闸门：ae-tools 模块未初始化完成则拒绝所有工具调用
            if (!(window.AE_LLM && window.AE_LLM._aeToolsReady)) {
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: 'AE 工具模块未就绪，请刷新面板后重试。' }]
                });
            }
            if (typeof CSInterface === 'undefined') {
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: 'CSInterface 不可用：请在 After Effects 中打开扩展面板' }]
                });
            }
            // AST 编译门（含 ESCAPE_PATTERN/SYSCALL_PATTERN 预检——设计
            // 「regex 黑名单同步收编」）：读盘产物每次执行过门（双过门
            // 决策——「冻结工件」信任前提不成立，存储可被 writeFile 触达）。过门用
            // 重发射产物执行（TOCTOU 消失：校验与执行同一份）；拒绝回结构化理由
            // （行号/construct/替代方案——LLM 自修正或用户修库）。撤销组（begin/endUndoGroup）
            // 收录（工具代码自带优先、框架兜底——见下方 dispatcher 跳过逻辑）。
            if (!(window.AE_LLM && typeof window.AE_LLM._runSandboxedScript === 'function')) {
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: 'AST 编译门未就绪（ast-gate 模块加载失败），拒绝执行以保安全。请刷新面板。' }]
                });
            }
            var _gateTool = window.AE_LLM._runSandboxedScript(extendScriptCode, { source: 'ae-tool' });
            if (!_gateTool.ok) {
                var _gateAlt = (_gateTool.error && _gateTool.error.alternative)
                    ? ' ' + _gateTool.error.alternative : '';
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: '[AE_LLM] AE 工具被 AST 门拒绝：' + _gateTool.displayText + _gateAlt + '。工具代码（含手工编辑后的 ae_tools.json）须在能力白名单内；如需该能力请修改工具代码或改用参数式工具。' }]
                });
            }
            // 门侧 AST 判据：工具代码没有可执行语句（空块/空循环/只有注释或分号）时，拼出的 IIFE
            // 什么都不做、宿主回「执行成功，未返回结果」——这条通道的假成功（循环检查确认；
            // 触发例：createAETool({extendScript:"// TODO"}) 建出的工具每次调用都回绿；外接 MCP 通道
            // 传空 code 也汇聚到这里）。判据与 agent 侧的 EMPTY_CODE 同一个（门返回的
            // noExecutableStatement，AST 级）。
            if (_gateTool.noExecutableStatement === true) {
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: '[AE_LLM] AE 工具代码没有可执行语句（空块、空循环，或只含注释/分号），本次未执行。请补上实际要执行的语句（工具代码需给全局 result 赋值才会回结果）。' }]
                });
            }
            var extendScriptEmitted = _gateTool.emitted;
            // 渲染触发判据（与 aeTools.jsx 侧镜像，勿单改一处——任何 renderQueue 取用
            // （别名/计算键）与 render( 调用都算渲染触发。便捷入口 addToRenderQueue / startRender
            // 已删除，两个字面量仍留在判据里：存量工具/用户脚本可能
            // 仍用这两种写法，宽判据宁可误伤。误伤只损失
            // 一次外层撤销组/多拦一次重复提交，漏判会让 AE 模态卡死整条通道或重复入队）。
            // 加 \brenderComp\b——参数式渲染工具（模板 `result = renderComp(__args);`）
            // 与 authored 直调同属渲染触发，须同样套在途去重/对话框抑制/渲染前备份。
            // 两处消费：本函数下方撤销组跳过 + 渲染在途去重。
            var _renderTrigger = /\baddToRenderQueue\b|\bstartRender\b|\brenderQueue\b|\brender\s*\(|\brenderComp\b/i.test(extendScriptEmitted);
            // 渲染类调用总判据 = 工具模板命中 ∪ **authored 代码命中**。
            // executeExtendScript（authored 代码执行核，undoInCore）的渲染藏在 args.code
            // 里——工具模板本身只是 `result = executeExtendScript(__args);`，只看模板会漏掉
            // 真机主路径（渲染复现探针走的正是 executeExtendScript → 原生
            // app.project.renderQueue.render()）。
            // 内核 aeTools.jsx 对 authored 代码有同款判据（管核内撤销组），
            // 但面板侧的在途去重与超时文案只能由本处判定，故此处补看 args.code
            //（判据同一族正则，勿单改一处）。args.code 非字符串（畸形入参/非核通道）按非渲染处理。
            var _isRenderCall = _renderTrigger
                || ((undoInCore === true || (opts && opts.name === 'executeExtendScript'))
                    && !!(args && typeof args.code === 'string'
                        && /\baddToRenderQueue\b|\bstartRender\b|\brenderQueue\b|\brender\s*\(|\brenderComp\b/i.test(args.code)));
            // ── 异步受理/迟到回执判据（勿与上方宽判据合并成一处）──────
            // 宽判据 _isRenderCall 的误伤代价是**廉价的**（多拦一次重复提交 / 少一个外层撤销组），
            // 故宁可误伤。但异步受理把工具结果换成 {status:"submitted"}、真实结果改由一张
            // 系统卡投递——误伤在这里的代价变成「模型拿不到真实结果 + 用户看到一张
            // 『渲染已完成』卡」。真机实测：executeExtendScript 只读
            // `app.project.renderQueue.item(n).templates`（无任何渲染调用）就被受理成 submitted，
            // 随后迟到回执投成「渲染已完成（后台受理回执）」。
            // 故异步受理只认真会阻塞脚本引擎的渲染调用：
            //   · 参数式渲染工具模板命中（_renderTrigger，如 renderComp 的模板）；
            //   · authored 核心（executeExtendScript / undoInCore）的 args.code 里**存在渲染调用**
            //     —— .render( 调用、startRender / renderComp 入口。仅**提及** renderQueue
            //     （读模板名、读队列项、清理队列）不算。
            // 两处消费：下方迟到回执投递 + 渲染异步受理分支；在途去重/对话框抑制/渲染前备份
            // 仍用宽判据 _isRenderCall（见上方 _renderTrigger 消费点）。
            var _authoredRenderInvoke = false;
            if ((undoInCore === true || (opts && opts.name === 'executeExtendScript'))
                && args && typeof args.code === 'string') {
                _authoredRenderInvoke = /\bstartRender\b|\brenderComp\b|\.\s*render\s*\(/i.test(args.code);
            }
            var _renderAcceptsAsync = _renderTrigger || _authoredRenderInvoke;
            // 渲染在途时拒绝新的渲染提交——面板超时只说明「等不到
            // 回执」，AE 侧渲染仍在跑且脚本引擎被独占（实测渲染期连最轻探针都排队到结束），
            // 此刻重试会排队到渲染结束后执行 = 真的再排一次渲染（重复入队）。静默排队不如
            // 如实拒绝（回执文案给出等待指引）。
            // 拒绝文案追加**占用者**（lane + 工具名）——
            // 团队模式下「已有渲染在进行」必须能定位到是哪条 lane 的哪次渲染，否则用户
            // 只能干等（文案后缀为空时与改动前逐字节相同：单 Agent 路径的老回执不变）。
            if (_isRenderCall && _renderInFlight) {
                return Promise.resolve({
                    success: false, isError: true,
                    content: [{ type: 'text', text: RENDER_INFLIGHT_TEXT + _ownerNote(_renderInFlightOwner) }]
                });
            }
            // / ：能力域运行时授权位（**授权帧载荷**，
            // 不再写入 args——authored 代码可自造 args.__allow 递归调核，「无条件覆盖」
            // 只挡住伪造值的生效、字段本身仍被核当真相消费）。D 修正：组装位置在
            // undoInCore 判定外——非撤销组的自定义 ae-tool 同样取得能力授权（bypass 时
            // 拿得到全开 file 能力）。四域读 config（file 域配置 ∪ allowSet 当次授权——
            // user-library 逐脚本确认 / llm-preview 域确认；menu 纯门侧无核需求）
            // + bypass 全开（ae-tool 通道=本门自身 bypassed；agent-tool 通道=
            // opts.bypassSource——executeExtendScript 注册端点，pipeline 无法经
            // opts 传参故注册面声明）。config 缺席时 system 域回退读
            // mirror（同 run.js 修正——m2b-allowset 沙箱设 mirror 驱动
            // 帧载荷的 system 位，config 模块未载；面板端 mirror 由 config 单点维护
            // 恒等于 domains.system，不构成第二真相源）
            if (!args) args = {};
            var _cfgD = (global.AEGate && global.AEGate.config)
                ? global.AEGate.config.read().domains : {};
            var _allow = {
                system: _cfgD.system === true
                    || !!(window.AE_LLM && window.AE_LLM.allowAEToolsSystemCall),
                socket: _cfgD.socket === true,
                file: _cfgD.file === true
            };
            if (_gateTool.bypassed === true
                || (opts && opts.bypassSource && global.AEGate && global.AEGate.config
                    && global.AEGate.config.isBypassed(opts.bypassSource))) {
                _allow.system = true;
                _allow.socket = true;
                _allow.file = true;
            }
            if (opts && typeof opts.allowSet === 'function') {
                try {
                    var _as = opts.allowSet(args);
                    if (_as && typeof _as === 'object') {
                        if (_as.system === true) _allow.system = true;
                        if (_as.socket === true) _allow.socket = true;
                        if (_as.file === true) _allow.file = true;
                        // 弹窗域：仅用户手动运行通道的服务层注入
                        //（脚本区 runScript / 脚本树 _execScriptFile 恒传 dialog:true）；
                        // ae-tool/agent 管线不传 → 核 shadow 保持（alert→日志 +
                        // confirm/prompt throw）
                        if (_as.dialog === true) _allow.dialog = true;
                    }
                } catch (_) {}
            }
            // _allow 不再写入 args —— 它是 begin 的载荷
            //（见下方拼装模板）。args 上的框架字段全部移除：四个来源的组装逻辑一字不改。
            // 三个框架字段（__allow/__undoName/__dataDir）的 LLM 预填值一律剥除——
            // 它们已零消费者，但拼装产物不得残留框架字段（防后人误把 args 当授权源）。
            delete args.__allow;
            // reject 直取：队列任务里同步抛错（cs.evalScript 抛）时，throw 只会拒绝**队列任务**
            // 的 Promise，工具面 Promise 必须显式 reject 才能保持改动前的拒绝语义。
            return new Promise(function(resolve, reject) {
                var cs = new CSInterface();
                // 注入 __dataDir 供 ExtendScript 侧工具使用（如 getPreviewFrame 写预览 PNG 到扩展数据目录，
                // 避免硬编码 APPDATA 路径导致用户自定义数据目录失效）。__ 前缀避免与 LLM input_schema 字段冲突。
                // 改经**授权帧载荷**传核（begin 的 dataDir
                // 字段）。「无条件覆盖」只挡住了伪造值的生效路径——字段本身仍
                // 躺在 args 上被核当真相读，authored 代码伪造它等于可控路径写盘。
                // 载体的「以框架目录为准、不可用时为空（jsx 侧回退硬编码 APPDATA 路径）」
                // 语义一字不改；args 上的预填值一律剥除（拼装产物不得残留框架字段）。
                var _dataDir = '';
                if (args) {
                    try {
                        var _dd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                            ? global.AEShared.getDataDir().dir : '';
                        if (_dd) _dataDir = _dd;
                        delete args.__dataDir;
                    } catch (_) {}
                }
                var argsJson = JSON.stringify(args || {});
                // U+2028/U+2029（行/段分隔符）在 ES3 字符串字面量中非法，且 JSON.stringify 不会转义它们，
                // 含此类字符的参数会让整个 evalScript 解析失败；这里显式转成 \uXXXX 转义
                var safeJson = argsJson.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
                    .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
                if (safeJson.length > 60000) {
                    resolve({ success: false, isError: true, content: [{ type: 'text', text: '参数过大 (' + safeJson.length + ' bytes)，超出 ExtendScript 传输限制' }] });
                    return;
                }

                // 超时保护：cs.evalScript 无取消机制，ExtendScript 卡住时 Promise 永不 resolve。
                // 超时后 resolve 错误释放 UI busy，AE 侧代码继续运行（无法从 CEF 杀掉）。
                // opts.timeoutMs 优先（preview/脚本树/quickBar 各自的执行超时
                // 设置——三入口改道本桥后经此透传），缺省回落 ae-tools 模块设置。
                // opts.timeoutMs 可传数字（固定覆盖）或函数 (args, baseMs)：多帧抓帧按
                // timesInSeconds 帧数抬升（见 previewBatchTimeoutMs）；函数抛错回退 base。
                var baseTimeoutMs = (window.AE_LLM && typeof window.AE_LLM._aeToolTimeoutMs === 'number')
                    ? window.AE_LLM._aeToolTimeoutMs : 30000;
                var timeoutMs = baseTimeoutMs;
                if (opts && typeof opts.timeoutMs === 'function') {
                    try { timeoutMs = opts.timeoutMs(args, baseTimeoutMs); } catch (_) { timeoutMs = baseTimeoutMs; }
                } else if (opts && typeof opts.timeoutMs === 'number') {
                    timeoutMs = opts.timeoutMs;
                }
                if (typeof timeoutMs !== 'number' || !isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = baseTimeoutMs;
                // 上限兜底（防御历史遗留的已存盘大值）：> 2^31-1 ms 的 setTimeout 延迟会被
                // 引擎夹成 ~1ms，表现为"立即超时"。面板采集/落盘与引擎 normalize 已统一夹
                // 到 120s（UI 口径 3–120），这里最后兜一层——旧磁盘大值/绕过设置的直传调用方
                // 都不会再把溢出值送进 setTimeout。
                if (timeoutMs > 120000) timeoutMs = 120000;
                var finished = false;
                // 本调用是否已真正下发到 AE（队列任务已开始）。false = 还在队列里等队头，
                // 超时文案据此分档（「未下发」与「已下发」是两件不同的事，不能共用一个措辞）。
                var _dispatched = false;
                // ── 两段预算 ────────────────────────────────
                // 排队等待与执行**各一份 timeoutMs**：
                //   · 等待段：从本次调用开始到真正下发为止（防无限期挂住；到点回「未下发」，
                //     保证 AE 侧零副作用）。
                //   · 执行段：从下发那一刻重新起算（旧口径一个定时器从入队前跑，排队时间会挤占
                //     执行预算 —— 前面一条渲染/长脚本就足以让「只是在等引擎」被误报成执行超时）。
                // 总预算最坏 2×timeoutMs；两段各有准确文案。队列本身不挂计时器（只负责顺序）。
                var waitTimer = null;
                var execTimer = null;
                var _clearTimers = function () {
                    if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
                    if (execTimer) { clearTimeout(execTimer); execTimer = null; }
                };
                var _onTimeout = function () {
                    if (finished) return;
                    finished = true;
                    waitTimer = null;
                    execTimer = null;
                    console.warn('[AE Bootstrap] Tool execution timeout after ' + (timeoutMs / 1000) + 's');
                    // 渲染类超时用**渲染专款简短文案**——渲染期脚本引擎被占用，
                    // 通用文案的两条路（去 AE 处理模态框 / 调大超时后再试）都不适用，且
                    // 「重试」本身正是要阻止的动作（会重复入队）。此处**不复位**
                    // _renderInFlight：渲染仍在 AE 侧跑，重试必须被在途门拦截；
                    // evalScript 迟到回执（= 渲染真正结束）到达时才复位。
                    // 已下发的渲染超时文案追加占用者标注
                    // （半角方括号，见 _ownerNote）——「谁在渲染」是团队模式下唯一有用的信息。
                    if (_isRenderCall) {
                        // 已下发（队列任务已在跑）：AE 侧真的在渲染本次调用
                        if (_renderInFlight) {
                            // 兜底：在途位从此开始无人可解（正常解 = 迟到回执），挂最长保持看门狗
                            _armRenderInFlightWatchdog();
                            resolve({
                                success: false, isError: true,
                                content: [{ type: 'text', text: 'AE 正在渲染，脚本引擎被占用。请等待渲染结束，勿重复提交。'
                                    + _ownerNote(_renderInFlightOwner) }]
                            });
                            return;
                        }
                        // 未下发（还在队列里等队头）→ 落到下面「未下发」分支，不在这里报「正在渲染」
                    }
                    // 还没轮到本调用就超时（排在队头之后）：**未下发**，AE 侧没有本次
                    // 调用的任何副作用，也没有「本调用在渲染」这回事——如实这么报，并把占着
                    // AE 引擎的那一位（归属 + 工具名）写进文案。此处也不挂看门狗：本调用从未
                    // 置位 _renderInFlight，无位可解。
                    if (!_dispatched) {
                        resolve({
                            success: false, isError: true,
                            content: [{ type: 'text', text: 'AE 工具排队等待超时（' + (timeoutMs / 1000) + ' 秒），本次调用未下发到 AE：'
                                + _waitOccupancyText() + '。请等待该调用结束后重试。' }]
                        });
                        return;
                    }
                    resolve({
                        success: false, isError: true,
                        // 超时只有墙钟可见，两种主因（模态框阻塞 / 操作本身慢）在 CEF 侧
                        // 无法区分——文案把两条路都给出。
                        content: [{ type: 'text', text: 'AE 工具执行超时（' + (timeoutMs / 1000) + ' 秒）。常见原因有两种：'
                            + '① AE 正弹着模态对话框等确认（如"缺少效果的参考"、文件对话框、"撤消组不匹配"警告）——切到 AE 处理弹窗后重试；'
                            + '② 操作本身耗时——可简化操作，或在模块设置中调大"执行超时"时间后重试。' }]
                    });
                };
                waitTimer = setTimeout(_onTimeout, timeoutMs);

                // AE 工具沙箱（守卫闭包私有化）——运行期防护安装已整体
                // 下沉到 aeTools.jsx 闭包（__aeSGOn/__aeSGDn，见该文件「运行时防护安装/
                // 卸载」段）：本模板只保留一个**安装点**，不再拼接任何补丁 JS——
                //   ① 补丁函数与其判据（_isSensitivePath/_isSystemOrRootDir）都是闭包内
                //      词法引用，authored 代码的名字空间里没有名字可替换（旧模板的
                //      __aeS* 守卫变量是 dispatcher 顶层 var，直跑工具代码词法嵌套
                //      其内、直接赋值即 disarm——闭包私有化后不再可达）；
                //   ② 宿主 shadow：system.callSystem / Socket 按帧授权域（allow.system /
                //      allow.socket），BridgeTalk / app.scheduleTask 恒拒（硬拒项无域无
                //      bypass 豁免），Socket 恢复含 $.global.Socket 同步；
                //   ③ File/Folder 原型补丁两 profile：授权 = 敏感路径（open 读写两态）+
                //      写/删方向系统目录/盘根（含 rename/copy 目标参数）；未授权 = open
                //      写模式 + remove/rename/copy/execute/changePath 全拦；
                //   ④ 重入深度计数（嵌套窗口只加计数），归零才恢复并清空保存引用
                //      （原模板两个恢复函数合并为 __aeSGDn）。
                // 授权位由**授权帧**承载（__aeSAuth.get().allow——domains 配置 ∪ allowSet
                // 当次授权 ∪ bypass 全开，见上方 _allow 组装）；__aeSGOn **无参**，自己读
                // 私有帧 _authFrame——模板不传授权值（帧载荷由面板单方写入，authored 代码
                // 既不持令牌也读不到拼装文本）。安装失败（引擎未就绪/安装点被替换/返回非
                // 严格 true）即 throw 中止本次调用（最坏是可用性损失，不会「调用成功
                // 但防护被削弱」）。恢复点在用户代码之后、帧关闭之前（正常/异常路径都到达，
                // 与现状一致）。
                // 统一返回值模式：框架预置 result=undefined，用户代码将返回值赋给 result
                // 注意：用赋值而非 var result; — 全局代码里 var 声明无 initializer 不会覆盖
                // 已存在的全局 result（ES3 变量实例化保留原值），会导致串到上次执行的残留值。
                // 用 result = undefined; 强制清零。
                // undoInCore 工具的撤销组在核内（撤销组名走下方授权帧载荷）
                // ——dispatcher 不再模板包裹（防双重包裹）。
                // 工具代码优先、框架兜底：自带撤销组时同样跳过外层
                // 包裹（避免嵌套 mismatch），撤销语义由工具代码自负。
                var _userOwnsUndo = /beginUndoGroup|endUndoGroup/i.test(extendScriptEmitted);
                // 渲染触发同样跳过外层撤销组——渲染在组内执行会让 AE 报
                // 「撤消组不匹配」并弹模态卡住脚本引擎（真机以小渲染复现定因；详见
                // aeTools.jsx 同款判据处注释）。判据 _renderTrigger 已在 AST 门后统一
                // 求值（见该处注释，两处消费：本处 + 渲染在途去重），不再在此重算——
                // 单处判据防漂移；覆盖面：工具体（自定义工具 extendScript）/脚本树/
                // 快捷栏/预览区通道，aeTools.jsx 侧覆盖 executeExtendScript 的 authored
                // 代码通道。
                var _skipUndoWrap = _userOwnsUndo || _renderTrigger;
                // 渲染触发包**对话框抑制**（与撤销组互斥——渲染触发时
                // _skipUndoWrap 恒真，两个分支不会同时命中，故仍只用一对 try/finally）。
                // 渲染输出模块指向已存在文件时 AE 弹应用级警告「所选输出模块将覆盖已存在
                // 的文件。要允许此操作，请按"确定"。」并卡住脚本引擎（真机三阶段对照的
                // 定因与实测数据见 aeTools.jsx 同款判据处注释；核内 authored 通道同款处理）。
                // endSuppressDialogs(false) 成对在 finally：用户代码炸时仍闭合，否则抑制
                // 状态泄漏到之后全部调用。
                var _suppressWrap = _renderTrigger;
                // 渲染触发 → 拼装脚本**头部**先做旧产物备份（<名>.prev<扩展名> 留一代）。
                // 位置硬约束：必须在 __aeSGOn() 之前——守卫装上后 File.prototype.rename/remove
                // 是 throw 版（未授权 file 域时），备份会静默失效。函数体在 aeTools.jsx（导出到
                // $.global）；名字已登记 _INTERNAL_NAMES，授权代码按名引用会被 AST 门拒。
                var _renderBackupCall = _renderTrigger
                    ? 'try { if (typeof _backupRenderOutputs === "function") { _backupRenderOutputs(); } } catch (__rb) {}\n'
                    : '';
                var undoOpen = (wrapUndo && !undoInCore && !_skipUndoWrap)
                    ? 'app.beginUndoGroup("AS_ExtP: ' + undoName + '");\ntry {\n'
                    : (_suppressWrap ? 'app.beginSuppressDialogs();\ntry {\n' : '');
                var undoClose = (wrapUndo && !undoInCore && !_skipUndoWrap)
                    ? '} finally { app.endUndoGroup(); }\n'
                    : (_suppressWrap ? '} finally { app.endSuppressDialogs(false); }\n' : '');
                // —— 授权帧建立/关闭 ──────────────────────────
                // 授权位（allow）/撤销组名（undoName）/数据目录（dataDir）不再经 args 传核：
                // args 是调用方数据，authored 代码自造 {__allow:{file:true}} 递归调核即可让
                // 守卫换成「授权」形态（AE 内实测逃逸）。现在面板在 authored 代码执行**之前**
                // 用令牌建立帧、末尾关闭，核与消费点读帧（__aeSG.__aeSAuth 门面 → 私有 _authFrame）。
                // 令牌只出现在本拼装文本里、**不进 args**——authored 代码读不到拼装文本，
                // 故猜不到令牌（这是它唯一的安全性来源，**不是密码学令牌**；ES3 同 VM 内
                // 不存在形式化保证。核内黑名单已拦 caller/callee——arguments.callee.caller
                // .toString() 正是读拼装文本的路径，**hotbox 等不过门通道靠那条兜底**
                //（外接同样过门，另有门侧 META_PROPERTIES 覆盖）。
                // 成对保底：正常路径与异常路径都在恢复段之后关闭（与 __aeSGDn 同址
                // ——它们已有同样的「异常路径也到达」语义）；begin 失败（帧内不同令牌重入被拒）
                // 时该 end 是无害 no-op（同令牌才计数）。
                var _frameToken = 't' + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
                // JSON → ES3 字符串字面量安全：U+2028/U+2029 是 ES3 行终止符且
                // JSON.stringify 不转义它们，裸嵌会让整条拼装脚本 SyntaxError
                //（对齐下方 safeJson 的既有处理）
                var _jsonLiteral = function (v) {
                    return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
                };
                var script = _renderBackupCall + 'try { var __args = JSON.parse("' + safeJson + '");\n' +
                    '__aeSAuth.begin("' + _frameToken + '", {"allow":' + _jsonLiteral(_allow)
                        + ',"undoName":' + _jsonLiteral(coreUndoName)
                        + ',"dataDir":' + _jsonLiteral(_dataDir)
                        // win:true = 「这是一次 authored 代码
                        // 执行窗口」——核侧 __aeSGDn() 据此**拒绝在窗口内把守卫计数降到 0**
                        // （详见 aeTools.jsx 该函数的注释）。载荷由面板单方拼装、帧由令牌
                        // 保护，authored 代码既猜不到令牌也重开不了帧 ⇒ 标记不可伪造/清除。
                        + ',"win":true});\n' +
                    // 安装点：__aeSGOn 无参（自读私有帧）；成功必须严格 true——
                    // 引擎未就绪/安装点被替换时本次调用当场中止（fail-loud，I5）。
                    'if(typeof __aeSGOn!=="function"||__aeSGOn()!==true)throw Error("[AE_LLM] 运行时防护安装失败（引擎未就绪或防护安装点被替换）——本次调用已中止");\n' +
                    'result = undefined;\n' +
                    undoOpen +
                    // 工具代码必须包进 IIFE——evalScript 内容按 Program 解析，顶层
                    // return 是 SyntaxError（整条脚本解析期失败），而 createAETool 工具描述
                    // 明确引导"错误处理：用 return 返回错误信息"，遵循约定即 100% 触发
                    // EvalScript error（同库对照通道已规避：aeTools.jsx executeExtendScript
                    // 用 new Function、agent executor.js 用 IIFE）。包裹后 return 合法，
                    // 返回值仅在非 undefined 时覆盖 result：seed 工具 result = func(__args);
                    // 形态无 return（__rv 恒为 undefined），赋值约定照常生效不受影响。
                    // 工具码 IIFE 加**形参遮蔽** Function/eval——与内核
                    // __prologue 的局部声明同款语义（dispatcher 通道没有核的局部声明机制，
                    // 形参是等价物）。实参是**内联函数表达式**（不经任何全局名传递——没有
                    // 名字即可达面）；工具代码里 Function(...)/eval(...)/new Function(...)
                    // 解析到形参、调用即抛。宿主全局 Function 只读（裸赋值静默失败）——
                    // 形参遮蔽与赋值无关，是唯一可靠机制。
                    // 内嵌门重发射产物（extendScriptEmitted）——校验与执行同一份
                    'var __rv = (function(Function, eval){\n' + extendScriptEmitted + '\n})(function(){throw Error("[AE_LLM] Function constructor blocked in AE tool sandbox.");},function(){throw Error("[AE_LLM] eval blocked in AE tool sandbox.");});\n' +
                    'if(typeof __rv!=="undefined")result=__rv;\n' +
                    undoClose +
                    // **先关帧、再卸守卫**（顺序不可换）。核侧 __aeSGDn()
                    // 在 win 帧仍开着时拒绝把计数降到 0（挡授权代码拆守卫）；模板自己的这次
                    // 卸载必须发生在 end 之后（此时 win 已随帧清空、放行）。反过来写 ⇒ 模板
                    // 自己也被拒 ⇒ 守卫永久驻留、之后所有调用反复补丁（readFile/writeFile 连锁失效）。
                    'if(typeof __aeSAuth!=="undefined")__aeSAuth.end("' + _frameToken + '");\n' +
                    'if(typeof __aeSGDn==="function")__aeSGDn();\n' +
                    // JSON.stringify(undefined) 在 ExtendScript 返回 undefined 值，evalScript 会转成空串 "",
                    // 下游 catch 会凭空捏造 {status:"success"}。这里把 undefined 显式翻成 "undefined" 字符串,
                    // 让 view.js 的 "无返回值" 警告分支(raw === 'undefined')能命中。
                    '(typeof result === "undefined" ? "undefined" : JSON.stringify(result));\n' +
                    '} catch(__e) { if(typeof __aeSAuth!=="undefined")__aeSAuth.end("' + _frameToken + '");if(typeof __aeSGDn==="function")__aeSGDn(); JSON.stringify({status:"error", message:__e.toString()}); }';
                // 渲染在途置位：请求即将下发。复位点在 evalScript 回调首行
                // ——无论面板是否已经超时（finished=true 早退）都必须复位：迟到回执到达
                // = AE 渲染真正结束，是在途门的唯一解除信号。
                // 同理，早退之前还要把**渲染类**迟到回执的结果回投发起 lane（见下方
                // _deliverLateRenderReceipt）：结果可以迟到，但不能丢（ISSUE-02）。
                //
                // ── 渲染迟到回执回投 ─────────────────────────
                // 面板超时（finished=true）只说明「等不到回执」，AE 侧渲染可能仍在跑；
                // 渲染真正结束时的 evalScript 回执会在 `if (finished) return;` 处被直接
                // 丢弃——Agent 永远不知道渲染已完成/失败，只能反复查询猜状态。
                // 这里只对**渲染类**调用（_isRenderCall）的迟到回执复用既有后台结果回流
                // 通道（AEEngine 门面的 injectSystemResult）推回**发起 lane**（_laneId）；
                // 非渲染工具与外接来源保持原行为（迟到回执丢弃），正常路径不经过本函数
                //（行为不变）。
                // 只投递一次：回调理论只来一次，重复回执（测试/异常重入）不得重复注入。
                // 门面缺席时 console.warn 放弃、不抛错（投递失败不能打断 CSInterface 回调链）。
                var _lateReceiptDelivered = false;
                // 渲染类工具「异步受理」标志。
                // true = 本次渲染在**下发时**已回执 submitted，结果由迟到回执投递；
                // 迟到回执文案据此写「后台受理回执」而不是「迟到的回执，面板曾超时」。
                var _renderSubmitted = false;
                var _deliverLateRenderReceipt = function(raw) {
                    if (_lateReceiptDelivered) return;
                    _lateReceiptDelivered = true;
                    try {
                        // 真实运行路径 = AEEngine.bridge.injectSystemResult（lane 精确投递，
                        // 见 engine/bootstrap.js 门面；给 laneId 就按 laneId 投，不回落当前
                        // lane）。直接挂在 AEEngine 上的形态一并兼容（单测/门面收敛）。
                        var _eng = (typeof window !== 'undefined') ? window.AEEngine : null;
                        var _inject = null;
                        var _injectHost = null;
                        if (_eng && typeof _eng.injectSystemResult === 'function') {
                            _inject = _eng.injectSystemResult;
                            _injectHost = _eng;
                        } else if (_eng && _eng.bridge && typeof _eng.bridge.injectSystemResult === 'function') {
                            _inject = _eng.bridge.injectSystemResult;
                            _injectHost = _eng.bridge;
                        }
                        if (!_inject) {
                            console.warn('[AE Bootstrap] 渲染迟到回执无法回投：AEEngine.injectSystemResult 不可用（lane='
                                + _laneId + '，工具 ' + _toolLabel + '）');
                            return;
                        }
                        var _resultStr = _rawToResultStr(raw);
                        var _parsed = null;
                        var _parseOk = false;
                        try { _parsed = _parseEvalResultStr(_resultStr); _parseOk = true; } catch (_) {}
                        // 结果分类与正常路径同口径：解析成功按 _isToolErrorPayload 判错；
                        // 解析失败时，空串/字面 "undefined" = 工具未给 result 赋值（AE 侧调用
                        // 已结束，不判失败），其余（EvalScript error / 非 JSON 正文）按失败带原文。
                        // 解析结果无论成功/失败都先做乱码修复（success 载荷里的
                        // AE 异常串同属回执正文；判据不动，合法西文重音串零影响）。
                        var _isError = false;
                        var _errText = '';
                        var _noResult = false;
                        if (_parseOk) {
                            _parsed = _repairAeLocalizedStrings(_parsed);
                            _isError = _isToolErrorPayload(_parsed);
                            if (_isError) _errText = _toolErrorText(_parsed);
                        } else {
                            var _trimmedRaw = String(_resultStr || '').trim();
                            _noResult = (_trimmedRaw === '' || _trimmedRaw === 'undefined');
                            _isError = !_noResult;
                            if (_isError) _errText = _repairAeLocalizedText(_trimmedRaw);
                        }
                        // 摘要只写回执里真实存在的字段，缺失不编造（renderComp 回执含
                        // outputPath / productSize / elapsedMs / comp）。
                        var _p = (_parseOk && _parsed && typeof _parsed === 'object') ? _parsed : null;
                        // 回执来源标注：异步受理（下发即 submitted）与面板超时两种来源文案不同——
                        // 前者没有「面板曾超时」，写「后台受理回执」。
                        var _rcptNote = _renderSubmitted ? '后台受理回执' : '迟到的回执，面板此前已超时';
                        var _vis = [];
                        if (_isError) {
                            _vis.push('工具 ' + _toolLabel + ' 渲染失败（' + _rcptNote + '）：'
                                + (_errText || 'Unknown error'));
                            // 结构化诊断：partial/recovery 与失败原因同等重要——
                            // 「脚本可能已部分执行」「可用 undoLastOperation 回滚」必须让用户/模型
                            // 在卡片里看到（细节区 JSON 已含全部字段，这里补可读摘要）。
                            if (_p) {
                                if (_p.partial !== undefined) {
                                    _vis.push('部分生效状态：' + String(_p.partial)
                                        + '（脚本抛错前可能已执行部分修改）。');
                                }
                                if (typeof _p.recovery === 'string' && _p.recovery) {
                                    _vis.push('恢复建议：' + _p.recovery);
                                }
                            }
                        } else {
                            _vis.push('工具 ' + _toolLabel + ' 的调用已结束（' + _rcptNote + '）。');
                            if (_p) {
                                if (typeof _p.comp === 'string' && _p.comp) _vis.push('合成 ' + _p.comp + '。');
                                var _path = '';
                                if (typeof _p.outputPath === 'string' && _p.outputPath) _path = _p.outputPath;
                                else if (typeof _p.outputFile === 'string' && _p.outputFile) _path = _p.outputFile;
                                var _size = (typeof _p.productSize === 'number') ? _p.productSize
                                    : ((typeof _p.size === 'number') ? _p.size : null);
                                if (_path) {
                                    _vis.push('产物 ' + _path + (_size !== null ? '（' + _size + ' 字节）' : '') + '。');
                                } else if (_size !== null) {
                                    _vis.push('产物大小 ' + _size + ' 字节。');
                                }
                                if (typeof _p.elapsedMs === 'number') _vis.push('AE 侧耗时 ' + _p.elapsedMs + 'ms。');
                            } else if (_noResult) {
                                _vis.push('工具未返回结果（未给 result 赋值），无法从回执确认渲染产物。');
                            } else {
                                _vis.push('回执：' + _repairAeLocalizedText(String(_resultStr || '').slice(0, 200)));
                            }
                        }
                        var _title = _isError ? ('渲染失败（' + _rcptNote + '）')
                            : (_noResult ? ('渲染已结束（' + _rcptNote + '）')
                                : ('渲染已完成（' + _rcptNote + '）'));
                        var _detailText = _parseOk ? JSON.stringify(_parsed)
                            : _repairAeLocalizedText(String(_resultStr || ''));
                        // 第 5 参 sessionId 传 null：结果写回该 lane 的当前会话（发起调用时未快照
                        // sessionId，跨会话场景由 lane 归属兜底；不把结果串进别的会话）。
                        var _injectRet = _inject.call(_injectHost, _title, { text: _vis.join('') },
                            { text: _detailText }, 'user', null, _laneId);
                        if (_injectRet && _injectRet.ok === false) {
                            console.warn('[AE Bootstrap] 渲染迟到回执回投未成功（lane=' + _laneId
                                + '，工具 ' + _toolLabel + '）：' + (_injectRet.reason || 'unknown'));
                        } else {
                            console.warn('[AE Bootstrap] 渲染迟到回执已回投 lane=' + _laneId + '（工具 '
                                + _toolLabel + '，' + (_isError ? '失败' : '成功') + '）');
                        }
                    } catch (_lateErr) {
                        // 投递绝不抛错回 CSInterface 回调链
                        try {
                            console.warn('[AE Bootstrap] 渲染迟到回执回投异常（已忽略）：'
                                + (_lateErr && _lateErr.message ? _lateErr.message : _lateErr));
                        } catch (_) {}
                    }
                };
                var _onEvalResult = function(raw) {
                    // 队头解除点——回执到达（**含面板已超时后的
                    // 迟到回执**）才放行队列。队头保持到 evalScript 回调，队列不得
                    // 「超时即放行队头」（否则后续 lane 的调用会被派发到仍在渲染的引擎上烧满
                    // executionTimeoutMs 并拿到错误归因）。
                    if (_taskSettle) _taskSettle();
                    if (_isRenderCall) { _renderInFlight = false; _renderInFlightOwner = null; _clearRenderInFlightWatchdog(); }
                    if (finished) {
                        // 回执在工具面已结算之后才到：两种来源——
                        //   ① 渲染异步受理（_renderSubmitted）：下发即回
                        //      submitted，这里把最终结果投回发起 lane；
                        //   ② 面板执行闸门超时（旧路径，外接来源/非异步受理）：结果迟到但
                        //      不能丢（ISSUE-02）。非渲染工具保持原行为（丢弃，行为不变）。
                        // 判据用收窄的 _renderAcceptsAsync（只读 renderQueue 的 authored 代码
                        // 不会被受理，也不会走到这里——它等真实回执即结算，见上方判据注释）。
                        // 外接来源（callerId 'ext:'）**不注入**：沿用 ComfyUI 外接来源不注入的
                        // 面板 Agent 不是这次调用的发起方，结果写进面板会话只会
                        // 污染对话并白唤醒一轮 LLM；外接客户端按调用超时自身处理。
                        if (_renderAcceptsAsync && !_isExtCaller) _deliverLateRenderReceipt(raw);
                        return;
                    }
                    finished = true;
                    _clearTimers();

                    var resultStr = _rawToResultStr(raw);
                    try {
                        var parsed = _parseEvalResultStr(resultStr);
                        var isError = _isToolErrorPayload(parsed);
                        // 错误回执与 success 载荷同口径修复——真机会话里 AE 异常被
                        // 工具脚本 catch 后拼进 success 返回串（"noTextDoc(Error: Êý×Ö…)"），
                        // 模型读到不可读文本。判据保证合法西文重音串不被改动（见
                        // _repairAeLocalizedText 注释）。
                        parsed = _repairAeLocalizedStrings(parsed);
                        // 成功结果的后处理（仅 postProcess 工具，目前是 getPreviewFrame 的多时间点）：
                        // 后处理失败按「工具已成功」处理——回退未处理结果，不报 isError。
                        if (!isError && postProcess) {
                            var _ppParsed = parsed;
                            Promise.resolve()
                                .then(function () { return postProcess(_ppParsed, args); })
                                .then(function (next) {
                                    resolve({
                                        success: true,
                                        isError: false,
                                        line: (_ppParsed && typeof _ppParsed.line === 'number') ? _ppParsed.line : undefined,
                                        content: [{ type: 'text', text: JSON.stringify((next && typeof next === 'object') ? next : _ppParsed) }]
                                    });
                                }, function (err) {
                                    try {
                                        console.warn('[AE Bootstrap] tool postProcess failed (' + (opts && opts.name) + '): ' + (err && err.message ? err.message : err));
                                    } catch (_) {}
                                    resolve({
                                        success: true,
                                        isError: false,
                                        line: (_ppParsed && typeof _ppParsed.line === 'number') ? _ppParsed.line : undefined,
                                        content: [{ type: 'text', text: JSON.stringify(_ppParsed) }]
                                    });
                                });
                            return;
                        }
                        resolve({
                            success: !isError,
                            isError: isError,
                            // 运行时错误行号（aeTools executeExtendScript 核 catch
                            // 透传的 e.line——{status} 协议字段级扩展；undefined 在
                            // 序列化时自然消失）
                            line: (parsed && typeof parsed.line === 'number') ? parsed.line : undefined,
                            // 错误正文出口：含 partial/recovery 等结构化诊断字段时整份 JSON
                            // 透出（pipeline 会 parse 回对象，LLM 才能看到「可能已部分执行」
                            // 与 undoLastOperation 回滚提示）；普通 {status,message} 仍是散文。
                            content: [{ type: 'text', text: isError ? _toolErrorContentText(parsed) : JSON.stringify(parsed) }]
                        });
                    } catch (_) {
                        // "EvalScript error." = 组装脚本在 ExtendScript 侧解析失败（语法错误），
                        // 必须报 isError，否则 LLM 误以为执行成功并在未生效的项目状态上叠加后续操作
                        var isEvalError = /EvalScript error/i.test(resultStr);
                        var _rawTrimmed = resultStr.trim();
                        // 工具代码未给全局 result 赋值时，ExtendScript 侧回传字面量 "undefined"
                        // （组装脚本末句刻意把它翻成字符串，供 view.js 的"无返回值"分支命中）。
                        // 它不是 JSON、也非解析错误：success 语义保持 true（AE 操作类工具本就可
                        // 以不返回值，判失败会让调用方重试并叠加重复操作），但正文改为可读说明
                        // ——把裸 "undefined" 当正文回传时，外接 MCP 客户端会显示成"成功但结果
                        // undefined"，无从区分"没返回值"与"真的拿到了 undefined"。
                        var _noResult = (_rawTrimmed === '' || _rawTrimmed === 'undefined');
                        resolve({
                            success: !isEvalError,
                            isError: isEvalError,
                            // 非空但非 JSON 的原始串(如 "EvalScript error.")原样透出
                            content: [{ type: 'text', text: isEvalError
                                ? (_repairAeLocalizedText(_rawTrimmed) || 'EvalScript error (empty response)')
                                : (_noResult ? '执行成功，未返回结果（工具代码未给 result 赋值）。'
                                    : _repairAeLocalizedText(resultStr)) }]
                        });
                    }
                };
                // ── 队列任务 ──────────────────────────────
                // 真正落到 AE 引擎的那一次调用。两条硬约束：
                //   ① 该 Promise **只在 evalScript 回执（含迟到回执）或同步抛错时结算**——
                //      面板侧超时**不结算它**，故队头保持到回执，队列不会「超时即放行队头」；
                //   ② 排队期间就超时的调用（用户已收到超时回执）**不再下发**：AE 侧不留副作用，
                //      任务空放行让队列交班（否则超时之后仍会真的执行一次操作）。
                var _taskSettle = null;
                var _taskSettled = false;
                var _task = function () {
                    return new Promise(function (settleTask) {
                        if (finished) { settleTask(); return; }
                        _taskSettle = function () {
                            if (_taskSettled) return;
                            _taskSettled = true;
                            if (_activeQueueSettle === _taskSettle) _activeQueueSettle = null;
                            if (_queueOccupant && _queueOccupant.token === _taskToken) _queueOccupant = null;
                            settleTask();
                        };
                        // 登记为「当前队头的交班函数」：6h 在途看门狗（AE 回执永不到达）要能放行队头，
                        // 否则其「宁可放行也不把渲染入口打死」的意图被队列抵消（实测复现）。
                        _activeQueueSettle = _taskSettle;
                        _queueOccupant = { token: _taskToken, laneId: _owner.laneId, name: _owner.name, external: _owner.external };
                        // ── 到位：等待段结束、执行段开始（两段预算）──────────────
                        // 先撤等待计时器，再起执行计时器；之后 queueOccupant 才成为「占有者」。
                        if (waitTimer) { clearTimeout(waitTimer); waitTimer = null; }
                        _dispatched = true;
                        execTimer = setTimeout(_onTimeout, timeoutMs);
                        // 渲染在途置位与占用者记账同址：拒绝/超时文案据此标明「谁在渲染」
                        if (_isRenderCall) { _renderInFlight = true; _renderInFlightOwner = _owner; }
                        try {
                            cs.evalScript(script, _onEvalResult);
                        } catch (e) {
                            // 同步异常：复位在途位、放行队头，并把失败透给**工具面** Promise
                            //（throw 只会拒绝队列任务，工具面必须显式 reject —— 原样抛出的
                            // 语义：调用方拿到的仍是 rejected promise）
                            if (_isRenderCall) { _renderInFlight = false; _renderInFlightOwner = null; _clearRenderInFlightWatchdog(); }
                            if (_taskSettle) _taskSettle();
                            // 同步抛错后工具面 reject 已定局：撤掉执行计时器并落 finished，
                            // 否则到点会再走一遍超时分支（多一条误导性警告）。
                            finished = true;
                            _clearTimers();
                            reject(e);
                        }
                        // ── 渲染类异步受理 ──────────────────────
                        // 渲染在 AE 侧是同步阻塞调用（60–70 s 起，长渲染可达分钟级），面板
                        // 执行闸门默认 30 s 必然先超时，调用方拿到「正在渲染/被占用」错误而
                        // 实际仍在渲染（真机：5 次 renderComp 全 error，其中 2 次成功只靠迟到
                        // 回执）。改为：下发即回执 submitted，完成/失败由迟到回执投回本 lane。
                        // 放在 evalScript 之后：同步抛错已在 catch 里 reject 且 finished=true，
                        // 受理分支自然跳过（不会出现「受理了却永远等不到回执」）。
                        // 外接调用方（HTTP 一次性响应、无迟到回执通道）保持原同步语义；
                        // 若回执同步到达（_onEvalResult 已结算），finished 亦为 true → 跳过。
                        // 判据用收窄的 _renderAcceptsAsync：只读 renderQueue 的 authored 代码
                        // （读模板名/读队列项/清理队列）不在这里被受理，照常等真实回执返回
                        // （见上方判据注释）。
                        if (_renderAcceptsAsync && !_isExtCaller && !finished) {
                            finished = true;
                            _renderSubmitted = true;
                            _clearTimers();
                            _armRenderInFlightWatchdog();
                            resolve({
                                success: true,
                                isError: false,
                                content: [{ type: 'text', text: JSON.stringify({
                                    status: 'submitted',
                                    tool: _toolLabel,
                                    message: '渲染已受理，正在 AE 后台执行。完成后会以系统消息回投本 lane'
                                        + '（含产物路径/大小/失败原因）；请勿重复提交同一渲染。'
                                        + '渲染期间其它 AE 调用会排队等待。'
                                }) }]
                            });
                        }
                    });
                };
                // 队列等待项的取消：停止 lane 时 orchestrator 会取消该 lane
                // **尚未下发**的调用。项被移走后 _onEvalResult 永远不会来——不在这里 reject，
                // 工具面就会挂到自身超时（用户点了停止却还要再等 30s 才拿到回执）。
                // 语义与队列契约一致：只在**未下发**（_task 尚未执行）时被调；队头不可取消。
                var _cancelBeforeDispatch = function (payload) {
                    if (finished) return;
                    finished = true;
                    _clearTimers();
                    _queueOccupant = null;
                    _activeQueueSettle = null;
                    var _cancelLane = (payload && payload.laneId) ? String(payload.laneId) : _laneId;
                    reject(new Error('AE 调用已取消：Agent「' + _laneNameOf(_cancelLane) + '」已停止，'
                        + '本次调用未下发（AE 未执行、工程未改动）。'));
                };
                // 队列模块（execQueue.js）由 scripts.manifest 排在 bootstrap.js 之前加载。
                // 队列**面板常开**（团队模式只是它的一个调用方，不再开关它）；
                // 模块缺席（单测直调 / 裁剪装配）时按直通执行——加载顺序不得成为失败点。
                // owner：展示归属（外接 → 'external'，其 laneId 仍是 'single'），队列据此把
                // 等待/占用文案写成「外接」而不是裸 id。
                var _queue = global.AEExecQueue;
                if (_queue && typeof _queue.run === 'function') {
                    _queue.run(_laneId, _toolLabel, _task, {
                        onCancel: _cancelBeforeDispatch,
                        owner: _isExtCaller ? 'external' : _laneId
                    });
                } else {
                    _task();
                }
            });
        };
    }

    // ── 注册 ──

    var _aeToolNames = {};

    // 预览帧目录 + 日志目录预建（getPreviewFrame 的调用前包装；清扫路径内也会调一次，
    // 见 _cleanAeToolsTemp）。日志目录（temp/logs）同理由面板预建：它是面板/bridge/
    // 宿主/hotbox 四方的共同落点，宿主与 hotbox 侧也会各自自建——谁先跑到谁建，
    // 任一方都不因目录缺失而静默丢日志。
    // 为什么必须由面板建：AE 侧建目录要过 `Folder.create`，而沙箱在未授权 file 域时把
    // 该方法换成抛错桩（aeTools.jsx 的 File/Folder 原型补丁 else 分支）——目录建不出来，
    // AE 的 saveFrameToPng 写向不存在的目录会**自己弹模态警告**并阻塞主线程（工具调用
    // 30s 超时、结果丢弃；实机）。面板侧走 AEFS（Node/cep.fs 直写，不经
    // ExtendScript 沙箱）建这三级目录，产物都落在数据目录内（受本模块 tempSweep 清扫）；
    // AE 侧候选目录都不可用时直接报错，不回退系统临时目录。
    // 幂等：目录已存在时跳过，无副作用；异常一律吞掉（预建失败不该阻断调用）。
    function ensurePreviewDir() {
        try {
            var dd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? (global.AEShared.getDataDir().dir || '') : '';
            if (!dd) return;
            var aefs = global.AEFS;
            if (!aefs || typeof aefs.mkdirSync !== 'function') return;
            var base = dd.replace(/[\\\/]+$/, '');
            var dirs = [base + '\\temp', base + '\\temp\\logs', base + '\\temp\\ae-tools'];
            for (var i = 0; i < dirs.length; i++) {
                if (typeof aefs.existsSync === 'function' && aefs.existsSync(dirs[i])) continue;
                aefs.mkdirSync(dirs[i]);
            }
        } catch (e) {
            console.warn('[AE Bootstrap] ensurePreviewDir failed: ' + (e && e.message ? e.message : e));
        }
    }

    function wrapWithPreviewDir(handler) {
        return function (args, ctx) {
            ensurePreviewDir();
            return handler(args, ctx);
        };
    }

    // 保留名兜底（模块级单一真源）：历史数据中若存在与元工具/内建撤回工具同名的定义，
    // 一律跳过注册，防止 hotReload 重注册时覆盖 createAETool/undoLastOperation 等
    //（saveTool/createAETool 现已拦截）。hotReload 计算「新集合」时同用此表——
    // 两处判据必须一致，否则保留名会因「在新集合里」而免于注销却又不被重新注册。
    var RESERVED_TOOL_NAMES = { createAETool: true, deleteAETool: true, undoLastOperation: true, shader_params: true };

    // 解析 AE 工具作用域：优先用工具显式保存的 scope 字段（支持 agent/script/shader 多模块并集）；
    // 缺失时向后兼容用 readOnly 推导（只读→全局，否则→agent），保证旧工具行为不变。
    function resolveAeScope(toolDef) {
        if (toolDef && toolDef.scope) return toolDef.scope;
        return (toolDef && toolDef.readOnly)
            ? { type: 'global' }
            : { type: 'module', moduleIds: ['agent'] };
    }

    // 外接短描述分叉：seed 的 description 给面板/内部 Agent；external-mcp
    // 投影取 externalDescriptions.js 的短版——客户端对 MCP 工具描述有 2048 字符硬顶，
    // 短版保证外接完整可见（参数级细节仍在 inputSchema，各客户端不截）。
    // 无短版的工具返回 null，注册表不挂 buildDescription。
    function buildAeExternalDescription(def) {
        var ext = global.AEExternalReadToolDescriptions;
        return (ext && typeof ext.build === 'function') ? ext.build(def) : null;
    }

    function registerToolsFromConfig(toolRegistry, toolsArray) {
        var registered = 0;
        var errors = [];
        _aeToolNames = {};
        // 保留名兜底见模块级 RESERVED_TOOL_NAMES（与 hotReload 计算新集合处共用一张表）
        for (var i = 0; i < toolsArray.length; i++) {
            var def = toolsArray[i];
            if (!def || !def.name) continue;
            // enabled 缺省按 true。手编 ae_tools.json 常漏该字段，falsy 判空会
            // 静默跳过且不计入 errors——UI 显示工具存在但 LLM 侧不可见
            if (def.enabled === false) continue;
            if (RESERVED_TOOL_NAMES[def.name]) {
                // 静默 continue 会让「JSON 里有、注册表里没有」成为无从解释的状态
                //（UI 列出该工具、LLM 侧却调不到）——留痕到 errors 供 UI/日志归因
                errors.push({ name: def.name, error: 'RESERVED_NAME' });
                continue;
            }

            var code;
            if (def.extendScript && typeof def.extendScript === 'string' && def.extendScript.trim()) {
                code = def.extendScript;
            } else {
                code = def.name + '(__args)';
            }

            var handler = createHandler(code, {
                name: def.name,
                wrapUndo: !def.readOnly,
                // executeExtendScript（authored 代码执行核）
                // 的撤销组入核——撤销组名经授权帧载荷传核内模板（shadow 外→undo 内→
                // 用户代码）；其余参数式工具保留 dispatcher 模板包裹（固定模板+转义
                // 参数=CI 铁律合法例外）
                undoInCore: def.name === 'executeExtendScript',
                // executeExtendScript 是 agent-tool 通道的注册执行端点
                //（pipeline 过 agent-tool 门后经 toolExecutor 分发至此）——bypass
                // ['agent-tool'] ON 时帧载荷三域全开在此读点（pipeline 无法
                // 经 opts 传参；仅 agent 管线可达——scope module:agent）
                bypassSource: def.name === 'executeExtendScript' ? 'agent-tool' : null,
                // executeExtendScript 撤销组名联动 action：用户 Ctrl+Z 时显示操作目的而非工具名
                getUndoName: (def.name === 'executeExtendScript')
                    ? function(args) { return args && typeof args.action === 'string' ? args.action : null; }
                    : null,
                // 多帧抓帧按 timesInSeconds 帧数抬升执行超时（见 previewBatchTimeoutMs）：
                // 全局「执行超时」默认 30s 撑不住 2–6 个时间点；单帧/其它工具仍按全局设置。
                timeoutMs: (def.name === 'getPreviewFrame' || def.name === 'analyzeImage')
                    ? previewBatchTimeoutMs : undefined,
                // 结果后处理（见 createHandler 头注释）：多时间点抓帧的 PNG 在面板侧拼成
                // 一张联系表；analyzeImage 在面板侧解码 PNG 并计算像素指标（AE 侧无 canvas）。
                // 模块未加载时置空——退化为多帧回执（filePath 指向第一帧）/无指标回执，
                // 不阻断工具本身。
                postProcess: (def.name === 'getPreviewFrame' && global.AEPreviewSheet
                    && typeof global.AEPreviewSheet.postProcessPreviewFrames === 'function')
                    ? global.AEPreviewSheet.postProcessPreviewFrames
                    : ((def.name === 'analyzeImage' && global.AEImageAnalysis
                        && typeof global.AEImageAnalysis.postProcessAnalyzeImage === 'function')
                        ? global.AEImageAnalysis.postProcessAnalyzeImage
                        : null)
            });
            // getPreviewFrame / analyzeImage：调用前预建预览帧目录（面板侧 AEFS 直写；AE 侧
            // 建不了，见 ensurePreviewDir 注释）。analyzeImage 的抓帧模式复用 getPreviewFrame
            // 落盘，同样需要目录先在位，否则 saveFrameToPng 写向不存在的目录会弹 AE 模态。
            if (def.name === 'getPreviewFrame' || def.name === 'analyzeImage') {
                handler = wrapWithPreviewDir(handler);
            }
            // queryEnvironment 的 availableEffects target 走缓存（app.effects 全量遍历会卡死 AE）：
            // 其余 target（installPath/renderQueue/sceneSummary）走普通 createHandler 调 jsx 函数。
            // getAvailableEffects 工具已删除，功能合并到 queryEnvironment。
            // 缓存包装来自 effectsCache.js 共享实现（controller 重新注册路径同用一份）。
            if (def.name === 'queryEnvironment' && global.AEEffectsCache && typeof global.AEEffectsCache.wrapQueryEnvironmentHandler === 'function') {
                handler = global.AEEffectsCache.wrapQueryEnvironmentHandler(handler);
            }

            var result = toolRegistry.register({
                name: def.name,
                description: def.description,
                buildDescription: buildAeExternalDescription(def),
                shortDescription: def.shortDescription || '',
                input_schema: def.input_schema || { type: 'object', properties: {} },
                handler: handler,
                scope: resolveAeScope(def),
                stub: def.stub !== undefined ? !!def.stub : !def.readOnly,
                // readOnly 是导演 lane 收窄的**唯一元数据判据**
                //（`source === 'ae-tools' && readOnly !== true` 即剔除），注册面必须写出**显式布尔**，
                // 否则缺字段（undefined）的工具会被一律当「非只读」误伤——用户自建的只读工具会在
                // 导演 lane 消失。取值 = 工具定义里的 readOnly；**缺失按写工具处理**（保守）：
                // seed 里缺该字段的五件都是有副作用工具（executeExtendScript / importFile /
                // replaceFootage / saveProject / renderComp——renderComp 尤其不能漏，它有 AE 副作用），
                // 纯查询类 seed（queryProject/queryDetails/queryEnvironment/listFolderFiles/getPreviewFrame）
                // 都显式带 readOnly:true。
                readOnly: def.readOnly === true,
                category: def.category || 'ae',
                source: 'ae-tools'
            });

            if (result && result.ok) {
                _aeToolNames[def.name] = true;
                registered++;
            } else {
                // 注册失败的名字必须从注册表移除：hotReload 不再无条件注销全部旧名
                //（见该函数内注释），残留会让「JSON 里已失效的定义」继续以旧定义在册——
                // 显式注销后失败语义：该名字不在册。
                if (typeof toolRegistry.unregister === 'function') {
                    toolRegistry.unregister(def.name);
                }
                errors.push({ name: def.name, error: result && result.error });
            }
        }
        console.log('[AE Bootstrap] ' + 'Registered ' + registered + ' AE tools' + (errors.length ? ', ' + errors.length + ' errors' : ''));
        return { ok: errors.length === 0, count: registered, errors: errors };
    }

    // ── 内建工具 shader_params（按 propertyIndex 读写 shader 参数）──
    // 存在理由：AE 的参数名是 cosmetic 字段（PF_UpdateParamUI 改的名字不随工程持久化，
    // 脚本读到的可能仍是注册态旧名），唯一稳定寻址是宿主 param-map 里记录的 propertyIndex。
    // 映射由 native 插件落盘（paramMap.cpp），解析住 shared/shaderParamMap.js（与
    // agent/engine/shaderTools.js 共用一份实现）。本工具不接受脚本代码——三段固定模板
    // 经 createHandler 通道下发（AST 门照过）；写操作走既有 Undo 包裹（wrapUndo）。
    // 槽位口径（native params.h）：propertyIndex = 5 + 4*slot + comp，
    // kIdxSlots=5 / kMaxParams=32 / kFloatsPerSlot=4 ⇒ 槽位分量索引 5..132（本工具只认这段）；
    // 其后是非槽位参数：133 画布、135..139 映射图层组、140 相机开关、142 起为灯光与重算控件。
    // 选中文件索引的真相源是隐藏原生参数 141（kIdxFileIndexParam）。
    var SHADER_SLOT_PROP_FIRST = 5;
    var SHADER_SLOT_PROP_LAST = 132;
    var SHADER_FILE_INDEX_PROP = 141;

    // 映射索引必须是整数且落在槽位区间：宿主只写 5 + 4*slot + comp（整数），
    // 非整数/越界即映射损坏或被篡改。不允许 Math.round 后照写——把 5.9 折成 6
    // 会把写入落到别人的参数上，且让注入字符串有机会变成合法索引。
    function isShaderPropIndex(n) {
        return Number.isInteger(n) && n >= SHADER_SLOT_PROP_FIRST && n <= SHADER_SLOT_PROP_LAST;
    }

    // 三段模板（内容为 ExtendScript ES3）：列实例/读值两段固定，只从 __args 读定位参数；
    // 写脚本由**面板侧校验过的数字**（库索引/参数索引/数值）生成数字字面量——目标索引必须
    // 与宿主映射逐字一致，且脚本里能直接看到写的是哪个索引。
    // effectIndex 的口径 = 该图层上 AS_Effect_Host 的 1 起序号（与工具参数一致），
    // 不是效果列的绝对下标。
    function buildShaderParamsScripts() {
        var first = SHADER_SLOT_PROP_FIRST;
        var last = SHADER_SLOT_PROP_LAST;
        var fileIdxProp = SHADER_FILE_INDEX_PROP;
        var compPrologue = 'var comp = null;\n' +
            '    if (__args.compId > 0) {\n' +
            '      comp = app.project.itemByID(__args.compId);\n' +
            '      if (!comp || !(comp instanceof CompItem)) {\n' +
            "        return { status: 'ok', compOk: false, reason: 'NO_COMP' };\n" +
            '      }\n' +
            '    } else {\n' +
            '      comp = app.project.activeItem;\n' +
            '      if (!comp || !(comp instanceof CompItem)) {\n' +
            "        return { status: 'ok', compOk: false, reason: 'NO_COMP' };\n" +
            '      }\n' +
            '    }\n';
        var effectPrologue = 'var ly = comp.layer(__args.layerIndex);\n' +
            "    if (!ly) return { status: 'ok', compOk: true, layerOk: false };\n" +
            "    var parade = ly.property('ADBE Effect Parade');\n" +
            "    if (!parade) return { status: 'ok', compOk: true, layerOk: true, effectOk: false };\n" +
            '    var want = __args.effectIndex;\n' +
            '    var fx = null;\n' +
            '    var ord = 0;\n' +
            '    for (var ei = 1; ei <= parade.numProperties; ei++) {\n' +
            '      var cand = parade.property(ei);\n' +
            "      if (!cand || cand.matchName !== 'AS_Effect_Host') continue;\n" +
            '      ord = ord + 1;\n' +
            '      if (ord === want) { fx = cand; break; }\n' +
            '    }\n' +
            "    if (!fx) return { status: 'ok', compOk: true, layerOk: true, effectOk: false };\n" +
            '    var fileIdx = -1;\n' +
            '    var fi = fx.property(' + fileIdxProp + ');\n' +
            '    if (fi) {\n' +
            '      var fv = fi.value;\n' +
            '      if (typeof fv === \'number\' && isFinite(fv)) fileIdx = Math.round(fv);\n' +
            '    }\n';

        // ① 列实例：合成里所有 matchName === 'AS_Effect_Host' 的效果（含 141 的值）。
        var enumScript = 'result = (function () {\n' +
            '  try {\n' +
            compPrologue +
            '    var list = [];\n' +
            '    for (var li = 1; li <= comp.numLayers; li++) {\n' +
            '      var layer = comp.layer(li);\n' +
            '      if (!layer) continue;\n' +
            "      var parade = layer.property('ADBE Effect Parade');\n" +
            '      if (!parade) continue;\n' +
            '      var ord = 0;\n' +
            '      for (var ei = 1; ei <= parade.numProperties; ei++) {\n' +
            '        var fx = parade.property(ei);\n' +
            "        if (!fx || fx.matchName !== 'AS_Effect_Host') continue;\n" +
            '        ord = ord + 1;\n' +
            '        var fileIdx = -1;\n' +
            '        var fi = fx.property(' + fileIdxProp + ');\n' +
            '        if (fi) {\n' +
            '          var fv = fi.value;\n' +
            '          if (typeof fv === \'number\' && isFinite(fv)) fileIdx = Math.round(fv);\n' +
            '        }\n' +
            '        list.push({\n' +
            '          layerIndex: li,\n' +
            '          layerName: String(layer.name),\n' +
            '          effectIndex: ord,\n' +
            '          effectName: String(fx.name),\n' +
            '          shaderIdx: fileIdx\n' +
            '        });\n' +
            '      }\n' +
            '    }\n' +
            '    return {\n' +
            "      status: 'ok', compOk: true,\n" +
            '      compId: comp.id, compName: String(comp.name),\n' +
            '      instances: list\n' +
            '    };\n' +
            '  } catch (e) {\n' +
            "    return { status: 'ok', compOk: false, reason: 'EXCEPTION', message: String(e) };\n" +
            '  }\n' +
            '})();\n';

        // ② 读该实例槽位分量当前值：vals[i] ↔ propertyIndex = first + i（5..132）。
        var readScript = 'result = (function () {\n' +
            '  try {\n' +
            compPrologue +
            effectPrologue +
            '    var vals = [];\n' +
            '    for (var j = ' + first + '; j <= ' + last + '; j++) {\n' +
            '      var one = null;\n' +
            '      try {\n' +
            '        var pr = fx.property(j);\n' +
            '        if (pr) {\n' +
            '          var raw = pr.value;\n' +
            "          if (typeof raw === 'number' && isFinite(raw)) one = raw;\n" +
            '        }\n' +
            '      } catch (e1) {\n' +
            '        one = null;\n' +
            '      }\n' +
            '      vals.push(one);\n' +
            '    }\n' +
            '    return {\n' +
            "      status: 'ok', compOk: true, layerOk: true, effectOk: true,\n" +
            '      fileIndex: fileIdx, values: vals\n' +
            '    };\n' +
            '  } catch (e) {\n' +
            "    return { status: 'ok', compOk: false, reason: 'EXCEPTION', message: String(e) };\n" +
            '  }\n' +
            '})();\n';

        // ③ 写一个分量：先核对 141（映射属于另一个 shader 时**不**回退按名写），
        // 再 setValue，读回确认；old 取写入前的值（回执要能说明改了什么）。
        // 三个数值由面板侧生成（库索引 / 参数索引 / 数值），**只接受校验过的整数/有限数**——
        // 写成数字字面量而不是从 __args 读：目标索引必须与宿主映射逐字对得上，
        // 也让脚本里能直接看到写的是哪个索引。
        // wrote：setValue 前 false、成功后 true。catch 一并回传——面板据此区分
        // 「已写入但回读失败」与「未写入」，不把已写入误报成未写入。
        function buildWriteScript(libraryIndex, propIndex, value) {
            var libIdx = Number(libraryIndex);
            var propIdx = Number(propIndex);
            var val = Number(value);
            if (!isFinite(libIdx) || !Number.isInteger(libIdx) || libIdx < 0) {
                throw new Error('shader_params: 库索引必须是非负整数 (' + String(libraryIndex) + ')');
            }
            if (!isFinite(val)) {
                throw new Error('shader_params: 写入参数必须是有限数值');
            }
            if (!isShaderPropIndex(propIdx)) {
                throw new Error('shader_params: 参数索引必须是 ' + SHADER_SLOT_PROP_FIRST + '..'
                    + SHADER_SLOT_PROP_LAST + ' 的整数 (' + String(propIndex) + ')');
            }
            return 'result = (function () {\n' +
                '  try {\n' +
                compPrologue +
                effectPrologue +
                '    var wrote = false;\n' +
                '    if (fileIdx !== ' + libIdx + ') {\n' +
                '      return {\n' +
                "        status: 'ok', compOk: true, layerOk: true, effectOk: true,\n" +
                '        fileIndexOk: false, fileIndex: fileIdx, wrote: false\n' +
                '      };\n' +
                '    }\n' +
                '    var prop = fx.property(' + propIdx + ');\n' +
                '    if (!prop) {\n' +
                '      return {\n' +
                "        status: 'ok', compOk: true, layerOk: true, effectOk: true,\n" +
                '        fileIndexOk: true, paramOk: false, wrote: false\n' +
                '      };\n' +
                '    }\n' +
                '    var oldVal = prop.value;\n' +
                "    if (typeof oldVal !== 'number' || !isFinite(oldVal)) oldVal = null;\n" +
                '    prop.setValue(' + val + ');\n' +
                '    wrote = true;\n' +
                '    var after = prop.value;\n' +
                "    if (typeof after !== 'number' || !isFinite(after)) after = null;\n" +
                '    return {\n' +
                "      status: 'ok', compOk: true, layerOk: true, effectOk: true,\n" +
                '      fileIndexOk: true, paramOk: true, old: oldVal, after: after, wrote: wrote\n' +
                '    };\n' +
                '  } catch (e) {\n' +
                "    return { status: 'ok', compOk: false, reason: 'EXCEPTION', message: String(e), wrote: wrote };\n" +
                '  }\n' +
                '})();\n';
        }

        return { enumerate: enumScript, read: readScript, buildWrite: buildWriteScript };
    }
    var SHADER_PARAMS_SCRIPTS = buildShaderParamsScripts();

    function shaderParamMapLib() {
        return global.AEShaderParamMap || null;
    }

    function shaderParamsDataRoot() {
        try {
            var dd = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir() : null;
            var dir = dd && dd.dir;
            return dir ? String(dir) : '';
        } catch (_) { return ''; }
    }

    // 统一回执：成功 = { success:true, isError:false, content:[{type:'text', text:JSON}] }
    // （与 createHandler 同信封，toolExecutor 原样透传 content）；错误同样带结构化 JSON。
    function shaderParamsOk(payload) {
        return { success: true, isError: false, content: [{ type: 'text', text: JSON.stringify(payload) }] };
    }
    function shaderParamsError(code, message, candidates) {
        var body = { status: 'error', code: code, message: message };
        if (candidates) body.candidates = candidates;
        return { success: false, isError: true, content: [{ type: 'text', text: JSON.stringify(body) }] };
    }

    // 调一次固定模板并解析回执 JSON。失败（AST 门拒绝/超时/非 JSON）→ { ok:false, message }。
    function shaderParamsCall(handler, args, ctx) {
        return Promise.resolve(handler(args || {}, ctx || {})).then(function (env) {
            var text = (env && env.content && env.content[0] && typeof env.content[0].text === 'string')
                ? env.content[0].text : '';
            if (!env || env.isError === true) return { ok: false, message: text || 'AE 侧执行失败' };
            try { return { ok: true, data: JSON.parse(text) }; }
            catch (_) { return { ok: false, message: text || 'AE 侧回执不是 JSON' }; }
        }, function (e) {
            return { ok: false, message: String(e && e.message ? e.message : e) };
        });
    }

    // 读宿主 param-map。文件缺失/损坏按同一个指引报（宿主只在载入/切换 shader 时落盘）。
    function readShaderParamsMap() {
        var lib = shaderParamMapLib();
        if (!lib) {
            return { code: 'NO_MAP', message: '共享模块未加载（shared/shaderParamMap.js）：无法解析宿主参数映射，请重开扩展面板。' };
        }
        var root = shaderParamsDataRoot();
        if (!root) return { code: 'NO_MAP', message: '数据目录不可用：读不到宿主参数映射。' };
        if (typeof AEFS === 'undefined' || !AEFS || typeof AEFS.readFileSync !== 'function') {
            return { code: 'NO_MAP', message: 'AEFS 不可用：读不到宿主参数映射。' };
        }
        var path = lib.paramMapPathFor(root);
        var text = null;
        try { text = AEFS.readFileSync(path, { quietNotFound: true }); } catch (_) { text = null; }
        var doc = lib.parseParamMapDoc(text);
        if (!doc) {
            return {
                code: 'NO_MAP',
                message: '宿主参数映射不存在或不可解析（' + path + '）：先在效果控件里选中一次该 shader 让宿主加载'
                    + '（或重新应用效果）后重试。'
            };
        }
        return { doc: doc, path: path };
    }

    // 读实例 shader 源文件：优先 entry.shaderPath（存在才读），否则回落
    // <数据根>\effects\<shaderName>.glsl。读不到返回 { text:null }（不阻断，回执标 stale:'unknown'）。
    function readShaderParamsSource(entry, root) {
        var path = (entry && entry.shaderPath) ? String(entry.shaderPath) : '';
        var fallback = '';
        if (entry && entry.shaderName) {
            fallback = String(root).replace(/[\\\/]+$/, '') + '\\effects\\' + String(entry.shaderName) + '.glsl';
        }
        var candidates = [];
        if (path) candidates.push(path);
        if (fallback && fallback !== path) candidates.push(fallback);
        for (var i = 0; i < candidates.length; i++) {
            var p = candidates[i];
            var exists = null;
            try {
                if (typeof AEFS !== 'undefined' && AEFS && typeof AEFS.existsSync === 'function') {
                    exists = AEFS.existsSync(p) === true;
                }
            } catch (_) { exists = false; }
            if (exists === false) continue;
            var t = null;
            try { t = AEFS.readFileSync(p, { quietNotFound: true }); } catch (_) { t = null; }
            if (typeof t === 'string') return { text: t, path: p };
        }
        return { text: null, path: path || fallback };
    }

    // 面板侧 handler：解析映射 → 固定模板列实例 → 解析目标实例 → list 读值 / set 写值。
    function createShaderParamsTool(inner) {
        function valueAt(uniform, comp, values, lib) {
            var idx = lib.propertyIndexOf(uniform, comp);
            // 非整数索引不拿去索引数组（映射损坏时按「无当前值」处理，不猜偏移）
            if (!isFinite(idx) || !Number.isInteger(idx)) return null;
            var off = idx - SHADER_SLOT_PROP_FIRST;
            if (off < 0 || off >= values.length) return null;
            var v = values[off];
            return (typeof v === 'number') ? v : null;
        }

        // enumData = 列实例脚本的回执（compId / compName 由枚举脚本采到，直接透传——
        // 调用方拿这个 id 回传 set 就能命中同一实例，不必依赖活动合成）。
        function listPayload(inst, entry, values, stale, lib, enumData) {
            var uniforms = entry.uniforms || [];
            var out = [];
            for (var i = 0; i < uniforms.length; i++) {
                var u = uniforms[i];
                var comps = lib.componentCount(u);
                var current = [];
                var c;
                for (c = 0; c < comps; c++) current.push(valueAt(u, c, values, lib));
                var def = null;
                if (u.hasDefault && u.default) {
                    if (comps <= 1) def = u.default[0];
                    else {
                        def = [];
                        for (c = 0; c < comps; c++) def.push(u.default[c]);
                    }
                }
                var range = null;
                if (u.range && isFinite(Number(u.range.min)) && isFinite(Number(u.range.max))) {
                    range = [Number(u.range.min), Number(u.range.max)];
                }
                out.push({
                    name: u.name,
                    type: u.type,
                    slot: u.slot,
                    propertyIndex: lib.propertyIndexOf(u, 0),
                    current: current,
                    default: def,
                    range: range
                });
            }
            return {
                status: 'ok',
                compId: (enumData && enumData.compId != null) ? enumData.compId : null,
                compName: (enumData && enumData.compName != null) ? String(enumData.compName) : '',
                shader: lib.baseName(entry.shaderPath) || (entry.shaderName ? entry.shaderName + '.glsl' : ''),
                shaderPath: entry.shaderPath || '',
                libraryIndex: (entry.libraryIndex == null) ? -1 : Number(entry.libraryIndex),
                layerIndex: inst.layerIndex,
                layerName: inst.layerName,
                effectIndex: inst.effectIndex,
                effectName: inst.effectName,
                stale: stale,
                uniforms: out
            };
        }

        function availableNames(uniforms, lib) {
            var names = [];
            for (var i = 0; i < uniforms.length; i++) {
                var u = uniforms[i];
                names.push(String(u.name));
                var comps = lib.componentCount(u);
                for (var c = 1; c < comps; c++) {
                    if (u.componentNames && u.componentNames[c]) names.push(String(u.componentNames[c]));
                }
            }
            return names;
        }

        return function (args, ctx) {
            args = args || {};
            var lib = shaderParamMapLib();
            var action = (args.action === 'list' || args.action === 'set') ? args.action : '';
            if (!action) {
                return Promise.resolve(shaderParamsError('BAD_ARGS', 'action 必须是 "list" 或 "set"。'));
            }
            if (!lib) {
                return Promise.resolve(shaderParamsError('NO_MAP',
                    '共享模块未加载（shared/shaderParamMap.js）：无法解析宿主参数映射，请重开扩展面板。'));
            }
            var wantName = (args.name == null) ? '' : String(args.name);
            if (action === 'set') {
                if (!wantName) {
                    return Promise.resolve(shaderParamsError('BAD_ARGS',
                        'action=set 需要 name（uniform 名或分量名，例如 uSpeed / uColor.g）。'));
                }
                if (typeof args.value !== 'number' || !Number.isFinite(args.value)) {
                    return Promise.resolve(shaderParamsError('BAD_ARGS',
                        'action=set 需要 number 类型的 value（当前收到的不是有限数值）。'));
                }
            }
            function optionalPosInt(v, label) {
                if (v === undefined || v === null || v === '') return { ok: true, value: 0 };
                var n = Number(v);
                if (!isFinite(n) || n !== Math.floor(n) || n < 1) {
                    return { ok: false, message: label + ' 必须是 1 起的整数。' };
                }
                return { ok: true, value: n };
            }
            var compIdArg = optionalPosInt(args.compId, 'compId');
            if (!compIdArg.ok) return Promise.resolve(shaderParamsError('BAD_ARGS', compIdArg.message));
            var layerArg = optionalPosInt(args.layerIndex, 'layerIndex');
            if (!layerArg.ok) return Promise.resolve(shaderParamsError('BAD_ARGS', layerArg.message));
            var effectArg = optionalPosInt(args.effectIndex, 'effectIndex');
            if (!effectArg.ok) return Promise.resolve(shaderParamsError('BAD_ARGS', effectArg.message));

            var map = readShaderParamsMap();
            if (!map.doc) return Promise.resolve(shaderParamsError(map.code, map.message));
            var root = shaderParamsDataRoot();
            var query = { compId: compIdArg.value };

            return shaderParamsCall(inner.enumerate, query, ctx).then(function (enumRes) {
                if (!enumRes.ok) {
                    return shaderParamsError('AE_ERROR', '列取 shader 实例失败：' + enumRes.message);
                }
                var data = enumRes.data || {};
                if (data.compOk === false) {
                    return shaderParamsError('NO_EFFECT',
                        '没有可用的合成：请先打开一个合成，或用 compId 指定。'
                            + (data.reason ? '（AE 侧原因：' + data.reason
                                + (data.message ? '：' + data.message : '') + '）' : ''));
                }
                var instances = data.instances || [];
                var matched = [];
                for (var i = 0; i < instances.length; i++) {
                    var inst = instances[i];
                    if (layerArg.value && Number(inst.layerIndex) !== layerArg.value) continue;
                    if (effectArg.value && Number(inst.effectIndex) !== effectArg.value) continue;
                    matched.push(inst);
                }
                if (!matched.length) {
                    return shaderParamsError('NO_EFFECT',
                        '指定的合成里没有匹配的 AS_Effect Host 实例'
                            + (instances.length ? '（该合成共有 ' + instances.length + ' 个实例，见 candidates）' : '')
                            + '：请给图层添加 AS_Effect Host 效果并在效果控件里选中 shader 文件。',
                        instances.length ? instances : undefined);
                }
                if (matched.length > 1) {
                    return shaderParamsError('MULTIPLE_EFFECTS',
                        '命中 ' + matched.length + ' 个 AS_Effect Host 实例：用 layerIndex / effectIndex 指定其中一个'
                            + '（effectIndex 是该图层上 AS_Effect Host 的 1 起序号）。',
                        matched);
                }
                var target = matched[0];
                var shaderIdx = Number(target.shaderIdx);
                if (!Number.isInteger(shaderIdx) || shaderIdx < 0) {
                    return shaderParamsError('NO_MAP',
                        '该实例没有选中 shader 文件（参数 141 = ' + String(target.shaderIdx) + '）：'
                            + '先在效果控件里选中一个 shader。');
                }
                var hits = lib.findEntriesByLibraryIndex(map.doc, shaderIdx);
                if (!hits.length) {
                    return shaderParamsError('NO_MAP',
                        '宿主参数映射里没有库索引 ' + shaderIdx + ' 的条目：先在效果控件里选中一次该 shader '
                            + '让宿主加载（或重新应用效果）后重试。');
                }
                if (hits.length > 1) {
                    var cands = [];
                    for (var h = 0; h < hits.length; h++) {
                        cands.push({
                            shaderPath: hits[h].entry.shaderPath,
                            shaderName: hits[h].entry.shaderName,
                            libraryIndex: hits[h].entry.libraryIndex,
                            key: hits[h].key
                        });
                    }
                    return shaderParamsError('AMBIGUOUS',
                        '库索引 ' + shaderIdx + ' 在宿主映射里对应多份 shader 记录：重选一次该 shader 让宿主刷新映射后重试。',
                        cands);
                }
                var entry = hits[0].entry;
                // 映射条目的库索引同样只接受整数（宿主只写整数；非整数 = 损坏/注入）。
                // 之后所有寻址与回执文案都用这个校验过的值。
                var entryLibIdx = Number(entry.libraryIndex);
                if (!Number.isInteger(entryLibIdx) || entryLibIdx < 0) {
                    return shaderParamsError('NO_MAP',
                        '宿主映射里的库索引非法（' + String(entry.libraryIndex)
                            + '）：映射可能已损坏，请重选一次该 shader 后重试。');
                }
                var src = readShaderParamsSource(entry, root);
                var stale = 'unknown';
                var sig = entry.signature;
                if (typeof src.text === 'string' && sig && sig.hash) {
                    stale = (lib.hashUtf8(src.text) === String(sig.hash)) ? 'fresh' : 'stale';
                }
                if (stale === 'stale') {
                    return shaderParamsError('STALE_MAP',
                        '宿主参数映射已过期（' + src.path + ' 的当前内容与宿主记录不一致）：'
                            + '重选一次该 shader（或重新应用效果）让宿主刷新映射后重试。');
                }
                var instQuery = {
                    compId: compIdArg.value,
                    layerIndex: target.layerIndex,
                    effectIndex: target.effectIndex
                };

                if (action === 'list') {
                    return shaderParamsCall(inner.read, instQuery, ctx).then(function (readRes) {
                        if (!readRes.ok) {
                            return shaderParamsError('AE_ERROR', '读取参数值失败：' + readRes.message);
                        }
                        var rd = readRes.data || {};
                        if (rd.compOk === false || rd.layerOk === false || rd.effectOk === false) {
                            return shaderParamsError('NO_EFFECT',
                                '读取时该图层或效果已不可用（实例可能已被删除）：请重新调用 list 取最新实例。');
                        }
                        if (Number(rd.fileIndex) !== entryLibIdx) {
                            return shaderParamsError('FILE_INDEX_MISMATCH',
                                '实例当前选中的库索引（' + rd.fileIndex + '）与映射条目（' + entryLibIdx
                                    + '）不一致：映射已过期，请重选一次该 shader 后重试。');
                        }
                        return shaderParamsOk(listPayload(target, entry, rd.values || [], stale, lib, data));
                    });
                }

                var uniforms = entry.uniforms || [];
                var uniform = null;
                var compIdx = -1;
                for (var ui = 0; ui < uniforms.length; ui++) {
                    var ci = lib.componentIndexForName(uniforms[ui], wantName);
                    if (ci >= 0) { uniform = uniforms[ui]; compIdx = ci; break; }
                }
                if (!uniform) {
                    return shaderParamsError('NO_PARAM',
                        '该 shader 没有名为 ' + wantName + ' 的参数：可用名字见 candidates。',
                        availableNames(uniforms, lib));
                }
                var propIndex = lib.propertyIndexOf(uniform, compIdx);
                // 越界/非整数一律按映射损坏拒绝：不做 Math.round 后照写（那会把注入值
                // 折成合法索引，写到别的参数上）。
                if (!isShaderPropIndex(propIndex)) {
                    return shaderParamsError('NO_MAP',
                        '宿主映射里的参数索引不是 ' + SHADER_SLOT_PROP_FIRST + '..' + SHADER_SLOT_PROP_LAST
                            + ' 的整数（' + String(propIndex) + '）：映射可能已损坏，请重选一次该 shader 后重试。');
                }
                // 写脚本按本次目标生成（库索引/参数索引/数值都写成数字字面量），仍走
                // createHandler 固定通道；写操作由既有 Undo 包裹（wrapUndo）。
                var writeHandler = null;
                try {
                    writeHandler = createHandler(
                        SHADER_PARAMS_SCRIPTS.buildWrite(entryLibIdx, propIndex, args.value),
                        { name: 'shader_params', wrapUndo: true }
                    );
                } catch (eBuild) {
                    return shaderParamsError('BAD_ARGS', '无法生成写入脚本：' + String(eBuild && eBuild.message ? eBuild.message : eBuild));
                }
                var writeArgs = {
                    compId: compIdArg.value,
                    layerIndex: target.layerIndex,
                    effectIndex: target.effectIndex
                };
                return shaderParamsCall(writeHandler, writeArgs, ctx).then(function (writeRes) {
                    if (!writeRes.ok) {
                        return shaderParamsError('AE_ERROR', '写入参数失败：' + writeRes.message);
                    }
                    var wd = writeRes.data || {};
                    // 写入阶段归因：wrote=true 表示 setValue 已执行（脚本 catch 回传）。
                    // 此时失败属于「回读失败」，不能报成未写入——按回执让用户核对数值。
                    if (wd.wrote === true && wd.compOk === false) {
                        return shaderParamsError('AE_ERROR',
                            '值已写入但回读失败，请核对效果控件数值。'
                                + (wd.message ? '（AE 侧原因：' + wd.message + '）' : ''));
                    }
                    if (wd.compOk === false || wd.layerOk === false || wd.effectOk === false) {
                        return shaderParamsError('NO_EFFECT',
                            '写入时该图层或效果已不可用（实例可能已被删除）：未写入，请重新调用 list 取最新实例。');
                    }
                    if (wd.fileIndexOk === false) {
                        return shaderParamsError('FILE_INDEX_MISMATCH',
                            '实例当前选中的库索引（' + wd.fileIndex + '）与映射条目（' + entryLibIdx
                                + '）不一致：本次未写入，请重选一次该 shader 让宿主刷新映射后重试。');
                    }
                    if (wd.paramOk === false) {
                        return shaderParamsError('NO_PARAM',
                            'AE 里没有索引 ' + propIndex + ' 的参数：本次未写入。');
                    }
                    var oldVal = (typeof wd.old === 'number') ? wd.old : null;
                    var newVal = (typeof wd.after === 'number') ? wd.after : null;
                    return shaderParamsOk({
                        status: 'ok',
                        name: wantName,
                        changed: (oldVal === null || newVal === null) ? false : (oldVal !== newVal),
                        old: oldVal,
                        new: newVal,
                        propertyIndex: propIndex
                    });
                });
            });
        };
    }

    // 只读两段（列实例 / 读值）在注册时建一次；写脚本按本次目标生成（见 set 分支）。
    function createShaderParamsHandlers() {
        return {
            enumerate: createHandler(SHADER_PARAMS_SCRIPTS.enumerate, { name: 'shader_params:enum' }),
            read: createHandler(SHADER_PARAMS_SCRIPTS.read, { name: 'shader_params:read' })
        };
    }

    // ── 初始化 ──

    async function initAETools(config) {
        var toolRegistry = config.toolRegistry;
        if (!toolRegistry) return { ok: false, error: 'MISSING_TOOL_REGISTRY' };

        // 「执行超时」补读：window.AE_LLM._aeToolTimeoutMs 只由
        // Agent 模块视图 init 赋值——面板重载后停在立方体首页（Agent 未挂载）时它为空，
        // 本文件的超时解析（见下方 createHandler 的 timeoutMs 段）就此回落 30s 默认，
        // 用户设的 120s 失效（真机复现：CDP Page.reload 后 +6…+38s 连续五次皆空、
        // AEAgentApp.debugLog 同步缺席，而 _aeToolsReady 为 true）。
        // 工具注册在面板启动必经路径上、且贴近消费点，故在这里从同一设置仓库补读一次；
        // settingsStore 按仓库既有约定由启动方注入（各模块不直接持有）。取值口径与 agent
        // 侧写入一致（>=3000ms 才认）；已是数值则不覆盖（会话内用户改过设置以最新值为准）。
        try {
            var _store = config.settingsStore;
            if (_store && typeof _store.getModuleSettings === 'function'
                && !(global.AE_LLM && typeof global.AE_LLM._aeToolTimeoutMs === 'number')) {
                var _agentSettings = await _store.getModuleSettings('agent', {});
                var _ms = Number(_agentSettings && _agentSettings.executionTimeoutMs);
                if (_ms >= 3000) {
                    global.AE_LLM = global.AE_LLM || {};
                    global.AE_LLM._aeToolTimeoutMs = _ms;
                    console.log('[AE Bootstrap] 执行超时取自模块设置: ' + _ms + 'ms');
                }
            }
        } catch (e) {
            // 读不到不是错误（调用端本来就回落 30s）；但如果连设置都不敢信，要留下痕迹
            console.warn('[AE Bootstrap] 执行超时读取失败（回落默认 30s）: ' + (e && e.message));
        }

        // 启动即清扫 + 裁保留池（temp/ae-tools 的 ae_preview_*.png，fire-and-forget）。
        // 面板 Agent 抓的预览帧**读完不删**（Agent 可能复读同一张图），
        // 由视觉 hook 每次读完把池裁到最新 30 张；此处兜底清理「中途停止/崩溃/异常退出」残留的
        // 孤儿、超龄（7 天）文件与超限堆积。预览帧无任何会话引用（消费方读的是注入后的 data URL）。
        // 小时周期：若启动那一刻数据目录尚未
        // 就绪（getDataDir 返回空目录则函数直接 return），整个会话就再也不会清扫；
        // agent 侧那套有 30 分钟周期，ae-tools 侧没有，是孤儿能留到 8 月的候选原因之一。
        _cleanAeToolsTemp().catch(function () {});
        if (!_aeSweepTimer) {
            _aeSweepTimer = setInterval(function () {
                _cleanAeToolsTemp().catch(function () {});
            }, 60 * 60 * 1000);
        }

        // ① 注入库函数到 AE
        var injectResult = await injectToolsCode();
        if (!injectResult.ok) {
            console.warn('[AE Bootstrap] ' + 'Warning: tools code injection failed: ' + injectResult.error);
        }

        // ①b 扫描 aeTools.jsx 库函数（供面板「库函数浏览器」查询——controller.searchAeFunctions；
        //     LLM 侧无对应工具）
        try {
            var _jsxPath = getJsxPath();
            if (_jsxPath) {
                var jsxSource = await AEFS.readFile(_jsxPath);
                if (jsxSource && global.AE_LLM && typeof global.AE_LLM.scanAeFunctions === 'function') {
                    global.AE_LLM._aeFunctions = global.AE_LLM.scanAeFunctions(jsxSource);
                    console.log('[AE Bootstrap] Scanned ' + global.AE_LLM._aeFunctions.length + ' library functions');
                }
            }
        } catch (e) {
            console.warn('[AE Bootstrap] Failed to scan library functions: ' + e);
        }

        // ② 加载工具定义（连顶层 migrations 标记一起读回，供 seed 合并的一次性迁移判定）
        var toolsArray = null;
        var toolsFile = null;
        var jsonPath = getJsonPath();
        if (jsonPath) {
            toolsFile = await loadToolsFile(jsonPath);
            toolsArray = toolsFile ? toolsFile.tools : null;
        }
        // 仅空数组（如用户删光了全部工具）是合法状态：继续走 seed 合并/注册流程，
        // 否则安全闸门永不升旗，整个 AE 工具模块（含 createAETool）会瘫痪到手动改 json
        if (!toolsArray) {
            console.warn('[AE Bootstrap] ' + 'No ae_tools.json found at: ' + jsonPath);
            return { ok: false, error: 'NO_TOOLS_JSON' };
        }

        console.log('[AE Bootstrap] ' + 'Loaded ' + toolsArray.length + ' tool defs from ' + jsonPath);

        // ②b 合并 seed 新增工具：按 name 比对，只追加数据目录里缺失的，已存在的一律不动。
        // 保护用户修改/禁用/LLM 创建的同名工具；用户删除的 seed 工具会被重新追加（seed 作为开发者预置基线）。
        // seed 读取失败静默跳过，不影响主流程。
        try {
            var seedTools = await loadSeedTools();
            if (seedTools && seedTools.length) {
                var merged = mergeSeedTools(toolsArray, seedTools, toolsFile ? toolsFile.migrations : null);
                if (merged.added > 0) {
                    console.log('[AE Bootstrap] ' + 'Merged ' + merged.added + ' new tool(s) from seed');
                }
                if (merged.added > 0 || merged.patched > 0 || merged.migrationsDirty) {
                    toolsArray = merged.tools;
                    // 有新增/补字段/迁移标记落定才写回数据目录（含一次性 external-mcp 迁移与
                    // 其 migrations 标记——无补齐但迁移"适用"时也要写一次标记，见 mergeSeedTools
                    // 循环后的标记落定段：不写回则标记永远上膛，用户之后的显式排除会被重新合并进来）
                    if (global.AE_LLM._aeSaveJson) {
                        await global.AE_LLM._aeSaveJson(jsonPath, toolsArray, merged.migrations);
                    }
                }
            }
        } catch (e) {
            console.warn('[AE Bootstrap] mergeSeedTools error: ' + e);
        }

        global.AE_LLM._aeToolsData = toolsArray;
        global.AE_LLM._aeToolsJsonPath = jsonPath;

        var regResult = registerToolsFromConfig(toolRegistry, toolsArray);

        // 内建撤回工具：面板侧直接注册，不进 ae_tools.json。理由：
        // ① seed 逐文件跳过已存在文件，已有安装的数据目录 json 拿不到新增工具；
        // ② 用户可能在 AE Tools UI 误删它；③ hotReload 只重注册 _aeToolNames 里的工具，内建工具天然幸存。
        // handler 复用 createHandler 通道；不传 wrapUndo —— 撤销操作自身不应再产生撤销组。
        var undoReg = toolRegistry.register({
            name: 'undoLastOperation',
            description: '撤销 After Effects 撤销栈中的最近一次操作（等效 Ctrl+Z）。注意：撤销栈是全局的，最近一次操作可能是本 Agent 的工具调用，也可能是用户自己的手动操作。仅在以下情况使用：① 发现自己刚执行的操作有误、需要立即自我纠正；② 用户明确要求撤销。若用户在 Agent 操作之后手动做过修改，本工具会回退用户的工作--不确定时应先询问用户确认。',
            shortDescription: '撤销最近一次操作',
            input_schema: { type: 'object', properties: {} },
            handler: createHandler('result = undoLastOperation(__args);'),
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: false,
            // 内建撤回工具是**写**工具——它改的是 AE 的撤销栈
            //（撤销一次操作 = 项目状态回退）。取 true 与「有副作用 ⇒ false」
            // 的判据冲突，且**显式重操作名单**本就含它（显式名单优先，收窄结果不变）；
            // 故此处按语义取 false，登记为偏离。
            readOnly: false,
            category: 'utility',
            source: 'ae-tools'
        });
        if (!undoReg || !undoReg.ok) {
            console.warn('[AE Bootstrap] undoLastOperation 内建工具注册失败: ' + (undoReg && undoReg.error));
        }

        // 内建 shader 参数工具：AE 参数名是 cosmetic（脚本读到的可能是注册态旧名），
        // 故读写都按宿主 param-map 的 propertyIndex 寻址。同属面板侧内建（不进 ae_tools.json）。
        // scope 显式含 external-mcp（开放外接，外接设置页归 Agent 引擎组）——
        // extTools.scopeAllowsExternal 要求 module 作用域显式收录它，否则投影与直调双拒。
        // lane 收窄仍按 readOnly !== true（导演 lane 剔除）；exec lane 的并联身份 ['agent','team']
        // 含 agent，故 ae-exec 可见。
        // readOnly=false 为**工具级**标记（同一工具可写）；list 分支内部不带 Undo 包裹
        // （inner.read 是独立 createHandler，未传 wrapUndo），只有 set 走撤销组。
        var shaderParamsReg = toolRegistry.register({
            name: 'shader_params',
            description: '读取或写入 AS_Effect Host 实例的 shader 参数。action=list 返回该实例的参数清单：'
                + '每个 uniform 的名字、类型、槽位、AE 参数索引、当前值、默认值、范围；'
                + 'action=set 按名字写一个参数值，内部按宿主参数映射的 propertyIndex 写入，不依赖 AE 参数显示名。'
                + '不传 compId 时用当前活动合成；不传 layerIndex/effectIndex 时唯一命中自动选中，多个命中返回候选'
                + '（含 layerIndex/layerName/effectIndex/shaderIdx）供重试。effectIndex 是该图层上 AS_Effect Host '
                + '实例的 1 起序号；参数名可用 uniform 名（如 uSpeed）或分量名（如 uColor.g）。不接受脚本代码。',
            shortDescription: '读 shader 参数清单 / 按名字写一个参数值',
            input_schema: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'set'],
                        description: 'list = 读当前实例的参数清单；set = 写一个参数值'
                    },
                    name: {
                        type: 'string',
                        description: 'set 必填：uniform 名或分量名，如 uSpeed、uColor.g'
                    },
                    value: {
                        type: 'number',
                        description: 'set 必填：要写入的数值'
                    },
                    compId: {
                        type: 'number',
                        description: '可选：目标合成 id；不传时用当前活动合成'
                    },
                    layerIndex: {
                        type: 'number',
                        description: '可选：目标图层序号（1 起）'
                    },
                    effectIndex: {
                        type: 'number',
                        description: '可选：该图层上 AS_Effect Host 实例的序号（1 起）'
                    }
                },
                required: ['action']
            },
            handler: createShaderParamsTool(createShaderParamsHandlers()),
            scope: { type: 'module', moduleIds: ['agent', 'external-mcp'] },
            stub: false,
            readOnly: false,
            category: 'effect',
            source: 'ae-tools'
        });
        if (!shaderParamsReg || !shaderParamsReg.ok) {
            console.warn('[AE Bootstrap] shader_params 内建工具注册失败: ' + (shaderParamsReg && shaderParamsReg.error));
        }

        // 安全闸门：工具注册完成后升旗。所有 AE 工具调用 (路径③④) 必须先查此旗。
        window.AE_LLM._aeToolsReady = true;
        console.log('[AE Bootstrap] AE tools ready - safety gate raised');

        // 注册 createAETool + deleteAETool 工具（Agent 模块专属）
        // 放在安全闸门之后：创建工具的前提是 AE 工具系统已就绪
        if (global.AE_LLM && typeof global.AE_LLM.createAEToolCreator === 'function') {
            var aeToolCreator = global.AE_LLM.createAEToolCreator({ toolRegistry: toolRegistry });
            global.AE_LLM.aeToolCreator = aeToolCreator;
            aeToolCreator.registerTool(toolRegistry);
            aeToolCreator.registerDeleteTool(toolRegistry);
            console.log('[AE Bootstrap] createAETool + deleteAETool tools registered (agent-only)');
        }

        return regResult;
    }

    // ── 热重载 ──

    // 外接清单同步：自定义工具的新增/删除/改名都改变了对外工具集，须推送
    // tools/list_changed（可见性变更 → tools/list 必须跟随）。
    // 两条注册路径各接一处：本文件的 hotReload（LLM 的 createAETool/deleteAETool 都汇流至此）
    // 与 controller 的三个公开写入口（UI 增删改；那条路径刻意不走 hotReload）。
    // 异常隔离：外接模块未加载/未连接/通知抛错都不得影响工具热重载主流程。
    function notifyExternalToolsChanged() {
        try {
            var bc = global.AEExternal && global.AEExternal.bridgeClient;
            if (bc && typeof bc.notifyToolsChanged === 'function') bc.notifyToolsChanged();
        } catch (e) {
            console.warn('[AE Bootstrap] 外接清单通知失败: ' + e);
        }
    }

    async function hotReload(toolRegistry, toolsArray) {
        if (!toolRegistry || !toolsArray) return { ok: false, error: 'MISSING_PARAMS' };

        // 先存盘，成功后再注销+重注册：保存失败时注册表保持原状，
        // 避免一次写盘失败导致所有 AE 工具从注册表丢失（直至面板重启）。
        // 动态取当前 json 路径：数据目录支持运行时切换，_aeToolsJsonPath 是 init 时的静态快照
        var jsonPath = (global.AE_LLM && typeof global.AE_LLM._aeToolsJsonPathFn === 'function')
            ? global.AE_LLM._aeToolsJsonPathFn() : global.AE_LLM._aeToolsJsonPath;
        // jsonPath 为空（getDataDir 初始化竞态返回空串）与 SAVE_FAILED 同等对待：
        // 静默跳过会只改内存并照常重注册、返回成功，重启后全部丢失且无任何提示
        if (!jsonPath) {
            console.warn('[AE Bootstrap] ' + 'Hot reload save failed: tools json path is empty');
            return { ok: false, error: 'SAVE_FAILED: tools json path is empty' };
        }
        try {
            await saveToolsToJson(jsonPath, toolsArray);
        } catch (e) {
            // 保存失败必须返回错误，否则调用方会以为已持久化，重启后工具丢失
            console.warn('[AE Bootstrap] ' + 'Hot reload save failed: ' + e);
            return { ok: false, error: 'SAVE_FAILED: ' + e };
        }

        // 只注销「新集合中已不存在」的名字（register 按名字覆盖，同名无需先注销）。
        // 早期实现是无条件注销全部旧名再重注册：保留下来的工具会被挪到注册表键序末尾，
        // 而 getLlmToolStubs 按 Object.keys 输出 → tools 数组顺序漂移 → 该轮请求体从首个
        // token 起与历史不同，整段前缀缓存失效。
        // 判据与 registerToolsFromConfig 的跳过条件保持一致：无名/空名、enabled===false、
        // 保留名都不进新集合——否则它们会因「在新集合里」而免于注销，实际却没重新注册。
        var nextNames = {};
        for (var n = 0; n < toolsArray.length; n++) {
            var nd = toolsArray[n];
            if (!nd || !nd.name) continue;
            if (nd.enabled === false) continue;
            if (RESERVED_TOOL_NAMES[nd.name]) continue;
            nextNames[nd.name] = true;
        }
        // 此处与 registerToolsFromConfig 之间无 await，不存在并发调用看到工具缺席的窗口。
        var aeNames = Object.keys(_aeToolNames);
        for (var i = 0; i < aeNames.length; i++) {
            if (!nextNames[aeNames[i]]) toolRegistry.unregister(aeNames[i]);
        }

        global.AE_LLM._aeToolsData = toolsArray;
        try {
            // registerToolsFromConfig 的 errors 只表示个别工具校验失败，注册表已改变，
            // 故通知无条件发出（幂等的「请重拉清单」）
            return registerToolsFromConfig(toolRegistry, toolsArray);
        } finally {
            // 放 finally 而非正常返回路径：重注册中途抛异常（如 createHandler 抛）时注册表
            // 也可能已被改动——上方 unregister 循环已执行，客户端不能停在过期清单上
            notifyExternalToolsChanged();
        }
    }

    // ── 开发用：从 aeTools.jsx 源码重载 ──

    async function reloadFromSource(config) {
        var toolRegistry = config && config.toolRegistry;
        if (!toolRegistry) {
            toolRegistry = global.AE_LLM && global.AE_LLM.toolRegistry;
        }
        if (!toolRegistry) return { ok: false, error: 'MISSING_TOOL_REGISTRY' };

        var jsxPath = getJsxPath();
        if (!jsxPath) return { ok: false, error: 'CANNOT_RESOLVE_JSX_PATH' };

        var raw = await AEFS.readFile(jsxPath);
        if (!raw) {
            return { ok: false, error: 'READ_JSX_FAILED' };
        }

        var code = raw + '\n(typeof getProjectInfo==="function"?"MCP_LOADED":"MCP_LOAD_FAILED")';
        var injectResult = await injectCodeToAE(code);
        if (!injectResult.ok) {
            return { ok: false, error: 'INJECT_FAILED: ' + injectResult.error };
        }

        // 重新扫描库函数（源码可能已变更）
        if (global.AE_LLM && typeof global.AE_LLM.scanAeFunctions === 'function') {
            global.AE_LLM._aeFunctions = global.AE_LLM.scanAeFunctions(raw);
            console.log('[AE Bootstrap] Re-scanned ' + global.AE_LLM._aeFunctions.length + ' library functions');
        }

        console.log('[AE Bootstrap] ' + 'Reload from source complete');
        return { ok: true };
    }

    // ── JSON 文件读写 ──

    // 读取数据目录 JSON 全量：{ tools, migrations }。migrations 是 mergeSeedTools 落下的一次性
    // 迁移标记（顶层对象，缺失 → {}）。工具数据与标记必须一起读回：只读 tools 会让每次启动
    // 都把已完成的迁移当未执行（轻则重复扫描，重则重写用户文件、覆盖用户之后的显式改动）。
    async function loadToolsFile(filePath) {
        try {
            var raw = await AEFS.readFile(filePath);
            if (!raw) return null;
            var data = JSON.parse(raw);
            // data.tools 为空数组时是合法状态（用户删光全部工具），不能走 || 回退到整个对象
            var tools = Array.isArray(data.tools) ? data.tools : data;
            if (!Array.isArray(tools)) return null;
            var migrations = (data && !Array.isArray(data) && data.migrations
                && typeof data.migrations === 'object') ? data.migrations : {};
            return { tools: tools, migrations: migrations };
        } catch (e) {
            console.warn('[AE Bootstrap] loadToolsFile error: ' + e);
            return null;
        }
    }

    async function loadToolsFromJson(filePath) {
        var file = await loadToolsFile(filePath);
        return file ? file.tools : null;
    }

    // 读取 seed 的 ae_tools.json（用于启动时合并新增工具到数据目录）
    // seed 是开发者预置基线，数据目录是用户实际状态。合并只追加缺失，不覆盖已存在。
    async function loadSeedTools() {
        try {
            var extRoot = (typeof window !== 'undefined' && window.__ext_root) || '';
            if (!extRoot) return null;
            var seedPath = extRoot.replace(/\\/g, '/') + '/client/seed/ae-tools/ae_tools.json';
            var raw = await AEFS.readFile(seedPath);
            if (!raw) return null;
            var data = JSON.parse(raw);
            // 与 loadToolsFromJson 同款：空数组是合法状态，不走 || 回退
            var tools = Array.isArray(data.tools) ? data.tools : data;
            return Array.isArray(tools) ? tools : null;
        } catch (e) {
            console.warn('[AE Bootstrap] loadSeedTools error: ' + e);
            return null;
        }
    }

    // 按 name 比对，把 seed 里有但 localTools 里没有的工具追加进去。
    // 已存在的不覆盖用户已修改的字段——保护用户修改/禁用/LLM 创建的同名工具，
    // 但会补充其缺失的字段（shortDescription、stub === undefined 时从 seed 补）。
    // 例外：description 以 seed 为准（见循环内注释）。
    // migrations（可选，顶层迁移标记对象，读写同一引用）：一到两次性迁移的标记载体——
    // external-mcp 作用域成员补齐、写工具 script 成员移除（各见循环内注释）。标记在
    // 「迁移适用」时落定，不要求本次真的改过字段；落定后由 initAETools 凭返回的
    // migrationsDirty 连同 tools 写回数据文件（无字段改动也写一次标记，见循环后标记落定段）。
    function mergeSeedTools(localTools, seedTools, migrations) {
        var mig = (migrations && typeof migrations === 'object') ? migrations : {};
        var existing = {};
        for (var i = 0; i < localTools.length; i++) {
            if (localTools[i] && localTools[i].name) {
                existing[localTools[i].name] = localTools[i];
            }
        }
        var added = [];
        var patched = 0;
        var migratedMembers = 0;
        var migratedScriptMembers = 0;
        // seed 是否声明了 external-mcp 成员 / 不含 script 的条目：两次一次性迁移的标记落定判据
        var seedDeclaresExternal = false;
        var seedDeclaresScriptFree = false;
        for (var j = 0; j < seedTools.length; j++) {
            var t = seedTools[j];
            if (t && t.name && !existing[t.name]) {
                added.push(t);
            } else if (t && t.name && existing[t.name]) {
                // 补充已有工具缺失的新增字段（如 shortDescription），不覆盖用户已修改的字段
                if (t.shortDescription && !existing[t.name].shortDescription) {
                    existing[t.name].shortDescription = t.shortDescription;
                    patched++;
                }
                // stub 字段：仅当现有工具未显式设置 stub（undefined）且 seed 显式指定时补充。
                // 用 === undefined 判断"缺失"，避免把用户显式设的 stub:false 误判为缺失而覆盖。
                if (t.stub !== undefined && existing[t.name].stub === undefined) {
                    existing[t.name].stub = !!t.stub;
                    patched++;
                }
                // description 对齐：seed 同名工具的描述以 seed 为准。
                // 描述是给 LLM 的契约面（ES3/撤销组禁令/弹窗禁令/能力域规则），随 seed 迭代——
                // local 副本里的旧描述是初次安装时的 seed 拷贝（AE Tools UI 无描述编辑框、
                // saveTool 整存透传），不覆盖则已部署环境永远拿不到契约更新（executeExtendScript
                // 契约搬迁实证：改 seed 描述在已有安装上不生效）。用户资产字段
                //（extendScript/enabled/scope）不动。幂等：对齐后不再触发写回。
                if (t.description && existing[t.name].description !== t.description) {
                    existing[t.name].description = t.description;
                    patched++;
                }
                // input_schema 对齐：与 description 同理——schema 是给 LLM 的契约面
                //（参数名/类型/参数级说明），local 副本是初次安装时的 seed 拷贝，而 AE Tools UI
                // 无 schema 编辑框、saveTool 整存透传。不同步则新增参数对已部署环境不可见
                //（面板工具面与外接 tools/list 都读这份 JSON），只有删掉整个数据目录才会消失。
                // 用户资产字段（extendScript/enabled/scope）仍一律不动。
                // 「策略文案必须写 description、不要写 input_schema」据此作废：
                // 该约束的前提是「schema 拿不到更新」，现已不成立。落点按读者分：整体行为契约
                // 写 description，单参数语义写该参数的 description。
                if (t.input_schema && JSON.stringify(existing[t.name].input_schema) !== JSON.stringify(t.input_schema)) {
                    existing[t.name].input_schema = t.input_schema;
                    patched++;
                }
                // external-mcp 作用域一次性迁移——
                // 背景：外接投影/执行现按 scope 判定（extTools.js 的 isToolExposed 单点闸门：
                // module 作用域必须显式含 'external-mcp'），而注册期 resolveAeScope 会给
                // 「无 scope」的 seed 条目兜底成 `{type:'module', moduleIds:['agent']}`——
                // 于是 seed 里没写 scope 的对外主力工具（executeExtendScript/importFile/
                // replaceFootage）在外部 MCP 客户端的 tools/list 里静默消失、直接调用被拒
                //（TOOL_SCOPE_EXCLUDES_EXTERNAL），用户却从未显式排除过。
                // 覆盖两种形态（都只作用于 seed 里显式声明了 external-mcp 的条目）：
                //   A. 本地已有显式 module scope 但缺 external-mcp：已部署安装把
                //      queryProject/queryDetails 这类工具写回成
                //      `{type:'module', moduleIds:['agent','script']}`（无 external-mcp）——
                //      只补 external-mcp 这一个成员。本地少的是 script 等其它成员属用户资产
                //      （UI 抽屉可改），不顺手补——只有 external-mcp 的缺失是历史写回造成的
                //      既知形态。
                //   B. 本地完全没有 scope（旧 seed 拷贝从未写过 scope）：把 seed 的 scope
                //      整体补上。本形态必须走这里而不是下方通用「缺 scope 补 seed」分支的
                //      原因：本块受 migrations 标记约束——标记落定后，用户之后把 scope 改掉
                //      （抽屉取消「外接」等）不会被 seed 对齐重新加回；通用分支则永远按
                //      「缺失才补」语义执行。
                // 一次性：落 migrations 标记后不再执行（标记版本 1，落定判据见循环后）。
                // 用户之后在抽屉里取消「外接」的显式排除不会被下次启动重新加回——外接的独立
                // 排除本来由 extPolicy 的 per-tool/per-server/分组开关表达。
                var _seedIds = (t.scope && Array.isArray(t.scope.moduleIds)) ? t.scope.moduleIds : null;
                var _seedExternal = !!(_seedIds && _seedIds.indexOf(EXTERNAL_MCP_MODULE) >= 0);
                if (_seedExternal) seedDeclaresExternal = true;
                var _localScope = existing[t.name].scope;
                if (!mig[MIGRATION_EXTERNAL_MCP_SCOPE] && _seedExternal) {
                    if (_localScope === undefined) {
                        existing[t.name].scope = t.scope;
                        patched++;
                        migratedMembers++;
                    } else if (_localScope && _localScope.type === 'module'
                        && Array.isArray(_localScope.moduleIds)
                        && _localScope.moduleIds.indexOf(EXTERNAL_MCP_MODULE) < 0) {
                        _localScope.moduleIds.push(EXTERNAL_MCP_MODULE);
                        patched++;
                        migratedMembers++;
                    }
                }
                // 写工具 script 成员一次性移除——与上方 external-mcp 补齐同属
                // 历史 scope 形态迁移，各自受独立标记约束。
                // 判据：seed 条目 scope 不含 script（当前为 5 件写工具）+ 本地 module 作用域含
                // script + 成员只来自 {agent, script, external-mcp} + 含 agent ⇒ 移除 script、
                // 保留其余成员（结果必含 agent，不会删空）。
                // 其余形态不动：含 shader/team 等自定义成员、只剩 script、global 作用域——无法
                // 区分用户显式设置，保持原样。标记落定后不再执行：用户之后把 script 加回写工具
                // 的显式设置不会被下次启动改掉。
                var _seedScriptFree = !!(_seedIds && _seedIds.indexOf('script') < 0);
                if (_seedScriptFree) seedDeclaresScriptFree = true;
                if (!mig[MIGRATION_SCRIPT_WRITE_SCOPE] && _seedScriptFree
                    && _localScope && _localScope.type === 'module'
                    && Array.isArray(_localScope.moduleIds)
                    && _localScope.moduleIds.indexOf('script') >= 0
                    && _localScope.moduleIds.indexOf('agent') >= 0) {
                    var _onlyKnownMembers = true;
                    for (var mi = 0; mi < _localScope.moduleIds.length; mi++) {
                        var _mid = _localScope.moduleIds[mi];
                        if (_mid !== 'agent' && _mid !== 'script' && _mid !== EXTERNAL_MCP_MODULE) {
                            _onlyKnownMembers = false;
                            break;
                        }
                    }
                    if (_onlyKnownMembers) {
                        var _keptIds = [];
                        for (var ki = 0; ki < _localScope.moduleIds.length; ki++) {
                            if (_localScope.moduleIds[ki] !== 'script') _keptIds.push(_localScope.moduleIds[ki]);
                        }
                        if (_keptIds.length > 0) {
                            _localScope.moduleIds = _keptIds;
                            patched++;
                            migratedScriptMembers++;
                        }
                    }
                }
                // scope 对齐：**仅当本地没有显式 scope 时**才用 seed 的补上。
                // 有显式 scope = 用户在 AE Tools UI 改过（或早期安装写入过），属用户资产，一律不动
                //（判据与上面 stub 同款：=== undefined 表示"缺失"，别用 falsy）。
                // 为什么需要这一条：缺失 scope 的工具按 readOnly 推导（只读→global=全模式可见），
                // 于是"只读工具默认渗进 shader 模式"这类问题只能靠 seed 写显式 scope 纠正；
                // 不补这一手，改 seed 的 scope 对已部署环境永远不生效（与 description/input_schema 同理）。
                // 上面迁移块已处理「seed 声明 external-mcp 且本地无 scope」的形态（受标记约束）；
                // 本分支覆盖其余 seed 条目与「标记已落定后新增的 seed 工具」（仍按缺失才补语义更新）。
                if (t.scope !== undefined && existing[t.name].scope === undefined) {
                    existing[t.name].scope = t.scope;
                    patched++;
                }
            }
        }
        // 迁移标记落定：判据是「迁移**适用**」（seed 任一条目声明了
        // external-mcp）而非「本次真的补过成员」。反例：只有真的补过成员才落标记
        // ——全新安装 / scope 已含成员的安装永远没有标记，迁移长期处于"上膛"状态：用户
        // 之后在 AE 工具抽屉取消「外接」（写回不含 external-mcp 的 scope），下次启动迁移
        // 又把它静默加回，违反"用户显式排除不得被重新加回"。迁移标记只按「适用」判据落定，并让
        // initAETools 连同 tools 写回数据文件（无补齐也写一次标记，代价一次写盘；
        // 标记一旦在盘上，此后每次启动零写盘）。真正的用户显式排除由 extPolicy 的
        // per-tool/per-server/分组开关表达（它们在外接投影时独立生效）。
        var migrationsDirty = false;
        if (seedDeclaresExternal && !mig[MIGRATION_EXTERNAL_MCP_SCOPE]) {
            mig[MIGRATION_EXTERNAL_MCP_SCOPE] = 1;
            migrationsDirty = true;
        }
        // 写工具 script 成员迁移的标记落定：判据同样是「迁移适用」（seed 任一条目 scope 不含
        // script），不要求本次真的移除过成员——全新安装的数据文件已是新 scope 时也落标记，
        // 否则迁移长期上膛：用户之后把 script 加回写工具的显式设置会被下次启动再次移除。
        if (seedDeclaresScriptFree && !mig[MIGRATION_SCRIPT_WRITE_SCOPE]) {
            mig[MIGRATION_SCRIPT_WRITE_SCOPE] = 1;
            migrationsDirty = true;
        }
        if (migratedMembers > 0) {
            console.log('[AE Bootstrap] One-time migration: added external-mcp to ' + migratedMembers + ' tool scope(s)');
        }
        if (migratedScriptMembers > 0) {
            console.log('[AE Bootstrap] One-time migration: removed script from ' + migratedScriptMembers + ' write-tool scope(s)');
        }
        if (migratedMembers === 0 && migratedScriptMembers === 0 && migrationsDirty) {
            console.log('[AE Bootstrap] One-time migration: marker recorded (no member change needed)');
        }
        if (added.length === 0 && patched === 0) {
            return { tools: localTools, added: 0, patched: 0, migrations: mig, migrationsDirty: migrationsDirty };
        }
        if (patched > 0) {
            console.log('[AE Bootstrap] Patched ' + patched + ' tool(s) with seed fields (shortDescription/stub/description/input_schema/scope缺失补齐/external-mcp成员补齐/写工具script成员移除)');
        }
        return { tools: localTools.concat(added), added: added.length, patched: patched, migrations: mig, migrationsDirty: migrationsDirty };
    }

    async function saveToolsToJson(filePath, toolsArray, migrations) {
        // 原子落盘（对齐同模块 effectsCache 的 .tmp → rename 模式，复用 AEFS 现有 API）：
        // 直接 writeFile 覆盖写属 truncate-then-write，写盘中途失败（崩溃/断电/磁盘满）会把
        // ae_tools.json 截断损坏——下次启动 JSON.parse 失败、_aeToolsReady 永不升旗，
        // 整个 AE 工具模块瘫痪且无应用内恢复路径。先写 .tmp 再 rename，正式文件要么是
        // 完整旧内容、要么是完整新内容，不存在半截状态。
        var tmpPath = filePath + '.tmp';
        try {
            // 顶层 migrations 标记的续存：controller 三入口与 hotReload 调用时只传
            // toolsArray（整存透传），不续读旧文件就会把 mergeSeedTools 落下的一次性迁移标记
            // 抹掉——下次启动迁移"复活"（重写用户文件；用户之后取消的外接勾选被重新加回）。
            // 未显式传入（或非对象）时从盘上原文件续读；读不到/解析失败按无标记处理，不阻塞保存。
            // 显式传入（initAETools 的 seed 合并路径）优先。
            var mig = (migrations && typeof migrations === 'object') ? migrations : null;
            if (!mig) {
                try {
                    if (typeof AEFS.readFile === 'function') {
                        var prevRaw = await AEFS.readFile(filePath);
                        var prevData = prevRaw ? JSON.parse(prevRaw) : null;
                        if (prevData && !Array.isArray(prevData) && prevData.migrations
                            && typeof prevData.migrations === 'object') {
                            mig = prevData.migrations;
                        }
                    }
                } catch (_) { mig = null; }
            }
            var data = { version: '1.0', updatedAt: new Date().toISOString(), tools: toolsArray };
            if (mig && Object.keys(mig).length > 0) data.migrations = mig;
            var jsonStr = JSON.stringify(data, null, 2);
            // 无 renameFile 通道的宿主环境退回直接覆盖写（保底行为）
            if (!AEFS.renameFile) {
                var directOk = await AEFS.writeFile(filePath, jsonStr);
                if (!directOk) throw new Error('writeFile failed');
                return;
            }
            var writeOk = await AEFS.writeFile(tmpPath, jsonStr);
            if (!writeOk) throw new Error('write tmp failed');
            var renameOk = await AEFS.renameFile(tmpPath, filePath);
            if (!renameOk) {
                // rename 通道对已存在的目标文件可能失败：新数据已安全写入 tmp，
                // 删旧文件后重试一次（与 effectsCache 同款兜底，把无文件窗口压到最小）
                try { if (AEFS.deleteFile) await AEFS.deleteFile(filePath); } catch (_) {}
                renameOk = await AEFS.renameFile(tmpPath, filePath);
            }
            if (!renameOk) throw new Error('rename failed');
        } catch (e) {
            console.warn('[AE Bootstrap] saveToolsToJson error: ' + e);
            // 失败不清理 .tmp：rename 兜底也失败时它是唯一完整副本（旧文件已删），
            // 留在原目录可手工恢复；下次保存成功路径会直接覆盖它
            throw e;
        }
    }

    // 清扫 temp/ae-tools 下残留的 ae_preview_*.png 预览帧，兜底清理停止/异常退出遗留的孤儿文件。
    // 年龄不依赖裸 window.cep.fs.stat 的 mtime：取不到就 mtimeMs=0 →
    // 每个文件 continue → 一个都没删（实测目录累积 199MB/22 张，最早的 8 月 21 日，其中
    // 两张各 84MB）。现统一走 AETempSweep：年龄取文件名内嵌毫秒时间戳（不依赖 stat），
    // 无时间戳的才回落 AEFS.stat（含 ExtendScript 回退），并落覆盖式报告
    // temp/_sweep_ae-tools.json——"没生效"时先读报告定位。
    // 保留池（不即删，池内保留最新 30 张）：本趟在龄清扫之后
    // 再裁一次保留池——视觉钩子每次读完也会裁，这里覆盖面板外抓的帧、崩溃残留与超限堆积。
    var _aeSweepTimer = null;
    async function _cleanAeToolsTemp() {
        try {
            var dataDir = (global.AEShared && typeof global.AEShared.getDataDir === 'function')
                ? global.AEShared.getDataDir().dir : '';
            if (!dataDir) return;
            // 目录存在性一并在这里兜住：清扫按「启动 + 每小时」跑，正好让「数据目录被清过/
            // 刚装好」之后 temp/ae-tools 自动回来（AE 侧的 Folder.create 在未授权 file 域时
            // 被守卫拦死，见 ensurePreviewDir 注释；这条是它在时间轴上的补充）
            ensurePreviewDir();
            if (!global.AETempSweep || typeof global.AETempSweep.sweep !== 'function') return;
            var base = dataDir.replace(/\\+$/, '');
            // 目标清单取自清扫器的 previewFrameTargets（单一真相源）：主目录 temp/ae-tools +
            // **temp 根回退目录**（AE 侧建不出主目录时 getPreviewFrame 写这里，见 aeTools.jsx
            // 三级候选）。此处不手抄目录与正则——手抄版就漏了回退目录。
            var pvTargets = global.AETempSweep.previewFrameTargets(base);
            await global.AETempSweep.sweep({
                targets: pvTargets,
                // 四个缓存目标统一 7 天，阈值唯一来源在清扫器
                maxAgeMs: global.AETempSweep.MIN_AGE_MS,
                reportPath: base + '\\temp\\_sweep_ae-tools.json'
            });
            if (typeof global.AETempSweep.retainPreviewFrames === 'function') {
                await global.AETempSweep.retainPreviewFrames(base, {
                    reportPath: base + '\\temp\\_sweep_ae-tools-keep.json'
                });
            }
        } catch (_) {}
    }

    // ── 启动后置检查：自定义工具与内建工具重名 ──

    // ae_tools.json 里的名字若被「非 ae-tools 来源」的注册表条目占用（其它模块 bootstrap
    // 注册的内建工具），该自定义工具**不会被注册**（后注册者按名覆盖，UI 列出但 LLM 侧是内建版）。
    //
    // 为什么必须放在启动**完成**之后调用：ae-tools 的初始化在 manifest / main.js 里早于
    // agent/engine、memory、skill、comfyui 等模块，注册那一刻那些内建工具还没进注册表——
    // 放在注册期判据永远不命中（这正是「运行时写入路径拦截」必须存在的原因；本检查只覆盖
    // 手编 JSON/历史遗留的存量条目）。
    // 只报不修：存量条目是用户数据，改名还是删除由用户决定；自动改名的静默副作用更大。
    function checkBuiltinNameConflicts(toolRegistry) {
        try {
            var registry = toolRegistry || (global.AE_LLM && global.AE_LLM.toolRegistry);
            if (!registry || typeof registry.get !== 'function') return [];
            var conflicts = [];
            var all = (global.AE_LLM && global.AE_LLM._aeToolsData) || [];
            for (var i = 0; i < all.length; i++) {
                var def = all[i];
                if (!def || !def.name) continue;
                var entry = registry.get(def.name);
                if (entry && entry.source !== 'ae-tools') {
                    conflicts.push({ name: def.name, source: entry.source || '' });
                }
            }
            for (var c = 0; c < conflicts.length; c++) {
                console.warn('[AE Bootstrap] 工具名冲突：自定义工具 "' + conflicts[c].name
                    + '" 与内建工具同名（注册表来源 ' + conflicts[c].source + '），该自定义工具不会生效，请改名或删除');
            }
            return conflicts;
        } catch (e) {
            console.warn('[AE Bootstrap] 工具名冲突检查失败: ' + (e && e.message ? e.message : e));
            return [];
        }
    }

    // ── 导出 ──

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.AE_CATEGORIES = AE_CATEGORIES;
    global.AE_LLM.initAETools = initAETools;
    global.AE_LLM._aeReloadFromSource = reloadFromSource;
    global.AE_LLM._aeInjectToolsCode = injectToolsCode;
    global.AE_LLM._aeHotReload = hotReload;
    global.AE_LLM._aeCreateHandler = createHandler;
    // 多帧抓帧的执行超时解析：controller 的重注册路径必须包同款，否则用户在 AE Tools UI
    // 里编辑并保存 getPreviewFrame 后，多帧调用回落到全局「执行超时」（默认 30s）
    global.AE_LLM._aePreviewBatchTimeoutMs = previewBatchTimeoutMs;
    // 内建 shader_params 的三段固定模板（测试通道：单测在假 AE 对象模型上真跑这些脚本）
    global.AE_LLM._aeShaderParamScripts = SHADER_PARAMS_SCRIPTS;
    global.AE_LLM._aeRegisterToolsFromConfig = registerToolsFromConfig;
    global.AE_LLM._aeCheckBuiltinNameConflicts = checkBuiltinNameConflicts;
    global.AE_LLM._aeResolveScope = resolveAeScope;
    // 外接短描述分叉：controller 的重注册路径必须包同款——否则用户在 AE Tools
    // UI 里编辑/启停 queryProject/queryDetails 后，注册条目丢失 buildDescription，外接又拿到
    // 长文并被客户端 2048 截断（直到面板重载）。
    global.AE_LLM._aeBuildExternalDescription = buildAeExternalDescription;
    global.AE_LLM._aeSaveJson = saveToolsToJson;
    global.AE_LLM._aeLoadJson = loadToolsFromJson;
    global.AE_LLM._aeMergeSeedTools = mergeSeedTools;   // 测试通道（description 对齐 / scope 缺员一次性补齐 / 写工具 script 成员一次性移除语义，第三参可传 migrations 标记对象）
    // 预览帧目录预建：controller 的重注册路径要包同款（否则用户在 AE Tools UI 里编辑并
    // 保存 getPreviewFrame 后，帧又会因目录建不出来而写失败）
    global.AE_LLM._aeEnsurePreviewDir = ensurePreviewDir;
    // 动态 json 路径：数据目录可运行时切换，消费方（hotReload/controller）应优先用它取当前路径
    global.AE_LLM._aeToolsJsonPathFn = getJsonPath;

})(window);
