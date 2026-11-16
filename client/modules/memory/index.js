(function (global) {
  var mounted = false;
  var controller = null;
  var view = null;
  // 在途 mount 的取消令牌：init 完成前 unmount（mounted 尚为 false 的早退窗口）
  // 置 cancelled，init 回调据此销毁 controller 而不再创建 view——否则 view 稍后
  // 照常创建并绑定 document/window 级监听，且永无人 destroy（审计）
  var pendingMount = null;

  var memoryModule = {
    id: 'memory',
    // getter：模块对象在文件加载时求值，翻译推迟到读取时
    get title() { return AEI18n.t('记忆管理'); },
    get description() { return AEI18n.t('持久化上下文记忆，支持增删改查搜索与 [[链接]]，按类型/作用域分类'); },
    panelId: 'memoryPanel',

    mount: function (containerContext) {
      if (mounted) return;

      // controller 挂到当前轮 mount 的取消令牌上——快速 unmount→remount
      // 竞态下旧令牌身份比较失败（pendingMount 已被新令牌替换）时，迟到的 init
      // 收尾只动模块级 controller 时（已被新一轮 mount 重写指向 controller2），
      // 旧 controller1 无人销毁泄漏；现按令牌销毁当前轮自己的 controller
      var token = { cancelled: false, controller: null };
      pendingMount = token;
      try {
        controller = global.AEMemory.createMemoryController(containerContext);
        token.controller = controller;

        controller.init().then(function () {
          // 当前轮 mount 已被 unmount 取消、或已被新一轮 mount 顶替（未取消但
          // pendingMount 已不是自己）：只销毁当前轮挂在令牌上的 controller；
          // 仍是当前令牌时同步清理模块级引用
          if (token.cancelled || pendingMount !== token) {
            if (token.controller && typeof token.controller.destroy === 'function') {
              token.controller.destroy();
            }
            if (pendingMount === token) {
              controller = null;
              pendingMount = null;
            }
            return;
          }
          var body = document.getElementById('memoryBody');
          if (body) {
            view = global.AEMemory.createMemoryView(controller, body);
            view.render();
          } else {
            console.error('[Memory] mount: #memoryBody not found in DOM');
          }

          mounted = true;
          console.log('[MemoryCtrl] mounted');
        }).catch(function (err) {
          console.error('[Memory] init failed:', err);
          // 被新一轮 mount 顶替的旧令牌迟到失败——不得清写新一轮的
          // 模块级状态（无条件 controller=null 会抹掉新一轮 controller2 的
          // 引用，使其视图创建断裂），只尽力销毁当前轮自己的 controller
          if (pendingMount !== token) {
            if (token.controller && typeof token.controller.destroy === 'function') {
              try { token.controller.destroy(); } catch (_) {}
            }
            return;
          }
          mounted = false;
          controller = null;
          view = null;
        });
      } catch (e) {
        console.error('[Memory] mount failed:', e);
        mounted = false;
        controller = null;
        view = null;
      }
    },

    showSettings: function () {
      var modalBody = document.querySelector('#settingsModal .modal-body');
      if (!modalBody) return;
      modalBody.innerHTML = AEI18n.html('<div id="memorySettingsContainer"><div class="btn-row"><button class="btn secondary" id="memoryAboutBtn">关于模块</button></div></div>');
      var aboutBtn = document.getElementById('memoryAboutBtn');
      if (aboutBtn) aboutBtn.addEventListener('click', function () {
        if (typeof showAboutModal === 'function') showAboutModal('module', { name: AEI18n.t('记忆模块'), desc: AEI18n.t('管理 LLM 对话记忆，类型分为经验/项目/偏好。支持 Script/Agent/Shader 模式规则，按模式注入 prompt。') });
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

      var panel = document.getElementById('memoryPanel');
      if (panel) panel.classList.add('hidden');
    }
  };

  global.AEModules = global.AEModules || {};
  global.AEModules.memoryModule = memoryModule;
})(window);
