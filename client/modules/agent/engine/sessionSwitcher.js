(function (global) {

    function createSessionSwitcher(options) {
        var opts = options || {};
        var getController = opts.getController;
        // 删除会话属不可逆操作，统一走全局 showConfirm 二次确认（与 script-tree/
        // service/settings 等模块一致）。优先用注入的 opts.showConfirm，回退到
        // 全局 showConfirm（main.js 顶层函数声明）。均不可用时拒绝而非放行——
        // 兜底放行会让不可逆删除在无确认组件的环境（局部加载/异常初始化）被静默执行。
        var _showConfirm = typeof opts.showConfirm === 'function'
            ? opts.showConfirm
            : (typeof global.showConfirm === 'function' ? global.showConfirm : function (t, m) { return Promise.resolve(false); });

        var _container = null;
        var _btn = null;
        var _label = null;
        var _menu = null;
        var _backdrop = null;
        var _isOpen = false;
        var _disabled = false;
        var _onDocClick = null;
        var _searchText = '';

        // ── 团队模式通道 ────────────────────────
        // 团队模式下**整队**会话只有 binder 一个下发口（`team/sessionBinder.js` 头注：id 规则、
        // busy 预检、部分失败回滚、三份索引同步都在它里面）。本文件因此在团队模式下**不再读写
        // 任何一条 lane 的 controller**——那样只会动到「当前 lane」，另外两条还停在旧会话上，
        // 正是要消除的分叉。三条显式通道（全部可选，缺省回落全局命名空间，
        // 与 orchestrator.js / sessionBinder.js 同一套口径）：
        //   opts.isTeamMode()    — () => boolean；缺省回落 global.AEAgentTeam.settings.isEnabled()
        //                          （团队开关的唯一读取访问器，见 team/settings.js:35）
        //   opts.getBinder()     — () => binder，须有 createTeamSession() / switchTeamSession(sid) /
        //                          renameTeamSession(sid,title) / deleteTeamSession(sid) /
        //                          getCurrentSessionId()；缺省回落 global.AEAgentTeam.sessionBinder
        //                          → AEAgentTeam.getSessionBinder() → AEEngine.getSessionBinder()
        //   opts.getTeamStores() — () => [store,…]（三条 lane 的 sessionStore，索引互为镜像）；
        //                          缺省回落 AEEngine.getLaneStores() → AEAgentTeam.laneStores
        //                          （数组或 {laneId: store}）→ 按 AEAgentTeam.lanes.list() 的
        //                          lane id 逐个调 AEEngine.getLaneStore(id)
        // 通道缺席时不回落单 Agent 路径（那会在一条 lane 里建会话、另两条看不见，正是要修的分叉）：
        // 列表为空，四个动作各弹一条如实文案（reason:'not_wired'）。
        // binder 的返回体是**同步对象**（不是 Promise）：按 ok/reason 给文案，busy / partial /
        // rolledBack 一律如实告知（唯一实现见 _teamFailText）；改名 / 删除的异步落盘结果在
        // res.done 里，失败经 _teamDoneWatch 留痕，不静默成功。

        function _escapeHtml(text) {
            return String(text || '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;');
        }

        function _formatTime(ts) {
            if (!ts) return '';
            var d = new Date(ts);
            var mm = String(d.getMonth() + 1).padStart(2, '0');
            var dd = String(d.getDate()).padStart(2, '0');
            var hh = String(d.getHours()).padStart(2, '0');
            var mi = String(d.getMinutes()).padStart(2, '0');
            return mm + '-' + dd + ' ' + hh + ':' + mi;
        }

        // 会话标题的显示值：持久化默认标题（state/sessionStore 写入的源文）在显示层翻译，
        // 其余标题是用户数据，原样显示。
        function _displayTitle(title) {
            var s = (title == null) ? '' : String(title);
            if (!s || s === '新会话') return AEI18n.t('新会话');
            return s;
        }

        // 按标题子串过滤（大小写不敏感）
        function _filterSessions(sessions) {
            if (!_searchText) return sessions;
            var q = _searchText.toLowerCase();
            var out = [];
            for (var i = 0; i < sessions.length; i++) {
                if (String(sessions[i].title || '').toLowerCase().indexOf(q) !== -1) {
                    out.push(sessions[i]);
                }
            }
            return out;
        }

        // ── 团队通道解析（缺省回落全局命名空间；每处都不抛、拿不到就是拿不到）──────────
        function _teamApi() { return global.AEAgentTeam || null; }

        function _isTeamMode() {
            if (typeof opts.isTeamMode === 'function') {
                try { return opts.isTeamMode() === true; } catch (_) { return false; }
            }
            var T = _teamApi();
            if (T && T.settings && typeof T.settings.isEnabled === 'function') {
                try { return T.settings.isEnabled() === true; } catch (_) { return false; }
            }
            return false;
        }

        function _binder() {
            if (typeof opts.getBinder === 'function') {
                try { var b0 = opts.getBinder(); if (b0) return b0; } catch (_) { /* 回落下一来源 */ }
            }
            var T = _teamApi();
            if (T && T.sessionBinder) return T.sessionBinder;
            if (T && typeof T.getSessionBinder === 'function') {
                try { var b1 = T.getSessionBinder(); if (b1) return b1; } catch (_) { /* 回落下一来源 */ }
            }
            if (global.AEEngine && typeof global.AEEngine.getSessionBinder === 'function') {
                try { var b2 = global.AEEngine.getSessionBinder(); if (b2) return b2; } catch (_) { /* 拿不到 */ }
            }
            return null;
        }

        function _asStoreList(v) {
            var out = [];
            if (!v) return out;
            if (Array.isArray(v)) {
                for (var i = 0; i < v.length; i++) { if (v[i]) out.push(v[i]); }
                return out;
            }
            if (typeof v === 'object') {
                var keys = Object.keys(v);
                for (var j = 0; j < keys.length; j++) { if (v[keys[j]]) out.push(v[keys[j]]); }
            }
            return out;
        }

        // 三条 lane 的 store：镜像索引。取不到就返回空数组——调用方据此走「通道未装配」。
        function _teamStores() {
            if (typeof opts.getTeamStores === 'function') {
                try { var s0 = _asStoreList(opts.getTeamStores()); if (s0.length) return s0; } catch (_) { /* 回落 */ }
            }
            var E = global.AEEngine;
            if (E && typeof E.getLaneStores === 'function') {
                try { var s1 = _asStoreList(E.getLaneStores()); if (s1.length) return s1; } catch (_) { /* 回落 */ }
            }
            var T = _teamApi();
            if (T && T.laneStores) {
                var s2 = _asStoreList(T.laneStores);
                if (s2.length) return s2;
            }
            // 最后一条：按 lane 定义枚举 lane id，逐个向宿主问 store（与 bootstrap 给 binder 注入
            // getLaneStore 的落点同源）。lanes 定义缺席时不做猜测。
            if (E && typeof E.getLaneStore === 'function' && T && T.lanes && typeof T.lanes.list === 'function') {
                var defs = null;
                try { defs = T.lanes.list(); } catch (_) { defs = null; }
                var out = [];
                if (Array.isArray(defs)) {
                    for (var k = 0; k < defs.length; k++) {
                        var id = (typeof defs[k] === 'string') ? defs[k] : (defs[k] && defs[k].id);
                        if (!id) continue;
                        try { var st = E.getLaneStore(id); if (st) out.push(st); } catch (_) { /* 该 lane 拿不到 */ }
                    }
                }
                if (out.length) return out;
            }
            return [];
        }

        // 团队会话清单：按 id 去重合并三条 lane 的索引。合并（而非只读第一条）的理由：某条 lane
        // 漂了时那条会话不该在菜单里彻底消失——改名/删除时 binder 会如实报 missing。
        function _teamSessions() {
            var stores = _teamStores();
            var out = [];
            var seen = {};
            for (var i = 0; i < stores.length; i++) {
                var st = stores[i];
                if (!st || typeof st.listSessions !== 'function') continue;
                var list = null;
                try { list = st.listSessions() || []; } catch (_) { list = []; }
                for (var j = 0; j < list.length; j++) {
                    var s = list[j];
                    if (!s || !s.id || seen[s.id]) continue;
                    seen[s.id] = true;
                    out.push(s);
                }
            }
            out.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
            return out;
        }

        function _teamCurrentId() {
            var b = _binder();
            if (!b || typeof b.getCurrentSessionId !== 'function') return null;
            try { return b.getCurrentSessionId(); } catch (_) { return null; }
        }

        function _teamSessionById(id) {
            var list = _teamSessions();
            for (var i = 0; i < list.length; i++) { if (list[i].id === id) return list[i]; }
            return null;
        }

        function _teamToast(msg, kind) {
            if (global.AEToast && typeof global.AEToast.show === 'function') global.AEToast.show(msg, kind || 'warn');
        }

        // 团队会话绑定变化后的**面板刷新**：走既有的 `ae:team-state-changed` 事件通道
        // ——teamUI 在 mount 时订阅它（`_onExternalStateChanged` ⇒ `_renderBoardIfTeam` ⇒ 任务清单段
        // 与子 Agent 段都重读）。发该事件的原因：`refresh()` 只覆盖**切换器自己**
        // （标题/菜单），任务板两段一个字都不重读 ⇒ 切到会话 B 之后面板上还挂着会话 A 的任务清单
        //（真机表现为「切了会话，团队任务清单还是上一个会话的」）。
        // 为什么**不**在这里直接摸 teamUI（调它的 renderBoard）：那是第二条私有刷新路径，两处
        // 触发时机/顺序必然漂移。事件是既有通道（bootstrap.js 与 teamUI 自己也在派发同一个名字）。
        // 能力缺席一律静默跳过（假 DOM / 老环境没有 dispatchEvent 或 CustomEvent）——一次刷新失败
        // 不该让会话切换本身报错。
        function _notifyTeamStateChanged() {
            var d = null;
            try { d = (typeof document !== 'undefined') ? document : null; } catch (_) { d = null; }
            if (!d || typeof d.dispatchEvent !== 'function') return false;
            var CE = (typeof global.CustomEvent === 'function') ? global.CustomEvent
                : ((d.defaultView && d.defaultView.CustomEvent) || null);
            if (typeof CE !== 'function') return false;
            try { d.dispatchEvent(new CE('ae:team-state-changed')); return true; } catch (_) { return false; }
        }

        // binder 归因表 → 用户文案（**唯一一份**，UI 不自己编原因）。busy / partial / rolledBack
        // 必须如实：静默当成功会让用户以为整队已切走，实际还在旧会话上。
        function _teamFailText(res, action) {
            var reason = (res && res.reason) || 'error';
            var act = action || AEI18n.t('操作');
            if (reason === 'busy') return AEI18n.t('团队会话{action}未完成：有 Agent 正在执行任务，请等它停下来再试', { action: act });
            if (reason === 'not_wired') return AEI18n.t('团队会话通道未装配：宿主未提供会话绑定器（binder），本次{action}未执行', { action: act });
            if (reason === 'partial') {
                var txt = AEI18n.t('团队会话{action}未完成：部分 Agent 失败，已把切成功的 Agent 回切', { action: act });
                if (res && res.rolledBack && res.rolledBack.length) {
                    txt += AEI18n.t('（已回切：{list}）', { list: res.rolledBack.join('、') });
                }
                var f = (res && res.failed && res.failed[0]) ? res.failed[0] : null;
                if (f) txt += AEI18n.t('；失败 Agent：{agent}（{reason}）', { agent: f.lane, reason: f.reason || 'error' });
                if (res && res.rollbackFailed && res.rollbackFailed.length) {
                    txt += AEI18n.t('；⚠ 回滚未完成，部分 Agent 可能停在不同会话上：{list}', {
                        list: res.rollbackFailed.map(function (x) { return x.lane + '(' + (x.reason || 'error') + ')'; }).join('、')
                    });
                }
                return txt;
            }
            if (reason === 'last_one') return AEI18n.t('至少保留一个会话');
            if (reason === 'bad_title') return AEI18n.t('会话标题不能为空');
            if (reason === 'unknown_session') return AEI18n.t('团队会话{action}未完成：这条会话在部分 Agent 的索引里不存在，未做半成功改动', { action: act });
            return AEI18n.t('团队会话{action}未完成（原因：{reason}）', { action: act, reason: reason });
        }

        // 改名 / 删除的**异步落盘结果**（binder 的 res.done）：同步返回体只说明「判据通过、已下发」，
        // 每条 lane 的文件/索引落盘成败在 done 里。失败留痕，不静默。
        function _teamDoneWatch(res, action) {
            if (!res || !res.done || typeof res.done.then !== 'function') return;
            res.done.then(function (d) {
                if (!d || !d.failed || !d.failed.length) return;
                _teamToast(AEI18n.t('团队会话{action}：有 Agent 未落地（{list}）', {
                    action: action,
                    list: d.failed.map(function (f) { return (f.lane || '?') + '(' + (f.reason || 'error') + ')'; }).join('、')
                }), 'warn');
            }, function (e) {
                _teamToast(AEI18n.t('团队会话{action}：结果回执读取失败（{error}）', {
                    action: action, error: String((e && e.message) || e)
                }), 'warn');
            });
        }

        function _itemsHtml(sessions, curId) {
            // 不截断：.session-menu-list CSS 已带 max-height + overflow-y 滚动，
            // 硬上限会让 20 条之后的会话在菜单中彻底不可达
            var html = '';
            for (var i = 0; i < sessions.length; i++) {
                var s = sessions[i];
                var isCur = s.id === curId;
                html += '<div class="session-menu-item' + (isCur ? ' current' : '') + '" data-session-id="' + _escapeHtml(s.id) + '">';
                html += '<span class="session-menu-check">' + (isCur ? '✓' : '') + '</span>';
                html += '<span class="session-menu-title">' + _escapeHtml(_displayTitle(s.title)) + '</span>';
                html += '<span class="session-menu-time">' + _formatTime(s.createdAt) + '</span>';
                // 每个条目右侧的操作按钮：改名 + 删除
                html += AEI18n.html('<button class="session-menu-item-btn session-menu-item-rename" title="重命名" data-action="rename">✎</button>');
                html += AEI18n.html('<button class="session-menu-item-btn session-menu-item-delete" title="删除" data-action="delete">🗑</button>');
                html += '</div>';
            }
            if (!html && _searchText) {
                html += AEI18n.html('<div class="session-menu-empty">无匹配会话</div>');
            }
            return html;
        }

        // 菜单数据源：单 Agent / 团队两条路径的**唯一分叉点**（列表 + 当前 id）。
        // 团队模式返回的 sessions 可能为空（通道未装配）——照常出菜单（空列表），
        // 不静默回落到单 Agent 路径（那会在一条 lane 里建会话、另两条看不见）。
        // 拿不到 controller / store 时返回 null（调用方保持改动前的早返回语义）。
        function _menuData() {
            if (_isTeamMode()) {
                return { sessions: _filterSessions(_teamSessions()), curId: _teamCurrentId() };
            }
            var controller = getController();
            if (!controller) return null;
            var store = controller.getActiveStore ? controller.getActiveStore() : null;
            if (!store) return null;
            return {
                sessions: _filterSessions(store.listSessions()),
                curId: controller.getActiveCm ? controller.getActiveCm().getSessionId() : null
            };
        }

        function _buildMenuContent() {
            var data = _menuData();
            if (!data) return;

            var html = '';
            html += '<div class="session-menu-header">';
            // 搜索框与「新建会话」按钮同一行，弹性占满剩余宽度
            html += AEI18n.html('<input class="session-menu-search" id="sessionMenuSearch" type="text" placeholder="搜索会话" autocomplete="off" spellcheck="false">');
            html += AEI18n.html('<button class="session-menu-new" id="sessionMenuNew">+ 新建会话</button>');
            html += '</div>';
            html += '<div class="session-menu-sep"></div>';
            html += '<div class="session-menu-list">' + _itemsHtml(data.sessions, data.curId) + '</div>';

            _menu.innerHTML = html;
            // 整体重建（refresh 等）时保留搜索词：用 value 赋值恢复，
            // 不把用户输入拼进 HTML 属性，避免引号/转义问题
            var searchInput = _menu.querySelector('#sessionMenuSearch');
            if (searchInput && _searchText) searchInput.value = _searchText;
            _bindMenuEvents();
        }

        // 搜索词变化时仅重渲染列表区（不重建搜索输入框，保持焦点与输入状态）
        function _updateListOnly() {
            if (!_menu) return;
            var listEl = _menu.querySelector('.session-menu-list');
            if (!listEl) return;
            var data = _menuData();
            if (!data) return;
            listEl.innerHTML = _itemsHtml(data.sessions, data.curId);
            _bindItemEvents(listEl);
        }

        function _bindMenuEvents() {
            var newBtn = _menu.querySelector('#sessionMenuNew');
            if (newBtn) {
                newBtn.addEventListener('click', function (e) {
                    e.stopPropagation();
                    if (_disabled) return;
                    if (_isTeamMode()) {
                        // 团队模式：整队新建（binder 生成 team_<ts>_<rand> 并逐 lane adoptSession）
                        var binder = _binder();
                        if (!binder || typeof binder.createTeamSession !== 'function') {
                            _teamToast(_teamFailText({ reason: 'not_wired' }, AEI18n.t('新建')));
                            return;
                        }
                        var tr = null;
                        try { tr = binder.createTeamSession(); } catch (err) { tr = { ok: false, reason: 'error' }; }
                        if (tr && tr.ok === true) {
                            refresh();
                            closeMenu();
                            // 绑定换了（新建即绑定）⇒ 同一条刷新通道（见 _notifyTeamStateChanged）
                            _notifyTeamStateChanged();
                        } else {
                            // created === false：id 已发出但未绑定（binder 如实带 sid）——文案按 reason 给
                            _teamToast(_teamFailText(tr, AEI18n.t('新建')));
                        }
                        return;
                    }
                    var controller = getController();
                    if (controller) {
                        controller.createSession().then(function (r) {
                            if (r && r.ok) {
                                refresh();
                                closeMenu();
                            } else if (r && r.reason === 'busy') {
                                if (global.AEToast) global.AEToast.show(AEI18n.t('请等待当前任务完成'), 'warn');
                            } else {
                                // store 未就绪 / 索引异常等显式失败：如实提示，不静默当成功
                                //（菜单保持展开，用户可重试。没有 rejection 分支时，
                                // 异常会变成「点了新建没反应 + 控制台一条未捕获拒绝」）
                                if (global.AEToast) {
                                    global.AEToast.show(AEI18n.t('新建会话失败：{reason}', { reason: (r && r.reason) || 'unknown' }), 'error');
                                }
                            }
                        }, function (e) {
                            if (global.AEToast) {
                                global.AEToast.show(AEI18n.t('新建会话异常：{error}', { error: (e && e.message) || e }), 'error');
                            }
                        });
                    }
                });
            }

            var searchInput = _menu.querySelector('#sessionMenuSearch');
            if (searchInput) {
                searchInput.addEventListener('input', function () {
                    _searchText = this.value || '';
                    _updateListOnly();
                });
            }

            _bindItemEvents(_menu);
        }

        function _bindItemEvents(scope) {
            var items = scope.querySelectorAll('.session-menu-item');
            for (var i = 0; i < items.length; i++) {
                (function (item) {
                    // 点击条目本体（非按钮）切换会话
                    item.addEventListener('click', function (e) {
                        // 点到操作按钮则不触发切换
                        if (e.target.closest('.session-menu-item-btn')) return;
                        e.stopPropagation();
                        if (_disabled) return;
                        var sid = item.getAttribute('data-session-id');
                        if (!sid) return;
                        if (_isTeamMode()) {
                            // 团队模式：整队切换（binder：预检 → 停 → 逐 lane adoptSession → 回滚）
                            var binder = _binder();
                            if (!binder || typeof binder.switchTeamSession !== 'function') {
                                _teamToast(_teamFailText({ reason: 'not_wired' }, AEI18n.t('切换')));
                                return;
                            }
                            var tr = null;
                            try { tr = binder.switchTeamSession(sid); } catch (err) { tr = { ok: false, reason: 'error' }; }
                            if (tr && tr.ok === true) {
                                refresh();
                                closeMenu();
                                // 绑定换了 ⇒ 任务板两段（团队任务清单 / 子 AGENT）跟着重读：
                                // 这条事件通道 teamUI 已经订阅，不必（也不该）在这里另写一条刷新路径。
                                _notifyTeamStateChanged();
                            } else {
                                _teamToast(_teamFailText(tr, AEI18n.t('切换')));
                            }
                            return;
                        }
                        var controller = getController();
                        if (controller) {
                            controller.switchSession(sid).then(function (r) {
                                if (r.ok) {
                                    refresh();
                                    closeMenu();
                                } else if (r.reason === 'busy') {
                                    if (global.AEToast) global.AEToast.show(AEI18n.t('请等待当前任务完成'), 'warn');
                                }
                            });
                        }
                    });

                    // 条目内改名按钮
                    var renameBtn = item.querySelector('.session-menu-item-rename');
                    if (renameBtn) {
                        renameBtn.addEventListener('click', function (e) {
                            e.stopPropagation();
                            if (_disabled) return;
                            var sid = item.getAttribute('data-session-id');
                            _startRenameFor(sid);
                        });
                    }

                    // 条目内删除按钮
                    var deleteBtn = item.querySelector('.session-menu-item-delete');
                    if (deleteBtn) {
                        deleteBtn.addEventListener('click', function (e) {
                            e.stopPropagation();
                            if (_disabled) return;
                            var sid = item.getAttribute('data-session-id');
                            if (_isTeamMode()) {
                                // 团队模式：整队删除（binder 绕开 per-store 的 last_one——
                                // 三条 lane 同时删空仍是合法态，见 sessionBinder.js 头注「删除」）。
                                // 二次确认语义不变（与单 Agent 路径同一个 _showConfirm）。
                                var tsess = _teamSessionById(sid);
                                var ttitle = _displayTitle(tsess && tsess.title);
                                _showConfirm(AEI18n.t('确认删除'), AEI18n.t('确认要删除会话「{title}」吗？', { title: ttitle }), 'confirm').then(function (ok) {
                                    if (!ok) return;
                                    var binder = _binder();
                                    if (!binder || typeof binder.deleteTeamSession !== 'function') {
                                        _teamToast(_teamFailText({ reason: 'not_wired' }, AEI18n.t('删除')));
                                        return;
                                    }
                                    var dr = null;
                                    try { dr = binder.deleteTeamSession(sid); } catch (err) { dr = { ok: false, reason: 'error' }; }
                                    if (dr && dr.ok === true) {
                                        _teamDoneWatch(dr, AEI18n.t('删除'));
                                        refresh();
                                        // 删的可能是当前会话：binder 会先整队切到下一条（绑定换了）
                                        // ⇒ 任务板两段同款重读（同一条刷新通道）
                                        _notifyTeamStateChanged();
                                    } else {
                                        _teamToast(_teamFailText(dr, AEI18n.t('删除')));
                                        refresh();
                                    }
                                });
                                return;
                            }
                            var controller = getController();
                            if (!controller) return;
                            var store = controller.getActiveStore ? controller.getActiveStore() : null;
                            var session = store ? store.getSession(sid) : null;
                            var title = _displayTitle(session && session.title);
                            _showConfirm(AEI18n.t('确认删除'), AEI18n.t('确认要删除会话「{title}」吗？', { title: title }), 'confirm').then(function (ok) {
                                if (!ok) return;
                                controller.deleteSession(sid).then(function (r) {
                                    if (r.ok) {
                                        refresh();
                                    } else if (r.reason === 'last_one') {
                                        if (global.AEToast) global.AEToast.show(AEI18n.t('至少保留一个会话'), 'warn');
                                    } else if (r.reason === 'deleted_switch_failed') {
                                        // 会话**已删**、只是没能自动切到下一个（并发点了切换/新建，
                                        // 内部 switchSession 撞锁）。文案必须与「未删除」相反
                                        //（落到 busy 分支会对已删会话说
                                        //「未删除该会话」，而 refresh() 后菜单里它已经消失）。
                                        if (global.AEToast) global.AEToast.show(AEI18n.t('会话已删除，但未能自动切换，请手动选择一个会话'), 'warn');
                                        refresh();
                                    } else if (r.reason === 'busy') {
                                        // 文案必须如实：controller.deleteSession 在**删除动作之前**就对 busy
                                        // 返回 {ok:false}（会话一条未删），原文案却称「会话已删除」。
                                        if (global.AEToast) global.AEToast.show(AEI18n.t('当前有任务在执行，未删除该会话，请稍后再试'), 'warn');
                                        refresh();
                                    }
                                });
                            });
                        });
                    }
                })(items[i]);
            }
        }

        // 就地重命名指定会话：把条目的 title span 替换为 input
        function _startRenameFor(sessionId) {
            var _team = _isTeamMode();
            var controller = null;
            var session = null;
            if (_team) {
                // 团队模式：标题从三条 lane store 的合并清单里取（binder 的改名要求三条 lane
                // 的索引里都有这条会话，缺一条会如实报 missing——这里不预判，交给 binder 归因）
                session = _teamSessionById(sessionId);
            } else {
                controller = getController();
                if (!controller) return;
                var store = controller.getActiveStore();
                if (!store) return;
                session = store.getSession(sessionId);
            }
            if (!session) return;

            var itemEl = _menu.querySelector('.session-menu-item[data-session-id="' + sessionId + '"]');
            if (!itemEl) return;
            var titleEl = itemEl.querySelector('.session-menu-title');
            if (!titleEl) return;

            var input = document.createElement('input');
            input.type = 'text';
            input.className = 'session-menu-rename-input';
            input.value = session.title || '';
            itemEl.replaceChild(input, titleEl);

            var cancelled = false;

            function commit() {
                if (cancelled) return;
                var newTitle = input.value.trim();
                if (newTitle && newTitle !== session.title) {
                    if (_team) {
                        // 团队模式：整队改名（三条 lane 的索引一起改；缺一条如实报 missing）
                        var binder = _binder();
                        if (!binder || typeof binder.renameTeamSession !== 'function') {
                            _teamToast(_teamFailText({ reason: 'not_wired' }, AEI18n.t('重命名')));
                        } else {
                            var rr = null;
                            try { rr = binder.renameTeamSession(sessionId, newTitle); } catch (err) { rr = { ok: false, reason: 'error' }; }
                            if (rr && rr.ok === true) _teamDoneWatch(rr, AEI18n.t('重命名'));
                            else _teamToast(_teamFailText(rr, AEI18n.t('重命名')));
                        }
                    } else {
                        controller.renameSession(sessionId, newTitle);
                    }
                }
                refresh();
            }

            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); commit(); }
                else if (e.key === 'Escape') {
                    cancelled = true;
                    refresh();
                }
            });
            input.addEventListener('blur', function () {
                if (!cancelled) commit();
            });
            input.focus();
            input.select();
        }

        function mount(containerEl) {
            if (!containerEl) return;
            _container = document.createElement('div');
            _container.className = 'ae-agent-session-switcher';

            _btn = document.createElement('button');
            _btn.className = 'session-switcher-btn';
            _btn.type = 'button';

            _label = document.createElement('span');
            _label.className = 'session-switcher-label';
            _label.textContent = AEI18n.t('新会话');

            var arrow = document.createElement('span');
            arrow.className = 'session-switcher-arrow';
            arrow.textContent = '▾';

            _btn.appendChild(_label);
            _btn.appendChild(arrow);

            _menu = document.createElement('div');
            _menu.className = 'session-switcher-menu';

            // 透明背板：挂到 #agentPanel（data-module-panel），与 _container 同处
            // #moduleView 的 stacking context（.view 有 position:relative + z-index:1）。
            // 挂在 document.body 则不成：backdrop z-index:90 在根 stacking context 中，
            // 会整体覆盖 #moduleView(z-index:1) 包括 _menu（z-index:9999 被困在
            // #moduleView context 内），导致点击菜单被 backdrop 拦截而自动关闭。
            // 挂在面板内部后：_container z-index:9999 > backdrop z-index:90（同 context），
            // 菜单可正常点击；backdrop 仍以 position:fixed 覆盖整个视口拦截点击。
            _backdrop = document.createElement('div');
            _backdrop.className = 'session-switcher-backdrop';
            var hostPanel = containerEl.closest('[data-module-panel]');
            if (hostPanel) {
                hostPanel.appendChild(_backdrop);
            } else {
                document.body.appendChild(_backdrop);
            }

            _container.appendChild(_btn);
            _container.appendChild(_menu);
            containerEl.appendChild(_container);

            _btn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (_disabled) return;
                if (_isOpen) closeMenu();
                else openMenu();
            });

            // 点背板关闭菜单
            _backdrop.addEventListener('click', function (e) {
                e.stopPropagation();
                closeMenu();
            });

            _onDocClick = function (e) {
                if (_isOpen && _container && !_container.contains(e.target)) {
                    closeMenu();
                }
            };
            document.addEventListener('click', _onDocClick);
        }

        function openMenu() {
            _searchText = ''; // 每次打开菜单重置搜索词
            _buildMenuContent();
            _menu.style.display = 'block';
            _backdrop.classList.add('active');
            // 提升 _container 层级（z-index:9999），高于同 stacking context 内的 backdrop(z-index:90)
            _container.classList.add('menu-open');
            _isOpen = true;
        }

        function closeMenu() {
            _menu.style.display = 'none';
            _backdrop.classList.remove('active');
            _container.classList.remove('menu-open');
            _isOpen = false;
        }

        function refresh() {
            if (_isTeamMode()) {
                // 团队模式：当前 id 来自 binder（真相源），标题从三条 lane store 的合并清单取。
                // 通道缺席（无 binder / 无 store）时**不改标题**：编一个「新会话」会让用户以为
                // 团队会话已经建立。列表照常重建（可能为空）。
                var tcur = _teamCurrentId();
                var tsess = tcur ? _teamSessionById(tcur) : null;
                if (tsess) setTitle(tsess.title);
                else if (!tcur) setTitle(AEI18n.t('新会话'));
                if (_isOpen) _buildMenuContent();
                return;
            }
            var controller = getController();
            if (!controller) return;
            var store = controller.getActiveStore ? controller.getActiveStore() : null;
            if (!store) return;
            var curId = controller.getActiveCm ? controller.getActiveCm().getSessionId() : null;
            var session = store.getSession(curId);
            setTitle(session ? session.title : AEI18n.t('新会话'));
            if (_isOpen) _buildMenuContent();
        }

        function setTitle(title) {
            if (_label) _label.textContent = _displayTitle(title);
        }

        function disable() {
            _disabled = true;
            if (_container) _container.classList.add('disabled');
        }

        function enable() {
            _disabled = false;
            if (_container) _container.classList.remove('disabled');
        }

        // 销毁：移除 body 级 backdrop、document 级 click 监听与容器本身，
        // 防模块 unmount/remount 反复泄漏 DOM 节点与监听器
        function destroy() {
            if (_onDocClick) {
                document.removeEventListener('click', _onDocClick);
                _onDocClick = null;
            }
            if (_backdrop && _backdrop.parentNode) {
                _backdrop.parentNode.removeChild(_backdrop);
            }
            _backdrop = null;
            if (_container && _container.parentNode) {
                _container.parentNode.removeChild(_container);
            }
            _container = null;
            _btn = null;
            _label = null;
            _menu = null;
            _isOpen = false;
            _searchText = '';
        }

        return {
            mount: mount,
            refresh: refresh,
            setTitle: setTitle,
            disable: disable,
            enable: enable,
            destroy: destroy,
            isMenuOpen: function () { return _isOpen; },
            isDisabled: function () { return _disabled; },
            closeMenu: closeMenu,
            getContainer: function () { return _container; }
        };
    }

    global.AEEngine = global.AEEngine || {};
    global.AEEngine.createSessionSwitcher = createSessionSwitcher;
})(window);
