(function (global) {
    // 设置面板容器 ID（从 main.js 迁移函数时一并带过来，避免 ReferenceError）
    var LLM_SETTINGS_CONTAINER = 'llmSettingsContainer';
    // maxLlmStubTools 的 0 是合法值（toolRegistry 语义：0=不限制），
    // `Number(v) || 200` 会把 0 挤成 200。仅 NaN/undefined 回退默认 200。
    // 与 engine/settings.js 的 Number.isFinite 写法保持同口径。
    function _normMaxLlmStubTools(v) {
        var n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(10000, n)) : 200;
    }

    // 执行超时（3~120 秒，默认 30 秒）：真源 = engine/settings.js 的 normalizeExecutionTimeoutMs，
    // 面板采集（app/main.js）与落盘都经它。若面板侧不夹上限（只由引擎夹），填 ≥2147484 秒时
    // 落盘值 >2^31-1 ms，setTimeout 延迟溢出夹成 ~1ms → 脚本模式「运行」/快捷栏执行立即误报超时。
    function _normExecutionTimeoutMs(v) {
        var eng = global.AEEngine && global.AEEngine.settings;
        if (eng && typeof eng.normalizeExecutionTimeoutMs === 'function') return eng.normalizeExecutionTimeoutMs(v);
        var n = Number(v) || 30000;
        return Math.max(3000, Math.min(120000, n));
    }

    // Agent 请求超时（10~300 秒，默认 120 秒）：真源 = engine/settings.js 的
    // normalizeRequestTimeoutMs，落盘/回填（本文件）与采集（app/main.js）都经它。
    // 采集只保下限、落盘原样会让落盘值与引擎口径分叉：填 600 秒时 UI 显示 600、
    // 实际请求 300。上限 300000 维持不变（提高上限是产品决定）。
    function _normRequestTimeoutMs(v) {
        var eng = global.AEEngine && global.AEEngine.settings;
        if (eng && typeof eng.normalizeRequestTimeoutMs === 'function') return eng.normalizeRequestTimeoutMs(v);
        var n = Number(v) || 120000;
        return Math.max(10000, Math.min(300000, n));
    }

    // 确认等待超时（0~300000ms）：0 = 不超时是合法值（UI 标题明示）。
    // `Number(v) || 30000` 把 0 挤成 30000——本会话内采集端返回 0 生效，但落盘值错，
    // 重载面板后确认卡片 30 秒自动拒绝。仅非法值（NaN）回退默认，与 engine/settings.js
    // 的 Number.isFinite 写法同口径。
    function _normPermissionConfirmTimeoutMs(v) {
        var n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(300000, n)) : 30000;
    }

    // askUser 提问等待上限（0~3600000ms，默认 300000）：0 = 不超时是合法值（UI 标题明示）。
    // 与 _normPermissionConfirmTimeoutMs 同口径：只有非法值才回落默认，0 原样保留。
    function _normAskUserTimeoutMs(v) {
        var n = Number(v);
        return Number.isFinite(n) ? Math.max(0, Math.min(3600000, n)) : 300000;
    }

    // 目标默认轮数上限（1..500，默认 25）：真源 = engine/settings.js 的
    // normalizeGoalDefaultMaxRounds（与上面两个超时归一同一转发口径），引擎未加载时同口径兜底。
    function _normGoalDefaultMaxRounds(v) {
        var eng = global.AEEngine && global.AEEngine.settings;
        if (eng && typeof eng.normalizeGoalDefaultMaxRounds === 'function') {
            return eng.normalizeGoalDefaultMaxRounds(v);
        }
        var n = Number(v);
        if (!Number.isFinite(n)) return 25;
        return Math.max(1, Math.min(500, Math.floor(n)));
    }

    // 工具可见性归一：真源 = engine/settings.js 的
    // normalizeToolVisibility（唯一实现）。设置页的读设置（resolveModuleSettings）、
    // 落盘白名单（saveSettings）、迁移写（loadSettings）全部**只转发**它——合法视图键、
    // 数组上限、disabled 优先、空段不落盘这套判据在本文件不得复制第二份。
    // 引擎未加载（测试桩/极端环境）时原样返回：宁可不归一，也不造第二个口径。
    function _normToolVisibility(v) {
        var eng = global.AEEngine && global.AEEngine.settings;
        var fn = (eng && typeof eng.normalizeToolVisibility === 'function') ? eng.normalizeToolVisibility : null;
        if (!fn) return v;
        try { return fn(v); } catch (_) { return v; }
    }

    // goal 默认轮数的采集读法（字段 id 只在本文件出现一次）。
    // 面板没打开 / 该行没渲染 ⇒ 返回基线（已生效值）——设置面板是动态注入的，采集链
    // 在面板关闭时也会被走到，绝不能因为「没拿到控件」就把已存值抹成默认
    //（本文件 team 段 maxLoops 已有同类警告：不得丢未渲染字段）。
    function readGoalDefaultMaxRoundsFromUI(baseValue) {
        var el = null;
        try { el = document.getElementById('goalDefaultMaxRounds'); } catch (_) { el = null; }
        if (!el) return _normGoalDefaultMaxRounds(baseValue);
        var raw = String(el.value === undefined || el.value === null ? '' : el.value).replace(/^\s+|\s+$/g, '');
        if (raw === '') return _normGoalDefaultMaxRounds(baseValue);
        return _normGoalDefaultMaxRounds(raw);
    }

    // 上下文 Token 上限：下拉预设 + 可直接输入（不维护"每个模型的窗口"数据，
    // 预设够用、自由填写兜底）。显示成人读得懂的形式（128K / 1M），解析同时认 200000 / 200K / 0.5M。
    function formatTokenValue(n) {
        var v = Math.round(Number(n) || 0);
        if (v >= 1000000 && v % 100000 === 0) return (v / 1000000) + 'M';
        if (v >= 1000 && v % 1000 === 0) return (v / 1000) + 'K';
        return String(v);
    }

    function parseTokenValue(raw, fallback) {
        var s = String(raw === undefined || raw === null ? '' : raw).trim().toLowerCase().replace(/[\s,_]/g, '');
        var m = /^(\d+(?:\.\d+)?)([km])?$/.exec(s);
        if (!m) return fallback;
        var n = Number(m[1]) * (m[2] === 'k' ? 1000 : (m[2] === 'm' ? 1000000 : 1));
        if (!Number.isFinite(n)) return fallback;
        // 与 engine/settings.js 的归一区间保持一致（2000 ~ 1000000）
        return Math.max(2000, Math.min(1000000, Math.round(n)));
    }

    // 团队模式的 lane 清单：**不写第二份 lane id 字面量**——顺序取 engine/settings.js 导出的
    // TEAM_LANE_IDS，标签取 team/lanes.js 的 list()。两处都拿不到（装配面没加载）时给空数组，
    // 调用方据此渲染「装配面未加载」的提示，而不是凭空造四条 lane 出来。
    function teamLaneDefs() {
        var ids = [];
        try {
            var es = global.AEEngine && global.AEEngine.settings;
            if (es && es.TEAM_LANE_IDS && es.TEAM_LANE_IDS.length) ids = es.TEAM_LANE_IDS.slice();
        } catch (_) { ids = []; }
        var labels = {};
        try {
            var lanes = global.AEAgentTeam && global.AEAgentTeam.lanes;
            var list = (lanes && typeof lanes.list === 'function') ? lanes.list() : [];
            for (var i = 0; i < list.length; i++) {
                if (list[i] && list[i].id) labels[list[i].id] = list[i].label || list[i].id;
                if (ids.indexOf(list[i].id) < 0) ids.push(list[i].id);
            }
        } catch (_) { /* 标签拿不到就用 id 兜底 */ }
        var out = [];
        for (var j = 0; j < ids.length; j++) out.push({ id: ids[j], label: labels[ids[j]] || ids[j] });
        return out;
    }

    // 思考等级候选：与全局 reasoningEffort 同集合（engine/settings.js:81 的 REASONING_EFFORTS）。
    // 该集合未单独导出，本仓设置面各处同款内联（settings.js:333、main.js:654）——沿用一致口径。
    var TEAM_EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'];
    // 子 Agent 保活：引擎侧单位是毫秒（0 ~ 3600000），面板按**分钟**展示（0 ~ 60）——
    // 与「执行超时（秒）」同款：UI 单位与内部字段不同名时，换算只在这两个函数里发生。
    var TEAM_KEEPALIVE_MAX_MIN = 60;

    function keepAliveMsToMinutes(ms) {
        var n = Number(ms);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.round(n / 60000);
    }

    function keepAliveMinutesToMs(min) {
        var n = Number(min);
        if (!Number.isFinite(n) || n <= 0) return 0;
        return Math.max(0, Math.min(TEAM_KEEPALIVE_MAX_MIN * 60000, Math.round(n) * 60000));
    }

    // 子 Agent 并发闸的默认值：取引擎设计默认（engine/settings.js 的 DEFAULTS），引擎缺席回落到
    // 同一个数（3）。**不写 `|| 0`**——见下条读法注释。
    function subagentMaxConcurrentDefault() {
        try {
            var es = global.AEEngine && global.AEEngine.settings;
            var d = es && es.DEFAULTS && es.DEFAULTS.team && es.DEFAULTS.team.subagent;
            var n = d ? Number(d.maxConcurrent) : NaN;
            if (Number.isFinite(n)) return n;
        } catch (_) { /* 引擎未加载：用下面这条常量 */ }
        return 3;
    }

    // ── 团队 lane 的模型 / 平台选择器 ───────────────────────────────
    // 背景：lane 的「模型」是自由文本框时——用户得自己记住「平台 id + 模型 id」两个字符串，
    // 而模型 ID 只在所属平台内唯一，填错要到发请求时才报错。现在改成：
    //   · 模型 = 点击弹窗（搜索 + 按平台分组的完整清单；候选可能上千条，普通下拉放不下）；
    //   · 平台不单独出现：点行时把所属平台
    //     一并写进隐藏输入，储存/引擎侧仍按「模型 + 平台」成对读取。
    // 数据源只有 providerRegistry 一份（不在这里维护第二份模型清单）。
    var LANE_MODEL_PICKER_ID = 'teamLaneModelPickerModal';

    function _escHtml(v) {
        return String(v == null ? '' : v)
            .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
            .replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // 候选平台（只读快照）：停用平台、没有模型的平台不进候选——选了也发不出去。
    function teamLaneProviders() {
        var out = [];
        try {
            var reg = global.AE_LLM && global.AE_LLM.providerRegistry;
            var list = (reg && typeof reg.listProviders === 'function') ? (reg.listProviders() || []) : [];
            for (var i = 0; i < list.length; i++) {
                var p = list[i];
                if (!p || !p.id || p.enabled === false) continue;
                var models = [];
                var src = Array.isArray(p.models) ? p.models : [];
                for (var j = 0; j < src.length; j++) {
                    var m = src[j];
                    if (!m || !m.id) continue;
                    var caps = m.capabilities || {};
                    models.push({ id: String(m.id), vision: caps.vision === true, video: caps.video === true });
                }
                if (!models.length) continue;
                out.push({ id: String(p.id), label: String(p.label || p.id), models: models });
            }
        } catch (_) { out = []; }
        return out;
    }

    function _providerHasModel(provider, modelId) {
        if (!provider || !modelId) return false;
        for (var i = 0; i < provider.models.length; i++) {
            if (provider.models[i].id === modelId) return true;
        }
        return false;
    }

    function _laneModelText(model) {
        var s = String(model == null ? '' : model);
        return s ? s : AEI18n.t('跟随全局默认');
    }

    // lane 模型字段的**唯一写点**：隐藏输入（采集链读它）与可见按钮文案一起更新。
    function _setTeamLaneModel(laneId, model) {
        var mEl = null;
        try { mEl = document.getElementById('teamLaneModel_' + laneId); } catch (_) { mEl = null; }
        if (mEl) mEl.value = String(model == null ? '' : model);
        var btn = null;
        try { btn = document.getElementById('teamLaneModelPick_' + laneId); } catch (_) { btn = null; }
        if (!btn) return;
        var textEl = (typeof btn.querySelector === 'function') ? btn.querySelector('.st-pick-text') : null;
        var text = _laneModelText(model);
        if (textEl) {
            if (String(textEl.textContent == null ? '' : textEl.textContent) !== text) textEl.textContent = text;
            if (textEl.classList && typeof textEl.classList.toggle === 'function') {
                textEl.classList.toggle('is-empty', !model);
            }
        }
        if (typeof btn.setAttribute === 'function') {
            btn.setAttribute('title', model
                ? (AEI18n.t('当前模型：') + model + AEI18n.t('（点击更换）'))
                : AEI18n.t('跟随「模型管理」的全局默认模型（点击选择）'));
        }
    }

    // lane 平台字段的**唯一写点**：平台不再有可见下拉框（
    // 「平台下拉不需要了，直接模型就够了」），但字段契约保留——模型弹窗点行时把所属平台
    // 一并写进隐藏输入，readTeamFromUI 与引擎侧仍按「模型 + 平台」成对读取。
    // 为什么不能只存模型：模型 ID 只在所属平台内唯一，只存模型遇到重名会解析到别的平台。
    function _setTeamLanePlatform(laneId, platform) {
        var pEl = null;
        try { pEl = document.getElementById('teamLanePlatform_' + laneId); } catch (_) { pEl = null; }
        if (pEl) pEl.value = String(platform == null ? '' : platform);
    }

    // lane 显示名（弹窗标题用）：定义源只有 teamLaneDefs（标签取自 team/lanes.js）。
    function _laneLabelOf(laneId) {
        var defs = teamLaneDefs();
        for (var i = 0; i < defs.length; i++) {
            if (defs[i].id === laneId) return defs[i].label;
        }
        return laneId;
    }

    function closeTeamLaneModelPicker() {
        var el = null;
        try { el = document.getElementById(LANE_MODEL_PICKER_ID); } catch (_) { el = null; }
        if (!el) return;
        // Esc 监听随遮罩一起移除：不摘的话每开一次弹窗就多挂一个 document 级监听，
        // 且迟到的监听会对已脱离 DOM 的遮罩 removeChild（persona 编辑弹窗的历史坑）。
        if (typeof el.__escHandler === 'function') {
            try { document.removeEventListener('keydown', el.__escHandler); } catch (_) {}
            el.__escHandler = null;
        }
        if (el.parentNode) el.parentNode.removeChild(el);
    }

    // 模型选择弹窗：搜索框 + 平台筛选 chip + 按平台分组的模型行；点行即提交（平台 + 模型），
    // 「跟随全局默认」清空两个字段。行用 <button>，键盘 Enter/Space 原生可用。
    function openTeamLaneModelPicker(laneId) {
        closeTeamLaneModelPicker();
        var providers = teamLaneProviders();
        var mEl = null;
        try { mEl = document.getElementById('teamLaneModel_' + laneId); } catch (_) { mEl = null; }
        var pEl = null;
        try { pEl = document.getElementById('teamLanePlatform_' + laneId); } catch (_) { pEl = null; }
        var curModel = mEl ? String(mEl.value == null ? '' : mEl.value) : '';
        var curPlatform = pEl ? String(pEl.value == null ? '' : pEl.value) : '';
        var curProvider = null;
        for (var ci = 0; ci < providers.length; ci++) {
            if (_providerHasModel(providers[ci], curModel)) { curProvider = providers[ci]; break; }
        }
        // 已存平台是否还在候选里（平台被删/停用 ⇒ 只保留字符串，不假装它可选）
        var curPlatformOk = !curPlatform;
        for (var cpi = 0; cpi < providers.length; cpi++) {
            if (providers[cpi].id === curPlatform) { curPlatformOk = true; break; }
        }
        var state = { query: '', platform: '' };

        function isSelected(p, m) {
            if (m.id !== curModel) return false;
            // 有可用平台就按平台判定（模型 ID 只在平台内唯一）；平台已失效时只按模型高亮，
            // 让用户看出「模型还在候选里，只是平台没了」。
            if (curPlatform && curPlatformOk) return p.id === curPlatform;
            return !!(curProvider && curProvider.id === p.id);
        }

        function renderRows() {
            var listEl = null;
            try { listEl = document.getElementById('teamLaneModelPickerList'); } catch (_) { listEl = null; }
            if (!listEl) return;
            var q = state.query.toLowerCase();
            var html = '';
            var shown = 0;
            for (var i = 0; i < providers.length; i++) {
                var p = providers[i];
                if (state.platform && p.id !== state.platform) continue;
                var rows = '';
                for (var j = 0; j < p.models.length; j++) {
                    var m = p.models[j];
                    var hit = !q
                        || p.id.toLowerCase().indexOf(q) >= 0
                        || p.label.toLowerCase().indexOf(q) >= 0
                        || m.id.toLowerCase().indexOf(q) >= 0;
                    if (!hit) continue;
                    var selCls = isSelected(p, m) ? ' is-selected' : '';
                    rows += '<button type="button" class="st-mp-row' + selCls + '"'
                        + ' data-platform="' + _escHtml(p.id) + '" data-model="' + _escHtml(m.id) + '"'
                        + ' title="' + _escHtml(p.label + ' · ' + m.id) + '">'
                        + '<span class="st-mp-row-model">' + _escHtml(m.id) + '</span>'
                        + '<span class="st-mp-row-tags">'
                        + (m.vision ? AEI18n.html('<span class="st-mp-tag">视觉</span>') : '')
                        + (m.video ? AEI18n.html('<span class="st-mp-tag">视频</span>') : '')
                        + '</span>'
                        + '<span class="st-mp-row-check" aria-hidden="true">✓</span>'
                        + '</button>';
                    shown++;
                }
                if (rows) {
                    html += '<div class="st-mp-group"><div class="st-mp-group-title">'
                        + _escHtml(p.label) + '</div>' + rows + '</div>';
                }
            }
            listEl.innerHTML = shown ? html : AEI18n.html('<div class="st-mp-empty">没有匹配的模型</div>');
        }

        function commit(platform, model) {
            // 平台 + 模型成对写：模型走可见按钮的唯一写点，平台写隐藏输入（readTeamFromUI 的契约）。
            _setTeamLaneModel(laneId, model);
            _setTeamLanePlatform(laneId, model ? (platform || '') : '');
            closeTeamLaneModelPicker();
        }

        var chips = AEI18n.html('<button type="button" class="st-mp-chip is-active" data-platform="">全部平台</button>');
        for (var pi = 0; pi < providers.length; pi++) {
            chips += '<button type="button" class="st-mp-chip" data-platform="'
                + _escHtml(providers[pi].id) + '">' + _escHtml(providers[pi].label) + '</button>';
        }
        var note = '';
        if (curModel && !curProvider) {
            note = '<div class="st-mp-note">'
                + AEI18n.html('当前保存的模型')
                + ' <code>' + _escHtml(curModel) + '</code> '
                + AEI18n.html('不在候选清单里（平台已删除或平台下没有这个模型），可直接重选或跟随全局默认。')
                + '</div>';
        } else if (curModel && !curPlatformOk) {
            note = '<div class="st-mp-note">'
                + AEI18n.html('当前模型记录的所属平台')
                + ' <code>' + _escHtml(curPlatform) + '</code> '
                + AEI18n.html('已不在候选清单里（平台被删除或停用）；重选一次模型即可按新平台修正。')
                + '</div>';
        }
        // 标题是「前缀 + lane 显示名」的复合串：走整句模板（AEI18n.html 只按文本节点查表，
        // 拼好的复合串查不到 key）。lane 名已转义，可直接进 HTML。
        // 含中文的静态片段各自过 AEI18n.html：key 提取只认实参为字面量的调用，
        // 整段拼接塞进一个 html() 时这些片段取不到 key，运行期 t() 未命中就原样上中文。
        var html = AEI18n.html('<div class="modal-head"><span>'
            + AEI18n.t('选择模型 · {name}', { name: _escHtml(_laneLabelOf(laneId)) }) + '</span>'
            + AEI18n.html('<button class="icon-btn" id="teamLaneModelPickerCloseBtn">关闭</button></div>')
            + '<div class="st-mp-toolbar">'
            + AEI18n.html('<input type="text" class="st-mp-search" id="teamLaneModelPickerSearch" placeholder="搜索模型或平台" autocomplete="off" spellcheck="false">')
            + '</div>'
            + '<div class="st-mp-chips" id="teamLaneModelPickerChips">' + chips + '</div>'
            + note
            + '<div class="modal-body ae-scrollbar st-mp-body" id="teamLaneModelPickerList"></div>'
            + '<div class="st-mp-footer">'
            + AEI18n.html('<span class="st-mp-hint">选择后自动记录所属平台；留空 = 跟随全局默认</span>')
            + '<div class="st-mp-btns">'
            + AEI18n.html('<button class="btn secondary" id="teamLaneModelPickerClearBtn">跟随全局默认</button>')
            + AEI18n.html('<button class="btn" id="teamLaneModelPickerCancelBtn">取消</button>')
            + '</div></div>');

        var overlay = document.createElement('div');
        overlay.className = 'modal-mask';
        overlay.id = LANE_MODEL_PICKER_ID;
        overlay.style.display = 'flex';
        overlay.style.opacity = '1';
        overlay.style.zIndex = '110';
        var box = document.createElement('div');
        box.className = 'modal st-model-picker-modal';
        box.style.opacity = '1';
        box.style.transform = 'none';
        box.innerHTML = html;
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        var searchEl = document.getElementById('teamLaneModelPickerSearch');
        if (searchEl) {
            searchEl.addEventListener('input', function () {
                state.query = String(searchEl.value == null ? '' : searchEl.value).replace(/^\s+|\s+$/g, '');
                renderRows();
            });
        }
        var chipEls = box.querySelectorAll('.st-mp-chip');
        for (var chi = 0; chi < chipEls.length; chi++) {
            (function (chip) {
                chip.addEventListener('click', function () {
                    state.platform = chip.getAttribute('data-platform') || '';
                    for (var k = 0; k < chipEls.length; k++) {
                        if (chipEls[k].classList) {
                            chipEls[k].classList.toggle('is-active', chipEls[k] === chip);
                        }
                    }
                    renderRows();
                });
            })(chipEls[chi]);
        }
        var listEl = document.getElementById('teamLaneModelPickerList');
        if (listEl) {
            listEl.addEventListener('click', function (e) {
                var t = e.target;
                while (t && t !== listEl) {
                    if (t.getAttribute && t.getAttribute('data-model')) {
                        commit(t.getAttribute('data-platform') || '', t.getAttribute('data-model') || '');
                        return;
                    }
                    t = t.parentNode;
                }
            });
        }
        var closeBtn = document.getElementById('teamLaneModelPickerCloseBtn');
        if (closeBtn) closeBtn.addEventListener('click', closeTeamLaneModelPicker);
        var cancelBtn = document.getElementById('teamLaneModelPickerCancelBtn');
        if (cancelBtn) cancelBtn.addEventListener('click', closeTeamLaneModelPicker);
        var clearBtn = document.getElementById('teamLaneModelPickerClearBtn');
        if (clearBtn) {
            clearBtn.addEventListener('click', function () { commit('', ''); });
        }
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeTeamLaneModelPicker();
        });
        // Esc 关闭；监听挂在遮罩上，关闭函数统一摘除（见 closeTeamLaneModelPicker）。
        function escHandler(e) {
            if (e.key === 'Escape' || e.keyCode === 27) closeTeamLaneModelPicker();
        }
        overlay.__escHandler = escHandler;
        document.addEventListener('keydown', escHandler);
        renderRows();
        setTimeout(function () {
            try { if (searchEl && typeof searchEl.focus === 'function') searchEl.focus(); } catch (_) {}
        }, 0);
    }

    // 字段下方的可见提示（id 与 maxContextTokensHint 同款，样式复用 .st-field-hint）：面板没打开
    // 时该节点不存在 ⇒ 静默跳过（本函数跑在采集链上，绝不能因此抛错）。
    function _setSubagentMaxConcurrentHint(text) {
        var el = null;
        try { el = document.getElementById('teamSubagentMaxConcurrentHint'); } catch (_) { el = null; }
        if (!el) return;
        // 同值不写：本读法在保存/采集链上被反复调用，无谓的 textContent 赋值会白触发一次重排。
        var next = text || '';
        if (String(el.textContent == null ? '' : el.textContent) === next) return;
        el.textContent = next;
    }

    // 子 Agent 并发闸的输入框读法：三个闸**运行期可改**（subagent.js 的
    // setLimits），maxConcurrent = 0 从「以前无害」变成真闸门（派生与追问都显式失败 limit_zero）。
    // 故这里不能再用 `Number(v) || 0`：留空 / 非数字会被静默存成 0 ⇒ 一保存就把子 Agent 全关掉。
    // 只在**能解析出数字**时采纳输入（0 仍可显式输入，那是合法意图）；其余情况保持原值（基线，
    // 基线缺席取设计默认），并把这件事写进字段下方的可见提示。
    function readSubagentMaxConcurrent(maxEl, baseSub) {
        var prev = Number(baseSub && baseSub.maxConcurrent);
        if (!Number.isFinite(prev)) prev = subagentMaxConcurrentDefault();
        var raw = maxEl ? String(maxEl.value == null ? '' : maxEl.value).trim() : '';
        var n = raw === '' ? NaN : Number(raw);
        if (!Number.isFinite(n)) {
            _setSubagentMaxConcurrentHint(AEI18n.t('这一项留空或不是数字，保持原值 {value}（0 = 不允许派生，追问同样被拒）', { value: prev }));
            return prev;
        }
        _setSubagentMaxConcurrentHint('');
        return n;
    }

    // 设置面板的团队段 → team 段对象（**唯一**知道那些字段 id 的地方；采集入口由
    // app/main.js 的 getCurrentSettingsFromUI 调用）。
    // 三个必须守住的语义：
    //   · `enabled` 取**当前快照**（团队开关的入口在顶栏，不在设置页）：这里若写成 false，
    //     用户改一次 lane 模型就会把团队关掉；
    //   · `maxLoops`（轮数上限）不在 UI 上 ⇒ 同样从快照保留，不能因为没渲染就丢掉；
    //   · lane 输入框缺席（设置面板没打开）⇒ 返回 null，让调用方**整段跳过**——
    //     返回一份空 lane 配置会把已存的模型/平台/思考等级一起抹平。
    // 基线来源（**禁止**改成 AEAgentTeam.settings.snapshot()）：snapshot 的取数通道是引擎装配时
    // 注册的 provider，而那个 provider 就是 app/main.js 里读全局设置的回调——它内部又会调
    // getCurrentSettingsFromUI()（即本函数的调用方）。真机现象：进入 Agent 模块时
    // controller.render() → getSettings() → getCurrentSettingsFromUI() → 这里 → snapshot()
    // → provider → 又回到 getCurrentSettingsFromUI()，形成每轮 +9 帧的无界递归
    //（实测栈深 400+ 仍在增长），面板主线程 100% CPU、CDP 求值全部超时。
    // 基线只取**已生效的权威 team 段**（调用方传入，或 main.js 的 cachedSettings.team），
    // 它是 team 开关落盘后立刻更新的那份数据，语义与原 snapshot() 完全一致，但链条在此断开。
    function _teamBaseline(baseTeam) {
        var raw = (baseTeam && typeof baseTeam === 'object') ? baseTeam : null;
        if (!raw) {
            try {
                if (typeof cachedSettings === 'object' && cachedSettings
                    && cachedSettings.team && typeof cachedSettings.team === 'object') {
                    raw = cachedSettings.team;
                }
            } catch (_) { raw = null; }
        }
        if (!raw) return null;
        try {
            var st = global.AEEngine && global.AEEngine.settings;
            // 第二参 = 当前 runtimeMode，作 baseMode 兜底：这段 team 段可能来自
            // 调用方给的基线（未必带 baseMode），归一不得把它抹成默认值——团队关着时
            // baseMode 恒等于 runtimeMode，用现成的 runtimeMode 兜最准。
            if (st && typeof st.normalizeTeam === 'function') {
                return st.normalizeTeam(raw, (cachedSettings && cachedSettings.runtimeMode));
            }
        } catch (_) { /* 归一不可用：原样用（下面只读 enabled / lanes / subagent 三个键） */ }
        return raw;
    }

    // baseTeam（可选）= 调用方手里那份 team 段基线；不传则回落 cachedSettings.team。
    // 两条路都不触发 provider，故本函数可安全地被设置采集链调用（见 _teamBaseline 注释）。
    function readTeamFromUI(baseTeam) {
        var defs = teamLaneDefs();
        if (!defs.length) return null;
        var base = _teamBaseline(baseTeam);
        var baseLanes = (base && base.lanes) || {};
        var baseSub = (base && base.subagent) || {};
        var lanes = {};
        var anyField = false;
        for (var i = 0; i < defs.length; i++) {
            var id = defs[i].id;
            var mEl = document.getElementById('teamLaneModel_' + id);
            var pEl = document.getElementById('teamLanePlatform_' + id);
            var eEl = document.getElementById('teamLaneEffort_' + id);
            if (mEl || pEl || eEl) anyField = true;
            var prev = baseLanes[id] || {};
            var laneModel = mEl ? String(mEl.value == null ? '' : mEl.value).trim() : (prev.model || '');
            var lanePlatform = pEl ? String(pEl.value == null ? '' : pEl.value).trim() : (prev.platform || '');
            // 模型为空 ⇒ 平台无意义：「跟随全局默认」在界面上就是两个字段都空（平台下拉已于
            // 移除）。旧文本输入时代可能留下「只有平台没有模型」的孤儿组合——若不收敛，
            // 界面显示「跟随全局默认」而引擎会按该平台的默认模型解析，口径对不上。保存时收敛掉。
            if (!laneModel) lanePlatform = '';
            lanes[id] = {
                model: laneModel,
                platform: lanePlatform,
                reasoningEffort: eEl ? (eEl.value || prev.reasoningEffort || 'high') : (prev.reasoningEffort || 'high')
            };
        }
        if (!anyField) return null;   // 设置面板没打开：不采集（避免把已存配置抹平）
        var keepEl = document.getElementById('teamSubagentKeepAliveMin');
        var maxEl = document.getElementById('teamSubagentMaxConcurrent');
        return {
            enabled: !!(base && base.enabled),
            // baseMode：本函数是「从设置面板采集 team 段」的唯一出口，**必须带上它**——
            // 漏掉它，一次从设置面板触发的保存就会把「上次从外接进团队」的来处抹成默认 script，
            // 退出团队时落错档（applyModeConsistency 按 runtimeMode 兜底兜不出历史来处）。
            baseMode: (base && base.baseMode) || 'script',
            lanes: lanes,
            subagent: {
                // 并发闸走专门读法：留空 / 非数字不写 0（0 现在是真闸门，见 readSubagentMaxConcurrent）
                maxConcurrent: readSubagentMaxConcurrent(maxEl, baseSub),
                keepAliveMs: keepEl ? keepAliveMinutesToMs(keepEl.value) : (Number(baseSub.keepAliveMs) || 0),
                maxLoops: Number(baseSub.maxLoops) || 0
            }
        };
    }

    // 落盘前的团队段归一：转发 engine/settings.js 的 normalizeTeam（唯一实现）。
    // 引擎未加载（极端环境）时返回 null 而不是造一份默认值——写 null 会让读取侧走
    // 「关闭态」的显式分支（归一实现在读侧会补默认），比写一份可能与引擎漂移的默认值安全。
    // 第二参 runtimeMode（可选）= baseMode 兜底来处：漏掉它，一次落盘就可能把
    // 「上次从外接进团队」留下的 baseMode 抹成 'script'，退出团队时落错档。
    function _normalizeTeamForSave(raw, runtimeMode) {
        var fn = null;
        try {
            fn = (global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.normalizeTeam) || null;
        } catch (_) { fn = null; }
        if (typeof fn !== 'function') return null;
        try { return fn(raw, runtimeMode); } catch (_) { return null; }
    }

    // 落盘前的一致性：转发 engine/settings.js 的 applyModeConsistency（唯一实现）。
    // 保存路径必须过一遍——否则 UI 采集出的 `runtimeMode` / `team` 两半可能不自洽，脏值先落盘、
    // 下次读盘才被纠正（中间那次持久化已经是错的）。
    function _applyModeConsistencyForSave(target) {
        var fn = null;
        try {
            fn = (global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.applyModeConsistency) || null;
        } catch (_) { fn = null; }
        if (typeof fn !== 'function') return target;
        try { fn(target); } catch (_) { /* 归一不可用：保持原值（读侧还会再纠正一次） */ }
        return target;
    }

    function resolveModuleSettings(defaults, partial, clampScriptListHeight) {
        const base = {
            ...(defaults || {}),
            ...(partial || {})
        };
        base.scriptListHeight = clampScriptListHeight(base.scriptListHeight, 320);
        // 白名单引用 engine 的唯一档位表：第 5 档 'team' 也是合法档位。
        // 引擎未加载时本地兜底同一清单（旧包/测试桩），不造第二份白名单。
        var _modes = ['script', 'agent', 'shader', 'external', 'team'];
        try {
            var _stModes = global.AEEngine && global.AEEngine.settings && global.AEEngine.settings.MODES;
            if (Array.isArray(_stModes) && _stModes.length) _modes = _stModes;
        } catch (_) { /* 引擎缺席：用上面的兜底 */ }
        base.runtimeMode = _modes.indexOf(base.runtimeMode) >= 0 ? base.runtimeMode : 'script';
        base.executionTimeoutMs = _normExecutionTimeoutMs(base.executionTimeoutMs);
        base.requestTimeoutMs = _normRequestTimeoutMs(base.requestTimeoutMs);
        // 兜底值钳制：区间不变（2000 ~ 1000000）；`|| 256000` 只兜「从未设置过」——
        // 已存盘的旧值（如 1000000）原样保留，升级不重置（默认 256k）
        base.maxContextTokens = Math.max(2000, Math.min(1000000, Number(base.maxContextTokens) || 256000));
        base.confirmBeforeExecute = !!base.confirmBeforeExecute;
        base.agentScriptReview = !!base.agentScriptReview;
        base.shaderJsReview = !!base.shaderJsReview;
        base.allowCloudModels = !!base.allowCloudModels;
        base.webSearchEnabled = !!base.webSearchEnabled;
        // 待发送消息派发时机：false = 下一轮 LLM 请求前注入（默认，现状）；
        // true = 等当前轮正式回复后作为新一轮发送。归一只有布尔夹取，语义消费在 controller。
        base.deferInjectUntilReply = !!base.deferInjectUntilReply;
        base.maxLlmStubTools = _normMaxLlmStubTools(base.maxLlmStubTools);
        // 目标默认轮数上限（1..500）：设置页读到的值与运行时实际用的一致
        base.goalDefaultMaxRounds = _normGoalDefaultMaxRounds(base.goalDefaultMaxRounds);
        // 工具可见性用户覆盖：读设置路径同样归一（脏盘/手改文件在这里被清洗，
        // 面板渲染与运行时闸口读到同一份结构；老盘无此键 ⇒ 空配置 = 全默认面）。
        base.toolVisibility = _normToolVisibility(base.toolVisibility);
        // 旧盘残留键 previewFps（「Shader 预览帧率（fps）」设置项已整体移除，预览固定
        // 30fps——真源 AEEngine.settings.PREVIEW_FPS）：读时丢弃、不做迁移，既不得把它
        // 当生效值，也不得让它的存在挤掉其它字段（stale key 容忍）。
        delete base.previewFps;
        // 外部链接点击确认：默认开启，关闭后直接用系统默认浏览器打开
        base.confirmExternalLink = base.confirmExternalLink !== false;
        // 聊天区本地路径点击确认：默认开启；关闭后单击直开所在目录
        base.confirmPathOpen = base.confirmPathOpen !== false;
        base.reasoningEffort = ['low', 'medium', 'high', 'xhigh'].indexOf(base.reasoningEffort) >= 0 ? base.reasoningEffort : 'high';
        base.permissionMode = ['auto', 'balanced', 'conservative'].indexOf(base.permissionMode) >= 0 ? base.permissionMode : 'balanced';
        base.previewDraft = String(base.previewDraft || '');
        base.shaderDraft = String(base.shaderDraft || '');
        base.flowAnimOffsetMs = Math.max(-5000, Math.min(5000, Number(base.flowAnimOffsetMs) || 0));
        base.airsAnimOffsetMs = Math.max(-5000, Math.min(5000, Number(base.airsAnimOffsetMs) || 0));
        base.userPersona = String(base.userPersona || '');
        // Agent 模块不再维护模型覆盖项，统一跟随「模型管理」模块的全局默认 provider/model。
        base.providerId = '';
        base.modelId = '';
        base.platform = '';
        base.model = '';
        base.customModel = '';
        // 团队段归一：唯一实现在 engine/settings.js 的 normalizeTeam（缺段补默认 = 旧设置盘升级
        // 兼容）。这里**只转发**——设置页读的是归一后的值，与运行时实际用的一致；引擎未加载时
        // 保留原值（不在这里造第二份默认值）。
        // 老盘迁移：转发 engine 的唯一实现，**必须排在 normalizeTeam 之前**——归一一旦
        // 补上 baseMode，就再也分不清「老盘缺这个字段」与「新格式本来就有」，而那个区别正是
        // 「旧盘迁移」与「稳态一致性」的分界（后者绝不能把 runtimeMode 拽回 'team'）。
        var migrateLegacyFn = null;
        try {
            migrateLegacyFn = (global.AEEngine && global.AEEngine.settings
                && global.AEEngine.settings.migrateLegacyTeam) || null;
        } catch (_) { migrateLegacyFn = null; }
        if (typeof migrateLegacyFn === 'function') migrateLegacyFn(base);
        var normalizeTeamFn = null;
        try {
            normalizeTeamFn = (global.AEEngine && global.AEEngine.settings
                && global.AEEngine.settings.normalizeTeam) || null;
        } catch (_) { normalizeTeamFn = null; }
        if (typeof normalizeTeamFn === 'function') base.team = normalizeTeamFn(base.team, base.runtimeMode);
        // 面板档位一致性 + 老盘迁移：**转发** engine/settings.js 的唯一实现。
        // 为什么这条不能省：保存路径（saveSettings / getCurrentSettingsFromUI → 落盘）走的是本
        // 函数，若这里不做一致性，就会把 `runtimeMode='team'` + `team.enabled=false`（或反过来
        // 少了 baseMode）这种不自洽组合持久化下去，下次读盘才被纠正 —— 中间那次落盘已经是脏的。
        var applyConsistencyFn = null;
        try {
            applyConsistencyFn = (global.AEEngine && global.AEEngine.settings
                && global.AEEngine.settings.applyModeConsistency) || null;
        } catch (_) { applyConsistencyFn = null; }
        if (typeof applyConsistencyFn === 'function') applyConsistencyFn(base);
        return base;
    }

    function getSettingsStore(moduleContext) {        if (moduleContext && moduleContext.settingsStore) {
            return moduleContext.settingsStore;
        }
        if (global.AEAppContainer && typeof global.AEAppContainer.getContext === 'function') {
            const ctx = global.AEAppContainer.getContext();
            return ctx ? ctx.settingsStore : null;
        }
        return null;
    }

    function stripGlobalOnlyFields(source) {
        const cleaned = { ...(source || {}) };
        // Legacy global fields
        delete cleaned.apiKey;
        delete cleaned.openrouterApiKey;
        delete cleaned.deepseekApiKey;
        delete cleaned.kimiApiKey;
        delete cleaned.anthropicApiKey;
        delete cleaned.themePreset;
        delete cleaned.customThemeColors;
        delete cleaned.debugMode;
        // Derive additional sensitive fields dynamically from registry
        try {
            if (global.AE_LLM && global.AE_LLM.providerRegistry && typeof global.AE_LLM.providerRegistry.listProviders === 'function') {
                var providers = global.AE_LLM.providerRegistry.listProviders(false);
                for (var i = 0; i < providers.length; i++) {
                    if (providers[i].apiKeyField) {
                        delete cleaned[providers[i].apiKeyField];
                    }
                }
            }
        } catch (_) {}
        return cleaned;
    }

    async function loadSettings(options) {
        const opts = options || {};
        const {
            moduleContext,
            moduleId,
            globalDefaults,
            moduleDefaults,
            models,
            clampScriptListHeight
        } = opts;

        const store = getSettingsStore(moduleContext);
        if (store && typeof store.getGlobalSettings === 'function' && typeof store.getModuleSettings === 'function') {
            const globalSettings = await store.getGlobalSettings(globalDefaults || {});
            const moduleSettings = await store.getModuleSettings(moduleId, moduleDefaults || {});
            const legacyAgentSettings = await store.getModuleSettings('ae-agent', {});
            const moduleSettingsForModule = stripGlobalOnlyFields(moduleSettings);
            const legacyAgentSettingsForModule = stripGlobalOnlyFields(legacyAgentSettings);
            const resolved = resolveModuleSettings(
                {
                    ...(globalDefaults || {}),
                    ...(moduleDefaults || {})
                },
                {
                    ...globalSettings,
                    ...legacyAgentSettingsForModule,
                    ...moduleSettingsForModule
                },
                clampScriptListHeight
            );
            const moduleSettingsContainsGlobalFields = !!(moduleSettings && (
                Object.prototype.hasOwnProperty.call(moduleSettings, 'apiKey')
                || Object.prototype.hasOwnProperty.call(moduleSettings, 'themePreset')
                || Object.prototype.hasOwnProperty.call(moduleSettings, 'debugMode')
            ));
            if (!moduleSettings || !moduleSettings._migratedFromAeAgent || moduleSettingsContainsGlobalFields) {
                await store.setModuleSettings(moduleId, {
                    ...moduleSettingsForModule,
                    flowAnimOffsetMs: resolved.flowAnimOffsetMs,
                    airsAnimOffsetMs: resolved.airsAnimOffsetMs,
                    providerId: '',
                    modelId: '',
                    platform: '',
                    model: '',
                    customModel: '',
                    skipRunConfirm: !!resolved.skipRunConfirm,
                    scriptListHeight: resolved.scriptListHeight,
                    runtimeMode: resolved.runtimeMode,
                    executionTimeoutMs: resolved.executionTimeoutMs,
                    requestTimeoutMs: resolved.requestTimeoutMs,
                    maxContextTokens: resolved.maxContextTokens,
                    reasoningEffort: resolved.reasoningEffort || 'high',
                    permissionMode: resolved.permissionMode || 'balanced',
                    previewDraft: resolved.previewDraft || '',
                    shaderDraft: resolved.shaderDraft || '',
                    userPersona: resolved.userPersona || '',
                    agentScriptReview: !!resolved.agentScriptReview,
                    shaderJsReview: !!resolved.shaderJsReview,
                    webSearchEnabled: resolved.webSearchEnabled !== false,
                    deferInjectUntilReply: !!resolved.deferInjectUntilReply,
                    maxLlmStubTools: _normMaxLlmStubTools(resolved.maxLlmStubTools),
                    // 目标默认轮数上限：迁移写同样要带，否则这次迁移会把已存值抹回默认
                    goalDefaultMaxRounds: _normGoalDefaultMaxRounds(resolved.goalDefaultMaxRounds),
                    confirmExternalLink: resolved.confirmExternalLink !== false,
                    confirmPathOpen: resolved.confirmPathOpen !== false,
                    // 团队段：迁移写同样要带上——它的字段表是显式的，漏掉就会把已存的
                    // 团队开关/lane 参数在这一次迁移写里抹掉（读侧回默认 = 团队被静默关闭）
                    team: _normalizeTeamForSave(resolved.team, resolved.runtimeMode),
                    // 工具可见性同理：迁移写的字段表是显式的，漏掉它会让升级后首次 load
                    // 把已存的用户覆盖抹回默认（漏一处即重载回默认）。
                    toolVisibility: _normToolVisibility(resolved.toolVisibility),
                    _migratedFromAeAgent: true
                });
            }
            return resolved;
        }

        // 设置仓库不可用时（项目定论：settingsStore 恒注入——client/main.js:2785 创建、
        // :3064 经 createAppContainer dependencies 传入；此路实际不可达）
        // **不读 localStorage**。按扁平字段形状读（parsed.debugMode /
        // parsed.themePreset / …），而字段早已被 settingsStore 搬到 global.* 与 modules.*
        //（见 settingsStore.js:249）——读到的只能是默认值：不是"旧版本数据"，而是"读错了位置"。
        // 与 agent/app/main.js 的 loadSettings 同款处理，两处必须一致（否则又是一处漏改）。
        console.warn('[Agent] settingsStore 不可用，loadSettings 返回默认值（不再读 localStorage 旧形状）');
        return {
            ...(globalDefaults || {}),
            ...(moduleDefaults || {}),
            model: (models && models.openrouter && models.openrouter[0]) || ''
        };
    }

    async function saveSettings(options) {
        const opts = options || {};
        const {
            settings,
            moduleContext,
            moduleId,
            openHeightPx,
            clampScriptListHeight
        } = opts;

        const normalized = {
            ...(settings || {}),
            scriptListHeight: clampScriptListHeight((settings || {}).scriptListHeight, openHeightPx)
        };
        // 一致性（含老盘迁移）：在归一 team 段**之前**跑，且 team 段先浅拷贝——
        // applyModeConsistency 会重建成新对象，但 `normalized.team` 与入参 settings.team 是同一个
        // 引用，不拷贝就会把调用方（UI 采集路径）手里的对象也改掉。
        normalized.team = Object.assign({}, (settings || {}).team);
        _applyModeConsistencyForSave(normalized);
        // 团队段：**必须进白名单**。store.setModuleSettings 的入参是显式字段表——漏掉它，
        // 团队开关与 lane 参数就只活在内存里，重启后面板回到默认（团队静默关闭）。
        // 归一转发 engine/settings.js 的 normalizeTeam（唯一实现，不在这里兜第二份默认值）。
        const teamNormalized = _normalizeTeamForSave(normalized.team, normalized.runtimeMode);

        const store = getSettingsStore(moduleContext);
        if (store && typeof store.setModuleSettings === 'function') {
            // 透传写盘结果（false = localStorage 配额满/加密异常，见 settingsStore.writeRaw）。
            // await 后不看返回值、恒 resolve undefined 时——调用方（保存按钮/即时保存）
            // 误判成功弹「模块设置已保存」，实际重启后回退。
            return await store.setModuleSettings(moduleId, {
                flowAnimOffsetMs: normalized.flowAnimOffsetMs,
                airsAnimOffsetMs: normalized.airsAnimOffsetMs,
                providerId: '',
                modelId: '',
                platform: '',
                model: '',
                customModel: '',
                skipRunConfirm: !!normalized.skipRunConfirm,
                scriptListHeight: normalized.scriptListHeight,
                runtimeMode: normalized.runtimeMode,
                executionTimeoutMs: _normExecutionTimeoutMs(normalized.executionTimeoutMs),
                requestTimeoutMs: _normRequestTimeoutMs(normalized.requestTimeoutMs),
                maxContextTokens: normalized.maxContextTokens,
                reasoningEffort: ['low', 'medium', 'high', 'xhigh'].indexOf(normalized.reasoningEffort) >= 0 ? normalized.reasoningEffort : 'high',
                permissionMode: ['auto', 'balanced', 'conservative'].indexOf(normalized.permissionMode) >= 0 ? normalized.permissionMode : 'balanced',
                permissionConfirmTimeoutMs: _normPermissionConfirmTimeoutMs(normalized.permissionConfirmTimeoutMs),
                askUserTimeoutMs: _normAskUserTimeoutMs(normalized.askUserTimeoutMs),
                previewDraft: String(normalized.previewDraft || ''),
                shaderDraft: String(normalized.shaderDraft || ''),
                userPersona: normalized.userPersona || '',
                agentScriptReview: !!normalized.agentScriptReview,
                shaderJsReview: !!normalized.shaderJsReview,
                allowCloudModels: !!normalized.allowCloudModels,
                maxLlmStubTools: _normMaxLlmStubTools(normalized.maxLlmStubTools),
                // 目标默认轮数上限（显式字段表：漏掉它，用户改的值只活在内存、重载面板后丢）
                goalDefaultMaxRounds: _normGoalDefaultMaxRounds(normalized.goalDefaultMaxRounds),
                webSearchEnabled: normalized.webSearchEnabled !== false,
                deferInjectUntilReply: !!normalized.deferInjectUntilReply,
                confirmExternalLink: normalized.confirmExternalLink !== false,
                confirmPathOpen: normalized.confirmPathOpen !== false,
                // 团队段（开关 + 四条 lane 的模型/平台/思考等级 + 子 Agent 闸）
                team: teamNormalized,
                // 工具可见性用户覆盖：显式字段表 + 落盘前归一（转发 engine 唯一实现）。
                // 漏掉它 = 用户配置只在内存里、重载面板回默认（「改了不生效」）。
                toolVisibility: _normToolVisibility(normalized.toolVisibility),
                _migratedFromAeAgent: true
            });
        }

        // 设置仓库不可用：**不再直写 localStorage**，只告警。
        // `localStorage.setItem(settingsKey, …)` 直写的是**与 settingsStore 同一个 key**
        //（`ae_llm_tool_settings_v3`）的**扁平形状**，而 store 在该 key 下存的是
        // `{global:{…}, modules:{…}}`——一旦真的走到这里，会把整个存储载荷覆盖成扁平对象，
        // **连带清掉全局设置与其它所有模块的设置**（比"读错位置"严重得多：那是读不到，
        // 这是砸掉数据）。全局设置那边用**独立 key** 的 patch（`ae_global_settings_patch_v1`）
        // 正是为了避开这一点，唯独这里写进了共享 key。
        // 读侧兜底返回默认值（见上方 loadSettings），故这里的写入也不再有任何读者
        // ——写了没人读、还会砸掉别人的数据，两头都不成立，直接去掉。
        console.warn('[Agent] settingsStore 不可用，设置无法持久化（已跳过直写，避免覆盖存储载荷）；'
            + '本次修改仅存在于内存，重载面板后丢失');
        // 如实返回失败——调用方据此弹错误提示，不再默默弹「已保存」
        return false;
    }

    function applySettingsToUI(options) {
        const opts = options || {};
        const {
            settings,
            clampScriptListHeight,
            scriptListUiState,
            statusState,
            applyThemeFromSettings
        } = opts;
        // refreshModelOptions 使用 IIFE 内部版本，不依赖外部注入

        const s = settings || {};
        const skipRunConfirm = document.getElementById('skipRunConfirm');
        const executionTimeoutMs = document.getElementById('executionTimeoutMs');
        const maxContextTokens = document.getElementById('maxContextTokens');
        const flowAnimOffsetMs = document.getElementById('flowAnimOffsetMs');
        const airsAnimOffsetMs = document.getElementById('airsAnimOffsetMs');
        const runtimeMode = document.getElementById('runtimeMode');

        if (skipRunConfirm) skipRunConfirm.checked = !!s.skipRunConfirm;
        if (executionTimeoutMs) executionTimeoutMs.value = (s.executionTimeoutMs || 30000) / 1000;
        const permissionConfirmTimeoutMs = document.getElementById('permissionConfirmTimeoutMs');
        if (permissionConfirmTimeoutMs) permissionConfirmTimeoutMs.value = (s.permissionConfirmTimeoutMs !== undefined ? s.permissionConfirmTimeoutMs : 30000) / 1000;
        const askUserTimeoutMs = document.getElementById('askUserTimeoutMs');
        if (askUserTimeoutMs) askUserTimeoutMs.value = (s.askUserTimeoutMs !== undefined ? s.askUserTimeoutMs : 300000) / 1000;
        const requestTimeoutMs = document.getElementById('requestTimeoutMs');
        // 回填经共享归一——磁盘遗留 600 秒旧值显示为夹取后的 300，与落盘/引擎一致
        if (requestTimeoutMs) requestTimeoutMs.value = _normRequestTimeoutMs(s.requestTimeoutMs) / 1000;   // UI 单位是秒，内部字段仍毫秒
        if (maxContextTokens) maxContextTokens.value = formatTokenValue(s.maxContextTokens);
        // 生效上限来源提示（模型自报窗口 / 手填兜底）：面板每次打开按当前口径刷一次；
        // 保存与切模型时由 bridge.syncMaxContextTokens 侧再刷（engine 的 _updateCtxWindowHint）
        if (window.AEEngine && window.AEEngine.bridge
            && typeof window.AEEngine.bridge.refreshCtxWindowHint === 'function') {
            window.AEEngine.bridge.refreshCtxWindowHint();
        }
        if (flowAnimOffsetMs) flowAnimOffsetMs.value = s.flowAnimOffsetMs || 0;
        if (airsAnimOffsetMs) airsAnimOffsetMs.value = s.airsAnimOffsetMs || 0;
        if (runtimeMode) runtimeMode.value = s.runtimeMode || 'script';
        var allowCloudModelsEl = document.getElementById('allowCloudModels');
        if (allowCloudModelsEl) allowCloudModelsEl.checked = !!s.allowCloudModels;
        var webSearchEnabledEl = document.getElementById('webSearchEnabled');
        if (webSearchEnabledEl) webSearchEnabledEl.checked = !!s.webSearchEnabled;
        var maxLlmStubToolsEl = document.getElementById('maxLlmStubTools');
        if (maxLlmStubToolsEl) maxLlmStubToolsEl.value = _normMaxLlmStubTools(s.maxLlmStubTools);
        // 目标默认轮数上限：保存后就地回填，用户不必重开面板才看到生效值
        var goalDefaultMaxRoundsEl = document.getElementById('goalDefaultMaxRounds');
        if (goalDefaultMaxRoundsEl) goalDefaultMaxRoundsEl.value = _normGoalDefaultMaxRounds(s.goalDefaultMaxRounds);
        // 工具执行权限：定位工具栏 strip（与 reasoningEffort 同机制）
        var permLevels = ['auto', 'balanced', 'conservative'];
        var permIdx = permLevels.indexOf(s.permissionMode);
        if (permIdx < 0) permIdx = 1;
        var permStripEl = document.getElementById('permissionModeStrip');
        if (permStripEl) {
            permStripEl.style.transform = 'translateY(' + (-permIdx * 18) + 'px)';
        }
        // 思考滚轮：团队档显示当前 Agent 的配置，单 Agent 显示全局值（同一写点，见 _syncThinkingWheel）
        _syncThinkingWheel(s);

        scriptListUiState.openHeightPx = clampScriptListHeight(s.scriptListHeight, 320);
        statusState.debugMode = !!s.debugMode;

        const globalDebugToggle = document.getElementById('globalDebugToggleBtn');
        if (globalDebugToggle) {
            globalDebugToggle.checked = statusState.debugMode;
        }

        var userPersonaEl = document.getElementById('userPersonaInput');
        if (userPersonaEl) { userPersonaEl.value = s.userPersona || ''; }

        var agentScriptReviewEl = document.getElementById('agentScriptReview');
        if (agentScriptReviewEl) agentScriptReviewEl.checked = !!s.agentScriptReview;

        var shaderJsReviewEl = document.getElementById('shaderJsReview');
        if (shaderJsReviewEl) shaderJsReviewEl.checked = !!s.shaderJsReview;

        var confirmExternalLinkEl = document.getElementById('confirmExternalLink');
        if (confirmExternalLinkEl) confirmExternalLinkEl.checked = s.confirmExternalLink !== false;

        var confirmPathOpenEl = document.getElementById('confirmPathOpen');
        if (confirmPathOpenEl) confirmPathOpenEl.checked = s.confirmPathOpen !== false;

        var deferInjectUntilReplyEl = document.getElementById('deferInjectUntilReply');
        if (deferInjectUntilReplyEl) deferInjectUntilReplyEl.checked = !!s.deferInjectUntilReply;

        // 工具可见性回填：隐藏输入是子面板草稿的载体，保存后按**归一后的已生效值**
        // 重写一次，用户不必重开设置页。值来自归一结果，序列化包 try 只为不让一次异常
        // 打断整页回填。
        var toolVisibilityInputEl = document.getElementById('toolVisibilityInput');
        if (toolVisibilityInputEl) {
            var tvBackfill = _normToolVisibility(s.toolVisibility);
            if (tvBackfill && typeof tvBackfill === 'object') {
                try { toolVisibilityInputEl.value = JSON.stringify(tvBackfill); } catch (_) {}
            }
        }

        // 团队段回填（四条 lane 的模型/平台/思考等级 + 子 Agent 闸）：设置页是按钮驱动的
        // 表单，保存后就地回填，用户不必关掉重开才能看到生效值。
        var teamSnapForUi = null;
        try {
            var tsUi = window.AEAgentTeam && window.AEAgentTeam.settings;
            teamSnapForUi = (tsUi && typeof tsUi.snapshot === 'function') ? tsUi.snapshot(s) : null;
        } catch (_) { teamSnapForUi = null; }
        if (teamSnapForUi) {
            var uiLanes = teamLaneDefs();
            for (var ti = 0; ti < uiLanes.length; ti++) {
                var lcfg = (teamSnapForUi.lanes && teamSnapForUi.lanes[uiLanes[ti].id]) || {};
                // 模型走唯一写点 _setTeamLaneModel（隐藏输入 + 可见按钮文案一起更新）；
                // 平台是隐藏输入（不单独展示），同样由唯一写点 _setTeamLanePlatform 回填。
                _setTeamLanePlatform(uiLanes[ti].id, lcfg.platform || '');
                var mEl = document.getElementById('teamLaneModel_' + uiLanes[ti].id);
                if (mEl) _setTeamLaneModel(uiLanes[ti].id, lcfg.model || '');
                var eEl = document.getElementById('teamLaneEffort_' + uiLanes[ti].id);
                if (eEl) eEl.value = lcfg.reasoningEffort || 'high';
            }
            var sub = teamSnapForUi.subagent || {};
            var subMaxEl = document.getElementById('teamSubagentMaxConcurrent');
            if (subMaxEl) subMaxEl.value = Number(sub.maxConcurrent) || 0;
            var keepEl = document.getElementById('teamSubagentKeepAliveMin');
            if (keepEl) keepEl.value = keepAliveMsToMinutes(sub.keepAliveMs);
        }

        applyThemeFromSettings(s);
    }

    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.settings = {
        resolveModuleSettings,
        getSettingsStore,
        loadSettings,
        saveSettings,
        applySettingsToUI,
        // 团队段：设置面板 → team 段对象的采集入口（字段 id 只在这里出现一次）
        readTeamFromUI,
        teamLaneDefs,
        // 团队 lane 的模型选择器（设置页 UI 单测用：候选快照筛选、点击提交后模型/平台成对写入）
        teamLaneProviders,
        setTeamLaneModel: _setTeamLaneModel,
        setTeamLanePlatform: _setTeamLanePlatform,
        bindTeamLaneModelPickers: bindTeamLaneModelPickers,
        openTeamLaneModelPicker: openTeamLaneModelPicker,
        closeTeamLaneModelPicker: closeTeamLaneModelPicker,
        // 静态工具栏「思考」滚轮：团队档 = 当前 Agent 的思考等级（main.js 的采集判据与单测共用）
        teamThinkingContext: _teamThinkingContext,
        thinkingWheelEffort: _thinkingWheelEffort,
        syncThinkingWheel: _syncThinkingWheel,
        persistLaneThinkingEffort: _persistLaneThinkingEffort,
        // 单一归一口径（采集/落盘共用；engine 未加载时同口径兜底）
        normalizeExecutionTimeoutMs: _normExecutionTimeoutMs,
        normalizeRequestTimeoutMs: _normRequestTimeoutMs,
        normalizePermissionConfirmTimeoutMs: _normPermissionConfirmTimeoutMs,
        normalizeAskUserTimeoutMs: _normAskUserTimeoutMs,
        // 目标默认轮数上限（1..500）：设置行回填/保存/采集共用；采集读法单独导出便于接线与单测
        normalizeGoalDefaultMaxRounds: _normGoalDefaultMaxRounds,
        readGoalDefaultMaxRoundsFromUI: readGoalDefaultMaxRoundsFromUI
    };
