/**
 * theme-baseline.js — 主题变量值等价基线工具
 *
 * 职责：
 *   1. 从 theme-presets.js（vm 沙箱）/ themeApplier.js（正则提取映射）/ panel.css :root
 *      构建「每主题有效变量表」（applier 设置的变量取预设值，其余取 :root 静态值）
 *   2. 解析 client 下 10 个 CSS 的全部含 var() / 颜色字面量的声明，逐主题解析最终值
 *   3. 扫描 JS / HTML 内联样式中的 var() 引用，同样逐主题解析
 *   4. 基线数据落盘；--diff 与基线对比，仅报告「解析值变化」
 *      （变量改名但三主题解析值不变 = 值等价，不报告）
 *
 * 用法：
 *   node tools/theme-baseline.js          # 生成/覆盖基线
 *   node tools/theme-baseline.js --diff   # 对比基线，有值差异 exit 1
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const OUT_DIR = path.join(ROOT, '.tmp', 'theme-baseline');

// ── 1. 预设数据（vm 沙箱加载） ──

function loadPresets() {
    const src = fs.readFileSync(path.join(CLIENT, 'shared', 'theme-presets.js'), 'utf8');
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const presets = ctx.window.AE_THEME_PRESETS;
    if (!presets || !presets.default || !presets.eva01 || !presets.eva02) {
        throw new Error('theme-presets.js 解析失败：缺少 default/eva01/eva02');
    }
    return presets;
}

// ── 2. applier 变量映射与派生函数（从 themeApplier.js 提取，与真实代码自同步） ──

// 在 vm 沙箱加载 themeApplier.js，取 deriveThemeColors（加载期不触 DOM，安全）
function loadThemeApplier() {
    const src = fs.readFileSync(path.join(CLIENT, 'modules', 'agent', 'app', 'themeApplier.js'), 'utf8');
    const ctx = { window: {} };
    vm.createContext(ctx);
    vm.runInContext(src, ctx);
    const applier = ctx.window.AEAgentApp && ctx.window.AEAgentApp.themeApplier;
    if (!applier || typeof applier.deriveThemeColors !== 'function') {
        throw new Error('themeApplier.js 加载失败：未找到 AEAgentApp.themeApplier.deriveThemeColors');
    }
    return applier;
}

function loadApplierMap() {
    const src = fs.readFileSync(path.join(CLIENT, 'modules', 'agent', 'app', 'themeApplier.js'), 'utf8');
    const out = [];
    const re = /setProperty\(\s*'(--[a-zA-Z0-9-]+)'\s*,\s*([^;]+?)\);/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        const cssVar = m[1];
        const expr = m[2];
        // 形态（|| 链）：t.key / theme.key / 'literal'（t.* 为派生补全后的主题对象）
        const segments = expr.split('||').map((seg) => {
            const s = seg.trim();
            let sm = /^(?:t|theme)\.(\w+)$/.exec(s);
            if (sm) return { type: 'key', name: sm[1] };
            sm = /^'([^']*)'$/.exec(s);
            if (sm) return { type: 'literal', value: sm[1] };
            throw new Error(`themeApplier.js setProperty 表达式段无法解析: "${s}"（完整表达式: ${expr}）`);
        });
        out.push({ cssVar, segments });
    }
    if (out.length < 38) {
        throw new Error(`themeApplier.js 仅提取到 ${out.length} 个 setProperty，预期 39+`);
    }
    return out;
}

// ── 3. :root 静态值（panel.css） ──

function loadRootStatic() {
    const src = fs.readFileSync(path.join(CLIENT, 'shared', 'styles', 'panel.css'), 'utf8');
    const start = src.indexOf(':root');
    if (start === -1) throw new Error('panel.css 未找到 :root');
    const open = src.indexOf('{', start);
    let depth = 1;
    let i = open + 1;
    while (i < src.length && depth > 0) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') depth--;
        i++;
    }
    const body = src.slice(open + 1, i - 1);
    const map = {};
    const re = /(--[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
    let m;
    while ((m = re.exec(body)) !== null) {
        map[m[1]] = m[2].trim();
    }
    return map;
}

// ── 4. 每主题有效变量表 ──

function buildEffectiveMap(preset, applierMap, rootStatic, deriveThemeColors) {
    const map = {};
    // 与运行时同构：applyThemeVars 先 deriveThemeColors(theme) 再 setProperty
    const derived = deriveThemeColors(preset);
    for (const a of applierMap) {
        let v = null;
        for (const seg of a.segments) {
            if (seg.type === 'key') v = derived[seg.name];
            else if (seg.type === 'literal') v = seg.value;
            else throw new Error(`未知 applier 表达式段类型: ${seg.type}`);
            if (v != null && v !== '') break;
        }
        if (v != null) map[a.cssVar] = String(v);
    }
    // applier 不设置、仅 :root 静态定义的变量（--danger-strong / --run-btn-* / --drag-accent）
    for (const [k, v] of Object.entries(rootStatic)) {
        if (!(k in map)) map[k] = v;
    }
    // 链式解析（如 --drag-accent: var(--accent)），带环保护
    const resolving = new Set();
    const resolveRef = (name) => {
        const v = map[name];
        if (typeof v !== 'string' || !v.includes('var(')) return v;
        if (resolving.has(name)) return '<CYCLE>';
        resolving.add(name);
        const r = substituteVars(v, map);
        resolving.delete(name);
        map[name] = r;
        return r;
    };
    for (const name of Object.keys(map)) resolveRef(name);
    return map;
}

// ── 5. var() 代换（括号深度扫描，支持嵌套 fallback） ──

function substituteVars(value, effMap, seen) {
    seen = seen || new Set();
    let out = '';
    let i = 0;
    while (i < value.length) {
        const idx = value.indexOf('var(', i);
        if (idx === -1) { out += value.slice(i); break; }
        const prev = idx === 0 ? '' : value[idx - 1];
        if (/[a-zA-Z0-9_-]/.test(prev)) { // 排除 somevar( 之类误匹配
            out += value.slice(i, idx + 4);
            i = idx + 4;
            continue;
        }
        out += value.slice(i, idx);
        let depth = 1;
        let j = idx + 4;
        while (j < value.length && depth > 0) {
            if (value[j] === '(') depth++;
            else if (value[j] === ')') depth--;
            j++;
        }
        const inner = value.slice(idx + 4, j - 1);
        // 顶层逗号切分 name / fallback
        let d = 0;
        let comma = -1;
        for (let c = 0; c < inner.length; c++) {
            if (inner[c] === '(') d++;
            else if (inner[c] === ')') d--;
            else if (inner[c] === ',' && d === 0) { comma = c; break; }
        }
        const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
        const fallback = comma === -1 ? null : inner.slice(comma + 1).trim();
        let resolved;
        if (seen.has(name)) {
            resolved = '<CYCLE>';
        } else if (name in effMap && effMap[name] !== undefined) {
            const v = effMap[name];
            resolved = typeof v === 'string' && v.includes('var(')
                ? substituteVars(v, effMap, new Set([...seen, name]))
                : String(v);
        } else if (fallback !== null) {
            resolved = substituteVars(fallback, effMap, seen);
        } else {
            resolved = '<UNDEF:' + name + '>';
        }
        out += resolved;
        i = j;
    }
    return out;
}

// ── 6. CSS 解析（注释等长替换保行号 / 字符串感知 / 跨行声明） ──

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
        if (text[i] === '\n') starts.push(i + 1);
    }
    return starts;
}

function lineOf(starts, idx) {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= idx) lo = mid;
        else hi = mid - 1;
    }
    return lo + 1;
}

const COLOR_TOKEN_RE = /#[0-9a-fA-F]{3,8}\b|rgba?\(/;

function parseCssFile(file, content) {
    // 注释替换为等长空白（保留换行，维持行号对齐）
    const stripped = content.replace(/\/\*[\s\S]*?\*\//g, (mm) => mm.replace(/[^\n]/g, ' '));
    const starts = lineStarts(stripped);
    const usages = [];  // {line, sel, prop, raw}
    const defs = [];    // 自定义属性定义 {line, sel, prop, raw}
    const stack = [];
    let preludeStart = 0;
    let declStart = -1;
    let i = 0;

    const skipString = () => {
        const quote = stripped[i];
        i++;
        while (i < stripped.length) {
            if (stripped[i] === '\\') { i += 2; continue; }
            if (stripped[i] === quote) { i++; return; }
            i++;
        }
    };

    while (i < stripped.length) {
        const ch = stripped[i];
        if (ch === '"' || ch === "'") { skipString(); continue; }
        if (ch === '{') {
            const prelude = stripped.slice(preludeStart, i).replace(/\s+/g, ' ').trim();
            stack.push(prelude || '<anon>');
            declStart = i + 1;
            preludeStart = i + 1;
            i++;
            continue;
        }
        if (ch === '}') {
            stack.pop();
            preludeStart = i + 1;
            declStart = -1;
            i++;
            continue;
        }
        if (ch === ';') {
            if (declStart >= 0) {
                emitDeclaration(stripped.slice(declStart, i));
            }
            preludeStart = i + 1;
            declStart = i + 1;
            i++;
            continue;
        }
        i++;
    }

    function emitDeclaration(text) {
        const t = text.replace(/\s+/g, ' ').trim();
        if (!t) return;
        const m = /^(-{0,2}[a-zA-Z][a-zA-Z0-9-]*)\s*:\s*(.+)$/.exec(t);
        if (!m) return;
        const prop = m[1];
        const raw = m[2].trim();
        const sel = stack.join(' | ');
        const line = lineOf(starts, declStart);
        if (prop.startsWith('--')) {
            defs.push({ line, sel, prop, raw });
        } else if (raw.includes('var(') || COLOR_TOKEN_RE.test(raw)) {
            usages.push({ line, sel, prop, raw });
        }
    }

    return { file, usages, defs };
}

// ── 7. JS / HTML 内联 var() 扫描 ──

function walkFiles(dir, exts, out) {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === 'dist' || ent.name === 'vendor' || ent.name === 'node_modules') continue;
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walkFiles(p, exts, out);
        else if (exts.includes(path.extname(ent.name))) out.push(p);
    }
    return out;
}

function scanInlineVarUsages(effMaps) {
    const files = walkFiles(CLIENT, ['.js', '.html'], []);
    const rows = [];
    for (const f of files) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        const lines = fs.readFileSync(f, 'utf8').split('\n');
        for (let ln = 0; ln < lines.length; ln++) {
            const text = lines[ln];
            let idx = 0;
            while ((idx = text.indexOf('var(--', idx)) !== -1) {
                const prev = idx === 0 ? '' : text[idx - 1];
                if (/[a-zA-Z0-9_-]/.test(prev)) { idx += 7; continue; }
                // 括号深度扫描取完整 var(...) 表达式
                let depth = 1;
                let j = idx + 4;
                while (j < text.length && depth > 0) {
                    if (text[j] === '(') depth++;
                    else if (text[j] === ')') depth--;
                    j++;
                }
                const inner = text.slice(idx + 4, j - 1);
                let d = 0, comma = -1;
                for (let c = 0; c < inner.length; c++) {
                    if (inner[c] === '(') d++;
                    else if (inner[c] === ')') d--;
                    else if (inner[c] === ',' && d === 0) { comma = c; break; }
                }
                const name = (comma === -1 ? inner : inner.slice(0, comma)).trim();
                const fallback = comma === -1 ? '' : inner.slice(comma + 1).trim();
                const row = { file: rel, line: ln + 1, varName: name, fallback };
                for (const [theme, map] of Object.entries(effMaps)) {
                    row[theme] = (name in map && map[name] !== undefined)
                        ? String(map[name])
                        : (fallback ? substituteVars(fallback, map) : '<UNDEF:' + name + '>');
                }
                rows.push(row);
                idx = j;
            }
        }
    }
    return rows;
}

// ── 8. 汇总与输出 ──

function buildAll() {
    const presets = loadPresets();
    const applierMap = loadApplierMap();
    const rootStatic = loadRootStatic();
    const { deriveThemeColors } = loadThemeApplier();
    const themeNames = ['default', 'eva01', 'eva02'];
    const effMaps = {};
    for (const t of themeNames) effMaps[t] = buildEffectiveMap(presets[t], applierMap, rootStatic, deriveThemeColors);

    const cssFiles = walkFiles(CLIENT, ['.css'], []);
    const cssRows = [];
    const defRows = [];
    for (const f of cssFiles) {
        const rel = path.relative(ROOT, f).replace(/\\/g, '/');
        const { usages, defs } = parseCssFile(rel, fs.readFileSync(f, 'utf8'));
        for (const u of usages) {
            const row = { ...u, file: rel };
            for (const t of themeNames) row[t] = substituteVars(u.raw, effMaps[t]);
            cssRows.push(row);
        }
        for (const dd of defs) {
            const row = { ...dd, file: rel };
            for (const t of themeNames) row[t] = substituteVars(dd.raw, effMaps[t]);
            defRows.push(row);
        }
    }
    const inlineRows = scanInlineVarUsages(effMaps);

    // 有效变量表（三主题并集，含 UNDEF 标记）
    const allVars = new Set();
    for (const map of Object.values(effMaps)) {
        for (const k of Object.keys(map)) allVars.add(k);
    }
    const varRows = [...allVars].sort().map((v) => ({
        varName: v,
        default: effMaps.default[v] != null ? String(effMaps.default[v]) : '<UNSET>',
        eva01: effMaps.eva01[v] != null ? String(effMaps.eva01[v]) : '<UNSET>',
        eva02: effMaps.eva02[v] != null ? String(effMaps.eva02[v]) : '<UNSET>'
    }));

    return { themeNames, varRows, cssRows, defRows, inlineRows, cssFiles };
}

function writeTsv(file, header, rows, toCells) {
    const lines = [header.join('\t')];
    for (const r of rows) {
        const cells = toCells(r).map((c) => String(c).replace(/[\t\n\r]/g, ' '));
        lines.push(cells.join('\t'));
    }
    fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

function writeBaseline(data) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    writeTsv(path.join(OUT_DIR, 'vars.tsv'), ['var', 'default', 'eva01', 'eva02'], data.varRows,
        (r) => [r.varName, r.default, r.eva01, r.eva02]);
    writeTsv(path.join(OUT_DIR, 'css.tsv'),
        ['file', 'line', 'sel', 'prop', 'raw', 'default', 'eva01', 'eva02'], data.cssRows,
        (r) => [r.file, r.line, r.sel, r.prop, r.raw, r.default, r.eva01, r.eva02]);
    writeTsv(path.join(OUT_DIR, 'defs.tsv'),
        ['file', 'line', 'sel', 'prop', 'raw', 'default', 'eva01', 'eva02'], data.defRows,
        (r) => [r.file, r.line, r.sel, r.prop, r.raw, r.default, r.eva01, r.eva02]);
    writeTsv(path.join(OUT_DIR, 'inline.tsv'),
        ['file', 'line', 'var', 'fallback', 'default', 'eva01', 'eva02'], data.inlineRows,
        (r) => [r.file, r.line, r.varName, r.fallback, r.default, r.eva01, r.eva02]);
}

function readTsv(file) {
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
    const header = lines[0].split('\t');
    return lines.slice(1).map((l) => {
        const cells = l.split('\t');
        const o = {};
        header.forEach((h, i) => { o[h] = cells[i] != null ? cells[i] : ''; });
        return o;
    });
}

// ── 9. diff（仅比较三主题解析值；raw 变化但值等价不报告） ──

function keyRows(rows, keyFn) {
    const counts = new Map();
    const keyed = new Map();
    for (const r of rows) {
        const base = keyFn(r);
        const n = (counts.get(base) || 0) + 1;
        counts.set(base, n);
        keyed.set(`${base} #${n}`, r);
    }
    return keyed;
}

function diffTables(name, oldRows, newRows, keyFn, valFn, labelFn) {
    const normVal = (s) => String(s).replace(/\s*,\s*/g, ',').replace(/\s+/g, ' ').trim();
    const oldK = keyRows(oldRows || [], keyFn);
    const newK = keyRows(newRows || [], keyFn);
    const diffs = [];
    for (const [k, orow] of oldK) {
        const nrow = newK.get(k);
        if (!nrow) {
            diffs.push({ type: 'REMOVED', key: k, label: labelFn(orow), old: valFn(orow), neu: '' });
            continue;
        }
        const ov = valFn(orow);
        const nv = valFn(nrow);
        if (normVal(ov) !== normVal(nv)) {
            diffs.push({ type: 'CHANGED', key: k, label: labelFn(nrow), old: ov, neu: nv, rawOld: orow.raw, rawNew: nrow.raw });
        }
    }
    for (const [k, nrow] of newK) {
        if (!oldK.has(k)) {
            diffs.push({ type: 'ADDED', key: k, label: labelFn(nrow), old: '', neu: valFn(nrow), rawNew: nrow.raw });
        }
    }
    if (diffs.length > 0) {
        console.error(`\n=== ${name}: ${diffs.length} 处差异 ===`);
        for (const d of diffs) {
            console.error(`[${d.type}] ${d.label}`);
            if (d.type === 'CHANGED') {
                console.error(`  旧: ${d.old}`);
                console.error(`  新: ${d.neu}`);
            } else {
                console.error(`  值: ${d.neu || d.old}`);
            }
        }
    }
    return diffs.length;
}

