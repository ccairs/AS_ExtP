(function (global) {
    'use strict';

    // ============================================================================
    // 官方模板库浏览 modal（搜索 Comfy-Org 官方索引 → 选中条目拉取转换注册）
    // 表单视图与画布顶栏共用同一份实现：AEComfyUI.officialTemplateModal.open/close。
    // overlay 挂在 document.body，关闭即移除（不常驻）；打开前先关旧 overlay（单实例）。
    // 「添加」成功关闭并回报调用方 status(msg, kind) / onAdded(entry)；失败留在状态行。
    // 顶层不触 DOM，缺失 document 的环境可载入、open/close 静默。
    // ============================================================================

    var OVERLAY_ID = 'comfyuiOfficialTplOverlay';
    var LIST_ID = 'comfyuiOfficialTplList';
    var STATUS_ID = 'comfyuiOfficialTplStatus';
    var PAGE_SIZE = 10;

    // 当前 modal 会话状态：{offset, query, category, controller, status, onAdded}
    var _state = null;
    // 搜索请求令牌：每次 _searchPage 递增，只有最新一次请求的响应可以写列表。
    // 连点搜索/翻页时前后两次请求会重叠，过期响应写入会与最新响应叠成两份列表。
    var _searchToken = 0;

    function _report(state, msg, kind) {
        if (state && typeof state.status === 'function') state.status(msg, kind);
    }

    function close() {
        if (typeof document === 'undefined' || !document) {
            _state = null;
            return;
        }
        var overlay = document.getElementById(OVERLAY_ID);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        _state = null;
    }

    async function _searchPage() {
        var st = _state;
        if (!st) return;
        if (typeof document === 'undefined' || !document) return;
        var listEl = document.getElementById(LIST_ID);
        var statusEl = document.getElementById(STATUS_ID);
        if (!listEl) return;
        var myToken = ++_searchToken;
        listEl.innerHTML = '';
        if (statusEl) statusEl.textContent = AEI18n.t('搜索中…');
        if (!st.controller || typeof st.controller.searchOfficialTemplates !== 'function') {
            if (statusEl) statusEl.textContent = AEI18n.t('搜索失败');
            return;
        }
        try {
            var resp = await st.controller.searchOfficialTemplates(st.query, st.category, PAGE_SIZE, st.offset);
            // 搜索期间 modal 已关闭或重开，或又发起了新搜索：过期响应不写入列表
            if (_state !== st || myToken !== _searchToken) return;
            if (!resp || !resp.ok) {
                if (statusEl) statusEl.textContent = (resp && resp.error) || AEI18n.t('搜索失败');
                return;
            }
            _renderList(st, resp, listEl, statusEl);
        } catch (e) {
            if (_state !== st || myToken !== _searchToken) return;
            if (statusEl) statusEl.textContent = AEI18n.t('搜索失败: {error}', { error: e && e.message ? e.message : e });
        }
    }

    function _renderList(st, resp, listEl, statusEl) {
        if (typeof document === 'undefined' || !document) return;
        var entries = (resp && Array.isArray(resp.entries)) ? resp.entries : null;
        if (!entries || !resp.total) {
            if (statusEl) statusEl.textContent = AEI18n.t('无匹配模板，换个关键词试试（如 flux / 图生视频 / upscale）');
            return;
        }
        if (statusEl) statusEl.textContent = '';
        entries.forEach(function (e) {
            var name = e.name;
            var row = document.createElement('div');
            row.className = 'comfyui-official-tpl-row';
            var title = document.createElement('div');
            title.className = 'comfyui-official-tpl-title';
            title.textContent = e.title || name;
            var meta = document.createElement('div');
            meta.className = 'comfyui-official-tpl-meta';
            var metaParts = [];
            if (e.type) metaParts.push(e.type);
            if (e.needsImage) metaParts.push(AEI18n.t('需要输入图片'));
            if (!e.openSource) metaParts.push(AEI18n.t('云端/API（消耗额度）'));
            // 分隔符用语言中立间隔点：纯标点串不含汉字，抽 key 器不收（keys.json 只收含汉字的串），
            // 因此不设标点 key，中英文下都不出现对方语言的全角/半角标点。
            var metaText = metaParts.join(' · ');
            meta.textContent = e.description ? (metaText ? metaText + ' · ' : '') + e.description : metaText;
            var addBtn = document.createElement('button');
            addBtn.className = 'btn secondary comfyui-official-tpl-add';
            addBtn.textContent = AEI18n.t('添加');
            addBtn.title = AEI18n.t('拉取并转换为表单/画布可用模板');
            addBtn.addEventListener('click', function () {
                var clickState = _state;
                if (!clickState) return;
                var ctrl = clickState.controller;
                if (!ctrl || typeof ctrl.fetchOfficialTemplate !== 'function') {
                    if (statusEl) statusEl.textContent = AEI18n.t('添加失败');
                    return;
                }
                addBtn.disabled = true;
                addBtn.textContent = AEI18n.t('添加中…');
                ctrl.fetchOfficialTemplate(name).then(function (r) {
                    if (r && r.ok) {
                        var addedName = (r.data && r.data.name) ? r.data.name : name;
                        close();
                        _report(clickState, AEI18n.t('已添加官方模板: {name}', { name: addedName }), 'success');
                        if (typeof clickState.onAdded === 'function') clickState.onAdded(r.data);
                    } else {
                        addBtn.disabled = false;
                        addBtn.textContent = AEI18n.t('添加');
                        var msg = (r && r.error && r.error.message) ? r.error.message : AEI18n.t('添加失败');
                        if (statusEl) statusEl.textContent = msg;
                    }
                }).catch(function (e2) {
                    addBtn.disabled = false;
                    addBtn.textContent = AEI18n.t('添加');
                    if (statusEl) statusEl.textContent = AEI18n.t('添加失败: {error}', { error: e2 && e2.message ? e2.message : e2 });
                });
            });
            row.appendChild(title);
            row.appendChild(meta);
            row.appendChild(addBtn);
            listEl.appendChild(row);
        });
        // 翻页按钮
        var pager = document.createElement('div');
        pager.className = 'comfyui-official-tpl-pager';
        if (st.offset > 0) {
            var prev = document.createElement('button');
            prev.className = 'btn secondary';
            prev.textContent = AEI18n.t('上一页');
            prev.addEventListener('click', function () {
                st.offset = Math.max(0, st.offset - PAGE_SIZE);
                _searchPage();
            });
            pager.appendChild(prev);
        }
        pager.appendChild(document.createTextNode(' ' + (st.offset + 1) + '-' + Math.min(st.offset + PAGE_SIZE, resp.total) + ' / ' + resp.total + ' '));
        if (resp.hasMore) {
            var next = document.createElement('button');
            next.className = 'btn secondary';
            next.textContent = AEI18n.t('下一页');
            next.addEventListener('click', function () {
                st.offset = st.offset + PAGE_SIZE;
                _searchPage();
            });
            pager.appendChild(next);
        }
        listEl.appendChild(pager);
    }

    function open(opts) {
        if (typeof document === 'undefined' || !document || !document.body) return;
        close();
        var options = opts || {};
        _state = {
            offset: 0,
            query: '',
            category: '',
            controller: options.controller || null,
            status: options.status,
            onAdded: options.onAdded
        };

        var overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.className = 'comfyui-official-tpl-overlay';

        var panel = document.createElement('div');
        panel.className = 'comfyui-official-tpl-panel';

        // 头部：标题 + 关闭
        var head = document.createElement('div');
        head.className = 'comfyui-official-tpl-head';
        var title = document.createElement('div');
        title.className = 'comfyui-official-tpl-head-title';
        title.textContent = AEI18n.t('官方模板库（Comfy-Org/workflow_templates，600+ 套持续更新）');
        var closeBtn = document.createElement('button');
        closeBtn.className = 'btn secondary';
        closeBtn.textContent = '✕';
        closeBtn.title = AEI18n.t('关闭');
        closeBtn.addEventListener('click', close);
        head.appendChild(title);
        head.appendChild(closeBtn);

        // 搜索行：输入 + 分类 + 搜索按钮
        var searchRow = document.createElement('div');
        searchRow.className = 'comfyui-official-tpl-search';
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = AEI18n.t('搜索关键词（如 flux / 图生视频 / upscale / kling）');
        var catSel = document.createElement('select');
        ['', 'video', 'image', 'api'].forEach(function (c) {
            var o = document.createElement('option');
            o.value = c;
            o.textContent = c === '' ? AEI18n.t('全部分类')
                : (c === 'video' ? AEI18n.t('视频') : (c === 'image' ? AEI18n.t('图片') : AEI18n.t('API/云端')));
            catSel.appendChild(o);
        });
        var searchBtn = document.createElement('button');
        searchBtn.className = 'btn';
        searchBtn.textContent = AEI18n.t('搜索');
        function doSearch() {
            if (!_state) return;
            _state.offset = 0;
            _state.query = input.value;
            _state.category = catSel.value;
            _searchPage();
        }
        searchBtn.addEventListener('click', doSearch);
        input.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doSearch();
        });
        searchRow.appendChild(input);
        searchRow.appendChild(catSel);
        searchRow.appendChild(searchBtn);

        // 列表 + 状态
        var listEl = document.createElement('div');
        listEl.id = LIST_ID;
        listEl.className = 'comfyui-official-tpl-list';
        var statusEl = document.createElement('div');
        statusEl.id = STATUS_ID;
        statusEl.className = 'comfyui-official-tpl-status';
        statusEl.textContent = AEI18n.t('输入关键词搜索官方模板库');

        panel.appendChild(head);
        panel.appendChild(searchRow);
        panel.appendChild(listEl);
        panel.appendChild(statusEl);
        overlay.appendChild(panel);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) close();
        });
        document.body.appendChild(overlay);
        input.focus();
    }

    global.AEComfyUI = global.AEComfyUI || {};
    global.AEComfyUI.officialTemplateModal = {
        open: open,
        close: close
    };
})(window);
