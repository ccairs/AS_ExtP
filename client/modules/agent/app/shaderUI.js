(function (global) {
  // shader 模式 UI 控制器：左抽屉（实时预览 + 效果库列表）右抽屉（Task 4）。
  // deps: { effectsDir(), aefs, getRuntimeMode(), getPreviewCode(), setPreviewCode(code),
  //         onApplyResult?(ok), previewRendererFactory() }
  function createShaderUI(deps) {
    deps = deps || {};
    var _renderer = null;
    // 最近一次加载到预览区的效果名（不含扩展名）。
    // 不做列表高亮（双击加载，无选中态），仅用于「保存到效果库」的默认命名。
    var _activeName = '';
    var _uiDestroyed = false;    // 实例销毁标记：迟到的空闲回调（预览初始化）不得再建 GL 资源
    var _lastPreviewCode = null; // 最近一次经 setSource 提交到渲染器的代码（updateCompileStatus 复用判定）
    // 静态 DOM（index.html 固有元素）监听登记表：模块 unmount → destroy 时统一解绑。
    // 模块重挂载会经 getShaderUI 创建新实例并对同一批静态元素重新 bind，不解绑则
    // 监听随挂载次数累积（折叠开关/暂停键点击一次执行两次、状态被抵消失效）。
    var _domHandlers = [];
    function bindDom(node, evt, fn, opts) {
      if (!node) return;
      node.addEventListener(evt, fn, opts);
      _domHandlers.push({ node: node, evt: evt, fn: fn, opts: opts });
    }

    function el(id) { return document.getElementById(id); }

    // 效果库名（保存/重命名）规则：允许 Unicode（中文名可用），与素材库
    // treeView.invalidNameSeg 同口径——禁控制符/引号/路径分隔/Windows 非法字符/尾随点与
    // 空格；内部空格/点号不拦。与 shaderTools.js 的 isValidShaderName 同一套规则，
    // 两处实现必须同步修改。
    var SHADER_NAME_ILLEGAL_RE = /[\u0000-\u001f\u007f"'\\/:*?<>|]/;
    function validLibName(s) {
      s = String(s == null ? '' : s).trim();
      if (!s || s.length > 64) return false;
      if (SHADER_NAME_ILLEGAL_RE.test(s)) return false;
      var lastCh = s.charAt(s.length - 1);
      return lastCh !== '.' && lastCh !== ' ';
    }
    // 注：本模块曾导出 isShader()（= getRuntimeMode() === 'shader'），已删除——
    // 它的窄语义正是「外接模式被挡在实时编译链外」那个缺陷的判据本体，删除时已无调用方。
    // 凡需判断「GLSL 编辑面是否活动」，一律用宿主注入的 deps.isGlslEditing()（含 external/team）；
    // 下方 schedulePreviewInit 的迟到守卫在未注入时按 shader/外接/团队三档自判（同口径回落）。

    // 列表空态/加载态/错误态占位（统一样式，取代内联 style）
    function emptyState(msg) {
      return '<div class="shader-library-empty">' + msg + '</div>';
    }

    // —— 效果库多选状态（单击选中 / Ctrl 反选 / Shift 连选）——
    // 选中集按效果名（不含扩展名）记；列表刷新后按存活名裁剪（被删条目自然落选）。
    var _selectedNames = {};
    var _lastClickedName = '';   // Shift 连选锚点（与 script-tree 的 lastClickedPath 同口径）
    var _libCount = 0;           // 最近一次列目录的效果数（标题「效果库 (n) · 已选 m」复算用）

    function getSelectedNames() {
      var out = [];
      for (var k in _selectedNames) { if (_selectedNames[k]) out.push(k); }
      return out;
    }

    // 选中态 UI 落位：标题计数 + 批量删除按钮可用性（无选中即禁用）
    function updateSelectionUI() {
      var count = getSelectedNames().length;
      var title = el('shaderLibTitle');
      if (title) {
        title.textContent = AEI18n.t('效果库') + (_libCount > 0 ? ' (' + _libCount + ')' : '')
          + (count > 0 ? AEI18n.t(' · 已选 ') + count : '');
      }
      var btn = el('shaderBatchDeleteBtn');
      if (btn) btn.disabled = (count === 0);
    }

    // 更新标题中的文件计数
    function updateLibCount(n) {
      _libCount = n > 0 ? n : 0;
      updateSelectionUI();
    }

    // 选中集裁剪：列表刷新后只保留仍存在的效果名（被删/被改名条目自然落选）
    function pruneSelection(aliveNames) {
      var alive = {};
      for (var i = 0; i < aliveNames.length; i++) alive[aliveNames[i]] = true;
      for (var k in _selectedNames) {
        if (_selectedNames[k] && !alive[k]) delete _selectedNames[k];
      }
      if (_lastClickedName && !alive[_lastClickedName]) _lastClickedName = '';
    }

    // 选中态落到当前行（不重建 DOM：不冲掉滚动位置，也不打断拖动/编辑）
    function syncRowSelection() {
      var list = el('shaderLibraryList');
      if (!list) return;
      var rows = list.querySelectorAll('.shader-library-item[data-name]');
      for (var i = 0; i < rows.length; i++) {
        if (_selectedNames[rows[i].getAttribute('data-name')]) rows[i].classList.add('selected');
        else rows[i].classList.remove('selected');
      }
    }

    // 单击：单选（清空其余）
    function selectOnly(name) {
      _selectedNames = {};
      _selectedNames[name] = true;
      _lastClickedName = name;
      updateSelectionUI();
      syncRowSelection();
    }

    // Ctrl 单击：反选（已在选中集内则移出）
    function toggleSelected(name) {
      if (_selectedNames[name]) delete _selectedNames[name];
      else _selectedNames[name] = true;
      _lastClickedName = name;
      updateSelectionUI();
      syncRowSelection();
    }

    // Shift 单击：锚点到本行的连选（getExistingNames 为列表显示序）；无有效锚点退回单选
    function selectRange(name) {
      var names = getExistingNames();
      var from = names.indexOf(_lastClickedName);
      var to = names.indexOf(name);
      if (!_lastClickedName || from === -1 || to === -1) { selectOnly(name); return; }
      _selectedNames = {};
      var start = Math.min(from, to), end = Math.max(from, to);
      for (var i = start; i <= end; i++) _selectedNames[names[i]] = true;
      _lastClickedName = name;
      updateSelectionUI();
      syncRowSelection();
    }

    function clearSelection() {
      _selectedNames = {};
      _lastClickedName = '';
      updateSelectionUI();
      syncRowSelection();
    }

    // 获取列表中已有的效果名（不含扩展名）
    function getExistingNames() {
      var list = el('shaderLibraryList');
      if (!list) return [];
      var items = list.querySelectorAll('.shader-library-item[data-name]');
      var names = [];
      for (var i = 0; i < items.length; i++) {
        var n = items[i].getAttribute('data-name');
        if (n) names.push(n);
      }
      return names;
    }

    // 同名顺延：base 与 existing 比对（大小写不敏感），冲突则追加 _2、_3...
    // 与 script-tree newScript/newFolder 对齐（n 从 2 起）。
    // 例：base="abc" existing=["abc"] → "abc_2"；existing=["abc","abc_2"] → "abc_3"
    function dedupeName(base, existing) {
      base = String(base || 'effect');
      var lower = (existing || []).map(function (n) { return String(n).toLowerCase(); });
      if (lower.indexOf(base.toLowerCase()) === -1) return base;
      var i = 2;
      while (lower.indexOf((base + '_' + i).toLowerCase()) !== -1) { i++; }
      return base + '_' + i;
    }

    // —— 左抽屉 ——
    function showLeft() { var p = el('shaderLeftPanel'); if (p) p.style.display = ''; }
    function hideLeft() { var p = el('shaderLeftPanel'); if (p) p.style.display = 'none'; }

    // ── 团队模式右抽屉（预览 + 并列 tab 版式）──
    // 上半 = shader 实时预览，下半 = **「GLSL 代码 | 效果库」并列 tab**（原话：
    // 「团队模式的 Shader 效果库放到右边抽屉，在右边抽屉的 GLSL 代码预览区搞个并列 tab 放他」
    // ——效果库因此从左列下半搬进右抽屉，与代码栏并列成两个页签）。
    // 两件搬移（预览 stage / 效果库两件）的落点协议与 external/view.js 的 enter/exit 同款：
    // 进团队搬进右抽屉的容器，离开时移回 #shaderLeftPanel 原位（stage 回**首子节点**、效果库回
    // **预览与分隔条之后**，原序不变）。canvas 移动不丢 WebGL 上下文，渲染循环逐帧读 clientWidth
    // 自适应新尺寸（同外接的移入中列）。
    // 两件按「先 stage、后效果库」的**同一序**执行（进/出两个方向都是），且这个序是刻意的：
    // 效果库搬移**之前**抛错时留下的半态是「舞台已在右抽屉、效果库仍在左列」——左列有内容
    // ⇒ 不让位 ⇒ 用户看到的是旧双栏（预览在右、效果库在左）。
    // 搬移本身**不是原子的**：两件之间或挂类之前抛错，会把头部/两件
    // 留在默认隐藏的「效果库」页里——但下一次 showTeamLayout/hideTeamLayout 会整体自愈，
    // 且「效果库」页签点得开（守卫只认「列表在不在页里」），所以不会成为不可达态。
    // 幂等且方向安全：重复 show 不会重复搬；hide 只在「东西确实还在团队容器里」时才搬回——
    // 否则会把外接布局刚移进中列的 stage 抢回左列（两个布局的落点会打架）。
    var _teamLayoutOn = false;
    // 页签状态（'code' | 'library'）：写在 #shaderTeamTabs 的 data-active 上，两个页的显隐由
    // agent.css 按它切（**不写内联 display**）。默认 GLSL 代码页，hideTeamLayout 复位。
    var _teamTab = 'code';

    // 效果库的最小搬移单元（头部 + 列表）。头部在 index.html 里有 id（#shaderLibraryHead）
    // 正是为这次搬移加的锚点。
    function _libParts() {
      return { head: el('shaderLibraryHead'), list: el('shaderLibraryList') };
    }
    // 效果库当前是否在右抽屉的「效果库」页里。saveToLibrary 与页签守卫都按**实际位置**判，
    // 不按模式判——模式是派生档，位置才是真相。
    function _libInTeamPane() {
      var pane = el('shaderTeamLibPane');
      var parts = _libParts();
      if (!pane || !parts.list || !pane.contains) return false;
      return pane.contains(parts.list);
    }
    // 「左列 shader 面板已被搬空」的判据：预览舞台与效果库两件都不在里面。只有真搬空才挂
    // .team-emptied（CSS 据此让位给团队面板）——搬移失败时 class 不在，面板照旧可见，
    // 与 .shader-team-stage:empty 同款「显示权交回内容是否在场」的手法。
    function _syncLeftPanelEmptied() {
      var home = el('shaderLeftPanel');
      if (!home || !home.classList) return;
      var parts = _libParts();
      var out = function (n) { return !n || n.parentNode !== home; };
      var emptied = out(el('shaderPreviewStage')) && out(parts.head) && out(parts.list);
      if (emptied) home.classList.add('team-emptied');
      else home.classList.remove('team-emptied');
    }
    // 页签落位（幂等）：状态写 tab 条的 data-active，按钮的 .active 跟着走
    function _applyTeamTab() {
      var tabs = el('shaderTeamTabs');
      if (!tabs) return;
      tabs.setAttribute('data-active', _teamTab);
      var btns = tabs.querySelectorAll ? tabs.querySelectorAll('.shader-team-tab') : [];
      for (var i = 0; i < btns.length; i++) {
        var on = String(btns[i].getAttribute('data-tab') || '') === _teamTab;
        if (on) btns[i].classList.add('active'); else btns[i].classList.remove('active');
      }
    }
    // 切页（调用方：bindTeamTabs 的点击 / saveToLibrary 的「保存后亮出效果库」）
    function showTeamTab(name) {
      var want = (name === 'library') ? 'library' : 'code';
      // 「效果库」页只在效果库**确实搬进来了**时才切：搬移失败（容器缺席/老实例）时切过去
      // 只会得到一块空页，不如老实停在代码页。
      if (want === 'library' && !_libInTeamPane()) want = 'code';
      _teamTab = want;
      _applyTeamTab();
      return _teamTab;
    }
    function bindTeamTabs() {
      var tabs = el('shaderTeamTabs');
      if (!tabs) return;
      _applyTeamTab();   // 初始态兜底（骨架里已写 data-active="code" + 首颗 .active）
      bindDom(tabs, 'click', function (e) {
        var node = e && e.target ? e.target : null;
        var btn = (node && node.closest) ? node.closest('.shader-team-tab') : null;
        if (!btn && node && node.getAttribute && node.getAttribute('data-tab')) btn = node;
        if (!btn) return;
        showTeamTab(btn.getAttribute('data-tab'));
      });
    }

    function showTeamLayout() {
      var host = el('shaderTeamStage');
      var stage = el('shaderPreviewStage');
      if (host && stage && stage.parentNode !== host) host.appendChild(stage);
      // 效果库搬进「效果库」页（两件按头 → 列表的次序 append，页内次序即左列原序）。
      // **前提与「挂 .team-emptied」共用同一个 home 判据**：左面板节点缺席时**不搬走**——
      // 搬走会让效果库落进默认隐藏的页里、而没人能让左列让位（半态：
      // 「东西搬走了 + 左列不让位」无自愈路径）。搬移与让位必须是同一次判定的两个后果。
      var home = el('shaderLeftPanel');
      var pane = el('shaderTeamLibPane');
      var parts = _libParts();
      if (home && pane && parts.head && parts.list) {
        if (parts.head.parentNode !== pane) pane.appendChild(parts.head);
        if (parts.list.parentNode !== pane) pane.appendChild(parts.list);
      }
      _teamLayoutOn = true;
      _syncLeftPanelEmptied();
      _applyTeamTab();
    }
    function hideTeamLayout() {
      var was = _teamLayoutOn;
      _teamLayoutOn = false;
      var host = el('shaderTeamStage');
      var stage = el('shaderPreviewStage');
      var home = el('shaderLeftPanel');
      if (host && stage && home && host.contains && host.contains(stage)) {
        home.insertBefore(stage, home.firstChild);
      }
      // 效果库搬回左列（预览/分隔条之后 = 原序；appendChild 次序即 head → list）。
      // 只在「确实还在团队页里」时才搬——外接/shader 布局的效果库一直在左列，乱搬会打乱次序。
      var pane = el('shaderTeamLibPane');
      var parts = _libParts();
      if (home && pane && pane.contains && parts.head && parts.list && pane.contains(parts.head)) {
        home.appendChild(parts.head);
        home.appendChild(parts.list);
      }
      // 页签回默认页（下次进团队仍是 GLSL 代码页；两个页的显隐随 data-active 由 CSS 切回来）
      showTeamTab('code');
      _syncLeftPanelEmptied();
      // 分隔条拖拽写下的内联 flex-basis 只在团队布局里有效：离开后这些面板在别的模式
      // （shader 右抽屉 / 外接六功能区）有自己的 flex 口径，内联值会压制它们
      if (was) {
        if (host) host.style.flexBasis = '';
        var codePanel = el('shaderRightPanel');
        if (codePanel) codePanel.style.flexBasis = '';
        // 下半的两个并列页都收过分隔条的内联 basis，离开时一并清（同上口径）
        var libPaneBasis = el('shaderTeamLibPane');
        if (libPaneBasis) libPaneBasis.style.flexBasis = '';
      }
    }

    function refreshLibrary() {
      var list = el('shaderLibraryList');
      if (!list) return Promise.resolve();
      _hideLibContextMenu();
      // 内联命名编辑中：跳过刷新，避免冲掉正在输入的名称（编辑行无 data-name，据此识别）
      if (list.querySelector('.shader-library-item.editing')) return Promise.resolve();
      list.innerHTML = emptyState(AEI18n.t('加载中...'));
      updateLibCount(0);
      var dir = deps.effectsDir ? deps.effectsDir() : '';
      // 有 Result 版通道时列目录能力以它为准（可区分失败与空目录）
      if (!dir || !global.AEFS || (typeof global.AEFS.listFiles !== 'function'
          && typeof global.AEFS.listFilesResult !== 'function')) {
        list.innerHTML = emptyState(AEI18n.t('效果目录不可用'));
        return Promise.resolve();
      }
      // 走异步列目录（fetch），避免同步 XHR 在进入/切换会话时阻塞主线程
      var listFn = (typeof global.AEFS.listFilesAsync === 'function')
        ? global.AEFS.listFilesAsync
        : global.AEFS.listFiles;
      function renderFiles(files) {
        var names = (files || []).filter(function (f) { return /\.glsl$/i.test(f); });
        if (names.length === 0) {
          list.innerHTML = emptyState(AEI18n.t('暂无效果'));
          _selectedNames = {};
          _lastClickedName = '';
          updateLibCount(0);
          return;
        }
        // 选择集裁剪先于建行：刷新后只保留仍存在的效果名（被删条目自然落选）
        pruneSelection(names.map(function (n) { return n.replace(/\.glsl$/i, ''); }));
        updateLibCount(names.length);
        list.innerHTML = '';
        names.forEach(function (name) {
          var row = document.createElement('div');
          row.className = 'shader-library-item';
          var base = name.replace(/\.glsl$/i, '');
          row.setAttribute('data-name', base);
          if (_selectedNames[base]) row.classList.add('selected');
          // 删除已移入右键菜单，条目仅保留「读取」按钮
          row.innerHTML = '<span class="name"></span><span class="actions">'
            + AEI18n.html('<button type="button" class="btn compact" data-act="read" title="读取此效果">读取</button>')
            + '</span>';
          row.querySelector('.name').textContent = base;
          // origin=external 徽标（外部 Agent 经 shader_library 写入的效果）
          try {
            var extReg = global.AEExternal && global.AEExternal.bridgeClient;
            var extInfo = extReg && typeof extReg.getLibOrigin === 'function'
              ? extReg.getLibOrigin(name) : null;
            if (extInfo) {
              var extBadge = document.createElement('span');
              extBadge.className = 'ext-origin-badge';
              extBadge.textContent = AEI18n.t('外');
              extBadge.title = AEI18n.t('由外部 Agent 写入') + (extInfo.ts ? ' · ' + new Date(extInfo.ts).toLocaleString() : '');
              // 徽标插在「读取」按钮左侧（.actions 之前），按钮保持在行尾
              row.insertBefore(extBadge, row.querySelector('.actions'));
            }
          } catch (_) {}
          row.querySelector('[data-act="read"]').addEventListener('click', function (e) { e.stopPropagation(); loadFromLibrary(base); });
          row.querySelector('[data-act="read"]').addEventListener('dblclick', function (e) { e.stopPropagation(); });
          // 单击选中（Ctrl 反选 / Shift 连选）；双击加载（先选中再打开，与资源管理器同款）
          row.addEventListener('click', function (e) {
            if (e.shiftKey) selectRange(base);
            else if (e.ctrlKey || e.metaKey) toggleSelected(base);
            else selectOnly(base);
          });
          row.addEventListener('dblclick', function () { loadFromLibrary(base); });
          // 右键菜单：重命名 / 删除
          row.addEventListener('contextmenu', function (e) {
            e.preventDefault(); e.stopPropagation();
            _showLibContextMenu(e.clientX, e.clientY, base);
          });
          list.appendChild(row);
        });
      }
      // 读取失败：渲染错误态（含原因 + 刷新指引），不得折叠成「暂无效果」空态——
      // 目录不可读与目录确实为空对用户是两种语义。Result 版通道能区分两者，
      // 优先使用；仅旧装配无 Result 版时用 reject 兜底。
      function renderListError(reason) {
        var _reasonEsc = String(reason == null ? '' : reason)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        list.innerHTML = emptyState(AEI18n.t('效果库读取失败{reason}，请点刷新重试', {
          reason: _reasonEsc ? AEI18n.punct('：', ': ') + _reasonEsc : ''
        }));
        // 列目录失败后条目已不可见：清空选中（否则「已选 N」与可删的条目都不在屏幕上，
        // 批量删除会作用于用户看不见的名字）
        _selectedNames = {};
        _lastClickedName = '';
        updateLibCount(0);
      }
      if (typeof global.AEFS.listFilesResult === 'function') {
        var _resPromise;
        try {
          _resPromise = global.AEFS.listFilesResult(dir);
        } catch (e) {
          // 同步抛错同样按读取失败呈现（不穿出 refreshLibrary 打断调用方）
          renderListError(String((e && e.message) || e));
          return Promise.resolve();
        }
        return Promise.resolve(_resPromise).then(function (r) {
          if (!r || r.ok !== true) {
            var _err = (r && r.error) || {};
            renderListError(_err.code || _err.message || '');
            return;
          }
          renderFiles(r.data || []);
        }).catch(function (e) { renderListError(String((e && e.message) || e)); });
      }
      var _listPromise;
      try {
        _listPromise = listFn(dir);
      } catch (e) {
        renderListError(String((e && e.message) || e));
        return Promise.resolve();
      }
      return Promise.resolve(_listPromise).then(renderFiles).catch(function (e) {
        renderListError(String((e && e.message) || e));
      });
    }

    // 预览区（GLSL 代码编辑区）是否已有内容：读取效果库文件会整段覆盖它。
    // deps.getPreviewCode 缺席（旧装配/单测桩）按空处理。
    function previewHasContent() {
      if (typeof deps.getPreviewCode !== 'function') return false;
      var code = deps.getPreviewCode();
      return !!String(code == null ? '' : code).trim();
    }

    // 读取前是否需要覆盖确认：GLSL 编辑面活动（shader/外接档）且预览区已有内容。
    // GLSL 编辑面判据取宿主注入的 deps.isGlslEditing()（与实时链同源）；未注入时不限模式。
    function needOverwriteConfirm() {
      if (typeof deps.isGlslEditing === 'function' && !deps.isGlslEditing()) return false;
      return previewHasContent();
    }

    // 读取覆盖确认：只在 needOverwriteConfirm() 为真时调用。onDone(true|false) 是唯一结算出口：
    // 取消与弹窗异常按 false 收尾；showConfirm 缺席或同步抛错按 true 收尾。
    function confirmOverwrite(name, onDone) {
      if (typeof global.showConfirm !== 'function') { onDone(true); return; }
      var pending;
      try {
        pending = global.showConfirm(AEI18n.t('覆盖确认'),
          AEI18n.t('预览区已有内容，读取效果「{name}」将覆盖当前代码。是否继续？', { name: name }), 'confirm');
      } catch (_) { onDone(true); return; }
      Promise.resolve(pending).then(function (ok) { onDone(!!ok); }, function () { onDone(false); });
    }

    // 待确认的读取效果名（空串 = 无在途确认）。确认在途时忽略后续读取请求。
    var _loadConfirmPending = '';

    function loadFromLibrary(name) {
      var dir = deps.effectsDir ? deps.effectsDir() : '';
      if (!dir) return;
      if (_loadConfirmPending) return;
      function doRead() {
        global.AEFS.readFile(dir + '\\' + name + '.glsl').then(function (content) {
          // AEFS.readFile 失败约定为 resolve(null)（文件被外部删除/占用/安全拒绝，
          // 不 reject）——null 落进 `if (content && ...)` 时会静默无任何反馈，用户双击
          // 库中条目毫无反应（deleteFromLibrary 同类吞错的姊妹位置）。显式提示。
          if (content === null || content === undefined) {
            if (typeof deps.showStatus === 'function') deps.showStatus(AEI18n.t('读取效果失败: ') + name, 'error');
            return;
          }
          if (content && deps.setPreviewCode) {
            deps.setPreviewCode(String(content));
            // 加载效果库文件：预览时间基准归零——面板预览是常驻渲染循环，uTime 已累计很大，
            // 载入新效果会直接从中途时刻开始（动画类 shader 一进来就跳到后段）。
            var _pr = ensureRenderer();
            if (_pr && typeof _pr.resetTime === 'function') _pr.resetTime();
            // 效果库加载：uniform 列表可能变化，重建滑块列表（setPreviewCode 不重建，防打断拖动）
            renderUniforms((global.AEEffectLab && typeof global.AEEffectLab.parseUniforms === 'function')
              ? global.AEEffectLab.parseUniforms(String(content)) : []);
            _activeName = name;
            // 在 Agent 专属信息栏弹出读取提示（双击或点「读取」按钮均会触发）
            if (typeof deps.showStatus === 'function') deps.showStatus(AEI18n.t('已读取 ') + name, 'success');
            // 团队档：读取后亮出代码页——效果库页在前台时代码栏被 CSS 隐藏，
            // 不切页则读到的代码与 uniform 滑块都看不见（与保存时亮出效果库页对称）。
            if (_libInTeamPane()) showTeamTab('code');
          }
        });
      }
      if (!needOverwriteConfirm()) { doRead(); return; }
      _loadConfirmPending = name;
      confirmOverwrite(name, function (ok) {
        _loadConfirmPending = '';
        if (_uiDestroyed) return;
        if (ok) doRead();
      });
    }

    // 面板无「应用」按钮：AE 宿主在效果控件窗口（ECW）自绘选择器里直接选 glsl 文件渲染，
    // 与面板效果库解耦。面板只负责浏览/加载/编辑/保存效果代码。

    function deleteFromLibrary(name) {
      var dir = deps.effectsDir ? deps.effectsDir() : '';
      if (!dir) return;
      // 使用项目统一的 showConfirm 弹窗（与 script-tree / sessionSwitcher 删除确认一致，带 warn 图标 + beep）
      // 降级：showConfirm 未加载时回退原生 confirm，保证功能可用
      var confirmFn = (typeof global.showConfirm === 'function') ? global.showConfirm : function (_t, m) { return Promise.resolve(window.confirm(m)); };
      confirmFn(AEI18n.t('确认删除'), AEI18n.t('确认要删除效果「{name}」吗？此操作不可撤销。', { name: name }), 'warn').then(function (ok) {
        if (!ok) return;
        var path = dir + '\\' + name + '.glsl';
        (global.AEFS && typeof global.AEFS.deleteFile === 'function' ? global.AEFS.deleteFile(path) : Promise.resolve(true))
          .then(function (deleted) {
            // 透传删除结果（内参曾与外层用户确认 ok 同名遮蔽、恒被忽略）——
            // 失败（文件被占用/安全拒绝）时不清 _activeName、不静默刷新（条目
            // 刷新后仍在，看似已删又复活），提示用户删除失败（同语义）
            if (!deleted) {
              if (typeof global.showStatus === 'function') {
                global.showStatus(AEI18n.t('删除失败 — ') + (global.AEFS.lastError ? (global.AEFS.lastError() || AEI18n.t('未知错误')) : AEI18n.t('未知错误')), 'error');
              }
              return;
            }
            if (_activeName === name) { _activeName = ''; }
            refreshLibrary();
          });
      });
    }

    // 批量删除选中（工具栏 🗑 / 右键菜单多选态入口）。
    // 确认文案按数量分档：单条与 deleteFromLibrary 逐字一致（同一件事不该有两种问法）。
    // 逐条删除后统计结果——成功的移出选中集、失败的保留选中（refreshLibrary 按存活名裁剪），
    // 用户可直接对残留高亮重试；失败原因经 AEFS.lastError 透传（与单删同语义，不吞错）。
    function deleteSelectedFromLibrary() {
      var names = getSelectedNames();
      if (names.length === 0) return;
      var dir = deps.effectsDir ? deps.effectsDir() : '';
      if (!dir) return;
      var confirmFn = (typeof global.showConfirm === 'function') ? global.showConfirm : function (_t, m) { return Promise.resolve(window.confirm(m)); };
      var msg = (names.length === 1)
        ? AEI18n.t('确认要删除效果「{name}」吗？此操作不可撤销。', { name: names[0] })
        : AEI18n.t('确认要删除选中的 {n} 个效果吗？此操作不可撤销。', { n: names.length });
      var failed = [];
      function removeOne(name) {
        var path = dir + '\\' + name + '.glsl';
        var del = (global.AEFS && typeof global.AEFS.deleteFile === 'function')
          ? global.AEFS.deleteFile(path)
          : Promise.resolve(true);
        // 单条异常不中断整批（AEFS 异步版约定不 reject，此处兜底防实现违约吞掉后续文件）
        return del.then(function (deleted) { if (!deleted) failed.push(name); }, function () { failed.push(name); });
      }
      confirmFn(AEI18n.t('确认删除'), msg, 'warn').then(function (ok) {
        if (!ok) return;
        // 串行删除：桥是一次一条的 HTTP，串行让失败原因（lastError）归属明确
        var seq = Promise.resolve();
        names.forEach(function (name) { seq = seq.then(function () { return removeOne(name); }); });
        seq.then(function () {
          for (var i = 0; i < names.length; i++) {
            if (failed.indexOf(names[i]) === -1) delete _selectedNames[names[i]];
          }
          if (names.indexOf(_activeName) !== -1 && failed.indexOf(_activeName) === -1) _activeName = '';
          var okCount = names.length - failed.length;
          if (typeof global.showStatus === 'function') {
            if (failed.length === 0) {
              global.showStatus(AEI18n.t('已删除 ') + okCount + AEI18n.t(' 个效果'), 'success');
            } else {
              var reason = (global.AEFS && typeof global.AEFS.lastError === 'function')
                ? (global.AEFS.lastError() || '') : '';
              global.showStatus(AEI18n.t('删除失败 — 已删除 ') + okCount + '/' + names.length + AEI18n.t(' 个')
                + (reason ? '（' + reason + '）' : ''), 'error');
            }
          }
          refreshLibrary();
        });
      });
    }

    // —— 效果库右键菜单：重命名 / 删除 ——
    // 复用全局 .ae-context-menu / .context-menu-item 样式（与脚本预览区右键菜单一致）。
    var _libContextMenu = null;
    var _libMenuBound = false;
    function _hideLibContextMenu() {
      if (_libContextMenu) { _libContextMenu.remove(); _libContextMenu = null; }
    }
    function _showLibContextMenu(x, y, name) {
      _hideLibContextMenu();
      // 右键落在多选集内：菜单项转批量删除（与 script-tree 右键删除的多选判定同口径）
      var selCount = getSelectedNames().length;
      var batch = !!_selectedNames[name] && selCount > 1;
      var menu = document.createElement('div');
      menu.className = 'ae-context-menu';
      menu.style.display = 'block';
      menu._libName = name;
      menu._libBatch = batch;
      var items = [
        { label: AEI18n.t('重命名'), action: 'rename' },
        { sep: true },
        { label: batch ? AEI18n.t('删除选中的 {n} 个', { n: selCount }) : AEI18n.t('删除'), action: 'delete', danger: true }
      ];
      items.forEach(function (it) {
        if (it.sep) {
          var sep = document.createElement('div');
          sep.className = 'context-menu-sep';
          menu.appendChild(sep);
          return;
        }
        var elItem = document.createElement('div');
        elItem.className = 'context-menu-item' + (it.danger ? ' danger' : '');
        elItem.textContent = it.label;
        elItem.dataset.action = it.action;
        menu.appendChild(elItem);
      });
      document.body.appendChild(menu);
      // 定位（避免溢出屏幕）
      var rect = menu.getBoundingClientRect();
      var mx = x, my = y;
      if (mx + rect.width > window.innerWidth) mx = window.innerWidth - rect.width - 4;
      if (my + rect.height > window.innerHeight) my = window.innerHeight - rect.height - 4;
      menu.style.left = mx + 'px';
      menu.style.top = my + 'px';
      _libContextMenu = menu;
      _bindLibMenu();
    }
    // document 级菜单委托（仅绑定一次）
    // 经 bindDom 登记进 _domHandlers，destroy 统一解绑——否则模块重挂载后
    // 新实例重置 _libMenuBound 再绑一遍，document 级监听随挂载次数净累积。
    function _bindLibMenu() {
      if (_libMenuBound) return;
      _libMenuBound = true;
      bindDom(document, 'click', function (e) {
        if (!_libContextMenu) return;
        var item = e.target.closest('.context-menu-item');
        if (!item || !_libContextMenu.contains(item)) { _hideLibContextMenu(); return; }
        var name = _libContextMenu._libName;
        var batch = !!_libContextMenu._libBatch;
        var action = item.dataset.action;
        _hideLibContextMenu();
        if (action === 'rename') beginRename(name);
        else if (action === 'delete') { if (batch) deleteSelectedFromLibrary(); else deleteFromLibrary(name); }
      });
      bindDom(document, 'mousedown', function (e) {
        if (_libContextMenu && !_libContextMenu.contains(e.target)) _hideLibContextMenu();
      });
      bindDom(document, 'scroll', _hideLibContextMenu, true);
    }

    // 效果库条目内联改名：把 .name 替换为输入框，回车/失焦提交，Esc 取消
    function beginRename(name) {
      var list = el('shaderLibraryList');
      if (!list) return;
      // 已有编辑行（保存命名/其它改名）则不重复进入
      if (list.querySelector('.shader-library-item.editing')) return;
      // 属性值转义（\ 与 "）——效果名含引号时选择器非法，querySelector 直接
      // 抛 SyntaxError 中断改名入口（与 script-tree.js beginRename 同款手法）
      var row = list.querySelector('.shader-library-item[data-name="' + String(name).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"]');
      if (!row) return;
      var nameEl = row.querySelector('.name');
      if (!nameEl) return;
      var dir = deps.effectsDir ? deps.effectsDir() : '';
      if (!dir) return;

      var input = document.createElement('input');
      input.className = 'shader-lib-name-input';
      input.value = name;
      input.maxLength = 64;
      row.replaceChild(input, nameEl);
      row.classList.add('editing');
      input.focus();
      input.select();

      var done = false;
      // 恢复显示（不受 done 限制：冲突/失败等需恢复场景，done 可能已上锁）
      function restoreInput() {
        row.classList.remove('editing');
        if (input.parentNode) {
          var sp = document.createElement('span');
          sp.className = 'name';
          sp.textContent = name;
          row.replaceChild(sp, input);
        }
      }
      function commit() {
        if (done) return;
        var newName = String(input.value || '').trim();
        if (!newName || !validLibName(newName)) {
          // 非法名不抢焦点（防 blur→submit→focus 焦点陷阱）；点击空白放弃由 blur 分支处理
          input.classList.add('invalid');
          return;
        }
        // 名称未变：仅恢复显示
        if (newName.toLowerCase() === name.toLowerCase()) { restoreInput(); return; }
        // 同名检测（排除自身，getExistingNames 含改名前自身 data-name）
        var clash = getExistingNames().some(function (n) {
          return n.toLowerCase() === newName.toLowerCase() && n.toLowerCase() !== name.toLowerCase();
        });
        if (clash) {
          if (typeof global.showStatus === 'function') global.showStatus(AEI18n.punct('「', '"', '「', '„', '“', '« ', '«') + newName + AEI18n.t('」已存在'), 'error');
          restoreInput();
          return;
        }
        done = true;
        global.AEFS.renameFile(dir + '\\' + name + '.glsl', dir + '\\' + newName + '.glsl').then(function (ok) {
          if (ok) {
            if (_activeName === name) _activeName = newName;
            // 选中集/锚点随改名迁移：否则刷新后按旧名裁剪，选中态凭空消失
            if (_selectedNames[name]) { delete _selectedNames[name]; _selectedNames[newName] = true; }
            if (_lastClickedName === name) _lastClickedName = newName;
            if (typeof global.showStatus === 'function') global.showStatus(AEI18n.t('已重命名为: ') + newName, 'success');
            // 先移除 editing 再刷新：refreshLibrary 检测到 .editing 会跳过刷新
            row.classList.remove('editing');
            refreshLibrary();
          } else {
            if (typeof global.showStatus === 'function') global.showStatus(AEI18n.t('重命名失败'), 'error');
            restoreInput();
          }
        });
      }
      function cancel() {
        if (done) return;
        restoreInput();
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      input.addEventListener('input', function () { input.classList.remove('invalid'); });
      // blur（点击外部）= 提交，与 script-tree beginRename 的 blur→submit 约定一致。
      // 非法名直接放弃编辑恢复原名，不 focus() 抢回焦点形成陷阱（只能 Esc 脱身）
      input.addEventListener('blur', function () {
        var v = String(input.value || '').trim();
        if (!v || !validLibName(v)) { cancel(); return; }
        commit();
      });
    }

    function bindResizer() {
      var resizer = el('shaderListResizer');
      var stage = el('shaderPreviewStage');
      if (!resizer || !stage) return;
      var dragging = false, startY = 0, startPct = 0;
      bindDom(resizer, 'pointerdown', function (e) {
        dragging = true;
        startY = e.clientY;
        var rect = resizer.parentElement.getBoundingClientRect();
        var stageRect = stage.getBoundingClientRect();
        startPct = (stageRect.height / Math.max(1, rect.height)) * 100;
        resizer.setPointerCapture && resizer.setPointerCapture(e.pointerId);
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp);
        e.preventDefault();
      });
      function onMove(e) {
        if (!dragging) return;
        var rect = resizer.parentElement.getBoundingClientRect();
        var pct = Math.max(12, Math.min(70, startPct + ((e.clientY - startY) / Math.max(1, rect.height)) * 100));
        stage.style.flexBasis = pct + '%';
      }
      function onUp() {
        dragging = false;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
      }

      // 团队模式右列分隔条（上预览 / 下代码）：与外接的 .ext-row-resizer 同款——
      // 上下两条 basis 冻结合计 100%，拖拽位移 1:1 映射（只写上面那半的话 flex-grow
      // 会把位移摊薄）。内联 basis 由 hideTeamLayout 清理（共享面板在别的模式有各自口径）。
      // 下半是**两个并列页**（代码 / 效果库）⇒ basis 同时写给两页——只写代码栏的话，
      // 停在「效果库」页时拖拽只能间接影响它（两页各自的内联值因此始终同步）。
      var teamBar = el('shaderTeamResizer');
      var teamTop = el('shaderTeamStage');
      var teamBottoms = [];
      var teamCode = el('shaderRightPanel');
      var teamLib = el('shaderTeamLibPane');
      if (teamCode) teamBottoms.push(teamCode);
      if (teamLib) teamBottoms.push(teamLib);
      if (teamBar && teamTop && teamBottoms.length) {
        var tDragging = false, tStartY = 0, tStartPct = 0;
        bindDom(teamBar, 'pointerdown', function (e) {
          tDragging = true;
          tStartY = e.clientY;
          var rect = teamBar.parentElement.getBoundingClientRect();
          tStartPct = (teamTop.getBoundingClientRect().height / Math.max(1, rect.height)) * 100;
          teamBar.classList.add('dragging');
          if (teamBar.setPointerCapture) { try { teamBar.setPointerCapture(e.pointerId); } catch (_) {} }
          window.addEventListener('pointermove', onTeamMove);
          window.addEventListener('pointerup', onTeamUp);
          e.preventDefault();
        });
        function onTeamMove(e) {
          if (!tDragging) return;
          var rect = teamBar.parentElement.getBoundingClientRect();
          var pct = Math.max(12, Math.min(70, tStartPct + ((e.clientY - tStartY) / Math.max(1, rect.height)) * 100));
          teamTop.style.flexBasis = pct + '%';
          for (var i = 0; i < teamBottoms.length; i++) teamBottoms[i].style.flexBasis = (100 - pct) + '%';
        }
        function onTeamUp() {
          tDragging = false;
          teamBar.classList.remove('dragging');
          window.removeEventListener('pointermove', onTeamMove);
          window.removeEventListener('pointerup', onTeamUp);
        }
      }
    }

    function ensureRenderer() {
      if (_renderer) return _renderer;
      if (deps.previewRendererFactory && typeof deps.previewRendererFactory === 'function') {
        try { _renderer = deps.previewRendererFactory(); } catch (_) { _renderer = null; }
      }
      return _renderer;
    }

    // 预览区 msg/暂停键随渲染器状态落位（refreshPreviewFromCode 与 main.js onStatus
    // 注入共用）：异步编译（KHR_parallel_shader_compile）下 refreshPreviewFromCode 只能
    // 画出 pending 态，终态（成功/失败/跳过）由渲染器 onStatus 回调经此函数补齐——
    // 否则编译完成后 msg 永远停留在「编译中…」
    function syncPreviewStatus(status) {
      var msg = el('shaderPreviewMsg');
      var pauseBtn = el('shaderPreviewPauseBtn');
      var resetBtn = el('shaderPreviewResetBtn');
      var camBtn = el('shaderPreviewCamResetBtn');
      var r = ensureRenderer();
      if (!msg || !r || !status) return;
      if (status.pending) {
        msg.style.display = '';
        msg.textContent = AEI18n.t('编译中…');
        msg.className = 'shader-preview-msg';
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (resetBtn) resetBtn.style.display = 'none';
        if (camBtn) camBtn.style.display = 'none';
      } else if (status.ok) {
        msg.style.display = 'none';
        msg.textContent = '';
        if (pauseBtn) {
          var paused = !!(r.getPaused && r.getPaused());
          pauseBtn.style.display = '';
          pauseBtn.textContent = paused ? '▶' : '⏸';
          pauseBtn.title = paused ? AEI18n.t('继续预览') : AEI18n.t('暂停预览');
        }
        // 重置时间键与暂停键同生同灭：仅编译通过（有可渲染画面）时可用
        if (resetBtn) resetBtn.style.display = '';
        // 相机复位同规则：无画面时相机手势也无意义（画布是空的）
        if (camBtn) camBtn.style.display = '';
      } else if (status.skip) {
        msg.style.display = '';
        msg.textContent = AEI18n.t('实时预览：提交代码后自动渲染');
        msg.className = 'shader-preview-msg';
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (resetBtn) resetBtn.style.display = 'none';
        if (camBtn) camBtn.style.display = 'none';
      } else {
        msg.style.display = '';
        msg.textContent = status.error || AEI18n.t('编译失败');
        msg.className = 'shader-preview-msg error';
        if (pauseBtn) pauseBtn.style.display = 'none';
        if (resetBtn) resetBtn.style.display = 'none';
        if (camBtn) camBtn.style.display = 'none';
      }
    }

    function refreshPreviewFromCode(code) {
      var r = ensureRenderer();
      if (r && typeof r.setSource === 'function') {
        r.setSource(code || '');
        // 记录已提交渲染器的代码：updateCompileStatus 对同一代码复用渲染器编译状态，
        // 不再把同一份源码在校验上下文重复编译一遍
        _lastPreviewCode = String(code == null ? '' : code);
      }
      // 重编译后同步 uniform 默认值到预览渲染器：stripUniformInitializers 剥离了初始化器，
      // GL 中 uniform 默认 0.0，必须显式设置才能看到正确效果。
      // 代码已包含用户滑块调整后的值（setUniformDefaultValue 写回），解析即得正确值。
      if (r && code && global.AEEffectLab && typeof global.AEEffectLab.parseUniforms === 'function') {
        var uniforms = global.AEEffectLab.parseUniforms(String(code));
        if (uniforms && uniforms.length > 0) {
          uniforms.forEach(function (u) {
            if (typeof r.setUniformValue !== 'function') return;
            var def = u.default;
            if (u.type === 'float') {
              r.setUniformValue(u.name, (typeof def === 'number') ? def : 1.0);
            } else {
              var n = u.type === 'vec2' ? 2 : u.type === 'vec3' ? 3 : 4;
              var arr = Array.isArray(def) ? def.slice(0, n) : [];
              var fill = (u.type === 'vec4') ? 1.0 : 0.0;
              while (arr.length < n) arr.push(fill);
              r.setUniformValue(u.name, arr);
            }
          });
        }
      }
      var msg = el('shaderPreviewMsg');
      if (msg && r) {
        // 空代码：占位提示（renderer 已跳过空代码编译，不会误报"编译失败"）
        if (!code || !String(code).trim()) {
          var pauseBtn0 = el('shaderPreviewPauseBtn');
          var resetBtn0 = el('shaderPreviewResetBtn');
          var camBtn0 = el('shaderPreviewCamResetBtn');
          msg.style.display = '';
          msg.textContent = AEI18n.t('实时预览：提交代码后自动渲染');
          msg.className = 'shader-preview-msg';
          if (pauseBtn0) pauseBtn0.style.display = 'none';
          if (resetBtn0) resetBtn0.style.display = 'none';
          if (camBtn0) camBtn0.style.display = 'none';
          return;
        }
        // pending（异步编译中）→ 「编译中…」；终态同步路径即时落位；
        // 异步终态由渲染器 onStatus → syncPreviewStatus 补齐
        syncPreviewStatus(r.getStatus());
      }
    }

    function startPreview() {
      var r = ensureRenderer();
      if (r && typeof r.start === 'function') r.start();
      schedulePreviewInit();
    }

    // —— 预览初始化调度：把重活（WebGL 上下文创建 + 驱动编译器初始化 + 草稿首编译）
    // 挪到空闲时刻执行。startPreview 在模式切换钩子里被同步调用时，首次加载
    // shader 的数百 ms 级一次性 GL 开销落在点击处理器里（主线程卡顿）；调度后切换
    // 动画/交互不被阻塞，预览在空闲帧就绪。LLM 提交路径不经此处（service.js 直调
    // refreshPreviewFromCode，上下文此时已预热，且渲染器编译走 KHR 并行编译异步通道）。
    // 入场动画感知：启动直接进 shader/外接模式时，requestIdleCallback 会在入场动画
    // （panel-enter 420ms）的帧间隙触发，GL 的一次性同步开销（上下文创建数百 ms）把
    // 动画整个冻住——用户感知"一打开就卡"。故动画进行中先等（150ms 轮询，3s 上限
    // 兜底动画事件异常），动画结束再进空闲槽。模式切换路径无入场动画，行为不变。
    var _previewInitScheduled = false;
    function schedulePreviewInit() {
      if (_previewInitScheduled) return;
      _previewInitScheduled = true;
      var r = ensureRenderer();
      var run = function () {
        _previewInitScheduled = false;
        // 迟到守卫：实例已销毁（模块卸载）或已切出 shader/外接/团队档时不做任何 GL
        // 工作（防销毁后经 refreshPreviewFromCode→ensureRenderer 重建渲染器泄漏，
        // 对齐迟到回调守卫手法）
        if (_uiDestroyed) return;
        // 活动模式判据优先取宿主注入的 isGlslEditing()（单一真源）；未注入（单测直接
        // 构造 shaderUI）时按 shader/外接/团队三档自判，与宿主同口径。
        var m = deps.getRuntimeMode ? deps.getRuntimeMode() : '';
        var fallbackGlsl = (m === 'shader' || m === 'external' || m === 'team');
        var editing = typeof deps.isGlslEditing === 'function' ? !!deps.isGlslEditing() : fallbackGlsl;
        if (!editing) return;
        var draft = deps.getPreviewCode ? deps.getPreviewCode() : '';
        // 预览渲染器预热（幂等）：无条件执行——除上下文/编译器/占位纹理外，warmup 的
        // 首帧现付（drawing buffer 实际尺寸分配 + 首次呈现合成层 + 首 draw 管线）是
        // setSource 覆盖不到的一次性成本，草稿非空（首次准备场景）时同样需要预热，
        // 否则全部叠在首编译完成的显示瞬间（多付一次最小编译，ms 级）
        if (r && typeof r.warmup === 'function') {
          try { r.warmup(); } catch (_) {}
        }
        refreshPreviewFromCode(draft);
        // 校验单例预热（submit_shader 工具校验用，独立上下文）：在提交草稿编译之后
        // 触发（30ms）——编译在驱动侧并行进行，上下文创建（CEF 下数百 ms 主线程
        // 阻塞）落在「编译中」的 pending 窗口内（预览尚未显示，用户不可感知）。
        // 固定 +100ms 时恰与复杂 shader 的编译完成时刻相撞，表现为「编译完成
        // 显示的瞬间 UI 卡一下」；30ms 让「编译中…」状态先完成一次绘制再进入阻塞。
        setTimeout(function () {
          if (_uiDestroyed) return;
          if (global.AEEffectLab && typeof global.AEEffectLab.warmup === 'function') {
            try { global.AEEffectLab.warmup(); } catch (_) {}
          }
        }, 30);
      };
      var waited = 0;
      function scheduleRun() {
        if (typeof global.requestIdleCallback === 'function') {
          global.requestIdleCallback(run, { timeout: 1500 });
        } else {
          setTimeout(run, 120);
        }
      }
      (function waitIntro() {
        if (typeof deps.isIntroAnimating === 'function' && deps.isIntroAnimating() && waited < 3000) {
          waited += 150;
          setTimeout(waitIntro, 150);
          return;
        }
        scheduleRun();
      })();
    }

    function stopPreview() {
      if (_renderer && typeof _renderer.stop === 'function') _renderer.stop();
    }

    // 预览渲染器编译状态（只读）：getShaderPreview 截图前等待 settle 用（shaderTools
    // waitForPreviewSettle 经 AEShaderUIInstance 轮询）。不用 ensureRenderer——查询
    // 不应有"创建渲染器"副作用；渲染器不存在（未进 shader 模式）返回 null。
    function getPreviewStatus() {
      return (_renderer && typeof _renderer.getStatus === 'function') ? _renderer.getStatus() : null;
    }

    // 多时间点抓帧（getShaderPreview 的 timesInSeconds 用）：先按各时间点渲染画面，再截图；
    // 合成联系表由工具侧做。渲染器/画布不可用返回 null；渲染失败返回 { ok:false, error }。
    function capturePreviewFrames(times) {
      var canvas = el('shaderPreviewCanvas');
      if (!_renderer || typeof _renderer.renderFrameSequence !== 'function' || !canvas) return null;
      var frames = [];
      var res = _renderer.renderFrameSequence(times, function (meta) {
        var dataUrl = null;
        try { dataUrl = canvas.toDataURL('image/jpeg', 0.9); } catch (_) { dataUrl = null; }
        frames.push({ time: meta.time, actualTime: meta.actualTime, frame: meta.frame, dataUrl: dataUrl });
      });
      if (!res || res.ok !== true) return { ok: false, error: (res && res.error) || '预览渲染失败' };
      return {
        ok: true,
        mode: res.mode,
        timeClamped: !!res.timeClamped,
        frameRate: res.frameRate,
        frameWidth: canvas.width || 0,
        frameHeight: canvas.height || 0,
        frames: frames
      };
    }

    function destroy() {
      _uiDestroyed = true;
      // 解绑静态 DOM 监听：模块重挂载创建新实例后会重新 bind，
      // 不解绑则同一批静态元素上的监听随挂载次数累积
      for (var i = 0; i < _domHandlers.length; i++) {
        try { _domHandlers[i].node.removeEventListener(_domHandlers[i].evt, _domHandlers[i].fn, _domHandlers[i].opts); } catch (_) {}
      }
      _domHandlers = [];
      // 菜单节点挂 document.body，实例销毁时一并移除
      _hideLibContextMenu();
      // 撤销挂起的 uniform 写回防抖——迟到的 setPreviewCode 会经
      // getShaderUI 重建实例并重挂监听（对齐迟到回调守卫手法）
      if (_uniformWriteTimer) { clearTimeout(_uniformWriteTimer); _uniformWriteTimer = null; }
      _uniformWritePending = null;
      // 迟到的覆盖确认不再触发读取。
      _loadConfirmPending = '';
      stopPreview();
      if (_renderer && typeof _renderer.destroy === 'function') _renderer.destroy();
      _renderer = null;
    }

    // —— 右抽屉：编译状态 + 参数控件 + 应用 ——
    // 控件类型映射（与原生 ECW customUI.cpp kindFor 对齐；颜色语义判定取
    // AEEffectLab.isColorNamed，与宿主 glsl::isColorNamed 共用同一张判据表）：
    //   float → Slider（单滑块）；vec2/vec3 颜色语义 → Swatch（取色器，单行）；
    //   vec4 → Swatch（取色器 + alpha 滑块）；其余 vec2/vec3 → Point（多分量滑块）。
    function isColorName(name) {
      var lab = window.AEEffectLab;
      return !!(lab && typeof lab.isColorNamed === 'function' && lab.isColorNamed(name));
    }
    function clamp01(v) { return Math.max(0, Math.min(1, Number(v) || 0)); }
    function toHex(v) {
      var n = Math.round(clamp01(v) * 255);
      return ('0' + n.toString(16)).slice(-2);
    }
    // [r,g,b(,a)] 0~1 → '#rrggbb'（alpha 不参与 hex）
    function rgbToHex(arr) {
      var a = Array.isArray(arr) ? arr : [1, 1, 1];
      return '#' + toHex(a[0]) + toHex(a[1]) + toHex(a[2]);
    }
    // '#rrggbb' → [r,g,b] 0~1
    function hexToRgb(hex) {
      var s = String(hex || '').replace('#', '');
      if (s.length !== 6) return [1, 1, 1];
      var n = parseInt(s, 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    // 滑块范围：@range 注释优先；无则按默认值推导 [min(0,默认), max(1,默认)]——
    // 与宿主 C++ customUI.cpp rangeFor 同口径（float 无初始化器默认 1.0，vec 分量无初始化器默认 0）
    function rangeFor(u, comp) {
      if (u && u.range) return { min: u.range.min, max: u.range.max };
      var dv;
      if (u.type === 'float') dv = (typeof u.default === 'number') ? u.default : 1.0;
      else dv = (Array.isArray(u.default) && typeof u.default[comp] === 'number') ? u.default[comp] : 0;
      var lo = Math.min(0, dv), hi = Math.max(1, dv);
      if (lo === hi) hi = lo + 1;   // 防除零（对齐宿主）
      return { min: lo, max: hi };
    }
    // 分量数：float=1 / vec2=2 / vec3=3 / vec4=4
    function compCount(type) {
      return type === 'float' ? 1 : type === 'vec2' ? 2 : type === 'vec3' ? 3 : 4;
    }
    // 无默认值/表达式时的中性值（与原生 PARAMS_SETUP 对齐：float/vec4 无默认 → 1.0，vec2/vec3 → 0）
    function neutralDefault(u) {
      if (u.type === 'float') return 1.0;
      var n = compCount(u.type);
      var fill = (u.type === 'vec4') ? 1.0 : 0.0;
      var arr = [];
      for (var i = 0; i < n; i++) arr.push(fill);
      return arr;
    }
    // 取 uniform 当前值：float → number；vec → 完整数组（缺失分量补默认）
    function valueOf(u) {
      var def = u.default;
      if (u.type === 'float') return (typeof def === 'number') ? def : neutralDefault(u);
      var n = compCount(u.type);
      var arr = Array.isArray(def) ? def.slice(0, n) : [];
      var fill = neutralDefault(u)[0];
      while (arr.length < n) arr.push(fill);
      return arr;
    }

    function renderUniforms(uniforms) {
      var body = el('shaderUniformsBody');
      if (!body) return;
      body.innerHTML = '';
      if (!uniforms || uniforms.length === 0) {
        body.innerHTML = AEI18n.html('<div style="font-size:11px;color:#888;">无参数（uniform float/vec2/vec3/vec4）</div>');
        return;
      }
      var r = ensureRenderer();
      uniforms.forEach(function (u) {
        var row = document.createElement('div');
        row.className = 'shader-uniform-row';
        var sync = function (value) {
          if (r && typeof r.setUniformValue === 'function') r.setUniformValue(u.name, value);
        };
        var value = valueOf(u);
        // 同步默认值到预览渲染器（stripUniformInitializers 剥离了初始化器，
        // 预览 GL 中 uniform 默认 0.0，必须显式设置才能看到正确效果）
        sync(value);
        var label = document.createElement('span');
        label.className = 'u-name';
        label.textContent = u.name;
        row.appendChild(label);

        if (u.type === 'float') {
          buildFloatControl(row, u, value, sync);
        } else if ((u.type === 'vec2' || u.type === 'vec3') && isColorName(u.name)) {
          buildColorControl(row, u, value, sync, false);
        } else if (u.type === 'vec4') {
          buildColorControl(row, u, value, sync, true);
        } else {
          buildPointControl(row, u, value, sync);
        }
        body.appendChild(row);
      });
    }

    // float → 单滑块（@range；无则按默认值推导）
    function buildFloatControl(row, u, value, sync) {
      var rng = rangeFor(u);
      var input = document.createElement('input');
      input.type = 'range';
      input.min = rng.min; input.max = rng.max; input.step = 0.01;
      input.value = value;
      var valEl = document.createElement('span');
      valEl.className = 'u-val';
      valEl.textContent = Number(value).toFixed(2);
      input.addEventListener('input', function () {
        var v = Number(input.value);
        valEl.textContent = v.toFixed(2);
        sync(v);
        setUniformDefaultValue(u, v);
      });
      row.appendChild(input); row.appendChild(valEl);
    }

    // vec2/vec3 非颜色 → 多分量滑块（x/y/z 分别调；各分量范围按该分量默认值推导）
    function buildPointControl(row, u, value, sync) {
      var n = value.length;
      var comps = document.createElement('div');
      comps.className = 'u-comps';
      var names = ['x', 'y', 'z', 'w'];
      for (var i = 0; i < n; i++) {
        var rng = rangeFor(u, i);
        var c = document.createElement('div');
        c.className = 'u-comp';
        var cl = document.createElement('label');
        cl.textContent = names[i];
        var input = document.createElement('input');
        input.type = 'range';
        input.min = rng.min; input.max = rng.max; input.step = 0.01;
        input.value = value[i];
        (function (idx, inp) {
          inp.addEventListener('input', function () {
            // 必须更新 value 原数组（与 buildColorControl 更新 base 一致）：
            // 若只改 slice() 副本，updateVal 显示不刷新，且拖其它分量时会用
            // 初始 value 重建数组，已调整的分量被覆盖丢失（uniform 值/写回默认值都错）
            value[idx] = Number(inp.value);
            sync(value);
            updateVal();
            setUniformDefaultValue(u, value);
          });
        })(i, input);
        c.appendChild(cl); c.appendChild(input);
        comps.appendChild(c);
      }
      var valEl = document.createElement('span');
      valEl.className = 'u-val';
      function updateVal() {
        valEl.textContent = value.map(function (v) { return Number(v).toFixed(2); }).join(', ');
      }
      updateVal();
      row.appendChild(comps); row.appendChild(valEl);
    }

    // 颜色型（vec2/vec3 命中颜色语义，或 vec4）→ 取色器；分量数与 value 一致，
    // vec4 额外 alpha 滑块（0~1）。
    function buildColorControl(row, u, value, sync, hasAlpha) {
      var n = hasAlpha ? 4 : Math.min(value.length, 3);
      var base = value.slice(0, n);
      while (base.length < n) base.push(1);
      var wrap = document.createElement('div');
      wrap.className = 'u-color';
      var cinput = document.createElement('input');
      cinput.type = 'color';
      cinput.value = rgbToHex(base);
      var valEl = document.createElement('span');
      valEl.className = 'u-val';
      function updateVal() {
        valEl.textContent = base.map(function (v) { return Number(v).toFixed(2); }).join(', ');
      }
      updateVal();
      cinput.addEventListener('input', function () {
        var rgb = hexToRgb(cinput.value);
        for (var i = 0; i < Math.min(3, base.length); i++) base[i] = rgb[i];
        sync(base.slice(0, n));
        updateVal();
        setUniformDefaultValue(u, base.slice(0, n));
      });
      wrap.appendChild(cinput);
      if (hasAlpha) {
        var aWrap = document.createElement('div');
        aWrap.className = 'u-alpha';
        var aLabel = document.createElement('label');
        aLabel.textContent = 'α';
        var aInput = document.createElement('input');
        aInput.type = 'range';
        aInput.min = 0; aInput.max = 1; aInput.step = 0.01;
        aInput.value = base[3];
        aInput.addEventListener('input', function () {
          base[3] = Number(aInput.value);
          sync(base);
          updateVal();
          setUniformDefaultValue(u, base);
        });
        aWrap.appendChild(aLabel); aWrap.appendChild(aInput);
        wrap.appendChild(aWrap);
      }
      wrap.appendChild(valEl);
      row.appendChild(wrap);
    }

    // 写回默认值：value 为完整值（float → 数值；vec → 完整数组）
    // 滑块拖动路径的写回/持久化/预览重编译合并进 250ms 防抖——每次
    // input 事件即触发一次全量设置持久化（deps.setPreviewCode 内 saveSettings 为
    // 完整 readAll+writeAll）+ refreshPreviewFromCode/updateCompileStatus 双份执行
    // （deps.setPreviewCode 内部已各调一次）；script 预览区同构场景已用 250ms 防抖，
    // shader 滑块路径漏改。拖动视觉零延迟由 sync()（r.setUniformValue 直设，下一帧
    // 生效）保证。防抖期间新值以 pending 为基底累积（而非重读编辑区旧值），避免
    // 250ms 内交替拖多个 uniform 时前一个的调整被旧基底吞掉。
    var _uniformWriteTimer = null;
    var _uniformWritePending = null;
    function setUniformDefaultValue(u, value) {
      var code = (_uniformWritePending != null)
        ? _uniformWritePending
        : (deps.getPreviewCode ? deps.getPreviewCode() : '');
      if (!code) return;
      var newCode = (global.AEEffectLab && typeof global.AEEffectLab.setUniformDefault === 'function')
        ? global.AEEffectLab.setUniformDefault(code, u.name, value)
        : code;
      if (newCode === code) return;
      _uniformWritePending = newCode;
      if (_uniformWriteTimer) clearTimeout(_uniformWriteTimer);
      _uniformWriteTimer = setTimeout(function () {
        _uniformWriteTimer = null;
        if (_uniformWritePending == null) return;
        var pending = _uniformWritePending;
        _uniformWritePending = null;
        // deps.setPreviewCode 内部已做高亮/持久化/refreshPreviewFromCode/
        // updateCompileStatus（main.js 注入），此处不再重复调用（再调一次就是双份）。
        if (deps.setPreviewCode) deps.setPreviewCode(pending);
      }, 250);
    }

    function updateCompileStatus(code) {
      var statusEl = el('shaderCompileStatus');
      if (!statusEl) return;
      // 渲染器已对同一代码跑过 setSource：编译状态已由渲染器 onStatus 回调写入状态栏
      // （成功/失败/跳过全路径，见 main.js previewRendererFactory 注入），无需再跑
      // compileCheck——GLSL 全量编译+链接很贵，每次加载/提交都会把同一份源码在
      // 校验上下文再编译一遍（卡顿来源之一）。渲染器不可用（工厂缺失/画布异常）时
      // 代码不会命中 → 走下方 compileCheck 兜底。
      if (ensureRenderer() && _lastPreviewCode === String(code == null ? '' : code)) return;
      var ck = (global.AEEffectLab && typeof global.AEEffectLab.compileCheck === 'function')
        ? global.AEEffectLab.compileCheck(code)
        : null;
      if (ck && ck.ok === true) { statusEl.textContent = AEI18n.t('编译通过'); statusEl.className = 'shader-compile-status ok'; }
      else if (ck && ck.ok === false) { statusEl.textContent = (ck.error || AEI18n.t('编译失败')).slice(0, 40); statusEl.className = 'shader-compile-status error'; }
      else { statusEl.textContent = AEI18n.t('未编译'); statusEl.className = 'shader-compile-status'; }
    }

    // 应用由 AE ECW 自绘选择器直接选 glsl 文件完成，面板不再提供 applyShader。

    function saveToLibrary() {
      // 防抖窗口内保存须先同步 flush pending——滑块调整后 250ms 内点保存，
      // getPreviewCode 读到的是未 flush 的旧代码，落盘 .glsl 与预览画面不一致（从库
      // 重新加载时 uniform 默认值回退旧值，用户无感知）。
      if (_uniformWritePending != null) {
        var pending = _uniformWritePending;
        _uniformWritePending = null;
        if (_uniformWriteTimer) {
          clearTimeout(_uniformWriteTimer);
          _uniformWriteTimer = null;
        }
        if (deps.setPreviewCode) deps.setPreviewCode(pending);
      }
      // 取码与空码判定先于切页/开抽屉：编辑面为空时只报失败，不把界面切到效果库
      //（否则用户看到的是页签跳走 + 「写入失败」，代码面反而不见了）。
      var code = deps.getPreviewCode ? deps.getPreviewCode() : '';
      if (!code || !code.trim()) {
        if (typeof deps.onApplyResult === 'function') deps.onApplyResult(false);
        return;
      }
      // 保存时自动展开**效果库所在的抽屉**并亮出列表，便于用户看到刚保存的条目。
      // 效果库在右抽屉的「效果库」页 ⇒ 切到该页 + 展开右抽屉；其余模式效果库在左列下半
      // ⇒ 展开左抽屉（既有口径逐字不动）。判据用「效果库的实际位置」而不是模式。
      if (_libInTeamPane()) {
        showTeamTab('library');
        if (typeof deps.openRightDrawer === 'function') deps.openRightDrawer();
      } else {
        showLeft();
        if (typeof deps.openLibraryDrawer === 'function') deps.openLibraryDrawer();
      }
      var list = el('shaderLibraryList');
      if (!list) return;
      // 已有编辑行则不重复插入
      if (list.querySelector('.shader-library-item.editing')) return;
      // 清除空态占位
      var empty = list.querySelector('.shader-library-empty');
      if (empty) empty.remove();
      // 默认名：优先复用当前加载名（覆盖式保存语义），否则 "effect"
      var base = _activeName || 'effect';
      if (!validLibName(base)) base = 'effect';
      // 当前加载名若是历史顺延名（如 a_2），回溯根名（a）再顺延，保持 a→a_2→a_3 序列，避免 a_2→a_2_2
      base = base.replace(/_\d+$/, '');
      // 预填顺延后的名称（当前加载名若已存在则顺延，避免静默覆盖）
      var suggested = dedupeName(base, getExistingNames());

      var row = document.createElement('div');
      row.className = 'shader-library-item editing';
      row.innerHTML = '<input type="text" class="shader-lib-name-input" maxlength="64" />'
        + AEI18n.html('<span class="actions"><span class="hint">回车保存 · Esc取消</span></span>');
      var input = row.querySelector('input');
      input.value = suggested;
      list.insertBefore(row, list.firstChild);
      input.focus();
      input.select();

      var done = false;
      function commit() {
        if (done) return;
        var name = String(input.value || '').trim();
        if (!name || !validLibName(name)) {
          // 非法名不抢焦点（防 blur→commit→focus 焦点陷阱）；点击空白放弃由 blur 分支处理
          input.classList.add('invalid');
          return;
        }
        done = true;
        // 确认时再次检测同名（用户可能修改了名称），自动顺延
        var finalName = dedupeName(name, getExistingNames());
        var dir = deps.effectsDir ? deps.effectsDir() : '';
        if (!dir) { row.remove(); return; }
        global.AEFS.writeFile(dir + '\\' + finalName + '.glsl', code).then(function (ok) {
          if (typeof deps.onApplyResult === 'function') deps.onApplyResult(!!ok);
          // 顺延提示放 onApplyResult 之后：showStatus 是覆盖式，放前面会被 onApplyResult 的提示覆盖。
          // 与 script-tree newScript/newFolder 对齐（"原名 已存在" → 已顺延为 x_N）
          if (ok && finalName !== name && typeof global.showStatus === 'function') {
            global.showStatus(AEI18n.t('已保存: ') + finalName + AEI18n.punct('（', ' (') + name + AEI18n.t(' 已存在）'), 'success');
          }
          // 成功必须先移除编辑行再 refreshLibrary：refreshLibrary 检测到 .editing 会跳过刷新，
          // 否则行残留且 done=true 挡住 Enter/Esc/blur，命名阶段卡死
          if (ok) { _activeName = finalName; row.remove(); refreshLibrary(); }
          else { row.remove(); }
        });
      }
      function cancel() {
        if (done) return;
        done = true;
        row.remove();
        // 取消后若列表清空，恢复空态
        if (!list.children.length) {
          list.innerHTML = emptyState(AEI18n.t('暂无效果'));
          updateLibCount(0);
        }
      }
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); commit(); }
        else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
      });
      input.addEventListener('input', function () { input.classList.remove('invalid'); });
      // blur（点击外部）= 提交保存，与 script-tree newScript/newFolder/beginRename 的 blur→submit 约定一致。
      // 非法名直接放弃保存移除编辑行，不 focus() 抢回焦点形成陷阱（只能 Esc 脱身）
      input.addEventListener('blur', function () {
        var v = String(input.value || '').trim();
        if (!v || !validLibName(v)) { cancel(); return; }
        commit();
      });
    }

    function showRight() { var p = el('shaderRightPanel'); if (p) p.style.display = ''; }
    function hideRight() { var p = el('shaderRightPanel'); if (p) p.style.display = 'none'; }

    function bindRightEvents() {
      var saveBtn = el('shaderSaveBtn');
      bindDom(saveBtn, 'click', saveToLibrary);
      var toggle = el('shaderUniformsToggle');
      var body = el('shaderUniformsBody');
      if (toggle && body) bindDom(toggle, 'click', function () {
        var collapsed = body.classList.toggle('collapsed');
        var caret = toggle.querySelector('.caret');
        if (caret) caret.textContent = collapsed ? '▸' : '▾';
      });
      var refreshBtn = el('shaderRefreshLibBtn');
      bindDom(refreshBtn, 'click', function () { refreshLibrary(); });
      bindLibraryEvents();
    }

    // 效果库列表的静态 DOM 绑定（列表元素在 index.html，条目由 refreshLibrary 动态建）：
    // 批量删除键 + 空白处单击清空选中（点中条目由行内 click 处理，此处只兜「没点到条目」）。
    function bindLibraryEvents() {
      var list = el('shaderLibraryList');
      if (!list) return;
      bindDom(list, 'click', function (e) {
        var t = e.target;
        var inRow = (t && typeof t.closest === 'function') ? t.closest('.shader-library-item') : null;
        if (inRow) return;
        if (getSelectedNames().length === 0) return;
        clearSelection();
      });
      bindDom(el('shaderBatchDeleteBtn'), 'click', deleteSelectedFromLibrary);
      // 挂载时按当前选中集落一次态（模块重挂载后按钮可用性与标题计数不留旧值）
      updateSelectionUI();
    }

    // —— 预览相机操控：左键旋转 / 右键推拉 / 中键平移 ——
    // 预览渲染器注入的虚拟相机暂时替代 AE 相机矩阵（uHasCam=1，见 shaderPreviewRenderer
    // CAM_* 常量），此处只做 DOM 手势 → 渲染器方法的转发。shader / 外接两模式共用同一个
    // canvas（外接模式仅搬移 DOM 位置，监听随元素不丢），故一次绑定两模式都生效。
    // pointer capture：拖出画布（甚至移出面板）仍持续接收事件，与 bindResizer 同手法。
    function bindPreviewCamera() {
      var canvas = el('shaderPreviewCanvas');
      if (!canvas) return;
      var drag = null;   // { btn, x, y }
      function cam() {
        var r = ensureRenderer();
        // 渲染器缺相机方法（注入的渲染器/工厂未提供）时静默不接管拖拽，不改动画面
        return (r && typeof r.orbitCamera === 'function') ? r : null;
      }
      // 右键用于缩放：屏蔽 canvas 上下文菜单，否则每次缩放结束弹出菜单
      bindDom(canvas, 'contextmenu', function (e) { e.preventDefault(); });
      // 中键：屏蔽 CEF/Chromium 的自动滚动（mousedown 默认行为）与中键 auxclick
      bindDom(canvas, 'mousedown', function (e) { if (e.button === 1 || e.button === 2) e.preventDefault(); });
      bindDom(canvas, 'auxclick', function (e) { e.preventDefault(); });
      bindDom(canvas, 'pointerdown', function (e) {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        if (!cam()) return;
        drag = { btn: e.button, x: e.clientX, y: e.clientY };
        canvas.classList.add('cam-dragging');
        try { if (canvas.setPointerCapture) canvas.setPointerCapture(e.pointerId); } catch (_) {}
        e.preventDefault();
      });
      bindDom(canvas, 'pointermove', function (e) {
        if (!drag) return;
        var r = cam();
        if (!r) { drag = null; canvas.classList.remove('cam-dragging'); return; }
        // 增量转发：拖动中每帧只传本帧位移，渲染器侧无需知道起点
        var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.x = e.clientX; drag.y = e.clientY;
        if (drag.btn === 0) r.orbitCamera(dx, dy);
        // 右键推拉只吃横向位移（向右拖 = 推近）：纵向位移忽略，两种手势不互相串扰
        else if (drag.btn === 2) r.zoomCamera(dx);
        else r.panCamera(dx, dy);
      });
      function endDrag() {
        if (!drag) return;
        drag = null;
        canvas.classList.remove('cam-dragging');
      }
      bindDom(canvas, 'pointerup', endDrag);
      bindDom(canvas, 'pointercancel', endDrag);
      bindDom(canvas, 'lostpointercapture', endDrag);
    }

    // 预览浮层键：暂停（冻结/继续，时间从暂停点继续）+ 重置时间（uTime 归零）+ 相机复位
    function bindPreviewEvents() {
      // 相机手势与浮层键相互独立：先绑相机（本函数下方的暂停键守卫会提前 return，
      // 若把相机绑定放在其后，缺暂停键的 DOM（单测/精简宿主）下相机一并失效）
      bindPreviewCamera();
      var btn = el('shaderPreviewPauseBtn');
      if (!btn) return;
      bindDom(btn, 'click', function () {
        var r = ensureRenderer();
        if (!r || typeof r.setPaused !== 'function') return;
        var paused = !(r.getPaused ? r.getPaused() : false);
        r.setPaused(paused);
        btn.textContent = paused ? '▶' : '⏸';
        btn.title = paused ? AEI18n.t('继续预览') : AEI18n.t('暂停预览');
      });
      // 重置时间：手动把 uTime 归零重新起算（与「加载效果库文件」同一入口；预览常驻
      // 循环下时间只增不减，调试动画类 shader 需要能回到 t=0）
      bindDom(el('shaderPreviewResetBtn'), 'click', function () {
        var r = ensureRenderer();
        if (!r || typeof r.resetTime !== 'function') return;
        r.resetTime();
      });
      // 相机复位：回到默认取景（正面、整层可见）——转晕了/缩放过头时的唯一出口
      bindDom(el('shaderPreviewCamResetBtn'), 'click', function () {
        var r = ensureRenderer();
        if (!r || typeof r.resetCamera !== 'function') return;
        r.resetCamera();
      });
    }

    return {
      showLeft: showLeft, hideLeft: hideLeft,
      // 团队模式右抽屉：stage 移入/移回（显隐由 .team-mode-active 的 CSS 驱动）；
      // 同一对出口还负责效果库搬进/搬回与页签复位，另加页签切换与绑定两个出口
      showTeamLayout: showTeamLayout, hideTeamLayout: hideTeamLayout,
      showTeamTab: showTeamTab, bindTeamTabs: bindTeamTabs,
      refreshLibrary: refreshLibrary, loadFromLibrary: loadFromLibrary, deleteFromLibrary: deleteFromLibrary,
      deleteSelectedFromLibrary: deleteSelectedFromLibrary,
      refreshPreviewFromCode: refreshPreviewFromCode, syncPreviewStatus: syncPreviewStatus, getPreviewStatus: getPreviewStatus, capturePreviewFrames: capturePreviewFrames, startPreview: startPreview, stopPreview: stopPreview, destroy: destroy,
      bindResizer: bindResizer, bindPreviewEvents: bindPreviewEvents,
      showRight: showRight, hideRight: hideRight, renderUniforms: renderUniforms,
      updateCompileStatus: updateCompileStatus, saveToLibrary: saveToLibrary, bindRightEvents: bindRightEvents
    };
  }

  global.AEShaderUI = global.AEShaderUI || {};
  global.AEShaderUI.createShaderUI = createShaderUI;
})(window);
