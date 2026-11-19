let generatedScript = '';


// 注：本文件不定义 SETTINGS_KEY——设置读写已统一
// 经 settingsStore（它的 SETTINGS_KEY 是权威定义，见 settingsStore.js:2）。
const MODULE_ID = 'agent';
let llmModuleContext = null;
let llmUiInitialized = false;
let llmModuleMounted = false;
// mount 延迟 init 的定时器句柄 + 本周期 init 幂等标志。
// 「刷新模块」在 500ms 延迟窗口内 deactivate→activate 时，上一周期迟到的
// init 会与新周期的 init 双跑（重复 bridge.mount/loadSettings → 事件监听器
// 双绑，一次点击触发两次）；unmount 清定时器并复位标志拦截迟到双跑
let llmModuleInitTimer = null;
let llmModuleInitDone = false;
let cachedSettings = {};

// 诊断出口：debugMode 下把 [tag] 前缀的消息交给 console，由 shared/logger.js
// 劫持进底部 DEBUG LOG 面板。本模块不自留缓冲，日志留存统一由该面板负责。
function debugLog(tag, data) {
    var dbg = (typeof statusState !== 'undefined' && statusState) ? statusState.debugMode : false;
    if (!dbg) return;
    console.log('[' + tag + ']', typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

// MODELS derived from global registry with fallback for early init
function _getModels() {
    if (window.AE_LLM && window.AE_LLM.MODELS && Object.keys(window.AE_LLM.MODELS).length > 0) {
        return window.AE_LLM.MODELS;
    }
    // Minimal fallback for settings initialization before registry is ready
    return {
        openrouter: ['openai/gpt-6.1-terra'],
        deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
        siliconflow: ['deepseek-ai/DeepSeek-V4-Pro'],
        kimi: ['kimi-k3.1-pro']
    };
}
function _getDefaultModel() {
    var models = _getModels();
    return models.openrouter && models.openrouter[0] ? models.openrouter[0] : 'deepseek/deepseek-v4-pro';
}

const GLOBAL_SETTINGS_DEFAULT = {
    apiKey: '',
    openrouterApiKey: '',
    deepseekApiKey: '',
    kimiApiKey: '',
    themePreset: 'default',
    debugMode: false
};

const MODULE_SETTINGS_DEFAULT = {
    platform: '',
    model: '',
    customModel: '',
    skipRunConfirm: false,
    scriptListHeight: 320,
    runtimeMode: 'script',
    agentScriptReview: false,
    shaderJsReview: true,
    executionTimeoutMs: 30000,
    requestTimeoutMs: 120000,
    // 上下文兜底上限（默认 256k）：**只在服务商未上报模型窗口时生效**；
    // 服务商上报了就按窗口走（不再取 min）。已存盘的值不会被这里重置——默认值只对
    // 「新建/从未设置过」生效（见 normalize：Number(x) || 256000，存的 1000000 原样保留）。
    maxContextTokens: 256000,
    reasoningEffort: 'high',
    previewDraft: '',
    shaderDraft: '',
    allowCloudModels: false,
    webSearchEnabled: true,
    maxLlmStubTools: 200,
    // 待发送消息派发时机：false = 下一轮 LLM 请求前注入（默认，现状）；
    // true = 等当前轮正式回复后再作为新一轮发送。真源语义见 engine/settings.js 同名注释。
    deferInjectUntilReply: false,
    // 工具可见性用户覆盖：只存偏差，空 views = 全默认面（升级零迁移）。
    // 结构见 engine/settings.js 的 normalizeToolVisibility；本文件只转发归一，不写第二份判据。
    toolVisibility: { version: 1, views: {} },
    // 聊天区本地路径点击确认：默认弹确认框
    confirmPathOpen: true
};

const moduleUtils = window.AEAgentApp && window.AEAgentApp.moduleUtils ? window.AEAgentApp.moduleUtils : null;
const llmStateFactory = window.AEAgentApp && window.AEAgentApp.state ? window.AEAgentApp.state : null;
const llmSettings = window.AEAgentApp && window.AEAgentApp.settings ? window.AEAgentApp.settings : null;
/* exported llmPreviewHighlighter */
const llmPreviewHighlighter = window.AEAgentApp && window.AEAgentApp.previewHighlighter ? window.AEAgentApp.previewHighlighter : null;
const llmParticles = window.AEAgentApp && window.AEAgentApp.particles ? window.AEAgentApp.particles : null;
const llmHostBridgeAdapter = window.AEAgentApp && window.AEAgentApp.hostBridgeAdapter ? window.AEAgentApp.hostBridgeAdapter : null;
function getAgentBridge() {
    return window.AEEngine && window.AEEngine.bridge ? window.AEEngine.bridge : null;
}

// statusState 单例由 app/statusBar.js 拥有，此处取同一引用（保持既有 45 处调用不变）。
// 防御式回退：测试沙箱/dev mock 未加载 statusBar.js 时维持旧行为。
const statusState = (window.AEAgentApp && window.AEAgentApp.statusBar)
    ? window.AEAgentApp.statusBar.state
    : {
        hideTimer: null,
        stickyTimeoutTimer: null,
        currentStickyRequestId: 0,
        debugMode: false
    };

// 三个安全/路径函数已移至 agent/scripts/scriptSecurity.js
// 此处保留全局 function 转发，避免破坏现有调用方
// （quickBarScanner.js / script-tree.js / main.js 内部多处全局调用）
/* exported getDefaultScriptDir, normalizeScriptDir, isDangerousScriptDir */
function getDefaultScriptDir() {
    return window.AEScriptSecurity.getDefaultScriptDir();
}
function normalizeScriptDir(dir) {
    return window.AEScriptSecurity.normalizeScriptDir(dir);
}
function isDangerousScriptDir(dir) {
    return window.AEScriptSecurity.isDangerousScriptDir(dir);
}

// 约束脚本列表高度，确保拖拽缩放后的尺寸始终处于可读可用区间。
function clampScriptListHeight(value, fallback) {
    if (moduleUtils && typeof moduleUtils.clampScriptListHeight === 'function') {
        return moduleUtils.clampScriptListHeight(value, fallback);
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return fallback;
    }
    return Math.max(55, Math.min(720, Math.round(n)));
}

// 状态条系统已拆至 app/statusBar.js（showStatus/hideStatus 等由 window 挂载提供）

const runPulseState = {
    timeline: null,
    startedAt: 0,
    stopTimer: null
};

/* exported modalAnimationState */
const modalAnimationState = {
    closing: false,
    // 设置弹窗代际令牌（对齐下方 openModal/closeModal 的 _modalGen 模式）——
    // settings.js 关闭动画的 complete 回调不可取消，关闭后 170ms 内重开会被迟到
    // finalize 隐藏。open/close 各递增代际，回调校验代际未变才生效。
    gen: 0
};

// 粒子引擎状态机：渲染循环、画布尺寸、指针交互与诊断信息
const particleEngineState = {
    running: false,
    rafId: 0,
    timerId: 0,
    startTimerId: 0,
    startScheduled: false,
    canvas: null,
    ctx: null,
    stage: null,
    interactionTarget: null,
    particles: [],
    pulses: [],
    lastTs: 0,
    pointerX: -9999,
    pointerY: -9999,
    pointerActive: false,
    pointerHandlers: null,
    startRetryCount: 0,
    startRetryTimerId: 0,
    diagnosticsEnabled: true,
    firstFrameDrawn: false,
    layoutSyncRafId: 0,
    lastCssWidth: 0,
    lastCssHeight: 0,
    lastDpr: 1,
    lastErrorNoticeAt: 0
};

// 进入动画进行中标志：动画期间不启动粒子引擎，避免粒子 rAF 循环与
// anime.js 进入动画抢帧导致动画不流畅。动画完成后由 complete 回调启动粒子。
let _enterAnimating = false;


const scriptListUiState = (llmStateFactory && typeof llmStateFactory.createScriptListUiState === 'function')
    ? llmStateFactory.createScriptListUiState()
    : {
        expanded: false,
        minHeightPx: 55,
        maxHeightPx: 720,
        openHeightPx: 220
    };

const drawerUiState = {
    leftWidthPx: 320,
    rightWidthPx: 320,
    minWidthPx: 180,
    maxWidthPx: 680
};

const rafTick = (typeof window !== 'undefined' && typeof window.requestAnimationFrame === 'function')
    ? window.requestAnimationFrame.bind(window)
    : (cb) => window.setTimeout(() => cb(Date.now()), 16);
const cancelRafTick = (typeof window !== 'undefined' && typeof window.cancelAnimationFrame === 'function')
    ? window.cancelAnimationFrame.bind(window)
    : (id) => window.clearTimeout(id);

// 为按钮提供按压反馈动画，提升操作确认感
function animatePress(target) {
    if (typeof window.anime !== 'function') {
        return;
    }

    const isRunButton = target && target.classList && target.classList.contains('run');
    if (isRunButton) {
        window.anime({
            targets: target,
            scale: [1, 0.95, 1.02, 1],
            duration: 300,
            easing: 'easeOutCubic'
        });
        return;
    }

    window.anime({
        targets: target,
        scale: [1, 0.97, 1],
        duration: 220,
        easing: 'easeOutQuad'
    });
}

/* exported startRunPulse */
function startRunPulse() {
    const runBtn = document.getElementById('runBtn');
    if (!runBtn) {
        return;
    }
    // 执行期间禁用运行按钮——双击的第二下不再派发（service 侧
    // _runInFlight 单飞锁兜底程序化调用），动画/状态文案保持原样。
    runBtn.disabled = true;
    if (typeof window.anime !== 'function') {
        return;
    }

    if (runPulseState.stopTimer) {
        clearTimeout(runPulseState.stopTimer);
        runPulseState.stopTimer = null;
    }

    if (runPulseState.timeline) {
        runPulseState.timeline.pause();
        runPulseState.timeline = null;
    }

    runPulseState.startedAt = Date.now();
    runBtn.classList.add('running');

    runPulseState.timeline = window.anime.timeline({
        targets: runBtn,
        loop: true,
        easing: 'easeInOutSine'
    }).add({
        boxShadow: [
            '0 0 14px rgba(255, 151, 48, .42)',
            '0 0 36px rgba(255, 151, 48, .98)',
            '0 0 14px rgba(255, 151, 48, .42)'
        ],
        duration: 820
    }).add({
        scale: [1, 1.015, 1],
        duration: 820
    }, 0);
}

/* exported stopRunPulse */
function stopRunPulse() {
    const runBtn = document.getElementById('runBtn');
    const finalize = () => {
        if (runPulseState.timeline) {
            runPulseState.timeline.pause();
            runPulseState.timeline = null;
        }
        if (runBtn) {
            runBtn.classList.remove('running');
            runBtn.style.boxShadow = '';
            runBtn.style.transform = '';
            // startRunPulse 执行期禁用按钮，运行终态（含 minVisible 延迟
            // 收尾路径）必须复位——否则首次运行后按钮永久 disabled，运行入口自此不可用；
            // 复位点与 'running' 动画类同点（禁用窗口 = 视觉在跑窗口，快脚本双击第二下落在
            // 该窗口内仍被按钮原生 disabled 拦下）。
            runBtn.disabled = false;
        }
    };

    const elapsed = Date.now() - runPulseState.startedAt;
    const minVisibleMs = 520;
    if (elapsed < minVisibleMs) {
        if (runPulseState.stopTimer) {
            clearTimeout(runPulseState.stopTimer);
        }
        runPulseState.stopTimer = setTimeout(() => {
            runPulseState.stopTimer = null;
            finalize();
        }, minVisibleMs - elapsed);
        return;
    }

    finalize();
}

// 模块首屏面板入场动画，增强层级与节奏感
// 用合成器线程执行的 CSS 动画（见 agent.css 的 ae-panel-enter），避免 anime.js 走
// JS 主线程逐帧驱动——进入模块时主线程正忙着渲染恢复的会话，JS 动画会掉帧卡顿。
// 顺序约定（先播动画再分批加载）：动画在 init 同步工作结束后立即播放（面板壳先淡入，
// 避免等恢复期间面板被整体隐藏、露出背景）；初始会话恢复的重渲染由 bootstrap.js 经
// AEAgentApp.whenEnterAnimIdle 推迟到动画播完后执行，避免与动画重叠导致掉帧。

// 等入场动画播完再执行重任务（代码高亮/布局刷新等），避免它们抢主线程拖帧；
// 动画未在运行（如二次打开无动画）时立即执行。
function _whenEnterAnimIdle(cb) {
    if (_enterAnimating) {
        setTimeout(() => _whenEnterAnimIdle(cb), 60);
    } else {
        cb();
    }
}

// 供 bootstrap.js 等待入场动画结束再执行初始会话恢复的重渲染（先播动画再分批加载）
function _whenEnterAnimIdleSafe(cb) {
    try {
        _whenEnterAnimIdle(cb);
    } catch (e) {
        // 等待逻辑异常不应阻塞恢复流程，直接放行
        if (typeof cb === 'function') cb();
    }
}

// 入场动画的 start 延迟（setTimeout(start,0)）与 600ms 兜底定时器句柄
// 必须入模块状态——句柄即弃时，快速 unmount→remount 的前一周期迟到 start/
// finish 会在新周期上 remove('panel-enter') 掐断入场动画、提前复位 _enterAnimating
// 并提前启动粒子（对齐的 llmModuleInitTimer 句柄治理手法）。
var _enterStartTimer = null;
var _enterFallbackTimer = null;

function animatePanelsIn() {
    const layout = document.getElementById('agentPanel');
    if (!layout) {
        return;
    }

    // 重入先撤销上一周期挂起的 start/兜底回调，避免旧周期迟到触发
    // 干扰本周期动画状态
    if (_enterStartTimer) { clearTimeout(_enterStartTimer); _enterStartTimer = null; }
    if (_enterFallbackTimer) { clearTimeout(_enterFallbackTimer); _enterFallbackTimer = null; }

    _enterAnimating = true;
    layout.classList.remove('panel-enter');
    layout.classList.add('panel-enter-pending');

    let started = false;
    const start = () => {
        if (started) {
            return;
        }
        started = true;
        // start 已触发，清除挂起句柄
        _enterStartTimer = null;
        // 动画真正开播时再次置位，防止 unmount 曾重置标志后事件迟到触发动画时守卫失效
        _enterAnimating = true;
        layout.classList.remove('panel-enter-pending');
        layout.classList.add('panel-enter');
        let ended = false;
        const finish = (ev) => {
            if (ended) {
                return;
            }
            // animationend 会从子孙元素冒泡上来：面板内若有自己的 CSS 动画（消息气泡、
            // 加载态、状态提示等）提前结束，会误触发 finish 把 420ms 入场动画提前掐断成
            // 瞬显，视觉上就是首次打开的"卡"。因此只认 ae-panel-enter 自身的结束事件；
            // setTimeout 兜底调用时无 ev，正常放行。
            if (ev && ev.animationName && ev.animationName !== 'ae-panel-enter') {
                return;
            }
            ended = true;
            // 正常完成时撤销兜底句柄（animationend 先于 600ms 兜底触发）
            if (_enterFallbackTimer) { clearTimeout(_enterFallbackTimer); _enterFallbackTimer = null; }
            layout.removeEventListener('animationend', finish);
            layout.classList.remove('panel-enter');
            _enterAnimating = false;
            // 动画播完再启动粒子，避免粒子 rAF 循环与进入动画抢帧导致动画不流畅
            if (llmModuleMounted && !window.AE_ExtP_LowPerfMode && !particleEngineState.running) {
                startParticleEngine();
            }
        };
        // 不用 once：子元素动画先冒泡触发时守卫会提前 return，once 会把监听消费掉，
        // 导致面板自身 ae-panel-enter 的结束事件再也收不到。改普通监听、finish 里手动移除。
        layout.addEventListener('animationend', finish);
        // 兜底：动画未触发/异常时也保证完成回调执行，避免 _enterAnimating 残留
        // 句柄入模块状态，unmount/重入可撤销迟到触发
        _enterFallbackTimer = setTimeout(finish, 600);
    };

    // 动画开播统一推迟到下一个宏任务：animatePanelsIn 在 init 的同步调用栈中段被调用，
    // 其后还有 bridge.mount/enforceHeight/refreshList 等同步布局工作。若此处立即 start()，
    // 动画(420ms) 会与这些主线程工作重叠而被拖帧。setTimeout(0) 让动画在 init 同步尾部
    // 全部跑完后、主线程空闲时再播放。
    // 顺序约定（先播动画再分批加载）：动画不等初始会话恢复——否则大上下文会话恢复期间
    // 面板被 .panel-enter-pending 整体隐藏数秒、露出背景。恢复的重渲染(switchSession)
    // 由 bootstrap.js 经 AEAgentApp.whenEnterAnimIdle 推迟到动画播完后执行。
    _enterStartTimer = setTimeout(start, 0);
}


// 优先使用模块注入的 settingsStore，缺省时回退到全局容器上下文。
function getSettingsStore() {
    if (llmSettings && typeof llmSettings.getSettingsStore === 'function') {
        return llmSettings.getSettingsStore(llmModuleContext);
    }
    return llmModuleContext && llmModuleContext.settingsStore
        ? llmModuleContext.settingsStore
        : (window.AEAppContainer && window.AEAppContainer.getContext ? window.AEAppContainer.getContext().settingsStore : null);
}

// 读取并合并“全局设置 + 模块设置”，同时做字段归一化与兼容回退。
async function loadSettings() {
    if (llmSettings && typeof llmSettings.loadSettings === 'function') {
        return llmSettings.loadSettings({
            moduleContext: llmModuleContext,
            moduleId: MODULE_ID,
            globalDefaults: GLOBAL_SETTINGS_DEFAULT,
            moduleDefaults: MODULE_SETTINGS_DEFAULT,
            models: _getModels(),
            clampScriptListHeight
        });
    }

    const store = getSettingsStore();

    if (store && typeof store.getGlobalSettings === 'function' && typeof store.getModuleSettings === 'function') {
        const globalSettings = await store.getGlobalSettings(GLOBAL_SETTINGS_DEFAULT);
        const moduleSettings = await store.getModuleSettings(MODULE_ID, MODULE_SETTINGS_DEFAULT);
        const merged = {
            ...GLOBAL_SETTINGS_DEFAULT,
            ...MODULE_SETTINGS_DEFAULT,
            ...globalSettings,
            ...moduleSettings
        };

        merged.scriptListHeight = clampScriptListHeight(merged.scriptListHeight, 320);
        return merged;
    }

    // 设置仓库不可用时（项目定论：settingsStore 恒注入——client/main.js:2785 创建、
    // :3064 经 createAppContainer dependencies 传入，getSettingsStore 的容器兜底读的
    // 就是它；此路实际不可达）
    // **不读 localStorage**。按扁平形状读（parsed.debugMode /
    // parsed.platform / …），而字段早已被 settingsStore 搬到 global.* 与 modules.*
    //（见 settingsStore.js:249 的迁移）——读到的只能是默认值：不是"旧版本数据"，
    // 而是"读错了位置"，且静默无痕（表现为"设置莫名回默认"而毫无线索）。
    // 保留一个总返回默认值的出口即可，函数仍然总是有返回值。
    console.warn('[Agent] settingsStore 不可用，loadSettings 返回默认值（不再读 localStorage 旧形状）');
    return {
        ...GLOBAL_SETTINGS_DEFAULT,
        ...MODULE_SETTINGS_DEFAULT,
        model: _getDefaultModel()
    };
}

// 持久化设置：先归一化关键字段，再分发到全局/模块存储层。
async function saveSettings(settings) {
    if (llmSettings && typeof llmSettings.saveSettings === 'function') {
        // 先同步更新内存态，让同步调用方（refreshList/switchContext/getSettings）
        // 立即读到新值——否则 await 持久化期间读到旧 runtimeMode 会导致
        // 切 Agent 模式时刷新错列表（Agent 模式刷脚本列表 / 脚本模式刷任务列表）。
        cachedSettings = { ...cachedSettings, ...settings };
        _syncAeToolTimeout();
        _syncLlmStubToolsLimit();
        // 透传写结果（false = settingsStore 写失败，配额满/加密异常）——
        // 调用方（保存按钮/DEBUG 开关）据此弹错，不再把失败当成功提示
        return await llmSettings.saveSettings({
            settings,
            moduleContext: llmModuleContext,
            moduleId: MODULE_ID,
            defaultModel: _getDefaultModel(),
            openHeightPx: scriptListUiState.openHeightPx,
            clampScriptListHeight
        });
    }

    const normalized = {
        ...settings,
        scriptListHeight: clampScriptListHeight(settings.scriptListHeight, scriptListUiState.openHeightPx),
        debugMode: !!settings.debugMode
    };
    // 一致性：team 段先浅拷贝（本函数会把它重建成新对象，别改到调用方那份），
    // 再跑转发来的一致性规则——主路径（llmSettings.saveSettings）里同样有一遍（app/settings.js）。
    normalized.team = Object.assign({}, settings.team);
    _applyModeConsistencyForSave(normalized);

    const store = getSettingsStore();
    if (store && typeof store.setModuleSettings === 'function') {
        cachedSettings = { ...cachedSettings, ...normalized };
        _syncAeToolTimeout();
        _syncLlmStubToolsLimit();
        // 透传写盘结果（false = settingsStore 写失败）——调用方据此弹错，不谎报成功
        return await store.setModuleSettings(MODULE_ID, {
            platform: normalized.platform || 'openrouter',
            model: normalized.model || _getDefaultModel(),
            customModel: normalized.customModel || '',
            skipRunConfirm: !!normalized.skipRunConfirm,
            scriptListHeight: normalized.scriptListHeight,
            runtimeMode: normalized.runtimeMode || 'script',
            executionTimeoutMs: _normExecutionTimeoutMs(normalized.executionTimeoutMs),
            // 与 engine/app-settings 统一 10000–300000 夹取（采集通道
            // 只保下限——统一走共享归一，见 _normRequestTimeoutMs）
            requestTimeoutMs: _normRequestTimeoutMs(normalized.requestTimeoutMs),
            // 兜底值：未设置过才用 256K；已存盘的值原样保留（升级不重置）。钳制上限仍是 1M
            maxContextTokens: Math.max(2000, Math.min(1000000, Number(normalized.maxContextTokens) || 256000)),
            agentScriptReview: !!normalized.agentScriptReview,
            shaderJsReview: !!normalized.shaderJsReview,
            webSearchEnabled: normalized.webSearchEnabled !== false,
            deferInjectUntilReply: !!normalized.deferInjectUntilReply,
            // 0=不限制是合法值，`|| 200` 会挤掉 0；仅 NaN 回退 200
            maxLlmStubTools: Number.isFinite(Number(normalized.maxLlmStubTools))
                ? Math.max(0, Math.min(10000, Number(normalized.maxLlmStubTools)))
                : 200,
            reasoningEffort: ['low', 'medium', 'high', 'xhigh'].indexOf(normalized.reasoningEffort) >= 0 ? normalized.reasoningEffort : 'high',
            permissionMode: ['auto', 'balanced', 'conservative'].indexOf(normalized.permissionMode) >= 0 ? normalized.permissionMode : 'balanced',
            // 0 = 不超时是合法值（UI 标题明示）：`Number(v) || 30000` 会把 0 挤成 30000，
            // 仅 NaN/非法值回退默认。与 app/settings.js 的 _normPermissionConfirmTimeoutMs 同口径。
            permissionConfirmTimeoutMs: (function () {
                var _n = Number(normalized.permissionConfirmTimeoutMs);
                return Number.isFinite(_n) ? Math.max(0, Math.min(300000, _n)) : 30000;
            })(),
            // askUser 提问等待上限（0 = 不超时是合法值；仅非法值回落默认 5 分钟）
            askUserTimeoutMs: (function () {
                var _n = Number(normalized.askUserTimeoutMs);
                return Number.isFinite(_n) ? Math.max(0, Math.min(3600000, _n)) : 300000;
            })(),
            // 团队段：store 的入参是显式字段表，漏掉它团队开关与 lane 参数就只活在内存里
            // （重启后面板回到默认 = 团队被静默关闭）
            team: _normTeamForSave(normalized.team, normalized.runtimeMode),
            // 工具可见性用户覆盖：同样是显式字段表——漏掉它，用户配置只活在内存、
            // 重载面板即回默认。归一转发 engine/settings.js（唯一实现）。
            // `typeof` 守卫理由同 getCurrentSettingsFromUI 里那处：本函数也会被单测按函数体
            // 切片求值，兄弟归一转发缺席时原样落值，不抛 ReferenceError（生产面恒装配）。
            toolVisibility: (typeof _normToolVisibility === 'function')
                ? _normToolVisibility(normalized.toolVisibility)
                : normalized.toolVisibility
        });
    }

    // 设置仓库不可用：**不再直写 localStorage**，只告警。
    // 直写 `localStorage.setItem(SETTINGS_KEY, …)` 会把**扁平形状**写进 store 用的**同一个 key**
    //（store 在该 key 下存的是 `{global:{…}, modules:{…}}`）——一旦真的走到这里，会把整个存储
    // 载荷覆盖成扁平对象，**连带清掉全局设置与其它所有模块的设置**。原注释的理由是
    // "不删除该分支，避免未知调用方行为变化"，但它换来的是"可能砸掉全部设置"，不成比例。
    //（settings.js 的 saveSettings 兜底是同款写法，已一并去除；全局设置那边用独立 key 的
    //  patch `ae_global_settings_patch_v1` 正是为避开这一点。）
    // 读侧兜底返回默认值（见上方 loadSettings），故这里的写入也不再有任何读者。
    // 其后的内存态同步必须保留：保存失败也不该让本次会话读到旧值。
    console.warn('[Agent] settingsStore 不可用，设置无法持久化（已跳过直写，避免覆盖存储载荷）；'
        + '本次修改仅存在于内存，重载面板后丢失');
    cachedSettings = { ...cachedSettings, ...normalized };
    _syncAeToolTimeout();
    // 如实返回失败——调用方据此保留弹窗/弹错误提示
    return false;
}

// 团队段落盘归一：转发 engine/settings.js 的 normalizeTeam（唯一实现）。引擎未加载时返回
// null——读取侧（team/settings.js）对 null 走「关闭态」的显式分支，比在这里造第二份默认值安全。
// 第二参 runtimeMode = baseMode 兜底来处：漏掉它，一次落盘就可能把
// 「上次从外接进团队」留下的 baseMode 抹成 'script'，退出团队时落错档。
function _normTeamForSave(raw, runtimeMode) {
    var fn = null;
    try {
        fn = (window.AEEngine && window.AEEngine.settings && window.AEEngine.settings.normalizeTeam) || null;
    } catch (_) { fn = null; }
    if (typeof fn !== 'function') return null;
    try { return fn(raw, runtimeMode); } catch (_) { return null; }
}

// 面板档位一致性 + 老盘迁移：转发 engine/settings.js 的唯一实现。
// 落盘前必须过一遍——否则 `runtimeMode` 与 `team` 两半可能不自洽，脏值先落盘、下次读盘才纠正。
function _applyModeConsistencyForSave(target) {
    var fn = null;
    try {
        fn = (window.AEEngine && window.AEEngine.settings && window.AEEngine.settings.applyModeConsistency) || null;
    } catch (_) { fn = null; }
    if (typeof fn !== 'function') return target;
    try { fn(target); } catch (_) { /* 归一不可用：保持原值（读侧还会再纠正一次） */ }
    return target;
}

// 执行超时归一（3~120 秒，默认 30 秒）：真源 = engine/settings.js 的
// normalizeExecutionTimeoutMs（与 app/settings.js 的 _normExecutionTimeoutMs 同一转发）。
// 采集（getCurrentSettingsFromUI）与落盘兜底分支都走这里——旧采集式
// `Math.max(3, 秒) * 1000` 只保下限：填 ≥2147484 秒时值 >2^31-1 ms，
// setTimeout 延迟溢出夹成 ~1ms → 脚本模式「运行」与快捷栏执行立即误报超时。
function _normExecutionTimeoutMs(v) {
    var norm = null;
    try {
        norm = (typeof window !== 'undefined' && window && window.AEEngine
            && window.AEEngine.settings && window.AEEngine.settings.normalizeExecutionTimeoutMs) || null;
    } catch (_) { norm = null; }
    if (typeof norm === 'function') return norm(v);
    var n = Number(v) || 30000;
    return Math.max(3000, Math.min(120000, n));
}

// Agent 请求超时归一（10~300 秒 / 10000~300000ms，默认 120000ms）：真源 = engine/settings.js 的
// normalizeRequestTimeoutMs（与 app/settings.js 的 _normRequestTimeoutMs 同一转发）。
// 采集（getCurrentSettingsFromUI）与落盘兜底分支都走这里——旧采集式
// `Math.max(10, 秒) * 1000` 只保下限：填 600 秒时 UI 显示 600、引擎实际夹到 300，
// 回填又按原值显示 600，形成「UI 显示 600s 实际 300s」的假象。上限 300000 维持不变。
function _normRequestTimeoutMs(v) {
    var norm = null;
    try {
        norm = (typeof window !== 'undefined' && window && window.AEEngine
            && window.AEEngine.settings && window.AEEngine.settings.normalizeRequestTimeoutMs) || null;
    } catch (_) { norm = null; }
    if (typeof norm === 'function') return norm(v);
    var n = Number(v) || 120000;
    return Math.max(10000, Math.min(300000, n));
}

// 工具可见性归一：真源 = engine/settings.js 的 normalizeToolVisibility（唯一实现）。
// 采集（getCurrentSettingsFromUI）、落盘兜底字段表都**只转发**这一个函数——app 层不得复制
// 「合法视图键 / 数组上限 / disabled 优先 / 空段不落盘」这套判据（第二份判据必漂移）。
// 引擎未加载（测试桩/极端环境）时原样返回：宁可不归一，也不在这里造第二个口径。
function _normToolVisibility(v) {
    var norm = null;
    try {
        norm = (typeof window !== 'undefined' && window && window.AEEngine
            && window.AEEngine.settings && window.AEEngine.settings.normalizeToolVisibility) || null;
    } catch (_) { norm = null; }
    if (typeof norm === 'function') {
        try { return norm(v); } catch (_) { return v; }
    }
    return v;
}

function _syncAeToolTimeout() {
    try {
        window.AE_LLM = window.AE_LLM || {};
        var ms = Number(cachedSettings.executionTimeoutMs);
        if (ms >= 3000) window.AE_LLM._aeToolTimeoutMs = ms;
    } catch (_) {}
}

// 将 Agent 模块的“工具上限”设置同步到 toolRegistry 的 stub 工具裁剪上限。
// 0 表示不限制；被裁工具仍可经 tool_search 获取完整定义。
function _syncLlmStubToolsLimit() {
    try {
        var reg = window.AE_LLM && window.AE_LLM.toolRegistry;
        if (reg && typeof reg.setMaxLlmStubTools === 'function') {
            reg.setMaxLlmStubTools(Number(cachedSettings.maxLlmStubTools) || 0);
        }
    } catch (_) {}
}

// 从模块设置面板读取当前输入值
// includeDrafts：默认 **false** = 不采集「草稿载体」类字段
//（目前只有 #toolVisibilityInput）。设置页是按钮驱动表单，面板里的草稿在点「保存模块设置」
// 前不生效；因此只有该保存按钮路径（app/settings.js 的 handleSaveSettings）显式传 true，
// 其余调用点一律不采集，否则「关设置页不保存则丢弃」会被一条工具栏切换/草稿防抖静默打穿。
// 非保存调用点现状（grep 维护，归一判据只有一处）：app/settings.js 工具栏 strip 即时保存
//（_persistSettingsFromUI）、main.js 脚本草稿 250ms 防抖 / shader 草稿防抖 / setPreviewCode
// 两处程序化写、app/service.js 的预览区提交写稿与两个运行入口、app/script-tree.js 载入预览。
function getCurrentSettingsFromUI(includeDrafts) {
    var _includeDrafts = includeDrafts === true;
    // 安全读取：设置面板元素是动态注入的，未打开时可能不存在，fallback 到 cachedSettings
    var el = function (id) { return document.getElementById(id); };
    var val = function (id, fallback) {
        var elem = el(id);
        return elem ? elem.value : (fallback !== undefined ? fallback : '');
    };
    var chk = function (id, fallback) {
        var elem = el(id);
        return elem ? !!elem.checked : !!fallback;
    };
    var num = function (id, fallback) {
        var v = val(id, fallback);
        return Number(v) || (fallback || 0);
    };

    var cs = cachedSettings || {};
    var modeSw = document.getElementById('runtimeModeSwitch');
    var _modeIdx = modeSw ? parseInt(modeSw.dataset.modeIndex || '0', 10) : 0;
    // 旋钮第 5 档**就是** `runtimeMode === 'team'` —— 旋钮位置与
    // 设置字段同义。若第 5 档沿用已持久化的单 Agent 档位，写 'team'
    // 会被 normalize 折成 script，于是没人敢写。现在「被 park 的单 Agent 档位」由 team.baseMode 承载。
    // 档位表引用 engine 的唯一来源（MODES，引擎缺席时本地兜底同一清单——不造第二份白名单）。
    // `typeof window` 守卫：本函数会被单测按函数体切片求值（无 window 的上下文），不能裸读 window。
    var _stM = (typeof window !== 'undefined' && window && window.AEEngine && window.AEEngine.settings) || null;
    var _modes = (_stM && _stM.MODES) || ['script', 'agent', 'shader', 'external', 'team'];
    var runtimeMode = _modes[_modeIdx] || String(cs.runtimeMode || 'script');
    var out = {
        // LLM provider/model 由「模型管理」模块的全局默认值统一维护，Agent UI 不再提供覆盖项。
        platform: '',
        model: '',
        customModel: '',
        skipRunConfirm: chk('skipRunConfirm', cs.skipRunConfirm),
        scriptListHeight: clampScriptListHeight(scriptListUiState.openHeightPx || cs.scriptListHeight, 320),
        runtimeMode,
        executionTimeoutMs: _normExecutionTimeoutMs(num('executionTimeoutMs', (cs.executionTimeoutMs || 30000) / 1000) * 1000),
        permissionConfirmTimeoutMs: (function () {
            var el = document.getElementById('permissionConfirmTimeoutMs');
            if (el && el.value !== '') {
                var v = Number(el.value);
                // 先四舍五入到毫秒再夹取——旧 `Math.floor(秒)*1000` 把 0.5 秒
                // 取整成 0ms，而 0 的约定是「不超时（无限等待）」：用户输入"半秒"
                // 得到"永不超时"，语义正好反转。0 仍保持 0 = 不超时。
                var ms = Math.round((isFinite(v) ? v : 30) * 1000);
                // 正的极小值（< 0.0005 秒）四舍五入同样落到 0——与 同款
                // 语义反转（用户填了正数却得到"永不超时"）。正数下限收敛到 1ms；
                // 只有输入恰为 0（显式"不超时"）或非法值回落 30 秒才保留 0 分支。
                if (ms === 0 && v > 0) ms = 1;
                return Math.max(0, Math.min(300000, ms));
            }
            return (typeof cs.permissionConfirmTimeoutMs === 'number' ? cs.permissionConfirmTimeoutMs : 30000);
        })(),
        // askUser 提问等待上限：UI 单位是秒、内部字段毫秒（与确认等待超时同款换算）。
        // 0 = 不超时（显式合法值）；正数下限收敛到 1ms，避免小数秒四舍五入成 0 反转语义。
        askUserTimeoutMs: (function () {
            var elx = document.getElementById('askUserTimeoutMs');
            if (elx && elx.value !== '') {
                var v = Number(elx.value);
                var ms = Math.round((isFinite(v) ? v : 300) * 1000);
                if (ms === 0 && v > 0) ms = 1;
                return Math.max(0, Math.min(3600000, ms));
            }
            return (typeof cs.askUserTimeoutMs === 'number' ? cs.askUserTimeoutMs : 300000);
        })(),
        // UI 单位是秒，内部字段毫秒——与「执行超时」同款换算形状。
        // 采集经共享归一（10~300 秒），与落盘/引擎同口径——只保下限时，
        // 600 秒落盘后被引擎夹成 300，UI 却按 600 回显。
        requestTimeoutMs: _normRequestTimeoutMs(num('requestTimeoutMs', (cs.requestTimeoutMs || 120000) / 1000) * 1000),
        // 上下文上限是「下拉 + 可输入」的组合框：值可能是 128K / 0.5M，交给统一的解析器（认三种写法）
        maxContextTokens: (function () {
            var elx = document.getElementById('maxContextTokens');
            var fallback = Math.max(2000, Math.min(1000000, Number(cs.maxContextTokens) || 256000));
            if (!elx || elx.value === '') return fallback;
            var parse = window.AEAgentApp && window.AEAgentApp.settingsPanel
                && window.AEAgentApp.settingsPanel.parseTokenValue;
            return typeof parse === 'function' ? parse(elx.value, fallback) : fallback;
        })(),
        reasoningEffort: (function () {
            // 团队档：工具栏滚轮显示的是**当前 Agent** 的思考等级，不能当全局值采集
            //（滚轮改为编辑当前 Agent 后，权限滚轮触发的即时保存会把 lane 值
            // 写进全局设置——这里在团队档直接返回缓存里的全局值，单 Agent 档行为不变）。
            var _teamCtx = null;
            try {
                _teamCtx = (typeof window !== 'undefined' && window.AEAgentApp
                    && window.AEAgentApp.settings
                    && typeof window.AEAgentApp.settings.teamThinkingContext === 'function')
                    ? window.AEAgentApp.settings.teamThinkingContext() : null;
            } catch (_) { _teamCtx = null; }
            if (_teamCtx && _teamCtx.on && _teamCtx.laneId) return cs.reasoningEffort || 'high';
            var strip = el('reasoningEffortStrip');
            if (!strip) return cs.reasoningEffort || 'high';
            var levels = ['low', 'medium', 'high', 'xhigh'];
            var transform = strip.style.transform || '';
            var match = transform.match(/-?\d+/);
            var idx = match ? Math.round(-parseInt(match[0], 10) / 18) : 2;
            return levels[idx] || 'high';
        })(),
        previewDraft: String(el('scriptPreview') ? el('scriptPreview').value : (cs.previewDraft || '')),
        shaderDraft: String(el('shaderCodePreview') ? el('shaderCodePreview').value : (cs.shaderDraft || '')),
        // loadSettings 异常时 cs.userPersona 可能是 undefined/null，
        // 直接 .trim() 会抛 TypeError 并放大为「运行脚本失败: JS异常」——加 || '' 同款防御。
        userPersona: (val('userPersonaInput', cs.userPersona) || '').trim(),
        agentScriptReview: chk('agentScriptReview', cs.agentScriptReview),
        shaderJsReview: chk('shaderJsReview', cs.shaderJsReview),
        allowCloudModels: chk('allowCloudModels', cs.allowCloudModels),
        webSearchEnabled: chk('webSearchEnabled', cs.webSearchEnabled),
        maxLlmStubTools: (function () {
            // 面板未打开/输入非法时回退缓存值——缓存里的 0（不限制）必须原样保留
            var fb = Number.isFinite(Number(cs.maxLlmStubTools)) ? Number(cs.maxLlmStubTools) : 200;
            var el = document.getElementById('maxLlmStubTools');
            if (el && el.value !== '' && el.value !== undefined) {
                var v = Number(el.value);
                return (isFinite(v) && v >= 0) ? Math.min(10000, Math.floor(v)) : fb;
            }
            return fb;
        })(),
        confirmExternalLink: chk('confirmExternalLink', cs.confirmExternalLink !== false),
        confirmPathOpen: chk('confirmPathOpen', cs.confirmPathOpen !== false),
        deferInjectUntilReply: chk('deferInjectUntilReply', cs.deferInjectUntilReply),
        // 工具可见性：设置面板里的 #toolVisibilityInput 是子面板
        // 草稿的唯一载体（JSON 字符串）。只有点「保存模块设置」的路径（includeDrafts=true）
        // 才采集它；其余即时保存/草稿防抖路径一律沿用**已生效**缓存值——否则工具栏切换或
        // 代码预览区编辑会把子面板草稿顺手落盘，「关设置页不保存则丢弃」失效。
        // 非法 JSON / 元素不存在（面板没打开）⇒ 回落到已生效的缓存值：一次坏草稿绝不能
        // 把已存配置抹成默认（面板关闭时采集链仍会被走到）。
        // `typeof` 守卫：本函数会被单测按**函数体切片**求值（只带被切出的几个兄弟函数），
        // 归一转发缺席时原样用缓存值——否则 `_normToolVisibility is not defined` 会抛掉整个用例
        //（本仓既有手法，见上方 MODES 的 `typeof window` 守卫注释）。
        // 生产面引擎恒装配（scripts.manifest.js 里 app/main.js 先装、engine/settings.js 后装；
        // 本函数运行时惰性取 window.AEEngine.settings，故装载先后不影响归一，但顶层/早期调用会取不到）。
        toolVisibility: (function () {
            var norm = (typeof _normToolVisibility === 'function')
                ? _normToolVisibility
                : function (v) { return v; };
            var fb = norm(cs.toolVisibility);
            if (!_includeDrafts) return fb;
            var tvEl = document.getElementById('toolVisibilityInput');
            if (!tvEl || tvEl.value === '' || tvEl.value === undefined || tvEl.value === null) return fb;
            var parsed = null;
            try { parsed = JSON.parse(tvEl.value); } catch (_) { return fb; }
            return norm(parsed);
        })(),
        permissionMode: (function () {
            var strip = el('permissionModeStrip');
            var levels = ['auto', 'balanced', 'conservative'];
            if (!strip) return cs.permissionMode || 'balanced';
            var transform = strip.style.transform || '';
            var match = transform.match(/-?\d+/);
            var idx = match ? Math.round(-parseInt(match[0], 10) / 18) : 1;
            return levels[idx] || 'balanced';
        })()
    };
    // 团队段（三条 lane 的模型/平台/思考等级 + 子 Agent 闸）由设置面板的团队段采集
    //（app/settings.js 的 readTeamFromUI：它同时是**唯一**知道那些字段 id 的地方）。
    // 基线显式传 cs.team（已生效的权威 team 段）——**不能让采集端自己去问
    // AEAgentTeam.settings.snapshot()**：那条路经引擎 provider 回到本函数，会形成无界递归
    //（真机卡死根因，详见 app/settings.js 的 _teamBaseline 注释）。
    // 面板没打开 / 装配面缺席时返回 null ⇒ **不带 team 键**：settings 的合并是浅合并，
    // 带一个 null 会把已存的团队段覆盖掉（团队被静默关闭）。
    var teamFromUi = null;
    try {
        var sp = window.AEAgentApp && window.AEAgentApp.settings;
        if (sp && typeof sp.readTeamFromUI === 'function') teamFromUi = sp.readTeamFromUI(cs.team || null);
    } catch (_) { teamFromUi = null; }
    if (teamFromUi) out.team = teamFromUi;
    return out;
}

// 运行时设置视图：设置面板是纯按钮驱动表单——面板里改的值在点
// 「保存模块设置」之前**不生效**。因此引擎可见的设置只认**已保存**的那份（cachedSettings）：
// 面板打开期间的任何草稿（团队段 lane 模型/平台/思考等级、以及超时/权限/上下文上限等其它
// 字段）都不进入引擎。否则面板开着改 lane 配置，正在跑的 Agent 下一轮就按未保存的草稿发请求，
// 点取消也照样生效。
// 即时控件（工具栏「权限/思考」strip、模式旋钮、DEBUG 开关）在点击时就写 cachedSettings，
// 所以这里读到的最新值不受影响。
// 另一收益：运行时每轮会多次读设置（bootstrap/controller 共 40+ 处调用点），这里不再采集
// 设置面板 DOM（不必每次读都跑一遍 getCurrentSettingsFromUI）。
function composeRuntimeSettings(saved) {
    var out = Object.assign({}, saved || {});
    // 团队段浅拷贝一层：消费方只读（provider/resolver 都不写 team），这一步防的是未来某个
    // 消费方顺手改字段时污染 cachedSettings 里那份已保存设置。
    if (saved && saved.team) out.team = Object.assign({}, saved.team);
    else delete out.team;
    // 工具可见性同上：闸口只读（_viewCfg 不写），浅拷贝同样防未来消费方顺手改字段写穿 cachedSettings。
    if (saved && saved.toolVisibility) out.toolVisibility = Object.assign({}, saved.toolVisibility);
    else delete out.toolVisibility;
    out.runtimeMode = (saved && saved.runtimeMode) || 'script';
    return out;
}

// 将模式胶囊滑块同步到指定 runtimeMode（script/agent/shader/external/**team**）。
// 供 applySettingsToUI 回填与模式切换失败回弹共用。
// 第 5 档是**第一等档位** —— `settings.runtimeMode` 就是面板
// 档位（含 'team'），旋钮位置是它的字面投影。旧规则（第 5 档是派生档，真相源是
// `settings.team.enabled`，runtimeMode 保持原值）已废止：正是那条规则让「面板在哪个档」在会话名、
// 胶囊、工具栏、白闪四处各错一次。
// 这里仍保留 `teamOn` 作为**保险丝**：引擎侧团队态（_teamEnabled）在异步装配窗口里可能比
// cachedSettings 先落地，此时按引擎裁决更准。runtimeMode 与 team.enabled 恒一致，故它不再改变结果，
// 只在过渡窗口里防抖。
// 档位表与显示名引用 engine 的唯一来源（MODES / MODE_LABELS），与 bootstrap.syncModeButtons 同源
// ——各写一份四槽表时，团队档下会把标签写成 'Script'。
function syncRuntimeMode(mode) {
    const sw = document.getElementById('runtimeModeSwitch');
    // `typeof window` 守卫：本函数在部分单测里被按函数体切片求值（上下文无 window）。
    const _st = ((typeof window !== 'undefined' && window && window.AEEngine && window.AEEngine.settings) || null);
    const MODE_LIST = (_st && _st.MODES) || ['script', 'agent', 'shader', 'external', 'team'];
    var modeLabels = (_st && _st.MODE_LABELS)
        || { script: 'Script', agent: 'Agent', shader: 'Shader', external: AEI18n.t('外接'), team: AEI18n.t('团队') };
    var teamOn = false;
    try {
        teamOn = !!(window.AEAgentTeamUI && window.AEAgentTeamUI.isTeamModeOn && window.AEAgentTeamUI.isTeamModeOn());
    } catch (_) { teamOn = false; }
    var show = teamOn ? 'team' : String(mode || 'script');
    if (sw) {
        // CSS 通过 [data-mode-index] 属性选择器驱动滑块位置和激活态视觉
        var idx = MODE_LIST.indexOf(show);
        sw.dataset.modeIndex = String(idx < 0 ? 0 : idx);
        var label = sw.querySelector('.mode-current-label');
        // 显示名表是源文（engine/settings.js 的 MODE_LABELS）：此处按当前语言翻译一次。
        // 只在「值与档位 id 不同」时过 t()——Script/Agent/Shader 三档是同一串，无需查表。
        if (label) {
            var _lab = modeLabels[show] || show;
            label.textContent = (_lab === show) ? _lab : AEI18n.t(_lab);
        }
    }
    // 团队 UI 的模式相关显隐：团队开关与三个主 Agent 胶囊**只在 Agent
    // 模式可见**、团队开启时**隐藏模式旋钮**。判据与 DOM 写入的落点都在 teamUI（它拿得到
    // 引擎侧「团队开着吗」），这里只把模式推过去——模式切换不经过 teamUI 的任何入口。
    try {
        var teamUi = window.AEAgentTeamUI;
        if (teamUi && typeof teamUi.syncModeChrome === 'function') teamUi.syncModeChrome(show);
    } catch (_) { /* 团队 UI 缺席（未登记/加载失败）：单 Agent 路径不受影响 */ }
}

// 将设置值回填到界面控件，并触发主题与模型列表的联动刷新。
function applySettingsToUI(settings) {
    const restorePreviewDraft = (resolvedSettings) => {
        // shader 草稿恢复（独立于 script 草稿，互不干扰）
        const shaderEl = document.getElementById('shaderCodePreview');
        if (shaderEl) {
            const shaderDraft = resolvedSettings && resolvedSettings.shaderDraft ? String(resolvedSettings.shaderDraft) : '';
            if (shaderDraft) shaderEl.value = shaderDraft;
        }
        const previewEl = document.getElementById('scriptPreview');
        if (!previewEl) {
            return;
        }
        if (generatedScript && String(generatedScript).trim()) {
            return;
        }
        const draft = resolvedSettings && resolvedSettings.previewDraft ? String(resolvedSettings.previewDraft) : '';
        if (!draft) {
            return;
        }
        previewEl.value = draft;
        generatedScript = draft;
        (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})(true);
    };

    if (llmSettings && typeof llmSettings.applySettingsToUI === 'function') {
        llmSettings.applySettingsToUI({
            settings,
            clampScriptListHeight,
            scriptListUiState,
            statusState,
            applyThemeFromSettings: window.applyThemeFromSettings
        });
        syncRuntimeMode((settings && settings.runtimeMode) || 'script');
        syncDebugOnlySettingsVisibility();
        restorePreviewDraft(settings || {});
        return;
    }

    document.getElementById('skipRunConfirm').checked = !!settings.skipRunConfirm;
    document.getElementById('executionTimeoutMs').value = (settings.executionTimeoutMs || 30000) / 1000;   // UI 单位是秒
    // 回填经共享归一（10~300 秒）——磁盘遗留 600 秒的旧值显示为夹取后的 300，
    // 与落盘/引擎实际值一致，不再出现「显示 600、实际 300」
    document.getElementById('requestTimeoutMs').value = _normRequestTimeoutMs(settings.requestTimeoutMs) / 1000;   // UI 单位是秒
    {
        var _ctxEl = document.getElementById('maxContextTokens');
        var _fmt = window.AEAgentApp && window.AEAgentApp.settingsPanel && window.AEAgentApp.settingsPanel.formatTokenValue;
        if (_ctxEl) _ctxEl.value = typeof _fmt === 'function' ? _fmt(settings.maxContextTokens) : String(settings.maxContextTokens);
    }
    var _effortLevels = ['low', 'medium', 'high', 'xhigh'];
    var _effortIdx = _effortLevels.indexOf(settings.reasoningEffort);
    if (_effortIdx < 0) _effortIdx = 2;
    var _stripEl = document.getElementById('reasoningEffortStrip');
    if (_stripEl) _stripEl.style.transform = 'translateY(' + (-_effortIdx * 18) + 'px)';
    var _permLevels = ['auto', 'balanced', 'conservative'];
    var _permIdx = _permLevels.indexOf(settings.permissionMode);
    if (_permIdx < 0) _permIdx = 1;
    var _permStripEl = document.getElementById('permissionModeStrip');
    if (_permStripEl) _permStripEl.style.transform = 'translateY(' + (-_permIdx * 18) + 'px)';
    restorePreviewDraft(settings || {});
    scriptListUiState.openHeightPx = clampScriptListHeight(settings.scriptListHeight, 320);

    statusState.debugMode = !!settings.debugMode;
    const globalDebugToggle = document.getElementById('globalDebugToggleBtn');
    if (globalDebugToggle) {
        globalDebugToggle.checked = statusState.debugMode;
    }

    window.applyThemeFromSettings(settings);
    syncRuntimeMode((settings && settings.runtimeMode) || 'script');
    syncDebugOnlySettingsVisibility();
}


// 主题应用已拆至 app/themeApplier.js（window.applyThemeFromSettings 由其提供）

// 为宿主 evalScript 增加超时与异常兜底，统一回调结果格式。
// 本文件内无调用点：app/service.js（运行脚本/运行脚本文件）经全局作用域调用，
// 显式挂 window 以声明跨文件契约（经典 script 顶层函数本已是全局，此行无行为变化）。
function evalScriptWithTimeout(csInterface, script, timeoutMs, callback) {
    if (llmHostBridgeAdapter && typeof llmHostBridgeAdapter.evalScriptWithTimeout === 'function') {
        llmHostBridgeAdapter.evalScriptWithTimeout({
            csInterface,
            script,
            timeoutMs,
            callback
        });
        return;
    }

    let finished = false;

    const timer = setTimeout(() => {
        if (finished) {
            return;
        }
        finished = true;
        callback({ ok: false, result: '', error: `EVAL_TIMEOUT_${timeoutMs}` });
    }, timeoutMs);

    try {
        csInterface.evalScript(script, (result) => {
            if (finished) {
                return;
            }
            finished = true;
            clearTimeout(timer);
            callback({ ok: true, result: typeof result === 'string' ? result : '', error: null });
        });
    } catch (e) {
        if (finished) {
            return;
        }
        finished = true;
        clearTimeout(timer);
        callback({ ok: false, result: '', error: `EVAL_EXCEPTION:${e.toString()}` });
    }
}
window.evalScriptWithTimeout = evalScriptWithTimeout;

let _enforcePreviewFillHeightPending = false;
let _enforcePreviewFillHeightRafId = 0;
let _enforcePreviewFillHeightLastTarget = '';

function enforcePreviewFillHeight() {
    if (_enforcePreviewFillHeightPending) return;
    _enforcePreviewFillHeightPending = true;

    if (_enforcePreviewFillHeightRafId) {
        cancelRafTick(_enforcePreviewFillHeightRafId);
    }
    _enforcePreviewFillHeightRafId = rafTick(() => {
        _enforcePreviewFillHeightPending = false;
        _enforcePreviewFillHeightRafId = 0;
        _doEnforcePreviewFillHeight();
    });
}

function _doEnforcePreviewFillHeight() {
    const llmPanel = document.getElementById('agentPanel');
    if (!llmPanel || llmPanel.classList.contains('hidden')) {
        return;
    }
    const panelBody = llmPanel.querySelector('.panel .panel-body');
    const previewWrap = document.getElementById('scriptPreviewWrap');
    if (!panelBody || !previewWrap) {
        return;
    }

    const previewRect = previewWrap.getBoundingClientRect();
    const moduleView = document.getElementById('moduleView');
    const moduleViewRect = moduleView ? moduleView.getBoundingClientRect() : null;
    // 以模块可视区为基准，确保只填满扩展窗口内的剩余区域。
    const viewportBottom = moduleViewRect ? moduleViewRect.bottom : window.innerHeight;
    const safeBottomGap = 12;
    const available = Math.floor(viewportBottom - previewRect.top - safeBottomGap);
    const target = Math.max(120, available);
    const newHeight = `${target}px`;

    // 尺寸没变则跳过粒子相关操作
    if (_enforcePreviewFillHeightLastTarget === newHeight) return;
    _enforcePreviewFillHeightLastTarget = newHeight;

    previewWrap.style.height = newHeight;
    previewWrap.style.maxHeight = newHeight;

    if (initParticleCanvasStage()) {
        const resized = resizeParticleCanvas();
        if (resized && particleEngineState.running) {
            renderParticleFrame(Date.now());
        }
        updatePreviewParticleBrightness();
    }
    if (!particleEngineState.running && !particleEngineState.startScheduled && llmModuleMounted && !window.AE_ExtP_LowPerfMode && !_enterAnimating) {
        particleEngineState.startScheduled = true;
        particleEngineState.startTimerId = setTimeout(() => {
            particleEngineState.startTimerId = 0;
            if (!llmModuleMounted) return;
            if (window.AE_ExtP_LowPerfMode) return;
            startParticleEngine();
        }, 40);
    }
}

    // lastHighlightedCode / prismLoaded / prismLoadAttempts → service.js

function applyScriptListToggleUi() {
    const shell = document.getElementById('scriptListDrawer');
    const toggle = document.getElementById('scriptListToggle');
    if (!shell || !toggle) {
        return;
    }

    if (scriptListUiState.expanded) {
        shell.classList.remove('collapsed');
        toggle.textContent = '◀';
        toggle.setAttribute('data-arrow', '◀');
        toggle.setAttribute('aria-expanded', 'true');
    } else {
        shell.classList.add('collapsed');
        toggle.textContent = '▶';
        toggle.setAttribute('data-arrow', '▶');
        toggle.setAttribute('aria-expanded', 'false');
    }
    applyDrawerWidths();
}

function toggleScriptList(expanded, skipAnimation) {
    const shell = document.getElementById('scriptListDrawer');
    const toggle = document.getElementById('scriptListToggle');
    if (!shell || !toggle) {
        return;
    }

    if (typeof expanded === 'boolean') {
        scriptListUiState.expanded = expanded;
    } else {
        scriptListUiState.expanded = !scriptListUiState.expanded;
    }

    void skipAnimation;
    applyScriptListToggleUi();

    setTimeout(enforcePreviewFillHeight, 28);
    setTimeout(enforcePreviewFillHeight, 120);
}

function togglePreviewDrawer(expanded) {
    const shell = document.getElementById('scriptPreviewDrawer');
    const toggle = document.getElementById('scriptPreviewToggle');
    if (!shell || !toggle) {
        return;
    }
    const next = typeof expanded === 'boolean'
        ? expanded
        : shell.classList.contains('collapsed');
    shell.classList.toggle('collapsed', !next);
    toggle.textContent = next ? '▶' : '◀';
    toggle.setAttribute('data-arrow', next ? '▶' : '◀');
    toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
    applyDrawerWidths();
    if (!next) {
        // 收起时移除焦点：焦点不应留在折叠抽屉内（键盘输入会落入不可见区域）。
        // 选区不主动清除（"秒级掉帧"源于 a11y 树序列化，已由 manifest
        // --disable-renderer-accessibility 根治），保留选区便于重新展开后继续操作。
        const active = document.activeElement;
        if (active && shell.contains(active) && active !== document.body) {
            active.blur();
        }
    }
}

function clampDrawerWidth(value) {
    const maxByViewport = Math.max(drawerUiState.minWidthPx, Math.floor((window.innerWidth || 1200) * 0.6));
    const max = Math.min(drawerUiState.maxWidthPx, maxByViewport);
    const n = Number(value);
    if (!Number.isFinite(n)) return drawerUiState.minWidthPx;
    return Math.max(drawerUiState.minWidthPx, Math.min(max, Math.round(n)));
}

function applyDrawerWidths() {
    const leftShell = document.getElementById('scriptListDrawer');
    const rightShell = document.getElementById('scriptPreviewDrawer');
    const leftBody = document.querySelector('#scriptListDrawer .drawer-body');
    const rightBody = document.querySelector('#scriptPreviewDrawer .drawer-body');
    if (leftBody) {
        const w = clampDrawerWidth(drawerUiState.leftWidthPx);
        drawerUiState.leftWidthPx = w;
        if (leftShell) {
            leftShell.style.setProperty('--drawer-width', `${w}px`);
        }
        leftBody.style.width = `${w}px`;
        leftBody.style.minWidth = `${w}px`;
        leftBody.style.maxWidth = `${w}px`;
    }
    if (rightBody) {
        const w = clampDrawerWidth(drawerUiState.rightWidthPx);
        drawerUiState.rightWidthPx = w;
        if (rightShell) {
            rightShell.style.setProperty('--drawer-width', `${w}px`);
        }
        rightBody.style.width = `${w}px`;
        rightBody.style.minWidth = `${w}px`;
        rightBody.style.maxWidth = `${w}px`;
    }
}

    // loadPrismJs / cleanupTempFile / normalizeScriptNameByPromptInput → service.js



// 模态对话框已拆至 app/modals.js（window.showConfirm/showPrompt 由其提供）

function reportParticleDiagnostics(reason) {
    if (llmParticles && typeof llmParticles.reportParticleDiagnostics === 'function') {
        return llmParticles.reportParticleDiagnostics({
            state: particleEngineState,
            reason,
            showStatus
        });
    }

    return '';
}

// 初始化粒子画布上下文与交互容器引用，作为引擎启动前置条件。
function initParticleCanvasStage() {
    if (llmParticles && typeof llmParticles.initParticleCanvasStage === 'function') {
        return llmParticles.initParticleCanvasStage({
            state: particleEngineState,
            document
        });
    }

    return false;
}

// 画布尺寸变化时重设像素比与粒子分布
function resizeParticleCanvas(forceReset = false) {
    if (llmParticles && typeof llmParticles.resizeParticleCanvas === 'function') {
        return llmParticles.resizeParticleCanvas({
            state: particleEngineState,
            forceReset,
            window
        });
    }

    return false;
}

// 粒子渲染主循环：委托粒子子模块处理。
function renderParticleFrame(ts) {
    if (llmParticles && typeof llmParticles.renderParticleFrame === 'function') {
        llmParticles.renderParticleFrame({
            state: particleEngineState,
            window,
            ts,
            rafTick,
            cancelRafTick,
            showStatus,
            reportParticleDiagnostics
        });
    }
}

function startParticleEngine() {
    if (llmParticles && typeof llmParticles.startParticleEngine === 'function') {
        particleEngineState.startScheduled = false;
        if (particleEngineState.startTimerId) {
            clearTimeout(particleEngineState.startTimerId);
            particleEngineState.startTimerId = 0;
        }
        llmParticles.startParticleEngine({
            state: particleEngineState,
            window,
            rafTick,
            cancelRafTick,
            showStatus,
            reportParticleDiagnostics
        });
        return;
    }

    showStatus(AEI18n.t('粒子模块未就绪'), 'error', { autoHideMs: 2000 });
}

function stopParticleEngine() {
    particleEngineState.startScheduled = false;
    if (particleEngineState.startTimerId) {
        clearTimeout(particleEngineState.startTimerId);
        particleEngineState.startTimerId = 0;
    }
    if (llmParticles && typeof llmParticles.stopParticleEngine === 'function') {
        llmParticles.stopParticleEngine({
            state: particleEngineState,
            cancelRafTick
        });
        return;
    }

    showStatus(AEI18n.t('粒子模块未就绪'), 'error', { autoHideMs: 2000 });
}



// 应用调试模式：面板启动按持久化值应用；全局设置保存后由主壳经 AEAgent.setDebugMode 调用。
// 拨动全局设置里的那个开关本身不触发这里——它是表单字段，改动只在点「保存全局设置」后生效
//（与同弹窗的数据目录/热盒快捷键/低性能模式一致）。此函数只改运行时态，不写盘、不弹提示。
function applyDebugMode(enabled) {
    statusState.debugMode = !!enabled;
    // 内存缓存跟随：模块设置保存路径会用 cachedSettings.debugMode 回写 statusState，
    // 不跟随会让「全局里开了调试 → 存一次模块设置 → 调试态被旧值顶掉」
    cachedSettings = { ...cachedSettings, debugMode: statusState.debugMode };

    const globalDebugToggle = document.getElementById('globalDebugToggleBtn');
    if (globalDebugToggle) {
        globalDebugToggle.checked = statusState.debugMode;
    }

    if (statusState.debugMode) {
        if (window.__aeDebugLogger) window.__aeDebugLogger.enable();
    } else {
        if (window.__aeDebugLogger) window.__aeDebugLogger.disable();
    }

    syncDebugOnlySettingsVisibility();

    var runBtn = document.querySelector('#runBtn');
    var runBtnRow = runBtn && runBtn.closest('.btn-row');
    let probeBtn = document.getElementById('particleProbeBtn');
    let prismBtn = document.getElementById('prismCheckBtn');
    const prismStatusEl = document.getElementById('prismStatus');

    if (statusState.debugMode) {
        if (prismStatusEl) { prismStatusEl.style.display = ''; }
        if (!probeBtn && runBtnRow) {
            probeBtn = document.createElement('button');
            probeBtn.id = 'particleProbeBtn';
            probeBtn.className = 'btn';
            probeBtn.textContent = AEI18n.t('测试待发');
            runBtnRow.appendChild(probeBtn);
            probeBtn.addEventListener('click', function () {
                if (window.AEEngine && window.AEEngine.bridge && typeof window.AEEngine.bridge.debugPreviewInject === 'function') {
                    window.AEEngine.bridge.debugPreviewInject();
                } else {
                    showStatus(AEI18n.t('待发送框调试：引擎未就绪'), 'error', { autoHideMs: 2000 });
                }
            });

            prismBtn = document.createElement('button');
            prismBtn.id = 'prismCheckBtn';
            prismBtn.className = 'btn';
            prismBtn.textContent = AEI18n.t('测试弹窗');
            runBtnRow.appendChild(prismBtn);
            prismBtn.addEventListener('click', async () => {
                const result = await showConfirm(AEI18n.t('测试确认'), AEI18n.t('这是一个测试弹窗，确认是否正常显示？'));
                showStatus(AEI18n.t('弹窗测试结果: ') + result, result ? 'success' : 'info', { showAnyway: true });
            });
        }
    } else {
        if (prismStatusEl) { prismStatusEl.style.display = 'none'; }
        if (probeBtn) {
            probeBtn.remove();
        }
        if (prismBtn) {
            prismBtn.remove();
        }
    }

    // 引擎侧：已渲染的消息要按新调试态重渲染（工具卡片「查看详情」按 debug 门控）。
    // 引擎只登记「待重建」，列表不可见/有活元素时延后消费（见 controller/chatViewHelpers）。
    if (window.AEEngine && window.AEEngine.bridge && typeof window.AEEngine.bridge.setDebugMode === 'function') {
        window.AEEngine.bridge.setDebugMode(statusState.debugMode);
    }
}

// 给模块内按钮统一挂载按压反馈动画
function updatePreviewParticleBrightness() {
    // Script mode: preview brightness
    var preview = document.getElementById('scriptPreview');
    var panel = document.querySelector('.app') || document.body;
    if (preview && panel) {
        var val = (preview.value || '').trim();
        var hasContent = val.length > 30;
        panel.style.setProperty('--preview-brightness', hasContent ? '1.08' : '1');
    }

    // Agent mode: dim particles when input has text or file chips
    var inputWrap = document.getElementById('aeAgentInputWrap');
    if (inputWrap) {
        var agentInput = document.getElementById('aeAgentInput');
        var chips = document.getElementById('aeAgentFileChips');
        var hasText = agentInput && (agentInput.value || '').trim().length > 0;
        var hasChips = chips && chips.children.length > 0;
        if (hasText || hasChips) {
            inputWrap.classList.add('has-content');
        } else {
            inputWrap.classList.remove('has-content');
        }
    }
}

    // highlightCode / syncScroll / renumberFileChips / updatePreviewScriptFromAgent / decodeHostResult → service.js
    // __hl_dummy_removed__ → cleaned up
    // __hl_dummy__ → service.js



    // syncScroll → service.js





    // renumberFileChips → service.js

// 监听提示词与面板尺寸变化，确保预览区填充高度与粒子画布尺寸同步。


    // updatePreviewScriptFromAgent → service.js



    // decodeHostResult → service.js



    // populatePlatformOptions / refreshModelOptions / animateSelectReveal / PLATFORM_LIST → settings.js
    // renumberFileChips / updatePreviewScriptFromAgent / decodeHostResult / cleanupTempFile → service.js






function bindButtonAnimations() {
    const clickable = document.querySelectorAll('.btn, .icon-btn');
    clickable.forEach((btn) => {
        if (btn.classList.contains('run') || btn.id === 'generateBtn' || btn.id === 'saveBtn' || btn.id === 'openSettingsBtn') {
            return;
        }
        btn.addEventListener('click', () => animatePress(btn));
    });

    const settingsBtn = document.getElementById('openSettingsBtn');
    const generateBtn = document.getElementById('generateBtn');
    const saveBtn = document.getElementById('saveBtn');

    const bindSettingsLikeAnimation = (btn) => {
        if (!btn || typeof window.anime !== 'function') {
            return;
        }
        btn.addEventListener('click', () => {
            window.anime({
                targets: btn,
                scale: [1, 0.95, 1.02, 1],
                duration: 300,
                easing: 'easeOutCubic'
            });
        });
    };

    bindSettingsLikeAnimation(settingsBtn);
    bindSettingsLikeAnimation(generateBtn);
    bindSettingsLikeAnimation(saveBtn);
}

// 图片 Lightbox 已拆至 app/imageLightbox.js（window._openImageLightbox 由其提供）

// 拖入项 → 磁盘路径。CEP 的 dataTransfer.files 对每个拖入项都给磁盘绝对路径
//（File.path 补丁，文件夹同样占一条）；entry.fullPath 是**拖放树内的虚拟路径**
//（拖 F:\…\图\角色 得 "/角色"），不是磁盘路径。文件夹取 entry.fullPath 会让引用块只剩
// 最后一段（「文件夹1: \角色 (角色)」），LLM 与工具拿到不存在的路径，故文件夹必须用
// dt.files 的 path，取不到就返回 null 由调用方提示放弃。
// 取值优先 dt.items / dt.files 下标对齐（两者同序），名字不符时按名字兜底（顺序漂移的环境）。
function _resolveDropEntry(entry, idx, fileList, isFolder) {
    var files = fileList || [];
    var want = (entry && entry.name) ? String(entry.name).toLowerCase() : '';
    function baseName(p) {
        var s = String(p == null ? '' : p).replace(/[\\/]+$/, '');
        var k = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
        return k >= 0 ? s.slice(k + 1) : s;
    }
    function hit(f) {
        return !!(f && f.path) && (!want || baseName(f.path).toLowerCase() === want);
    }
    var pick = hit(files[idx]) ? files[idx] : null;
    if (!pick && want) {
        for (var j = 0; j < files.length; j++) {
            if (hit(files[j])) { pick = files[j]; break; }
        }
    }
    // 单文件：保留「无 path 时退回名字」的旧口径；文件夹没有 path 就不可用（虚拟路径不能顶替）
    if (!pick && !isFolder) pick = files[idx] || null;
    if (!pick) return null;
    var path = pick.path ? String(pick.path) : (isFolder ? '' : (pick.name || ''));
    if (isFolder && !path) return null;
    return {
        path: path,
        name: pick.name || (entry && entry.name) || baseName(path),
        isFolder: !!isFolder,
        file: pick
    };
}

function bindEvents() {
    try {
    // saveBtn/runBtn → service.js bind() 处理

    const scriptListToggleBtn = document.getElementById('scriptListToggle');
    const previewToggleBtn = document.getElementById('scriptPreviewToggle');
    const runtimeModeSwitch = document.getElementById('runtimeModeSwitch');
    const agentInput = document.getElementById('aeAgentInput');
    const agentSendBtn = document.getElementById('aeAgentSendBtn');
    // 发送函数在下方 if(agentInput) 块内赋值，提升到本层作用域供发送按钮 click 使用
    let doSendAgentMessage = null;

    // 斜杠命令自动补全已拆至 app/bindEvents/slashAutocomplete.js
    // renderCodeChipOverlay 用惰性包装：_renderCodeChipOverlay 在下方 if(scriptPreviewEl) 块内声明，
    // 用运行时 typeof 查找语义（sloppy-mode Annex B 块级函数提升），调用时才解析。
    const slash = window.AEAgentApp.createSlashAutocomplete({
        agentInput,
        renderCodeChipOverlay: function () {
            if (typeof _renderCodeChipOverlay === 'function') _renderCodeChipOverlay();
        },
        updatePreviewParticleBrightness
    });

    // @ 文件引用补全（app/bindEvents/fileMentions.js）：候选 = 当前输入区的附件 chip（还没发出去的文件）。
    // 插入的是文件 chip token（语法见 utils/chipTokens.js 的 file 分支），故原子编辑/删除/发送解析
    // 与图层引用走同一套机制。两个回调都用惰性包装：_renderCodeChipOverlay / _insertChipToken
    // 在下方 if(scriptPreviewEl) 块内声明，沿用与 slash 同款的运行时解析语义。
    const fileMentions = window.AEAgentApp.createFileMentions({
        agentInput,
        listFiles: function () { return _fileChipEntries(); },
        insertToken: function (name, range) {
            const ct = _chipTokens();
            const built = ct ? ct.buildFileToken(name) : null;
            if (!built) {
                showStatus(AEI18n.t('该文件名无法引用（含 token 定界符/换行等特殊字符）: ') + name, 'warn');
                return false;
            }
            return _insertChipToken(built.token, range);
        }
    });

    // 文档解析/图片落盘助手已拆至 app/bindEvents/chatDocParse.js。
    // 解构放在 bindEvents 顶层，以保持 drag/drop 与文件选择器处调用不变。

    const { PARSEABLE_DOC_EXT, _saveImageToTemp } =
        (window.AEAgentApp && window.AEAgentApp.chatDocParse) || {};

    const bindDrawerToggleInteraction = (toggleEl, onToggle, onDragDelta) => {
        if (!toggleEl) return;
        let down = false;
        let dragged = false;
        let lastX = 0;
        let startX = 0;
        const DRAG_THRESHOLD = 3;
        const onMove = (e) => {
            if (!down) return;
            const dx = e.clientX - lastX;
            if (!dragged && Math.abs(e.clientX - startX) >= DRAG_THRESHOLD) {
                dragged = true;
            }
            if (dragged) {
                onDragDelta(dx);
                applyDrawerWidths();
                setTimeout(enforcePreviewFillHeight, 0);
            }
            lastX = e.clientX;
        };
        const onUp = () => {
            if (!down) return;
            const wasDragged = dragged;
            down = false;
            dragged = false;
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
            if (!wasDragged) {
                onToggle();
                setTimeout(enforcePreviewFillHeight, 0);
            }
        };
        toggleEl.addEventListener('pointerdown', (e) => {
            down = true;
            dragged = false;
            lastX = e.clientX;
            startX = e.clientX;
            toggleEl.setPointerCapture && toggleEl.setPointerCapture(e.pointerId);
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
    };

    bindDrawerToggleInteraction(scriptListToggleBtn, () => toggleScriptList(), (dx) => {
        drawerUiState.leftWidthPx = clampDrawerWidth(drawerUiState.leftWidthPx + dx);
    });

    bindDrawerToggleInteraction(previewToggleBtn, () => togglePreviewDrawer(), (dx) => {
        drawerUiState.rightWidthPx = clampDrawerWidth(drawerUiState.rightWidthPx - dx);
    });

    const refreshScriptListBtn = document.getElementById('refreshScriptListBtn');
    if (refreshScriptListBtn) {
        refreshScriptListBtn.addEventListener('click', () => {
            refreshList();
            setTimeout(enforcePreviewFillHeight, 0);
        });
    }
    const closeSettingsBtn = document.getElementById('closeSettingsBtn');
    if (closeSettingsBtn) {
        closeSettingsBtn.addEventListener('click', function () {
            (window.AEAgentApp && window.AEAgentApp.settingsPanel && typeof window.AEAgentApp.settingsPanel.close === 'function' ? window.AEAgentApp.settingsPanel.close : function(){})();
        });
    }
    // 保存/关于/浏览按钮现由 openSettingsModal 动态注入，不再绑定静态 ID
    // #globalDebugToggleBtn 不在此绑定：拨动开关不产生任何运行时副作用（它只是全局设置
    // 弹窗里的表单字段），调试模式在点「保存全局设置」时由主壳调 AEAgent.setDebugMode 应用。

    // 面板大小调整的昂贵副作用统一节流到单帧 rAF。
    // 拖拽面板/调整窗口会连续触发多次 resize，若每次同步重建粒子画布
    // （canvas.width 重新分配 GPU 缓冲）并与流式输出抢占主线程，会造成明显卡顿。
    // 合并后每帧最多执行一次，且回调内从 getBoundingClientRect 实时读取尺寸，
    // 即使中间多次 resize 被命中合并，仍取到该帧最新尺寸，不残留旧值。
    var _resizeFrameLoading = false;
    window.addEventListener('resize', () => {
        if (_resizeFrameLoading) return;
        _resizeFrameLoading = true;
        rafTick(() => {
            _resizeFrameLoading = false;
            if (particleEngineState.running) {
                resizeParticleCanvas();
            }
            applyDrawerWidths();
            enforcePreviewFillHeight();
        });
    });

    // resize 期间锁定消息列表宽度：长上下文会话里消息列表是全量重排的大头
    // （实测单次 viewport 变化 5.7k 元素全量重排 460ms；连续拖拽逐帧重排全部
    // 消息文本换行 → 任务积压表现为数秒"冻结"，且空会话 DOM 少故不卡）。
    // 锁 px 宽度后子树布局结果被缓存复用，逐帧只剩面板级轻量重排；
    // ── 团队模式：消息列表的「按 lane 解析」工具 ────────────────────────────
    // 单 Agent 路径只有一份 `#aeAgentMessageList`；团队模式三条 lane 各一份。宽度锁对**全部 lane**
    // 生效，拖拽改高与滚动到底针对**当前 lane**。
    // 解析不到任何 lane 容器时回退单例：既有测试的 document mock 只认 `aeAgentMessageList`，
    // 没有这层回退它们会静默跳过整段接线（那正是"改动看起来生效、旧测试仍绿"的假安全）。
    function _teamListIds() {
        if (window.AEAgentTeam && window.AEAgentTeam.lanes && typeof window.AEAgentTeam.lanes.listMessageIds === 'function') {
            return window.AEAgentTeam.lanes.listMessageIds();
        }
        return ['aeAgentMessageList'];
    }
    // 单 Agent 列表**始终**纳入：team/*.js 无条件先于 engine/bootstrap.js 装载，
    // 「解析得到 lane 列表」不等于「当前跑团队模式」。单 Agent 路径的
    // 消息渲染在 #aeAgentMessageList，漏掉它会让宽度锁 / 拖拽迁移清理 /「回到底部」按钮
    // 三处接线在单 Agent 模式下整体静默失效（滚动按钮永不 is-visible）。
    function _existingMessageLists() {
        const out = [];
        const seen = {};
        const single = document.getElementById('aeAgentMessageList');
        if (single) { out.push(single); seen[single.id] = 1; }
        _teamListIds().forEach((id) => {
            if (seen[id]) return;
            const el = document.getElementById(id);
            if (el) { out.push(el); seen[id] = 1; }
        });
        return out;
    }
    function _currentMessageList() {
        try {
            const v = (window.AEEngine && typeof window.AEEngine.getView === 'function') ? window.AEEngine.getView() : null;
            const id = (v && typeof v.getDom === 'function') ? ((v.getDom() || {}).listId || '') : '';
            if (id) {
                const el = document.getElementById(id);
                if (el) return el;
            }
        } catch (_) { /* 取不到就回退单例 */ }
        return document.getElementById('aeAgentMessageList');
    }

    // 拖拽停止 150ms 后解锁恢复自适应宽度。必须同步执行：进 rAF 合并就晚了，
    // 中间已发生一次全量布局。与上方 rAF 合并监听器职责不同，独立存在。
    // 注：拖拽中宽度与视口有短暂偏差（松手后对齐），感知影响小，不做渐进跟随。
    var _listWidthLockTimer = 0;
    window.addEventListener('resize', () => {
        const lists = _existingMessageLists();
        if (!lists.length) return;
        lists.forEach((listEl) => {
            if (!listEl.style.width) {
                listEl.style.width = listEl.getBoundingClientRect().width + 'px';
            }
        });
        clearTimeout(_listWidthLockTimer);
        _listWidthLockTimer = setTimeout(function () {
            lists.forEach((listEl) => { listEl.style.width = ''; });
        }, 150);
    });

    // 运行模式三段开关已拆至 app/bindEvents/runtimeModeSwitch.js
    window.AEAgentApp.createRuntimeModeSwitch({
        getCachedSettings: function () { return cachedSettings; },
        applySettingsToUI,
        refreshList,
        syncRuntimeMode,
        getShaderUI
    }).bind(runtimeModeSwitch);

    // 图片硬限制：单次输入最多 10 张图片 chip（与 visionProxy.js MAX_PROXY_IMAGES 一致）。
    // 已达上限时拖入/粘贴/文件选择器三入口直接拒绝追加并提示。
    // 按 .ae-agent-file-chip-image 计数（class 在 chip 同步 append 时已带上，计数即时准确）。
    var MAX_IMAGE_CHIPS = 10;
    function _imageChipCount() {
        var chipsBox = document.getElementById('aeAgentFileChips');
        if (!chipsBox) return 0;
        return chipsBox.querySelectorAll('.ae-agent-file-chip-image').length;
    }

    if (agentInput) {
        agentInput.addEventListener('input', function () {
            updatePreviewParticleBrightness();
            // 两个补全弹层互斥（都在输入框上沿同一位置弹出）：@ 文件引用优先——它是光标处的具体意图；
            // 它开着时让 / 命令列表收起来（handleSlashInput 在文本不以 / 开头时本就会自己收）
            if (fileMentions.checkInput()) {
                slash.hideAutocomplete();
            } else {
                slash.handleSlashInput();
            }
            // 执行中输入框有字变化→按钮在发送/停止间切换
            var bridge = getAgentBridge();
            if (bridge && typeof bridge.isBusy === 'function' && bridge.isBusy()) {
                var _aeC = window.AEEngine && typeof window.AEEngine.getController === 'function' && window.AEEngine.getController();
                if (_aeC && typeof _aeC.syncView === 'function') {
                    _aeC.syncView();
                }
            }
        });
        agentInput.addEventListener('focus', updatePreviewParticleBrightness);
        // blur 延迟隐藏由两个补全模块各自管理定时器，避免点击「/ 命令」按钮时旧定时器盖掉刚显示的列表
        agentInput.addEventListener('blur', function () {
            updatePreviewParticleBrightness();
            slash.scheduleHide(200);
            fileMentions.scheduleHide(200);
        });

        // 清空输入框并保留可撤销历史（execCommand 全选删除；不可用时回退直接清空）
        function _clearAgentInputWithUndo() {
            agentInput.focus();
            try {
                agentInput.setSelectionRange(0, agentInput.value.length);
                if (document.execCommand('insertText', false, '')) return true;
            } catch (_) {}
            agentInput.value = '';
            return false;
        }

        doSendAgentMessage = async function () {
            var text = agentInput.value.trim();
            var _sendChips = document.getElementById('aeAgentFileChips');
            var _hasSendFiles = !!(_sendChips && _sendChips.children.length);
            if (!text && !_hasSendFiles) return;

            try {

            var bridge = getAgentBridge();
            if (!bridge || typeof bridge.submitUserInput !== 'function') {
                showStatus(AEI18n.t('Agent 尚未就绪，请稍后再试'), 'warn');
                console.warn('[AEAgent] doSendAgentMessage: bridge 不可用');
                return;
            }
            var slashCmds = window.AEEngine && window.AEEngine.slashCommands;
            if (text.charAt(0) === '/' && slashCmds) {
                var ctrl = window.AEEngine && typeof window.AEEngine.getController === 'function' && window.AEEngine.getController();
                var processed = slashCmds.execute(text, ctrl);
                if (processed === null) {
                    _clearAgentInputWithUndo();
                    agentInput.focus();
                    showStatus(AEI18n.t('请输入需求描述，例如：/plan 创建一个粒子效果'), 'warn');
                    return;
                }
                if (processed && typeof processed === 'object' && processed._silent) {
                    _clearAgentInputWithUndo();
                    agentInput.focus();
                    return;
                }
                agentInput.value = processed;
            }

            var chips = document.getElementById('aeAgentFileChips');
            // 图片 chip 的 base64 尚在异步读取（上传按钮路径，chip 带
            // data-image-loading）时阻止发送——此时发送该图不在任何附件集合里，
            // 消息发出即静默丢图且 clearInput 后无法找回；等读取完成再发。
            if (chips && chips.children.length) {
                for (var _li = 0; _li < chips.children.length; _li++) {
                    if (chips.children[_li].getAttribute
                        && chips.children[_li].getAttribute('data-image-loading')) {
                        showStatus(AEI18n.t('图片正在读取，请稍候再发送'), 'warn');
                        agentInput.focus();
                        return;
                    }
                }
            }
            var imageDataUrls = [];
            var imageTempPaths = [];
            var videoPaths = [];
            var fileRefs = [];
            var lines = ['[引用文件]'];
            if (chips && chips.children.length && window.AEEngine) {
                for (var ci = 0; ci < chips.children.length; ci++) {
                    var chip = chips.children[ci];
                    var label = (chip.querySelector('.ae-agent-file-chip-label') || {}).textContent || '';
                    var path = chip.getAttribute('data-path') || '';
                    var name = chip.getAttribute('data-name') || '';
                    var dataUrl = chip.getAttribute('data-image-dataurl');
                    lines.push(label + ': ' + path + ' (' + name + ')');
                    if (dataUrl) {
                        imageDataUrls.push(dataUrl);
                        var tp = chip.getAttribute('data-image-temppath');
                        if (!tp) { tp = _saveImageToTemp(dataUrl, name); if (tp) chip.setAttribute('data-image-temppath', tp); }
                        if (tp) imageTempPaths.push(tp);
                    }
                    // 视频文件：收集路径供聊天框预览（相对路径转绝对，与 read_video 一致）
                    if (chip.getAttribute('data-type') !== 'folder' && /\.(mp4|mov|webm|m4v|mkv)$/i.test(name)) {
                        var vPath = path;
                        if (vPath && vPath.indexOf('data:') !== 0 && !/^[a-zA-Z]:[\\/]/.test(vPath)) {
                            var _vdir = (window.AEShared && typeof window.AEShared.getDataDir === 'function')
                                ? window.AEShared.getDataDir().dir : '';
                            if (_vdir) vPath = _vdir.replace(/\\+$/, '') + '\\' + vPath.replace(/^[\\/]+/, '');
                        }
                        videoPaths.push(vPath);
                    }
                    // 非图片/视频引用（文档 + 文件夹）：收集为聊天框引用标签（图片/视频已有缩略图/预览）
                    var _isFolderRef = chip.getAttribute('data-type') === 'folder';
                    var _isVideoRef = !_isFolderRef && /\.(mp4|mov|webm|m4v|mkv)$/i.test(name);
                    var _isImageRef = !_isFolderRef && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(name);
                    if (!_isImageRef && !_isVideoRef) {
                        fileRefs.push({ name: name, path: path, isFolder: _isFolderRef });
                    }
                }
            }
            // 组装 pending 交接字段（store.set 为整体覆盖，须一次性 set；file 字段有 chips 时填充）
            var _pendingFilePayload = null;   // file 5 字段：有文件 chips 时填充
            if (chips && chips.children.length) {
                _pendingFilePayload = {
                    fileContext: lines.join('\n'),
                    imageDataUrls: imageDataUrls.length > 0 ? imageDataUrls : null,
                    imageTempPaths: imageTempPaths.length > 0 ? imageTempPaths : null,
                    videoPaths: videoPaths.length > 0 ? videoPaths : null,
                    fileRefs: fileRefs.length > 0 ? fileRefs : null
                };
            }
            // 团队模式：pending 输入按 lane 分槽，写入端必须带**当前 lane**
            // ——否则本条 lane 的附件落进缺省槽，被别条 lane 的 consume() 破坏性取走（分槽的意义就在这一处）。
            // **只认一条真相源**：`AEEngine.getCurrentLaneId()`（orchestrator 的当前 lane；团队关闭/
            // 未装配 ⇒ `''`）。不设回落的依据：两条回退路径各自不成立——
            // ①`AEAgentTeam.orchestrator` 在 client/ 全仓无赋值、orchestrator 公开面也没有
            // `getCurrentLaneId` ⇒ 死分支；②「第一个未 hidden 的 lane 容器」与读取端
            // （`inputDispatch` 的 `controller.getLaneId()`）**是两个真相源**，显隐落地后就会分叉
            // ——写入端给 `'director'`、读取端仍 `''` ⇒ `consume('')` 得 null ⇒ 附件静默丢失
            //（只拖文件不打字时更是「点发送毫无反应」）。两个真相源里必有一个是错的，故只留一条。
            var _pendingLaneId = (function () {
                var E = window.AEEngine || {};
                if (typeof E.getCurrentLaneId === 'function') {
                    var v = E.getCurrentLaneId();
                    if (typeof v === 'string' && v) return v;
                }
                return '';
            })();
            if (window.AEEngine && window.AEEngine.pendingInput) {
                var _raw = agentInput.value.trim();
                window.AEEngine.pendingInput.set({
                    fileContext: _pendingFilePayload ? _pendingFilePayload.fileContext : null,
                    imageDataUrls: _pendingFilePayload ? _pendingFilePayload.imageDataUrls : null,
                    imageTempPaths: _pendingFilePayload ? _pendingFilePayload.imageTempPaths : null,
                    videoPaths: _pendingFilePayload ? _pendingFilePayload.videoPaths : null,
                    fileRefs: _pendingFilePayload ? _pendingFilePayload.fileRefs : null,
                    // 文本含 chip token（代码行号引用 / 图层引用）时原位解析成引用说明作为发给
                    // LLM 的文本（图层引用解析出 layerId/compositionId）；displayText 保留 token
                    //（气泡里渲染成标签）。不含 token 时留空，走原始文本。
                    codeContext: _hasChipTokens(_raw) ? _resolveChipTokens(_raw) : null,
                    codeDisplay: agentInput.value
                }, _pendingLaneId);
                _pendingCodeChips = [];
            }

            bridge.submitUserInput();
            if (typeof aeBeep === 'function') aeBeep('send');
            } catch (e) {
                // 发送链路任何异常都不静默吞掉：提示用户，避免"点击发送无反应"无从排查
                console.error('[Agent] doSendAgentMessage 异常:', e);
                if (typeof showStatus === 'function') {
                    showStatus(AEI18n.t('发送失败: ') + (e && e.message ? e.message : e), 'error');
                }
            }
        }

        agentInput.addEventListener('keydown', function (e) {
            // @ 文件引用补全最先判：它开着时 ↑↓/Enter/Tab/Esc 归它（/ 命令列表此时已由 input 处理让位）
            if (fileMentions.handleKeydown(e)) return;
            var autocomplete = document.getElementById('slash-autocomplete');
            var isVisible = autocomplete && autocomplete.style.display === 'block';
            if (isVisible) {
                if (e.key === 'Tab' || e.key === 'Enter') {
                    e.preventDefault();
                    slash.applyAutocompleteItem();
                    return;
                }
                if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    slash.moveAutocompleteSelection(1);
                    return;
                }
                if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    slash.moveAutocompleteSelection(-1);
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    slash.hideAutocomplete();
                    return;
                }
            }

            // Ctrl+Enter / Shift+Enter 换行：Shift+Enter 浏览器默认就换行；
            // Ctrl+Enter 默认无动作，需手动在光标处插入换行符。
            // e.isComposing 为真时是输入法候选确认，不触发发送/换行，避免中文输入误操作。
            if (e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                var pos = agentInput.selectionStart != null ? agentInput.selectionStart : agentInput.value.length;
                var inserted = false;
                try {
                    agentInput.setSelectionRange(pos, pos);
                    inserted = document.execCommand('insertText', false, '\n');
                } catch (_) {}
                if (!inserted) {
                    agentInput.value = agentInput.value.slice(0, pos) + '\n' + agentInput.value.slice(pos);
                    var np = pos + 1;
                    try { agentInput.setSelectionRange(np, np); } catch (_) {}
                }
                agentInput.dispatchEvent(new Event('input', { bubbles: true }));
                return;
            }

            // Enter 发送；e.isComposing 为真时是输入法候选确认，不触发发送，避免中文输入误发。
            if (e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                var bridge = getAgentBridge();
                if (!bridge || typeof bridge.submitUserInput !== 'function') return;
                if (typeof bridge.isBusy === 'function' && bridge.isBusy()) {
                    // 执行中：有字→追加发送（入队），无字→停止
                    var hasText = agentInput.value && String(agentInput.value).trim();
                    if (hasText) {
                        doSendAgentMessage();
                    } else if (typeof bridge.requestStop === 'function') {
                        bridge.requestStop();
                    }
                    return;
                }
                doSendAgentMessage();
            }
        });

        // 任何文本插入前同步吸附：粘贴/输入法/直接插入都走 beforeinput，插入点若在 token 内部
        // 会把它劈成两半（chip 从 overlay 消失、发送文本里只剩载荷碎片——引用静默失效）。
        // 这里必须**同步**（keydown 那种放行后吸附赶不上插入），故不能只靠 paste + 0ms 定时器。
        agentInput.addEventListener('beforeinput', function() {
            _snapCaretOutOfTokens();
        });
        agentInput.addEventListener('paste', function(e) {
            // paste 路径另有一层（beforeinput 之外的兜底，且图片粘贴分支不受影响）
            _snapCaretOutOfTokens();
            try {
                var items = e.clipboardData && e.clipboardData.items;
                if (!items) return;
                // \u5148\u626B\u63CF\u662F\u5426\u6709\u56FE\u7247\uFF0C\u65E0\u56FE\u7247\u5219\u8BA9\u6D4F\u89C8\u5668\u9ED8\u8BA4\u5904\u7406\uFF08\u6587\u672C\u7C98\u8D34\u7B49\uFF09
                var hasImage = false;
                for (var i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') === 0) { hasImage = true; break; }
                }
                if (!hasImage) return;
                e.preventDefault();
                // \u5904\u7406\u6240\u6709\u56FE\u7247\u9879
                for (var i = 0; i < items.length; i++) {
                    if (items[i].type.indexOf('image') !== 0) continue;
                    var blob = items[i].getAsFile();
                    if (!blob) continue;
                    // 每个 item 生成唯一名——无序号时多图粘贴落在同一毫秒得到
                    // 同名 chip，发送落盘（_saveImageToTemp 用 data-name）互相覆盖，持久化
                    // 历史多条指向同一文件。名字同步求值（带循环序号）后挂 reader 实例：
                    // var 为函数级作用域，onload 异步触发时循环变量已推进到末项，闭包直读
                    // 会拿到最后一项的名字。
                    var reader = new FileReader();
                    reader._clipImgName = 'clipboard-image-' + Date.now() + '-' + (i + 1) + '.png';
                    reader.onload = function(ev) {
                        var dataUrl = ev.target.result;
                        var chips = document.getElementById('aeAgentFileChips');
                        if (!chips) return;
                        // 硬限制：已达 10 张图片上限，拒绝追加（多图粘贴逐项检查，超额项跳过）
                        if (_imageChipCount() >= MAX_IMAGE_CHIPS) {
                            showStatus(AEI18n.t('已达 ') + MAX_IMAGE_CHIPS + AEI18n.t(' 张图片上限，无法继续添加：请先删除部分图片或分批发送'), 'warn');
                            return;
                        }
                        var startIdx = chips.children.length;
                        var idx = startIdx + 1;
                        var chip = document.createElement('div');
                        chip.className = 'ae-agent-file-chip ae-agent-file-chip-image';
                        chip.setAttribute('data-path', '(clipboard)');
                        chip.setAttribute('data-type', 'image');
                        chip.setAttribute('data-name', ev.target._clipImgName);
                        chip.setAttribute('data-index', idx);
                        chip.setAttribute('data-image-dataurl', dataUrl);
                        var icon = document.createElement('span');
                        icon.className = 'ae-agent-file-chip-icon file';
                        icon.textContent = '\uD83D\uDDBC';
                        chip.appendChild(icon);
                        var thumb = document.createElement('img');
                        thumb.className = 'ae-agent-file-chip-thumb';
                        thumb.src = dataUrl;
                        chip.appendChild(thumb);
                        var preview = document.createElement('img');
                        preview.className = 'ae-agent-file-chip-preview';
                        preview.src = dataUrl;
                        chip.appendChild(preview);
                        var label = document.createElement('span');
                        label.className = 'ae-agent-file-chip-label';
                        label.textContent = AEI18n.t('\u56FE\u7247') + idx;
                        chip.appendChild(label);
                        var nameEl = document.createElement('span');
                        nameEl.className = 'ae-agent-file-chip-name';
                        nameEl.textContent = AEI18n.t('\u526A\u8D34\u677F\u56FE\u7247');
                        chip.appendChild(nameEl);
                        var closeEl = document.createElement('span');
                        closeEl.className = 'ae-agent-file-chip-close';
                        closeEl.textContent = '\u2715';
                        closeEl.addEventListener('click', (function(el) { return function() { el.remove(); (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.renumberFileChips === 'function' ? window.AEAgentApp.llmService.renumberFileChips : function(){})(); updatePreviewParticleBrightness(); }; })(chip));
                        chip.appendChild(closeEl);
                        chips.appendChild(chip);
                        updatePreviewParticleBrightness();
                    };
                    reader.readAsDataURL(blob);
                }
            } catch(e) { console.warn('[Agent] \u7C98\u8D34\u56FE\u7247\u5931\u8D25: ' + (e && e.message ? e.message : String(e))); }
        });
    }

    // 输入区文件去重：按归一化路径判断是否已存在相同文件/文件夹 chip。
    // Windows 路径大小写不敏感：统一反斜杠并转小写后比较（拖拽与上传共用）。
    function _hasFileChip(chips, path) {
        if (!path) return false;
        var norm = String(path).replace(/\//g, '\\').toLowerCase();
        var existing = chips.querySelectorAll('[data-path]');
        for (var i = 0; i < existing.length; i++) {
            var p = existing[i].getAttribute('data-path');
            if (p && String(p).replace(/\//g, '\\').toLowerCase() === norm) return true;
        }
        return false;
    }

    // 输入区附件 chip → 结构化条目。@ 文件引用补全的候选源与发送解析的 名→路径 表**共用这一处读数**：
    // 分头读会漂成「候选里显示的名」与「能解析回的名」不是同一个。
    // name 取 data-name（chip 的身份，与 [引用文件] 块同一来源）；path 供候选行显示与发送解析定位。
    // **不读类型**：候选行曾按类型出 emoji 图标，在面板这层子树里落成认不出的单色字形（用户实测），
    // 只给名 + 路径——没有消费者就不留字段（类型信息由扩展名与附件 chip 的标签给）。
    function _fileChipEntries() {
        var chips = document.getElementById('aeAgentFileChips');
        var out = [];
        if (!chips) return out;
        for (var i = 0; i < chips.children.length; i++) {
            var chip = chips.children[i];
            if (!chip.getAttribute) continue;
            var name = chip.getAttribute('data-name') || '';
            if (!name) continue;
            out.push({
                name: name,
                path: chip.getAttribute('data-path') || ''
            });
        }
        return out;
    }

    // 名 → 路径数组。同名文件可能来自不同目录：**全给**（让 LLM 看到有两个候选去问，不挑一个冒充）。
    // '(clipboard)' 这类占位不是路径，不算进来（剪贴板图片没有落盘路径）。
    function _filePathsByName(name) {
        var entries = _fileChipEntries();
        var out = [];
        for (var i = 0; i < entries.length; i++) {
            if (entries[i].name !== name) continue;
            var p = entries[i].path;
            if (p && p.charAt(0) !== '(') out.push(p);
        }
        return out;
    }

    // 回收视频 chip 的 blob: URL：chip 销毁后 Object URL 不回收会让 File 对象
    // 经 URL 注册表长期滞留（长会话反复拖入视频 = 资源泄漏）
    function _revokeChipBlobUrls(chipEl) {
        if (!chipEl || !window.URL || typeof window.URL.revokeObjectURL !== 'function') return;
        var vids = chipEl.querySelectorAll('video');
        for (var i = 0; i < vids.length; i++) {
            var s = vids[i].getAttribute('src') || '';
            if (s.indexOf('blob:') === 0) {
                try { window.URL.revokeObjectURL(s); } catch (_) {}
            }
        }
    }

    var inputWrap = document.getElementById('aeAgentInputWrap');
    if (inputWrap) {
        var dragCounter = 0;
        inputWrap.addEventListener('dragover', function (e) {
            e.preventDefault();
            e.stopPropagation();
        });
        inputWrap.addEventListener('dragenter', function (e) {
            e.preventDefault();
            e.stopPropagation();
            dragCounter++;
            inputWrap.classList.add('drag-over');
        });
        inputWrap.addEventListener('dragleave', function (e) {
            e.preventDefault();
            e.stopPropagation();
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                inputWrap.classList.remove('drag-over');
            }
        });
        // 创建单个文件/文件夹 chip（拖拽 drop 与文件选择器共用）
        function _appendFileChip(chips, path, name, isFolder, file, index) {
            path = path.replace(/\//g, '\\');
            var chip = document.createElement('div');
            chip.className = 'ae-agent-file-chip';
            chip.setAttribute('data-path', path);
            chip.setAttribute('data-type', isFolder ? 'folder' : 'file');
            chip.setAttribute('data-name', name);
            chip.setAttribute('data-index', index);

            var icon = document.createElement('span');
            icon.className = 'ae-agent-file-chip-icon ' + (isFolder ? 'folder' : 'file');
            icon.textContent = isFolder ? '\uD83D\uDCC1' : '\uD83D\uDCC4';
            chip.appendChild(icon);

            var label = document.createElement('span');
            label.className = 'ae-agent-file-chip-label';
            // 标签按类型显示：文件夹 / 视频 / 图片 / 文件（isImage/isVideo 在下方独立声明，此处按同一规则判定）
            var _isVideoChip = !isFolder && /\.(mp4|mov|webm|m4v|mkv)$/i.test(name);
            var _isImageChip = !isFolder && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(name);
            label.textContent = (isFolder ? AEI18n.t('\u6587\u4EF6\u5939')
                : _isVideoChip ? AEI18n.t('\u89C6\u9891')
                : _isImageChip ? AEI18n.t('\u56FE\u7247')
                : AEI18n.t('\u6587\u4EF6')) + index;
            chip.appendChild(label);

            var nameEl = document.createElement('span');
            nameEl.className = 'ae-agent-file-chip-name';
            nameEl.textContent = name;
            nameEl.title = path;
            chip.appendChild(nameEl);

            var closeEl = document.createElement('span');
            closeEl.className = 'ae-agent-file-chip-close';
            closeEl.textContent = '\u2715';
            closeEl.addEventListener('click', function (chipEl) {
                return function () {
                    _revokeChipBlobUrls(chipEl);
                    chipEl.remove();
                    (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.renumberFileChips === 'function' ? window.AEAgentApp.llmService.renumberFileChips : function(){})();
                };
            }(chip));
            chip.appendChild(closeEl);

            var isImage = !isFolder && /\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(name);
            // 硬限制：已达 10 张图片上限，拒绝追加（拖拽与文件选择器共用入口；返回 null 调用方已安全处理）
            if (isImage && _imageChipCount() >= MAX_IMAGE_CHIPS) {
                showStatus(AEI18n.t('已达 ') + MAX_IMAGE_CHIPS + AEI18n.t(' 张图片上限，无法继续添加：请先删除部分图片或分批发送'), 'warn');
                return null;
            }
            if (isImage) {
                chip.classList.add('ae-agent-file-chip-image');
                if (file) {
                    // 有 File 对象（拖拽）：FileReader 本地读 base64
                    var reader = new FileReader();
                    reader.onload = (function(chipEl) {
                        return function(e) {
                            chipEl.setAttribute('data-image-dataurl', e.target.result);
                            var thumb = document.createElement('img');
                            thumb.className = 'ae-agent-file-chip-thumb';
                            thumb.src = e.target.result;
                            chipEl.insertBefore(thumb, chipEl.firstChild);
                            var preview2 = document.createElement('img');
                            preview2.className = 'ae-agent-file-chip-preview';
                            preview2.src = e.target.result;
                            chipEl.appendChild(preview2);
                        };
                    })(chip);
                    reader.readAsDataURL(file);
                } else {
                    // 只有路径（上传按钮）：AEFS 服务端读图片 base64
                    (function (chipEl, filePath, fileName) {
                        // chip 标记「读取中」——该路径 base64 异步回填（约百毫秒~
                        // 秒级），读取完成前发送时图片不在 imageDataUrls/imageTempPaths/
                        // fileRefs 任何一处（图片扩展名不入 fileRefs），消息发出即静默丢图，
                        // 随后 clearInput 清空 chips 无法找回。doSendAgentMessage 对带
                        // data-image-loading 的 chip 阻止发送；完成/失败/异常均解除标记。
                        // 读取/转码两段任一失败都必须显式提示——图片扩展名不入
                        // fileRefs，chip 留在输入区只会让发送时无声丢图（无缩略图无报错）。
                        // 提示后移除该 chip（连同「读取中」标记）；重编号保持序号连续。
                        function failChip(reason) {
                            chipEl.removeAttribute('data-image-loading');
                            showStatus(reason + AEI18n.t('，已移除：') + fileName, 'error');
                            if (chipEl.parentNode) chipEl.parentNode.removeChild(chipEl);
                            if (window.AEAgentApp && window.AEAgentApp.llmService
                                && typeof window.AEAgentApp.llmService.renumberFileChips === 'function') {
                                window.AEAgentApp.llmService.renumberFileChips();
                            }
                        }
                        function applyDataUrl(dataUrl) {
                            chipEl.removeAttribute('data-image-loading');
                            chipEl.setAttribute('data-image-dataurl', dataUrl);
                            var thumb = document.createElement('img');
                            thumb.className = 'ae-agent-file-chip-thumb';
                            thumb.src = dataUrl;
                            chipEl.insertBefore(thumb, chipEl.firstChild);
                            var preview3 = document.createElement('img');
                            preview3.className = 'ae-agent-file-chip-preview';
                            preview3.src = dataUrl;
                            chipEl.appendChild(preview3);
                        }
                        chipEl.setAttribute('data-image-loading', '1');
                        var _imgExt = String(fileName || filePath).toLowerCase().split('.').pop();
                        // /api/read-image 白名单只认 png/jpg/jpeg，gif/bmp/webp 走它恒
                        // 被 400 拒（响应里没有 success/base64，直接返回会变成：
                        // 无缩略图无报错、data-image-dataurl 不回填 → 发送时也不进 imageDataUrls）。
                        // 这三种格式改走「读原字节（AEFS.readBlob 通用二进制通道，端点不限扩展名）
                        // → FileReader 原图 dataURL → 面板侧 canvas 转 JPEG（shared/imageTranscode.js
                        // 单点，CEF 88 原生解码 gif/bmp/webp）→ dataURL」，与拖放路径最终落到同一
                        // data-image-dataurl 字段（发送链据此收集进 imageDataUrls）。
                        if (_imgExt === 'gif' || _imgExt === 'bmp' || _imgExt === 'webp') {
                            if (typeof AEFS === 'undefined' || typeof AEFS.readBlob !== 'function') {
                                failChip(AEI18n.t('图片读取通道不可用'));
                                return;
                            }
                            AEFS.readBlob(filePath).then(function (rb) {
                                if (!rb || !rb.success || !rb.blob) {
                                    failChip(AEI18n.t('图片读取失败（{ext}）', { ext: _imgExt }));
                                    return null;
                                }
                                return new Promise(function (resolve) {
                                    var fr = new FileReader();
                                    fr.onload = function () { resolve(fr.result || null); };
                                    fr.onerror = function () { resolve(null); };
                                    fr.readAsDataURL(rb.blob);
                                });
                            }).then(function (rawDataUrl) {
                                if (rawDataUrl === null) return;   // 读取失败已提示（failChip）
                                if (!rawDataUrl) { failChip(AEI18n.t('图片读取失败（{ext}）', { ext: _imgExt })); return; }
                                var tx = window.AEImageTranscode;
                                if (!tx || typeof tx.transcodeDetailed !== 'function') {
                                    failChip(AEI18n.t('图片转码模块不可用'));
                                    return;
                                }
                                return tx.transcodeDetailed(rawDataUrl).then(function (tr) {
                                    // converted=false 即转码单点回退原图（Image 解码失败/canvas
                                    // 不可用）——gif/bmp/webp 必须得到 PNG/JPEG，回退按失败处理并
                                    // 显式提示，不得把未转码的图静默放行/丢弃
                                    if (!tr || !tr.converted || !tr.url) {
                                        failChip(AEI18n.t('图片转码失败（{ext}）', { ext: _imgExt }));
                                        return;
                                    }
                                    applyDataUrl(tr.url);
                                });
                            }).catch(function (e) {
                                console.warn('[Agent] 图片读取/转码异常: ' + (e && e.message ? e.message : e));
                                failChip(AEI18n.t('图片读取/转码异常'));
                            });
                            return;
                        }
                        if (typeof AEFS === 'undefined' || typeof AEFS.readImageBase64 !== 'function') {
                            failChip(AEI18n.t('图片读取通道不可用'));
                            return;
                        }
                        AEFS.readImageBase64(filePath).then(function (r) {
                            if (!r || !r.success || !r.base64) { failChip(AEI18n.t('图片读取失败')); return; }
                            applyDataUrl('data:' + (r.mime || 'image/png') + ';base64,' + r.base64);
                        }).catch(function (e) {
                            console.warn('[Agent] 图片读取异常: ' + (e && e.message ? e.message : e));
                            failChip(AEI18n.t('图片读取异常'));
                        });
                    })(chip, path, name);
                }
            }

            // 视频 chip：hover 弹出预览框并自动播放（与图片预览一致；muted 允许无手势自动播放）。
            // 预览交给 shared/videoPreview.js：CEF 解不了的编码（HEVC/H.265 等）在那里自动
            // 转码兜底——直接挂在 chip 上的裸 <video> 遇到这类文件永远是黑框且不报错。
            var isVideo = !isFolder && ((typeof AEShared !== 'undefined' && typeof AEShared.isVideoPath === 'function')
                ? AEShared.isVideoPath(name)
                : /\.(mp4|mov|webm|m4v|mkv)$/i.test(name));
            if (isVideo) {
                chip.classList.add('ae-agent-file-chip-video');
                var _pv = (typeof AEShared !== 'undefined' && typeof AEShared.createVideoPreview === 'function')
                    ? AEShared.createVideoPreview({
                        path: path,
                        file: file || null,
                        name: name,
                        compact: true,
                        // 复用既有的浮层定位样式（.ae-agent-file-chip-preview 从 <video>
                        // 挪到本组件的根元素上，CSS 无需改动）
                        elClassName: 'ae-agent-file-chip-preview'
                    })
                    : null;
                if (_pv) {
                    chip.appendChild(_pv.el);
                    chip.addEventListener('mouseenter', function () {
                        // 每次 hover 从头播放
                        try { _pv.video.currentTime = 0; } catch (_) {}
                        _pv.play().catch(function () {});
                    });
                    chip.addEventListener('mouseleave', function () { _pv.pause(); });
                } else {
                    // 降级｜shared 模块不可用：保持旧的裸 video 行为
                    var vid = document.createElement('video');
                    vid.className = 'ae-agent-file-chip-preview';
                    vid.muted = true;
                    vid.loop = true;
                    vid.playsInline = true;
                    vid.preload = 'metadata';
                    if (file) {
                        vid.src = URL.createObjectURL(file);
                    } else {
                        vid.src = (typeof AEShared !== 'undefined' && typeof AEShared.toFileUrl === 'function')
                            ? AEShared.toFileUrl(path)
                            : path;
                    }
                    chip.appendChild(vid);
                    chip.addEventListener('mouseenter', function () {
                        try { vid.currentTime = 0; } catch (_) {}
                        vid.play().catch(function () {});
                    });
                    chip.addEventListener('mouseleave', function () {
                        try { vid.pause(); } catch (_) {}
                    });
                }
            }

            chips.appendChild(chip);
            return chip;
        }
        inputWrap.addEventListener('drop', function (e) {
            e.preventDefault();
            e.stopPropagation();
            dragCounter = 0;
            inputWrap.classList.remove('drag-over');

            var chips = document.getElementById('aeAgentFileChips');
            if (!chips) return;

            var items = e.dataTransfer.items;
            var files = e.dataTransfer.files;
            var startIdx = chips.children.length;
            for (var i = 0; i < items.length; i++) {
                var entry = items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
                var isFolder = !!(entry && entry.isDirectory);
                var drop = _resolveDropEntry(entry, i, files, isFolder);
                if (!drop) {
                    // 文件夹拿不到磁盘路径时不能退回 entry.fullPath（拖放树内虚拟路径），
                    // 否则引用块里是 "\角色" 这种不存在的路径，LLM 与工具都会读空。
                    if (isFolder) {
                        showStatus(AEI18n.t('无法取得该文件夹的磁盘路径（拖放通道未提供），请改用「添加文件」：')
                            + ((entry && entry.name) || AEI18n.t('文件夹')), 'warn');
                    }
                    continue;
                }
                var path = drop.path;
                var name = drop.name;
                // 只允许「能识别」的文件：图片/视频/可解析文档生成 chip；文件夹作为路径引用保留。
                // 其余无法解析内容的单文件直接拒绝，不加入引用。
                if (!isFolder && !/\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(name)
                    && !/\.(mp4|mov|webm|m4v|mkv)$/i.test(name)
                    && !PARSEABLE_DOC_EXT.test(name)) {
                    showStatus(AEI18n.t('不支持该格式，仅允许图片/视频/文档：') + name, 'warn');
                    continue;
                }
                // 同一路径已存在 → 跳过并提示，避免重复添加相同文件/文件夹
                if (_hasFileChip(chips, path)) {
                    showStatus(AEI18n.t('该文件已在输入区中，无需重复添加：') + name, 'warn');
                    continue;
                }
                _appendFileChip(chips, path, name, isFolder, drop.file, startIdx + i + 1);
            }

            if (chips.children.length) {
                agentInput && agentInput.focus();
            }
        });
    }

    // ── 输入框上方工具按钮：/ 命令 与 文件上传 ──
    var slashBtn = document.getElementById('aeAgentSlashBtn');
    if (slashBtn && agentInput) {
        slashBtn.addEventListener('click', function () {
            agentInput.focus();
            var pos = agentInput.selectionStart != null ? agentInput.selectionStart : agentInput.value.length;
            // 光标处插入 "/"；若在行首则 input 事件会触发 slash 命令面板
            var inserted = false;
            try {
                agentInput.setSelectionRange(pos, pos);
                inserted = document.execCommand('insertText', false, '/');
            } catch (_) {}
            if (!inserted) {
                agentInput.value = agentInput.value.slice(0, pos) + '/' + agentInput.value.slice(pos);
            }
            var np = pos + 1;
            try { agentInput.setSelectionRange(np, np); } catch (_) {}
            agentInput.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }

    var uploadBtn = document.getElementById('aeAgentUploadBtn');
    if (uploadBtn) {
        // CEP 中 input[type=file] 触发系统文件对话框会导致 CEF 渲染进程崩溃（面板整块黑屏，AE 正常）。
        // 改用 ExtendScript File.openDialog（AEPickGuard 统一文件选择锁 + 崩溃兜底，支持多选）。
        uploadBtn.addEventListener('click', function () {
            if (!window.AEPickGuard) return;
            window.AEPickGuard.pickFile({
                title: AEI18n.t('添加文件到对话'),
                filter: AEI18n.t('所有文件:*.*'),
                multiSelect: true
            }, function (paths) {
                var chips = document.getElementById('aeAgentFileChips');
                if (!chips) return;
                var list = Array.isArray(paths) ? paths : [];
                for (var i = 0; i < list.length; i++) {
                    var p = list[i];
                    if (!p) continue;
                    var name = p.replace(/\\/g, '/').split('/').pop() || p;
                    // 与拖放一致：只允许「能识别」的文件（图片/视频/可解析文档），
                    // 其余无法解析内容的格式直接拒绝，不加入引用。
                    if (!/\.(png|jpg|jpeg|gif|bmp|webp)$/i.test(name)
                        && !/\.(mp4|mov|webm|m4v|mkv)$/i.test(name)
                        && !PARSEABLE_DOC_EXT.test(name)) {
                        showStatus(AEI18n.t('不支持该格式，仅允许图片/视频/文档：') + name, 'warn');
                        continue;
                    }
                    // 同一路径已存在 → 跳过并提示，避免重复添加相同文件
                    if (_hasFileChip(chips, p)) {
                        showStatus(AEI18n.t('该文件已在输入区中，无需重复添加：') + name, 'warn');
                        continue;
                    }
                    _appendFileChip(chips, p, name, false, null, chips.children.length + 1);
                }
                agentInput && agentInput.focus();
            });
        });
    }

    if (agentSendBtn) {
        agentSendBtn.addEventListener('click', function () {
            var bridge = getAgentBridge();
            if (!bridge || typeof bridge.submitUserInput !== 'function') {
                showStatus(AEI18n.t('Agent 尚未初始化，请稍后再试'), 'warn');
                return;
            }
            if (typeof bridge.isBusy === 'function' && bridge.isBusy()) {
                // 执行中：有字→追加发送（入队），无字→停止
                var hasText = agentInput.value && String(agentInput.value).trim();
                if (hasText) {
                    doSendAgentMessage();
                } else if (typeof bridge.requestStop === 'function') {
                    bridge.requestStop();
                }
                return;
            }
            doSendAgentMessage();
        });
    }

    const messageResizer = document.getElementById('aeAgentMessageResizer');
    // ── 中列拉条：拖拽调整「消息区 / 输入区」分界 ──────────────
    // 布局口径（agent.css）：消息区吃满中列剩余高度，输入区定高（默认 200px / 最小 64px）。
    // ⇒ 拖拽写的是输入区高度（反向）：往下拖 = 消息区变高、输入区变矮；往上拖 = 消息区变矮、
    // 输入区变高。两块合计恒等于列内可分空间 ⇒ 拖到哪都不会在消息区下方留空位
    // （按消息列表 / lane 容器定高时，消息区不再撑满就会留空；
    // 现在消息区始终撑满，空位从根上不存在）。
    const agentInputWrap = document.getElementById('aeAgentInputWrap');
    const _resizableLists = _existingMessageLists();
    if (agentInputWrap && messageResizer && _resizableLists.length) {
        const _isLaneList = (el) => !!(el && el.id && el.id.indexOf('aeAgentMessageList_') === 0);
        // lane 容器经「列表 → wrap → 容器」解析（不按 id 拼，容器 id 由 lane 定义给）
        const _laneBoxOf = (listEl) => {
            const wrap = listEl && listEl.parentNode;
            const lane = wrap && wrap.parentNode;
            return (lane && lane.classList && lane.classList.contains('ae-agent-lane')) ? lane : null;
        };
        // 迁移安全网：拖拽可能往消息列表 / lane 容器写内联定高，现在这些盒子一律由 CSS
        // 撑满，残留的内联值会把「撑满」钉死；挂载时统一清掉（面板重载后 DOM 重建本来就没有
        // 残留，这里只防「同一页面内旧代码先写过、又走到新接线」的时序）。
        _resizableLists.forEach((el) => {
            el.style.height = '';
            el.style.flex = '';
            const box = _laneBoxOf(el);
            if (box) {
                box.style.height = '';
                box.style.flex = '';
            }
        });
        // 输入区下限读 CSS 的 min-height（64px），不在这里再写一份数值
        const getInputMinHeight = () => {
            const v = parseFloat(window.getComputedStyle(agentInputWrap).minHeight);
            return (isFinite(v) && v > 0) ? v : 64;
        };
        // 消息区保底高度：拖拽上限按「消息区 + 输入区当前合计 - 本值」算，避免把聊天区拖到 0
        const MESSAGE_AREA_MIN_HEIGHT = 140;
        const listForDrag = () => _currentMessageList() || _resizableLists[0];
        // 量消息区的可见框：单 Agent = 列表本身（有边框、被裁剪的那个框），团队 = 当前 lane 容器
        const _messageBoxOf = (listEl) => (_isLaneList(listEl) ? (_laneBoxOf(listEl) || listEl) : listEl);
        const getInputMaxHeight = (listEl) => {
            const box = _messageBoxOf(listEl);
            const budget = agentInputWrap.getBoundingClientRect().height
                + (box ? box.getBoundingClientRect().height : 0);
            return Math.max(getInputMinHeight(), Math.round(budget - MESSAGE_AREA_MIN_HEIGHT));
        };
        let dragging = false;
        let startY = 0;
        let startHeight = 0;
        // rAF 节流：pointermove 可能一帧触发多次（高刷/快速拖动），每次都读 rect +
        // 写 height 会造成 layout thrashing（读写交替强制同步 reflow）。
        // 帧内只记录最新 clientY，统一到每帧一次读取+写入，clamp 逻辑不变。
        let moveRaf = 0;
        let lastClientY = 0;
        const applyMove = () => {
            moveRaf = 0;
            if (!dragging) return;
            const listEl = listForDrag();
            if (!listEl) return;
            const dy = lastClientY - startY;
            // 反向：往下拖（dy>0）输入区变矮（下限 = CSS min-height），消息区占走差额
            const next = Math.max(getInputMinHeight(), Math.min(getInputMaxHeight(listEl), Math.round(startHeight - dy)));
            agentInputWrap.style.flex = '0 1 auto';
            agentInputWrap.style.height = `${next}px`;
        };
        const onMove = (e) => {
            if (!dragging) return;
            lastClientY = e.clientY;
            if (!moveRaf) {
                moveRaf = requestAnimationFrame(applyMove);
            }
        };
        const onUp = () => {
            dragging = false;
            if (moveRaf) {
                cancelAnimationFrame(moveRaf);
                moveRaf = 0;
            }
            window.removeEventListener('pointermove', onMove);
            window.removeEventListener('pointerup', onUp);
        };
        messageResizer.addEventListener('pointerdown', (e) => {
            const listEl = listForDrag();
            if (!listEl) return;
            // 提问面板在场时输入区是「按内容自适应」（agent.css .has-ask-panel），拖拽写下的
            // 高度会被 !important 压住、当下无视觉反馈，结算后却突然生效——直接不许拖。
            if (agentInputWrap.classList && agentInputWrap.classList.contains('has-ask-panel')) return;
            dragging = true;
            startY = e.clientY;
            startHeight = agentInputWrap.getBoundingClientRect().height || getInputMinHeight();
            messageResizer.setPointerCapture && messageResizer.setPointerCapture(e.pointerId);
            window.addEventListener('pointermove', onMove);
            window.addEventListener('pointerup', onUp);
            e.preventDefault();
        });
        window.addEventListener('resize', () => {
            // 只在用户拖过（有内联高度）时钳制：没拖过的高度由 CSS 定高与 min-height 管
            if (!agentInputWrap.style.height) return;
            // 隐藏态（外接/脚本等模式把中列藏起来时）所有 rect 都是 0：此时钳制会把用户拖出的
            // 高度误钳成 min-height，跳过（回到可见模式后窗口 resize 会重新钳制）
            if (!agentInputWrap.getBoundingClientRect().height) return;
            const listEl = listForDrag();
            if (!listEl) return;
            const current = agentInputWrap.getBoundingClientRect().height;
            const maxNow = getInputMaxHeight(listEl);
            if (current > maxNow) {
                agentInputWrap.style.height = `${maxNow}px`;
            } else if (current < getInputMinHeight()) {
                agentInputWrap.style.height = `${getInputMinHeight()}px`;
            }
        });
    }

    // 滚动到底部按钮：用户向上滚动查看历史时浮现，点击快速回到底部。
    // 团队模式：每条 lane 的消息区自带一个按钮（id 以消息列表 id 派生），
    // 共享单例会让"按钮跟着哪条 lane"错位——隐藏容器里的按钮点不到，可见 lane 又没有按钮。
    const _scrollBottomBtnFor = (listEl) => {
        const listId = (listEl && listEl.id) ? listEl.id : '';
        if (listId.indexOf('aeAgentMessageList_') === 0) {
            const perLane = document.getElementById('aeAgentScrollBottomBtn_' + listId.slice('aeAgentMessageList_'.length));
            if (perLane) return perLane;
        }
        return document.getElementById('aeAgentScrollBottomBtn');
    };
    const _scrollLists = _existingMessageLists();
    if (_scrollLists.length) {
        // 口径与 view.js 的 _FOLLOW_THRESHOLD（24px）对齐：跟随在距底 > 24 时关闭，
        // 按钮必须同样在 > 24 时出现——否则距底 25–79px 区间「跟随已关、按钮不见」，
        // 用户失去恢复自动滚动的入口（与「系统卡打断自动滚动」同类的症状）。
        const NEAR_BOTTOM_THRESHOLD = 24;
        const _scrollRaf = new WeakMap();
        function updateScrollBottomBtn(listEl) {
            const btn = _scrollBottomBtnFor(listEl);
            if (!btn) return;
            const notNearBottom = (listEl.scrollHeight - listEl.scrollTop - listEl.clientHeight) >= NEAR_BOTTOM_THRESHOLD;
            btn.classList.toggle('is-visible', notNearBottom);
        }
        _scrollLists.forEach((listEl) => {
            const btn = _scrollBottomBtnFor(listEl);
            if (!btn) return;
            listEl.addEventListener('scroll', function () {
                if (_scrollRaf.get(listEl)) return;
                _scrollRaf.set(listEl, requestAnimationFrame(function () {
                    _scrollRaf.set(listEl, 0);
                    updateScrollBottomBtn(listEl);
                }));
            });
            btn.addEventListener('click', function () {
                // 历史浏览模式下尾部块处于 display:none（窗口化挂载），scrollHeight 只反映
                // 挂载窗口——直接 scrollTo(scrollHeight) 会停在窗口底而非会话底。
                // view.js 在列表元素上挂了 __aeScrollToBottom：先推进窗口到最新 CAP 条再滚动。
                if (typeof listEl.__aeScrollToBottom === 'function') {
                    listEl.__aeScrollToBottom();
                } else {
                    listEl.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' });
                }
            });
            updateScrollBottomBtn(listEl);
        });
    }


    const scriptPreviewEl = document.getElementById('scriptPreview');
    if (scriptPreviewEl) {
        let isComposing = false;

        // 预览区 tab（编辑/产物——双栏对照，产物=门重发射产物只读展示）
        const previewTabsEl = document.getElementById('scriptPreviewTabs');
        if (previewTabsEl) {
            previewTabsEl.addEventListener('click', (e) => {
                const btn = e.target && e.target.closest ? e.target.closest('.preview-tab') : null;
                if (!btn) return;
                const pane = btn.getAttribute('data-pane');
                previewTabsEl.querySelectorAll('.preview-tab').forEach(t => t.classList.toggle('active', t === btn));
                const editPane = document.getElementById('previewEditPane');
                const productPane = document.getElementById('previewProductPane');
                if (editPane) editPane.hidden = (pane !== 'edit');
                if (productPane) productPane.hidden = (pane !== 'product');
            });
        }

        scriptPreviewEl.addEventListener('compositionstart', () => {
            isComposing = true;
        });

        scriptPreviewEl.addEventListener('compositionend', () => {
            isComposing = false;
            (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})();
        });

        // 草稿持久化对齐 shaderDraft 的 250ms 防抖——否则每 input 事件全量
        // 序列化+写盘（saveSettings），逐键输入大脚本时 IO 风暴；高亮保持即时
        // （与 shader 路径「高亮无延迟」一致）
        var scriptDraftDebounce = null;
        function onScriptPreviewEdited() {
            if (isComposing) {
                return;
            }
            // 编辑即清错误行内高亮（标记失效）+ 产物 pane 标过期（非实时——
            // 下次运行重新过门刷新）
            if (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.clearPreviewLineMarks === 'function') window.AEAgentApp.llmService.clearPreviewLineMarks();
            if (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.markProductPaneStale === 'function') window.AEAgentApp.llmService.markProductPaneStale();
            (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})();
            if (scriptDraftDebounce) clearTimeout(scriptDraftDebounce);
            scriptDraftDebounce = setTimeout(function () {
                scriptDraftDebounce = null;
                try {
                    saveSettings({
                        ...cachedSettings,
                        ...getCurrentSettingsFromUI(),
                        previewDraft: scriptPreviewEl.value
                    });
                } catch (_) {}
            }, 250);
        }
        scriptPreviewEl.addEventListener('input', onScriptPreviewEdited);

        // shader/外接/团队档：GLSL 编辑区跟随代码编辑（高亮立即跟随输入，编译/滑块 250ms 防抖）
        var shaderPreviewDebounce = null;
        function onShaderPreviewEdited(e) {
            // 只认 GLSL 编辑区来源：外接模式下 script 预览区与 GLSL 编辑区同显（六功能
            // 区），两区都绑了本处理器——不判别事件来源时，改脚本会把 GLSL 预览/滑块重算
            // 一遍（renderUniforms 重建 innerHTML，会打断正在拖动的滑块），并把未变化的
            // 草稿反复写盘。无事件对象（程序化调用）按 GLSL 区处理。
            var fromGlslEditor = !(e && e.target) || e.target === document.getElementById('shaderCodePreview');
            if (!fromGlslEditor) return;
            // 高亮无延迟：输入即更新 overlay
            applyGlslHighlight();
            if (shaderPreviewDebounce) clearTimeout(shaderPreviewDebounce);
            shaderPreviewDebounce = setTimeout(function () {
                // 模块已卸载的迟到防抖直接丢弃——getShaderUI 发现实例为 null 会
                // 重建 shaderUI（bindResizer/bindPreviewEvents 重挂监听 + 经
                // previewRendererFactory 重编译 WebGL），泄漏渲染器与静态 DOM 监听
                if (!llmModuleMounted) return;
                var su = getShaderUI();
                // 外接/团队档与 shader 档共用 #shaderCodePreview 及同一条预览/编译/
                // uniform/草稿链，判据统一走 isGlslEditingMode（按单一模式写死会让外接/团队档
                // 改代码不编译、滑块不跟随、shaderDraft 不落盘）。
                if (su && isGlslEditingMode()) {
                    var code = getShaderPreviewCode();
                    su.refreshPreviewFromCode(code);
                    su.updateCompileStatus(code);
                    su.renderUniforms(parseShaderUniforms(code));
                    try { saveSettings({ ...cachedSettings, ...getCurrentSettingsFromUI(), shaderDraft: code }); } catch (_) {}
                }
            }, 250);
        }
        scriptPreviewEl.addEventListener('input', onShaderPreviewEdited);

        // shader 模式：独立 GLSL 编辑区（#shaderCodePreview）同样跟随编辑刷新预览/编译/滑块
        var shaderCodeEl = document.getElementById('shaderCodePreview');
        if (shaderCodeEl) {
            shaderCodeEl.addEventListener('input', onShaderPreviewEdited);
            shaderCodeEl.addEventListener('scroll', function () {
                var pv = window.AEAgentApp && window.AEAgentApp.glslHighlight && window.AEAgentApp.glslHighlight.preview;
                if (pv && typeof pv.syncScroll === 'function') {
                    pv.syncScroll();
                }
            });
            shaderCodeEl.addEventListener('keydown', function (e) {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    var start = shaderCodeEl.selectionStart;
                    var end = shaderCodeEl.selectionEnd;
                    var val = shaderCodeEl.value;
                    shaderCodeEl.value = val.substring(0, start) + '    ' + val.substring(end);
                    shaderCodeEl.selectionStart = shaderCodeEl.selectionEnd = start + 4;
                    // 程序化改 value 不触发 input 事件，须手动刷新 overlay 高亮
                    // （对齐 script 侧 Tab 处理的 highlightCode() 调用），
                    // 否则 has-highlight 态下新缩进在 overlay 中不可见
                    applyGlslHighlight();
                }
            });
        }

        scriptPreviewEl.addEventListener('scroll', (window.AEAgentApp && window.AEAgentApp.llmService && window.AEAgentApp.llmService.syncScroll || function(){}));

        scriptPreviewEl.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                const start = scriptPreviewEl.selectionStart;
                const end = scriptPreviewEl.selectionEnd;
                const val = scriptPreviewEl.value;
                scriptPreviewEl.value = val.substring(0, start) + '    ' + val.substring(end);
                scriptPreviewEl.selectionStart = scriptPreviewEl.selectionEnd = start + 4;
                (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})();
            }
        });

        // ── 预览区右键菜单：添加选中代码/全部代码到输入区（原子 chip 占位）──
        // chip 在文本流中是定界符包裹的行号 token（\u200b + 间距 + L5-L34 + 间距 + \u200b），
        // overlay 按出现顺序渲染成可点击的行号标签，发送时把 token 原位替换为行号引用。
        // store 仅在发送解析时使用。
        var _pendingCodeChips = [];
        var _codeChipSeq = 0;
        // 输入框失焦时记住最后光标位置：预览区右键添加 chip 时（焦点在预览区）插入到该位置，
        // 而不是总追加到文本尾部。聚焦后用实时光标，此缓存失效。
        var _lastInputSelection = null;
        // chip overlay 的渲染上限（字符）。overlay 是透明文本副本（CSS color: transparent），
        // 唯一职责是给 chip 标签提供与 textarea 逐字对齐的定位；而「没有换行机会的超长段落」
        // 在 Chromium 里的折行排版是平方级成本（压力测试实测单段文本：5 万字符
        // 65ms / 10 万 253ms / 50 万 10.3s，且这个成本落在每一次 input 上）。5 万字符远超
        // 正常输入，到这个量级说明是粘贴的物料——chip 标签与对齐都无意义，撤掉渲染即可
        //（textarea 仍照常显示 token 载荷原文；发送解析走文本扫描，不依赖 overlay）。
        var CHIP_OVERLAY_MAX_CHARS = 50000;
        // 渲染 overlay：把 textarea 文本中的 token 画成标签，其余文本透明仅占位保证对齐
        function _renderCodeChipOverlay() {
            var overlay = document.getElementById('aeAgentCodeChipOverlay');
            var input = document.getElementById('aeAgentInput');
            if (!overlay || !input) return;
            overlay.innerHTML = '';
            var value = input.value;
            if (!value) return;
            // 早退①：超过上限不渲染（依据见 CHIP_OVERLAY_MAX_CHARS 注释）。长度判定放在扫描之前，
            // 省一次全文扫描；overlay 已在上方清空，文本变短后下一次 input 自动恢复渲染
            if (value.length > CHIP_OVERLAY_MAX_CHARS) return;
            // token 三类（代码行号引用 L5-L34 / 图层引用 @compId:layerId[,layerId…] / 文件引用 @文件名，
            // 语法见 utils/chipTokens.js 单一真源）：零宽定界符 \u200b 包裹，内部两侧内边距（图层 chip 用
            // 不换行空格，个数按标签宽推算），外部两侧各 2 普通空格作框外间隙；
            // overlay 透明文本副本保证与 textarea 逐字对齐
            //（chip 框宽必须严格等于 token 文本宽，否则会盖住相邻输入文本）。
            // 原子编辑（光标不可进入 token 内部）由 keydown 拦截实现（见下方 _tokenRangeAt / keydown 监听）
            var _ct = _chipTokens();
            if (!_ct) return;   // 语法模块未装载（清单缺项）时不渲染，避免半套语法错位
            var tokenRe = _ct.makeScanRe();
            // 早退②：整份文本没有 chip token —— overlay 只为 chip 定位而存在，没有 token 就没有
            // 要画的东西（把全文镜像进来再排一遍版会在长文本上白付一次折行排版）。
            // test 会推进全局正则的 lastIndex，命中后必须归零再进下面的渲染循环
            if (!tokenRe.test(value)) return;
            tokenRe.lastIndex = 0;
            var frag = document.createDocumentFragment();
            var last = 0;
            var m;
            var chipOrder = 0;      // 全部 chip 的出现次序（点击删除按它定位）
            var layerOrdinal = 0;   // 图层 chip 的次序（hover 浮层标题按它编号）
            var itemOrdinal = 0;    // 项目项 chip 的次序（同上）
            var fileKindOrdinals = {};  // 文件 chip 按类型的次序（图片1/图片2/视频1…——标签与 hover 编号）
            while ((m = tokenRe.exec(value)) !== null) {
                if (m.index > last) frag.appendChild(document.createTextNode(value.slice(last, m.index)));
                var span = document.createElement('span');
                span.setAttribute('data-token', m[0]);
                span.setAttribute('data-order', chipOrder++);
                // 显示去掉零宽定界符、保留内部空格：框内边距由 token 内空格提供（CSS white-space: pre 保留）
                var tokRaw = m[0].replace(/\u200b/g, '');
                var layerRef = _ct.parseLayerToken(m[0]);
                // 项目项 chip（@:c123,f456 —— 项目面板里选中的合成/素材）：标签只说个数（「引用 N 个对象」），
                // 与图层 chip 同款——载荷字形以 visibility:hidden 撑出逐字对齐的宽度，标签居中浮上；
                // 类型、名字与 id 在 hover 浮层里给（_showItemChipPopover）。
                var itemRef = layerRef ? null : _ct.parseItemToken(m[0]);
                // 文件 chip（@ 引用附件）：标签显示「图片N/视频N」（类型 + 同类型文本序编号），
                // **不显示真名**——与图层 chip 同款：载荷字形（@名，
                // 见 chipTokens「名即身份」）以 visibility:hidden 撑宽，标签居中浮上，真名在 hover 浮层。
                var fileRef = (layerRef || itemRef) ? null : _ct.parseFileToken(m[0]);
                if (layerRef) {
                    // 图层 chip：可见标签只说引用了几个图层，与载荷（@compId:layerId[,layerId…]）字符数
                    // 对不齐——载荷以 visibility:hidden 撑出与 textarea 逐字对齐的宽度（建 token 时已按
                    // 标签宽补足内边距，见 chipTokens.innerPadFor），标签居中浮在其上；chip 框用不透明底
                    // 盖住 textarea 画在下层的载荷字形（半透明底会让载荷与标签叠在一起）。
                    // 载荷里相邻同合成合并成一个组（compId 只写一次）：框宽就是载荷宽，压缩直接换来更窄的 chip
                    span.className = 'ae-layer-token';
                    layerOrdinal++;
                    span.setAttribute('data-layer-ordinal', String(layerOrdinal));
                    var layerFill = document.createElement('span');
                    layerFill.className = 'ae-layer-token-fill';
                    layerFill.setAttribute('aria-hidden', 'true');
                    layerFill.appendChild(document.createTextNode(tokRaw));
                    span.appendChild(layerFill);
                    var layerLabelEl = document.createElement('span');
                    layerLabelEl.className = 'ae-layer-token-label';
                    layerLabelEl.textContent = _ct.layerLabel(layerRef.refs.length);
                    span.appendChild(layerLabelEl);
                } else if (itemRef) {
                    // 项目项 chip：标签只说引用了几个对象（合成/素材），引用了哪些在 hover 浮层里给；
                    // 载荷以 visibility:hidden 撑宽（与图层 chip 同款，见 chipTokens.innerPadFor）
                    span.className = 'ae-item-token';
                    itemOrdinal++;
                    span.setAttribute('data-item-ordinal', String(itemOrdinal));
                    var itemFill = document.createElement('span');
                    itemFill.className = 'ae-item-token-fill';
                    itemFill.setAttribute('aria-hidden', 'true');
                    itemFill.appendChild(document.createTextNode(tokRaw));
                    span.appendChild(itemFill);
                    var itemLabelEl = document.createElement('span');
                    itemLabelEl.className = 'ae-item-token-label';
                    itemLabelEl.textContent = _ct.itemLabel(itemRef.items.length);
                    span.appendChild(itemLabelEl);
                } else if (fileRef) {
                    // 文件 chip：标签 = 类型 + 同类型内文本序编号（图片1/视频1…，与 fileLabel 同源，
                    // 与发送解析 resolveFileTokens 的编号口径一致——用户说"图片1"，消息里也是「引用图片1」）
                    span.className = 'ae-file-token';
                    var fk = _ct.fileKind(fileRef.name);
                    fileKindOrdinals[fk] = (fileKindOrdinals[fk] || 0) + 1;
                    span.setAttribute('data-file-kind', fk);
                    span.setAttribute('data-file-ordinal', String(fileKindOrdinals[fk]));
                    var fileFill = document.createElement('span');
                    fileFill.className = 'ae-file-token-fill';
                    fileFill.setAttribute('aria-hidden', 'true');
                    fileFill.appendChild(document.createTextNode(tokRaw));
                    span.appendChild(fileFill);
                    var fileLabelEl = document.createElement('span');
                    fileLabelEl.className = 'ae-file-token-label';
                    fileLabelEl.textContent = _ct.fileLabel(fileRef.name, fileKindOrdinals[fk]);
                    span.appendChild(fileLabelEl);
                } else {
                    span.className = 'ae-code-token';
                    span.appendChild(document.createTextNode(tokRaw));
                }
                // 无 title 属性：避免原生提示与自定义 hover 浮层重叠
                // hover 显示该代码片段的完整内容（浮层，纯文本防注入）
                span.addEventListener('mouseenter', function () {
                    var tok = this.getAttribute('data-token') || '';
                    // 图层 chip：标签只说个数，引用了哪几层必须能查到（同代码 chip 的
                    // "标签短、hover 给全文"口径）
                    var layerRefHover = _chipTokens() ? _chipTokens().parseLayerToken(tok) : null;
                    if (layerRefHover) {
                        _showLayerChipPopover(this, layerRefHover,
                            Number(this.getAttribute('data-layer-ordinal') || '0'));
                        return;
                    }
                    // 项目项 chip：标签只说个数，引用了哪些合成/素材必须能查到（同图层 chip 口径）
                    var itemRefHover = _chipTokens() ? _chipTokens().parseItemToken(tok) : null;
                    if (itemRefHover) {
                        _showItemChipPopover(this, itemRefHover,
                            Number(this.getAttribute('data-item-ordinal') || '0'));
                        return;
                    }
                    // 文件 chip：标签是「图片N」（不显示真名），引的是哪个文件必须能查到
                    // ——与图层 chip 同口径给浮层（真名 + 附件路径；路径读输入区附件，被清空时只剩名）
                    var fileRefHover = _chipTokens() ? _chipTokens().parseFileToken(tok) : null;
                    if (fileRefHover) {
                        _showFileChipPopover(this, fileRefHover,
                            Number(this.getAttribute('data-file-ordinal') || '0'));
                        return;
                    }
                    // 落进下面的代码 chip 分支也无碍：行号正则匹配不上 @ 开头的 token，chipText 为空即返回。
                    var tokRaw = tok.replace(/\u200b/g, '').trim();  // data-token 带零宽定界符+内边距空格，存储的 token 不带
                    var chipText = '';
                    for (var i = 0; i < _pendingCodeChips.length; i++) {
                        if (_pendingCodeChips[i].token === tokRaw) { chipText = _pendingCodeChips[i].text; break; }
                    }
                    // 无内存记录（跨会话粘贴的 chip）：从预览区按行号读取当前代码，保证 hover 有内容
                    if (!chipText) {
                        var mm = /^L(\d+)(?:-L(\d+))?/.exec(tokRaw);
                        if (mm) {
                            var _ls = Number(mm[1]);
                            var _le = mm[2] != null ? Number(mm[2]) : _ls;
                            chipText = _previewLinesOf(_ls, _le);
                        }
                    }
                    if (!chipText) return;
                    _hideChipPopover();
                    var pop = document.createElement('div');
                    pop.className = 'ae-agent-popover';
                    var t = document.createElement('span');
                    t.className = 'popover-title';
                    t.textContent = AEI18n.t('代码片段 ') + tokRaw + AEI18n.t('（点击标签可移除）');
                    pop.appendChild(t);
                    pop.appendChild(document.createTextNode(chipText));
                    document.body.appendChild(pop);
                    _positionChipPopover(pop, this);
                    _chipPopover = pop;
                    clearTimeout(_chipPopTimer);
                    pop.addEventListener('mouseenter', function () { clearTimeout(_chipPopTimer); });
                    pop.addEventListener('mouseleave', function () { _chipPopTimer = setTimeout(_hideChipPopover, 200); });
                });
                span.addEventListener('mouseleave', function () {
                    _chipPopTimer = setTimeout(_hideChipPopover, 200);
                });
                span.addEventListener('click', function (ev) {
                    ev.preventDefault();
                    ev.stopPropagation();
                    var order = Number(this.getAttribute('data-order'));
                    var val = input.value;
                    // 定位文本流中第 order 个 chip：token 可能重复（同一行号/同一图层可多次引用），
                    // 不能用 indexOf 按相同串跳过，须按出现顺序数；
                    // 范围含外部 2 空格（框外占位符属于 chip），点击删除时连占位符一起移除
                    var _ctClick = _chipTokens();
                    if (!_ctClick) return;
                    var _reTok = _ctClick.makeRangeRe();
                    var _m = null;
                    var idx = -1;
                    for (var i2 = 0; i2 <= order; i2++) {
                        _m = _reTok.exec(val);
                        if (!_m) return;
                        idx = _m.index;
                    }
                    var tokLen = _m[0].length;
                    // _pendingCodeChips（仅代码 chip 的 hover 缓存）按**代码 token**的下标移除
                    var codeIdx = _codeChipIndexOf(val, idx, _m[0]);
                    input.focus();
                    try { input.setSelectionRange(idx, idx + tokLen); } catch (_) {}
                    // execCommand 删除选区：进入撤销栈，可 Ctrl+Z 恢复
                    var removed = false;
                    try { removed = document.execCommand('insertText', false, ''); } catch (_) {}
                    if (!removed) {
                        input.value = val.slice(0, idx) + val.slice(idx + tokLen);
                        try { input.setSelectionRange(idx, idx); } catch (_) {}
                    }
                    if (codeIdx >= 0 && codeIdx < _pendingCodeChips.length) _pendingCodeChips.splice(codeIdx, 1);
                    // 点击删除 chip 时同步关闭其 hover 预览浮框（span 移除不触发 mouseleave，浮框会残留）
                    _hideChipPopover();
                    _renderCodeChipOverlay();
                    updatePreviewParticleBrightness();
                });
                frag.appendChild(span);
                last = m.index + m[0].length;
            }
            if (last < value.length) frag.appendChild(document.createTextNode(value.slice(last)));
            overlay.appendChild(frag);
            overlay.scrollTop = input.scrollTop;
        }
        // 发送时把文本中的 token 原位替换为行号引用（不嵌代码全文）：
        // 预览区代码可能随后变化、且相同代码片段易混淆，故只给行数，
        // LLM 需要时用行号读取工具按行号读取。
        // 不依赖 _pendingCodeChips 记录：本会话添加或跨会话粘贴来的 token 都按行号解析。
        // 按当前 runtimeMode 选择行号读取工具名——shader 模式下
        // get_current_script（module:script scope）未注册，对应工具为
        // get_current_shader（module:shader），硬编码会把 LLM 指向不存在的工具。
        // 模式取自 runtimeModeSwitch 的 dataset.modeIndex（与 getCurrentSettingsFromUI
        // 及预览区右键菜单同款途径，模式切换入口即时同步）。与
        // engine/controller/chatViewHelpers.js resolveChipTokensForLlm 同步实现
        // （两处分属 app/engine 层无法共享，改动须两处同步）。
        function _resolveCodeChipTokens(text) {
            if (!text) return text;
            var modeSw = document.getElementById('runtimeModeSwitch');
            var modeIdx = modeSw ? parseInt(modeSw.dataset.modeIndex || '0', 10) : 0;
            // agent 模式下两个行号读取工具均未注册（get_current_script 为
            // module:script、get_current_shader 为 module:shader），指向任一都会把 LLM
            // 引向不存在的工具——改用中性提示（chip 仅经跨会话粘贴/编辑重发到达此模式）
            var mode = null;
            if (modeIdx === 4) {
                // 团队档（第 5 档）没有单一档位：本轮身份按**当前 lane** 取。
                // glsl lane 的 slot 是 shader（指引 get_current_shader），导演/AE 执行两条 lane 的
                // 集合是 ['agent','team']（两件行号读取工具都不在）；三档表只有 3 项，idx=4 取到
                // undefined 落到 else —— 给 glsl lane 指了个它没有的 script 工具。
                var ri = (window.AEEngine && typeof window.AEEngine.roundIdentity === 'function')
                    ? window.AEEngine.roundIdentity() : null;
                var ids = (ri && ri.ids) ? ri.ids : [];
                mode = (ids.indexOf('shader') >= 0) ? 'shader' : 'agent';
            } else {
                mode = ['script', 'agent', 'shader'][modeIdx];
            }
            var guide = mode === 'shader' ? '可调 get_current_shader 工具读取'
                : mode === 'agent' ? 'Agent 模式无行号读取工具，需切换到 Script/Shader 模式读取'
                : '可调 get_current_script 工具读取';
            return text.replace(/\u200b {2}(L\d+(?:-L\d+)?(?:\(\d+\))?) {2}\u200b/g, function (m, label) {
                // 解析行号（token 可能带历史重名后缀 (N)，行号不变）
                var mm = /^L(\d+)(?:-L(\d+))?/.exec(label);
                var s = mm ? Number(mm[1]) : 0;
                var e = mm && mm[2] != null ? Number(mm[2]) : s;
                if (e > s) return '（预览区 L' + s + '-L' + e + ' 行代码，' + guide + '）';
                return '（预览区 L' + s + ' 行代码，' + guide + '）';
            });
        }
        // 文本里是否含 chip token（代码行号引用或图层引用）——决定发送时是否需要走解析路径
        function _hasChipTokens(text) {
            if (!text) return false;
            var ct = _chipTokens();
            if (!ct) return /\u200b {2}L\d+/.test(text);
            return ct.makeScanRe().test(text);   // 每次新建实例：全局正则无 lastIndex 残留
        }
        // 发送用的完整解析：先解析图层引用（原位替换成"引用图层N：layerId=.., compositionId=.."，
        // 多条时一个括号里给全），再解析项目项引用（"引用对象N：合成 compositionId=..；素材 footageId=.."），
        // 再解析文件引用（"引用图片N：名，路径 .."——路径来自输入区附件，附件此刻还在，故按名查得到），
        // 最后解析代码行号引用（模式相关的工具指引）。token 由语法模块解析，
        // 与 engine 侧 chatViewHelpers.resolveChipTokensForLlm（编辑重发）同源。
        // 顺序与 chipTokens 的分支顺序同向（图层 → 项目项 → 文件），两侧口径不许分叉。
        function _resolveChipTokens(text) {
            if (!text) return text;
            var ct = _chipTokens();
            if (!ct) return _resolveCodeChipTokens(text);
            return _resolveCodeChipTokens(ct.resolveFileTokens(ct.resolveItemTokens(ct.resolveLayerTokens(text)), _filePathsByName));
        }
        // 代码片段 chip hover 浮层（复用 .ae-agent-popover）
        var _chipPopover = null;
        var _chipPopTimer = null;
        function _hideChipPopover() {
            if (_chipPopover) {
                _chipPopover.remove();
                _chipPopover = null;
            }
        }
        function _positionChipPopover(pop, anchor) {
            var r = anchor.getBoundingClientRect();
            var pw = pop.offsetWidth || 320;
            var left = Math.min(r.left, window.innerWidth - pw - 8);
            if (left < 8) left = 8;
            pop.style.left = left + 'px';
            pop.style.top = (r.bottom + 6) + 'px';
        }
        // chip token 语法（utils/chipTokens.js，app/engine 两层的唯一语法源）经 global 取
        function _chipTokens() {
            return (window.AEAgentApp && window.AEAgentApp.chipTokens) || null;
        }
        // 图层 chip 的 hover 浮层：标签只说个数，引用了哪几层在这里给全（名 + 两个稳定键）。
        // 纯文本节点拼装，防注入。给用户看的只有「引用了哪几层」，定位口径属实现细节，不上浮层。
        function _showLayerChipPopover(anchor, parsed, ordinal) {
            _hideChipPopover();
            var refs = (parsed && parsed.refs) || [];
            // 名不在 token 载荷里（见 chipTokens.js 的口径）：本会话点出来的引用在缓存里留有名字，
            // 跨会话粘贴来的 token 只能给 id——那不是失效，id 才是定位键
            var names = _layerRefNames[_chipPayloadKey(refs)];
            var lines = [];
            for (var i = 0; i < refs.length; i++) {
                // 名有两个来源，按可信度取：token 自带（旧形态 token 的载荷里有名）> 本会话缓存 >
                // 没有（跨会话粘贴来的新形态 token 只有 id——id 才是定位键，名字缺了不影响引用）。
                // token 自带的名是**外部数据**（旧 token 的名允许含换行/制表），过一遍 sanitizeName，
                // 否则浮层会被撑成多行
                var ct = _chipTokens();
                var nmText = refs[i].name
                    ? (ct ? ct.sanitizeName(refs[i].name) : refs[i].name)
                    : ((names && names[i]) || '');
                var nm = nmText ? '「' + nmText + '」' : '';
                lines.push((i + 1) + '. ' + nm
                    + 'layerId=' + refs[i].layerId + '，compositionId=' + refs[i].compositionId);
            }
            var pop = document.createElement('div');
            pop.className = 'ae-agent-popover';
            var t = document.createElement('span');
            t.className = 'popover-title';
            t.textContent = (ordinal > 0 ? AEI18n.t('第 ') + ordinal + AEI18n.t(' 个引用：') : '')
                + refs.length + AEI18n.t(' 个图层（点击标签可移除）');
            pop.appendChild(t);
            pop.appendChild(document.createTextNode(lines.join('\n')));
            document.body.appendChild(pop);
            _positionChipPopover(pop, anchor);
            _chipPopover = pop;
            clearTimeout(_chipPopTimer);
            pop.addEventListener('mouseenter', function () { clearTimeout(_chipPopTimer); });
            pop.addEventListener('mouseleave', function () { _chipPopTimer = setTimeout(_hideChipPopover, 200); });
        }
        // 项目项 chip 的 hover 浮层：标签只说个数，引用了哪些合成/素材在这里给全（类型、名、id）。
        // 纯文本节点拼装，防注入。给用户看的是「引用了哪些对象」，定位参数名（compositionId/
        // footageId）属实现细节，不上浮层——与图层 chip 浮层同口径。
        function _showItemChipPopover(anchor, parsed, ordinal) {
            _hideChipPopover();
            var items = (parsed && parsed.items) || [];
            // 名不在 token 载荷里（见 chipTokens.js 的口径）：本会话点出来的引用在缓存里留有名字，
            // 跨会话粘贴来的 token 只能给类型与 id——id 才是定位键，名字缺了不影响引用
            var names = _itemRefNames[_itemPayloadKey(items)];
            var lines = [];
            for (var i = 0; i < items.length; i++) {
                var nmText = (names && names[i]) || '';
                var nm = nmText ? '「' + nmText + '」' : '';
                lines.push((i + 1) + '. ' + nm + (items[i].type === 'comp' ? AEI18n.t('合成') : AEI18n.t('素材'))
                    + '（id=' + items[i].id + '）');
            }
            var pop = document.createElement('div');
            pop.className = 'ae-agent-popover';
            var t = document.createElement('span');
            t.className = 'popover-title';
            t.textContent = (ordinal > 0 ? AEI18n.t('第 ') + ordinal + AEI18n.t(' 个引用：') : '')
                + items.length + AEI18n.t(' 个项目对象（点击标签可移除）');
            pop.appendChild(t);
            pop.appendChild(document.createTextNode(lines.join('\n')));
            document.body.appendChild(pop);
            _positionChipPopover(pop, anchor);
            _chipPopover = pop;
            clearTimeout(_chipPopTimer);
            pop.addEventListener('mouseenter', function () { clearTimeout(_chipPopTimer); });
            pop.addEventListener('mouseleave', function () { _chipPopTimer = setTimeout(_hideChipPopover, 200); });
        }
        // 文件 chip 的 hover 浮层：标签只说「图片N」，引的是哪个文件
        // 必须能查到（与图层 chip 的「标签短、hover 给全文」同口径）。真名 + 附件路径——路径读输入区
        // 附件（_fileChipEntries，与发送解析同源）；附件已被清空（编辑重发/跨会话粘贴）时只剩名，
        // 名就是身份，够不着路径不猜（与 resolveFileTokens 的 lookup 缺席口径一致）。
        function _showFileChipPopover(anchor, parsed, ordinal) {
            _hideChipPopover();
            var ct = _chipTokens();
            var rawName = String(parsed && parsed.name || '');
            var name = ct && typeof ct.sanitizeName === 'function' ? ct.sanitizeName(rawName) : rawName;
            var label = ct && typeof ct.fileLabel === 'function' ? ct.fileLabel(rawName, ordinal) : AEI18n.t('文件{index}', { index: ordinal });
            var paths = [];
            try {
                var entries = _fileChipEntries();
                for (var i = 0; i < entries.length; i++) {
                    if (entries[i].name === rawName && entries[i].path) paths.push(entries[i].path);
                }
            } catch (_) {}
            var pop = document.createElement('div');
            pop.className = 'ae-agent-popover';
            var t = document.createElement('span');
            t.className = 'popover-title';
            t.textContent = label + AEI18n.punct('：', ': ') + name + AEI18n.t('（点击标签可移除）');
            pop.appendChild(t);
            if (paths.length) pop.appendChild(document.createTextNode('\n' + AEI18n.t('路径') + ' ' + paths.join(AEI18n.punct('；', '; ', '、'))));
            document.body.appendChild(pop);
            _positionChipPopover(pop, anchor);
            _chipPopover = pop;
            clearTimeout(_chipPopTimer);
            pop.addEventListener('mouseenter', function () { clearTimeout(_chipPopTimer); });
            pop.addEventListener('mouseleave', function () { _chipPopTimer = setTimeout(_hideChipPopover, 200); });
        }
        // 计算 [start, end) 在代码文本中覆盖的行号范围，如 "L1-L34"；单行返回 "L5"
        function _lineNumAt(value, idx) {
            var n = 1;
            var len = value.length;
            for (var i = 0; i < idx && i < len; i++) if (value.charCodeAt(i) === 10) n++;
            return n;
        }
        function _lineLabelOf(value, start, end) {
            var s = _lineNumAt(value, start);
            var e = _lineNumAt(value, end);
            // end 恰好在行首（前一个字符是换行，选中内容不含该换行）→ 归并到上一行
            if (end > start && end > 0 && value.charCodeAt(end - 1) === 10) e--;
            if (e < s) e = s;
            return s === e ? 'L' + s : 'L' + s + '-L' + e;
        }
        // 从预览区按行号范围 [s, e]（1-based 含端点）读取代码片段：
        // 供无内存记录的 chip（跨会话粘贴）hover 预览使用，行号超出范围时返回空
        function _previewLinesOf(s, e) {
            var pv = document.getElementById('scriptPreview');
            if (!pv || !pv.value) return '';
            var lines = pv.value.split('\n');
            if (s < 1 || s > lines.length) return '';
            return lines.slice(s - 1, Math.max(e, s)).join('\n');
        }
        function _addCodeChip(sourceName, text, lineLabel) {
            if (!text) return;
            _codeChipSeq++;
            // token 用行号范围命名（L1-L34）用于 chip 显示与 hover 定位；
            // 同一行号可被重复引用（引用同段代码多次），token 允许重复，不再追加序号
            var token = lineLabel || ('代码' + _codeChipSeq);
            _pendingCodeChips.push({ token: token, text: text });
            // 多字符 token 插入（overlay 透明文本副本与 textarea 逐字对齐）；
            // 原子编辑行为（光标不可进入 token 内部）由 keydown 拦截实现。
            // token 内部两侧 2 空格 = 框内边距；token 外部两侧 2 空格 = 框外间隙
            _insertChipToken('  \u200b  ' + token + '  \u200b  ');
        }
        // 在光标处插入一个 chip token（代码 chip、图层 chip、文件 chip 共用同一套插入/撤销语义）。
        // range 给定（{start, end}）时替换该区间而不是插入——@ 文件引用要把「@ + 已输入串」整段换掉。
        function _insertChipToken(tokenText, range) {
            if (!tokenText) return false;
            var input = document.getElementById('aeAgentInput');
            if (!input) return false;
            // 插入位置：优先实时光标（焦点在输入框）；失焦时（如右键菜单来自预览区、
            // 或点击「当前选中」时焦点在工具栏）用 blur 时记住的最后光标位置，
            // 避免 chip 总被追加到文本尾部
            var isFocused = document.activeElement === input;
            var start, end;
            if (range && typeof range.start === 'number') {
                start = Math.max(0, Math.min(range.start, input.value.length));
                end = Math.max(start, Math.min(typeof range.end === 'number' ? range.end : start, input.value.length));
            } else if (isFocused) {
                start = input.selectionStart != null ? input.selectionStart : input.value.length;
                end = input.selectionEnd != null ? input.selectionEnd : input.value.length;
            } else if (_lastInputSelection) {
                start = Math.min(_lastInputSelection.start, input.value.length);
                end = Math.min(_lastInputSelection.end, input.value.length);
            } else {
                start = end = input.value.length;
            }
            input.focus();
            try { input.setSelectionRange(start, end); } catch (_) {}
            // execCommand 插入：与真实输入同撤销栈，Ctrl+Z 可撤回且不破坏既有撤销历史；
            // 不可用时回退直接赋值（无法撤销，但不中断功能）
            var inserted = false;
            try { inserted = document.execCommand('insertText', false, tokenText); } catch (_) {}
            if (!inserted) {
                input.value = input.value.slice(0, start) + tokenText + input.value.slice(end);
                _renderCodeChipOverlay();
                updatePreviewParticleBrightness();
            }
            var pos = start + tokenText.length;
            try { input.setSelectionRange(pos, pos); } catch (_) {}
            input.focus();
            _renderCodeChipOverlay();
            updatePreviewParticleBrightness();
            return true;
        }
        // 量测一段文本在输入框字体下的像素宽：与 textarea/overlay 同字号同字体（agent.css 里
        // 这两处的字体/行高/折行规则是逐字对齐的前提，故一律从这里取计算样式，不另写字号）。
        // 用途：内边距补宽（chip 框宽由 token 文本宽决定，标签宽由字数决定，两者自然不相等）。
        function _measureChipText(text) {
            var probe = document.createElement('span');
            probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;'
                + 'white-space:pre;pointer-events:none';
            var ref = document.getElementById('aeAgentInput');
            if (ref && window.getComputedStyle) {
                var cs = window.getComputedStyle(ref);
                probe.style.font = cs.font || '';
                probe.style.fontFamily = cs.fontFamily;
                probe.style.fontSize = cs.fontSize;
                probe.style.fontWeight = cs.fontWeight;
                probe.style.fontStyle = cs.fontStyle;
                probe.style.letterSpacing = cs.letterSpacing;
            }
            probe.textContent = text == null ? '' : String(text);
            var host = document.getElementById('aeAgentInputWrap') || document.body;
            host.appendChild(probe);
            var w = probe.getBoundingClientRect ? probe.getBoundingClientRect().width : 0;
            if (probe.remove) probe.remove(); else if (probe.parentNode) probe.parentNode.removeChild(probe);
            return Number(w) || 0;
        }
        // 载荷 → 会话内的图层名缓存（名不进 token：见 chipTokens.js 的口径）。粘贴来的 token
        // 查不到就是查不到，不回退凭猜。
        // key 由语法模块的 layerPayload 产出（与 token 载荷同一生产者），存取两侧都走本函数——
        // 各写一份就会错位一次（存的是 `@a:b`、查的是 `a:b`，hover 永远查不到名）。
        var _layerRefNames = {};
        function _chipPayloadKey(refs) {
            var ct = _chipTokens();
            return ct ? ct.layerPayload(refs || []) : '';
        }
        // 同上，项目项 chip 的名字缓存（key 由语法模块的 itemPayload 产出，存取两侧同一生产者）
        var _itemRefNames = {};
        function _itemPayloadKey(items) {
            var ct = _chipTokens();
            return ct ? ct.itemPayload(items || []) : '';
        }
        // 输入框一行的可用宽（px）= textarea 内容宽（clientWidth 含 padding，要减掉）。
        // 用途：token 宽过一行时 textarea 会从 token 中间断行、overlay 的 chip 不会断，两者行数
        // 不一致 → chip 框盖到别的文本上（实测 10 条@300px）。据此切段见 chipTokens.buildLayerTokens。
        function _inputLineWidth() {
            var input = document.getElementById('aeAgentInput');
            if (!input) return 0;
            var w = Number(input.clientWidth) || 0;
            if (w && window.getComputedStyle) {
                var cs = window.getComputedStyle(input);
                w -= (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
            }
            return w > 0 ? w : 0;
        }
        // 图层引用 chip 插入（「当前选中」点击 → engine/bootstrap 经 window.AEAgentApp 调用）：
        // refs = gatherSelectedRefs 的整个选中列表（compositionId/layerId/name/...）。
        // **一次点击 = 一条 chip**：AE 里选中 N 层就得到「引用 N 个图层」一条，而不是 N 条各引用一层
        //（位置语义仍在：多条引用可插在同一句的不同位置）。选中很多层时按行宽切成几条插在同一处，
        // 否则一条超宽 token 会被 textarea 从中间断行而 chip 不断（见 _inputLineWidth）。
        // 缺稳定键的条目（旧版 AE 无 Layer.id/Item.id）被丢弃并计入 dropped——退回位置键的引用会随
        // 增删/重排指到别的层，宁可不建。返回 { chips, refs, dropped } 供调用方组装提示文案。
        function _addLayerRefChips(refs) {
            var result = { chips: 0, refs: 0, dropped: 0 };
            var ct = _chipTokens();
            if (!ct || !refs || !refs.length) return result;
            var built = ct.buildLayerTokens(refs, {
                measure: _measureChipText,
                maxWidth: _inputLineWidth()
            });
            result.dropped = built.dropped;
            if (!built.tokens.length) return result;
            // 名按实际收下的条目对齐（丢 id 的与重复的都不在 entries 里），否则 hover 浮层会把名字
            // 安到别的层上——比没有名字更坏。先按 id 建表再逐条取，不靠遍历顺序。
            var nameByKey = {};
            for (var i = 0; i < refs.length; i++) {
                var key = Math.floor(Number(refs[i] && refs[i].compositionId)) + ':'
                    + Math.floor(Number(refs[i] && refs[i].layerId));
                if (!nameByKey[key]) nameByKey[key] = ct.sanitizeName(refs[i] && refs[i].name);
            }
            for (var t = 0; t < built.tokens.length; t++) {
                var item = built.tokens[t];
                if (!_insertChipToken(item.token)) break;
                result.chips++;
                result.refs += item.count;
                var names = [];
                for (var j = 0; j < item.entries.length; j++) {
                    names.push(nameByKey[item.entries[j].compositionId + ':' + item.entries[j].layerId] || '');
                }
                _layerRefNames[_chipPayloadKey(item.entries)] = names;
            }
            return result;
        }
        window.AEAgentApp = window.AEAgentApp || {};
        window.AEAgentApp.addLayerRefChips = _addLayerRefChips;
        // 项目项引用 chip 插入（「当前选中」点击 → engine/bootstrap 经 window.AEAgentApp 调用）：
        // refs = gatherSelectedItemRefs 的整个选中列表（itemId/itemType/name/...）。
        // 与图层 chip 同款：一次点击 = 一条 chip（选中的 N 个对象合成一条「引用 N 个对象」，
        // 超一行宽时按行宽切成几条）；itemType 只认 comp/footage——文件夹不可引用（工具面没有按
        // 文件夹定位/操作的参数），计入 skipped；缺 id 的条目（旧版 AE 无 Item.id）计入 dropped。
        // 两类条目一律不建引用（宁可不建，也不建一条用不上的引用）。返回 { chips, refs, dropped, skipped }。
        function _addItemRefChips(refs) {
            var result = { chips: 0, refs: 0, dropped: 0, skipped: 0 };
            var ct = _chipTokens();
            if (!ct || !refs || !refs.length) return result;
            var built = ct.buildItemTokens(refs, {
                measure: _measureChipText,
                maxWidth: _inputLineWidth()
            });
            result.dropped = built.dropped;
            result.skipped = built.skipped;
            if (!built.tokens.length) return result;
            // 名按实际收下的条目对齐（丢 id 的 / 文件夹 / 重复的都不在 entries 里），否则 hover 浮层会把
            // 名字安到别的对象上——比没有名字更坏。先按 id 建表再逐条取，不靠遍历顺序（Item.id 全工程唯一）。
            var nameById = {};
            for (var i = 0; i < refs.length; i++) {
                var rid = Math.floor(Number(refs[i] && refs[i].itemId));
                if (!(rid > 0)) continue;
                if (!nameById[rid]) nameById[rid] = ct.sanitizeName(refs[i] && refs[i].name);
            }
            for (var t = 0; t < built.tokens.length; t++) {
                var item = built.tokens[t];
                if (!_insertChipToken(item.token)) break;
                result.chips++;
                result.refs += item.count;
                var names = [];
                for (var j = 0; j < item.entries.length; j++) {
                    names.push(nameById[item.entries[j].id] || '');
                }
                _itemRefNames[_itemPayloadKey(item.entries)] = names;
            }
            return result;
        }
        window.AEAgentApp.addItemRefChips = _addItemRefChips;
        // ── chip 原子编辑：光标不可进入 token 内部，chip 视为单个整体 ──
        // token（零宽定界符 \u200b 包裹、内部两侧各 2 空格为框内边距，外部普通空格为框外间隙）
        // 在 textarea 中是多字符普通文本，以下拦截让 chip 行为像单个字符：
        // 方向键跳过整个 chip、退格/删除整体删除 chip、字符输入（含粘贴/IME 首键）阻止。
        function _tokenRangeAt(value, pos) {
            // 原子范围含 token 外部两侧 2 空格（框外占位符属于 chip）：占位符同样不可被单独选中/删除。
            // 两种 chip（代码行号引用 / 图层引用）共用一套范围正则（语法模块单一真源）
            var _ctRange = _chipTokens();
            if (!_ctRange) return null;
            var re = _ctRange.makeRangeRe();
            var m, order = 0;
            while ((m = re.exec(value)) !== null) {
                // pos <= end：光标停在 chip 末尾也算命中，退格才能整体删除（否则原生退格只删掉尾部空格/定界符残留）
                if (pos >= m.index && pos <= m.index + m[0].length) {
                    return { start: m.index, end: m.index + m[0].length, order: order, token: m[0] };
                }
                order++;
            }
            return null;
        }
        function _removeChipAt(input, range) {
            var val = input.value;
            // range.order 是**全部 chip** 的次序；_pendingCodeChips 只登记代码 chip，
            // 故按"这条之前有几个代码 chip"换算下标（图层 chip 混排时不占该数组）
            var codeIdx = _codeChipIndexOf(val, range.start, range.token);
            input.focus();
            try { input.setSelectionRange(range.start, range.end); } catch (_) {}
            var removed = false;
            try { removed = document.execCommand('insertText', false, ''); } catch (_) {}
            if (!removed) {
                input.value = val.slice(0, range.start) + val.slice(range.end);
                try { input.setSelectionRange(range.start, range.start); } catch (_) {}
            }
            if (codeIdx >= 0 && codeIdx < _pendingCodeChips.length) _pendingCodeChips.splice(codeIdx, 1);
            _renderCodeChipOverlay();
            updatePreviewParticleBrightness();
        }
        // 该 chip（含图层 chip / 文件 chip 混排）在 _pendingCodeChips 里的下标；它本身不是代码 chip 时返回 -1
        //（引用类 chip 不占该数组——直接按混合次序删会删错一条代码 chip 的 hover 缓存）
        function _codeChipIndexOf(value, tokenStart, tokenText) {
            var ct = _chipTokens();
            if (!ct || ct.isRefToken(tokenText)) return -1;
            var count = 0;
            String(value || '').slice(0, tokenStart).replace(ct.makeScanRe(), function (w) {
                if (!ct.isRefToken(w)) count++;
                return w;
            });
            return count;
        }
        // 选区任一端落在 token 内部时吸附到 token 边缘（chip 整体不可分割）：
        // 跨过 chip 的选区包含整个 chip，选在 chip 内则扩到整个 chip
        function _snapSelectionToTokens() {
            var s = agentInput.selectionStart;
            var e = agentInput.selectionEnd;
            if (s === e || s == null || e == null) return;
            var changed = false;
            var rs = _tokenRangeAt(agentInput.value, s);
            if (rs && s > rs.start && s < rs.end) { s = rs.start; changed = true; }
            var re = _tokenRangeAt(agentInput.value, e);
            if (re && e > re.start && e < re.end) { e = re.end; changed = true; }
            if (changed) {
                try { agentInput.setSelectionRange(s, e); } catch (_) {}
            }
        }
        // 光标落在 token 内部时吸出到 token **起点**（token 内部不可停留：一旦停进去，打字/粘贴会把
        // token 从中间劈开，引用静默失效——chip 从 overlay 消失、发送文本里只剩载荷碎片）。
        // 统一吸到起点而不是「最近边界」：若吸到终点，紧接着的退格会吃掉 token 末尾的零宽定界符，
        // token 同样作废（吸到起点则退格只删它前面的框外空格）。
        // 上下键/Home/End/翻页键的移动是浏览器默认动作，keydown 拦不到结果，故放行后用 0ms 定时器吸附。
        function _snapCaretOutOfTokens() {
            if (agentInput.selectionStart !== agentInput.selectionEnd) return;   // 选区（拖选/扩选）不动
            var pos = agentInput.selectionStart;
            if (pos == null) return;
            var range = _tokenRangeAt(agentInput.value, pos);
            if (!range || pos <= range.start || pos >= range.end) return;
            try { agentInput.setSelectionRange(range.start, range.start); } catch (_) {}
        }
        agentInput.addEventListener('keydown', function (e) {
            var key = e.key;
            // Shift+导航键扩展选区：选区任一端已进入 token 内部时阻止本次移动并吸附（键盘选择同样不可选中 chip 内部）
            if (e.shiftKey && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp'
                || key === 'ArrowDown' || key === 'Home' || key === 'End'
                || key === 'PageUp' || key === 'PageDown')) {
                var _s0 = agentInput.selectionStart;
                var _e0 = agentInput.selectionEnd;
                var _r1 = _tokenRangeAt(agentInput.value, _s0);
                var _r2 = _tokenRangeAt(agentInput.value, _e0);
                if ((_r1 && _s0 > _r1.start && _s0 < _r1.end) || (_r2 && _e0 > _r2.start && _e0 < _r2.end)) {
                    e.preventDefault();
                    _snapSelectionToTokens();
                    return;
                }
            }
            // 上下键/Home/End/翻页键：默认动作会把光标（或 Shift 扩选的端点）送进 token 内部，
            // keydown 拦不到结果，故放行后吸附出来
            if (key === 'ArrowUp' || key === 'ArrowDown' || key === 'Home' || key === 'End'
                || key === 'PageUp' || key === 'PageDown') {
                setTimeout(e.shiftKey ? _snapSelectionToTokens : _snapCaretOutOfTokens, 0);
                return;
            }
            // 仅处理无选区时的光标原子行为；拖选（跨 chip）编辑不拦截
            if (agentInput.selectionStart !== agentInput.selectionEnd) return;
            var pos = agentInput.selectionStart;
            var range = _tokenRangeAt(agentInput.value, pos);
            if (!range) return;
            if (key === 'ArrowLeft') {
                if (pos > range.start) { e.preventDefault(); try { agentInput.setSelectionRange(range.start, range.start); } catch (_) {} }
                return;
            }
            if (key === 'ArrowRight') {
                if (pos < range.end) { e.preventDefault(); try { agentInput.setSelectionRange(range.end, range.end); } catch (_) {} }
                return;
            }
            // 光标在 token 内部：退格/删除 = 整体删除 chip；其余编辑键阻止
            if (pos > range.start && pos < range.end) {
                if (key === 'Backspace' || key === 'Delete') { e.preventDefault(); _removeChipAt(agentInput, range); }
                else if (!e.ctrlKey && !e.metaKey && !e.altKey && !e.isComposing) e.preventDefault();
                return;
            }
            // 光标停在 token 末尾按退格 / 停在 token 开头按 Delete = 整体删除 chip
            if (pos === range.end && key === 'Backspace') { e.preventDefault(); _removeChipAt(agentInput, range); return; }
            if (pos === range.start && key === 'Delete') { e.preventDefault(); _removeChipAt(agentInput, range); return; }
        });
        // 点击把光标放进 token 内部（边缘缝隙）时，就近归位到 token 开头
        agentInput.addEventListener('click', function () {
            if (agentInput.selectionStart !== agentInput.selectionEnd) return;
            var pos = agentInput.selectionStart;
            var range = _tokenRangeAt(agentInput.value, pos);
            if (range && pos > range.start && pos < range.end) {
                try { agentInput.setSelectionRange(range.start, range.start); } catch (_) {}
            }
        });
        // 拖选结束修正选区：chip 视为整体，内部文字无法被单独选中（跨过 chip 的选区包含整个 chip）
        agentInput.addEventListener('mouseup', function () {
            _snapSelectionToTokens();
        });
        // 输入/滚动时同步 overlay（token 随文本流变化；清空输入也会经 input 事件重渲染）
        agentInput.addEventListener('input', function () {
            _renderCodeChipOverlay();
        });
        agentInput.addEventListener('scroll', function () {
            var ov = document.getElementById('aeAgentCodeChipOverlay');
            if (ov) ov.scrollTop = agentInput.scrollTop;
        });
        // 失焦记录最后光标位置（预览区右键添加 chip 时插入到该处）；聚焦后清除（改用实时光标）
        agentInput.addEventListener('blur', function () {
            _lastInputSelection = {
                start: agentInput.selectionStart != null ? agentInput.selectionStart : 0,
                end: agentInput.selectionEnd != null ? agentInput.selectionEnd : 0
            };
        });
        agentInput.addEventListener('focus', function () {
            _lastInputSelection = null;
        });
        // ── 预览区右键菜单：添加选中代码到对话 / 复制选中代码 ──
        // 通用实现：script 预览区与 shader 编辑区共用。绑定到目标 textarea，
        // 有选区时右键弹出菜单。「添加到对话」仅 Script 模式启用（Agent/Shader 模式下
        // LLM 看不到预览区，行数引用无效），故 shader 编辑区右键只保留「复制选中代码」。
        function _bindPreviewContextMenu(targetEl) {
            let _previewContextMenu = null;
            function _hidePreviewContextMenu() {
                if (_previewContextMenu) {
                    _previewContextMenu.remove();
                    _previewContextMenu = null;
                }
            }
            function _showPreviewContextMenu(clientX, clientY, hasSelection) {
                _hidePreviewContextMenu();
                const menu = document.createElement('div');
                menu.className = 'ae-context-menu';
                menu.style.display = 'block';
                const items = [];
                if (hasSelection) {
                    const modeSw = document.getElementById('runtimeModeSwitch');
                    const _modeIdx = modeSw ? parseInt(modeSw.dataset.modeIndex || '0', 10) : 0;
                    // 「添加到对话」仅 Agent 模式禁用：Agent 模式 LLM 看不到预览区
                    // （get_current_script 工具仅在 Script 模式注册）；Script 用
                    // get_current_script、Shader 用 get_current_shader 均可读预览区，
                    // 行数引用有效，故均可启用。
                    if (_modeIdx !== 1) {
                        items.push({ label: AEI18n.t('添加到对话'), action: 'append-selection' });
                        items.push({ sep: true });
                    }
                    items.push({ label: AEI18n.t('复制选中代码'), action: 'copy-selection' });
                }
                items.forEach(it => {
                    if (it.sep) {
                        const sep = document.createElement('div');
                        sep.className = 'context-menu-sep';
                        menu.appendChild(sep);
                        return;
                    }
                    const el = document.createElement('div');
                    el.className = 'context-menu-item';
                    el.textContent = it.label;
                    el.dataset.action = it.action;
                    menu.appendChild(el);
                });
                document.body.appendChild(menu);
                // 定位（避免溢出屏幕）
                const rect = menu.getBoundingClientRect();
                let x = clientX, y = clientY;
                if (x + rect.width > window.innerWidth) x = window.innerWidth - rect.width - 4;
                if (y + rect.height > window.innerHeight) y = window.innerHeight - rect.height - 4;
                menu.style.left = x + 'px';
                menu.style.top = y + 'px';
                _previewContextMenu = menu;
            }
            targetEl.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const start = targetEl.selectionStart;
                const end = targetEl.selectionEnd;
                const hasSelection = end > start;
                // 无选区不弹菜单（原「添加全部代码」选项已移除，无选区无可用操作）
                if (!hasSelection) return;
                _showPreviewContextMenu(e.clientX, e.clientY, hasSelection);
            });
            // 菜单项点击委托
            document.addEventListener('click', (e) => {
                if (!_previewContextMenu) return;
                const item = e.target.closest('.context-menu-item');
                if (!item || !_previewContextMenu.contains(item)) {
                    _hidePreviewContextMenu();
                    return;
                }
                const action = item.dataset.action;
                _hidePreviewContextMenu();
                if (action === 'append-selection') {
                    const start = targetEl.selectionStart;
                    const end = targetEl.selectionEnd;
                    const sel = targetEl.value.substring(start, end);
                    if (sel) {
                        _addCodeChip('选中代码', sel, _lineLabelOf(targetEl.value, start, end));
                    }
                } else if (action === 'copy-selection') {
                    const start = targetEl.selectionStart;
                    const end = targetEl.selectionEnd;
                    const sel = targetEl.value.substring(start, end);
                    if (sel) {
                        try { navigator.clipboard.writeText(sel); } catch (_) {}
                    }
                }
            });
            // 其他地方点击/右键 → 关闭菜单
            document.addEventListener('mousedown', (e) => {
                if (_previewContextMenu && !_previewContextMenu.contains(e.target)) _hidePreviewContextMenu();
            });
            document.addEventListener('scroll', _hidePreviewContextMenu, true);
        }
        _bindPreviewContextMenu(scriptPreviewEl);
        if (shaderCodeEl) _bindPreviewContextMenu(shaderCodeEl);


        const overlayEl = document.getElementById('scriptHighlight');
        let editorFontSize = 12;
        const MIN_FONT_SIZE = 8;
        const MAX_FONT_SIZE = 32;

        const applyEditorFontSize = (size) => {
            editorFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, size));
            const px = editorFontSize + 'px';
            const lh = Math.round(editorFontSize * 1.5) + 'px';
            scriptPreviewEl.style.fontSize = px;
            scriptPreviewEl.style.lineHeight = lh;
            if (overlayEl) {
                overlayEl.style.fontSize = px;
                overlayEl.style.lineHeight = lh;
            }
        };

        scriptPreviewEl.addEventListener('wheel', (e) => {
            if (e.ctrlKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -1 : 1;
                applyEditorFontSize(editorFontSize + delta);
            }
        }, { passive: false });
    }

    // bindPreviewResizeObservers → service.js bind() 处理
    bindButtonAnimations();
    } catch(e) { console.error('[Agent] bindEvents 内部错误:', e, e.stack); }
}