function openSettingsModal() {
    const mask = document.getElementById('settingsModal');
    if (!mask) return;
    const modal = mask.querySelector('.modal');
    if (!modal) return;

    // 直接替换，各模块统一用 innerHTML，不需维护互斥 ID 列表
    var modalBody = mask.querySelector('.modal-body');
    if (modalBody) {
        modalBody.innerHTML = buildLlmSettingsHtml(cachedSettings);
    }
    // 设置项输入随本次 innerHTML 注入，字段绑定（组合框/下拉高亮）必须在 DOM 构建完成后执行
    // （settingsPanel.bind 在模块 init 时执行，彼时 modal-body 为空，绑定全部落空）
    bindSettingsInputsOnChange();
    // 同步 debug 选项可见性（动态注入的 DOM 不会自动应用当前 debug 状态）
    syncDebugOnlySettingsVisibility();

    // 绑定保存按钮
    var saveBtn = document.getElementById('llmSaveSettingsBtn');
    if (saveBtn) saveBtn.addEventListener('click', handleSaveSettings);
    // 绑定人格描述按钮
    var personaBtn = document.getElementById('userPersonaBtn');
    if (personaBtn) personaBtn.addEventListener('click', function () {
        var input = document.getElementById('userPersonaInput');
        var currentVal = input ? input.value : '';
        _showPersonaEditor(currentVal, function (newVal) {
            if (newVal !== null && input) {
                input.value = newVal;
            }
        });
    });
    // 绑定关于按钮
    var aboutBtn = document.getElementById('llmAboutModuleBtn');
    if (aboutBtn) aboutBtn.addEventListener('click', function () { showAboutModal('module', { name: AEI18n.t('Agent 模块'), desc: AEI18n.t('LLM 驱动的 AE 智能体：编写 ExtendScript 脚本、操控 AE 工程、创作 GLSL 视觉效果，并支持多轮对话协作') }); });

    // 绑定 AST 门能力配置入口（通道信任/能力域/危险脚本记忆统一配置面）
    var gateBtn = document.getElementById('llmGateConfigBtn');
    if (gateBtn) gateBtn.addEventListener('click', function () { showGateConfigModal(); });

    // 绑定「工具可见性…」入口（openSettingsModal 一处）：
    // 子面板 app/toolVisibilityPanel.js 按存在性接线——存在则调 open()；
    // 不存在（装配面残缺/旧包）则禁用 + 段内常驻 .st-field-hint 说明，绝不静默吞点击。
    var tvOpenBtn = document.getElementById('toolVisibilityOpenBtn');
    if (tvOpenBtn) {
        var tvPanelApi = null;
        try { tvPanelApi = (global.AE_LLM && global.AE_LLM.ToolVisibilityPanel) || null; } catch (_) { tvPanelApi = null; }
        if (tvPanelApi && typeof tvPanelApi.open === 'function') {
            tvOpenBtn.addEventListener('click', function () {
                if (typeof global.aeBeep === 'function') global.aeBeep('open');
                try { tvPanelApi.open(); } catch (e) {
                    console.error('[AgentSettings] 打开工具可见性面板失败: ' + (e && (e.stack || e.message) || e));
                    if (global.AEToast) global.AEToast.show(AEI18n.t('工具可见性面板打开失败: ') + (e && e.message ? e.message : e), 'error');
                }
            });
        } else {
            tvOpenBtn.disabled = true;
            tvOpenBtn.title = AEI18n.t('工具可见性配置面板尚未装配');
            // disabled 按钮的 title 在 CEF 不可靠：同时点亮段内常驻的 .st-field-hint 说明
            //（面板缺席时用户找不到配置入口）。
            var tvAssemblyHint = document.getElementById('toolVisibilityAssemblyHint');
            if (tvAssemblyHint) tvAssemblyHint.hidden = false;
        }
    }

    (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.loadPrismJs === 'function' ? window.AEAgentApp.llmService.loadPrismJs : function(cb){ if(cb) cb(); })(function () {
        setTimeout(function () { try { (window.AEAgentApp && window.AEAgentApp.llmService && typeof window.AEAgentApp.llmService.highlightCode === 'function' ? window.AEAgentApp.llmService.highlightCode : function(){})(true); } catch (e) {} }, 100);
    });

    // 代际递增——使关闭动画在途的迟到 finalize 失效（关闭后 170ms 内重开场景）
    modalAnimationState.gen = (modalAnimationState.gen || 0) + 1;
    modalAnimationState.closing = false;
    // ×按钮是双 handler：main.js 常驻 closeModal('settingsModal') 的 220ms 隐藏定时器
    // 与本模块关闭动画同时在途。 只作废了本模块代际；重开还须走 openModal 递增
    // main 侧 _modalGen 作废那条迟到定时器，否则 220ms 内重开的弹窗仍会被
    // display='none' 藏掉（对齐 comfyui view.js showSettingsModal 的修复方式）。
    // 入场动画保留 anime：本模块关闭走 anime 逐帧写 opacity，重开落在关闭动画
    // 在途窗口时需靠新 anime 持续覆写，openModal 的一次性 rAF 写入压不过它
    if (typeof global.openModal === 'function') {
        global.openModal('settingsModal');
    }
    mask.style.display = 'flex';
    mask.style.opacity = '0';
    modal.style.opacity = '0';
    modal.style.transform = 'translateY(10px) scale(.98)';

    if (typeof window.anime === 'function') {
        window.anime({ targets: mask, opacity: [0, 1], duration: 180, easing: 'linear' });
        window.anime({ targets: modal, opacity: [0, 1], translateY: [10, 0], scale: [0.98, 1], duration: 240, easing: 'easeOutCubic' });
    } else {
        mask.style.opacity = '1';
        modal.style.opacity = '1';
        modal.style.transform = 'translateY(0) scale(1)';
    }
}