function runDiff() {
    const data = buildAll();
    let total = 0;
    const themes = data.themeNames;

    const oldVars = readTsv(path.join(OUT_DIR, 'vars.tsv'))
        ?.map((r) => ({ ...r, varName: r['var'] }));
    total += diffTables('vars.tsv（有效变量表）', oldVars, data.varRows,
        (r) => r.varName,
        (r) => themes.map((t) => `${t}=${r[t]}`).join(' | '),
        (r) => r.varName);

    const oldCss = readTsv(path.join(OUT_DIR, 'css.tsv'));
    total += diffTables('css.tsv（CSS 声明解析值）', oldCss, data.cssRows,
        (r) => `${r.file} | ${r.sel} | ${r.prop}`,
        (r) => themes.map((t) => `${t}=${r[t]}`).join(' | '),
        (r) => `${r.file}:${r.line} [${r.sel}] ${r.prop}`);

    const oldDefs = readTsv(path.join(OUT_DIR, 'defs.tsv'));
    total += diffTables('defs.tsv（自定义属性定义）', oldDefs, data.defRows,
        (r) => `${r.file} | ${r.sel} | ${r.prop}`,
        (r) => themes.map((t) => `${t}=${r[t]}`).join(' | '),
        (r) => `${r.file}:${r.line} [${r.sel}] ${r.prop}`);

    const oldInline = readTsv(path.join(OUT_DIR, 'inline.tsv'))
        ?.map((r) => ({ ...r, varName: r['var'] }));
    total += diffTables('inline.tsv（JS/HTML 内联 var()）', oldInline, data.inlineRows,
        (r) => `${r.file} | ${r.varName}`,
        (r) => themes.map((t) => `${t}=${r[t]}`).join(' | '),
        (r) => `${r.file}:${r.line} var(${r.varName}${r.fallback ? ', ' + r.fallback : ''})`);

    console.error(`\n=== diff 汇总: ${total} 处差异 ===`);
    process.exitCode = total > 0 ? 1 : 0;
}