// 反思审阅面板已拆至 app/reflectReviewPanel.js（AEAgentApp.reflectPanel）

let csInterfaceScript = null;

// 按需加载 CSInterface 脚本，兼容宿主环境中脚本晚于模块初始化的场景。
function loadCsInterfaceIfNeeded(callback) {
    if (llmHostBridgeAdapter && typeof llmHostBridgeAdapter.loadCsInterfaceIfNeeded === 'function') {
        llmHostBridgeAdapter.loadCsInterfaceIfNeeded({
            callback,
            document
        });
        return;
    }

    if (typeof CSInterface !== 'undefined') {
        if (callback) callback();
        return;
    }
    csInterfaceScript = document.createElement('script');
    csInterfaceScript.src = 'vendor/CSInterface.js';
    csInterfaceScript.onload = () => {
        setTimeout(() => {
            if (callback) callback();
        }, 200);
    };
    csInterfaceScript.onerror = () => {
        setTimeout(() => {
            if (callback) callback();
        }, 200);
    };
    document.head.appendChild(csInterfaceScript);
}

// 模块初始化总入口：恢复设置、绑定事件、加载宿主桥与粒子效果
// 初始化模块：恢复设置、绑定事件、启动布局与粒子/高亮子系统。
async function init(context) {
    // 幂等守卫：同一挂载周期 init 至多跑一次——定时器句柄已在
    // mount/unmount 两侧清理，此处兜底拦截同周期的重复触发（防双跑重复
    // bridge.mount/loadSettings → 监听器双绑）；unmount 复位标志，保证
    // 「刷新模块」跨周期重挂载后 init 可重入
    if (llmModuleInitDone) return;
    llmModuleInitDone = true;
    if (context) {
        llmModuleContext = context;
    }

    window.AEAgentApp = window.AEAgentApp || {};
    window.AEAgentApp.debugLog = debugLog;
    // 左抽屉展开/收起（唯一实现就是本文件的 toggleScriptList；传 true/false 显式设置，省略=切换）。
    // 消费方：teamUI 开团队时把抽屉展开（三个 Agent 切换入口在抽屉团队面板里，
    // 抽屉收着等于入口不可见）。不在这里重写 DOM 步骤——那会与 toggleScriptList 内的
    // applyScriptListToggleUi/applyDrawerWidths 漂移。
    window.AEAgentApp.setDrawerExpanded = toggleScriptList;
    // bootstrap.js 初始会话恢复经此等待入场动画播完，避免重渲染与动画重叠掉帧
    window.AEAgentApp.whenEnterAnimIdle = _whenEnterAnimIdleSafe;
    window.AEEngine = window.AEEngine || {};
    window.AEEngine.debugLog = debugLog;

    var settingsApplied = false;
    try {
        cachedSettings = await loadSettings();
        applySettingsToUI(cachedSettings);
        settingsApplied = true;
        try {
            window.AE_LLM = window.AE_LLM || {};
            window.AE_LLM._aeToolTimeoutMs = Number(cachedSettings.executionTimeoutMs) || 30000;
        } catch (_) {}
        _syncLlmStubToolsLimit();
    } catch (e) {
        console.error('[llmApp] 设置加载/应用失败: ' + (e && (e.stack || e.message) || e));
        debugLog('llmApp', '设置加载/应用失败:', e);
    }

    loadCsInterfaceIfNeeded(() => {
        try {
            if (!llmUiInitialized) {
                scriptListUiState.expanded = false;
                bindEvents();
                // 模块 bind（替代分散的事件绑定）
                try { if (window.ScriptTree && typeof window.ScriptTree.init === 'function') { window.ScriptTree.init(); } } catch(e) { console.error('[Agent] ScriptTree.init 失败:', e); }
                try { if (window.AEAgentApp.settingsPanel) { window.AEAgentApp.settingsPanel.bind(); } } catch(e) { console.error('[Agent] settingsPanel.bind 失败:', e); }
                try { if (window.AEAgentApp.llmService) { window.AEAgentApp.llmService.bind(); } } catch(e) { console.error('[Agent] llmService.bind 失败:', e); }
                if (settingsApplied) {
                    // 启动时按持久化值应用一次（拨动开关不再触发应用，这条是唯一入口的另一半）
                    applyDebugMode(statusState.debugMode);
                }
                updatePreviewParticleBrightness();
                animatePanelsIn();
                llmUiInitialized = true;
            }
            const bridge = getAgentBridge();
            if (bridge && typeof bridge.mount === 'function') {
                bridge.mount({
                    context: llmModuleContext || context || {},
                    // 运行时读设置：只认**已保存**那份（面板里未保存的草稿不在引擎可见范围，
                    // 见 composeRuntimeSettings）；runtimeMode 同理以 cachedSettings（持久化
                    // 设置）为准：设置面板会从模式按钮实时读 runtimeMode，而点击事件触发时
                    // 按钮已高亮——若让它覆盖，switchMode 的 same 守卫会误判"已是目标模式"而
                    // 拒绝，按钮被回弹、永远无法切换。
                    getSettings: () => composeRuntimeSettings(cachedSettings),
                    getDebugMode: () => statusState.debugMode,
                    saveSettings: (nextSettings) => {
                        saveSettings(nextSettings);
                        applySettingsToUI({ ...cachedSettings, ...nextSettings });
                    },
                    // opts 透传（含 { area: 'shader' | 'script' }）：写入目标由提交工具族显式给出，
                    // 返回是否真的落进目标区（false = 目标元素缺失，工具据此报错而非回 passed）
                    // 服务未加载时返回 false：提交类工具据此报写入失败，不把未写入当成功。
                    updatePreviewScript: function(script, opts) { var s = window.AEAgentApp && window.AEAgentApp.llmService; if (s && typeof s.updatePreviewScriptFromAgent === 'function') return s.updatePreviewScriptFromAgent(script, opts); return false; },
                    showConfirm: showConfirm,
                    showStatus: showStatus
                });
            }
            setTimeout(function () {
                // reflect 钩子：**三条 lane 的 view 都要挂**。只挂
                // 「当前 view」的话，切走之后那条 lane 渲染出的 reflect 草稿永远等不到展示
                //（用户看不到它，而它已经写进消息里了）。
                // view 的来源：编排面逐 lane 取（AEEngine.getOrchestrator → getLane(id).view）；
                // 编排面缺席（团队关闭/未装配）时回落到 AEEngine.view —— 与改动前逐字同义。
                var targets = _reflectTargets();
                for (var vi = 0; vi < targets.length; vi++) _hookReflectOnView(targets[vi]);
            }, 100);
            // 恢复抽屉状态而非强制收起：首次进入默认收起（见 llmUiInitialized 分支），
            // 之后保持用户上次手动展开/收起的状态
            applyScriptListToggleUi();
            applyDrawerWidths();
            enforcePreviewFillHeight();
            refreshList();

            // Search / Toolbar / Context menu / Container drop → 由 view.js + controller.js bind() 处理
        } catch (e) {
            console.error('[llmApp] UI初始化失败:', e);
            showStatus(AEI18n.t('UI初始化失败: ') + (e && e.message ? e.message : String(e)), 'error');
        }

        setTimeout(() => {
            try {
                _whenEnterAnimIdle(() => {
                    enforcePreviewFillHeight();
                });
            } catch (e) {
                debugLog('llmApp', '延迟布局刷新失败:', e);
            }
        }, 150);

        setTimeout(() => {
            try {
                if (llmModuleMounted && !window.AE_ExtP_LowPerfMode && !_enterAnimating) {
                    startParticleEngine();
                }
            } catch (e) {
            }
        }, 200);

        setTimeout(() => {
            try {
                _whenEnterAnimIdle(() => {
                    (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})();
                });
            } catch (e) {
            }
        }, 400);

        setTimeout(() => {
            try {
                showStatus(AEI18n.t('Agent已就绪'), 'info');
            } catch (e) {
            }
        }, 600);
    });
}

