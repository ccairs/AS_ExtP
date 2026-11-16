// toast.js — 全局面板级顶部提示（Agent 模块以外使用）
// 非 Agent 模块的轻量反馈：成功/错误/信息，顶部居中弹出，自动消失。
// 与 AENotice 区别：toast 无动作按钮、无进度，仅纯文本短反馈；
// Agent 模块内的内联状态条（agent/app/main.js 的 showStatus）保持不变。
// 支持堆叠：最多 5 条同时显示，超出时移除最早的一条。
(function (global) {
    var container = null;
    var children = [];

    function ensureContainer() {
        if (container && document.body.contains(container)) return container;
        container = document.createElement('div');
        container.className = 'ae-toast-container';
        container.setAttribute('role', 'status');
        container.setAttribute('aria-live', 'polite');
        document.body.appendChild(container);
        return container;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    var MAX_VISIBLE = 5;

    // show(message, type?, options?)
    //   type: 'success' | 'error' | 'info' | 'warn'（默认 'info'）
    //   options.autoHideMs: 自动消失时长，默认 success/info=2600，error/warn=4200；0=不自动消失
    function show(message, type, options) {
        var t = type || 'info';
        var opts = options || {};
        ensureContainer();

        // 音效反馈：success/error/warn/info 各有专属音效
        if (typeof global.aeBeep === 'function' && (t === 'success' || t === 'error' || t === 'warn' || t === 'info')) {
            global.aeBeep(t);
        }

        // 超出上限：移除最早的一条
        while (children.length >= MAX_VISIBLE) {
            removeChild(children[0]);
        }

        var node = document.createElement('div');
        node.className = 'ae-toast ae-toast-' + t + ' ae-toast-show';

        // `autoHideMs: 0`（常驻提醒，如迁移取消留下的安全警示）**不自动消失**
        // ——最多堆 5 条、只能刷新面板。常驻的用意是"不被错过"，所以不改成自动消失（会漏看），
        // 而是给一个显式关闭按钮：保留常驻语义，同时给用户逃生口。
        var ms = Number.isFinite(opts.autoHideMs) ? opts.autoHideMs : (t === 'error' || t === 'warn' ? 4200 : 2600);
        var persistent = !(ms > 0);
        node.innerHTML = '<span class="ae-toast-text">' + esc(message) + '</span>'
            + (persistent ? '<button class="ae-toast-close" type="button" title="' + AEI18n.t('关闭') + '" aria-label="' + AEI18n.t('关闭') + '">\u00d7</button>' : '');
        container.appendChild(node);

        var child = { node: node, timer: null };
        children.push(child);
        if (persistent) {
            var closeBtn = node.querySelector('.ae-toast-close');
            if (closeBtn) {
                closeBtn.addEventListener('click', function (e) {
                    if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                    removeChild(child);
                });
            }
        }
        if (ms > 0) {
            child.timer = setTimeout(function () { removeChild(child); }, ms);
        }

        return { close: function () { removeChild(child); } };
    }

    function removeChild(child) {
        var idx = children.indexOf(child);
        if (idx === -1) return;
        children.splice(idx, 1);
        if (child.timer) { clearTimeout(child.timer); child.timer = null; }
        var node = child.node;
        if (!node || !node.parentNode) return;
        node.classList.remove('ae-toast-show');
        node.classList.add('ae-toast-leaving');
        setTimeout(function () {
            if (node.parentNode) node.parentNode.removeChild(node);
        }, 200);
    }

    function hide() {
        // 逐个移除（从后往前，避免 splice 索引错乱）
        while (children.length) {
            removeChild(children[children.length - 1]);
        }
    }

    global.AEToast = {
        show: show,
        hide: hide,
        success: function (m, o) { return show(m, 'success', o); },
        error: function (m, o) { return show(m, 'error', o); },
        info: function (m, o) { return show(m, 'info', o); },
        warn: function (m, o) { return show(m, 'warn', o); }
    };
})(typeof window !== 'undefined' ? window : this);
