(function (global) {
    'use strict';
    function createSessionLoadingUi() {
        // ── 会话异步读取 loading 指示 ──
        // switchSession 异步加载会话期间在输入框顶部显示转圈，加载完成隐藏。
        // 隐藏带最小展示时长：异步读取可能仅几十毫秒，直接隐藏会闪烁。
        var sessionLoadingTimer = null;

        function getSessionLoadingEl() {
            return document.getElementById('aeAgentInputLoading');
        }

        function showSessionLoading(on) {
            var el = getSessionLoadingEl();
            if (!el) return;
            if (on) {
                if (sessionLoadingTimer) { clearTimeout(sessionLoadingTimer); sessionLoadingTimer = null; }
                el.classList.add('visible');
                el.setAttribute('aria-hidden', 'false');
            } else {
                if (sessionLoadingTimer) return;  // 已有隐藏计时，保持
                sessionLoadingTimer = setTimeout(function () {
                    sessionLoadingTimer = null;
                    el.classList.remove('visible');
                    el.setAttribute('aria-hidden', 'true');
                }, 350);
            }
        }

        return { getSessionLoadingEl: getSessionLoadingEl, showSessionLoading: showSessionLoading };
    }
    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createSessionLoadingUi = createSessionLoadingUi;
})(typeof global !== 'undefined' ? global : window);