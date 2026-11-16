// 反思审阅面板（/reflect 经验草稿审阅 UI）
// 从 app/main.js 拆出：
//   - 依赖 window.AEMemory.getMemoryRegistry()（运行时查询）
//   - 依赖 window.AEEngine.bridge.clearReflectDrafts()（运行时查询）
(function (global) {
    // 关闭回调：由 renderMessages 钩子传入，关闭时通知钩子把渲染来源消息记为已关闭。
    var _onClosed = null;
    // 渲染器
    function renderReflectReviewPanel(memories, opts) {
        // 面板已打开时跳过重建：renderMessages 会因后台任务（injectSystemResult →
        // syncView 等）在审阅期间反复触发本渲染，无条件 remove+重建会丢掉用户已
        // 编辑的草稿输入。跳过时也不更新关闭回调，保证回调对应实际渲染来源的消息。
        if (document.querySelector('.reflect-review-panel')) return;
        _onClosed = (opts && typeof opts.onClose === 'function') ? opts.onClose : null;
        function escHtml(str) {
            var d = document.createElement('div');
            d.textContent = str || '';
            // textContent→innerHTML 只转义 & < >；本面板会把结果拼进双引号
            // value="..." 属性，必须额外转义引号，防止注入 onfocus/autofocus 等事件属性
            return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        }

        // 移除已有面板
        var existingPanel = document.querySelector('.reflect-review-panel');
        var existingOverlay = document.querySelector('.reflect-overlay');
        if (existingPanel) existingPanel.remove();
        if (existingOverlay) existingOverlay.remove();

        // 注入面板样式（仅一次）
        if (!document.getElementById('reflect-review-style')) {
            var styleEl = document.createElement('style');
            styleEl.id = 'reflect-review-style';
            styleEl.textContent =
                '.reflect-overlay {position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,0.5);}' +
                '.reflect-review-panel {' +
                    'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:10000;' +
                    'width:560px;max-height:80vh;display:flex;flex-direction:column;overflow:hidden;' +
                    'background:#1e222a;border:1px solid #353a44;border-radius:8px;' +
                    'box-shadow:0 8px 32px rgba(0,0,0,0.5);' +
                '}' +
                /* 固定头部：标题 + 关闭按钮不随列表滚动 */
                '.reflect-panel-head {' +
                    'position:relative;flex-shrink:0;padding:16px 52px 12px 20px;' +
                    'border-bottom:1px solid #353a44;background:#1e222a;' +
                '}' +
                '.reflect-review-panel h3 {margin:0;color:#f0f2f5;font-size:16px;font-weight:600;}' +
                '.reflect-panel-body {flex:1;overflow-y:auto;padding:16px 20px 20px;}' +
                '.reflect-close {' +
                    'position:absolute;top:12px;right:16px;' +
                    'background:none;border:none;color:#8b949e;font-size:20px;cursor:pointer;line-height:1;' +
                '}' +
                '.reflect-close:hover {color:#f0f2f5;}' +
                /* 卡片：头部（名称/描述/箭头）可点击展开收起，展开显示表单 */
                '.reflect-card {' +
                    'background:rgba(24,30,36,0.8);border:1px solid #353a44;border-radius:6px;' +
                    'margin-bottom:10px;overflow:hidden;' +
                '}' +
                '.reflect-card-head {' +
                    'display:flex;align-items:center;gap:10px;padding:12px 14px;cursor:pointer;user-select:none;' +
                '}' +
                '.reflect-card-head:hover {background:rgba(255,255,255,0.03);}' +
                '.reflect-card-name {' +
                    'flex:0 1 auto;max-width:42%;font-weight:600;color:#f0f2f5;font-size:13px;' +
                    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
                '}' +
                '.reflect-card-desc {' +
                    'flex:1;min-width:0;color:#8b949e;font-size:12px;' +
                    'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
                '}' +
                '.reflect-card-toggle {flex-shrink:0;color:#8b949e;font-size:12px;transition:transform .2s ease;}' +
                '.reflect-card.open .reflect-card-toggle {transform:rotate(180deg);}' +
                '.reflect-card-body {display:none;padding:14px;border-top:1px solid rgba(53,58,68,0.6);}' +
                '.reflect-card.open .reflect-card-body {display:block;}' +
                '.reflect-card label {display:block;margin-bottom:8px;color:#a0a5b0;font-size:13px;}' +
                '.reflect-card input,.reflect-card textarea,.reflect-card select {' +
                    'width:100%;box-sizing:border-box;background:#13161c;border:1px solid #353a44;' +
                    'border-radius:4px;color:#e0e3e8;padding:6px 8px;font-size:13px;font-family:inherit;' +
                '}' +
                '.reflect-card textarea {resize:vertical;}' +
                '.reflect-card-actions {' +
                    'display:flex;gap:8px;margin-top:12px;padding-top:12px;' +
                    'border-top:1px solid rgba(53,58,68,0.4);' +
                '}' +
                '.reflect-confirm {' +
                    'background:#fbbf24;color:#1a1e24;border:none;border-radius:4px;' +
                    'padding:6px 16px;font-size:13px;cursor:pointer;font-weight:600;' +
                '}' +
                '.reflect-confirm:hover {background:#f59e0b;}' +
                '.reflect-skip {' +
                    'background:transparent;color:#8b949e;border:1px solid #353a44;border-radius:4px;' +
                    'padding:6px 16px;font-size:13px;cursor:pointer;' +
                '}' +
                '.reflect-skip:hover {color:#f0f2f5;border-color:#8b949e;}';
            document.head.appendChild(styleEl);
        }

        // 遮罩层
        var overlay = document.createElement('div');
        overlay.className = 'reflect-overlay';
        overlay.addEventListener('click', _closeReflectPanel);
        document.body.appendChild(overlay);

        var panel = document.createElement('div');
        panel.className = 'reflect-review-panel';
        panel.innerHTML =
            AEI18n.html('<div class="reflect-panel-head"><h3>经验草稿 — 请审阅</h3><button class="reflect-close" title="关闭">✕</button></div>') +
            '<div class="reflect-panel-body"></div>';
        var panelBody = panel.querySelector('.reflect-panel-body');

        for (var i = 0; i < memories.length; i++) {
            var m = memories[i];
            var card = document.createElement('div');
            card.className = 'reflect-card';
            card.innerHTML =
                '<div class="reflect-card-head">' +
                  '<span class="reflect-card-name">' + escHtml(m.name || AEI18n.t('未命名')) + '</span>' +
                  '<span class="reflect-card-desc">' + escHtml(m.description || '') + '</span>' +
                  '<span class="reflect-card-toggle">▼</span>' +
                '</div>' +
                '<div class="reflect-card-body">' +
                  AEI18n.html('<label>名称: <input type="text" class="reflect-name" value="') + escHtml(m.name || '') + '"></label>' +
                  AEI18n.html('<label>描述: <input type="text" class="reflect-desc" value="') + escHtml(m.description || '') + '"></label>' +
                  '<label>Scope: <select class="reflect-scope">' +
                    '<option value="script"' + (m.scope === 'script' ? ' selected' : '') + '>Script</option>' +
                    '<option value="agent"' + (m.scope === 'agent' ? ' selected' : '') + '>Agent</option>' +
                    '<option value="both"' + (m.scope === 'both' ? ' selected' : '') + '>Both</option>' +
                  '</select></label>' +
                  AEI18n.html('<label>内容: <textarea class="reflect-content" rows="6">') + escHtml(m.content || '') + '</textarea></label>' +
                  '<div class="reflect-card-actions">' +
                    '<button class="reflect-confirm" data-index="' + i + '">' + AEI18n.t('确认写入') + '</button>' +
                    '<button class="reflect-skip" data-index="' + i + '">' + AEI18n.t('跳过') + '</button>' +
                  '</div>' +
                '</div>';
            // 点击卡片头部展开/收起
            var head = card.querySelector('.reflect-card-head');
            head.addEventListener('click', function () {
                var c = this.parentNode;
                var wasOpen = c.classList.contains('open');
                // 收起其它已展开的卡片，只保留一个展开
                var opened = panelBody.querySelectorAll('.reflect-card.open');
                for (var oi = 0; oi < opened.length; oi++) opened[oi].classList.remove('open');
                if (!wasOpen) c.classList.add('open');
            });
            panelBody.appendChild(card);
        }

        // 默认展开第一条
        var firstCard = panelBody.querySelector('.reflect-card');
        if (firstCard) firstCard.classList.add('open');

        document.body.appendChild(panel);

        // 关闭按钮
        panel.querySelector('.reflect-close').addEventListener('click', _closeReflectPanel);

        // 确认 / 跳过逻辑
        panel.addEventListener('click', function (e) {
            if (e.target.classList.contains('reflect-confirm')) {
                var idx = parseInt(e.target.dataset.index, 10);
                var mem = memories[idx];
                if (!mem) return;
                var cardEl = e.target.closest('.reflect-card');
                var updatedName = cardEl.querySelector('.reflect-name').value;
                var updatedDesc = cardEl.querySelector('.reflect-desc').value;
                var updatedScope = cardEl.querySelector('.reflect-scope').value;
                var updatedContent = cardEl.querySelector('.reflect-content').value;

                var memRegistry = window.AEMemory && window.AEMemory.getMemoryRegistry ? window.AEMemory.getMemoryRegistry() : null;
                if (memRegistry) {
                    var result = memRegistry.add({
                        name: updatedName,
                        description: updatedDesc,
                        type: mem.type || 'project',
                        scope: updatedScope,
                        content: updatedContent
                    });
                    if (result && result.ok) {
                        cardEl.querySelector('.reflect-card-actions').innerHTML = AEI18n.html('<span style="color:#81c784">✅ 已写入</span>');
                    } else {
                        cardEl.querySelector('.reflect-card-actions').innerHTML = AEI18n.html('<span style="color:#ff8a80">❌ 写入失败: ') + escHtml(result ? String(result.error) : 'unknown') + '</span>';
                    }
                } else {
                    cardEl.querySelector('.reflect-card-actions').innerHTML = AEI18n.html('<span style="color:#ff8a80">❌ Memory 模块未就绪</span>');
                }
            }
            if (e.target.classList.contains('reflect-skip')) {
                var cardEl = e.target.closest('.reflect-card');
                cardEl.querySelector('.reflect-card-actions').innerHTML = AEI18n.html('<span style="color:#8b949e">⏭ 已跳过</span>');
            }
        });
    }

    function _closeReflectPanel() {
        var p = document.querySelector('.reflect-review-panel');
        var o = document.querySelector('.reflect-overlay');
        if (p) p.remove();
        if (o) o.remove();
        // 清除 reflectDraft 标记，防止下次 renderMessages 重复弹出
        var bridge = window.AEEngine && window.AEEngine.bridge;
        if (bridge && typeof bridge.clearReflectDrafts === 'function') {
            bridge.clearReflectDrafts();
        }
        // clearReflectDrafts 按当前 lane 的 controller 清理；关闭时的 slot 与渲染该面板
        // 的 lane 不一致或清理尚未落盘时，消息上的 detail.reflectDraft 仍在，任何
        // renderMessages 都会再次拉起面板。向钩子回报本次关闭，按消息对象跳过重渲染。
        var cb = _onClosed;
        _onClosed = null;
        if (cb) {
            try { cb(); } catch (_) { /* 关闭回调失败不影响面板移除 */ }
        }
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.reflectPanel = { render: renderReflectReviewPanel, close: _closeReflectPanel };
})(window);
