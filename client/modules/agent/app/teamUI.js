(function (global) {
    'use strict';
    // 团队模式 UI：团队开关 / lane 切换条 / 左抽屉 tab / 任务板渲染 / 刷新节奏。
    //
    // **单一落点**：任务板的 DOM 只在本文件生成。`engine/view.js` 只做 id 参数化，
    // `app/main.js` 只做「tab 条与面板的显隐路由」，都不再各造一份行渲染——两处渲染必然漂移
    //（一处显示「工具 x 执行中 12s」、另一处显示「空闲」，用户无从判断哪条是真的）。
    //
    // 三条数据口径：
    //   · 快照**只经** `AEAgentTeam.buildBoardSnapshot`（纯函数；它内部复用 orchestrator 的
    //     `deriveLaneStatus`）。本文件不写第二份「谁在跑」的判据。
    //   · 当前 lane 的唯一真相源是 orchestrator（`AEEngine.getOrchestrator()` → getCurrentLane /
    //     setCurrentLane / getLane）。本文件**不缓存**「我认为的当前 lane」：缓存必然与引擎漂移
    //     （别处切了 lane，UI 还高亮旧的，点停就停错人）。lane 容器显隐每次都按真相源现算。
    //   · 可用性一律**显式**：orchestrator 取不到、快照判据缺失（`degraded`）、切换入口未接线
    //     ——都如实显示/提示，不假装「三条 lane 都空闲」或「已经切过去了」。
    //
    // 刷新节奏：状态变化事件驱动 + **tab 可见时** 1s 轮询兜底。
    //   · 事件面：`ae:team-state-changed`（本文件在自身动作后派发；派单、子 Agent 完成等
    //     也可派发同一事件）+ `notifyLaneActivity()`（main.js 的 reflect 钩子在三条 view 的循环里调，
    //     消息渲染 = 该 lane 有活动）。
    //   · 轮询**只在「团队任务」tab 可见时存在**（隐藏即 clearInterval）：面板可能整夜开着，
    //     tab 不在前台时一次都不该跑（真机 CPU 与 AE 队列无关但白白占主线程）。
    //
    // DOM 约定（index.html 的骨架 + 本文件生成的部分）：
    //   #scriptListShell             — 左抽屉壳：tab 条与 #teamTaskPanel 在其内
    //   #teamDrawerTabs              — 「计划 | 团队任务」（静态骨架，本文件绑事件）
    //   #teamTaskPanel               — 任务板面板（静态骨架；**行由本文件渲染**）
    //   #teamBoardLanes              — 运行态段的行容器（静态骨架，本文件只填行）
    //   #teamBoardTasks              — 团队任务清单段的行容器（**本文件动态建**：段不进骨架，
    //                                  否则「老骨架 + 新脚本」这类组合会少一个容器；行由本文件渲染）
    //   #teamBoardSubagents          — 子 Agent 段的行容器（同样动态建）
    //   #teamBoardFiles              — 工作区文件段的行容器（静态骨架，本文件只填行）
    // 注：**工作项段已下线**（派单退化成一次投递，结论由对方完成后自己 send_message
    // 回来；此后不再有完成回投，那一段没有数据来源），
    // 容器 #teamBoardItems / 派单派生面 deriveItemView / 渲染函数 _renderItems 都**已不存在**
    // ——别按旧契约去找它们。
    // 子 Agent 的内联卡片也不再由本文件推：聊天区不出卡片（与团队面板重复），
    // 卡片面留在 engine/view.js（冻结签名）供老部署/单测持有。

    var POLL_MS = 1000;
    var COALESCE_MS = 150;      // 事件驱动的合并窗口：一轮工具循环会连发多次渲染通知
    var TAB_PLAN = 'plan';
    var TAB_TEAM = 'team';

    // 状态 → 排序档（「正在跑的置顶高亮」）：等确认 > 工具 > 思考 > 出错 > 空闲。
    // 与 orchestrator 的优先级判据（confirm > busy > error > idle）同序，不另立一套语义。
    var STATUS_RANK = { confirm: 0, tool: 1, thinking: 2, error: 3, idle: 4 };
    // 读时才翻译：顶层求值会在无 AEI18n 的沙箱抛 ReferenceError。
    var STATUS_TEXT_FALLBACK = {
        get idle() { return AEI18n.t('空闲'); },
        get thinking() { return AEI18n.t('思考中'); },
        get tool() { return AEI18n.t('工具执行中'); },
        get confirm() { return AEI18n.t('等待确认'); },
        get error() { return AEI18n.t('出错'); }
    };

    var _mounted = false;
    var _opts = {};
    var _activeTab = TAB_PLAN;
    var _pollTimer = null;       // tab 可见时存在的 1s 兜底轮询
    var _coalesceTimer = null;   // 事件驱动的合并窗口
    var _seenMsgCount = {};      // laneId -> 已读的消息条数（未读标记的判据）
    var _unreadMap = {};         // laneId -> true：本次渲染要打未读点（由 unreadLanes() 现算，与行渲染同批）
    var _tasksSection = null;    // 任务清单段的容器引用（#teamBoardTasks 由本文件建，不在 index.html 骨架里）
    var _taskDetail = null;      // 任务详情悬浮窗（点任务行打开；同一时刻最多一个）
    var _taskDetailAnchor = null;// 当前浮层对应的行节点（再点同一行 = 关闭）
    var _taskDetailDocBound = false; // 文档级关闭监听的幂等位（点外部 / Esc / 滚动）
    // 工作区文件浮层（左抽屉要能打开计划书 / 文字分镜，点击弹窗 + markdown）。
    // 与任务详情同一套关闭语义（再点同一行/点外部/Esc/滚动/unmount/面板隐藏）。
    var _filePopover = null;       // 文件浮层（挂 body；同一时刻最多一个）
    var _filePopoverAnchor = null; // 当前浮层对应的文件行（再点同一行 = 关闭）
    var _fileReqSeq = 0;           // 异步读取序号：关闭/换文件后在途回填作废（防串内容）
    var _filesSig = '';            // 已渲染的文件清单签名（名称序列）；不变就不重建行（浮层锚点/焦点保持）
    var _nodes = null;           // 本文件建的节点引用（顶栏栏位；重挂载时重建）
    var _subagentsSection = null; // 子 Agent 段的容器引用（#teamBoardSubagents 同上）
    var _docEventBound = false;  // 状态变化事件的订阅幂等位（mount 可被重复调用）
    var _lastActivityLane = '';  // 最近一次活动的 lane（诊断/单测观察点）
    var _lastSnapshot = null;    // 最近一次渲染用的快照（单测与诊断观察点）
    var _lastMode = '';          // 最近一次由宿主显式推来的 runtimeMode（见 syncModeChrome）
    var _toggleInFlight = false; // 团队开关的落盘在途位（在途期间不按设置段回写勾选态，防闪回）
    // 任务板各段的折叠态：
    // 键 = 段名（lanes/tasks/subagents），值 = true 表示已折叠。**内存态**，与「计划 | 团队任务」
    // 的 _activeTab 同款：unmount 时一并复位（面板重载/模块重挂载后回默认展开）——折叠是一次性的
    // 阅读辅助，不占设置字段，也不该跨挂载周期活着（同一挂载周期内的重渲染当然要保持，见 unmount）。
    var _collapsedSections = {};

    // ── 注入/缺省环境访问 ────────────────────────────────────────────────
    function _doc() {
        return _opts.doc || global.document;
    }

    function _timers() {
        return _opts.timers || global;
    }

    function _byId(id) {
        var d = _doc();
        return (d && id) ? d.getElementById(id) : null;
    }

    function _now() {
        if (typeof _opts.now === 'function') {
            try {
                var v = _opts.now();
                if (typeof v === 'number' && isFinite(v)) return v;
            } catch (_) { /* 时钟抛错回落系统钟：任务板不该因注入的钟整块不渲染 */ }
        }
        return Date.now();
    }

    // 编排面：`AEEngine.getOrchestrator()`（bootstrap 的公开访问器）为主。团队关闭/未装配时为 null
    // ⇒ 调用方走「无编排面」分支（开关仍可点，只是如实提示没装上）。
    function _orchestrator() {
        if (typeof _opts.getOrchestrator === 'function') {
            try { return _opts.getOrchestrator() || null; } catch (_) { return null; }
        }
        var eng = global.AEEngine;
        if (eng && typeof eng.getOrchestrator === 'function') {
            try { return eng.getOrchestrator() || null; } catch (_) { return null; }
        }
        // 回落（老包 / 别的装配方式）：模块级编排面句柄。取不到就是 null，不现造一个。
        var team = global.AEAgentTeam;
        return (team && team.orchestrator) ? team.orchestrator : null;
    }

    // lane 定义（展示顺序 = 定义顺序，唯一事实源在 team/lanes.js）：缺编排面时直接问 lanes 访问器
    // ——开关与 tab 条在「团队刚打开、runtime 还没建好」的窗口里也要有骨架可渲染。
    function _laneDefs() {
        var orch = _orchestrator();
        if (orch && typeof orch.lanes === 'function') {
            try {
                var list = orch.lanes();
                if (list && list.length) return list;
            } catch (_) { /* 定义源抛错 → 回落 lanes 访问器 */ }
        }
        var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
        if (api && typeof api.list === 'function') {
            try { return api.list() || []; } catch (_) { return []; }
        }
        return [];
    }

    function _laneIds() {
        var defs = _laneDefs();
        var ids = [];
        for (var i = 0; i < defs.length; i++) {
            if (defs[i] && defs[i].id) ids.push(defs[i].id);
        }
        return ids;
    }

    // ── 任务板各段的折叠 ──
    // 段 = #teamTaskPanel 里的 .team-board-section（运行态 / 团队任务清单 / 子 AGENT）。
    // 三条实现约束：
    //  ① 折叠**只写类** .is-collapsed（展开态是默认）——三段的**行容器类名不是一一对应**的
    //    （团队任务清单段的容器是 `.team-board-items`，运行态段是 `.team-board-lanes`，
    //     子 Agent 段是 `.team-board-subagents`），样式一刀切
    //    （`.team-board-section.is-collapsed > *:not(.team-board-title)`）比逐个列举稳；
    //  ② 指示箭头用 CSS 的 ::after 画，**不往标题里塞子节点**：标题文字由渲染反复改写
    //    （如「团队任务清单 · 导演 更新」），塞进去会被 textContent 冲掉；
    //  ③ 绑定幂等（data-collapse-bound 标记）：这些 _ensure*Section 每次渲染都会被调到。
    function _sectionCollapsed(key) {
        return _collapsedSections[key] === true;
    }
    function _applySectionCollapsed(section, key) {
        if (!section || !section.classList) return;
        if (_sectionCollapsed(key)) section.classList.add('is-collapsed');
        else section.classList.remove('is-collapsed');
        var title = (section.querySelector) ? section.querySelector('.team-board-title') : null;
        if (title && title.setAttribute) title.setAttribute('aria-expanded', _sectionCollapsed(key) ? 'false' : 'true');
    }
    function _makeCollapsible(section, key) {
        if (!section || !key) return section;
        if (section.getAttribute && section.getAttribute('data-collapse-bound') === '1') {
            _applySectionCollapsed(section, key);   // 已绑过：只重放当前状态（幂等）
            return section;
        }
        if (section.setAttribute) {
            section.setAttribute('data-section', key);
            section.setAttribute('data-collapse-bound', '1');
        }
        var title = (section.querySelector) ? section.querySelector('.team-board-title') : null;
        if (title) {
            if (title.setAttribute) {
                title.setAttribute('role', 'button');
                title.setAttribute('tabindex', '0');
                title.setAttribute('title', AEI18n.t('点击折叠/展开这一段'));
            }
            var toggle = function (e) {
                if (e && e.preventDefault) e.preventDefault();
                _collapsedSections[key] = !_sectionCollapsed(key);
                _applySectionCollapsed(section, key);
            };
            title.addEventListener('click', toggle);
            title.addEventListener('keydown', function (e) {
                // 按住回车/空格会重复派发 keydown：不挡 repeat 就会来回翻转，
                // 终态取决于重复次数奇偶。挡掉重复事件，一次按键只翻一次。
                if (e && e.repeat) return;
                var k = e && (e.key !== undefined ? e.key : e.keyCode);
                if (k === 'Enter' || k === ' ' || k === 'Spacebar' || k === 13 || k === 32) toggle(e);
            });
        }
        _applySectionCollapsed(section, key);
        return section;
    }
    // 段的收尾：挂折叠绑定（幂等）后原样返回。三个 _ensure*Section 的**每条**返回路径都过它
    // （子 Agent 段的缓存命中路径若裸返回 ⇒ 折叠态不会重放）。
    // 另：只认真正的段节点——`_makeCollapsible` 会往任何传入节点挂 data-section/
    // is-collapsed，并用 `querySelector('.team-board-title')` 写 aria（子树里第一个标题可能是邻段的）。
    function _finishSection(sec, key) {
        if (sec && sec.section && sec.section.classList && sec.section.classList.contains('team-board-section')) {
            _makeCollapsible(sec.section, key);
        }
        return sec;
    }

    // 运行态段是**静态骨架**（index.html 里就有），没有 _ensure*Section：这里按 id 认它的宿主
    function _makeRuntimeSectionCollapsible() {
        var host = _byId('teamBoardLanes');
        if (!host) return null;
        var section = host.parentNode;
        // 向上找到「带标题的那一层」：宿主是 .team-board-lanes，父节点是 .team-board-section
        if (section && section.classList && section.classList.contains('team-board-section')) {
            return _makeCollapsible(section, 'lanes');
        }
        return null;
    }
    // 可编程出口：折叠某一段（或取当前折叠表）
    function toggleBoardSection(key, collapsed) {
        if (!key) return false;
        _collapsedSections[key] = (typeof collapsed === 'boolean') ? collapsed : !_sectionCollapsed(key);
        _applyAllSectionCollapsed();
        return _collapsedSections[key];
    }
    function isBoardSectionCollapsed(key) {
        return _sectionCollapsed(key);
    }
    function _applyAllSectionCollapsed() {
        var panel = _byId('teamTaskPanel');
        if (!panel || !panel.querySelectorAll) return;
        var secs = panel.querySelectorAll('.team-board-section');
        for (var i = 0; i < secs.length; i++) {
            var key = secs[i].getAttribute ? String(secs[i].getAttribute('data-section') || '') : '';
            if (key) _applySectionCollapsed(secs[i], key);
        }
    }

    // 团队模式是否「真的开着」：真相源 = 引擎的**团队态状态机**。
    // 旧判据是「当前 lane 非空」，它给不出两种真实态的答案：① 全失败已回滚（引擎回单 Agent，
    // 但 orchestrator 仍保留 currentLane）② 部分 lane 装配失败（partial，仍算开着）。两者用
    // 「当前 lane 非空」判都会得出错误结论——① 会让 UI 切成团队布局而引擎已在单 Agent 跑
    // （消息落隐藏容器），② 会把可用的那部分也当失败。故 state ∈ {on, partial, starting} 才算开；
    // 旧部署（无 getTeamState）回退到 getCurrentLaneId()，行为与改动前一致。
    function isTeamModeOn() {
        var eng = global.AEEngine;
        if (!eng) return false;
        if (typeof eng.getTeamState === 'function') {
            try {
                var ts = eng.getTeamState();
                if (ts && typeof ts.state === 'string') {
                    return ts.state === 'on' || ts.state === 'partial' || ts.state === 'starting';
                }
            } catch (_) { /* 状态出口异常：回退旧判据（判据抛错不该打穿整块布局） */ }
        }
        if (typeof eng.getCurrentLaneId !== 'function') return false;
        try { return !!eng.getCurrentLaneId(); } catch (_) { return false; }
    }

    function currentLaneId() {
        // 团队关闭 ⇒ **无 lane 语义**（返回空串）。orchestrator 的 currentLane 在 dispose 之后
        // 仍停在「最后看过的那条」上（实例保留、会话绑定保留，重开即恢复），
        // 直接读它会让单 Agent 路径拿到一条并不生效的 lane：顶栏用量行会去镜像那条 lane 的
        // 节点（显示的根本不是当前会话的用量）、lane 切换条也会把旧 lane 标成 current。
        if (!isTeamModeOn()) return '';
        var orch = _orchestrator();
        if (orch && typeof orch.getCurrentLane === 'function') {
            try {
                var cur = orch.getCurrentLane();
                if (cur) return cur;
            } catch (_) { /* 回落引擎访问器 */ }
        }
        var eng = global.AEEngine;
        if (eng && typeof eng.getCurrentLaneId === 'function') {
            try { return eng.getCurrentLaneId() || ''; } catch (_) { return ''; }
        }
        return '';
    }

    function _laneRuntime(id) {
        var orch = _orchestrator();
        if (!orch || typeof orch.getLane !== 'function' || !id) return null;
        try { return orch.getLane(id) || null; } catch (_) { return null; }
    }

    // 一条 runtime（lane 或主 Agent 那条）的锁相关标志。判据**只取真机存在的信号**

    //   · busy      — `state.busy`（真 controller 的 `isBusy()` / `getState()` 都给得出）；
    //   · restoring — `state.restoring`（bootstrap 的启动恢复链在跑；`_setRestoringAll` 把它写进
    //                 **每条** runtime 的 state，`createLaneRuntime` 也会继承 ⇒ 公开可读）
    //                 ——这期间切会话会与「各 lane 各自消费 lastActiveId」的恢复链抢同一份数据；
    //   · switching — controller 真的暴露 `getSwitching()/isSwitching()` 时才读
    //                 （真 controller 有这四个公开出口，见 controller.js 的 api：
    //                 `_switching || _adoptRestoring > 0` / `_stopping` ⇒ 这条腿**不再恒假**；
    //                 仍按能力探测读，是为了老装配/旧混合包不至于在这一行抛错）。
    // 为什么不再把 controller 的 stopping/switching 当既有防线：能力探测拿不到真实状态时那条腿**恒 false**，
    // 等于没有防线（假绿）。此外 in-flight 的「整队切换」真相始终在 binder，由 anyLaneLocked 直接问它
    //（binder 的在途位与各 controller 的自报窗口是两件事：前者是这份判据的第三个信号）。
    // 判据与主 Agent 那条**共用本函数**：同一个 runtime 形状、同一份探测口径，不许各写一套。
    function runtimeFlags(rt) {
        var st = (rt && rt.state) || null;
        var c = (rt && rt.controller) || null;
        var ctlSwitching = false;
        try {
            if (c && typeof c.getSwitching === 'function') ctlSwitching = !!c.getSwitching();
            else if (c && typeof c.isSwitching === 'function') ctlSwitching = !!c.isSwitching();
        } catch (_) { ctlSwitching = false; }
        var ctlBusy = false;
        try {
            if (c && typeof c.isBusy === 'function') ctlBusy = !!c.isBusy();
        } catch (_) { ctlBusy = false; }
        return {
            busy: !!(st && st.busy === true) || ctlBusy,
            restoring: !!(st && st.restoring === true),
            switching: ctlSwitching
        };
    }

    function laneFlags(id) {
        return runtimeFlags(_laneRuntime(id));
    }

    // `_mainRuntime()` 随团队主通道移除——团队档内没有单 Agent
    // runtime，锁判据只剩「三条 lane + binder 整队切换」；从 AEEngine.getMainRuntime 读
    // 「主 Agent 在途」的两条腿（任何一次 lane 侧刷新都会把主 Agent 的锁解掉，N7）一并删除。

    // 团队会话 binder（整队切换的唯一真相源）。解析顺序与 engine/sessionSwitcher.js 的 `_binder()`
    // 同源：全局单例 → AEAgentTeam.getSessionBinder() → AEEngine.getSessionBinder()。
    // 拿不到就是 null（旧部署/单测环境）——不猜、不因此认为「没在切换」之外的任何事。
    function _sessionBinder() {
        var T = global.AEAgentTeam;
        if (T && T.sessionBinder) return T.sessionBinder;
        if (T && typeof T.getSessionBinder === 'function') {
            try { var b = T.getSessionBinder(); if (b) return b; } catch (_) { /* 回落下一来源 */ }
        }
        var E = global.AEEngine;
        if (E && typeof E.getSessionBinder === 'function') {
            try { var b2 = E.getSessionBinder(); if (b2) return b2; } catch (_) { /* 拿不到 */ }
        }
        return null;
    }

    // binder 自己「整队切换进行中」的对外出口：isSwitching / getSwitching
    // 两种名字都认，都没有就按「没在切」处理。
    function _binderSwitching() {
        var b = _sessionBinder();
        if (!b) return false;
        try {
            if (typeof b.isSwitching === 'function') return !!b.isSwitching();
            if (typeof b.getSwitching === 'function') return !!b.getSwitching();
        } catch (_) { return false; }
        return false;
    }

    // **会话切换器与「全部停止」禁用态的唯一判据**（宿主 index.js 与「全部停止」
    // 的可用性都用它，不再各写一套）。命中任一条即锁：
    //   · 某条 lane busy（真 `state.busy`）/ 正在跑启动恢复链（真 `state.restoring`）；
    //   · controller 真的自报在切会话 / 在历史回读（真 controller 的 isSwitching/getSwitching）；
    //   · binder 的整队切换在途（in-flight 的真相在 binder，不在各 lane 的 controller）。
    // 团队关闭时恒为 false——单 Agent 路径的锁由 chatViewHelpers 经
    // AEEngine.setSessionSwitcherDisabled 驱动，不走这里（两条路不叠加）。
    function anyLaneLocked() {
        if (!isTeamModeOn()) return false;
        if (_binderSwitching()) return true;
        var ids = _laneIds();
        for (var i = 0; i < ids.length; i++) {
            var f = laneFlags(ids[i]);
            if (f.busy || f.restoring || f.switching) return true;
        }
        return false;
    }

    // 「全部停止」的可用性判据（**从 anyLaneLocked 拆出**）。
    // 为什么不能沿用 anyLaneLocked：那是**会话切换器**的锁（「有人在跑时别切会话」），含 busy /
    // restoring 两腿；把这套判据用到「全部停止」上语义正好相反 —— 用户点它**就是为了停**正在跑的
    // lane，而忙时那颗按钮却是 disabled。真机取证：lane 忙 ⇒
    // disabled=true，**真鼠标点击 clicks=0（点不动）**；空闲 ⇒ clicks=1。

    // 现在的判据只保留**切换/回读在途**这一腿：那时 stopAll 会与 binder 的整队动作打架（停止打断
    // 正在执行的 adopt，会留下半切状态）。busy / restoring 不作为禁用理由：
    //   · busy 正是要停的对象（`orchestrator.stopAll` 对忙 lane 是正常停止、不拒）；
    //   · 启动恢复链（restoring）期间点停止是幂等 no-op，没有任何冲突面。
    function _stopAllDisabled() {
        if (!isTeamModeOn()) return false;
        if (_binderSwitching()) return true;
        var ids = _laneIds();
        for (var i = 0; i < ids.length; i++) {
            if (laneFlags(ids[i]).switching) return true;
        }
        return false;
    }

    // ── 快照与行渲染 ────────────────────────────────────────────────────
    // 子 Agent 行：**唯一来源**是编排面快照的 subagents 段（池的 list() 接到那里）。
    // 本文件不直接摸池句柄：并发闸与保活到期回收都住在池里（回收靠 `list()` 读取时懒触发），
    // UI 再拿一个句柄就多出一份判据——那正是把「谁在跑」锁进 orchestrator 的同一条理由。
    // 编排面 / 该方法缺席（团队关闭、老装配）⇒ 空数组：既不编造一条，也不把「看不到」伪装成失败。
    function _subagentRows() {
        var orch = _orchestrator();
        if (!orch || typeof orch.getBoardSnapshot !== 'function') return [];
        try {
            var snap = orch.getBoardSnapshot();
            var rows = (snap && snap.subagents) || [];
            return (rows && typeof rows.length === 'number') ? rows : [];
        } catch (_) { return []; }
    }

    // 快照 = taskBoard.js 的纯函数（判据复用的唯一意义所在）。runtimes 逐 lane 现取：
    // getLane 在「lane 还没建好」时返回 null，纯函数对 null runtime 也出一行 idle（三条 lane 恒在）。
    function buildSnapshot() {
        var defs = _laneDefs();
        var runtimes = {};
        for (var i = 0; i < defs.length; i++) {
            var id = defs[i] && defs[i].id;
            if (!id) continue;
            var rt = _laneRuntime(id);
            if (rt) runtimes[id] = rt;
        }
        var board = global.AEAgentTeam && global.AEAgentTeam.buildBoardSnapshot;
        if (typeof board !== 'function') {
            // 判据/组装面缺席（manifest 载序错）：如实给 degraded + unavailable（红字提示），
            // 但**仍按 lane 定义出行**。给 `lanes: []` ⇒ 0 行 ⇒ 唯一入口一起消失：
            // 行即切换入口，0 行等于用户连切 Agent 都没法切，而
            // `_laneDefs()` 明明还给得出三条 lane 的 id/label（定义源与组装面是两个模块）。
            // 行状态照实说「不可用」，不冒充「空闲」（busyText 优先于 idle 的默认文案）。
            var degradedRows = [];
            for (var di = 0; di < defs.length; di++) {
                var d = defs[di] || {};
                if (!d.id) continue;
                degradedRows.push({
                    id: d.id,
                    label: d.label || d.id,
                    status: 'idle',
                    busyText: AEI18n.t('状态不可用'),
                    toolName: '',
                    elapsedMs: 0,
                    subagentCount: 0
                });
            }
            return { lanes: degradedRows, subagents: [], degraded: true, unavailable: true };
        }
        return board({
            lanes: defs, runtimes: runtimes, now: _now(),
            subagents: _subagentRows()
        });
    }

    // 「正在跑的置顶」：按状态档排序，同档保持定义顺序（sort 的稳定性不依赖引擎实现——
    // 显式带上原始下标做次级键，Chrome 88 之外的实现也不会打乱）。
    function orderBoardRows(rows) {
        var arr = (rows && rows.length) ? rows.slice() : [];
        var wrapped = [];
        for (var i = 0; i < arr.length; i++) wrapped.push({ row: arr[i], idx: i });
        wrapped.sort(function (a, b) {
            var ra = STATUS_RANK[(a.row && a.row.status) || 'idle'];
            var rb = STATUS_RANK[(b.row && b.row.status) || 'idle'];
            if (ra === undefined) ra = STATUS_RANK.idle;
            if (rb === undefined) rb = STATUS_RANK.idle;
            if (ra !== rb) return ra - rb;
            return a.idx - b.idx;
        });
        var out = [];
        for (var j = 0; j < wrapped.length; j++) out.push(wrapped[j].row);
        return out;
    }

    function _isBusyStatus(status) {
        return status === 'tool' || status === 'thinking' || status === 'confirm';
    }

    function _rowText(row) {
        var base = row && row.busyText ? String(row.busyText) : (STATUS_TEXT_FALLBACK[(row && row.status) || 'idle'] || '');
        // 「等待确认」**不挂秒数**：手上的 elapsedMs 是「本轮」耗时
        // （orchestrator 按 busySince 起算），不是「已经等你多久」；挂在「等待确认」后面会被读成
        // 「已等你 12 秒（30 秒就按拒绝处理）」——口径不对的秒数比没有秒数更误导。
        if (row && row.status === 'confirm') return base;
        // 耗时文案的唯一格式化处是 taskBoard.formatElapsed（不在 UI 层再写一份 '12s'）
        var fmt = global.AEAgentTeam && global.AEAgentTeam.formatElapsed;
        var elapsed = (typeof fmt === 'function') ? fmt(row ? row.elapsedMs : 0) : '--';
        if (_isBusyStatus(row && row.status)) return base + ' ' + elapsed;
        return base;
    }

    // 运行态段的一行：名称 + 状态点 + 当前动作 + 子 Agent 数。
    // **行即切换入口**（切换入口与运行态结合，点行就切、不要独立入口）：
    //   · 节点是 `<button>`（键盘可达、语义正确），点击经容器**委托**处理（见 _bindLaneRowsHost）——
    //     委托而不是逐行绑：行按 index 复用、忙碌行还会被排到前面，逐行绑会在复用后指错 lane；
    //   · 当前 lane 行 `aria-current="true"` + `.is-current`（左侧高亮条）；
    //   · 未读标记（●）在这里显示（unreadLanes 判据继续用，不重写一份）。
    // 节点**复用**：只改文本/类，不整块重建——1s 一次的轮询若重建 DOM，会把用户正在
    // 划选/悬停的节点抽掉（真机表现为「任务板一闪一闪」）。
    function _renderLaneRow(container, row, index) {
        var doc = _doc();
        var rowEl = container.children[index];
        if (!rowEl) {
            rowEl = doc.createElement('button');
            rowEl.type = 'button';
            rowEl.className = 'team-board-row';
            var dot = doc.createElement('span');
            dot.className = 'team-board-dot';
            var name = doc.createElement('span');
            name.className = 'team-board-name';
            var text = doc.createElement('span');
            text.className = 'team-board-text';
            var sub = doc.createElement('span');
            sub.className = 'team-board-sub';
            var unread = doc.createElement('span');
            unread.className = 'team-board-unread';
            unread.textContent = '●';
            rowEl.appendChild(dot);
            rowEl.appendChild(name);
            rowEl.appendChild(text);
            rowEl.appendChild(sub);
            rowEl.appendChild(unread);
            rowEl.setAttribute('data-lane', row.id || '');
            container.appendChild(rowEl);
        }
        var status = (row && row.status) || 'idle';
        var busy = _isBusyStatus(status);
        var isCur = !!(row && row.id === currentLaneId());
        rowEl.setAttribute('data-lane', (row && row.id) || '');
        rowEl.setAttribute('data-status', status);
        rowEl.className = 'team-board-row' + (busy ? ' is-running' : '')
            + (status === 'confirm' ? ' is-confirm' : '')
            + (status === 'error' ? ' is-error' : '')
            + (isCur ? ' is-current' : '');
        if (isCur) rowEl.setAttribute('aria-current', 'true');
        else if (rowEl.removeAttribute) rowEl.removeAttribute('aria-current');
        if (rowEl.setAttribute) {
            rowEl.setAttribute('title', (isCur ? AEI18n.t('当前 Agent：') : AEI18n.t('点击切换到：'))
                + ((row && row.label) || (row && row.id) || '') + AEI18n.punct('（', ' (') + _rowText(row) + AEI18n.punct('）', ')'));
        }
        if (rowEl.children[0]) rowEl.children[0].className = 'team-board-dot is-' + status;
        if (rowEl.children[1]) rowEl.children[1].textContent = (row && row.label) || (row && row.id) || '';
        if (rowEl.children[2]) rowEl.children[2].textContent = _rowText(row);
        if (rowEl.children[3]) {
            var n = (row && row.subagentCount) || 0;
            rowEl.children[3].textContent = n > 0 ? (AEI18n.t('子 Agent ') + n) : '';
        }
        if (rowEl.children[4]) rowEl.children[4].hidden = !_unreadMap[row && row.id];
        return rowEl;
    }

    // 运行态行的点击入口（**委托一次**，绑在容器上；容器由 index.html 静态提供，不随行复用变化）。
    // 幂等：容器上打标记，重挂/重复 mount 不会叠第二个监听。
    function _bindLaneRowsHost() {
        var host = _byId('teamBoardLanes');
        if (!host || host.__aeLaneRowsBound) return host;
        host.__aeLaneRowsBound = true;
        host.addEventListener('click', function (e) {
            var n = e && e.target;
            var rowEl = null;
            while (n && n !== host) {
                // 精确类名：行是 `team-board-row`，子节点是 `team-board-dot/-name/-text/-sub/-unread`
                // ——同 `_findTaskRow` 的口径，不用子串匹配（否则将来子节点叫 `team-board-row-*` 时，
                // 点文字会命中子节点而不是行，data-lane 读空 ⇒ 点击静默失效）。
                if (n.className && (' ' + String(n.className).replace(/\s+/g, ' ') + ' ').indexOf(' team-board-row ') >= 0) {
                    rowEl = n;
                    break;
                }
                n = n.parentNode;
            }
            if (!rowEl) return;
            var id = rowEl.getAttribute('data-lane');
            if (id) _onLaneClick(id);
        });
        return host;
    }

    // ── 团队任务清单段（**三条 lane 共用一份**）────────────
    // 团队模式下计划工具不暴露给 lane，改为「全新的团队任务工具」`updateTeamTasks`（controller 注册，
    // scope moduleIds:['team']）；它的产出落在这段里。数据源是 `AEEngine.getTeamTaskList()`
    // （团队会话级的 tasks.json），**不是**某条 lane 的 activePlan——详见 _renderTeamTasks。
    // 容器动态建（老骨架也能渲染；容器 id #teamBoardTasks 不进 index.html 骨架）。
    function _ensureTasksSection() {
        var panel = _byId('teamTaskPanel');
        if (!panel) return null;
        var sec = _tasksSection;
        if (sec && sec.section && sec.section.parentNode === panel) return _finishSection(sec, 'tasks');
        var existing = _byId('teamBoardTasks');
        if (existing) {
            sec = { section: existing.parentNode || existing, host: existing, title: null };
            _tasksSection = sec;
            return _finishSection(sec, 'tasks');
        }
        var doc = _doc();
        if (!doc || typeof doc.createElement !== 'function') return null;
        var section = doc.createElement('div');
        section.className = 'team-board-section';
        var titleEl = doc.createElement('div');
        titleEl.className = 'team-board-title';
        titleEl.textContent = AEI18n.t('任务清单');
        var host = doc.createElement('div');
        host.className = 'team-board-items';
        host.id = 'teamBoardTasks';
        section.appendChild(titleEl);
        section.appendChild(host);
        panel.appendChild(section);
        _tasksSection = { section: section, host: host, title: titleEl };
        return _finishSection(_tasksSection, 'tasks');
    }

    // ── 团队任务清单段（**三条 lane 共用一份**）────────────────────────────
    // 数据源：`AEEngine.getTeamTaskList()`（team/taskList.js 的实例，按**团队会话**隔离，
    // 落 `<工作区>/tasks.json`）——**三条 lane 共用同一份**，故标题不带 lane 名、切 lane 不变色。
    // 不能用「当前 lane 的 activePlan」：那是每条 lane 各一份，导演拆的任务 AE 执行看不见。
    // 空清单 ⇒ 出一行占位（与子 Agent 段**同一个 helper**、同一套类名规则：空态可见，不是空白块）。
    function _teamTaskList() {
        try {
            var e = global.AEEngine;
            return (e && typeof e.getTeamTaskList === 'function') ? (e.getTeamTaskList() || null) : null;
        } catch (_) { return null; }
    }

    // 面板是否可见（**三段共用的一道门**：团队任务清单段 / 子 Agent 段 / 工作区文件段）。
    // 为什么是一道门而不是各写一遍：这两段同属 #teamTaskPanel，可见性判据只有一个
    // （`panel.hidden`）；各写一份必然漂——真机曾经是「面板隐藏时任务清单段照建照写、
    // 子 Agent 段一行不写」，同一时刻两段行为不一致，谁都说不清哪边是对的。
    // 隐藏时**一次 DOM 写入都不做**（连段容器都不建）：面板可能整夜开着，隐藏的段不该占主线程。
    function _boardSectionsVisible() {
        var panel = _byId('teamTaskPanel');
        return !!(panel && !panel.hidden);
    }

    function _renderTeamTasks() {
        if (!_boardSectionsVisible()) { _hideTaskDetail(); return 0; }   // 与子 Agent 段同一道门（见 _boardSectionsVisible）
        var sec = _ensureTasksSection();
        if (!sec || !sec.host) return 0;
        var doc = _doc();
        var tl = _teamTaskList();
        var snap = null;
        try { snap = tl ? tl.snapshot() : null; } catch (_) { snap = null; }
        var steps = (snap && snap.steps) || [];
        var byLabel = '';
        if (snap && snap.updatedBy) {
            var defs = _laneDefs();
            byLabel = snap.updatedBy;
            for (var di = 0; di < defs.length; di++) {
                if (defs[di] && defs[di].id === snap.updatedBy) byLabel = defs[di].label || snap.updatedBy;
            }
        }
        if (sec.title) {
            // 标题不带括号注：
            // 原为「团队任务清单（三条 Agent 共用）」——括号里的协作口径在**工具描述**里讲
            //（`updateTeamTasks` 的 description 有「三条 Agent 共用」），面板上不必重复占宽。
            sec.title.textContent = AEI18n.t('团队任务清单') + (byLabel ? ' · ' + byLabel + AEI18n.t(' 更新') : '');
        }
        var host = sec.host;
        _bindTaskRowsHost(host);   // 行点击 → 右侧详情浮层（容器委托一次；行节点每秒复用/增删）
        // 占位行必须先清掉：空清单时这一段渲染的是
        // `.team-board-placeholder`，而下面的行复用是**按下标取 `host.children[i]`** —— 占位行会被
        // 当成第 1 行"复用"（它没有三个格子 ⇒ 第一条任务永远不显示，其余行整体错位一条）。
        // 判据用类名（与 `_isTaskRow` 同款）：占位行与数据行是两种节点。
        while (host.children && host.children.length && !_isTaskRow(host.children[0])) {
            host.removeChild(host.children[0]);
        }
        while (host.children && host.children.length > steps.length) {
            host.removeChild(host.children[host.children.length - 1]);
        }
        if (!steps.length) {
            // 清单空了/换会话：详情浮层没有可依附的行了（早退路径也必须收，不然浮层会留在原地）
            _hideTaskDetail();
            var emptyText = AEI18n.t('暂无任务');
            if (!tl) {
                emptyText = AEI18n.t('暂无任务（团队任务清单未装配）');
            } else if (typeof tl.isReadFailed === 'function' && tl.isReadFailed()) {
                // 读失败保护态：如实说明「没读到 + 原文件未被触碰」，不假装清单是空的
                emptyText = AEI18n.t('清单读取失败，已保护原文件不被覆盖（重试或检查工作区 tasks.json）');
            }
            // 空态走**共用占位行 helper**（`_renderItemsPlaceholder`，子 Agent 段也用同一个）：
            // 占位行的节点种类/类名规则/复用语义只写一份——两段各写一份必然漂移
            // （这里若自写 .team-board-placeholder、子 Agent 段用 … is-empty，
            // 同一个面板里两段空态类名不一样）。
            // 空态文案不带括号注（与标题同款）：
            // 维护方式属于工具描述（`updateTeamTasks`），面板这行只说事实「暂无任务」。
            return _renderItemsPlaceholder(host, 'is-empty', emptyText);
        }
        for (var i = 0; i < steps.length; i++) {
            var s = steps[i] || {};
            var row = host.children[i];
            if (!row) {
                row = doc.createElement('div');
                row.className = 'team-board-item';
                var numEl = doc.createElement('span');
                numEl.className = 'team-board-item-num';
                var titleText = doc.createElement('span');
                titleText.className = 'team-board-item-summary';
                var stateEl = doc.createElement('span');
                stateEl.className = 'team-board-item-state';
                row.appendChild(numEl);
                row.appendChild(titleText);
                row.appendChild(stateEl);
                host.appendChild(row);
                if (row.setAttribute) {
                    // 键盘可达：与段标题的折叠键同一套语义（role/tabindex + Enter/Space）
                    row.setAttribute('role', 'button');
                    row.setAttribute('tabindex', '0');
                }
            }
            // 状态直读（清单存的就是 clean 形状 { number, description, status }）。
            // 兼容旧形状（_done/_running/_failed，单 Agent 的 activePlan 曾用过）——面板不该因为
            // 数据来源换过一代就渲染成空。
            var status = (typeof s.status === 'string' && s.status) ? s.status
                : (s._done ? (s._success === false ? 'failed' : 'done')
                    : (s._running ? 'running' : (s._failed ? 'failed' : 'pending')));
            if (row.children[0]) row.children[0].textContent = String(s.number == null ? (i + 1) : s.number) + '.';
            if (row.children[1]) row.children[1].textContent = s.description || '';
            if (row.children[2]) {
                var taskText = (global.AEAgentTeam && global.AEAgentTeam.TASK_STATUS_TEXT) || {};
                row.children[2].className = 'team-board-item-state is-' + status;
                row.children[2].textContent = taskText[status] || status;
            }
            row.className = 'team-board-item' + (status === 'running' ? ' is-running' : '');
        }
        // 清单重渲后行节点可能被裁剪/替换：浮层锚点不在容器里就关掉（不留一个脱离行的浮窗）。
        if (_taskDetail && _taskDetailAnchor && host.contains && !host.contains(_taskDetailAnchor)) _hideTaskDetail();
        return steps.length;
    }

    // ── 团队任务行详情悬浮窗（点任务行在右侧弹窗看详情）──────
    // 行上的描述只有一行（CSS ellipsis，长描述看不全）——点击行在这里看全文 + 状态 + 清单最近更新。
    // 浮层挂 body（fixed），不受左抽屉滚动容器裁剪；同一时刻只开一个；再点同一行/点外部/Esc/滚动/
    // 切走页签/unmount 都关闭。description 来自模型写入的清单，一律 textContent（防注入）。
    var TASK_DETAIL_GAP = 8;
    function _hideTaskDetail() {
        if (_taskDetail && _taskDetail.parentNode) {
            try { _taskDetail.parentNode.removeChild(_taskDetail); } catch (_) { /* 已被摘掉 */ }
        }
        _taskDetail = null;
        _taskDetailAnchor = null;
    }

    // 计划行浮层（ae-plan-detail）的实现归 engine/view.js；这里只在计划区让位时触发关闭
    //（浮层挂 body，不随 #scriptTree 隐藏消失）。
    function _closePlanDetailPopover() {
        var eng = global.AEEngine;
        if (!eng || typeof eng.closePlanDetail !== 'function') return;
        try { eng.closePlanDetail(); } catch (_) { /* 关闭失败不阻断路由 */ }
    }

    function _laneLabelOfId(id) {
        var defs = _laneDefs() || [];
        for (var i = 0; i < defs.length; i++) {
            if (defs[i] && defs[i].id === id) return defs[i].label || id;
        }
        return id || '';
    }

    // 清单级最近更新（任务本身没有逐条时间戳）：取不到就不显示。
    function _taskDetailMeta() {
        var tl = _teamTaskList();
        var snap = null;
        try { snap = tl ? tl.snapshot() : null; } catch (_) { snap = null; }
        if (!snap || !snap.updatedBy) return '';
        var text = AEI18n.t('清单最近更新：{by}', { by: _laneLabelOfId(snap.updatedBy) });
        if (typeof snap.updatedAt === 'number' && snap.updatedAt > 0) {
            try {
                var d = new Date(snap.updatedAt);
                var two = function (n) { return (n < 10 ? '0' : '') + n; };
                if (!isNaN(d.getTime())) text += ' · ' + two(d.getHours()) + ':' + two(d.getMinutes());
            } catch (_) { /* 时钟不可用：只显示更新者 */ }
        }
        return text;
    }

    // 位置：**行右侧**优先；右侧放不下时夹到视口内，纵向同样夹紧。
    // 拿不到 rect/尺寸（单测假 DOM、节流窗口）时给固定落点——宁可在固定位置显示，不要不显示。
    function _positionTaskDetail(pop, anchor) {
        var rect = null;
        try {
            rect = (anchor && typeof anchor.getBoundingClientRect === 'function') ? anchor.getBoundingClientRect() : null;
        } catch (_) { rect = null; }
        if (!rect) {
            pop.style.left = '320px';
            pop.style.top = '120px';
            return;
        }
        var w = (pop.offsetWidth && pop.offsetWidth > 0) ? pop.offsetWidth : 360;
        var h = (pop.offsetHeight && pop.offsetHeight > 0) ? pop.offsetHeight : 240;
        var vw = (typeof global.innerWidth === 'number' && global.innerWidth > 0) ? global.innerWidth : 0;
        var vh = (typeof global.innerHeight === 'number' && global.innerHeight > 0) ? global.innerHeight : 0;
        var left = rect.right + TASK_DETAIL_GAP;
        if (vw && left + w > vw - TASK_DETAIL_GAP) left = Math.max(TASK_DETAIL_GAP, vw - w - TASK_DETAIL_GAP);
        var top = rect.top;
        if (vh) top = Math.max(TASK_DETAIL_GAP, Math.min(top, vh - h - TASK_DETAIL_GAP));
        pop.style.left = Math.round(left) + 'px';
        pop.style.top = Math.round(top) + 'px';
    }

    function _bindTaskDetailDoc(d) {
        if (_taskDetailDocBound || !d || typeof d.addEventListener !== 'function') return;
        _taskDetailDocBound = true;
        // 点空白关闭：用 mousedown（先于 click）——打开那一下的 mousedown 发生在浮层创建前，
        // 不会自己把自己关掉；点在当前行上也不关，交给行自己的 click 做开/关切换。
        // 同一套关闭语义覆盖**任务详情**与**工作区文件**两个浮层（一次绑定，两条链）。
        d.addEventListener('mousedown', function (e) {
            var t = e && e.target;
            if (_taskDetail && !_popoverKeepsOpen(_taskDetail, _taskDetailAnchor, t)) _hideTaskDetail();
            if (_filePopover && !_popoverKeepsOpen(_filePopover, _filePopoverAnchor, t)) _hideFilePopover();
        }, true);
        d.addEventListener('keydown', function (e) {
            if (!e || (e.key !== 'Escape' && e.key !== 'Esc')) return;
            _hideTaskDetail();
            _hideFilePopover();
        });
        // 滚动/尺寸变化后锚点坐标失效：直接关闭，避免浮层与行脱开。
        // 浮层**内部**的滚动（长正文超出 max-height）不算——否则用户刚想滚正文就把浮层滚没了。
        d.addEventListener('scroll', function (e) {
            var t = e && e.target;
            if (_taskDetail && !(_taskDetail.contains && _taskDetail.contains(t))) _hideTaskDetail();
            if (_filePopover && !(_filePopover.contains && _filePopover.contains(t))) _hideFilePopover();
        }, true);
        if (typeof global.addEventListener === 'function') {
            global.addEventListener('resize', function () {
                if (_taskDetail) _hideTaskDetail();
                if (_filePopover) _hideFilePopover();
            });
        }
    }

    // 浮层的「保留打开」判据：点在浮层内或它自己的锚点行上都不关（锚点行交给行内 click 做开/关）。
    function _popoverKeepsOpen(pop, anchor, target) {
        if (!pop) return false;
        if (pop.contains && pop.contains(target)) return true;
        if (anchor && anchor.contains && anchor.contains(target)) return true;
        return false;
    }

    function _openTaskDetail(anchor, data) {
        var d = _doc();
        if (!d || typeof d.createElement !== 'function' || !d.body || typeof d.body.appendChild !== 'function') return false;
        if (_taskDetail && _taskDetailAnchor === anchor) {   // 同一行再点 = 关闭
            _hideTaskDetail();
            return false;
        }
        _hideTaskDetail();
        _hideFilePopover();   // 两个浮层互斥：同一时刻只开一个
        var pop = d.createElement('div');
        pop.className = 'ae-agent-popover team-task-detail';
        if (pop.setAttribute) pop.setAttribute('role', 'dialog');
        var title = d.createElement('span');
        title.className = 'popover-title team-task-detail-title';
        title.textContent = AEI18n.t('任务 ') + (data.number || '?') + ' · ' + (data.statusText || data.status || '');
        var desc = d.createElement('div');
        desc.className = 'team-task-detail-desc';
        desc.textContent = data.description || AEI18n.t('（无描述）');
        pop.appendChild(title);
        pop.appendChild(desc);
        if (data.meta) {
            var meta = d.createElement('div');
            meta.className = 'team-task-detail-meta';
            meta.textContent = data.meta;
            pop.appendChild(meta);
        }
        d.body.appendChild(pop);
        _taskDetail = pop;
        _taskDetailAnchor = anchor;
        _positionTaskDetail(pop, anchor);
        _bindTaskDetailDoc(d);
        return true;
    }

    // 任务行里取详情：编号/描述/状态都从**行节点**读（与渲染同源），不重算清单。
    function _taskDataOfRow(rowEl) {
        if (!rowEl || !rowEl.children || rowEl.children.length < 3) return null;
        var numText = String((rowEl.children[0] && rowEl.children[0].textContent) || '');
        numText = numText.replace(/\.\s*$/, '').replace(/^\s+|\s+$/g, '');
        var stateEl = rowEl.children[2] || null;
        var stateClass = String((stateEl && stateEl.className) || '');
        var m = /(?:^|\s)is-([a-z]+)(?:\s|$)/.exec(stateClass);
        return {
            number: numText,
            description: String((rowEl.children[1] && rowEl.children[1].textContent) || ''),
            status: m ? m[1] : '',
            statusText: String((stateEl && stateEl.textContent) || '')
        };
    }

    function _findTaskRow(node, host) {
        var n = node;
        while (n && n !== host) {
            var cls = ' ' + String(n.className || '') + ' ';
            if (cls.indexOf(' team-board-item ') >= 0) return n;   // 精确类名：别把 -num/-summary/-state 当行
            n = n.parentNode;
        }
        return null;
    }

    // 任务行的点击入口：宿主上**委托一次**（行节点每秒复用/增删，逐行绑会漏绑/叠绑）。
    function _bindTaskRowsHost(host) {
        if (!host || host.__aeTaskRowsBound) return host;
        host.__aeTaskRowsBound = true;
        host.addEventListener('click', function (e) {
            var rowEl = _findTaskRow(e && e.target, host);
            if (!rowEl) return;
            var data = _taskDataOfRow(rowEl);
            if (!data) return;
            data.meta = _taskDetailMeta();
            _openTaskDetail(rowEl, data);
        });
        host.addEventListener('keydown', function (e) {
            var key = e && e.key;
            if (key !== 'Enter' && key !== ' ' && key !== 'Spacebar') return;
            if (e.repeat) return;
            var rowEl = _findTaskRow(e && e.target, host);
            if (!rowEl) return;
            if (e.preventDefault) e.preventDefault();
            var data = _taskDataOfRow(rowEl);
            if (!data) return;
            data.meta = _taskDetailMeta();
            _openTaskDetail(rowEl, data);
        });
        return host;
    }

    // ── 工作区文件段（左抽屉要能打开计划书 / 文字分镜）──────
    // 内容源 = 团队工作区的文件表（workspace.listFiles()，唯一真相源：加文件类型只改那张表）；
    // 读取走 workspace.read(rel, 团队会话 id)（路径安全/数据目录/会话 id 全在它里面，UI 不拼路径）。
    // 点击文件行在右侧弹浮层；正文按 markdown 渲染（marked + js-xss，与聊天气泡同一条链）。
    // 文件不存在时显式说「尚未生成」，不显示空白（模型还没写与文件是空的必须可区分）。
    var FILE_ROW_CLASS = 'team-file-row';
    var FILE_POP_CLASS = 'team-file-popover';

    function _workspaceApi() {
        var E = global.AEEngine;
        if (!E || typeof E.getTeamWorkspace !== 'function') return null;
        var ws = null;
        try { ws = E.getTeamWorkspace(); } catch (_) { ws = null; }
        if (!ws || typeof ws.read !== 'function' || typeof ws.listFiles !== 'function') return null;
        var sid = '';
        try {
            var b = (typeof E.getSessionBinder === 'function') ? E.getSessionBinder() : null;
            sid = (b && typeof b.getCurrentSessionId === 'function') ? String(b.getCurrentSessionId() || '') : '';
        } catch (_) { sid = ''; }
        return { ws: ws, sid: sid };
    }

    function _workspaceFiles() {
        var api = _workspaceApi();
        if (!api) return null;
        try { return api.ws.listFiles() || []; } catch (_) { return null; }
    }

    function _workspaceRead(rel) {
        var api = _workspaceApi();
        if (!api) {
            return Promise.resolve({ ok: false, reason: 'no_workspace', message: AEI18n.t('团队工作区未装配') });
        }
        if (!api.sid) {
            return Promise.resolve({ ok: false, reason: 'no_team_session', message: AEI18n.t('团队会话尚未建立') });
        }
        try { return Promise.resolve(api.ws.read(rel, api.sid)); } catch (e) {
            return Promise.resolve({ ok: false, reason: 'error', message: AEI18n.t('读取异常：{reason}', { reason: (e && e.message) || e }) });
        }
    }

    function _hideFilePopover() {
        if (_filePopover && _filePopover.parentNode) {
            try { _filePopover.parentNode.removeChild(_filePopover); } catch (_) { /* 已被摘掉 */ }
        }
        _filePopover = null;
        _filePopoverAnchor = null;
        _fileReqSeq++;   // 作废在途读取：关闭后回来的内容不再写进任何浮层
    }

    // 文件行识别：**精确类名 token**（不能用 indexOf——`team-file-row-label` 会命中）。
    function _isFileRow(n) {
        return !!n && (' ' + String(n.className || '') + ' ').indexOf(' ' + FILE_ROW_CLASS + ' ') >= 0;
    }

    function _findFileRow(node, host) {
        var n = node;
        while (n && n !== host) {
            if (_isFileRow(n)) return n;
            n = n.parentNode;
        }
        return null;
    }

    // markdown 正文：走项目的唯一 markdown 链（marked + js-xss 白名单）。
    // 库缺席/抛错时退回纯文本（`is-plain` 保留换行）——宁可排版差，不可把原始文本渲染丢。
    // baseCls：容器自己的类名（文件浮层 / 子 Agent 会话弹窗各一档）；markdown 的阅读排版统一由
    // `.ae-agent-message-body` 提供（agent.css 那唯一一套），两个面不各造一份。
    function _renderMarkdownInto(el, text, baseCls, renderOptions) {
        var base = (typeof baseCls === 'string' && baseCls) ? baseCls : 'team-file-md';
        var app = global.AEAgentApp;
        var md = app && app.markdown;
        if (md && typeof md.render === 'function') {
            try {
                el.className = base + ' ae-agent-message-body';
                el.innerHTML = md.render(text, renderOptions || undefined);
                return true;
            } catch (_) { /* 落到纯文本 */ }
        }
        el.className = base + ' ae-agent-message-body is-plain';
        el.textContent = text;
        return false;
    }

    function _openFilePopover(anchor, entry) {
        var d = _doc();
        if (!d || typeof d.createElement !== 'function' || !d.body || typeof d.body.appendChild !== 'function') return false;
        if (_filePopover && _filePopoverAnchor === anchor) {   // 同一行再点 = 关闭
            _hideFilePopover();
            return false;
        }
        _hideTaskDetail();   // 两个浮层互斥：同一时刻只开一个
        _hideFilePopover();
        var pop = d.createElement('div');
        pop.className = 'ae-agent-popover ' + FILE_POP_CLASS;
        if (pop.setAttribute) pop.setAttribute('role', 'dialog');
        var title = d.createElement('span');
        title.className = 'popover-title team-file-popover-title';
        title.textContent = (entry.label || entry.name) + ' · ' + entry.name;
        var body = d.createElement('div');
        body.className = 'team-file-md ae-agent-message-body is-loading';
        body.textContent = AEI18n.t('读取中…');
        pop.appendChild(title);
        pop.appendChild(body);
        d.body.appendChild(pop);
        _filePopover = pop;
        _filePopoverAnchor = anchor;
        _positionTaskDetail(pop, anchor);
        _bindTaskDetailDoc(d);
        var seq = ++_fileReqSeq;
        _workspaceRead(entry.name).then(function (r) {
            // 浮层已被关闭 / 已换到别的文件 ⇒ 本次读取作废（防串内容）
            if (_filePopover !== pop || seq !== _fileReqSeq) return;
            if (r && r.ok === true) {
                var text = (typeof r.content === 'string') ? r.content : '';
                if (!text) {
                    body.className = 'team-file-md is-empty';
                    body.textContent = AEI18n.t('（文件为空）');
                } else {
                    _renderMarkdownInto(body, text);
                }
            } else if (r && r.reason === 'not_found') {
                body.className = 'team-file-md is-empty';
                body.textContent = AEI18n.t('尚未生成：工作区里还没有 ') + entry.name + AEI18n.punct('。', '.', '。');
            } else {
                body.className = 'team-file-md is-error';
                body.textContent = AEI18n.t('读取失败：') + ((r && r.message) || (r && r.reason) || AEI18n.t('未知原因'));
            }
            if (r && r.truncated) {
                // 读取面上限 64KB（workspace.MAX_READ_CHARS）：静默截断会让用户以为文件就这么多，显式提示。
                var note = d.createElement('div');
                note.className = 'team-file-truncated';
                note.textContent = AEI18n.t('内容超过 64KB，仅显示前 64K 字符（共 ') + (typeof r.size === 'number' ? r.size : '?')
                    + AEI18n.t(' 字符）');
                pop.appendChild(note);
            }
            _positionTaskDetail(pop, anchor);   // 内容落定后再夹一次位置（高度变了）
        }).catch(function (e) {
            // 生产 workspace.read 恒回 Result（不 reject）；这里兜住桩/将来实现 reject 的情况：
            // 不能让正文永久停在「读取中…」，也不能冒一条未处理的拒绝。
            if (_filePopover !== pop || seq !== _fileReqSeq) return;
            body.className = 'team-file-md is-error';
            body.textContent = AEI18n.t('读取失败：') + ((e && e.message) || e);
            _positionTaskDetail(pop, anchor);
        });
        return true;
    }

    function _bindFileRowsHost(host) {
        if (!host || host.__aeFileRowsBound) return host;
        host.__aeFileRowsBound = true;
        host.addEventListener('click', function (e) {
            var rowEl = _findFileRow(e && e.target, host);
            if (!rowEl) return;
            var rel = (rowEl.getAttribute) ? String(rowEl.getAttribute('data-file') || '') : '';
            if (!rel) return;
            var entry = null;
            var files = _workspaceFiles() || [];
            for (var i = 0; i < files.length; i++) {
                if (files[i] && files[i].name === rel) { entry = files[i]; break; }
            }
            _openFilePopover(rowEl, entry || { name: rel, label: rel });
        });
        return host;
    }

    // 段渲染：宿主是 index.html 的静态骨架（#teamBoardFiles）。骨架缺席（老部署/测试变体）
    // ⇒ 静默 0：不建第二份容器、不抛错（与运行态段同款降级）。
    function _renderWorkspaceFiles() {
        var host = _byId('teamBoardFiles');
        if (!host) return 0;
        // 可见性门在**一切 DOM 写入之前**（含折叠属性）：面板隐藏时一次写入都不做
        //（团队面板可能整夜开着，隐藏的段不该占主线程）。折叠绑定在可见分支里补。
        if (!_boardSectionsVisible()) { _hideFilePopover(); return 0; }
        var section = host.parentNode;
        if (section && section.classList && section.classList.contains('team-board-section')) {
            _makeCollapsible(section, 'files');
        }
        var files = _workspaceFiles();
        // 签名要区分「null（工作区未装配）」「空表」「有文件」三态——只用名字拼接时后两种同为空串，
        // 早退分支会让「文件被删空」后旧行永远留着。
        var sig = files ? ('list:' + files.map(function (f) { return f && f.name ? f.name : ''; }).join('|')) : 'none';
        // 清单没变 ⇒ 不重建行：1s 一次的兜底轮询不该每秒抽掉浮层的锚点行（节点引用保持）
        if (host.children && host.children.length && sig === _filesSig) return host.children.length;
        _filesSig = sig;
        while (host.children && host.children.length) host.removeChild(host.children[0]);
        // 占位行复用**同一个 helper**（团队任务清单段 / 子 Agent 段 / 工作区文件段三段同一套
        // 节点种类与类名规则，见 _renderItemsPlaceholder）
        if (!files) { _renderItemsPlaceholder(host, 'is-unavailable', AEI18n.t('团队工作区未装配')); return 0; }
        if (!files.length) { _renderItemsPlaceholder(host, 'is-empty', AEI18n.t('工作区还没有文件')); return 0; }
        var doc = _doc();
        if (!doc || typeof doc.createElement !== 'function') return 0;
        for (var i = 0; i < files.length; i++) {
            var f = files[i] || {};
            if (!f.name) continue;
            var btn = doc.createElement('button');
            btn.type = 'button';
            btn.className = FILE_ROW_CLASS;
            if (btn.setAttribute) {
                btn.setAttribute('data-file', f.name);
                btn.setAttribute('title', AEI18n.t('查看 ') + (f.label || f.name) + AEI18n.punct('（', ' (') + f.name + AEI18n.punct('）', ')'));
            }
            var labelEl = doc.createElement('span');
            labelEl.className = 'team-file-row-label';
            labelEl.textContent = f.label || f.name;
            var relEl = doc.createElement('span');
            relEl.className = 'team-file-row-rel';
            relEl.textContent = f.name;
            btn.appendChild(labelEl);
            btn.appendChild(relEl);
            host.appendChild(btn);
        }
        _bindFileRowsHost(host);
        // 清单变化后浮层锚点已不在容器里 ⇒ 关掉（不留一个脱离行的浮窗）
        if (_filePopover && _filePopoverAnchor && host.contains && !host.contains(_filePopoverAnchor)) {
            _hideFilePopover();
        }
        return host.children.length;
    }

    // 可编程出口：按文件名打开浮层（行不存在时返回 false，不造节点）
    function openWorkspaceFile(rel) {
        if (!rel) return false;
        var host = _byId('teamBoardFiles');
        if (!host || !host.children) return false;
        for (var i = 0; i < host.children.length; i++) {
            var row = host.children[i];
            var name = (row && row.getAttribute) ? String(row.getAttribute('data-file') || '') : '';
            if (name !== rel) continue;
            var entry = null;
            var files = _workspaceFiles() || [];
            for (var j = 0; j < files.length; j++) {
                if (files[j] && files[j].name === rel) { entry = files[j]; break; }
            }
            return _openFilePopover(row, entry || { name: rel, label: rel });
        }
        return false;
    }

    // 命中最内层「class 里含 cls 这个**词**」的祖先（含自身）。按词匹配，不用 indexOf 子串：
    // 子 Agent 行的五个子节点类名都以 `team-board-subagent` 开头（-title / -state / -elapsed /
    // -tokens / -lane），容器是 `team-board-subagents`；子串匹配会把子节点或容器当成行返回，
    // 而它们都没有 data-subagent-id ⇒ 点到文字上整条点击静默失效（真机：点条目没反应，
    // 只有点行内空白处才开）。判据是「类名列表里有一个词全等」，不是「字符串包含」。
    function _closestByClass(el, cls) {
        var n = el;
        var d = _doc();
        var needle = ' ' + String(cls).replace(/^\s+|\s+$/g, '') + ' ';
        while (n && n !== d) {
            if (n.className) {
                var hay = ' ' + String(n.className).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '') + ' ';
                if (hay.indexOf(needle) >= 0) return n;
            }
            n = n.parentNode;
        }
        return null;
    }

    // 占位行（空态 / 派生面缺席）：与数据行是**两种节点**（子结构不同），切换时整块替换是必要的；
    // 同一种占位行之间只改文本——1s 一次的兜底轮询不重建这个节点。
    // **三段共用**：团队任务清单段（空/未装配/读失败）、子 Agent 段（空/派生面缺席）与
    // 工作区文件段（工作区未装配/空表）都走它
    // ——占位行的节点种类与类名规则只有这一份（工作项段已下线）。
    function _renderItemsPlaceholder(host, cls, text) {
        var doc = _doc();
        var first = host.children[0];
        var el = (first && String(first.className).indexOf(cls) >= 0) ? first : null;
        if (!el) {
            while (host.children.length) host.removeChild(host.children[0]);
            el = doc.createElement('div');
            el.className = 'team-board-placeholder ' + cls;
            host.appendChild(el);
        } else {
            while (host.children.length > 1) host.removeChild(host.children[host.children.length - 1]);
        }
        el.textContent = text;
        return 0;
    }

    // ── 子 Agent 段 ────────────────────────────
    // 容器同样**动态建**（骨架里没有 #teamBoardSubagents）：老骨架 + 新脚本的组合下也照常渲染，
    // index.html 因此一个字节都不用动。骨架缺席（#teamTaskPanel 不在）⇒ 返回 null：
    // 不抛错、静默 0 行（与运行态段同款降级）。
    function _ensureSubagentsSection() {
        var panel = _byId('teamTaskPanel');
        if (!panel) return null;
        var sec = _subagentsSection;
        // 引用校验：宿主（静态骨架）在模块重载/别的装配方式下可能被换掉，旧子树已脱离文档——
        // 留着会让这一段从此写进不受文档管理的节点（用户完全看不到）。
        // 缓存命中也要过 _finishSection（这里裸返回 ⇒ 折叠态/绑定不重放）。
        if (sec && sec.section && sec.section.parentNode === panel) return _finishSection(sec, 'subagents');
        var existing = _byId('teamBoardSubagents');
        if (existing) {
            // 骨架里已经有同 id 的容器（宿主自己加的 / 上一次装配留下的）⇒ 认它，不叠第二份
            sec = { section: existing.parentNode || existing, host: existing };
            _subagentsSection = sec;
            return _finishSection(sec, 'subagents');
        }
        var doc = _doc();
        if (!doc || typeof doc.createElement !== 'function') return null;
        var section = doc.createElement('div');
        section.className = 'team-board-section';
        var titleEl = doc.createElement('div');
        titleEl.className = 'team-board-title';
        titleEl.textContent = AEI18n.t('子 Agent');
        var host = doc.createElement('div');
        host.className = 'team-board-subagents';
        host.id = 'teamBoardSubagents';
        section.appendChild(titleEl);
        section.appendChild(host);
        panel.appendChild(section);
        _subagentsSection = { section: section, host: host };
        return _finishSection(_subagentsSection, 'subagents');
    }

    // 只判容器直接子节点的类名：占位行是 .team-board-placeholder（不含 team-board-subagent），
    // 两种节点不会被认错——认错会让复用逻辑把占位行当子 Agent 行改写（行数不变但内容错位）。
    function _isSubagentRow(el) {
        return !!(el && el.className && String(el.className).indexOf('team-board-subagent') >= 0);
    }

    // 团队任务清单段的数据行判据：行复用按下标取 `host.children[i]`，所以「占位行」与
    // 「数据行」必须能分辨——认错就会把占位行当第 1 行复用，第一条任务永远不显示（真机 TT10）。
    // 判据 = 类名含 `.team-board-item`（任务清单行用的就是那套格子；占位行是 `.team-board-placeholder`）。
    function _isTaskRow(el) {
        return !!(el && el.className && String(el.className).indexOf('team-board-item') >= 0);
    }

    // 子 Agent 段的一行：[标题] + 状态 + 耗时 + token + 归属 lane。
    // 节点**复用**（同 _renderItemRow）：只改文本/类，不整块重建——1s 一次的重渲若重建 DOM，
    // 会把用户正在悬停/划选的那一行抽掉（真机表现为「任务板一闪一闪」）。
    // 文本与类**无条件覆盖**每一个格子（复用 ⇒ 漏一个格子就会把上一条的值留在这一行上）。
    // entry = { view（taskBoard.deriveSubagentView 的产物）, lane（归属 lane 的展示名）}。
    function _renderSubagentRow(container, entry, index) {
        var doc = _doc();
        var view = entry.view;
        var rowEl = container.children[index];
        if (rowEl && !_isSubagentRow(rowEl)) {
            // 种类不符（占位行清完之后理论上不会发生）：清掉全部再从零建，否则 appendChild 的
            // 落点与 index 错位（这一行会显示成另一条子 Agent 的内容）。该位**还没有节点**是
            // 正常的新建路径，此时 children.length === index，appendChild 恰好落在 index 上。
            while (container.children.length) container.removeChild(container.children[0]);
            rowEl = null;
        }
        if (!rowEl) {
            rowEl = doc.createElement('div');
            rowEl.className = 'team-board-subagent';
            var titleEl = doc.createElement('span');
            titleEl.className = 'team-board-subagent-title';
            var stateEl = doc.createElement('span');
            stateEl.className = 'team-board-subagent-state';
            var elapsedEl = doc.createElement('span');
            elapsedEl.className = 'team-board-subagent-elapsed';
            var tokensEl = doc.createElement('span');
            tokensEl.className = 'team-board-subagent-tokens';
            var laneEl = doc.createElement('span');
            laneEl.className = 'team-board-subagent-lane';
            rowEl.appendChild(titleEl);
            rowEl.appendChild(stateEl);
            rowEl.appendChild(elapsedEl);
            rowEl.appendChild(tokensEl);
            rowEl.appendChild(laneEl);
            container.appendChild(rowEl);
        }
        rowEl.setAttribute('data-subagent-id', view.key || '');
        rowEl.className = 'team-board-subagent' + (view.stateClass ? ' ' + view.stateClass : '');
        if (rowEl.children[0]) rowEl.children[0].textContent = '[' + (view.title || '') + ']';
        if (rowEl.children[1]) {
            // 状态文案来自 taskBoard.deriveSubagentView（UI 不写第二份 state → 文案的映射，
            // 卡片那一面同样走它）
            rowEl.children[1].textContent = view.stateText || '';
            rowEl.children[1].className = 'team-board-subagent-state'
                + (view.stateClass ? ' ' + view.stateClass : '');
        }
        // 耗时/token 的**数字与格式**都来自派生结果（这里只加标签，不在这里算秒数）
        if (rowEl.children[2]) rowEl.children[2].textContent = AEI18n.t('耗时 ') + (view.elapsedText || '--');
        if (rowEl.children[3]) {
            var hasTokens = !!view.tokensText;
            rowEl.children[3].textContent = hasTokens ? ('token ' + view.tokensText) : '';
            // 拿不到计数就整格收掉：留一个空的「token 」比不留更容易被读成「用了 0 个」
            rowEl.children[3].hidden = !hasTokens;
        }
        if (rowEl.children[4]) rowEl.children[4].textContent = entry.lane || '';
        return rowEl;
    }

    // ── 子 Agent 会话（点击子 Agent 进入他的会话）──────
    // 点「子 AGENT」段的任意一行 ⇒ 打开这个弹窗：它的对话本体（运行器的 cm）+ 状态/耗时/token +
    // 一个追问输入框（走 `AEEngine.askSubagent`，与 ask_subagent 工具同一条池链路）。
    // 为什么是弹窗而不是「把聊天区换成它的会话」：聊天区/输入框属于当前 lane 的 view 与 controller
    //（换内容要动那条链的渲染与状态镜像），弹窗只读运行器自己的 cm，互不干扰；关闭即回到原样。
    // 会话已回收（终态后被 _pruneSubagentRuntimes 释放）⇒ 如实说明并显示池里最后那份结论摘要。
    var _saSession = null;
    // 弹窗显隐必须走 common.css 的 `.modal-mask` / `.modal` 过渡约定：两者默认都是 `opacity: 0`
    //（`.modal` 还带 `translateY(10px) scale(.98)`），只把 mask 设成 `display: flex` 的话
    // 节点在、文本在、**屏幕上看不见**——真机形态与「点了没反应」完全同形（实测症状
    // 「没弹窗」，截图取证：display=flex 而 mask/box 的 computed opacity 都是 0）。
    // 标准打开写法（app/modals.js 的 showConfirm 同一套）：先 display，再下一帧抬 opacity + 盒子复位。
    function _raf(fn) {
        var raf = (global && typeof global.requestAnimationFrame === 'function') ? global.requestAnimationFrame : null;
        if (raf) {
            try { raf(fn); return; } catch (_) { /* 回落同步（老宿主/测试桩） */ }
        }
        fn();
    }
    var _SA_BOX_CLOSED = 'translateY(10px) scale(.98)';
    var _SA_BOX_OPEN = 'translateY(0) scale(1)';
    function _ensureSubagentSessionModal() {
        var doc = _doc();
        if (!doc || typeof doc.createElement !== 'function') return null;
        if (_saSession && _saSession.mask && _saSession.mask.parentNode) return _saSession;
        var mask = doc.createElement('div');
        mask.className = 'modal-mask';
        mask.id = 'subagentSessionModal';
        mask.style.display = 'none';
        var modal = doc.createElement('div');
        modal.className = 'modal subagent-session-modal';
        var head = doc.createElement('div');
        head.className = 'modal-head';
        var headText = doc.createElement('span');
        headText.id = 'subagentSessionTitle';
        headText.textContent = AEI18n.t('子 Agent 会话');
        var closeBtn = doc.createElement('button');
        closeBtn.className = 'icon-btn';
        closeBtn.id = 'closeSubagentSessionBtn';
        closeBtn.textContent = AEI18n.t('关闭');
        head.appendChild(headText);
        head.appendChild(closeBtn);
        var body = doc.createElement('div');
        body.className = 'modal-body ae-scrollbar subagent-session-body';
        var meta = doc.createElement('div');
        meta.className = 'subagent-session-meta';
        meta.id = 'subagentSessionMeta';
        var msgs = doc.createElement('div');
        msgs.className = 'subagent-session-msgs';
        msgs.id = 'subagentSessionMsgs';
        var row = doc.createElement('div');
        row.className = 'subagent-session-input';
        var input = doc.createElement('textarea');
        input.id = 'subagentSessionInput';
        input.className = 'subagent-session-textarea';
        input.setAttribute('placeholder', AEI18n.t('追问这个子 Agent（保活窗口内可继续对话）…'));
        var send = doc.createElement('button');
        send.className = 'btn';
        send.id = 'subagentSessionSend';
        send.textContent = AEI18n.t('发送');
        row.appendChild(input);
        row.appendChild(send);
        body.appendChild(meta);
        body.appendChild(msgs);
        body.appendChild(row);
        modal.appendChild(head);
        modal.appendChild(body);
        mask.appendChild(modal);
        try { doc.body.appendChild(mask); } catch (_) { return null; }
        _saSession = { mask: mask, box: modal, title: headText, meta: meta, msgs: msgs, input: input, send: send, id: '' };
        closeBtn.addEventListener('click', function () { closeSubagentSession(); });
        mask.addEventListener('click', function (e) { if (e && e.target === mask) closeSubagentSession(); });
        send.addEventListener('click', function () { _askSubagentFromSession(); });
        input.addEventListener('keydown', function (e) {
            if (e && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); _askSubagentFromSession(); }
        });
        return _saSession;
    }

    function openSubagentSession(id) {
        var sid = (id === undefined || id === null) ? '' : String(id);
        if (!sid) return false;
        var s = _ensureSubagentSessionModal();
        if (!s) return false;
        s.id = sid;
        s.mask.style.display = 'flex';
        s.mask.style.opacity = '0';
        if (s.box) { s.box.style.opacity = '0'; s.box.style.transform = _SA_BOX_CLOSED; }
        _renderSubagentSession();
        // 下一帧抬可见度（与 modals.js 同款）：过渡从 opacity:0 起跳，弹窗才是「淡入」而不是硬闪现。
        _raf(function () {
            s.mask.style.opacity = '1';
            if (s.box) { s.box.style.opacity = '1'; s.box.style.transform = _SA_BOX_OPEN; }
        });
        return true;
    }

    function closeSubagentSession() {
        if (!_saSession || !_saSession.mask) return false;
        // 已经关着 ⇒ false（幂等且**如实**：调用方据此知道这次没做事）
        if (_saSession.mask.style.display === 'none' && !_saSession.id) return false;
        // display:none 已经不可见；opacity/transform 一并归位，避免下次打开从「半开」状态起跳。
        _saSession.mask.style.display = 'none';
        _saSession.mask.style.opacity = '0';
        if (_saSession.box) { _saSession.box.style.opacity = '0'; _saSession.box.style.transform = _SA_BOX_CLOSED; }
        _saSession.id = '';
        return true;
    }

    function _saEngine() { return global.AEEngine || {}; }

    // 会话内容渲染：一条消息一行（角色前缀 + 正文）。空会话 ⇒ 一行占位（不是空白块）。
    function _renderSubagentSession() {
        if (!_saSession || !_saSession.id) return 0;
        var doc = _doc();
        var eng = _saEngine();
        var info = null;
        try {
            info = (typeof eng.getSubagentSession === 'function') ? eng.getSubagentSession(_saSession.id) : null;
        } catch (_) { info = null; }
        if (!info || info.ok !== true) {
            if (_saSession.title) _saSession.title.textContent = AEI18n.t('子 Agent 会话');
            if (_saSession.meta) _saSession.meta.textContent = AEI18n.t('读不到这条子 Agent（可能已被清理）：')
                + ((info && info.reason) || 'unknown');
            if (_saSession.msgs) _saSession.msgs.textContent = '';
            return 0;
        }
        if (_saSession.title) _saSession.title.textContent = AEI18n.t('子 Agent 会话 · ') + (info.title || info.id);
        if (_saSession.meta) {
            // 状态文案取**同一处派生**（taskBoard.deriveSubagentView 的 stateText）：面板的行、
            // 卡片、弹窗三处必须同一个词（各写一份映射必然漂移）
            var derive = global.AEAgentTeam && global.AEAgentTeam.deriveSubagentView;
            var st = '';
            if (typeof derive === 'function') {
                try { st = (derive({ state: info.state }) || {}).stateText || ''; } catch (_) { st = ''; }
            }
            // 元信息做成一排 chip：` · ` 串起来的一长行，字段一多就成一堵墙。
            // 文案逐字保持旧口径（测试按子串断言：保活 / 耗时 8s / token 数 / 导演 / 已回收）。
            var chips = [{ text: AEI18n.t('状态：{state}', { state: st || info.state || '--' }), cls: 'is-state' }];
            if (info.elapsedMs) chips.push({ text: AEI18n.t('耗时 {n}s', { n: Math.round(info.elapsedMs / 1000) }) });
            if (info.tokens && (info.tokens.prompt || info.tokens.completion)) {
                chips.push({ text: 'token ↑' + (info.tokens.prompt || 0) + ' ↓' + (info.tokens.completion || 0) });
            }
            if (info.turns) chips.push({ text: AEI18n.t('第 {n} 轮', { n: info.turns }) });
            if (info.recycled) chips.push({ text: AEI18n.t('会话已回收（只能看结论摘要）'), cls: 'is-recycled' });
            chips.push({ text: AEI18n.t('上级：{name}', { name: _laneLabel(info.parentLane) }), cls: 'is-lane' });
            while (_saSession.meta.children && _saSession.meta.children.length) {
                _saSession.meta.removeChild(_saSession.meta.children[0]);
            }
            for (var ci = 0; ci < chips.length; ci++) {
                var chip = doc.createElement('span');
                chip.className = 'subagent-session-chip' + (chips[ci].cls ? ' ' + chips[ci].cls : '');
                chip.textContent = chips[ci].text;
                _saSession.meta.appendChild(chip);
            }
        }
        var msgs = info.messages || [];
        var host = _saSession.msgs;
        if (!host) return 0;
        while (host.children && host.children.length) host.removeChild(host.children[0]);
        if (!msgs.length) {
            var ph = doc.createElement('div');
            ph.className = 'subagent-session-empty';
            if (info.recycled) {
                // 回收态的摘要也是 markdown（子 Agent 的结论正文本来就带标题/表格）。
                ph.className += ' is-recycled';
                var phLab = doc.createElement('div');
                phLab.className = 'subagent-session-summary-label';
                phLab.textContent = AEI18n.t('会话已回收 · 结论摘要');
                var phBody = doc.createElement('div');
                _renderMarkdownInto(phBody, info.summary || AEI18n.t('（没有留下摘要）'), 'subagent-session-summary-md');
                ph.appendChild(phLab);
                ph.appendChild(phBody);
            } else {
                ph.textContent = AEI18n.t('这条子 Agent 还没有消息（可能刚派出、正在排队）。');
            }
            host.appendChild(ph);
            return 0;
        }
        for (var i = 0; i < msgs.length; i++) {
            var m = msgs[i] || {};
            var row = doc.createElement('div');
            row.className = 'subagent-session-msg is-' + (m.role || 'unknown');
            var role = doc.createElement('div');
            role.className = 'subagent-session-msg-role';
            var badge = doc.createElement('span');
            badge.className = 'subagent-session-role-badge';
            badge.textContent = (m.role === 'assistant') ? AEI18n.t('子 Agent')
                : (m.role === 'user' ? AEI18n.t('上级 Agent') : (m.title || m.role || AEI18n.t('系统')));
            role.appendChild(badge);
            var text = doc.createElement('div');
            // 子 Agent 的产出是 markdown（标题/列表/表格/代码块）：走项目唯一 markdown 链渲染；
            // 渲染失败退回纯文本（is-plain 保留换行），不丢原文。
            // 上级 Agent（user 角色）的消息与主输入框同口径保留换行；子 Agent 输出走默认口径
            _renderMarkdownInto(text, m.text || '', 'subagent-session-msg-text',
                (m.role === 'user') ? { breaks: true } : undefined);
            row.appendChild(role);
            row.appendChild(text);
            host.appendChild(row);
        }
        // 结论摘要（池里那份）单独收尾一块：对话被裁剪/回收时它仍是最完整的结论
        if (info.summary) {
            var sum = doc.createElement('div');
            sum.className = 'subagent-session-summary';
            var sumLab = doc.createElement('div');
            sumLab.className = 'subagent-session-summary-label';
            sumLab.textContent = AEI18n.t('结论摘要');
            var sumBody = doc.createElement('div');
            _renderMarkdownInto(sumBody, info.summary, 'subagent-session-summary-md');
            sum.appendChild(sumLab);
            sum.appendChild(sumBody);
            host.appendChild(sum);
        }
        try { if (host.scrollTop !== undefined) host.scrollTop = host.scrollHeight; } catch (_) {}
        return msgs.length;
    }

    // 追问（弹窗里的输入框）：走 AEEngine.askSubagent（与 ask_subagent 同一条池链路）。
    // 忙碌期禁点（避免连点两次追问 → 池里两次 ask 撞在同一个保活窗口上）；结果如实提示。
    function _askSubagentFromSession() {
        if (!_saSession || !_saSession.id) return;
        var eng = _saEngine();
        var text = _saSession.input ? String(_saSession.input.value || '').replace(/^\s+|\s+$/g, '') : '';
        if (!text) { _status(AEI18n.t('追问内容为空：写清要它补什么'), 'warn'); return; }
        if (typeof eng.askSubagent !== 'function') { _status(AEI18n.t('追问不可用：引擎未暴露 askSubagent'), 'error'); return; }
        if (_saSession.send) _saSession.send.disabled = true;
        if (_saSession.input) _saSession.input.value = '';
        _status(AEI18n.t('已追问子 Agent，等它跑完…'), 'info');
        Promise.resolve(eng.askSubagent(_saSession.id, text)).then(function (r) {
            if (_saSession && _saSession.send) _saSession.send.disabled = false;
            if (!r || r.ok !== true) {
                _status(AEI18n.t('追问失败：{reason}', { reason: (r && r.reason) || 'unknown' })
                    + (r && r.reason === 'not_waiting' ? AEI18n.t('（已跑完且超出保活窗口：只能重新派一个）') : ''), 'error');
            }
            _renderSubagentSession();
        }, function (e) {
            if (_saSession && _saSession.send) _saSession.send.disabled = false;
            _status(AEI18n.t('追问异常：{reason}', { reason: (e && e.message) || e }), 'error');
        });
    }

    // 子 Agent 行的点击（容器委托，一次）：行节点复用，故从行上**现读** data-subagent-id。
    // 显示名用上面已有的 _laneLabel（唯一一份，别再写第二份映射）。
    function _bindSubagentRowsHost(host) {
        if (!host || host.__aeTeamSubagentsBound) return;
        host.__aeTeamSubagentsBound = true;
        host.addEventListener('click', function (e) {
            var el = _closestByClass(e && e.target, 'team-board-subagent');
            if (!el || typeof el.getAttribute !== 'function') return;
            var sid = el.getAttribute('data-subagent-id');
            if (!sid) return;
            openSubagentSession(sid);
        });
    }

    // 子 Agent 段的一次渲染。返回本次渲染的行数（单测直驱用；0 = 空态或未渲染）。
    // 门：**面板可见时才渲染**（#teamTaskPanel 隐藏 ⇒ 一次 DOM 写入都不做，连容器都不建）
    // ——与团队任务清单段**同一道门**（`_boardSectionsVisible()`，两段不再各写一份判据）。
    function _renderSubagents(snapshot) {
        if (!_boardSectionsVisible()) return 0;
        var sec = _ensureSubagentsSection();
        if (!sec) return 0;                     // 骨架缺席：不抛错、静默 0 行
        var derive = global.AEAgentTeam && global.AEAgentTeam.deriveSubagentView;
        if (typeof derive !== 'function') {
            // 派生面缺席（manifest 载序错）：**如实**出一行「不可用」，不把「看不到」伪装成
            // 「暂无子 Agent」——后者会让用户以为一个子 Agent 都没起过。
            return _renderItemsPlaceholder(sec.host, 'is-unavailable',
                AEI18n.t('子 Agent 不可用：任务板派生面未加载（AEAgentTeam.deriveSubagentView 缺失）'));
        }
        var raw = (snapshot && snapshot.subagents) || [];
        // 过滤口径（只列仍在跑或仍在保活窗口里的子 Agent）：判据取
        // `AEAgentTeam.isSubagentActive`（与状态文案同一处，见 taskBoard.js）——UI 不自己写一份
        // 「哪些 state 算活跃」。**卡片不过滤**（消息流里的历史要保留终态卡片），只有这一段过滤。
        // 派生面缺席时 isActive 也没有 ⇒ 退化为「不过滤」（旧行为），并在下面按缺件如实提示。
        var isActive = global.AEAgentTeam && global.AEAgentTeam.isSubagentActive;
        var entries = [];
        for (var i = 0; i < raw.length; i++) {
            if (typeof isActive === 'function') {
                var act = false;
                try { act = !!isActive(raw[i]); } catch (_) { act = false; }
                if (!act) continue;
            }
            var v = null;
            try { v = derive(raw[i]); } catch (_) { v = null; }   // 单条坏数据不该让整段消失
            if (v) entries.push({ view: v, lane: _laneLabel(raw[i] && raw[i].parentLane) });
        }
        if (!entries.length) return _renderItemsPlaceholder(sec.host, 'is-empty', AEI18n.t('暂无子 Agent'));
        var host = sec.host;
        _bindSubagentRowsHost(host);   // 行可点（进它的会话）；容器委托，绑定幂等
        // 占位行清掉（占位行与数据行是两种节点，切换时整块替换是必要的；任务清单段同款）
        while (host.children.length && !_isSubagentRow(host.children[0])) {
            host.removeChild(host.children[0]);
        }
        for (var j = 0; j < entries.length; j++) _renderSubagentRow(host, entries[j], j);
        // 多余的旧行（保活到期被释放后）移除：留着会是「幽灵行」（已经不在任何一份数据里，
        // 却还在板上报一个状态——那是最难被识破的一种假信息）
        while (host.children.length > entries.length) {
            host.removeChild(host.children[host.children.length - 1]);
        }
        return entries.length;
    }

    // 归属 lane 的展示名（定义源缺席时回落 id：宁可显示 id，不可空着一格）
    function _laneLabel(id) {
        if (!id) return '';
        var defs = _laneDefs();
        for (var i = 0; i < defs.length; i++) {
            if (defs[i] && defs[i].id === id) return defs[i].label || id;
        }
        return String(id);
    }

    // ── 子 Agent 卡片（**不再往聊天区画**）──────────────────────────────
    // 原因：派遣子 Agent 的提示会在聊天历史区域出现，与团队任务面板重复。
    // 于是本文件不再 upsert 卡片：聊天区不再出现子 Agent 状态卡，子 Agent 的状态/耗时/token
    // 统一看团队面板的「子 AGENT」段（同一份快照驱动，点行还能进它的会话）。
    // 「回收自己推过的卡」这条链路不存在：
    //（_laneView / _syncSubagentCards / _clearSubagentCards + `_cardIdsByLane` 表）——那张表
    // **两处写入都是 `= {}`**，从未记过任何 id ⇒ `seen` 恒空 ⇒ 回收循环一次都不执行、
    // `pushed` 恒 0、`_clearSubagentCards` 恒空转。既然本文件一次都不推卡，
    // 「回收自己推过的卡」在本文件无从谈起：没有可回收的卡，回收侧为空（
    // 删掉的是恒等于「什么都不做」的那部分）。卡片面本身仍在 engine/view.js（冻结签名）。

    // 任务板面板的整段渲染（**本文件是唯一落点**）。返回本次渲染的行数（单测直驱用）。
    function renderBoard() {
        var snapshot = buildSnapshot();
        // tab 条上的「运行中」角标与 lane 切换条共用同一份快照——两处各自算一次必然不同步
        _lastSnapshot = snapshot;

        var host = _byId('teamBoardLanes');
        if (!host) return 0;   // 骨架缺席（未挂载/别的页面）：不抛，静默 0 行
        _bindLaneRowsHost();   // 行即切换入口（委托监听，幂等）
        _makeRuntimeSectionCollapsible();   // 运行态段是静态骨架：每次渲染挂一次折叠绑定（幂等）

        // 未读标记（从旧胶囊搬来）：与行渲染同一份判据（unreadLanes），不各算一份
        _unreadMap = unreadLanes();

        var rows = orderBoardRows(snapshot.lanes);

        for (var i = 0; i < rows.length; i++) _renderLaneRow(host, rows[i], i);
        // 多余的旧行（lane 集合变小）移除：留着会是「幽灵行」（点它还切不过去）
        while (host.children.length > rows.length) host.removeChild(host.children[host.children.length - 1]);

        // 任务清单段：**三条 lane 共用**的那份团队任务清单（`_teamTaskList()`），
        // 见 _renderTeamTasks。（不能读「当前 lane 的 activePlan」：那会让导演拆的任务
        // AE 执行看不见。）与子 Agent 段同一道可见性门（_boardSectionsVisible）。
        _renderTeamTasks();
        // 子 Agent 段：同一份快照的 subagents。
        _renderSubagents(snapshot);
        // 工作区文件段：计划书 / 文字分镜（从工作区文件表派生），点击弹浮层看 markdown。
        _renderWorkspaceFiles();

        var hint = _byId('teamBoardHint');
        if (hint) {
            hint.textContent = snapshot.unavailable
                ? AEI18n.t('状态不可用：任务板组装面未加载（AEAgentTeam.buildBoardSnapshot 缺失）')
                : (snapshot.degraded ? AEI18n.t('状态不可用：状态判据未加载') : '');
            hint.hidden = !(snapshot.unavailable || snapshot.degraded);
        }
        return rows.length;
    }

    // ── 顶栏：团队开关 + lane 切换条 ──────────
    function _hostBar() {
        // 顶栏由 index.js 建（#agentCurrentModelBar）；它随模块 unmount/remount 重建
        // ⇒ 每次 mount / 刷新都重新取，不长期缓存引用（缓存必在重挂载后指向脱离文档的节点）。
        return _byId('agentCurrentModelBar');
    }

    // 模式旋钮那一行（`.llm-chat-topbar` 的第一个 `.btn-row`）——团队开关就挂在它里面、
    // #runtimeModeSwitch 右边（「放在 Agent 模式的右边靠左排」）。
    function _modeRow() {
        var knob = _byId('runtimeModeSwitch');
        if (knob && knob.parentNode) return knob.parentNode;
        var d = _doc();
        try {
            return (d && typeof d.querySelector === 'function') ? (d.querySelector('.llm-chat-topbar .btn-row') || null) : null;
        } catch (_) { return null; }
    }

    // 当前运行模式（script/agent/shader/external）。三个来源按可靠度取：
    //   ① 宿主显式推来的（main.js 的 syncRuntimeMode → syncModeChrome，落 _lastMode）；
    //   ② 模式旋钮的 data-mode-index（runtimeMode 的 UI 镜像，写点唯一：syncRuntimeMode）；
    //   ③ 判不出来 ⇒ 空串，一律按「非 Agent」处理（开关/胶囊只在 Agent 模式可见，判不出就不显示，
    //      不猜一个默认档——猜错会让它们出现在脚本/Shader 模式里）。
    function _runtimeMode() {
        if (_lastMode) return _lastMode;
        if (typeof _opts.getRuntimeMode === 'function') {
            try {
                var m = _opts.getRuntimeMode();
                if (m) return String(m);
            } catch (_) { /* 注入的取值器抛错 → 回落 DOM 镜像 */ }
        }
        var sw = _byId('runtimeModeSwitch');
        var raw = (sw && sw.dataset) ? sw.dataset.modeIndex : undefined;
        var idx = (raw === undefined || raw === null || raw === '') ? NaN : parseInt(raw, 10);
        // 档位清单引用 engine 的唯一来源（与 main.js / bootstrap 同源，不在本文件再写一份）
        var modes = (global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.MODES)
            || ['script', 'agent', 'shader', 'external', 'team'];
        if (!isNaN(idx) && idx >= 0 && idx < modes.length) return modes[idx];
        return '';
    }

    // 宿主（main.js 的 syncRuntimeMode）推模式：落 _lastMode 再刷一遍可见性。
    // 为什么需要显式推：开关/胶囊的可见判据是 runtimeMode，而模式切换不经过本文件的任何入口
    // （旋钮的点击处理器在 bindEvents/runtimeModeSwitch.js）。
    function syncModeChrome(mode) {
        if (mode) _lastMode = String(mode);
        syncTopBar();
        return _lastMode;
    }

    // 团队 UI 三件（按当前实现）：
    //   · 团队开关 → 模式旋钮那一行，紧跟 #runtimeModeSwitch（靠左排）；组件**复用**项目现成的
    //     `.toggle-wrap` + `input.switch-input` + `span.switch-slider`（与「模块设置面板 → 权限与功能」
    //     同一颗开关，样式在 common.css:704-745），不再自造胶囊与圆点。
    //     （这一颗**整块隐藏**：团队成了模式旋钮的第 5 档，旋钮是进出的唯一入口。）
    //   · **lane 切换入口 = 运行态行本身**（入口与运行态结合，点行即切）：
    //     没有独立的胶囊栏、也没有 #teamBoardSwitch 那种小节——行是 `<button>`，点击由
    //     `_bindLaneRowsHost` 在 #teamBoardLanes 上委托处理。这里一个栏位都不建。
    //   · 全部停止 → 发送按钮下方的静态骨架 #aeAgentStopAllBtn（index.html 里就有，本文件只管
    //     它的显隐/可用性与点击）；当前 lane 的停止沿用发送按钮 busy 态的既有行为。
    function _ensureTopBarNodes() {
        var doc = _doc();
        var modeRow = _modeRow();
        // 拓扑校验：引用还在**且仍挂在各自宿主里**才复用。宿主随模块 unmount 被整体移除、
        // 重挂载时换了个新节点 ⇒ 旧引用（连同它的子节点）已脱离文档，留着会让团队 UI 永久消失。
        // 这里**只按引用判**、不按 id 回查：自己建的节点没必要经文档查回来（假 DOM/测试环境下
        // getElementById 未必认动态节点，回查会把可用引用换成 null）。
        if (_nodes) {
            var w = _nodes.switchWrap;
            if (w && w.parentNode !== modeRow) _nodes = null;
        }
        var nodes = _nodes;
        if (!nodes) nodes = { switchWrap: null, toggle: null, stopAllBtn: null, sendStack: null };

        // ── lane 切换入口 = 运行态行 ──────────────────────
        // 这里**不再建任何栏位**：切换入口与「运行态」合并——行本身可点（teamUI._renderLaneRow
        // 建 button + _bindLaneRowsHost 委托点击）。旧的 #aeAgentTeamBar / #aeAgentLaneBar 不再存在。

        // ── 团队开关：模式旋钮右边（靠左排），项目现成的开关组件 ───────────────
        if (!nodes.switchWrap && modeRow) {
            var wrap = doc.createElement('label');
            wrap.id = 'aeAgentTeamSwitchWrap';
            wrap.className = 'toggle-wrap ae-agent-team-switch';
            var labelEl = doc.createElement('span');
            labelEl.className = 'ae-agent-team-switch-label';
            labelEl.textContent = AEI18n.t('团队');
            var inputEl = doc.createElement('input');
            inputEl.type = 'checkbox';
            inputEl.id = 'aeAgentTeamToggle';
            inputEl.className = 'switch-input';
            var sliderEl = doc.createElement('span');
            sliderEl.className = 'switch-slider';
            sliderEl.setAttribute('aria-hidden', 'true');
            inputEl.addEventListener('change', function (e) { _onToggleChange(e); });
            wrap.appendChild(labelEl);
            wrap.appendChild(inputEl);
            wrap.appendChild(sliderEl);
            var knobEl = _byId('runtimeModeSwitch');
            if (knobEl && knobEl.parentNode === modeRow) {
                var after = knobEl.nextElementSibling;
                if (after) modeRow.insertBefore(wrap, after);
                else modeRow.appendChild(wrap);
            } else {
                modeRow.appendChild(wrap);
            }
            nodes.switchWrap = wrap;
            nodes.toggle = inputEl;
        }

        // ── 全部停止：发送按钮下 1/4（静态骨架，本文件只绑一次点击）───────────
        nodes.stopAllBtn = _byId('aeAgentStopAllBtn');
        nodes.sendStack = _byId('aeAgentSendStack');
        if (nodes.stopAllBtn && !nodes.stopAllBtn.__aeTeamBound) {
            nodes.stopAllBtn.__aeTeamBound = true;
            nodes.stopAllBtn.addEventListener('click', function () { _onStopAll(); });
        }

        _nodes = nodes;
        return _nodes;
    }

    // 胶囊不存在了，运行态行的点击判据在 _bindLaneRowsHost
    // 里就地做（class 含 'team-board-row' 即命中）。

    // 未读标记：lane 的已读条数按「切到它 / 它是当前 lane」推进。条数取 controller.getState().messages
    // ——团队模式下每条 lane 有自己的 cm，条数只能从该 lane 的 controller 问。
    function _laneMessageCount(id) {
        var rt = _laneRuntime(id);
        var c = (rt && rt.controller) || null;
        if (!c || typeof c.getState !== 'function') return -1;
        try {
            var st = c.getState();
            var msgs = (st && st.messages) || null;
            return (msgs && typeof msgs.length === 'number') ? msgs.length : -1;
        } catch (_) { return -1; }
    }

    function unreadLanes() {
        var out = {};
        if (!isTeamModeOn()) return out;
        var cur = currentLaneId();
        var ids = _laneIds();
        for (var i = 0; i < ids.length; i++) {
            var id = ids[i];
            var n = _laneMessageCount(id);
            if (n < 0) continue;                       // 读不到条数：不猜「有未读」
            if (id === cur) { _seenMsgCount[id] = n; continue; }
            var seen = (typeof _seenMsgCount[id] === 'number') ? _seenMsgCount[id] : -1;
            if (seen < 0) { _seenMsgCount[id] = n; continue; }   // 首次见到：以当前条数为已读基线
            if (n > seen) out[id] = true;
        }
        return out;
    }

    // 三个 Agent 胶囊栏已不存在（切换入口与运行态结合，点行即切）——
    // 未读标记与状态点搬进 _renderLaneRow，切换动作走 _bindLaneRowsHost 的委托监听。

    // 顶栏可见性（旋钮与开关的口径）：
    //   · 模式旋钮：**恒可见**——团队就是第 5 档（「把团队模式集合进那个四模式开关，
    //     变成第五个模式」），旋钮是团队模式的**唯一入口**（点第 5 档进团队、点别的档退团队）。
    //     旧规则「团队开着就隐藏旋钮」必须去掉：否则进去就出不来（只剩设置段那颗开关）；
    //     旧的四档时代那条规则是必要的（旋钮在团队模式下会显示「Agent」这种骗人档位）——
    //     现在第 5 档显示的就是「团队」，不再有骗人的可能。
    //   · 内联「团队」开关：**不再显示**（与旋钮的第五档重复；同一件事两个入口会打架）。
    //     模块设置 → 团队模式段那颗开关保留（设置面的镜子）。
    //   · 全部停止 = 发送按钮下 1/4，只在团队模式下切开（团队关闭时那半段不占位，
    //     发送按钮与改动前逐字一致）；它的**可用性判据是 `_stopAllDisabled()`**（
    //     取证后从 anyLaneLocked 拆出：只跟「切换/回读在途」，**不跟 busy**）——锁定期间置
    //     `disabled` 但**保持可见**：藏起来会让用户以为这个入口没了。
    // 单 Agent / 非 Agent 模式下的既有行为一律不动。
    function syncTopBar() {
        var nodes = _ensureTopBarNodes();
        var on = isTeamModeOn();
        if (!nodes) return;
        // ── 内联团队开关（由旋钮第五档取代）──
        var toggle = nodes.toggle;
        if (toggle) {
            // 勾选态仍跟设置段同步（便于诊断与无障碍读屏），但**整块隐藏**
            var want = _teamEnabledInSettings();
            if (!_toggleInFlight) toggle.checked = want;
            toggle.setAttribute('aria-checked', want ? 'true' : 'false');
            if (nodes.switchWrap) {
                nodes.switchWrap.hidden = true;
                nodes.switchWrap.setAttribute('title', want
                    ? AEI18n.t('团队模式已开启（四条 Agent：导演 / AE 执行 / Shader 执行 / 美术执行）；用左边的模式旋钮切到别的档即退出')
                    : AEI18n.t('团队模式：四条常驻 Agent 协作；用左边的模式旋钮切到第 5 档「团队」开启'));
            }
        }
        // ── lane 切换入口 = 运行态行（入口与运行态结合，点行即切）──
        // 不再有独立的胶囊栏：行本身是 `<button>`（_renderLaneRow），点击由 _bindLaneRowsHost
        // 委托处理。这里只保证容器可见性跟着团队开关走（面板显隐由 resolveDrawerRouting 管）。
        // ── 模式旋钮：**恒可见**（团队 = 第 5 档，旋钮是进出团队的唯一入口）──
        // 旧的「团队开着就隐藏旋钮」是对四档时代的补丁（旋钮只能显示四档、在团队模式下会显示
        // 骗人的档位）。第 5 档上线后该补丁失去理由，且会把用户关在团队模式里（没有出口）。
        var knob = _byId('runtimeModeSwitch');
        if (knob) knob.hidden = false;
        // ── 全部停止（发送按钮下半段）──
        var stack = nodes.sendStack || _byId('aeAgentSendStack');
        if (stack && stack.classList) stack.classList.toggle('is-split', on);
        var stopAll = nodes.stopAllBtn || _byId('aeAgentStopAllBtn');
        if (stopAll) {
            stopAll.hidden = !on;
            // 可用性 = `_stopAllDisabled()`：**只跟「切换 / 回读在途」**，见该函数的注释与真机取证。
            // 旧口径错误地同源到 anyLaneLocked()（那是会话切换器的锁，含 busy/restoring），
            // 结果是把这颗按钮在最需要它的时刻禁掉——真机实测忙态真鼠标点击 clicks=0
            // 忙是要停的对象，不是禁用理由。
            stopAll.disabled = _stopAllDisabled();
            if (stopAll.setAttribute) stopAll.setAttribute('title', AEI18n.t('停止全部四条 Agent（导演 / AE 执行 / Shader 执行 / 美术执行）'));
        }
    }

    function _teamEnabledInSettings() {
        var s = global.AEAgentTeam && global.AEAgentTeam.settings;
        if (s && typeof s.isEnabled === 'function') {
            try { return !!s.isEnabled(); } catch (_) { return false; }
        }
        return isTeamModeOn();
    }

    // ── lane 容器显隐（切 lane = 显隐切换，不跨 lane 重渲）────────
    function _singleMessageWrap() {
        var list = _byId('aeAgentMessageList');
        if (!list) return null;
        var wrap = list.parentNode;
        // 只认正牌容器：`#aeAgentMessageList` 的父节点就是单 Agent 的消息区。
        // 类名守卫是为了在骨架变体/测试假 DOM 下不误伤别的宿主节点。
        if (wrap && wrap.className && String(wrap.className).indexOf('ae-agent-message-wrap') >= 0) return wrap;
        return null;
    }

    function syncLaneVisibility() {
        var on = isTeamModeOn();
        var cur = currentLaneId();
        var defs = _laneDefs();
        for (var i = 0; i < defs.length; i++) {
            var def = defs[i] || {};
            if (!def.id) continue;
            var el = _byId(def.containerId || ('aeAgentLane_' + def.id));
            if (!el) continue;
            el.hidden = !(on && def.id === cur);
        }
        var single = _singleMessageWrap();
        if (single) single.hidden = on;
        // 计划 tab 在前台时，换 lane 要把计划树换成**新 lane 的 todo**（每 lane 各自的 plan，
        // 真相源是 AEEngine.view / bridge.getActivePlan —— 都在 _syncSlots 之后指向当前 lane）。
        // 落点仍在 main.js 的 refreshList（本文件不抢它的渲染职责），这里只负责「换了人 ⇒ 再刷一次」。
        // **silent**：refreshList 默认会写状态条「任务清单已刷新…」，那会把刚写的
        // 「已切到 <Agent>」提示（或忙 lane 的真实执行文案）盖掉——换 lane 的刷新不该改状态栏。
        if (on && _activeTab === TAB_PLAN) {
            try {
                if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                    global.AEAgent.refreshList({ silent: true });
                }
            } catch (_) { /* 刷新失败不该打穿切 lane */ }
        }
    }

    // ── 左抽屉 tab 路由（设计 B-4：团队模式优先）────────────────────────────
    // 返回 { shellVisible, tabs, tree, panel }：
    //   shellVisible — #scriptListShell 是否可见；tabs — tab 条是否可见；tree/panel — 计划区与团队面板（互斥）。
    // 单 Agent 路径下与改动前逐字同义（modeHidesShell ⇒ 隐藏 shell），团队模式下一律保留 shell
    // ——GLSL lane 的 slot 就是 shader，沿用「shader ⇒ 隐藏」会让 tab 条与「团队任务」一起消失。
    //
    // **字段名为什么不叫 `shell`**：CI 卡口 `npm run audit:family` 的 F2 族是
    // 「client 下任何非注释行出现 `shell: true` ⇒ 判红」（抓 child_process 的 spawn 选项），
    // 逐行正则分不清「spawn 选项」与「同名的普通布尔字段」——`{ shell: true, … }` 这条路由字面量
    // 因此被误报（真机无 spawn，报错信息里的 _shellQuote 也与此无关）。选择**改名**而不是把
    // teamUI.js 加进 F2 白名单：白名单是文件级的，加了会连这个文件里未来真出现的 spawn 一起放行。
    function resolveDrawerRouting(input) {
        var o = input || {};
        var teamOn = (typeof o.teamOn === 'boolean') ? o.teamOn : isTeamModeOn();
        var tab = (o.tab === TAB_TEAM || o.tab === TAB_PLAN) ? o.tab : _activeTab;
        if (teamOn) {
            // 团队模式：**两个页签并列**——
            // 「计划」显示**当前 lane 自己的 todo**（planTracking 的 plan，侧栏计划树渲染；
            // main.js 的 refreshList 对团队模式也走这条渲染路径），「团队任务」显示团队面板
            // （共用的团队任务清单 + 运行态 + 子 Agent；工作项段已下线）。两者互斥显隐。
            // 曾只留团队任务页签，后果是 lane 自己的 todo 没有渲染面（与恢复计划工具同一处
            // 根因）：模型列了步骤，用户却看不到。
            // toolbar=false：`.script-tree-toolbar`（搜索脚本 +
            // 新建/删除按钮）是**脚本列表**的工具条，它不在 #scriptTree 里 ⇒ 光隐藏树它还在，
            // 于是团队任务面板顶上挂着一排脚本操作。团队模式下它一律不显示（计划页签也不需要它：
            // 计划树是 renderPlanToSidebar 画的，搜索脚本对它无效）。
            var showPlan = (tab === TAB_PLAN);
            return { shellVisible: true, tabs: true, tree: showPlan, panel: !showPlan, planTab: true, toolbar: false };
        }
        return { shellVisible: !o.modeHidesShell, tabs: false, tree: true, panel: false, planTab: false, toolbar: true };
    }

    // 把路由落到 DOM（main.js 的 refreshList 与 tab 点击都经它）。**只写显隐**：
    // 不重建任何子树——tab 切换重建 DOM 会把 `#scriptTree` 的计划树（renderPlanToSidebar
    // 的产物）与团队面板的行节点一起抽掉，用户看到的是闪一下再回来。
    //
    // shell/tree 两元素的写入条件（防「模块刚挂载时把 shader 模式的脚本区闪出来」）：
    //   · 团队模式开着 ⇒ 由本路由说了算（B-4 的团队优先）；
    //   · 单 Agent ⇒ 只有调用方**显式给了模式判据**（main.js 的 refreshList 给了）才写；
    //     没给判据的调用点（mount/tab 切换）只同步 tab 条与面板，不碰 shell/tree——
    //     那两个元素的显隐在单 Agent 路径下的唯一落点是 main.js 的 refreshList。
    function applyDrawerRouting(input) {
        var o = input || {};
        var route = resolveDrawerRouting(o);
        // 团队模式两个页签并列 ⇒ 不再强制把 _activeTab 钉到团队任务；_activeTab 是唯一真相源，
        // 两个页签都可能在团队模式下激活（计划 tab 的渲染由 main.js refreshList 按 route.tree 决定）。
        var shell = _byId('scriptListShell');
        var tree = _byId('scriptTree');
        var canJudgeShell = route.tabs || (typeof o.modeHidesShell === 'boolean');
        if (canJudgeShell) {
            if (shell) shell.style.display = route.shellVisible ? '' : 'none';
            if (tree) tree.style.display = route.tree ? '' : 'none';
        }
        var tabs = _byId('teamDrawerTabs');
        if (tabs) {
            tabs.hidden = !route.tabs;
            var planTab = _byId('teamDrawerTabPlan');
            var teamTab = _byId('teamDrawerTabTeam');
            // 团队模式：两个页签都显示，激活态跟 _activeTab；单 Agent：tabs 整体隐藏，沿用原口径。
            // 判据用各自的 route 字段（planTab / panel），不共用 panel——计划 tab 前台时 panel 恰好为 false。
            var planActive = route.planTab && route.tabs && _activeTab === TAB_PLAN;
            var teamActive = route.panel && route.tabs && _activeTab === TAB_TEAM;
            if (planTab) {
                planTab.hidden = !route.planTab;
                planTab.className = 'team-drawer-tab' + (planActive ? ' is-active' : '');
            }
            if (teamTab) {
                teamTab.className = 'team-drawer-tab' + (teamActive ? ' is-active' : '');
            }
        }
        var panel = _byId('teamTaskPanel');
        if (panel) panel.hidden = !route.panel;
        // 面板不可见时详情浮层必须一起收：浮层挂 body、不随面板 hidden 消失。切页签、切模式、
        // 关团队都汇到这条路由，收在这里才没有第二条关闭链。（工作区文件浮层同一道门。）
        if (!route.panel) { _hideTaskDetail(); _hideFilePopover(); }
        // 计划区让位（团队档切「团队任务」页签 / 计划区隐藏）时计划行浮层跟着收：
        // 浮层挂 body、不随 #scriptTree 隐藏消失。单 Agent route.tree 恒 true，不受影响。
        if (!route.tree) _closePlanDetailPopover();
        // 脚本工具条（搜索脚本 + 新建/删除）：它在 #scriptTree **之外**（静态骨架里的兄弟节点），
        // 所以只隐藏树是藏不住它的（真机现象：「怎么有个搜索脚本框」）。
        // **只写「团队档要藏」这一半**（真机现象：「Agent 模式下左边多了个脚本搜索框」）：
        // 路由不知道模式，早先它在非团队档一律写 `''`，于是一旦在 agent/shader 档被调用
        // （`ae:team-state-changed` → _syncTeamChrome 这条链上就有），就把 refreshList 刚藏好的
        // 搜索框又写回可见——真机复现：团队档点旋钮回 Agent 档，工具条最终 display=''。
        // 另一半（agent / shader 档也要藏）由 main.js 的 refreshList 按模式裁决（模式 chrome 的
        // 单一落点），这里不再越权放行。
        var toolbar = _byId('scriptTreeToolbar');
        if (toolbar && route.toolbar === false) toolbar.style.display = 'none';
        // 可见性可能刚刚变了（抽屉展开/收起、模式切换把 shell 藏了、tab 换了）⇒ 同步轮询开关。
        // 这里必须同步：抽屉展开是一次纯 DOM 动作，没有任何状态事件会跟着来——不同步的话
        // 「展开抽屉后任务板不刷新」，要等下一次 lane 活动才活过来。
        _syncPoller();
        return route;
    }

    // 单 Agent 路径下清掉团队面板的行与顶栏 lane 按钮：留着会在下次开团队时先闪一帧旧数据
    //（那些行是上一次团队会话的状态，与当前会话无关）。
    function _clearBoard() {
        var host = _byId('teamBoardLanes');
        if (host) {
            while (host.children && host.children.length) host.removeChild(host.children[0]);
        }
        // 子 Agent 段同款清理（行 + 占位行）；容器留着（它是面板里的一个空壳）
        var subsHost = (_subagentsSection && _subagentsSection.host && _subagentsSection.host.parentNode)
            ? _subagentsSection.host : _byId('teamBoardSubagents');
        if (subsHost && subsHost.children) {
            while (subsHost.children.length) subsHost.removeChild(subsHost.children[0]);
        }
        // 工作区文件段：行清掉、签名复位（下次开团队按新会话的工作区重渲），
        // 打开着的文件浮层一并收（它挂 body，不随面板 hidden 消失；行已不在也点不回去）。
        var filesHost = _byId('teamBoardFiles');
        if (filesHost && filesHost.children) {
            while (filesHost.children.length) filesHost.removeChild(filesHost.children[0]);
        }
        _filesSig = '';
        _hideFilePopover();
        // 运行态行本身由 renderBoard 按快照复用/裁剪（团队关闭时它不再渲染），这里只清未读基线，
        // 免得下次开团队时先闪一帧「有未读」（那些条数是上一次会话的）。
        _unreadMap = {};
        _lastSnapshot = null;
    }

    // 事件驱动的渲染入口：团队模式开着才渲染（单 Agent 路径下任务板整块不该有内容）。
    function _renderBoardIfTeam() {
        if (!isTeamModeOn()) { _clearBoard(); return 0; }
        return renderBoard();
    }

    function getActiveTab() {
        return _activeTab;
    }

    // tab 切换：只切显示 + 按需刷新数据源，不重建 DOM（单测②钉住这条）。
    function setTab(name) {
        // 团队模式下两个页签都可用（计划 = 当前 lane 自己的 todo；团队任务 = 团队面板）。
        // 显式给了页签名就用它；没给（或给了不认识的值）才按模式取缺省——团队模式落团队任务、
        // 单 Agent 落计划（单 Agent 路径下 tabs 整体隐藏，这里只影响 _activeTab 的真相源）。
        var next = (name === TAB_TEAM || name === TAB_PLAN) ? name : (isTeamModeOn() ? TAB_TEAM : TAB_PLAN);
        var changed = (next !== _activeTab);
        _activeTab = next;
        applyDrawerRouting({ tab: next });
        if (next === TAB_TEAM) {
            _renderBoardIfTeam();
            _syncPoller();
        } else {
            _syncPoller();       // 团队面板不可见 ⇒ 轮询必须停（隐藏时零调用）
            // 详情浮层的关闭不在这里做：统一在 applyDrawerRouting 判 route.panel（见那里）。
        }
        // 「计划」tab 渲染的是**当前 lane** 的 plan：切 tab 时让 main.js 的既有调用点再跑一次
        // （renderPlanToSidebar 的落点仍在 main.js，本文件不抢它的渲染职责）。
        if (next === TAB_PLAN && changed && global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
            try { global.AEAgent.refreshList(); } catch (_) { /* 刷新失败不该让 tab 切换失败 */ }
        }
        return next;
    }

    function _bindTabs() {
        var planTab = _byId('teamDrawerTabPlan');
        var teamTab = _byId('teamDrawerTabTeam');
        if (planTab && !planTab.__aeTeamBound) {
            planTab.__aeTeamBound = true;
            planTab.addEventListener('click', function () { setTab(TAB_PLAN); });
        }
        if (teamTab && !teamTab.__aeTeamBound) {
            teamTab.__aeTeamBound = true;
            teamTab.addEventListener('click', function () { setTab(TAB_TEAM); });
        }
    }

    // ── 刷新节奏 ────────────────────────────────────────────────────────
    // tab 可见性（轮询闸门）：注入优先（单测直驱），否则按真相源 + 骨架状态现算。
    // 「可见」的三条与用户实际看到的一致：团队模式开着、停在团队 tab、抽屉没被收起、shell 没被隐藏。
    function isBoardVisible() {
        if (typeof _opts.isTabVisible === 'function') {
            try { return !!_opts.isTabVisible(); } catch (_) { return false; }
        }
        if (!isTeamModeOn()) return false;
        if (_activeTab !== TAB_TEAM) return false;
        var drawer = _byId('scriptListDrawer');
        if (drawer && drawer.classList && typeof drawer.classList.contains === 'function'
            && drawer.classList.contains('collapsed')) return false;
        var shell = _byId('scriptListShell');
        if (shell && shell.style && shell.style.display === 'none') return false;
        return true;
    }

    function _syncPoller() {
        var want = _mounted && isBoardVisible();
        if (want && !_pollTimer) {
            _pollTimer = _timers().setInterval(function () { _tick(); }, POLL_MS);
        } else if (!want && _pollTimer) {
            _timers().clearInterval(_pollTimer);
            _pollTimer = null;
        }
        return !!_pollTimer;
    }

    function _tick() {
        renderBoard();               // 含 lane 切换条（状态点 + 未读）与当前 lane 的停止按钮态
        syncTopBar();
        _notifyTick();
    }

    // 状态变化事件驱动的一跳（合并窗口内的连续通知只跑一次渲染）。
    function _scheduleRefresh() {
        if (!_mounted) return;
        if (_coalesceTimer) return;
        _coalesceTimer = _timers().setTimeout(function () {
            _coalesceTimer = null;
            _renderBoardIfTeam();
            syncTopBar();
            _syncPoller();
            _notifyTick();
        }, COALESCE_MS);
    }

    function _notifyTick() {
        if (typeof _opts.onStateTick === 'function') {
            try { _opts.onStateTick(); } catch (_) { /* 宿主的锁刷新抛错不该打穿 UI */ }
        }
    }

    // 供三条 view 的渲染钩子调（main.js 的 reflect 循环）：某条 lane 有活动 ⇒ 状态可能变了。
    // 注意：**只安排一次合并渲染**，不在这里读 DOM —— 渲染期读 DOM 会打断正在进行的批量渲染。
    // 单 Agent 路径直接返回：那时没有 lane 语义，团队面板也没有内容可刷（少一次无谓的重排）。
    // 「未读」的判据是**条数差**（见 unreadLanes）：这里不需要额外打标——
    // 非当前 lane 的条数一涨，下一次渲染自然就亮（打标反而会把基线重设成新值，未读永远不亮）。
    function notifyLaneActivity(laneId) {
        if (!_mounted || !isTeamModeOn()) return;
        _scheduleRefresh();
        if (laneId) _lastActivityLane = laneId;
    }

    // 外部（派单 / 子 Agent 完成 / 别的模块）广播的状态变化事件。
    function _onExternalStateChanged() {
        syncTopBar();
        _syncPoller();
        // 锁判据含 binder 的整队切换在途位，它的起止只在这类状态事件上可见：
        // 每次事件重算一次，切换窗口结束后会话切换器才能自己解灰。
        try {
            if (global.AEEngine && typeof global.AEEngine.refreshTeamSwitcherLock === 'function') {
                global.AEEngine.refreshTeamSwitcherLock();
            }
        } catch (_) { /* 引擎未装配：静默 */ }
        if (_mounted) _renderBoardIfTeam();
        // **引擎侧自己把团队开起来**（重载后的恢复链按持久设置启用团队）时，旋钮位置与抽屉路由
        // 必须跟着——这两处的写点分别在 main.js 的 syncRuntimeMode 与 applyDrawerRouting，而 teamUI
        // 只在「用户点开关」那条路径上叫它们时，刷新面板后团队在跑、旋钮却还写着
        // Script、脚本工具条也还挂着（team-state-changed 事件来了但没人重算这两处）。
        _syncTeamChrome();
        // 打开着的「子 Agent 会话」跟着刷新（状态/耗时/token/追问后的新消息都在同一份快照里）
        if (_saSession && _saSession.id && _saSession.mask && _saSession.mask.style.display !== 'none') {
            try { _renderSubagentSession(); } catch (_) { /* 刷新失败不该打穿事件链 */ }
        }
        _notifyTick();
    }

    // 团队 chrome 的四处重算：旋钮的第 5 档位置 + 抽屉路由
    // （页签/计划树/团队面板/脚本工具条）+ 团队布局类（右抽屉上预览下「代码|效果库」、左列团队
    // 面板独占）+ **会话切换器标题**。幂等且只写显隐/文案，可以随时调用；异常各自吞掉
    //（chrome 同步失败不该打穿事件链）。
    // 会话切换器：
    // 团队档与单 Agent 档是**两套会话域**（团队会话 id 由 binder 持有），标题只在各自域的
    // refresh 里取。没有任何一条进出团队的路径重取标题时 ⇒ 顶栏停在上一个模式那条会话的
    // 标题上（真机复现：从 shader 档切进团队，标签仍是 shader 档会话名；调一次
    // refreshSessionTitle 即变成团队会话名）。开/关团队与重载恢复都经本函数 ⇒ 这是唯一写点。
    // **必须走窄接口**：`refreshSessionSwitcher` 是「引擎已装配」的宽信号，
    // 它还会 `_refreshTeamUI()` ⇒ `teamUI.mount()`（实测 315ms/次团队档 / 622ms/次单 Agent 档）；
    // 本函数在每次团队状态事件上都会跑，用宽接口等于每次事件叠一整次团队 UI 重挂载
    //（真机 A/B：出团队阻塞 +1.2s）。窄接口缺席（旧部署）时回落宽接口——
    // 不因缺能力而丢标题刷新。
    function _refreshSessionTitle() {
        var E = global.AEEngine;
        if (!E) return;
        if (typeof E.refreshSessionTitle === 'function') {
            try { E.refreshSessionTitle(); } catch (_) { /* 标题重取失败：不该打穿 chrome 同步 */ }
            return;
        }
        if (typeof E.refreshSessionSwitcher === 'function') {
            try { E.refreshSessionSwitcher(); } catch (_) { /* 同上（旧部署回落） */ }
        }
    }
    function _syncTeamChrome() {
        try {
            if (global.AEAgent && typeof global.AEAgent.syncRuntimeMode === 'function') {
                global.AEAgent.syncRuntimeMode(isTeamModeOn() ? 'team' : (_lastMode || 'script'));
            }
        } catch (_) { /* 旋钮同步失败：不影响其它 chrome */ }
        try { applyDrawerRouting({}); } catch (_) { /* 路由同步失败：同上 */ }
        try { syncLayoutClass(); } catch (_) { /* 布局类同步失败：同上 */ }
        _refreshSessionTitle();   // 窄接口（见其注释：宽的那个会重挂团队 UI，本函数每次都跑）
        // 团队布局里还有**DOM 搬移**（预览 stage 进右抽屉上半；效果库两件进右抽屉的
        // 「效果库」页）：它由 shaderUI 落，主路径是 main.js refreshList 的团队分支。这里补一次
        // 只为覆盖「引擎自己开团队/面板重载」那条不经过 refreshList 的时机；shaderUI 实例还没建
        // 时跳过（refreshList 会建）。
        // **只在团队开着时补 show**：关团队时不动 stage——退出团队要去哪个档位由 refreshList
        // 决定（去外接要把 stage 移进中列，这里抢先移回左列就把它打乱了）。
        try {
            var suL = global.AEShaderUIInstance;
            if (isTeamModeOn() && suL && typeof suL.showTeamLayout === 'function') suL.showTeamLayout();
        } catch (_) { /* stage 搬移失败：refreshList 主路径还会补 */ }
    }

    // 团队布局类：`.team-mode-active` 挂在 #agentPanel 上（与外接的 `.ext-mode-active`
    // 同款手法）。CSS 靠它把右抽屉排成「上 shader 实时预览 / 下『GLSL 代码 | 效果库』并列 tab」、
    // 左列排成「团队面板独占」（效果库搬进右抽屉后左列不再双栏）。为什么团队必须自己接管
    // 这块 chrome：第 5 档是派生档（settings.runtimeMode 保持原值），底层若是 external，
    // 六功能区的 display:none!important 会把聊天区/输入区压住——真机「从外接切到团队，聊天历史框和
    // 输入框都没出来」正是这条。写点唯一（_syncTeamChrome），进/出团队与重载恢复都经它。
    function syncLayoutClass() {
        var ap = _byId('agentPanel');
        if (!ap || !ap.classList) return;
        if (isTeamModeOn()) ap.classList.add('team-mode-active');
        else ap.classList.remove('team-mode-active');
    }

    // ── 交互动作 ────────────────────────────────────────────────────────
    // 开关：先确认「运行时能落」（引擎装配面在不在），再落设置，最后落运行时。
    // 顺序不能倒：引擎没装配就先把设置写成 enabled:true，会留下「设置说开着、运行时没开」
    // 的半态——本次会话开关回弹、下次重载又自己开起来，用户完全看不懂。
    // opts（**可选**）：
    //   · targetMode        —— 关团队**马上要切到**的那一档（旋钮档位路径传进来的）。同步旋钮时用它，
    //                          而不是回落 `_opts.getRuntimeMode() || 'script'`：后者在「底层档=外接」
    //                          这类场景下会把旋钮先写成脚本、再被随后的切档改成真档（真机：旋钮 4→0→1 跳两下）。
    //   · skipChromeRefresh —— 关团队之后**不再自己 refreshList 一次**。专给「关团队只为立刻切到别的档」
    //                          的调用方（旋钮档位路径）：那一次 refreshList 画的是**底层档**的 chrome——
    //                          底层档是外接时就把外接布局点亮了一瞬，紧接着的切档又把它摘掉，
    //                          真机表现就是「团队 → 外接 → 回团队 → 转其他模式时闪一下外接面板」
    //                          （`enter()` 由那次 refreshList 调起，
    //                          152ms 后才被 exit 摘掉，中间 5–9 帧外接面板可见）。
    //                          调用方随后必然自己 refreshList（切档成功路径），所以这里不画反而只剩一次绘制。
    function _setTeamEnabled(on, opts) {
        var o = opts || {};
        var applier = (typeof _opts.setTeamMode === 'function')
            ? _opts.setTeamMode
            : (global.AEEngine && typeof global.AEEngine.setTeamMode === 'function' ? global.AEEngine.setTeamMode : null);
        if (typeof applier !== 'function') {
            _status(AEI18n.t('团队模式不可用：引擎未装配（AEEngine.setTeamMode 缺失）——设置未改动'), 'error');
            syncTopBar();   // 勾选态回弹（真相源仍是设置段）
            return Promise.resolve(false);
        }
        var cur = readTeamSettings();
        // 来处 = 此刻面板档位。取法按可靠性排序：
        //   ① `_runtimeMode()` —— 宿主推来的模式（`_lastMode`）或旋钮档位（DOM 镜像）。
        //      两者就是 `settings.runtimeMode` 的镜像，且**不依赖任何注入**（DOM 永远在）；
        //   ② `_opts.getRuntimeMode()`（旧注入；生产上 mount 未注入它 ⇒ 常缺）；
        //   ③ team 快照里上一回的 baseMode；④ 'script'。
        // 只读 ②+③ 时，「外接 → 团队」会把来处记成上一回的 baseMode
        // （agent/script）而不是 external ⇒ 退出团队落错档，正是这轮要根治的用户可见症状。
        var SINGLE_MODES = (global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.SINGLE_MODES)
            || ['script', 'agent', 'shader', 'external'];
        var curMode = '';
        try {
            var knobMode = String(_runtimeMode() || '');
            if (SINGLE_MODES.indexOf(knobMode) >= 0) curMode = knobMode;
        } catch (_) { /* 判不出：走下面两条 */ }
        if (!curMode && typeof _opts.getRuntimeMode === 'function') {
            try {
                var optMode = String(_opts.getRuntimeMode() || '');
                if (SINGLE_MODES.indexOf(optMode) >= 0) curMode = optMode;
            } catch (_) { /* 注入的取值器抛错：走下面 */ }
        }
        if (!curMode) curMode = (SINGLE_MODES.indexOf(cur.baseMode) >= 0) ? cur.baseMode : 'script';
        // 退出落点：调用方指定的目标档优先（`targetMode`），否则回 baseMode（来处）。
        var offMode = (o.targetMode && SINGLE_MODES.indexOf(String(o.targetMode)) >= 0)
            ? String(o.targetMode)
            : curMode;
        var next = {
            enabled: !!on,
            baseMode: on ? curMode : offMode,
            lanes: cur.lanes || {},
            subagent: cur.subagent || null
        };
        // ── 开关这一下**必须同时写 runtimeMode**，两半在同一次 saveSettings 里 ──
        //   · 开团队：runtimeMode='team'，baseMode=来处（当前单 Agent 档位）；
        //   · 关团队：runtimeMode = targetMode || baseMode —— 「离开团队」在语义上**就是切到那一档**，
        //     不写它设置段那颗开关就关不掉团队：归一实现按真相重算 enabled，会把只写了
        //     `team.enabled=false` 的一次保存又拉回 true。
        // 旋钮路径**不再**走这里退出团队（一步式：controller.switchMode 写设置 + switchGlobalMode
        // 成功后关引擎），故 `targetMode` 现在只有「设置段的开关要顺手切到某档」这类调用方会用。
        var modeToWrite = on ? 'team' : offMode;
        var saver = (typeof _opts.saveSettings === 'function') ? _opts.saveSettings : global.saveSettings;
        var p = null;
        if (typeof saver === 'function') {
            try { p = saver({ runtimeMode: modeToWrite, team: next }); } catch (e) { p = Promise.reject(e); }
        }
        return Promise.resolve(p).then(function (saved) {
            if (saved === false) {
                // 写盘失败（配额满/加密异常）：**不改运行时**，如实提示——否则重载后开关回退，
                // 用户以为「上次明明开了团队模式」。
                _status(AEI18n.t('团队模式设置写入失败，重启后不会保留（本地存储写入被拒绝）'), 'error');
                syncTopBar();   // 勾选态回弹
                return false;
            }
            var res = applier(!!on);
            if (res === null) {
                // bootstrap 的显式失败体：装配面缺席（orchestrator 未加载）⇒ 保持单 Agent 路径
                _status(AEI18n.t('团队模式不可用：编排面（orchestrator）未加载'), 'error');
                syncTopBar();   // 勾选态回弹
                return false;
            }
            // ── 引擎**全失败已回滚** ⇒ 设置也必须回滚 ────────────────
            // 引擎回滚后若设置还停在 runtimeMode='team'，重载面板会再尝试开一次（失败再来一遍），
            // 用户还会看到「开关是开的、界面是单 Agent」的错位。回滚到本次写入前的档位（curMode）
            // 并把失败原因如实显示。只有 rolledBack 才回滚：partial（部分 lane 可用）保持开着。
            if (on && res && res.rolledBack === true) {
                // 失败文案优先取引擎给的**人话** message（single_busy/busy 这类原因码用户读不懂），
                // 其次才是失败 lane 名/原因码（拒绝必须可见且可理解）。
                var failText = res.message
                    || ((res.failed && res.failed.length) ? res.failed.join('/') : '')
                    || res.reason || 'runtime_failed';
                _status(AEI18n.t('团队模式启动失败（{reason}），已退回原模式', { reason: failText }), 'error');
                var rbTeam = {
                    enabled: false,
                    baseMode: curMode,
                    lanes: cur.lanes || {},
                    subagent: cur.subagent || null
                };
                var rbP = null;
                if (typeof saver === 'function') {
                    try { rbP = saver({ runtimeMode: curMode, team: rbTeam }); } catch (e) { rbP = Promise.reject(e); }
                }
                return Promise.resolve(rbP).then(function () {
                    syncTopBar();
                    _syncPoller();
                    _dispatchStateChanged();
                    try {
                        if (global.AEAgent && typeof global.AEAgent.syncRuntimeMode === 'function') {
                            global.AEAgent.syncRuntimeMode(curMode);
                        }
                    } catch (_) { /* 旋钮同步失败不该让回滚失败 */ }
                    return false;
                }, function () {
                    _status(AEI18n.t('团队模式设置回滚失败，重启后会再次尝试开启'), 'warn');
                    syncTopBar();
                    return false;
                });
            }
            // 部分 lane 装配失败：仍算开着（既有设计：不阻断其余两条），但必须如实提示缺了谁，
            // 否则用户只看到一个「少了条 Agent」的团队（任务板少一行，没有任何解释）。
            if (on && res && res.teamState === 'partial') {
                _status(AEI18n.t('团队模式已开启，但部分 Agent 装配失败：{failed}',
                    { failed: (res.failed || []).join('/') || AEI18n.t('未知') }), 'warn');
            }
            if (on) {
                _seenMsgCount = {};
                syncLaneVisibility();
                _activeTab = TAB_TEAM;   // 开团队直接落到「团队任务」：开完看不到面板等于没开
                applyDrawerRouting({});
                _renderBoardIfTeam();
            } else {
                syncLaneVisibility();
                _activeTab = TAB_PLAN;
                applyDrawerRouting({});
                _clearBoard();
            }
            syncTopBar();
            _syncPoller();
            _notifyTick();
            // 模式旋钮的第 5 档位置：团队开关是另一条入口（设置段的开关），它变化后旋钮必须
            // 跟着走——旋钮位置的写点唯一在 main.js 的 syncRuntimeMode。
            // 同步到**本次实际写入的那一档**（`modeToWrite`），不再回落
            // `_opts.getRuntimeMode() || 'script'` —— 那个回落是生产上的真实缺陷：mount 未注入
            // getRuntimeMode 时它恒取 'script'，于是「从设置段关团队」会把旋钮写成「脚本」，
            // 而设置与界面其实是 external（真机实测：disk `runtimeMode='external'` + 外接布局亮着，
            // 旋钮却停在 idx=0）。现在 `modeToWrite` 就是要落的那一档，两边不可能不一致。
            try {
                if (global.AEAgent && typeof global.AEAgent.syncRuntimeMode === 'function') {
                    global.AEAgent.syncRuntimeMode(modeToWrite);
                }
            } catch (_) { /* 旋钮同步失败不该让开关失败 */ }
            if (!o.skipChromeRefresh && global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
                try { global.AEAgent.refreshList(); } catch (_) { /* 列表刷新失败不该让开关回弹 */ }
            }
            _dispatchStateChanged();
            return true;
        }, function () {
            _status(AEI18n.t('团队模式设置保存失败'), 'error');
            syncTopBar();   // 勾选态回弹
            return false;
        });
    }

    // 开关是**复选框**：change 事件带目标勾选态，直接照它落运行时。
    // 落失败（写盘被拒 / 引擎未装配）时回弹勾选态——勾选态的唯一真相源是设置段，
    // 不回弹就会留下「看起来开着、其实没开」的半态。
    function _onToggleChange(e) {
        var t = (e && e.target) || null;
        var want = !!(t && t.checked);
        var p = _setTeamEnabled(want);
        // 在途位：写盘是异步的，期间不让 syncTopBar 按（还没更新的）设置段把勾选态闪回去
        _toggleInFlight = true;
        var done = function () {
            _toggleInFlight = false;
            syncTopBar();
            if (want) _expandDrawerForTeam();
        };
        if (p && typeof p.then === 'function') p.then(done, done);
        else done();
    }

    // 开团队时顺手展开左抽屉：
    // 抽屉收着的话，切换入口与任务板都看不见——刚开团队的用户会以为「入口没了」。
    // 只在**收起**时展开一次，不反向收起（尊重用户自己的布局选择）。
    function _expandDrawerForTeam() {
        var shell = _byId('scriptListDrawer');
        if (!shell || !shell.classList || typeof shell.classList.contains !== 'function') return false;
        if (!shell.classList.contains('collapsed')) return false;
        var app = global.AEAgentApp || {};
        if (typeof app.setDrawerExpanded === 'function') {
            try { app.setDrawerExpanded(true); return true; } catch (_) { return false; }
        }
        return false;
    }

    function _onLaneClick(id) {
        var cur = currentLaneId();
        if (id === cur) return;
        var orch = _orchestrator();
        var switcher = null;
        if (orch && typeof orch.setCurrentLane === 'function') {
            switcher = function (lane) { return orch.setCurrentLane(lane); };
        } else if (global.AEEngine && typeof global.AEEngine.setCurrentLane === 'function') {
            // 引擎侧 setter（bootstrap 的公开面；缺失时下面如实提示，不假装切过去了）
            switcher = function (lane) { return global.AEEngine.setCurrentLane(lane); };
        }
        if (typeof switcher !== 'function') {
            _status(AEI18n.t('Agent 切换入口未接线：引擎未暴露 setCurrentLane（AEEngine.getOrchestrator 也没有编排面）'), 'warn');
            return;
        }
        var res = null;
        try { res = switcher(id); } catch (e) { res = { ok: false, reason: 'error' }; }
        if (res && res.ok === false) {
            _status(AEI18n.t('切换 Agent 失败：{reason}', { reason: res.reason || 'unknown' }), 'error');
            return;
        }
        if (res && res.changed === false) return;
        _seenMsgCount[id] = _laneMessageCount(id);
        syncLaneVisibility();          // 当前 lane 容器显示、其余隐藏（真相源已切换）
        _renderBoardIfTeam();
        syncTopBar();
        _notifyTick();
        if (global.AEAgent && typeof global.AEAgent.refreshList === 'function') {
            // 计划区/脚本区按新的当前 lane 重取（滚动到底与拖拽改高也按当前 lane —— main.js 里
            // 那两个入口每次都经 _currentMessageList() 现取，切换后自然指向新 lane）
            try { global.AEAgent.refreshList(); } catch (_) { /* 刷新失败不影响切 lane 本身 */ }
        }
        _dispatchStateChanged();
    }

    function _onStopCurrent() {
        var id = currentLaneId();
        var orch = _orchestrator();
        if (!id || !orch || typeof orch.stopLane !== 'function') {
            _status(AEI18n.t('停止入口未接线：编排面不可用'), 'warn');
            return;
        }
        var res = orch.stopLane(id);
        if (res && res.ok === false) _status(AEI18n.t('停止失败：{reason}', { reason: res.reason || 'unknown' }), 'error');
        _renderBoardIfTeam();
        syncTopBar();
        _notifyTick();
    }

    // 「全部停止」成功时的可见反馈（只提示失败分支时，成功点下去像没反应）。
    // **数字口径**：只报**真在跑的**。
    //   直接拿 `res.stopped` 的长度当「已停下几条」——那是「有 runtime 的 lane 数」，恒等于
    //   三条，于是**全空闲时点一下**也会报「已停下 3 条 Agent 及其 0 个子 Agent」，读起来像刚停了
    // 三条在跑的。
    //   现在「在跑几条」在**点之前**按 `laneFlags(id).busy` 现算（与 `anyLaneLocked` 同一判据源）；
    //   子 Agent 条数仍用编排面的 `subagentsStopped`，且 **0 不报**（不编一句「及其 0 个子 Agent」）。
    // 措辞用「已停下」而不是「已停止」：后者正是子 Agent 状态档 `stopped` 的显示文案，
    // 而本文件里**不出现**任何状态档文案的第二份
    //（同一情形两种说法会造成漂移）。
    //
    // 点之前**真在跑的 lane 数**（`busy` 一腿，与 anyLaneLocked 同源）。取不到 lane 定义时返回 -1
    // ⇒ `_stopAllText` 走「退回旧口径」分支，不猜数字。
    function _runningLaneCount() {
        var ids = null;
        try { ids = _laneIds() || []; } catch (_) { return -1; }
        if (!ids.length) return -1;
        var n = 0;
        for (var i = 0; i < ids.length; i++) {
            if (laneFlags(ids[i]).busy) n++;
        }
        return n;
    }

    function _stopAllText(res, runningLanes) {
        var r = res || {};
        var sub = (typeof r.subagentsStopped === 'number' && isFinite(r.subagentsStopped) && r.subagentsStopped > 0)
            ? r.subagentsStopped : null;
        var running = (typeof runningLanes === 'number' && runningLanes >= 0) ? runningLanes : -1;
        if (running < 0) {
            // 读不到「在跑几条」（旧装配 / lane 定义缺席）⇒ 退回旧口径：只报编排面给的那份
            var n = Array.isArray(r.stopped) ? r.stopped.length : -1;
            var legacy = (n >= 0) ? AEI18n.t('已停下 {n} 条 Agent', { n: n }) : AEI18n.t('全部 Agent 已停下');
            if (sub !== null) legacy += AEI18n.t(' 及其 {n} 个子 Agent', { n: sub });
            return legacy;
        }
        if (running === 0) {
            // 空闲时点它：如实说「没人在跑」，不再冒充停掉了三条
            return (sub !== null)
                ? AEI18n.t('已停下 {n} 个子 Agent（Agent 本身没在跑）', { n: sub })
                : AEI18n.t('当前没有 Agent 在跑');
        }
        return AEI18n.t('已停下 {n} 条在跑的 Agent', { n: running })
            + (sub !== null ? AEI18n.t(' 及其 {n} 个子 Agent', { n: sub }) : '');
    }

    function _onStopAll() {
        var orch = _orchestrator();
        if (!orch || typeof orch.stopAll !== 'function') {
            _status(AEI18n.t('全部停止入口未接线：编排面不可用'), 'warn');
            return;
        }
        // 在跑数必须在 stopAll **之前**取（停完就都闲了，事后再算恒 0）
        var running = _runningLaneCount();
        var res = orch.stopAll();
        if (res && res.ok === false) _status(AEI18n.t('全部停止：部分 Agent 未停下'), 'error');
        else _status(_stopAllText(res, running), 'info');
        _renderBoardIfTeam();
        syncTopBar();
        _notifyTick();
    }

    function _status(msg, type) {
        if (typeof global.showStatus === 'function') {
            try { global.showStatus(msg, type || 'info'); } catch (_) { /* 提示失败不影响主流程 */ }
        }
    }

    function _dispatchStateChanged() {
        var d = _doc();
        if (!d || typeof d.dispatchEvent !== 'function') return;
        var CE = (typeof global.CustomEvent === 'function') ? global.CustomEvent
            : ((d.defaultView && d.defaultView.CustomEvent) || null);
        if (typeof CE !== 'function') return;
        try { d.dispatchEvent(new CE('ae:team-state-changed')); } catch (_) { /* 事件通道可选 */ }
    }

    // ── 装配 / 拆卸 ─────────────────────────────────────────────────────
    // 幂等：index.js 每次进入模块都会调（顶栏随 unmount 重建），重复 mount 只做「补齐节点 + 重同步」。
    function mount(opts) {
        _opts = opts || {};
        _mounted = true;
        var d = _doc();
        // 状态变化事件的订阅只绑一次（模块 unmount/remount 会重复调 mount）：重复绑定会让
        // 一次广播触发 N 次渲染。
        if (!_docEventBound && d && typeof d.addEventListener === 'function') {
            _docEventBound = true;
            d.addEventListener('ae:team-state-changed', function () { _onExternalStateChanged(); });
        }
        _ensureTopBarNodes();
        _bindTabs();
        syncLaneVisibility();
        applyDrawerRouting({});
        _renderBoardIfTeam();
        syncTopBar();
        _syncPoller();
        _syncTeamChrome();   // mount 那一刻团队可能已经开着（重载恢复链）⇒ 旋钮/路由立刻对齐
        _notifyTick();
        return true;
    }

    function unmount() {
        _mounted = false;
        _hideTaskDetail();   // 详情浮层挂 body：模块卸载必须自己摘（否则切走模块后浮层留在聊天区上空）
        _hideFilePopover();  // 工作区文件浮层同款（挂 body、不随面板卸载消失）
        _filesSig = '';
        if (_pollTimer) {
            _timers().clearInterval(_pollTimer);
            _pollTimer = null;
        }
        if (_coalesceTimer) {
            _timers().clearTimeout(_coalesceTimer);
            _coalesceTimer = null;
        }
        // 团队开关挂在**静态骨架**（.llm-chat-topbar 的模式旋钮行）里——宿主顶栏那一条会随
        // index.js 的 topbarEl 一起被摘掉，这一颗不会。不显式摘掉，「切走模块再回来」就会叠出
        // 第二颗开关（拓扑校验按引用判等兜不住它：unmount 已经把引用丢了）。
        var drop = function (el) {
            if (el && el.parentNode) {
                try { el.parentNode.removeChild(el); } catch (_) { /* 骨架已被换掉：无需摘 */ }
            }
        };
        if (_nodes) {
            drop(_nodes.switchWrap);
        }
        _nodes = null;
        _activeTab = TAB_PLAN;
        // 折叠态与 _activeTab 同款：**挂载周期内的内存态**，unmount 时一并复位。
        // 没有重置点时 ⇒ 关掉模块再回来，折叠的段还是折着的（而 _activeTab
        // 已经回到「计划」，两处对不上）。**同一挂载周期内的重渲染照旧保持折叠**
        //（复位点只有这里，renderBoard/_applySectionCollapsed 都不碰它——那条已被测试钉住）。
        _collapsedSections = {};
        return true;
    }

    // team 段的**读取**访问器（归一实现在 engine/settings.js；本文件不写第二份默认值）
    // baseMode 一并带出：开关落盘时要用它保住「退出团队回哪一档」的来处。
    function readTeamSettings() {
        var s = global.AEAgentTeam && global.AEAgentTeam.settings;
        if (s && typeof s.snapshot === 'function') {
            try {
                var snap = s.snapshot();
                if (snap) {
                    return {
                        enabled: !!snap.enabled,
                        baseMode: (typeof snap.baseMode === 'string') ? snap.baseMode : 'script',
                        lanes: snap.lanes || {},
                        subagent: snap.subagent || null
                    };
                }
            } catch (_) { /* 取不到 → 关闭态 */ }
        }
        return { enabled: false, baseMode: 'script', lanes: {}, subagent: null };
    }

    global.AEAgentTeamUI = {
        mount: mount,
        unmount: unmount,
        // 真相源访问器
        isTeamModeOn: isTeamModeOn,
        currentLaneId: currentLaneId,
        laneFlags: laneFlags,
        anyLaneLocked: anyLaneLocked,
        readTeamSettings: readTeamSettings,
        // 任务板
        buildSnapshot: buildSnapshot,
        orderBoardRows: orderBoardRows,
        renderBoard: renderBoard,
        lastSnapshot: function () { return _lastSnapshot; },
        // 左抽屉路由
        resolveDrawerRouting: resolveDrawerRouting,
        applyDrawerRouting: applyDrawerRouting,
        getActiveTab: getActiveTab,
        setTab: setTab,
        // 刷新
        isBoardVisible: isBoardVisible,
        notifyLaneActivity: notifyLaneActivity,
        syncLaneVisibility: syncLaneVisibility,
        syncTopBar: syncTopBar,
        syncModeChrome: syncModeChrome,
        // 团队布局类：.team-mode-active 的写入落点（可编程出口供自动化驱动）
        syncLayoutClass: syncLayoutClass,
        // 任务板各段的折叠：出口供自动化驱动（真机判据仍走真点击标题）
        toggleBoardSection: toggleBoardSection,
        isBoardSectionCollapsed: isBoardSectionCollapsed,
        // 子 Agent 会话：点「子 AGENT」段的行进它的会话（弹窗）；自动化用这两个出口
        openSubagentSession: openSubagentSession,
        closeSubagentSession: closeSubagentSession,
        // 工作区文件：按文件名打开浮层（可编程出口供自动化驱动；真实入口是文件行的点击）
        openWorkspaceFile: openWorkspaceFile,
        // 动作（单测直驱）
        setTeamEnabled: _setTeamEnabled,
        stopCurrentLane: _onStopCurrent,
        stopAllLanes: _onStopAll
    };
})(typeof window !== 'undefined' ? window : globalThis);
