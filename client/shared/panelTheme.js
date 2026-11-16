// 面板主题方案库：主题状态与写路径的唯一实现（不含 DOM）（本文件暂未进 scripts.manifest.js，由接线任务登记）。
//
// 数据落点（settingsStore 的 global 段，经注入的 load/persist 读写）：
//   customThemePresets        命名方案列表 [{ id, name, colors, createdAt, updatedAt }]
//   activeCustomThemePresetId 当前方案指针
//   themePreset               仍是 default|eva01|eva02|custom 四档
//   customThemeColors         当前生效色快照（仅 custom 档写，兼容既有读者）
//
// 不变量：
//   1. 写路径必须把方案 colors 存成**完整主题对象**（源预设全键）：themeApplier 在 custom 档以
//      THEME_PRESETS.default 打底（Object.assign），只存核心色会让表面色/弹窗边框/顶栏项
//      静默退回 default，从 eva01 fork 出的外观会走样。旧数据迁移路径只能照抄历史快照，
//      其键数取决于当年写入的键集。
//   2. 写路径必须**合并写**：只覆盖传入的可编辑键，其余键保留。
//   3. 用户/Agent 写路径先落盘、成功后才应用外观（fail-closed），落盘失败回滚内存态并返回错误；
//      旧数据迁移是尽力而为——写盘失败只记日志，下次启动重试。
//   4. 外观应用只经注入的 applyTheme（真机 = main.js applyTheme → themeApplier）。
(function (global) {
    'use strict';

    var MAX_PRESETS = 20;
    var NAME_MAX = 24;
    var PRESET_KEYS = ['default', 'eva01', 'eva02', 'custom'];
    // 方案缩略色卡取色键（面板方案列表预览用）：背景 → 控件 → 边框 → 主文字 → 强调，
    // 恰好是一条从暗到亮的读色梯度，且全是可编辑核心色（方案 colors 里必有）
    var SWATCH_KEYS = ['appBg', 'btnBg', 'border', 'textMain', 'accent'];
    var HEX_RE = /^#[0-9a-fA-F]{6}$/;
    var RGBA_RE = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*[\d.]+\s*)?\)$/i;
    var TRIPLET_RE = /^\d+\s*,\s*\d+\s*,\s*\d+$/;

    function isColorValue(v) {
        return typeof v === 'string' && (HEX_RE.test(v) || RGBA_RE.test(v) || TRIPLET_RE.test(v));
    }

    // 色值 → [r,g,b]（0-255）；无法解析返回 null
    function parseColorToRgb(v) {
        var m = HEX_RE.exec(v || '');
        if (m) {
            var n = parseInt(v.slice(1), 16);
            return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
        }
        var m2 = RGBA_RE.exec(v || '');
        if (m2) {
            var body = v.slice(v.indexOf('(') + 1, v.lastIndexOf(')')).split(',');
            return [parseInt(body[0], 10), parseInt(body[1], 10), parseInt(body[2], 10)];
        }
        var m3 = TRIPLET_RE.exec(v || '');
        if (m3) {
            var p = v.split(',');
            return [parseInt(p[0], 10), parseInt(p[1], 10), parseInt(p[2], 10)];
        }
        return null;
    }

    function channelLuminance(c) {
        var s = c / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    }

    function relativeLuminance(rgb) {
        return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
    }

    // WCAG 对比度（1~21）；任一入参无法解析返回 0
    function contrastRatio(rgbA, rgbB) {
        if (!rgbA || !rgbB) return 0;
        var la = relativeLuminance(rgbA);
        var lb = relativeLuminance(rgbB);
        var hi = Math.max(la, lb);
        var lo = Math.min(la, lb);
        return (hi + 0.05) / (lo + 0.05);
    }

    function cloneShallow(o) {
        var r = {};
        if (!o || typeof o !== 'object') return r;
        for (var k in o) {
            if (Object.prototype.hasOwnProperty.call(o, k)) r[k] = o[k];
        }
        return r;
    }

    // 方案名规范化：去首尾空白、限长 1–24；不合格返回 null
    function normalizeName(name) {
        if (typeof name !== 'string') return null;
        var t = name.trim();
        if (!t || t.length > NAME_MAX) return null;
        return t;
    }

    function createPanelTheme(deps) {
        deps = deps || {};
        var presets = deps.presets || global.AE_THEME_PRESETS || {};
        var labels = deps.labels || global.AE_THEME_PRESET_LABELS || {};
        var editableKeys = (deps.editableKeys || global.AE_THEME_EDITABLE_KEYS || []).slice();
        var load = deps.load || function () { return Promise.resolve({}); };
        var persist = deps.persist || function () { return Promise.resolve(false); };
        var applyTheme = deps.applyTheme || function () {};
        var now = deps.now || function () { return Date.now(); };
        var subscribers = [];
        var state = {
            themePreset: 'default',
            customThemePresets: [],
            activeCustomThemePresetId: '',
            customThemeColors: null,
            // 本次提交需要把盘上的快照显式写成 null（方案库被删空时置真），见 getSettingsPatch
            dropSnapshot: false
        };

        // 方案 id：必须与现有列表**以及已分配 id**（seenIds）都不撞。
        // init 归一化时一批条目在新 id 落进 state 之前就要判重，只看 findScheme 会漏，
        // 于是同毫秒内 4096 档（12 bit）随机后缀撞号时会出现两个同 id 条目（都自称 active、按 id 只有首个可达）。
        // 重试有界：先试随机后缀，再退化为带 '_' 的递增序号（随机后缀是纯 36 进制，不含 '_'，两形态不同名）。
        function newSchemeId(seenIds) {
            var base = 'p_' + now().toString(36);
            for (var i = 0; i < 8; i++) {
                var id = base + Math.floor(Math.random() * 4096).toString(36);
                if (!findScheme(id) && !(seenIds && seenIds[id])) return id;
            }
            var n = 0;
            while (n < 4096 && (findScheme(base + '_' + n.toString(36)) || (seenIds && seenIds[base + '_' + n.toString(36)]))) {
                n++;
            }
            return base + '_' + n.toString(36);
        }

        // 方案深拷贝：colors 是嵌套对象，浅拷贝会让读方与内部状态共享引用
        function cloneScheme(s) {
            var c = cloneShallow(s);
            c.colors = cloneShallow(s && s.colors);
            return c;
        }

        function findScheme(nameOrId) {
            if (!nameOrId || typeof nameOrId !== 'string') return null;
            var list = state.customThemePresets;
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === nameOrId || list[i].name === nameOrId) return list[i];
            }
            return null;
        }

        function activeScheme() { return findScheme(state.activeCustomThemePresetId); }

        function schemeNames() {
            if (!state.customThemePresets.length) return AEI18n.t('（无）');
            var out = [];
            for (var i = 0; i < state.customThemePresets.length; i++) out.push(state.customThemePresets[i].name);
            return out.join((typeof AEI18n !== 'undefined' && AEI18n.punct ? AEI18n.punct('、', ', ', '、') : '、'));
        }

        // 生效色：非 custom 档 = 该预设；custom 档 = default 打底 + 方案覆盖（与 themeApplier 同口径）
        function effectiveColors() {
            if (state.themePreset !== 'custom') {
                return cloneShallow(presets[state.themePreset] || presets.default || {});
            }
            var scheme = activeScheme();
            var over = scheme ? (scheme.colors || {}) : (state.customThemeColors || {});
            var out = cloneShallow(presets.default || {});
            for (var k in over) {
                if (Object.prototype.hasOwnProperty.call(over, k)) out[k] = over[k];
            }
            return out;
        }

        function editableColors() {
            var all = effectiveColors();
            var out = {};
            for (var i = 0; i < editableKeys.length; i++) {
                var k = editableKeys[i];
                if (all[k] != null) out[k] = all[k];
            }
            return out;
        }

        // 方案缩略色卡：按 SWATCH_KEYS 取色，缺项回退 default 预设——旧数据键集不齐时
        // 也不留空洞（返回定长 5 项，面板可直接铺 5 格）
        function swatchColorsOf(scheme) {
            var colors = (scheme && scheme.colors) || {};
            var base = presets.default || {};
            var out = [];
            for (var i = 0; i < SWATCH_KEYS.length; i++) {
                var v = colors[SWATCH_KEYS[i]] != null ? colors[SWATCH_KEYS[i]] : base[SWATCH_KEYS[i]];
                out.push(typeof v === 'string' ? v : '');
            }
            return out;
        }

        function getState() {
            var active = (state.themePreset === 'custom') ? activeScheme() : null;
            return {
                themePreset: state.themePreset,
                presetLabel: labels[state.themePreset] || state.themePreset,
                activeScheme: active ? { id: active.id, name: active.name } : null,
                schemeId: state.activeCustomThemePresetId,
                colors: editableColors(),
                schemes: state.customThemePresets.map(function (s) {
                    return {
                        id: s.id,
                        name: s.name,
                        active: s.id === state.activeCustomThemePresetId,
                        updatedAt: s.updatedAt || 0,
                        swatches: swatchColorsOf(s)
                    };
                }),
                editableKeys: editableKeys.slice(),
                customThemeColors: state.customThemeColors ? cloneShallow(state.customThemeColors) : null,
                draftActive: draftActive,
                draftDirty: draftDirty()
            };
        }

        function getSettingsPatch() {
            var patch = {
                themePreset: state.themePreset,
                customThemePresets: state.customThemePresets.map(cloneScheme),
                activeCustomThemePresetId: state.activeCustomThemePresetId
            };
            // custom 档写当前生效色快照；非 custom 档默认不动已存快照，
            // 但方案库被删空时必须**显式写 null**——盘上残留的旧快照会在下次启动被
            // migrateLegacy 包装成「手动方案」，等于删掉的方案自己复活。
            if (state.themePreset === 'custom') {
                patch.customThemeColors = state.customThemeColors ? cloneShallow(state.customThemeColors) : null;
            } else if (state.dropSnapshot) {
                patch.customThemeColors = null;
            }
            return patch;
        }

        function snapshotState() {
            return {
                themePreset: state.themePreset,
                customThemePresets: state.customThemePresets.map(cloneScheme),
                activeCustomThemePresetId: state.activeCustomThemePresetId,
                customThemeColors: state.customThemeColors ? cloneShallow(state.customThemeColors) : null,
                dropSnapshot: state.dropSnapshot
            };
        }

        function restoreState(snap) {
            state.themePreset = snap.themePreset;
            state.customThemePresets = snap.customThemePresets;
            state.activeCustomThemePresetId = snap.activeCustomThemePresetId;
            state.customThemeColors = snap.customThemeColors;
            state.dropSnapshot = snap.dropSnapshot;
        }

        function applyCurrent() {
            applyTheme(state.themePreset, state.themePreset === 'custom' ? effectiveColors() : null);
        }

        // ── 编辑草稿：把「全局设置」弹窗里的主题区做成一个事务 ──────────────────────────
        // 弹窗打开 → beginDraft() 记下已保存状态当基线；期间的档位切换 / 方案新建·改名·删除 /
        // 改色**全部只改内存并立即应用外观（预览）**，不落盘；点「保存」→ commitDraft() 一次落盘；
        // 未保存关闭 → discardDraft() 回滚到基线（外观一并回滚）。
        // 外部写入（Agent 工具，显式 opts.draft === false）优先：先丢弃未保存草稿，避免把预览态
        // 连同这次写入一起落盘——与 syncThemeState「外部新值取代未保存临时编辑」同口径。
        var draftActive = false;
        var draftBaseline = null;

        // 草稿脏判定用的状态签名（比对象引用可靠：colors 是嵌套对象，每次写都是新引用）
        function draftSignature(snap) {
            if (!snap) return '';
            var parts = [snap.themePreset, snap.activeCustomThemePresetId, snap.dropSnapshot ? '1' : '0',
                JSON.stringify(snap.customThemeColors || null)];
            var list = snap.customThemePresets || [];
            for (var i = 0; i < list.length; i++) {
                parts.push(list[i].id + '|' + list[i].name + '|' + JSON.stringify(list[i].colors || {}) + '|' + (list[i].updatedAt || 0));
            }
            return parts.join('\n');
        }

        function draftDirty() {
            if (!draftActive || !draftBaseline) return false;
            return draftSignature(snapshotState()) !== draftSignature(draftBaseline);
        }

        function beginDraft() {
            if (draftActive) return { ok: true, already: true };
            draftBaseline = snapshotState();
            draftActive = true;
            broadcast();
            return { ok: true };
        }

        // 丢弃草稿的内存态（不应用、不广播）：调用方负责随后的应用/广播
        function dropDraftState() {
            if (draftBaseline) restoreState(draftBaseline);
            draftActive = false;
            draftBaseline = null;
        }

        function discardDraft() {
            if (!draftActive) return Promise.resolve({ ok: true, noop: true });
            var reverted = draftDirty();
            dropDraftState();
            var applied = true;
            try {
                applyCurrent();
            } catch (e) {
                applied = false;
                console.warn('[PanelTheme] 丢弃草稿后应用外观抛错: ' + (e && e.message ? e.message : e));
            }
            broadcast();
            return Promise.resolve({ ok: true, applied: applied, reverted: reverted });
        }

        // 草稿落盘：「保存」的唯一提交口。失败时草稿保持有效，用户可重试保存
        function commitDraft() {
            if (!draftActive) return Promise.resolve({ ok: true, noop: true });
            var patch = getSettingsPatch();
            return Promise.resolve()
                .then(function () { return persist(patch); })
                .then(function (ok) {
                    if (ok === false) {
                        return { ok: false, error: 'PERSIST_FAILED', message: AEI18n.t('设置写入失败（localStorage 配额满或加密异常），主题未保存。') };
                    }
                    draftActive = false;
                    draftBaseline = null;
                    state.dropSnapshot = false;   // 清空快照的意图已随本次写入落盘
                    // 与 commit() 同口径：写入已成功，applier 抛错不回滚，但回执标 applied=false
                    var applied = true;
                    try {
                        applyCurrent();
                    } catch (e) {
                        applied = false;
                        console.warn('[PanelTheme] 提交草稿后应用外观抛错: ' + (e && e.message ? e.message : e));
                    }
                    broadcast();
                    return { ok: true, committed: true, applied: applied };
                }, function (e) {
                    return { ok: false, error: 'PERSIST_FAILED', message: AEI18n.t('设置写入失败：') + (e && e.message ? e.message : e) };
                });
        }

        function broadcast() {
            var st = getState();
            // 遍历副本：订阅者回调里自解绑（或订阅新回调）不能跳过后续订阅者
            var list = subscribers.slice();
            for (var i = 0; i < list.length; i++) {
                try { list[i](st); } catch (e) {
                    console.warn('[PanelTheme] 订阅者抛错: ' + (e && e.message ? e.message : e));
                }
            }
        }

        // 突变 → 落盘 → 应用 → 广播。落盘失败回滚内存态，外观不变（fail-closed）。
        // 并发：persist 是异步的，面板 UI 路径与 Agent 工具路径可能在同一 tick 各发起一次 commit，
        // 故用递增 opId 只允许「自己那一次」回滚——迟到失败若回滚了后一次的快照，
        // 会把已成功的写入在内存里抹掉（disk 与内存随之分叉）。
        // 草稿期（弹窗开着且未显式 draft:false）：只应用 + 广播，落盘留给 commitDraft。
        var commitSeq = 0;
        function commit(mutate, opts) {
            opts = opts || {};
            // 外部写入优先：先丢弃未保存的 UI 草稿，否则 getSettingsPatch() 会把预览态一起落盘
            if (draftActive && opts.draft === false) dropDraftState();
            var drafting = draftActive && opts.draft !== false;
            var before = snapshotState();
            var opId = ++commitSeq;
            var res;
            try {
                res = mutate();
            } catch (e) {
                if (opId === commitSeq) restoreState(before);
                return Promise.resolve({ ok: false, error: 'INTERNAL', message: String(e && e.message ? e.message : e) });
            }
            if (!res || res.ok !== true) {
                if (opId === commitSeq) restoreState(before);
                return Promise.resolve(res || { ok: false, error: 'UNKNOWN', message: AEI18n.t('未知错误') });
            }
            // 快照随生效色更新（仅 custom 档写入 settings，见 getSettingsPatch）。
            // 方案库为空时快照必须为 null：否则重启后 migrateLegacy 会把这份无主快照
            // 包装成「手动方案」，用户会看到一套自己没建过的方案。
            if (state.themePreset === 'custom') {
                state.customThemeColors = state.customThemePresets.length ? effectiveColors() : null;
            }
            if (drafting) {
                var appliedInDraft = true;
                try {
                    applyCurrent();
                } catch (e2) {
                    appliedInDraft = false;
                    console.warn('[PanelTheme] 草稿预览应用外观抛错: ' + (e2 && e2.message ? e2.message : e2));
                }
                broadcast();
                res.applied = appliedInDraft;
                res.draft = true;
                return Promise.resolve(res);
            }
            // persist 放进 Promise 链：同步抛错与 rejected promise 归一成失败结果，
            // 与 ok===false 同一条回滚路径（否则内存态领先于盘、且异常逃给调用方）
            return Promise.resolve()
                .then(function () { return persist(getSettingsPatch()); })
                .then(function (ok) {
                    if (ok === false) {
                        if (opId === commitSeq) restoreState(before);
                        return { ok: false, error: 'PERSIST_FAILED', message: AEI18n.t('设置写入失败（localStorage 配额满或加密异常），主题未改动。') };
                    }
                    state.dropSnapshot = false;   // 清空快照的意图已随本次写入落盘
                    // 写入已成功：applier 抛错不回滚（回滚也撤不掉已落盘的设置），
                    // 但回执必须标 applied=false——否则调用方（工具层文案）会谎报外观已生效
                    var applied = true;
                    try {
                        applyCurrent();
                    } catch (e) {
                        applied = false;
                        console.warn('[PanelTheme] applyTheme 抛错，外观可能未完整生效: ' + (e && e.message ? e.message : e));
                    }
                    broadcast();
                    if (!applied) {
                        var out = {};
                        for (var k in res) {
                            if (Object.prototype.hasOwnProperty.call(res, k)) out[k] = res[k];
                        }
                        out.applied = false;
                        return out;
                    }
                    res.applied = true;
                    return res;
                }, function (e) {
                    if (opId === commitSeq) restoreState(before);
                    return { ok: false, error: 'PERSIST_FAILED', message: AEI18n.t('设置写入失败：') + (e && e.message ? e.message : e) };
                });
        }

        // fork 命名：源预设标签 + 「 副本」；重名追加序号。custom 档无方案时用「自定义方案」。
        function forkName() {
            var base = (state.themePreset === 'custom' || !labels[state.themePreset])
                ? AEI18n.t('自定义方案')
                : (labels[state.themePreset] + AEI18n.t(' 副本'));
            if (!findScheme(base)) return base;
            for (var n = 2; n <= 99; n++) {
                var candidate = base + ' ' + n;
                if (!findScheme(candidate)) return candidate;
            }
            return base + ' ' + now();
        }

        // textMain/appBg 对比度低于 WCAG AA（4.5:1）时给提示（不阻断）
        function contrastWarning() {
            var c = effectiveColors();
            var fg = parseColorToRgb(c.textMain);
            var bg = parseColorToRgb(c.appBg);
            if (!fg || !bg) return '';
            var ratio = contrastRatio(fg, bg);
            if (ratio >= 4.5) return '';
            return AEI18n.t('文本与背景对比度 {ratio}:1，低于 4.5:1，面板文字可能不易辨认。', { ratio: ratio.toFixed(2) });
        }

        // 改色：目标方案（opts.preset 指定 / 当前方案 / 必要时 fork）合并覆盖传入键。
        // 非法键与非法值不整体失败：忽略并在 ignored 中如实回报；全部非法才失败。
        function setColors(colors, opts) {
            opts = opts || {};
            return commit(function () {
                if (!colors || typeof colors !== 'object' || Array.isArray(colors)) {
                    return { ok: false, error: 'MISSING_COLORS', message: AEI18n.t('缺少参数 colors（对象，键为可编辑核心色）。') };
                }
                var keys = Object.keys(colors);
                if (!keys.length) {
                    return { ok: false, error: 'MISSING_COLORS', message: AEI18n.t('colors 为空对象，没有可改的键。') };
                }
                // 目标方案：显式 preset > 「custom 档的当前方案」。内置档一律视为无当前方案——
                // activeCustomThemePresetId 在切回内置档后按设计保留（供 UI 高亮），
                // 若直接拿它当目标，内置档改色会去改那套旧方案而不是 fork（与 spec 的 fork 规则相反）。
                var target = opts.preset
                    ? findScheme(opts.preset)
                    : (state.themePreset === 'custom' ? activeScheme() : null);
                var forked = false;
                if (!target) {
                    if (opts.preset) {
                        return {
                            ok: false,
                            error: 'PRESET_NOT_FOUND',
                            message: AEI18n.t('方案「') + opts.preset + AEI18n.t('」不存在。现有方案：') + schemeNames() + AEI18n.punct('。', '.', '。')
                        };
                    }
                    if (state.customThemePresets.length >= MAX_PRESETS) {
                        return {
                            ok: false, error: 'PRESET_LIMIT',
                            message: AEI18n.t('方案数已达上限 ') + MAX_PRESETS + AEI18n.t(' 套，请先删除不用的方案。')
                        };
                    }
                    target = {
                        id: newSchemeId(),
                        name: forkName(),
                        // fork 以**当前生效色**为底（含快照保留的非白名单键）：只复制核心色、
                        // 或退化成 presets.default 打底，都会让调用方没传的键静默变回 default
                        colors: cloneShallow(effectiveColors()),
                        createdAt: now(),
                        updatedAt: now()
                    };
                    state.customThemePresets.push(target);
                    forked = true;
                }
                var appliedKeys = [];
                var ignored = [];
                for (var i = 0; i < keys.length; i++) {
                    var k = keys[i];
                    if (editableKeys.indexOf(k) < 0) {
                        ignored.push({ key: k, reason: AEI18n.t('不在可编辑核心色清单内') });
                        continue;
                    }
                    if (!isColorValue(colors[k])) {
                        ignored.push({ key: k, reason: AEI18n.t('色值格式非法（接受 #rrggbb / rgba(r,g,b,a) / r,g,b）') });
                        continue;
                    }
                    target.colors[k] = colors[k];
                    appliedKeys.push(k);
                }
                if (!appliedKeys.length) {
                    return {
                        ok: false, error: 'NO_VALID_COLORS',
                        message: AEI18n.t('没有可用的颜色值，主题未改动。'),
                        ignored: ignored
                    };
                }
                // 目标方案即当前方案；切换档位与指针
                state.themePreset = 'custom';
                state.activeCustomThemePresetId = target.id;
                target.updatedAt = now();
                return {
                    ok: true,
                    appliedKeys: appliedKeys,
                    ignored: ignored,
                    scheme: { id: target.id, name: target.name },
                    forked: forked,
                    warning: contrastWarning()
                };
            }, opts);
        }

        function resolveNameOrId(nameOrId, listHint) {
            var s = findScheme(nameOrId);
            if (!s) {
                return {
                    ok: false,
                    error: 'PRESET_NOT_FOUND',
                    message: AEI18n.t('方案「') + nameOrId + AEI18n.t('」不存在。现有方案：') + (listHint || schemeNames()) + AEI18n.punct('。', '.', '。')
                };
            }
            return { ok: true, scheme: s };
        }

        // 保存方案：同名更新（幂等），否则新建。colors 缺省 = 当前生效色。
        // 给定 colors 时以当前生效色为底合并（保留非白名单键）。
        function savePreset(name, colors, apply, opts) {
            opts = opts || {};
            return commit(function () {
                var clean = normalizeName(name);
                if (!clean) {
                    return { ok: false, error: 'INVALID_NAME', message: AEI18n.t('方案名需为去空白后 1–') + NAME_MAX + AEI18n.t(' 个字符。') };
                }
                var overrides = {};
                var ignored = [];
                if (colors && typeof colors === 'object' && !Array.isArray(colors)) {
                    var keys = Object.keys(colors);
                    for (var i = 0; i < keys.length; i++) {
                        var k = keys[i];
                        if (editableKeys.indexOf(k) < 0) { ignored.push({ key: k, reason: AEI18n.t('不在可编辑核心色清单内') }); continue; }
                        if (!isColorValue(colors[k])) { ignored.push({ key: k, reason: AEI18n.t('色值格式非法') }); continue; }
                        overrides[k] = colors[k];
                    }
                }
                var existing = findScheme(clean);
                var created = false;
                var scheme = existing;
                if (!existing) {
                    if (state.customThemePresets.length >= MAX_PRESETS) {
                        return { ok: false, error: 'PRESET_LIMIT', message: AEI18n.t('方案数已达上限 ') + MAX_PRESETS + AEI18n.t(' 套，请先删除不用的方案。') };
                    }
                    var base = effectiveColors();   // 完整主题对象（custom 档 = default 打底 + 方案覆盖）
                    for (var k2 in overrides) {
                        if (Object.prototype.hasOwnProperty.call(overrides, k2)) base[k2] = overrides[k2];
                    }
                    scheme = {
                        id: newSchemeId(), name: clean, colors: base,
                        createdAt: now(), updatedAt: now()
                    };
                    state.customThemePresets.push(scheme);
                    created = true;
                } else {
                    for (var k3 in overrides) {
                        if (Object.prototype.hasOwnProperty.call(overrides, k3)) scheme.colors[k3] = overrides[k3];
                    }
                    scheme.updatedAt = now();
                }
                if (apply !== false) {
                    state.themePreset = 'custom';
                    state.activeCustomThemePresetId = scheme.id;
                }
                return {
                    ok: true, action: 'save', created: created,
                    scheme: { id: scheme.id, name: scheme.name }, ignored: ignored
                };
            }, opts);
        }

        function applyPreset(nameOrId, opts) {
            opts = opts || {};
            return commit(function () {
                var found = resolveNameOrId(nameOrId);
                if (!found.ok) return found;
                state.themePreset = 'custom';
                state.activeCustomThemePresetId = found.scheme.id;
                return { ok: true, action: 'apply', scheme: { id: found.scheme.id, name: found.scheme.name } };
            }, opts);
        }

        function renamePreset(nameOrId, newName, opts) {
            opts = opts || {};
            return commit(function () {
                var found = resolveNameOrId(nameOrId);
                if (!found.ok) return found;
                var clean = normalizeName(newName);
                if (!clean) {
                    return { ok: false, error: 'INVALID_NAME', message: AEI18n.t('新方案名需为去空白后 1–') + NAME_MAX + AEI18n.t(' 个字符。') };
                }
                var dup = findScheme(clean);
                if (dup && dup.id !== found.scheme.id) {
                    return { ok: false, error: 'NAME_TAKEN', message: AEI18n.t('已有同名方案「') + clean + AEI18n.punct('」。', '".', '」。', '“.', '”.', ' ». ', '».') };
                }
                found.scheme.name = clean;
                found.scheme.updatedAt = now();
                return { ok: true, action: 'rename', scheme: { id: found.scheme.id, name: clean } };
            }, opts);
        }

        function deletePreset(nameOrId, opts) {
            opts = opts || {};
            return commit(function () {
                var found = resolveNameOrId(nameOrId);
                if (!found.ok) return found;
                var victim = found.scheme;
                var wasPointer = state.activeCustomThemePresetId === victim.id;
                // 只有「被删的正是当前生效方案」才回落默认档：指针在内置档会被保留（供 UI 高亮），
                // 那种情况下删它不该把用户正在看的那个内置预设顶掉。
                var wasLive = wasPointer && state.themePreset === 'custom';
                var next = [];
                for (var i = 0; i < state.customThemePresets.length; i++) {
                    if (state.customThemePresets[i].id !== victim.id) next.push(state.customThemePresets[i]);
                }
                state.customThemePresets = next;
                if (wasPointer) state.activeCustomThemePresetId = '';
                if (wasLive) state.themePreset = 'default';
                // 库被删空 → 连快照一起清掉并落盘，否则重启时旧快照会被包装成「手动方案」
                state.dropSnapshot = !state.customThemePresets.length;
                return {
                    ok: true, action: 'delete',
                    deleted: { id: victim.id, name: victim.name },
                    pointerCleared: wasPointer,
                    fellBackToDefault: wasLive
                };
            }, opts);
        }

        function resetToDefault(opts) {
            opts = opts || {};
            return commit(function () {
                state.themePreset = 'default';
                return { ok: true, action: 'reset_default' };
            }, opts);
        }

        // 内置档 / custom 档切换（UI 预设下拉的保存路径；Agent 工具不暴露内置档）
        function setPresetKey(key, opts) {
            opts = opts || {};
            return commit(function () {
                if (PRESET_KEYS.indexOf(key) < 0) {
                    return { ok: false, error: 'INVALID_PRESET', message: AEI18n.t('未知预设档：') + key };
                }
                if (key !== 'custom' && !presets[key]) {
                    return { ok: false, error: 'INVALID_PRESET', message: AEI18n.t('预设不存在：') + key };
                }
                state.themePreset = key;
                if (key === 'custom' && !activeScheme() && state.customThemePresets.length) {
                    state.activeCustomThemePresetId = state.customThemePresets[0].id;
                }
                return { ok: true, action: 'set_preset', preset: key };
            }, opts);
        }

        function subscribe(fn) {
            if (typeof fn !== 'function') return function () {};
            subscribers.push(fn);
            return function () {
                var i = subscribers.indexOf(fn);
                if (i >= 0) subscribers.splice(i, 1);
            };
        }

        function migrateLegacy() {
            if (state.customThemePresets.length) return false;
            var legacy = state.customThemeColors;
            if (!legacy) return false;
            var hasKey = false;
            for (var i = 0; i < editableKeys.length; i++) {
                if (legacy[editableKeys[i]] != null) { hasKey = true; break; }
            }
            if (!hasKey) return false;
            var ts = now();
            var scheme = {
                id: newSchemeId(),
                name: AEI18n.t('手动方案'),
                colors: cloneShallow(legacy),
                createdAt: ts,
                updatedAt: ts
            };
            state.customThemePresets = [scheme];
            state.activeCustomThemePresetId = scheme.id;
            return true;
        }

        // 读入归一化：缺 id / id 重复的条目各得一个新 id（否则重复项按 id 不可达，
        // 且 findScheme 首个命中会让第二项永远选不中）；缺名称回落 id（列表里可见、可寻址）。
        function normalizeScheme(raw, seenIds) {
            var s = (raw && typeof raw === 'object') ? raw : {};
            var id = (typeof s.id === 'string' && s.id && !seenIds[s.id]) ? s.id : newSchemeId(seenIds);
            seenIds[id] = true;
            return {
                id: id,
                name: (typeof s.name === 'string' && s.name) ? s.name : id,
                colors: cloneShallow(s.colors),
                createdAt: s.createdAt || 0,
                updatedAt: s.updatedAt || 0
            };
        }

        function init() {
            return Promise.resolve().then(function () { return load(); }).then(function (settings) {
                settings = settings || {};
                state.themePreset = PRESET_KEYS.indexOf(settings.themePreset) >= 0 ? settings.themePreset : 'default';
                var seen = {};
                state.customThemePresets = Array.isArray(settings.customThemePresets)
                    ? settings.customThemePresets.map(function (s) { return normalizeScheme(s, seen); })
                    : [];
                state.activeCustomThemePresetId = settings.activeCustomThemePresetId || '';
                state.customThemeColors = (settings.customThemeColors && typeof settings.customThemeColors === 'object')
                    ? cloneShallow(settings.customThemeColors) : null;
                var migrated = migrateLegacy();
                // 快照 = 当前生效色（仅 custom 档）：init 后 getState()/getSettingsPatch() 与
                // commit() 内的同一条不变量对齐——否则内存快照停在 loaded 值（无 customThemeColors
                // 键时为 null），custom 档 patch 会写出空快照而非「当前生效色快照」。
                if (state.themePreset === 'custom') {
                    state.customThemeColors = state.customThemePresets.length ? effectiveColors() : null;
                }
                if (!migrated) return getState();
                // 迁移写盘是尽力而为：抛错/拒绝与 ok===false 一样只记日志，不阻断面板启动
                // （与 commit() 的 fail-closed 不同——这里没有用户动作可回滚，且下次启动会重试）
                return Promise.resolve()
                    .then(function () { return persist(getSettingsPatch()); })
                    .then(function (ok) {
                        if (ok === false) {
                            console.warn('[PanelTheme] 迁移结果未能落盘（本次仅在内存生效），下次启动重试');
                        }
                        return getState();
                    }, function (e) {
                        console.warn('[PanelTheme] 迁移落盘抛错（本次仅在内存生效），下次启动重试: '
                            + (e && e.message ? e.message : e));
                        return getState();
                    });
            });
        }

        return {
            init: init,
            getState: getState,
            getSettingsPatch: getSettingsPatch,
            effectiveColors: effectiveColors,
            editableColors: editableColors,
            setColors: setColors,
            savePreset: savePreset,
            applyPreset: applyPreset,
            renamePreset: renamePreset,
            deletePreset: deletePreset,
            resetToDefault: resetToDefault,
            setPresetKey: setPresetKey,
            contrastWarning: contrastWarning,
            subscribe: subscribe,
            // 编辑草稿（全局设置弹窗的主题事务）
            beginDraft: beginDraft,
            commitDraft: commitDraft,
            discardDraft: discardDraft,
            isDraftActive: function () { return draftActive; }
        };
    }

    createPanelTheme.MAX_PRESETS = MAX_PRESETS;
    createPanelTheme.isColorValue = isColorValue;
    createPanelTheme.parseColorToRgb = parseColorToRgb;
    createPanelTheme.contrastRatio = contrastRatio;
    createPanelTheme.normalizeName = normalizeName;

    global.AEShared = global.AEShared || {};
    global.AEShared.createPanelTheme = createPanelTheme;
})(window);
