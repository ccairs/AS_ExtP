// 斜杠命令自动补全
// 从 app/main.js 的 bindEvents 闭包拆出：
//   - 工厂接收 agentInput + 两个惰性回调（renderCodeChipOverlay / updatePreviewParticleBrightness）
//   - _slashHideTimer（失焦延迟隐藏）由本模块内部管理
(function (global) {
    function createSlashAutocomplete(opts) {
        var agentInput = opts.agentInput;
        var renderCodeChipOverlay = opts.renderCodeChipOverlay || function () {};
        var updatePreviewParticleBrightness = opts.updatePreviewParticleBrightness || function () {};
        var _slashHideTimer = null;

        var slashAutocomplete = document.createElement('div');
        slashAutocomplete.id = 'slash-autocomplete';
        slashAutocomplete.style.display = 'none';
        if (agentInput && agentInput.parentNode) {
            agentInput.parentNode.appendChild(slashAutocomplete);
        }

        function escapeHtml(text) {
            return String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function parseSlashInput(text) {
            if (!text || text.charAt(0) !== '/') return null;
            var rest = text.slice(1);
            var spaceIdx = rest.search(/[\s:]/);
            return {
                partial: spaceIdx === -1 ? rest : rest.slice(0, spaceIdx),
                rest: spaceIdx === -1 ? '' : rest.slice(spaceIdx + 1),
                // 是否已输入分隔符（空格/冒号）：为真表示命令名之后在填参数，走参数补全分支。
                // 未输入分隔符时保持旧行为：只补全命令名（`/goal` 回车仍是状态查询）。
                sep: spaceIdx !== -1
            };
        }

        function _cancelHide() {
            // 取消点击「/」按钮时由失焦触发的延迟隐藏，避免命令列表刚显示就被盖掉
            if (_slashHideTimer) {
                clearTimeout(_slashHideTimer);
                _slashHideTimer = null;
            }
        }

        function renderAutocomplete(items, partial) {
            slashAutocomplete.innerHTML = '';
            if (!items.length) {
                slashAutocomplete.style.display = 'none';
                return;
            }
            _cancelHide();
            for (var i = 0; i < items.length; i++) {
                var item = document.createElement('div');
                item.className = 'slash-autocomplete-item';
                if (i === 0) item.classList.add('selected');
                var cmdName = '/' + items[i].name;
                var matchEnd = partial ? partial.length + 1 : cmdName.length;
                item.innerHTML = '<span class="slash-cmd-name">' + escapeHtml(cmdName.slice(0, matchEnd)) + '</span>' +
                    '<span class="slash-cmd-rest">' + escapeHtml(cmdName.slice(matchEnd)) + '</span>' +
                    (items[i].description ? '<span class="slash-cmd-desc">' + escapeHtml(AEI18n.t(items[i].description)) + '</span>' : '');
                item.setAttribute('data-cmd', items[i].name);
                item.addEventListener('click', function (e) {
                    applyAutocompleteItem(e.currentTarget);
                });
                slashAutocomplete.appendChild(item);
            }
            slashAutocomplete.style.display = 'block';
        }

        // 参数（子命令）补全列表：命令名已精确输入且已有参数表时展示。
        // 点/键选中后整段替换成 `/<命令> <insert>`（data-insert 在渲染时算好；edit/limit 的
        // insert 带尾空格，光标落在末尾继续填目标文本/轮数）。
        function renderParamAutocomplete(items, cmdName, query) {
            slashAutocomplete.innerHTML = '';
            if (!items.length) {
                slashAutocomplete.style.display = 'none';
                return;
            }
            _cancelHide();
            var q = String(query == null ? '' : query).replace(/^\s+|\s+$/g, '').toLowerCase();
            for (var i = 0; i < items.length; i++) {
                var p = items[i];
                var item = document.createElement('div');
                item.className = 'slash-autocomplete-item';
                if (i === 0) item.classList.add('selected');
                var label = String(p.name);
                // 无查询词（刚输入 `/goal `）时整段放进高亮色 .slash-cmd-name——`.slash-cmd-rest`
                // 是暗灰色（用于命令名未输入部分），整段落进去会让参数名一上来就是灰的；
                // 有查询词时命中前缀高亮、剩余部分灰显。
                var hlLen = q ? Math.min(q.length, label.length) : label.length;
                item.innerHTML = '<span class="slash-cmd-name">' + escapeHtml(label.slice(0, hlLen)) + '</span>' +
                    '<span class="slash-cmd-rest">' + escapeHtml(label.slice(hlLen)) + '</span>' +
                    (p.description ? '<span class="slash-cmd-desc">' + escapeHtml(AEI18n.t(p.description)) + '</span>' : '');
                item.setAttribute('data-cmd', cmdName);
                item.setAttribute('data-insert', '/' + cmdName + ' ' + (p.insert || p.name));
                item.addEventListener('click', function (e) {
                    applyAutocompleteItem(e.currentTarget);
                });
                slashAutocomplete.appendChild(item);
            }
            slashAutocomplete.style.display = 'block';
        }

        function applyAutocompleteItem(targetEl) {
            targetEl = targetEl || slashAutocomplete.querySelector('.slash-autocomplete-item.selected');
            if (!targetEl) return;
            var parsed = parseSlashInput(agentInput.value);
            var insertAttr = targetEl.getAttribute('data-insert');
            var isParamItem = !!insertAttr;
            var newVal = insertAttr;
            if (!newVal) {
                var cmdName = targetEl.getAttribute('data-cmd');
                // 命令名补全：有分隔符时保留"命令 + 空格 + 已输入参数"，否则保持旧的补位行为
                newVal = '/' + cmdName + (parsed && (parsed.sep || parsed.rest) ? ' ' + parsed.rest : '');
            }
            // execCommand 全选替换：补全进入撤销栈，Ctrl+Z 可撤回，且不破坏既有撤销历史
            agentInput.focus();
            var replaced = false;
            try {
                agentInput.setSelectionRange(0, agentInput.value.length);
                replaced = document.execCommand('insertText', false, newVal);
            } catch (_) {}
            if (!replaced) {
                agentInput.value = newVal;
            }
            hideAutocomplete();
            agentInput.focus();
            renderCodeChipOverlay();
            updatePreviewParticleBrightness();
            // 命令名补全且带出了分隔符（如 `/go ` → `/goal `）时，直接接着展示该命令的
            // 参数补全，少按一次键就能看到 edit/pause/…（无参数表的命令保持收起）。
            if (!isParamItem && newVal.charAt(newVal.length - 1) === ' ') {
                handleSlashInput();
            }
        }

        function moveAutocompleteSelection(delta) {
            var items = slashAutocomplete.querySelectorAll('.slash-autocomplete-item');
            if (!items.length) return;
            var selectedIdx = -1;
            for (var i = 0; i < items.length; i++) {
                if (items[i].classList.contains('selected')) {
                    selectedIdx = i;
                    items[i].classList.remove('selected');
                    break;
                }
            }
            var newIdx = selectedIdx + delta;
            if (newIdx < 0) newIdx = items.length - 1;
            if (newIdx >= items.length) newIdx = 0;
            items[newIdx].classList.add('selected');
        }

        function hideAutocomplete() {
            slashAutocomplete.innerHTML = '';
            slashAutocomplete.style.display = 'none';
        }

        function handleSlashInput() {
            var text = agentInput.value;
            if (text.charAt(0) !== '/') {
                hideAutocomplete();
                return;
            }
            var parsed = parseSlashInput(text);
            if (!parsed) {
                hideAutocomplete();
                return;
            }
            var slashApi = window.AEEngine && window.AEEngine.slashCommands;
            // 已输入分隔符（`/goal `、`/goal pa`）且命令名精确命中 → 参数补全。
            // 命令名不完整（`/go `）时回落到命令名补全，让用户先把命令名补完。
            if (parsed.sep && slashApi && typeof slashApi.matchParams === 'function') {
                var params = slashApi.matchParams(parsed.partial, parsed.rest);
                if (params.length) {
                    renderParamAutocomplete(params, parsed.partial, parsed.rest);
                    positionAutocomplete();
                    return;
                }
            }
            var matches = slashApi ? slashApi.match('/' + parsed.partial) : [];
            if (matches.length === 1 && matches[0].name === parsed.partial) {
                hideAutocomplete();
                return;
            }
            renderAutocomplete(matches, parsed.partial);
            positionAutocomplete();
        }

        function positionAutocomplete() {
            var inputRect = agentInput.getBoundingClientRect();
            var wrapRect = agentInput.parentNode.getBoundingClientRect();
            slashAutocomplete.style.left = (inputRect.left - wrapRect.left) + 'px';
            slashAutocomplete.style.bottom = (wrapRect.bottom - inputRect.top + 4) + 'px';
            slashAutocomplete.style.minWidth = inputRect.width + 'px';
        }

        // blur 延迟隐藏：存内部 ID，避免点击「/ 命令」按钮时冒出的旧定时器把刚显示的命令列表又盖掉
        function scheduleHide(delay) {
            if (_slashHideTimer) clearTimeout(_slashHideTimer);
            _slashHideTimer = setTimeout(hideAutocomplete, delay || 200);
        }

        return {
            dom: slashAutocomplete,
            handleSlashInput,
            hideAutocomplete,
            applyAutocompleteItem,
            moveAutocompleteSelection,
            positionAutocomplete,
            scheduleHide
        };
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.createSlashAutocomplete = createSlashAutocomplete;
})(window);
