(function (global) {
    var mounted = false;
    var topbarEl = null;
    var topbarHandler = null;
    var sessionSwitcher = null;
    // 会话级 goal 的顶栏目标条（app/goalBar.js 建节点；本文件只负责挂载位置与生命周期）
    var goalBar = null;
    // 团队模式下「会话切换器被团队路径锁住」的标记（见 _syncSwitcherLock）：
    // 单 Agent 路径的锁由 chatViewHelpers 经 AEEngine.setSessionSwitcherDisabled 驱动，
    // 两条路必须互不覆盖——关团队那一刻要把团队路径留下的锁交还回去。
    var switcherLockedByTeam = false;

    function _resolveProviderLabel(providerId) {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        if (!registry || !providerId) return providerId || '';
        var provider = registry.getProvider(providerId);
        return (provider && provider.label) ? provider.label : providerId;
    }

    function _resolveSupportsVision(providerId, modelId) {
        var registry = global.AE_LLM && global.AE_LLM.providerRegistry;
        if (!registry || !providerId || !modelId) return false;
        try { return registry.supportsVision(providerId, modelId) === true; } catch (_) { return false; }
    }

    // 团队档当前 Agent 的模型/平台：顶栏显示的是**当前 lane** 的请求目标，
    // 解析实现只有引擎一份（AEEngine.getLaneModelSelection → bootstrap.resolveLaneModelSelection）。
    // 不是团队档 / 当前 lane 未知 / 引擎未装配 ⇒ null（回落全局默认，单 Agent 档行为逐字不变）。
    function _currentLaneModelSelection() {
        if (!_isTeamModeOn()) return null;
        var ui = _teamUI();
        var laneId = (ui && typeof ui.currentLaneId === 'function') ? (ui.currentLaneId() || '') : '';
        if (!laneId) return null;
        var engine = global.AEEngine;
        if (!engine || typeof engine.getLaneModelSelection !== 'function') return null;
        try {
            var sel = engine.getLaneModelSelection(laneId);
            if (sel && (sel.providerId || sel.modelId)) {
                return {
                    providerId: sel.providerId || '',
                    modelId: sel.modelId || '',
                    laneId: laneId,
                    laneLabel: _laneModelLabel(laneId)
                };
            }
        } catch (_) { /* 解析失败：回落全局默认 */ }
        return null;
    }

    // lane 显示名（顶栏标签用）：定义源只有 team/lanes.js，拿不到就用 id。
    function _laneModelLabel(laneId) {
        try {
            var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var list = (api && typeof api.list === 'function') ? (api.list() || []) : [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].id === laneId) return list[i].label || laneId;
            }
        } catch (_) { /* 定义拿不到：用 id 兜底 */ }
        return laneId;
    }

    function _readDefaults() {
        var laneSel = _currentLaneModelSelection();
        if (laneSel) return Promise.resolve(laneSel);
        var ctx = global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function' ? global.AEAppContainer.getContext() : null;
        var store = ctx && ctx.settingsStore;
        if (!store || typeof store.getGlobalSettings !== 'function') return Promise.resolve({ providerId: '', modelId: '' });
        return store.getGlobalSettings({}).then(function (g) {
            return {
                providerId: (g && (g.defaultProviderId || g.defaultPlatform)) || '',
                modelId: (g && (g.defaultModelId || g.defaultModel)) || ''
            };
        }).catch(function () { return { providerId: '', modelId: '' }; });
    }

    function _renderTopbar(detail) {
        if (!topbarEl) return;
        var providerId = detail && detail.providerId ? detail.providerId : '';
        var modelId = detail && detail.modelId ? detail.modelId : '';
        var providerLabel = _resolveProviderLabel(providerId);
        var hasVision = _resolveSupportsVision(providerId, modelId);

        // 不再用 textContent='' 清空整个 topbar（会误伤 token-stats）。
        // 改为：topbar 结构固定为 [infoWrapper, tokenStats]，
        // _renderTopbar 只重建 infoWrapper 内部内容，token-stats 保持不动。
        var infoWrapper = topbarEl.querySelector('.agent-topbar-info');
        if (!infoWrapper) {
            infoWrapper = document.createElement('span');
            infoWrapper.className = 'agent-topbar-info';
            topbarEl.appendChild(infoWrapper);
        }
        // 清空 wrapper 内部（不影响 token-stats）
        infoWrapper.textContent = '';

        var labelEl = document.createElement('span');
        labelEl.className = 'agent-topbar-label';
        // 团队档显示的是当前 Agent 的模型（与「当前选中」/用量行同源：当前 lane 的镜像）；
        // 单 Agent 档逐字不变。
        labelEl.textContent = (detail && detail.laneLabel) ? (AEI18n.t('当前模型 · ') + detail.laneLabel) : AEI18n.t('当前模型');
        _makeClickable(labelEl);
        infoWrapper.appendChild(labelEl);

        if (providerId || modelId) {
            var providerEl = document.createElement('span');
            providerEl.className = 'agent-topbar-provider';
            providerEl.textContent = providerLabel || AEI18n.t('未配置');
            _makeClickable(providerEl);
            infoWrapper.appendChild(providerEl);

            var dividerEl = document.createElement('span');
            dividerEl.className = 'agent-topbar-divider';
            dividerEl.textContent = '·';
            infoWrapper.appendChild(dividerEl);

            var modelEl = document.createElement('span');
            modelEl.className = 'agent-topbar-model';
            modelEl.textContent = modelId || AEI18n.t('未配置');
            if (modelId) modelEl.title = modelId;
            _makeClickable(modelEl);
            infoWrapper.appendChild(modelEl);

            if (hasVision) {
                var visionEl = document.createElement('span');
                visionEl.className = 'agent-topbar-vision';
                visionEl.title = AEI18n.t('支持视觉');
                visionEl.textContent = AEI18n.t('视觉');
                infoWrapper.appendChild(visionEl);
            }
        } else {
            var emptyEl = document.createElement('span');
            emptyEl.className = 'agent-topbar-model';
            emptyEl.textContent = AEI18n.t('未配置，点击前往模型管理');
            _makeClickable(emptyEl);
            infoWrapper.appendChild(emptyEl);
        }

        // sessionSwitcher 紧跟 token-stats 之后（幂等检查，确保它在 topbar 中）
        if (sessionSwitcher) {
            var switcherContainer = sessionSwitcher.getContainer();
            if (switcherContainer && switcherContainer.parentNode !== topbarEl) {
                topbarEl.appendChild(switcherContainer);
            }
        }
    }

    function _refreshTopbar() {
        _readDefaults().then(_renderTopbar);
    }

    function _navigateToModelManager() {
        if (global.AEApp && typeof global.AEApp.navigateToModule === 'function') {
            global.AEApp.navigateToModule('model-manager');
            return;
        }
        if (global.AEAppContainer && typeof global.AEAppContainer.activate === 'function') {
            global.AEAppContainer.activate('model-manager');
        }
    }

    // 把 label 和 model 节点包成可点击元素，点击跳转模型管理
    // provider/divider/vision 等其他区域不响应点击
    function _makeClickable(el) {
        if (!el) return;
        el.style.cursor = 'pointer';
        el.addEventListener('click', function (e) {
            e.stopPropagation();
            if (typeof aeBeep === 'function') aeBeep('open');
            _navigateToModelManager();
        });
    }

    // ── 团队模式 ────────────────────────────────────────────────
    function _teamUI() {
        var ui = global.AEAgentTeamUI;
        return (ui && typeof ui === 'object') ? ui : null;
    }

    function _isTeamModeOn() {
        var ui = _teamUI();
        if (!ui || typeof ui.isTeamModeOn !== 'function') return false;
        try { return !!ui.isTeamModeOn(); } catch (_) { return false; }
    }

    // 团队模式下的顶栏 token 行（`:143-147` 搬进顶栏的那个单节点）：显示**当前 lane** 的用量。
    // 内容从该 lane 自己的用量节点原样搬过来——**不在这里再写一份格式化**（up/down/缓存的
    // 排版唯一落点是 engine/view.js 的 _renderTokenStatsDom；两处排版必然不同步）。
    // 单 Agent 路径一个字节都不动（那行由当前 runtimeMode 的 view 自己写）。
    function _syncTokenRowToLane() {
        if (!topbarEl) return;
        var row = document.getElementById('aeAgentTokenStats');
        if (!row || !topbarEl.contains(row)) return;
        var ui = _teamUI();
        var laneId = (ui && typeof ui.currentLaneId === 'function') ? (ui.currentLaneId() || '') : '';
        var laneRow = laneId ? document.getElementById('aeAgentTokenStats_' + laneId) : null;
        if (!laneRow) {
            // 单 Agent / 该 lane 没有用量节点：维持 view 写入的原样。
            // 原生 title 在这里一并摘掉：「当前 Agent（…）的用量：与顶部那一行同源」这类文案
            // 关团队后残留会继续弹（现已不再写）。
            if (typeof row.removeAttribute === 'function') {
                try { row.removeAttribute('title'); } catch (_) { /* 属性不存在也不算失败 */ }
            }
            if (_isTeamModeOn()) return;   // 团队开着但该 lane 行缺失：标记保留，内容不动
            // 非团队档：清掉 lane 标记，并让当前 view 把内容重画回本模式的记录。
            // 团队档的镜像不会自己退回去，而 view 侧的 refreshTokenStats 是行的唯一排版落点
            //（这里不复制格式化）——否则切走团队后行上留的仍是上一条 lane 的数字
            //（症状：团队模式切到别的模式后不更新）。
            if (typeof row.removeAttribute === 'function') {
                try { row.removeAttribute('data-lane'); } catch (_) { /* 同上 */ }
            }
            try {
                var eng = global.AEEngine;
                var v = (eng && typeof eng.getView === 'function') ? eng.getView() : null;
                if (v && typeof v.refreshTokenStats === 'function') v.refreshTokenStats();
            } catch (_) { /* 引擎未装配：保持原样 */ }
            return;
        }
        if (row.innerHTML !== laneRow.innerHTML) row.innerHTML = laneRow.innerHTML;
        // 只写 data-lane，不写原生 title：title 的浏览器提示会与 view.js 的明细浮层
        //（_buildTokenPopover，「当前会话统计」）同时弹出两层，且文案是内部说明

        if (typeof row.setAttribute === 'function') {
            row.setAttribute('data-lane', laneId);
        }
    }

    // 会话切换器的禁用态：团队模式下 = 任一条 lane busy/restoring/switching、或 binder 整队切换
    // 在途（判据唯一实现在 `teamUI.anyLaneLocked`；主通道移除后不再有「主 Agent 在途」腿）。
    // `_switching` 窗口同样计入锁判据。判据实现在 teamUI，宿主只负责落到
    // switcher 上。
    // 单 Agent 路径这里**什么都不做**：那条路的锁是 chatViewHelpers 的职责，两边都写会互相覆盖
    //（一处 enable 就把另一处的锁解掉）。
    function _syncSwitcherLock() {
        if (!sessionSwitcher) return;
        if (!_isTeamModeOn()) {
            // 团队刚关（或从未开）：把团队路径留下的锁交还单 Agent 路径——否则「关了团队却
            // 永远切不了会话」。没有锁过就不动（别去 enable 掉单 Agent 路径正在生效的锁）。
            if (switcherLockedByTeam) {
                sessionSwitcher.enable();
                switcherLockedByTeam = false;
            }
            return;
        }
        var ui = _teamUI();
        var locked = (ui && typeof ui.anyLaneLocked === 'function') ? !!ui.anyLaneLocked() : false;
        if (locked) {
            sessionSwitcher.disable();
            switcherLockedByTeam = true;
        } else if (switcherLockedByTeam || sessionSwitcher.isDisabled && sessionSwitcher.isDisabled()) {
            // 团队档空闲 = 解锁。不只看自家标记：单 Agent 路径在进团队前可能已置灰，
            // 而它进团队后不再跑（两条路不叠加），只认自家标记会把那把锁永久留下。
            // 边界：本分支会解掉**任何来源**的禁用态。新增第三方 disable 源时必须同时把它
            // 接进 anyLaneLocked，否则会被这里静默解掉。
            sessionSwitcher.enable();
            switcherLockedByTeam = false;
        }
    }

    // 团队模式下的会话切换：整队切换的唯一落点是 binder，而 binder 经 orchestrator 的五个
    // 会话方法对外暴露（bootstrap 的公开面是 AEEngine.getOrchestrator）。
    // 为什么不能直接用当前 lane 的 controller：那只会切这一条 lane，另外两条留在旧会话上
    //（「整队」语义）。读接口（列表/当前会话）仍委托当前 lane 的 controller。
    function _teamControllerAdapter(laneController, orch) {
        return {
            getActiveStore: function () {
                return (laneController && typeof laneController.getActiveStore === 'function')
                    ? laneController.getActiveStore() : null;
            },
            getActiveCm: function () {
                return (laneController && typeof laneController.getActiveCm === 'function')
                    ? laneController.getActiveCm() : null;
            },
            createSession: function () { return Promise.resolve(orch.createTeamSession()); },
            switchSession: function (sid) { return Promise.resolve(orch.switchTeamSession(sid)); },
            renameSession: function (sid, title) { return Promise.resolve(orch.renameTeamSession(sid, title)); },
            deleteSession: function (sid) { return Promise.resolve(orch.deleteTeamSession(sid)); }
        };
    }

    // switcher 的 controller 解析：团队模式 + 编排面可用 ⇒ 整队适配器；否则**回落**现有
    // getController 路径（单 Agent 行为逐字不变，团队未装配时也不会更差）。
    function _switcherController() {
        var laneController = (global.AEEngine && typeof global.AEEngine.getController === 'function')
            ? global.AEEngine.getController() : null;
        if (!_isTeamModeOn()) return laneController;
        var orch = (global.AEEngine && typeof global.AEEngine.getOrchestrator === 'function')
            ? global.AEEngine.getOrchestrator() : null;
        if (!orch || typeof orch.switchTeamSession !== 'function') return laneController;
        return _teamControllerAdapter(laneController, orch);
    }

    // 团队 UI 的装配（幂等）：teamUI 缺席（未登记进 manifest / 加载失败）时静默跳过——
    // 单 Agent 路径不依赖它。tick 回调把「宿主侧的锁刷新与 token 行同步」挂进它的刷新节奏。
    function _mountTeamUI() {
        var ui = _teamUI();
        if (!ui || typeof ui.mount !== 'function') return false;
        try {
            ui.mount({ onStateTick: _syncTeamChrome });
            return true;
        } catch (e) {
            console.warn('[Agent] 团队 UI 装配失败: ' + (e && e.message ? e.message : e));
            return false;
        }
    }

    // 引擎装配/会话恢复完成后的补同步。为什么需要：模块 mount（→ _ensureTopbar → teamUI.mount）
    // **早于** bridge.mount（main.js 的 init 里 500ms 后调），而 AEEngine.getCurrentLaneId /
    // setTeamMode 是 bootstrap 在 _mountInner 里才挂上的 ⇒ 首次挂载那一刻「团队是否已开」问不出来
    // （团队开关栏会停在关闭外观、任务板空着），之后没有任何人会再来同步一次。
    // bootstrap 在恢复链收尾会调 refreshSessionSwitcher（本文件导出的公开通道）⇒ 借它补一次。
    function _refreshTeamUI() {
        _syncTeamChrome();
        if (!mounted) return false;
        return _mountTeamUI();
    }

    function _syncTeamChrome() {
        _syncSwitcherLock();
        _syncTokenRowToLane();
        // goal 目标条：团队 tick 是「当前 lane / 团队开关可能已变」的唯一廉价同步点。
        // 目标条读的是当前 controller 的 goal（团队切换后指向另一条 lane），所以必须复读。
        _refreshGoalBar();
        // 会话标题也在这里补一次：本函数是团队 UI 的 tick 回调（每次状态事件 +
        // 「团队任务」tab 可见时的 1s 兜底轮询都会经 `_notifyTick` 调它），而**重载**这条路上
        // 别人的刷新都问得太早——teamUI.mount 时 binder 还没认领团队会话 ⇒ 标签停在建时的「新会话」，
        // 之后若没有团队事件就一直是它（真机实测：重载后 teamOn=true、binder 已有 sid=team_…，
        // 标签仍写「新会话」；调一次窄接口即变成团队会话名）。窄接口实测 **0.22ms/次**，放在 tick 上
        // 无感；**绝不能用宽接口**（= 团队 UI 全量重挂载，见 refreshSessionSwitcher 处的实测）。
        if (typeof global.AEEngine.refreshSessionTitle === 'function') {
            try { global.AEEngine.refreshSessionTitle(); } catch (_) { /* 标题刷新失败不该打穿 tick */ }
        }
    }

    // 会话级 goal 的顶栏目标条：节点由 app/goalBar.js 建，本文件只负责
    // 挂载位置（顶栏左簇、#aeAgentTokenStats 之前——token-stats 的 margin-left:auto 右推布局
    // 不能动）与生命周期（unmount 里 destroy，节点显式摘除）。goalBar 缺席（未登记 manifest /
    // 加载失败）时静默跳过：单 Agent 路径不依赖它，缺了也不该让顶栏装配失败。
    function _ensureGoalBar(beforeEl) {
        if (!topbarEl) return;
        if (goalBar) {
            goalBar.update();
            return;
        }
        var factory = global.AEAgentGoalBar;
        if (!factory || typeof factory.createGoalBar !== 'function') return;
        var anchor = beforeEl || null;
        if (!anchor) {
            var ts = document.getElementById('aeAgentTokenStats');
            if (ts && ts !== topbarEl && topbarEl.contains(ts)) anchor = ts;
        }
        try {
            goalBar = factory.createGoalBar({ getController: _currentGoalController });
            goalBar.mount(topbarEl, anchor);
        } catch (e) {
            console.warn('[Agent] goal 顶栏条装配失败: ' + ((e && e.message) || e));
            goalBar = null;
        }
    }

    // 目标条的 controller 解析：团队档下 AEEngine.getController() 指向**当前 lane**（单例槽
    // _syncSlots 的指向）⇒ 切到 AE 执行 / Shader 执行 lane 时其 controller 没有 goal 门面，
    // 条自动隐藏。v1 不做跨 lane 展示导演目标。
    function _currentGoalController() {
        if (!global.AEEngine || typeof global.AEEngine.getController !== 'function') return null;
        try { return global.AEEngine.getController(); } catch (_) { return null; }
    }

    // tick / 幂等同步入口：条未建就补建（manifest 载序靠后也最终会补上），已建就复读当前 goal。
    function _refreshGoalBar() {
        if (!topbarEl) return;
        if (!goalBar) {
            _ensureGoalBar();
            return;
        }
        goalBar.update();
    }

    function _ensureTopbar() {
        var panel = document.getElementById('agentPanel');
        if (!panel) return;
        if (topbarEl && panel.contains(topbarEl)) return;
        topbarEl = document.createElement('div');
        topbarEl.id = 'agentCurrentModelBar';
        topbarEl.className = 'agent-current-model-bar';
        // 整体不再绑定 click，仅 label/provider/model 节点可点击
        panel.insertBefore(topbarEl, panel.firstChild);

        // 先创建 infoWrapper 占位（_renderTopbar 会填充其内部）
        var infoWrapper = document.createElement('span');
        infoWrapper.className = 'agent-topbar-info';
        topbarEl.appendChild(infoWrapper);

        // 把 token-stats 占位节点移动到 topbar 末尾（display 由 CSS 接管）
        // topbar 结构固定为 [infoWrapper, tokenStats]
        var tokenStats = document.getElementById('aeAgentTokenStats');
        if (tokenStats) {
            tokenStats.style.display = '';
            topbarEl.appendChild(tokenStats);
        }

        // 会话级 goal 目标条：顶栏左簇，插在 token-stats 之前
        _ensureGoalBar(tokenStats || null);

        // 初始化 sessionSwitcher（顶栏会话切换器），紧跟 token-stats 之后
        if (!sessionSwitcher && global.AEEngine && typeof global.AEEngine.createSessionSwitcher === 'function') {
            sessionSwitcher = global.AEEngine.createSessionSwitcher({
                // 团队模式下经编排面（binder 的下发口）整队切换；单 Agent 路径与改动前同款
                getController: _switcherController
            });
            sessionSwitcher.mount(topbarEl);
            // 引擎不随模块 unmount 销毁（bootstrap.mount 的 `if (mounted) return` 守卫使
            // 后续 mount 不再重跑会话恢复逻辑），刷新按钮重建 switcher 后默认标签是"新会话"，
            // 需立即从存活的 controller/cm 同步当前会话标题。首次挂载时 controller 为 null，
            // refresh() 会安全早返回，不影响首次启动由 bootstrap 触发的刷新流程。
            sessionSwitcher.refresh();
        }

        // 团队 UI（开关 / lane 切换条）：挂在顶栏（会话切换器同行）。幂等——顶栏随
        // unmount/remount 重建时它会把栏位补挂到新节点上。
        _mountTeamUI();
        _syncTeamChrome();

        _refreshTopbar();
    }

    function _bindEvents() {
        if (topbarHandler) return;
        topbarHandler = function () {
            _refreshTopbar();
            // 顶栏模型信息变了：团队模式下当前 lane 的用量行也顺手对齐一次（廉价、幂等）
            _syncTokenRowToLane();
        };
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('ae:default-llm-changed', topbarHandler);
            // 团队档切 lane / 开关团队 / 设置保存后的「当前模型」重绘（引擎派发；见
            // bootstrap._notifyLaneModelChanged / refreshLaneModelConfig）
            window.addEventListener('ae:lane-model-changed', topbarHandler);
        }
    }

    function _unbindEvents() {
        if (!topbarHandler) return;
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('ae:default-llm-changed', topbarHandler);
            window.removeEventListener('ae:lane-model-changed', topbarHandler);
        }
        topbarHandler = null;
    }

    var agentModule = {
        id: 'agent',
        get title() { return AEI18n.t('Agent 模块'); },
        get description() { return AEI18n.t('LLM 对话驱动 AE 操作，支持脚本 / Agent / Shader / 外接 / 团队五种模式'); },
        settingsTitle: 'Agent 模块设置',
        panelId: 'agentPanel',

        mount(containerContext) {
            if (mounted) return;
            if (global.AEAgent && typeof global.AEAgent.mount === 'function') {
                global.AEAgent.mount(containerContext || {});
            }
            _ensureTopbar();
            _bindEvents();
            // 挂载全部成功后才置位：先置后挂会在 AEAgent.mount 半途抛
            // 异常时把模块留在「mounted=true 但实际未挂载」状态，重进模块时守卫
            // 静默空跑、面板空白；对齐 unmount 的「标记反映真实状态」语义
            mounted = true;
        },

        unmount() {
            if (!mounted) return;
            mounted = false;
            _unbindEvents();
            // 团队 UI：停掉 1s 兜底轮询与合并窗口（引擎不随模块卸载销毁，团队 lane 继续在
            // 后台跑；但 UI 不可见时一次都不该轮询）。栏位引用一并弃掉，重挂载时按新顶栏重建。
            var teamUi = _teamUI();
            if (teamUi && typeof teamUi.unmount === 'function') {
                try { teamUi.unmount(); } catch (_) {}
            }
            // goal 目标条：destroy 由 goalBar 自己摘节点（连同 document 级监听），必须在顶栏
            // 移除之前——它挂在 topbar 内，且重挂载会建新实例，引用一并作废。
            if (goalBar && typeof goalBar.destroy === 'function') {
                try { goalBar.destroy(); } catch (_) {}
            }
            goalBar = null;
            if (topbarEl && topbarEl.parentNode) {
                // 拆卸前把 token-stats 还原回 #agentPanel 原位：它是 index.html 的静态
                // 共享元素，若随 topbarEl 一起移除会从文档丢失（getElementById 找不到
                // 脱离文档的节点）——重进模块后 token 显示永久消失，会话切换器也因
                // 缺少带 margin-left:auto 的 token-stats 而贴到模型信息旁。
                var ts = document.getElementById('aeAgentTokenStats');
                var panel = document.getElementById('agentPanel');
                if (ts && panel && topbarEl.contains(ts)) {
                    ts.style.display = 'none';
                    panel.insertBefore(ts, panel.firstChild);
                }
                topbarEl.parentNode.removeChild(topbarEl);
            }
            topbarEl = null;
            // 销毁会话切换器：移除 body 级 backdrop 与 document 级监听，防重复挂载泄漏
            if (sessionSwitcher && typeof sessionSwitcher.destroy === 'function') {
                try { sessionSwitcher.destroy(); } catch (_) {}
            }
            sessionSwitcher = null;
            // 锁的归属标记随 switcher 一起作废（重挂载会建一个默认启用态的新实例）
            switcherLockedByTeam = false;
            if (global.AEAgent && typeof global.AEAgent.unmount === 'function') {
                global.AEAgent.unmount();
            }
        },

        showSettings() {
            if (global.AEAgent && typeof global.AEAgent.showSettings === 'function') {
                global.AEAgent.showSettings();
            }
        },

        refresh() {
            if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                global.AEAgent.refreshList();
            }
        }
    };

    global.AEModules = global.AEModules || {};
    global.AEModules.agentModule = agentModule;

    // 暴露 sessionSwitcher 刷新接口供 bootstrap 调用
    global.AEEngine = global.AEEngine || {};
    // 会话切换器的**两个通道**（真机性能取证）：
    //   · refreshSessionTitle     —— **窄**：只重取标题/菜单（`sessionSwitcher.refresh()`）。
    //   · refreshSessionSwitcher  —— **宽**：窄的那一跳 + `_refreshTeamUI()`（= _syncTeamChrome +
    //     teamUI.mount）。宽的这一跳同时是「引擎侧已经装配好」的信号（bootstrap 的恢复链收尾要靠它
    //     补一次全量同步），但 `teamUI.mount()` 是**全量重挂载**（任务板重渲 / 抽屉路由 / 轮询重挂）
    //     —— 真机实测（CDP 直接量）：
    //       宽调用 **314.9ms/次（团队档）/ 621.9ms/次（单 Agent 档）**，而 `teamUI.mount()` 一项就占
    //       355ms / 616.7ms；CPU profile 的 top 全是 `_renderLaneRow` / `setAttribute` /
    //       `applyDrawerRouting` / `_syncTokenRowToLane` / `readTeamFromUI`。
    //     ⇒ **只是想让标题跟上（切模式 / 改名 / 进出团队）一律走窄接口**；宽的那个只留给
    //       「装配完成的补同步」（bootstrap 恢复链收尾那一次）。
    //     卡顿根因：会话标题修复当时用了宽接口，于是每次进出团队/切档都会叠
    //     一整次 teamUI 重挂载 —— 真机 A/B：进团队 +350ms 阻塞、出团队 **+1.2s** 阻塞；把两处调用
    //     换成 no-op 后阻塞归零（同一轮交错测量，非缓存冷热差异）。
    global.AEEngine.refreshSessionTitle = function () {
        if (sessionSwitcher) sessionSwitcher.refresh();
    };
    global.AEEngine.refreshSessionSwitcher = function () {
        global.AEEngine.refreshSessionTitle();
        // 这一跳同时是「引擎侧已经装配好」的信号（bootstrap 的恢复链收尾会调它）：
        // 团队 UI 在这里补一次全量同步（当前 lane 的用量行 / 锁 / 三条 lane 容器显隐 / 任务板）。
        _refreshTeamUI();
    };
    // 暴露 sessionSwitcher 禁用/启用接口供 controller 在 busy/停止清理窗口锁定切换入口
    global.AEEngine.setSessionSwitcherDisabled = function (disabled) {
        if (!sessionSwitcher) return;
        if (disabled) sessionSwitcher.disable();
        else sessionSwitcher.enable();
    };
    // 团队模式的锁刷新入口（teamUI 的刷新节奏／切 lane／团队开关都调它；单测直驱也用这个）。
    // 单 Agent 路径下它是**空操作**——见 _syncSwitcherLock 的注释（两条路不能互相覆盖）。
    global.AEEngine.refreshTeamSwitcherLock = function () { _syncSwitcherLock(); };
    global.AEEngine.refreshTeamChrome = function () { _syncTeamChrome(); };
})(window);
