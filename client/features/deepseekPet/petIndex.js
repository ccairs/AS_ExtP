// petIndex.js — 桌宠入口，挂载 global.AEDeepseekPet.bootstrap
(function (global) {
    'use strict';

    var _controller = null;
    var _settings = null;  // 提到 IIFE 顶层，_onSettingsReady 可访问
    var _easterEgg = null;  // 彩蛋实例，enableDeepseekPet=true 时 destroy 卸载

    function bootstrap() {
        // 彩蛋监听器必须同步立即挂载：main.js 的 bindHomeEvents 已先于本函数同步挂载
        // saveBtn 的 click handler（冒泡阶段），若等 settingsStore.getGlobalSettings 异步
        // resolve 后才挂载，会有时间窗口让"大肥鱼"被当作真实 dataDir 走完 AEFS 校验流程。
        // 同步挂载后，捕获阶段的 _checkEasterEgg 可通过 stopImmediatePropagation 拦截冒泡 handler。
        _initEasterEgg();

        try {
            if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
                var ctx = global.AEAppContainer.getContext();
                if (ctx && ctx.settingsStore && typeof ctx.settingsStore.getGlobalSettings === 'function') {
                    ctx.settingsStore.getGlobalSettings({ enableDeepseekPet: false }).then(function (s) {
                        _settings = s || {};
                        _onSettingsReady();
                    }).catch(function (e) {
                        // settingsStore reject 时回退到默认空设置，避免桌宠永不启动
                        console.warn('[DeepseekPet] getGlobalSettings rejected: ' + e);
                        _settings = {};
                        _onSettingsReady();
                    });
                    return;
                }
            }
        } catch (e) {
            console.warn('[DeepseekPet] settings load failed: ' + e);
        }
        _settings = {};
        _onSettingsReady();
    }

    function _onSettingsReady() {
        if (!_settings || !_settings.enableDeepseekPet) {
            // 未启用桌宠：保留已挂载的彩蛋监听器等待"大肥鱼"触发
            return;
        }
        // 已启用桌宠：彩蛋已无用，主动 destroy 卸载监听器避免内存泄漏
        _destroyEasterEgg();
        _startPet();
    }

    function _initEasterEgg() {
        if (_easterEgg) return;  // 防重入
        if (global.AEDeepseekPet.createEasterEgg) {
            _easterEgg = global.AEDeepseekPet.createEasterEgg();
            _easterEgg.init(function () {
                location.reload();
            });
        }
    }

    function _destroyEasterEgg() {
        if (_easterEgg && typeof _easterEgg.destroy === 'function') {
            try { _easterEgg.destroy(); } catch (e) {}
        }
        _easterEgg = null;
    }

    function _startPet() {
        if (_controller) return;
        _controller = global.AEDeepseekPet.createController();
        _controller.init();
        global.AEDeepseekPet.controller = _controller;
        global.AEDeepseekPet.api = _controller.getPetApi();

        _initSettingsButton();
    }

    function _initSettingsButton() {
        var btn = document.getElementById('openPetSettingsBtn');
        if (!btn) return;
        // HTML hidden 属性的 UA 样式 [hidden]{display:none} 优先级高于 inline style.display='',
        // 必须通过移除 hidden 属性才能让按钮可见（CEP Chrome 88 行为对齐）
        btn.hidden = false;
        btn.removeAttribute('hidden');
        btn.addEventListener('click', function () {
            if (global.AEDeepseekPet.settings && global.AEDeepseekPet.settings.openModal) {
                global.AEDeepseekPet.settings.openModal();
            }
        });
    }

    // 面板卸载前落盘（main.js beforeunload 调用，与 engine/bootstrap.js 的
    // sessionStore.flush 接线同风格）：桌宠未启用/控制器未建时无操作。
    // 内部逐库 flush 优先 AEFS 同步写通道（writeFileSync→renameFileSync，
    // Bridge 同步 XHR/cep.fs 原生同步调用，beforeunload 内可完成）；同步通道不可用时
    // 各库回落异步写，能否在卸载窗口内完成取决于异步通道（边界见各库 flush 注释）
    function flush() {
        if (_controller && typeof _controller.flush === 'function') {
            try {
                return _controller.flush();
            } catch (e) {
                console.warn('[DeepseekPet] flush failed: ' + (e && e.message ? e.message : e));
                return false;
            }
        }
        return false;
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.bootstrap = bootstrap;
    global.AEDeepseekPet.getController = function () { return _controller; };
    global.AEDeepseekPet.flush = flush;
})(window);
