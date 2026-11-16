(function (global) {
  var mounted = false;
  var controller = null;
  var view = null;
  // 在途 mount 的取消令牌：init 完成前 unmount（mounted 尚为 false 的早退窗口）
  // 置 cancelled，init 回调据此销毁 controller 而不再创建 view——否则 view 稍后
  // 照常创建并绑定 document/window 级监听，且永无人 destroy（审计）
  var pendingMount = null;

  var modelManagerModule = {
    id: 'model-manager',
    // 读取时才翻译：本文件会整份加载进无 AEI18n 的沙箱，顶层求值会抛 ReferenceError
    get title() { return AEI18n.t('模型管理'); },
    // 与 title 同：读取时才翻译，避免无 AEI18n 的沙箱在顶层求值
    get description() { return AEI18n.t('管理 LLM 平台、API Key、模型列表与能力标记'); },
    panelId: 'modelManagerPanel',

    mount: function (containerContext) {
      if (mounted) return;

      var token = { cancelled: false };
      pendingMount = token;
      try {
        controller = global.AE_LLM.createModelManagerController(containerContext);

        controller.init().then(function () {
          if (token.cancelled) {
            // 当前轮 mount 已被 unmount 取消：销毁 controller；若期间已 remount
            //（pendingMount 被新令牌替换），新 mount 自行管理生命周期，当前轮静默退出
            if (pendingMount === token) {
              if (controller && typeof controller.destroy === 'function') {
                controller.destroy();
              }
              controller = null;
              pendingMount = null;
            }
            return;
          }
          var body = document.getElementById('modelManagerBody');
          if (body) {
            view = global.AE_LLM.createModelManagerView(controller, body);
            view.render();
          } else {
            console.error('[ModelManager] mount: #modelManagerBody not found in DOM');
          }

          mounted = true;
          console.log('[ModelManager] mounted');
        }).catch(function (err) {
          console.error('[ModelManager] init failed:', err);
          mounted = false;
          controller = null;
          view = null;
        });
      } catch (e) {
        console.error('[ModelManager] mount failed:', e);
        mounted = false;
        controller = null;
        view = null;
      }
    },

    showSettings: function () {
      var modalBody = document.querySelector('#settingsModal .modal-body');
      if (!modalBody) return;
      modalBody.innerHTML = AEI18n.html('<div id="modelManagerSettings"><div class="btn-row"><button class="btn secondary" id="modelManagerAboutBtn">关于模块</button></div></div>');
      var aboutBtn = document.getElementById('modelManagerAboutBtn');
      if (aboutBtn) aboutBtn.addEventListener('click', function () {
        if (typeof showAboutModal === 'function') showAboutModal('module', {
          name: AEI18n.t('模型管理'),
          desc: AEI18n.t('管理 LLM 平台配置、API Key、模型列表与能力标记。支持从 OpenAI 兼容接口自动发现模型。')
        });
      });
      if (typeof openModal === 'function') openModal('settingsModal');
    },

    unmount: function () {
      if (!mounted) {
        // init 在途的早退窗口：置取消令牌，让 init 回调走销毁路径
        //（mount 从未发生 / init 已失败时 controller 为 null，此处无副作用）
        if (pendingMount) pendingMount.cancelled = true;
        return;
      }
      mounted = false;

      if (view && typeof view.destroy === 'function') {
        view.destroy();
      }
      view = null;

      if (controller && typeof controller.destroy === 'function') {
        controller.destroy();
      }
      controller = null;

      var panel = document.getElementById('modelManagerPanel');
      if (panel) panel.classList.add('hidden');
    }
  };

  global.AEModules = global.AEModules || {};
  global.AEModules.modelManagerModule = modelManagerModule;
})(window);