function closeSettingsModal() {
    var container = document.getElementById(LLM_SETTINGS_CONTAINER);
    // 容器不存在 = 共享遮罩内不是本模块的设置（其他模块 open 均 innerHTML 整体替换，
    // llmSettingsContainer 已随之销毁）或本模块设置已关闭。×按钮的 agent 侧 handler
    // 一次性绑定且不随模块卸载移除（closeSettingsBtn 是 index.html 静态共享 DOM），
    // 若无此守卫：其他模块设置弹窗点 × 会同时排入本模块 170ms 延迟 finalize，该模块
    // 随后经 openModal 重开（只递增 main 侧 _modalGen，不递增 agent 代际），迟到的
    // finalize 会把刚重开的弹窗 display='none' 藏掉。遮罩关闭统一交给 main.js closeModal。
    if (!container) return;
    if (container.parentNode) container.parentNode.removeChild(container);

    const mask = document.getElementById('settingsModal');
    if (!mask) return;
    const modal = mask.querySelector('.modal');
    if (!modal) return;

    if (mask.style.display === 'none' || modalAnimationState.closing) return;

    modalAnimationState.closing = true;

    // 代际守卫（对齐 main.js openModal/closeModal 的 _modalGen 模式）——close 捕获
    // 当前代际，finalize 开头校验代际未变才执行；关闭动画 170ms 内重开时
    // openSettingsModal 已递增代际并恢复 display='flex'，迟到的 finalize 跳过，
    // 不再把已重开的弹窗隐藏（表现为"点了设置没反应"）。
    const gen = modalAnimationState.gen = (modalAnimationState.gen || 0) + 1;

    const finalize = () => {
        if (modalAnimationState.gen !== gen) return;
        mask.style.display = 'none';
        mask.style.opacity = '0';
        modal.style.opacity = '0';
        modal.style.transform = 'translateY(10px) scale(.98)';
        modalAnimationState.closing = false;
    };

    if (typeof window.anime === 'function') {
        window.anime({ targets: modal, opacity: [1, 0], translateY: [0, 8], scale: [1, 0.985], duration: 180, easing: 'easeInCubic' });
        window.anime({ targets: mask, opacity: [1, 0], duration: 170, easing: 'linear', complete: finalize });
    } else {
        finalize();
    }
}

