(function(global) {

    function escHtml(str) {
        if (!str) return '';
        return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // 环境变量明文/密文切换的眼睛图标（内联 SVG，不使用 emoji，避免字体不一致）
    var _EYE_OPEN_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
    var _EYE_OFF_SVG = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>';

    // JSON 配置示例文本：**框内的真实内容**（真换行 + 真引号），打开向导即填进 textarea，
    // 供用户直接选中/复制/就地改。示例只作 placeholder 时灰字占位符选不中也复制不了；
    // 排版对齐 JSON.stringify(cfg, null, 2) 的落盘形态。
    var JSON_EXAMPLE_SERVER = '{\n  "my-server": {\n    "command": "npx",\n    "args": ["-y", "@scope/server"]\n  }\n}';
    var JSON_EXAMPLE_EDIT = '{\n  "my-server": {\n    "transport": "stdio",\n    "command": "npx",\n    "args": ["-y", "@scope/server"],\n    "env": {"API_KEY": "xxx"}\n  }\n}';

    // 「内容仍是示例」判据：示例现在是真内容，误点确认/误触输入都会把它当真实配置
    // （新增路径会加进一台 my-server；编辑路径会用示例值覆盖表单）——两处入口都先识别。
    function _isExampleOnly(text) {
        var t = String(text == null ? '' : text).trim();
        return t === JSON_EXAMPLE_SERVER.trim() || t === JSON_EXAMPLE_EDIT.trim();
    }

    // 复制到剪贴板：textarea + execCommand（CEF Chrome 可靠，同错误详情弹窗的手法）。
    // 临时 textarea 在 finally 里摘除——execCommand 抛错（或不可用）时不把隐藏节点留在 body。
    function _copyTextToClipboard(text) {
        var ta = null;
        try {
            ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.left = '-9999px';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            return true;
        } catch (e) {
            return false;
        } finally {
            if (ta && ta.parentNode) {
                try { ta.parentNode.removeChild(ta); } catch (_) {}
            }
        }
    }

    function createMcpView(options) {
        options = options || {};
        var toolRegistry = options.toolRegistry || null;
        var serverManager = options.serverManager || null;
        var settingsStore = options.settingsStore || null;
        var currentModuleId = options.moduleId || '';
        var toolFilter = 'all';
        var listeners = [];
        // 当前安装/编辑向导中存活的 ScopePicker 实例：
        // 关闭/替换向导时统一销毁，避免事件泄漏
        var _wizardScopePicker = null;

        function on(el, event, handler) {
            if (!el) return;
            el.addEventListener(event, handler);
            listeners.push({ el: el, event: event, handler: handler });
        }

        // 临时 DOM（随 innerHTML 重建/弹窗关闭即销毁）的监听直接挂元素上：
        // 元素不可达时监听器随之被 GC 回收。若走全局 listeners 数组，
        // 数组持有引用导致旧 DOM 与监听器永不释放（renderServerList 每次状态变化都重建，长会话持续累积）。
        // 仅持久容器（render 的 containerEl）用 on() 以便 destroy 时统一清理。
        function tmpOn(el, event, handler) {
            if (!el) return;
            el.addEventListener(event, handler);
        }

        function offAll() {
            while (listeners.length > 0) {
                var item = listeners.pop();
                item.el.removeEventListener(item.event, item.handler);
            }
        }

        // 环境变量明文/密文切换（眼睛按钮）：密文时整个输入框变黑（背景黑、文字透明），
        // 滚动条/角标也随密文变黑，避免右下角露出原生方框
        function _ensureEnvPwdCss() {
            if (document.getElementById('aexp-env-pwd-css-v2')) return;
            var style = document.createElement('style');
            style.id = 'aexp-env-pwd-css-v2';
            style.textContent = ''
                + '.aexp-pwd-wrap{position:relative;width:100%;}'
                + '.aexp-pwd-wrap textarea{width:100%;box-sizing:border-box;padding-right:30px;}'
                + '.aexp-pwd-wrap textarea.aexp-masked{resize:none;}'
                + '.aexp-pwd-wrap .toggle-pwd{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;background:transparent;border:none;color:var(--text-muted);cursor:pointer;line-height:1;font-size:0;}'
                + '.aexp-pwd-wrap .toggle-pwd:hover{color:var(--text-main);}'
                + '.aexp-pwd-wrap .toggle-pwd .eye-off{display:none;}'
                + '.aexp-pwd-wrap .toggle-pwd.visible .eye-open{display:none;}'
                + '.aexp-pwd-wrap .toggle-pwd.visible .eye-off{display:inline-flex;}'
                + '.aexp-pwd-wrap textarea.aexp-masked{background:#000;color:transparent;-webkit-text-fill-color:transparent;caret-color:transparent;text-shadow:none;user-select:none;-webkit-user-select:none;}'
                + '.aexp-pwd-wrap textarea::-webkit-scrollbar{width:10px;height:10px;}'
                + '.aexp-pwd-wrap textarea::-webkit-scrollbar-track{background:transparent;}'
                + '.aexp-pwd-wrap textarea::-webkit-scrollbar-thumb{background:var(--btn-border);border-radius:5px;}'
                + '.aexp-pwd-wrap textarea::-webkit-scrollbar-corner{background:transparent;}'
                + '.aexp-pwd-wrap textarea.aexp-masked::-webkit-scrollbar-track{background:#000;}'
                + '.aexp-pwd-wrap textarea.aexp-masked::-webkit-scrollbar-corner{background:#000;}'
                + '.aexp-pwd-wrap textarea.aexp-masked::-webkit-scrollbar-thumb{background:#222;}';
            document.head.appendChild(style);
        }

        // 粘贴 JSON 配置的代码高亮（复用全局 Prism，JSON 用 javascript 语法高亮）
        // 结构照搬 Agent 预览区：overlay <pre> 与 textarea 同字体/行高/内边距绝对定位叠放，
        // 滚动用 transform 平移 overlay 跟随 textarea（旧方案同步 scrollTop 会被 overflow:hidden
        // 限制导致滚到底错位，transform 不受 scrollHeight 限制，精确对齐）。
        // 粘贴框自身不再放示例（示例改由下方的真实文本块承载，见 _mountJsonExample）——
        // placeholder 是灰字占位符，选不中也复制不了。
        function _ensureJsonHighlightCss() {
            if (document.getElementById('aexp-json-hl-css')) return;
            var style = document.createElement('style');
            style.id = 'aexp-json-hl-css';
            style.textContent = ''
                + '.aexp-json-wrap{position:relative;width:100%;min-height:150px;border:1px solid var(--btn-border);border-radius:4px;overflow:hidden;}'
                + '.aexp-json-wrap textarea,.aexp-json-wrap pre{position:absolute;inset:0;margin:0;width:100%;height:100%;min-height:150px;box-sizing:border-box;border:none !important;border-radius:0;background:transparent !important;font-family:Consolas,"Courier New",monospace;font-size:12px;line-height:18px;white-space:pre;word-wrap:normal;overflow-wrap:normal;tab-size:4;}'
                + '.aexp-json-wrap textarea{padding:8px;z-index:2;color:var(--text-muted);caret-color:var(--text-main);resize:none;overflow:auto;outline:none;}'
                + '.aexp-json-wrap pre{padding:0;overflow:hidden;z-index:1;color:transparent;pointer-events:none;}'
                + '.aexp-json-wrap.has-highlight textarea{color:transparent !important;}'
                + '.aexp-json-wrap.has-highlight pre{color:var(--text-main) !important;}'
                + '.aexp-json-wrap code{display:block;padding:8px;font:inherit;line-height:inherit;white-space:pre;}';
            document.head.appendChild(style);
        }

        // 用 Prism 高亮 JSON 到 overlay，并切换 has-highlight（生效时 textarea 文字透明，由 overlay 显示）
        function _highlightPasteJson(textareaEl, codeEl, wrapEl) {
            if (!textareaEl || !codeEl || !wrapEl) return;
            var code = textareaEl.value;
            if (!code) {
                codeEl.innerHTML = '';
                wrapEl.classList.remove('has-highlight');
                return;
            }
            var P = window.Prism;
            if (P && P.highlight && P.languages && P.languages.javascript) {
                try {
                    codeEl.innerHTML = P.highlight(code, P.languages.javascript, 'javascript') + '\n';
                    wrapEl.classList.add('has-highlight');
                } catch (e) {
                    wrapEl.classList.remove('has-highlight');
                }
            } else {
                wrapEl.classList.remove('has-highlight');
            }
        }

        function setToolRegistry(reg) {
            toolRegistry = reg;
        }

        function setServerManager(mgr) {
            serverManager = mgr;
        }

        function setSettingsStore(store) {
            settingsStore = store;
        }

        function getTools() {
            if (!toolRegistry || typeof toolRegistry.getAll !== 'function') return [];
            var all = toolRegistry.getAll() || [];
            // 排除 mcp_servers/mcp_control（管理工具，非服务端工具，不应出现在工具列表中）
            var _EXCLUDE = { mcp_servers: true, mcp_control: true };
            return all.filter(function(t) { return t.source === 'mcp' && !_EXCLUDE[t.name]; });
        }

        function getFilteredTools() {
            var tools = getTools();
            if (toolFilter === 'all') return tools;
            if (toolFilter === 'local') {
                return tools.filter(function(t) { return !t.serverId; });
            }
            if (toolFilter === 'server') {
                return tools.filter(function(t) { return !!t.serverId; });
            }
            if (toolFilter === 'global') {
                return tools.filter(function(t) { return t.scope && t.scope.type === 'global'; });
            }
            if (toolFilter === 'module') {
                return tools.filter(function(t) { return t.scope && t.scope.type === 'module'; });
            }
            return tools;
        }

        function getServers() {
            if (!serverManager || typeof serverManager.getAllServerConfigs !== 'function') return [];
            var configs = serverManager.getAllServerConfigs() || {};
            var result = [];
            var ids = Object.keys(configs);
            for (var i = 0; i < ids.length; i++) {
                var id = ids[i];
                var config = configs[id];
                var status = getServerStatusObj(id);
                result.push({
                    id: id,
                    config: config,
                    status: status
                });
            }
            return result;
        }

        function getServerStatusObj(serverId) {
            if (!serverManager || typeof serverManager.getServerStatus !== 'function') {
                return { state: 'unknown' };
            }
            var st = serverManager.getServerStatus(serverId);
            if (!st) return { state: 'stopped' };
            return {
                state: st.state || 'unknown',
                lastError: st.lastError || null
            };
        }

        function getServerToolCount(serverId) {
            if (!toolRegistry || typeof toolRegistry.getByServerId !== 'function') return 0;
            var serverTools = toolRegistry.getByServerId(serverId);
            return serverTools ? serverTools.length : 0;
        }

        // 失败明细只对「当前仍有活动连接」的服务器展示。服务器被停止/
        // 删除/崩溃后明细已由 toolDiscovery.unregisterByServer 清空，此处再按连接
        // 状态兜底过滤（明细可能在状态变更与重渲染之间短暂残留）：stopped/
        // disconnected/unknown 一律不展示，防止已停止的服务器长期挂着失败徽标
        function _isServerActive(state) {
            return state === 'connected' || state === 'connecting';
        }

        // 明细通道（工具可用性失败）读取与拆分：注册失败条目带工具名，
        // tools/list 拉取失败条目带 phase='fetch' + 错误消息 + 时间（同表承载，
        // serverManager.getLastRegisterErrors 透传）
        function _splitAvailabilityErrors(serverId) {
            var fetchErrs = [];
            var regErrs = [];
            var all = (serverManager && typeof serverManager.getLastRegisterErrors === 'function')
                ? (serverManager.getLastRegisterErrors(serverId) || []) : [];
            for (var i = 0; i < all.length; i++) {
                if (all[i] && all[i].phase === 'fetch') fetchErrs.push(all[i]);
                else regErrs.push(all[i]);
            }
            return { fetch: fetchErrs, register: regErrs };
        }

        // 所有已配置 server 的 tools/list 拉取失败（工具 tab 空态提示用）。
        // 仅统计 connected/connecting 的服务器：空态文案写作「已连接 Server」，
        // 未连接服务器的残留明细不得被计入（措辞与事实一致）
        function _collectFetchErrors() {
            var out = [];
            var servers = getServers();
            for (var i = 0; i < servers.length; i++) {
                if (!_isServerActive(servers[i].status && servers[i].status.state)) continue;
                var split = _splitAvailabilityErrors(servers[i].id);
                for (var j = 0; j < split.fetch.length; j++) {
                    out.push({ serverId: servers[i].id, error: split.fetch[j].error, time: split.fetch[j].time });
                }
            }
            return out;
        }

        function _formatErrTime(ts) {
            if (!ts) return '';
            var d = new Date(ts);
            function pad(n) { return (n < 10 ? '0' : '') + n; }
            return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
        }

        function applyToolFilter(filterName) {
            toolFilter = filterName;
            renderToolList();
            updateToolFilterButtons();
        }

        function updateToolFilterButtons() {
            var body = document.getElementById('mcpMgmtBody');
            if (!body) return;
            var bar = body.querySelector('.mgmt-tools-filter-bar');
            if (!bar) return;
            var btns = bar.querySelectorAll('.mgmt-filter-btn');
            for (var i = 0; i < btns.length; i++) {
                var btn = btns[i];
                var f = btn.getAttribute('data-filter');
                if (f === toolFilter) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }
        }

        // 过滤按钮上的计数（全部/本地/Server/全局/模块）与主 tab「工具 (N)」计数
        // 只在 render() 首次渲染时写入，移除 Server 后工具数量变化，
        // 须重新计算，否则按钮数值停留在旧值。
        function updateToolFilterCounts() {
            var body = document.getElementById('mcpMgmtBody');
            if (!body) return;
            var bar = body.querySelector('.mgmt-tools-filter-bar');
            if (!bar) return;
            var btns = bar.querySelectorAll('.mgmt-filter-btn');
            if (!btns.length) return;

            var tools = getTools();
            var localCount = 0;
            var serverCount = 0;
            var globalCount = 0;
            var moduleCount = 0;
            for (var i = 0; i < tools.length; i++) {
                var t = tools[i];
                if (t.serverId) serverCount++;
                else localCount++;
                if (t.scope && t.scope.type === 'global') globalCount++;
                else if (t.scope && t.scope.type === 'module') moduleCount++;
            }

            // 主 tab「工具 (N)」同步更新（否则只更新过滤按钮，主 tab 停留在旧值）
            var mainTab = body.querySelector('.mgmt-main-tab[data-tab="tools"]');
            if (mainTab) mainTab.textContent = AEI18n.t('工具 (') + tools.length + ')';

            var labels = { all: AEI18n.t('全部'), local: AEI18n.t('本地'), server: 'Server', global: AEI18n.t('全局'), module: AEI18n.t('模块') };
            var counts = { all: tools.length, local: localCount, server: serverCount, global: globalCount, module: moduleCount };
            for (var j = 0; j < btns.length; j++) {
                var f = btns[j].getAttribute('data-filter');
                if (counts.hasOwnProperty(f)) {
                    btns[j].textContent = labels[f] + ' (' + counts[f] + ')';
                }
            }
        }

        function renderToolList() {
            updateToolFilterCounts();
            var body = document.getElementById('mcpMgmtBody');
            if (!body) return;
            var panel = body.querySelector('.mgmt-tools-panel');
            if (!panel) return;

            var tools = getFilteredTools();
            var container = panel.querySelector('.mgmt-list-container');
            if (!container) return;

            if (tools.length === 0) {
                // tools/list 拉取失败与"服务器本来没工具"是两回事：复用同一失败明细
                // 通道如实标注原因与处置入口（Server 页重启/重试），不新增 UI 类别
                var fetchErrs = _collectFetchErrors();
                var emptyText = AEI18n.t('暂无工具。请安装本地 MCP 工具或连接 MCP Server。');
                if (fetchErrs.length > 0) {
                    emptyText += '<br><span style="color:#ef6666;">' + AEI18n.t('有 {n} 个已连接 Server 的工具列表拉取失败：', { n: fetchErrs.length })
                        + escHtml(fetchErrs[0].serverId) + ' — ' + escHtml(fetchErrs[0].error)
                        + (fetchErrs[0].time ? AEI18n.punct('（', ' (') + escHtml(_formatErrTime(fetchErrs[0].time)) + AEI18n.punct('）', ')') : '')
                        + AEI18n.t('，可在 Server 页重启重试。') + '</span>';
                }
                container.innerHTML = '<div class="mgmt-empty">' + emptyText + '</div>';
                return;
            }

            var html = '<div class="mgmt-table-wrap"><table class="mgmt-table"><thead><tr>';
            html += AEI18n.html('<th class="col-name">名称</th><th class="col-desc">描述</th><th class="col-source">来源</th><th class="col-scope">作用域</th><th class="col-toggle">启用</th>');
            html += '</tr></thead><tbody>';

            for (var i = 0; i < tools.length; i++) {
                var t = tools[i];
                var sourceLabel = t.serverId ? escHtml(t.serverId) : AEI18n.t('本地');
                var sourceClass = t.serverId ? 'server' : 'local';
                var sourceTitle = sourceLabel;
                var scopeLabel = (t.scope && t.scope.type === 'global') ? AEI18n.t('全局') : AEI18n.t('模块');
                var scopeClass = (t.scope && t.scope.type === 'global') ? 'global' : 'module';
                var moduleName = (t.scope && t.scope.moduleId) ? t.scope.moduleId : '';
                var scopeTitle = scopeLabel + (moduleName ? ' (' + moduleName + ')' : '');

                html += '<tr data-tool-name="' + escHtml(t.name) + '">';
                html += '<td class="mgmt-name" title="' + escHtml(t.name) + '">' + escHtml(t.name) + '</td>';
                html += '<td class="mgmt-desc" title="' + escHtml(t.description || '') + '">' + escHtml((t.description || '').substring(0, 80)) + '</td>';
                html += '<td class="mgmt-badge-cell"><span class="mgmt-badge ' + sourceClass + '" title="' + sourceTitle + '">' + sourceLabel + '</span></td>';
                html += '<td class="mgmt-badge-cell"><span class="mgmt-badge ' + scopeClass + '" title="' + escHtml(scopeTitle) + '">' + scopeLabel + '</span></td>';
                html += '<td class="mgmt-toggle-cell"><label class="toggle-wrap"><input type="checkbox" class="switch-input tool-toggle" data-tool-name="' + escHtml(t.name) + '"' + (t.enabled !== false ? ' checked' : '') + '><span class="switch-slider"></span></label></td>';
                html += '</tr>';
            }

            html += '</tbody></table></div>';
            container.innerHTML = html;

            bindToolListEvents(container);
        }

        function bindToolListEvents(container) {
            var toggles = container.querySelectorAll('.tool-toggle');
            for (var i = 0; i < toggles.length; i++) {
                tmpOn(toggles[i], 'change', function() {
                    var toolName = this.getAttribute('data-tool-name');
                    var enabled = !!this.checked;
                    toggleTool(toolName, enabled);
                });
            }
        }

        // toggle 串行化：getModuleSettings 的读在 settingsStore 写锁外返回快照，
        // 两个并发 toggle 各自基于同一快照改 _disabledTools 再整体覆盖写回，
        // 后写者会丢掉先写者的数组项（读-改-写竞态）。用 promise 链把读-改-写
        // 串成原子序列（对齐 settingsStore._serializedWrite 模式），后到 toggle
        // 基于先到者写完后的最新值修改，不再丢更新。
        var _toggleChain = Promise.resolve();
        function _serializedToggle(fn) {
            var run = _toggleChain.then(fn, fn);
            // 防止链断裂：吞掉 run 中的错误，由调用方自行处理
            _toggleChain = run.catch(function() {});
            return run;
        }

        async function toggleTool(toolName, enabled) {
            if (!toolRegistry) return;
            if (typeof toolRegistry.setToolEnabled === 'function') {
                toolRegistry.setToolEnabled(toolName, enabled);
            }
            var disabledTools;
            // 捕获落盘结果——setModuleSettings 写盘失败 resolve false
            // （配额满/加密异常）而非 reject，静默吞掉时开关看似已保存、
            // 重启后回退。false 时如实提示（对齐 skill-manager toggleSkill 的失败提示）
            var writeOk;
            await _serializedToggle(async function () {
                if (settingsStore && typeof settingsStore.getModuleSettings === 'function') {
                    var moduleSettings = await settingsStore.getModuleSettings(currentModuleId, {});
                    disabledTools = (moduleSettings && moduleSettings._disabledTools) || [];
                    if (enabled) {
                        var idx = disabledTools.indexOf(toolName);
                        if (idx >= 0) disabledTools.splice(idx, 1);
                    } else {
                        if (disabledTools.indexOf(toolName) < 0) disabledTools.push(toolName);
                    }
                    // 只写变更键：setModuleSettings 是按键合并（settingsStore.js），整包回写会把
                    // 读取快照时的 stale servers 键覆盖 lifecycle persistConfigs 的并发写入
                    // （add/remove/update/短描述生成完成落盘）（审计）
                    writeOk = await settingsStore.setModuleSettings(currentModuleId, { _disabledTools: disabledTools });
                }
                // 同步禁用名单到 serverManager（toolDiscovery 的 _disabledToolNames 闭包列表）：
                // 重连/重启/notifyToolsChanged/短描述生成完成都会触发 registerTools 重注册，
                // 其按该列表整体覆盖 enabled，不同步会把开关状态回退成旧值
                // settingsStore 缺失时 disabledTools 为 undefined，回退空列表，仍保证本次开关生效
                if (serverManager && typeof serverManager.setDisabledTools === 'function') {
                    serverManager.setDisabledTools(disabledTools || []);
                }
            });
            if (writeOk === false && global.AEToast) {
                global.AEToast.show(AEI18n.t('工具开关保存失败（本次会话已生效，重启后回退）'), 'error');
            }
        }

        // 构建工具编辑表单 HTML（可嵌入任意容器，含说明文字 + 工具列表 + 保存按钮）
        function _buildToolEditorBody(serverId) {
            if (!toolRegistry || !serverManager) return '';
            // 明细通道：注册失败与 tools/list 拉取失败同表承载。
            // 明细仅对 connected/connecting 的服务器展示——已停止/
            // 断开的服务器其工具已注销，残留明细不得再挂在该服务器名下
            var availSplit = _isServerActive(getServerStatusObj(serverId).state)
                ? _splitAvailabilityErrors(serverId)
                : { fetch: [], register: [] };
            var html = '';
            // tools/list 拉取失败（整批未注册）优先展示：工具数 0 时用户能立刻区分
            // "服务器本来没工具"与"拉取失败"，并知道去 Server 页重启/重试
            if (availSplit.fetch.length > 0) {
                html += '<div style="margin:0 0 12px;padding:8px 12px;border:1px solid rgba(239,102,102,.35);border-radius:4px;font-size:11px;color:var(--text-muted);line-height:1.7;">';
                html += AEI18n.html('<b style="color:#ef6666;">工具列表拉取失败（Server 已连接但工具不可用，可在 Server 页重启重试）：</b><br>');
                for (var fi = 0; fi < availSplit.fetch.length; fi++) {
                    html += '· ' + escHtml(availSplit.fetch[fi].error)
                        + (availSplit.fetch[fi].time ? '（' + escHtml(_formatErrTime(availSplit.fetch[fi].time)) + '）' : '') + '<br>';
                }
                html += '</div>';
            }
            var serverTools = toolRegistry.getByServerId(serverId);
            if (!serverTools || serverTools.length === 0) {
                return html + '<div style="padding:24px;text-align:center;color:var(--text-muted);font-size:12px;">' + AEI18n.t('该服务器暂无已注册工具') + '</div>';
            }
            var cfg = serverManager.getServerConfig ? serverManager.getServerConfig(serverId) : null;
            var descMap = (cfg && cfg.toolDescriptions) ? cfg.toolDescriptions : {};
            var stubMap = (cfg && cfg.toolStubs) ? cfg.toolStubs : {};

            // 注册失败明细展示——sanitize 后仍失败的残余场景（保留名等）
            // 仅 console.warn 时用户看到「已连接」但工具不可用零提示
            var regErrors = availSplit.register;
            if (regErrors.length > 0) {
                html += '<div style="margin:0 0 12px;padding:8px 12px;border:1px solid rgba(239,102,102,.35);border-radius:4px;font-size:11px;color:var(--text-muted);line-height:1.7;">';
                html += AEI18n.html('<b style="color:#ef6666;">有 ') + regErrors.length + AEI18n.html(' 个工具注册失败（LLM 不可见）：</b><br>');
                for (var ri = 0; ri < regErrors.length; ri++) {
                    html += '· ' + escHtml(regErrors[ri].name) + '（' + escHtml(regErrors[ri].error) + '）<br>';
                }
                html += '</div>';
            }
            html += '<p style="margin:0 0 12px;font-size:12px;color:var(--text-muted);line-height:1.6;">';
            html += AEI18n.html('<b style="color:var(--btn-text);">短描述</b>：留空将自动生成，用于 LLM 快速识别工具用途。');
            html += AEI18n.html('<br><b style="color:var(--btn-text);">Stub 模式</b>：开启后 LLM 仅看到短描述与空参数表（调用前需先 tool_search 解锁完整定义），可显著节省 token；关闭则直接注入完整描述与参数。');
            html += '</p>';
            for (var i = 0; i < serverTools.length; i++) {
                var t = serverTools[i];
                // 缓存键用原始名（server 上报的稳定标识）——注册名随同名冲突
                // 漂移（mcp_foo → mcp_foo_2 → mcp_foo），按注册名保存的配置在冲突消失后
                // 静默失联；原始名不漂移。data-reg-name 保存当前注册名供收集时清理旧键
                var keyName = (serverManager.getOriginalToolName && serverManager.getOriginalToolName(serverId, t.name)) || t.name;
                var shortVal = descMap[t.name] || descMap[keyName] || t.shortDescription || '';
                var stubChecked = !(stubMap[keyName] === false || stubMap[t.name] === false); // 默认 stub=true
                html += '<div class="mcp-desc-edit-row" style="margin-bottom:10px;padding:10px;border:1px solid rgba(255,255,255,.06);border-radius:4px;">';
                html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;">';
                html += '<code style="font-size:13px;color:var(--accent);">' + escHtml(t.name) + '</code>';
                html += AEI18n.html('<label class="toggle-wrap" title="Stub 模式：开启省 token，关闭注入完整描述" style="display:flex;align-items:center;gap:6px;cursor:pointer;">');
                html += '<span style="font-size:11px;color:var(--text-muted);">Stub</span>';
                html += '<input type="checkbox" class="switch-input mcp-stub-input" data-tool-name="' + escHtml(keyName) + '" data-reg-name="' + escHtml(t.name) + '"' + (stubChecked ? ' checked' : '') + '>';
                html += '<span class="switch-slider" aria-hidden="true"></span>';
                html += '</label>';
                html += '</div>';
                html += '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;max-height:40px;overflow:hidden;">' + escHtml((t.description || '').substring(0, 120)) + '</div>';
                html += '<input type="text" class="mcp-desc-input" data-tool-name="' + escHtml(keyName) + '" data-reg-name="' + escHtml(t.name) + '" value="' + escHtml(shortVal) + '" placeholder="' + AEI18n.t('留空自动生成') + '" style="width:100%;padding:4px 8px;font-size:12px;background:var(--input-bg);border:1px solid var(--border);border-radius:3px;color:var(--btn-text);box-sizing:border-box;">';
                html += '</div>';
            }
            return html;
        }

        // 从容器收集工具编辑表单输入并保存
        function _collectAndSaveToolEditor(containerEl, serverId) {
            var cfg = serverManager.getServerConfig ? serverManager.getServerConfig(serverId) : null;
            var inputs = containerEl.querySelectorAll('.mcp-desc-input');
            var stubInputs = containerEl.querySelectorAll('.mcp-stub-input');
            // 合并到现有 descMap：保留未编辑的已有描述，更新被编辑的，清空的则删除（让系统自动生成）
            var mergedDescs = (cfg && cfg.toolDescriptions) ? Object.assign({}, cfg.toolDescriptions) : {};
            for (var k = 0; k < inputs.length; k++) {
                var name = inputs[k].getAttribute('data-tool-name');
                var val = inputs[k].value.trim();
                if (val) {
                    mergedDescs[name] = val;
                } else {
                    delete mergedDescs[name];
                }
                // 同步清理旧注册名键（迁移）——旧面板按注册名保存的值已被
                // 本次原始名键的写入取代，残留会让 registerTools 的注册名优先读取
                // 拿到陈旧值遮蔽用户本次保存
                var legacyKey = inputs[k].getAttribute('data-reg-name');
                if (legacyKey && legacyKey !== name) delete mergedDescs[legacyKey];
            }
            // 合并 stub 状态：保留未显示工具的原状态，更新显示工具的状态
            var mergedStubs = (cfg && cfg.toolStubs) ? Object.assign({}, cfg.toolStubs) : {};
            for (var s = 0; s < stubInputs.length; s++) {
                var sName = stubInputs[s].getAttribute('data-tool-name');
                var sChecked = !!stubInputs[s].checked;
                if (sChecked) {
                    delete mergedStubs[sName];
                } else {
                    mergedStubs[sName] = false;
                }
                // 同步清理旧注册名键（迁移，同上）
                var sLegacyKey = stubInputs[s].getAttribute('data-reg-name');
                if (sLegacyKey && sLegacyKey !== sName) delete mergedStubs[sLegacyKey];
            }
            var persistPromises = [];
            if (serverManager.updateToolDescriptions) {
                persistPromises.push(Promise.resolve(serverManager.updateToolDescriptions(serverId, mergedDescs)));
            }
            if (serverManager.updateToolStubs) {
                persistPromises.push(Promise.resolve(serverManager.updateToolStubs(serverId, mergedStubs)));
            }
            if (serverManager.notifyToolsChanged) {
                serverManager.notifyToolsChanged(serverId);
            }
            renderToolList();
            // 消费落盘回执——写失败不再谎报「已保存」；本次会话已生效，重启后回退
            // 两条补充——①装配缺失（两个更新入口都没有）时什么都没落盘，如实按失败提示
            //（否则 Promise.all([]) 直接弹「已保存」）；②SERVER_NOT_FOUND 等 ok:false 也计入失败
            //（只认 persisted===false 会漏，而该形态没有 persisted 字段）。
            var persistFailText = AEI18n.t('工具配置已生效，但保存失败：本次会话已生效，重启后回退');
            if (persistPromises.length === 0) {
                console.warn('[MCP] 工具配置未落盘：serverManager 缺少 updateToolDescriptions/updateToolStubs');
                if (global.AEToast) global.AEToast.show(persistFailText, 'error');
            } else {
                Promise.all(persistPromises).then(function (results) {
                    var failed = results.some(function (r) { return r && (r.persisted === false || r.ok === false); });
                    if (!global.AEToast) return;
                    if (failed) global.AEToast.show(persistFailText, 'error');
                    else global.AEToast.show(AEI18n.t('工具配置已保存'), 'success');
                }).catch(function (e) {
                    console.warn('[MCP] 工具配置落盘异常: ' + (e && e.message ? e.message : e));
                    if (global.AEToast) global.AEToast.show(persistFailText, 'error');
                });
            }
        }

        // 公用确认弹窗（使用 modal-mask 样式，与 skill-manager 对齐）
        function _showConfirmModal(title, message, onConfirm, confirmLabel) {
            var existing = document.getElementById('mcpConfirmModalDyn');
            if (existing) existing.parentNode.removeChild(existing);

            var overlay = document.createElement('div');
            overlay.className = 'modal-mask';
            overlay.id = 'mcpConfirmModalDyn';
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.zIndex = '101';

            var box = document.createElement('div');
            box.className = 'modal confirm-modal';
            box.style.opacity = '1';
            box.style.transform = 'none';
            box.innerHTML =
                '<div class="modal-head"><span>' + escHtml(title) + '</span></div>'
                + '<div class="modal-body">'
                + '<p style="margin:0;font-size:13px;line-height:1.6;color:var(--btn-text);">' + message + '</p>'
                + '</div>'
                + '<div class="btn-row" style="padding:12px 20px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:8px;justify-content:flex-end;">'
                + AEI18n.html('<button class="btn secondary" id="mcpConfirmCancelBtnDyn">取消</button>')
                + '<button class="btn" id="mcpConfirmOkBtnDyn" style="border-color:rgba(239,102,102,.4);color:#ef6666;">' + escHtml(confirmLabel || AEI18n.t('确认')) + '</button>'
                + '</div>';

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            var close = function () {
                if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            };

            tmpOn(overlay, 'click', function (e) { if (e.target === overlay) close(); });
            var cancelBtnDyn = document.getElementById('mcpConfirmCancelBtnDyn');
            if (cancelBtnDyn) cancelBtnDyn.addEventListener('click', close);
            var okBtnDyn = document.getElementById('mcpConfirmOkBtnDyn');
            if (okBtnDyn) okBtnDyn.addEventListener('click', function () {
                close();
                if (typeof onConfirm === 'function') onConfirm();
            });
        }

        function confirmServerRemove(serverId) {
            _showConfirmModal(
                AEI18n.t('移除 MCP Server'),
                AEI18n.t('确定要移除 MCP Server <b>{server}</b> 吗？所有关联工具将被卸载。', { server: escHtml(serverId) }),
                function () {
                    doRemoveServer(serverId);
                },
                AEI18n.t('确认移除')
            );
        }

        async function doRemoveServer(serverId) {
            if (!serverManager || typeof serverManager.removeServer !== 'function') return;
            serverManager.stopServerSync(serverId);
            // remove 落盘失败不能静默（回执不恒 ok:true）——
            // 运行时已移除，但重启后配置会回来，如实提示
            var r = await serverManager.removeServer(serverId);
            renderServerList();
            // 无条件刷新工具列表：移除入口在 servers tab，若仅在 tools tab 刷新，
            // 主 tab「工具 (N)」与过滤按钮计数会停留在旧值
            renderToolList();
            if (r && r.persisted === false && global.AEToast) {
                global.AEToast.show(AEI18n.t('已移除 MCP Server: {id}，但配置保存失败（本次会话已生效，重启后回退）', { id: serverId }), 'error');
            }
        }

        function renderServerList() {
            var body = document.getElementById('mcpMgmtBody');
            if (!body) return;
            var panel = body.querySelector('.mgmt-servers-panel');
            if (!panel) return;

            var servers = getServers();
            var container = panel.querySelector('.mgmt-list-container');
            if (!container) return;

            var html = '';
            html += '<div class="mgmt-actions">';
            html += AEI18n.html('<button class="btn" id="mcpServerInstallBtn">+ 添加 MCP Server</button>');
            html += '</div>';

            if (servers.length === 0) {
                html += AEI18n.html('<div class="mgmt-empty">暂无 MCP Server。点击上方按钮添加。</div>');
            } else {
                html += '<div class="mgmt-table-wrap"><table class="mgmt-table mgmt-table-servers"><thead><tr>';
                html += AEI18n.html('<th class="col-name-srv">Server ID</th><th class="col-desc-srv">端点</th><th class="col-status-srv">状态</th><th class="col-num-srv">工具数</th><th class="col-toggle-srv">自启</th><th class="col-scope-srv">作用域</th><th class="col-actions-srv">操作</th>');
                html += '</tr></thead><tbody>';

                for (var i = 0; i < servers.length; i++) {
                    var srv = servers[i];
                    var config = srv.config || {};
                    var st = srv.status || {};
                    // enabled 字段删除——列表不再有「已停用」特判，
                    // 状态列按运行状态如实显示（自启开关见「自启」列；停用 = 停止 + 关自启）
                    var stateLabel = getStateLabel(st.state);
                    var stateClass = 'mgmt-status ' + (st.state || 'unknown');
                    var stateErrorAttr = st.lastError ? ' data-last-error="' + escHtml(st.lastError) + '"' : '';
                    var scopeLabel = (config.scope && config.scope.type === 'global') ? AEI18n.t('全局') : AEI18n.t('模块');
                    var scopeClass = (config.scope && config.scope.type === 'global') ? 'global' : 'module';
                    var scopeTitle = scopeLabel;
                    if (config.scope && config.scope.type === 'module') {
                        var scMods = config.scope.moduleIds || (config.scope.moduleId ? [config.scope.moduleId] : []);
                        if (scMods.length) scopeTitle += ' (' + scMods.join(', ') + ')';
                        var scModes = config.scope.agentModes || (config.scope.mode ? [config.scope.mode] : []);
                        if (scMods.indexOf('agent') >= 0 && scModes.length) {
                            // 模式名走共享映射（外接显示「外接」，不是裸 id external-mcp）
                            var spLbl = global.AEScopePicker;
                            var scModeNames = (spLbl && typeof spLbl.modeShortLabels === 'function')
                                ? spLbl.modeShortLabels(scModes) : scModes;
                            scopeTitle += ' · Agent:' + scModeNames.join('/');
                        }
                    }
                    var autoStart = config.autoStart !== false;
                    var toolCount = getServerToolCount(srv.id);

                    html += '<tr data-server-id="' + escHtml(srv.id) + '">';
                    var isHttp = !!(config.url);
                    var transportBadge = isHttp
                        ? '<span class="mgmt-badge server">' + escHtml(config.transport || 'http') + '</span> '
                        : '<span class="mgmt-badge local">stdio</span> ';
                    var endpointText = isHttp
                        ? escHtml(config.url || '')
                        : escHtml(config.command || '-') + ' ' + escHtml((config.args || []).join(' '));

                    html += '<td class="mgmt-name">' + escHtml(srv.id) + '</td>';
                    html += '<td class="mgmt-desc" title="' + endpointText + '">' + transportBadge + '</td>';
                    var errorClickClass = st.lastError ? ' mgmt-status-clickable' : '';
                    html += '<td class="mgmt-status-cell"><span class="' + stateClass + errorClickClass + '"' + stateErrorAttr + '>' + stateLabel + '</span></td>';
                    html += '<td class="mgmt-num">' + toolCount + '</td>';
                    html += '<td class="mgmt-toggle-cell"><label class="toggle-wrap"><input type="checkbox" class="switch-input server-auto-toggle" data-server-id="' + escHtml(srv.id) + '"' + (autoStart ? ' checked' : '') + '><span class="switch-slider"></span></label></td>';
                    html += '<td class="mgmt-badge-cell"><span class="mgmt-badge ' + scopeClass + '" title="' + escHtml(scopeTitle) + '">' + scopeLabel + '</span></td>';
                    html += '<td class="mgmt-actions-cell">';
                    // tools/list 拉取失败：状态仍为已连接但工具不可用——在重启/重试
                    // 按钮旁如实标注（复用同一失败明细通道；不能只 console.warn）。
                    // 仅 connected/connecting 展示——已停止/断开/删除的
                    // 服务器不得再挂「工具列表拉取失败」徽标（明细已由
                    // unregisterByServer 清空，此处按当前连接状态兜底过滤）
                    var srvFetchErrs = _isServerActive(st.state) ? _splitAvailabilityErrors(srv.id).fetch : [];
                    if (srvFetchErrs.length > 0) {
                        var fetchErrTitle = srvFetchErrs[0].error
                            + (srvFetchErrs[0].time ? '（' + _formatErrTime(srvFetchErrs[0].time) + '）' : '');
                        html += '<span class="mgmt-badge" style="border-color:rgba(239,102,102,.4);color:#ef6666;margin-right:6px;" title="' + escHtml(fetchErrTitle) + '">' + AEI18n.t('工具列表拉取失败') + '</span>';
                    }
                    if (st.state === 'connected') {
                        html += '<button class="btn secondary server-stop-btn" data-server-id="' + escHtml(srv.id) + '">' + AEI18n.t('停止') + '</button>';
                        html += '<button class="btn secondary server-restart-btn" data-server-id="' + escHtml(srv.id) + '">' + AEI18n.t('重启') + '</button>';
                    } else if (st.state === 'connecting') {
                        html += AEI18n.html('<button class="btn secondary mgmt-btn-loading" disabled><span class="mgmt-spin"></span><span class="mgmt-spin-placeholder">启动</span></button>');
                    } else if (st.state === 'disconnected') {
                        html += '<button class="btn secondary server-start-btn" data-server-id="' + escHtml(srv.id) + '">' + AEI18n.t('重连') + '</button>';
                    } else {
                        html += '<button class="btn secondary server-start-btn" data-server-id="' + escHtml(srv.id) + '">' + AEI18n.t('启动') + '</button>';
                    }
                    html += '<button class="btn secondary server-edit-btn" data-server-id="' + escHtml(srv.id) + '">' + AEI18n.t('编辑') + '</button>';
                    html += '<button class="btn secondary server-remove-btn" data-server-id="' + escHtml(srv.id) + '">' + AEI18n.t('移除') + '</button>';
                    html += '</td>';
                    html += '</tr>';
                }

                html += '</tbody></table></div>';
            }

            container.innerHTML = html;

            bindServerListEvents(container);
        }

        function getStateLabel(state) {
            var labels = {
                'connecting': AEI18n.t('连接中'),
                'connected': AEI18n.t('已连接'),
                'disconnected': AEI18n.t('已断开'),
                'stopped': AEI18n.t('已停止')
            };
            return labels[state] || state || AEI18n.t('未知');
        }

        // enabled 字段删除——停用改由「自启」开关
        //（autoStart=false）+ 停止按钮表达，显式「启动/重启」不受影响。

        function bindServerListEvents(container) {
            var startBtns = container.querySelectorAll('.server-start-btn');
            for (var i = 0; i < startBtns.length; i++) {
                tmpOn(startBtns[i], 'click', function() {
                    var serverId = this.getAttribute('data-server-id');
                    if (serverId && serverManager && typeof serverManager.startServer === 'function') {
                        serverManager.startServer(serverId);
                        setTimeout(function() { renderServerList(); }, 500);
                    }
                });
            }

            var stopBtns = container.querySelectorAll('.server-stop-btn');
            for (var j = 0; j < stopBtns.length; j++) {
                tmpOn(stopBtns[j], 'click', function() {
                    var serverId = this.getAttribute('data-server-id');
                    if (serverId && serverManager && typeof serverManager.stopServer === 'function') {
                        serverManager.stopServer(serverId);
                        setTimeout(function() { renderServerList(); }, 300);
                    }
                });
            }

            var restartBtns = container.querySelectorAll('.server-restart-btn');
            for (var k = 0; k < restartBtns.length; k++) {
                tmpOn(restartBtns[k], 'click', function() {
                    var serverId = this.getAttribute('data-server-id');
                    if (serverId && serverManager && typeof serverManager.restartServer === 'function') {
                        serverManager.restartServer(serverId);
                        setTimeout(function() { renderServerList(); }, 500);
                    }
                });
            }

            var editBtns = container.querySelectorAll('.server-edit-btn');
            for (var l = 0; l < editBtns.length; l++) {
                tmpOn(editBtns[l], 'click', function() {
                    var serverId = this.getAttribute('data-server-id');
                    if (serverId) showServerInstallWizard(serverId);
                });
            }

            var removeBtns = container.querySelectorAll('.server-remove-btn');
            for (var m = 0; m < removeBtns.length; m++) {
                tmpOn(removeBtns[m], 'click', function() {
                    var serverId = this.getAttribute('data-server-id');
                    if (serverId) confirmServerRemove(serverId);
                });
            }

            var autoToggles = container.querySelectorAll('.server-auto-toggle');
            for (var n = 0; n < autoToggles.length; n++) {
                tmpOn(autoToggles[n], 'change', function() {
                    var serverId = this.getAttribute('data-server-id');
                    var checked = !!this.checked;
                    // 走 update 而非 add：add 会硬编码清空 toolDescriptions/toolStubs 缓存，
                    // 点一下开关就会丢掉 LLM 已生成的全部短描述与逐工具 Stub 设置
                    if (serverId && serverManager && typeof serverManager.updateServer === 'function') {
                        // update 落盘失败（persisted=false）时内存开关已生效、
                        // 重启会回退——对齐 toggleTool 的失败提示，不再静默
                        Promise.resolve(serverManager.updateServer(serverId, { autoStart: checked })).then(function(r) {
                            if (r && r.persisted === false && global.AEToast) {
                                global.AEToast.show(AEI18n.t('自启开关保存失败（本次会话已生效，重启后回退）'), 'error');
                            }
                        });
                    }
                });
            }

            var installBtn = document.getElementById('mcpServerInstallBtn');
            if (installBtn) {
                tmpOn(installBtn, 'click', function () {
                    showServerInstallWizard();
                });
            }

            var statusSpans = container.querySelectorAll('.mgmt-status-clickable');
            for (var p = 0; p < statusSpans.length; p++) {
                tmpOn(statusSpans[p], 'click', function(e) {
                    e.stopPropagation();
                    showErrorPopup(this);
                });
            }
        }

        var modalZIndex = 1000;
        function getModalZIndex() { return ++modalZIndex; }

        function showErrorPopup(targetEl) {
            var existing = document.getElementById('mcpErrorPopup');
            if (existing && existing.parentNode) {
                existing.parentNode.removeChild(existing);
            }
            if (existing && existing._target === targetEl) return;

            var errorText = targetEl.getAttribute('data-last-error');
            if (!errorText) return;

            var popup = document.createElement('div');
            popup.className = 'mgmt-error-popup';
            popup.id = 'mcpErrorPopup';
            popup._target = targetEl;
            popup.style.zIndex = getModalZIndex();

            popup.innerHTML = AEI18n.html('<div class="mgmt-error-popup-head">错误详情</div>')
                + '<div class="mgmt-error-popup-body">' + escHtml(errorText) + '</div>'
                + '<div class="mgmt-error-popup-actions">'
                + '<button class="btn secondary mgmt-error-copy-btn">' + AEI18n.t('复制') + '</button>'
                + AEI18n.html('<button class="btn secondary mgmt-error-close-btn">关闭</button>')
                + '</div>';

            document.body.appendChild(popup);

            var popupRect = popup.getBoundingClientRect();
            var targetRect = targetEl.getBoundingClientRect();
            var top = targetRect.bottom + 4;
            var left = targetRect.left;
            if (top + popupRect.height > window.innerHeight) {
                top = targetRect.top - popupRect.height - 4;
            }
            if (left + 300 > window.innerWidth) {
                left = window.innerWidth - 310;
            }
            popup.style.top = top + 'px';
            popup.style.left = left + 'px';

            var copyBtn = popup.querySelector('.mgmt-error-copy-btn');
            if (copyBtn) {
                tmpOn(copyBtn, 'click', function() {
                    _copyTextToClipboard(errorText);
                    copyBtn.textContent = AEI18n.t('已复制');
                    setTimeout(function() { copyBtn.textContent = AEI18n.t('复制'); }, 1500);
                });
            }

            var closeBtn = popup.querySelector('.mgmt-error-close-btn');
            if (closeBtn) {
                tmpOn(closeBtn, 'click', function() {
                    // 关闭路径同步摘除 document 捕获监听器——若只移除
                    // 弹窗 DOM，onClickOutside 残留到下一次全局点击才自清（且期间闭包
                    // 持有已卸载的 popup/targetEl 阻止回收）
                    document.removeEventListener('click', onClickOutside, true);
                    if (popup.parentNode) popup.parentNode.removeChild(popup);
                });
            }

            function onClickOutside(e) {
                if (!popup.contains(e.target) && e.target !== targetEl) {
                    if (popup.parentNode) popup.parentNode.removeChild(popup);
                    document.removeEventListener('click', onClickOutside, true);
                }
            }
            setTimeout(function() {
                document.addEventListener('click', onClickOutside, true);
            }, 0);
        }

        function getRegisteredModules() {
            var list = [];
            if (global.AEAppContainer && typeof global.AEAppContainer.listModules === 'function') {
                var modules = global.AEAppContainer.listModules();
                for (var i = 0; i < modules.length; i++) {
                    list.push({ id: modules[i].id, title: modules[i].title || modules[i].id });
                }
            }
            return list;
        }

        function showServerInstallWizard(editServerId) {
            _ensureEnvPwdCss();
            _ensureJsonHighlightCss();
            var existing = document.getElementById('mcpServerInstallModal');
            if (existing) {
                // 先销毁上一个向导的 ScopePicker 再移除 DOM，避免事件泄漏
                if (_wizardScopePicker) {
                    try { _wizardScopePicker.destroy(); } catch (e) {}
                    _wizardScopePicker = null;
                }
                existing.parentNode.removeChild(existing);
            }

            var isEdit = typeof editServerId === 'string' && editServerId.length > 0;
            var editConfig = null;
            if (isEdit && serverManager && typeof serverManager.getServerConfig === 'function') {
                editConfig = serverManager.getServerConfig(editServerId) || null;
            }

            var overlay = document.createElement('div');
            overlay.className = 'modal-mask';
            overlay.id = 'mcpServerInstallModal';
            overlay.style.display = 'flex';
            overlay.style.opacity = '1';
            overlay.style.zIndex = getModalZIndex();

            var box = document.createElement('div');
            box.className = 'modal';
            box.style.opacity = '1';
            box.style.transform = 'none';
            box.style.width = isEdit ? 'min(680px, 92vw)' : 'min(560px, 92vw)';

            var titleText = isEdit ? (AEI18n.t('编辑 MCP Server: ') + escHtml(editServerId)) : AEI18n.t('添加 MCP Server');
            var confirmText = isEdit ? AEI18n.t('保存修改') : AEI18n.t('确认添加');
            // 编辑模式：配置 / 工具 两个 tab；新建模式：粘贴配置 / 手动填写 两个 tab
            var tabHtml = isEdit ? (
                '<div class="mcp-modal-tabs">'
                + AEI18n.html('<button class="mcp-modal-tab active" data-tab="config">配置</button>')
                + AEI18n.html('<button class="mcp-modal-tab" data-tab="tools">工具</button>')
                + '</div>'
            ) : (
                '<div class="mcp-modal-tabs">'
                + AEI18n.html('<button class="mcp-modal-tab active" data-tab="paste">粘贴配置</button>')
                + AEI18n.html('<button class="mcp-modal-tab" data-tab="manual">手动填写</button>')
                + '</div>'
                + '<div class="mcp-tab-content" id="mcpServerTabPaste">'
                + '<div class="mcp-form-section">'
                + AEI18n.html('<div class="mcp-form-section-title">JSON 配置</div>')
                + '<div class="row row-full"><div class="aexp-json-wrap"><pre aria-hidden="true"><code id="mcpPasteHighlightCode"></code></pre><textarea id="mcpServerPasteContent" rows="6" spellcheck="false"></textarea></div></div>'
                + AEI18n.html('<div class="row row-full"><span style="font-size:11px;color:var(--text-muted);">支持 stdio (command+args) / HTTP (url) / SSE (url, transport:"sse")</span></div>')
                + '</div>'
                + '</div>'
            );

            // 预填值
            var preId = isEdit ? editServerId : '';
            var preCmd = (editConfig && editConfig.command) ? editConfig.command : '';
            var preArgs = (editConfig && editConfig.args && editConfig.args.length) ? editConfig.args.join('\n') : '';
            var preEnv = (editConfig && editConfig.env && typeof editConfig.env === 'object') ?
                Object.keys(editConfig.env).map(function(k) { return k + '=' + editConfig.env[k]; }).join('\n') : '';
            var preUrl = (editConfig && editConfig.url) ? editConfig.url : '';
            var preHeaders = (editConfig && editConfig.headers && typeof editConfig.headers === 'object') ?
                Object.keys(editConfig.headers).map(function(k) { return k + ': ' + editConfig.headers[k]; }).join('\n') : '';
            var preAutoStart = (!editConfig || editConfig.autoStart !== false) ? ' checked' : '';
            var defaultTransport = (editConfig && editConfig.transport) ? editConfig.transport : 'stdio';
            var defaultScope = (editConfig && editConfig.scope && editConfig.scope.type === 'module') ? 'module' : 'global';
            var defaultMods = [];
            var defaultModes = [];
            if (editConfig && editConfig.scope && editConfig.scope.type === 'module') {
                defaultMods = editConfig.scope.moduleIds || (editConfig.scope.moduleId ? [editConfig.scope.moduleId] : []);
                defaultModes = editConfig.scope.agentModes || (editConfig.scope.mode ? [editConfig.scope.mode] : []);
            }
            var registeredModules = getRegisteredModules();
            // 目标模块容纳框：由共享组件 AEScopePicker 渲染（点击弹窗逐模块+模式添加）
            var scopePickerInitial = { moduleIds: defaultMods, agentModes: defaultModes };

            // 作用域区（作用域 select + 目标模块容纳框）：挂在两个 tab / 子 tab 之外，由
            // 「粘贴配置」与「手动填写」共用——粘贴路径没有作用域入口时，粘贴导入的服务器
            // 只能落成全局；编辑路径的「粘贴配置」子 tab 同样看不到（表单被切走了）。
            var scopeSectionHtml = ''
                + '<div class="mcp-form-section">'
                + '<div class="mcp-form-section-title">' + AEI18n.t('作用域') + '</div>'
                + '<div class="row"><label>' + AEI18n.t('作用域') + '</label><select id="mcpServerScope"></select></div>'
                + '<div class="row" id="mcpModuleRow" style="display:none;"><label>' + AEI18n.t('目标模块') + '</label><div id="mcpScopePickerContainer"></div></div>'
                + '</div>';

            // 配置表单内容（新建「手动填写」tab 与编辑「配置」tab 的「手动填写」子 tab 共用）
            var configFormHtml = ''
                + '<div class="mcp-form-section">'
                + '<div class="mcp-form-section-title">' + AEI18n.t('基础信息') + '</div>'
                + (isEdit ? '' : '<div class="row"><label>Server ID</label><input type="text" id="mcpServerId" placeholder="my-mcp-server" value="' + escHtml(preId) + '"></div>')
                + '<div class="row"><label>' + AEI18n.t('传输类型') + '</label><select id="mcpServerTransport"></select></div>'
                + '</div>'
                + '<div class="mcp-form-section" id="mcpHttpSection">'
                + '<div class="mcp-form-section-title">' + AEI18n.t('HTTP / SSE 连接') + '</div>'
                + '<div class="row" id="mcpUrlRow"><label>URL</label><input type="text" id="mcpServerUrl" placeholder="' + escHtml(AEI18n.t('http://remote:3000/mcp 或 http://remote:3000/sse')) + '" value="' + escHtml(preUrl) + '"></div>'
                + '<div class="row" id="mcpHeadersRow"><label>' + AEI18n.t('请求头') + '</label><textarea id="mcpServerHeaders" rows="3" placeholder="Authorization: Bearer xxx&#10;X-Custom-Header: value">' + escHtml(preHeaders) + '</textarea></div>'
                + '</div>'
                + '<div class="mcp-form-section" id="mcpStdioSection">'
                + '<div class="mcp-form-section-title">' + AEI18n.t('Stdio 进程') + '</div>'
                + '<div id="mcpStdioFields">'
                + '<div class="row"><label>' + AEI18n.t('命令') + '</label><input type="text" id="mcpServerCommand" placeholder="npx" value="' + escHtml(preCmd) + '"></div>'
                + '<div class="row"><label>' + AEI18n.t('参数') + '</label><textarea id="mcpServerArgs" rows="3" placeholder="-y&#10;@scope/server">' + escHtml(preArgs) + '</textarea></div>'
                + '<div class="row"><label>' + AEI18n.t('环境变量') + '</label><div class="aexp-pwd-wrap"><textarea id="mcpServerEnv" rows="3" placeholder="NODE_ENV=production&#10;API_KEY=xxx">' + escHtml(preEnv) + '</textarea><button type="button" class="toggle-pwd" id="mcpServerEnvToggle" title="' + escHtml(AEI18n.t('显示/隐藏环境变量值')) + '"><span class="eye-open">' + _EYE_OPEN_SVG + '</span><span class="eye-off">' + _EYE_OFF_SVG + '</span></button></div></div>'
                + '</div>'
                + '</div>'
                ;

            box.innerHTML = '<div class="modal-head"><span>' + titleText + '</span>'
                + AEI18n.html('<label class="toggle-wrap" title="自动启动：连接就绪/面板启动时自动拉起此服务器；关闭＝不参与自启（停用服务器还须用停止按钮断开，之后仍可手动启动）" style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0 0 0 10px;">')
                + AEI18n.html('<span style="font-size:12px;color:var(--text-muted);">自启</span>')
                + '<input type="checkbox" class="switch-input" id="mcpServerAutoStart"' + preAutoStart + '>'
                + '<span class="switch-slider" aria-hidden="true"></span>'
                + '</label>'
                + AEI18n.html('<button class="icon-btn" id="mcpServerModalCloseBtn" style="margin-left:auto;">关闭</button>')
                + '</div>'
                + '<div class="modal-body">'
                + tabHtml
                + (isEdit
                    ? '<div class="mcp-tab-content" id="mcpServerTabConfig">'
                        + '<div class="mcp-modal-subtabs">'
                        + AEI18n.html('<button class="mcp-modal-subtab active" data-subtab="form">手动填写</button>')
                        + AEI18n.html('<button class="mcp-modal-subtab" data-subtab="paste">粘贴配置</button>')
                        + '</div>'
                        + '<div id="mcpConfigForm">' + configFormHtml + '</div>'
                        + '<div id="mcpConfigPaste" style="display:none;">'
                        + '<div class="mcp-form-section">'
                        + AEI18n.html('<div class="mcp-form-section-title">JSON 配置</div>')
                        + '<div class="row row-full"><div class="aexp-json-wrap"><pre aria-hidden="true"><code id="mcpEditPasteHighlightCode"></code></pre><textarea id="mcpEditPasteContent" rows="8" spellcheck="false"></textarea></div></div>'
                        + '</div>'
                        + '</div>'
                        + scopeSectionHtml
                        + '</div>'
                    : '<div class="mcp-tab-content" id="mcpServerTabManual" style="display:none;">' + configFormHtml + '</div>'
                        + scopeSectionHtml)
                + (isEdit ? '<div class="mcp-tab-content" id="mcpServerTabTools" style="display:none;overflow-y:auto;max-height:60vh;padding:4px 0;">' + _buildToolEditorBody(editServerId) + '</div>' : '')
                + '</div>'
                + '<div class="btn-row" style="padding:12px 20px;border-top:1px solid rgba(255,255,255,.06);display:flex;gap:8px;align-items:center;justify-content:flex-end;">'
                + '<span class="status-inline" id="mcpServerInstallStatus" style="display:none;margin-right:auto;max-width:260px;"></span>'
                + AEI18n.html('<button class="btn secondary" id="mcpServerInstallModalCancelBtn">取消</button>')
                + '<button class="btn" id="mcpServerInstallModalConfirmBtn">' + confirmText + '</button>'
                + '</div>';

            overlay.appendChild(box);
            document.body.appendChild(overlay);

            // 动态填充 transport select（避免 Chrome 88 CEF 静态 <option> bug）
            var transportSel = document.getElementById('mcpServerTransport');
            if (transportSel) {
                var transportOptions = [
                    { value: 'stdio', label: AEI18n.t('stdio (本地进程)') },
                    { value: 'http', label: 'HTTP (Streamable)' },
                    { value: 'sse', label: 'SSE (Legacy)' }
                ];
                for (var ti = 0; ti < transportOptions.length; ti++) {
                    var tOpt = document.createElement('option');
                    tOpt.value = transportOptions[ti].value;
                    tOpt.textContent = transportOptions[ti].label;
                    if (transportOptions[ti].value === defaultTransport) tOpt.selected = true;
                    transportSel.appendChild(tOpt);
                }
            }

            // 动态填充 scope select（避免 Chrome 88 CEF 静态 <option> bug）
            var scopeSel = document.getElementById('mcpServerScope');
            if (scopeSel) {
                var scopeOptions = [
                    { value: 'global', label: AEI18n.t('全局') },
                    { value: 'module', label: AEI18n.t('模块') }
                ];
                for (var si = 0; si < scopeOptions.length; si++) {
                    var sOpt = document.createElement('option');
                    sOpt.value = scopeOptions[si].value;
                    sOpt.textContent = scopeOptions[si].label;
                    if (scopeOptions[si].value === defaultScope) sOpt.selected = true;
                    scopeSel.appendChild(sOpt);
                }
            }

            // 作用域切换时显示/隐藏模块选择器
            var moduleRow = document.getElementById('mcpModuleRow');
            function updateScopeRows() {
                var scopeVal = scopeSel ? scopeSel.value : 'global';
                var showModule = (scopeVal === 'module');
                if (moduleRow) moduleRow.style.display = showModule ? '' : 'none';
            }
            if (scopeSel) {
                tmpOn(scopeSel, 'change', updateScopeRows);
                updateScopeRows();
            }
            // 目标模块容纳框：共享组件 AEScopePicker（点击弹窗逐模块+模式添加）
            var scopePicker = null;
            var scopePickerContainer = document.getElementById('mcpScopePickerContainer');
            if (scopePickerContainer && global.AEScopePicker) {
                scopePicker = global.AEScopePicker.create({
                    container: scopePickerContainer,
                    modules: registeredModules,
                    value: scopePickerInitial,
                    onChange: _syncFormToPaste
                });
                // 记录到闭包变量：hideServerInstallWizard 统一销毁。
                // 每次打开向导都给 hideServerInstallWizard 再包一层闭包时，
                // 长会话反复打开会无限累积包装层
                _wizardScopePicker = scopePicker;
            }

            // 单台配置声明了 scope 时把作用域控件同步过去——粘贴后控件显示的正是会写入的
            // 作用域（多台时控件表达不了逐台差异，未声明的按控件、声明的逐台优先，见
            // confirmServerInstallFromModal 的粘贴分支）。未声明 scope 时不动控件，
            // 不覆盖用户已做的选择。
            function _syncScopeFromPaste() {
                if (!pasteEl) return;
                var rawText = pasteEl.value.trim();
                if (!rawText) return;
                var cfg;
                try { cfg = JSON.parse(rawText); }
                catch (e) { return; }
                if (!cfg || typeof cfg !== 'object') return;
                if (cfg.servers && typeof cfg.servers === 'object' && !Array.isArray(cfg.servers)) cfg = cfg.servers;
                else if (cfg.mcpServers && typeof cfg.mcpServers === 'object' && !Array.isArray(cfg.mcpServers)) cfg = cfg.mcpServers;
                else if (cfg.mcp && typeof cfg.mcp === 'object' && !Array.isArray(cfg.mcp)) cfg = cfg.mcp;
                var pIds = Object.keys(cfg);
                if (pIds.length !== 1) return;
                var one = cfg[pIds[0]];
                if (!one || typeof one !== 'object' || !one.scope) return;
                var isModule = (one.scope.type === 'module');
                if (scopeSel) scopeSel.value = isModule ? 'module' : 'global';
                if (scopePicker) {
                    scopePicker.setValue(isModule ? {
                        moduleIds: one.scope.moduleIds || (one.scope.moduleId ? [one.scope.moduleId] : []),
                        agentModes: one.scope.agentModes || (one.scope.mode ? [one.scope.mode] : [])
                    } : { moduleIds: [], agentModes: [] });
                }
                updateScopeRows();
            }

            tmpOn(overlay, 'click', function(e) {
                if (e.target === overlay) hideServerInstallWizard();
            });

            var modalCloseBtn = document.getElementById('mcpServerModalCloseBtn');
            if (modalCloseBtn) tmpOn(modalCloseBtn, 'click', hideServerInstallWizard);

            var modalCancelBtn = document.getElementById('mcpServerInstallModalCancelBtn');
            if (modalCancelBtn) {
                tmpOn(modalCancelBtn, 'click', hideServerInstallWizard);
            }

            var modalConfirmBtn = document.getElementById('mcpServerInstallModalConfirmBtn');
            if (modalConfirmBtn) {
                tmpOn(modalConfirmBtn, 'click', confirmServerInstallFromModal);
            }

            // 环境变量明文/密文切换（眼睛按钮）：密文时整个输入框变黑（背景黑、文字透明），
            // 真实值始终保留在 value / data-real 中，编辑需切明文
            var envToggleBtn = document.getElementById('mcpServerEnvToggle');
            var envTextarea = document.getElementById('mcpServerEnv');
            if (envToggleBtn && envTextarea) {
                // 真实值存于 data-real；默认密文（value 已是真实值，由 aexp-masked 变黑遮住）
                // 密文态 readOnly 拦截输入——确认保存时密文态读 dataset.real，
                // 可聚焦盲打的输入会被静默丢弃；置 readOnly 后输入在源头被阻止
                envTextarea.dataset.real = preEnv || '';
                envTextarea.dataset.masked = '1';
                envTextarea.readOnly = true;
                envTextarea.classList.add('aexp-masked');
                tmpOn(envToggleBtn, 'click', function() {
                    var isMasked = envTextarea.dataset.masked === '1';
                    if (isMasked) {
                        // 切明文：显示真实值，允许编辑
                        envTextarea.value = envTextarea.dataset.real;
                        envTextarea.dataset.masked = '0';
                        envTextarea.readOnly = false;
                        envTextarea.classList.remove('aexp-masked');
                        envToggleBtn.classList.add('visible');
                    } else {
                        // 切密文：记录当前编辑结果，整框变黑
                        envTextarea.dataset.real = envTextarea.value;
                        envTextarea.dataset.masked = '1';
                        envTextarea.readOnly = true;
                        envTextarea.classList.add('aexp-masked');
                        envToggleBtn.classList.remove('visible');
                    }
                });
            }

            // 粘贴 JSON 配置代码高亮（Prism）：textarea 输入即高亮，滚动用 transform 平移 overlay 保持对齐
            var pasteEl = document.getElementById('mcpServerPasteContent');
            var pasteCodeEl = document.getElementById('mcpPasteHighlightCode');
            var pasteWrap = pasteEl ? pasteEl.closest('.aexp-json-wrap') : null;
            if (pasteEl && pasteCodeEl && pasteWrap) {
                // 打开即把示例填成框内真实内容（可选中/复制/就地改），不是 placeholder
                pasteEl.value = JSON_EXAMPLE_SERVER;
                _highlightPasteJson(pasteEl, pasteCodeEl, pasteWrap);
                tmpOn(pasteEl, 'input', function() {
                    _highlightPasteJson(pasteEl, pasteCodeEl, pasteWrap);
                    // 单台配置声明了 scope 时同步到作用域控件（见函数注释）
                    _syncScopeFromPaste();
                });
                tmpOn(pasteEl, 'scroll', function() {
                    pasteCodeEl.style.transform = 'translate(' + (-pasteEl.scrollLeft) + 'px,' + (-pasteEl.scrollTop) + 'px)';
                });
            }

            // 编辑模式：配置 tab 内「粘贴配置」子 tab 的代码高亮（复用同一套 overlay 方案）
            var editPasteEl = isEdit ? document.getElementById('mcpEditPasteContent') : null;
            var editPasteCodeEl = isEdit ? document.getElementById('mcpEditPasteHighlightCode') : null;
            var editPasteWrap = editPasteEl ? editPasteEl.closest('.aexp-json-wrap') : null;
            if (editPasteEl && editPasteCodeEl && editPasteWrap) {
                // 打开即填示例（框内真实内容，可选中/删改/直接打字），不是 placeholder
                editPasteEl.value = JSON_EXAMPLE_EDIT;
                _highlightPasteJson(editPasteEl, editPasteCodeEl, editPasteWrap);
                tmpOn(editPasteEl, 'input', function() {
                    _highlightPasteJson(editPasteEl, editPasteCodeEl, editPasteWrap);
                    // 自动同步：粘贴配置变化即应用到表单
                    _applyEditPasteToForm();
                });
                tmpOn(editPasteEl, 'scroll', function() {
                    editPasteCodeEl.style.transform = 'translate(' + (-editPasteEl.scrollLeft) + 'px,' + (-editPasteEl.scrollTop) + 'px)';
                });
            }

            // 编辑模式：配置 tab 内「粘贴配置」→ 自动同步到手动填写表单（仅支持单台配置）。
            // 输入变化即触发；JSON 无效或非单台时静默忽略，保持表单不变；
            // 内容仍是示例时同样忽略——否则用户只是点进框里按了个键，表单就被示例值覆盖。
            function _applyEditPasteToForm() {
                if (!editPasteEl) return;
                var rawText = editPasteEl.value.trim();
                if (!rawText) return;
                if (_isExampleOnly(rawText)) return;
                var parsedCfg;
                try { parsedCfg = JSON.parse(rawText); }
                catch (e) { return; }
                // JSON.parse("null") 等非对象结果：下方 parsedCfg.servers 属性访问会抛未捕获 TypeError
                if (!parsedCfg || typeof parsedCfg !== 'object') return;
                if (parsedCfg.servers && typeof parsedCfg.servers === 'object' && !Array.isArray(parsedCfg.servers)) parsedCfg = parsedCfg.servers;
                else if (parsedCfg.mcpServers && typeof parsedCfg.mcpServers === 'object' && !Array.isArray(parsedCfg.mcpServers)) parsedCfg = parsedCfg.mcpServers;
                else if (parsedCfg.mcp && typeof parsedCfg.mcp === 'object' && !Array.isArray(parsedCfg.mcp)) parsedCfg = parsedCfg.mcp;
                var pIds = Object.keys(parsedCfg);
                if (pIds.length !== 1) return;
                var pCfg = parsedCfg[pIds[0]];
                if (!pCfg || typeof pCfg !== 'object') return;

                // 传输类型
                var tSel3 = document.getElementById('mcpServerTransport');
                if (tSel3 && pCfg.transport) {
                    for (var to2 = 0; to2 < tSel3.options.length; to2++) {
                        if (tSel3.options[to2].value === pCfg.transport) { tSel3.options[to2].selected = true; break; }
                    }
                }
                // HTTP/SSE
                var urlEl3 = document.getElementById('mcpServerUrl');
                if (urlEl3) urlEl3.value = pCfg.url || '';
                var hdEl3 = document.getElementById('mcpServerHeaders');
                if (hdEl3) hdEl3.value = (pCfg.headers && typeof pCfg.headers === 'object') ? Object.keys(pCfg.headers).map(function(k) { return k + ': ' + pCfg.headers[k]; }).join('\n') : '';
                // Stdio
                var cmdEl3 = document.getElementById('mcpServerCommand');
                if (cmdEl3) cmdEl3.value = pCfg.command || '';
                var argEl3 = document.getElementById('mcpServerArgs');
                if (argEl3) argEl3.value = (pCfg.args && pCfg.args.length) ? pCfg.args.join('\n') : '';
                // 环境变量（写入真实值并切明文，便于核对）
                var envEl3 = document.getElementById('mcpServerEnv');
                var envTg3 = document.getElementById('mcpServerEnvToggle');
                var envText3 = (pCfg.env && typeof pCfg.env === 'object') ? Object.keys(pCfg.env).map(function(k) { return k + '=' + pCfg.env[k]; }).join('\n') : '';
                if (envEl3) {
                    envEl3.value = envText3;
                    envEl3.dataset.real = envText3;
                    envEl3.dataset.masked = '0';
                    envEl3.readOnly = false;
                    envEl3.classList.remove('aexp-masked');
                    if (envTg3) envTg3.classList.add('visible');
                }
                // 作用域
                var scpSel = document.getElementById('mcpServerScope');
                if (scpSel) scpSel.value = (pCfg.scope && pCfg.scope.type === 'module') ? 'module' : 'global';
                if (pCfg.scope && pCfg.scope.type === 'module') {
                    var pModIds = pCfg.scope.moduleIds || (pCfg.scope.moduleId ? [pCfg.scope.moduleId] : []);
                    var pModes = pCfg.scope.agentModes || (pCfg.scope.mode ? [pCfg.scope.mode] : []);
                    if (scopePicker) scopePicker.setValue({ moduleIds: pModIds, agentModes: pModes });
                } else if (scopePicker) {
                    scopePicker.setValue({ moduleIds: [], agentModes: [] });
                }
                updateTransportFields();
                updateScopeRows();
            }

            // 反向同步：表单修改自动写回 JSON 粘贴框
            function _syncFormToPaste() {
                if (!editPasteEl) return;
                var cfg = {};
                // 传输类型
                var tSel = document.getElementById('mcpServerTransport');
                if (tSel && tSel.value) cfg.transport = tSel.value;
                // HTTP/SSE
                var urlEl = document.getElementById('mcpServerUrl');
                if (urlEl && urlEl.value.trim()) cfg.url = urlEl.value.trim();
                // 请求头（每一行 key: value 解析）
                var hdEl = document.getElementById('mcpServerHeaders');
                if (hdEl && hdEl.value.trim()) {
                    var headers = {};
                    var lines = hdEl.value.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
                    lines.forEach(function(line) {
                        var colonIdx = line.indexOf(':');
                        if (colonIdx >= 0) {
                            var k = line.slice(0, colonIdx).trim();
                            var v = line.slice(colonIdx + 1).trim();
                            if (k) headers[k] = v;
                        }
                    });
                    if (Object.keys(headers).length) cfg.headers = headers;
                }
                // Stdio
                var cmdEl = document.getElementById('mcpServerCommand');
                if (cmdEl && cmdEl.value.trim()) cfg.command = cmdEl.value.trim();
                var argEl = document.getElementById('mcpServerArgs');
                if (argEl && argEl.value.trim()) {
                    cfg.args = argEl.value.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
                }
                // 环境变量（每一行 key=value 解析）
                var envEl = document.getElementById('mcpServerEnv');
                if (envEl && envEl.value.trim()) {
                    var env = {};
                    var lines = envEl.value.split('\n').map(function(l) { return l.trim(); }).filter(function(l) { return l; });
                    lines.forEach(function(line) {
                        var eqIdx = line.indexOf('=');
                        if (eqIdx >= 0) {
                            var k = line.slice(0, eqIdx).trim();
                            var v = line.slice(eqIdx + 1).trim();
                            if (k) env[k] = v;
                        }
                    });
                    if (Object.keys(env).length) cfg.env = env;
                }
                // 作用域
                var scpSel = document.getElementById('mcpServerScope');
                if (scpSel && scopePicker) {
                    var val = scopePicker.getValue();
                    if (val.moduleIds && val.moduleIds.length) {
                        cfg.scope = {
                            type: 'module',
                            moduleIds: val.moduleIds,
                            agentModes: val.agentModes
                        };
                    } else {
                        cfg.scope = { type: 'global' };
                    }
                }
                // 写入 JSON 粘贴框
                var singleCfg = {};
                // 取当前 server id 作为 key（编辑模式始终单台，与新建不同）
                if (typeof editServerId === 'string' && editServerId) {
                    singleCfg[editServerId] = cfg;
                } else {
                    // 新建流程不会走到这里（编辑模式才会有配置 tab + 粘贴子 tab）
                    return;
                }
                editPasteEl.value = JSON.stringify(singleCfg, null, 2);
                // 更新高亮
                if (editPasteCodeEl && editPasteWrap) {
                    _highlightPasteJson(editPasteEl, editPasteCodeEl, editPasteWrap);
                }
            }

            // 给表单各输入绑定反向同步事件
            var formInputs = [
                document.getElementById('mcpServerTransport'),
                document.getElementById('mcpServerUrl'),
                document.getElementById('mcpServerHeaders'),
                document.getElementById('mcpServerCommand'),
                document.getElementById('mcpServerArgs'),
                document.getElementById('mcpServerEnv')
            ];
            formInputs.forEach(function(el) {
                if (!el) return;
                var eventType = (el.tagName.toLowerCase() === 'select') ? 'change' : 'input';
                tmpOn(el, eventType, _syncFormToPaste);
            });
            // 作用域变化经 AEScopePicker 的 onChange 回调处理（见创建处），无需额外绑定
            // transport 切换已绑过 updateTransportFields，这里不重复绑

            // 编辑模式：配置 tab 内「手动填写 / 粘贴配置」子 tab 切换
            var subtabBtns = box.querySelectorAll('.mcp-modal-subtab');
            for (var st = 0; st < subtabBtns.length; st++) {
                (function(btn) {
                    tmpOn(btn, 'click', function() {
                        var name = btn.getAttribute('data-subtab');
                        var allBtn = box.querySelectorAll('.mcp-modal-subtab');
                        for (var sk = 0; sk < allBtn.length; sk++) allBtn[sk].classList.toggle('active', allBtn[sk] === btn);
                        var formEl = document.getElementById('mcpConfigForm');
                        var pasteCfgEl = document.getElementById('mcpConfigPaste');
                        if (formEl) formEl.style.display = (name === 'form') ? '' : 'none';
                        if (pasteCfgEl) pasteCfgEl.style.display = (name === 'paste') ? '' : 'none';
                    });
                })(subtabBtns[st]);
            }

            // Transport type toggle: show/hide HTTP vs stdio section（整 section 切换，避免孤标题）
            var transportSel2 = document.getElementById('mcpServerTransport');
            var httpSection = document.getElementById('mcpHttpSection');
            var stdioSection = document.getElementById('mcpStdioSection');

            function updateTransportFields() {
                var t = transportSel2 ? transportSel2.value : 'stdio';
                var isHttp = (t === 'http' || t === 'sse');
                if (httpSection) httpSection.style.display = isHttp ? '' : 'none';
                if (stdioSection) stdioSection.style.display = isHttp ? 'none' : '';
            }

            if (transportSel2) {
                tmpOn(transportSel2, 'change', updateTransportFields);
                updateTransportFields();
            }

            var modalTabBtns = box.querySelectorAll('.mcp-modal-tab');
            for (var q = 0; q < modalTabBtns.length; q++) {
                (function(tab) {
                    tmpOn(tab, 'click', function() {
                        var tabName = tab.getAttribute('data-tab');
                        if (tabName) switchModalTab(tabName, box);
                    });
                })(modalTabBtns[q]);
            }

            function switchModalTab(tabName, boxEl) {
                // 通用切换：遍历所有 tab 按钮，根据 data-tab 显示/隐藏对应 #mcpServerTab<Name>
                var tBtns = boxEl.querySelectorAll('.mcp-modal-tab');
                for (var j = 0; j < tBtns.length; j++) {
                    var b = tBtns[j];
                    var t = b.getAttribute('data-tab');
                    if (t === tabName) {
                        b.classList.add('active');
                    } else {
                        b.classList.remove('active');
                    }
                    var cap = t ? (t.charAt(0).toUpperCase() + t.slice(1)) : '';
                    var content = boxEl.querySelector('#mcpServerTab' + cap);
                    if (content) content.style.display = (t === tabName) ? '' : 'none';
                }
                // 编辑模式：根据当前 tab 更新确认按钮文字
                if (isEdit) {
                    var confirmBtn = document.getElementById('mcpServerInstallModalConfirmBtn');
                    if (confirmBtn) {
                        confirmBtn.textContent = (tabName === 'tools') ? AEI18n.t('保存工具') : AEI18n.t('保存修改');
                    }
                }
            }

            // 读「作用域」控件 → 可直接写进 server 配置的 scope。
            // 返回 null 表示选了模块作用域但一个模块都没选（调用方提示后中止）。
            function _readScopeControl() {
                var sel = document.getElementById('mcpServerScope');
                if (!sel || sel.value !== 'module') return { type: 'global' };
                var modsArr = [], modesArr = [];
                if (scopePicker) {
                    var sv = scopePicker.getValue();
                    modsArr = sv.moduleIds || [];
                    modesArr = sv.agentModes || [];
                }
                if (!modsArr.length) return null;
                var scope = { type: 'module', moduleIds: modsArr.slice() };
                // 仅 Agent 模块支持模式限定；勾选"全部模式"或未限定模式时不写 agentModes（全部生效）
                if (modsArr.indexOf('agent') >= 0 && modesArr.length) scope.agentModes = modesArr.slice();
                return scope;
            }

            async function confirmServerInstallFromModal() {
                var statusEl = document.getElementById('mcpServerInstallStatus');
                var setStatus = function(msg, isError) {
                    if (statusEl) {
                        statusEl.style.display = '';
                        statusEl.textContent = msg;
                        statusEl.style.color = isError ? 'var(--danger)' : 'var(--accent, #27ae60)';
                    }
                };

                var activeTabEl = box.querySelector('.mcp-modal-tab.active');
                var activeTab = activeTabEl ? activeTabEl.getAttribute('data-tab') : (isEdit ? 'config' : 'paste');

                // 编辑模式 + 工具 tab：保存工具短描述与 stub 配置
                if (isEdit && activeTab === 'tools') {
                    var toolsTabEl = document.getElementById('mcpServerTabTools');
                    if (toolsTabEl) {
                        _collectAndSaveToolEditor(toolsTabEl, editServerId);
                        hideServerInstallWizard();
                    }
                    return;
                }

                if (!isEdit && activeTab === 'paste') {
                    var pasteEl = document.getElementById('mcpServerPasteContent');
                    var raw = pasteEl ? pasteEl.value.trim() : '';
                    if (!raw) { setStatus(AEI18n.t('请粘贴 MCP Server JSON 配置'), true); return; }
                    // 框内预填的示例是真内容：用户没改就点确认时按「还没填配置」处理，
                    // 不把 my-server 当真实服务器加进去
                    if (_isExampleOnly(raw)) { setStatus(AEI18n.t('当前内容仍是示例，请替换为真实配置'), true); return; }
                    var parsed;
                    try { parsed = JSON.parse(raw); }
                    catch (e) { setStatus(AEI18n.t('JSON 格式无效: ') + (e && e.message ? e.message : String(e)), true); return; }
                    // JSON.parse("null") 等非对象结果：下方 parsed.servers 属性访问会抛未捕获 TypeError
                    if (!parsed || typeof parsed !== 'object') parsed = {};
                    if (parsed.servers && typeof parsed.servers === 'object' && !Array.isArray(parsed.servers)) parsed = parsed.servers;
                    else if (parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) parsed = parsed.mcpServers;
                    else if (parsed.mcp && typeof parsed.mcp === 'object' && !Array.isArray(parsed.mcp)) parsed = parsed.mcp;
                    var ids = Object.keys(parsed);
                    // 作用域：JSON 里各自声明的 scope 优先（逐台生效），未声明的按对话框的
                    // 作用域控件（粘贴与手动填写共用同一个）。控件选了模块却一个模块都没选时，
                    // 只有确实要套用控件的条目才拦下——整份 JSON 都自带 scope 时不必拦。
                    var dialogScope = _readScopeControl();
                    var needDialogScope = false;
                    for (var ni = 0; ni < ids.length; ni++) {
                        var cfgProbe = parsed[ids[ni]];
                        if (cfgProbe && typeof cfgProbe === 'object' && !cfgProbe.scope) { needDialogScope = true; break; }
                    }
                    if (needDialogScope && dialogScope === null) { setStatus(AEI18n.t('请选择目标模块'), true); return; }
                    var added = 0, failed = 0, failedIds = [], persistFailed = 0;
                    for (var i = 0; i < ids.length; i++) {
                        var sid = ids[i], cfg = parsed[sid];
                        if (cfg && typeof cfg === 'object' && serverManager && typeof serverManager.addServer === 'function') {
                            if (!cfg.scope) cfg.scope = dialogScope;
                            var r = await serverManager.addServer(sid, cfg);
                            if (r && r.ok) added++;
                            // 运行时已添加、仅落盘失败（persisted=false）——
                            // 计入已添加并单独提示，重启后会回退，不静默
                            else if (r && r.persisted === false) { added++; persistFailed++; }
                            else { failed++; failedIds.push(sid); console.error('[MCP View] Failed to add server ' + sid + ': ' + (r ? r.error : 'unknown')); }
                        }
                    }
                    var persistNote = persistFailed > 0 ? AEI18n.t('（{n} 个配置保存失败：本次会话已生效，重启后回退）', { n: persistFailed }) : '';
                    if (added > 0 && failed === 0) {
                        var okMsg = AEI18n.t('已添加 {n} 个 MCP Server', { n: added }) + (persistNote || AEI18n.t('，正在连接...'));
                        setStatus(okMsg, persistFailed > 0);
                        if (global.AEToast) { if (persistFailed > 0) AEToast.error(okMsg); else AEToast.success(AEI18n.t('已添加 ') + added + AEI18n.t(' 个 MCP Server')); }
                        setTimeout(function() { hideServerInstallWizard(); switchTab('servers'); }, 800);
                    }
                    else if (added > 0) { var warnMsg = AEI18n.t('已添加 {n} 个', { n: added }) + persistNote + AEI18n.t('，已拒绝 {n} 个无效配置: ', { n: failed }) + failedIds.join(', '); setStatus(warnMsg, true); if (global.AEToast) AEToast.warn(warnMsg); setTimeout(function() { hideServerInstallWizard(); switchTab('servers'); }, 1200); }
                    else {
                        // 观察项：serverManager 为空（initMCP 曾失败，main.js 异常隔离后
                        // 置 null）时，若把每个配置都静默跳过（循环条件直接不成立），
                        // 末尾统一落到「未识别到有效 MCP Server 配置」——把「模块不可用」
                        // 谎报成「用户配置无效」，用户只会反复重贴配置。此处按真实原因分流。
                        var errMsg;
                        if (failed > 0) errMsg = AEI18n.t('已拒绝 {n} 个无效配置: ', { n: failed }) + failedIds.join(', ');
                        else if (ids.length > 0 && !(serverManager && typeof serverManager.addServer === 'function')) {
                            errMsg = AEI18n.t('MCP 模块未就绪（初始化失败），配置未添加：{ids}。请刷新面板后重试', { ids: ids.join(', ') });
                        } else errMsg = AEI18n.t('未识别到有效 MCP Server 配置');
                        setStatus(errMsg, true); if (global.AEToast) AEToast.error(errMsg);
                    }
                } else {
                    var idEl = document.getElementById('mcpServerId');
                    var transportEl = document.getElementById('mcpServerTransport');
                    var urlEl = document.getElementById('mcpServerUrl');
                    var cmdEl = document.getElementById('mcpServerCommand');
                    var argsEl = document.getElementById('mcpServerArgs');
                    var envEl = document.getElementById('mcpServerEnv');
                    var headersEl = document.getElementById('mcpServerHeaders');
                    var autoStartEl = document.getElementById('mcpServerAutoStart');

                    var id = isEdit ? editServerId : (idEl ? idEl.value.trim() : '');
                    var transport = transportEl ? transportEl.value : 'stdio';
                    var url = urlEl ? urlEl.value.trim() : '';
                    var command = cmdEl ? cmdEl.value.trim() : '';
                    var argsStr = argsEl ? argsEl.value.trim() : '';
                    var envStr = envEl ? (envEl.dataset && envEl.dataset.masked === '1' ? (envEl.dataset.real || '') : envEl.value).trim() : '';
                    var headersStr = headersEl ? headersEl.value.trim() : '';
                    // 作用域控件（模块多选 + agent 模式多选）→ scope；null = 选了模块但未选模块
                    var scopeControl = _readScopeControl();
                    var autoStart = autoStartEl ? !!autoStartEl.checked : true;

                    if (!id) { setStatus(AEI18n.t('请填写 Server ID'), true); return; }

                    if (scopeControl === null) { setStatus(AEI18n.t('请选择目标模块'), true); return; }

                    // HTTP/SSE transport: requires URL
                    if (transport === 'http' || transport === 'sse') {
                        if (!url) { setStatus(AEI18n.t('请填写 URL'), true); return; }
                    } else {
                        // stdio transport: requires command
                        if (!command) { setStatus(AEI18n.t('请填写命令'), true); return; }
                    }

                    var args = argsStr ? argsStr.split('\n').map(function(s) { return s.trim(); }).filter(Boolean) : [];
                    var env = null;
                    if (envStr) {
                        env = {};
                        var lines = envStr.split('\n');
                        for (var ei = 0; ei < lines.length; ei++) {
                            var line = lines[ei].trim();
                            var eqIdx = line.indexOf('=');
                            if (eqIdx > 0) {
                                var key = line.substring(0, eqIdx).trim();
                                var val = line.substring(eqIdx + 1).trim();
                                if (key) env[key] = val;
                            }
                        }
                    }

                    // 请求头解析（HTTP/SSE 用）：格式 "Key: Value" 每行一个
                    var headers = null;
                    if (headersStr && (transport === 'http' || transport === 'sse')) {
                        headers = {};
                        var hLines = headersStr.split('\n');
                        for (var hi = 0; hi < hLines.length; hi++) {
                            var hLine = hLines[hi].trim();
                            var colonIdx = hLine.indexOf(':');
                            if (colonIdx > 0) {
                                var hKey = hLine.substring(0, colonIdx).trim();
                                var hVal = hLine.substring(colonIdx + 1).trim();
                                if (hKey) headers[hKey] = hVal;
                            }
                        }
                        // 空对象则置 null，避免持久化空 {}
                        if (!Object.keys(headers).length) headers = null;
                    }

                    var config = {
                        // enabled 字段删除——弹窗开关即「自启」
                        //（编辑预填原 autoStart，新建默认开；停用＝停止 + 关自启）
                        autoStart: autoStart,
                        scope: scopeControl,
                        transport: transport
                    };
                    if (transport === 'http' || transport === 'sse') {
                        config.url = url;
                    } else {
                        config.command = command;
                        config.args = args;
                    }
                    // 显式传 null（而非省略）：编辑走 update patch 时，省略的键会保留旧值，
                    // 用户清空 env/headers 将不生效；新建走 add 时 null 与省略等价
                    config.env = env || null;
                    config.headers = (transport === 'http' || transport === 'sse') ? (headers || null) : null;

                    if (serverManager && (isEdit ? typeof serverManager.updateServer === 'function' : typeof serverManager.addServer === 'function')) {
                        var result;
                        if (isEdit) {
                            // 编辑走 update + restart：
                            // - add 会硬编码清空 toolDescriptions/toolStubs 缓存（LLM 已生成的短描述丢失）
                            // - 不 restart 则 bridge 侧旧进程继续跑旧 command/args/env，配置不生效
                            // - 显式清掉另一 transport 的残留字段，避免 stdio→http 切换后 command 残留
                            var patch = Object.assign({}, config);
                            if (transport === 'http' || transport === 'sse') {
                                patch.command = '';
                                patch.args = [];
                            } else {
                                patch.url = '';
                            }
                            result = await serverManager.updateServer(id, patch, { restart: true });
                        } else {
                            result = await serverManager.addServer(id, config);
                        }
                        if (result && result.ok) {
                            // 回执按新增/编辑如实分流（不再有停用回执：
                            // 关自启不改变连接状态，断开经停止按钮显式完成）
                            var okMsg = isEdit ? (AEI18n.t('已保存: ') + id) : (AEI18n.t('已添加 MCP Server: ') + id);
                            setStatus(isEdit ? okMsg : (AEI18n.t('已添加 MCP Server: ') + id + AEI18n.t('，正在连接...')), false);
                            if (global.AEToast) AEToast.success(okMsg);
                            var delay = isEdit ? 400 : 600;
                            setTimeout(function() { hideServerInstallWizard(); if (!isEdit) switchTab('servers'); else renderServerList(); }, delay);
                        } else if (result && result.persisted === false && result.error === 'PERSIST_FAILED') {
                            // 运行时已保存/添加（配置进内存、连接已按新配置处理），
                            // 仅落盘失败——不能报「保存失败」（会误导用户重试），如实提示
                            // 重启后会回退；仍关闭向导（本次已生效）
                            var persistMsg = (isEdit ? AEI18n.t('已保存: ') : AEI18n.t('已添加 MCP Server: ')) + id
                                + AEI18n.t('（配置保存失败：本次会话已生效，重启后回退）');
                            setStatus(persistMsg, true);
                            if (global.AEToast) AEToast.error(persistMsg);
                            setTimeout(function() { hideServerInstallWizard(); if (!isEdit) switchTab('servers'); else renderServerList(); }, 600);
                        } else {
                            var failMsg = (isEdit ? AEI18n.t('保存') : AEI18n.t('添加')) + AEI18n.t('失败: ') + (result ? result.error : AEI18n.t('配置无效'));
                            setStatus(failMsg, true);
                            if (global.AEToast) AEToast.error(failMsg);
                        }
                    }
                }
            }
        }

        function hideServerInstallWizard() {
            // 销毁向导内 ScopePicker（事件监听挂在 document 上，不随 DOM 移除释放）
            if (_wizardScopePicker) {
                try { _wizardScopePicker.destroy(); } catch (e) {}
                _wizardScopePicker = null;
            }
            var modal = document.getElementById('mcpServerInstallModal');
            if (modal && modal.parentNode) {
                modal.parentNode.removeChild(modal);
            }
        }
        function switchTab(tabName) {
            var body = document.getElementById('mcpMgmtBody');
            if (!body) return;

            var toolsPanel = body.querySelector('.mgmt-tools-panel');
            var serversPanel = body.querySelector('.mgmt-servers-panel');
            var tabBtns = body.querySelectorAll('.mgmt-main-tab');

            if (toolsPanel) toolsPanel.style.display = tabName === 'tools' ? '' : 'none';
            if (serversPanel) serversPanel.style.display = tabName === 'servers' ? '' : 'none';


            for (var i = 0; i < tabBtns.length; i++) {
                var btn = tabBtns[i];
                var t = btn.getAttribute('data-tab');
                if (t === tabName) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            }

            if (tabName === 'tools') renderToolList();
            if (tabName === 'servers') renderServerList();
        }

        async function render(containerEl) {
            if (!containerEl) return;

            var allTools = getTools();
            var localCount = 0;
            var serverCount = 0;
            var globalCount = 0;
            var moduleCount = 0;
            for (var i = 0; i < allTools.length; i++) {
                var t = allTools[i];
                if (t.serverId) serverCount++;
                else localCount++;
                if (t.scope && t.scope.type === 'global') globalCount++;
                else if (t.scope && t.scope.type === 'module') moduleCount++;
            }

            var html = '';
            html += '<div class="mgmt-main-tabs">';
            html += AEI18n.html('<button class="mgmt-main-tab active" data-tab="tools">工具 (') + allTools.length + ')</button>';
            html += '<button class="mgmt-main-tab" data-tab="servers">Server</button>';
            html += '</div>';

            html += '<div class="mgmt-tools-panel" id="mcpToolsPanel">';
            html += '<div class="mgmt-tools-filter-bar mgmt-filter-bar">';
            html += '<div class="mgmt-filter-group">';
            html += AEI18n.html('<button class="mgmt-filter-btn active" data-filter="all">全部 (') + allTools.length + ')</button>';
            html += AEI18n.html('<button class="mgmt-filter-btn" data-filter="local">本地 (') + localCount + ')</button>';
            html += '<button class="mgmt-filter-btn" data-filter="server">Server (' + serverCount + ')</button>';
            html += AEI18n.html('<button class="mgmt-filter-btn" data-filter="global">全局 (') + globalCount + ')</button>';
            html += AEI18n.html('<button class="mgmt-filter-btn" data-filter="module">模块 (') + moduleCount + ')</button>';
            html += '</div>';
            html += '</div>';
            html += '<div class="mgmt-list-container" id="mcpToolListContainer"></div>';
            html += '</div>';

            html += '<div class="mgmt-servers-panel" id="mcpServersPanel" style="display:none;">';
            html += '<div class="mgmt-list-container" id="mcpServerListContainer"></div>';
            html += '</div>';

            containerEl.innerHTML = html;

            bindEvents(containerEl);
            renderToolList();
            renderServerList();
        }

        function bindEvents(containerEl) {
            var mainTabs = containerEl.querySelectorAll('.mgmt-main-tab');
            for (var i = 0; i < mainTabs.length; i++) {
                (function(btn) {
                    on(btn, 'click', function() {
                        var tabName = btn.getAttribute('data-tab');
                        if (tabName) switchTab(tabName);
                    });
                })(mainTabs[i]);
            }

            var filterBtns = containerEl.querySelectorAll('.mgmt-tools-filter-bar .mgmt-filter-btn');
            for (var j = 0; j < filterBtns.length; j++) {
                (function(btn) {
                    on(btn, 'click', function() {
                        var f = btn.getAttribute('data-filter');
                        if (f) applyToolFilter(f);
                    });
                })(filterBtns[j]);
            }
        }

        function destroy() {
            offAll();
        }

        return {
            render: render,
            renderToolList: renderToolList,
            renderServerList: renderServerList,
            switchTab: switchTab,
            setToolRegistry: setToolRegistry,
            setServerManager: setServerManager,
            setSettingsStore: setSettingsStore,
            destroy: destroy
        };
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.createMcpView = createMcpView;

})(window);
