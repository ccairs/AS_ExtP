/**
 * theme-hardcoded-audit.js — 硬编码主题色防复发卡口
 *
 * 规则：
 *   CSS 中出现与主题核心色相同的色值（hex 或任意 alpha 的 rgba 变体）即失败，
 *   必须改写为 var(--xxx) / rgba(var(--xxx-rgb),α)。
 *
 * 豁免（合法硬编码）：
 *   - :root 静态定义行（变量定义本身，经 theme-baseline 解析进 defs，不进 cssRows）
 *   - [data-theme] 补丁块（eva 例外机制，刻意回填默认色）
 *   - .cube-modal / .cube-icon（cube 3D 导航页与左上角 cube 图标：固定琥珀金 HUD 配色，
 *     刻意不随主题——见 panel.css 同名注释块。当前该块只**重声明变量**，而自定义属性定义
 *     走 defs 不进 cssRows，所以本条现在是策略白名单：为将来写在 cube 子树里的字面量色值兜底）
 *   - 黑白中性色（r=g=b，遮罩/高光/阴影，规范允许）
 *
 * 用法：
 *   node tools/theme-hardcoded-audit.js     # 扫描，命中 exit 1
 *   npm run audit:theme
 */

const { buildAll } = require('./theme-baseline.js');

// 主题核心色 → 建议变量（default 预设值；命中即硬编码了主题色）
const CORE_COLORS = [
    { hex: '#fbbf24', rgb: '251,191,36', varName: '--accent' },
    { hex: '#f97316', rgb: '249,115,22', varName: '--accent-2' },
    { hex: '#8f6dce', rgb: '143,109,206', varName: '--accent-purple' },
    { hex: '#ff8a8a', rgb: '255,138,138', varName: '--danger' },
    { hex: '#4ade80', rgb: '74,222,128', varName: '--signal-green' },
    { hex: '#3b82f6', rgb: '59,130,246', varName: '--vision-proxy' },
    { hex: '#2a303a', rgb: '42,48,58', varName: '--border-rgb' } // 旧 :root border 静态值族
];

// 选择器豁免（eva 补丁块 / cube HUD 固定金，见文件头说明）。
// 注：.btn.run（运行/发送主按钮）由 rgba(var(--accent-rgb),α) 推导，
// 故 .btn.run 不进选择器豁免——留在这里会让规则悄悄失效。
const SEL_EXEMPT_RE = /\[data-theme|\.cube-modal|\.cube-icon/;

function audit() {
    const data = buildAll();
    const violations = [];

    for (const row of data.cssRows) {
        if (SEL_EXEMPT_RE.test(row.sel)) continue;
        // 剥掉 var(...) 段，只查硬编码字面量
        const literal = String(row.raw).replace(/var\([^)]*\)/g, '');
        for (const c of CORE_COLORS) {
            const hexRe = new RegExp(c.hex.slice(1) + '(?![0-9a-fA-F])', 'i');
            const rgbRe = new RegExp(c.rgb.replace(/,/g, '\\s*,\\s*'), '');
            if (hexRe.test(literal) || rgbRe.test(literal)) {
                violations.push({
                    where: `${row.file}:${row.line} [${row.sel}] ${row.prop}`,
                    color: c.hex,
                    suggest: `var(${c.varName}) / rgba(var(${c.varName}-rgb),α)`
                });
            }
        }
    }

    if (violations.length > 0) {
        console.error(`=== 硬编码主题色 ${violations.length} 处（必须改用变量）===`);
        for (const v of violations) {
            console.error(`${v.where}`);
            console.error(`  ${v.color} → ${v.suggest}`);
        }
        process.exitCode = 1;
        return;
    }
    console.log(`硬编码主题色审计通过：${data.cssRows.length} 条声明无违规（黑白中性色/eva 补丁/cube HUD 豁免）`);
}

audit();