// 人格编辑弹窗的最后一步按钮是**「确认」不是「保存」**：
// 它只把文案写回面板字段（userPersonaInput），落盘统一归设置面板的「保存模块设置」——
// 叫「保存」会让人以为点了就已经存了，与纯按钮驱动的面板语义打架。
function _showPersonaEditor(currentVal, onSave) {
    var existing = document.getElementById('personaEditorModal');
    if (existing) existing.parentNode.removeChild(existing);

    var overlay = document.createElement('div');
    overlay.className = 'modal-mask';
    overlay.id = 'personaEditorModal';
    overlay.style.display = 'flex';
    overlay.style.opacity = '1';
    overlay.style.zIndex = '110';

    var box = document.createElement('div');
    box.className = 'modal persona-editor-modal';
    box.style.opacity = '1';
    box.style.transform = 'none';

    box.innerHTML =
        AEI18n.html('<div class="modal-head"><span>编辑 Agent 人格描述</span><button class="icon-btn" id="personaEditorCloseBtn">关闭</button></div>')
        + '<div class="modal-body">'
        + AEI18n.html('<textarea id="personaEditorTextarea" rows="8" placeholder="描述 Agent 的性格、语气、专业领域等，留空则使用默认人格。"></textarea>')
        + '</div>'
        + '<div class="btn-row" style="justify-content:flex-end;">'
        + AEI18n.html('<button class="btn" id="personaEditorSaveBtn">确认</button>')
        + '</div>';

    overlay.appendChild(box);
    document.body.appendChild(overlay);

    var textarea = document.getElementById('personaEditorTextarea');
    if (textarea) {
        textarea.value = currentVal || '';
        textarea.focus();
    }

    // 关闭时必须同步移除 document 级 Esc 监听：经「保存/关闭」按钮退出时监听器
    // 不会随 overlay 移除而消失，残留监听在下次按 Esc 时对已脱离 DOM 的 overlay
    // 调 removeChild（parentNode 为 null）抛 TypeError，且多次打开会持续累积泄漏。
    var escHandler = function (e) {
        if (e.key === 'Escape') {
            close();
        }
    };
    function close() {
        document.removeEventListener('keydown', escHandler);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }

    var closeBtn = document.getElementById('personaEditorCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    var saveBtn = document.getElementById('personaEditorSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', function () {
        var val = textarea ? textarea.value : '';
        close();
        if (onSave) onSave(val);
    });
    document.addEventListener('keydown', escHandler);
}

