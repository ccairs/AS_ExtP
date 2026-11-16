(function (global) {
    // 自包含名称校验（不再委托已删除的 controller.scriptTree）
    // 对齐 AEFS _checkPath：拒 %/控制字符/引号/路径分隔符/Windows 非法字符/.. /.段/DOS 设备名。
    function _safeName(name) {
        if (!name || typeof name !== 'string') return false;
        if (name.indexOf('%') !== -1) return false;  // URL 编码攻击（_checkPath ①）
        for (var i = 0; i < name.length; i++) { var c = name.charCodeAt(i); if (c <= 0x1F || c === 0x7F || c === 0x22 || c === 0x27) return false; }
        if (/[\\\/\:\*\?\"\<\>\|]/.test(name)) return false;
        if (name === '.' || name === '..') return false;
        var upper = name.replace(/\..*$/, '').toUpperCase();
        if (upper === 'NUL' || upper === 'CON' || upper === 'PRN' || upper === 'AUX' || /^COM[1-9]$/.test(upper) || /^LPT[1-9]$/.test(upper)) return false;
        return true;
    }

    // ── 运行错误反馈卡片 ──
    // runScript 失败/沙箱拦截时，在预览区弹出悬浮卡片，用户可一键反馈给 LLM。
    // 仅 runScript（预览区运行）触发；runScriptFileByPath（脚本树运行文件）不触发。
    var lastRunResult = null;  // { type: 'error'|'sandbox', message: string }

    // ──  脚本运行单飞锁（runScript / 脚本树 _execScriptFile 共用）──
    // 「跳过运行确认」开启时双击运行按钮/脚本树运行：两次入口各自过确认直跑，桥被调用
    // 两次 → 建层/加效果/入渲染队列重复执行，而撤销一次只回退一组。入口同步置位，
    // 第二次点击同 Tick 内即被拒；锁覆盖 门检→确认→执行 全窗口，成功/失败/取消/异常
    // 终态统一释放（各终态回调里 _endRun）。
    var _runInFlight = false;
    function _beginRun() {
        if (_runInFlight) return false;
        _runInFlight = true;
        return true;
    }
    function _endRun() {
        _runInFlight = false;
    }

    // ── 宿主脚本不可中断的静态提示 ──
    // ExtendScript 无中断 API：脚本一经 evalScript 下发即占住 AE 脚本线程，
    // executionTimeoutMs 只作用于面板等待/队列（超时后队列仍等该调用，后续全排队）。
    // 运行前对**明显死循环形态**做静态提示（只警告不阻断，用户在场自决），
    // 避免误点「运行」后只能强制重启 AE、丢掉未保存工程。
    // 判定前先剥字符串再剥注释（字符串里的 // 不能当注释起点），避免示例文本误报；
    // 有 break/throw 视为可控循环；return 只退出函数、不作为循环可终止的依据。
    function _busyLoopRiskHits(code) {
        var src = String(code == null ? '' : code);
        src = src.replace(/'(?:\\.|[^'\\])*'/g, "''").replace(/"(?:\\.|[^"\\])*"/g, '""');
        src = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n\r]*/g, ' ');
        var hits = [];
        // do-while 尾巴先判定并从扫描源移除，避免同一结构再命中 while 规则
        if (/\bdo\s*\{[\s\S]*?\}\s*while\s*\(\s*(?:true|1)\s*\)/.test(src)) {
            hits.push('do…while (true)');
            src = src.replace(/\bdo\s*\{[\s\S]*?\}\s*while\s*\(\s*(?:true|1)\s*\)/g, ' ');
        }
        if (/\bwhile\s*\(\s*(?:true|1)\s*\)/.test(src)) hits.push('while (true)');
        if (/\bfor\s*\(\s*;\s*;\s*\)/.test(src)) hits.push('for (;;)');
        if (!hits.length) return [];
        if (/\b(?:break|throw)\b/.test(src)) return [];
        hits.push(AEI18n.t('全文未见 break/throw'));
        return hits;
    }
    function _busyLoopWarningText(code) {
        var hits = _busyLoopRiskHits(code);
        if (!hits.length) return '';
        return AEI18n.t('\n\n⚠ 检测到疑似无法自行结束的循环（{hits}）。宿主脚本一旦开始执行就无法被面板超时中断，可能卡死 AE（需强制重启、未保存工程会丢失）。\n仍要运行吗？', {
            hits: hits.join(AEI18n.punct('；', '; '))
        });
    }

    function showRunErrorCard(type, title, message, hint) {
        // hint：卡片尾部的 UI 指引语——仅展示，不进 lastRunResult（反馈给 LLM 的
        // 只应是错误信息本身，指引语写入输入框是噪音）
        lastRunResult = { type: type, message: message || '' };
        var card = document.getElementById('runErrorCard');
        if (!card) return;
        var titleEl = document.getElementById('runErrorCardTitle');
        var bodyEl = document.getElementById('runErrorCardBody');
        if (titleEl) titleEl.textContent = title || AEI18n.t('脚本运行失败');
        if (bodyEl) {
            // 转义后保留换行展示
            var escaped = String(message || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            var hintEscaped = String(hint || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            bodyEl.innerHTML = escaped.replace(/\n/g, '<br>') + (hint ? ('<br><br>' + hintEscaped) : '');
        }
        card.hidden = false;
        card.setAttribute('data-type', type || 'error');
        // 抽屉关闭时强制打开，确保用户看到错误
        if (typeof togglePreviewDrawer === 'function') {
            togglePreviewDrawer(true);
        }
    }

    function hideRunErrorCard() {
        var card = document.getElementById('runErrorCard');
        if (card) card.hidden = true;
    }

    // ── 预览区错误行内高亮（区别于整段拒绝文案）──
    // 编辑器（原文）行号 = 门拒绝 e.line（preprocess 等长填充零漂移）/ lineMap
    // 映射后原文行；产物 pane 行号 = 产物行（运行时错误 AE 报错行）。
    // overlay（.hl-line）在 textarea 下层（文字透明叠加），行背景透出即可见。
    // 容错守卫：vm 测试 stub 无 children/classList 时静默跳过（既有测试零破坏）。
    function _markLines(containerId, line, cls) {
        try {
            if (!(line >= 1)) return;
            var codeEl = document.getElementById(containerId);
            if (!codeEl || !codeEl.children || !codeEl.children.length) return;
            var row = codeEl.children[line - 1];
            if (row && row.classList) row.classList.add(cls);
        } catch (_) {}
    }
    function markPreviewLine(line, kind) {
        var cls = kind === 'gate' ? 'hl-err' : 'hl-err-rt';
        // overlay 行由 hl-engine 防抖重建：标记时行可能尚未建好（或被重建覆盖），
        // 记录本次标记并在重建窗口后重放，保证运行结束后面板进入稳定态仍可见。
        _pendingPreviewMarks = [{ line: line, cls: cls }];
        _applyPreviewMarks();
        try { setTimeout(_applyPreviewMarks, 60); } catch (_) {}
        try { setTimeout(_applyPreviewMarks, 900); } catch (_) {}
    }
    var _pendingPreviewMarks = [];
    function _applyPreviewMarks() {
        for (var i = 0; i < _pendingPreviewMarks.length; i++) {
            _markLines('scriptHighlightCode', _pendingPreviewMarks[i].line, _pendingPreviewMarks[i].cls);
        }
    }
    function markProductLine(line) {
        _markLines('scriptProductCode', line, 'hl-err-rt');
    }
    function clearPreviewLineMarks() {
        _pendingPreviewMarks = [];
        try {
            if (typeof document.querySelectorAll !== 'function') return;
            var rows = document.querySelectorAll('.hl-err, .hl-err-rt');
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].classList) rows[i].classList.remove('hl-err', 'hl-err-rt');
            }
        } catch (_) {}
    }

    // ── 产物 pane（重发射产物只读对照——所见即所执行）──
    // 门通过即刷新（执行用的就是它）。行号 gutter 宽度随行号位数收紧（收尾①：
    // 窄行号 1-9 时 40px 定宽左侧留白过宽）+ Prism 按行着色（hl-engine.highlightLines
    // 全文 tokenize 行拆分——跨行块注释上下文正确；Prism/hlEngine 未就绪时纯文本
    // 降级，下次门通过自然着色——面板启动即载 Prism，实际竞态窗口极小）。
    function updateProductPane(emitted) {
        try {
            var codeEl = document.getElementById('scriptProductCode');
            var pane = document.getElementById('previewProductPane');
            if (!codeEl) return;
            var lines = String(emitted || '').split('\n');
            if (lines.length && lines[lines.length - 1] === '') lines.pop();
            var hl = null;
            try {
                var _lang = (window.Prism && window.Prism.languages) ? window.Prism.languages.javascript : null;
                if (_lang && global.AEAgentApp && global.AEAgentApp.hlEngine &&
                    typeof global.AEAgentApp.hlEngine.highlightLines === 'function') {
                    hl = global.AEAgentApp.hlEngine.highlightLines(lines.join('\n'), _lang);
                }
            } catch (_) { hl = null; }
            var html = [];
            for (var i = 0; i < lines.length; i++) {
                var esc = (hl && hl[i] != null) ? hl[i]
                    : lines[i].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                html.push('<div class="pl-row"><span class="pl-num">' + (i + 1) + '</span><span class="pl-code">' + esc + '</span></div>');
            }
            codeEl.innerHTML = html.join('');
            // gutter 宽度 = 最大行号位数（≥2 位），ch 单位自适应等宽字体
            if (codeEl.style && typeof codeEl.style.setProperty === 'function') {
                codeEl.style.setProperty('--pl-num-w', Math.max(2, String(lines.length).length) + 'ch');
            }
            if (pane && pane.classList) pane.classList.remove('is-stale');
        } catch (_) {}
    }
    function markProductPaneStale() {
        try {
            var pane = document.getElementById('previewProductPane');
            if (pane && pane.classList) pane.classList.add('is-stale');
        } catch (_) {}
    }