// shaderUI **可选方法**的调用壳：团队布局的舞台搬移（showTeamLayout / hideTeamLayout）是
// 可选接口；refreshList 里其余 shaderUI 方法（stopPreview / hideLeft / hideRight / showLeft…）
// 都是既有契约，缺席即真错、必须裸调（少了它们是真 bug，不该被这层吞掉）。
// 为什么要包：一个可选方法缺席就把整条 refreshList 打穿的话，**同一函数里后续的收拢分支与
// ScriptTree.refresh 全都不会执行**——（桩实例只实现
// 了老接口）。缺方法返回 false、抛错吞掉并留一行诊断，都不阻断 refreshList。
function _suOpt(su, name) {
    if (!su || typeof su[name] !== 'function') return false;
    try { su[name](); return true; } catch (e) {
        console.warn('[AEAgent] shaderUI.' + name + ' 调用失败: ' + (e && e.message ? e.message : e));
        return false;
    }
}

// ── shader 模式 UI 联动：挂载 shaderUI.js 单例 + 依赖注入 ──
var shaderUIInstance = null;
function getShaderUI() {
    if (shaderUIInstance) return shaderUIInstance;
    shaderUIInstance = window.AEShaderUI && typeof window.AEShaderUI.createShaderUI === 'function'
        ? window.AEShaderUI.createShaderUI({
            effectsDir: function () {
                try {
                    // 跟随「扩展数据目录」设置：数据根目录下 effects/（与宿主 data-dir.txt 指针一致）
                    if (window.AEShared && typeof window.AEShared.getDataDir === 'function') {
                        var r = window.AEShared.getDataDir();
                        if (r && r.dir) return r.dir.replace(/\\+$/, '') + '\\effects';
                    }
                } catch (_) {}
                return '';
            },
            getRuntimeMode: function () { return (cachedSettings && cachedSettings.runtimeMode) || 'script'; },
            // 入场动画进行中（粒子引擎/panel-enter 420ms + 600ms 兜底）：shaderUI 预览初始化
            // 据此等待动画结束再做 GL 工作——WebGL 上下文创建/编译（CEF 数百 ms 级同步阻塞）
            // 若落在动画帧间隙的空闲回调里会把入场动画整个冻住（启动直接进 shader/外接
            // 模式时的启动卡顿来源）
            isIntroAnimating: function () { return !!_enterAnimating; },
            // GLSL 编辑区活动判据（shader/外接/团队三档）——与宿主同一函数（单一真源），
            // 避免 shaderUI 内再写一份「模式 === 'shader'」硬编码
            isGlslEditing: function () { return isGlslEditingMode(); },
            // shader 模式读写独立的 GLSL 代码编辑区（#shaderCodePreview），与 script 代码预览区（#scriptPreview）分离
            // 外接模式：六功能区同显下 GLSL 相关调用（效果库读取/保存/
            // uniform 写回/预览渲染取材）与 shader 模式同源——均指向 GLSL 编辑区；
            // 仅认 'shader' 会把效果库内容写进右上 EScript 预览区。
            getPreviewCode: function () {
                if (isGlslEditingMode()) {
                    var se = document.getElementById('shaderCodePreview');
                    return se ? (se.value || '') : '';
                }
                var p = document.getElementById('scriptPreview');
                return p ? p.value : '';
            },
            setPreviewCode: function (code) {
                var isShader = isGlslEditingMode();
                var target = isShader ? document.getElementById('shaderCodePreview') : document.getElementById('scriptPreview');
                if (target) {
                    target.value = code;
                    if (isShader) {
                        applyGlslHighlight();
                    } else {
                        try {
                            (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})(true);
                        } catch (_) {}
                    }
                }
                // 草稿持久化：script → previewDraft，shader → shaderDraft（互不污染）
                if (isShader) {
                    try { saveSettings({ ...cachedSettings, ...getCurrentSettingsFromUI(), shaderDraft: code }); } catch (_) {}
                } else {
                    try { saveSettings({ ...cachedSettings, ...getCurrentSettingsFromUI(), previewDraft: code }); } catch (_) {}
                }
                // 刷新左抽屉预览与右抽屉编译状态。注意：此处不重建滑块列表（renderUniforms）——
                // 滑块拖动路径会经此写回代码，重建 innerHTML 会销毁正在拖动的 range 元素，
                // 原生拖动会话被中断（只能点一下动一格）。uniform 列表变化场景（效果库加载、
                // 提交代码/编辑代码）由各自调用方显式 renderUniforms。
                var su = getShaderUI();
                if (su) {
                    su.refreshPreviewFromCode(code);
                    su.updateCompileStatus(code);
                }
            },
            onApplyResult: function (ok) { showStatus(ok ? AEI18n.t('已应用，AE 画面将热重载') : AEI18n.t('写入失败'), ok ? 'success' : 'error'); },
            // 效果库读取提示：在 Agent 专属信息栏弹出（shaderUI.js loadFromLibrary 调用）
            showStatus: showStatus,
            // 保存时自动展开效果库所在的抽屉（外层抽屉：非团队 = 左 #scriptListDrawer +
            // 内层 shaderLeftPanel；团队模式效果库在右抽屉的「效果库」页 ⇒ 展开右抽屉，
            // shaderUI 自己切页——判据是效果库的实际位置，见其 saveToLibrary）
            openLibraryDrawer: function () { toggleScriptList(true); },
            openRightDrawer: function () { togglePreviewDrawer(true); },
            previewRendererFactory: function () {
                var canvas = document.getElementById('shaderPreviewCanvas');
                if (!canvas) return null;
                return window.AEShaderPreview && typeof window.AEShaderPreview.createShaderPreviewRenderer === 'function'
                    ? window.AEShaderPreview.createShaderPreviewRenderer({
                        getCanvas: function () { return canvas; },
                        // 「Shader 预览帧率（fps）」设置项已整体移除（「彻底
                        // 移除，预览按照 30FPS」）：预览解算帧率固定 30fps，唯一真相源 =
                        // engine/settings.js 的 AEEngine.settings.PREVIEW_FPS——渲染器直接读它，
                        // 故这里不注入帧率，不留"第二来源"。
                        // 取舍（合成帧率非 30fps 时预览速率/帧号不再与 AE 对齐）见该常量处注释。
                        // 预览编译结果同步到右抽屉编译状态栏，使 refreshList 无需再单独
                        // updateCompileStatus 重复编译（GLSL 编译很贵），避免重复 WebGL 编译。
                        onStatus: function (status) {
                            var el = document.getElementById('shaderCompileStatus');
                            if (el && status) {
                                if (status.pending) { el.textContent = AEI18n.t('编译中…'); el.className = 'shader-compile-status'; }
                                else if (status.skip) { el.textContent = AEI18n.t('未编译'); el.className = 'shader-compile-status'; }
                                else if (status.ok) { el.textContent = AEI18n.t('编译通过'); el.className = 'shader-compile-status ok'; }
                                else { el.textContent = (status.error || AEI18n.t('编译失败')).slice(0, 40); el.className = 'shader-compile-status error'; }
                            }
                            // 预览区 msg/暂停键同步落位：异步编译（KHR 并行编译）终态经此回调
                            // 补齐，否则 msg 停留在「编译中…」。取 window.AEShaderUIInstance
                            // 而非 getShaderUI()：后者实例为空时会重建实例并重挂监听（模块
                            // 卸载后迟到的 onStatus 会触发同类泄漏），前者卸载即置空
                            try {
                                var suSt = window.AEShaderUIInstance;
                                if (suSt && typeof suSt.syncPreviewStatus === 'function') suSt.syncPreviewStatus(status);
                            } catch (_) {}
                        }
                    })
                    : null;
            }
        })
        : null;
    // 暴露全局单例引用：service.js updatePreviewScriptFromAgent（submit_shader 通道）无 getShaderUI 访问权，经此刷新左抽屉预览
    window.AEShaderUIInstance = shaderUIInstance;
    if (shaderUIInstance) { try { shaderUIInstance.bindResizer(); shaderUIInstance.bindPreviewEvents(); shaderUIInstance.bindRightEvents(); _suOpt(shaderUIInstance, 'bindTeamTabs'); } catch (_) {} }
    // 团队布局：实例是**懒建**的（模块重挂载后要等 init → refreshList 才建），
    // 而 teamUI 的补 show 走全局引用 AEShaderUIInstance——那个窗口里它刚被 unmount 置空，补 show
    // 空转 ⇒ 左列会先按双栏显示约 500ms。这里建完实例立刻补一次（幂等；主路径仍是
    // refreshList 的团队分支）。**只在团队开着时补**：关团队时不动布局，免得搅乱外接/shader 档的落点。
    if (shaderUIInstance && _isTeamModeForUi()) _suOpt(shaderUIInstance, 'showTeamLayout');
    return shaderUIInstance;
}