function buildLlmSettingsHtml(settings) {
    var s = settings || cachedSettings || {};
    var esc = function (v) { return String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
    // 开关项统一模板：名称在左、滑块在右；title 承载悬浮说明，danger 额外标注 ⚠
    var toggle = function (id, name, title, checked, danger) {
        return '<label class="toggle-wrap st-toggle" title="' + esc(title) + '">'
            + '<span class="st-toggle-name">' + name + (danger ? '<span class="st-danger-mark">⚠</span>' : '') + '</span>'
            + '<input type="checkbox" id="' + id + '" class="switch-input"' + (checked ? ' checked' : '') + '>'
            + '<span class="switch-slider" aria-hidden="true"></span></label>';
    };
    var h = '<div id="' + LLM_SETTINGS_CONTAINER + '">';

    // ===== 分组：运行参数 =====
    h += AEI18n.html('<div class="st-section"><div class="st-section-title">运行参数</div><div class="st-grid">');
    // 执行超时（描述放 hover title）
    h += AEI18n.html('<div class="st-field" title="单个 AE 工具调用的等待上限（默认 30 秒，3–120）。超时按失败上报，AE 侧操作不会中断"><label for="executionTimeoutMs">执行超时（秒）</label><input type="number" id="executionTimeoutMs" min="3" max="120" step="1" value="') + ((s.executionTimeoutMs || 30000) / 1000) + '"></div>';
    // 确认等待超时（描述放 hover title）
    h += AEI18n.html('<div class="st-field" title="权限确认弹窗的等待上限（默认 30 秒，0 = 不超时）。超时后待确认操作按拒绝处理"><label for="permissionConfirmTimeoutMs">确认等待超时（秒）</label><input type="number" id="permissionConfirmTimeoutMs" min="0" max="300" step="1" value="') + ((s.permissionConfirmTimeoutMs !== undefined ? s.permissionConfirmTimeoutMs : 30000) / 1000) + '"></div>';
    // 提问等待超时（askUser 问答卡；描述放 hover title）
    h += AEI18n.html('<div class="st-field" title="Agent 调用 askUser 向你提问时的等待上限（默认 300 秒，0 = 不超时）。超时后工具返回未回答，Agent 可换问法或自行决定"><label for="askUserTimeoutMs">提问等待超时（秒）</label><input type="number" id="askUserTimeoutMs" min="0" max="3600" step="10" value="') + ((s.askUserTimeoutMs !== undefined ? s.askUserTimeoutMs : 300000) / 1000) + '"></div>';
    // Agent 请求超时（描述放 hover title）
    h += AEI18n.html('<div class="st-field" title="单次 LLM 请求的等待上限（默认 120 秒，10–300）"><label for="requestTimeoutMs">Agent 请求超时（秒）</label><input type="number" id="requestTimeoutMs" min="10" max="300" step="5" value="') + (_normRequestTimeoutMs(s.requestTimeoutMs) / 1000) + '"></div>';
    // 上下文 Token 上限：可输入 + 可下拉选预设（同一控件）。
    // 下拉用**原生 select 盖在箭头上**实现，而不是 `<input list>`+datalist：面板跑在老 CEF 上，
    // 那里既没有原生箭头、也没有 showPicker()，datalist 只能靠"打字"才出候选（用户实测「无法点击下拉」）。
    // 原生 select 的下拉在面板里其它字段上一直是好的，故沿用。
    // 候选档位只留 128K 及以上。
    // 低档位不是被禁掉，是**不再作为候选推荐**：输入框仍接受手填 2000 ~ 1000000，小窗口的本地
    // 模型照样能用；但低档位下「一轮工具结果超过整个上限」的概率高得多（实测：32K 档一次批量读
    // 两个 2 万字文件、或单条顶格中文结果即触发整段历史被裁空），
    // 不该摆在默认候选里。
    // 本字段语义：它**只在服务商未上报模型窗口时生效**（兜底值），
    // 默认 256K。档位顺序把 256K 放最前（对应新默认），其余档位保持可手填。
    var tokenOpts = [256000, 128000, 512000, 1000000];
    h += AEI18n.html('<div class="st-field"><label for="maxContextTokens">上下文 Token 兜底上限</label>')
        + '<div class="st-combo-wrap">'
        + '<input type="text" id="maxContextTokens" class="st-combo"'
        + ' value="' + formatTokenValue(s.maxContextTokens) + '"'
        + ' autocomplete="off" spellcheck="false" placeholder="' + AEI18n.t('如 128K / 200000 / 1M') + '"'
        + ' title="' + AEI18n.t('范围 2000–1000000，支持 200000 / 200K / 0.5M 写法') + '">'
        + AEI18n.html('<select id="maxContextTokensPicker" class="st-combo-picker" tabindex="-1" aria-label="选择预设值" title="">');
    // 不放空占位项：自定义下拉会为每个 option 生成一行，空串那行会渲成一条"奇怪的顶栏"
    tokenOpts.forEach(function (v) { h += '<option value="' + formatTokenValue(v) + '">' + formatTokenValue(v) + '</option>'; });
    // 生效值来源的**可见**提示（由 engine/bootstrap 的 _updateCtxWindowHint 实时写入）：
    // 用户必须能看出「当前生效上限是多少、来自模型窗口还是手填兜底」，否则「填了却没起作用」无从察觉。
    // 样式复用既有字段说明类 `.st-field-hint`（common.css:110，跟本面板 st-field 同一祖先作用域），
    // 不新开样式面也不内联硬编码。
    h += '</select></div>'
        + '<div class="st-field-hint" id="maxContextTokensHint"></div>'
        + '</div>';
    // 工具上限：注入 LLM 的工具数量上限（核心工具不占名额），防上万个自定义 AE 工具撑爆
    // prompt。**不在这里报「当前待注入 N 个」**——取
    // toolRegistry.getStubCount('agent')——那只是 Agent 单视图身份模块的注册表口径，用户放宽
    // director/asset-gen 后与实际不符；准确计数要按当前视图 + 用户草稿现算，放在
    // 「工具可见性」子面板的统计行（超上限提示）。这里只给说明性文案。
    h += AEI18n.html('<div class="st-field" title="单轮注入 LLM 的工具数上限（核心工具不占名额；0 = 不限制）。超出上限的工具本轮不注入，仍可经 tool_search 取回完整定义">')
        + AEI18n.html('<label for="maxLlmStubTools">工具上限</label>')
        + '<input type="number" id="maxLlmStubTools" min="0" max="10000" step="50" value="' + _normMaxLlmStubTools(s.maxLlmStubTools) + '"></div>';
    // 目标默认轮数上限：goal 自动续轮时 create_goal 不带 max_goal_rounds 的缺省值。
    // 单个目标可用 max_goal_rounds 覆盖，故 tooltip 只讲范围与来源。控件沿用本页既有
    // .st-field + type=number 行，不新增样式面。
    h += AEI18n.html('<div class="st-field" title="长期目标自动续轮的默认轮数上限（1–500，默认 25）；单个目标可用 max_goal_rounds 覆盖"><label for="goalDefaultMaxRounds">目标默认轮数上限</label><input type="number" id="goalDefaultMaxRounds" min="1" max="500" step="1" value="') + _normGoalDefaultMaxRounds(s.goalDefaultMaxRounds) + '"></div>';
    // 「Shader 预览帧率（fps）」设置项已整体移除（理由「彻底移除，预览
    // 按照 30FPS」）：预览解算帧率固定 30fps，真源 = engine/settings.js 的
    // AEEngine.settings.PREVIEW_FPS（唯一常量，渲染器直接引用它）。该值只喂 shader
    // 预览渲染器，且不再可配置，故面板上不保留任何入口（旧盘残留键读时丢弃）。
    h += '</div></div>';
    // 工具执行权限已移至输入框上方工具栏（思考强度左侧），此处不再渲染

    // ===== 分组：权限与功能 =====
    h += AEI18n.html('<div class="st-section"><div class="st-section-title">权限与功能</div><div class="st-toggle-grid">');
    h += toggle('skipRunConfirm', AEI18n.t('运行脚本免确认'), AEI18n.t('运行脚本不再弹二次确认'), s.skipRunConfirm);
    // 「脚本权限」开关已收割（对齐落定 3——直接删除无迁移）：能力域
    // 语义统一收敛到「AST 门能力配置」弹窗（ast-gate/config.js）
    h += toggle('agentScriptReview', AEI18n.t('工具代码审查'), AEI18n.t('执行自定义 ExtendScript 前先过 LLM 安全审查（每次多一次模型调用）'), s.agentScriptReview);
    h += toggle('shaderJsReview', AEI18n.t('Shader JS 审查'), AEI18n.t('shader 模式生成的 JS 效果代码先经 LLM 安全审查再执行（默认开启）'), s.shaderJsReview);
    h += toggle('allowCloudModels', AEI18n.t('云端模型'), AEI18n.t('允许 LLM 使用 ComfyUI 云端模型（消耗账户积分）'), s.allowCloudModels);
    h += toggle('webSearchEnabled', AEI18n.t('联网搜索'), AEI18n.t('允许 Agent / Script / Shader 模式经 search_web 工具联网搜索实时信息'), s.webSearchEnabled);
    h += toggle('confirmExternalLink', AEI18n.t('链接确认'), AEI18n.t('点击外部链接前弹确认框；关闭则直接交给系统浏览器'), s.confirmExternalLink !== false);
    // 聊天区本地路径点击：默认弹确认，关闭 = 单击直开所在目录并选中文件
    h += toggle('confirmPathOpen', AEI18n.t('路径打开确认'), AEI18n.t('点击聊天中的本地路径前弹确认框；关闭则直接打开所在文件夹并选中文件'), s.confirmPathOpen !== false);
    // 待发送消息派发时机：悬浮待发送队列里的消息是下一轮 LLM 请求前就
    // 注入，还是等当前轮 Agent 给出正式回复后再作为新一轮发送。开关形态与本节其余项一致。
    h += toggle('deferInjectUntilReply', AEI18n.t('待发送消息等回复后发送'), AEI18n.t('开启：执行中追加的消息等本轮正式回复后再作为新一轮发送；关闭：下一轮 LLM 请求前就注入（默认）'), s.deferInjectUntilReply);
    h += '</div></div>';

    // ===== 分组：Agent 人格 =====
    h += AEI18n.html('<div class="st-section"><div class="st-section-title">Agent 人格</div>');
    h += '<div class="st-persona-row">'
        + AEI18n.html('<div class="st-persona-text"><span class="st-persona-label">人格描述</span><span class="row-hint">Agent 的性格、语气与专业领域，留空使用默认人格</span></div>')
        + AEI18n.html('<button class="btn secondary" id="userPersonaBtn">编辑人格描述</button>')
        + '<input type="hidden" id="userPersonaInput" value="' + esc(s.userPersona || '') + '">'
        + '</div></div>';

    // ===== 分组：团队模式 =====
    // 四条 lane 的模型 / 平台 / 思考等级 + 子 Agent 闸（上限与保活）。
    // **不设温度项、不做温度提示**（默认平台的思考模式不接受
    // temperature，发了不报错也不生效）；「导演发散 / 执行收敛」由提示词身份段与工具收窄承担。
    // 团队开关本身不在设置页（唯一入口在聊天区顶部顶栏，见 app/teamUI.js）——两处开关必然漂移。
    // **默认折叠**：这一段有 4 条 lane × 3 个字段 + 子 Agent 闸共 14 个控件，
    // 展开会把整页撑得很长；用原生 `<details>`（无 JS、键盘可达），缺省不带 open ⇒ 折叠。
    // 折叠只影响**显示**：字段仍在 DOM 里，getCurrentSettingsFromUI 照旧读到值。
    h += AEI18n.html('<details class="st-section st-collapsible"><summary class="st-section-title">团队模式（四条常驻 Agent）</summary>');
    var laneDefs = teamLaneDefs();
    if (!laneDefs.length) {
        h += AEI18n.html('<div class="st-field-hint">团队装配面未加载（team/lanes.js 缺席），暂时无法配置 Agent 参数。</div>');
    } else {
        var teamSnap = (function () {
            try {
                var ts = window.AEAgentTeam && window.AEAgentTeam.settings;
                return (ts && typeof ts.snapshot === 'function') ? (ts.snapshot(s) || {}) : {};
            } catch (_) { return {}; }
        })();
        var teamLanesCfg = teamSnap.lanes || {};
        var teamSub = teamSnap.subagent || {};
        h += '<div class="st-team-grid">';
        for (var li = 0; li < laneDefs.length; li++) {
            var lane = laneDefs[li];
            var lc = teamLanesCfg[lane.id] || {};
            h += '<div class="st-team-lane" data-lane="' + esc(lane.id) + '">';
            h += '<div class="st-team-lane-title">' + esc(lane.label) + '</div>';
            // 模型：点击弹窗选（候选可能有上千条，普通下拉放不下）。平台不再单独出现——
            // 用户只需选模型，弹窗按平台分组、点行时把所属平台一并写进隐藏输入（字段契约不变；
            // 模型 ID 只在平台内唯一，所以储存侧仍是「模型 + 平台」成对）。
            h += AEI18n.html('<div class="st-field" title="点击选择模型；留空 = 跟随「模型管理」的全局默认模型"><label>模型</label>')
                + '<button type="button" class="st-pick" id="teamLaneModelPick_' + esc(lane.id) + '"'
                + ' data-lane="' + esc(lane.id) + '" aria-haspopup="dialog">'
                + '<span class="st-pick-text' + (lc.model ? '' : ' is-empty') + '">' + esc(lc.model || AEI18n.t('跟随全局默认')) + '</span>'
                + '<span class="st-pick-arrow" aria-hidden="true">▾</span></button>'
                + '<input type="hidden" id="teamLaneModel_' + esc(lane.id) + '" value="' + esc(lc.model || '') + '">'
                + '<input type="hidden" id="teamLanePlatform_' + esc(lane.id) + '" value="' + esc(lc.platform || '') + '"></div>';
            h += AEI18n.html('<div class="st-field" title="该 Agent 的思考等级（与全局同集合）"><label for="teamLaneEffort_') + esc(lane.id) + '">' + AEI18n.t('思考等级') + '</label>'
                + '<select id="teamLaneEffort_' + esc(lane.id) + '">';
            for (var ei = 0; ei < TEAM_EFFORT_LEVELS.length; ei++) {
                var lv = TEAM_EFFORT_LEVELS[ei];
                h += '<option value="' + lv + '"' + ((lc.reasoningEffort || 'high') === lv ? ' selected' : '') + '>' + lv + '</option>';
            }
            h += '</select></div>';
            h += '</div>';
        }
        h += '</div>';
        h += '<div class="st-grid">';
        h += AEI18n.html('<div class="st-field" title="同时在跑的子 Agent 上限（0 = 不允许派生，追问同样被拒；默认 3，上限 8）"><label for="teamSubagentMaxConcurrent">子 Agent 上限</label>')
            + '<input type="number" id="teamSubagentMaxConcurrent" min="0" max="8" step="1" value="' + (teamSub.maxConcurrent || 0) + '">'
            + '<div class="st-field-hint" id="teamSubagentMaxConcurrentHint"></div></div>';
        h += AEI18n.html('<div class="st-field" title="子 Agent 跑完后的追问保活窗口（0 = 跑完即落终态，记录仍留在名册：可查看、不可追问；默认 10 分钟，上限 60）"><label for="teamSubagentKeepAliveMin">子 Agent 保活（分钟）</label>')
            + '<input type="number" id="teamSubagentKeepAliveMin" min="0" max="' + TEAM_KEEPALIVE_MAX_MIN + '" step="1" value="' + keepAliveMsToMinutes(teamSub.keepAliveMs) + '"></div>';
        h += '</div>';
    }
    h += '</details>';

    // ===== 分组：工具可见性 =====
    // 与「团队模式」同级、同样默认折叠（原生 details，无 JS、键盘可达）。
    // 按钮打开子配置面（app/toolVisibilityPanel.js）；装配面缺席时按钮禁用 + 段内 hint 说明。
    // 子面板里的改动只是**草稿**，写进隐藏输入 #toolVisibilityInput；点「保存模块设置」才经
    // main.js 的 getCurrentSettingsFromUI(true) 采集落盘（隐藏输入只是草稿载体，
    // 运行中的工具面只认已保存设置；其余即时保存/草稿防抖路径不采集该键）。
    // 不新增样式面：复用 .st-section/.st-collapsible/.st-persona-row/.st-field-hint（ui-styling 规则）。
    var tvNorm = _normToolVisibility(s.toolVisibility);
    if (!tvNorm || typeof tvNorm !== 'object' || !tvNorm.views || typeof tvNorm.views !== 'object') {
        tvNorm = { version: 1, views: {} };
    }
    // 视图数与「已自定义 N 处」都按引擎的相对清单现算：视图键集合在 engine/settings.js
    // 的 toolVisibilityViewIds（3 固定 + 运行期 lanes），这里不维护第二份视图名单。
    var tvViewIds = [];
    try {
        var tvIdsFn = global.AEEngine && global.AEEngine.settings
            && global.AEEngine.settings.toolVisibilityViewIds;
        if (typeof tvIdsFn === 'function') tvViewIds = tvIdsFn() || [];
    } catch (_) { tvViewIds = []; }
    var tvCustomCount = 0;
    for (var tvIdx = 0; tvIdx < tvViewIds.length; tvIdx++) {
        var tvSeg = tvNorm.views[tvViewIds[tvIdx]];
        if (tvSeg && (((tvSeg.disabled || []).length) || ((tvSeg.enabled || []).length))) tvCustomCount++;
    }
    var tvViewText = tvViewIds.length ? AEI18n.t('{n} 个视图', { n: tvViewIds.length }) : '';
    var tvCustomText = AEI18n.t('已自定义 {n} 处', { n: tvCustomCount });
    var tvJson = '';
    try { tvJson = JSON.stringify(tvNorm); } catch (_) { tvJson = '{"version":1,"views":{}}'; }
    h += AEI18n.html('<details class="st-section st-collapsible"><summary class="st-section-title">工具可见性</summary>');
    // 入口卡：左侧「标签 + 状态 chip + 两行说明」，右侧「打开配置」。
    // 原布局把统计塞进 label 下方、说明堆成一段长句，读起来像未排版的表单行；
    // 这里复用 .st-section 骨架 + 入口卡自有类（样式见 agent.css 的 .tv-entry 段），
    // 不新增按钮/控件类型，键盘与既有测试契约（id / 隐藏输入 / 装配 hint）全部保留。
    h += '<div class="tv-entry">'
        + '<div class="tv-entry-line">'
        + AEI18n.html('<span class="tv-entry-label">各视图可见工具</span>')
        + (tvViewText ? '<span class="tv-entry-chip">' + esc(tvViewText) + '</span>' : '')
        + '<span class="tv-entry-chip' + (tvCustomCount > 0 ? ' tv-entry-chip--on' : '') + '">'
        + esc(tvCustomText) + '</span>'
        + AEI18n.html('<button type="button" class="btn secondary tv-entry-btn" id="toolVisibilityOpenBtn">打开配置…</button>')
        + '<input type="hidden" id="toolVisibilityInput" value="' + esc(tvJson) + '">'
        + '</div>'
        + AEI18n.html('<div class="tv-entry-hint">放宽只影响本视图能否看到与调用；工具的权限档、能力域与执行链不变。</div>')
        + AEI18n.html('<div class="tv-entry-hint tv-entry-hint--weak">改动需点「保存模块设置」才生效。</div>')
        + '</div>';
    // 面板装配性提示：disabled 按钮的 title 在 CEF 不可靠，改用段内常驻
    // .st-field-hint 说明——openSettingsModal 在 AE_LLM.ToolVisibilityPanel 缺席时显示本行。
    h += '<div class="st-field-hint" id="toolVisibilityAssemblyHint" hidden>'
        + AEI18n.html('工具可见性配置面板未装配（app/toolVisibilityPanel.js 缺席），本版本无法配置。</div>');
    h += '</details>';

    // 按钮行
    h += AEI18n.html('<div class="btn-row"><button class="btn" id="llmSaveSettingsBtn">保存模块设置</button>');
    h += AEI18n.html('<button class="btn secondary" id="llmGateConfigBtn">AST 门能力配置</button>');
    h += AEI18n.html('<button class="btn secondary" id="llmAboutModuleBtn">关于模块</button></div>');
    h += '</div>';
    return h;
}


function handleSaveSettings() {
    if (!document.getElementById(LLM_SETTINGS_CONTAINER)) return;
    const settings = {
        ...cachedSettings,
        // 保存按钮是**唯一**采集子面板草稿（#toolVisibilityInput）的路径：
        // 其余即时保存/草稿防抖路径不传 includeDrafts，草稿不落盘。
        ...getCurrentSettingsFromUI(true),
        // 目标默认轮数上限：main.js 的 getCurrentSettingsFromUI 没有读这一项（该函数在
        // 文件范围之外），这里按同一个显式字段补一次——否则「改了不生效」。基线取已生效值，
        // 面板没渲染该行时 readGoalDefaultMaxRoundsFromUI 原样返回（不丢未渲染字段）。
        goalDefaultMaxRounds: readGoalDefaultMaxRoundsFromUI((cachedSettings || {}).goalDefaultMaxRounds)
    };
    // 「脚本权限」安全警告确认分支已随开关收割——能力域确认统一
    // 走「AST 门能力配置」弹窗（agent-tool/llm-preview 通道开启警告在彼处）
    _doSaveSettings(settings);
}

async function _doSaveSettings(settings) {

    // 通过 main.js 全局 saveSettings (flat format) 保存，它会适配 options 包格式调用本地 IIFE 版本
    var saveResult;
    try {
        if (typeof window.saveSettings === 'function') {
            saveResult = await window.saveSettings(settings);
        }
    } catch (e) {
        console.error('[AgentSettings] 保存模块设置失败: ' + (e && (e.stack || e.message) || e));
        if (global.AEToast) global.AEToast.show(AEI18n.t('模块设置保存失败: ') + (e && e.message ? e.message : e), 'error');
        return;
    }
    // 写盘 resolve false（配额满/加密异常）不弹成功——不看返回值直接报「已保存」时，
    // 实际未落盘、重启后回退。保持弹窗开启，让用户知道本次修改没进磁盘。
    if (saveResult === false) {
        console.error('[AgentSettings] 模块设置写入失败：settingsStore 返回 false（localStorage 配额满或加密异常）');
        if (global.AEToast) global.AEToast.show(AEI18n.t('模块设置保存失败：本地存储写入被拒绝（可能已满），重启后修改会回退'), 'error');
        return;
    }
    if (typeof window.applySettingsToUI === 'function') {
        window.applySettingsToUI({ ...cachedSettings, ...settings });
    }
    // 团队段（四条 Agent 的模型/平台/思考等级）保存后即时生效：引擎按新配置重同步 lane 的
    // 上下文窗口，并通知顶栏「当前模型」重绘（不必等下一轮请求或重开面板）。
    try {
        if (window.AEEngine && typeof window.AEEngine.refreshLaneModelConfig === 'function') {
            window.AEEngine.refreshLaneModelConfig();
        }
    } catch (_) { /* 引擎未装配：设置已落盘，刷新动作缺席不影响 */ }
    if (global.AEToast) global.AEToast.show(AEI18n.t('模块设置已保存'), 'success');
    // 同步上下文 Token 上限到 contextManager（必须在 closeSettingsModal 之前，否则 DOM 已移除）
    if (window.AEEngine && window.AEEngine.bridge && typeof window.AEEngine.bridge.syncMaxContextTokens === 'function') {
        window.AEEngine.bridge.syncMaxContextTokens(settings.maxContextTokens);
    }
    closeSettingsModal();
    refreshList();
}


// 即时保存通道：**设置面板字段已全部改为按钮驱动**（见 bindSettingsInputsOnChange），
// 现在只有静态工具栏 strip（思考强度/权限循环切换）还走这里——它们的交互范式本就是
// 「点一下即刻生效」，没有保存按钮可等。
function _persistSettingsFromUI() {
    const settings = {
        ...cachedSettings,
        ...getCurrentSettingsFromUI()
    };
    if (typeof window.saveSettings === 'function') {
        // 即时保存通道补失败反馈——window.saveSettings(settings)
        // 未 await 未 catch，写盘失败变 unhandled rejection 且内存态与磁盘静默
        // 脱节（重启后设置回退），用户无从感知。对齐 _doSaveSettings 的 catch 手法。
        // saveSettings 现在会把 settingsStore 的 false（配额满/加密异常）resolve 出来，
        // 仅 catch rejection 不够——补 false 分支同样弹错。
        Promise.resolve(window.saveSettings(settings)).then(function (r) {
            if (r === false) {
                console.error('[AgentSettings] 即时保存模块设置失败：settingsStore 返回 false');
                if (global.AEToast) global.AEToast.show(AEI18n.t('设置保存失败：本地存储写入被拒绝（可能已满），重启后修改会回退'), 'error');
            }
        }).catch(function (e) {
            console.error('[AgentSettings] 即时保存模块设置失败: ' + (e && (e.stack || e.message) || e));
            if (global.AEToast) global.AEToast.show(AEI18n.t('设置保存失败: ') + (e && e.message ? e.message : e), 'error');
        });
    }
    applyScriptListToggleUi();
    // 同步 context token 上限
    if (window.AEEngine && window.AEEngine.bridge && typeof window.AEEngine.bridge.syncMaxContextTokens === 'function') {
        window.AEEngine.bridge.syncMaxContextTokens(settings.maxContextTokens);
    }
    requestAnimationFrame(() => {
        if (typeof enforcePreviewFillHeight === 'function') enforcePreviewFillHeight();
    });
}

// 设置面板的输入项由 openSettingsModal → buildLlmSettingsHtml 动态注入，modal-body
// 每次打开都 innerHTML 重建（旧元素随之销毁，不会重复挂监听），因此字段绑定
// 必须在 openSettingsModal 内 DOM 构建完成后执行，而非模块 init 时的
// settingsPanel.bind（彼时 modal-body 为空，绑定全部落空）。
//
// 面板是**纯按钮驱动的表单**：12 个设置字段（修正次数/各种超时/
// 工具上限/三个权限开关…）编辑期间不落盘、不生效，点「保存模块设置」才一次性应用
// （handleSaveSettings → _doSaveSettings）。change/input 即 _persistSettingsFromUI 时，
// 「点一下下拉」「把数字改完」当场落盘并生效，保存按钮形同虚设。
// _persistSettingsFromUI 保留给静态工具栏 strip（思考强度/权限循环切换），不在此处调用。
function bindSettingsInputsOnChange() {
    bindContextTokenPicker();
    // 团队段：模型按钮 / 平台下拉在任何 DOM 重建后都要重新挂一遍（设置面板每次 open 都 innerHTML 重建）
    bindTeamLaneModelPickers();
}

// 团队段模型选择器的接线（幂等位防同一批 DOM 重复挂监听）：
//   · 模型按钮：点击打开选择弹窗（搜索 + 按平台分组的全量候选，点行把「模型 + 所属平台」
//     成对写进隐藏输入——平台不再单独展示，见 _setTeamLanePlatform 注释）。
// 面板没渲染团队段（设置页没打开 / 装配面缺席）时静默跳过。
function bindTeamLaneModelPickers() {
    var defs = teamLaneDefs();
    if (!defs.length) return;
    for (var i = 0; i < defs.length; i++) {
        (function (lane) {
            var id = lane.id;
            var btn = document.getElementById('teamLaneModelPick_' + id);
            if (btn && !btn.__aeLaneBound && typeof btn.addEventListener === 'function') {
                btn.__aeLaneBound = true;
                btn.addEventListener('click', function () {
                    if (typeof global.aeBeep === 'function') global.aeBeep('open');
                    openTeamLaneModelPicker(id);
                });
            }
        })(defs[i]);
    }
    // 初次渲染的按钮文案以隐藏输入为准（与 buildLlmSettingsHtml 的快照同源）
    for (var j = 0; j < defs.length; j++) {
        var mEl = document.getElementById('teamLaneModel_' + defs[j].id);
        if (mEl) _setTeamLaneModel(defs[j].id, String(mEl.value == null ? '' : mEl.value));
    }
}

// 上下文上限的"下拉"部分：真实的 <select> 被面板全局的自定义下拉（shared/customSelect.js）接管。
// **选中只写回输入框，不落盘、不生效**——它跟手动打字一样，要等「保存模块设置」按钮才应用
// （下拉不能绕过保存按钮直接应用）。
// 另外把展开的列表宽度对齐字段（那个模块默认取按钮宽度 96px，比字段窄一截）。
function bindContextTokenPicker() {
    var picker = document.getElementById('maxContextTokensPicker');
    var input = document.getElementById('maxContextTokens');
    if (!picker || !input || typeof picker.addEventListener !== 'function') return;

    // 让原生 select 的选中位跟着输入框走：自定义下拉的列表是按它来打高亮的，
    // 不同步的话列表会高亮在旧值上（如输入框 256K 却高亮 32K）。
    function syncPickerHighlight() {
        var want = String(input.value === undefined || input.value === null ? '' : input.value).trim();
        if (picker.value === want) return;
        picker.value = want;   // 命中预设则选中该项，否则 selectedIndex=-1（列表不高亮任何项）
        if (typeof picker.dispatchEvent === 'function' && typeof Event === 'function') {
            picker.dispatchEvent(new Event('change', { bubbles: true }));   // 触发自定义下拉重建选项行
        }
    }

    picker.addEventListener('change', function () {
        var v = picker.value;
        // 只填值：不调 _persistSettingsFromUI（否则选一下就把设置落盘并生效，绕过保存按钮）
        if (v && v !== input.value) input.value = v;
    });
    if (typeof input.addEventListener === 'function') {
        input.addEventListener('input', syncPickerHighlight);
        input.addEventListener('change', syncPickerHighlight);
    }
    syncPickerHighlight();   // 初值：回填的人读值（如 256K）直接高亮在列表里
    var wrap = input.parentNode;
    if (wrap && typeof wrap.addEventListener === 'function') {
        // 捕获阶段先于自定义下拉的按钮处理器执行，故延到下一个 tick 再改它刚摆好的定位
        wrap.addEventListener('mousedown', function () {
            setTimeout(alignPickerList, 0);
        }, true);
    }
}

function alignPickerList() {
    var picker = document.getElementById('maxContextTokensPicker');
    var input = document.getElementById('maxContextTokens');
    var cs = picker && picker._cs;
    if (!cs || !cs.isOpen || !input || !cs.list) return;
    var r = input.getBoundingClientRect();
    cs.list.style.left = Math.round(r.left) + 'px';
    cs.list.style.width = Math.round(r.width) + 'px';
}

// ── 静态工具栏「思考」滚轮：团队档 = **当前 Agent** 的思考等级 ────────
// 单 Agent 档仍是全局设置（行为不变）。团队档改成按 lane 读写的原因：设置页里每条 Agent
// 各有一份思考等级，滚轮若继续改全局值，在团队档既看不见效果、还会把全局值改脏
//（因此团队档改的是当前 Agent 的思考等级）。
var THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh'];
var _thinkingSyncBound = false;

// 当前上下文：团队开关 + 当前 lane（标签取 lanes.list 的唯一事实源）
function _teamThinkingContext() {
    var on = false;
    var laneId = '';
    try {
        var ui = global.AEAgentTeamUI;
        if (ui && typeof ui.isTeamModeOn === 'function') on = !!ui.isTeamModeOn();
        if (on && ui && typeof ui.currentLaneId === 'function') laneId = ui.currentLaneId() || '';
    } catch (_) { on = false; laneId = ''; }
    var label = laneId;
    try {
        var api = global.AEAgentTeam && global.AEAgentTeam.lanes;
        var list = (api && typeof api.list === 'function') ? (api.list() || []) : [];
        for (var i = 0; i < list.length; i++) {
            if (list[i] && list[i].id === laneId) { label = list[i].label || laneId; break; }
        }
    } catch (_) { /* 标签拿不到：用 id 兜底 */ }
    return { on: on, laneId: laneId, label: label || laneId };
}

// 某条 lane 的思考等级（配置缺省/非法 ⇒ 设计默认 high，与 engine DEFAULTS 同口径）
function _laneThinkingEffort(laneId, settingsObj) {
    var s = settingsObj || ((typeof cachedSettings === 'object') ? cachedSettings : null);
    var team = (s && s.team && typeof s.team === 'object') ? s.team : null;
    var lane = (team && team.lanes && laneId) ? team.lanes[laneId] : null;
    var effort = lane ? lane.reasoningEffort : '';
    return THINKING_LEVELS.indexOf(effort) >= 0 ? effort : 'high';
}

// 滚轮的当前生效值：团队档 = 当前 Agent 的配置；单 Agent = 全局设置。
function _thinkingWheelEffort(settingsObj) {
    var ctx = _teamThinkingContext();
    if (ctx.on && ctx.laneId) return _laneThinkingEffort(ctx.laneId, settingsObj);
    var s = settingsObj || ((typeof cachedSettings === 'object') ? cachedSettings : null);
    var effort = s ? s.reasoningEffort : '';
    return THINKING_LEVELS.indexOf(effort) >= 0 ? effort : 'high';
}

// 滚轮显示同步（位置 + 悬停说明）。切 lane / 开关团队 / 保存设置后都要重跑。
function _syncThinkingWheel(settingsObj) {
    var effort = _thinkingWheelEffort(settingsObj);
    var idx = THINKING_LEVELS.indexOf(effort);
    if (idx < 0) idx = 2;
    var strip = document.getElementById('reasoningEffortStrip');
    if (strip && strip.style) strip.style.transform = 'translateY(' + (-idx * 18) + 'px)';
    var slider = document.getElementById('aeAgentThinkingSlider');
    if (slider && typeof slider.setAttribute === 'function') {
        var ctx = _teamThinkingContext();
        slider.setAttribute('title', (ctx.on && ctx.laneId)
            ? (AEI18n.t('点击切换当前 Agent（') + ctx.label + AEI18n.t('）的思考等级'))
            : AEI18n.t('点击切换思考等级'));
    }
}

// 团队档的滚轮点击：把下一档写进**当前 Agent** 的团队配置。
// 保存链仍是 window.saveSettings（唯一落盘口；归一/写盘失败提示都在那条链上），
// 这里只构造「显式 team 段」的那一份 next，别的不动。
function _persistLaneThinkingEffort(effort) {
    var ctx = _teamThinkingContext();
    if (!ctx.on || !ctx.laneId) return false;
    var next = THINKING_LEVELS.indexOf(effort) >= 0 ? effort : 'high';
    var team = (typeof cachedSettings === 'object' && cachedSettings
        && cachedSettings.team && typeof cachedSettings.team === 'object') ? cachedSettings.team : null;
    if (!team) {
        if (global.AEToast) global.AEToast.show(AEI18n.t('团队设置读取失败，思考等级未保存'), 'error');
        _syncThinkingWheel();
        return false;
    }
    // 浅拷贝 team + 深一层 lanes：不改 cachedSettings 里那份（保存链会重建 team 段）
    var nextTeam = {};
    for (var k in team) {
        if (Object.prototype.hasOwnProperty.call(team, k)) nextTeam[k] = team[k];
    }
    nextTeam.lanes = {};
    var lanes = team.lanes || {};
    for (var id in lanes) {
        if (Object.prototype.hasOwnProperty.call(lanes, id)) nextTeam.lanes[id] = Object.assign({}, lanes[id]);
    }
    nextTeam.lanes[ctx.laneId] = Object.assign({}, nextTeam.lanes[ctx.laneId] || {}, { reasoningEffort: next });
    if (typeof window.saveSettings !== 'function') { _syncThinkingWheel(); return false; }
    var ret = null;
    try {
        ret = window.saveSettings(Object.assign({}, cachedSettings, { team: nextTeam }));
    } catch (e) {
        if (global.AEToast) global.AEToast.show(AEI18n.t('思考等级保存失败: ') + (e && e.message ? e.message : e), 'error');
        _syncThinkingWheel();
        return false;
    }
    Promise.resolve(ret).then(function (r) {
        if (r === false) {
            if (global.AEToast) global.AEToast.show(AEI18n.t('思考等级保存失败：本地存储写入被拒绝（可能已满），重启后会回退'), 'error');
            return;
        }
        // 引擎侧按新配置重同步（窗口/顶栏）并派发 ae:lane-model-changed ⇒ 滚轮随之重绘
        if (global.AEEngine && typeof global.AEEngine.refreshLaneModelConfig === 'function') {
            global.AEEngine.refreshLaneModelConfig();
        }
        _syncThinkingWheel();
    }).catch(function (e) {
        if (global.AEToast) global.AEToast.show(AEI18n.t('思考等级保存失败: ') + (e && e.message ? e.message : e), 'error');
    });
    return true;
}

// 切 lane / 开关团队都会改「当前 Agent」：引擎的 ae:lane-model-changed（_syncSlots 派发、
// window 上）与团队 UI 的 ae:team-state-changed（**document** 上，团队 UI 的既有派发点）两条
// 通道都收，滚轮显示值才能与实际请求用的值同源。
function _bindThinkingWheelContextSync() {
    if (_thinkingSyncBound) return;
    _thinkingSyncBound = true;
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
        window.addEventListener('ae:lane-model-changed', function () { _syncThinkingWheel(); });
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
        document.addEventListener('ae:team-state-changed', function () { _syncThinkingWheel(); });
    }
}