// ── llm-preview 域确认链（四域映射）────────────────────────
// 域拒绝（error.domain）= 能力域未开而非逃逸形态——用户可当次授权放行：
// 确认 → policyOverride 重过门（getEffectivePolicy 合成 域开 ∪ config）+
// _domainToAllowSet 当次授权执行（桥 opts.allowSet——帧载荷该域真实放行）。
// menu 域核侧无 executeCommand shadow，allowSet 为空对象（仅门侧语义）。

var _DOMAIN_POLICY_KEYS = {
    system: 'syscallAllowed', socket: 'socketAllowed',
    file: 'fileAllowed', menu: 'menuAllowed'
};
var _DOMAIN_ALLOW_KEYS = { system: 'system', socket: 'socket', file: 'file' };
var _DOMAIN_NAMES = {
    get system() { return AEI18n.t('系统命令（system.callSystem）'); }, get socket() { return AEI18n.t('网络通信（Socket）'); },
    get file() { return AEI18n.t('文件读写（File/Folder）'); }, get menu() { return AEI18n.t('菜单命令（executeCommand）'); }
};
// bypass 全开 allow-set（三强制 source 门照跑、核侧三域全开——硬拒照拦）
var _FULL_OPEN_ALLOW = { system: true, socket: true, file: true };

function _domainConfirm(domain) {
    var _msg = AEI18n.t('脚本使用了未开启的能力域：{domain}。\n\n确认后本次运行将放行该能力（敏感路径黑名单与 execute()/changePath()/scheduleTask 等硬拒原语不受影响）。', {
        domain: _DOMAIN_NAMES[domain] || domain
    });
    if (typeof showConfirmEx === 'function') {
        return showConfirmEx(AEI18n.t('能力域确认'), _msg, 'confirm');
    }
    if (typeof showConfirm === 'function') {
        return showConfirm(AEI18n.t('能力域确认'), _msg, 'confirm');
    }
    return Promise.resolve(false);
}

// AST 门拒绝的用户可见文案：门侧 reason/alternative 是给 LLM 自修正的中文诊断原文，
// 非源语言界面只显示本地化分类句（映射见 shared/i18n/gateReasons.js）。
function _gateIsSourceLocale() {
    var src = AEI18n.SOURCE_LOCALE || 'zh-CN';
    var cur = (typeof AEI18n.getLocale === 'function') ? AEI18n.getLocale() : src;
    return cur === src;
}
function _gateSummary(gate) {
    var G = (global.AEGateReasons && typeof global.AEGateReasons.summary === 'function')
        ? global.AEGateReasons : null;
    return G ? G.summary(gate && gate.error) : '';
}