// 「当前运行模式的编辑面是 GLSL 编辑区」——shader / 外接 / 团队三档共用 #shaderCodePreview
// 及同一条预览/编译/uniform/草稿链（外接档的进入路径见 refreshList 外接分支、团队档见团队
// 分支，两者都 showLeft/showRight + startPreview；团队档的 GLSL 代码页在右抽屉）。
// 凡以 GLSL 编辑区为准的判定一律走此处，不得在别处另写「模式 === 'shader'」式字符串副本——
// 漏一档的后果是读写预览区落到 #scriptPreview（保存报「写入失败」、读取不显示、滑块写回不落码）。
// mode 省略时取当前持久化设置（cachedSettings）。
function isGlslEditingMode(mode) {
    var m = mode || (cachedSettings && cachedSettings.runtimeMode) || '';
    return m === 'shader' || m === 'external' || m === 'team';
}

function getShaderPreviewCode() {
    // shader 模式使用独立的 GLSL 代码编辑区（#shaderCodePreview），不再复用 script 预览区
    var p = document.getElementById('shaderCodePreview');
    return p ? (p.value || '') : '';
}

// 用统一增量引擎（glslHighlight 模块的 preview 实例，与 script 预览区共用 hl-engine）
// 把 GLSL 编辑区内容高亮到 overlay，无高亮能力时保持纯文本（textarea 文字直接可见）。
// forceReload=true 走全量重建（提交整段写入）；false 走按行增量（输入即着色）。
function applyGlslHighlight(forceReload) {
    var pv = window.AEAgentApp && window.AEAgentApp.glslHighlight && window.AEAgentApp.glslHighlight.preview;
    if (!pv || typeof pv.apply !== 'function') return;
    try { pv.apply(!!forceReload); } catch (_) {}
}

