// petHistoryPanel.js — 对话历史浮层面板（双 tab：历史 / 记忆）
(function (global) {
    'use strict';

    // 长记忆折叠阈值（按渲染行估算，不是精确排版）：面板内容宽约 280px、12px 字号，
    // 一行约 23 字 → 4 行约 90 字。超过阈值（或显式换行超过阈值行数）默认折叠为 4 行，
    // 避免一条长记忆把整个列表撑成一屏。
    var MEMORY_CLAMP_CHARS = 90;
    var MEMORY_CLAMP_LINES = 4;
    // 确认弹窗中的正文预览长度：够用户对上要删的是哪条，又不至于把弹窗撑爆
    var PREVIEW_CHARS = 40;

    function createHistoryPanel(eventBus, history, memory) {
        var _panelEl = null;
        var _activeTab = 'history';
        var _hideTimer = null;  // 退场动画 timer，destroy 时清理
        // 保存 eventBus 监听器引用，destroy 时才能正确 off
        var _busHandlers = null;

        function init() {
            // 防重入：重复 init 会创建多个 panel + 重复绑定事件
            // 触发场景：settings 开关快速切换 shutdown/startup
            if (_panelEl) return;

            _panelEl = document.createElement('div');
            _panelEl.className = 'dspet-history-panel';
            _panelEl.innerHTML =
                '<div class="dspet-history-head">' +
                    '<div class="dspet-history-tabs">' +
                        AEI18n.html('<button class="dspet-history-tab active" data-tab="history">历史</button>') +
                        AEI18n.html('<button class="dspet-history-tab" data-tab="memory">记忆</button>') +
                    '</div>' +
                    '<button class="dspet-history-close">✕</button>' +
                '</div>' +
                '<div class="dspet-history-body"></div>';
            document.body.appendChild(_panelEl);

            var tabs = _panelEl.querySelectorAll('.dspet-history-tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].addEventListener('click', function (e) {
                    _switchTab(e.target.dataset.tab);
                });
            }
            _panelEl.querySelector('.dspet-history-close').addEventListener('click', hide);

            // 保存 handler 引用，destroy 时才能正确 off
            _busHandlers = {
                memorySaved: function () { if (_activeTab === 'memory') _renderMemory(); },
                memoryDeleted: function () { if (_activeTab === 'memory') _renderMemory(); },
                historySummarized: function () { if (_activeTab === 'history') _renderHistory(); },
                historyDeleted: function () { if (_activeTab === 'history') _renderHistory(); }
            };
            eventBus.on('memory:saved', _busHandlers.memorySaved);
            eventBus.on('memory:deleted', _busHandlers.memoryDeleted);
            eventBus.on('history:summarized', _busHandlers.historySummarized);
            eventBus.on('history:deleted', _busHandlers.historyDeleted);
        }

        function _switchTab(tab) {
            _activeTab = tab;
            var tabs = _panelEl.querySelectorAll('.dspet-history-tab');
            for (var i = 0; i < tabs.length; i++) {
                tabs[i].classList.toggle('active', tabs[i].dataset.tab === tab);
            }
            if (tab === 'history') _renderHistory();
            else _renderMemory();
        }

        // 清空全部必须消费 history.clear() 的回执——读失败保护态下 clear 返回
        // {ok:false, reason}（拒绝且不清内存），此处走既有 AEToast 错误通道明确提示，
        // 不谎报清空成功（成功路径 clear 返回 {ok:true}，由 history:deleted 事件重渲染）。
        function _clearHistory() {
            var res = history.clear();
            if (res && res.ok === false) {
                var msg = res.reason || AEI18n.t('当前历史未成功读取，已暂停写入，暂不能清空');
                if (global.AEToast && typeof global.AEToast.error === 'function') {
                    global.AEToast.error(msg);
                } else {
                    console.warn('[petHistoryPanel] ' + msg);
                }
            }
        }

        // 不可恢复操作（删除单条记忆/单条历史/清空全部）统一走全局确认弹窗。
        // showConfirm 缺席（Agent app 未装载等异常装载态）时不降级到原生 confirm——
        // 项目禁用原生 confirm，且删除不可恢复：改为明确提示并取消本次删除（fail-closed，
        // 宁可这次删不掉，也不留下"没确认就删了"的路径）。
        function _confirmDelete(title, message) {
            if (typeof global.showConfirm === 'function') {
                try {
                    return Promise.resolve(global.showConfirm(title, message, 'danger')).then(function (ok) {
                        return !!ok;
                    }, function () { return false; });
                } catch (e) {
                    console.warn('[petHistoryPanel] showConfirm 调用失败: ' + e);
                }
            }
            var reason = AEI18n.t('确认弹窗不可用，已取消删除（请重启面板后重试）');
            if (global.AEToast && typeof global.AEToast.error === 'function') {
                try { global.AEToast.error(reason); } catch (_) {}
            } else {
                console.warn('[petHistoryPanel] ' + reason);
            }
            return Promise.resolve(false);
        }

        // 弹窗正文预览：压平空白并截断，用户能对上要删的是哪条
        // （showConfirm 的 message 是单行 <p>，换行不渲染，故压平）
        function _previewText(text) {
            var s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
            if (!s) return AEI18n.t('（空内容）');
            return s.length > PREVIEW_CHARS ? s.slice(0, PREVIEW_CHARS) + '…' : s;
        }

        // 是否需要折叠：超长正文，或显式换行本身就超过阈值行数
        function _isLongMemory(text) {
            var s = String(text == null ? '' : text);
            if (s.replace(/\s/g, '').length > MEMORY_CLAMP_CHARS) return true;
            var lines = s.split('\n');
            var used = 0;
            for (var i = 0; i < lines.length; i++) {
                if (lines[i].trim() !== '') used++;
            }
            return used > MEMORY_CLAMP_LINES;
        }

        function _renderHistory() {
            var body = _panelEl.querySelector('.dspet-history-body');
            body.innerHTML = '';

            // 顶部工具栏：搜索框 + 批量删除按钮
            var toolbar = document.createElement('div');
            toolbar.className = 'dspet-history-toolbar';

            var searchInput = document.createElement('input');
            searchInput.className = 'dspet-history-search';
            searchInput.placeholder = AEI18n.t('搜索历史...');
            toolbar.appendChild(searchInput);

            var clearBtn = document.createElement('button');
            clearBtn.className = 'dspet-history-clear-btn';
            clearBtn.textContent = AEI18n.t('清空全部');
            clearBtn.addEventListener('click', function () {
                _confirmDelete(AEI18n.t('清空对话历史'), AEI18n.t('确定要清空全部对话历史吗？此操作不可恢复。')).then(function (ok) {
                    if (ok) _clearHistory();
                });
            });
            toolbar.appendChild(clearBtn);
            body.appendChild(toolbar);

            var listEl = document.createElement('div');

            var summary = history.getSummary();
            if (summary) {
                var sumEl = document.createElement('div');
                sumEl.className = 'dspet-history-summary';
                sumEl.textContent = AEI18n.t('摘要: ') + summary;
                listEl.appendChild(sumEl);
            }

            var messages = history.getAllMessages();
            var filterText = '';
            searchInput.addEventListener('input', function () {
                filterText = searchInput.value.toLowerCase();
                _filterHistory(listEl, messages, filterText);
            });

            _filterHistory(listEl, messages, '');
            body.appendChild(listEl);
        }

        function _filterHistory(container, messages, filter) {
            container.innerHTML = '';
            for (var i = 0; i < messages.length; i++) {
                var msg = messages[i];
                var content = msg.content || '';
                if (filter && content.toLowerCase().indexOf(filter) < 0) continue;

                var item = document.createElement('div');
                item.className = 'dspet-history-item';
                var roleSpan = document.createElement('span');
                roleSpan.className = 'role ' + (msg.role || '');
                // assistant 角色显示为桌宠名，更友好
                var roleLabel = msg.role || '';
                if (roleLabel === 'assistant') roleLabel = AEI18n.t('大肥鱼桌宠');
                roleSpan.textContent = roleLabel;
                var contentSpan = document.createElement('span');
                contentSpan.className = 'content';
                contentSpan.textContent = content;  // textContent 防止 XSS
                item.appendChild(roleSpan);
                item.appendChild(contentSpan);

                // 删除按钮（与记忆面板同款）：单条删除同样不可恢复，先确认再删
                if (msg.id) {
                    var delBtn = document.createElement('button');
                    delBtn.className = 'mem-del';
                    delBtn.dataset.id = msg.id;
                    delBtn.textContent = AEI18n.t('删除');
                    (function (id, text) {
                        delBtn.addEventListener('click', function () {
                            _confirmDelete(AEI18n.t('删除对话记录'),
                                AEI18n.t('确定要删除这条对话记录「') + _previewText(text) + AEI18n.t('」吗？此操作不可恢复。')
                            ).then(function (ok) {
                                if (ok) history.deleteMessage(id);
                            });
                        });
                    })(msg.id, content);
                    item.appendChild(delBtn);
                }

                container.appendChild(item);
            }
            if (container.children.length === 0) {
                container.innerHTML = AEI18n.html('<div style="color:var(--text-muted);text-align:center;padding:20px;">无匹配记录</div>');
            }
        }

        function _renderMemory() {
            var body = _panelEl.querySelector('.dspet-history-body');
            body.innerHTML = '';

            var filterInput = document.createElement('input');
            filterInput.className = 'dspet-memory-filter';
            filterInput.placeholder = AEI18n.t('按标签筛选...');
            body.appendChild(filterInput);

            var listEl = document.createElement('div');
            var filterText = '';
            filterInput.addEventListener('input', function () {
                filterText = filterInput.value.toLowerCase();
                _filterMemory(listEl, filterText);
            });

            _filterMemory(listEl, '');
            body.appendChild(listEl);
        }

        function _filterMemory(container, filter) {
            container.innerHTML = '';
            var memories = memory.getAll();
            for (var i = 0; i < memories.length; i++) {
                var mem = memories[i];
                if (filter) {
                    // Array.isArray 防御：旧数据 tags 可能为字符串/null（search() 已做同类防御）
                    var matchTag = Array.isArray(mem.tags) && mem.tags.some(function (t) {
                        return t.toLowerCase().indexOf(filter) >= 0;
                    });
                    if (!matchTag && !(mem.content && mem.content.toLowerCase().indexOf(filter) >= 0)) continue;
                }

                var item = document.createElement('div');
                item.className = 'dspet-memory-item dspet-memory-importance-' + (mem.importance || 'medium');

                // 头部行：标签靠左、删除靠右。若把标签与删除按钮和正文放进同一个
                // flex 行，正文一长就被挤成窄列、按钮漂在卡片中部——用户反馈的
                // 「过长的记忆全部显示很奇怪」里，布局与不折叠各占一半。
                var head = document.createElement('div');
                head.className = 'mem-head';

                var tagsWrap = document.createElement('span');
                tagsWrap.className = 'mem-tags';
                if (Array.isArray(mem.tags)) {
                    for (var j = 0; j < mem.tags.length; j++) {
                        var tagSpan = document.createElement('span');
                        tagSpan.className = 'mem-tag';
                        tagSpan.textContent = mem.tags[j];
                        tagsWrap.appendChild(tagSpan);
                    }
                }
                head.appendChild(tagsWrap);

                var delBtn = document.createElement('button');
                delBtn.className = 'mem-del';
                delBtn.dataset.id = mem.id;
                delBtn.textContent = AEI18n.t('删除');
                head.appendChild(delBtn);
                item.appendChild(head);

                // 正文：textContent 渲染，避免 LLM 写入的 HTML 注入；
                // 超长默认折叠为 4 行 + 「展开全文」，换行按 pre-wrap 保留（CSS）
                var contentSpan = document.createElement('span');
                contentSpan.className = 'mem-content';
                contentSpan.textContent = mem.content || '';
                var collapsible = _isLongMemory(mem.content);
                if (collapsible) contentSpan.classList.add('mem-clamped');
                item.appendChild(contentSpan);

                if (collapsible) {
                    var toggleBtn = document.createElement('button');
                    toggleBtn.className = 'mem-toggle';
                    toggleBtn.textContent = AEI18n.t('展开全文');
                    (function (span, btn) {
                        btn.addEventListener('click', function () {
                            // 同一按钮承担展开/收起：状态只由 contentSpan 的类决定，
                            // 不另存标志位（避免重渲染后标志与 DOM 不一致）
                            if (span.classList.contains('mem-clamped')) {
                                span.classList.remove('mem-clamped');
                                btn.textContent = AEI18n.t('收起');
                            } else {
                                span.classList.add('mem-clamped');
                                btn.textContent = AEI18n.t('展开全文');
                            }
                        });
                    })(contentSpan, toggleBtn);
                    item.appendChild(toggleBtn);
                }

                (function (m) {
                    delBtn.addEventListener('click', function () {
                        _confirmDelete(AEI18n.t('删除记忆'),
                            AEI18n.t('确定要删除记忆「') + _previewText(m.content) + AEI18n.t('」吗？此操作不可恢复。')
                        ).then(function (ok) {
                            if (ok) memory.delete(m.id);
                        });
                    });
                })(mem);
                container.appendChild(item);
            }
            if (container.children.length === 0) {
                container.innerHTML = AEI18n.html('<div style="color:var(--text-muted);text-align:center;padding:20px;">暂无记忆</div>');
            }
        }

        function show() {
            if (!_panelEl) return;
            // 清理退场动画 timer，重置 hiding 类
            if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; }
            _panelEl.classList.remove('hiding');
            // 先 render 再加 visible 类，避免动画期间内容布局跳动
            if (_activeTab === 'history') _renderHistory();
            else _renderMemory();
            requestAnimationFrame(function () {
                if (_panelEl) _panelEl.classList.add('visible');
            });
        }

        function hide() {
            if (!_panelEl) return;
            // 添加 hiding 类触发退场动画，200ms 后恢复初始隐藏态（保留 display:flex 但 opacity:0）
            _panelEl.classList.add('hiding');
            _panelEl.classList.remove('visible');
            if (_hideTimer) clearTimeout(_hideTimer);
            _hideTimer = setTimeout(function () {
                _hideTimer = null;
                if (_panelEl) _panelEl.classList.remove('hiding');
            }, 200);
        }

        function toggle() {
            if (_panelEl && _panelEl.classList.contains('visible')) hide();
            else show();
        }

        function destroy() {
            if (_hideTimer) clearTimeout(_hideTimer);
            _hideTimer = null;
            // 移除 eventBus 监听器，避免 destroy 后回调访问已 null 的 _panelEl
            if (_busHandlers) {
                eventBus.off('memory:saved', _busHandlers.memorySaved);
                eventBus.off('memory:deleted', _busHandlers.memoryDeleted);
                eventBus.off('history:summarized', _busHandlers.historySummarized);
                eventBus.off('history:deleted', _busHandlers.historyDeleted);
                _busHandlers = null;
            }
            if (_panelEl && _panelEl.parentNode) _panelEl.parentNode.removeChild(_panelEl);
            _panelEl = null;
        }

        return { init: init, show: show, hide: hide, toggle: toggle, destroy: destroy };
    }

    global.AEDeepseekPet = global.AEDeepseekPet || {};
    global.AEDeepseekPet.createHistoryPanel = createHistoryPanel;
})(window);
