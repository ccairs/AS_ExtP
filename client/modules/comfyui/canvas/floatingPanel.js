(function (global) {
    global.AEComfyUI = global.AEComfyUI || {};

    // 悬浮 LLM 面板：可拖拽小方块，点击展开聊天面板。
    // 挂在 panelRoot（#nodegenPanel）下，非 ngWorld 子节点——免受画布 pan/zoom transform 影响。
    // 展开态：头栏中间对称构图（左清空 · 中收起 · 右模型），收起钮与未展开悬浮球位置对齐。
    // 可拖拽 + 右下角可调整大小，尺寸持久化到 localStorage，拖拽/缩放均约束在 panelRoot 内。
    // opts: { panelRoot, getModelLabel(), onClearChat() }
    //   返回方法：expand/collapse/appendMsg/streamToMsg/getInput/clearInput/setBusy/
    //            updateModelLabel/destroy。发送/停止由 index.js 直连 DOM（_wirePanelInput）。
    function createFloatingPanel(opts) {
        opts = opts || {};
        var panelRoot = opts.panelRoot;
        var TOPBAR_H = 38;          // 顶栏高度 + 间距，悬浮面板不得进入此区域
        var MIN_W = 260, MIN_H = 320;
        var HEAD_ANCHOR_Y = 18;     // 收起钮距面板顶部约 18px（头栏垂直中心），用于与球对齐
        var SIZE_KEY = 'ng-float-size-v1';

        var box = document.createElement('div');
        box.className = 'ng-float ng-float-collapsed';
        // 默认位置：顶栏下方右侧，避免被顶栏遮挡
        box.style.top = TOPBAR_H + 'px';
        box.style.right = '16px';
        box.innerHTML =
            AEI18n.html('<div class="ng-float-handle" title="AI 助手 · 拖拽移动 · 点击展开">✦</div>');
        panelRoot.appendChild(box);

        var expandedEl = null;

        function buildExpanded() {
            var el = document.createElement('div');
            el.className = 'ng-float-expanded ng-hidden';
            // 头栏：左清空 · 中收起 · 右模型（绝对定位贴边，收起钮居中 → 中间对称）
            el.innerHTML =
                '<div class="ng-float-head">' +
                  AEI18n.html('<span class="ng-float-clear-chat" title="清空对话">🗑</span>') +
                  AEI18n.html('<span class="ng-float-close" title="收起">收起</span>') +
                  AEI18n.html('<span class="ng-float-model" title="当前模型">…</span>') +
                '</div>' +
                '<div class="ng-float-body">' +
                  '<div class="ng-float-msgs"></div>' +
                  '<div class="ng-float-input-row">' +
                    AEI18n.html('<textarea class="ng-float-input" placeholder="让 AI 帮你写提示词…"></textarea>') +
                    AEI18n.html('<button class="btn run ng-float-send">发送</button>') +
                    AEI18n.html('<button class="btn btn-slice ng-float-stop ng-hidden">停止</button>') +
                  '</div>' +
                '</div>' +
                AEI18n.html('<div class="ng-float-resize" title="拖拽调整大小"></div>');
            panelRoot.appendChild(el);
            return el;
        }

        expandedEl = buildExpanded();

        // ── 尺寸持久化 ──
        function loadSize() {
            try {
                var raw = localStorage.getItem(SIZE_KEY);
                if (!raw) return null;
                var s = JSON.parse(raw);
                if (s && s.w && s.h) return { w: s.w, h: s.h };
            } catch (_) {}
            return null;
        }
        function saveSize(w, h) {
            try { localStorage.setItem(SIZE_KEY, JSON.stringify({ w: w, h: h })); } catch (_) {}
        }
        function applySize(w, h) {
            expandedEl.style.width = Math.max(MIN_W, w) + 'px';
            expandedEl.style.height = Math.max(MIN_H, h) + 'px';
        }

        function clampLeft(left, panelW, pr) {
            return Math.max(4, Math.min(left, pr.width - panelW - 4));
        }
        function clampTop(top, panelH, pr) {
            return Math.max(TOPBAR_H, Math.min(top, pr.height - panelH - 4));
        }
        // 尺寸钳制：下限 MIN_W/MIN_H，上限不超过 panelRoot 可用区（留 4px 边距 + 顶栏），
        // 否则持久化的大尺寸或默认 560 高在小面板上会溢出，右下 resize 手柄跑到可视区外无法触发。
        function clampSize(w, h, pr) {
            var maxW = Math.max(MIN_W, pr.width - 8);
            var maxH = Math.max(MIN_H, pr.height - TOPBAR_H - 4);
            return { w: Math.max(MIN_W, Math.min(w, maxW)), h: Math.max(MIN_H, Math.min(h, maxH)) };
        }

        // ── 折叠/展开 ──
        // 以悬浮球为中心展开：收起钮（头栏中心）对齐球的中心，配合融球出场动画。
        // 收起时球回到收起钮的位置——视觉上球 ↔ 收起钮互换，对称。
        function expand() {
            var br = box.getBoundingClientRect();
            var bw = br.width || 42, bh = br.height || 42;
            box.classList.add('ng-hidden');
            expandedEl.classList.remove('ng-hidden');
            // 应用尺寸：持久化 or 默认（窄而高），均钳制到 panelRoot 可用区
            var pr0 = panelRoot.getBoundingClientRect();
            var saved = loadSize();
            var sized = saved
                ? clampSize(saved.w, saved.h, pr0)
                : clampSize(300, Math.max(560, Math.round(pr0.height * 0.82)), pr0);
            applySize(sized.w, sized.h);
            var pr = panelRoot.getBoundingClientRect();
            var panelW = expandedEl.offsetWidth;
            var panelH = expandedEl.offsetHeight;
            var cx = (br.left - pr.left) + bw / 2;
            var cy = (br.top - pr.top) + bh / 2;
            // 收起钮在面板顶部 HEAD_ANCHOR_Y 处 → 面板 top = cy - HEAD_ANCHOR_Y 让钮对齐球心
            var left = clampLeft(cx - panelW / 2, panelW, pr);
            var top = clampTop(cy - HEAD_ANCHOR_Y, panelH, pr);
            expandedEl.style.left = left + 'px';
            expandedEl.style.top = top + 'px';
            expandedEl.style.right = 'auto';
            expandedEl.style.bottom = 'auto';
            // 融球出场动画
            expandedEl.classList.add('ng-float-blob-in');
            expandedEl.addEventListener('animationend', function _onBlobEnd() {
                expandedEl.classList.remove('ng-float-blob-in');
                expandedEl.removeEventListener('animationend', _onBlobEnd);
            });
            updateModelLabel();
        }
        function collapse() {
            // 球回到收起钮当前位置（头栏中心），与 expand 对称
            var pr = panelRoot.getBoundingClientRect();
            var closeEl = expandedEl.querySelector('.ng-float-close');
            var cr = closeEl.getBoundingClientRect();
            var bw = box.offsetWidth || 42, bh = box.offsetHeight || 42;
            var cx = (cr.left + cr.width / 2) - pr.left;
            var cy = (cr.top + cr.height / 2) - pr.top;
            var newLeft = Math.max(0, Math.min(cx - bw / 2, pr.width - bw - 4));
            var newTop = Math.max(TOPBAR_H, Math.min(cy - bh / 2, pr.height - bh - 4));
            box.style.left = newLeft + 'px';
            box.style.top = newTop + 'px';
            box.style.right = 'auto';
            box.style.bottom = 'auto';
            expandedEl.classList.add('ng-hidden');
            box.classList.remove('ng-hidden');
        }
        expandedEl.addEventListener('click', function (e) {
            if (e.target.classList.contains('ng-float-close')) collapse();
            if (e.target.classList.contains('ng-float-clear-chat') && typeof opts.onClearChat === 'function') {
                // 清空对话会立即经 _schedulePanelSave 覆盖落盘 nodegen_panel.json，不可恢复——
                // 先经全局 showConfirm（danger）确认；降级按本模块既有写法（canvasIndex 删除
                // 画布同款）：showConfirm 缺席（极老环境）不弹直接执行。
                if (typeof global.showConfirm !== 'function') {
                    opts.onClearChat();
                    return;
                }
                global.showConfirm(AEI18n.t('清空对话'), AEI18n.t('将永久删除该面板的全部对话记录（不可恢复），确定？'), 'danger')
                    .then(function (ok) {
                        if (ok) opts.onClearChat();
                    });
            }
        });

        // ── 拖拽（折叠态拖球，展开态拖 head），约束在 panelRoot 内不溢出 ──
        function bindDrag(dragHandle, target, onClick) {
            dragHandle.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                if (e.target.classList.contains('ng-float-close') ||
                    e.target.classList.contains('ng-float-clear-chat')) return;
                var tr = target.getBoundingClientRect();
                var pr = panelRoot.getBoundingClientRect();
                var startLeft = tr.left - pr.left;
                var startTop = tr.top - pr.top;
                target.style.left = startLeft + 'px';
                target.style.top = startTop + 'px';
                target.style.right = 'auto';
                target.style.bottom = 'auto';
                var startX = e.clientX, startY = e.clientY, moved = false;
                function onMove(ev) {
                    if (!moved) {
                        if (Math.abs(ev.clientX - startX) < 3 && Math.abs(ev.clientY - startY) < 3) return;
                        moved = true;
                    }
                    var tw = target.offsetWidth, th = target.offsetHeight;
                    var nl = Math.max(0, Math.min(startLeft + ev.clientX - startX, pr.width - tw - 4));
                    var nt = Math.max(TOPBAR_H, Math.min(startTop + ev.clientY - startY, pr.height - th - 4));
                    target.style.left = nl + 'px';
                    target.style.top = nt + 'px';
                }
                function onUp() {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    if (!moved && onClick) onClick();
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });
        }
        bindDrag(box, box, expand);  // 折叠方块：单击展开，拖拽移动
        bindDrag(expandedEl.querySelector('.ng-float-head'), expandedEl);

        // ── 右下角调整大小 ──
        function bindResize() {
            var handle = expandedEl.querySelector('.ng-float-resize');
            if (!handle) return;
            handle.addEventListener('mousedown', function (e) {
                if (e.button !== 0) return;
                e.preventDefault();
                e.stopPropagation();
                var pr = panelRoot.getBoundingClientRect();
                var rect = expandedEl.getBoundingClientRect();
                var startW = expandedEl.offsetWidth;
                var startH = expandedEl.offsetHeight;
                var startX = e.clientX, startY = e.clientY;
                // 右下角拖：宽高同步增减，但不溢出 panelRoot 右下边界
                var maxW = pr.right - rect.left - 4;
                var maxH = pr.bottom - rect.top - 4;
                function onMove(ev) {
                    var nw = Math.max(MIN_W, Math.min(startW + (ev.clientX - startX), maxW));
                    var nh = Math.max(MIN_H, Math.min(startH + (ev.clientY - startY), maxH));
                    applySize(nw, nh);
                }
                function onUp() {
                    window.removeEventListener('mousemove', onMove);
                    window.removeEventListener('mouseup', onUp);
                    saveSize(expandedEl.offsetWidth, expandedEl.offsetHeight);
                }
                window.addEventListener('mousemove', onMove);
                window.addEventListener('mouseup', onUp);
            });
        }
        bindResize();

        // ── 聊天 API ──
        function appendMsg(role, text) {
            var msgs = expandedEl.querySelector('.ng-float-msgs');
            var div = document.createElement('div');
            div.className = 'ng-float-msg ng-float-msg-' + role;
            div.textContent = text;
            msgs.appendChild(div);
            msgs.scrollTop = msgs.scrollHeight;
            return div;
        }
        function streamToMsg(div, token) {
            div.textContent = (div.textContent || '') + token;
            var msgs = expandedEl.querySelector('.ng-float-msgs');
            msgs.scrollTop = msgs.scrollHeight;
        }
        function getInput() { return expandedEl.querySelector('.ng-float-input').value; }
        function clearInput() { expandedEl.querySelector('.ng-float-input').value = ''; }
        // busy 标志与发送/停止按钮显隐在同一处维护：供 _sendPanelChat 入口
        // 守卫查询——生成中（busy）textarea 仍可输入，Enter 仍会触发发送，须拦住第
        // 二个并发 chat 循环（两路 onToken 共享同一条流式消息节点，文字交错拼进）。
        var _busy = false;
        function setBusy(busy) {
            _busy = !!busy;
            expandedEl.querySelector('.ng-float-send').classList.toggle('ng-hidden', busy);
            expandedEl.querySelector('.ng-float-stop').classList.toggle('ng-hidden', !busy);
        }
        function isBusy() { return _busy; }

        function updateModelLabel() {
            var el = expandedEl.querySelector('.ng-float-model');
            if (el && typeof opts.getModelLabel === 'function') el.textContent = opts.getModelLabel();
        }

        function destroy() {
            if (box.parentNode) box.parentNode.removeChild(box);
            if (expandedEl.parentNode) expandedEl.parentNode.removeChild(expandedEl);
        }

        return {
            expand: expand,
            collapse: collapse,
            appendMsg: appendMsg,
            streamToMsg: streamToMsg,
            getInput: getInput,
            clearInput: clearInput,
            setBusy: setBusy,
            isBusy: isBusy,
            updateModelLabel: updateModelLabel,
            destroy: destroy,
            _box: box,
            _expandedEl: expandedEl
        };
    }

    global.AEComfyUI.createFloatingPanel = createFloatingPanel;
})(window);