function parseShaderUniforms(code) {
    return (window.AEEffectLab && typeof window.AEEffectLab.parseUniforms === 'function')
        ? window.AEEffectLab.parseUniforms(code) : [];
}

// 团队模式开着吗（UI 判据的唯一入口：teamUI 从引擎的当前 lane 现算，不读 settings 缓存）。
// teamUI 缺席（未登记进 manifest / 加载失败）⇒ false，整条链路回到改动前的行为。
function _isTeamModeForUi() {
    var ui = window.AEAgentTeamUI;
    if (!ui || typeof ui.isTeamModeOn !== 'function') return false;
    try { return !!ui.isTeamModeOn(); } catch (_) { return false; }
}

// 团队模式：摘掉外接布局（外接视图可能仍停在 enter 态）。
// 外接视图停在 enter 态时 `.ext-mode-active` 会用 display:none!important 压住聊天区/输入区，
// 中列也还挂着管理台与 GLSL 预览图。exit() 本身幂等；万一视图实例与 DOM 脱节（类还在但
// isEntered 已是 false），这里再兜底摘一次类与面板显隐——漏摘的代价是整块聊天面不可见，
// 宁可多写一次。
function _healExternalLayoutForTeam() {
    var view = window.AEExternal && window.AEExternal.view;
    if (view && typeof view.exit === 'function') {
        try { view.exit(); } catch (e) {
            console.warn('[AEAgent] 团队模式摘外接布局失败: ' + (e && e.message ? e.message : e));
        }
    }
    var ap = document.getElementById('agentPanel');
    if (ap && ap.classList && ap.classList.contains('ext-mode-active')) ap.classList.remove('ext-mode-active');
    var extPanel = document.getElementById('extModePanel');
    if (extPanel) extPanel.style.display = 'none';
}

