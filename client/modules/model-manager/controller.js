(function (global) {
  'use strict';

  function createModelManagerController(context) {
    var ctx = context || {};
    var _subscribers = [];
    // 模型发现 stale 请求防护序号——连续发起发现请求（改 URL 重试/快速切换
    // 平台）时，慢的旧请求后到不得覆盖新请求的 _state.discovery 结果（旧结果导入选中
    // 后 404）。请求发起时 ++ 快照，结果回来时与当前值比对，不一致即丢弃。
    var _discoverSeq = 0;
    var _state = {
      providers: [],
      selectedProviderId: null,
      selectedProvider: null,
      userConfig: null,
      loadError: null,
      discovery: null,
      discoveryLoading: false,
      discoveryError: null,
      busy: false,
      error: null,
      globalSettings: null
    };

    function _getRegistry() {
      return global.AE_LLM && global.AE_LLM.providerRegistry;
    }

    // 存量已保存的公网 http:// 条目（历史配置，加载时不删除）：
    // 真正发起请求前给一次告警（console.warn + UI toast，不阻断，行为变更最小化）。
    var _publicHttpWarned = {};
    function _warnIfPublicHttpProvider(provider) {
      if (!provider || !provider.baseUrl) return;
      var registry = _getRegistry();
      if (!registry || typeof registry.isPublicHttpUrl !== 'function') return;
      if (!registry.isPublicHttpUrl(provider.baseUrl)) return;
      console.warn('[ModelManager] 平台「' + (provider.label || provider.id) + '」使用公网 http://，API Key 将以明文传输: ' + provider.baseUrl);
      if (_publicHttpWarned[provider.id]) return;
      _publicHttpWarned[provider.id] = true;
      if (global.AEToast && typeof global.AEToast.show === 'function') {
        global.AEToast.show(AEI18n.t('平台「{platform}」为公网 http://，API Key 将以明文传输，建议改用 https://', { platform: (provider.label || provider.id) }), 'warn', { autoHideMs: 6000 });
      }
    }

    function _getSettingsStore() {
      return ctx && ctx.settingsStore;
    }

    function _emit(event, payload) {
      for (var i = 0; i < _subscribers.length; i++) {
        _subscribers[i](event, payload);
      }
    }

    function _emitDefaultLlmChanged() {
      try {
        if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
          window.dispatchEvent(new CustomEvent('ae:default-llm-changed', {
            detail: _state.globalSettings ? {
              providerId: _state.globalSettings.defaultProviderId || _state.globalSettings.defaultPlatform || '',
              modelId: _state.globalSettings.defaultModelId || _state.globalSettings.defaultModel || ''
            } : {}
          }));
        }
      } catch (_) {}
    }

    async function _refreshGlobalSettings() {
      var store = _getSettingsStore();
      if (store && typeof store.getGlobalSettings === 'function') {
        _state.globalSettings = await store.getGlobalSettings();
      }
    }

    function _refreshProviderList() {
      var registry = _getRegistry();
      if (!registry) return;
      _state.providers = registry.listProviders();
      _state.userConfig = registry.getUserConfig();
      _state.loadError = registry.getLoadError();
      if (_state.selectedProviderId) {
        _state.selectedProvider = registry.getProvider(_state.selectedProviderId);
      }
    }

    // ── userConfig 读-改-写串行化（对照 settingsStore._serializedWrite）──
    // saveUserProviders 异步写盘完成后才更新内存快照，窗口内并发的第二次 getUserConfig()
    // 仍返回旧快照，后保存者整包覆盖前者（更新静默丢失，如复制按钮快速双击）。
    // 所有"读快照→修改→保存"的公共入口一律入队串行；同一操作内部的嵌套调用
    // （duplicateProvider → 新增副本）不经此队列、直调核心实现，避免自锁。
    var _configOpQueue = Promise.resolve();
    function _serializeConfigOp(fn) {
      var run = _configOpQueue.then(function () {
        return Promise.resolve().then(fn);
      });
      // 防止链断裂：吞掉 run 中的错误，由调用方自行处理
      _configOpQueue = run.then(function () {}, function () {});
      return run;
    }

    // 观察项：updateCustomProvider 的 Key 迁移失败收尾。
    // 病灶：providers.json 的 apiKeyField 换成新字段而 Key 值未搬移（setGlobalSettings
    // 写失败）→ 平台按新字段读 Key 恒为空，立即鉴权失败；不回滚、不重试（异常路径
    // 还把失败当成功返回）。修法比照 renameCustomProvider 的回滚语义，但只回滚该平台的
    // apiKeyField（保留用户本次的其余编辑）：Key 仍在旧槽位 → 平台立即可用，重试保存
    // 即再次尝试迁移。回滚也失败时如实提示重新输入 API Key（不谎报迁移完成）。
    function _rollbackKeyFieldMigration(self, config, providerId, oldKeyField) {
      var errReenterApiKey = AEI18n.t('设置写入失败（本地存储空间可能已满），API Key 字段迁移未完成，请在平台设置中重新输入 API Key');
      var rollback = null;
      try { rollback = JSON.parse(JSON.stringify(config)); } catch (_) { rollback = null; }
      var entry = null;
      if (rollback && rollback.customProviders) {
        for (var i = 0; i < rollback.customProviders.length; i++) {
          if (rollback.customProviders[i].id === providerId) { entry = rollback.customProviders[i]; break; }
        }
      }
      if (!entry || typeof oldKeyField !== 'string' || !oldKeyField) {
        return Promise.resolve({ ok: false, error: errReenterApiKey });
      }
      entry.apiKeyField = oldKeyField;   // 回滚字段名：平台继续读旧槽位（Key 未搬移）
      return self.saveUserConfig(rollback).then(function (rr) {
        if (rr && rr.ok !== false) {
          return { ok: false, error: AEI18n.t('设置写入失败（本地存储空间可能已满），API Key 字段迁移未完成；已回滚为原字段，平台可继续使用原 Key，请重试保存以完成迁移') };
        }
        return { ok: false, error: errReenterApiKey };
      }, function () {
        return { ok: false, error: errReenterApiKey };
      });
    }

    // addCustomProvider 的核心实现（不经串行化队列）：公共入口 addCustomProvider
    // 入队执行；duplicateProvider 在锁内嵌套新增副本时直调本函数，避免队列自锁。
    function _addCustomProviderCore(self, provider) {
      var registry = _getRegistry();
      if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });

      var errors = registry.validateProvider(provider, true);
      if (errors.length > 0) {
        return Promise.resolve({ ok: false, error: errors.join(', ') });
      }
      // endpoint 前置校验（与 providerRegistry 保存/加载侧 isSafeEndpoint 对齐）：
      // 否则非法 endpoint 会在 saveUserProviders 里被静默丢弃，UI 却显示"已保存"
      if (typeof registry.isSafeEndpoint === 'function' && !registry.isSafeEndpoint(provider.endpoint)) {
        return Promise.resolve({ ok: false, error: AEI18n.t('endpoint 必须以 / 开头，且不能包含 ://、@、?、# 或空白') });
      }

      var config = registry.getUserConfig();
      config.customProviders = config.customProviders || [];
      // 新增重名检查：自定义平台之间 id 不能重复（与内置平台冲突已由 validateProvider 拦截）
      for (var i = 0; i < config.customProviders.length; i++) {
        if (config.customProviders[i].id === provider.id) {
          return Promise.resolve({ ok: false, error: '平台 ID 已存在: ' + provider.id });
        }
      }
      config.customProviders.push(provider);

      return self.saveUserConfig(config);
    }

    function _mergeModels(existingModels, newModels) {
      var existing = {};
      for (var i = 0; i < existingModels.length; i++) {
        existing[existingModels[i].id] = existingModels[i];
      }
      for (var j = 0; j < newModels.length; j++) {
        existing[newModels[j].id] = newModels[j];
      }
      var result = [];
      for (var key in existing) {
        if (existing.hasOwnProperty(key)) result.push(existing[key]);
      }
      return result;
    }

    function _joinUrl(baseUrl, endpoint) {
      var ep = String(endpoint || '');
      if (ep.indexOf('http://') === 0 || ep.indexOf('https://') === 0) return ep;
      if (!ep) return String(baseUrl || '').replace(/\/+$/, '');
      return String(baseUrl || '').replace(/\/+$/, '') + '/' + ep.replace(/^\/+/, '');
    }

    // 声明式会话头（如 OpenCode Go 的 x-opencode-session）取值：测试连接 / 获取模型
    // 是直连 fetch 的旁路调用，无会话上下文，取 llmChannel 的安装级稳定 id（唯一来源）。
    // 取不到时返回空串，makeHeaders 按「无 sessionId」处理——不写该头，也不伪造值。
    function _sessionIdForHeaders() {
      try {
        var channel = global.AE_LLM && global.AE_LLM.llmChannel;
        if (channel && typeof channel.getClientSessionId === 'function') {
          return channel.getClientSessionId() || '';
        }
      } catch (_) {}
      return '';
    }

    function _makeHeaders(provider, apiKey) {
      if (global.AE_LLM && global.AE_LLM.protocolAdapters && typeof global.AE_LLM.protocolAdapters.makeHeaders === 'function') {
        return global.AE_LLM.protocolAdapters.makeHeaders(provider, apiKey, { sessionId: _sessionIdForHeaders() });
      }
      var headers = { 'Content-Type': 'application/json' };
      if (provider.auth && provider.auth.type === 'x-api-key') {
        headers[provider.auth.header || 'x-api-key'] = apiKey;
      } else {
        headers[provider.auth && provider.auth.header ? provider.auth.header : 'Authorization'] = 'Bearer ' + apiKey;
      }
      if (provider.protocol === 'anthropic-messages' && !headers['anthropic-version']) {
        headers['anthropic-version'] = '2023-06-01';
      }
      return headers;
    }

    function _normalizeDiscoveredModel(raw, provider) {
      var id = raw.id || raw.model || '';
      // 上下文窗口：只认**窗口语义**的字段（按可信度排序），读不到就写 0 = 未知。
      // 模型自报窗口优先、用户设置兜底，这里是分母的**唯一来源**，
      // 因此宁可写「未知」也不能写错：
      //   · 不认 `max_tokens`：它在 OpenAI 兼容接口/OpenRouter 里是**单次输出上限**
      //     （top_provider.max_tokens，常见 4096/8192；也可能 ≥32K）——当窗口采纳会被
      //     `context.js` 的 32K 信任闸放过，分母被误压小 ⇒ 提前自动压缩（真实用户损伤）；
      //   · 不兜底 4096：那是假数字，会把「未上报」误当「4K 模型」；
      //   · 取舍依据是非对称风险：认错（虚小）会让上下文被过早丢弃，不认只是回落到用户
      //     手填的兜底值（未设置则默认 256K）——两个方向的代价差一个量级。
      // 认的字段各有明确出处：max_context_length（多数网关）/ context_length（OpenRouter）/
      // context_window（部分网关）/ max_input_tokens（Anthropic 风格输入上限，正是提示词侧容量）/
      // inputTokenLimit（Gemini models.list）。
      var win = Number(raw.max_context_length || raw.context_length || raw.context_window
        || raw.max_input_tokens || raw.inputTokenLimit || 0);
      return {
        id: String(id),
        capabilities: {
          vision: false,
          jsonMode: true,
          tools: true,
          stream: true
        },
        // 与「新增模型」同口径：新入库的模型默认思考模式=开启
        thinking: { mode: 'on' },
        contextWindow: (isFinite(win) && win > 0) ? Math.floor(win) : 0,
        maxOutput: raw.max_output_tokens || raw.max_completion_tokens || 1024,
        pricing: { input: 0, output: 0 }
      };
    }

    function _parseModelsFromResponse(data, provider) {
      var models = [];
      if (data && Array.isArray(data.data)) {
        // OpenAI-style { data: [...] }
        for (var i = 0; i < data.data.length; i++) {
          models.push(_normalizeDiscoveredModel(data.data[i], provider));
        }
      } else if (Array.isArray(data.models)) {
        // Some providers use { models: [...] }
        for (var j = 0; j < data.models.length; j++) {
          models.push(_normalizeDiscoveredModel(data.models[j], provider));
        }
      } else if (Array.isArray(data)) {
        // Direct array
        for (var k = 0; k < data.length; k++) {
          models.push(_normalizeDiscoveredModel(data[k], provider));
        }
      }
      return models;
    }

    return {
      init: function () {
        _refreshProviderList();
        return _refreshGlobalSettings();
      },

      destroy: function () {
        _subscribers = [];
      },

      subscribe: function (cb) {
        if (typeof cb === 'function') _subscribers.push(cb);
      },

      getState: function () {
        return JSON.parse(JSON.stringify(_state));
      },

      selectProvider: function (providerId) {
        _state.selectedProviderId = providerId;
        var registry = _getRegistry();
        _state.selectedProvider = registry ? registry.getProvider(providerId) : null;
        _state.discovery = null;
        _state.discoveryError = null;
        _emit('providerSelected', { providerId: providerId });
      },

      getProviderApiKey: function (providerId) {
        var registry = _getRegistry();
        var provider = registry ? registry.getProvider(providerId) : null;
        if (!provider || !_state.globalSettings) return '';
        var field = provider.apiKeyField;
        if (field && _state.globalSettings[field]) {
          return _state.globalSettings[field];
        }
        // Legacy fallback for siliconflow
        if (providerId === 'siliconflow' && _state.globalSettings.apiKey) {
          return _state.globalSettings.apiKey;
        }
        return '';
      },

      saveProviderApiKey: function (providerId, apiKey) {
        var registry = _getRegistry();
        var store = _getSettingsStore();
        var provider = registry ? registry.getProvider(providerId) : null;
        if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });
        if (!store || typeof store.setGlobalSettings !== 'function') {
          return Promise.resolve({ ok: false, error: 'Settings store not available' });
        }
        var field = provider.apiKeyField;
        if (!field) {
          return Promise.resolve({ ok: false, error: 'Provider does not have an apiKeyField' });
        }
        var updates = {};
        updates[field] = apiKey;
        // setGlobalSettings 在配额满/加密异常时 resolve false（settingsStore.writeRaw），
        // 不看返回值直接 ok:true 时——UI 谎报「平台设置已保存」而 Key 实际未落盘。
        return store.setGlobalSettings(updates).then(function (r) {
          if (r === false) {
            return { ok: false, error: AEI18n.t('设置写入失败（本地存储空间可能已满），API Key 未保存') };
          }
          return _refreshGlobalSettings().then(function () {
            _emit('apiKeySaved', { providerId: providerId });
            return { ok: true };
          });
        }).catch(function (e) {
          var msg = (e && e.message) ? e.message : String(e);
          console.warn('[ModelManager] saveProviderApiKey 失败: ' + msg);
          return { ok: false, error: msg };
        });
      },

      setDefaultModel: function (providerId, modelId) {
        var registry = _getRegistry();
        var store = _getSettingsStore();
        var provider = registry ? registry.getProvider(providerId) : null;
        if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });
        if (!store || typeof store.setGlobalSettings !== 'function') {
          return Promise.resolve({ ok: false, error: 'Settings store not available' });
        }
        var updates = {
          defaultProviderId: providerId,
          defaultPlatform: providerId,
          defaultModelId: modelId,
          defaultModel: modelId
        };
        // 主模型不能被设为视觉代理：若新主模型恰是当前视觉代理配置，自动清空视觉代理
        var _proxyCleared = false;
        if (_state.globalSettings
          && _state.globalSettings.visionProviderId === providerId
          && _state.globalSettings.visionModelId === modelId) {
          updates.visionProviderId = '';
          updates.visionModelId = '';
          _proxyCleared = true;
        }
        // 写失败（resolve false）不得再刷新/发事件谎报成功——UI 按 ok:false 弹错误
        return store.setGlobalSettings(updates).then(function (r) {
          if (r === false) {
            return { ok: false, error: AEI18n.t('设置写入失败（本地存储空间可能已满），当前模型未更新') };
          }
          return _refreshGlobalSettings().then(function () {
            _refreshProviderList();
            _emit('defaultModelSet', { providerId: providerId, modelId: modelId });
            _emitDefaultLlmChanged();
            return { ok: true, visionProxyCleared: _proxyCleared };
          });
        }).catch(function (e) {
          var msg = (e && e.message) ? e.message : String(e);
          console.warn('[ModelManager] setDefaultModel 失败: ' + msg);
          return { ok: false, error: msg };
        });
      },

      // 视觉代理模型：非视觉主模型遇到图片/读图时，后台用此模型转文字描述。
      // 与 setDefaultModel 不同——不写 defaultProviderId/defaultModelId，主对话模型保持不变。
      // 传空 providerId/modelId 即清空视觉模型配置。
      setDefaultVisionModel: function (providerId, modelId) {
        var store = _getSettingsStore();
        if (!store || typeof store.setGlobalSettings !== 'function') {
          return Promise.resolve({ ok: false, error: 'Settings store not available' });
        }
        if (providerId && modelId) {
          var registry = _getRegistry();
          var provider = registry ? registry.getProvider(providerId) : null;
          if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });
          // 校验模型存在且支持视觉，避免配置一个不可用的视觉模型
          var modelEntry = null;
          var sourceModels = provider.models || [];
          for (var mi = 0; mi < sourceModels.length; mi++) {
            if (sourceModels[mi].id === modelId) { modelEntry = sourceModels[mi]; break; }
          }
          if (!modelEntry) return Promise.resolve({ ok: false, error: 'Model not found' });
          if (!modelEntry.capabilities || modelEntry.capabilities.vision !== true) {
            return Promise.resolve({ ok: false, error: AEI18n.t('该模型未标记为支持视觉') });
          }
          // 视觉代理需要真实发起视觉请求：未配置 API Key 时拦截，避免设完才发现无法用
          if (!this.getProviderApiKey(providerId)) {
            return Promise.resolve({ ok: false, error: AEI18n.t('该平台未配置 API Key，无法设为视觉代理') });
          }
          // 主模型（当前默认模型）不能被设为视觉代理：视觉代理仅用于补充主模型视觉能力
          if (_state.globalSettings) {
            var _defProviderId = _state.globalSettings.defaultProviderId || _state.globalSettings.defaultPlatform || '';
            var _defModelId = _state.globalSettings.defaultModelId || _state.globalSettings.defaultModel || '';
            if (providerId === _defProviderId && modelId === _defModelId) {
              return Promise.resolve({ ok: false, error: AEI18n.t('主模型不能被设为视觉代理') });
            }
          }
        }
        var updates = {
          visionProviderId: providerId || '',
          visionModelId: modelId || ''
        };
        // 同 saveProviderApiKey/setDefaultModel——false 时不发 defaultVisionModelSet
        return store.setGlobalSettings(updates).then(function (r) {
          if (r === false) {
            return { ok: false, error: AEI18n.t('设置写入失败（本地存储空间可能已满），视觉代理未更新') };
          }
          return _refreshGlobalSettings().then(function () {
            _emit('defaultVisionModelSet', { providerId: providerId || '', modelId: modelId || '' });
            return { ok: true };
          });
        }).catch(function (e) {
          var msg = (e && e.message) ? e.message : String(e);
          console.warn('[ModelManager] setDefaultVisionModel 失败: ' + msg);
          return { ok: false, error: msg };
        });
      },

      saveUserConfig: function (config) {
        var registry = _getRegistry();
        if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
        _state.busy = true;
        _emit('busyChanged', { busy: true });
        return registry.saveUserProviders(config).then(function (result) {
          _state.busy = false;
          _emit('busyChanged', { busy: false });
          if (result.ok) {
            _refreshProviderList();
            _emit('configSaved', {});
          } else {
            _state.error = result.error;
            _emit('error', { error: result.error });
          }
          return result;
        }).catch(function (e) {
          // 写入失败也必须复位 busy，否则 UI 永久卡在"保存中"
          _state.busy = false;
          _emit('busyChanged', { busy: false });
          var msg = (e && e.message) ? e.message : String(e);
          _state.error = msg;
          _emit('error', { error: msg });
          console.warn('[ModelManager] saveUserConfig 失败: ' + msg);
          return { ok: false, error: msg };
        });
      },

      addCustomProvider: function (provider) {
        var self = this;
        return _serializeConfigOp(function () {
          return _addCustomProviderCore(self, provider);
        });
      },

      updateCustomProvider: function (providerId, updates) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });

          var config = registry.getUserConfig();
          config.customProviders = config.customProviders || [];
          var found = false;
          // 快照合并前的 apiKeyField——view 保存路径把共用槽位
          //（'customApiKey'）迁到唯一槽位（'customApiKey-{id}'）时经本方法落盘，
          // 旧槽位的 Key 值须搬移并清理（比照 renameCustomProvider/deleteCustomProvider
          // 两处孤儿 Key 清理），否则敏感凭据在全局设置中长期残留
          var oldKeyField = '';
          var newKeyField = '';
          for (var i = 0; i < config.customProviders.length; i++) {
            if (config.customProviders[i].id === providerId) {
              oldKeyField = config.customProviders[i].apiKeyField || '';
              newKeyField = (updates && updates.apiKeyField) || oldKeyField;
              for (var key in updates) {
                if (updates.hasOwnProperty(key)) {
                  config.customProviders[i][key] = updates[key];
                }
              }
              found = true;
              break;
            }
          }
          if (!found) return Promise.resolve({ ok: false, error: 'Provider not found' });

          // 与 addCustomProvider 对齐：合并后的完整条目必须过一次 validate，
          // 堵住 updateCustomProvider 直写路径绕过校验的口子（公网 http:// 在此被拦）。
          var merged = null;
          for (var j = 0; j < config.customProviders.length; j++) {
            if (config.customProviders[j].id === providerId) { merged = config.customProviders[j]; break; }
          }
          var errors = registry.validateProvider(merged, true);
          if (errors.length > 0) {
            return Promise.resolve({ ok: false, error: errors.join(', ') });
          }
          // endpoint 前置校验（与 addCustomProvider 对齐），避免非法值被保存侧静默丢弃
          if (typeof registry.isSafeEndpoint === 'function' && !registry.isSafeEndpoint(merged.endpoint)) {
            return Promise.resolve({ ok: false, error: AEI18n.t('endpoint 必须以 / 开头，且不能包含 ://、@、?、# 或空白') });
          }

          return self.saveUserConfig(config).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: 'Save failed' };
            // apiKeyField 迁移时搬移 Key 值并清理旧槽位（比照 renameCustomProvider
            // 的搬移+清理写法）：旧字段仍被其他存活平台使用（共享 'customApiKey' 槽位）时
            // 保留不清空，否则清空避免敏感凭据残留；旧字段无值则只改字段名
            if (oldKeyField && newKeyField && oldKeyField !== newKeyField
              && _state.globalSettings
              && typeof _state.globalSettings[oldKeyField] !== 'undefined'
              && _state.globalSettings[oldKeyField] !== '') {
              var store = _getSettingsStore();
              if (store && typeof store.setGlobalSettings === 'function') {
                var keyUpdates = {};
                keyUpdates[newKeyField] = _state.globalSettings[oldKeyField];
                var _oldFieldStillUsed = false;
                var _survivors = registry.listProviders();
                for (var _si = 0; _si < _survivors.length; _si++) {
                  if (_survivors[_si].id !== providerId && _survivors[_si].apiKeyField === oldKeyField) { _oldFieldStillUsed = true; break; }
                }
                if (!_oldFieldStillUsed) {
                  keyUpdates[oldKeyField] = '';
                }
                return store.setGlobalSettings(keyUpdates).then(function (r) {
                  // resolve false（配额满/加密异常）被当成功时——providers.json 的
                  // apiKeyField 换成新字段而 Key 值未搬移，重启后平台按新字段读 Key
                  // 恒为空（鉴权失败）却回执成功。如实返回错误（不谎报迁移完成）。
                  // 并回滚 providers.json 的 apiKeyField（比照 rename 的回滚路径）——
                  // 否则平台按新字段读 Key 恒为空，立即鉴权失败。
                  if (r === false) {
                    return _rollbackKeyFieldMigration(self, config, providerId, oldKeyField);
                  }
                  return _refreshGlobalSettings().then(function () { return result; });
                }).catch(function (e) {
                  // 异常路径把失败当成功返回时——
                  // 与 resolve false 同口径：回滚字段名 + 如实报错
                  console.warn('[ModelManager] apiKeyField 迁移的 Key 搬移失败: ' + ((e && e.message) || e));
                  return _rollbackKeyFieldMigration(self, config, providerId, oldKeyField);
                });
              }
            }
            return result;
          });
        });
      },

      renameCustomProvider: function (oldId, newId) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          var store = _getSettingsStore();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
          if (!oldId || !newId) return Promise.resolve({ ok: false, error: 'Provider id required' });
          if (oldId === newId) return Promise.resolve({ ok: true });

          var sanitized = registry.sanitizeId ? registry.sanitizeId(newId) : String(newId);
          if (!sanitized || sanitized !== newId) {
            return Promise.resolve({ ok: false, error: AEI18n.t('平台 ID 只能包含小写字母、数字、下划线和连字符') });
          }

          var existing = registry.getProvider(newId);
          if (existing) return Promise.resolve({ ok: false, error: '平台 ID 已存在: ' + newId });

          var config = registry.getUserConfig();
          config.customProviders = config.customProviders || [];
          var found = false;
          var oldKeyField = '';
          var newKeyField = 'customApiKey-' + newId;
          var originalProvider = null;
          for (var i = 0; i < config.customProviders.length; i++) {
            if (config.customProviders[i].id === oldId) {
              oldKeyField = config.customProviders[i].apiKeyField || '';
              // 改名前快照：providers.json 改名成功但后续 Key 迁移失败时，用它把
              // providers.json 回滚回旧 id，保证重试同一 rename 仍能找到平台
              originalProvider = JSON.parse(JSON.stringify(config.customProviders[i]));
              config.customProviders[i].id = newId;
              // 重命名同步迁移 apiKeyField 到 'customApiKey-{newId}'：沿用旧字段会让之后用旧 id
              // 重建的平台生成同名字段，两平台读写同一 Key 存储互相覆盖（deleteCustomProvider
              // 已防御同 id 重建静默继承旧 Key 的同构入口，重命名路径在此补齐）
              config.customProviders[i].apiKeyField = newKeyField;
              found = true;
              break;
            }
          }
          if (!found) return Promise.resolve({ ok: false, error: 'Custom provider not found' });

          // 选中态延后到两段提交（providers.json 改名 + Key 迁移）全部成功后再变更：
          // 保存前就改 selectedProviderId 时，保存失败后选中态指向不存在的平台
          return self.saveUserConfig(config).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: 'Save failed' };
            var updates = null;
            if (_state.globalSettings) {
              var currentProviderId = _state.globalSettings.defaultProviderId || _state.globalSettings.defaultPlatform || '';
              if (currentProviderId === oldId) {
                updates = { defaultProviderId: newId, defaultPlatform: newId };
              }
              // 视觉代理平台被重命名：同步更新 visionProviderId
              if (_state.globalSettings.visionProviderId === oldId) {
                updates = updates || {};
                updates.visionProviderId = newId;
              }
            }
            // Key 值随字段迁移：旧字段值搬到新字段；旧字段仍被其他存活平台使用（如共享
            // 'customApiKey' 槽位）时保留不清空，否则清空避免敏感数据残留（镜像
            // deleteCustomProvider 的孤儿 Key 清理模式）。旧字段无值则只改字段名。
            if (oldKeyField && oldKeyField !== newKeyField
              && _state.globalSettings
              && typeof _state.globalSettings[oldKeyField] !== 'undefined'
              && _state.globalSettings[oldKeyField] !== '') {
              updates = updates || {};
              updates[newKeyField] = _state.globalSettings[oldKeyField];
              var _oldFieldStillUsed = false;
              var _survivors = registry.listProviders();
              for (var _si = 0; _si < _survivors.length; _si++) {
                if (_survivors[_si].id !== newId && _survivors[_si].apiKeyField === oldKeyField) { _oldFieldStillUsed = true; break; }
              }
              if (!_oldFieldStillUsed) {
                updates[oldKeyField] = '';
              }
            }
            if (updates && store && typeof store.setGlobalSettings === 'function') {
              return store.setGlobalSettings(updates).then(function (r) {
                // resolve false（写盘失败）转异常走下方同一回滚路径——false 被
                // 当成功：providers.json 改名成功而 Key 未搬移，重启后新 id 平台读不到 Key
                // （鉴权失败）却回执 ok:true。
                if (r === false) {
                  throw new Error(AEI18n.t('设置写入失败（本地存储空间可能已满），平台重命名未完成'));
                }
              }).catch(function (e) {
                // providers.json 改名成功但 Key 迁移失败：回滚 providers.json 到旧 id。
                // Key 值仍留在旧字段（尚未搬移），旧 id 平台照常读 Key，重试同一
                // rename 不再报 Custom provider not found，用户无须重输 Key
                var rollback = JSON.parse(JSON.stringify(config));
                for (var r = 0; r < rollback.customProviders.length; r++) {
                  if (rollback.customProviders[r].id === newId) {
                    rollback.customProviders[r] = originalProvider;
                    break;
                  }
                }
                return self.saveUserConfig(rollback).then(function () {
                  throw e;
                }, function () {
                  // 回滚也失败（连续两次写盘失败的极端场景）：仍如实返回原始错误
                  throw e;
                });
              }).then(function () {
                return _refreshGlobalSettings().then(function () {
                  if (_state.selectedProviderId === oldId) {
                    _state.selectedProviderId = newId;
                  }
                  _refreshProviderList();
                  _emit('providerRenamed', { oldId: oldId, newId: newId });
                  _emitDefaultLlmChanged();
                  return { ok: true };
                });
              });
            }
            if (_state.selectedProviderId === oldId) {
              _state.selectedProviderId = newId;
            }
            _refreshProviderList();
            _emit('providerRenamed', { oldId: oldId, newId: newId });
            return { ok: true };
          }).catch(function (e) {
            var msg = (e && e.message) ? e.message : String(e);
            console.warn('[ModelManager] renameCustomProvider 失败: ' + msg);
            return { ok: false, error: msg };
          });
        });
      },

      deleteCustomProvider: function (providerId) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          var store = _getSettingsStore();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });

          // 删除前留存快照：清理孤儿 API Key 时需要其 apiKeyField
          var removedProvider = registry.getProvider(providerId);

          var config = registry.getUserConfig();
          config.customProviders = config.customProviders || [];
          config.customProviders = config.customProviders.filter(function (p) {
            return p.id !== providerId;
          });

          if (_state.selectedProviderId === providerId) {
            _state.selectedProviderId = null;
            _state.selectedProvider = null;
          }

          return self.saveUserConfig(config).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: 'Save failed' };
            var updates = null;
            if (_state.globalSettings) {
              var currentProviderId = _state.globalSettings.defaultProviderId || _state.globalSettings.defaultPlatform || '';
              if (currentProviderId === providerId) {
                updates = { defaultProviderId: '', defaultPlatform: '', defaultModelId: '', defaultModel: '' };
              }
              // 删除的是视觉代理平台：同步清空视觉代理配置，避免指向不存在的平台
              if (_state.globalSettings.visionProviderId === providerId) {
                updates = updates || {};
                updates.visionProviderId = '';
                updates.visionModelId = '';
              }
            }
            // 清理孤儿 API Key：被删平台的 apiKeyField 若已无任何存活平台使用，同步从全局设置清空，
            // 避免敏感数据残留（及同 id 重建平台时静默继承旧 Key）
            if (removedProvider && removedProvider.apiKeyField
              && _state.globalSettings
              && typeof _state.globalSettings[removedProvider.apiKeyField] !== 'undefined') {
              var _removedField = removedProvider.apiKeyField;
              var _fieldStillUsed = false;
              var _survivors = registry.listProviders();
              for (var _si = 0; _si < _survivors.length; _si++) {
                if (_survivors[_si].apiKeyField === _removedField) { _fieldStillUsed = true; break; }
              }
              if (!_fieldStillUsed) {
                updates = updates || {};
                updates[_removedField] = '';
              }
            }
            if (updates && store && typeof store.setGlobalSettings === 'function') {
              return store.setGlobalSettings(updates).then(function (r) {
                if (r === false) {
                  // providers.json 删除已提交，但默认模型/孤儿 Key 的全局设置清理写失败
                  // ——照发 providerDeleted 并回执 ok:true 时，重启后默认模型仍指向已删除
                  // 平台、孤儿 Key 残留。删除本身已生效，刷新列表但如实回执失败。
                  _refreshProviderList();
                  return { ok: false, error: AEI18n.t('设置写入失败（本地存储空间可能已满），默认模型/API Key 清理未保存') };
                }
                return _refreshGlobalSettings().then(function () {
                  _refreshProviderList();
                  _emit('providerDeleted', { providerId: providerId });
                  _emitDefaultLlmChanged();
                  return { ok: true };
                });
              });
            }
            return result;
          }).catch(function (e) {
            var msg = (e && e.message) ? e.message : String(e);
            console.warn('[ModelManager] deleteCustomProvider 失败: ' + msg);
            return { ok: false, error: msg };
          });
        });
      },

      // 复制平台为新的自定义平台：深拷贝源配置（含模型），生成唯一 id（{id}-copy[-N]），
      // label 追加「(副本)」，builtin 强制 false。
      // API Key 跟随复制，但副本用独立 apiKeyField（{baseField}-{newId}），
      // 避免源/副本共享同一存储字段导致改一个另一个也变——副本完全独立。
      duplicateProvider: function (providerId) {
        var self = this;
        return _serializeConfigOp(function () {
          // newId 生成也必须在锁内：并发双击复制时，第二次须在第一次保存完成后
          // 才能探测到 {id}-copy 已占用，从而生成 {id}-copy-2，而不是撞名失败
          var registry = _getRegistry();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
          var source = registry.getProvider(providerId);
          if (!source) return Promise.resolve({ ok: false, error: 'Provider not found' });

          var baseId = source.id + '-copy';
          var newId = baseId;
          var n = 2;
          while (registry.getProvider(newId)) {
            newId = baseId + '-' + n;
            n++;
          }

          var copy = JSON.parse(JSON.stringify(source));
          copy.id = newId;
          copy.label = AEI18n.t('{label} (副本)', { label: source.label || source.id });
          copy.builtin = false;
          copy.enabled = true;
          copy.selectedModelId = source.selectedModelId || '';
          // 生成唯一 apiKeyField：基于源字段名 + 副本 id，确保与源及其它副本不撞。
          // settings 存储允许任意 key 名；getProviderApiKey/saveProviderApiKey 按 provider.apiKeyField 读写。
          var baseKeyField = source.apiKeyField || 'customApiKey';
          copy.apiKeyField = baseKeyField + '-' + newId;

          return _addCustomProviderCore(self, copy).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: AEI18n.t('复制失败') };
            var sourceKey = self.getProviderApiKey(providerId);
            if (sourceKey) {
              // 用副本自己的 apiKeyField 存源 Key 值，副本即独立可用。
              return self.saveProviderApiKey(newId, sourceKey).then(function () {
                _refreshProviderList();
                _emit('providerDuplicated', { sourceId: providerId, newId: newId });
                return { ok: true, newId: newId };
              });
            }
            _refreshProviderList();
            _emit('providerDuplicated', { sourceId: providerId, newId: newId });
            return { ok: true, newId: newId };
          });
        });
      },

      addOrUpdateModel: function (providerId, model) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });

          var provider = registry.getProvider(providerId);
          if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });

          // 判断模型是否已存在（以 provider.models 合并后的列表为准）
          var existed = false;
          var currentModels = provider.models || [];
          for (var mi = 0; mi < currentModels.length; mi++) {
            if (currentModels[mi] && currentModels[mi].id === model.id) { existed = true; break; }
          }

          var config = registry.getUserConfig();
          if (provider.builtin) {
            config.builtinModelOverrides = config.builtinModelOverrides || {};
            config.builtinModelOverrides[providerId] = _mergeModels(config.builtinModelOverrides[providerId] || [], [model]);
            if (config.builtinDeletedModels && Array.isArray(config.builtinDeletedModels[providerId])) {
              config.builtinDeletedModels[providerId] = config.builtinDeletedModels[providerId].filter(function (id) {
                return id !== model.id;
              });
            }
            return self.saveUserConfig(config).then(function (result) {
              if (result && result.ok) result.action = existed ? 'updated' : 'added';
              return result;
            });
          }

          config.customProviders = config.customProviders || [];
          for (var i = 0; i < config.customProviders.length; i++) {
            if (config.customProviders[i].id === providerId) {
              config.customProviders[i].models = _mergeModels(config.customProviders[i].models || [], [model]);
              break;
            }
          }

          return self.saveUserConfig(config).then(function (result) {
            if (result && result.ok) result.action = existed ? 'updated' : 'added';
            return result;
          });
        });
      },

      deleteModel: function (providerId, modelId) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          var store = _getSettingsStore();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
          if (!modelId) return Promise.resolve({ ok: false, error: 'Model not specified' });

          var provider = registry.getProvider(providerId);
          if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });

          var config = registry.getUserConfig();
          var removed = false;
          if (provider.builtin) {
            var modelExists = false;
            for (var mIndex = 0; mIndex < (provider.models || []).length; mIndex++) {
              if (provider.models[mIndex].id === modelId) {
                modelExists = true;
                break;
              }
            }
            if (!modelExists) return Promise.resolve({ ok: false, error: 'Model not found' });
            config.builtinModelOverrides = config.builtinModelOverrides || {};
            config.builtinDeletedModels = config.builtinDeletedModels || {};
            var overrides = Array.isArray(config.builtinModelOverrides[providerId]) ? config.builtinModelOverrides[providerId] : [];
            config.builtinModelOverrides[providerId] = overrides.filter(function (m) {
              return m && m.id !== modelId;
            });
            config.builtinDeletedModels[providerId] = Array.isArray(config.builtinDeletedModels[providerId]) ? config.builtinDeletedModels[providerId] : [];
            if (config.builtinDeletedModels[providerId].indexOf(modelId) === -1) {
              config.builtinDeletedModels[providerId].push(modelId);
            }
            removed = true;
            if (config.builtinSelectedModels && config.builtinSelectedModels[providerId] === modelId) {
              delete config.builtinSelectedModels[providerId];
            }
          } else {
            config.customProviders = config.customProviders || [];
            for (var i = 0; i < config.customProviders.length; i++) {
              if (config.customProviders[i].id === providerId) {
                var before = (config.customProviders[i].models || []).length;
                config.customProviders[i].models = (config.customProviders[i].models || []).filter(function (m) {
                  return m.id !== modelId;
                });
                removed = before !== config.customProviders[i].models.length;
                if (config.customProviders[i].selectedModelId === modelId) {
                  config.customProviders[i].selectedModelId = '';
                }
                break;
              }
            }
          }
          if (!removed) return Promise.resolve({ ok: false, error: 'Model not found' });

          return self.saveUserConfig(config).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: 'Save failed' };
            var refreshedProvider = registry.getProvider(providerId);
            var fallbackModelId = refreshedProvider && refreshedProvider.models && refreshedProvider.models.length ? refreshedProvider.models[0].id : '';
            var updates = null;
            if (_state.globalSettings) {
              var currentProviderId = _state.globalSettings.defaultProviderId || _state.globalSettings.defaultPlatform || '';
              var currentModelId = _state.globalSettings.defaultModelId || _state.globalSettings.defaultModel || '';
              if (currentProviderId === providerId && currentModelId === modelId) {
                updates = { defaultModelId: fallbackModelId, defaultModel: fallbackModelId };
              }
              // 删除的是视觉代理模型：同步清空视觉代理配置
              if (_state.globalSettings.visionProviderId === providerId && _state.globalSettings.visionModelId === modelId) {
                updates = updates || {};
                updates.visionProviderId = '';
                updates.visionModelId = '';
              }
            }
            if (updates && store && typeof store.setGlobalSettings === 'function') {
              return store.setGlobalSettings(updates).then(function (r) {
                if (r === false) {
                  // 模型删除已提交，但默认模型/视觉代理清理写失败——回执 ok:true 时，
                  // 重启后默认模型仍指向已删除条目（面板报成功、重启后配置悬空）。
                  // 模型删除本身已生效，刷新列表但如实回执失败。
                  _refreshProviderList();
                  return { ok: false, error: AEI18n.t('设置写入失败（本地存储空间可能已满），默认模型/视觉代理清理未保存') };
                }
                return _refreshGlobalSettings().then(function () {
                  _refreshProviderList();
                  _emit('modelDeleted', { providerId: providerId, modelId: modelId });
                  _emitDefaultLlmChanged();
                  return { ok: true, fallbackModelId: fallbackModelId };
                });
              });
            }
            _refreshProviderList();
            _emit('modelDeleted', { providerId: providerId, modelId: modelId });
            return { ok: true, fallbackModelId: fallbackModelId };
          }).catch(function (e) {
            var msg = (e && e.message) ? e.message : String(e);
            console.warn('[ModelManager] deleteModel 失败: ' + msg);
            return { ok: false, error: msg };
          });
        });
      },

      setModelVision: function (providerId, modelId, vision) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
          if (!modelId) return Promise.resolve({ ok: false, error: 'Model not specified' });

          var provider = registry.getProvider(providerId);
          if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });

          var modelEntry = null;
          var sourceModels = provider.models || [];
          for (var mi = 0; mi < sourceModels.length; mi++) {
            if (sourceModels[mi].id === modelId) {
              modelEntry = sourceModels[mi];
              break;
            }
          }
          if (!modelEntry) return Promise.resolve({ ok: false, error: 'Model not found' });

          var nextCapabilities = modelEntry.capabilities && typeof modelEntry.capabilities === 'object'
            ? JSON.parse(JSON.stringify(modelEntry.capabilities))
            : { vision: false, jsonMode: true, tools: true, stream: true };
          nextCapabilities.vision = !!vision;

          var nextModel = JSON.parse(JSON.stringify(modelEntry));
          nextModel.capabilities = nextCapabilities;

          var config = registry.getUserConfig();
          if (provider.builtin) {
            config.builtinModelOverrides = config.builtinModelOverrides || {};
            config.builtinModelOverrides[providerId] = _mergeModels(config.builtinModelOverrides[providerId] || [], [nextModel]);
          } else {
            config.customProviders = config.customProviders || [];
            var found = false;
            for (var i = 0; i < config.customProviders.length; i++) {
              if (config.customProviders[i].id === providerId) {
                config.customProviders[i].models = _mergeModels(config.customProviders[i].models || [], [nextModel]);
                found = true;
                break;
              }
            }
            if (!found) return Promise.resolve({ ok: false, error: 'Custom provider not found' });
          }
          return self.saveUserConfig(config).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: 'Save failed' };
            // 取消的是视觉代理模型的视觉标记：视觉代理配置随之失效，同步清空
            if (vision === false && _state.globalSettings
              && _state.globalSettings.visionProviderId === providerId
              && _state.globalSettings.visionModelId === modelId) {
              var store2 = _getSettingsStore();
              if (store2 && typeof store2.setGlobalSettings === 'function') {
                return store2.setGlobalSettings({ visionProviderId: '', visionModelId: '' }).then(function (r) {
                  if (r === false) {
                    // 模型能力/视觉标记已保存，但视觉代理清理写失败——代理配置仍指向
                    // 一个已取消视觉的模型，重启后读图代理失效；.catch 只吞 reject 时，
                    // false 被当成功（回执 ok:true）。如实回执（模型能力本身已落盘）。
                    return { ok: false, error: AEI18n.t('模型设置已保存，但视觉代理配置清理失败（本地存储空间可能已满）') };
                  }
                  return _refreshGlobalSettings().then(function () { return result; });
                }).catch(function () { return result; });
              }
            }
            return result;
          });
        });
      },

      // 统一更新模型能力（vision/video/jsonMode/tools/stream 等任意字段）。
      // 与 setModelVision 不同：接收完整能力补丁对象，可一次更新多个能力。
      // 设置模型的「思考模式」意图（off/on/custom）——与 setModelCapabilities 同款落盘路径
      // （内置平台走 builtinModelOverrides、自定义平台直改条目）。存的是意图而非拼好的参数：
      // 请求构建时由 protocolAdapters 的映射表翻译成各家原生字段（thinking.type /
      // enable_thinking / reasoning …，且可因模型而异）。
      setModelThinking: function (providerId, modelId, thinking) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
          if (!modelId) return Promise.resolve({ ok: false, error: 'Model not specified' });
          if (!thinking || typeof thinking !== 'object') return Promise.resolve({ ok: false, error: AEI18n.t('thinking 参数不合法') });

          var mode = thinking.mode;
          if (['off', 'on', 'custom'].indexOf(mode) < 0) {
            return Promise.resolve({ ok: false, error: AEI18n.t('thinking.mode 必须是 off/on/custom') });
          }
          var custom = {};
          if (mode === 'custom') {
            if (!thinking.custom || typeof thinking.custom !== 'object' || Array.isArray(thinking.custom)) {
              return Promise.resolve({ ok: false, error: AEI18n.t('自定义思考参数必须是 JSON 对象') });
            }
            try { custom = JSON.parse(JSON.stringify(thinking.custom)); } catch (e) {
              return Promise.resolve({ ok: false, error: AEI18n.t('自定义思考参数无法序列化') });
            }
          }

          var provider = registry.getProvider(providerId);
          if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });

          var modelEntry = null;
          var sourceModels = provider.models || [];
          for (var mi = 0; mi < sourceModels.length; mi++) {
            if (sourceModels[mi].id === modelId) { modelEntry = sourceModels[mi]; break; }
          }
          if (!modelEntry) return Promise.resolve({ ok: false, error: 'Model not found' });

          var nextModel = JSON.parse(JSON.stringify(modelEntry));
          nextModel.thinking = { mode: mode, custom: custom };

          var config = registry.getUserConfig();
          if (provider.builtin) {
            config.builtinModelOverrides = config.builtinModelOverrides || {};
            config.builtinModelOverrides[providerId] = _mergeModels(config.builtinModelOverrides[providerId] || [], [nextModel]);
          } else {
            config.customProviders = config.customProviders || [];
            var found = false;
            for (var i = 0; i < config.customProviders.length; i++) {
              if (config.customProviders[i].id === providerId) {
                config.customProviders[i].models = _mergeModels(config.customProviders[i].models || [], [nextModel]);
                found = true;
                break;
              }
            }
            if (!found) return Promise.resolve({ ok: false, error: 'Custom provider not found' });
          }
          return self.saveUserConfig(config);
        });
      },

      setModelCapabilities: function (providerId, modelId, capabilities) {
        var self = this;
        return _serializeConfigOp(function () {
          var registry = _getRegistry();
          if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
          if (!modelId) return Promise.resolve({ ok: false, error: 'Model not specified' });
          if (!capabilities || typeof capabilities !== 'object') return Promise.resolve({ ok: false, error: 'Capabilities not specified' });

          var provider = registry.getProvider(providerId);
          if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });

          var modelEntry = null;
          var sourceModels = provider.models || [];
          for (var mi = 0; mi < sourceModels.length; mi++) {
            if (sourceModels[mi].id === modelId) { modelEntry = sourceModels[mi]; break; }
          }
          if (!modelEntry) return Promise.resolve({ ok: false, error: 'Model not found' });

          var nextCapabilities = modelEntry.capabilities && typeof modelEntry.capabilities === 'object'
            ? JSON.parse(JSON.stringify(modelEntry.capabilities))
            : { vision: false, video: false, jsonMode: true, tools: true, stream: true };
          for (var k in capabilities) {
            if (Object.prototype.hasOwnProperty.call(capabilities, k)) nextCapabilities[k] = !!capabilities[k];
          }

          var nextModel = JSON.parse(JSON.stringify(modelEntry));
          nextModel.capabilities = nextCapabilities;

          var config = registry.getUserConfig();
          if (provider.builtin) {
            config.builtinModelOverrides = config.builtinModelOverrides || {};
            config.builtinModelOverrides[providerId] = _mergeModels(config.builtinModelOverrides[providerId] || [], [nextModel]);
          } else {
            config.customProviders = config.customProviders || [];
            var found = false;
            for (var i = 0; i < config.customProviders.length; i++) {
              if (config.customProviders[i].id === providerId) {
                config.customProviders[i].models = _mergeModels(config.customProviders[i].models || [], [nextModel]);
                found = true;
                break;
              }
            }
            if (!found) return Promise.resolve({ ok: false, error: 'Custom provider not found' });
          }
          return self.saveUserConfig(config).then(function (result) {
            if (!result || result.ok === false) return result || { ok: false, error: 'Save failed' };
            // 关闭的是视觉代理模型的视觉能力：视觉代理配置随之失效，同步清空
            if (nextCapabilities.vision === false && _state.globalSettings
              && _state.globalSettings.visionProviderId === providerId
              && _state.globalSettings.visionModelId === modelId) {
              var store2 = _getSettingsStore();
              if (store2 && typeof store2.setGlobalSettings === 'function') {
                return store2.setGlobalSettings({ visionProviderId: '', visionModelId: '' }).then(function (r) {
                  if (r === false) {
                    // 模型能力/视觉标记已保存，但视觉代理清理写失败——代理配置仍指向
                    // 一个已取消视觉的模型，重启后读图代理失效；.catch 只吞 reject 时，
                    // false 被当成功（回执 ok:true）。如实回执（模型能力本身已落盘）。
                    return { ok: false, error: AEI18n.t('模型设置已保存，但视觉代理配置清理失败（本地存储空间可能已满）') };
                  }
                  return _refreshGlobalSettings().then(function () { return result; });
                }).catch(function () { return result; });
              }
            }
            return result;
          });
        });
      },

      discoverModels: function (providerId, apiKey) {
        var registry = _getRegistry();
        if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });

        var provider = registry.getProvider(providerId);
        if (!provider) return Promise.resolve({ ok: false, error: 'Provider not found' });

        return this.discoverModelsFromProvider(provider, apiKey);
      },

      // 接受临时 provider 对象（不依赖已保存的 providerId），用于新增平台模式下获取模型
      discoverModelsFromProvider: function (provider, apiKey) {
        if (!provider) return Promise.resolve({ ok: false, error: 'Provider not provided' });
        _warnIfPublicHttpProvider(provider);

        var discovery = provider.modelDiscovery || {};
        if (discovery.enabled === false) {
          return Promise.resolve({ ok: false, error: AEI18n.t('该平台不支持模型发现') });
        }
        var discoveryEndpoint = discovery.endpoint || '/models';
        var modelsUrl = _joinUrl(provider.baseUrl, discoveryEndpoint);
        var headers = _makeHeaders(provider, apiKey);

        // 请求发起时快照递增序号——见 _discoverSeq 声明处注释
        var seq = ++_discoverSeq;

        _state.discoveryLoading = true;
        _state.discoveryError = null;
        _emit('discoveryStarted', {});

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, 30000);

        return fetch(modelsUrl, {
          method: 'GET',
          headers: headers,
          signal: controller.signal
        }).then(function (response) {
          if (!response.ok) {
            // 报错时带上实际请求 URL 与响应体，便于定位拼接/端点问题（如 Kimi 模型列表 404）
            return response.text().then(function (errText) {
              var detail = errText ? ' ' + errText.slice(0, 300) : '';
              throw new Error('HTTP ' + response.status + ' ' + modelsUrl + detail);
            });
          }
          return response.json();
        }).then(function (data) {
          // 响应体解析完成才清超时——头到达即清表会让 json() 停滞（代理
          // 缓冲挂起）时 30s 兜底失效，发现抽屉与 discoveryLoading 永卡
          clearTimeout(timeoutId);
          // 序号已前进（有更新的发现请求发起）→ 丢弃本次结果，不写
          // _state、不发事件（loading/error 状态归新请求所有）
          if (seq !== _discoverSeq) return { ok: false, stale: true };
          var models = _parseModelsFromResponse(data, provider);
          _state.discovery = models;
          _state.discoveryLoading = false;
          _emit('discoveryComplete', { models: models });
          return { ok: true, models: models };
        }).catch(function (err) {
          clearTimeout(timeoutId);
          // stale 请求的错误同样丢弃——不复位 loading、不写 error（新请求
          // 已接管这两个状态，旧错误覆盖会造成 UI 谎报）
          if (seq !== _discoverSeq) return { ok: false, stale: true };
          // 超时 abort 后 fetch 以 AbortError 拒绝，错误原文是英文
          //（'The user aborted a request.' 等）误导排查——判 signal.aborted /
          // err.name 映射为中文超时提示（对照 llmChannel「请求超时」文案风格）
          if (controller.signal.aborted || (err && err.name === 'AbortError')) {
            _state.discoveryLoading = false;
            _state.discoveryError = AEI18n.t('请求超时，模型列表在 30 秒内未返回');
            _emit('discoveryError', { error: _state.discoveryError });
            return { ok: false, error: _state.discoveryError };
          }
          _state.discoveryLoading = false;
          _state.discoveryError = err && err.message ? err.message : String(err);
          _emit('discoveryError', { error: _state.discoveryError });
          return { ok: false, error: _state.discoveryError };
        });
      },

      getProviderSelectedModel: function (providerId) {
        var registry = _getRegistry();
        return registry ? registry.getProviderSelectedModel(providerId) : null;
      },

      setProviderSelectedModel: function (providerId, modelId) {
        var registry = _getRegistry();
        if (!registry) return Promise.resolve({ ok: false, error: 'Registry not available' });
        // registry.setProviderSelectedModel 直接改 _userConfig 内存快照后异步保存，
        // 与其他 userConfig 写操作并发时同样存在覆盖窗口，一并入队串行化
        return _serializeConfigOp(function () {
          return registry.setProviderSelectedModel(providerId, modelId);
        });
      },

      testModel: function (providerId) {
        var registry = _getRegistry();
        var provider = registry ? registry.getProvider(providerId) : null;
        if (!provider) {
          return Promise.resolve({ ok: false, error: 'Provider not found' });
        }
        _warnIfPublicHttpProvider(provider);

        var selectedModelId = registry.getProviderSelectedModel(providerId);
        if (!selectedModelId && provider.models && provider.models.length > 0) {
          selectedModelId = provider.models[0].id;
        }
        if (!selectedModelId) {
          return Promise.resolve({ ok: false, error: 'No model selected' });
        }

        var apiKey = this.getProviderApiKey(providerId);
        if (!apiKey) {
          return Promise.resolve({ ok: false, error: 'API key not set' });
        }

        var protocolDefaultEndpoint = provider.protocol === 'anthropic-messages' ? '/v1/messages' : '/chat/completions';
        var endpoint = provider.endpoint || protocolDefaultEndpoint;
        var url = _joinUrl(provider.baseUrl, endpoint);
        var headers = _makeHeaders(provider, apiKey);

        var controller = new AbortController();
        var timeoutId = setTimeout(function () { controller.abort(); }, 30000);

        var body = {
          model: selectedModelId,
          messages: [{ role: 'user', content: 'Hi' }],
          stream: false,
          max_tokens: 5,
          maxTokens: 5
        };
        if (global.AE_LLM && global.AE_LLM.protocolAdapters && typeof global.AE_LLM.protocolAdapters.getAdapter === 'function') {
          var adapter = global.AE_LLM.protocolAdapters.getAdapter(provider.protocol || 'openai-compatible');
          if (adapter && typeof adapter.buildRequest === 'function') {
            body = adapter.buildRequest({
              provider: provider,
              model: selectedModelId,
              messages: [{ role: 'user', content: 'Hi' }],
              stream: false,
              maxTokens: 5
            });
          }
        }

        return fetch(url, {
          method: 'POST',
          headers: headers,
          signal: controller.signal,
          body: JSON.stringify(body)
        }).then(function (response) {
          if (!response.ok) {
            return response.text().then(function (errText) {
              throw new Error('HTTP ' + response.status + (errText ? ' ' + errText : ''));
            });
          }
          return response.json();
        }).then(function (data) {
          // 响应体解析完成才清超时——头到达即清表会让 json() 停滞（代理
          // 缓冲挂起）时 30s 兜底失效，测试 Promise 永挂、UI 永卡「正在测试模型...」
          clearTimeout(timeoutId);
          return { ok: true, result: 'Connection successful', model: selectedModelId };
        }).catch(function (err) {
          clearTimeout(timeoutId);
          // 超时 abort 后 fetch 以 AbortError 拒绝，错误原文是英文
          //（'The user aborted a request.' 等）误导排查——判 signal.aborted /
          // err.name 映射为中文超时提示（对照 llmChannel「请求超时」文案风格）
          if (controller.signal.aborted || (err && err.name === 'AbortError')) {
            return { ok: false, error: AEI18n.t('请求超时，模型在 30 秒内未响应'), model: selectedModelId };
          }
          var msg = err && err.message ? err.message : String(err);
          return { ok: false, error: msg, model: selectedModelId };
        });
      },

      importDiscoveredModel: function (providerId, model) {
        return this.addOrUpdateModel(providerId, model);
      },

      clearDiscovery: function () {
        _state.discovery = null;
        _state.discoveryError = null;
        _emit('discoveryCleared', {});
      }
    };
  }

  global.AE_LLM = global.AE_LLM || {};
  global.AE_LLM.createModelManagerController = createModelManagerController;
})(window);