// 静态工具栏 strip（reasoningEffortSlot/permissionModeSlot 为 index.html 固有元素，
// 模块 init 时即存在）：仍由 settingsPanel.bind 一次性绑定
function syncSettingsFromUIOnChange() {
    var slotEl = document.getElementById('reasoningEffortSlot');
    if (slotEl) {
        slotEl.addEventListener('click', function () {
            if (typeof aeSlotSpin === 'function') aeSlotSpin();
            var strip = document.getElementById('reasoningEffortStrip');
            var ctx = _teamThinkingContext();
            // 团队档：当前值以**当前 Agent 的配置**为准（滚轮显示可能滞后一拍）
            var currentIdx = (ctx.on && ctx.laneId) ? THINKING_LEVELS.indexOf(_laneThinkingEffort(ctx.laneId)) : -1;
            if (currentIdx < 0) {
                currentIdx = 2;
                if (strip) {
                    var transform = strip.style.transform || '';
                    var match = transform.match(/-?\d+/);
                    if (match) currentIdx = Math.round(-parseInt(match[0], 10) / 18);
                }
                if (currentIdx < 0 || currentIdx >= THINKING_LEVELS.length) currentIdx = 2;
            }
            var nextIdx = (currentIdx + 1) % THINKING_LEVELS.length;
            if (strip) {
                strip.style.transform = 'translateY(' + (-nextIdx * 18) + 'px)';
            }
            // 团队档写当前 Agent 的配置；单 Agent 档保留全局即时保存（行为不变）
            if (ctx.on && ctx.laneId) _persistLaneThinkingEffort(THINKING_LEVELS[nextIdx]);
            else _persistSettingsFromUI();
        });
    }

    // 工具执行权限 strip：点击循环切换（与 reasoningEffort 同机制）
    var permSlotEl = document.getElementById('permissionModeSlot');
    if (permSlotEl) {
        permSlotEl.addEventListener('click', function () {
            if (typeof aeSlotSpin === 'function') aeSlotSpin();
            var levels = ['auto', 'balanced', 'conservative'];
            var strip = document.getElementById('permissionModeStrip');
            var currentIdx = 1;
            if (strip) {
                var transform = strip.style.transform || '';
                var match = transform.match(/-?\d+/);
                if (match) currentIdx = Math.round(-parseInt(match[0], 10) / 18);
                if (currentIdx < 0 || currentIdx >= levels.length) currentIdx = 1;
            }
            var nextIdx = (currentIdx + 1) % levels.length;
            if (strip) {
                strip.style.transform = 'translateY(' + (-nextIdx * 18) + 'px)';
            }
            _persistSettingsFromUI();
        });
    }

    // 团队档「思考」滚轮跟随当前 Agent：绑定事件通道并先按当前上下文落一次初值
    _bindThinkingWheelContextSync();
    _syncThinkingWheel();
}

function bind() { syncSettingsFromUIOnChange(); }
    function unbind() {}
    global.AEAgentApp.settingsPanel = {
        open: openSettingsModal, close: closeSettingsModal, handleSave: handleSaveSettings, bind: bind, unbind: unbind,
        // 上下文 Token 上限的显示/解析（main.js 的读写路径与 engine/bootstrap 的 DOM 兜底共用）
        formatTokenValue: formatTokenValue,
        parseTokenValue: parseTokenValue
    };

})(window);