// 左抽屉的显隐路由：落到 teamUI（路由判据 + DOM 写入的单一落点，单测可直驱）。
// teamUI 缺席时回落到改动前的行为（modeHidesShell ⇒ 隐藏 shell），保证老包/加载失败时
// 与改动前逐字同义。
function _applyDrawerRoute(modeHidesShell) {
    // 抽屉路由重算前先收计划行浮层：计划区隐藏/重渲后旧行锚点作废；浮层挂 body、
    // 不随 DOM 重写消失（实现归 engine/view.js）。本函数唯一调用点在 refreshList。
    if (window.AEEngine && typeof window.AEEngine.closePlanDetail === 'function') {
        try { window.AEEngine.closePlanDetail(); } catch (_) { /* 关闭失败不阻断路由 */ }
    }
    var ui = window.AEAgentTeamUI;
    if (ui && typeof ui.applyDrawerRouting === 'function') {
        try { return ui.applyDrawerRouting({ modeHidesShell: !!modeHidesShell }); } catch (e) {
            console.warn('[AEAgent] 左抽屉路由失败，回落模式默认: ' + (e && e.message ? e.message : e));
        }
    }
    var shellEl = document.getElementById('scriptListShell');
    if (shellEl) shellEl.style.display = modeHidesShell ? 'none' : '';
    return { shell: !modeHidesShell, tabs: false, tree: true, panel: false };
}