function feedbackToAI() {
    if (!lastRunResult) { hideRunErrorCard(); return; }
    var text;
    if (lastRunResult.type === 'sandbox') {
        text = '脚本被沙箱拦截：\n' + lastRunResult.message;
    } else {
        text = '脚本运行失败：\n' + lastRunResult.message;
    }
    var input = document.getElementById('aeAgentInput');
    if (input) {
        var existing = input.value || '';
        // 有效内容长度（去掉尾部空白）；空输入/纯空白直接填 text，否则前置换行分隔
        var trimLen = existing.replace(/\s+$/, '').length;
        var insertText = trimLen > 0 ? ('\n\n' + text) : text;
        // 选中尾部空白并 execCommand 插入：与真实输入同撤销栈，Ctrl+Z 可一步撤回
        input.focus();
        try { input.setSelectionRange(trimLen, existing.length); } catch (_) {}
        var inserted = false;
        try { inserted = document.execCommand('insertText', false, insertText); } catch (_) {}
        if (!inserted) {
            input.value = existing.slice(0, trimLen) + insertText;
            // 直改 value 不触发 input 事件——chip overlay 计数/粒子亮度等
            // 监听 #aeAgentInput input 的状态不刷新；execCommand 路径浏览器会原生
            // 派发 input，回退分支对齐手动派发（与 main.js 既有 dispatchEvent 手法一致）
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // 光标移到末尾
        var len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (_) {}
        input.focus();
    }
    hideRunErrorCard();
}

function runScript() {
    // 单飞——运行中（含确认/门检 await 窗口）再次点击直接忽略，
    // 修复「跳过运行确认」双击重复执行（建层/加效果/入渲染队列重复、撤销只回退一组）。
    if (!_beginRun()) return;
    try {
        var editedScript = document.getElementById('scriptPreview').value;
        if (!editedScript) {
            showStatus(AEI18n.t('没有可运行的脚本内容'), 'error');
            _endRun();
            return;
        }

        if (typeof CSInterface === 'undefined') {
            showStatus(AEI18n.t('CSInterface未定义，无法运行脚本'), 'error');
            _endRun();
            return;
        }

        // 安全闸门：沙箱未就绪则拒绝所有脚本执行
        if (!(window.AE_LLM && window.AE_LLM._agentSafetyReady)) {
            showStatus(AEI18n.t('安全措施未就绪，拒绝执行脚本'), 'error');
            _endRun();
            return;
        }

        var settings = getCurrentSettingsFromUI();

        // AST 编译门（内含 regex 预检三块——hasSandboxBypass/hasSysCall/
        // hasDanger；「两通道 ES6 处理合流」）：预览区代码 = LLM
        // submit_script 写入，source=llm-preview 强制过门。拒绝理由结构化展示
        // （行号/construct/替代方案）；通过则执行重发射产物（TOCTOU 消失）。
        if (!(window.AE_LLM && typeof window.AE_LLM._runSandboxedScript === 'function')) {
            showStatus(AEI18n.t('AST 编译门未就绪（ast-gate 模块加载失败），拒绝执行脚本'), 'error');
            _endRun();
            return;
        }
        var _gatePreview = window.AE_LLM._runSandboxedScript(editedScript, { source: 'llm-preview' });
        // bypass['llm-preview'] ON → 确认层停用 + 桥 allowSet 全开
        // （门照跑：emitted=门产物、逃逸形态/成员白名单保持）
        var _gateBypassed = !!(_gatePreview.ok && _gatePreview.bypassed === true);
        var gateEmitted = _gatePreview.ok ? _gatePreview.emitted : '';
        // 产物行映射（产物行 → 原文行——运行时错误回指数据通道）
        var gateLineMap = _gatePreview.lineMap || null;
        // 产物 pane 刷新（门通过即定形——执行用的就是它，所见即所执行）
        if (_gatePreview.ok) updateProductPane(gateEmitted);

        // 原文行内高亮（e.line 即预览区行号——preprocess 等长空白填充零漂移）
        // + 结构化错误卡（位置/结构/原因/替代方案分行）
        function showGateError(gate) {
            clearPreviewLineMarks();
            markPreviewLine(gate.error && gate.error.line, 'gate');
            var _ge = gate.error || {};
            var _source = _gateIsSourceLocale();
            showStatus(_source
                ? AEI18n.t('AST 门拒绝：') + gate.displayText
                : AEI18n.t('AST 门拒绝: {detail}', { detail: _gateSummary(gate) || gate.displayText }),
                'error', { autoHideMs: 8000 });
            showRunErrorCard('gate', AEI18n.t('AST 门拒绝（能力白名单外）'),
                AEI18n.t('位置：第 {line} 行，第 {col} 列\n', { line: _ge.line || 0, col: _ge.column || 0 }) +
                AEI18n.t('结构：{construct}\n', { construct: _ge.construct || 'unknown' }) +
                AEI18n.t('原因：{reason}\n', { reason: _source ? (_ge.reason || AEI18n.t('未知')) : _gateSummary(gate) }) +
                ((_source && _ge.alternative) ? AEI18n.t('替代方案：') + _ge.alternative : ''),
                AEI18n.t('请修正后重新运行（可点「反馈」将错误发给 LLM 自动修改）。'));
        }

        function doRun(allowSet) {
            hideRunErrorCard();  // 开始新运行前隐藏旧错误卡片，避免显示旧结果
            clearPreviewLineMarks();  // 新执行清旧行内高亮标记
            startRunPulse();
            // 执行桥统一改道宿主执行核（bootstrap createHandler 桥 →
            // aeTools.jsx executeExtendScript——shadow + 核内 undo + allow-set）。
            // _wrapScriptForAE 已随 落定 4 删除（无关门直跑回退路径——
            // bypass 门照跑）；{status} JSON 协议经桥翻译为 成功/沙箱拦截/失败
            // 三态（收口代价⑤ UI 适配层）。
            // allowSet——域确认当次授权 / bypass 全开 / 常规 null。
            if (!(window.AE_LLM && typeof window.AE_LLM._aeCreateHandler === 'function')) {
                stopRunPulse();
                showStatus(AEI18n.t('执行桥未就绪（ae-tools 模块加载失败），拒绝执行脚本'), 'error');
                showRunErrorCard('error', AEI18n.t('脚本运行失败'), AEI18n.t('执行桥未就绪（ae-tools 模块加载失败）'));
                _endRun();
                return;
            }
            var handler = window.AE_LLM._aeCreateHandler('result = executeExtendScript(__args);', {
                name: 'Script 运行',
                wrapUndo: true,
                undoInCore: true,
                timeoutMs: Number(settings.executionTimeoutMs) || 30000,
                // 弹窗域：脚本区 = 用户手动运行通道（点运行按钮
                // = 用户在场）→ 恒注入 dialog:true（核侧真弹窗：alert/confirm/prompt
                // 不重定向不 shadow）；域确认当次授权（allowSet）三键随行合并
                allowSet: function () {
                    var _as = { dialog: true };
                    if (allowSet && typeof allowSet === 'object') {
                        if (allowSet.system === true) _as.system = true;
                        if (allowSet.socket === true) _as.socket = true;
                        if (allowSet.file === true) _as.file = true;
                    }
                    return _as;
                }
            });
            handler({ code: gateEmitted }).then(function (resp) {
                stopRunPulse();
                var msg = (resp && resp.content && resp.content[0] && typeof resp.content[0].text === 'string')
                    ? resp.content[0].text : '';
                if (resp && resp.success) {
                    showStatus(AEI18n.t('脚本运行成功'), 'success');
                    hideRunErrorCard();
                } else if (msg.indexOf('[AE_LLM]') >= 0) {
                    showStatus(AEI18n.t('沙箱已拦截危险操作'), 'info', { autoHideMs: 4000 });
                    showRunErrorCard('sandbox', AEI18n.t('沙箱拦截'), msg.replace(/^ERROR:/, ''));
                } else {
                    // 运行时错误行号回指——产物行（AE 报错行，核侧已减 new Function
                    // 包装偏移）经 lineMap 映射回原文行；产物 pane 同步标注产物行
                    var _rtLine = (resp && typeof resp.line === 'number') ? resp.line : 0;
                    var _srcLine = 0;
                    if (_rtLine && gateLineMap && window.AEGate && typeof window.AEGate.mapProductLine === 'function') {
                        _srcLine = window.AEGate.mapProductLine(gateLineMap, _rtLine);
                    }
                    if (_rtLine) {
                        markProductLine(_rtLine);
                        if (_srcLine) { markPreviewLine(_srcLine, 'runtime'); }
                    }
                    var _locSuffix = _rtLine ? (AEI18n.punct('（产物第 ', ' (product line ', '（成果物 第', ' (Produktzeile ', ' (결과물 ', ' (ligne de produit ', ' (строка продукта ') + _rtLine + AEI18n.punct(' 行', '', '行目', null, '행', null, ' стр.') + (_srcLine ? AEI18n.punct('，原文第 ', ', source line ', '、原文 第', ', Quellzeile ', ', 원본 ', ', ligne source ', ', исходная строка ') + _srcLine + AEI18n.punct(' 行', '', '行目', null, '행', null, ' стр.') : '') + AEI18n.punct('）', ')', '）')) : '';
                    showStatus(AEI18n.t('运行脚本失败: ') + (msg || AEI18n.t('未知错误')) + _locSuffix, 'error', { autoHideMs: 5200 });
                    showRunErrorCard('error', AEI18n.t('脚本运行失败'),
                        AEI18n.t('运行脚本失败: ') + (msg || AEI18n.t('未知错误')) + (_locSuffix ? '\n' + _locSuffix : ''));
                }
                _endRun();   // 执行终态（成功/失败/沙箱拦截）释放单飞锁
            }).catch(function (e) {
                stopRunPulse();
                var em = (e && e.message) ? e.message : String(e);
                showStatus(AEI18n.t('运行脚本失败: ') + em, 'error', { autoHideMs: 5200 });
                showRunErrorCard('error', AEI18n.t('脚本运行失败'), AEI18n.t('运行脚本失败: ') + em);
                _endRun();   // 桥异常同样释放，防入口永久锁死
            });
        }

        if (_gatePreview.ok) {
            if (_gateBypassed) {
                // bypass['llm-preview'] ON——确认层停用（免打扰），
                // 桥 allowSet 全开（门照跑核三域放行；硬拒/敏感路径照拦）
                doRun(_FULL_OPEN_ALLOW);
            } else if (!settings.skipRunConfirm) {
                showConfirm(AEI18n.t('确认运行'), AEI18n.t('确定要运行此脚本吗？\n\n请注意：运行脚本可能会修改 After Effects 项目。')
                    + _busyLoopWarningText(editedScript)).then(function (ok) {
                    if (!ok) { _endRun(); return; }   // 用户取消 → 释放单飞锁
                    doRun(null);
                }, function (e) {
                    // 确认框 reject：释放锁防入口永久锁死（异常路径也不漏释放）
                    console.error('[Agent] 运行确认异常:', e);
                    _endRun();
                });
            } else {
                doRun(null);
            }
            return;
        }

        // ── 拒绝分流（Step 4）──────────────────────────────
        // error.domain 存在且 config 可用 → 域确认链（当次授权重过门执行）；
        // 无 domain（逃逸形态/ES6/硬拒）或 config 缺席（模块未载——重过门无
        // policyOverride 合成通道）→ 结构化错误卡（现行保持）
        var _rejDomain = _gatePreview.error && _gatePreview.error.domain;
        if (_rejDomain && Object.prototype.hasOwnProperty.call(_DOMAIN_POLICY_KEYS, _rejDomain) &&
            window.AEGate && window.AEGate.config) {
            var _confirmed = {};
            var _allowSet = null;
            (function confirmStep(gate) {
                if (gate.ok) {
                    // 逐域确认收敛（每轮新增一个域，≤四轮）——产物定形后直接执行
                    // （用户刚就危险明确确认，不再走通用运行确认）
                    gateEmitted = gate.emitted;
                    gateLineMap = gate.lineMap || null;
                    updateProductPane(gateEmitted);
                    doRun(_allowSet);
                    return;
                }
                var dom = gate.error && gate.error.domain;
                if (!dom || !Object.prototype.hasOwnProperty.call(_DOMAIN_POLICY_KEYS, dom)) {
                    showGateError(gate);
                    _endRun();   // 无法收敛的域拒终态 → 释放
                    return;
                }
                Promise.resolve(_domainConfirm(dom)).then(function (r) {
                    var ok = (r && typeof r === 'object') ? r.ok : r;
                    if (!ok) {
                        showGateError(gate);
                        _endRun();   // 域确认取消 → 释放
                        return;
                    }
                    _confirmed[dom] = true;
                    _allowSet = _allowSet || {};
                    var _ak = _DOMAIN_ALLOW_KEYS[dom];
                    if (_ak) _allowSet[_ak] = true;
                    var _override = {};
                    for (var k in _confirmed) {
                        if (Object.prototype.hasOwnProperty.call(_confirmed, k)) {
                            _override[_DOMAIN_POLICY_KEYS[k]] = true;
                        }
                    }
                    confirmStep(window.AE_LLM._runSandboxedScript(editedScript, {
                        source: 'llm-preview', policyOverride: _override
                    }));
                }, function (e) {
                    // 域确认 reject：释放锁并保持门拒反馈（异常路径同样释放）
                    console.error('[Agent] 能力域确认异常:', e);
                    showGateError(gate);
                    _endRun();
                });
            })(_gatePreview);
            return;
        }
        showGateError(_gatePreview);
        _endRun();   // 门拒终态（非域拒路径）→ 释放
    } catch (e) {
        stopRunPulse();
        _endRun();   // 同步异常 → 释放，防入口永久锁死
        showStatus(AEI18n.t('运行脚本失败: JS异常:') + e.toString(), 'error', { autoHideMs: 5200 });
    }
}


function saveScript() {
    var editedScript = document.getElementById('scriptPreview').value;
    if (!editedScript) {
        showStatus(AEI18n.t('没有可保存的脚本内容'), 'error');
        return;
    }

    try {
        // 脚本目录固定使用数据目录 agent/scripts（不再支持用户自定义）
        var scriptDir = getDefaultScriptDir();
        if (!scriptDir) {
            showStatus(AEI18n.t('无法确定脚本保存目录'), 'error');
            return;
        }

        normalizeScriptNameByPromptInput().then(function (scriptName) {
            if (!scriptName) {
                showStatus(AEI18n.t('已取消保存'), 'info');
                return;
            }

            var destPath = buildDestPath(scriptDir, scriptName);
            // 重名检测：同名脚本已存在时自动追加 _1、_2 ... 后缀，避免覆盖
            var finalPath = dedupeDestPath(destPath);
            var renamed = (finalPath !== destPath);

            // AEFS 统一 IO
            AEFS.mkdir(scriptDir).then(function () {
                return AEFS.writeFile(finalPath, editedScript);
            }).then(function (ok) {
                if (ok) {
                    showStatus(renamed ? AEI18n.t('脚本已保存（重名，已重命名为）: ') + finalPath : AEI18n.t('脚本已保存: ') + finalPath, 'success');
                    refreshList();
                } else {
                    showStatus(AEI18n.t('保存脚本失败: 无法写入 ') + finalPath, 'error', { autoHideMs: 5200 });
                }
            });
        }).catch(function (e) {
            showStatus(AEI18n.t('保存脚本失败: ') + (e && e.message ? e.message : String(e)), 'error', { autoHideMs: 5200 });
        });
    } catch (e) {
        console.error('[Agent] saveScript error:', e);
        showStatus(AEI18n.t('保存脚本失败: ') + (e && e.message ? e.message : String(e)), 'error', { autoHideMs: 5200 });
    }
}

// 从编辑器运行：直接 eval 编辑器内容，不经过文件

function _execScriptFile(filePath, timeoutMs) {
    // 安全闸门：沙箱未就绪则拒绝执行
    if (!(window.AE_LLM && window.AE_LLM._agentSafetyReady)) {
        showStatus(AEI18n.t('安全措施未就绪，拒绝执行脚本'), 'error');
        return;
    }
    // 脚本树运行入口单飞（与 runScript 共用一把锁）——「跳过运行确认」
    // 双击脚本树运行会重复执行同一文件（建层/加效果重复、撤销只回退一组）。
    // **拦截必须给反馈**——静默 return 会让用户点了一个
    // 已确认语义的动作却界面毫无反应（同仓其它入口都给「请稍候」，见 inputDispatch/apiActions）。
    if (!_beginRun()) {
        showStatus(AEI18n.t('已有脚本在运行，请稍候再试'), 'warn');
        return;
    }
    startRunPulse();

    // 走 AEFS.readFile 读文件内容（顺带过 _checkPath 安全校验），
    // 经 user-library 审计门 + bootstrap 桥交核执行（改道；
    // _wrapScriptForAE 已随 落定 4 删除）。不走 runScriptFromFile
    // （已删除）——它曾在自身函数作用域内 eval，沙箱 IIFE 的 shadow 不可见。
    // 读文件调用本身同步抛错（AEFS 未载等）也要走终态释放——否则单飞锁
    // 永久持有，运行入口（预览区/脚本树共用一把锁）自此全部不可用。
    var _readPromise = null;
    try {
        _readPromise = AEFS.readFile(filePath);
    } catch (e) {
        stopRunPulse();
        showStatus(AEI18n.t('运行脚本失败: ') + (e && e.message ? e.message : String(e)), 'error', { autoHideMs: 5200 });
        _endRun();
        return;
    }
    _readPromise.then(function (content) {
        if (!content || typeof content !== 'string') {
            stopRunPulse();
            showStatus(AEI18n.t('运行脚本失败: 无法读取文件 ') + filePath, 'error', { autoHideMs: 5200 });
            _endRun();   // 读失败终态 → 释放
            return;
        }

        // AST 编译门（内含 regex 预检三块）：脚本树库文件走 user-library
        // 审计模式（user-library 信任根降级，取代原
        // 「跳过门」）——AST 全量检测产 dangers 危险清单，emitted=原文（所存
        // 即所跑，审计不改写）。
        var _gateLib = (window.AE_LLM && typeof window.AE_LLM._runSandboxedScript === 'function')
            ? window.AE_LLM._runSandboxedScript(content, { source: 'user-library' })
            : { ok: true, emitted: content };
        if (!_gateLib.ok) {
            stopRunPulse();
            showStatus(_gateIsSourceLocale()
                ? AEI18n.t('AST 门拒绝：') + _gateLib.displayText
                : AEI18n.t('AST 门拒绝: {detail}', { detail: _gateSummary(_gateLib) || _gateLib.displayText }),
                'error', { autoHideMs: 8000 });
            _endRun();   // 门拒终态 → 释放
            return;
        }
        var libEmitted = _gateLib.emitted;
        // bypass['user-library'] ON → 审计检测与确认弹窗整体停用
        //（run.js bypass 分支：emitted=原文、无 dangers）+ 桥 allowSet 全开
        //（核三域放行；硬拒/敏感路径照拦）
        if (_gateLib.bypassed === true) {
            doExec({ system: true, socket: true, file: true });
            return;
        }

        // 审计确认层（内含 hasDanger regex——文本层升格 AST 层，
        // 不再以 allowWrite 为前置）：dangers 非空 → 查 per-script 记忆（锚定
        // 内容哈希，代码变即失效即重新弹）→ 无记忆弹确认（「此脚本不再提醒」
        // 勾选）。确认后执行； + 落定 6：确认 = 当次授权
        // ——dangers 能力类并集经 allowSetFromDangers 产 allow-set 传核
        //（system/socket/file 域真实放行——File 经核内包装构造器，敏感路径
        // 黑名单与 execute()/changePath() 硬拒照拦）。
        // 记忆模块缺席（模块未载）= 维持直跑过渡态。
        var fileName = filePath.split(/[\\\/]/).pop() || filePath;
        var dangers = _gateLib.dangers || [];
        var _dangerMem = window.AE_LLM && window.AE_LLM._scriptDangerMemory;
        if (dangers.length > 0 && _dangerMem && typeof _dangerMem.confirmExecution === 'function') {
            _dangerMem.confirmExecution(fileName, content, dangers).then(function (ok) {
                if (!ok) { stopRunPulse(); _endRun(); return; }   // 审计取消 → 释放
                doExec(_dangerMem.allowSetFromDangers ? _dangerMem.allowSetFromDangers(dangers) : null);
            }, function (e) {
                // 审计确认 reject：释放锁防入口永久锁死（异常路径也不漏释放）
                console.error('[Agent] 脚本审计确认异常:', e);
                stopRunPulse();
                _endRun();
            });
            return;
        }
        doExec();

        function doExec(allowSet) {
            // 执行桥统一改道宿主执行核（与 runScript 同款——
            // createHandler 桥 + undoName 数据通道 + allow-set 当次授权；
            // {status} JSON 协议经桥翻译）。undoName 保持「Script 运行: <文件名>」。
            if (!(window.AE_LLM && typeof window.AE_LLM._aeCreateHandler === 'function')) {
                stopRunPulse();
                showStatus(AEI18n.t('执行桥未就绪（ae-tools 模块加载失败），拒绝执行脚本'), 'error');
                _endRun();   // 桥缺失终态 → 释放
                return;
            }
            var handler = window.AE_LLM._aeCreateHandler('result = executeExtendScript(__args);', {
                name: 'Script 运行: ' + fileName,
                wrapUndo: true,
                undoInCore: true,
                timeoutMs: Number(timeoutMs) || 30000,
                // 弹窗域：脚本树 = 用户手动运行通道 → 恒注入
                // dialog:true（核侧真弹窗）；审计确认当次授权（allowSet）随行合并
                allowSet: function () {
                    var _as = { dialog: true };
                    if (allowSet && typeof allowSet === 'object') {
                        if (allowSet.system === true) _as.system = true;
                        if (allowSet.socket === true) _as.socket = true;
                        if (allowSet.file === true) _as.file = true;
                    }
                    return _as;
                }
            });
            handler({ code: libEmitted }).then(function (resp) {
                stopRunPulse();
                var msg = (resp && resp.content && resp.content[0] && typeof resp.content[0].text === 'string')
                    ? resp.content[0].text : '';
                if (resp && resp.success) {
                    showStatus(AEI18n.t('脚本运行成功'), 'success');
                } else if (msg.indexOf('[AE_LLM]') >= 0) {
                    showStatus(AEI18n.t('沙箱已拦截危险操作'), 'info', { autoHideMs: 4000 });
                } else {
                    showStatus(AEI18n.t('运行脚本失败: ') + (msg || AEI18n.t('未知错误')), 'error', { autoHideMs: 5200 });
                }
                _endRun();   // 执行终态 → 释放单飞锁
            }).catch(function (e) {
                stopRunPulse();
                showStatus(AEI18n.t('运行脚本失败: ') + ((e && e.message) ? e.message : String(e)), 'error', { autoHideMs: 5200 });
                _endRun();   // 桥异常同样释放
            });
        }
    }).catch(function (e) {
        stopRunPulse();
        showStatus(AEI18n.t('运行脚本失败: ') + (e && e.message ? e.message : String(e)), 'error', { autoHideMs: 5200 });
        _endRun();   // 读文件/门检异常 → 释放
    });
}

// 从脚本列表运行已保存的脚本：走 AEFS.readFile 读取文件内容，
// 经 user-library 审计门 + bootstrap 桥交核执行（改道；
// _wrapScriptForAE 已随 落定 4 删除。不走 runScriptFromFile ——
// 它曾在自身函数作用域内 eval，沙箱 IIFE 的 shadow 不可见，已从 runtimeApi.jsx 删除）

function runScriptFileByPath(filePath, fileName) {
    if (!filePath) {
        showStatus(AEI18n.t('运行脚本失败: 缺少文件路径'), 'error');
        return;
    }

    if (typeof CSInterface === 'undefined') {
        showStatus(AEI18n.t('CSInterface未定义，无法运行脚本'), 'error');
        return;
    }

    // 安全闸门：沙箱未就绪则拒绝所有脚本执行
    if (!(window.AE_LLM && window.AE_LLM._agentSafetyReady)) {
        showStatus(AEI18n.t('安全措施未就绪，拒绝执行脚本'), 'error');
        return;
    }

    // 已有运行在途（预览区/脚本树）时不再叠加脚本树运行入口——
    // 确认弹窗阶段也拦（锁由 _execScriptFile 获取，这里只做在途预检）。
    // M-6：同上，拦截要给反馈（右键菜单项没有原生 disabled，只有运行**按钮**有）。
    if (_runInFlight) {
        showStatus(AEI18n.t('已有脚本在运行，请稍候再试'), 'warn');
        return;
    }

    var settings = getCurrentSettingsFromUI();

    if (!settings.skipRunConfirm) {
        var _askRunFile = function (codeText) {
            showConfirm(AEI18n.t('确认运行'), AEI18n.t('确定要运行脚本\u300c') + (fileName || filePath) + AEI18n.t('\u300d吗？\n\n请注意：运行脚本可能会修改 After Effects 项目。')
                + _busyLoopWarningText(codeText)).then(function (ok) {
                if (!ok) return;
                _execScriptFile(filePath, settings.executionTimeoutMs);
            });
        };
        // 脚本树文件运行前读源码做死循环静态提示（读失败不阻塞运行）
        var _aefs = (typeof AEFS !== 'undefined' && AEFS) || (global && global.AEFS) || null;
        if (_aefs && typeof _aefs.readFile === 'function' && filePath) {
            _aefs.readFile(filePath).then(function (text) { _askRunFile(text || ''); },
                function () { _askRunFile(''); });
        } else {
            _askRunFile('');
        }
    } else {
        _execScriptFile(filePath, settings.executionTimeoutMs);
    }
}




function updatePreviewScriptFromAgent(script, opts) {
    // 写入目标由**提交工具族**显式声明（opts.area === 'shader' | 'script'）——唯一判据。
    // 外接客户端可在任意面板模式下调用任一族的 submit（工具 moduleId 取自身 scope，与面板
    // runtimeMode 无关），早前按 runtimeMode 判定会把 GLSL 写进 #scriptPreview 并落进
    // previewDraft（用户脚本草稿被覆盖），而 GLSL 区未变、回执却报 passed
    // （实测两向都成立）。
    //
    // 不设"没有 area 就按面板模式猜"的兜底：当前所有调用点都
    // 声明 area，兜底没有消费者；留着等于留第二个目标来源，漏传时会静默写错区。未声明 area
    // = 装配不一致（旧 controller/main 配新 service，或面板文件漏拷）→ 直接失败不猜，
    // 由提交工具回"写入预览区失败"。同理，外接的 isPendingShaderSubmit 提示已整机制删除
    // （它原本只为补这个入口缺失区分而存在，与本处同时失去意义）。
    //
    // shader 区：GLSL 原样写入，不走 script 的 ES6→ES3 转译/换行整理管线。cleanScriptContent
    // 会把合法 GLSL 的 const 替换成 var、把紧凑单行 for 循环头拆行，导致预览区内容与
    // submit_shader 编译通过的原文不一致，保存到库后宿主编译失败。
    var area = (opts && (opts.area === 'shader' || opts.area === 'script')) ? opts.area : '';
    if (!area) return false;
    var isShaderPreview = (area === 'shader');
    var generatedScript = isShaderPreview
        ? String(script || '')
        : window.AEAgentApp.scriptUtils.cleanScriptContent(script || '');
    // shader 区写入独立 GLSL 编辑区（#shaderCodePreview），与 script 代码预览区（#scriptPreview）分离
    const preview = isShaderPreview
        ? document.getElementById('shaderCodePreview')
        : document.getElementById('scriptPreview');
    if (preview) {
        preview.value = generatedScript;
    }
    // shader 模式：submit_shader 后左抽屉实时预览/编译状态/滑块同步刷新。
    // 单例由 main.js getShaderUI 创建后暴露于 window.AEShaderUIInstance（未挂载/沙箱中为 undefined，安全跳过）。
    if (isShaderPreview) {
        var su = window.AEShaderUIInstance;
        if (su) {
            su.refreshPreviewFromCode(generatedScript);
            su.updateCompileStatus(generatedScript);
            su.renderUniforms((global.AEEffectLab && typeof global.AEEffectLab.parseUniforms === 'function')
                ? global.AEEffectLab.parseUniforms(generatedScript)
                : []);
        }
        // GLSL 语法高亮（统一增量引擎 glslHighlight.preview，与 script 共用；未就绪时保持纯文本）
        try {
            var pv = window.AEAgentApp && window.AEAgentApp.glslHighlight && window.AEAgentApp.glslHighlight.preview;
            if (pv && typeof pv.apply === 'function') {
                pv.apply(true);  // 整段写入：全量重建，着色与原文即时一致
            }
        } catch (_) {}
    }
    // GLSL 写入 shaderDraft（不写 script 的 previewDraft），也不走 script 的 prism 高亮
    if (!isShaderPreview) {
        try {
            saveSettings({
                ...cachedSettings,
                ...getCurrentSettingsFromUI(),
                previewDraft: generatedScript
            });
        } catch (_) {}
        togglePreviewDrawer(true);
        highlightCode(true);
    } else {
        // 提交即持久化 shaderDraft（与 main.js setPreviewCode 同款）：否则模块 unmount→重进时
        // applySettingsToUI → restorePreviewDraft 用旧 shaderDraft 回填 #shaderCodePreview，
        // 覆盖本次刚提交的 GLSL（表现为"提交的代码消失、退回旧代码"）
        try {
            saveSettings({
                ...cachedSettings,
                ...getCurrentSettingsFromUI(),
                shaderDraft: generatedScript
            });
        } catch (_) {}
        togglePreviewDrawer(true);
    }
    // 是否真的落进了目标区：目标元素缺失时返回 false，提交工具据此报错而不是回 passed
    // （跳过写入仍报成功会变成"回执描述的内容没进预览区"这类静默失败）
    return !!preview;
}



function normalizeScriptNameByPromptInput() {
    return showPrompt(AEI18n.t('请输入脚本名称（无需扩展名）'), 'generated_script').then((input) => {
        if (input === null) {
            return null;
        }
        var baseName = input.trim() || 'generated_script_' + Date.now();
        // 去掉可能的手动扩展名，_safeName 之后再统一加
        var stripped = baseName.replace(/\.(jsx|jsxbin)$/i, '');
        if (!_safeName(stripped)) {
            showStatus(AEI18n.t('脚本名称包含非法字符'), 'error', { autoHideMs: 4000 });
            return null;
        }
        return stripped + '.jsx';
    });
}


function loadPrismJs(callback) {
    if (llmPreviewHighlighter && typeof llmPreviewHighlighter.loadPrismJs === 'function') {
        llmPreviewHighlighter.loadPrismJs({
            getLoaded: () => prismLoaded,
            setLoaded: (v) => {
                prismLoaded = !!v;
            },
            getLoadAttempts: () => prismLoadAttempts,
            setLoadAttempts: (n) => {
                prismLoadAttempts = n;
            },
            updateStatus: (text) => {
                const prismStatus = document.getElementById('prismStatus');
                if (prismStatus) {
                    prismStatus.textContent = text;
                }
            },
            onReady: callback
        });
        return;
    }

    if (window.Prism && window.Prism.languages && window.Prism.languages.javascript) {
        if (callback) callback();
        return;
    }

    const prismStatus = document.getElementById('prismStatus');
    if (prismStatus) {
        prismStatus.textContent = 'Prism: waiting...';
    }

    let attempts = 0;
    const maxAttempts = 50;

    function checkPrism() {
        attempts++;

        if (window.Prism && window.Prism.languages && window.Prism.languages.javascript) {
            if (prismStatus) {
                prismStatus.textContent = 'Prism: ready!';
            }
            if (callback) callback();
        } else if (attempts < maxAttempts) {
            setTimeout(checkPrism, 100);
        } else {
            if (prismStatus) {
                prismStatus.textContent = 'Prism: unavailable';
            }
        }
    }

    checkPrism();
}


// ── 代码预览高亮：统一增量引擎（engine/hl-engine.js）──
// script 预览区（#scriptPreview）与 shader GLSL 编辑区（#shaderCodePreview）
// 共用同一份按行增量高亮引擎，避免两套高亮逻辑双维护。引擎语言无关，
// 通过参数注入元素访问与 Prism 语言（script=javascript）；Prism 缺失时经
// loadPrismJs 延迟加载重试。
var scriptPreviewHl = (global.AEAgentApp && global.AEAgentApp.hlEngine && global.AEAgentApp.hlEngine.create)
    ? global.AEAgentApp.hlEngine.create({
        getTextarea: function () { return document.getElementById('scriptPreview'); },
        getOverlay: function () { return document.getElementById('scriptHighlightCode'); },
        getWrap: function () { return document.getElementById('scriptPreviewWrap'); },
        getStatusEl: function () { return document.getElementById('prismStatus'); },
        getLanguage: function () { return (window.Prism && window.Prism.languages) ? window.Prism.languages.javascript : null; },
        getLanguageName: 'javascript',
        onPrismMissing: loadPrismJs
    })
    : null;

function highlightCode(forceReload) {
    if (scriptPreviewHl) scriptPreviewHl.apply(!!forceReload);
}

function syncScroll() {
    if (scriptPreviewHl) scriptPreviewHl.syncScroll();
}

// enforcePreviewFillHeight → main.js (uses global particle/layout state)
// _doEnforcePreviewFillHeight → main.js (uses global particle/layout state)

let prismLoaded = false;
let prismLoadAttempts = 0;


function bindPreviewResizeObservers() {
    const panelBody = document.querySelector('#moduleView .panel .panel-body');
    const scriptPreviewWrap = document.getElementById('scriptPreviewWrap');
    const sync = () => {
        if (typeof enforcePreviewFillHeight === 'function') enforcePreviewFillHeight();
    };

    if (typeof ResizeObserver === 'function') {
        if (panelBody) {
            let lastBodyW = Math.round(panelBody.clientWidth);
            let lastBodyH = Math.round(panelBody.clientHeight);
            const bodyRo = new ResizeObserver((entries) => {
                const entry = entries[0];
                const w = Math.round(entry.contentRect.width);
                const h = Math.round(entry.contentRect.height);
                if (w === lastBodyW && h === lastBodyH) return;
                lastBodyW = w;
                lastBodyH = h;
                sync();
            });
            bodyRo.observe(panelBody);
        }
        if (scriptPreviewWrap) {
            let lastPreviewW = Math.round(scriptPreviewWrap.clientWidth);
            let lastPreviewH = Math.round(scriptPreviewWrap.clientHeight);
            const previewRo = new ResizeObserver((entries) => {
                const entry = entries[0];
                const w = Math.round(entry.contentRect.width);
                const h = Math.round(entry.contentRect.height);
                if (w === lastPreviewW && h === lastPreviewH) return;
                lastPreviewW = w;
                lastPreviewH = h;
                sync();
            });
            previewRo.observe(scriptPreviewWrap);
        }
        // 输入框尺寸变化时同步粒子画布缓冲区，避免 canvas 内部像素尺寸
        // 与 CSS 尺寸脱节导致粒子被裁切（消息列表拖拽缩放等场景）
        const inputWrap = document.getElementById('aeAgentInputWrap');
        if (inputWrap) {
            let lastInputW = Math.round(inputWrap.clientWidth);
            let lastInputH = Math.round(inputWrap.clientHeight);
            const inputRo = new ResizeObserver(() => {
                const w = Math.round(inputWrap.clientWidth);
                const h = Math.round(inputWrap.clientHeight);
                if (w === lastInputW && h === lastInputH) return;
                lastInputW = w;
                lastInputH = h;
                if (typeof resizeParticleCanvas === 'function') {
                    resizeParticleCanvas();
                }
            });
            inputRo.observe(inputWrap);
        }
    }

    if (panelBody) {
        panelBody.addEventListener('transitionend', sync);
    }
    window.addEventListener('mouseup', () => sync());
}

// 绑定模块主要事件：生成功能、文件操作、设置弹窗与交互动画

function renumberFileChips() {
    var chips = document.getElementById('aeAgentFileChips');
    if (!chips) return;
    var items = chips.children;
    for (var i = 0; i < items.length; i++) {
        var chip = items[i];
        var isFolder = chip.getAttribute('data-type') === 'folder';
        var name = chip.getAttribute('data-name') || '';
        var idx = i + 1;
        chip.setAttribute('data-index', idx);
        // 标签按类型重编号（与 _appendFileChip 创建逻辑一致）：图片/视频 chip 不能
        // 降级为「文件N」；图标创建后不变，重写会把剪贴板图片的 🖼 覆盖成 📄
        var isVideo = !isFolder && /\.(mp4|mov|webm|m4v|mkv)$/i.test(name);
        var isImage = !isFolder && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(name);
        var label = chip.querySelector('.ae-agent-file-chip-label');
        if (label) {
            label.textContent = (isFolder ? AEI18n.t('\u6587\u4EF6\u5939')
                : isVideo ? AEI18n.t('\u89C6\u9891')
                : isImage ? AEI18n.t('\u56FE\u7247')
                : AEI18n.t('\u6587\u4EF6')) + idx;
        }
        var nameEl = chip.querySelector('.ae-agent-file-chip-name');
        if (nameEl) {
            nameEl.textContent = name;
        }
    }
}


function decodeHostResult(result) {
    if (result.indexOf('B64:') === 0) {
        var b64 = result.slice(4);
        try { b64 = decodeURIComponent(b64); } catch (_) {}
        if (window.cep && cep.encoding && cep.encoding.conversion && cep.encoding.conversion.b64_to_utf8) {
            return cep.encoding.conversion.b64_to_utf8(b64);
        }
        return decodeURIComponent(atob(b64).split('').map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); }).join(''));
    }
    if (result.indexOf('SUCCESS:') === 0) {
        return decodeURIComponent(result.slice('SUCCESS:'.length));
    }
    return result;
}


