// Agent 顶栏目标条与操作浮层。
//
// 数据源唯一：当前控制器的 `controller.goal` 门面（engine/controller.js 的 api.goal）。
// 本文件只读 goal 快照、只调门面的变更方法，**不复制任何状态判据**——相位/CAS/轮次
// 的唯一实现在 engine/goalState.js。变更成功后 controller 已经落盘并派发 document 的
// `ae:goal-changed`；这里仍本地 update() 一次（同帧可见），并向外部触发
// `AEEngine.notifyGoalChanged`（若引擎提供，供其它 UI 跟进）。
//
// 生命周期：index.js 的 _ensureTopbar 建条并 mount 进 #agentCurrentModelBar
// （#aeAgentTokenStats 之前），unmount 里 destroy（节点与 document 级监听一起摘除）。
// 隐藏语义：无 goal / phase=complete / controller 尚未就绪（异步装配）时整条 [hidden]。
(function (global) {
    'use strict';

    var PHASE_ACTIVE = 'active';
    var PHASE_PAUSED = 'paused';
    var PHASE_BLOCKED = 'blocked';

    function _trim(s) { return typeof s === 'string' ? s.replace(/^\s+|\s+$/g, '') : ''; }

    // chip 的相位摘要：paused 按 pausedBy 分「已暂停/已停止」，blocked 显示原因摘要
    function _phaseText(goal) {
        if (!goal) return '';
        if (goal.phase === PHASE_PAUSED) return goal.pausedBy === 'stop' ? AEI18n.t('已停止') : AEI18n.t('已暂停');
        if (goal.phase === PHASE_BLOCKED) {
            var reason = String(goal.blockedReason ? goal.blockedReason : '');
            if (reason.length > 24) reason = reason.slice(0, 24) + '…';
            return reason ? AEI18n.t('受阻：') + reason : AEI18n.t('受阻');
        }
        if (goal.phase === PHASE_ACTIVE) return 'active';
        return String(goal.phase || '');
    }

    function _chipText(goal) {
        if (!goal) return '';
        var rounds = Number(goal.roundsStarted) || 0;
        var max = Number(goal.maxGoalRounds) || 0;
        return AEI18n.t('◎ 目标 第 {rounds}/{max} 轮 · {phase}', { rounds: rounds, max: max, phase: _phaseText(goal) });
    }

    // 浮层元信息：轮次 / 相位与来源 / 续轮开关（重载面板后 goal 仍在但 disarmed，这里明示）
    function _metaText(goal, api) {
        if (!goal) return '';
        var parts = [];
        parts.push(AEI18n.t('第 {rounds}/{max} 轮', { rounds: Number(goal.roundsStarted) || 0, max: Number(goal.maxGoalRounds) || 0 }));
        if (goal.phase === PHASE_PAUSED) {
            parts.push(goal.pausedBy === 'stop' ? AEI18n.t('已停止（被打断时自动暂停）') : AEI18n.t('已暂停'));
        } else if (goal.phase === PHASE_BLOCKED) {
            parts.push(AEI18n.t('受阻：') + (goal.blockedReason ? String(goal.blockedReason) : AEI18n.t('未说明原因')));
        } else {
            parts.push(AEI18n.t('进行中'));
        }
        var armed = true;
        if (api && typeof api.isArmed === 'function') {
            try { armed = !!api.isArmed(); } catch (_) { armed = true; }
        }
        if (goal.phase === PHASE_ACTIVE) {
            parts.push(armed ? AEI18n.t('续轮已启用') : AEI18n.t('续轮已停用（/goal resume 重新启用）'));
        }
        return parts.join(' · ');
    }

    function _errText(res) {
        if (!res) return AEI18n.t('操作失败');
        var msg = res.message ? String(res.message) : '';
        var code = res.code ? String(res.code) : '';
        if (msg && code) return msg + '（' + code + '）';
        return msg || code || AEI18n.t('操作失败');
    }

    function createGoalBar(options) {
        var opts = options || {};
        var getController = (typeof opts.getController === 'function') ? opts.getController : null;
        var doc = (typeof document !== 'undefined') ? document : null;

        var bar = null;          // span.ae-agent-goal-bar（#aeAgentGoalBar）
        var chip = null;         // button.ae-agent-goal-chip
        var pop = null;          // div.ae-agent-goal-pop
        var objectiveEl = null;  // 目标全文（white-space: pre-wrap）
        var metaEl = null;       // 轮次/相位/续轮
        var editWrap = null;     // 编辑区（textarea）
        var textarea = null;
        var actionsEl = null;
        var btnEdit = null;
        var btnSave = null;
        var btnCancel = null;
        var btnPause = null;
        var btnResume = null;
        var btnClear = null;
        var errEl = null;        // 内联错误
        var mounted = false;
        var editing = false;

        var onDocMouseDown = null;
        var onGoalChanged = null;

        function _controller() {
            if (!getController) return null;
            try { return getController() || null; } catch (_) { return null; }
        }

        function _goalApi() {
            var ctrl = _controller();
            if (!ctrl || !ctrl.goal || typeof ctrl.goal.get !== 'function') return null;
            return ctrl.goal;
        }

        // 当前应渲染的 goal：无门面/无 goal/坏数据/已完成一律 null（= 不渲染）。
        // 另外：**通道不支持目标时也不渲染**（团队执行 lane、团队主通道）——
        // 那些通道上即使会话索引里残着 goal，也不该出现一条按不动的条。
        // （单 Agent 三档 agent / script / shader 都支持目标。）
        function _goalOf(api) {
            var a = api || _goalApi();
            if (!a || typeof a.get !== 'function') return null;
            if (typeof a.supported === 'function') {
                var ok = false;
                try { ok = !!a.supported(); } catch (_) { ok = false; }
                if (!ok) return null;
            }
            var g = null;
            try { g = a.get(); } catch (_) { g = null; }
            if (!g || typeof g !== 'object') return null;
            if (g.phase === 'complete') return null;
            if (!_trim(g.objective)) return null;
            return g;
        }

        function _isArmed(api) {
            if (!api || typeof api.isArmed !== 'function') return true;
            try { return !!api.isArmed(); } catch (_) { return true; }
        }

        function _el(tag, cls, text) {
            var node = doc.createElement(tag);
            if (cls) node.className = cls;
            if (text != null) node.textContent = String(text);
            return node;
        }

        function _btn(cls, text, onClick) {
            var node = _el('button', cls, text);
            node.type = 'button';
            node.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                onClick();
            });
            return node;
        }

        function _build() {
            if (bar) return;
            bar = _el('span', 'ae-agent-goal-bar');
            bar.id = 'aeAgentGoalBar';
            bar.hidden = true;

            chip = _el('button', 'ae-agent-goal-chip');
            chip.type = 'button';
            chip.setAttribute('aria-haspopup', 'dialog');
            chip.setAttribute('aria-expanded', 'false');
            chip.addEventListener('click', function (e) {
                if (e && typeof e.stopPropagation === 'function') e.stopPropagation();
                _togglePop();
            });
            bar.appendChild(chip);

            pop = _el('div', 'ae-agent-goal-pop');
            pop.hidden = true;
            pop.setAttribute('role', 'dialog');

            objectiveEl = _el('div', 'ae-agent-goal-objective');
            pop.appendChild(objectiveEl);

            metaEl = _el('div', 'ae-agent-goal-meta');
            pop.appendChild(metaEl);

            editWrap = _el('div', 'ae-agent-goal-edit-wrap');
            editWrap.hidden = true;
            textarea = _el('textarea', 'ae-agent-goal-edit');
            textarea.setAttribute('rows', '3');
            textarea.setAttribute('placeholder', AEI18n.t('目标全文，可换行'));
            textarea.setAttribute('spellcheck', 'false');
            textarea.value = '';
            editWrap.appendChild(textarea);
            pop.appendChild(editWrap);

            actionsEl = _el('div', 'ae-agent-goal-actions');
            btnEdit = _btn('ae-agent-goal-btn', AEI18n.t('编辑'), _beginEdit);
            btnSave = _btn('ae-agent-goal-btn is-primary', AEI18n.t('保存'), _saveEdit);
            btnCancel = _btn('ae-agent-goal-btn', AEI18n.t('取消'), _cancelEdit);
            btnPause = _btn('ae-agent-goal-btn', AEI18n.t('暂停'), function () { _mutate('pause', {}); });
            btnResume = _btn('ae-agent-goal-btn', AEI18n.t('恢复'), function () { _mutate('resume', {}); });
            btnClear = _btn('ae-agent-goal-btn is-danger', AEI18n.t('清除'), _clearGoal);
            actionsEl.appendChild(btnEdit);
            actionsEl.appendChild(btnSave);
            actionsEl.appendChild(btnCancel);
            actionsEl.appendChild(btnPause);
            actionsEl.appendChild(btnResume);
            actionsEl.appendChild(btnClear);
            pop.appendChild(actionsEl);

            errEl = _el('div', 'ae-agent-goal-error');
            errEl.hidden = true;
            pop.appendChild(errEl);

            bar.appendChild(pop);
        }

        function _showError(msg) {
            if (!errEl) return;
            errEl.textContent = String(msg || AEI18n.t('操作失败'));
            errEl.hidden = false;
        }

        function _clearError() {
            if (!errEl) return;
            errEl.textContent = '';
            errEl.hidden = true;
        }

        function _renderPop(goal, api) {
            if (!pop) return;
            objectiveEl.textContent = goal.objective;
            metaEl.textContent = _metaText(goal, api);
            if (!editing) textarea.value = goal.objective;
        }

        function _syncActions(goal) {
            if (!actionsEl) return;
            var phase = goal ? goal.phase : '';
            btnEdit.hidden = editing;
            btnSave.hidden = !editing;
            btnCancel.hidden = !editing;
            btnPause.hidden = phase !== PHASE_ACTIVE;
            btnResume.hidden = !(phase === PHASE_PAUSED || phase === PHASE_BLOCKED);
            btnClear.hidden = false;
        }

        function _setOpen(open) {
            if (!pop) return;
            pop.hidden = !open;
            if (chip && typeof chip.setAttribute === 'function') {
                chip.setAttribute('aria-expanded', open ? 'true' : 'false');
            }
            if (bar && bar.classList) {
                if (open) bar.classList.add('is-open');
                else bar.classList.remove('is-open');
            }
            if (!open) {
                editing = false;
                if (editWrap) editWrap.hidden = true;
                _clearError();
            }
        }

        function _openPop() {
            var api = _goalApi();
            var goal = _goalOf(api);
            if (!goal) return;
            editing = false;
            if (editWrap) editWrap.hidden = true;
            _renderPop(goal, api);
            _syncActions(goal);
            _clearError();
            _setOpen(true);
        }

        function _closePop() {
            _setOpen(false);
        }

        function _togglePop() {
            if (!pop) return;
            if (pop.hidden) _openPop();
            else _closePop();
        }

        function _beginEdit() {
            var goal = _goalOf();
            if (!goal) return;
            editing = true;
            textarea.value = goal.objective;
            editWrap.hidden = false;
            _syncActions(goal);
            _clearError();
            if (typeof textarea.focus === 'function') {
                try { textarea.focus(); } catch (_) { /* 焦点失败不影响编辑 */ }
            }
        }

        function _cancelEdit() {
            editing = false;
            editWrap.hidden = true;
            _clearError();
            _syncActions(_goalOf());
        }

        function _notifyChanged() {
            try {
                if (global.AEEngine && typeof global.AEEngine.notifyGoalChanged === 'function') {
                    global.AEEngine.notifyGoalChanged();
                }
            } catch (_) { /* 外部通知失败不影响本地状态 */ }
        }

        function _saveEdit() {
            var api = _goalApi();
            var goal = _goalOf(api);
            if (!api || !goal) { _showError(AEI18n.t('当前没有目标')); update(); return; }
            var text = textarea ? String(textarea.value || '') : '';
            if (!_trim(text)) { _showError(AEI18n.t('目标内容不能为空')); return; }
            var res = null;
            try { res = api.edit({ ref: goal.revision, objective: text }); } catch (e) {
                _showError(AEI18n.t('操作失败：') + ((e && e.message) || e));
                return;
            }
            if (!res || !res.ok) { _showError(_errText(res)); update(); return; }
            editing = false;
            editWrap.hidden = true;
            _clearError();
            update();
            _notifyChanged();
        }

        // 变更统一入口：暂停/恢复（清除另有语义，单独处理）
        function _mutate(method, args) {
            var api = _goalApi();
            if (!api || typeof api[method] !== 'function') { _showError(AEI18n.t('目标接口不可用')); return; }
            var goal = _goalOf(api);
            if (!goal) { _showError(AEI18n.t('当前没有目标')); update(); return; }
            var payload = {};
            if (args) {
                for (var k in args) {
                    if (Object.prototype.hasOwnProperty.call(args, k)) payload[k] = args[k];
                }
            }
            payload.ref = goal.revision;   // CAS：点击这一刻的实时 revision（不用旧快照）
            if (method === 'pause') payload.pausedBy = 'human';
            var res = null;
            try { res = api[method](payload); } catch (e) {
                _showError(AEI18n.t('操作失败：') + ((e && e.message) || e));
                return;
            }
            if (!res || !res.ok) { _showError(_errText(res)); update(); return; }
            editing = false;
            if (editWrap) editWrap.hidden = true;
            _clearError();
            update();
            _notifyChanged();
        }

        function _clearGoal() {
            var api = _goalApi();
            if (!api || typeof api.clear !== 'function') { _showError(AEI18n.t('目标接口不可用')); return; }
            var res = null;
            try { res = api.clear(); } catch (e) {
                _showError(AEI18n.t('操作失败：') + ((e && e.message) || e));
                return;
            }
            if (res && res.ok === false) { _showError(_errText(res)); return; }
            _closePop();
            update();
            _notifyChanged();
        }

        function _bindDoc() {
            if (!doc) return;
            if (!onDocMouseDown) {
                // 点空白关闭：用 mousedown（先于 click，打开那一下不会自己把自己关掉）；
                // 点在条内（chip 或浮层）不关，chip 的开/关由它自己的 click 决定。
                onDocMouseDown = function (e) {
                    if (!bar || bar.hidden || !pop || pop.hidden) return;
                    var target = e && e.target;
                    if (bar.contains && bar.contains(target)) return;
                    _closePop();
                };
            }
            if (!onGoalChanged) {
                onGoalChanged = function () { update(); };
            }
            if (typeof doc.addEventListener === 'function') {
                doc.addEventListener('mousedown', onDocMouseDown, true);
                doc.addEventListener('ae:goal-changed', onGoalChanged);
            }
        }

        function _unbindDoc() {
            if (!doc || typeof doc.removeEventListener !== 'function') return;
            if (onDocMouseDown) doc.removeEventListener('mousedown', onDocMouseDown, true);
            if (onGoalChanged) doc.removeEventListener('ae:goal-changed', onGoalChanged);
        }

        function update() {
            if (!mounted || !bar) return;
            var api = _goalApi();
            var goal = _goalOf(api);
            if (!goal) {
                _closePop();
                bar.hidden = true;
                chip.textContent = '';
                chip.title = '';
                chip.className = 'ae-agent-goal-chip';
                return;
            }
            var text = _chipText(goal);
            if (chip.textContent !== text) chip.textContent = text;
            var tip = goal.objective;
            if (goal.phase === PHASE_BLOCKED && goal.blockedReason) {
                tip += AEI18n.t('\n受阻原因：') + goal.blockedReason;
            }
            if (chip.title !== tip) chip.title = tip;
            var cls = 'ae-agent-goal-chip is-' + goal.phase;
            if (goal.phase === PHASE_ACTIVE && !_isArmed(api)) cls += ' is-disarmed';
            if (chip.className !== cls) chip.className = cls;
            bar.hidden = false;
            if (!pop.hidden) {
                _renderPop(goal, api);
                _syncActions(goal);
            }
        }

        function mount(parentEl, beforeEl) {
            if (!doc || !parentEl || typeof parentEl.insertBefore !== 'function') return false;
            _build();
            if (beforeEl && beforeEl !== bar && beforeEl.parentNode === parentEl) {
                parentEl.insertBefore(bar, beforeEl);
            } else {
                parentEl.appendChild(bar);
            }
            if (!mounted) {
                mounted = true;
                _bindDoc();
            }
            update();
            return true;
        }

        function destroy() {
            if (!bar) return;
            _unbindDoc();
            _closePop();
            if (bar.parentNode) bar.parentNode.removeChild(bar);
            bar = null;
            chip = null;
            pop = null;
            objectiveEl = null;
            metaEl = null;
            editWrap = null;
            textarea = null;
            actionsEl = null;
            btnEdit = null;
            btnSave = null;
            btnCancel = null;
            btnPause = null;
            btnResume = null;
            btnClear = null;
            errEl = null;
            onDocMouseDown = null;
            onGoalChanged = null;
            mounted = false;
            editing = false;
        }

        function getNode() { return bar; }

        return {
            mount: mount,
            update: update,
            destroy: destroy,
            getNode: getNode
        };
    }

    global.AEAgentGoalBar = { createGoalBar: createGoalBar };
})(typeof window !== 'undefined' ? window : globalThis);
