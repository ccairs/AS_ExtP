// Agent 状态条系统（showStatus/hideStatus + 共享 statusState）
// 从 app/main.js 拆出：
//   - 本文件拥有 statusState 单例（main.js 通过 AEAgentApp.statusBar.state 取同一引用）
//   - showStatus/hideStatus/clearStatusTimers/syncDebugOnlySettingsVisibility
//     保留 window 挂载（main.js / settings.js 存在裸全局调用）
(function (global) {
    var stateFactory = global.AEAgentApp && global.AEAgentApp.state;
    var statusState = (stateFactory && typeof stateFactory.createStatusState === 'function')
        ? stateFactory.createStatusState()
        : {
            hideTimer: null,
            stickyTimeoutTimer: null,
            currentStickyRequestId: 0,
            debugMode: false
        };

    // 统一清理状态条相关定时器，避免提示串台或旧请求超时误触发。
    function clearStatusTimers() {
        if (statusState.hideTimer) {
            clearTimeout(statusState.hideTimer);
            statusState.hideTimer = null;
        }
        if (statusState.stickyTimeoutTimer) {
            clearTimeout(statusState.stickyTimeoutTimer);
            statusState.stickyTimeoutTimer = null;
        }
        if (statusState.stackTimers) {
            Object.keys(statusState.stackTimers).forEach((k) => {
                clearTimeout(statusState.stackTimers[k]);
            });
            statusState.stackTimers = {};
        }
        if (statusState.stickyTimeoutByRequest) {
            Object.keys(statusState.stickyTimeoutByRequest).forEach((k) => {
                clearTimeout(statusState.stickyTimeoutByRequest[k]);
            });
            statusState.stickyTimeoutByRequest = {};
        }
    }

    // 给状态条应用短促动效，强化用户感知
    function animateStatus(el) {
        if (typeof window.anime === 'function') {
            window.anime({
                targets: el,
                opacity: [0, 1],
                translateX: [10, 0],
                duration: 280,
                easing: 'easeOutCubic'
            });
        }
    }

    function hideStatus() {
        const status = document.getElementById('status');
        if (!status) {
            return;
        }
        status.textContent = '';
        status.style.display = 'flex';
        status.style.visibility = 'hidden';
        status.style.opacity = '1';
        status.className = 'status-inline';
    }

    // 状态条的宿主面板。团队模式的 lane 也写这条
    // 单例（`AEAgentTeam.lanes.domFor` 的三个状态键都指向它），所以团队模式下这里取到的就是
    // 单例本身——保留这段按 lane 取的理由：lane 忙态动画（is-generating / is-highlight）本就
    // 打在这条栏上，而「当前 lane 才允许写」的闸门在 view.js（sharedStatus + isCurrentLane），
    // 不在这里重复一遍判据（两处判据必然漂移）。单 Agent 路径与改动前逐字同款。
    function _currentStatusPanel() {
        var laneId = '';
        try {
            if (global.AEEngine && typeof global.AEEngine.getCurrentLaneId === 'function') {
                laneId = global.AEEngine.getCurrentLaneId() || '';
            }
        } catch (_) { laneId = ''; }
        if (laneId) {
            var lanes = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var dom = (lanes && typeof lanes.domFor === 'function') ? lanes.domFor(laneId) : null;
            var lanePanel = (dom && dom.statusPanelId) ? document.getElementById(dom.statusPanelId) : null;
            if (lanePanel) return lanePanel;
            // 该 lane 的面板缺席（骨架变体 / 尚未渲染）：**回落单例**——状态文案 #status 就在
            // 单例面板里，脉冲凭空消失比打在"上一层"更糟（用户得不到任何可见反馈）。
        }
        return document.getElementById('aeAgentStatusPanel');
    }

    function pulseStatusPanel() {
        const panel = _currentStatusPanel();
        if (!panel) {
            return;
        }
        panel.classList.remove('is-highlight');
        requestAnimationFrame(() => {
            panel.classList.add('is-highlight');
            setTimeout(() => {
                panel.classList.remove('is-highlight');
            }, 560);
        });
    }

    function resolveStatusTone(message, type) {
        if (type === 'success') {
            return 'status-tone-safe';
        }
        if (type === 'error') {
            const fatalPattern = /(致命|fatal|崩溃|不可恢复|critical|host桥接不可用|csinterface未定义)/i;
            return fatalPattern.test(String(message || '')) ? 'status-tone-fatal' : 'status-tone-warn';
        }
        return 'status-tone-safe';
    }

    function syncDebugOnlySettingsVisibility() {
        const rows = document.querySelectorAll('.debug-only-settings');
        rows.forEach((row) => {
            row.style.display = statusState.debugMode ? 'grid' : 'none';
        });
    }

    // 音效节流：状态条为单槽显示（新消息覆盖旧消息），模块挂载等场景会
    // 短时间内连弹多条状态，音效需同步合并——常规音效 1 秒窗口内只响第一声，
    // 避免连成"叮叮叮"；error 级别不受长窗口限制（仅 300ms 防错误级联重叠），保证错误不被吞。
    var _beepLastAt = 0;
    var _beepErrLastAt = 0;
    var BEEP_GAP_MS = 1000;
    var BEEP_ERR_GAP_MS = 300;

    function beepForStatus(type, tone) {
        if (typeof global.aeBeep !== 'function') return;
        if (type !== 'success' && type !== 'error' && type !== 'warn' && type !== 'info') return;
        const now = Date.now();
        if (type === 'error') {
            if (now - _beepErrLastAt < BEEP_ERR_GAP_MS) return;
            _beepErrLastAt = now;
            _beepLastAt = now;
            global.aeBeep(tone === 'status-tone-fatal' ? 'danger' : 'error');
            return;
        }
        if (now - _beepLastAt < BEEP_GAP_MS) return;
        _beepLastAt = now;
        global.aeBeep(type);
    }

    // 显示状态提示；支持 sticky 模式并可按 debug 策略过滤 info
    function showStatus(message, type, options = {}) {
        const status = document.getElementById('status');
        if (!status) {
            return;
        }

        if (!statusState.debugMode && type === 'info' && (!options.showAnyway)) {
            return;
        }

        const sticky = !!options.sticky;
        const autoHideMs = Number.isFinite(options.autoHideMs) ? options.autoHideMs : 3500;
        const rawMessage = String(message || '');

        // 每次展示新状态前先清理旧计时器，避免旧 hideTimer 抢先把新消息隐藏。
        if (statusState.hideTimer) {
            clearTimeout(statusState.hideTimer);
            statusState.hideTimer = null;
        }
        // sticky 超时句柄同样在覆盖前清理——连续两条
        // sticky 时新句柄直接覆盖旧句柄，旧定时器丢失无法取消，悬挂到原定到期才释放
        if (statusState.stickyTimeoutTimer) {
            clearTimeout(statusState.stickyTimeoutTimer);
            statusState.stickyTimeoutTimer = null;
        }

        status.textContent = rawMessage.replace(/\s+/g, ' ').trim();
        status.title = rawMessage;
        const tone = resolveStatusTone(message, type);
        status.className = `status-inline ${type} ${tone}`;
        status.style.display = 'flex';
        status.style.visibility = 'visible';
        animateStatus(status);
        pulseStatusPanel();

        // 音效反馈：对齐共享 toast 的按类型播报；致命错误（fatal tone）升级为更重的 danger 音效
        beepForStatus(type, tone);

        if (sticky) {
            const requestId = (statusState.currentStickyRequestId || 0) + 1;
            statusState.currentStickyRequestId = requestId;
            if (Number.isFinite(options.stickyTimeoutMs) && options.stickyTimeoutMs > 0) {
                statusState.stickyTimeoutTimer = setTimeout(() => {
                    if (statusState.currentStickyRequestId !== requestId) {
                        return;
                    }
                    showStatus(AEI18n.t('请求超时（>{secs}秒）', { secs: Math.round(options.stickyTimeoutMs / 1000) }), 'error', { autoHideMs: 5000 });
                }, options.stickyTimeoutMs);
            }
            return requestId;
        }

        statusState.hideTimer = setTimeout(() => {
            hideStatus();
        }, autoHideMs);
        return 0;
    }

    global.showStatus = showStatus;
    global.hideStatus = hideStatus;
    global.clearStatusTimers = clearStatusTimers;
    global.syncDebugOnlySettingsVisibility = syncDebugOnlySettingsVisibility;
    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.statusBar = {
        state: statusState,
        showStatus,
        hideStatus,
        clearStatusTimers,
        syncDebugOnlySettingsVisibility
    };
})(window);
