// 工具可见性设置子面板
//
// 入口：设置页折叠段「工具可见性」的「工具可见性…」按钮（app/settings.js 的
// buildLlmSettingsHtml 渲染入口段、openSettingsModal 绑定按钮）。
//
// 结构（复用 showGateConfigModal 的写法，不新造框架）：
//   .modal-mask / .modal → modal-head + modal-body（页签 / 工具条 / 分组卡）+ 底栏；
//   页签视觉复用 .ext-tabs/.ext-tab，分组卡复用 .ext-settings-group/.ext-settings-group-head/
//   .ext-tool-list/.ext-tool-chip，本面板只新增 .tv-locked（灰显行）/ .tv-badge（状态徽标）。
//
// 数据源（不得自建第二份名单）：
//   · 视图集合 = gate.views()；页签名：固定三档用显示名，lane 取 lanes.get(id).label；
//   · 行集与四态（默认可见 / 锁定 / 停用 / 当前有效）= gate.entriesFor(view)；
//   · 灰显原因 = entry.lockedReason（完整原因）/ entry.lockedShort（徽标短句），均取自闸口
//     分类表；两个字段都是 zh-CN 源文，本面板只翻译、不重写判定、不解析文案。
//
// 闸口实例：用**同一个** createToolVisibility 工厂建一份「设置面」实例，getSettings 返回
// 面板草稿——entriesFor(view).reason 因此能反映草稿态（USER_DISABLED / 放宽后 null /
// DEPENDENCY_HIDDEN），行集与默认判定仍由闸口 _decide 算，面板只读消费、不复制判定。
// 面板关闭时 _state 置空，草稿对象不再被任何运行期持有；生产闸口（bootstrap 注入的
// 每 runtime 实例）不受本面板影响。
//
// 保存语义：页签切换 / 搜索 / 勾选 / 恢复默认都只改内存草稿；「确定」把归一后的
// JSON 写回设置页隐藏输入 #toolVisibilityInput（草稿载体），「取消」/×/Esc 丢弃；落盘仍由
// 设置页「保存模块设置」完成——运行中的工具面只认已保存设置。
(function (global) {
    'use strict';

    var MODAL_ID = 'toolVisibilityModal';
    var INPUT_ID = 'toolVisibilityInput';

    // 固定三档的显示名。**视图 id 集合不在这里维护**：页签列表取 gate.views()。
    var FIXED_LABELS = { agent: 'Agent', script: 'Script', shader: 'Shader' };

    // 分组顺序与显示名。只决定「怎么显示」，不决定「有哪些工具」：
    // 行集始终来自 gate.entriesFor(view)；注册表出现未知 source 时按 source 原字面追加在
    // 已列来源之后，空 source 归「未分组」，不另维护第二份来源名单。
    // onlyViews（可选）：该分组只在列出的视图页签里显示，其它视图整组不渲染。面板主题只放
    // Agent 模式——闸口分类表已把 panel_theme 锁在 Agent（其它视图不可
    // 启用），这里只是让它在别的页签里不占位置；判定仍由闸口，不构成第二套可见性真相。
    var SOURCE_GROUPS = [
        { key: 'ae-tools', get label() { return AEI18n.t('AE 工具'); } },
        { key: 'agent', get label() { return AEI18n.t('Agent 引擎'); } },
        { key: 'comfyui', label: 'ComfyUI' },
        { key: 'memory', get label() { return AEI18n.t('记忆'); } },
        { key: 'platform', get label() { return AEI18n.t('平台'); } },
        { key: 'skill-manager', get label() { return AEI18n.t('技能'); } },
        { key: 'mcp', label: 'MCP' },
        { key: 'assets', get label() { return AEI18n.t('素材库'); } },
        { key: 'panel-theme', get label() { return AEI18n.t('面板主题'); }, onlyViews: ['agent'] },
        { key: 'team', get label() { return AEI18n.t('团队'); } }
    ];
    // 空 source 的组名是**源文**：渲染点写成 AEI18n.t('未分组') 字面量（key 提取只认字面量实参），
    // 取值时再翻，避免模块加载期把语言冻住。

    // 只在部分视图显示的分组来源 → 允许显示的视图 id 列表（由 SOURCE_GROUPS 派生一次）。
    var _onlyViewsMap = null;
    function _onlyViewsOf() {
        if (_onlyViewsMap) return _onlyViewsMap;
        _onlyViewsMap = Object.create(null);
        for (var i = 0; i < SOURCE_GROUPS.length; i++) {
            if (SOURCE_GROUPS[i].onlyViews) _onlyViewsMap[SOURCE_GROUPS[i].key] = SOURCE_GROUPS[i].onlyViews;
        }
        return _onlyViewsMap;
    }

    // 本视图可见的行集：按来源剔除「只属于别的视图」的分组。分组/统计/上限提示共用这份清单，
    // 保证「组头数字 / 默认 N · 已启用 N / 上方行数」三处口径一致。
    function _visibleList(viewId, list) {
        var all = Array.isArray(list) ? list : [];
        var only = _onlyViewsOf();
        var keys = Object.keys(only);
        if (!keys.length) return all;
        var out = [];
        for (var i = 0; i < all.length; i++) {
            var allowed = only[String(all[i].source || '')];
            if (allowed && allowed.indexOf(viewId) < 0) continue;
            out.push(all[i]);
        }
        return out;
    }

    // 本视图被 onlyViews 隐藏来源的工具名集合（null = 无或索引尚未建好）。改动指示
    // （页签点/「改动 N 项」/底部「有未保存的修改」）必须忽略这些名字：旧配置可能在别的视图
    // enabled/disabled 过隐藏来源的工具（如 Script 页的 panel_theme），面板不显示该组 ⇒ 用户
    // 无法通过可见行消除差异，三处指示会显示「改了 N 项」却找不到可改的行。
    // 索引从**本视图渲染时已有的全量条目**派生（entriesFor 返回全注册表条目，名字/source 跨视图
    // 相同），不额外取注册表——保持「一次渲染只取一次 entries」的 O(n) 契约；判定仍由闸口负责
    // （分类表锁先于用户 enabled），这里只统一「改动」口径。
    var _hiddenNameIndex = null;    // { name: allowedViews[] }（只含 onlyViews 受限来源的工具）
    function _refreshHiddenNameIndex(list) {
        var only = _onlyViewsOf();
        var keys = Object.keys(only);
        if (!keys.length) { _hiddenNameIndex = null; return; }
        var index = Object.create(null);
        var has = false;
        var all = Array.isArray(list) ? list : [];
        for (var i = 0; i < all.length; i++) {
            var allowed = only[String(all[i].source || '')];
            if (!allowed) continue;
            index[all[i].name] = allowed;
            has = true;
        }
        _hiddenNameIndex = has ? index : null;
    }
    function _hiddenNameSet(viewId) {
        var index = _hiddenNameIndex;
        if (!index) return null;
        var set = null;
        for (var name in index) {
            if (!Object.prototype.hasOwnProperty.call(index, name)) continue;
            if (index[name].indexOf(viewId) < 0) {
                if (!set) set = Object.create(null);
                set[name] = true;
            }
        }
        return set;
    }

    // 当前打开的配置面状态（关闭即置 null，草稿不留在运行期）：
    //   { gate, draft, baseline, views, viewId, search, descCache }
    var _state = null;
    var _escHandler = null;
    // 本视图条目的单次渲染缓存：entriesFor(view) 每次调用都会遍历
    // 全注册表，逐行 `_entryByName` 再各调一次就是 O(n²)。渲染开始时取一次、建 name→entry
    // map，`_groups/_stats/_bindPaneEvents/行点击` 全部复用；视图切换/重绘时失效。
    var _entryCache = null;   // { viewId, list, byName }

    // ── 基础工具 ────────────────────────────────────────────────────────────────
    // 描述里的中文才需要译文；非中文描述（如 MCP 服务器给的英文文案）原样显示。
    var CJK = /[\u3400-\u4dbf\u4e00-\u9fff]/;

    function esc(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function _toast(msg, type) {
        try {
            if (global.AEToast && typeof global.AEToast.show === 'function') {
                global.AEToast.show(String(msg), type || 'info');
                return;
            }
        } catch (_) { /* toast 缺席不影响面板功能 */ }
        try { console.warn('[ToolVisibilityPanel] ' + msg); } catch (_) {}
    }

    // 归一：真源 = engine/settings.js 的 normalizeToolVisibility（唯一实现）。
    // 引擎未装配（测试桩/极早窗口）时原样清洗到可用结构，不在这里复制归一判据。
    function _normToolVisibility(v) {
        var engineFn = null;
        try {
            engineFn = (global.AEEngine && global.AEEngine.settings
                && global.AEEngine.settings.normalizeToolVisibility) || null;
        } catch (_) { engineFn = null; }
        if (typeof engineFn === 'function') {
            try { return engineFn(v); } catch (_) { /* 回落下面的结构清洗 */ }
        }
        return (v && typeof v === 'object' && !Array.isArray(v))
            ? { version: 1, views: (v.views && typeof v.views === 'object') ? v.views : {} }
            : { version: 1, views: {} };
    }

    // 设置页隐藏输入里当前携带的草稿（打开面板时读一次；面板编辑期内不再回读）。
    function _readDraftFromHiddenInput() {
        var el = document.getElementById(INPUT_ID);
        if (!el || el.value === undefined || el.value === null || el.value === '') {
            return { version: 1, views: {} };
        }
        var parsed = null;
        try { parsed = JSON.parse(el.value); } catch (_) { parsed = null; }
        return _normToolVisibility(parsed);
    }

    // 团队开关：优先引擎/UI 的实时态（切档窗口里 cachedSettings 可能落后），
    // 其次按已保存设置的 runtimeMode / team.enabled 判断。只用于 agent 视图默认面
    // 是否剔除 source==='team'（defaultVisible 的语义）。
    function _isTeamMode() {
        try {
            if (global.AEAgentTeamUI && typeof global.AEAgentTeamUI.isTeamModeOn === 'function') {
                return !!global.AEAgentTeamUI.isTeamModeOn();
            }
        } catch (_) { /* 回落设置判断 */ }
        var cs = (typeof cachedSettings !== 'undefined' && cachedSettings) ? cachedSettings : null;
        if (cs && cs.runtimeMode === 'team') return true;
        return !!(cs && cs.team && cs.team.enabled === true);
    }

    function _lanes() {
        try { return (global.AEAgentTeam && global.AEAgentTeam.lanes) || null; } catch (_) { return null; }
    }

    // 工具上限（已保存设置；子面板不编辑它，上限提示只读）：0 = 不限制。
    function _llmLimit() {
        var cs = (typeof cachedSettings !== 'undefined' && cachedSettings) ? cachedSettings : null;
        var n = cs ? Number(cs.maxLlmStubTools) : NaN;
        return (isFinite(n) && n > 0) ? Math.floor(n) : 0;
    }

    // 本视图「非核心启用数」（用于上限提示）：核心工具不占名额。
    // CORE_TOOL_NAMES 只住在注册表内部，公开面暂无 isCoreTool；有该 getter 时精确，
    // 没有时退化为「本视图 checked 条目数」= 上界（核心 ≤ 15 件，仅可能在 limit~limit+15
    // 区间误报）——上限提示宁多不漏，不因此阻止任何操作。
    function _nonCoreEnabledCount(viewId, list) {
        var reg = null;
        try { reg = (global.AE_LLM && global.AE_LLM.toolRegistry) || null; } catch (_) { reg = null; }
        var isCore = (reg && typeof reg.isCoreTool === 'function') ? reg.isCoreTool : null;
        var n = 0;
        for (var i = 0; i < list.length; i++) {
            if (!_isChecked(viewId, list[i])) continue;
            if (isCore && isCore(list[i].name) === true) continue;
            n++;
        }
        return n;
    }

    // 设置面闸口实例：同一工厂 + 同一份 lane 收窄判据（lanes.get(id).filter 同一个函数对象，
    // 与 bootstrap._mkRuntimeToolVisibility 同源）。getSettings 返回面板草稿，故条目状态随草稿现算。
    function _createGate() {
        var factory = (global.AE_LLM && global.AE_LLM.createToolVisibility) || null;
        if (typeof factory !== 'function') return null;
        return factory({
            getRegistry: function () {
                return (global.AE_LLM && global.AE_LLM.toolRegistry) || null;
            },
            getSettings: function () {
                return _state ? { toolVisibility: _state.draft } : null;
            },
            getLanes: function () { return _lanes(); },
            getLaneFilter: function (viewId) {
                var lanes = _lanes();
                var def = (lanes && typeof lanes.get === 'function') ? lanes.get(viewId) : null;
                return (def && typeof def.filter === 'function') ? def.filter : null;
            },
            isTeamMode: function () { return _isTeamMode(); }
        });
    }

    // 页签显示名：固定三档取显示名；lane 取 lanes.get(id).label（团队未开也可配置）。
    function _viewLabel(viewId) {
        if (FIXED_LABELS[viewId]) return FIXED_LABELS[viewId];
        var def = null;
        try {
            var lanes = _lanes();
            if (lanes && typeof lanes.get === 'function') def = lanes.get(viewId);
        } catch (_) { def = null; }
        if (def && def.label) return AEI18n.t('团队 · {name}', { name: def.label });
        return viewId;
    }

    // 描述（hover 用）：行集/状态的真源仍是 gate.entriesFor；闸口条目不带描述，这里只做
    // **只读补充**——registry.get(name) 的 buildDescription（按本视图身份首项现生成）或
    // shortDescription/description。取不到就不显示描述（不伪造）。
    // 契约：只显示已有译文的描述。描述是模型侧 zh-CN 文案，非源语言界面下 t() 未命中
    // 就返回空串（该行不设 title），避免英文界面 hover 出现中文。非中文描述原样显示。
    function _displayDescription(text) {
        var s = String(text == null ? '' : text);
        if (!s || !CJK.test(s)) return s;
        var out = AEI18n.t(s);
        if (out !== s) return out;
        var src = AEI18n.SOURCE_LOCALE || 'zh-CN';
        var cur = (typeof AEI18n.getLocale === 'function') ? AEI18n.getLocale() : src;
        return cur === src ? s : '';
    }

    function _descriptionOf(viewId, name) {
        var reg = null;
        try { reg = (global.AE_LLM && global.AE_LLM.toolRegistry) || null; } catch (_) { reg = null; }
        if (!reg || typeof reg.get !== 'function') return '';
        var entry = null;
        try { entry = reg.get(name); } catch (_) { entry = null; }
        if (!entry) return '';
        var cacheKey = viewId + '\u0000' + name;
        if (_state && _state.descCache && Object.prototype.hasOwnProperty.call(_state.descCache, cacheKey)) {
            return _state.descCache[cacheKey];
        }
        var text = '';
        if (typeof entry.buildDescription === 'function') {
            try {
                var ids = _state && _state.gate ? (_state.gate.identityOf(viewId).moduleIds || []) : [];
                text = entry.buildDescription(ids.length ? ids[0] : '') || '';
            } catch (_) { text = ''; }
        }
        if (!text) text = String(entry.shortDescription || entry.description || '');
        text = _displayDescription(text);
        if (_state && _state.descCache) _state.descCache[cacheKey] = text;
        return text;
    }

    // ── 草稿读写 ────────────────────────────────────────────────────────────────
    function _seg(viewId) {
        var views = _state.draft.views || (_state.draft.views = {});
        var seg = views[viewId];
        if (!seg || typeof seg !== 'object') {
            seg = { disabled: [], enabled: [] };
            views[viewId] = seg;
        }
        if (!Array.isArray(seg.disabled)) seg.disabled = [];
        if (!Array.isArray(seg.enabled)) seg.enabled = [];
        return seg;
    }

    function _segReadOnly(viewId) {
        var views = _state.draft.views || {};
        var seg = views[viewId];
        if (!seg || typeof seg !== 'object') return { disabled: [], enabled: [] };
        return {
            disabled: Array.isArray(seg.disabled) ? seg.disabled : [],
            enabled: Array.isArray(seg.enabled) ? seg.enabled : []
        };
    }

    function _has(arr, name) { return arr.indexOf(name) >= 0; }
    function _remove(arr, name) {
        var i = arr.indexOf(name);
        if (i >= 0) arr.splice(i, 1);
    }

    // 勾选语义：勾上 = 本视图可见（必要时写 enabled）；取消 = 不可见（必要时写
    // disabled）；与默认一致时删除对应键（不落重复配置）。锁定/停用行不参与。
    function _setChecked(viewId, entry, checked) {
        if (!entry || entry.locked || entry.disabled) return;
        var seg = _seg(viewId);
        _remove(seg.disabled, entry.name);
        _remove(seg.enabled, entry.name);
        if (checked) {
            if (!entry.defaultVisible) seg.enabled.push(entry.name);
        } else if (entry.defaultVisible) {
            seg.disabled.push(entry.name);
        }
        _pruneEmptyView(viewId);
    }

    function _pruneEmptyView(viewId) {
        var views = _state.draft.views || {};
        var seg = views[viewId];
        if (!seg || typeof seg !== 'object') return;
        if ((!seg.disabled || !seg.disabled.length) && (!seg.enabled || !seg.enabled.length)) {
            delete views[viewId];
        }
    }

    function _isChecked(viewId, entry) {
        if (!entry || entry.disabled || entry.locked) return false;
        var seg = _segReadOnly(viewId);
        if (_has(seg.disabled, entry.name)) return false;
        if (_has(seg.enabled, entry.name)) return true;
        return !!entry.defaultVisible;
    }

    function _badgeOf(viewId, entry) {
        if (entry.disabled) return AEI18n.t('已停用');
        if (entry.locked) return _lockedBadge(entry);
        var seg = _segReadOnly(viewId);
        if (_has(seg.disabled, entry.name)) return AEI18n.t('已关闭');
        if (_has(seg.enabled, entry.name) && !entry.defaultVisible) return AEI18n.t('已放宽');
        return entry.defaultVisible ? AEI18n.t('默认可见') : AEI18n.t('默认不可见');
    }

    // 徽标的视觉档位（只管颜色，不改文案）：widen=放宽（强调）、off=用户关闭（危险色）、
    // locked=锁定/停用（灰）、muted=与默认一致（右列弱化，让异常状态先跳出来）。
    function _badgeKind(viewId, entry) {
        if (entry.disabled) return 'locked';
        if (entry.locked) return 'locked';
        var seg = _segReadOnly(viewId);
        if (_has(seg.disabled, entry.name)) return 'off';
        if (_has(seg.enabled, entry.name) && !entry.defaultVisible) return 'widen';
        return 'muted';
    }

    // 锁定原因文案 → 短徽标：分类表同时给完整原因（lockedReason，进 title 与提示）与短句
    // （lockedShort，进徽标）。两者都是 zh-CN 源文，这里只过 AEI18n.t 取当前语言，
    // 不按中文形态切片或正则捕获（翻译后形态不同，切片会失效）。
    function _lockedBadge(entry) {
        var short = entry && entry.lockedShort;
        return short ? AEI18n.t(short) : AEI18n.t('仅特定视图可用');
    }

    function _lockedReasonText(entry) {
        var reason = entry && entry.lockedReason;
        return reason ? AEI18n.t(reason) : AEI18n.t('该工具在其它视图不可用');
    }

    function _titleOf(viewId, entry) {
        var parts = [];
        if (entry.locked) {
            parts.push(_lockedReasonText(entry));
        } else if (entry.disabled) {
            parts.push(AEI18n.t('该工具已在注册表全局停用'));
        } else if (entry.reason === 'USER_DISABLED') {
            parts.push(AEI18n.t('已在本视图关闭'));
        } else if (entry.reason === 'DEPENDENCY_HIDDEN') {
            parts.push(AEI18n.t('因本视图 tool_search 已关闭，stub 工具不会注入；重新开启 tool_search 后恢复'));
        }
        var desc = _descriptionOf(viewId, entry.name);
        var base = entry.name + (desc ? AEI18n.punct('：', ': ') + desc : '');
        return parts.length
            ? (base + AEI18n.punct('（', ' (') + parts.join(AEI18n.punct('；', '; ', '、')) + AEI18n.punct('）', ')'))
            : base;
    }

    // ── 条目与分组 ──────────────────────────────────────────────────────────────
    // entriesFor(view) 的**唯一**取用点（每次调用遍历全注册表）。`_viewEntries` 每次渲染只让
    // 它跑一次并建 name→entry map；分组/统计/行事件/行点击全部复用缓存。
    function _entries(viewId) {
        if (!_state || !_state.gate) return [];
        try {
            var list = _state.gate.entriesFor(viewId);
            return Array.isArray(list) ? list : [];
        } catch (_) { return []; }
    }

    function _viewEntries(viewId) {
        if (_entryCache && _entryCache.viewId === viewId) return _entryCache;
        var list = _entries(viewId);
        var byName = Object.create(null);
        for (var i = 0; i < list.length; i++) byName[list[i].name] = list[i];
        _entryCache = { viewId: viewId, list: list, byName: byName };
        return _entryCache;
    }

    function _entryByName(viewId, name) {
        var cache = _viewEntries(viewId);
        return cache.byName[name] || null;
    }

    function _matchSearch(viewId, entry) {
        var q = String(_state.search || '').replace(/^\s+|\s+$/g, '').toLowerCase();
        if (!q) return true;
        if (String(entry.name).toLowerCase().indexOf(q) >= 0) return true;
        var desc = _descriptionOf(viewId, entry.name).toLowerCase();
        return desc.indexOf(q) >= 0;
    }

    // 组清单：已知来源按 SOURCE_GROUPS 顺序，未知来源按出现顺序追加，空 source 最后。
    // 组内成员 = 本视图条目里 source 相同、且命中当前搜索的行（成员数随搜索变化）——
    // 组级全开/全关用的也是这同一份过滤集，行为与组头数字一致。
    function _groups(viewId, list) {
        var all = Array.isArray(list) ? list : _viewEntries(viewId).list;
        var bySource = Object.create(null);
        var unknownOrder = [];
        for (var i = 0; i < all.length; i++) {
            var entry = all[i];
            if (!_matchSearch(viewId, entry)) continue;
            var src = String(entry.source || '');
            if (!bySource[src]) { bySource[src] = []; if (src) unknownOrder.push(src); }
            bySource[src].push(entry);
        }
        var out = [];
        var knownSeen = Object.create(null);
        for (var g = 0; g < SOURCE_GROUPS.length; g++) {
            var def = SOURCE_GROUPS[g];
            knownSeen[def.key] = true;
            if (bySource[def.key] && bySource[def.key].length) {
                out.push({ source: def.key, label: def.label, entries: bySource[def.key] });
            }
        }
        var extras = [];
        for (var u = 0; u < unknownOrder.length; u++) {
            var key = unknownOrder[u];
            if (knownSeen[key]) continue;
            if (bySource[key] && bySource[key].length) {
                extras.push({ source: key, label: key, entries: bySource[key] });
            }
        }
        extras.sort(function (a, b) { return a.source < b.source ? -1 : (a.source > b.source ? 1 : 0); });
        out = out.concat(extras);
        if (bySource[''] && bySource[''].length) {
            out.push({ source: '', label: AEI18n.t('未分组'), entries: bySource[''] });
        }
        return out;
    }

    function _stats(viewId, list) {
        var all = Array.isArray(list) ? list : _viewEntries(viewId).list;
        var defaultCount = 0;
        var enabledCount = 0;
        for (var i = 0; i < all.length; i++) {
            // 「默认 N」= 出厂默认可见的条目数（全局停用的不参与——它们不会注入）
            if (all[i].defaultVisible && !all[i].disabled) defaultCount++;
            if (_isChecked(viewId, all[i])) enabledCount++;
        }
        return { defaultCount: defaultCount, enabledCount: enabledCount };
    }

    // ── DOM 构建 ────────────────────────────────────────────────────────────────
    function _buildDom() {
        var existing = document.getElementById(MODAL_ID);
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        // 布局（样式见 agent.css 的 .tv-panel 段）：
        //   头（标题 + 关闭）→ 说明 → 吸顶区（页签 / 搜索工具条 / 上限提示）→ 工具清单（分组可折叠）
        //   → 底栏（恢复全部默认 + 未保存提示 + 取消 / 确定）。
        // .modal-body 全局是 flex column + overflow-y:auto：子项默认 flex-shrink:1，
        // 内容超高时会被压缩而不是出滚动条，故说明/吸顶区/清单一律显式 flex-shrink:0
        // （与 gate-config-modal 的 details 修复同一成因；样式里统一给，不再逐处内联）。
        var html = AEI18n.html('<div class="modal-head"><span>工具可见性</span><button class="icon-btn" id="tvCloseBtn" type="button">关闭</button></div><div class="modal-body" id="tvBody"><div class="st-field-hint tv-note">放宽只影响本视图能否看到与调用；工具的权限档、能力域与执行链不变。锁定工具不能跨视图启用。</div><div class="tv-sticky"><div class="ext-tabs" id="tvTabs" role="tablist"></div><div class="tv-toolbar"><input type="search" id="tvSearch" class="tv-search" placeholder="搜索工具名 / 描述" autocomplete="off"><span class="tv-stats" id="tvStats"></span><span class="tv-changes" id="tvChangeCount" hidden></span><button class="tv-quiet-btn" id="tvResetViewBtn" type="button">恢复默认</button></div><div class="st-field-hint tv-limit-hint" id="tvLimitHint" hidden>超出工具上限，部分工具本轮不会注入（仍可经 tool_search 取回）</div></div><div id="tvViewPane" role="tabpanel"></div></div><div class="gate-config-footer tv-footer"><button class="tv-quiet-btn" id="tvResetAllBtn" type="button">恢复全部默认</button><span class="gate-config-dirty-hint" id="tvDirtyHint" hidden>有未保存的修改</span><div class="gate-config-footer-btns"><button class="btn secondary" id="tvCancelBtn" type="button">取消</button><button class="btn run" id="tvConfirmBtn" type="button">确定</button></div></div>');

        var overlay = document.createElement('div');
        overlay.className = 'modal-mask';
        overlay.id = MODAL_ID;
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.style.zIndex = '110';

        var box = document.createElement('div');
        box.className = 'modal tv-panel';
        box.style.opacity = '1';
        box.style.transform = 'none';
        box.innerHTML = html;

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function on(id, type, fn) {
            var el = document.getElementById(id);
            if (el && typeof el.addEventListener === 'function') el.addEventListener(type, fn);
        }
        on('tvCloseBtn', 'click', _close);
        on('tvCancelBtn', 'click', _close);
        on('tvConfirmBtn', 'click', _confirm);
        on('tvResetAllBtn', 'click', function () {
            _state.draft = { version: 1, views: {} };
            _state.descCache = Object.create(null);
            _renderAll();
        });
        on('tvResetViewBtn', 'click', function () {
            _resetView(_state.viewId);
        });
        on('tvSearch', 'input', function () {
            var el = document.getElementById('tvSearch');
            _state.search = el ? String(el.value || '') : '';
            _renderPane();
        });

        _escHandler = function (e) {
            if (!e) return;
            if (e.key !== 'Escape' && e.keyCode !== 27) return;
            // 顶层确认弹窗在场时让位（同 showGateConfigModal 写法）
            var cm = document.getElementById('confirmModal');
            if (cm && cm.style && cm.style.display === 'flex') return;
            _close();
        };
        document.addEventListener('keydown', _escHandler);
    }

    function _renderTabs() {
        var tabs = document.getElementById('tvTabs');
        if (!tabs) return;
        var html = '';
        for (var i = 0; i < _state.views.length; i++) {
            var id = _state.views[i];
            var active = (id === _state.viewId);
            // 本视图草稿与打开时基线不同 ⇒ 页签加一点提示，
            // 七个视图之间切来切去时能看出哪些视图被改过。点自身无文本，不影响页签名。
            html += '<button type="button" class="ext-tab' + (active ? ' active' : '') + '" '
                + 'role="tab" aria-selected="' + (active ? 'true' : 'false') + '" '
                + 'data-view="' + esc(id) + '">'
                + esc(_viewLabel(id))
                + (_viewDirty(id) ? '<span class="tv-tab-dot" aria-hidden="true"></span>' : '')
                + '</button>';
        }
        tabs.innerHTML = html;
        if (typeof tabs.querySelectorAll !== 'function') return;
        var btns = tabs.querySelectorAll('[data-view]');
        for (var b = 0; b < btns.length; b++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var viewId = btn.getAttribute('data-view');
                    if (!viewId || viewId === _state.viewId) return;
                    _state.viewId = viewId;
                    _renderTabs();
                    _renderPane();
                });
            })(btns[b]);
        }
    }

    // 内容区：按 source 分组卡 + 逐工具行。所有动态字符串（工具名/描述/分组名/原因）
    // 一律经 esc 后进 innerHTML / 属性位（MCP 工具描述来自外部服务器，不可信）。
    //
    // 行式清单：每行 = 复选框 + 工具名（占满）+ 状态徽标（右对齐成列）；
    // 分组头 = 折叠箭头 + 组名 + 启用分数 + 成员数 + 全开/全关（轻量文字钮）。行上的
    // data-* 钩子与类名（.tv-badge / .tv-locked / .ext-group-* ）保持原契约，子面板单测按此取节点。
    function _renderPane() {
        var pane = document.getElementById('tvViewPane');
        if (!pane) return;
        var viewId = _state.viewId;
        // 本次渲染的条目只从闸口取一次（O(n)）；后续分组/统计/行事件都复用同一 list + map。
        _entryCache = null;
        // 只在指定视图提供的分组（SOURCE_GROUPS 的 onlyViews）：在渲染入口按来源剔除，
        // 后续分组/统计/上限提示都用这份过滤后清单（三处数字口径一致）。
        var _allForView = _viewEntries(viewId).list;
        _refreshHiddenNameIndex(_allForView);
        var list = _visibleList(viewId, _allForView);
        var groups = _groups(viewId, list);
        var collapsed = _collapsedOf(viewId);
        var searching = !!String(_state.search || '').replace(/^\s+|\s+$/g, '');
        var seg = _segReadOnly(viewId);
        var html = '';
        for (var g = 0; g < groups.length; g++) {
            var group = groups[g];
            var srcKey = String(group.source || '');
            // 搜索命中时无视折叠记忆：折叠组里的命中结果也必须可见（否则搜完像是没找到）
            var isCollapsed = !searching && collapsed[srcKey] === true;
            var entries = group.entries;
            var onCount = 0;
            var changed = false;
            for (var c = 0; c < entries.length; c++) {
                if (_isChecked(viewId, entries[c])) onCount++;
                if (!changed && (_has(seg.disabled, entries[c].name) || _has(seg.enabled, entries[c].name))) {
                    changed = true;
                }
            }
            html += '<div class="ext-settings-group tv-group' + (isCollapsed ? ' tv-collapsed' : '')
                + (changed ? ' tv-group--changed' : '') + '" data-source="' + esc(srcKey) + '">'
                + '<div class="ext-settings-group-head tv-group-head">'
                + '<button class="tv-group-toggle" type="button" data-group-toggle="' + esc(srcKey) + '" '
                + 'aria-expanded="' + (isCollapsed ? 'false' : 'true') + '" '
                + 'aria-label="' + esc((searching ? AEI18n.t('搜索中不可折叠') + AEI18n.punct('：', ': ')
                    : (isCollapsed ? AEI18n.t('展开分组') + AEI18n.punct('：', ': ')
                        : AEI18n.t('收起分组') + AEI18n.punct('：', ': '))) + group.label) + '" '
                // 搜索时分组被强制展开，折叠箭头一并禁用（否则点了界面没反应，清空搜索又突变）
                + (searching ? 'disabled ' : '')
                + 'title="' + (searching ? AEI18n.t('搜索中不可折叠分组')
                    : (isCollapsed ? AEI18n.t('展开分组') : AEI18n.t('收起分组'))) + '">'
                + '<span class="tv-chevron"></span></button>'
                + '<span class="ext-group-name">' + esc(group.label) + '</span>'
                // 组内启用数只在「没全开」时出现，全开时不显示（默认面貌不吵）
                + (onCount === entries.length ? ''
                    : '<span class="tv-group-enabled">' + onCount + '/' + entries.length + AEI18n.html(' 启用</span>'))
                + '<span class="ext-group-tag">' + entries.length + AEI18n.html(' 个工具</span>')
                + '<div class="tv-group-actions">'
                + '<button class="tv-mini" type="button" data-group-all="on" data-group-source="'
                + esc(srcKey) + '">' + AEI18n.t('全开') + '</button>'
                + '<button class="tv-mini" type="button" data-group-all="off" data-group-source="'
                + esc(srcKey) + '">' + AEI18n.t('全关') + '</button>'
                + '</div></div>'
                + '<div class="ext-tool-list tv-list">';
            for (var r = 0; r < entries.length; r++) {
                var entry = entries[r];
                var locked = entry.locked === true;
                var disabled = entry.disabled === true;
                var checked = _isChecked(viewId, entry);
                var rowTitle = _titleOf(viewId, entry);
                var kind = _badgeKind(viewId, entry);
                // 灰显行（.tv-locked）：锁定工具，或依赖联动下被隐藏的 stub 行
                //（tool_search 关闭 → DEPENDENCY_HIDDEN，仅灰显 + title 给原因，不禁止勾选）。
                var gray = locked || disabled || entry.reason === 'DEPENDENCY_HIDDEN';
                html += '<label class="ext-tool-chip tv-row'
                    + (gray ? ' tv-locked' : '')
                    + (kind === 'widen' ? ' tv-row--widen' : '')
                    + (kind === 'off' ? ' tv-row--off' : '')
                    + (checked ? ' is-on' : '')
                    + '" data-tool-name="' + esc(entry.name) + '" title="' + esc(rowTitle) + '">'
                    + '<input type="checkbox" class="switch-input" data-tool="' + esc(entry.name) + '"'
                    + (checked ? ' checked' : '')
                    + ((locked || disabled) ? ' disabled' : '')
                    + '>'
                    + '<span class="ext-check"></span>'
                    + '<span class="ext-tool-name">' + esc(entry.name) + '</span>'
                    + '<span class="tv-badge tv-badge--' + kind + '">' + esc(_badgeOf(viewId, entry)) + '</span>'
                    + '</label>';
            }
            html += '</div></div>';
        }
        if (!groups.length) {
            html = '<div class="ext-tool-empty tv-empty">'
                + AEI18n.html('<span>没有匹配的工具</span>')
                + (_state.search
                    ? AEI18n.html('<button class="tv-quiet-btn" type="button" data-clear-search="1">清除搜索</button>')
                    : '')
                + '</div>';
        }
        pane.innerHTML = html;

        _syncStats(viewId, list);
        _syncLimitHint(viewId, list);
        _syncDirtyHint();
        _bindPaneEvents(pane, groups);
    }

    // 全量重建后把焦点还给同一控件：checkbox 勾选会走 `_renderPane()`，
    // 旧节点被替换后焦点落回 body；键盘用户连续勾选时必须重新定位到同名行。
    function _focusToolInput(name) {
        var pane = document.getElementById('tvViewPane');
        if (!pane || typeof pane.querySelectorAll !== 'function') return;
        var inputs = pane.querySelectorAll('input[data-tool]');
        for (var i = 0; i < inputs.length; i++) {
            if (inputs[i].getAttribute('data-tool') === name) {
                try { inputs[i].focus(); } catch (_) {}
                return;
            }
        }
    }

    function _focusGroupButton(source, on) {
        var pane = document.getElementById('tvViewPane');
        if (!pane || typeof pane.querySelectorAll !== 'function') return;
        var btns = pane.querySelectorAll('button[data-group-all]');
        for (var i = 0; i < btns.length; i++) {
            if (btns[i].getAttribute('data-group-source') === String(source || '')
                && btns[i].getAttribute('data-group-all') === (on ? 'on' : 'off')) {
                try { btns[i].focus(); } catch (_) {}
                return;
            }
        }
    }

    // 折叠/展开后把焦点还给同一分组的箭头（与勾选/组级操作同一套重建后焦点恢复策略）。
    function _focusGroupToggle(source) {
        var pane = document.getElementById('tvViewPane');
        if (!pane || typeof pane.querySelectorAll !== 'function') return;
        var btns = pane.querySelectorAll('button[data-group-toggle]');
        for (var i = 0; i < btns.length; i++) {
            if (String(btns[i].getAttribute('data-group-toggle') || '') === String(source || '')) {
                try { btns[i].focus(); } catch (_) {}
                return;
            }
        }
    }

    function _bindPaneEvents(pane, groups) {
        if (typeof pane.querySelectorAll !== 'function') return;
        var inputs = pane.querySelectorAll('input[data-tool]');
        for (var i = 0; i < inputs.length; i++) {
            (function (input) {
                if (input.disabled) return;
                input.addEventListener('change', function () {
                    var name = input.getAttribute('data-tool');
                    var entry = _entryByName(_state.viewId, name);
                    if (!entry) return;
                    _setChecked(_state.viewId, entry, !!input.checked);
                    // 重绘页签（「有改动」点）与清单；搜索框不在重建范围内，焦点不丢。
                    _renderAll();
                    _focusToolInput(name);
                });
            })(inputs[i]);
        }
        // 锁定 / 停用行：复选框禁用，点整行给一句提示（AEToast）
        var rows = pane.querySelectorAll('label[data-tool-name]');
        for (var j = 0; j < rows.length; j++) {
            (function (row) {
                var name = row.getAttribute('data-tool-name');
                var entry = _entryByName(_state.viewId, name);
                if (!entry || (!entry.locked && !entry.disabled)) return;
                row.addEventListener('click', function () {
                    if (entry.locked) {
                        _toast(entry.name + AEI18n.punct('：', ': ')
                            + _lockedReasonText(entry), 'warn');
                    } else {
                        _toast(entry.name + AEI18n.punct('：', ': ') + AEI18n.t('该工具已在注册表全局停用'), 'warn');
                    }
                });
            })(rows[j]);
        }
        var groupBtns = pane.querySelectorAll('button[data-group-all]');
        for (var k = 0; k < groupBtns.length; k++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    var source = btn.getAttribute('data-group-source');
                    var on = btn.getAttribute('data-group-all') === 'on';
                    // 作用面 = 本次渲染的分组过滤集（与组头成员数一致）
                    var group = null;
                    for (var gi = 0; gi < groups.length; gi++) {
                        if (String(groups[gi].source || '') === String(source || '')) { group = groups[gi]; break; }
                    }
                    if (!group) return;
                    _setGroupEntries(group.entries, on);
                    // 组级操作可能改页签的「有改动」点，重绘页签 + 清单（只重绘不会丢搜索框焦点）
                    _renderAll();
                    _focusGroupButton(source, on);
                });
            })(groupBtns[k]);
        }
        // 分组折叠：只切本视图的折叠记忆，草稿不变、不触发脏标记。
        // 搜索中分组被强制展开，箭头同时 disabled，这里再兜一层防止程序化点击。
        var toggles = pane.querySelectorAll('button[data-group-toggle]');
        for (var t = 0; t < toggles.length; t++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    if (String(_state.search || '').replace(/^\s+|\s+$/g, '')) return;
                    var source = String(btn.getAttribute('data-group-toggle') || '');
                    var map = _collapsedOf(_state.viewId);
                    map[source] = map[source] !== true;
                    _renderPane();
                    _focusGroupToggle(source);
                });
            })(toggles[t]);
        }
        // 空态里的「清除搜索」（比让用户回工具栏找搜索框更快）
        var clearBtns = pane.querySelectorAll('[data-clear-search]');
        for (var z = 0; z < clearBtns.length; z++) {
            (function (btn) {
                btn.addEventListener('click', function () {
                    _state.search = '';
                    var search = document.getElementById('tvSearch');
                    if (search) search.value = '';
                    _renderPane();
                    if (search && typeof search.focus === 'function') search.focus();
                });
            })(clearBtns[z]);
        }
    }

    // 组级全开/全关：只作用于传入的**本组当前过滤集**里的开放工具（锁定工具不随组级操作
    // 改变，含允许视图内的锁定工具——它们仍是个体勾选）。
    function _setGroupEntries(entries, on) {
        var viewId = _state.viewId;
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            if (entry.locked || entry.disabled) continue;
            _setChecked(viewId, entry, on);
        }
    }

    function _resetView(viewId) {
        var views = _state.draft.views || {};
        delete views[viewId];
        _pruneEmptyView(viewId);
        _renderAll();
    }

    function _syncStats(viewId, list) {
        var el = document.getElementById('tvStats');
        if (!el) return;
        var st = _stats(viewId, list);
        el.textContent = AEI18n.t('默认 ') + st.defaultCount + AEI18n.t(' · 已启用 ') + st.enabledCount;
        _syncChangeCount();
    }

    // 草稿里与打开时基线不一致的工具总数（各视图合计），0 ⇒ 隐藏徽标。
    // 口径必须与页签改动点 / 底部「有未保存的修改」一致（都相对基线，而不是草稿里的绝对条数）：
    // 设置页打开时会把**已保存配置**回填成草稿，若按绝对条数算，一进来就显示「改动 N 项」而
    // 页签没有任何点、底部也不提示，三处指示互相矛盾。
    function _syncChangeCount() {
        var el = document.getElementById('tvChangeCount');
        if (!el) return;
        var n = 0;
        var viewIds = Object.create(null);
        var draftViews = (_state && _state.draft && _state.draft.views) || {};
        var baseViews = (_state && _state.baseline && _state.baseline.views) || {};
        var side;
        for (side = 0; side < 2; side++) {
            var views = side === 0 ? draftViews : baseViews;
            for (var k in views) {
                if (Object.prototype.hasOwnProperty.call(views, k)) viewIds[k] = true;
            }
        }
        for (var viewId in viewIds) {
            if (!Object.prototype.hasOwnProperty.call(viewIds, viewId)) continue;
            n += _viewChangeCount(viewId);
        }
        el.hidden = n === 0;
        if (n) {
            el.textContent = AEI18n.t('改动 ') + n + AEI18n.t(' 项');
            el.title = AEI18n.t('本次草稿与打开时的配置相比改动 ') + n + AEI18n.t(' 处（全部视图合计，点确定后写入设置页草稿）');
        }
    }

    // 单个视图的「规范化签名」：两组名字排序后再拼，用于判断草稿 vs 基线是否真的不同。
    // 不能直接 JSON.stringify 比较——勾选实现是先删后 push，同一集合换个顺序 JSON 就变了
    // （用户把某工具关了→开→关，页签点和「有未保存的修改」会常驻，但点确定写回的内容其实等价）。
    // 本视图不显示的来源（onlyViews）里的名字不参与比较，口径与可见行一致（_hiddenNameSet）。
    function _segSignature(views, viewId) {
        var seg = (views || {})[viewId];
        if (!seg || typeof seg !== 'object') return '';
        var hidden = _hiddenNameSet(viewId);
        var d = Array.isArray(seg.disabled) ? seg.disabled : [];
        var e = Array.isArray(seg.enabled) ? seg.enabled : [];
        var ds = [];
        var es = [];
        var i;
        for (i = 0; i < d.length; i++) { if (!hidden || !hidden[d[i]]) ds.push(d[i]); }
        for (i = 0; i < e.length; i++) { if (!hidden || !hidden[e[i]]) es.push(e[i]); }
        ds.sort();
        es.sort();
        return ds.join('\u0000') + '\u0001' + es.join('\u0000');
    }

    // 本视图草稿是否与打开时的基线不同（页签「有改动」点用）。
    function _viewDirty(viewId) {
        if (!_state) return false;
        try {
            return _segSignature(_state.draft.views, viewId) !== _segSignature(_state.baseline.views, viewId);
        } catch (_) { return true; }
    }

    // 单视图里与打开时基线不一致的工具数（按名字比较两张数组的成员关系，顺序无关）。
    // 本视图不显示的来源（onlyViews）里的名字跳过——否则会出现「改动 N 项」但页面上没有
    // 对应可改行（_hiddenNameSet，与可见行/页签点/脏提示同口径）。
    function _viewChangeCount(viewId) {
        if (!_state) return 0;
        var hidden = _hiddenNameSet(viewId);
        var draft = (_state.draft.views || {})[viewId] || {};
        var base = (_state.baseline.views || {})[viewId] || {};
        var dd = Array.isArray(draft.disabled) ? draft.disabled : [];
        var de = Array.isArray(draft.enabled) ? draft.enabled : [];
        var bd = Array.isArray(base.disabled) ? base.disabled : [];
        var be = Array.isArray(base.enabled) ? base.enabled : [];
        var seen = Object.create(null);
        var i;
        var groups = [dd, de, bd, be];
        for (var g = 0; g < groups.length; g++) {
            for (i = 0; i < groups[g].length; i++) seen[String(groups[g][i])] = true;
        }
        var n = 0;
        for (var name in seen) {
            if (!Object.prototype.hasOwnProperty.call(seen, name)) continue;
            if (hidden && hidden[name]) continue;
            if (_has(dd, name) !== _has(bd, name) || _has(de, name) !== _has(be, name)) n++;
        }
        return n;
    }

    // 本视图的分组折叠记忆（面板内状态，不进草稿、不落盘）。
    function _collapsedOf(viewId) {
        if (!_state) return Object.create(null);
        if (!_state.collapsed) _state.collapsed = {};
        var map = _state.collapsed[viewId];
        if (!map) map = _state.collapsed[viewId] = Object.create(null);
        return map;
    }

    // 工具上限提示：只对非核心工具计数（CORE_TOOL_NAMES 不占名额），
    // maxLlmStubTools=0/缺省 = 不限制 ⇒ 不提示。提示文案见 _buildDom 里的 #tvLimitHint。
    function _syncLimitHint(viewId, list) {
        var el = document.getElementById('tvLimitHint');
        if (!el) return;
        var limit = _llmLimit();
        if (!limit) { el.hidden = true; return; }
        var count = _nonCoreEnabledCount(viewId, list);
        el.hidden = !(count > limit);
    }

    // 三处改动指示（页签点 / 底部脏提示 / 改动计数）共用一套口径：都相对打开时的基线，
    // 且集合相同只换数组顺序不算改动（_setChecked 先删后 push）。这里逐视图比签名，
    // 不再 JSON.stringify 整份草稿（顺序敏感会假报「有未保存的修改」）。
    function _anyDirty() {
        if (!_state) return false;
        var viewIds = Object.create(null);
        var side;
        var k;
        for (side = 0; side < 2; side++) {
            var views = (side === 0 ? _state.draft.views : _state.baseline.views) || {};
            for (k in views) {
                if (Object.prototype.hasOwnProperty.call(views, k)) viewIds[k] = true;
            }
        }
        for (var viewId in viewIds) {
            if (!Object.prototype.hasOwnProperty.call(viewIds, viewId)) continue;
            if (_viewDirty(viewId)) return true;
        }
        return false;
    }

    function _syncDirtyHint() {
        var el = document.getElementById('tvDirtyHint');
        if (!el) return;
        el.hidden = !_anyDirty();
    }

    function _renderAll() {
        _renderTabs();
        _renderPane();
    }

    // ── 打开 / 关闭 / 确定 ─────────────────────────────────────────────────────
    function open() {
        // 重入保护：已有一份打开中的配置面（含其 Esc 监听与草稿）先按取消语义收尾，
        // 避免旧 _state / 旧 keydown 监听留在运行期。
        if (_state) _close();
        var existing = document.getElementById(MODAL_ID);
        if (existing && existing.parentNode) existing.parentNode.removeChild(existing);

        var gate = _createGate();
        if (!gate) {
            _toast(AEI18n.t('工具可见性闸门未装配（shared/toolVisibility.js 缺席），无法打开配置面'), 'error');
            return false;
        }
        var views = [];
        try { views = gate.views() || []; } catch (_) { views = []; }
        if (!views.length) {
            _toast(AEI18n.t('工具可见性闸门没有可用视图，无法打开配置面'), 'error');
            return false;
        }

        var draft = _readDraftFromHiddenInput();
        _entryCache = null;
        _hiddenNameIndex = null;
        _state = {
            gate: gate,
            draft: draft,
            baseline: JSON.parse(JSON.stringify(draft)),
            views: views,
            viewId: views[0],
            search: '',
            descCache: Object.create(null),
            collapsed: {}          // 视图 id → { source: true }（面板内折叠记忆，不落盘）
        };
        _buildDom();
        _renderAll();
        return true;
    }

    function _close() {
        if (_escHandler) {
            try { document.removeEventListener('keydown', _escHandler); } catch (_) {}
            _escHandler = null;
        }
        var overlay = document.getElementById(MODAL_ID);
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        _entryCache = null;
        _hiddenNameIndex = null;
        _state = null;   // 草稿随面板丢弃（关闭不保存不留痕）
    }

    function _confirm() {
        if (!_state) return;
        var normalized = _normToolVisibility(_state.draft);
        var json = '';
        try { json = JSON.stringify(normalized); } catch (_) { json = '{"version":1,"views":{}}'; }
        var input = document.getElementById(INPUT_ID);
        if (!input) {
            _toast(AEI18n.t('设置页未打开，工具可见性草稿无法写回（请从模块设置里的「工具可见性…」进入）'), 'error');
            return;
        }
        input.value = json;
        _toast(AEI18n.t('工具可见性配置已写入设置页草稿，点「保存模块设置」后生效'), 'success');
        _close();
    }

    global.AE_LLM = global.AE_LLM || {};
    global.AE_LLM.ToolVisibilityPanel = { open: open, close: _close };

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.toolVisibilityPanel = { open: open, close: _close };

})(typeof window !== 'undefined' ? window : globalThis);