// ── 10. 主流程 ──

function main() {
    const mode = process.argv[2] || '';
    if (mode === '--diff') {
        if (!fs.existsSync(path.join(OUT_DIR, 'vars.tsv'))) {
            console.error('基线不存在，请先运行: node tools/theme-baseline.js');
            process.exitCode = 2;
            return;
        }
        runDiff();
        return;
    }

    const data = buildAll();
    writeBaseline(data);

    // 汇总与幽灵变量清单
    const rawVarCount = data.cssFiles.reduce((n, f) => {
        const src = fs.readFileSync(f, 'utf8');
        return n + (src.match(/var\(--/g) || []).length;
    }, 0);
    const ghosts = new Map();
    for (const [file, rows] of [['css', data.cssRows], ['inline', data.inlineRows]]) {
        for (const r of rows) {
            const um = /^<UNDEF:(--[a-zA-Z0-9-]+)>$/.exec(r[data.themeNames[0]]);
            if (um) {
                const k = `${um[1]} (${file})`;
                ghosts.set(k, (ghosts.get(k) || 0) + 1);
            }
        }
    }

    console.log(`CSS 文件: ${data.cssFiles.length}`);
    console.log(`CSS 声明（含 var()/颜色字面量）: ${data.cssRows.length}（源码 var(-- 原始计数 ${rawVarCount}）`);
    console.log(`自定义属性定义: ${data.defRows.length}`);
    console.log(`JS/HTML 内联 var() 引用: ${data.inlineRows.length}`);
    console.log(`有效变量: ${data.varRows.length}`);
    if (ghosts.size > 0) {
        console.log(`\n幽灵变量（解析为 <UNDEF>，声明按 invalid 处理）:`);
        for (const [k, n] of [...ghosts.entries()].sort()) console.log(`  ${k}: ${n} 处`);
    }
    console.log(`\n基线已写入 ${path.relative(ROOT, OUT_DIR)}`);
}

if (require.main === module) {
    main();
} else {
    // 供 tools/theme-hardcoded-audit.js 复用（解析器 + 有效变量表）
    module.exports = { buildAll, substituteVars, loadPresets, loadApplierMap, loadRootStatic, loadThemeApplier };
}