// 把重活（WebGL 上下文创建 / GLSL 编译等高开销同步操作）延后到浏览器空闲时执行，
// 避免在进入/切换会话的动画窗口内同步阻塞主线程导致动画卡顿。
// 优先 requestIdleCallback，缺省回退 setTimeout——但用较长延迟，确保不落在动画帧上。
function deferIdle(fn) {
    if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(function () { try { fn(); } catch (_) {} }, { timeout: 3000 });
    } else {
        setTimeout(function () { try { fn(); } catch (_) {} }, 120);
    }
}

// ── reflect 钩子的挂载目标 ───────────────────────────────
// 返回 [{ view, laneId }]：团队模式下 = 三条 lane 各一条（从编排面逐 lane 取 view），
// 团队关闭 / 编排面未装配 = 单 Agent 那条（AEEngine.view）。按 view **对象身份**去重
//（团队开启时 AEEngine.view 就是当前 lane 的那条，不去重会重复包一层 → 一次渲染两次回调）。
function _reflectTargets() {
    var out = [];
    var seen = [];
    function push(view, laneId) {
        if (!view || typeof view.renderMessages !== 'function') return;
        for (var i = 0; i < seen.length; i++) {
            if (seen[i] === view) return;
        }
        seen.push(view);
        out.push({ view: view, laneId: laneId || '' });
    }
    var orch = (window.AEEngine && typeof window.AEEngine.getOrchestrator === 'function')
        ? window.AEEngine.getOrchestrator() : null;
    if (orch && typeof orch.getLane === 'function' && typeof orch.lanes === 'function') {
        var defs = orch.lanes() || [];
        for (var i = 0; i < defs.length; i++) {
            var id = defs[i] && defs[i].id;
            if (!id) continue;
            var rt = orch.getLane(id);
            push(rt && rt.view, id);
        }
    }
    if (window.AEEngine) push(window.AEEngine.view, '');
    return out;
}

