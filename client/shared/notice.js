// notice.js — 公用提示卡片（主面板底部弹出，非阻断，带动作按钮）
// 供主面板向用户发消息 / 征询选择用。多张可堆叠，同 id 只保留一张。
// 调用：showNotice({ id, icon, title, message, tone, dismissible, actions, onClose })
(function (global) {
    var stackEl = null;
    var cards = {}; // id -> { el, onClose }

    function ensureStack() {
        if (stackEl && document.body.contains(stackEl)) return stackEl;
        stackEl = document.createElement('div');
        stackEl.className = 'notice-stack';
        document.body.appendChild(stackEl);
        return stackEl;
    }

    // 转义 innerHTML 安全文本（notice 的 title/message 进 innerHTML）
    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /**
     * 显示一张提示卡片。
     * @param {object} opts
     *   - id: string 唯一标识，同 id 先移除旧卡（防重复）
     *   - icon: string 图标（emoji/文本）
     *   - title: string 标题
     *   - message: string 正文（支持 <code> 标签，其余转义）
     *   - tone: 'info'|'success'|'warn'|'error' 决定左边框色
     *   - dismissible: boolean 是否显示右上角 ×（默认 true）
     *   - actions: [{label, type:'primary'|'secondary', keepOpen, onClick}]
     *       点击按钮默认关闭卡片并触发 onClose，除非 keepOpen:true
     *   - onClose: function(optionalResult) 卡片关闭时回调；按钮触发会传入 {action:label}
     * @returns {object} card 控制句柄 { close }，未渲染成功返回 null
     */
    function showNotice(opts) {
        opts = opts || {};
        var id = opts.id || ('notice_' + Date.now() + '_' + Math.random().toString(36).slice(2));
        if (cards[id]) {
            closeNotice(id, null, true);
        }

        var stack = ensureStack();
        if (!stack) return null;

        var card = document.createElement('div');
        card.className = 'notice-card';
        var tone = opts.tone || 'info';
        if (tone !== 'info') card.className += ' notice-' + tone;
        card.setAttribute('data-notice-id', id);

        var html = '<div class="notice-head">';
        if (opts.icon) html += '<span class="notice-icon">' + esc(opts.icon) + '</span>';
        html += '<span class="notice-title">' + esc(opts.title || '') + '</span>';
        if (opts.dismissible !== false) {
            html += '<button class="notice-close" data-notice-act="close" title="' + AEI18n.t('关闭') + '">&times;</button>';
        }
        html += '</div>';
        if (opts.message) {
            // 允许 <code>...</code> 标签，其余先转义再放回 code
            var safe = esc(opts.message).replace(/&lt;code&gt;/g, '<code>').replace(/&lt;\/code&gt;/g, '</code>');
            html += '<div class="notice-body">' + safe + '</div>';
        }
        if (opts.progress !== undefined && opts.progress !== null) {
            var pct = Math.max(0, Math.min(100, Math.round(Number(opts.progress) || 0)));
            html += '<div class="notice-progress"><div class="notice-progress-bar" style="width:' + pct + '%"></div></div>';
            if (opts.progressLabel) {
                html += '<div class="notice-progress-label">' + esc(opts.progressLabel) + '</div>';
            }
        }
        if (opts.actions && opts.actions.length) {
            html += '<div class="notice-actions">';
            for (var i = 0; i < opts.actions.length; i++) {
                var a = opts.actions[i];
                var cls = (a.type === 'secondary') ? 'btn secondary' : 'btn';
                html += '<button class="' + cls + '" data-notice-act="' + esc(a.label) + '">' + esc(a.label) + '</button>';
            }
            html += '</div>';
        }
        card.innerHTML = html;

        // 事件代理
        card.addEventListener('click', function (ev) {
            var btn = ev.target.closest('[data-notice-act]');
            if (!btn) return;
            var act = btn.getAttribute('data-notice-act');
            if (act === 'close') {
                closeNotice(id, null, false);
                return;
            }
            // 动作按钮
            var matched = null;
            if (opts.actions) {
                for (var k = 0; k < opts.actions.length; k++) {
                    if (opts.actions[k].label === act) { matched = opts.actions[k]; break; }
                }
            }
            if (!matched) return;
            try { if (matched.onClick) matched.onClick(); } catch (e) { /* 忽略回调异常 */ }
            if (!matched.keepOpen) {
                closeNotice(id, { action: act }, false);
            }
        });

        stack.appendChild(card);
        cards[id] = { el: card, onClose: opts.onClose || null };
        return { id: id, close: function (result) { closeNotice(id, result, false); } };
    }

    function closeNotice(id, result, silent) {
        var entry = cards[id];
        if (!entry) return;
        delete cards[id];
        var el = entry.el;
        el.classList.add('notice-leaving');
        setTimeout(function () {
            if (el.parentNode) el.parentNode.removeChild(el);
            // 空了移除 stack
            if (stackEl && !stackEl.children.length) {
                if (stackEl.parentNode) stackEl.parentNode.removeChild(stackEl);
                stackEl = null;
            }
        }, 200);
        if (!silent && entry.onClose) {
            try { entry.onClose(result || null); } catch (e) { /* 忽略 */ }
        }
    }

    // 就地更新已存在的卡片内容（消息/进度条/进度标签）。卡片不存在则忽略。
    function updateNotice(id, opts) {
        var entry = cards[id];
        if (!entry || !entry.el) return;
        var el = entry.el;
        if (opts && opts.message !== undefined) {
            var body = el.querySelector('.notice-body');
            if (body) {
                var safe = esc(opts.message).replace(/&lt;code&gt;/g, '<code>').replace(/&lt;\/code&gt;/g, '</code>');
                body.innerHTML = safe;
            }
        }
        if (opts && opts.progress !== undefined) {
            if (opts.progress === null) {
                // 显式清除进度条与标签（如 PSD 转 PNG 阶段结束后切回纯文本阶段）
                var progEl = el.querySelector('.notice-progress');
                if (progEl) progEl.remove();
                var labEl = el.querySelector('.notice-progress-label');
                if (labEl) labEl.remove();
            } else {
                var pct = Math.max(0, Math.min(100, Math.round(Number(opts.progress) || 0)));
                var bar = el.querySelector('.notice-progress-bar');
                if (bar) {
                    bar.style.width = pct + '%';
                } else {
                    // 卡片原本没有进度条，插入一条
                    var prog = document.createElement('div');
                    prog.className = 'notice-progress';
                    prog.innerHTML = '<div class="notice-progress-bar" style="width:' + pct + '%"></div>';
                    entry.el.appendChild(prog);
                }
            }
        }
        if (opts && opts.progressLabel !== undefined) {
            if (opts.progressLabel === null) {
                var labRm = el.querySelector('.notice-progress-label');
                if (labRm) labRm.remove();
            } else {
                var label = el.querySelector('.notice-progress-label');
                if (label) {
                    label.textContent = opts.progressLabel;
                } else if (opts.progressLabel) {
                    var lab = document.createElement('div');
                    lab.className = 'notice-progress-label';
                    lab.textContent = opts.progressLabel;
                    entry.el.appendChild(lab);
                }
            }
        }
    }

    function closeAllNotices() {
        var ids = [];
        for (var k in cards) { if (cards.hasOwnProperty(k)) ids.push(k); }
        for (var i = 0; i < ids.length; i++) closeNotice(ids[i], null, true);
    }

    function isNoticeOpen(id) {
        return !!cards[id];
    }

    global.AENotice = {
        show: showNotice,
        update: updateNotice,
        close: function (id) { closeNotice(id, null, false); },
        closeAll: closeAllNotices,
        isOpen: isNoticeOpen
    };
})(typeof window !== 'undefined' ? window : this);
