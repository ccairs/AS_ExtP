(function() {
    'use strict';

    var queue = [];
    var barEl = null;
    var logEl = null;
    var MAX_LINES = 200;
    var MAX_LINE_LEN = 2000;
    var isEnabled = false;

    try {
        var raw = localStorage.getItem('ae_llm_tool_settings_v3');
        if (raw) {
            var parsed = JSON.parse(raw);
            // 权威位置是 global.debugMode（settingsStore 写入处；旧形状的顶层 debugMode
            // 由 settingsStore.js:249 迁移进 global.*）。必须以 global 为准——
            // 若写成 `parsed.debugMode || parsed.global.debugMode`，**残留的旧顶层字段
            // 能把日志栏单独打开**，而设置界面与运行时 statusState 读的是 global，出现
            // 「设置显示关闭、底栏却开着」的矛盾（实机包内即为此现象）。
            //
            // 判据是「**global 命名空间是否存在**」而不是「global.debugMode 是否为布尔」：
            // 后者会在 global 存在但字段缺失时又回退到残留顶层字段，等于把同一个口子留着。
            // 迁移后的存储里 global.debugMode 恒为布尔（保存路径始终带上它），故 global 存在
            // 即视为已迁移、顶层一律忽略。仅当前者为完全不存在 global 时按迁移前旧数据兼容。
            if (parsed.global) {
                isEnabled = parsed.global.debugMode === true;
            } else {
                isEnabled = parsed.debugMode === true;
            }
        }
    } catch (e) {}

    function timeStr() {
        var d = new Date();
        var pad = function(n) { return (n < 10 ? '0' : '') + n; };
        return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    }

    // 复制到剪贴板前的脱敏：密钥模式打码、Windows 路径用户名段隐藏
    // （仅用于外发文本；屏幕渲染保持原文，避免干扰调试）
    //
    // 四种形态的补充不改变判据：
    // 只在「值长得像密钥」时才打码，宁可漏掉不像密钥的，也不吃掉正常日志文本——脱敏过的
    // 诊断包用户自己也会看，误伤会让日志失去诊断价值。四种形态各自的边界：
    //   · AIza：Google 风格键不带 sk- 前缀，旧模式整条漏掉；
    //   · Basic：旧 Bearer 规则不覆盖 Basic 凭据；
    //   · session/secret/credential 名（如本项目自定义头 x-opencode-session）：名字里不含
    //     token/key 词根，旧三条键名规则都不命中。值须 ≥8 位且含数字或 ≥20 位，否则
    //     `session: restored successfully` 这种英文日志会被误吃（真机语料零命中已验）；
    //   · URL 内嵌凭据 https://user:pw@host。
    function redact(text) {
        return text
            .replace(/sk-[A-Za-z0-9_-]{8,}/gi, 'sk-***')
            .replace(/Bearer\s+\S+/gi, 'Bearer ***')
            // 键名后允许一个**收尾引号**：JSON 形态 {"apiKey": "…"} / {"access_token":"…"} 里
            // 键名与冒号之间隔着引号，旧三条规则（键名后必须紧跟空白/冒号）整条漏掉——
            // 脱敏盲区。引号可选，非 JSON 的 `api_key: v` 形态行为逐字不变。
            .replace(/(api[_-]?key["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(token["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(password["']?\s*[:=])\s*\S+/gi, '$1***')
            .replace(/(Authorization[ \t]*:[ \t]*Basic[ \t]+)\S+/gi, '$1***')
            .replace(/AIza[0-9A-Za-z_-]{20,}/g, 'AIza***')
            .replace(/([A-Za-z0-9-]*(?:session|secret|credential)[A-Za-z0-9-]*["']?[ \t]*[:=][ \t]*)(["']?)(?=[A-Za-z0-9._\-+/=]{8,})(?:[A-Za-z0-9._\-+/=]*\d[A-Za-z0-9._\-+/=]*|[A-Za-z0-9._\-+/=]{20,})/gi, '$1$2***')
            .replace(/(\/\/)[A-Za-z0-9._%\-]{1,64}:[^\s@\/]{1,64}@/g, '$1***@')
            .replace(/([A-Za-z]:[\\/])Users[\\/][^\\/\s]+/gi, '$1Users\\<user>');
    }

    // 格式化与**落盘**不受 debugMode 门控：用户出问题时不会先开 DEBUG 再复现，
    // 而面板重载会销毁 JS 上下文（无可靠的 flush 时机），所以「常开落盘」是
    // 「导出诊断包」能作为支持手段的前提（见 shared/diagLog.js）。
    // 底栏渲染仍只在 debugMode 下进行。
    function addLine(level, args) {
        var msg = '';
        for (var i = 0; i < args.length; i++) {
            try {
                msg += (typeof args[i] === 'object' ? (args[i] instanceof Error ? (args[i].message || String(args[i])) : JSON.stringify(args[i])) : String(args[i]));
            } catch (e) {
                msg += '[object]';
            }
            if (i < args.length - 1) msg += ' ';
        }
        if (msg.length > MAX_LINE_LEN) msg = msg.slice(0, MAX_LINE_LEN) + '…[truncated]';

        try {
            var dl = (typeof window !== 'undefined') && window.AEDiagLog;
            if (dl && typeof dl.append === 'function') dl.append(level, msg);
        } catch (_) {}

        if (!isEnabled) return;
        var text = timeStr() + ' ' + msg;
        queue.push({ level: level, text: text });
        if (queue.length > MAX_LINES) queue.shift();
        renderLine(level, text);
    }

    function renderLine(level, text) {
        if (!logEl || !isEnabled) return;
        var div = document.createElement('div');
        div.style.cssText = 'margin:0;padding:0;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.4;'
            + (level === 'ERROR' ? 'color:#ff6b6b;' : level === 'WARN' ? 'color:#ffd93d;' : 'color:#ccc;');
        div.textContent = text;
        logEl.appendChild(div);

        var lines = logEl.children;
        while (lines.length > MAX_LINES) {
            logEl.removeChild(lines[0]);
        }
        logEl.scrollTop = logEl.scrollHeight;
    }

    // —— 模态打开时抽屉让位 ——
    // 抽屉 z-index 高于 .modal-mask(100)，展开时会盖住对话框底部按钮（设置对话框的
    // 「保存模块设置」实测点不到：点下去命中抽屉的文本 div）。模态没有统一开关函数
    //（各模块各自 style.display/class 切换），故用 MutationObserver 侦测"任一
    // .modal-mask 可见"；回调按 rAF 合并（日志 append 本身高频触发 mutation，逐条
    // 重算太贵），且只在值变化时赋值（避免自身 style 改动触发回环）。
    // 让位 = display:none（而非降层级：抽屉压到 QuickBar 之下会让收起后的标题条
    // 被 QuickBar 盖住，再也展不开）。
    function anyModalOpen() {
        if (typeof document === 'undefined' || !document.querySelectorAll) return false;
        var masks;
        try { masks = document.querySelectorAll('.modal-mask, [class*="modal-mask"]'); } catch (_) { return false; }
        for (var i = 0; i < masks.length; i++) {
            var el = masks[i];
            if (!el || !el.style || el.style.display === 'none') continue;
            try {
                if (typeof getComputedStyle !== 'function' || getComputedStyle(el).display !== 'none') return true;
            } catch (_) { return true; }
        }
        return false;
    }
    function syncDrawerYield() {
        if (!barEl) return;
        // 恢复值必须是 'flex'（初始 display 由 cssText 设成 flex，置空会丢掉它）
        var want = anyModalOpen() ? 'none' : 'flex';
        if (barEl.style.display !== want) barEl.style.display = want;
    }
    function bindDrawerYield() {
        if (typeof MutationObserver !== 'function' || typeof document === 'undefined' || !document.body) return;
        var scheduled = false;
        function schedule() {
            if (scheduled) return;
            scheduled = true;
            var run = function () { scheduled = false; syncDrawerYield(); };
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
            else setTimeout(run, 100);
        }
        try {
            new MutationObserver(schedule).observe(document.body, {
                childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style']
            });
        } catch (_) { /* 观测失败就退化为"不自动让位"，不影响抽屉本身 */ }
        syncDrawerYield();
    }

    function initBar() {
        if (barEl) return;
        if (!isEnabled) return;
        // Node 下（本文件导出 module.exports 供单测直接断言）没有 document：
        // 若 localStorage 里 debugMode 为真，加载期会 setTimeout(initBar) —— 定时器在
        // **测试进行中**才触发，此处直接抛 ReferenceError 会让整个测试进程崩掉
        //（不是断言失败，是进程退出）。与文件内其它处一致加环境守卫。
        if (typeof document === 'undefined') return;
        if (!document.body) { setTimeout(initBar, 50); return; }

        barEl = document.createElement('div');
        barEl.id = '__ae_debug_bar__';
        // z-index 99999：抽屉在 QuickBar(9998)/右键菜单(10010) 之上，双击标题才点得到
        //（早期把它压到模态之下试过——QuickBar 就把收起后的 22px 标题条盖住，再也展不开）。
        // 模态（.modal-mask = 100）比它低，靠**模态打开时让位**解决，见下方 syncDrawerYield：
        // 抽屉展开会盖住设置对话框的「保存模块设置」按钮连同底部输入区，点不到
        //（实测：保存设置必须先双击收起抽屉）。
        barEl.style.cssText =
            'position:fixed;bottom:0;left:0;right:0;z-index:99999;' +
            'background:#1a1a2e;border-top:2px solid #e94560;' +
            'font-family:Consolas,monospace;display:flex;flex-direction:column;';

        var header = document.createElement('div');
        header.style.cssText =
            'background:#16213e;padding:3px 8px;' +
            'font-size:11px;font-weight:bold;user-select:none;' +
            'display:flex;align-items:center;justify-content:space-between;';
        // 收起态持久化：面板重载后不会"自己弹回来"。不持久化时，"刚重载面板
        // 就改设置"这条最自然的路径必然撞上抽屉盖住模态按钮（见上方 z-index 注释）。
        // 键独立于 debugMode（那是"日志功能开关"，这是"抽屉显不显示"两回事）。
        var DRAWER_COLLAPSED_KEY = 'ae_debug_drawer_collapsed';
        function readDrawerCollapsed() {
            try { return localStorage.getItem(DRAWER_COLLAPSED_KEY) === '1'; } catch (_) { return false; }
        }
        function writeDrawerCollapsed(hidden) {
            try { localStorage.setItem(DRAWER_COLLAPSED_KEY, hidden ? '1' : '0'); } catch (_) {}
        }
        header.ondblclick = function() {
            var body = document.getElementById('__ae_debug_body__');
            if (body) {
                body.style.display = body.style.display === 'none' ? '' : 'none';
                writeDrawerCollapsed(body.style.display === 'none');
            }
        };

        var titleSpan = document.createElement('span');
        titleSpan.textContent = AEI18n.t('\u25BC DEBUG LOG (\u53CC\u51FB\u9690\u85CF)');
        titleSpan.style.cssText = 'color:#e94560;cursor:pointer;';
        header.appendChild(titleSpan);

        var btnGroup = document.createElement('span');
        btnGroup.style.cssText = 'display:flex;align-items:center;gap:8px;flex-shrink:0;';
        header.appendChild(btnGroup);

        barEl.appendChild(header);

        var body = document.createElement('div');
        body.id = '__ae_debug_body__';
        body.style.cssText = 'max-height:200px;overflow-y:auto;padding:2px 8px;';
        barEl.appendChild(body);
        document.body.appendChild(barEl);
        // 上次收起过就保持收起（默认仍是展开——用户没表态前不改既有观感）
        if (readDrawerCollapsed()) body.style.display = 'none';
        bindDrawerYield();

        function _makeHeaderBtn(text, title, color, onClick) {
            var btn = document.createElement('span');
            btn.textContent = text;
            btn.title = title;
            btn.style.cssText = 'color:' + color + ';cursor:pointer;font-size:13px;line-height:1;';
            btn.onclick = function(e) { e.stopPropagation(); onClick(); };
            return btn;
        }

        var copyBtn = _makeHeaderBtn('\u2398', AEI18n.t('\u590d\u5236\u65e5\u5fd7'), '#aaa', function() {
            var text = '';
            for (var i = 0; i < queue.length; i++) { text += redact(queue[i].text) + '\n'; }
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); } catch (ex) {}
            document.body.removeChild(ta);
            copyBtn.textContent = '\u2713';
            copyBtn.style.color = '#4ecdc4';
            setTimeout(function() {
                copyBtn.textContent = '\u2398';
                copyBtn.style.color = '#aaa';
            }, 800);
        });
        btnGroup.appendChild(copyBtn);

        var clearBtn = _makeHeaderBtn('\u2715', AEI18n.t('\u6e05\u7a7a\u65e5\u5fd7'), '#aaa', function() {
            if (logEl) logEl.innerHTML = '';
            queue = [];
        });
        clearBtn.addEventListener('mouseenter', function() { clearBtn.style.color = '#ff6b6b'; });
        clearBtn.addEventListener('mouseleave', function() { clearBtn.style.color = '#aaa'; });
        btnGroup.appendChild(clearBtn);

        logEl = body;

        for (var i = 0; i < queue.length; i++) {
            renderLine(queue[i].level, queue[i].text);
        }
    }

    function destroyBar() {
        if (barEl && barEl.parentNode) {
            barEl.parentNode.removeChild(barEl);
        }
        barEl = null;
        logEl = null;
    }

    function enable() {
        if (isEnabled) return;
        isEnabled = true;
        // Node 下无 DOM：只翻开关，不建底栏（同 initBar 的环境守卫）
        if (typeof document === 'undefined') return;
        if (!barEl && document.body) {
            initBar();
        } else if (!barEl && !document.body) {
            setTimeout(initBar, 50);
        } else if (barEl) {
            barEl.style.display = '';
        }
    }

    function disable() {
        isEnabled = false;
        destroyBar();
    }

    var api = {
        enable: enable,
        disable: disable,
        isEnabled: function() { return isEnabled; },
        redact: redact,
        // verbose 环快照：供诊断包收录（debugMode 关闭时为空数组，不影响导出流程）
        snapshot: function() { return queue.slice(); }
    };
    if (typeof window !== 'undefined') window.__aeDebugLogger = api;
    // Node 单测可 require 本文件直接断言 redact（CEP 下不影响原有全局导出）
    if (typeof module !== 'undefined' && module.exports) module.exports = api;

    // 面板日志常开落盘 + 外部日志体积收敛（不受 debugMode 门控）
    try {
        if (typeof window !== 'undefined' && window.AEDiagLog
            && typeof window.AEDiagLog.start === 'function') {
            window.AEDiagLog.start();
        }
    } catch (_) {}

    if (isEnabled) {
        setTimeout(initBar, 100);
    }

    var _console = typeof console !== 'undefined' ? console : null;
    if (_console) {
        var _origLog = _console.log ? _console.log.bind(_console) : function() {};
        var _origWarn = _console.warn ? _console.warn.bind(_console) : _origLog;
        var _origError = _console.error ? _console.error.bind(_console) : _origLog;

        _console.log = function() {
            _origLog.apply(_console, arguments);
            try { addLine('LOG', arguments); } catch (e) {}
        };
        _console.warn = function() {
            _origWarn.apply(_console, arguments);
            try { addLine('WARN', arguments); } catch (e) {}
        };
        _console.error = function() {
            _origError.apply(_console, arguments);
            try { addLine('ERROR', arguments); } catch (e) {}
        };
    }

    if (isEnabled) {
        addLine('LOG', ['=== DEBUG LOGGER ACTIVE ===']);
    }
})();