function buildDestPath(scriptDir, scriptName) {
    const normalizedDir = scriptDir.replace(/[\\/]+$/, '');
    return normalizedDir + '/' + scriptName;
}

// 重名检测：若 destPath 已存在，在文件名末尾（扩展名前）追加 _1、_2、_3 ... 直到找到不存在的路径。
// 返回最终可用路径；若 AEFS 不可用则原样返回 destPath（向后兼容）。
// 例：myscript.jsx 存在 → myscript_1.jsx → myscript_2.jsx ...
function dedupeDestPath(destPath) {
    if (typeof AEFS === 'undefined' || !AEFS.existsSync) return destPath;
    if (!AEFS.existsSync(destPath)) return destPath;
    var lastSep = Math.max(destPath.lastIndexOf('/'), destPath.lastIndexOf('\\'));
    var dir = lastSep >= 0 ? destPath.substring(0, lastSep) : '';
    var fileName = lastSep >= 0 ? destPath.substring(lastSep + 1) : destPath;
    var dotIdx = fileName.lastIndexOf('.');
    var base = dotIdx > 0 ? fileName.substring(0, dotIdx) : fileName;
    var ext = dotIdx > 0 ? fileName.substring(dotIdx) : '';
    var n = 1;
    var candidate;
    do {
        candidate = dir ? dir + '/' + base + '_' + n + ext : base + '_' + n + ext;
        n++;
    } while (AEFS.existsSync(candidate));
    return candidate;
}


    // updatePreviewParticleBrightness → main.js (uses global particle/layout state)


    function createLlmScriptService(deps) {
        return { deps: deps || {} };
    }

    function bind() {
        var saveBtn = document.getElementById("saveBtn");
        var runBtn = document.getElementById("runBtn");
        if (saveBtn) saveBtn.addEventListener("click", saveScript);
        if (runBtn) runBtn.addEventListener("click", runScript);
        // 错误反馈卡片按钮
        var feedbackBtn = document.getElementById("runErrorCardFeedback");
        var cancelBtn = document.getElementById("runErrorCardCancel");
        var closeBtn = document.getElementById("runErrorCardClose");
        if (feedbackBtn) feedbackBtn.addEventListener("click", feedbackToAI);
        if (cancelBtn) cancelBtn.addEventListener("click", hideRunErrorCard);
        if (closeBtn) closeBtn.addEventListener("click", hideRunErrorCard);
        bindPreviewResizeObservers();
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.createService = createLlmScriptService;
    global.AEAgentApp.llmService = {
        runScript: runScript, saveScript: saveScript, highlightCode: highlightCode,
        runScriptFileByPath: runScriptFileByPath,
        normalizeScriptNameByPromptInput: normalizeScriptNameByPromptInput,
        loadPrismJs: loadPrismJs, syncScroll: syncScroll,
        decodeHostResult: decodeHostResult,
        renumberFileChips: renumberFileChips,
        updatePreviewScriptFromAgent: updatePreviewScriptFromAgent,
        clearPreviewLineMarks: clearPreviewLineMarks,   // 编辑即清错误行内高亮（main.js input 回调）
        markProductPaneStale: markProductPaneStale,     // 产物 pane 过期标记（原文编辑后非实时）
        bind: bind
    };
})(window);
