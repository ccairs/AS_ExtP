/**
 * view.js — 外接模式视图（布局重排 + 管理台）
 *
 * 布局（六功能区）：
 *   enter()：#agentPanel 挂 .ext-mode-active（CSS 驱动六功能区同显）+ #shaderPreviewStage
 *   移入中列 #extGlslStage（canvas 预览图，渲染循环逐帧读 clientWidth 自适应新尺寸）+
 *   展开左右抽屉；exit()：恢复原生 DOM 结构。
 *
 * 管理台（中列下）：
 *   状态卡常驻顶行：总开关（授权语义）+ Bridge/激活态 + 对外工具数 + 档位滚轮（靠右）
 *   tab 区：调用日志（默认）/ 审阅队列 / 设置（档位控件在状态卡，不在此页）
 *
 * 调用方：runtimeModeSwitch.js 模式钩子 + main.js refreshList external 分支（幂等）。
 */
(function (global) {
    'use strict';

    var _entered = false;
    var _previewStageOriginalParent = null;
    var _logInitialized = false;
    var _settingsInitialized = false;

    function el(id) { return document.getElementById(id); }

    // 组成员名解析（设置页渲染用）。固定组读静态名单；动态组的成员在运行期可变，必须向
    // extTools 要——那里经 extPolicy.groupOfTool 统一判定归属与去重，本文件不得另写
    // source 过滤（重写一份即两个真相源）。枚举失败一律降级为空名单：设置页是装饰性 UI，
    // 注册表异常不该让整页空白（组开关、其它组、档位卡片都还能用）。
    function groupMemberNames(groupId, group) {
        if (!group.dynamic) return group.fixed || [];
        var t = global.AEExternal && global.AEExternal.tools;
        if (!t || typeof t.listDynamicGroupTools !== 'function') return [];
        try {
            return t.listDynamicGroupTools(groupId).map(function (x) { return x.name; });
        } catch (e) {
            console.warn('[ext-view] 动态组成员枚举失败: ' + (e && e.message));
            return [];
        }
    }

    // ── 布局进出 ──
    function enter() {
        if (_entered) return;
        _entered = true;

        var agentPanel = el('agentPanel');
        if (agentPanel) agentPanel.classList.add('ext-mode-active');

        // GLSL 预览图移入中列（中列上=预览图）。canvas 移动不丢 WebGL 上下文，
        // 渲染循环逐帧按 clientWidth 自适应（shaderPreviewRenderer L115-125）
        var stage = el('shaderPreviewStage');
        var target = el('extGlslStage');
        if (stage && target && stage.parentNode !== target) {
            // 原位只认**左列 shader 面板**（与 exit 的注释「移回 shaderLeftPanel 首子节点」同义），
            // 不认 stage.parentNode：混装/半更新包里若团队布局的
            // hideTeamLayout 缺席，进外接时 parentNode 可能是 #shaderTeamStage（.team-mode-active
            // 一摘就是 display:none）⇒ exit() 把舞台塞回隐藏容器，之后所有档位都看不到预览。
            _previewStageOriginalParent = el('shaderLeftPanel') || stage.parentNode;
            target.appendChild(stage);
        }

        // 左右抽屉不再强制展开：保持用户当前开合状态——
        // enter 时 remove('collapsed') 会把收着的抽屉弹开，切回又弹回，
        // 表现为模式切换时抽屉一开一合

        // shader 内层面板 display 放行（其它模式的 hideLeft/hideRight 内联 display:none
        // 会压制 CSS 类；此处显式清除）
        var slp = el('shaderLeftPanel');
        var srp = el('shaderRightPanel');
        if (slp) slp.style.display = '';
        if (srp) srp.style.display = '';

        initConsole();
        bindRowResizers();
        renderStatusCard();
    }

    function exit() {
        if (!_entered) return;
        _entered = false;

        var agentPanel = el('agentPanel');
        if (agentPanel) agentPanel.classList.remove('ext-mode-active');

        // 预览图移回原位（shaderLeftPanel 首子节点）
        var stage = el('shaderPreviewStage');
        if (stage && _previewStageOriginalParent) {
            _previewStageOriginalParent.insertBefore(stage, _previewStageOriginalParent.firstChild);
            _previewStageOriginalParent = null;
        }

        resetRowResizers();

        var panel = el('extModePanel');
        if (panel) panel.style.display = 'none';
        // 注意：授权不随退出关闭（通道开关语义——切走模块不断连，仅状态卡总开关/重载失效）。
        // 对称约定：进入外接档同样不改动授权——开关只归状态卡管
    }

    // ── 三列行分隔条拖拽（左列双库 / 中列预览+管理台 / 右列双预览）──
    // 复用 shaderUI bindResizer 手法：pointer 捕获 + 顶面板 flexBasis 百分比。
    // 上下双 basis 冻结（合计 100%）保证拖拽位移 1:1 映射，不被 flex-grow 均摊稀释。
    var _resizersBound = false;
    var _RESIZER_COLUMNS = [
        { bar: 'extLeftResizer', top: 'scriptListShell', bottom: 'shaderLeftPanel' },
        { bar: 'extMidResizer', top: 'extGlslStage', bottom: 'extConsole' },
        { bar: 'extRightResizer', top: 'scriptPreviewWrap', bottom: 'shaderRightPanel' }
    ];

    function bindRowResizers() {
        if (_resizersBound) return;
        _resizersBound = true;
        for (var i = 0; i < _RESIZER_COLUMNS.length; i++) {
            (function (col) {
                var bar = el(col.bar);
                var top = el(col.top);
                var bottom = el(col.bottom);
                if (!bar || !top || !bottom) return;
                var dragging = false, startY = 0, startPct = 0;
                bar.addEventListener('pointerdown', function (e) {
                    dragging = true;
                    startY = e.clientY;
                    var rect = bar.parentElement.getBoundingClientRect();
                    startPct = (top.getBoundingClientRect().height / Math.max(1, rect.height)) * 100;
                    bar.classList.add('dragging');
                    if (bar.setPointerCapture) { try { bar.setPointerCapture(e.pointerId); } catch (_) {} }
                    window.addEventListener('pointermove', onMove);
                    window.addEventListener('pointerup', onUp);
                    e.preventDefault();
                });
                function onMove(e) {
                    if (!dragging) return;
                    var rect = bar.parentElement.getBoundingClientRect();
                    var pct = Math.max(12, Math.min(70,
                        startPct + ((e.clientY - startY) / Math.max(1, rect.height)) * 100));
                    top.style.flexBasis = pct + '%';
                    bottom.style.flexBasis = (100 - pct) + '%';
                }
                function onUp() {
                    dragging = false;
                    bar.classList.remove('dragging');
                    window.removeEventListener('pointermove', onMove);
                    window.removeEventListener('pointerup', onUp);
                }
            })(_RESIZER_COLUMNS[i]);
        }
    }

    // 退出外接模式时清除拖拽产生的内联 flexBasis——共享面板
    // （scriptListShell/scriptPreviewWrap 等）在其他模式有各自的 flex 布局，内联值会压制它们
    function resetRowResizers() {
        for (var i = 0; i < _RESIZER_COLUMNS.length; i++) {
            var top = el(_RESIZER_COLUMNS[i].top);
            var bottom = el(_RESIZER_COLUMNS[i].bottom);
            if (top) top.style.flexBasis = '';
            if (bottom) bottom.style.flexBasis = '';
        }
    }

    // ── 管理台初始化（tab 切换一次性绑定）──
    function initConsole() {
        var tabs = el('extTabs');
        if (tabs && !tabs._extBound) {
            tabs._extBound = true;
            tabs.addEventListener('click', function (e) {
                var btn = e.target && e.target.closest ? e.target.closest('.ext-tab') : null;
                if (!btn) return;
                var tab = btn.getAttribute('data-tab');
                var btns = tabs.querySelectorAll('.ext-tab');
                for (var i = 0; i < btns.length; i++) {
                    btns[i].classList.toggle('active', btns[i] === btn);
                }
                var panes = { log: el('extTabLog'), review: el('extTabReview'), settings: el('extTabSettings') };
                var keys = Object.keys(panes);
                for (var j = 0; j < keys.length; j++) {
                    if (panes[keys[j]]) panes[keys[j]].hidden = keys[j] !== tab;
                }
                if (tab === 'review') renderReviewTab();
                if (tab === 'settings') renderSettingsTab();
                if (tab === 'log' && _logDirty) renderLogTab();   // 离开期间有新日志 → 全量重建
            });
        }
        if (!_logInitialized) {
            _logInitialized = true;
            var bc = global.AEExternal && global.AEExternal.bridgeClient;
            if (bc && typeof bc.onLog === 'function') {
                bc.onLog(onLogEntry);   // 增量渲染（不重建整表，展开态/滚动位置保持）
            }
        }
        renderLogTab();
    }

    // ── 状态卡 ──
    function renderStatusCard() {
        var card = el('extStatusCard');
        if (!card) return;
        var policy = global.AEExternal && global.AEExternal.policy;
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        if (!policy || !bc) return;

        var active = policy.isActive();
        var connected = bc.isConnected();
        var toolsCount = 0;
        try {
            if (global.AEExternal.tools) toolsCount = global.AEExternal.tools.buildExternalToolDefs().length;
        } catch (_) {}

        card.innerHTML = '';
        var doc = document;

        // 总开关（授权语义）——复用项目 .toggle-wrap / .switch-slider 胶囊开关视觉
        var toggleLabel = doc.createElement('label');
        toggleLabel.className = 'ext-master-toggle toggle-wrap';
        var cb = doc.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'switch-input';
        cb.checked = active;
        cb.addEventListener('change', function () {
            policy.setActive(cb.checked);
            renderStatusCard();
        });
        var slider = doc.createElement('span');
        slider.className = 'switch-slider';
        var tText = doc.createElement('span');
        tText.textContent = AEI18n.t('外部访问授权');
        toggleLabel.appendChild(cb);
        toggleLabel.appendChild(slider);
        toggleLabel.appendChild(tText);
        card.appendChild(toggleLabel);

        // Bridge 状态
        card.appendChild(makeDot(connected, 'Bridge'));
        // 授权状态
        card.appendChild(makeDot(active, active ? AEI18n.t('已授权') : AEI18n.t('未授权')));
        // 工具数
        var toolSpan = doc.createElement('span');
        toolSpan.textContent = AEI18n.t('对外工具: ') + toolsCount;
        card.appendChild(toolSpan);
        // 档位滚轮（靠右，CSS margin-left:auto 顶到行尾）：显示与调整收成同一个控件，
        // 显示与调整都在同一控件内，无需「状态卡文字回显 + 设置页下拉」两处维护
        card.appendChild(makeTierSlider(policy));
    }

    // ── 档位滚轮 ──
    // 与 Agent/Shader 模式工具栏的「权限」滚轮同款：同一套 .ae-agent-perm-slider /
    // .thinking-slot / .thinking-strip 结构与样式类（点击循环切换 + aeSlotSpin 音效 +
    // strip 逐格滚动），故这里不新增任何样式，只是档位名单换成外接的两档
    //（conservative ≡ balanced 已裁，见 extPolicy 档位归一注释）。
    var TIER_LEVELS = ['auto', 'balanced'];
    var TIER_LABELS = { get auto() { return AEI18n.t('自动'); }, get balanced() { return AEI18n.t('平衡'); } };
    var TIER_ITEM_H = 18;   // 单格行高，与 .thinking-strip-item（agent.css）一致

    function tierIndexOf(tier) { return tier === 'auto' ? 0 : 1; }

    function makeTierSlider(policy) {
        var doc = document;
        var wrap = doc.createElement('div');
        wrap.className = 'ae-agent-perm-slider ext-tier-slider';
        wrap.title = AEI18n.t('权限档位：点击循环切换\n自动：全部外部调用直接执行（日志留痕）\n')
            + AEI18n.t('平衡：七组高危操作（创建/覆盖 AE 工具 / 记忆写 / 删素材文件夹 / 效果库删除 / 技能写面 / 脚本入库写 / MCP 服务器配置与运行控制）')
            + AEI18n.t('在 Agent 软件内弹确认，其余直接执行；客户端不支持确认交互时这些操作一律拒绝');
        var label = doc.createElement('span');
        label.className = 'perm-slider-label';
        label.textContent = AEI18n.t('权限');
        var slot = doc.createElement('div');
        slot.className = 'thinking-slot';
        var strip = doc.createElement('div');
        strip.className = 'thinking-strip';
        for (var i = 0; i < TIER_LEVELS.length; i++) {
            var item = doc.createElement('span');
            item.className = 'thinking-strip-item';
            item.setAttribute('data-val', TIER_LEVELS[i]);
            item.textContent = TIER_LABELS[TIER_LEVELS[i]];
            strip.appendChild(item);
        }
        slot.appendChild(strip);   // slot 里必须挂 strip，否则滚轮窗口是空白（单测曾抓住这行漏写）
        function paint(tier) {
            strip.style.transform = 'translateY(' + (-tierIndexOf(tier) * TIER_ITEM_H) + 'px)';
        }
        paint(policy.getTier());
        // 切换只就地改 strip 的 transform，不重建状态卡：重建会把刚拿到动画起点的节点换掉，
        // .45s 的滚动动画直接掐断（工具栏那套同样只在原节点上改 transform）。
        // 状态卡其余字段（连接态/工具数）与档位无关，无需整体重渲。
        slot.addEventListener('click', function () {
            if (typeof global.aeSlotSpin === 'function') global.aeSlotSpin();
            var next = TIER_LEVELS[(tierIndexOf(policy.getTier()) + 1) % TIER_LEVELS.length];
            policy.setTier(next);   // 持久化 + notifyListeners（顶栏提示条的档位文案自行刷新）
            paint(next);
        });
        wrap.appendChild(label);
        wrap.appendChild(slot);
        return wrap;
    }

    function makeDot(on, label) {
        var wrap = document.createElement('span');
        wrap.style.display = 'inline-flex';
        wrap.style.alignItems = 'center';
        wrap.style.gap = '4px';
        var dot = document.createElement('span');
        dot.className = 'ext-dot ' + (on ? 'on' : 'off');
        var text = document.createElement('span');
        text.textContent = label;
        wrap.appendChild(dot);
        wrap.appendChild(text);
        return wrap;
    }

    // ── 调用日志 tab ──
    // 结构：滚动列表 + 底部固定工具栏（计数 + 复制 + 清空）；
    // 条目可展开收起（左侧三角），输入/输出/错误放展开框，详情懒构建。
    // 性能：数据层环形缓冲（extBridgeClient LOG_RING_MAX）封顶存量；新日志走增量
    // 头插（O(1)，不重建整表——展开态/滚动位置不丢），仅切 tab/清空/进入时全量重建。
    function fmtTime(ts) {
        var d = new Date(ts);
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    function fmtDateTime(ts) {
        var d = new Date(ts);
        function p(n) { return n < 10 ? '0' + n : '' + n; }
        return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
    }

    var _logList = null;      // 日志滚动列表容器（增量渲染挂点）
    var _logCount = null;     // 底栏计数标签
    var _logEmptyEl = null;   // 空态占位符引用（O(1) 移除——勿在增量路径 querySelector 全树扫描）
    var _logDirty = false;    // 非当前 tab 期间有新日志 → 切回时全量重建

    function logPaneVisible() {
        var pane = el('extTabLog');
        return !!pane && !pane.hidden;
    }

    function logRingMax() {
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        return (bc && bc.LOG_RING_MAX) || 200;
    }

    // 输入/输出小块（展开框内）
    function ioBlock(label, text) {
        var b = document.createElement('div');
        b.className = 'ext-log-io';
        var l = document.createElement('div');
        l.className = 'ext-log-io-label';
        l.textContent = label;
        var pre = document.createElement('pre');
        pre.className = 'ext-log-io-body';
        pre.textContent = text || AEI18n.t('（空）');
        b.appendChild(l);
        b.appendChild(pre);
        return b;
    }

    function buildLogDetail(detail, e) {
        detail.appendChild(ioBlock(AEI18n.t('输入'), e.input));
        detail.appendChild(ioBlock(AEI18n.t('输出'), e.output));
        if (e.error) detail.appendChild(ioBlock(AEI18n.t('错误'), e.error));
    }

    // 单条目：折叠行 + 懒加载详情框（首次展开才构建，万级存量下折叠行保持轻量）
    function makeLogItem(e) {
        var item = document.createElement('div');
        item.className = 'ext-log-item';

        var row = document.createElement('div');
        row.className = 'ext-log-row';
        row.title = AEI18n.t('点击展开/收起输入输出详情');
        var caret = document.createElement('span');
        caret.className = 'ext-log-caret';
        caret.textContent = '▶';
        var time = document.createElement('span'); time.className = 'ext-log-time'; time.textContent = fmtTime(e.ts);
        var tool = document.createElement('span'); tool.className = 'ext-log-tool'; tool.textContent = e.tool || '?';
        var client = document.createElement('span'); client.className = 'ext-log-client'; client.textContent = e.clientId || '';
        row.appendChild(caret); row.appendChild(time); row.appendChild(tool); row.appendChild(client);
        // 确认留痕标记：granted=已确认 / skipped=客户端不支持确认但放行
        if (e.confirm === 'skipped' || e.confirm === 'granted') {
            var cm = document.createElement('span');
            cm.className = 'ext-log-confirm ' + (e.confirm === 'skipped' ? 'skipped' : 'granted');
            cm.textContent = e.confirm === 'skipped' ? AEI18n.t('放行') : AEI18n.t('已确认');
            row.appendChild(cm);
        }
        var res = document.createElement('span');
        res.className = 'ext-log-result ' + (e.ok ? 'ok' : 'err');
        res.textContent = e.ok ? 'OK' : 'ERR';
        res.title = e.error || '';
        var dur = document.createElement('span'); dur.className = 'ext-log-dur'; dur.textContent = (e.durationMs || 0) + 'ms';
        row.appendChild(res); row.appendChild(dur);
        item.appendChild(row);

        var detail = document.createElement('div');
        detail.className = 'ext-log-detail';
        detail.hidden = true;
        item.appendChild(detail);

        var built = false;
        row.addEventListener('click', function () {
            var open = item.classList.toggle('open');
            detail.hidden = !open;
            if (open && !built) {
                built = true;
                buildLogDetail(detail, e);
            }
        });
        return item;
    }

    function updateLogCount() {
        if (!_logCount) return;
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        var n = bc ? bc.getCallLog().length : 0;
        _logCount.textContent = n ? n + AEI18n.t(' 条记录') : '';
    }

    // 复制文本到剪贴板（textarea + execCommand，CEF Chrome 可靠——同 presetView 手法）
    function copyTextToClipboard(text) {
        try {
            var ta = document.createElement('textarea');
            ta.value = text;
            ta.style.cssText = 'position:fixed;left:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            document.body.removeChild(ta);
            return true;
        } catch (_) { return false; }
    }

    // 复制到剪贴板前脱敏：与调试日志复制/诊断包同源（shared/logger.js 的 redact，
    // 经 __aeDebugLogger 暴露；logger.js 在清单里先于本文件装载）。屏幕渲染保持原文
    // （同 diagLog 口径：脱敏只作用于外发文本）；redact 缺席属装载异常，此时如实打标，
    // 不静默把原文当脱敏结果复制出去。
    function redactForCopy(text) {
        var dl = global.__aeDebugLogger;
        if (dl && typeof dl.redact === 'function') {
            try { return dl.redact(text); } catch (_) {}
        }
        return '⚠ 脱敏未启用（redact 不可用），以下内容未过滤敏感信息\n' + text;
    }

    // 复制全部日志（含输入输出详情；外发文本先脱敏）
    function copyAllLogs() {
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        if (!bc) return;
        var log = bc.getCallLog();
        if (!log.length) {
            if (global.AEToast) global.AEToast.show(AEI18n.t('暂无日志可复制'), 'warn');
            return;
        }
        var lines = ['=== AS_ExtP 外部调用日志（' + log.length + ' 条）==='];
        for (var i = 0; i < log.length; i++) {
            var e = log[i];
            var head = '[' + fmtDateTime(e.ts) + '] ' + (e.tool || '?') +
                (e.clientId ? ' — ' + e.clientId : '') +
                ' — ' + (e.ok ? 'OK' : 'ERR') + ' — ' + (e.durationMs || 0) + 'ms';
            if (e.confirm === 'skipped') head += ' — [放行]';
            else if (e.confirm === 'granted') head += ' — [已确认]';
            lines.push(head);
            lines.push('  输入: ' + (e.input || '（空）'));
            lines.push('  输出: ' + (e.output || '（空）'));
            if (e.error) lines.push('  错误: ' + e.error);
        }
        if (copyTextToClipboard(redactForCopy(lines.join('\n')))) {
            if (global.AEToast) global.AEToast.success(AEI18n.t('已复制 ') + log.length + AEI18n.t(' 条日志（含详情）'));
        } else {
            if (global.AEToast) global.AEToast.error(AEI18n.t('复制失败（剪贴板不可用）'));
        }
    }

    // 全量重建（进入外接模式 / 切回日志 tab / 清空后）
    function renderLogTab() {
        var pane = el('extTabLog');
        if (!pane) return;
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        if (!bc) return;
        var log = bc.getCallLog();
        _logDirty = false;

        // 结构一次性搭建：滚动列表 + 底部工具栏（清空/复制固定底层，单独一栏）
        if (!_logList || _logList.parentNode !== pane) {
            pane.innerHTML = '';
            _logList = document.createElement('div');
            _logList.className = 'ext-log-list';
            pane.appendChild(_logList);

            var bar = document.createElement('div');
            bar.className = 'ext-log-toolbar';
            _logCount = document.createElement('span');
            _logCount.className = 'ext-log-count';
            bar.appendChild(_logCount);
            var copyBtn = document.createElement('button');
            copyBtn.type = 'button';
            copyBtn.className = 'btn secondary';
            copyBtn.textContent = AEI18n.t('复制日志');
            copyBtn.title = AEI18n.t('复制全部日志（含输入输出详情）');
            copyBtn.addEventListener('click', copyAllLogs);
            bar.appendChild(copyBtn);
            var clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'btn secondary';
            clearBtn.textContent = AEI18n.t('清空日志');
            clearBtn.addEventListener('click', function () {
                bc.clearCallLog();
                renderLogTab();
            });
            bar.appendChild(clearBtn);
            pane.appendChild(bar);
        }

        _logList.innerHTML = '';
        _logEmptyEl = null;
        if (!log.length) {
            var empty = document.createElement('div');
            empty.className = 'ext-log-empty';
            empty.textContent = AEI18n.t('暂无外部调用记录');
            _logList.appendChild(empty);
            _logEmptyEl = empty;
        } else {
            // 倒序（最新在上）
            for (var i = log.length - 1; i >= 0; i--) _logList.appendChild(makeLogItem(log[i]));
        }
        updateLogCount();
    }

    // 新日志增量渲染：头插一条 + 尾部淘汰越限行（与数据层环形 shift 对齐）。
    // 不重建整表——展开态与滚动位置保持；tab 不可见时仅标脏，切回时全量重建。
    // bc.onLog 回调自带新条目，直接消费（免一次全量 getCallLog 拷贝）
    function onLogEntry(entry) {
        if (!logPaneVisible()) { _logDirty = true; return; }
        var pane = el('extTabLog');
        if (!_logList || !pane || _logList.parentNode !== pane) return;
        if (!entry) return;
        if (_logEmptyEl && _logEmptyEl.parentNode === _logList) _logList.removeChild(_logEmptyEl);
        _logEmptyEl = null;
        _logList.insertBefore(makeLogItem(entry), _logList.firstChild);
        var max = logRingMax();
        while (_logList.children.length > max) _logList.removeChild(_logList.lastChild);
        updateLogCount();
    }

    // ── 审阅队列 tab ──
    // 纯历史记录：外部提交/入库记录（从调用日志派生）。
    // 不带预览区状态卡（右列预览区明摆着，字符数无信息量）、不带内联操作按钮——
    // 运行/保存走顶栏（按聚焦预览区），载入走左列脚本树/效果库，
    // 审阅队列只负责回答「外部都干了什么」
    function renderReviewTab() {
        var pane = el('extTabReview');
        if (!pane) return;
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        var log = bc ? bc.getCallLog() : [];
        pane.innerHTML = '';

        // 外部提交/入库记录（从日志派生：submit_* 与 写库调用）
        var SUBMIT_TOOLS = { submit_script: 1, submit_shader: 1, submit_js_effect: 1 };
        var LIB_WRITE_MODES = { create: 1, write: 1, save: 1 };
        var records = [];
        for (var i = log.length - 1; i >= 0; i--) {
            var e = log[i];
            var meta = fmtTime(e.ts) + ' ' + (e.clientId || '') + (e.ok ? '' : AEI18n.t(' · 失败'));
            if (SUBMIT_TOOLS[e.tool]) {
                records.push({ title: AEI18n.t('外部提交 → ') + e.tool, meta: meta });
            } else if (e.ok && (e.tool === 'script_manager' || e.tool === 'shader_library')
                && e.detail && LIB_WRITE_MODES[e.detail.mode]) {
                var target = e.tool === 'script_manager'
                    ? (e.detail.path || e.detail.name)
                    : (e.detail.name + '.' + (e.detail.type === 'js' ? 'js' : 'glsl'));
                records.push({ title: AEI18n.t('入库 → ') + target, meta: meta });
            }
        }
        if (records.length) {
            for (var j = 0; j < records.length && j < 50; j++) {
                pane.appendChild(makeReviewCard(records[j].title, records[j].meta));
            }
        } else {
            pane.appendChild(makeReviewCard(AEI18n.t('外部产出记录'), AEI18n.t('暂无（外部 Agent 提交脚本/shader 后在此显示）')));
        }
    }

    function makeReviewCard(title, meta) {
        var card = document.createElement('div');
        card.className = 'ext-review-card';
        var t = document.createElement('div'); t.className = 'ext-review-title'; t.textContent = title;
        var m = document.createElement('div'); m.className = 'ext-review-meta'; m.textContent = meta;
        card.appendChild(t); card.appendChild(m);
        return card;
    }

    // ── 设置 tab ──
    function renderSettingsTab() {
        var pane = el('extTabSettings');
        if (!pane) return;
        var policy = global.AEExternal && global.AEExternal.policy;
        var bc = global.AEExternal && global.AEExternal.bridgeClient;
        var registry = global.AE_LLM && global.AE_LLM.toolRegistry;
        if (!policy) return;
        pane.innerHTML = '';

        // 档位原在本页顶部的基础卡里（下拉选择）——已收进状态卡右端的权限滚轮
        //（与其他模式同款，显示与调整同点），本页只剩模块组卡片，不再自建基础卡

        // ── 模块组卡片列表：组开关 + per-server + per-tool（三层）──
        var groupIds = Object.keys(policy.TOOL_GROUPS);
        for (var i = 0; i < groupIds.length; i++) {
            var gid = groupIds[i];
            var group = policy.TOOL_GROUPS[gid];

            var groupCard = document.createElement('div');
            groupCard.className = 'ext-settings-group' + (policy.isGroupEnabled(gid) ? '' : ' group-off');

            // 组头：开关 + 组名 + 右侧说明 tag（开关复用 .toggle-wrap / .switch-slider 胶囊视觉）
            var head = document.createElement('div');
            head.className = 'ext-settings-group-head';
            var headToggle = document.createElement('label');
            headToggle.className = 'ext-group-toggle toggle-wrap';
            var gcb = document.createElement('input');
            gcb.type = 'checkbox';
            gcb.className = 'switch-input';
            gcb.checked = policy.isGroupEnabled(gid);
            (function (groupId, card, chk) {
                chk.addEventListener('change', function () {
                    policy.setGroupEnabled(groupId, chk.checked);
                    card.classList.toggle('group-off', !chk.checked);
                    renderStatusCard();
                });
            })(gid, groupCard, gcb);
            var gslider = document.createElement('span');
            gslider.className = 'switch-slider';
            var gname = document.createElement('span');
            gname.className = 'ext-group-name';
            gname.textContent = group.label;
            headToggle.appendChild(gcb);
            headToggle.appendChild(gslider);
            headToggle.appendChild(gname);
            head.appendChild(headToggle);
            var gtag = document.createElement('span');
            gtag.className = 'ext-group-tag';
            // 动态组的 fixed 恒为空数组，按 fixed.length 会恒显示「0 个工具」（误导），故
            // 两个分支都经 groupMemberNames 取实际成员数
            gtag.textContent = group.gateway
                ? AEI18n.t('网关默认关 · 服务器需逐个开启')
                : groupMemberNames(gid, group).length + AEI18n.t(' 个工具');
            head.appendChild(gtag);
            groupCard.appendChild(head);

            // 网关组：per-server 开关（三级第二层——组开后仍需逐 server 显式开启，双默认关）
            if (group.gateway) {
                var sm = global.AE_LLM && global.AE_LLM.serverManager;
                var serverCfgs = sm && typeof sm.getAllServerConfigs === 'function' ? sm.getAllServerConfigs() : {};
                var sids = Object.keys(serverCfgs);
                if (sids.length === 0) {
                    var emptySrv = document.createElement('div');
                    emptySrv.className = 'ext-tool-empty';
                    emptySrv.textContent = AEI18n.t('（mcp-manager 暂无已配置服务器）');
                    groupCard.appendChild(emptySrv);
                } else {
                    var srvList = document.createElement('div');
                    srvList.className = 'ext-tool-list';
                    for (var s = 0; s < sids.length; s++) {
                        var sid = sids[s];
                        var cfgCmd = String((serverCfgs[sid] && serverCfgs[sid].command) || '');
                        var schip = document.createElement('label');
                        schip.className = 'ext-tool-chip';
                        schip.title = sid + (cfgCmd ? '：' + cfgCmd : '');
                        var scb = document.createElement('input');
                        scb.type = 'checkbox';
                        scb.className = 'switch-input';
                        scb.checked = policy.isServerEnabled(sid);
                        (function (serverId, chk) {
                            chk.addEventListener('change', function () {
                                policy.setServerEnabled(serverId, chk.checked);
                                renderStatusCard();
                            });
                        })(sid, scb);
                        var sbox = document.createElement('span');
                        sbox.className = 'ext-check';
                        var sname = document.createElement('span');
                        sname.className = 'ext-tool-name';
                        sname.textContent = sid;
                        schip.appendChild(scb); schip.appendChild(sbox); schip.appendChild(sname);
                        srvList.appendChild(schip);
                    }
                    groupCard.appendChild(srvList);
                }
            }

            // 组内 per-tool 开关（gateway 组为动态 mcp_*，走 per-server 开关不列 per-tool）——
            // 成员名单按组类型解析（见 groupMemberNames），循环体对三类组完全一致，流式自适应排布
            if (!group.gateway && registry) {
                var memberNames = groupMemberNames(gid, group);
                var toolList = document.createElement('div');
                toolList.className = 'ext-tool-list';
                if (memberNames.length === 0 && group.dynamic) {
                    // 只有动态组可能空（固定组的 fixed 名单是源码常量）；不渲染空列表，给一句
                    // 提示，否则卡片只剩组头，看不出是「本来就没有」还是渲染坏了
                    var emptyTool = document.createElement('div');
                    emptyTool.className = 'ext-tool-empty';
                    emptyTool.textContent = AEI18n.t('（暂无自定义工具）');
                    groupCard.appendChild(emptyTool);
                }
                for (var k = 0; k < memberNames.length; k++) {
                    var name = memberNames[k];
                    var tool = registry.get(name);
                    var desc = tool ? String(tool.shortDescription || tool.description || '') : AEI18n.t('（未注册）');
                    var chip = document.createElement('label');
                    chip.className = 'ext-tool-chip';
                    // 默认关的工具（记忆写四件）勾选框天然是未勾态：在 title 里点明来由与恢复
                    // 方式，否则看起来像渲染坏了或「本来就没勾」
                    var defaultOff = (typeof policy.isToolDisabled === 'function'
                        && policy.TOOL_DEFAULT_DISABLED && policy.TOOL_DEFAULT_DISABLED[name] === true
                        && policy.isToolDisabled(name)) ? AEI18n.t('（默认关：不对外提供，勾开即恢复）') : '';
                    chip.title = name + (desc ? '：' + desc : '') + defaultOff;
                    var tcb = document.createElement('input');
                    tcb.type = 'checkbox';
                    tcb.className = 'switch-input';
                    // 初值读策略层（与档位/组/per-server 同一持久化真相源）；
                    // 策略层不可用时回退注册表现状（旧行为）
                    tcb.checked = (policy && typeof policy.isToolDisabled === 'function')
                        ? !policy.isToolDisabled(name)
                        : !registry.isModuleDisabled(name, 'external-mcp');
                    (function (toolName, chk) {
                        chk.addEventListener('change', function () {
                            // per-tool 开关并入 extPolicy 持久化设置（内部同步
                            // toolRegistry 镜像），不再只写注册表内存态——只写内存态时重启后排除项
                            // 被静默恢复暴露。策略层不可用时回退旧直写（拼装不完整时仍可用）。
                            if (policy && typeof policy.setToolDisabled === 'function') {
                                policy.setToolDisabled(toolName, !chk.checked);
                            } else {
                                registry.setModuleEnabled(toolName, 'external-mcp', chk.checked);
                            }
                            if (bc) bc.notifyToolsChanged();
                            renderStatusCard();
                        });
                    })(name, tcb);
                    var box = document.createElement('span');
                    box.className = 'ext-check';
                    var tname = document.createElement('span');
                    tname.className = 'ext-tool-name';
                    tname.textContent = name;
                    chip.appendChild(tcb); chip.appendChild(box); chip.appendChild(tname);
                    toolList.appendChild(chip);
                }
                groupCard.appendChild(toolList);
            }
            pane.appendChild(groupCard);
        }
    }

    global.AEExternal = global.AEExternal || {};
    global.AEExternal.view = {
        enter: enter,
        exit: exit,
        isEntered: function () { return _entered; },
        renderStatusCard: renderStatusCard,
        // 供测试直接渲染设置页（幂等：内部先清空 pane，重复调用刷新为当前配置态）
        renderSettingsTab: renderSettingsTab,
        // 供测试直接驱动日志页（复制/清空路径回归；正常入口经模式切换）
        renderLogTab: renderLogTab
    };
})(window);