// reflect 草稿的展示闸门：**当前 lane 才展示**（view / 权限确认 / 任务板 / toast
// 一律经当前 lane 判断）。非当前 lane 的草稿不去抢用户正在看的审阅面板：它仍在消息 detail
// 里，切到那条 lane 时随该 lane 的渲染展示。单 Agent 路径（laneId 为空）恒为真，与改动前同义。
function _isReflectLaneActive(laneId) {
    if (!laneId) return true;
    var ui = window.AEAgentTeamUI;
    if (ui && typeof ui.isTeamModeOn === 'function' && typeof ui.currentLaneId === 'function') {
        try {
            if (ui.isTeamModeOn()) return ui.currentLaneId() === laneId;
        } catch (_) { return true; }
    }
    return true;
}

// 给一条 view 挂 reflect 钩子 + 团队任务板的活动通知。幂等位 `_reflectHooked` 保留
//（同一实例只包一次；三条 lane 各一个实例，互不干扰）。
function _hookReflectOnView(target) {
    var viewObj = target && target.view;
    if (!viewObj || typeof viewObj.renderMessages !== 'function') return false;
    if (viewObj._reflectHooked) return false;
    var laneId = (target && target.laneId) || '';
    viewObj._reflectHooked = true;
    var _origRenderMessages = viewObj.renderMessages;
    viewObj.renderMessages = function (messages, mode, onDone) {
        _origRenderMessages.call(viewObj, messages, mode, onDone);
        // 状态变化事件：该 lane 渲染了 = 有活动 ⇒ 任务板/lane 切换条按合并窗口刷新一次
        //（teamUI 内部再按 tab 可见性决定要不要 1s 轮询兜底）
        var ui = window.AEAgentTeamUI;
        if (ui && typeof ui.notifyLaneActivity === 'function') {
            try { ui.notifyLaneActivity(laneId); } catch (_) { /* 刷新失败不影响渲染结果 */ }
        }
        if (!_isReflectLaneActive(laneId)) return;
        var list = messages || [];
        // 面板关闭后，同一条消息不得在后续 renderMessages 中重新拉起面板；
        // 按消息对象记录已关闭的渲染来源。一次渲染里可能有多条草稿消息，关闭时
        // 全部记为已关闭（面板只展示一份，关掉即视为整批已处理）。
        var dismissed = viewObj._reflectDismissed || (viewObj._reflectDismissed = []);
        var batch = [];
        for (var i = 0; i < list.length; i++) {
            var m = list[i];
            if (m && m.detail && m.detail.reflectDraft
                && window.AEAgentApp && window.AEAgentApp.reflectPanel) {
                if (dismissed.indexOf(m) >= 0) continue;
                batch.push(m);
            }
        }
        if (!batch.length) return;
        window.AEAgentApp.reflectPanel.render(batch[0].detail.reflectDraft, {
            onClose: function () {
                for (var b = 0; b < batch.length; b++) {
                    if (dismissed.indexOf(batch[b]) < 0) dismissed.push(batch[b]);
                }
            }
        });
    };
    return true;
}

function refreshList(opts) {
    // opts.silent：**不写状态条**。为什么需要：换 lane 时若停在「计划」页签，teamUI 会再调一次
    // refreshList 把计划树换成新 lane 的 todo；而下面的 showStatus('任务清单已刷新…') 会把状态栏上
    // 那条「已切到 <Agent>」提示（或忙 lane 的真实执行文案）盖掉。
    var _silent = !!(opts && opts.silent);
    // 模块已卸载时的后台 refreshList 直接返回——engine 层（switchSession/
    // planTracking 等）的直调路径不受挂载状态约束（只覆盖了防抖回调路径），
    // 而 getShaderUI 发现实例为 null 会重建 shaderUI（bindResizer/bindPreviewEvents
    // 重挂监听 + 经 previewRendererFactory 重建 WebGL 渲染循环后台空转）。挂载标志
    // 由 mount/unmount 维护，对齐 onShaderPreviewEdited 的既有守卫手法。
    if (!llmModuleMounted) return;
    try {
        var settings = cachedSettings;
        var mode = settings && settings.runtimeMode;
        // 团队模式：团队开着时**整块模式 chrome 一律按团队走**。分支判据取
        // `_isTeamModeForUi()`（引擎当前 lane 现算），不顺着 `settings.runtimeMode` 的来处分叉：
        // 来处是 external 时 `.ext-mode-active` 会把聊天区/输入区按 display:none!important
        // 压住，中列还挂着管理台与 GLSL 预览图。团队优先须覆盖整块模式 chrome
        //（外接分支 / shader 分支 / 工具栏 / 抽屉），不只左抽屉路由。
        var teamOnUi = _isTeamModeForUi();
        var isAgent = mode === 'agent';
        // `isShader` 必须**同时**排掉团队模式——只把 `!teamOnUi` 加在
        // `isExternal` 上，于是「团队开着 + 底层档 = shader」时 shader 分支照旧执行并提前 return
        // （main.js 的 `if (isShader && su) { … return; }`）⇒ 团队分支整段被跳过：舞台被
        // `hideTeamLayout` 搬回左列，而 `.team-mode-active .shader-team-stage{display:flex}` 仍在
        // ⇒ 右抽屉上半是一块**空的带边框面板**（「上半实时预览」落空），重载恢复同样坏。
        // 团队档是模式旋钮的第五档（runtimeMode='team'）⇒ 界面档一律按团队走：团队开着时
        // isShader/isExternal 都恒为 false。
        var isShader = (mode === 'shader') && !teamOnUi;
        var isExternal = (mode === 'external') && !teamOnUi;
        // 左抽屉的显隐路由：modeHidesShell 只认 **shader**。
        // 外接模式左列是「脚本树 + 效果库」双库（设计：六功能区左列），树必须显示；把
        // external 也算进「隐藏 shell」，于是 `#scriptListShell` 被写成 display:none、
        // `.ext-mode-active .script-list-shell` 那条 50% 分栏压根没生效——真机现象
        //「外接模式的脚本树高度被压成0了（或者消失了）」。团队模式优先仍由路由内部裁决。
        var drawerRoute = _applyDrawerRoute(isShader);
        // 团队模式先摘外接布局（幂等）：不摘掉它，下面所有「显示聊天区」的写入都会被那条
        // !important 压回去（从外接档切进团队时外接视图还在 enter 态）。
        if (teamOnUi) _healExternalLayoutForTeam();
        // 团队布局类（`.team-mode-active`，CSS 驱动「右抽屉上预览下代码 + 左列双栏」）：写点唯一
        // 仍是 teamUI.syncLayoutClass（幂等），这里跟着模式 chrome 再钉一次——refreshList 自己
        // 就算得出 teamOnUi，两边同拍才不会出现「类没挂上而舞台已经搬进右抽屉」的半态。
        if (window.AEAgentTeamUI && typeof window.AEAgentTeamUI.syncLayoutClass === 'function') {
            try { window.AEAgentTeamUI.syncLayoutClass(); } catch (_) { /* 布局类失败：其余 chrome 照走 */ }
        }

        // shader 模式隐藏聊天顶栏的「保存脚本/运行脚本/刷新列表」：保存与 shader
        // 代码预览区的「保存」（#shaderSaveBtn）、刷新与效果库的「刷新」
        //（#shaderRefreshLibBtn）入口重复，运行脚本在 shader 模式无意义（GLSL 走
        // submit_shader 通道提交，不经脚本执行链）。置于外接分支之前统一覆盖四模式。
        // 团队档：同款理由再收一层——这三颗
        // 都是**脚本模式**的顶栏入口（保存/运行的是脚本模式的预览区，刷新的是脚本列表），团队档
        // 下左列是团队面板、右抽屉是 GLSL 预览/代码，三者都没有落点；留着一个「上一个模式的
        // 按钮」正是「很多东西还是切之前的那个模式」。清空对话不在其列（团队档仍要清当前
        // lane 的会话）。判据用 `teamOnUi`：团队档的界面档一律按团队走（同 isShader）。
        var hideTopScriptBtns = isShader || teamOnUi;
        var topSaveBtn = document.getElementById('saveBtn');
        if (topSaveBtn) topSaveBtn.style.display = hideTopScriptBtns ? 'none' : '';
        var topRunBtn = document.getElementById('runBtn');
        if (topRunBtn) topRunBtn.style.display = hideTopScriptBtns ? 'none' : '';
        var topRefreshBtn = document.getElementById('refreshScriptListBtn');
        if (topRefreshBtn) topRefreshBtn.style.display = hideTopScriptBtns ? 'none' : '';

        // 「当前选中」入口的显隐：不再按模式名单（旧的 `!isShader`），而是按
        // **当前轮身份能不能真的读到工程**——判据在 engine 侧（注册表里 queryProject 的 scope/禁用，
        // 与发消息时同一份数据），团队档据此按**当前 lane** 判定：身份含 `'agent'` 的
        // （导演 / AE 执行 / 美术）显示；glsl 身份是 `['shader','team']`（与单 Agent Shader 档同面）
        // ⇒ 隐藏；单 Agent 四档与改动前逐格同义（shader 隐藏）。
        // engine 缺席（旧部署 / 测试桩）时回落改动前的 `!isShader`，保证老包行为不变。
        if (window.AEEngine && typeof window.AEEngine.applyAeStateChipVisibility === 'function') {
            try { window.AEEngine.applyAeStateChipVisibility(); } catch (_) { /* 入口缺席：不改 DOM */ }
        } else if (window.AEEngine && typeof window.AEEngine.setAeStateChipVisible === 'function') {
            window.AEEngine.setAeStateChipVisible(!isShader);
        }

        // 外接模式（EXT-MCP）：六功能区同显——左列双库/右列双预览由 ext-mode-active
        // CSS 驱动，此处保证 shader 内层面板可见 + 预览循环常驻（预览图实时必做）
        if (isExternal) {
            var toolbarExt = document.querySelector('.script-tree-toolbar');
            if (toolbarExt) { toolbarExt.style.display = ''; }
            var scriptWrapExt = document.getElementById('scriptPreviewWrap');
            if (scriptWrapExt) { scriptWrapExt.style.display = ''; }
            // #scriptListShell 的显隐已由上面的 _applyDrawerRoute 落下（外接模式
            // = 显示，与 .ext-mode-active 的 50% 双库分栏对齐；团队模式下由 tab 决定
            // shell/树/面板，这里不再直接写 display 抢它的判定）
            var suExt = getShaderUI();
            if (suExt) {
                // 从团队档切进外接：预览舞台要先从左列原位复位，再由 ext enter 移进中列
                // （顺序不能倒——两个布局的 stage 落点会打架）
                _suOpt(suExt, 'hideTeamLayout');
                suExt.showLeft();
                suExt.showRight();
                suExt.refreshLibrary();
            }
            if (window.AEExternal && window.AEExternal.view) window.AEExternal.view.enter();
            // 预览循环延后启动（避开切换动画窗口；不占用 deferIdle——其调用点唯一性
            // 需要保住，故此处用 setTimeout 隔离）
            setTimeout(function () {
                if (!llmModuleMounted) return;
                if (!cachedSettings || cachedSettings.runtimeMode !== 'external') return;
                // GLSL 高亮 + uniform 滑块对齐 shader 模式的 deferIdle 初始化：外接分支
                // 两步都要做：面板重载/首次进入外接模式时草稿已回填 #shaderCodePreview
                // 但 overlay 为空（restorePreviewDraft 不渲染着色），要等任一预览区输入
                // （onShaderPreviewEdited 同时绑了 script 与 shader 两区 input）才出现。
                applyGlslHighlight();
                var codeExt = getShaderPreviewCode();
                var suExt2 = getShaderUI();
                if (suExt2) {
                    suExt2.renderUniforms(parseShaderUniforms(codeExt));
                    suExt2.startPreview();
                }
            }, 60);
            window.ScriptTree.refresh();
            return;
        }

        // Agent/Shader 模式下隐藏脚本工具栏（shader 只展示左抽屉预览与右抽屉编译区）
        // 团队模式同样不带它（toolbar:false 曾被外接/脚本分支的 display:'' 盖回来——
        // 真机「搜索脚本框」在「从外接切进团队」这条路径上复现）
        var toolbar = document.querySelector('.script-tree-toolbar');
        if (toolbar) { toolbar.style.display = (isAgent || isShader || teamOnUi) ? 'none' : ''; }
        // shader 模式使用独立的 GLSL 代码编辑区（#shaderCodePreview），隐藏 script 代码预览区，两区互不干扰；
        // 团队模式右抽屉下半同样是 GLSL 代码栏，脚本预览区同样让位。
        var scriptWrap = document.getElementById('scriptPreviewWrap');
        if (scriptWrap) { scriptWrap.style.display = (isShader || teamOnUi) ? 'none' : ''; }
        // 左抽屉：shader 模式显示 shader 面板（实时预览 + 效果库），隐藏脚本树；其他模式恢复脚本树。
        // #scriptListShell 的显隐**唯一落点**是 refreshList 顶部的 _applyDrawerRoute（团队模式优先，
        // 设计 B-4）——这里不再直接写 display：两处写同一个属性必然互相打脸。

        var su = getShaderUI();
        if (isShader && su) {
            // 从团队档切回 shader：预览舞台先复位（团队模式把它移进右抽屉了）
            _suOpt(su, 'hideTeamLayout');
            // shader 面板嵌在左右抽屉内（showLeft/showRight 只改内层 panel 的 display），
            // 但不强制展开外层抽屉：保持用户当前抽屉状态，用户自行决定是否展开
            su.showLeft();
            su.showRight();
            su.refreshLibrary();  // 内部走异步 listFilesAsync，不阻塞主线程
            // 重活（Prism 高亮 + uniform 面板重建 + 预览编译）延后到浏览器空闲时执行，
            // 避免在进入/切换会话的动画窗口内同步阻塞主线程导致动画卡顿。
            // startPreview 内部的幂等缓存保证同一代码只编译一次。
            deferIdle(function () {
                // 迟到回调双重守卫——空闲窗口内模块已卸载或已切出 shader
                // 模式时，闭包捕获的旧 su 实例仍会经 startPreview 重建 WebGL 渲染循环
                // 且无人回收（不可逆泄漏）。守卫须在 applyGlslHighlight 之前，对齐
                // refreshList 入口的挂载守卫手法（cachedSettings 为模块级当前设置）。
                if (!llmModuleMounted) return;
                if (!cachedSettings || cachedSettings.runtimeMode !== 'shader') return;
                applyGlslHighlight();
                var code = getShaderPreviewCode();
                su.renderUniforms(parseShaderUniforms(code));
                su.startPreview();
            });
            return;
        }
        // ── 团队模式：中心列 = 聊天流，右抽屉 = 上预览 / 下「代码|效果库」──
        // 预览舞台与效果库（GLSL lane 的素材面，与 shader 模式同一份列表）**都搬进右抽屉**：
        // 上半 = shader 实时预览，下半 = 「GLSL 代码 | 效果库」并列 tab（效果库原在
        // 左列下半，现搬到右抽屉与代码栏并列）。两件搬移都幂等，显隐由 .team-mode-active
        // 的 CSS 驱动。**不 stopPreview**：GLSL lane 干活时预览要在场（实时预览的前提）。
        if (teamOnUi && su) {
            _suOpt(su, 'showTeamLayout');
            // 内层 shader 面板的显隐仍放行：搬移失败（容器缺席/老实例）时它是预览与效果库的落点，
            // 不能带着上一档写下的 display:none 留在那儿；搬移成功时它由 .team-emptied 让位给团队面板。
            su.showLeft();
            // 右抽屉下半 = GLSL 代码栏：**必须显式放行**——从 script/agent 档切进团队时，
            // 那两个档的收尾分支刚写过 hideRight()（内联 display:none），不放开就只剩上半的预览。
            // （缺口：外接→团队恰好被外接分支的 showRight 掩盖，script→团队才暴露。）
            su.showRight();
            su.refreshLibrary();
            // 重活延后到空闲窗口（同 shader 分支：WebGL 上下文创建 / GLSL 编译是同步重活，
            // 落在切换动画帧里会把动画冻住）。迟到守卫按**团队仍在**判（`teamOnUi` 由引擎
            // 当前 lane 现算，比 runtimeMode 更直接反映团队 chrome 是否还在）。
            deferIdle(function () {
                if (!llmModuleMounted) return;
                if (!_isTeamModeForUi()) return;
                applyGlslHighlight();
                var codeTeam = getShaderPreviewCode();
                su.renderUniforms(parseShaderUniforms(codeTeam));
                su.startPreview();
            });
        } else if (su) {
            _suOpt(su, 'hideTeamLayout');
            su.stopPreview(); su.hideLeft(); su.hideRight();
        }

        // 「计划」tab 渲染当前 lane 的 plan：单 Agent 的 agent 模式照旧；团队模式下**每条 lane**
        // 都有自己的 plan（GLSL lane 的 slot 是 shader，按旧判据它的计划永远不渲染）。
        // 团队面板（团队任务 tab）在前台时跳过这次渲染——树是隐藏的，渲染它纯属白干。
        if ((isAgent || _isTeamModeForUi()) && drawerRoute.tree) {
            var planListEl = document.getElementById('scriptTree');
            var agentView = window.AEEngine && window.AEEngine.view;
            if (planListEl && agentView && typeof agentView.renderPlanToSidebar === 'function') {
                agentView.renderPlanToSidebar(planListEl);
                var bridge = window.AEEngine && window.AEEngine.bridge;
                var plan = bridge && typeof bridge.getActivePlan === 'function' ? bridge.getActivePlan() : null;
                var stepCount = plan && plan.steps ? plan.steps.length : 0;
                if (!_silent) {
                    if (stepCount) {
                        showStatus(AEI18n.t('已刷新 ') + stepCount + AEI18n.t(' 条任务'), 'success');
                    } else {
                        showStatus(AEI18n.t('任务清单已刷新，暂无任务'), 'success');
                    }
                }
            }
        } else if (drawerRoute.tree) {
            window.ScriptTree.refresh();
        }
        // drawerRoute.tree === false（团队「团队任务」tab 在前台）：计划区与脚本树都不可见，
        // 两者都不渲染——省一次全量重建，也不产生「刷新了看不见的列表」的假信号。
    } catch (e) {
        // 空 catch 吞掉全部异常——任务清单/脚本树渲染失败静默空白无提示，
        // 排查无从下手。补控制台日志与用户可见的错误状态条。
        console.error('[AEAgent] refreshList 渲染失败:', e);
        showStatus(AEI18n.t('列表刷新失败: ') + (e && e.message ? e.message : String(e)), 'error', { autoHideMs: 5200 });
    }
}

// 对外暴露模块生命周期与列表刷新能力，供容器主面板调用
window.AEAgent = window.AEAgent || {
    mount: function mount(context) {
        llmModuleMounted = true;
        // 后台结果「自动唤起」的前置条件之一：引擎侧（controller/apiActions）
        // 无挂载态概念，故由模块生命周期显式 stamp。模块未挂载时不起轮——否则用户切到别的
        // 模块期间会空跑一轮 LLM（耗 token），回话也要等重开模块才可见。unmount 处置 false。
        if (window.AEEngine) { try { window.AEEngine.agentUiMounted = true; } catch (_) {} }
        // 定时器句柄必须保存——重挂载前先撤销上一周期挂起的延迟
        // init，避免双定时器在新周期内双跑（监听器双绑）
        if (llmModuleInitTimer) { clearTimeout(llmModuleInitTimer); llmModuleInitTimer = null; }
        llmModuleInitTimer = setTimeout(() => {
            llmModuleInitTimer = null;
            try {
                init(context);
            } catch (e) {
                console.error('[AEAgent] mount 初始化失败:', e);
                showStatus(AEI18n.t('模块初始化失败: ') + (e && e.message ? e.message : String(e)), 'error');
            }
        }, 500);
    },
    refreshList: refreshList,
    // 模式旋钮的**唯一写点**：团队开关（设置段/旋钮）变化后，由它重算第 5 档的位置。
    // teamUI 的 setTeamEnabled 落定后会调它——knob 的位置与 data-mode-index 不在这里以外的地方写。
    syncRuntimeMode: syncRuntimeMode,
    showSettings: function() { var sp = window.AEAgentApp && window.AEAgentApp.settingsPanel; if (sp && typeof sp.open === 'function') { sp.open(); } },
    setLowPerfMode: function setLowPerfMode(enabled) {
        // 开启低性能模式：立即停止粒子引擎（关闭时不自动重启，下次 mount 自然恢复）
        if (enabled) {
            try { stopParticleEngine(); } catch (e) {}
        }
    },
    setDebugMode: function setDebugMode(enabled) {
        // 全局设置保存后由主壳调用（applyDebugMode 的唯一外部入口）：应用运行时调试态
        //（调试日志栏 / 调试项可见性 / 引擎侧重渲染登记）。持久化由主壳的全局设置保存路径负责。
        applyDebugMode(enabled);
    },
    unmount: function unmount() {
        llmModuleMounted = false;
        // 撤销挂起的延迟 init 并复位幂等标志——卸载后迟到的 init
        // 会在新挂载周期双跑（重复 bridge.mount/loadSettings → 监听器双绑）
        if (llmModuleInitTimer) { clearTimeout(llmModuleInitTimer); llmModuleInitTimer = null; }
        llmModuleInitDone = false;
        // 动画可能未播完就卸载（animationend 不会触发），重置标志并移除入场 class，
        // 避免下次挂载粒子被卡住不启动或残留 will-change
        _enterAnimating = false;
        var _enterLayout = document.getElementById('agentPanel');
        if (_enterLayout) {
            _enterLayout.classList.remove('panel-enter');
            _enterLayout.classList.remove('panel-enter-pending');
        }
        stopParticleEngine();
        // shader 模式：卸载时销毁预览渲染器，避免 canvas 渲染器泄漏（destroy 内 stopPreview + renderer.destroy）
        if (shaderUIInstance && typeof shaderUIInstance.destroy === 'function') { try { shaderUIInstance.destroy(); } catch (_) {} }
        shaderUIInstance = null;
        window.AEShaderUIInstance = null;
        // 撤销入场动画挂起的 start 延迟与 600ms 兜底回调——迟到触发会在
        // 新周期 remove('panel-enter') 掐断入场动画并提前启动粒子（置于尾部：与
        // shaderUI 销毁无顺序依赖，清锁语义只要求 unmount 完成前执行）
        if (_enterStartTimer) { clearTimeout(_enterStartTimer); _enterStartTimer = null; }
        if (_enterFallbackTimer) { clearTimeout(_enterFallbackTimer); _enterFallbackTimer = null; }
        // 卸载必须摘掉挂 body 上的计划行浮层（浮层不随模块容器卸载消失；实现归 engine/view.js）。
        // 位置在两处 clearTimeout 之后：定时器清理按 unmount 头部 1500 字符定长切片校验。
        if (window.AEEngine && typeof window.AEEngine.closePlanDetail === 'function') {
            try { window.AEEngine.closePlanDetail(); } catch (_) { /* 关闭失败不阻断卸载 */ }
        }
        // 清理运行错误反馈卡片状态，避免重新进入模块时残留旧错误
        var _errCard = document.getElementById('runErrorCard');
        if (_errCard) _errCard.hidden = true;
        // 后台结果自动唤起的前置条件之一（见 mount 处注释）：卸载即标记，避免在用户已
        // 离开 Agent 模块（切到别的模块）时起轮空跑。置于尾部——按
        // unmount 头部 1500 字符定长切片复核入场定时器清理，顶部插行会把它挤出窗口。
        if (window.AEEngine) { try { window.AEEngine.agentUiMounted = false; } catch (_) {} }
    }
};