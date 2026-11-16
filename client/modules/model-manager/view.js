(function (global) {
  'use strict';

  function _escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // API Key 明文/密文切换的眼睛图标（内联 SVG，不使用 emoji，避免字体不一致）
  var _EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  var _EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

  function _escapeAttr(str) {
    return _escapeHtml(str);
  }

  function createModelManagerView(controller, container) {
    var _ctrl = controller;
    var _el = container;
    var _searchTimer = null;
    var _discoveredModels = [];
    var _discoveryProviderId = null;
    var _discoveryTempProvider = null; // 新增平台模式下保存前的临时 provider 对象
    var _editingProviderId = null;
    var _editingCapabilitiesModelId = null;
    var _statusTimer = null;

    function _isActiveProvider(provider, state) {
      if (!provider || !state || !state.globalSettings) return false;
      var currentProviderId = state.globalSettings.defaultProviderId || state.globalSettings.defaultPlatform || '';
      return currentProviderId === provider.id;
    }

    function _getDisplayModelId(provider, state) {
      var isActiveProvider = _isActiveProvider(provider, state);
      if (isActiveProvider && state.globalSettings && (state.globalSettings.defaultModelId || state.globalSettings.defaultModel)) {
        return state.globalSettings.defaultModelId || state.globalSettings.defaultModel;
      }
      var selectedModelId = _ctrl.getProviderSelectedModel(provider.id);
      if (selectedModelId) return selectedModelId;
      if (provider.selectedModelId) return provider.selectedModelId;
      if (provider.models && provider.models.length > 0) return provider.models[0].id;
      return null;
    }

    // 提示统一走全局 AEToast（顶部弹出，覆盖所有面板）。
    // 保留函数名 + 签名以免改动 30+ 调用处；type 映射到 AEToast 的四种 tone。
    function _showPanelStatus(message, type) {
      if (global.AEToast && typeof global.AEToast.show === 'function') {
        global.AEToast.show(message || '', type || 'info', { autoHideMs: 3600 });
      }
    }

    function _buildHtml() {
      var html = '';
      html += '<div class="model-manager-container">';
      // 视觉代理模型通过「模型平台管理」条目的右键菜单设置（设为/取消视觉代理），
      // 被设为视觉代理的条目会高亮为主题色并显示「视觉代理」标签。
      html += '<div class="provider-list-header">';
      html += AEI18n.html('<span class="provider-list-title">模型平台管理</span>');
      html += AEI18n.html('<button class="btn compact" id="addProviderBtn">新增平台</button>');
      html += '</div>';
      html += '<div id="providerStatusMessage" class="model-manager-status hidden"></div>';
      html += '<div class="provider-list-compact ae-scrollbar" id="providerList"></div>';
      html += '</div>';

      html += '<div class="modal-mask hidden" id="providerEditorModal">';
      html += '<div class="modal wide">';
      html += '<div class="modal-head">';
      html += AEI18n.html('<span class="modal-title" id="providerEditorTitle">新建自定义平台</span>');
      html += '<button class="modal-close" id="providerEditorClose">×</button>';
      html += '</div>';
      html += '<div class="modal-body ae-scrollbar">';
      html += '<div class="editor-section">';
      html += AEI18n.html('<div class="editor-section-title">平台配置</div>');
      html += '<div class="editor-form-grid">';
      html += AEI18n.html('<div class="modal-row"><label>平台 ID</label><input type="text" id="providerEditId" placeholder="例如 my-custom-provider"></div>');
      html += AEI18n.html('<div class="modal-row"><label>显示名称</label><input type="text" id="providerEditLabel" placeholder="例如 My Custom Provider"></div>');
      html += AEI18n.html('<div class="modal-row"><label>协议类型</label><select id="providerEditProtocol"></select></div>');
      html += '<div class="modal-row"><label>Base URL</label><input type="text" id="providerEditBaseUrl" placeholder="https://api.example.com/v1"></div>';
      html += AEI18n.html('<div class="modal-row api-key-row wide"><label>API Key</label><div class="pwd-wrap"><input type="password" id="providerEditApiKey" placeholder="输入该平台 API Key（仅加密保存到全局设置）"><button type="button" class="toggle-pwd" id="providerEditApiKeyToggle" title="显示/隐藏 API Key"><span class="eye-open">') + _EYE_OPEN_SVG + '</span><span class="eye-off">' + _EYE_OFF_SVG + '</span></button></div></div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="editor-section advanced-options">';
      html += '<div class="editor-section-title collapsible collapsed" id="advancedOptionsTitle">';
      html += AEI18n.html('<span>高级选项</span>');
      html += '<span class="collapse-icon">▼</span>';
      html += '</div>';
      html += '<div class="advanced-options-content hidden" id="advancedOptionsContent">';
      html += '<div class="editor-form-grid">';
      html += AEI18n.html('<div class="modal-row wide endpoint-row" id="providerEditEndpointRow"><label>端点路径</label><div class="endpoint-controls"><select id="providerEditEndpoint"></select><input type="text" id="providerEditEndpointCustom" placeholder="例如 /custom/v1/chat" style="display:none"></div></div>');
      html += AEI18n.html('<div class="modal-row wide upload-mode-row" id="providerEditUploadModeRow"><label>上传方式</label><label class="toggle-wrap" title="开启：视频/文件上传为 file_id 引用；关闭：即使填写了上传文件 URL 也走 base64 内联"><input type="checkbox" class="switch-input" id="providerEditUseUpload"><span class="switch-slider" aria-hidden="true"></span><span class="toggle-label">作为文件引用上传</span></label></div>');
      html += AEI18n.html('<div class="modal-row wide" id="providerEditUploadUrlRow"><label>上传文件 URL</label><input type="text" id="providerEditUploadUrl" placeholder="例如 https://api.example.com/v1/files"><div class="upload-url-hint">未填写时该平台不启用文件上传（视频能力不可用）</div></div>');
      html += AEI18n.html('<div class="modal-row wide" id="providerEditHeadersRow"><label>自定义请求头</label><textarea id="providerEditHeaders" spellcheck="false" placeholder="每行一条，格式 名称: 值（如 x-opencode-session: my-session-id）"></textarea></div>');
      html += '</div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="editor-section">';
      html += AEI18n.html('<div class="editor-section-title">模型列表</div>');
      html += '<div class="editor-model-list" id="providerEditModels"></div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="modal-footer">';
      html += AEI18n.html('<button class="btn secondary" id="providerEditorDiscover">获取模型</button>');
      html += AEI18n.html('<button class="btn secondary" id="providerEditorAddModel">新增模型</button>');
      html += '<span class="modal-footer-spacer"></span>';
      html += AEI18n.html('<button class="btn secondary" id="providerEditorCancel">取消</button>');
      html += AEI18n.html('<button class="btn" id="providerEditorSave">保存</button>');
      html += '</div>';
      html += '<div class="drawer-mask hidden" id="discoveryDrawerMask"></div>';
      html += '<div class="drawer right hidden" id="discoveryDrawer">';
      html += '<div class="drawer-toolbar">';
      html += AEI18n.html('<span class="drawer-title">模型发现</span>');
      html += '<button class="drawer-close" id="discoveryDrawerClose">×</button>';
      html += '</div>';
      html += '<div class="drawer-status" id="discoveryDrawerStatus"></div>';
      html += '<div class="drawer-controls">';
      html += AEI18n.html('<input type="text" class="text-input" id="discoverySearchInput" placeholder="搜索模型...">');
      html += AEI18n.html('<button class="btn" id="discoveryFetchBtn">获取/刷新</button>');
      html += AEI18n.html('<button class="btn secondary" id="discoveryImportSelectedBtn">导入选中</button>');
      html += '</div>';
      html += '<div class="drawer-body ae-scrollbar" id="discoveryDrawerResults"></div>';
      html += '</div>';
      html += '<div class="modal-mask hidden" id="addModelModal">';
      html += '<div class="modal">';
      html += '<div class="modal-head">';
      html += AEI18n.html('<span class="modal-title">新增模型</span>');
      html += '<button class="modal-close" id="addModelClose">×</button>';
      html += '</div>';
      html += '<div class="modal-body ae-scrollbar">';
      html += AEI18n.html('<div class="modal-row"><label>模型 ID</label><input type="text" id="addModelId" placeholder="例如 doubao-seed-X（必填）"></div>');
      html += AEI18n.html('<div class="modal-row"><label>显示名称</label><input type="text" id="addModelName" placeholder="可选，默认同模型 ID"></div>');
      html += '<div class="add-model-capabilities">';
      html += AEI18n.html('<div class="add-model-capabilities-title">模型能力</div>');
      html += '<div class="add-model-capabilities-list" id="addModelCapabilitiesList"></div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="modal-footer">';
      html += '<span class="modal-footer-spacer"></span>';
      html += AEI18n.html('<button class="btn secondary" id="addModelCancel">取消</button>');
      html += AEI18n.html('<button class="btn" id="addModelSave">保存</button>');
      html += '</div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="modal-mask hidden" id="editModelCapabilitiesModal">';
      html += '<div class="modal">';
      html += '<div class="modal-head">';
      html += AEI18n.html('<span class="modal-title">编辑模型能力</span>');
      html += '<button class="modal-close" id="editModelCapabilitiesClose">×</button>';
      html += '</div>';
      html += '<div class="modal-body ae-scrollbar">';
      html += '<div class="capabilities-model-card" id="editModelCapabilitiesName"></div>';
      html += '<div class="capabilities-edit-group">';
      html += AEI18n.html('<div class="capabilities-edit-group-title">支持能力</div>');
      html += '<div class="capabilities-edit-list" id="editModelCapabilitiesList"></div>';
      html += '</div>';
      html += '</div>';
      html += '<div class="modal-footer">';
      html += '<span class="modal-footer-spacer"></span>';
      html += AEI18n.html('<button class="btn secondary" id="editModelCapabilitiesCancel">取消</button>');
      html += AEI18n.html('<button class="btn" id="editModelCapabilitiesSave">保存</button>');
      html += '</div>';
      html += '</div>';
      html += '</div>';
      html += '</div></div>';

      return html;
    }

    function _renderProviderRow(provider, state) {
      var gs = (state && state.globalSettings) || {};
      var isActiveProvider = _isActiveProvider(provider, state);
      var isVisionProxy = gs.visionProviderId === provider.id;
      var rowClass = 'provider-row-card';
      if (isActiveProvider) rowClass += ' active-provider';
      if (isVisionProxy) rowClass += ' vision-proxy';
      var modelId = _getDisplayModelId(provider, state);
      var html = '<div class="' + rowClass + '" data-provider-id="' + _escapeAttr(provider.id) + '">';
      html += '<div class="provider-card-main">';
      html += '<div class="provider-card-title">';
      html += '<span class="provider-name">' + _escapeHtml(AEI18n.t(provider.label || provider.id)) + '</span>';
      html += '<div class="provider-badges">';
      html += provider.builtin ? AEI18n.html('<span class="provider-badge builtin">内置</span>') : AEI18n.html('<span class="provider-badge custom">自定义</span>');
      html += '</div>';
      html += '</div>';
      html += '<div class="provider-card-model">';
      html += AEI18n.html('<span class="provider-model-label">模型</span>');
      html += '<select class="provider-model-select" data-action="model-select" onclick="event.stopPropagation()">';
      var models = provider.models || [];
      var selectedModelEntry = null;
      if (!models.length) {
        html += AEI18n.html('<option value="">暂无模型</option>');
      } else {
        for (var mi = 0; mi < models.length; mi++) {
          var m = models[mi];
          if (m.id === modelId) selectedModelEntry = m;
          html += '<option value="' + _escapeAttr(m.id) + '"' + (m.id === modelId ? ' selected' : '') + '>' + _escapeHtml(m.id) + '</option>';
        }
      }
      html += '</select>';
      // 模型能力徽章统一包进容器：provider-card-model 是 3 列 grid（标签|下拉|徽章），
      // 若直接添加多个徽章子元素会被 grid 自动换行到新行，故用一个容器承载全部徽章。
      html += '<span class="provider-model-badges">';
      if (isVisionProxy) {
        // 视觉代理 == 该平台当前选中的模型（跟随式），下拉选中即代理模型，状态直观
        html += '<span class="provider-badge vision-proxy" title="' + _escapeAttr(AEI18n.t('视觉代理模型：{model}（非视觉主模型遇到图片/读图时，后台用此模型转文字描述）', { model: modelId || '' })) + '">' + AEI18n.t('视觉代理') + '</span>';
      } else {
        if (selectedModelEntry && selectedModelEntry.capabilities && selectedModelEntry.capabilities.vision === true) {
          html += AEI18n.html('<span class="provider-badge vision" title="支持视觉">视觉</span>');
        }
        if (selectedModelEntry && selectedModelEntry.capabilities && selectedModelEntry.capabilities.video === true) {
          html += AEI18n.html('<span class="provider-badge video" title="支持视频">视频</span>');
        }
      }
      html += '</span>';
      html += '</div>';
      html += '</div>';
      html += '<div class="provider-row-actions">';
      html += '<button class="btn compact secondary" data-action="activate">' + (isActiveProvider ? AEI18n.t('使用中') : AEI18n.t('启用')) + '</button>';
      html += AEI18n.html('<button class="btn compact secondary" data-action="test">测试</button>');
      if (!provider.builtin) html += AEI18n.html('<button class="btn compact danger" data-action="delete">删除</button>');
      html += '</div>';
      html += '</div>';
      return html;
    }

    function refreshProviderList() {
      var listEl = document.getElementById('providerList');
      if (!listEl) return;
      var state = _ctrl.getState();
      var html = '';
      for (var i = 0; i < state.providers.length; i++) html += _renderProviderRow(state.providers[i], state);
      if (state.providers.length === 0) html = AEI18n.html('<div class="provider-list-empty">暂无平台配置</div>');
      listEl.innerHTML = html;
    }

    function _findProvider(providerId) {
      var providers = _ctrl.getState().providers || [];
      for (var i = 0; i < providers.length; i++) {
        if (providers[i].id === providerId) return providers[i];
      }
      return null;
    }

    function _confirmAction(title, message) {
      if (global && typeof global.showConfirm === 'function') {
        return global.showConfirm(title, message, 'confirm');
      }
      _showPanelStatus(AEI18n.t('确认弹窗不可用，无法继续操作'), 'error');
      return Promise.resolve(false);
    }

    function _formatError(err) {
      return err && err.message ? err.message : String(err);
    }

    function _renderEditorModels(provider) {
      var listEl = document.getElementById('providerEditModels');
      if (!listEl) return;
      if (!provider) {
        listEl.innerHTML = AEI18n.html('<div class="editor-model-empty">保存平台后可管理模型列表</div>');
        return;
      }
      var models = provider.models || [];
      if (!models.length) {
        listEl.innerHTML = AEI18n.html('<div class="editor-model-empty">暂无模型，可通过“获取模型”导入</div>');
        return;
      }
      var html = '';
      for (var i = 0; i < models.length; i++) {
        var model = models[i];
        html += '<div class="editor-model-row" data-model-id="' + _escapeAttr(model.id) + '">';
        html += '<div class="editor-model-main">';
        html += '<div class="editor-model-name">' + _escapeHtml(model.id) + '</div>';
        html += '</div>';
        html += AEI18n.html('<button class="btn compact secondary" data-action="edit-capabilities" title="编辑该模型支持的功能（视觉/视频等）">编辑</button>');
        html += AEI18n.html('<button class="btn compact danger" data-action="delete-model">删除</button>');
        html += '</div>';
      }
      listEl.innerHTML = html;
    }

    function _saveCardModel(providerId, modelId) {
      if (!modelId) { _showPanelStatus(AEI18n.t('该平台没有可选模型'), 'error'); return; }
      var provider = _findProvider(providerId);
      var _stateNow = _ctrl.getState();
      var _gsNow = (_stateNow && _stateNow.globalSettings) || {};
      var _isVisionProxy = _gsNow.visionProviderId === providerId;
      // 新选中模型是否支持视觉
      var _newModelHasVision = false;
      if (provider && provider.models) {
        for (var _mi = 0; _mi < provider.models.length; _mi++) {
          if (provider.models[_mi].id === modelId && provider.models[_mi].capabilities && provider.models[_mi].capabilities.vision === true) {
            _newModelHasVision = true;
            break;
          }
        }
      }
      // 视觉代理平台必然不是主模型平台（主模型平台当前选中模型即主模型，无法被设为视觉代理），
      // 因此此处切换模型只会落在「跟随」或「取消」两种结果，无需考虑主模型。

      _ctrl.setProviderSelectedModel(providerId, modelId).then(function (result) {
        if (!result || result.ok === false) {
          _showPanelStatus((result && result.error) || AEI18n.t('模型选择保存失败'), 'error');
          refreshProviderList();
          return;
        }
        // 视觉代理跟随：视觉代理 == 视觉代理平台当前选中的视觉模型。
        // 切到非视觉模型时取消视觉代理，保证下拉里选中的模型即视觉代理，状态直观。
        if (_isVisionProxy) {
          if (!_newModelHasVision) {
            _ctrl.setDefaultVisionModel('', '').then(function (vr) {
              _showPanelStatus((vr && vr.ok) ? AEI18n.t('当前模型不支持视觉，已取消视觉代理') : ((vr && vr.error) || AEI18n.t('取消视觉代理失败')), (vr && vr.ok) ? 'warn' : 'error');
              refreshProviderList();
            });
          } else {
            _ctrl.setDefaultVisionModel(providerId, modelId).then(function (vr) {
              _showPanelStatus((vr && vr.ok) ? AEI18n.t('视觉代理已跟随切换至 {model}', { model: modelId }) : ((vr && vr.error) || AEI18n.t('视觉代理更新失败')), (vr && vr.ok) ? 'success' : 'error');
              refreshProviderList();
            });
          }
          return;
        }
        if (provider && _isActiveProvider(provider, _ctrl.getState())) {
          _ctrl.setDefaultModel(providerId, modelId).then(function (defaultResult) {
            var _dmsg = defaultResult.ok ? AEI18n.t('当前模型已更新') : (defaultResult.error || AEI18n.t('模型选择保存失败'));
            if (defaultResult.ok && defaultResult.visionProxyCleared) _dmsg += AEI18n.t('（该模型原为视觉代理，已自动取消）');
            _showPanelStatus(_dmsg, defaultResult.ok ? 'success' : 'error');
            refreshProviderList();
          }).catch(function (err) {
            _showPanelStatus(AEI18n.t('模型选择保存失败: {error}', { error: _formatError(err) }), 'error');
            refreshProviderList();
          });
        } else {
          _showPanelStatus(AEI18n.t('模型选择已保存'), 'success');
          refreshProviderList();
        }
      }).catch(function (err) {
        _showPanelStatus(AEI18n.t('模型选择保存失败: {error}', { error: _formatError(err) }), 'error');
        refreshProviderList();
      });
    }

    function _bindProviderRowEvents() {
      var listEl = document.getElementById('providerList');
      if (!listEl) return;
      listEl.addEventListener('change', function (evt) {
        var select = evt.target.closest('.provider-model-select');
        if (!select) return;
        var row = select.closest('.provider-row-card');
        if (!row) return;
        var providerId = row.getAttribute('data-provider-id');
        _ctrl.selectProvider(providerId);
        _saveCardModel(providerId, select.value);
      });
      listEl.addEventListener('click', function (evt) {
        var row = evt.target.closest('.provider-row-card');
        if (!row) return;
        // customSelect（shared/customSelect.js）把原生 <select> 整个替换成
        // .cs-wrap > button.cs-btn 自定义下拉，原生 select 已 display:none，
        // elementFromPoint 取不到它。点下拉触发器时只开下拉，不进编辑面板。
        if (evt.target.closest('.cs-wrap')) return;
        var providerId = row.getAttribute('data-provider-id');
        var actionEl = evt.target.closest('[data-action]');
        var action = actionEl ? actionEl.getAttribute('data-action') : '';
        _ctrl.selectProvider(providerId);
        if (!action) {
          // 点卡片任意非控件区域均进入编辑。下拉由上方 .cs-wrap 拦截。
          showProviderEditor(providerId);
          return;
        }
        evt.stopPropagation();
        if (action === 'model-select') {
          return;
        }
        if (action === 'activate') {
          var provider = _ctrl.getState().selectedProvider;
          var modelId = _getDisplayModelId(provider, _ctrl.getState());
          if (!modelId) { _showPanelStatus(AEI18n.t('该平台没有可用模型，请先编辑平台或获取模型'), 'error'); return; }
          _ctrl.setDefaultModel(providerId, modelId).then(function (result) {
            _showPanelStatus(result.ok ? AEI18n.t('已启用 {name} / {model}', { name: AEI18n.t(provider.label || provider.id), model: modelId }) : (result.error || AEI18n.t('启用失败')), result.ok ? 'success' : 'error');
            refreshProviderList();
          });
        } else if (action === 'test') {
          _showPanelStatus(AEI18n.t('正在测试模型...'), 'info');
          _ctrl.testModel(providerId).then(function (result) {
            _showPanelStatus(result.ok ? AEI18n.t('测试成功: {model}', { model: result.model || '' }) : (result.error || AEI18n.t('测试失败')), result.ok ? 'success' : 'error');
          });
        } else if (action === 'delete') {
          _deleteProvider(providerId);
        }
      });
      listEl.addEventListener('contextmenu', function (evt) {
        var row = evt.target.closest('.provider-row-card');
        if (!row) return;
        evt.preventDefault();
        var providerId = row.getAttribute('data-provider-id');
        _ctrl.selectProvider(providerId);
        _showProviderContextMenu(providerId, evt.clientX, evt.clientY);
      });
      listEl.addEventListener('scroll', _hideContextMenu, true);
    }

    function _deleteProvider(providerId) {
      var provider = _findProvider(providerId);
      if (!provider) { _showPanelStatus(AEI18n.t('平台不存在，无法删除'), 'error'); return; }
      if (provider.builtin) { _showPanelStatus(AEI18n.t('内置平台不能删除'), 'error'); return; }
      _confirmAction(AEI18n.t('删除平台'), AEI18n.t('确定要删除平台「{name}」吗？', { name: (provider.label || provider.id) })).then(function (ok) {
        if (!ok) return;
        _ctrl.deleteCustomProvider(providerId).then(function (result) {
          _showPanelStatus(result.ok ? AEI18n.t('平台已删除') : (result.error || AEI18n.t('删除失败')), result.ok ? 'success' : 'error');
          refreshProviderList();
        });
      });
    }

    // ── 右键菜单 ──
    var _contextMenuEl = null;

    function _hideContextMenu() {
      if (_contextMenuEl && _contextMenuEl.parentNode) {
        _contextMenuEl.parentNode.removeChild(_contextMenuEl);
      }
      _contextMenuEl = null;
    }

    function _onDocMouseDown(evt) {
      if (_contextMenuEl && !_contextMenuEl.contains(evt.target)) _hideContextMenu();
    }

    function _onKeyDownForMenu(evt) {
      if (evt.key !== 'Escape') return;
      // 优先级：右键菜单 > 发现抽屉 > 编辑弹窗
      if (_contextMenuEl) { _hideContextMenu(); return; }
      var drawer = document.getElementById('discoveryDrawer');
      if (drawer && drawer.classList.contains('open')) { _closeDiscoveryDrawer(); return; }
      var modal = document.getElementById('providerEditorModal');
      if (modal && modal.classList.contains('open')) { hideProviderEditor(); return; }
    }

    function _handleContextAction(action, providerId) {
      _ctrl.selectProvider(providerId);
      if (action === 'activate') {
        var provider = _ctrl.getState().selectedProvider;
        var modelId = _getDisplayModelId(provider, _ctrl.getState());
        if (!modelId) { _showPanelStatus(AEI18n.t('该平台没有可用模型，请先编辑或获取模型'), 'error'); return; }
        _ctrl.setDefaultModel(providerId, modelId).then(function (result) {
          var _amsg = result.ok ? AEI18n.t('已启用 {name} / {model}', { name: AEI18n.t(provider.label || provider.id), model: modelId }) : (result.error || AEI18n.t('启用失败'));
          if (result.ok && result.visionProxyCleared) _amsg += AEI18n.t('（该模型原为视觉代理，已自动取消）');
          _showPanelStatus(_amsg, result.ok ? 'success' : 'error');
          refreshProviderList();
        });
      } else if (action === 'edit') {
        showProviderEditor(providerId);
      } else if (action === 'duplicate') {
        _showPanelStatus(AEI18n.t('正在复制平台...'), 'info');
        _ctrl.duplicateProvider(providerId).then(function (result) {
          if (result && result.ok) {
            var np = _findProvider(result.newId);
            _showPanelStatus(AEI18n.t('已复制为「{name}」', { name: AEI18n.t(np ? (np.label || np.id) : result.newId) }), 'success');
            refreshProviderList();
          } else {
            _showPanelStatus((result && result.error) || AEI18n.t('复制失败'), 'error');
          }
        });
      } else if (action === 'test') {
        _showPanelStatus(AEI18n.t('正在测试模型...'), 'info');
        _ctrl.testModel(providerId).then(function (result) {
          _showPanelStatus(result.ok ? AEI18n.t('测试成功: {model}', { model: result.model || '' }) : (result.error || AEI18n.t('测试失败')), result.ok ? 'success' : 'error');
        });
      } else if (action === 'vision-proxy') {
        // 视觉代理：非视觉主模型遇到图片/读图时，后台用该平台当前选中的模型转文字描述。
        // 已在视觉代理状态 → 取消；否则 → 用平台当前选中模型设置（要求模型已标记支持视觉）。
        var _vpState = _ctrl.getState();
        var _vpGlobals = _vpState.globalSettings || {};
        var _isProxy = _vpGlobals.visionProviderId === providerId;
        if (_isProxy) {
          _ctrl.setDefaultVisionModel('', '').then(function (result) {
            _showPanelStatus((result && result.ok) ? AEI18n.t('已取消视觉代理') : ((result && result.error) || AEI18n.t('取消失败')), (result && result.ok) ? 'success' : 'error');
            refreshProviderList();
          });
          return;
        }
        var _vp = _vpState.selectedProvider;
        var _vpModelId = _getDisplayModelId(_vp, _vpState);
        if (!_vpModelId) { _showPanelStatus(AEI18n.t('该平台没有可用模型，无法设为视觉代理'), 'error'); return; }
        _showPanelStatus(AEI18n.t('正在设置视觉代理...'), 'info');
        _ctrl.setDefaultVisionModel(providerId, _vpModelId).then(function (result) {
          if (result && result.ok) {
            _showPanelStatus(AEI18n.t('已设为视觉代理：{name} / {model}', { name: AEI18n.t(_vp ? (_vp.label || _vp.id) : providerId), model: _vpModelId }), 'success');
          } else {
            _showPanelStatus((result && result.error) || AEI18n.t('设置失败'), 'error');
          }
          refreshProviderList();
        });
      } else if (action === 'delete') {
        _deleteProvider(providerId);
      }
    }

    function _showProviderContextMenu(providerId, clientX, clientY) {
      _hideContextMenu();
      var provider = _findProvider(providerId);
      if (!provider) return;
      var state = _ctrl.getState();
      var isActive = _isActiveProvider(provider, state);
      var isVisionProxy = (state.globalSettings || {}).visionProviderId === providerId;
      var hasModel = !!(provider.models && provider.models.length);
      // 当前选中模型是否支持视觉：设为视觉代理的前提
      var _curModelHasVision = false;
      var _curModelId = _getDisplayModelId(provider, state);
      if (_curModelId && provider.models) {
        for (var _cmi = 0; _cmi < provider.models.length; _cmi++) {
          if (provider.models[_cmi].id === _curModelId && provider.models[_cmi].capabilities && provider.models[_cmi].capabilities.vision === true) {
            _curModelHasVision = true;
            break;
          }
        }
      }
      // 主模型（当前默认模型）不能被设为视觉代理：视觉代理仅用于补充主模型视觉能力
      var _gs2 = state.globalSettings || {};
      var _defaultProviderId = _gs2.defaultProviderId || _gs2.defaultPlatform || '';
      var _defaultModelId = _gs2.defaultModelId || _gs2.defaultModel || '';
      var _isMainModelEntry = !!(_curModelId && _defaultProviderId === provider.id && _curModelId === _defaultModelId);
      var _visionProxyDisabled = !hasModel || (!isVisionProxy && (!_curModelHasVision || _isMainModelEntry));
      var _visionProxyLabel = isVisionProxy ? AEI18n.t('取消视觉代理') : AEI18n.t('设为视觉代理');
      if (!isVisionProxy && hasModel && !_curModelHasVision) _visionProxyLabel += AEI18n.t('（当前模型不支持视觉）');
      else if (!isVisionProxy && hasModel && _isMainModelEntry) _visionProxyLabel += AEI18n.t('（主模型不可设为视觉代理）');

      var items = [
        { key: 'activate', label: isActive ? AEI18n.t('已设为默认') : AEI18n.t('设为默认平台'), disabled: isActive || !hasModel },
        { key: 'edit', label: AEI18n.t('编辑') },
        { key: 'duplicate', label: AEI18n.t('复制') },
        { key: 'test', label: AEI18n.t('测试连接') },
        { key: 'divider' },
        // 视觉代理：用该平台当前选中的模型作为视觉代理（要求模型已标记支持视觉）
        { key: 'vision-proxy', label: _visionProxyLabel, disabled: _visionProxyDisabled, accent: true },
        { key: 'divider' },
        { key: 'delete', label: AEI18n.t('删除'), disabled: provider.builtin, danger: true }
      ];

      var menu = document.createElement('div');
      menu.className = 'provider-context-menu';
      for (var i = 0; i < items.length; i++) {
        var it = items[i];
        if (it.key === 'divider') {
          var divider = document.createElement('div');
          divider.className = 'provider-context-divider';
          menu.appendChild(divider);
          continue;
        }
        var item = document.createElement('div');
        item.className = 'provider-context-item' + (it.disabled ? ' disabled' : '') + (it.danger ? ' danger' : '') + (it.accent ? ' accent' : '');
        item.textContent = it.label;
        (function (key, pid, disabled) {
          item.addEventListener('click', function (e) {
            e.stopPropagation();
            _hideContextMenu();
            if (disabled) return;
            _handleContextAction(key, pid);
          });
        })(it.key, providerId, it.disabled);
        menu.appendChild(item);
      }

      document.body.appendChild(menu);
      _contextMenuEl = menu;

      // 定位，避免溢出视口
      var rect = menu.getBoundingClientRect();
      var x = clientX;
      var y = clientY;
      if (x + rect.width > window.innerWidth - 4) x = window.innerWidth - rect.width - 4;
      if (y + rect.height > window.innerHeight - 4) y = window.innerHeight - rect.height - 4;
      menu.style.left = x + 'px';
      menu.style.top = y + 'px';
    }

    // 模型能力项定义：key 对应 capabilities 字段，label 为展示名，hint 为开关提示，ico 为行内图标。
    var _CAP_ICO_VISION = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    var _CAP_ICO_VIDEO = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="13" height="12" rx="2"/><path d="M15 11l6-3v8l-6-3z"/></svg>';
    var _CAP_ICO_JSON = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H7a2 2 0 0 0-2 2v3a2 2 0 0 1-2 2 2 2 0 0 1 2 2v3a2 2 0 0 0 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-3a2 2 0 0 1 2-2 2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/></svg>';
    var _CAP_ICO_TOOLS = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/></svg>';
    var _CAP_ICO_STREAM = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="12 6 15 10 12 14 15 18"/><polyline points="7 6 10 10 7 14 10 18"/></svg>';
    var _CAP_ICO_THINKING = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>';
    var _CAPABILITY_DEFS = [
      { key: 'vision', label: AEI18n.t('视觉'), get hint() { return AEI18n.t('支持图片 / 截图理解'); }, ico: _CAP_ICO_VISION, tone: 'blue' },
      { key: 'video', label: AEI18n.t('视频'), get hint() { return AEI18n.t('支持视频理解（read_video）'); }, ico: _CAP_ICO_VIDEO, tone: 'purple' },
      { key: 'jsonMode', label: AEI18n.t('JSON 模式'), get hint() { return AEI18n.t('支持结构化 JSON 输出'); }, ico: _CAP_ICO_JSON, tone: 'green' },
      { key: 'tools', label: AEI18n.t('工具调用'), get hint() { return AEI18n.t('支持函数 / 工具调用'); }, ico: _CAP_ICO_TOOLS, tone: 'orange' },
      { key: 'stream', label: AEI18n.t('流式'), get hint() { return AEI18n.t('支持流式输出'); }, ico: _CAP_ICO_STREAM, tone: 'cyan' },
      // 思考是「本地声明」而非请求开关：只驱动多轮工具调用的思考回传保护
      // （避免 thinking+tools 的 400），是否真的开启思考由供应商配置决定。
      // hint 控制在单行可容纳的长度；完整说明放 more（行 title 悬停可见）。
      { key: 'thinking', label: AEI18n.t('思考'),
        get hint() { return AEI18n.t('开启后发送本平台的思考参数'); },
        get more() { return AEI18n.t('。关闭时不发送思考参数，也不发送思考等级（reasoning_effort）；开启后在下方留空即用本平台预设参数，也可手填 JSON 覆盖'); },
        ico: _CAP_ICO_THINKING, tone: 'violet' }
    ];

    // 能力行 title：行内 hint 保持单行可容纳，更长的说明放 def.more 只在悬停时展示
    function _capRowTitle(def) {
      if (!def) return '';
      return def.more ? (def.hint + def.more) : def.hint;
    }

    function _openModelCapabilitiesEditor(modelId) {
      var providerId = _editingProviderId;
      if (!providerId || !modelId) return;
      _editingCapabilitiesModelId = modelId;
      var provider = _ctrl.getState().selectedProvider;
      var nameEl = document.getElementById('editModelCapabilitiesName');
      if (nameEl) {
        nameEl.innerHTML = ''
          + AEI18n.html('<span class="capabilities-model-ico">模型</span>')
          + '<span class="capabilities-model-info">'
          + '<span class="capabilities-model-id">' + _escapeHtml(modelId) + '</span>'
          + '<span class="capabilities-model-provider">' + _escapeHtml(AEI18n.t(provider ? (provider.label || provider.id) : providerId)) + '</span>'
          + '</span>';
      }
      _renderCapabilitiesEditor(provider, modelId);
      var modal = document.getElementById('editModelCapabilitiesModal');
      if (modal) {
        // 与 providerEditorModal 一致：移到 body 直接子元素，避免祖先 stacking context 干扰 backdrop-filter
        if (modal.parentNode !== document.body) document.body.appendChild(modal);
        var cancelBtn = document.getElementById('editModelCapabilitiesCancel');
        if (cancelBtn) cancelBtn.onclick = _closeCapabilitiesEditor;
        var closeBtn = document.getElementById('editModelCapabilitiesClose');
        if (closeBtn) closeBtn.onclick = _closeCapabilitiesEditor;
        modal.classList.remove('hidden');
        modal.classList.add('open');
      }
    }

    // 思考模式：模型级「意图」（off/on/custom）→ 请求时由 protocolAdapters 的映射表
    // 翻译成各家原生参数（thinking.type / enable_thinking / reasoning …，可因模型而异）。
    function _thinkingAdapters() {
      return (global.AE_LLM && global.AE_LLM.protocolAdapters) || null;
    }

    // 思考只有一个开关（上方能力行的「思考」），自定义参数框是它的附属输入：
    // 留空 = 发送本平台预设思考参数（文案由适配层给：把将发的 JSON 摊开，强度跟随型平台
    // 还会逐档说明「思考等级会变成什么值」）；填了 = 原样并入请求体（覆盖预设）。
    // 文案是纯函数（protocolAdapters.thinkingHintFor），那份真相源与请求构建同一套映射表。
    function _thinkingHintText(provider, modelId, custom) {
      var ad = _thinkingAdapters();
      if (ad && typeof ad.thinkingHintFor === 'function') {
        return ad.thinkingHintFor(provider, modelId, custom);
      }
      return AEI18n.t('留空则按本平台预设发送原生思考参数。');
    }

    function _isThinkingOn(modelEntry) {
      var t = (modelEntry && modelEntry.thinking) || {};
      var cap = (modelEntry && modelEntry.capabilities) || {};
      return (t.mode && t.mode !== 'off') || cap.thinking === true;
    }

    function _renderThinkingBox(provider, modelId, modelEntry) {
      var t = (modelEntry && modelEntry.thinking) || { mode: 'off', custom: {} };
      var on = _isThinkingOn(modelEntry);
      var custom = (t.mode === 'custom' && t.custom && Object.keys(t.custom).length) ? t.custom : {};
      var html = '<div class="capabilities-thinking-custom' + (on ? '' : ' hidden') + '" id="editModelThinkingCustomRow">';
      html += AEI18n.html('<textarea id="editModelThinkingCustom" spellcheck="false" placeholder=\'手填 JSON 覆盖上方的预设，如 {"thinking":{"type":"disabled"}} / {"enable_thinking":true}\'>')
        + _escapeHtml(Object.keys(custom).length ? JSON.stringify(custom, null, 2) : '') + '</textarea>';
      html += '<div class="capabilities-thinking-hint" id="editModelThinkingHint">'
        + _escapeHtml(_thinkingHintText(provider, modelId, custom)) + '</div>';
      html += '</div>';
      return html;
    }

    function _bindThinkingBlock(provider, modelId) {
      var box = document.getElementById('editModelThinkingCustomRow');
      var area = document.getElementById('editModelThinkingCustom');
      var hint = document.getElementById('editModelThinkingHint');
      // 「思考」能力开关 = 思考功能的总开关（在能力列表里）
      var toggle = document.querySelector('#editModelCapabilitiesList .switch-input[data-cap-key="thinking"]');
      var updateBox = function () {
        var on = toggle ? toggle.checked : false;
        if (box) box.classList.toggle('hidden', !on);
      };
      var updateHint = function () {
        if (!hint) return;
        var raw = area && area.value ? area.value.trim() : '';
        var parsed = {};
        if (raw) {
          try { parsed = JSON.parse(raw); } catch (_) { parsed = null; }
        }
        hint.textContent = parsed === null
          ? AEI18n.t('自定义参数不是合法 JSON，保存会被拒绝。')
          : _thinkingHintText(provider, modelId, parsed || {});
      };
      if (toggle) toggle.addEventListener('change', updateBox);
      if (area) area.addEventListener('input', updateHint);
    }

    function _renderCapabilitiesEditor(provider, modelId) {
      var listEl = document.getElementById('editModelCapabilitiesList');
      if (!listEl) return;
      var cap = {};
      var modelEntry = null;
      if (provider && provider.models) {
        for (var i = 0; i < provider.models.length; i++) {
          if (provider.models[i].id === modelId) {
            modelEntry = provider.models[i];
            cap = provider.models[i].capabilities || {};
            break;
          }
        }
      }
      var html = '';
      for (var j = 0; j < _CAPABILITY_DEFS.length; j++) {
        var def = _CAPABILITY_DEFS[j];
        // 思考开关的态来自「思考意图」（presets 标 mode:'on' 的 36 个模型没有 capabilities.thinking
        // 位，但确实开着）——两者取或，保证开关显示与实际行为一致
        var on = (def.key === 'thinking') ? _isThinkingOn(modelEntry) : !!cap[def.key];
        html += '<label class="capabilities-edit-row" title="' + _escapeHtml(_capRowTitle(def)) + '">'
          + '<span class="capabilities-edit-ico tone-' + def.tone + '">' + def.ico + '</span>'
          + '<span class="capabilities-edit-info">'
          + '<span class="capabilities-edit-name">' + _escapeHtml(def.label) + '</span>'
          + '<span class="capabilities-edit-hint">' + _escapeHtml(def.hint) + '</span>'
          + '</span>'
          + '<span class="toggle-wrap">'
          + '<input type="checkbox" class="switch-input" data-cap-key="' + def.key + '"' + (on ? ' checked' : '') + '>'
          + '<span class="switch-slider" aria-hidden="true"></span>'
          + '</span>'
          + '</label>';
        // 思考开关打开时，紧跟其后露出自定义参数框（留空 = 用本平台预设）
        if (def.key === 'thinking') html += _renderThinkingBox(provider, modelId, modelEntry);
      }
      listEl.innerHTML = html;
      _bindThinkingBlock(provider, modelId);
    }

    // 新增模型弹窗内的模型能力复选框（默认勾选工具调用与流式，与旧默认一致）
    function _renderAddModelCapabilities() {
      var listEl = document.getElementById('addModelCapabilitiesList');
      if (!listEl) return;
      var html = '';
      for (var j = 0; j < _CAPABILITY_DEFS.length; j++) {
        var def = _CAPABILITY_DEFS[j];
        // 新建模型默认开思考（与 _submitAddModel 里写入的 thinking:{mode:'on'} 一致）
        var on = (def.key === 'tools' || def.key === 'stream' || def.key === 'thinking');
        html += '<label class="capabilities-edit-row" title="' + _escapeHtml(_capRowTitle(def)) + '">'
          + '<span class="capabilities-edit-ico tone-' + def.tone + '">' + def.ico + '</span>'
          + '<span class="capabilities-edit-info">'
          + '<span class="capabilities-edit-name">' + _escapeHtml(def.label) + '</span>'
          + '<span class="capabilities-edit-hint">' + _escapeHtml(def.hint) + '</span>'
          + '</span>'
          + '<span class="toggle-wrap">'
          + '<input type="checkbox" class="switch-input" data-cap-key="' + def.key + '"' + (on ? ' checked' : '') + '>'
          + '<span class="switch-slider" aria-hidden="true"></span>'
          + '</span>'
          + '</label>';
      }
      listEl.innerHTML = html;
    }

    function _saveCapabilitiesEditor() {
      var providerId = _editingProviderId;
      var modelId = _editingCapabilitiesModelId;
      if (!providerId || !modelId) return;
      var patches = {};
      var inputs = document.querySelectorAll('#editModelCapabilitiesList .switch-input');
      for (var i = 0; i < inputs.length; i++) {
        var key = inputs[i].getAttribute('data-cap-key');
        if (key) patches[key] = inputs[i].checked;
      }
      // 思考：单一开关（能力行的「思考」）+ 可选自定义参数框 → 意图（off / on / custom）。
      // 留空 = 用本平台预设参数；填了 = 原样并入请求体。非法 JSON 本地拒绝，不产生半保存。
      var thinkingPatch = null;
      var thinkingToggle = document.querySelector('#editModelCapabilitiesList .switch-input[data-cap-key="thinking"]');
      if (thinkingToggle) {
        var customEl = document.getElementById('editModelThinkingCustom');
        var raw = customEl && customEl.value ? customEl.value.trim() : '';
        if (!thinkingToggle.checked) {
          thinkingPatch = { mode: 'off', custom: {} };
        } else if (!raw) {
          thinkingPatch = { mode: 'on', custom: {} };
        } else {
          var parsed = null;
          try { parsed = JSON.parse(raw); } catch (e) {
            _showPanelStatus(AEI18n.t('自定义思考参数不是合法 JSON：{error}', { error: _formatError(e) }), 'error');
            return;
          }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            _showPanelStatus(AEI18n.t('自定义思考参数必须是 JSON 对象（如 {"thinking":{"type":"disabled"}}）'), 'error');
            return;
          }
          thinkingPatch = { mode: 'custom', custom: parsed };
        }
      }
      var done = function () {
        _showPanelStatus(AEI18n.t('模型能力已保存'), 'success');
        _closeCapabilitiesEditor();
        _ctrl.selectProvider(providerId);
        refreshProviderList();
        _renderEditorModels(_ctrl.getState().selectedProvider);
      };
      _ctrl.setModelCapabilities(providerId, modelId, patches).then(function (result) {
        if (!result || result.ok === false) {
          _showPanelStatus((result && result.error) || AEI18n.t('更新模型能力失败'), 'error');
          return null;
        }
        if (!thinkingPatch) return true;
        return _ctrl.setModelThinking(providerId, modelId, thinkingPatch).then(function (r2) {
          if (!r2 || r2.ok === false) {
            _showPanelStatus((r2 && r2.error) || AEI18n.t('更新思考模式失败'), 'error');
            return null;
          }
          return true;
        });
      }).then(function (ok) {
        if (ok) done();
      }).catch(function (err) {
        _showPanelStatus(AEI18n.t('更新模型能力失败: {error}', { error: _formatError(err) }), 'error');
      });
    }

    function _closeCapabilitiesEditor() {
      var modal = document.getElementById('editModelCapabilitiesModal');
      if (modal) { modal.classList.remove('open'); modal.classList.add('hidden'); }
      _editingCapabilitiesModelId = null;
    }

    function _deleteProviderModel(modelId) {
      var providerId = _editingProviderId;
      if (!providerId || !modelId) return;
      var provider = _ctrl.getState().selectedProvider;
      var providerName = provider ? (provider.label || provider.id) : providerId;
      _confirmAction(AEI18n.t('删除模型'), AEI18n.t('确定要从「{provider}」删除模型「{model}」吗？', { provider: providerName, model: modelId })).then(function (ok) {
        if (!ok) return;
        _ctrl.deleteModel(providerId, modelId).then(function (result) {
          if (!result || result.ok === false) {
            _showPanelStatus((result && result.error) || AEI18n.t('删除模型失败'), 'error');
          } else {
            _showPanelStatus(AEI18n.t('模型已删除'), 'success');
          }
          _ctrl.selectProvider(providerId);
          refreshProviderList();
          _renderEditorModels(_ctrl.getState().selectedProvider);
        }).catch(function (err) {
          _showPanelStatus(AEI18n.t('删除模型失败: {error}', { error: _formatError(err) }), 'error');
          _ctrl.selectProvider(providerId);
          refreshProviderList();
          _renderEditorModels(_ctrl.getState().selectedProvider);
        });
      });
    }

    // 新增平台模式下，从编辑弹窗表单读取临时 provider 对象
    // 返回 null 表示校验失败（已通过 toast 提示）
    function _buildTempProviderFromEditorForm() {
      var idInput = document.getElementById('providerEditId');
      var labelInput = document.getElementById('providerEditLabel');
      var protocolSelect = document.getElementById('providerEditProtocol');
      var baseUrlInput = document.getElementById('providerEditBaseUrl');
      var apiKeyInput = document.getElementById('providerEditApiKey');
      var id = idInput ? idInput.value.trim() : '';
      var label = labelInput ? labelInput.value.trim() : '';
      var protocol = protocolSelect ? protocolSelect.value : 'openai-compatible';
      var baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
      // API Key 允许为空：本地无鉴权平台（Ollama/LM Studio 等）也要能发现模型
      var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';

      if (!baseUrl) { _showPanelStatus(AEI18n.t('请先填写 Base URL'), 'error'); return null; }

      // 根据 protocol 选择 auth 类型（Anthropic 用 x-api-key，其他走 Bearer）
      var authConfig;
      if (protocol === 'anthropic-messages') {
        authConfig = { type: 'x-api-key', header: 'x-api-key' };
      } else {
        authConfig = { type: 'bearer', header: 'Authorization' };
      }

      // 构造一个临时 provider 对象，关键字段供 _makeHeaders 和 _joinUrl 使用
      // modelDiscovery.endpoint 继承选中平台预设的真实端点（如 kimi -> /v1/models），
      // 避免硬编码 /models 导致与平台实际模型列表接口不符（如 kimi 请求 /models 会 404）。
      // enabled===false 的预设（表单创建平台的归一化结果）不继承，用默认可用配置
      var _discoveryPreset = null;
      var _editingProvider = null;
      if (_editingProviderId) {
        var selP = _ctrl.getState().selectedProvider;
        if (selP) {
          _editingProvider = selP;
          if (selP.modelDiscovery && selP.modelDiscovery.enabled !== false) _discoveryPreset = selP.modelDiscovery;
        }
      }
      // 请求头面同样继承编辑中平台的声明：makeHeaders 只认 provider 上的字段，临时投影
      // 漏掉 sessionIdHeader / headers 时「获取模型」对需要它们的平台必然失败
      //（如 OpenCode Go 强制 x-opencode-session）。自定义头以表单当前文本为准，与保存
      // 路径共用 parseHeaderLines；解析失败按表单校验失败处理（提示后返回 null），
      // 不拿平台已存声明顶替——否则用户改坏的头会被无声忽略。
      var _headersInput = document.getElementById('providerEditHeaders');
      var _parsedHeaders = _headersInput ? parseHeaderLines(_headersInput.value) : { ok: true, headers: {} };
      if (!_parsedHeaders.ok) {
        _showPanelStatus(_parsedHeaders.error, 'error');
        return null;
      }
      var tempProvider = {
        id: id || '__temp__',
        label: label || AEI18n.t('新平台'),
        protocol: protocol,
        baseUrl: baseUrl,
        endpoint: readEndpointValue(),
        apiKeyField: 'customApiKey-' + (id || '__temp__'),
        builtin: false,
        auth: authConfig,
        sessionIdHeader: (_editingProvider && _editingProvider.sessionIdHeader) || null,
        headers: _parsedHeaders.headers,
        modelDiscovery: _discoveryPreset || { enabled: true, endpoint: '/models' }
      };
      // 缓存 apiKey 到临时对象，供 discoveryFetchBtn 读取
      tempProvider._tempApiKey = apiKey;
      return tempProvider;
    }

    function _openDiscoveryDrawer(providerId, tempProvider) {
      _discoveryProviderId = providerId || null;
      _discoveryTempProvider = tempProvider || null;
      _discoveredModels = [];
      var drawerTitleText;
      if (tempProvider) {
        // 新增平台模式：使用临时配置，不调用 selectProvider
        drawerTitleText = AEI18n.t('获取模型 - {name}', { name: tempProvider.label || tempProvider.id || AEI18n.t('新平台') });
      } else {
        _ctrl.selectProvider(_discoveryProviderId);
        var provider = _ctrl.getState().selectedProvider;
        drawerTitleText = AEI18n.t('获取模型 - {name}', { name: provider ? (provider.label || provider.id) : _discoveryProviderId });
      }
      var title = document.querySelector('#discoveryDrawer .drawer-title');
      if (title) title.textContent = drawerTitleText;
      var search = document.getElementById('discoverySearchInput');
      if (search) search.value = '';
      var mask = document.getElementById('discoveryDrawerMask');
      var drawer = document.getElementById('discoveryDrawer');
      if (mask) mask.classList.remove('hidden');
      if (drawer) drawer.classList.remove('hidden');
      requestAnimationFrame(function () {
        if (mask) mask.classList.add('open');
        if (drawer) drawer.classList.add('open');
      });
      _renderDiscoveryResults();
    }

    function _closeDiscoveryDrawer() {
      _discoveryProviderId = null;
      _discoveryTempProvider = null;
      _discoveredModels = [];
      var mask = document.getElementById('discoveryDrawerMask');
      var drawer = document.getElementById('discoveryDrawer');
      if (mask) mask.classList.remove('open');
      if (drawer) drawer.classList.remove('open');
      setTimeout(function () {
        if (mask && !mask.classList.contains('open')) mask.classList.add('hidden');
        if (drawer && !drawer.classList.contains('open')) drawer.classList.add('hidden');
      }, 220);
    }

    // 新增模型：不依赖 discovery 接口，手动填写模型 ID 与能力后保存。
    // 解决部分平台（如火山方舟）无法通过「获取模型」拉取列表（接口 401）的问题。
    function _openAddModelModal() {
      var modal = document.getElementById('addModelModal');
      if (!modal) return;
      // 与 providerEditorModal 一致：移到 body 直接子元素，规避 stacking context 干扰 backdrop-filter
      if (modal.parentNode !== document.body) document.body.appendChild(modal);
      var idInput = document.getElementById('addModelId');
      if (idInput) idInput.value = '';
      var nameInput = document.getElementById('addModelName');
      if (nameInput) nameInput.value = '';
      _renderAddModelCapabilities();
      modal.classList.remove('hidden');
      modal.classList.add('open');
      if (idInput) setTimeout(function () { idInput.focus(); }, 30);
    }

    function _closeAddModelModal() {
      var modal = document.getElementById('addModelModal');
      if (modal) { modal.classList.remove('open'); modal.classList.add('hidden'); }
    }

    function _submitAddModel() {
      var idEl = document.getElementById('addModelId');
      var id = idEl ? idEl.value.trim() : '';
      if (!id) { _showPanelStatus(AEI18n.t('请输入模型 ID'), 'error'); return; }
      var nameEl = document.getElementById('addModelName');
      var name = nameEl ? nameEl.value.trim() : '';
      // 读取模型能力复选框（默认仅勾选工具调用与流式）
      var capabilities = {};
      var capInputs = document.querySelectorAll('#addModelCapabilitiesList .switch-input');
      for (var ci = 0; ci < capInputs.length; ci++) {
        var capKey = capInputs[ci].getAttribute('data-cap-key');
        if (capKey) capabilities[capKey] = capInputs[ci].checked;
      }
      var model = {
        id: id,
        label: name || id,
        capabilities: capabilities,
        // 新建模型默认「思考模式=开启」：映射表命中的平台会带原生思考
        // 参数、未收录平台不发参数但保留思考等级（reasoning_effort）。可在「编辑模型能力」里改。
        thinking: { mode: 'on' }
      };
      _resolveAddModelProviderId().then(function (providerId) {
        if (!providerId) return;
        _showPanelStatus(AEI18n.t('正在保存模型: {model}', { model: id }), 'info');
        _ctrl.addOrUpdateModel(providerId, model).then(function (result) {
          if (result && result.ok) {
            _showPanelStatus((result.action === 'updated' ? AEI18n.t('已更新模型 {model}', { model: id }) : AEI18n.t('已新增模型 {model}', { model: id })), 'success');
            _closeAddModelModal();
            // 刷新编辑弹窗内的模型列表与平台卡片
            _ctrl.selectProvider(providerId);
            refreshProviderList();
            _renderEditorModels(_ctrl.getState().selectedProvider);
          } else {
            _showPanelStatus((result && result.error) || AEI18n.t('保存失败'), 'error');
          }
        });
      });
    }

    function _renderDiscoveryResults() {
      var resultsEl = document.getElementById('discoveryDrawerResults');
      var statusEl = document.getElementById('discoveryDrawerStatus');
      var searchInput = document.getElementById('discoverySearchInput');
      if (!resultsEl) return;
      var q = searchInput ? searchInput.value.toLowerCase() : '';
      var filtered = [];
      for (var i = 0; i < _discoveredModels.length; i++) {
        var m = _discoveredModels[i];
        var text = String(m.id || '').toLowerCase();
        if (!q || text.indexOf(q) >= 0) filtered.push(m);
      }
      var shown = filtered.slice(0, 100);
      // 已存在于平台模型列表中的模型标记为「已导入」：行内按钮置灰禁用
      // （以平台已保存模型为准，重新拉取/搜索后状态依然正确）
      var importedIds = {};
      var _prov = _ctrl.getState().selectedProvider;
      var _provModels = (_prov && _prov.models) || [];
      for (var pi = 0; pi < _provModels.length; pi++) {
        if (_provModels[pi] && _provModels[pi].id) importedIds[_provModels[pi].id] = true;
      }
      var html = '';
      if (statusEl) statusEl.textContent = filtered.length ? (AEI18n.t('发现 ') + filtered.length + AEI18n.t(' 个模型，显示前 ') + shown.length + AEI18n.t(' 个；勾选后批量导入，或点击行内「导入」')) : '';
      for (var j = 0; j < shown.length; j++) {
        var imported = !!importedIds[shown[j].id];
        html += '<label class="discovery-row" data-model-id="' + _escapeAttr(shown[j].id) + '">';
        html += '<input type="checkbox" class="discovery-model-check">';
        html += '<span class="discovery-checkmark"></span>';
        html += '<span class="discovery-row-main"><span class="discovery-row-name">' + _escapeHtml(shown[j].id) + '</span></span>';
        html += '<button type="button" class="btn compact discovery-import-one' + (imported ? ' imported' : '') + '"' + (imported ? ' disabled' : '') + ' title="' + (imported ? AEI18n.t('已导入该平台') : AEI18n.t('直接导入该模型')) + '">' + (imported ? AEI18n.t('已导入') : AEI18n.t('导入')) + '</button>';
        html += '</label>';
      }
      if (!html && _discoveredModels.length) html = AEI18n.html('<div class="drawer-empty">无匹配模型</div>');
      if (!html) html = AEI18n.html('<div class="drawer-empty">点击“获取/刷新”拉取模型列表</div>');
      resultsEl.innerHTML = html;
    }

    // 新增模型（编辑弹窗内）时解析目标 providerId：
    // 编辑已有平台直接用 _editingProviderId；新增平台模式先静默保存表单拿到 providerId。
    function _resolveAddModelProviderId() {
      if (_editingProviderId) return Promise.resolve(_editingProviderId);
      if (_discoveryProviderId) return Promise.resolve(_discoveryProviderId);
      return _saveProviderEditor({ keepOpen: true, silent: true }).then(function (saveResult) {
        if (!saveResult.ok) {
          _showPanelStatus(AEI18n.t('新增模型需要先保存平台：{error}', { error: saveResult.error || AEI18n.t('保存失败') }), 'error');
          return null;
        }
        if (!_editingProviderId) _editingProviderId = saveResult.providerId;
        return saveResult.providerId;
      });
    }

    // 新增平台模式需先静默保存平台拿到 providerId；已保存模式直接复用现有 providerId。
    // 批量导入与行内单模型导入共用此解析逻辑。
    function _resolveDiscoveryProviderId() {
      if (_discoveryTempProvider && !_discoveryProviderId) {
        return _saveProviderEditor({ keepOpen: true, silent: true }).then(function (saveResult) {
          if (!saveResult.ok) {
            _showPanelStatus(AEI18n.t('导入需要先保存平台：{error}', { error: saveResult.error || AEI18n.t('保存失败') }), 'error');
            return null;
          }
          _discoveryProviderId = saveResult.providerId;
          _discoveryTempProvider = null; // 切换到已保存模式
          // 静默保存已被触发（新增平台模式），弹 toast 让用户知道平台已写入配置
          _showPanelStatus(AEI18n.t('平台已自动保存：{name}', { name: _discoveryProviderId || '' }), 'success');
          return saveResult.providerId;
        });
      }
      return Promise.resolve(_discoveryProviderId);
    }

    // 导入完成后同步刷新平台卡片列表与编辑弹窗内的模型列表；
    // 新增平台模式下把编辑器切换到已保存平台模式，保证删除模型/视觉标记等操作可用
    function _finishDiscoveryImport(providerId) {
      if (!providerId) return;
      _ctrl.selectProvider(providerId);
      if (!_editingProviderId) _editingProviderId = providerId;
      refreshProviderList();
      _renderEditorModels(_ctrl.getState().selectedProvider);
    }

    function _importSelectedDiscoveryModels() {
      var rows = document.querySelectorAll('#discoveryDrawerResults .discovery-row');
      var selected = [];
      for (var i = 0; i < rows.length; i++) {
        var check = rows[i].querySelector('.discovery-model-check');
        if (check && check.checked) {
          var modelId = rows[i].getAttribute('data-model-id');
          for (var j = 0; j < _discoveredModels.length; j++) {
            if (_discoveredModels[j].id === modelId) { selected.push(_discoveredModels[j]); break; }
          }
        }
      }
      if (!selected.length) { _showPanelStatus(AEI18n.t('请先勾选要导入的模型'), 'error'); return; }

      _resolveDiscoveryProviderId().then(function (providerId) {
        if (!providerId) return;
        var addedCount = 0;
        var updatedCount = 0;
        var importedIds = [];
        var chain = Promise.resolve({ ok: true });
        for (var k = 0; k < selected.length; k++) {
          (function (model) {
            chain = chain.then(function (prev) {
              if (!prev.ok) return prev;
              return _ctrl.importDiscoveredModel(providerId, model).then(function (r) {
                if (r && r.ok) {
                  if (r.action === 'updated') updatedCount++;
                  else addedCount++;
                  importedIds.push(model.id);
                }
                return r;
              });
            });
          })(selected[k]);
        }
        return chain.then(function (result) {
          if (result && result.ok) {
            var msg;
            if (updatedCount > 0 && addedCount > 0) {
              msg = AEI18n.t('已导入 {total} 个模型（新增 {added} 个，更新 {updated} 个已存在）', { total: selected.length, added: addedCount, updated: updatedCount });
            } else if (updatedCount > 0) {
              msg = AEI18n.t('已更新 {updated} 个已存在模型（无新增）', { updated: updatedCount });
            } else {
              msg = AEI18n.t('已导入 {added} 个新模型', { added: addedCount });
            }
            _showPanelStatus(msg, 'success');
          } else {
            _showPanelStatus((result && result.error) || AEI18n.t('导入失败'), 'error');
          }
          if (importedIds.length) _markDiscoveryRowsImported(importedIds);
          _finishDiscoveryImport(providerId);
        });
      });
    }

    // 行内「导入」按钮：单模型直接导入，无需勾选
    function _importSingleDiscoveryModel(modelId) {
      var model = null;
      for (var i = 0; i < _discoveredModels.length; i++) {
        if (_discoveredModels[i].id === modelId) { model = _discoveredModels[i]; break; }
      }
      if (!model) return;
      _resolveDiscoveryProviderId().then(function (providerId) {
        if (!providerId) return;
        _ctrl.importDiscoveredModel(providerId, model).then(function (r) {
          if (r && r.ok) {
            var isUpdate = r.action === 'updated';
            _showPanelStatus(isUpdate ? AEI18n.t('已更新 {model}（平台已存在）', { model: model.id }) : AEI18n.t('已导入 {model}', { model: model.id }), 'success');
            _markDiscoveryRowsImported([model.id]);
          } else {
            _showPanelStatus((r && r.error) || AEI18n.t('导入失败'), 'error');
          }
          _finishDiscoveryImport(providerId);
        });
      });
    }

    // 导入成功后就地更新行内按钮为「已导入」态：
    // 不整表重渲染，避免丢失已勾选项与滚动位置
    function _markDiscoveryRowsImported(modelIds) {
      if (!modelIds || !modelIds.length) return;
      var lookup = {};
      for (var mi = 0; mi < modelIds.length; mi++) lookup[modelIds[mi]] = true;
      var rows = document.querySelectorAll('#discoveryDrawerResults .discovery-row');
      for (var ri = 0; ri < rows.length; ri++) {
        if (!lookup[rows[ri].getAttribute('data-model-id')]) continue;
        var btn = rows[ri].querySelector('.discovery-import-one');
        if (!btn) continue;
        btn.disabled = true;
        btn.classList.add('imported');
        btn.textContent = AEI18n.t('已导入');
        btn.title = AEI18n.t('已导入该平台');
      }
    }

    function showProviderEditor(providerId) {
      _editingProviderId = providerId || null;
      if (providerId) _ctrl.selectProvider(providerId);
      else _ctrl.selectProvider(null);

      var modal = document.getElementById('providerEditorModal');
      var titleEl = document.getElementById('providerEditorTitle');
      var idInput = document.getElementById('providerEditId');
      var labelInput = document.getElementById('providerEditLabel');
      var protocolSelect = document.getElementById('providerEditProtocol');
      var baseUrlInput = document.getElementById('providerEditBaseUrl');
      var apiKeyInput = document.getElementById('providerEditApiKey');
      var apiKeyToggle = document.getElementById('providerEditApiKeyToggle');
      var discoverBtn = document.getElementById('providerEditorDiscover');

      // 每次打开弹窗都重置为密文显示，避免上次切换留下的明文状态残留
      if (apiKeyInput) apiKeyInput.type = 'password';
      if (apiKeyToggle) apiKeyToggle.classList.remove('visible');

      var provider = providerId ? _ctrl.getState().selectedProvider : null;
      if (titleEl) titleEl.textContent = providerId ? AEI18n.t('编辑平台') : AEI18n.t('新建自定义平台');
      var endpointRow = document.getElementById('providerEditEndpointRow');
      var uploadUrlInput = document.getElementById('providerEditUploadUrl');
      var useUploadInput = document.getElementById('providerEditUseUpload');
      var headersInput = document.getElementById('providerEditHeaders');
      var advancedSection = document.querySelector('#providerEditorModal .advanced-options');
      if (provider) {
        // 内置平台的端点由预设固定，不暴露给用户修改/查看
        if (endpointRow) endpointRow.style.display = provider.builtin ? 'none' : '';
        if (advancedSection) advancedSection.style.display = provider.builtin ? 'none' : '';
        if (uploadUrlInput) uploadUrlInput.value = (provider.videoInput && provider.videoInput.upload && provider.videoInput.upload.endpoint) || '';
        if (useUploadInput) useUploadInput.checked = !(provider.videoInput && provider.videoInput.inline === true);
        if (headersInput) headersInput.value = formatHeaderLines(provider.headers);
        if (idInput) {
          idInput.value = provider.id;
          idInput.disabled = !!provider.builtin;
          idInput.style.opacity = provider.builtin ? '0.6' : '1';
        }
        if (labelInput) { labelInput.value = provider.label || ''; labelInput.disabled = !!provider.builtin; }
        if (protocolSelect) { protocolSelect.value = provider.protocol || 'openai-compatible'; protocolSelect.disabled = !!provider.builtin; if (window.refreshCustomSelect) window.refreshCustomSelect(protocolSelect); }
        if (baseUrlInput) { baseUrlInput.value = provider.baseUrl || ''; baseUrlInput.disabled = !!provider.builtin; }
        syncEndpointEditor(provider.endpoint || '', !!provider.builtin);
        if (apiKeyInput) apiKeyInput.value = _ctrl.getProviderApiKey(provider.id) || '';
      } else {
        if (endpointRow) endpointRow.style.display = '';
        if (advancedSection) advancedSection.style.display = '';
        if (uploadUrlInput) uploadUrlInput.value = '';
        if (useUploadInput) useUploadInput.checked = true;
        if (headersInput) headersInput.value = '';
        if (idInput) { idInput.value = ''; idInput.disabled = false; idInput.style.opacity = '1'; }
        if (labelInput) { labelInput.value = ''; labelInput.disabled = false; }
        if (protocolSelect) { protocolSelect.value = 'openai-compatible'; protocolSelect.disabled = false; if (window.refreshCustomSelect) window.refreshCustomSelect(protocolSelect); }
        if (baseUrlInput) { baseUrlInput.value = ''; baseUrlInput.disabled = false; }
        syncEndpointEditor('', false);
        if (apiKeyInput) apiKeyInput.value = '';
      }
      _renderEditorModels(provider);
      if (discoverBtn) {
        // 新增平台模式（provider === null）与自定义平台始终显示：
        // 自定义平台协议均为 openai 兼容/anthropic，都有 /models 发现端点；
        // 表单创建的平台 modelDiscovery 被归一化为 {enabled:false}，按预设判断会永久隐藏入口
        if (!provider || !provider.builtin) {
          discoverBtn.style.display = 'inline-flex';
        } else {
          var discovery = provider.modelDiscovery || {};
          discoverBtn.style.display = (discovery.enabled !== false) ? 'inline-flex' : 'none';
        }
      }
      if (modal) {
        // 移至 body 直接子元素：CEP/CEF 中 #providerEditorModal 嵌套在 #modelManagerBody ->
        // #moduleView -> .app 祖先链内，祖先的 position:relative + z-index:1 创建 stacking context，
        // 干扰 position:fixed 元素的 backdrop-filter 背景采样（导致模糊约 1 秒后消失）。
        // 移到 body 后无 stacking context 干扰，backdrop-filter 稳定生效。
        if (modal.parentNode !== document.body) {
          document.body.appendChild(modal);
        }
        // 每次打开都用 onclick 绑定，避免依赖 render 时机（元素移到 body 后事件仍跟随元素）
        var cancelBtn = document.getElementById('providerEditorCancel');
        if (cancelBtn) cancelBtn.onclick = hideProviderEditor;
        var closeBtn = document.getElementById('providerEditorClose');
        if (closeBtn) closeBtn.onclick = hideProviderEditor;
        // 上传方式开关控制上传文件 URL 输入框的显示：关闭（内联）时隐藏
        if (useUploadInput) {
          useUploadInput.onchange = syncUploadUrlVisibility;
          syncUploadUrlVisibility();
        }
        modal.classList.remove('hidden');
        modal.classList.add('open');
      }
    }

    function hideProviderEditor() {
      var modal = document.getElementById('providerEditorModal');
      if (modal) { modal.classList.remove('open'); modal.classList.add('hidden'); }
      _editingProviderId = null;
    }

    function _saveProviderEditor(opts) {
      opts = opts || {};
      var keepOpen = !!opts.keepOpen;
      var silent = !!opts.silent;
      var idInput = document.getElementById('providerEditId');
      var labelInput = document.getElementById('providerEditLabel');
      var protocolSelect = document.getElementById('providerEditProtocol');
      var baseUrlInput = document.getElementById('providerEditBaseUrl');
      var apiKeyInput = document.getElementById('providerEditApiKey');
      var id = idInput ? idInput.value.trim() : '';
      var label = labelInput ? labelInput.value.trim() : '';
      var protocol = protocolSelect ? protocolSelect.value : 'openai-compatible';
      var baseUrl = baseUrlInput ? baseUrlInput.value.trim() : '';
      var endpoint = readEndpointValue();
      var uploadUrlInput = document.getElementById('providerEditUploadUrl');
      var uploadUrl = uploadUrlInput ? uploadUrlInput.value.trim() : '';
      var useUploadInput = document.getElementById('providerEditUseUpload');
      var useUpload = useUploadInput ? useUploadInput.checked : true;
      var headersInput = document.getElementById('providerEditHeaders');
      var apiKey = apiKeyInput ? apiKeyInput.value.trim() : '';

      return new Promise(function (resolve) {
        if (!id) { if (!silent) _showPanelStatus(AEI18n.t('请输入平台 ID'), 'error'); resolve({ ok: false, error: AEI18n.t('请输入平台 ID') }); return; }
        if (!label) { if (!silent) _showPanelStatus(AEI18n.t('请输入显示名称'), 'error'); resolve({ ok: false, error: AEI18n.t('请输入显示名称') }); return; }
        if (!baseUrl) { if (!silent) _showPanelStatus(AEI18n.t('请输入 Base URL'), 'error'); resolve({ ok: false, error: AEI18n.t('请输入 Base URL') }); return; }

        // 自定义请求头：解析失败/名称非法/占用应用托管头时整单拒绝保存，
        // 避免"界面显示已配、实际被静默丢弃或覆盖"的错配（与 baseUrl/endpoint 前置校验同风格）
        var parsedHeaders = headersInput ? parseHeaderLines(headersInput.value) : { ok: true, headers: {} };
        if (!parsedHeaders.ok) {
          if (!silent) _showPanelStatus(parsedHeaders.error, 'error');
          resolve({ ok: false, error: parsedHeaders.error });
          return;
        }

        // 公网 http:// 会以明文传输 API Key：阻止保存并弹窗警告。
        // 本机/内网地址（127.0.0.1、localhost、10.x、172.16-31.x、192.168.x、.local/.lan/.internal）不受影响。
        var _registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        if (_registry && typeof _registry.isPublicHttpUrl === 'function' && _registry.isPublicHttpUrl(baseUrl)) {
          var insecureMsg = AEI18n.t('公网 http:// 会以明文传输 API Key，已拒绝保存；本机/内网地址（如 127.0.0.1、192.168.x.x）不受影响');
          if (global.AENotice && typeof global.AENotice.show === 'function') {
            global.AENotice.show({
              id: 'provider-insecure-public-http',
              icon: '⚠️',
              title: AEI18n.t('已阻止保存不安全的平台地址'),
              message: insecureMsg + '：<code>' + baseUrl + '</code>',
              tone: 'warn'
            });
          } else if (!silent) {
            _showPanelStatus(insecureMsg, 'error');
          }
          resolve({ ok: false, error: insecureMsg });
          return;
        }

        var selected = _editingProviderId ? _ctrl.getState().selectedProvider : null;
        if (selected && selected.builtin) {
          _ctrl.saveProviderApiKey(selected.id, apiKey).then(function (keyResult) {
            if (!silent) _showPanelStatus(keyResult.ok ? AEI18n.t('平台设置已保存') : (keyResult.error || AEI18n.t('保存失败')), keyResult.ok ? 'success' : 'error');
            if (keyResult.ok) {
              if (!keepOpen) hideProviderEditor();
              refreshProviderList();
              resolve({ ok: true, providerId: selected.id });
            } else {
              resolve({ ok: false, error: keyResult.error || AEI18n.t('保存失败') });
            }
          }).catch(function (e) {
            var emsg = (e && e.message) ? e.message : String(e);
            if (!silent) _showPanelStatus(AEI18n.t('API Key 保存失败: {error}', { error: emsg }), 'error');
            resolve({ ok: false, error: emsg });
          });
          return;
        }

        // API Key 存储字段：沿用平台已有唯一字段（如 duplicateProvider 生成的副本字段）；
        // 共用 'customApiKey' 槽位的存量平台统一迁到 'customApiKey-{id}' 唯一槽位，
        // 避免多个自定义平台读写同一全局设置字段导致保存 Key 时互相覆盖。
        // Key 值经编辑器回填自动迁移：打开弹窗时 apiKeyInput 已预读旧字段值，保存时写入新字段。
        // 迁移落盘经 updateCustomProvider 时同步搬移旧槽位 Key 值并清理孤儿槽位
        //（比照 controller 的 renameCustomProvider/deleteCustomProvider 孤儿清理），旧共享
        // 槽位的敏感凭据不再残留。
        // 重命名（_editingProviderId !== id）时 selected 是重命名前的快照，其 apiKeyField 是旧
        // 字段名不能沿用——renameCustomProvider 已迁移到 'customApiKey-{新id}' 并搬移 Key 值。
        var apiKeyField = (selected && _editingProviderId === id && selected.apiKeyField && selected.apiKeyField !== 'customApiKey')
          ? selected.apiKeyField
          : ('customApiKey-' + id);
        // auth 跟随协议（与 _buildTempProviderFromEditorForm / protocolAdapters 对齐）：
        // 保存的 provider 缺 auth 字段时，anthropic-messages 平台会错误走 Bearer 头
        var authConfig = (protocol === 'anthropic-messages')
          ? { type: 'x-api-key', header: 'x-api-key' }
          : { type: 'bearer', header: 'Authorization' };
        // 模型发现配置：沿用已有配置；无配置的存量条目（归一化后为 {enabled:false}）补默认值，
        // 否则表单创建的平台保存后「获取模型」按钮消失、编辑态发现请求也会被拒
        var discoveryConfig = (selected && selected.modelDiscovery && (selected.modelDiscovery.enabled !== false || selected.modelDiscovery.endpoint))
          ? selected.modelDiscovery
          : { enabled: true, endpoint: '/models' };
        var provider = {
          id: id,
          label: label,
          protocol: protocol,
          baseUrl: baseUrl,
          endpoint: endpoint,
          apiKeyField: apiKeyField,
          auth: authConfig,
          headers: parsedHeaders.headers,
          modelDiscovery: discoveryConfig,
          videoInput: buildVideoInput(selected, uploadUrl, useUpload),
          models: selected && selected.models ? JSON.parse(JSON.stringify(selected.models)) : [],
          selectedModelId: selected && selected.selectedModelId ? selected.selectedModelId : '',
          builtin: false
        };
        var originalId = _editingProviderId;
        var renamePromise = (selected && originalId && originalId !== id)
          ? _ctrl.renameCustomProvider(originalId, id)
          : Promise.resolve({ ok: true });
        renamePromise.then(function (renameResult) {
          if (!renameResult || renameResult.ok === false) {
            if (!silent) _showPanelStatus((renameResult && renameResult.error) || AEI18n.t('重命名失败'), 'error');
            resolve({ ok: false, error: (renameResult && renameResult.error) || AEI18n.t('重命名失败') });
            return;
          }
          if (selected && originalId && originalId !== id) {
            _editingProviderId = id;
          }
          var promise = selected ? _ctrl.updateCustomProvider(id, provider) : _ctrl.addCustomProvider(provider);
          promise.then(function (result) {
            if (!result.ok) { if (!silent) _showPanelStatus(result.error || AEI18n.t('保存失败'), 'error'); resolve({ ok: false, error: result.error || AEI18n.t('保存失败') }); return; }
            _ctrl.saveProviderApiKey(id, apiKey).then(function (keyResult) {
              if (!silent) _showPanelStatus(keyResult.ok ? AEI18n.t('平台已保存') : (keyResult.error || AEI18n.t('平台已保存，但 API Key 保存失败')), keyResult.ok ? 'success' : 'error');
              if (keyResult.ok) {
                _ctrl.selectProvider(id);
                if (!keepOpen) hideProviderEditor();
                refreshProviderList();
                resolve({ ok: true, providerId: id });
              } else {
                resolve({ ok: false, error: keyResult.error || AEI18n.t('API Key 保存失败') });
              }
            }).catch(function (e) {
              var emsg = (e && e.message) ? e.message : String(e);
              if (!silent) _showPanelStatus(AEI18n.t('API Key 保存失败: {error}', { error: emsg }), 'error');
              resolve({ ok: false, error: emsg });
            });
          }).catch(function (e) {
            var emsg = (e && e.message) ? e.message : String(e);
            if (!silent) _showPanelStatus(AEI18n.t('保存失败: {error}', { error: emsg }), 'error');
            resolve({ ok: false, error: emsg });
          });
        }).catch(function (e) {
          var emsg = (e && e.message) ? e.message : String(e);
          if (!silent) _showPanelStatus(AEI18n.t('重命名失败: {error}', { error: emsg }), 'error');
          resolve({ ok: false, error: emsg });
        });
      });
    }

    function _bindEvents() {
      var addBtn = document.getElementById('addProviderBtn');
      if (addBtn) addBtn.addEventListener('click', function () { showProviderEditor(null); });
      // 右键菜单全局关闭：点菜单外/ESC/滚动均关闭
      document.addEventListener('mousedown', _onDocMouseDown, true);
      window.addEventListener('keydown', _onKeyDownForMenu);

      var saveBtn = document.getElementById('providerEditorSave');
      if (saveBtn) saveBtn.addEventListener('click', _saveProviderEditor);
      // API Key 明文/密文切换（眼睛按钮）
      var apiKeyToggle = document.getElementById('providerEditApiKeyToggle');
      var apiKeyInputEl = document.getElementById('providerEditApiKey');
      if (apiKeyToggle && apiKeyInputEl) {
        apiKeyToggle.addEventListener('click', function () {
          var isHidden = apiKeyInputEl.type === 'password';
          apiKeyInputEl.type = isHidden ? 'text' : 'password';
          apiKeyToggle.classList.toggle('visible', !isHidden);
        });
      }
      // 平台 ID 输入时自动转小写并过滤非法字符（大写不再报错，而是直接规范化）
      var idField = document.getElementById('providerEditId');
      if (idField) {
        idField.addEventListener('input', function () {
          var raw = idField.value;
          var clean = String(raw).toLowerCase().replace(/[^a-z0-9_-]/g, '');
          if (clean !== raw) idField.value = clean;
        });
      }
      var editorDiscoverBtn = document.getElementById('providerEditorDiscover');
      if (editorDiscoverBtn) editorDiscoverBtn.addEventListener('click', function () {
        // 统一从弹窗表单读取最新配置（编辑/新增模式都走临时配置路径）
        // 这样用户修改 Base URL/API Key 后无需先保存即可获取模型
        var tempProvider = _buildTempProviderFromEditorForm();
        if (!tempProvider) return; // 校验失败，已提示
        // 编辑模式保留 providerId 以便导入时直接使用（不需要先保存）
        // 新增模式 providerId 为 null，导入时会先静默保存
        var providerId = _editingProviderId || null;
        _openDiscoveryDrawer(providerId, tempProvider);
      });
      var providerList = document.getElementById('providerList');
      if (providerList) _bindProviderRowEvents();
      var discoveryCloseBtn = document.getElementById('discoveryDrawerClose');
      if (discoveryCloseBtn) discoveryCloseBtn.addEventListener('click', _closeDiscoveryDrawer);
      var discoveryMask = document.getElementById('discoveryDrawerMask');
      if (discoveryMask) discoveryMask.addEventListener('click', _closeDiscoveryDrawer);
      var discoveryImportBtn = document.getElementById('discoveryImportSelectedBtn');
      if (discoveryImportBtn) discoveryImportBtn.addEventListener('click', _importSelectedDiscoveryModels);
      // 新增模型：手动填写模型 ID/能力的入口（编辑平台弹窗底部按钮，无需依赖 discovery 接口）
      var providerEditorAddModel = document.getElementById('providerEditorAddModel');
      if (providerEditorAddModel) providerEditorAddModel.addEventListener('click', _openAddModelModal);
      var addModelSave = document.getElementById('addModelSave');
      if (addModelSave) addModelSave.addEventListener('click', _submitAddModel);
      var addModelCancel = document.getElementById('addModelCancel');
      if (addModelCancel) addModelCancel.addEventListener('click', _closeAddModelModal);
      var addModelClose = document.getElementById('addModelClose');
      if (addModelClose) addModelClose.addEventListener('click', _closeAddModelModal);
      var addModelMask = document.getElementById('addModelModal');
      if (addModelMask) addModelMask.addEventListener('mousedown', function (e) {
        if (e.target === addModelMask) _closeAddModelModal();
      });
      var addModelIdInput = document.getElementById('addModelId');
      if (addModelIdInput) addModelIdInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); _submitAddModel(); }
      });
      // 编辑模型能力弹窗：保存/关闭/遮罩点击
      var capSave = document.getElementById('editModelCapabilitiesSave');
      if (capSave) capSave.addEventListener('click', _saveCapabilitiesEditor);
      var capClose = document.getElementById('editModelCapabilitiesClose');
      if (capClose) capClose.addEventListener('click', _closeCapabilitiesEditor);
      var capCancel = document.getElementById('editModelCapabilitiesCancel');
      if (capCancel) capCancel.addEventListener('click', _closeCapabilitiesEditor);
      var capModal = document.getElementById('editModelCapabilitiesModal');
      if (capModal) capModal.addEventListener('mousedown', function (e) {
        if (e.target === capModal) _closeCapabilitiesEditor();
      });
      // 行内「导入」按钮（按钮嵌在 label 行内，阻止冒泡避免误触勾选）
      var discoveryResultsEl = document.getElementById('discoveryDrawerResults');
      if (discoveryResultsEl) discoveryResultsEl.addEventListener('click', function (evt) {
        var importBtn = evt.target.closest('.discovery-import-one');
        if (!importBtn) return;
        evt.preventDefault();
        evt.stopPropagation();
        var row = importBtn.closest('.discovery-row');
        if (!row) return;
        _importSingleDiscoveryModel(row.getAttribute('data-model-id'));
      });
      var editorModels = document.getElementById('providerEditModels');
      if (editorModels) editorModels.addEventListener('click', function (evt) {
        var row = evt.target.closest('.editor-model-row');
        if (!row) return;
        var modelId = row.getAttribute('data-model-id');
        var deleteBtn = evt.target.closest('[data-action="delete-model"]');
        if (deleteBtn) {
          _deleteProviderModel(modelId);
          return;
        }
        var editBtn = evt.target.closest('[data-action="edit-capabilities"]');
        if (editBtn) {
          _openModelCapabilitiesEditor(modelId);
        }
      });
      var discoveryFetchBtn = document.getElementById('discoveryFetchBtn');
      if (discoveryFetchBtn) discoveryFetchBtn.addEventListener('click', function () {
        var statusEl = document.getElementById('discoveryDrawerStatus');
        if (statusEl) statusEl.textContent = AEI18n.t('正在获取模型列表...');
        if (_discoveryTempProvider) {
          // 新增/编辑平台模式：用临时配置调用 discoverModelsFromProvider。
          // 优先读取表单最新值（用户可能在 drawer 打开后又改了表单）；表单校验失败
          //（Base URL 缺失 / 请求头格式错）时已由构建函数提示，这里直接放弃本次请求。
          var freshTemp = _buildTempProviderFromEditorForm();
          if (!freshTemp) {
            if (statusEl) statusEl.textContent = '';
            return;
          }
          var tempProvider = freshTemp;
          var tempApiKey = freshTemp._tempApiKey;
          _ctrl.discoverModelsFromProvider(tempProvider, tempApiKey).then(function (result) {
            // stale 请求结果（期间已发起更新的发现）直接跳过——不覆盖
            // _discoveredModels、不弹旧错误，交由最新请求收尾
            if (result.stale) return;
            if (result.ok) _discoveredModels = result.models || [];
            else _showPanelStatus(result.error || AEI18n.t('获取模型失败'), 'error');
            _renderDiscoveryResults();
          });
          return;
        }
        if (!_discoveryProviderId) return;
        // API Key 允许为空：本地无鉴权平台（Ollama/LM Studio 等）也要能发现模型
        var apiKey = _ctrl.getProviderApiKey(_discoveryProviderId);
        _ctrl.discoverModels(_discoveryProviderId, apiKey).then(function (result) {
          // 同上——stale 请求结果不进入 UI
          if (result.stale) return;
          if (result.ok) _discoveredModels = result.models || [];
          else _showPanelStatus(result.error || AEI18n.t('获取模型失败'), 'error');
          _renderDiscoveryResults();
        });
      });
      var discoverySearchInput = document.getElementById('discoverySearchInput');
      if (discoverySearchInput) discoverySearchInput.addEventListener('input', function () {
        if (_searchTimer) clearTimeout(_searchTimer);
        _searchTimer = setTimeout(_renderDiscoveryResults, 120);
      });
      var protocolSelect = document.getElementById('providerEditProtocol');
      if (protocolSelect) {
        var protocols = [
          { value: 'openai-compatible', label: AEI18n.t('OpenAI 兼容') },
          { value: 'anthropic-messages', label: 'Anthropic Messages' }
        ];
        for (var i = 0; i < protocols.length; i++) {
          var opt = document.createElement('option');
          opt.value = protocols[i].value;
          opt.textContent = protocols[i].label;
          protocolSelect.appendChild(opt);
        }
        // doc：协议切换时，若端点仍是"按协议默认"（空）或停留在**另一协议**的
        // 默认端点上（协议来回切换后被物化的残留值），自动改写为当前协议默认端点；
        // 用户自定义值/__custom__ 一律不动（避免覆盖手填端点）。
        // 默认端点表与发送侧 llmChannel/controller 的「无 endpoint 时回退」同源
        protocolSelect.addEventListener('change', function () {
          var endpointSelect = document.getElementById('providerEditEndpoint');
          if (!endpointSelect || endpointSelect.disabled) return;
          var protocol = protocolSelect.value;
          var currentDefault = _protocolDefaultEndpoint(protocol);
          var otherDefault = _protocolDefaultEndpoint(
            protocol === 'anthropic-messages' ? 'openai-compatible' : 'anthropic-messages');
          var cur = endpointSelect.value;
          if (cur === '' || cur === otherDefault) {
            endpointSelect.value = currentDefault;
            if (window.refreshCustomSelect) window.refreshCustomSelect(endpointSelect);
          }
        });
      }
      // 端点下拉：选择"自定义…"时显示自定义输入框
      var endpointSelect = document.getElementById('providerEditEndpoint');
      if (endpointSelect) {
        endpointSelect.addEventListener('change', function () {
          var customInput = document.getElementById('providerEditEndpointCustom');
          if (!customInput) return;
          if (endpointSelect.value === '__custom__') {
            customInput.style.display = '';
            customInput.focus();
          } else {
            customInput.style.display = 'none';
          }
        });
      }
      // 端点路径下拉：预设常见端点 + 自定义。选择"自定义…"时显示自定义输入框。
      populateEndpointSelect();
      // 高级选项：默认折叠，点击标题展开/收起
      var advancedTitle = document.getElementById('advancedOptionsTitle');
      if (advancedTitle) {
        advancedTitle.addEventListener('click', function () {
          var content = document.getElementById('advancedOptionsContent');
          if (!content) return;
          var isHidden = content.classList.toggle('hidden');
          advancedTitle.classList.toggle('collapsed', isHidden);
        });
      }
    }

    var _ENDPOINT_PRESETS = [
      '', // 按协议默认（openai-compatible→/chat/completions，anthropic→/v1/messages）
      '/chat/completions',
      '/v1/messages',
      '/responses'
    ];
    // doc：协议 → 默认端点（与 llmChannel.js / controller.js 发送侧
    // 「provider.endpoint || defaultEndpoint」同一张真相表；改这里不会自动改发送侧，
    // 但两边取值必须一致）。仅用于「按协议默认/残留物化值」的 UI 归一
    var _PROTOCOL_DEFAULT_ENDPOINTS = {
      'openai-compatible': '/chat/completions',
      'anthropic-messages': '/v1/messages'
    };
    function _protocolDefaultEndpoint(protocol) {
      return _PROTOCOL_DEFAULT_ENDPOINTS[protocol] || _PROTOCOL_DEFAULT_ENDPOINTS['openai-compatible'];
    }
    var _ENDPOINT_PRESET_LABELS = {
      '': AEI18n.t('按协议默认'),
      '/chat/completions': AEI18n.t('/chat/completions（OpenAI 兼容）'),
      '/v1/messages': '/v1/messages（Anthropic）',
      '/responses': '/responses（Responses/Agent）'
    };

    function populateEndpointSelect() {
      var select = document.getElementById('providerEditEndpoint');
      if (!select) return;
      select.innerHTML = '';
      for (var i = 0; i < _ENDPOINT_PRESETS.length; i++) {
        var v = _ENDPOINT_PRESETS[i];
        var opt = document.createElement('option');
        opt.value = v;
        opt.textContent = _ENDPOINT_PRESET_LABELS[v];
        select.appendChild(opt);
      }
      var customOpt = document.createElement('option');
      customOpt.value = '__custom__';
      customOpt.textContent = AEI18n.t('自定义…');
      select.appendChild(customOpt);
    }

    // 根据 provider.endpoint 同步下拉框与自定义输入框的显示/选中状态
    function syncEndpointEditor(endpoint, disabled) {
      var select = document.getElementById('providerEditEndpoint');
      var customInput = document.getElementById('providerEditEndpointCustom');
      if (!select) return;
      var isPreset = endpoint === '' || _ENDPOINT_PRESETS.indexOf(endpoint) >= 0;
      if (isPreset) {
        select.value = endpoint || '';
        if (customInput) { customInput.value = ''; customInput.style.display = 'none'; }
      } else {
        select.value = '__custom__';
        if (customInput) { customInput.value = endpoint || ''; customInput.style.display = ''; }
      }
      select.disabled = !!disabled;
      if (customInput) customInput.disabled = !!disabled;
      // customSelect 替换原生 <select> 后不会感知 js 直接设置的 value，
      // 需手动刷新按钮 label，否则按钮文案与输入框显示状态不一致
      if (window.refreshCustomSelect) window.refreshCustomSelect(select);
    }

    // 从端点下拉框/自定义输入框读取最终端点值
    function readEndpointValue() {
      var select = document.getElementById('providerEditEndpoint');
      var customInput = document.getElementById('providerEditEndpointCustom');
      if (!select) return '';
      if (select.value === '__custom__') {
        return customInput ? customInput.value.trim() : '';
      }
      return select.value;
    }

    // 上传方式开关关闭（走内联）时隐藏上传文件 URL 输入框
    function syncUploadUrlVisibility() {
      var input = document.getElementById('providerEditUseUpload');
      var row = document.getElementById('providerEditUploadUrlRow');
      if (!row) return;
      row.style.display = (input && input.checked) ? '' : 'none';
    }

    // ── 自定义请求头：文本 ⇄ 对象转换 ──
    // 文本格式：每行一条「名称: 值」；空行与 # 开头的注释行忽略。
    // 应用托管的头一律拒绝配置：Authorization / x-api-key / Content-Type 由 makeHeaders
    // 按平台 auth 与协议写入，用户再配一份只会"界面像生效、实际被覆盖"；Host / Content-Length /
    // Connection 属 fetch 禁止的头，配了也发不出去（浏览器直接忽略或抛错），拒绝比静默失效清楚。
    var _RESERVED_HEADER_NAMES = ['authorization', 'x-api-key', 'content-type', 'content-length', 'host', 'connection'];
    var _HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

    function parseHeaderLines(text) {
      var out = {};
      var lines = String(text || '').split(/\r?\n/);
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.charAt(0) === '#') continue;
        var idx = line.indexOf(':');
        // idx <= 0：没有冒号，或行首就是冒号（名称为空）
        if (idx <= 0) return { ok: false, error: AEI18n.t('第 {line} 行格式不正确，应为「名称: 值」', { line: i + 1 }) };
        var name = line.slice(0, idx).trim();
        var value = line.slice(idx + 1).trim();
        if (!_HEADER_NAME_RE.test(name)) return { ok: false, error: AEI18n.t('第 {line} 行请求头名称非法: {name}', { line: i + 1, name: name }) };
        if (_RESERVED_HEADER_NAMES.indexOf(name.toLowerCase()) >= 0) {
          return { ok: false, error: AEI18n.t('第 {line} 行「{name}」由应用托管（按平台鉴权/协议自动写入），不能在此配置', { line: i + 1, name: name }) };
        }
        out[name] = value;
      }
      return { ok: true, headers: out };
    }

    function formatHeaderLines(headers) {
      if (!headers || typeof headers !== 'object') return '';
      var lines = [];
      for (var k in headers) {
        if (headers.hasOwnProperty(k)) lines.push(k + ': ' + headers[k]);
      }
      return lines.join('\n');
    }

    // 根据上传文件 URL 与上传方式开关构建 videoInput 配置。
    // 复选框是 inline 的唯一权威来源：勾选=文件引用上传（inline:false），取消=base64 内联（inline:true）。
    // 取消勾选时即使没填上传 URL 也必须落盘 inline:true——只在 uploadUrl 非空时才写 inline 会导致
    // 取消勾选保存后重开弹窗按「inline === true」判定又显示回勾选态（状态回弹 bug 的根因）。
    // 编辑已有平台时保留 purpose（如 user_data）、reference 引用前缀（如火山方舟 'file://'）
    // 与 maxSizeMB 等其余字段：reference 丢失会让 visionProxy 回退 ms:// 前缀，视频引用被服务端拒绝。
    // 上传 URL 清空时只移除 upload 而保留其余字段——返回 undefined 会让 updateCustomProvider
    // 的字段级 merge 把整个 videoInput 置空，引用前缀一并丢失。
    function buildVideoInput(selected, uploadUrl, useUpload) {
      var prev = (selected && selected.videoInput) || null;
      // 键序刻意保持 upload → inline → 其余（reference/maxSizeMB…）：落盘 JSON 与现有格式一致，
      // 避免无意义 diff（先建 {upload, inline} 再补 reference，此处同序）
      var result = {};
      if (uploadUrl) {
        result.upload = {
          endpoint: uploadUrl,
          purpose: (prev && prev.upload && prev.upload.purpose) || 'video'
        };
      }
      result.inline = !useUpload;
      for (var k in prev) {
        if (prev.hasOwnProperty(k) && k !== 'upload' && k !== 'inline') result[k] = prev[k];
      }
      // 勾选上传但没填 URL 且原本无视频配置：整份配置无信息量（无端点、非内联），
      // 不生成 videoInput。运行时 visionProxy 的「无端点且非内联」守卫照旧拒绝视频并给出提示。
      if (!result.upload && !result.inline) {
        var hasOther = false;
        for (var k2 in result) {
          if (result.hasOwnProperty(k2) && k2 !== 'inline') { hasOther = true; break; }
        }
        if (!hasOther) return undefined;
      }
      return result;
    }

    return {
      render: function () {
        // 清理 body 下可能遗留的 modal（showProviderEditor 为解决 backdrop-filter 问题将其移到 body，
        // 若上次 destroy 未清理，此处 innerHTML 重新生成会导致 DOM 中出现两个 #providerEditorModal）
        var staleModal = document.getElementById('providerEditorModal');
        if (staleModal && staleModal.parentNode === document.body) {
          document.body.removeChild(staleModal);
        }
        var staleCapModal = document.getElementById('editModelCapabilitiesModal');
        if (staleCapModal && staleCapModal.parentNode === document.body) {
          document.body.removeChild(staleCapModal);
        }
        // addModelModal 同样会被 _openAddModelModal 移到 body（解决 stacking context
        // 干扰 backdrop-filter），漏清理会在 remount 后产生重复 #addModelModal：
        // getElementById 命中旧节点后，新增模型的表单读写/关闭全部落在隐藏的旧弹窗上
        var staleAddModelModal = document.getElementById('addModelModal');
        if (staleAddModelModal && staleAddModelModal.parentNode === document.body) {
          document.body.removeChild(staleAddModelModal);
        }
        if (_el) _el.innerHTML = _buildHtml();
        _bindEvents();
        refreshProviderList();
        console.warn('[ModelManagerView] render done');
      },
      refreshProviderList: refreshProviderList,
      destroy: function () {
        if (_searchTimer) clearTimeout(_searchTimer);
        if (_statusTimer) clearTimeout(_statusTimer);
        _searchTimer = null;
        _statusTimer = null;
        _hideContextMenu();
        document.removeEventListener('mousedown', _onDocMouseDown, true);
        window.removeEventListener('keydown', _onKeyDownForMenu);
        // 清理被移到 body 下的 modal（showProviderEditor 为解决 backdrop-filter 问题将其移出 #modelManagerBody，
        // destroy 时若不清理，下次 mount 会在 #modelManagerBody 内重新生成，导致 DOM 中出现两个 #providerEditorModal，
        // 事件绑定与显示分离，点击取消/关闭无反应）
        var staleModal = document.getElementById('providerEditorModal');
        if (staleModal && staleModal.parentNode === document.body) {
          document.body.removeChild(staleModal);
        }
        var staleCapModal = document.getElementById('editModelCapabilitiesModal');
        if (staleCapModal && staleCapModal.parentNode === document.body) {
          document.body.removeChild(staleCapModal);
        }
        var staleAddModelModal = document.getElementById('addModelModal');
        if (staleAddModelModal && staleAddModelModal.parentNode === document.body) {
          document.body.removeChild(staleAddModelModal);
        }
        _el = null;
      }
    };
  }

  global.AE_LLM = global.AE_LLM || {};
  global.AE_LLM.createModelManagerView = createModelManagerView;
})(window);
