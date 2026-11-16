// Agent 模块主题应用器（主题变量写入 + 按设置应用预设）
// 从 app/main.js 拆出：
//   - shared/theme.js 通过 global.applyThemeFromSettings 调用，必须保留 window 挂载
//   - THEME_PRESETS 来自 shared/theme-presets.js（global.AE_THEME_PRESETS）
// 本文件是主题唯一 applier；
//   预设不存派生键（rgb 三元组 / soft 变体），统一由 deriveThemeColors 计算。
(function (global) {
    var THEME_PRESETS = global.AE_THEME_PRESETS || {};

    // 语义状态色扩展：预设键名（camelCase）= CSS 变量名去掉连字符后的小驼峰
    var EXTRA_STATUS_KEYS = ['dangerVivid', 'dangerDeep', 'warningVivid', 'link', 'reason', 'drag'];
    // camelCase → CSS 变量前缀（dangerVivid → --danger-vivid）
    function cssVarName(key) {
        return '--' + key.replace(/[A-Z]/g, function (c) { return '-' + c.toLowerCase(); });
    }

    // hex(#rrggbb) → "r,g,b" 三元组，解析失败返回 null
    function hexToRgbTriplet(hex) {
        var m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
        if (!m) return null;
        var n = parseInt(m[1], 16);
        return ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255);
    }

    // hex(#rrggbb) + alpha → "rgba(r,g,b,alpha)"，解析失败返回 null
    function softRgba(hex, alpha) {
        var t = hexToRgbTriplet(hex);
        return t ? 'rgba(' + t + ',' + alpha + ')' : null;
    }

    // 任意色值（#rgb / #rrggbb / rgb() / rgba()）→ "r,g,b" 三元组，解析失败返回 null。
    // 核心色里 surface2/surface3/inputBg 默认就是 rgba（见 theme-presets），只认 hex 会漏。
    function toRgbTriplet(v) {
        var t = hexToRgbTriplet(v);
        if (t) return t;
        var m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(v || '');
        return m ? (parseInt(m[1], 10) + ',' + parseInt(m[2], 10) + ',' + parseInt(m[3], 10)) : null;
    }

    // 强调色上的前景色（深/浅墨）：主按钮在 custom 改色后由 accent 推底色，文字必须自己选
    // 深/浅——否则浅色主题下白底白字、深底深字都会瞎。按 WCAG 相对亮度算黑/白两种前景的
    // 对比度，取高的那支：金 #fbbf24 → 深墨 #12161c；二号机红 #D62828 → 浅墨 #f7f8fa。
    var INK_DARK = '#12161c';
    var INK_LIGHT = '#f7f8fa';

    function relativeLuminance(triplet) {
        var parts = String(triplet || '').split(',');
        if (parts.length !== 3) return null;
        var lin = [];
        for (var i = 0; i < 3; i++) {
            var c = parseInt(parts[i], 10) / 255;
            if (!isFinite(c)) return null;
            lin.push(c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
        }
        return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    }

    function contrastInk(color) {
        var l = relativeLuminance(toRgbTriplet(color));
        if (l === null) return '';
        var onLight = 1.05 / (l + 0.05); // 浅色前景的对比度
        var onDark = (l + 0.05) / 0.05;  // 深色前景的对比度
        return onLight >= onDark ? INK_LIGHT : INK_DARK;
    }

    // 主按钮（.btn.run）专用配色：默认/内置档直接用预设里那套「暗底 + 亮描边 + 亮字」原值；
    // 只有 custom 档**改过 accent** 时才由 accent 派生一套同形状的深色版（accent 按 30%/38%
    // 混进 appBg 当底，描边取 accent 本身，文字按对比度选墨）。
    // 没改 accent ⇒ 返回空对象 ⇒ 保留 default 预设原值 ⇒ 与默认档逐字一致。
    function mixRgb(aTriplet, bTriplet, w) {
        var a = String(aTriplet || '').split(',');
        var b = String(bTriplet || '').split(',');
        if (a.length !== 3 || b.length !== 3) return null;
        var out = [];
        for (var i = 0; i < 3; i++) {
            var av = parseInt(a[i], 10);
            var bv = parseInt(b[i], 10);
            if (!isFinite(av) || !isFinite(bv)) return null;
            out.push(Math.max(0, Math.min(255, Math.round(av * w + bv * (1 - w)))));
        }
        return out.join(',');
    }

    function deriveRunColors(t) {
        if (sameAsDefault(t, 'accent')) return {};
        var ac = toRgbTriplet(t.accent);
        var bg = toRgbTriplet(t.appBg) || '0,0,0';
        if (!ac) return {};
        var runBg = mixRgb(ac, bg, 0.3);
        var runHoverBg = mixRgb(ac, bg, 0.38);
        if (!runBg || !runHoverBg) return {};
        return {
            runBg: 'rgb(' + runBg + ')',
            runHoverBg: 'rgb(' + runHoverBg + ')',
            runBorder: t.accent,
            runText: contrastInk('rgb(' + runBg + ')') || INK_LIGHT
        };
    }

    // 低频表面色 / 弹窗分隔线 / Agent 顶栏：这 11 个键**不在主题弹窗那 20 项可编辑清单里**，
    // 但 applier 照样会写进 CSS（共 77 处引用）。custom 档照抄 default 打底值时 ⇒ 它们
    // 永远不随主题变化——AE 工具面板/表格、所有 .modal、
    // 素材库卡片、Agent 顶栏、底部状态栏在 20 项全刷白后仍然是黑的。
    // 这里对 custom 档一律由核心色派生（表面色统一跟 surface1「弹窗菜单底」走），
    // 内置 default/eva01/eva02 三档仍用预设里写死的值 → 外观零变化。
    //
    // 不变量：**用户没改过的源核心色，其对应低频键保持 default 预设原值**。
    // 起因：派生公式与 default 写死的值不是同一个数（surfacePanel 由 surface1 #1a1e24 派生成
    // rgba(26,30,36,.7)，而 default 写的是 rgba(12,16,22,.7)），于是「自定义档什么都没改」
    // 却比默认主题整体亮一档——自定义主题默认应与默认主题一样。
    // 现在按源键判定：源色 == default ⇒ 用 default 原值；源色被改过 ⇒ 才走派生公式。
    // 于是 custom 空方案与 default 逐变量同值。
    function sameAsDefault(t, key) {
        var d = (THEME_PRESETS && THEME_PRESETS.default) || {};
        if (!Object.prototype.hasOwnProperty.call(d, key)) return false;
        var a = toRgbTriplet(t[key]);
        return !!a && a === toRgbTriplet(d[key]);
    }

    function deriveSurfaces(t) {
        var d = (THEME_PRESETS && THEME_PRESETS.default) || {};
        var bg = toRgbTriplet(t.appBg) || '0,0,0';
        var s1 = toRgbTriplet(t.surface1) || bg;
        var s2 = toRgbTriplet(t.surface2) || s1;
        var s3 = toRgbTriplet(t.surface3) || s1;
        var bd = toRgbTriplet(t.border) || s1;
        var tm = toRgbTriplet(t.textMain) || '255,255,255';
        var ac = toRgbTriplet(t.accent) || '255,255,255';
        // 源核心色未改 ⇒ 保持 default 原值（不是「派生出来的近似值」）
        var keepS1 = sameAsDefault(t, 'surface1');
        var keepS2 = sameAsDefault(t, 'surface2') && sameAsDefault(t, 'surface3');
        var keepTm = sameAsDefault(t, 'textMain');
        var keepAc = sameAsDefault(t, 'accent');
        var keepBd = sameAsDefault(t, 'border');
        function keep(same, key, derived) {
            return (same && d[key]) ? d[key] : derived;
        }
        return {
            borderRgb: keep(keepBd, 'borderRgb', bd),
            surfacePanel: keep(keepS1, 'surfacePanel', 'rgba(' + s1 + ',.7)'),
            surfaceBar: keep(keepS1, 'surfaceBar', 'rgba(' + s1 + ',.8)'),
            surfaceTableWrap: keep(keepS1, 'surfaceTableWrap', 'rgba(' + s1 + ',.6)'),
            surfaceModal: keep(keepS1, 'surfaceModal', 'rgba(' + s1 + ',.96)'),
            surfaceCard: keep(keepS1, 'surfaceCard', 'rgb(' + s1 + ')'),
            // 分隔线取正文色的极低透明度：深色主题 = 白线（与改动前同观感），
            // 浅色主题自动翻成黑线（写死白 alpha 时，浅底上等于看不见）
            borderModal: keep(keepTm, 'borderModal', 'rgba(' + tm + ',.08)'),
            borderModalLight: keep(keepTm, 'borderModalLight', 'rgba(' + tm + ',.06)'),
            agentTopbarBg: keep(keepS2, 'agentTopbarBg', 'linear-gradient(135deg, rgba(' + s2 + ',.9), rgba(' + s3 + ',.85))'),
            agentTopbarHighlightBg: keep(keepS2, 'agentTopbarHighlightBg', 'linear-gradient(135deg, rgba(' + s3 + ',.9), rgba(' + s2 + ',.85))'),
            agentTopbarHighlightShadow: keep(keepAc, 'agentTopbarHighlightShadow', '0 0 0 1px rgba(' + ac + ',.5), 0 0 20px rgba(' + ac + ',.2)')
        };
    }

    // 派生键统一计算：rgb 三元组 / soft 变体从核心色派生（alpha 统一 .15，柔光 .06）。
    // 存量 customThemeColors 数据中的旧派生键优先（不覆盖），仅补缺失项；返回浅拷贝。
    function deriveThemeColors(theme) {
        var t = {};
        var src = theme || {};
        for (var k in src) {
            if (Object.prototype.hasOwnProperty.call(src, k)) t[k] = src[k];
        }
        t.accentRgb = t.accentRgb || hexToRgbTriplet(t.accent) || '';
        t.accentSoft = t.accentSoft || softRgba(t.accent, '.15') || '';
        t.accent2Rgb = t.accent2Rgb || hexToRgbTriplet(t.accent2) || '';
        t.accent2Soft = t.accent2Soft || softRgba(t.accent2, '.15') || '';
        t.accentPurpleRgb = t.accentPurpleRgb || hexToRgbTriplet(t.accentPurple) || '';
        t.signalGreenSoft = t.signalGreenSoft || softRgba(t.signalGreen, '.15') || '';
        t.signalGreenRgb = t.signalGreenRgb || hexToRgbTriplet(t.signalGreen) || '';
        t.dangerRgb = t.dangerRgb || hexToRgbTriplet(t.danger) || '';
        t.warningSoft = t.warningSoft || softRgba(t.warning, '.15') || '';
        t.visionProxyRgb = t.visionProxyRgb || hexToRgbTriplet(t.visionProxy) || '';
        // 语义状态色扩展：6 个键各自派生 rgb 三元组 + .15 soft，
        // 供「同色不同 alpha」的站点写成 rgba(var(--x-rgb), α)
        for (var ei = 0; ei < EXTRA_STATUS_KEYS.length; ei++) {
            var key = EXTRA_STATUS_KEYS[ei];
            t[key + 'Rgb'] = t[key + 'Rgb'] || hexToRgbTriplet(t[key]) || '';
            t[key + 'Soft'] = t[key + 'Soft'] || softRgba(t[key], '.15') || '';
        }
        return t;
    }

    // 将主题变量写入文档根节点，供模块区域即时生效
    function applyThemeVars(theme) {
        const root = document.documentElement;
        if (!root || !theme) {
            return;
        }
        const t = deriveThemeColors(theme);

        root.style.setProperty('--app-bg', t.appBg);
        root.style.setProperty('--surface-1', t.surface1);
        root.style.setProperty('--surface-2', t.surface2);
        root.style.setProperty('--surface-3', t.surface3);
        root.style.setProperty('--border', t.border);
        root.style.setProperty('--text-main', t.textMain);
        root.style.setProperty('--text-muted', t.textMuted);
        root.style.setProperty('--accent', t.accent);
        root.style.setProperty('--accent-soft', t.accentSoft);
        root.style.setProperty('--accent-rgb', t.accentRgb);
        // 主按钮（.btn.run）专用配色：预设原值（default = 最初的暗金签名配色），
        // custom 改过 accent 时已被 deriveRunColors 换成 accent 派生值
        root.style.setProperty('--run-bg', t.runBg);
        root.style.setProperty('--run-border', t.runBorder);
        root.style.setProperty('--run-text', t.runText);
        root.style.setProperty('--run-hover-bg', t.runHoverBg);
        root.style.setProperty('--input-bg', t.inputBg);
        root.style.setProperty('--btn-bg', t.btnBg);
        root.style.setProperty('--btn-border', t.btnBorder);
        root.style.setProperty('--btn-text', t.btnText);
        root.style.setProperty('--btn-hover-bg', t.btnHoverBg);
        root.style.setProperty('--accent-2', t.accent2);
        root.style.setProperty('--accent-2-soft', t.accent2Soft);
        root.style.setProperty('--accent-2-rgb', t.accent2Rgb);
        root.style.setProperty('--accent-purple', t.accentPurple);
        root.style.setProperty('--accent-purple-rgb', t.accentPurpleRgb);
        root.style.setProperty('--danger', t.danger);
        root.style.setProperty('--danger-soft', t.dangerSoft);
        root.style.setProperty('--signal-green', t.signalGreen);
        root.style.setProperty('--signal-green-soft', t.signalGreenSoft);
        root.style.setProperty('--signal-green-rgb', t.signalGreenRgb);
        root.style.setProperty('--danger-rgb', t.dangerRgb);
        root.style.setProperty('--warning', t.warning);
        root.style.setProperty('--warning-soft', t.warningSoft);
        root.style.setProperty('--vision-proxy', t.visionProxy || '#3b82f6');
        root.style.setProperty('--vision-proxy-rgb', t.visionProxyRgb || '59,130,246');

        // 语义状态色扩展：主色 + rgb 三元组 + soft
        for (var si = 0; si < EXTRA_STATUS_KEYS.length; si++) {
            var sk = EXTRA_STATUS_KEYS[si];
            if (t[sk]) root.style.setProperty(cssVarName(sk), t[sk]);
            if (t[sk + 'Rgb']) root.style.setProperty(cssVarName(sk) + '-rgb', t[sk + 'Rgb']);
            if (t[sk + 'Soft']) root.style.setProperty(cssVarName(sk) + '-soft', t[sk + 'Soft']);
        }

        // 管理面板/弹窗/Agent顶栏表面色
        root.style.setProperty('--border-rgb', t.borderRgb);
        root.style.setProperty('--surface-panel', t.surfacePanel);
        root.style.setProperty('--surface-bar', t.surfaceBar);
        root.style.setProperty('--surface-table-wrap', t.surfaceTableWrap);
        root.style.setProperty('--surface-modal', t.surfaceModal);
        root.style.setProperty('--surface-card', t.surfaceCard);
        root.style.setProperty('--border-modal', t.borderModal);
        root.style.setProperty('--border-modal-light', t.borderModalLight);
        root.style.setProperty('--agent-topbar-bg', t.agentTopbarBg);
        root.style.setProperty('--agent-topbar-highlight-bg', t.agentTopbarHighlightBg);
        root.style.setProperty('--agent-topbar-highlight-shadow', t.agentTopbarHighlightShadow);
    }

    // 按预设名（或 'custom' + 自定义色）应用主题（main.js applyTheme 与 applyThemeFromSettings 的公共实现）
    function applyThemePreset(themePreset, customColors) {
        let theme;
        if (themePreset === 'custom') {
            // 自定义主题以 default 预设打底：面板未覆盖的核心键回落默认值，避免 setProperty
            // 写入 undefined 使变量失效。打底之后必须再走一层 deriveSurfaces——那 11 个低频键
            // （表面色/弹窗分隔线/Agent 顶栏）不在可编辑清单里，照抄打底值就永远不随主题变化。
            theme = Object.assign({}, THEME_PRESETS.default, customColors || {});
            theme = Object.assign(theme, deriveSurfaces(theme), deriveRunColors(theme));
        } else if (themePreset === 'default') {
            theme = THEME_PRESETS.default;
        } else {
            theme = THEME_PRESETS[themePreset] || THEME_PRESETS.default;
        }
        document.documentElement.setAttribute('data-theme', themePreset || 'default');
        applyThemeVars(theme);
        // 同步当前主题到热盒浮窗（写 <数据目录>\hotbox\theme.json，仅消费核心色键），失败静默用默认色
        if (global.AEShared && typeof global.AEShared.writeHotboxTheme === 'function') {
            global.AEShared.writeHotboxTheme(theme);
        }
    }

    function applyThemeFromSettings(settings) {
        applyThemePreset(settings.themePreset, settings.customThemeColors);
    }

    global.applyThemeVars = applyThemeVars;
    global.applyThemeFromSettings = applyThemeFromSettings;
    global.applyThemePreset = applyThemePreset;
    global.AEAgentApp = global.AEAgentApp || {};
    global.AEAgentApp.themeApplier = { applyThemeVars, applyThemePreset, applyThemeFromSettings, deriveThemeColors, deriveSurfaces, hexToRgbTriplet, toRgbTriplet };
})(window);
