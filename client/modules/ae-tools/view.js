(function(global) {

    function escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 单趟状态机剥离注释与字符串字面量（与 aeToolCreator.js 同名函数
    // 逐字一致，两处同步防漂移）——链式替换无论「先注释后字符串」还是「先字符串
    // 后注释」各有盲区（前者把字符串内的 // 当行注释起点，后者被注释里的撇号
    // 误配对），单趟扫描同时跟踪字符串/注释上下文两侧都正确。未闭合的块注释/
    // 字符串保留原文（保守交给括号计数暴露异常）。
    function _stripCommentsAndStrings(code) {
        var out = [];
        var n = code.length;
        var i = 0;
        while (i < n) {
            var c = code.charAt(i);
            var c2 = (i + 1 < n) ? code.charAt(i + 1) : '';
            if (c === '/' && c2 === '*') {
                var bcEnd = code.indexOf('*/', i + 2);
                if (bcEnd === -1) { out.push(code.slice(i)); break; }   // 未闭合：保留原文
                i = bcEnd + 2;
                continue;
            }
            if (c === '/' && c2 === '/') {
                var nl = code.indexOf('\n', i + 2);
                if (nl === -1) break;   // 行注释吞到末尾
                i = nl;   // 保留换行（行结构不影响计数）
                continue;
            }
            if (c === '"' || c === "'") {
                var j = i + 1;
                while (j < n) {
                    var cj = code.charAt(j);
                    if (cj === '\\') { j += 2; continue; }
                    if (cj === c) break;
                    j++;
                }
                if (j >= n) { out.push(code.slice(i)); break; }   // 未闭合：保留原文
                i = j + 1;
                continue;
            }
            out.push(c);
            i++;
        }
        return out.join('');
    }

    // 剥离正则字面量——/\(/、/\)/ 等正则里的括号会干扰平衡计数，
    // 含正则的合法工具代码被误报为括号不匹配（fail-closed 误拦）。
    // 启发式判定 / 为正则起点还是除号：最近词为关键字（return/typeof/in/of/instanceof/
    // new/delete/void/throw/case/do/else/yield）或前一非空白字符为运算符/分隔符
    // （( [ { } , = ! ? ; & | + - * % ^ ~ < > 或起始）→ 正则起点；
    // 标识符/数字/右圆括号/右方括号后 → 除号（arr[i] / 2、foo() / 2 不误剥）。
    // 正则不跨行（换行仍未闭合则保留原文，不影响计数）；支持 \/ 转义与 [...] 字符类内的 /。
    // 与 aeToolCreator.js checkBracketBalance 中的同名函数保持一致（两处同步修复，防逻辑漂移）。
    function stripRegexLiterals(src) {
        var KEYWORDS = { return: 1, typeof: 1, instanceof: 1, in: 1, of: 1, new: 1, delete: 1, void: 1, throw: 1, case: 1, do: 1, else: 1, yield: 1 };
        var out = [];
        var word = '';   // 当前累积的词（跨空白累积："return x / 2" 累积为 "returnx"，非关键字 → 除号，判定恰好正确）
        var lastCh = ''; // 最近一个非空白字符
        var i = 0, len = src.length;
        while (i < len) {
            var ch = src.charAt(i);
            if (ch === '/') {
                var isRegex = false;
                if (word) {
                    isRegex = !!KEYWORDS[word];
                } else {
                    isRegex = lastCh === '' || '([{,=!?;&|+-*%^~<>}'.indexOf(lastCh) >= 0;
                }
                if (isRegex) {
                    var j = i + 1, inClass = false, closed = false;
                    while (j < len) {
                        var c2 = src.charAt(j);
                        if (c2 === '\\') { j += 2; continue; }
                        if (c2 === '\n') break;
                        if (c2 === '[') inClass = true;
                        else if (c2 === ']') inClass = false;
                        else if (c2 === '/' && !inClass) { closed = true; break; }
                        j++;
                    }
                    if (closed) {
                        j++;
                        while (j < len && 'gimsuy'.indexOf(src.charAt(j)) >= 0) j++;
                        out.push(' ');
                        lastCh = '/'; word = '';
                        i = j;
                        continue;
                    }
                }
                // 除号或未闭合的伪正则：保留原文（未闭合段内的括号原样参与计数）
                out.push(ch);
                lastCh = '/'; word = '';
                i++;
                continue;
            }
            out.push(ch);
            if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f') {
                // 空白不更新状态：关键字与 / 之间、"x" 与 / 之间都可能有空白
            } else if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$') {
                word += ch;
                lastCh = ch;
            } else {
                word = '';
                lastCh = ch;
            }
            i++;
        }
        return out.join('');
    }

    function createAEToolsView(controller, containerEl) {
        var listeners = [];
        var currentQuery = '';
        var currentCategory = 'all';
        var editingToolName = null;
        var sortKey = '';
        var sortAsc = true;
        var currentTab = 'manage';       // 'manage' | 'reference'
        var apiCollapsed = {};           // 记录 API 参考中各分类的折叠状态

        function on(el, event, handler) {
            if (!el) return;
            el.addEventListener(event, handler);
            listeners.push({ el: el, event: event, handler: handler });
        }

        function offAll() {
            while (listeners.length > 0) {
                var item = listeners.pop();
                item.el.removeEventListener(item.event, item.handler);
            }
        }

        // 移除绑定在 rootEl 内部（含自身）元素上的监听：
        // render()/openDrawer() 会 innerHTML 重建子树，旧条目若不清理，
        // 已脱离文档的元素会被 handler 闭包持续引用而无法 GC（内存泄漏）
        function offWithin(rootEl) {
            if (!rootEl) return;
            for (var i = listeners.length - 1; i >= 0; i--) {
                var item = listeners[i];
                if (item.el === rootEl || rootEl.contains(item.el)) {
                    item.el.removeEventListener(item.event, item.handler);
                    listeners.splice(i, 1);
                }
            }
        }

        function render() {
            if (!containerEl) return;

            offWithin(containerEl);

            var html = '<div class="ae-tools-tab-bar">';
            html += '<button class="ae-tab-btn' + (currentTab === 'manage' ? ' active' : '') + '" id="aeTabManage">' + AEI18n.t('工具管理') + '</button>';
            html += '<button class="ae-tab-btn' + (currentTab === 'reference' ? ' active' : '') + '" id="aeTabReference">' + AEI18n.t('API 参考') + '</button>';
            html += '</div>';

            html += '<div class="ae-tools-backdrop" id="aeToolsBackdrop"></div>';
            html += '<div class="ae-tools-container">';

            if (currentTab === 'manage') {
                html += renderManageView();
            } else {
                html += renderApiReferenceView();
            }

            html += '</div>';

            html += '<div class="ae-tools-drawer-overlay" id="aeToolsDrawer">';
            html += renderDrawerContent(null);
            html += '</div>';

            containerEl.innerHTML = html;
            bindEvents();
        }

        function renderManageView() {
            var filteredCount = controller.searchTools(currentQuery, currentCategory).length;
            var html = '';

            html += '<div class="ae-tools-filter-bar">';
            html += '<div class="ae-tools-filter-group">';
            html += AEI18n.html('<button class="btn run" id="aeToolAddBtn">新增</button>');
            html += '<select class="ae-tools-category-select" id="aeToolCategoryFilter">';
            html += '<option value="all"' + (currentCategory === 'all' ? ' selected' : '') + '>' + AEI18n.t('全部分组') + '</option>';
            var cats = controller.getCategories();
            for (var c = 0; c < cats.length; c++) {
                html += '<option value="' + cats[c] + '"' + (currentCategory === cats[c] ? ' selected' : '') + '>' + cats[c] + '</option>';
            }
            html += '</select>';
            html += '</div>';
            html += '<div class="ae-tools-filter-group ae-tools-right-group">';
            html += AEI18n.html('<span class="ae-tools-count-badge">共 ') + filteredCount + AEI18n.html(' 个</span>');
            html += '<input class="ae-tools-search" id="aeToolSearch" placeholder="' + AEI18n.t('搜索...') + '" value="' + escHtml(currentQuery) + '">';
            html += '</div>';
            html += '</div>';

            html += '<div class="ae-tools-table-wrap" id="aeToolsTableWrap">';
            html += renderTable();
            html += '</div>';

            return html;
        }

        function renderApiReferenceView() {
            var filteredCount = controller.searchAeFunctions(currentQuery, currentCategory).length;
            var html = '';

            html += '<div class="ae-tools-filter-bar">';
            html += '<div class="ae-tools-filter-group">';
            html += '<select class="ae-tools-category-select" id="aeRefCategoryFilter">';
            html += '<option value="all"' + (currentCategory === 'all' ? ' selected' : '') + '>' + AEI18n.t('全部函数') + '</option>';
            html += '<option value="direct"' + (currentCategory === 'direct' ? ' selected' : '') + '>' + AEI18n.t('可直接调用') + '</option>';
            html += '<option value="helper"' + (currentCategory === 'helper' ? ' selected' : '') + '>' + AEI18n.t('辅助函数') + '</option>';
            html += '</select>';
            html += '</div>';
            html += '<div class="ae-tools-filter-group ae-tools-right-group">';
            html += AEI18n.html('<span class="ae-tools-count-badge">共 ') + filteredCount + AEI18n.html(' 个</span>');
            html += '<input class="ae-tools-search" id="aeRefSearch" placeholder="' + AEI18n.t('搜索...') + '" value="' + escHtml(currentQuery) + '">';
            html += '</div>';
            html += '</div>';

            html += '<div class="ae-tools-table-wrap" id="aeRefTableWrap">';
            html += renderApiContent();
            html += '</div>';

            return html;
        }

        function renderApiContent() {
            var funcs = controller.searchAeFunctions(currentQuery, currentCategory);

            // 分组：可直接调用 / 辅助函数
            var directFuncs = [];
            var helperFuncs = [];
            for (var i = 0; i < funcs.length; i++) {
                var f = funcs[i];
                var isDirect = (f.rawParams === 'args' || f.rawParams.indexOf('args,') === 0);
                if (isDirect) directFuncs.push(f);
                else helperFuncs.push(f);
            }

            directFuncs.sort(function(a, b) { return a.name.localeCompare(b.name); });
            helperFuncs.sort(function(a, b) { return a.name.localeCompare(b.name); });

            if (funcs.length === 0) {
                return '<div class="ae-table-empty">' + AEI18n.t('没有匹配的函数') + '</div>';
            }

            var html = '<div class="ae-api-list">';
            if (directFuncs.length > 0) {
                html += renderFuncGroup(AEI18n.t('可直接调用'), directFuncs);
            }
            if (helperFuncs.length > 0) {
                html += renderFuncGroup(AEI18n.t('辅助函数'), helperFuncs);
            }
            html += '</div>';
            return html;
        }

        function renderFuncGroup(groupName, funcs) {
            var collapsed = apiCollapsed[groupName] === true;
            var html = '<div class="ae-api-category">';
            html += '<div class="ae-api-cat-header" data-cat="' + escHtml(groupName) + '">';
            html += '<span class="ae-api-cat-arrow">' + (collapsed ? '▶' : '▼') + '</span>';
            html += '<span class="ae-cat-badge">' + escHtml(groupName) + '</span>';
            html += '<span class="ae-api-cat-count">' + funcs.length + AEI18n.html(' 个函数</span>');
            html += '</div>';

            if (!collapsed) {
                html += '<div class="ae-api-cat-body">';
                for (var i = 0; i < funcs.length; i++) {
                    html += renderApiFuncCard(funcs[i]);
                }
                html += '</div>';
            }
            html += '</div>';
            return html;
        }

        function renderApiFuncCard(fn) {
            var isDirect = (fn.rawParams === 'args' || fn.rawParams.indexOf('args,') === 0);
            var html = '<div class="ae-api-tool-card" id="apiCard_' + escHtml(fn.name) + '">';
            html += '<div class="ae-api-tool-header">';
            html += '<code class="ae-api-tool-name">' + escHtml(fn.name) + '(' + escHtml(fn.rawParams || '') + ')</code>';
            html += '</div>';

            if (isDirect && fn.params && fn.params.length > 0) {
                html += '<div class="ae-api-params">';
                for (var p = 0; p < fn.params.length; p++) {
                    html += '<code class="ae-api-param-tag">args.' + escHtml(fn.params[p]) + '</code>';
                    if (p < fn.params.length - 1) html += ' ';
                }
                html += '</div>';
            }

            if (fn.body) {
                html += '<pre class="ae-api-code">' + escHtml(fn.body) + '</pre>';
            }

            html += '</div>';
            return html;
        }

        function sortArrow(key) {
            if (sortKey !== key) return '';
            return sortAsc ? ' ▴' : ' ▾';
        }

        // 描述列与 title 的展示文案。内建工具（seed 预置，无 createdBy 标记）的描述是
        // 产品文案，按当前语言查词典；用户与 LLM 创建的工具描述是用户数据，原样显示。
        // 只作用于展示：tool.description 本身（编辑框内容、发给 LLM 的 schema）不改。
        function displayDescription(tool) {
            var desc = tool && tool.description ? String(tool.description) : '';
            if (!desc) return '';
            if (tool.createdBy === 'llm' || tool.createdBy === 'user') return desc;
            return AEI18n.t(desc);
        }

        function renderTable() {
            var tools = controller.searchTools(currentQuery, currentCategory);

            if (sortKey) {
                tools.sort(function(a, b) {
                    var va = (a[sortKey] || '').toString().toLowerCase();
                    var vb = (b[sortKey] || '').toString().toLowerCase();
                    if (sortKey === 'enabled') { va = a.enabled ? '1' : '0'; vb = b.enabled ? '1' : '0'; }
                    if (va < vb) return sortAsc ? -1 : 1;
                    if (va > vb) return sortAsc ? 1 : -1;
                    return 0;
                });
            }

            var html = '<table class="ae-tools-table"><thead><tr>';
            html += AEI18n.html('<th class="col-name sortable" data-sort="name">名称') + sortArrow('name') + '</th>';
            html += AEI18n.html('<th class="col-source">来源</th>');
            html += AEI18n.html('<th class="col-desc sortable" data-sort="description">描述') + sortArrow('description') + '</th>';
            html += AEI18n.html('<th class="col-category sortable" data-sort="category">分组') + sortArrow('category') + '</th>';
            html += AEI18n.html('<th class="col-enabled sortable" data-sort="enabled">启用') + sortArrow('enabled') + '</th>';
            html += '<th class="col-actions"></th>';
            html += '</tr></thead><tbody>';

            if (tools.length === 0) {
                return '<div class="ae-table-empty">' + AEI18n.t('暂无工具。点击"新增"创建你的第一个 AE 工具。') + '</div>';
            }

            for (var i = 0; i < tools.length; i++) {
                var t = tools[i];
                var rowClass = '';
                if (!t.enabled) rowClass += ' disabled';
                if (editingToolName === t.name) rowClass += ' selected';
                var descText = displayDescription(t);

                html += '<tr' + (rowClass ? ' class="' + rowClass.trim() + '"' : '') + ' data-tool-name="' + escHtml(t.name) + '">';
                html += '<td class="col-name" title="' + escHtml(t.name) + '"><strong>' + escHtml(t.name) + '</strong></td>';
                html += '<td class="col-source">' + (t.createdBy === 'llm' ? AEI18n.html('<span class="ae-llm-badge" title="LLM 创建">AI</span>') : t.createdBy === 'user' ? AEI18n.html('<span class="ae-user-badge">用户</span>') : AEI18n.html('<span class="ae-sys-badge">系统</span>')) + '</td>';
                html += '<td class="col-desc" title="' + escHtml(descText) + '">' + escHtml(descText.substring(0, 80)) + '</td>';
                html += '<td class="col-category" title="' + escHtml(t.category || '') + '"><span class="ae-cat-badge">' + escHtml(t.category || '') + '</span></td>';
                html += '<td class="col-enabled"><label class="toggle-wrap"><input type="checkbox" class="switch-input ae-toggle-enable" data-tool-name="' + escHtml(t.name) + '"' + (t.enabled ? ' checked' : '') + '><span class="switch-slider"></span></label></td>';
                html += '<td class="col-actions">';
                html += '<button class="btn ae-row-btn" data-action="edit" data-tool-name="' + escHtml(t.name) + '">' + AEI18n.t('编辑') + '</button>';
                html += '<button class="btn ae-row-btn ae-row-btn-danger" data-action="delete" data-tool-name="' + escHtml(t.name) + '">×</button>';
                html += '</td>';
                html += '</tr>';
            }

            html += '</tbody></table>';
            return html;
        }

        function renderDrawerContent(tool) {
            if (!tool) {
                return '<div class="ae-tools-drawer-placeholder">' + AEI18n.t('点击左侧列表中的"编辑"按钮，或点击"新增"创建新工具。') + '</div>';
            }

            var code = tool.extendScript || '';

            var html = '<div class="ae-tools-drawer-header">';
            html += '<label class="toggle-wrap">';
            html += '<input type="checkbox" class="switch-input" id="aeDrawerEnabled"' + (tool.enabled !== false ? ' checked' : '') + '>';
            html += '<span class="switch-slider"></span>';
            html += AEI18n.html('<span class="toggle-label">启用</span>');
            html += '</label>';
            html += '</div>';

            html += '<div class="ae-tools-drawer-form">';

            html += AEI18n.html('<label>名称</label>');
            html += '<input type="text" id="aeDrawerName" value="' + escHtml(tool.name) + '">';

            html += AEI18n.html('<label>描述</label>');
            html += '<textarea id="aeDrawerDesc" rows="3">' + escHtml(tool.description || '') + '</textarea>';

            html += AEI18n.html('<label>Stub 描述 <span class="ae-field-hint">（留空则截断描述）</span></label>');
            html += '<input type="text" id="aeDrawerShortDesc" maxlength="30" placeholder="' + AEI18n.t('如：获取项目信息') + '" value="' + escHtml(tool.shortDescription || '') + '">';

            var stubChecked = tool.stub !== undefined ? !!tool.stub : !tool.readOnly;
            var roChecked = tool.readOnly === true;
            html += '<div class="ae-tools-fieldset">';
            html += AEI18n.html('<div class="ae-tools-fieldset-label">工具行为</div>');
            html += '<div class="ae-tools-fieldset-row">';
            html += '<label class="toggle-wrap">';
            html += '<input type="checkbox" class="switch-input" id="aeDrawerReadOnly"' + (roChecked ? ' checked' : '') + '>';
            html += '<span class="switch-slider"></span>';
            html += AEI18n.html('<span class="toggle-label">只读</span>');
            html += '</label>';
            html += '<label class="toggle-wrap">';
            html += '<input type="checkbox" class="switch-input" id="aeDrawerStub"' + (stubChecked ? ' checked' : '') + '>';
            html += '<span class="switch-slider"></span>';
            html += '<span class="toggle-label">Stub</span>';
            html += '</label>';
            html += '</div>';
            html += '</div>';

            var curScope = tool.scope;
            var isScopeGlobal = !!(curScope && curScope.type === 'global');
            var scopeMods = [];
            if (curScope && curScope.type === 'module') {
                scopeMods = curScope.moduleIds || (curScope.moduleId ? [curScope.moduleId] : []);
            }
            // 旧工具无 scope 字段：按 readOnly 回退（与 resolveAeScope 一致）
            if (!curScope) {
                if (tool.readOnly) isScopeGlobal = true;
                else scopeMods = ['agent'];
            }
            var scopeModDisabled = isScopeGlobal ? ' disabled' : '';
            var scopeAgentChk = (!isScopeGlobal && scopeMods.indexOf('agent') >= 0) ? ' checked' : '';
            var scopeScriptChk = (!isScopeGlobal && scopeMods.indexOf('script') >= 0) ? ' checked' : '';
            var scopeShaderChk = (!isScopeGlobal && scopeMods.indexOf('shader') >= 0) ? ' checked' : '';
            // 外接（external-mcp）也是 scope 的合法成员（getPreviewFrame/queryEnvironment 用），
            // 且不能省——外接 tools/list 投影不查 scope，调用闸门才查，漏了就是「列着但一调就拒」。
            // 抽屉只有 Agent/Script/Shader 三个框时，保存时按框重建 scope 会把 external-mcp
            // 静默抹掉。
            var scopeExtChk = (!isScopeGlobal && scopeMods.indexOf('external-mcp') >= 0) ? ' checked' : '';
            html += '<div class="ae-tools-fieldset">';
            html += AEI18n.html('<div class="ae-tools-fieldset-label">作用域</div>');
            html += '<div class="ae-scope-checks">';
            html += '<label class="ae-scope-check' + (isScopeGlobal ? ' disabled' : (scopeAgentChk ? ' active' : '')) + '"><input type="checkbox" id="aeDrawerScopeAgent"' + scopeAgentChk + scopeModDisabled + '> Agent</label>';
            html += '<label class="ae-scope-check' + (isScopeGlobal ? ' disabled' : (scopeScriptChk ? ' active' : '')) + '"><input type="checkbox" id="aeDrawerScopeScript"' + scopeScriptChk + scopeModDisabled + '> Script</label>';
            html += '<label class="ae-scope-check' + (isScopeGlobal ? ' disabled' : (scopeShaderChk ? ' active' : '')) + '"><input type="checkbox" id="aeDrawerScopeShader"' + scopeShaderChk + scopeModDisabled + '> Shader</label>';
            html += '<label class="ae-scope-check' + (isScopeGlobal ? ' disabled' : (scopeExtChk ? ' active' : '')) + '"><input type="checkbox" id="aeDrawerScopeExternal"' + scopeExtChk + scopeModDisabled + '>' + AEI18n.t(' 外接') + '</label>';
            html += '<label class="ae-scope-check' + (isScopeGlobal ? ' active' : '') + '"><input type="checkbox" id="aeDrawerScopeGlobal"' + (isScopeGlobal ? ' checked' : '') + '>' + AEI18n.t(' 全局') + '</label>';
            html += '</div>';
            html += '</div>';

            html += AEI18n.html('<label>分组</label>');
            html += '<select id="aeDrawerCategory">';
            var cats = controller.getCategories();
            var catMatched = false;
            for (var c = 0; c < cats.length; c++) {
                var catSel = tool.category === cats[c];
                if (catSel) catMatched = true;
                html += '<option value="' + cats[c] + '"' + (catSel ? ' selected' : '') + '>' + cats[c] + '</option>';
            }
            // 分组不在预置列表（历史数据/手工编辑 JSON）时动态补项，防止保存时被静默重置为第一项
            if (tool.category && !catMatched) {
                html += '<option value="' + escHtml(tool.category) + '" selected>' + escHtml(tool.category) + '</option>';
            }
            html += '</select>';

            html += '<label>Input Schema</label>';
            html += '<div class="ae-schema-builder" id="aeSchemaBuilder">';
            html += '<div class="ae-schema-params" id="aeSchemaParams"></div>';
            html += AEI18n.html('<button class="btn secondary ae-schema-add-btn" id="aeSchemaAddBtn">+ 添加参数</button>');
            html += '</div>';
            // 隐藏域存原始 JSON，兼容高级用户直接编辑
            html += '<textarea id="aeDrawerSchema" class="mono" style="display:none">' + escHtml(JSON.stringify(tool.input_schema || {}, null, 2)) + '</textarea>';

            html += '<label>ExtendScript</label>';
            html += '<div class="ae-code-highlight-wrap" id="aeDrawerCodeWrap">';
            html += AEI18n.html('<textarea id="aeDrawerCode" rows="6" spellcheck="false" placeholder="// 将返回给llm的结果赋给 result &#10;// llm传入的参数存放在 __args 对象中&#10;// 例: result = getProjectInfo(__args);&#10;// 例: result = JSON.stringify({status:&quot;success&quot;});">') + escHtml(code) + '</textarea>';
            html += '<pre id="aeDrawerCodeHighlight"><code id="aeDrawerCodeHighlightCode" class="language-javascript"></code></pre>';
            html += '</div>';
            html += '</div>';

            // 测试参数区
            html += '<div class="ae-run-args-wrap" id="aeRunArgsWrap">';
            html += AEI18n.html('<div class="ae-run-resize-handle" id="aeRunArgsResize" title="拖动调整测试参数区高度"></div>');
            html += AEI18n.html('<label class="ae-run-args-label" id="aeRunArgsToggle">⚙ 测试参数 <span class="ae-run-args-hint">(临时替换 __args)</span></label>');
            html += '<textarea class="ae-run-args-input" id="aeDrawerArgs" rows="2" spellcheck="false" placeholder=\'{"layerIndex":1, "time":2}\'></textarea>';
            html += '</div>';

            // 运行结果区
            html += '<div class="ae-run-result" id="aeRunResult" style="display:none">';
            html += '<div class="ae-run-result-header"><span class="ae-run-status" id="aeRunStatus"></span><button class="ae-run-close" id="aeRunClose">×</button></div>';
            html += '<pre class="ae-run-output" id="aeRunOutput"></pre>';
            html += '</div>';

            html += '<div class="ae-tools-drawer-actions">';
            html += AEI18n.html('<button class="btn" id="aeDrawerRun">▶ 运行</button>');
            html += '<div class="ae-drawer-actions-right">';
            html += AEI18n.html('<button class="btn secondary" id="aeDrawerCancel">取消</button>');
            html += AEI18n.html('<button class="btn" id="aeDrawerSave">💾 保存</button>');
            html += '</div>';
            html += '</div>';

            return html;
        }

        function refreshTable() {
            // 异步回调（保存/删除/启停）可能跨 tab 到达，此时不得污染 API 参考页的计数徽章
            if (currentTab !== 'manage') return;
            var wrap = document.getElementById('aeToolsTableWrap');
            if (wrap) {
                wrap.innerHTML = renderTable();
            }
            var badge = document.querySelector('.ae-tools-count-badge');
            if (badge) {
                badge.textContent = AEI18n.t('共 ') + controller.searchTools(currentQuery, currentCategory).length + AEI18n.t(' 个');
            }
        }

        function openDrawer(tool) {
            editingToolName = tool ? tool.name : null;
            _lastHighlighted = '';
            var backdrop = document.getElementById('aeToolsBackdrop');
            var drawer = document.getElementById('aeToolsDrawer');
            if (backdrop) backdrop.classList.add('show');
            if (drawer) {
                offWithin(drawer);
                drawer.innerHTML = renderDrawerContent(tool);
                drawer.classList.add('open');
                bindDrawerEvents(drawer);
                syncArgsFromSchema();
                syncCodeHighlight();
            }
            refreshTable();
        }

        var _lastHighlighted = '';

        function syncCodeHighlight() {
            var codeEl = document.getElementById('aeDrawerCode');
            var codeTag = document.getElementById('aeDrawerCodeHighlightCode');
            var wrap = document.getElementById('aeDrawerCodeWrap');
            if (!codeEl || !codeTag) return;
            var code = codeEl.value;
            if (code === _lastHighlighted) return;
            _lastHighlighted = code;
            // 用 Prism.highlight() 而非 highlightElement（后者需要额外插件）
            if (typeof Prism !== 'undefined' && Prism.languages && Prism.languages.javascript) {
                var highlighted = Prism.highlight(code, Prism.languages.javascript, 'javascript');
                codeTag.innerHTML = highlighted;
                if (wrap) wrap.classList.add('has-highlight');
            } else {
                codeTag.textContent = code;
            }
            // 同步滚动 (transform 方式，跟 agent 模块一致)
            codeTag.style.transform = 'translate(' + (-codeEl.scrollLeft) + 'px,' + (-codeEl.scrollTop) + 'px)';
        }

        function closeDrawer() {
            editingToolName = null;
            _lastHighlighted = '';
            var backdrop = document.getElementById('aeToolsBackdrop');
            var drawer = document.getElementById('aeToolsDrawer');
            if (backdrop) backdrop.classList.remove('show');
            if (drawer) {
                drawer.classList.remove('open');
                setTimeout(function() {
                    if (!drawer.classList.contains('open')) {
                        offWithin(drawer);
                        drawer.innerHTML = renderDrawerContent(null);
                    }
                }, 250);
            }
            refreshTable();
        }

        function refreshApiRef() {
            // 异步回调可能跨 tab 到达，此时不得污染工具管理页的计数徽章
            if (currentTab !== 'reference') return;
            var wrap = document.getElementById('aeRefTableWrap');
            if (wrap) {
                wrap.innerHTML = renderApiContent();
            }
            var badge = document.querySelector('.ae-tools-count-badge');
            if (badge) {
                badge.textContent = AEI18n.t('共 ') + controller.searchAeFunctions(currentQuery, currentCategory).length + AEI18n.t(' 个');
            }
        }

        function switchTab(tab) {
            if (currentTab === tab) return;
            currentTab = tab;
            currentQuery = '';
            currentCategory = 'all';
            closeDrawer();
            render();
        }

        function bindEvents() {
            // 选项卡切换
            var tabManage = document.getElementById('aeTabManage');
            var tabRef = document.getElementById('aeTabReference');
            if (tabManage) on(tabManage, 'click', function() { switchTab('manage'); });
            if (tabRef) on(tabRef, 'click', function() { switchTab('reference'); });

            // API 参考：分类折叠
            var refWrap = document.getElementById('aeRefTableWrap');
            if (refWrap) {
                on(refWrap, 'click', function(e) {
                    var header = e.target.closest('.ae-api-cat-header');
                    if (header) {
                        var cat = header.getAttribute('data-cat');
                        apiCollapsed[cat] = !apiCollapsed[cat];
                        refreshApiRef();
                    }
                });
            }
            // API 参考：搜索和分类筛选项
            var refSearch = document.getElementById('aeRefSearch');
            var refCat = document.getElementById('aeRefCategoryFilter');
            if (refSearch) {
                on(refSearch, 'input', function() {
                    currentQuery = this.value;
                    refreshApiRef();
                });
            }
            if (refCat) {
                on(refCat, 'change', function() {
                    currentCategory = this.value;
                    refreshApiRef();
                });
            }

            var addBtn = document.getElementById('aeToolAddBtn');
            if (addBtn) {
                on(addBtn, 'click', function() {
                    openDrawer({
                        name: '',
                        description: '',
                        shortDescription: '',
                        input_schema: { type: 'object', properties: {}, required: [] },
                        enabled: true,
                        category: 'custom',
                        extendScript: null,
                        _isNew: true
                    });
                });
            }

            var backdropEl = document.getElementById('aeToolsBackdrop');
            if (backdropEl) {
                on(backdropEl, 'click', closeDrawer);
            }

            var searchEl = document.getElementById('aeToolSearch');
            if (searchEl) {
                on(searchEl, 'input', function() {
                    currentQuery = this.value;
                    refreshTable();
                });
            }

            var catEl = document.getElementById('aeToolCategoryFilter');
            if (catEl) {
                on(catEl, 'change', function() {
                    currentCategory = this.value;
                    refreshTable();
                });
            }

            var tableWrap = document.getElementById('aeToolsTableWrap');
            if (tableWrap) {
                // 事件委托统一处理：排序、编辑、删除、启停，innerHTML 重建后无需重新绑定
                on(tableWrap, 'click', function(e) {
                    var th = e.target.closest('th.sortable');
                    if (th) {
                        var key = th.getAttribute('data-sort');
                        if (sortKey === key) { sortAsc = !sortAsc; }
                        else { sortKey = key; sortAsc = true; }
                        refreshTable();
                        return;
                    }
                    var btn = e.target.closest('button[data-action]');
                    if (btn) {
                        e.stopPropagation();
                        var action = btn.getAttribute('data-action');
                        var toolName = btn.getAttribute('data-tool-name');
                        if (action === 'edit') {
                            var tool = controller.getTool(toolName);
                            if (tool) { var editCopy = JSON.parse(JSON.stringify(tool)); editCopy._isNew = false; openDrawer(editCopy); }
                        } else if (action === 'delete') {
                            var doDelete = function() {
                                controller.deleteTool(toolName).then(function(ok) {
                                    // 删除失败已回滚内存，仍刷新表格以反映实际状态
                                    if (ok && editingToolName === toolName) closeDrawer();
                                    refreshTable();
                                });
                            };
                            if (typeof global.showConfirm === 'function') {
                                global.showConfirm(AEI18n.t('删除工具'), AEI18n.t('确定要删除工具 "') + toolName + AEI18n.t('" 吗？此操作不可撤销。'), 'confirm').then(function(ok) {
                                    if (ok) doDelete();
                                });
                            } else {
                                if (confirm(AEI18n.t('确定要删除工具 "') + toolName + AEI18n.t('" 吗？此操作不可撤销。'))) doDelete();
                            }
                        }
                    }
                });
                on(tableWrap, 'change', function(e) {
                    var cb = e.target.closest('.ae-toggle-enable');
                    if (!cb) return;
                    var toolName = cb.getAttribute('data-tool-name');
                    controller.toggleToolEnabled(toolName).then(function() {
                        // 切换失败已回滚 UI 状态，刷新表格反映实际状态
                        refreshTable();
                    });
                });
            }
        }

        // ── Schema Builder ──

        function parseSchemaToParams(schema) {
            var params = [];
            if (!schema || !schema.properties) return params;
            var props = schema.properties;
            var keys = Object.keys(props);
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var p = props[k];
                params.push({
                    name: k,
                    type: p.type || 'string',
                    description: p.description || ''
                });
            }
            return params;
        }

        function buildSchemaFromParams() {
            var container = document.getElementById('aeSchemaParams');
            var rows = container ? container.querySelectorAll('.ae-schema-param-row') : [];
            // 以抽屉隐藏域中的原 schema 为基底合并：保留 builder 不支持的约束
            // （required/enum/items/default 及顶层附加字段），避免"编辑→保存"静默摧毁它们
            var baseSchema = null;
            var schemaEl = document.getElementById('aeDrawerSchema');
            if (schemaEl) {
                try { baseSchema = JSON.parse(schemaEl.value || 'null'); } catch (_) { baseSchema = null; }
            }
            var baseProps = (baseSchema && baseSchema.properties && typeof baseSchema.properties === 'object' && !Array.isArray(baseSchema.properties)) ? baseSchema.properties : {};
            var baseRequired = (baseSchema && Array.isArray(baseSchema.required)) ? baseSchema.required : [];

            var props = {};
            for (var i = 0; i < rows.length; i++) {
                var row = rows[i];
                var nameEl = row.querySelector('.ae-param-name');
                var typeEl = row.querySelector('.ae-param-type');
                var descEl = row.querySelector('.ae-param-desc');
                var name = nameEl ? nameEl.value.trim() : '';
                if (!name) continue;
                if (props[name]) {
                    if (global.AEToast) global.AEToast.show(AEI18n.t('参数名 "') + name + AEI18n.t('" 重复，仅保留第一个'), 'warn');
                    continue;
                }
                var orig = baseProps[name];
                if (orig && typeof orig === 'object' && !Array.isArray(orig)) {
                    // 保留 enum/items/default 等原有属性，只覆盖 builder 管理的字段
                    var merged = {};
                    for (var ok in orig) merged[ok] = orig[ok];
                    if (!Array.isArray(orig.type)) {
                        merged.type = typeEl ? typeEl.value : (orig.type || 'string');
                    } // 多类型（如 ["string","null"]）无法在 builder 表达，保留原值
                    merged.description = descEl ? descEl.value.trim() : (orig.description || '');
                    props[name] = merged;
                } else {
                    props[name] = {
                        type: typeEl ? typeEl.value : 'string',
                        description: descEl ? descEl.value.trim() : ''
                    };
                }
            }
            // required 只保留仍存在的参数名
            var required = [];
            for (var r = 0; r < baseRequired.length; r++) {
                if (props[baseRequired[r]]) required.push(baseRequired[r]);
            }
            var schema = { type: 'object' };
            if (baseSchema && typeof baseSchema === 'object' && !Array.isArray(baseSchema)) {
                for (var tk in baseSchema) schema[tk] = baseSchema[tk];
            }
            schema.type = 'object';
            schema.properties = props;
            schema.required = required;
            return schema;
        }

        function renderSchemaParams(params) {
            var container = document.getElementById('aeSchemaParams');
            if (!container) return;
            var html = '';
            for (var i = 0; i < params.length; i++) {
                var p = params[i];
                html += '<div class="ae-schema-param-row" data-index="' + i + '">';
                html += '<input class="ae-param-name" placeholder="' + AEI18n.t('参数名') + '" value="' + escHtml(p.name || '') + '">';
                html += '<select class="ae-param-type">';
                html += '<option value="string"' + (p.type === 'string' ? ' selected' : '') + '>string</option>';
                html += '<option value="number"' + (p.type === 'number' ? ' selected' : '') + '>number</option>';
                html += '<option value="integer"' + (p.type === 'integer' ? ' selected' : '') + '>integer</option>';
                html += '<option value="boolean"' + (p.type === 'boolean' ? ' selected' : '') + '>boolean</option>';
                html += '<option value="array"' + (p.type === 'array' ? ' selected' : '') + '>array</option>';
                html += '<option value="object"' + (p.type === 'object' ? ' selected' : '') + '>object</option>';
                if (typeof p.type === 'string' && p.type
                    && ['string', 'number', 'integer', 'boolean', 'array', 'object'].indexOf(p.type) < 0) {
                    // 未知类型（历史数据/手工编辑 JSON）动态补项，防止被静默重置为 string
                    html += '<option value="' + escHtml(p.type) + '" selected>' + escHtml(p.type) + '</option>';
                }
                html += '</select>';
                html += '<input class="ae-param-desc" placeholder="' + AEI18n.t('描述') + '" value="' + escHtml(p.description || '') + '">';
                html += '<button class="btn ae-param-remove-btn" data-index="' + i + '">×</button>';
                html += '</div>';
            }
            container.innerHTML = html;
        }

        // 从 Schema Builder 同步测试参数的默认 JSON
        function syncArgsFromSchema() {
            var argsEl = document.getElementById('aeDrawerArgs');
            if (!argsEl) return;
            // 用户手动改过的参数不覆盖
            if (argsEl.value.trim() && argsEl.dataset.manual === '1') return;

            var schema = buildSchemaFromParams();
            if (!schema || !schema.properties) return;
            var props = schema.properties;
            var keys = Object.keys(props);
            if (keys.length === 0) return;

            var defaults = {};
            for (var i = 0; i < keys.length; i++) {
                var k = keys[i];
                var t = props[k].type || 'string';
                if (t === 'string') defaults[k] = '';
                else if (t === 'number' || t === 'integer') defaults[k] = 0;
                else if (t === 'boolean') defaults[k] = false;
                else if (t === 'array') defaults[k] = [];
                else defaults[k] = {};
            }
            argsEl.value = JSON.stringify(defaults, null, 2);
        }

        // ── Drawer Events ──

        function bindDrawerEvents(drawer) {
            var cancelBtn = document.getElementById('aeDrawerCancel');
            if (cancelBtn) on(cancelBtn, 'click', closeDrawer);

            // 作用域胶囊复选框：点击 label 切换选中态并高亮（CEF 不支持 :has()，用 class 控制）
            // 全局必须是最后一项（用 id 判定，别按位置——曾写死 i===3，加「外接」后会错位）
            var scopeLabel = [
                document.getElementById('aeDrawerScopeAgent'),
                document.getElementById('aeDrawerScopeScript'),
                document.getElementById('aeDrawerScopeShader'),
                document.getElementById('aeDrawerScopeExternal'),
                document.getElementById('aeDrawerScopeGlobal')
            ].filter(Boolean);
            if (scopeLabel.length) {
                // 上行都对应 input；这里绑定 label（input 的父级）
                for (var _sci = 0; _sci < scopeLabel.length; _sci++) {
                    (function(i) {
                        var input = scopeLabel[i];
                        var label = input.parentElement;
                        var isGlobal = (input.id === 'aeDrawerScopeGlobal');
                        on(label, 'click', function(e) {
                            e.preventDefault();
                            if (label.classList.contains('disabled')) return;
                            if (isGlobal) {
                                // 全局：toggle。选中→禁用模块；再点→取消，恢复模块可选
                                if (label.classList.contains('active')) {
                                    label.classList.remove('active');
                                    input.checked = false;
                                    var all = document.querySelectorAll('#aeToolsDrawer .ae-scope-check');
                                    for (var _g = 0; _g < all.length; _g++) {
                                        var cb = all[_g].querySelector('input');
                                        if (cb && cb.id !== 'aeDrawerScopeGlobal') {
                                            all[_g].classList.remove('disabled');
                                            cb.disabled = false;
                                        }
                                    }
                                } else {
                                    label.classList.add('active');
                                    input.checked = true;
                                    var all = document.querySelectorAll('#aeToolsDrawer .ae-scope-check');
                                    for (var _g = 0; _g < all.length; _g++) {
                                        var cb = all[_g].querySelector('input');
                                        if (cb && cb.id !== 'aeDrawerScopeGlobal') {
                                            all[_g].classList.add('disabled');
                                            all[_g].classList.remove('active');
                                            cb.disabled = true;
                                            cb.checked = false;
                                        }
                                    }
                                }
                            } else {
                                // 模块：取消全局（若选中），再 toggle 自身
                                var gLabel = document.getElementById('aeDrawerScopeGlobal').parentElement;
                                var gInput = document.getElementById('aeDrawerScopeGlobal');
                                if (gLabel.classList.contains('active')) {
                                    gLabel.classList.remove('active');
                                    gInput.checked = false;
                                }
                                input.checked = !input.checked;
                                label.classList.toggle('active', input.checked);
                            }
                        });
                    })(_sci);
                }
            }

            // 测试参数 toggle
            var argsWrap = document.getElementById('aeRunArgsWrap');
            var argsToggle = document.getElementById('aeRunArgsToggle');
            if (argsWrap && argsToggle) {
                // 默认折叠
                argsWrap.classList.add('collapsed');
                on(argsToggle, 'click', function() {
                    argsWrap.classList.toggle('collapsed');
                });
            }
            // args 手动编辑标记 — 用户改过就不再被 schema 自动覆盖
            var argsEl = document.getElementById('aeDrawerArgs');
            if (argsEl) {
                on(argsEl, 'input', function() {
                    // 用户清空内容则恢复自动同步，否则标记手动编辑
                    if (argsEl.value.trim()) {
                        argsEl.dataset.manual = '1';
                    } else {
                        delete argsEl.dataset.manual;
                    }
                });
                // 测试参数区：右上角手柄拖动调整高度
                var resizeHandle = document.getElementById('aeRunArgsResize');
                if (resizeHandle) {
                    var _resize = null;
                    on(resizeHandle, 'pointerdown', function(e) {
                        e.preventDefault();
                        _resize = { startY: e.clientY, startH: argsEl.offsetHeight };
                        if (resizeHandle.setPointerCapture) {
                            try { resizeHandle.setPointerCapture(e.pointerId); } catch (_) {}
                        }
                    });
                    on(resizeHandle, 'pointermove', function(e) {
                        if (!_resize) return;
                        // 手柄在面板顶部：面板顶边跟随鼠标（上拖变大、下拖变小）
                        var h = Math.min(300, Math.max(28, _resize.startH - (e.clientY - _resize.startY)));
                        argsEl.style.height = h + 'px';
                    });
                    var endResize = function() { _resize = null; };
                    on(resizeHandle, 'pointerup', endResize);
                    on(resizeHandle, 'pointercancel', endResize);
                }
            }

            // 运行按钮
            var runBtn = document.getElementById('aeDrawerRun');
            if (runBtn) {
                on(runBtn, 'click', function() {
                    var codeEl = document.getElementById('aeDrawerCode');
                    if (!codeEl) return;
                    var code = codeEl.value.trim();
                    if (!code) { if (global.AEToast) global.AEToast.show(AEI18n.t('请先输入 ExtendScript 代码'), 'warn'); return; }

                    // 读取测试参数 JSON → 对象
                    var argsEl = document.getElementById('aeDrawerArgs');
                    var argsObj = {};
                    if (argsEl) {
                        var raw = argsEl.value.trim();
                        if (raw) {
                            try { argsObj = JSON.parse(raw); }
                            catch (_) {
                                // 展开参数区，让用户看到错误
                                if (argsWrap) argsWrap.classList.remove('collapsed');
                                if (global.AEToast) global.AEToast.show(AEI18n.t('测试参数 JSON 格式无效，请修正后重试'), 'warn');
                                return;
                            }
                        }
                    }

                    var resultEl = document.getElementById('aeRunResult');
                    var statusEl = document.getElementById('aeRunStatus');
                    var outputEl = document.getElementById('aeRunOutput');
                    if (resultEl) resultEl.style.display = 'block';
                    if (statusEl) { statusEl.textContent = AEI18n.t('⏳ 执行中…'); statusEl.className = 'ae-run-status running'; }
                    if (outputEl) outputEl.textContent = '';

                    // 走标准工具执行通道（与 LLM 调用同一条路）：沙箱 + 超时 + 撤销组包裹 + var result shadow + JSON 双重解套
                    // 测试环境与生产一致，所见即所得。撤销组与生产通道同规则：只读工具不包。
                    var createHandler = window.AE_LLM && window.AE_LLM._aeCreateHandler;
                    if (typeof createHandler !== 'function') {
                        if (statusEl) { statusEl.textContent = AEI18n.t('❌ 通道不可用'); statusEl.className = 'ae-run-status error'; }
                        if (outputEl) outputEl.textContent = AEI18n.t('AE 工具执行通道未就绪，请刷新面板后重试。');
                        return;
                    }
                    var runToolName = editingToolName || 'customTool';
                    // 撤销组策略读当前表单的只读勾选（而非已保存的旧定义），确保测试行为与保存后一致
                    var runReadOnlyEl = document.getElementById('aeDrawerReadOnly');
                    var runWrapUndo = !(runReadOnlyEl && runReadOnlyEl.checked);
                    try {
                        // 与生产两条注册路径同规则（bootstrap.js:711-740、controller.js:80-124；
                        // 同款规则）：
                        // **executeExtendScript 的撤销组入核**（undoInCore）+ **getPreviewFrame 的
                        // 结果后处理/预览目录** + **多帧抓帧的动态执行超时**。创建面漏传字段的后果：
                        //   · 撤销组由外层模板包裹，而外层的渲染跳过判据 _renderTrigger 只对**工具模板**
                        //     求值（抽屉里模板是 `result = executeExtendScript(__args);`，不含
                        //     renderQueue/render(）——用户在试运行里写 app.project.renderQueue.render()
                        //     时渲染就落在撤销组内，AE 报「撤消组不匹配」并弹模态（bootstrap.js:477-483、
                        //     aeTools.jsx:1958-1962 的真机记录）。入核后由核内判据处理（aeTools.jsx:1972）。
                        //   · 漏传 postProcess ⇒ 多时间点抓帧不拼联系表，静默退化成多帧回执（controller.js:92-93
                        //     已写明同款后果）；漏建预览帧目录 ⇒ 帧写不进去（bootstrap.js:738-740 同址）。
                        //   · 漏传 timeoutMs ⇒ 多帧抓帧回落全局「执行超时」（默认 30s），6 个时间点
                        //     又会被面板判超时、结果整体丢弃（bootstrap.js 的 previewBatchTimeoutMs）。
                        var runHandler = createHandler(code, {
                            name: runToolName,
                            wrapUndo: runWrapUndo,
                            undoInCore: runToolName === 'executeExtendScript',
                            getUndoName: (runToolName === 'executeExtendScript')
                                ? function (a) { return a && typeof a.action === 'string' ? a.action : null; }
                                : null,
                            timeoutMs: (runToolName === 'getPreviewFrame' || runToolName === 'analyzeImage')
                                ? ((window.AE_LLM && typeof window.AE_LLM._aePreviewBatchTimeoutMs === 'function')
                                    ? window.AE_LLM._aePreviewBatchTimeoutMs : undefined)
                                : undefined,
                            postProcess: (runToolName === 'getPreviewFrame' && window.AEPreviewSheet
                                && typeof window.AEPreviewSheet.postProcessPreviewFrames === 'function')
                                ? window.AEPreviewSheet.postProcessPreviewFrames
                                : ((runToolName === 'analyzeImage' && window.AEImageAnalysis
                                    && typeof window.AEImageAnalysis.postProcessAnalyzeImage === 'function')
                                    ? window.AEImageAnalysis.postProcessAnalyzeImage
                                    : null)
                        });
                        // queryEnvironment 的 availableEffects 由缓存层处理（jsx 层守卫拒绝该分支）：
                        // 抽屉试运行与注册路径共用同一包装，避免落到 jsx 守卫报错。
                        if (runToolName === 'queryEnvironment' && window.AEEffectsCache
                            && typeof window.AEEffectsCache.wrapQueryEnvironmentHandler === 'function') {
                            runHandler = window.AEEffectsCache.wrapQueryEnvironmentHandler(runHandler);
                        }
                        if ((runToolName === 'getPreviewFrame' || runToolName === 'analyzeImage') && window.AE_LLM
                            && typeof window.AE_LLM._aeEnsurePreviewDir === 'function') {
                            try { window.AE_LLM._aeEnsurePreviewDir(); } catch (_) {}
                        }
                        runHandler(argsObj).then(function(resp) {
                            var raw = (resp && resp.content && resp.content[0] && resp.content[0].text) || '';
                            var text = raw;
                            if (resp && resp.isError) {
                                if (statusEl) { statusEl.textContent = AEI18n.t('❌ AE 错误'); statusEl.className = 'ae-run-status error'; }
                            } else if (!raw || raw === 'undefined' || raw.indexOf('未返回结果') >= 0) {
                                if (statusEl) { statusEl.textContent = AEI18n.t('⚠️ 无返回值'); statusEl.className = 'ae-run-status error'; }
                                text = AEI18n.t('(代码执行了但 result 未赋值 — 确认代码里给 result 赋值了？\n例: result = getProjectInfo(__args);)');
                            } else {
                                if (statusEl) { statusEl.textContent = AEI18n.t('✅ 执行完成'); statusEl.className = 'ae-run-status success'; }
                            }
                            if (outputEl) outputEl.textContent = text;
                        }).catch(function(e) {
                            if (statusEl) { statusEl.textContent = AEI18n.t('❌ 错误'); statusEl.className = 'ae-run-status error'; }
                            if (outputEl) outputEl.textContent = String(e);
                        });
                    } catch (e) {
                        if (statusEl) { statusEl.textContent = AEI18n.t('❌ 错误'); statusEl.className = 'ae-run-status error'; }
                        if (outputEl) outputEl.textContent = String(e);
                    }
                });
            }
            // 关闭结果区
            var closeBtn = document.getElementById('aeRunClose');
            if (closeBtn) {
                on(closeBtn, 'click', function() {
                    var el = document.getElementById('aeRunResult');
                    if (el) el.style.display = 'none';
                });
            }

            var codeEl = document.getElementById('aeDrawerCode');
            if (codeEl) {
                on(codeEl, 'input', syncCodeHighlight);
                on(codeEl, 'scroll', function() {
                    var codeTag = document.getElementById('aeDrawerCodeHighlightCode');
                    if (codeTag) {
                        codeTag.style.transform = 'translate(' + (-codeEl.scrollLeft) + 'px,' + (-codeEl.scrollTop) + 'px)';
                    }
                });
            }

            // Schema builder: 初始化参数列表
            var schemaEl = document.getElementById('aeDrawerSchema');
            if (schemaEl) {
                var initSchema = {};
                try { initSchema = JSON.parse(schemaEl.value || '{}'); } catch (_) {}
                var initParams = parseSchemaToParams(initSchema);
                renderSchemaParams(initParams);
            }
            // 添加参数按钮
            var addParamBtn = document.getElementById('aeSchemaAddBtn');
            if (addParamBtn) {
                on(addParamBtn, 'click', function() {
                    var container = document.getElementById('aeSchemaParams');
                    if (!container) return;
                    var idx = container.querySelectorAll('.ae-schema-param-row').length;
                    var row = document.createElement('div');
                    row.className = 'ae-schema-param-row';
                    row.setAttribute('data-index', idx);
                    row.innerHTML = AEI18n.html('<input class="ae-param-name" placeholder="参数名">')
                        + '<select class="ae-param-type">'
                        + '<option value="string" selected>string</option>'
                        + '<option value="number">number</option>'
                        + '<option value="integer">integer</option>'
                        + '<option value="boolean">boolean</option>'
                        + '<option value="array">array</option>'
                        + '<option value="object">object</option>'
                        + '</select>'
                        + AEI18n.html('<input class="ae-param-desc" placeholder="描述">')
                        + '<button class="btn ae-param-remove-btn">×</button>';
                    container.appendChild(row);
                    syncArgsFromSchema();
                });
            }
            // 删除参数按钮 (事件委托)
            var schemaBuilder = document.getElementById('aeSchemaBuilder');
            if (schemaBuilder) {
                on(schemaBuilder, 'click', function(e) {
                    var btn = e.target.closest('.ae-param-remove-btn');
                    if (!btn) return;
                    var row = btn.closest('.ae-schema-param-row');
                    if (row && row.parentNode) {
                        row.parentNode.removeChild(row);
                        syncArgsFromSchema();
                    }
                });
                // 参数名/类型变更时也同步
                on(schemaBuilder, 'input', function(e) {
                    if (e.target.closest('.ae-param-name') || e.target.closest('.ae-param-type')) {
                        syncArgsFromSchema();
                    }
                });
            }

            var saveBtn = document.getElementById('aeDrawerSave');
            if (saveBtn) {
                on(saveBtn, 'click', function() {
                    var nameEl = document.getElementById('aeDrawerName');
                    var descEl = document.getElementById('aeDrawerDesc');
                    var shortDescEl = document.getElementById('aeDrawerShortDesc');
                    var enabledEl = document.getElementById('aeDrawerEnabled');
                    var categoryEl = document.getElementById('aeDrawerCategory');
                    var codeEl = document.getElementById('aeDrawerCode');

                    var name = nameEl ? nameEl.value.trim() : '';
                    if (!name) { if (global.AEToast) global.AEToast.show(AEI18n.t('工具名称不能为空'), 'warn'); return; }
                    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
                        if (global.AEToast) global.AEToast.show(AEI18n.t('工具名称格式无效：只能包含字母、数字、下划线，以字母或下划线开头'), 'warn');
                        return;
                    }

                    // 描述非空前置校验——空描述工具可落盘成功（_aeSaveJson 不校验），
                    // 但 toolRegistry.register 以 MISSING_DESCRIPTION 拒绝：UI 提示成功而工具被
                    // 静默剔除（编辑场景还先把原工具反注册）。在保存入口拦截并提示。
                    var desc = descEl ? descEl.value.trim() : '';
                    if (!desc) { if (global.AEToast) global.AEToast.show(AEI18n.t('工具描述不能为空（Agent 需凭描述判断是否/如何调用该工具）'), 'warn'); return; }

                    // 简单的 ExtendScript 括号平衡检查
                    if (codeEl) {
                        var rawCode = codeEl.value || '';
                        // 改单趟状态机剥离（与 aeToolCreator.checkBracketBalance
                        // 同步）—— 的「先剥注释再剥字符串」链式替换有反向盲区：
                        // 字符串内的 //（"http://a"、file:///）被当行注释起点，整行后半段
                        // 连带闭引号/闭括号被剥掉，括号计数失真、合法工具被误拒；单趟扫描
                        // 同时跟踪字符串/注释上下文，注释撇号与字符串 // 两侧都正确
                        var cleanCode = _stripCommentsAndStrings(rawCode);
                        // 字符串/注释剥离后增补正则字面量剥离（/\(/ 等正则中的括号不再干扰计数，
                        // 与 aeToolCreator.checkBracketBalance 同步修复）
                        cleanCode = stripRegexLiterals(cleanCode);
                        var depth = 0;
                        var bracketErr = null;
                        for (var bi = 0; bi < cleanCode.length; bi++) {
                            var ch = cleanCode[bi];
                            if (ch === '{' || ch === '(' || ch === '[') depth++;
                            else if (ch === '}' || ch === ')' || ch === ']') depth--;
                            if (depth < 0) { bracketErr = ch; break; }
                        }
                        if (bracketErr) {
                            if (global.AEToast) global.AEToast.show(AEI18n.t('ExtendScript 语法疑似有问题：意外的 "') + bracketErr + AEI18n.t('"（括号/花括号不匹配）'), 'warn');
                            return;
                        }
                        if (depth !== 0) {
                            if (global.AEToast) global.AEToast.show(AEI18n.t('ExtendScript 语法疑似有问题：括号/花括号未配对（差 ') + depth + AEI18n.t(' 个开括号）'), 'warn');
                            return;
                        }
                    }

                    var schemaObj = buildSchemaFromParams();

                    var stubEl = document.getElementById('aeDrawerStub');
                    var readOnlyEl = document.getElementById('aeDrawerReadOnly');

                    // 读取作用域：勾「全局」→ global；否则收集勾选的模块（至少一个，空则回退 agent）
                    var scopeGlobalEl = document.getElementById('aeDrawerScopeGlobal');
                    var scopeAgentEl = document.getElementById('aeDrawerScopeAgent');
                    var scopeScriptEl = document.getElementById('aeDrawerScopeScript');
                    var scopeShaderEl = document.getElementById('aeDrawerScopeShader');
                    var scopeExternalEl = document.getElementById('aeDrawerScopeExternal');
                    var scope;
                    if (scopeGlobalEl && scopeGlobalEl.checked) {
                        scope = { type: 'global' };
                    } else {
                        var mods = [];
                        if (scopeAgentEl && scopeAgentEl.checked) mods.push('agent');
                        if (scopeScriptEl && scopeScriptEl.checked) mods.push('script');
                        if (scopeShaderEl && scopeShaderEl.checked) mods.push('shader');
                        // 外接必须能留：漏它是「外接列着但一调就拒」（见渲染处注释）
                        if (scopeExternalEl && scopeExternalEl.checked) mods.push('external-mcp');
                        scope = { type: 'module', moduleIds: mods.length ? mods : ['agent'] };
                    }

                    var toolDef = {
                        name: name,
                        description: desc,
                        shortDescription: shortDescEl ? shortDescEl.value.trim() : '',
                        input_schema: schemaObj,
                        enabled: enabledEl ? enabledEl.checked : true,
                        category: categoryEl ? categoryEl.value : 'custom',
                        extendScript: codeEl ? codeEl.value.trim() || null : null,
                        stub: stubEl ? stubEl.checked : true,
                        readOnly: readOnlyEl ? readOnlyEl.checked : false,
                        scope: scope
                    };
                    // 保留表单未覆盖的元数据字段（如 createdBy），避免编辑保存后丢失标记
                    var existingTool = editingToolName ? controller.getTool(editingToolName) : null;
                    if (existingTool && existingTool.createdBy) {
                        toolDef.createdBy = existingTool.createdBy;
                    } else if (!existingTool) {
                        toolDef.createdBy = 'user';
                    }

                    var doSave = function () {
                        controller.saveTool(toolDef, editingToolName).then(function(ok) {
                            if (ok) closeDrawer();
                            // 保存失败已回滚内存，刷新表格反映实际状态
                            refreshTable();
                        });
                    };

                    // 自定义 ExtendScript 安全检查：警告可能被 LLM 调用的危险操作
                    var es = toolDef.extendScript;
                    var confirmDanger = function () {
                        if (es && /\bFile\s*\(|\bFolder\s*\(|system\.callSystem\s*\(|\bSocket\b/i.test(es)) {
                            if (typeof global.showConfirm === 'function') {
                                global.showConfirm(AEI18n.t('保存工具'), AEI18n.t('自定义 ExtendScript 包含文件操作或系统调用。') +
                                    AEI18n.t('Agent 模式下 LLM 可以直接调用此工具，文件写入/删除/系统命令/网络通信等操作可能造成数据损坏或外泄。') +
                                    AEI18n.t('如果这仅是读取操作或您信任此工具的用途，可以继续保存。检测到的危险模式：File / Folder / system.callSystem / Socket。确定要保存吗？')).then(function(ok) {
                                    if (ok) doSave();
                                });
                            } else {
                                if (confirm(AEI18n.t('自定义 ExtendScript 包含文件操作或系统调用，确定要保存吗？'))) doSave();
                            }
                            return;
                        }
                        doSave();
                    };
                    // 重名保护（一）：与内建/其它模块的工具同名 → 直接拒绝，不进入保存流程。
                    // 必须排在「确认覆盖」之前：那条确认是给自定义工具之间的覆盖用的，
                    // 让用户先确认再失败（controller._saveTool 同判据会拒）是误导。
                    var takenEntry = (controller && typeof controller.isNameTakenByBuiltin === 'function')
                        ? controller.isNameTakenByBuiltin(name) : null;
                    if (takenEntry) {
                        if (global.AEToast) {
                            global.AEToast.show('"' + name + AEI18n.t('" 已被内建工具占用')
                                + (takenEntry.source ? AEI18n.t('（来源 ') + takenEntry.source + AEI18n.punct('）', ')') : '')
                                + AEI18n.t('，不能创建或覆盖同名工具。请换一个名称。'), 'error');
                        }
                        return;
                    }
                    // 重名保护（二）：与其他自定义工具同名时需确认，防止静默覆盖现有工具定义
                    if (name !== editingToolName && controller && typeof controller.getTool === 'function' && controller.getTool(name)) {
                        var clashMsg = AEI18n.t('已存在名为 "{name}" 的工具，继续保存将覆盖其全部定义（不可撤销）。确定覆盖吗？', { name: name });
                        if (typeof global.showConfirm === 'function') {
                            global.showConfirm(AEI18n.t('覆盖现有工具'), clashMsg).then(function(ok) {
                                if (ok) confirmDanger();
                            });
                        } else if (confirm(clashMsg)) {
                            confirmDanger();
                        }
                        return;
                    }
                    confirmDanger();
                });
            }
        }

        function destroy() { offAll(); }

        return {
            render: render,
            refreshTable: refreshTable,
            openDrawer: openDrawer,
            closeDrawer: closeDrawer,
            destroy: destroy
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createAEToolsView = createAEToolsView;

})(window);
