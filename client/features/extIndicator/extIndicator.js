// extIndicator.js — 外部访问授权常驻指示（全局边光 + 置顶提示条）
//
// 职责边界：把 extPolicy 的 active 状态映射为两个 document.body 直接子节点的
// 存在与否。不持有自己的开关状态，任何判断都以 policy.isActive() 为准。
//
// 为什么不走 AEToast.show()：toast.js 的栈语义是「最多 5 条、超出踢掉最早的」
// （toast.js:28/44-46），且 hide() 是清空全部（:78-83）。本指示器是状态驱动、
// 无终止时点的，混进那个瞬态栈会被 5 条上限踢掉、被别人的 hide() 顺手清掉。
// 故自建节点、只复用 .ae-toast 的 CSS 类（视觉完全一致，同一条 CSS）。
//
// 为什么挂 body 直接子元素：CEP 里 position:fixed 落在祖先 stacking context
// 内时合成层管理会出问题。
//
// 为什么未授权时零节点：不允许「建了再用 clip/display 藏起来」——被 clip-path
// 裁剪到不可见的元素，其 backdrop-filter 仍创建合成层。
// 关闭必须是真删节点，不能是隐藏。
(function (global) {
    'use strict';

    var EDGE_CLASS = 'ae-ext-edge-glow';
    var WRAP_CLASS = 'ae-ext-pinned-wrap';
    var CAPSULE_CLASS = 'ae-toast ae-toast-info ae-toast-show ae-ext-pinned ae-toast-ring';
    var HL_CLASS = 'ae-ext-pinned-hl';
    var META_CLASS = 'ae-ext-pinned-meta';
    // 文案随语言切换：用函数取值，模块装载后再取当前语言
    function _hlBaseText() { return AEI18n.t('外接授权已开启'); }
    // 滚动动画类（作用在「整行」= hl + meta 两个节点上，见 _setLineRoll）。
    // 命名不再带 hl：调用时**整行**滚出、只滚入「调用 X」，
    // 档位/工具数那段（meta）同步滚出且调用期间不显示（回显时写回最新值）。
    var ROLL_OUT_CLASS = 'ae-ext-roll-out';
    var ROLL_IN_CLASS = 'ae-ext-roll-in';
    // 时序：
    // 滚动单程 150ms（与 CSS 关键帧时长一致，改一处必须同步另一处）、显示窗口 3s。
    var ROLL_MS = 150;
    var HOLD_MS = 3000;

    var edgeNode = null;
    var wrapNode = null;
    var hlNode = null;
    var metaNode = null;
    var disposed = false;
    var subscribed = false;   // onSettingsChange 无取消订阅 API，只能保证不重复登记
    // 滚动状态：rolling = 一段滚动进行中；pendingTarget = 滚动中收到的最新目标（合并用）
    var rolling = false;
    var pendingTarget = null;
    var rollTimer = null;
    var revertTimer = null;
    // meta 文案（档位/工具数）的当前值 + 「调用显示期间」抑制标志：
    // 调用期间整行只显示调用名，meta 不写 DOM 但仍持续接收 refreshText 的新值
    //（缓冲在 _metaText），回显时统一写回最新值——否则档位/工具数刷新会在调用
    // 显示中途把 meta 写回，整行滚动的效果就被戳破。
    var _metaText = '';
    var _metaSuppressed = false;

    function doc() { return global.document; }

    function policy() {
        return global.AEExternal && global.AEExternal.policy;
    }

    function isActive() {
        var p = policy();
        return !!(p && typeof p.isActive === 'function' && p.isActive());
    }

    function isMounted() { return !!edgeNode; }

    function mount() {
        if (edgeNode) return;
        var d = doc();
        if (!d || !d.body) return;

        edgeNode = d.createElement('div');
        edgeNode.className = EDGE_CLASS;
        d.body.appendChild(edgeNode);

        wrapNode = d.createElement('div');
        wrapNode.className = WRAP_CLASS;

        var capsule = d.createElement('div');
        capsule.className = CAPSULE_CLASS;

        var hl = d.createElement('span');
        hl.className = HL_CLASS;
        hl.textContent = _hlBaseText();
        hlNode = hl;

        metaNode = d.createElement('span');
        metaNode.className = META_CLASS;

        capsule.appendChild(hl);
        capsule.appendChild(metaNode);
        wrapNode.appendChild(capsule);
        d.body.appendChild(wrapNode);

        // 新节点从静态行开始：抑制标志必须复位（否则上次调用中断留下的 true
        // 会让 meta 一直不显示）
        _metaSuppressed = false;
        refreshText();
    }

    // 真删节点（不是隐藏）：见文件头「为什么未授权时零节点」
    function unmount() {
        // 先清计时器再摘节点：回写计时器若在节点移除后触发，会往脱离文档的节点写文案
        //（该节点已不可见，且下次 mount 会新建——残留状态是无意义的泄漏）
        _clearRollTimers();
        if (edgeNode && edgeNode.parentNode) edgeNode.parentNode.removeChild(edgeNode);
        if (wrapNode && wrapNode.parentNode) wrapNode.parentNode.removeChild(wrapNode);
        edgeNode = null;
        wrapNode = null;
        hlNode = null;
        metaNode = null;
    }

    function _clearRollTimers() {
        if (rollTimer) { clearTimeout(rollTimer); rollTimer = null; }
        if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
        rolling = false;
        pendingTarget = null;
        _metaSuppressed = false;
    }

    // ── 工具调用滚动提示（notifyToolCall）──
    //
    // 单行「滚出 → 换字 → 滚入」，且**整行同步**：
    // 调用时 hl（外接授权已开启）与 meta（· 档位 … · 对外工具 …）一起滚出，
    // 换字后整行只滚入「调用 X」（meta 清空），3s 后整行滚回「外接授权已开启 · 档位 …」。
    // 滚动范围覆盖整行：不只滚外接授权标记。
    //
    // 动画类加在两个 span 自身（它们在胶囊这个 flex 容器里是 flex item，computed
    // display 为 block，transform 生效）；胶囊本体不带 transform。同一时刻只有一份
    // 文本，故无需裁剪容器、也不新增任何节点——胶囊恰 2 个子节点与「textContent 即
    // 当前文案」两条既有契约都不变。
    //
    // 假 DOM（单测）没有 classList/style，故一律走 className 字符串操作，不碰样式属性。
    function _classNameHas(node, cls) {
        return (' ' + (node.className || '') + ' ').indexOf(' ' + cls + ' ') >= 0;
    }

    function _addClass(node, cls) {
        if (node && !_classNameHas(node, cls)) node.className = ((node.className || '') + ' ' + cls).replace(/^\s+/, '');
    }

    function _removeClass(node, cls) {
        if (!node) return;
        node.className = (' ' + (node.className || ' ') + ' ')
            .split(' ' + cls + ' ').join(' ')
            .replace(/^\s+|\s+$/g, '')
            .replace(/\s+/g, ' ');
    }

    // 整行（hl + meta）同步加/摘动画类：两节点的 transform/opacity 用同一条关键帧，
    // 类在同一个 tick 挂上 ⇒ 视觉上是一整行在滚。
    function _addRollClass(cls) {
        _addClass(hlNode, cls);
        _addClass(metaNode, cls);
    }

    function _removeRollClass(cls) {
        _removeClass(hlNode, cls);
        _removeClass(metaNode, cls);
    }

    // 动效敏感用户：跳过整套动画（直接换字）。CSS 侧另有同款 @media 兜底——
    // 两层都做是因为 JS 这层管「换字节奏」，CSS 那层防「拿不到 matchMedia 的环境」。
    function _prefersReducedMotion() {
        try {
            return !!(global.matchMedia && typeof global.matchMedia === 'function'
                && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
        } catch (e) { return false; }
    }

    // 写整行文案（换字点/退化路径共用）
    function _applyLineText(target) {
        if (hlNode && hlNode.textContent !== target.hl) hlNode.textContent = target.hl;
        if (metaNode && metaNode.textContent !== target.meta) metaNode.textContent = target.meta;
    }

    // 把整行切到 target（{hl, meta}，带滚动动画）。滚动进行中则只记 pendingTarget（合并）。
    function _setLineRoll(target) {
        if (!hlNode) return;
        // 已是目标（两段都比对）：不动画
        if (hlNode.textContent === target.hl
            && (!metaNode || metaNode.textContent === target.meta)) return;
        if (rolling) { pendingTarget = target; return; }
        rolling = true;
        if (_prefersReducedMotion()) {
            _applyLineText(target);
            _finishRoll();
            return;
        }
        _addRollClass(ROLL_OUT_CLASS);
        rollTimer = setTimeout(function () {
            rollTimer = null;
            if (!hlNode) { _finishRoll(); return; }
            _removeRollClass(ROLL_OUT_CLASS);
            _applyLineText(target);
            _addRollClass(ROLL_IN_CLASS);
            rollTimer = setTimeout(function () {
                rollTimer = null;
                _removeRollClass(ROLL_IN_CLASS);
                _finishRoll();
            }, ROLL_MS);
        }, ROLL_MS);
    }

    function _finishRoll() {
        rolling = false;
        // 合并语义：滚动期间来的最新目标在此补滚（一次只滚一次，不排队叠加）
        var next = pendingTarget;
        pendingTarget = null;
        if (next) _setLineRoll(next);
    }

    // 回显静态行：hl 回基础文案，meta 取缓冲中的最新值（调用期间收到的刷新在此生效）
    function _rollToBase() {
        _metaSuppressed = false;
        _setLineRoll({ hl: _hlBaseText(), meta: _metaText });
    }

    // 工具名显示上限：注册表允许名字到 128 字符（toolRegistry.validateToolId），而胶囊是
    // 顶部居中的定宽感组件（.ae-ext-pinned-wrap 撑满宽度 + flex 居中）——超长名字会把
    // 提示条拉成横跨整个面板的一条。截断到 32 字符 + 省略号，保持胶囊形态稳定。
    var CALL_NAME_MAX = 32;

    // 外部 Agent 调用工具 → 整行滚动显示「调用 <工具名>」（档位/工具数随整行滚出、调用期间
    // 不显示），HOLD_MS 后整行滚回静态文案。由 extBridgeClient.runDispatch 在**门控全通过、
    // 即将执行**时调用（被拒的调用不显示——它们不改变 AE 状态，且反复试探时会刷屏）。
    // 守卫式：未挂载（未授权/模块未启动）时静默跳过，不建节点、不计时器。
    function notifyToolCall(toolName) {
        if (disposed || !hlNode) return;
        var name = (toolName === null || toolName === undefined) ? '' : String(toolName);
        if (!name) return;
        if (name.length > CALL_NAME_MAX) name = name.slice(0, CALL_NAME_MAX) + '…';
        // 显示窗口重置（原地替换语义）：密集调用期间持续显示最新工具名，静默 3s 后才回显
        if (revertTimer) { clearTimeout(revertTimer); revertTimer = null; }
        revertTimer = setTimeout(function () {
            revertTimer = null;
            _rollToBase();
        }, HOLD_MS);
        // 调用期间 meta 不写 DOM（刷新继续缓冲进 _metaText，回显时写回最新值）
        _metaSuppressed = true;
        _setLineRoll({ hl: '调用 ' + name, meta: '' });
    }

    function sync() {
        if (disposed) return;   // dispose 后须经 init() 恢复（init 会清 disposed）
        if (isActive()) mount();
        else unmount();
    }

    // 工具数取不到（AEExternal.tools 缺失 / Bridge 断 / buildExternalToolDefs 抛错）
    // 返回 null，由调用方渲染成 '--'——不阻塞提示条主体显示。
    // 来源与面板状态卡一致（view.js:189-191，buildExternalToolDefs().length）。
    // 注意失败路径分叉：取不到时本处显示 '--'、状态卡显示 '0'——授权指示器上
    // '0' 是安全面向的假陈述（"一个都没暴露"与"不知道"必须可区分），故本处取 '--'。
    // catch 留痕：投影真坏掉时面板会丢工具、指示条只显示 '--'，不留线索就无法归因。
    function toolsCount() {
        try {
            var tools = global.AEExternal && global.AEExternal.tools;
            if (tools && typeof tools.buildExternalToolDefs === 'function') {
                return tools.buildExternalToolDefs().length;
            }
        } catch (e) {
            console.warn('[ext-indicator] 工具数不可用: ' + (e && e.message));
        }
        return null;
    }

    // 与 extPolicy.effectiveTier（extPolicy.js:188-191）同口径：auto 单独一档，
    // 其余（含 conservative）归一为「平衡」——conservative ≡ balanced。
    // 与 toolsCount 对称的兜底：getTier → ensureLoaded → loadSettings（读 localStorage），
    // 抛错时回落「平衡」而不是让 mount() 在 appendChild 之后抛出、留下空 meta 文本。
    function tierLabel() {
        try {
            var p = policy();
            var raw = (p && typeof p.getTier === 'function') ? p.getTier() : null;
            return raw === 'auto' ? AEI18n.t('自动') : AEI18n.t('平衡');
        } catch (e) {
            console.warn('[ext-indicator] 档位不可用: ' + (e && e.message));
            return AEI18n.t('平衡');
        }
    }

    function buildMetaText() {
        var n = toolsCount();
        return ' · 档位 ' + tierLabel() + ' · 对外工具 ' + (n === null ? '--' : n);
    }

    // 只改 textContent，绝不重建节点：tier / group / server 事件可能密集触发，
    // 重建会让提示条重新播放入场动画（common.css:1253-1256 的 animation: ae-toast-in
    // 会随新节点重放）——防重放靠的是元素复用，不是下面那个比较。
    // 调用显示期间（_metaSuppressed）：只缓冲新值、不写 DOM——整行此刻只该有调用名，
    // 回显（_rollToBase）时把最新值写回，档位/工具数的刷新不会丢。
    function refreshText() {
        _metaText = buildMetaText();
        if (!metaNode || _metaSuppressed) return;
        // 比较只是省掉无谓的 DOM 写入，无行为差异（去掉它套件仍全绿）
        if (metaNode.textContent !== _metaText) metaNode.textContent = _metaText;
    }

    function onChange(change) {
        if (disposed || !change) return;
        if (change.kind === 'active') { sync(); return; }
        // 其余 kind（tier / group / server / toast）都可能改变文案：直接刷新。
        // refreshText 在未挂载时是 no-op（metaNode 为 null 时提前返回），
        // 故不需要在此判断 kind——Task 4 只需实现 refreshText 的函数体。
        refreshText();
    }

    function init() {
        var p = policy();
        if (!p || typeof p.onSettingsChange !== 'function') {
            console.warn('[ext-indicator] AEExternal.policy 不可用，指示器未启动');
            return;
        }
        disposed = false;
        if (!subscribed) {
            p.onSettingsChange(onChange);
            subscribed = true;
        }
        sync();
    }

    // onSettingsChange 无取消订阅 API（extPolicy.js:249 只做 listeners.push），
    // 故 dispose 用失效标记实现：置位后 onChange 直接返回，init() 清除该标记。
    function dispose() {
        disposed = true;
        unmount();
    }

    global.AEExtIndicator = {
        init: init,
        sync: sync,
        refreshText: refreshText,
        notifyToolCall: notifyToolCall,
        isMounted: isMounted,
        dispose: dispose,
        _onChange: onChange
    };
})(typeof window !== 'undefined' ? window : this);
