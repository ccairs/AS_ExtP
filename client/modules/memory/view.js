(function (global) {

  // 记忆模块的提示走 AEShared.createStatusFacade()（内部转发全局 AEToast）。
  // 不再吃 agent 模块泄漏的全局 showStatus（其 #status 在 memory 视图下不可见）。
  var _statusFacade = null;
  function showStatus(message, type) {
    if (!_statusFacade && global.AEShared && typeof global.AEShared.createStatusFacade === 'function') {
      _statusFacade = global.AEShared.createStatusFacade();
    }
    if (_statusFacade) {
      _statusFacade.show(message, type);
    }
  }

  // 删除类确认统一走全局 showConfirm（原生 confirm 禁用）。showConfirm 缺席
  // （Agent app 未装载等异常装载态）或调用失败时不降级到原生 confirm：明确提示并
  // 取消本次删除（fail-closed，不留「没确认就删了」的路径）。
  function _askConfirm(title, message, type) {
    if (typeof global.showConfirm === 'function') {
      try {
        return Promise.resolve(global.showConfirm(title, message, type)).then(function (ok) {
          return !!ok;
        }, function () { return false; });
      } catch (e) {
        console.warn('[Memory] showConfirm 调用失败: ' + e);
      }
    }
    showStatus(AEI18n.t('确认弹窗不可用，已取消删除（请重启面板后重试）'), 'error');
    return Promise.resolve(false);
  }

  // getter：取值时才查词典，顶层只建形状、不触发翻译
  var TYPE_LABELS = {
    get lesson() { return AEI18n.t('经验'); },
    get project() { return AEI18n.t('项目'); },
    get preference() { return AEI18n.t('偏好'); },
    get rule() { return AEI18n.t('规则'); }
  };
  var SCOPE_LABELS = {
    get script() { return AEI18n.t('Script'); },
    get agent() { return AEI18n.t('Agent'); },
    get shader() { return AEI18n.t('Shader'); },
    get both() { return AEI18n.t('通用'); }
  };
  // 列表分组顺序，对齐 memoryRegistry 的 VALID_TYPES
  var GROUP_ORDER = ['lesson', 'project', 'preference'];

  function createMemoryView(controller, container) {
    var _ctrl = controller;
    var _el = container;
    var _expandedName = null;
    var _scopeFilter = 'all';
    var _activeTab = 'memories';
    // 多选删除（管理模式）：_selectedNames 按 name 记录选中（跨过滤条件保留），
    // _filteredNames 缓存当前过滤结果（"全选"的作用域），由 refreshList 刷新
    var _selectMode = false;
    var _selectedNames = {};
    var _filteredNames = [];

    // DOM cache
    var _listEl = null;
    var _searchInput = null;
    var _editorEl = null;
    var _countEl = null;
    var _editingName = null;
    var _searchTimer = null;
    var _searchDebounceMs = 250;

    function _escapeHtml(str) {
      if (!str) return '';
      return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 时间戳（存储口径为 UTC ISO）→ 本地时间（YYYY-MM-DD HH:mm，对齐 agent 侧
    // fmtTime 风格）。未记录/不可解析回空串，调用方显示「未记录」
    function _formatStamp(iso) {
      if (!iso) return '';
      var d = new Date(iso);
      if (isNaN(d.getTime())) return '';
      var pad = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
        + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /**
     * 索引读失败态判据——失败态下条目集不可信，编辑/删除入口据此拒绝并回
     * 如实文案（与空态「记忆索引读取失败（可重启面板重试）」同口径），不尝试写盘。
     */
    function _indexReadFailedNow() {
      var registry = _ctrl.getRegistry();
      return !!(registry && typeof registry.isIndexReadFailed === 'function' && registry.isIndexReadFailed());
    }

    function _showIndexReadFailed(actionLabel) {
      showStatus(AEI18n.t('记忆索引读取失败（可重启面板重试），无法') + actionLabel + AEI18n.t('（未执行任何写盘）'), 'error');
    }

    /**
     * Escape a value for safe use in HTML attribute values (double-quoted).
     */
    function _escapeAttr(str) {
      if (!str) return '';
      return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    /**
     * Build the complete panel HTML
     */
    function _buildHtml() {
      var html = '';

      // Tabs
      html += '<div class="memory-tabs">';
      html += AEI18n.html('<button class="memory-tab active" data-tab="memories" id="memoryTabMemories">记忆</button>');
      html += AEI18n.html('<button class="memory-tab" data-tab="rules" id="memoryTabRules">规则</button>');
      html += '</div>';

      // Toolbar
      html += '<div class="memory-toolbar">';
      html += '<div class="memory-scope-filters" id="memoryScopeFilters">';
      html += AEI18n.html('<button class="memory-scope-btn active" data-scope="all">全部</button>');
      html += '<button class="memory-scope-btn" data-scope="script">Script</button>';
      html += '<button class="memory-scope-btn" data-scope="agent">Agent</button>';
      html += '<button class="memory-scope-btn" data-scope="shader">Shader</button>';
      html += '</div>';
      html += '<div class="memory-search-wrap">';
      html += AEI18n.html('<input type="text" class="memory-search-input" id="memorySearchInput" placeholder="搜索记忆...">');
      html += '</div>';
      html += AEI18n.html('<button class="btn" id="memoryNewBtn">新建</button>');
      html += AEI18n.html('<button class="btn secondary" id="memoryManageBtn">管理</button>');
      // 管理模式批量操作按钮（默认隐藏，_updateSelectToolbar 同步显隐）
      html += AEI18n.html('<button class="btn secondary hidden" id="memorySelectAllBtn">全选</button>');
      html += AEI18n.html('<button class="btn danger hidden" id="memoryBatchDeleteBtn">删除 (0)</button>');
      html += AEI18n.html('<button class="btn secondary hidden" id="memoryExitSelectBtn">取消</button>');
      html += '</div>';

      // Editor modal
      html += '<div class="memory-modal-mask hidden" id="memoryEditorModal">';
      html += '<div class="memory-modal">';
      html += '<div class="memory-modal-head">';
      html += AEI18n.html('<span class="memory-modal-title" id="memoryEditorTitle">新建记忆</span>');
      html += '</div>';
      html += '<div class="memory-modal-body">';
      html += '<div class="memory-modal-row">';
      html += AEI18n.html('<label>名称</label>');
      html += AEI18n.html('<input type="text" id="memoryEditName" placeholder="例如：my-coding-style">');
      html += '</div>';
      html += '<div class="memory-modal-row">';
      html += AEI18n.html('<label>描述</label>');
      html += AEI18n.html('<input type="text" id="memoryEditDesc" placeholder="一句话描述">');
      html += '</div>';
      html += '<div class="memory-modal-row memory-inline-row">';
      html += AEI18n.html('<div class="memory-inline-field"><label for="memoryEditType">类型</label><select id="memoryEditType"></select></div>');
      html += '<div class="memory-inline-field"><label for="memoryEditScope">Scope</label><select id="memoryEditScope"></select></div>';
      html += '</div>';
      html += '<div class="memory-modal-row">';
      html += AEI18n.html('<label>正文 (Markdown)</label>');
      html += AEI18n.html('<textarea id="memoryEditContent" rows="6" class="ae-scrollbar" placeholder="记忆正文，支持 Markdown。用 [[名称]] 引用其他记忆"></textarea>');
      html += '</div>';
      html += '</div>';
      html += '<div class="memory-modal-footer">';
      html += AEI18n.html('<button class="btn secondary" id="memoryEditorCancel">取消</button>');
      html += AEI18n.html('<button class="btn" id="memoryEditorSave">创建</button>');
      html += '</div>';
      html += '</div>';
      html += '</div>';

      // List container
      html += '<div class="memory-list ae-scrollbar" id="memoryList"></div>';

      // Footer count
      html += '<div class="memory-footer">';
      html += AEI18n.html('<span class="memory-count" id="memoryCount">共 0 条记忆</span>');
      html += '</div>';

      return html;
    }

    /**
     * Extract [[link]] references from content (delegates to controller if available)
     */
    function _extractLinksFromContent(content) {
      if (_ctrl._extractLinks) {
        return _ctrl._extractLinks(content);
      }
      // Fallback
      var linkRegex = /\[\[([^\]]+)\]\]/g;
      var links = [];
      var match;
      while ((match = linkRegex.exec(content || '')) !== null) {
        var linkTarget = match[1].trim();
        var pipeIdx = linkTarget.indexOf('|');
        if (pipeIdx !== -1) {
          linkTarget = linkTarget.substring(0, pipeIdx).trim();
        }
        if (linkTarget && links.indexOf(linkTarget) === -1) links.push(linkTarget);
      }
      return links;
    }

    /**
     * Render a single memory row
     */
    function _renderMemoryRow(entry) {
      // 管理模式下不展开详情（行点击让位给选中切换）
      var isExpanded = _expandedName === entry.name && !_selectMode;
      var isSelected = _selectMode && !!_selectedNames[entry.name];
      var typeLabel = TYPE_LABELS[entry.type] || entry.type;
      var html = '<div class="memory-row' + (isSelected ? ' selected' : '') + '" data-name="' + _escapeAttr(entry.name) + '">';
      html += '<div class="memory-row-header">';
      // 顺序：[管理模式复选框] → 文件图标 → 类型徽章（经验等）→ 类别徽章 → 名称 → 描述 → 关系 → 操作
      if (_selectMode) {
        html += '<span class="memory-row-check"><span class="memory-icon-check"></span></span>';
      }
      html += '<span class="memory-row-icon"><span class="memory-icon-file"></span></span>';
      html += '<span class="memory-type-badge memory-type-' + _escapeAttr(entry.type) + '">' + _escapeHtml(typeLabel) + '</span>';
      var scope = entry.scope || 'both';
      html += '<span class="memory-scope-badge memory-scope-' + _escapeAttr(scope) + '">' + _escapeHtml(SCOPE_LABELS[scope] || scope) + '</span>';
      html += '<span class="memory-row-name">' + _escapeHtml(entry.name) + '</span>';
      html += '<span class="memory-row-desc">' + _escapeHtml(entry.description) + '</span>';
      // 折叠态关系指示：↗引用数 ↖被引用数（无关系不渲染，展开后可见明细标签）
      var linksCount = (entry.links && entry.links.length) || 0;
      var backlinksCount = (entry.backlinks && entry.backlinks.length) || 0;
      if (linksCount > 0 || backlinksCount > 0) {
        var relText = (linksCount > 0 ? '↗' + linksCount : '') + (backlinksCount > 0 ? ' ↖' + backlinksCount : '');
        html += '<span class="memory-rel-badge" title="' + AEI18n.t('引用 {out} 条 / 被引用 {in} 条', { out: linksCount, in: backlinksCount }) + '">' + _escapeHtml(relText) + '</span>';
      }
      // 管理模式隐藏行内编辑/删除（批量操作统一走工具栏，减少误触）
      if (!_selectMode) {
        html += '<div class="memory-row-actions">';
        html += '<button class="btn secondary memory-edit-btn" data-name="' + _escapeAttr(entry.name) + '"><span class="memory-icon-edit"></span></button>';
        html += '<button class="btn danger memory-delete-btn" data-name="' + _escapeAttr(entry.name) + '"><span class="memory-icon-delete"></span></button>';
        html += '</div>';
      }
      html += '</div>';

      // Expanded detail
      if (isExpanded) {
        html += '<div class="memory-row-body">';
        // 时间标注行：创建/修改（标时间戳上线前建的旧条目无记录，如实显示「未记录」）
        html += AEI18n.html('<div class="memory-row-times">创建：') + (_escapeHtml(_formatStamp(entry.created)) || AEI18n.t('未记录'))
          + AEI18n.t(' · 更新：') + (_escapeHtml(_formatStamp(entry.updated)) || AEI18n.t('未记录')) + '</div>';
        html += '<pre class="memory-content-preview">' + _escapeHtml(entry.content || '(无正文)') + '</pre>';

        var links = entry.links || [];
        var backlinks = entry.backlinks || [];
        html += '<div class="memory-links">';
        html += AEI18n.html('<span class="memory-links-label"><span class="memory-icon-link"></span>引用：</span>');
        if (links.length > 0) {
          for (var l = 0; l < links.length; l++) {
            html += '<span class="memory-link-tag" data-name="' + _escapeAttr(links[l]) + '">' + _escapeHtml(links[l]) + '</span>';
          }
        } else {
          html += AEI18n.html('<span class="memory-links-none">无</span>');
        }
        html += AEI18n.html(' | <span class="memory-links-label">被引用：</span>');
        if (backlinks.length > 0) {
          for (var b = 0; b < backlinks.length; b++) {
            html += '<span class="memory-link-tag" data-name="' + _escapeAttr(backlinks[b]) + '">' + _escapeHtml(backlinks[b]) + '</span>';
          }
        } else {
          html += AEI18n.html('<span class="memory-links-none">无</span>');
        }
        html += '</div>';
        html += '</div>';
      }

      html += '</div>';
      return html;
    }

    /**
     * 客户端搜索：空格分隔多词 AND 匹配（registry.search 为 OR 排序，此处更严格）
     */
    function _matchesSearchText(entry, searchText) {
      if (!searchText) return true;
      var words = searchText.toLowerCase().split(/\s+/).filter(function (w) { return w.length > 0; });
      if (words.length === 0) return true;
      var haystack = (entry.name + ' ' + entry.description + ' ' + (entry.content || '')).toLowerCase();
      for (var w = 0; w < words.length; w++) {
        if (haystack.indexOf(words[w]) === -1) return false;
      }
      return true;
    }

    /**
     * Refresh the list display from registry data
     */
    function refreshList() {
      if (!_listEl) return;
      var registry = _ctrl.getRegistry();
      var all = registry ? registry.getAll() : [];
      var searchText = _searchInput ? _searchInput.value.trim() : '';

      // Rule tab — 就地编辑（textarea 直接在卡片内，不再弹窗）
      if (_activeTab === 'rules') {
        var html = '';
        var scopes = ['script', 'agent', 'shader'];
        for (var s = 0; s < scopes.length; s++) {
          if (_scopeFilter !== 'all' && _scopeFilter !== scopes[s]) continue;
          var rule = registry && registry.getRule ? registry.getRule(scopes[s]) : null;
          var ruleContent = rule ? (rule.content || '') : '';
          html += '<div class="memory-rule-card">';
          html += '<div class="memory-rule-header">';
          html += '<span class="memory-scope-badge memory-scope-' + scopes[s] + '">' + (SCOPE_LABELS[scopes[s]] || scopes[s]) + '</span>';
          html += '<span class="memory-rule-status">' + (ruleContent ? ruleContent.length + AEI18n.t(' 字符') : AEI18n.t('未设置')) + '</span>';
          html += '</div>';
          html += '<textarea class="memory-rule-editor ae-scrollbar" data-scope="' + scopes[s] + '" placeholder="' + AEI18n.t('输入 ') + (SCOPE_LABELS[scopes[s]] || scopes[s]) + AEI18n.t(' 模式行为规则...') + '">' + _escapeHtml(ruleContent) + '</textarea>';
          html += '<div class="memory-rule-actions">';
          html += '<button class="btn memory-rule-save-btn" data-scope="' + scopes[s] + '">' + AEI18n.t('保存') + '</button>';
          html += '</div>';
          html += '</div>';
        }
        _listEl.innerHTML = html || AEI18n.html('<div class="memory-empty">暂无规则</div>');
        if (_countEl) _countEl.textContent = '';
        // 规则页无多选语义：清空过滤缓存并同步工具栏（批量按钮隐藏）
        _filteredNames = [];
        _updateSelectToolbar();
        // 保存：写回 store 并就地更新本卡字符数状态（不整表 refreshList——
        // 重绘会丢弃其他卡片未保存的编辑内容）
        var ruleSaveBtns = _listEl.querySelectorAll('.memory-rule-save-btn');
        for (var rs = 0; rs < ruleSaveBtns.length; rs++) {
          ruleSaveBtns[rs].addEventListener('click', function () {
            var scope = this.getAttribute('data-scope');
            var ta = _listEl.querySelector('.memory-rule-editor[data-scope="' + scope + '"]');
            if (!ta) return;
            var ok = _ctrl.getRegistry().setRule(scope, ta.value);
            if (!ok) { showStatus(AEI18n.t('保存规则失败'), 'error'); return; }
            showStatus((SCOPE_LABELS[scope] || scope) + AEI18n.t(' 模式规则已保存'), 'success');
            var card = ta.parentElement;
            if (card) {
              var statusEl = card.querySelector('.memory-rule-status');
              if (statusEl) statusEl.textContent = ta.value ? (ta.value.length + AEI18n.t(' 字符')) : AEI18n.t('未设置');
            }
          });
        }
        return;
      }

      // Filter by scope
      var filtered = all;
      if (_scopeFilter !== 'all') {
        filtered = [];
        for (var i = 0; i < all.length; i++) {
          var s = all[i].scope || 'both';
          if (s === _scopeFilter || s === 'both') filtered.push(all[i]);
        }
      }
      // Filter by search text (multi-word AND；在 scope 过滤结果之上叠加)
      if (searchText) {
        var searched = [];
        for (var i = 0; i < filtered.length; i++) {
          if (_matchesSearchText(filtered[i], searchText)) {
            searched.push(filtered[i]);
          }
        }
        filtered = searched;
      }

      // 缓存过滤结果名列表："全选"按钮的作用域（管理模式下跨搜索/scope 切换保留已选）
      _filteredNames = [];
      for (var fn = 0; fn < filtered.length; fn++) _filteredNames.push(filtered[fn].name);

      if (filtered.length === 0) {
        // 索引读失败（registry 重试后仍失败）时空态如实说明，不显示
        // 「暂无记忆。点击 + 新建」——数据仍在磁盘上，误导文案会诱导用户重建
        var indexReadFailed = !searchText && registry
          && typeof registry.isIndexReadFailed === 'function'
          && !!registry.isIndexReadFailed();
        _listEl.innerHTML = '<div class="memory-empty">'
          + (searchText ? AEI18n.t('无匹配结果')
            : (indexReadFailed ? AEI18n.t('记忆索引读取失败（可重启面板重试）') : AEI18n.t('暂无记忆。点击 "+ 新建" 创建一条吧。')))
          + '</div>';
      } else {
        var html = '';
        // 按 type 分组渲染（顺序对齐 VALID_TYPES：经验/项目/偏好），空分组不渲染；
        // 未知类型（手改 frontmatter 等旁路数据）归入尾部"其他"组
        var groups = {};
        var extraTypes = [];
        for (var i = 0; i < filtered.length; i++) {
          var t = filtered[i].type;
          if (GROUP_ORDER.indexOf(t) === -1 && extraTypes.indexOf(t) === -1) extraTypes.push(t);
          if (!groups[t]) groups[t] = [];
          groups[t].push(filtered[i]);
        }
        var renderGroup = function (type, entries) {
          html += '<div class="memory-group-header">';
          html += '<span class="memory-group-title">' + _escapeHtml(TYPE_LABELS[type] || type) + '</span>';
          html += '<span class="memory-group-count">' + entries.length + '</span>';
          html += '</div>';
          for (var g = 0; g < entries.length; g++) {
            html += _renderMemoryRow(entries[g]);
          }
        };
        for (var gi = 0; gi < GROUP_ORDER.length; gi++) {
          if (groups[GROUP_ORDER[gi]]) renderGroup(GROUP_ORDER[gi], groups[GROUP_ORDER[gi]]);
        }
        for (var xi = 0; xi < extraTypes.length; xi++) {
          if (groups[extraTypes[xi]]) renderGroup(extraTypes[xi], groups[extraTypes[xi]]);
        }
        _listEl.innerHTML = html;
      }

      if (_countEl) {
        _countEl.textContent = AEI18n.t('共 ') + all.length + AEI18n.t(' 条记忆') + (searchText ? AEI18n.t('（显示 ') + filtered.length + AEI18n.t(' 条）') : '');
      }

      _bindRowEvents();
      _updateSelectToolbar();
    }

    /**
     * Bind click events on list rows
     */
    function _bindRowEvents() {
      if (!_listEl) return;

      // Click header → toggle expand（管理模式下 → toggle select）
      var headers = _listEl.querySelectorAll('.memory-row-header');
      for (var i = 0; i < headers.length; i++) {
        (function (header) {
          header.addEventListener('click', function () {
            var name = header.parentElement.getAttribute('data-name');
            // 管理模式：整行点击切换选中，不展开
            if (_selectMode) {
              _toggleSelect(name);
              return;
            }
            _expandedName = (_expandedName === name) ? null : name;
            refreshList();
          });
        })(headers[i]);
      }

      // Edit button
      var editBtns = _listEl.querySelectorAll('.memory-edit-btn');
      for (var j = 0; j < editBtns.length; j++) {
        editBtns[j].addEventListener('click', function (e) {
          e.stopPropagation();
          showEditor(this.getAttribute('data-name'));
        });
      }

      // Delete button
      var deleteBtns = _listEl.querySelectorAll('.memory-delete-btn');
      for (var k = 0; k < deleteBtns.length; k++) {
        deleteBtns[k].addEventListener('click', function (e) {
          e.stopPropagation();
          _confirmDelete(this.getAttribute('data-name'));
        });
      }

      // Link tag click → expand that memory and scroll it into view
      var linkTags = _listEl.querySelectorAll('.memory-link-tag');
      for (var l = 0; l < linkTags.length; l++) {
        linkTags[l].addEventListener('click', function (e) {
          e.stopPropagation();
          var target = this.getAttribute('data-name');
          _expandedName = target;
          refreshList();
          // 重绘后定位目标行：列表较长时目标可能在视口外，只展开不滚动等于没跳转。
          // target 原样拼进属性选择器，[[x"y]] 等含引号/反斜杠的链接目标会拼出
          // 非法 selector，querySelector 直接抛未捕获 DOMException。改为遍历行做
          // data-name 属性值全等匹配，完全绕开 selector 解析。
          var rows = _listEl.querySelectorAll('.memory-row');
          var row = null;
          for (var ri = 0; ri < rows.length; ri++) {
            if (rows[ri].getAttribute('data-name') === target) { row = rows[ri]; break; }
          }
          if (row && typeof row.scrollIntoView === 'function') {
            row.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }
        });
      }
    }

    /**
     * Show editor (create mode if editName is null, edit mode otherwise)
     */
    function showEditor(editName) {
      if (!_editorEl) return;
      _editingName = editName || null;

      var titleEl = document.getElementById('memoryEditorTitle');
      var nameInput = document.getElementById('memoryEditName');
      var descInput = document.getElementById('memoryEditDesc');
      var typeSelect = document.getElementById('memoryEditType');
      var scopeSelect = document.getElementById('memoryEditScope');
      var contentArea = document.getElementById('memoryEditContent');
      var saveBtn = document.getElementById('memoryEditorSave');

      if (editName) {
        if (titleEl) titleEl.textContent = AEI18n.t('编辑记忆');
        if (saveBtn) saveBtn.textContent = AEI18n.t('保存');
        var entry = _ctrl.getRegistry().get(editName);
        if (entry) {
          if (nameInput) { nameInput.value = entry.name; nameInput.disabled = true; nameInput.style.opacity = '0.6'; }
          if (descInput) descInput.value = entry.description || '';
          if (typeSelect) typeSelect.value = entry.type || 'project';
          if (scopeSelect) scopeSelect.value = entry.scope || 'both';
          if (contentArea) contentArea.value = entry.content || '';
        } else {
          _editingName = null;
          hideEditor();
          // 索引读失败态下"不存在"是误诊——条目可能就在磁盘上未载入
          if (_indexReadFailedNow()) {
            _showIndexReadFailed(AEI18n.t('编辑记忆「{name}」', { name: editName }));
          } else {
            showStatus(AEI18n.t('记忆 [') + editName + AEI18n.t('] 不存在'), 'error');
          }
          return;
        }
      } else {
        if (titleEl) titleEl.textContent = AEI18n.t('新建记忆');
        if (saveBtn) saveBtn.textContent = AEI18n.t('创建');
        if (nameInput) { nameInput.value = ''; nameInput.disabled = false; nameInput.style.opacity = '1'; }
        if (descInput) descInput.value = '';
        if (typeSelect) typeSelect.value = 'project';
        if (scopeSelect) scopeSelect.value = 'both';
        if (contentArea) contentArea.value = '';
      }

      _editorEl.classList.remove('hidden');
      if (nameInput && !editName) setTimeout(function(){ nameInput.focus(); }, 100);
    }

    function hideEditor() {
      if (!_editorEl) return;
      _editingName = null;
      _editorEl.classList.add('hidden');
    }

    /**
     * Save the editor form
     */
    function _saveEditor() {
      var nameInput = document.getElementById('memoryEditName');
      var descInput = document.getElementById('memoryEditDesc');
      var typeSelect = document.getElementById('memoryEditType');
      var scopeSelect = document.getElementById('memoryEditScope');
      var contentArea = document.getElementById('memoryEditContent');

      var name = nameInput ? nameInput.value.trim() : '';
      var desc = descInput ? descInput.value.trim() : '';
      var type = typeSelect ? typeSelect.value : 'project';
      var scope = scopeSelect ? scopeSelect.value : 'both';
      var content = contentArea ? contentArea.value : '';

      if (!name) { showStatus(AEI18n.t('请输入记忆名称'), 'error'); return; }
      if (!desc) { showStatus(AEI18n.t('请输入描述'), 'error'); return; }

      // Validate name format (auto-lowercase first)
      name = name.toLowerCase();
      if (!_editingName && !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
        showStatus(AEI18n.t('名称格式无效。请用小写字母+连字符，例如 my-style'), 'error');
        return;
      }

      var registry = _ctrl.getRegistry();
      // 收集 add/update 透传的降级告警（INDEX_UPDATE_FAILED 等）——
      // 只判 ok 会把「文件已写、索引未收录」吞成纯成功，条目重启后从列表消失。
      var saveWarning = null;
      var saveWarningName = '';

      if (_editingName) {
        // 失败态入口闸门——registry.update 在 _map 未载入时会误报 NOT_FOUND，
        // 如实说明失败态并保持编辑器内容不丢，不尝试写盘
        if (_indexReadFailedNow()) { _showIndexReadFailed(AEI18n.t('更新记忆「{name}」', { name: _editingName })); return; }
        var partial = {};
        var oldEntry = registry.get(_editingName);
        if (oldEntry) {
          if (desc !== oldEntry.description) partial.description = desc;
          // type 为空串时不提交：历史遗留 'rule' 类型条目在下拉中无匹配项（value 变空），
          // 提交空串会被 update() 判 INVALID_TYPE；不触碰则其余字段正常保存，手选合法类型可迁移
          if (type && type !== oldEntry.type) partial.type = type;
          if (scope !== oldEntry.scope) partial.scope = scope;
          if (content !== oldEntry.content) partial.content = content;
        }
        if (Object.keys(partial).length === 0) {
          partial.description = desc;
        }
        var result = registry.update(_editingName, partial);
        if (!result.ok) { showStatus(AEI18n.t('更新失败：') + result.error, 'error'); return; }
        if (result.warning) { saveWarning = result.warning; saveWarningName = _editingName; }
      } else {
        var links = _extractLinksFromContent(content);
        var newEntry = { name: name, description: desc, type: type, scope: scope, content: content, links: links, backlinks: [], filePath: 'memories/' + name + '.md' };
        var result2 = registry.add(newEntry);
        if (!result2.ok) {
          if (result2.error && result2.error.indexOf('DUPLICATE') === 0) {
            showStatus(AEI18n.punct('「', '"', '「', '„', '“', '« ', '«') + name + AEI18n.t('」已存在，请换个名称'), 'error');
          } else {
            showStatus(AEI18n.t('创建失败：') + result2.error, 'error');
          }
          return;
        }
        if (result2.warning) { saveWarning = result2.warning; saveWarningName = name; }
      }

      // warning 分支补警示 toast（经 showStatus→AEToast，文案对照 bootstrap
      // 工具侧 ⚠️ 告警风格）——降级成功也要让用户知道条目未入索引
      if (saveWarning) {
        showStatus(AEI18n.t('⚠️ 记忆 [') + saveWarningName + AEI18n.t('] 已写入文件，但索引更新失败（') + saveWarning + AEI18n.t('），重启后可能从列表消失'), 'warn');
      }

      hideEditor();
      refreshList();
    }

    // ── 多选删除（管理模式）──

    /** 进入管理模式：清空选中与展开态（展开让位给复选框） */
    function _enterSelectMode() {
      _selectMode = true;
      _selectedNames = {};
      _expandedName = null;
      refreshList();
    }

    /** 退出管理模式并清空选中 */
    function _exitSelectMode() {
      _selectMode = false;
      _selectedNames = {};
      refreshList();
    }

    /** 切换单条选中（管理模式下整行/复选框点击） */
    function _toggleSelect(name) {
      if (!name) return;
      if (_selectedNames[name]) delete _selectedNames[name];
      else _selectedNames[name] = true;
      refreshList();
    }

    /** 全选/取消全选：作用于当前过滤结果（跨搜索/scope 切换已选保留） */
    function _toggleSelectAll() {
      if (_filteredNames.length === 0) return;
      var allSelected = true;
      for (var i = 0; i < _filteredNames.length; i++) {
        if (!_selectedNames[_filteredNames[i]]) { allSelected = false; break; }
      }
      for (var j = 0; j < _filteredNames.length; j++) {
        if (allSelected) delete _selectedNames[_filteredNames[j]];
        else _selectedNames[_filteredNames[j]] = true;
      }
      refreshList();
    }

    /** 批量删除选中记忆：确认后逐条 remove，部分失败如实汇报（对齐素材库批量删除） */
    function _confirmBatchDelete() {
      var names = Object.keys(_selectedNames);
      if (names.length === 0) return;

      function doBatchDelete() {
        // 失败态不逐条尝试写盘——一次性如实说明（各条都会命中 NOT_FOUND 假象）
        if (_indexReadFailedNow()) { _showIndexReadFailed(AEI18n.t('删除选中的记忆')); return; }
        var registry = _ctrl.getRegistry();
        var okCount = 0;
        var failCount = 0;
        // 如实收 warning（文件已删、索引更新失败 → 重启后列表可能复活指向缺失文件的
        // 条目）。批量删除与单条删除同走 warning 通道。
        var warnNames = [];
        for (var i = 0; i < names.length; i++) {
          var result = registry.remove(names[i]);
          if (result.ok) { okCount++; if (result.warning) warnNames.push(names[i]); }
          else failCount++;
        }
        // 删除动作已发生：退出管理模式、清空选中并刷新
        _selectMode = false;
        _selectedNames = {};
        _expandedName = null;
        refreshList();
        if (failCount > 0) {
          showStatus(AEI18n.t('删除完成（') + okCount + AEI18n.t(' 成功，') + failCount + AEI18n.t(' 失败）'), 'error');
        } else if (warnNames.length > 0) {
          showStatus(AEI18n.t('已删除 ') + okCount + AEI18n.t(' 条记忆，但 ') + warnNames.length + AEI18n.t(' 条的索引更新失败（重启后可能重新出现）：')
            + warnNames.slice(0, 3).join(AEI18n.punct('、', ', ', '、')) + (warnNames.length > 3 ? AEI18n.t(' 等') : ''), 'warn');
        } else {
          showStatus(AEI18n.t('已删除 ') + okCount + AEI18n.t(' 条记忆'), 'success');
        }
      }

      _askConfirm(AEI18n.t('批量删除'), AEI18n.t('确定要删除选中的 ') + names.length + AEI18n.t(' 条记忆吗？此操作不可恢复。'), 'confirm').then(function (ok) {
        if (!ok) return;
        doBatchDelete();
      });
    }

    /** 同步工具栏按钮显隐/文案/禁用态（refreshList 内调用，幂等） */
    function _updateSelectToolbar() {
      var isRules = _activeTab === 'rules';
      var registry = _ctrl.getRegistry();
      var hasEntries = registry ? registry.getAll().length > 0 : false;
      // 常规态（记忆页 + 非管理）：新建/管理；管理态：全选/删除/取消
      var showNormal = !_selectMode && !isRules;
      var showBatch = _selectMode && !isRules;

      var newBtn = document.getElementById('memoryNewBtn');
      var manageBtn = document.getElementById('memoryManageBtn');
      var selectAllBtn = document.getElementById('memorySelectAllBtn');
      var deleteBtn = document.getElementById('memoryBatchDeleteBtn');
      var exitBtn = document.getElementById('memoryExitSelectBtn');

      if (newBtn) newBtn.classList.toggle('hidden', !showNormal);
      // 无任何条目时管理无意义，直接隐藏
      if (manageBtn) manageBtn.classList.toggle('hidden', !showNormal || !hasEntries);
      if (selectAllBtn) selectAllBtn.classList.toggle('hidden', !showBatch);
      if (deleteBtn) deleteBtn.classList.toggle('hidden', !showBatch);
      if (exitBtn) exitBtn.classList.toggle('hidden', !showBatch);

      var selectedCount = Object.keys(_selectedNames).length;
      if (deleteBtn) {
        deleteBtn.textContent = AEI18n.t('删除 (') + selectedCount + ')';
        deleteBtn.disabled = selectedCount === 0;
      }
      if (selectAllBtn) {
        var allSelected = _filteredNames.length > 0;
        for (var i = 0; i < _filteredNames.length; i++) {
          if (!_selectedNames[_filteredNames[i]]) { allSelected = false; break; }
        }
        selectAllBtn.textContent = allSelected ? AEI18n.t('取消全选') : AEI18n.t('全选');
        selectAllBtn.disabled = _filteredNames.length === 0;
      }
    }

    function _confirmDelete(name) {
      _askConfirm(AEI18n.t('删除记忆'), AEI18n.t('确定要删除记忆「') + name + AEI18n.t('」吗？此操作不可恢复。'), 'confirm').then(function(ok) {
        if (!ok) return;
        doDelete();
      });
      function doDelete() {
        // 与批量删除同款——失败态如实说明而非"删除失败：NOT_FOUND"
        if (_indexReadFailedNow()) { _showIndexReadFailed(AEI18n.t('删除记忆「{name}」', { name: name })); return; }
        var result = _ctrl.getRegistry().remove(name);
        if (!result.ok) { showStatus(AEI18n.t('删除失败：') + result.error, 'error'); return; }
        // 与批量删除路径一致：文件已删但索引行清理失败时提示；
        // 索引残留会在重启后表现为指向缺失文件的条目。
        if (result.warning) {
          showStatus(AEI18n.t('⚠️ 记忆 [') + name + AEI18n.t('] 已删除，但索引更新失败（') + result.warning
            + AEI18n.t('），重启后列表可能出现指向缺失文件的条目'), 'warn');
        }
        _expandedName = null;
        refreshList();
      }
    }

    /**
     * Bind toolbar/editor events
     */
    function _bindEvents() {
      _searchInput = document.getElementById('memorySearchInput');
      if (_searchInput) {
        _searchInput.addEventListener('input', function () {
          // Debounce search
          if (_searchTimer) clearTimeout(_searchTimer);
          _searchTimer = setTimeout(function () {
            refreshList();
          }, _searchDebounceMs);
        });
      }

      var newBtn = document.getElementById('memoryNewBtn');
      if (newBtn) newBtn.addEventListener('click', function () { showEditor(null); });

      // 管理模式（多选删除）
      var manageBtn = document.getElementById('memoryManageBtn');
      if (manageBtn) manageBtn.addEventListener('click', function () { _enterSelectMode(); });
      var selectAllBtn = document.getElementById('memorySelectAllBtn');
      if (selectAllBtn) selectAllBtn.addEventListener('click', function () { _toggleSelectAll(); });
      var batchDeleteBtn = document.getElementById('memoryBatchDeleteBtn');
      if (batchDeleteBtn) batchDeleteBtn.addEventListener('click', function () { _confirmBatchDelete(); });
      var exitSelectBtn = document.getElementById('memoryExitSelectBtn');
      if (exitSelectBtn) exitSelectBtn.addEventListener('click', function () { _exitSelectMode(); });

      var cancelBtn = document.getElementById('memoryEditorCancel');
      if (cancelBtn) cancelBtn.addEventListener('click', function () { hideEditor(); });

      var saveBtn = document.getElementById('memoryEditorSave');
      if (saveBtn) saveBtn.addEventListener('click', function () { _saveEditor(); });

      // Scope filter buttons
      var scopeBtns = document.querySelectorAll('#memoryScopeFilters .memory-scope-btn');
      for (var s = 0; s < scopeBtns.length; s++) {
        scopeBtns[s].addEventListener('click', function () {
          var btns = document.querySelectorAll('#memoryScopeFilters .memory-scope-btn');
          for (var b = 0; b < btns.length; b++) btns[b].classList.remove('active');
          this.classList.add('active');
          _scopeFilter = this.getAttribute('data-scope') || 'all';
          refreshList();
        });
      }

      // Tab switching
      var tabBtns = document.querySelectorAll('.memory-tab');
      for (var t = 0; t < tabBtns.length; t++) {
        tabBtns[t].addEventListener('click', function () {
          var allTabs = document.querySelectorAll('.memory-tab');
          for (var tb = 0; tb < allTabs.length; tb++) allTabs[tb].classList.remove('active');
          this.classList.add('active');
          _activeTab = this.getAttribute('data-tab') || 'memories';
          if (_activeTab === 'rules') {
            _scopeFilter = 'all';
            // 规则页无条目多选语义，进页即退出管理模式
            _selectMode = false;
            _selectedNames = {};
          }
          // scope 按钮高亮与 _scopeFilter 同步：进规则页会重置为 all，
          // 不同步则返回记忆页时残留旧高亮（如 Agent 亮着却显示全部）
          var syncBtns = document.querySelectorAll('#memoryScopeFilters .memory-scope-btn');
          for (var sb = 0; sb < syncBtns.length; sb++) {
            syncBtns[sb].classList.toggle('active', (syncBtns[sb].getAttribute('data-scope') || 'all') === _scopeFilter);
          }
          var isRules = _activeTab === 'rules';
          // newBtn 显隐已移交 _updateSelectToolbar（refreshList 内调用，同时接管管理模式切换）
          var searchWrap = document.querySelector('.memory-search-wrap');
          var scopeFilters = document.getElementById('memoryScopeFilters');
          if (searchWrap) searchWrap.style.display = isRules ? 'none' : '';
          if (scopeFilters) scopeFilters.style.display = isRules ? 'none' : '';
          refreshList();
        });
      }
    }

    return {
      render: function () {
        if (_el) _el.innerHTML = _buildHtml();

        // 动态填充 select option（避免 Chrome 88 CEF 静态 <option> bug）
        var typeSelect = document.getElementById('memoryEditType');
        if (typeSelect) {
          var typeOptions = [
            { value: 'lesson', label: AEI18n.t('经验') },
            { value: 'project', label: AEI18n.t('项目') },
            { value: 'preference', label: AEI18n.t('偏好') }
          ];
          for (var ti = 0; ti < typeOptions.length; ti++) {
            var tOpt = document.createElement('option');
            tOpt.value = typeOptions[ti].value;
            tOpt.textContent = typeOptions[ti].label;
            typeSelect.appendChild(tOpt);
          }
        }

        var scopeSelect = document.getElementById('memoryEditScope');
        if (scopeSelect) {
          var scopeOptions = [
            { value: 'both', label: AEI18n.t('通用') },
            { value: 'script', label: 'Script' },
            { value: 'agent', label: 'Agent' },
            { value: 'shader', label: 'Shader' }
          ];
          for (var si = 0; si < scopeOptions.length; si++) {
            var sOpt = document.createElement('option');
            sOpt.value = scopeOptions[si].value;
            sOpt.textContent = scopeOptions[si].label;
            scopeSelect.appendChild(sOpt);
          }
        }

        _listEl = document.getElementById('memoryList');
        _editorEl = document.getElementById('memoryEditorModal');
        _countEl = document.getElementById('memoryCount');
        _bindEvents();
        refreshList();
        console.log('[MemoryView] render done');
      },
      refreshList: refreshList,
      showEditor: showEditor,
      hideEditor: hideEditor,
      destroy: function () {
        // Clear debounce timer
        if (_searchTimer) {
          clearTimeout(_searchTimer);
          _searchTimer = null;
        }
        _listEl = null;
        _searchInput = null;
        _editorEl = null;
        _countEl = null;
        _el = null;
      }
    };
  }

  global.AEMemory = global.AEMemory || {};
  global.AEMemory.createMemoryView = createMemoryView;
})(window);
