// 输入框 @ 文件引用补全
//
// 输入 @ 后按文件名补全，把已拖进输入区的文件引用进消息。
// 候选来源 = **当前输入区的附件 chip**（#aeAgentFileChips，拖拽/上传/粘贴三入口进来、还没发出去的那些）：
// 引用的是"随这条消息一起发出去的文件"，附件被清空后没有可引的东西，故不列历史附件。
//
// 落在输入框里的东西与图层引用同构：一个 chip token（\u200b 定界 + 内边距），
// 语法见 utils/chipTokens.js（file 分支）——所以光标不可进入 token 内部、退格整体删除、
// 点击标签删除、发送时原位解析成「（引用文件N：名，路径 …）」全部复用既有机制，本模块只管补全交互。
// token 的**名即身份**（载荷里不放序号/路径，理由见 chipTokens.buildFileToken 注释）。
//
// 与 / 命令补全（slashAutocomplete.js）的关系：两套弹层互斥——都在输入框上方同一位置弹出。
// 判定顺序在 main.js 的 input 处理里：先问本模块（@ 是光标处的具体意图），本模块开则 / 命令列表收。
(function (global) {
    // 弹层位置与 / 命令列表同款（贴输入框上沿、同宽），两套补全看起来是同一件东西
    var MAX_LOOKBACK = 60;     // 从光标向前找 @ 的最大距离（一行里 @ 离得太远就不是"正在输入引用"）
    var PREV_BLOCK_RE = /[A-Za-z0-9._%+-]/;   // @ 前若是这些字符按普通文本处理（邮箱/URL/单词里的 @）

    // 纯函数①：从（文本, 光标）解析"当前正在输入的 @ 引用"。
    // 返回 { start, partial }（start = @ 的下标，partial = @ 与光标之间的已输入串）或 null。
    // 判据：
    //   · 只认**光标处**正在输入的那一个 @（从光标向前找，路上遇到空白/零宽定界符就停——那是上个词/上个 chip）；
    //   · @ 前一个字符若是 ASCII 字母/数字/._%+- 则不算触发（"a@b.com" 里的 @ 不该弹文件列表）；
    //     中文（"看@测试"）没有空格分隔，不在这条禁令里，照常触发；
    //   · partial 里的任何换行/空白都已在向后扫描时排除，故 partial 一定不含空白。
    function parseMentionInput(text, caret) {
        var s = String(text == null ? '' : text);
        var pos = (caret == null) ? s.length : Math.floor(Number(caret));
        if (!(pos >= 0)) return null;
        if (pos > s.length) pos = s.length;
        var floor = pos - MAX_LOOKBACK;
        if (floor < 0) floor = 0;
        for (var i = pos - 1; i >= floor; i--) {
            var ch = s.charAt(i);
            if (ch === '@') {
                var prev = i > 0 ? s.charAt(i - 1) : '';
                if (prev && PREV_BLOCK_RE.test(prev)) return null;
                return { start: i, partial: s.slice(i + 1, pos) };
            }
            if (ch === ' ' || ch === '\u00A0' || ch === '\u200b'
                || ch === '\n' || ch === '\r' || ch === '\t') return null;
        }
        return null;
    }

    // 纯函数②：候选排序。三档——名以关键词开头 → 名内出现 → 只在路径（目录）里出现；
    // 同档保持数据原序（= 附件在输入区的顺序），不做二次排序/打分：
    // 附件通常只有几个，"打完字就能看见要的那条"靠的是档位，不是分数。
    // 档位按**逐条算一次**再分桶（不是每档重扫一遍）：名以关键词开头的条目同时也"含关键词"，
    // 分档条件若不互斥会把它收进两个档 → 候选列表里同一条出现两次。
    function rankFiles(files, partial) {
        var list = Array.isArray(files) ? files : [];
        var q = String(partial == null ? '' : partial).toLowerCase();
        if (!q) return list.slice();
        var out = [];
        for (var tier = 0; tier < 3; tier++) {
            for (var i = 0; i < list.length; i++) {
                var f = list[i] || {};
                var name = String(f.name || '').toLowerCase();
                var path = String(f.path || '').toLowerCase();
                var nameIdx = name.indexOf(q);
                var at = nameIdx === 0 ? 0                    // 名以关键词开头
                    : nameIdx > 0 ? 1                         // 名内出现
                    : (path.indexOf(q) >= 0 ? 2 : -1);        // 只在路径里
                if (at === tier) out.push(list[i]);
            }
        }
        return out;
    }

    // files 条目（由 app 层从附件 chip 读出）：{ name, path }
    //   name —— chip 的 data-name（身份，进 token 载荷；与 [引用文件] 块里的名同一来源）
    //   path —— chip 的 data-path（弹层第二行显示，绑定时做行内省略；'(clipboard)' 这类占位不当路径展示）
    // 行内不放类型图标：曾按类型给 emoji（🖼/🎥/📁/📄），在面板这层子树里字体回退把它们落成认不出的
    // 单色字形（用户实测：「那个奇奇怪怪的图形是什么」）。类型信息由扩展名与上方附件 chip 的标签给，
    // 候选行只留名 + 路径。
    function createFileMentions(opts) {
        opts = opts || {};
        var agentInput = opts.agentInput;
        var listFiles = typeof opts.listFiles === 'function' ? opts.listFiles : function () { return []; };
        var insertToken = typeof opts.insertToken === 'function' ? opts.insertToken : function () { return false; };
        var _hideTimer = null;
        var _composing = false;     // 输入法组字中（组字期间的值是拼音串，按它过滤会把候选清空）
        var _open = false;

        var listEl = document.createElement('div');
        listEl.id = 'file-mention-list';
        listEl.style.display = 'none';
        if (agentInput && agentInput.parentNode) {
            agentInput.parentNode.appendChild(listEl);
        }

        // 路径只在弹层里做显示，'(clipboard)' 这类非路径占位不展示（剪贴板图片没有落盘路径）
        function _displayPath(path) {
            var p = String(path || '');
            if (!p || p.charAt(0) === '(') return '';
            return p;
        }

        function render(items) {
            listEl.innerHTML = '';
            for (var i = 0; i < items.length; i++) {
                var f = items[i] || {};
                var row = document.createElement('div');
                row.className = 'file-mention-item' + (i === 0 ? ' selected' : '');
                row.setAttribute('data-name', String(f.name || ''));
                // 名与路径一律 textContent（用户数据，防注入；与图层 chip hover 浮层同款口径）
                var nameEl = document.createElement('span');
                nameEl.className = 'file-mention-name';
                nameEl.textContent = f.name || '';
                row.appendChild(nameEl);
                var shownPath = _displayPath(f.path);
                if (shownPath) {
                    var pathEl = document.createElement('span');
                    pathEl.className = 'file-mention-path';
                    pathEl.textContent = shownPath;
                    row.appendChild(pathEl);
                }
                // mousedown 阻止默认：点击候选不该把焦点/光标从输入框抢走——插入位置就是当前光标，
                // 焦点一转走（blur）光标就没了，插入会落到文本尾部。
                row.addEventListener('mousedown', function (e) { e.preventDefault(); });
                row.addEventListener('click', function (e) {
                    applyItem(e.currentTarget);
                });
                listEl.appendChild(row);
            }
            _open = true;
            listEl.style.display = 'block';
            position();
        }

        function position() {
            if (!agentInput || !agentInput.parentNode) return;
            var inputRect = agentInput.getBoundingClientRect();
            var wrapRect = agentInput.parentNode.getBoundingClientRect();
            listEl.style.left = (inputRect.left - wrapRect.left) + 'px';
            listEl.style.bottom = (wrapRect.bottom - inputRect.top + 4) + 'px';
            // 宽用**定量 width**、不是 min-width：绝对定位元素只给 min-width 时，收缩到合适的宽度
            // 按 max-content 取（长路径会让弹层宽成内容宽——实测 380px 的输入框里弹出 766px 的列表，
            // 撑破面板）。定量后行内 flex 才真正受约束，长名/长路径走各自的省略号。
            // 取值 = 输入框自身的宽（与 / 命令列表同一视觉宽度）。
            listEl.style.width = inputRect.width + 'px';
        }

        function hide() {
            if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
            listEl.innerHTML = '';
            listEl.style.display = 'none';
            _open = false;
        }

        function scheduleHide(delay) {
            if (_hideTimer) clearTimeout(_hideTimer);
            _hideTimer = setTimeout(hide, delay || 200);
        }

        function isVisible() { return _open; }

        function selectedEl() {
            return listEl.querySelector('.file-mention-item.selected');
        }

        function moveSelection(delta) {
            var items = listEl.querySelectorAll('.file-mention-item');
            if (!items.length) return;
            var idx = -1;
            for (var i = 0; i < items.length; i++) {
                if (items[i].classList.contains('selected')) { idx = i; break; }
            }
            var next = idx + delta;
            if (next < 0) next = items.length - 1;
            if (next >= items.length) next = 0;
            for (var k = 0; k < items.length; k++) {
                if (k === next) items[k].classList.add('selected');
                else items[k].classList.remove('selected');
            }
            // 选中行滚进视野（候选人多了列表会滚；不滚就会"看不见选中的是哪条"）
            try { items[next].scrollIntoView({ block: 'nearest' }); } catch (_) {}
        }

        // 选中一条候选：把「@ + 已输入串」整段换成 file token（插入交给 app 层，撤销语义与其它 chip 一致）。
        // 触发点按**当下的光标**重算（列表可能是上一拍渲染的）：用户已把光标移走/删掉 @ 时只关闭列表，
        // 不按旧位置硬插（插错位置比不插更坏）。
        function applyItem(targetEl) {
            var row = targetEl || selectedEl();
            if (!row) { hide(); return false; }
            var name = row.getAttribute('data-name') || '';
            if (!name || !agentInput) { hide(); return false; }
            var caret = agentInput.selectionStart;
            if (caret == null) caret = agentInput.value.length;
            var parsed = parseMentionInput(agentInput.value, caret);
            hide();
            if (!parsed) return false;
            return insertToken(name, { start: parsed.start, end: caret }) !== false;
        }

        // 输入变化后重算候选。返回是否开着列表（供调用方决定 / 命令列表要不要让位）。
        function checkInput() {
            if (!agentInput) return false;
            if (_composing) return _open;
            var files = listFiles() || [];
            if (!files.length) { hide(); return false; }
            var caret = agentInput.selectionStart;
            if (caret == null) caret = agentInput.value.length;
            var parsed = parseMentionInput(agentInput.value, caret);
            if (!parsed) { hide(); return false; }
            var matches = rankFiles(files, parsed.partial);
            if (!matches.length) { hide(); return false; }
            render(matches);
            return true;
        }

        // 键盘处理（在输入框 keydown 里最先调用）。返回 true = 本次按键已被补全列表消费。
        function handleKeydown(e) {
            if (!_open || !e) return false;
            // 输入法候选确认（Enter/Tab 用于上屏）不当作选择，交回默认路径
            if (_composing || e.isComposing) return false;
            if (e.key === 'Tab' || e.key === 'Enter') {
                e.preventDefault();
                applyItem();
                return true;
            }
            if (e.key === 'ArrowDown') { e.preventDefault(); moveSelection(1); return true; }
            if (e.key === 'ArrowUp') { e.preventDefault(); moveSelection(-1); return true; }
            if (e.key === 'Escape') { e.preventDefault(); hide(); return true; }
            return false;
        }

        if (agentInput) {
            // 组字期间不重算（值是拼音串），组字结束后补算一次——否则打完中文名要再敲一下才出候选。
            // setTimeout 0：compositionend 与随之而来的 input 事件先后次序在各版本 CEF 不一，
            // 等一拍再读值，读到的一定是上屏后的文本。
            agentInput.addEventListener('compositionstart', function () { _composing = true; });
            agentInput.addEventListener('compositionend', function () {
                _composing = false;
                setTimeout(function () { checkInput(); }, 0);
            });
        }

        return {
            dom: listEl,
            checkInput: checkInput,
            handleKeydown: handleKeydown,
            applyItem: applyItem,
            moveSelection: moveSelection,
            hide: hide,
            scheduleHide: scheduleHide,
            isVisible: isVisible
        };
    }

    // 纯函数挂在工厂上：面板侧只挂这一个全局名，单测可直接取用（不必构造 DOM）
    createFileMentions.parseMentionInput = parseMentionInput;
    createFileMentions.rankFiles = rankFiles;
    createFileMentions.MAX_LOOKBACK = MAX_LOOKBACK;

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.createFileMentions = createFileMentions;
})(window);
