/**
 * family-extinct-audit.js — 缺陷家族灭绝防复发卡口
 *
 * 把已灭绝缺陷家族的机械可检规则固化为 CI 卡口：白名单之外的新增即报警，
 * 防同族缺陷修一处漏一处。
 *
 * 六族规则：
 *   F1 execSync 家族     —— client 面板代码禁用 execSync（阻塞 CEP UI 线程）。
 *                           白名单：bridge-server.js 启动期单次探测/清理（事件循环尚无服务对象）。
 *   F2 shell:true 家族   —— 仅允许两处已加引号防护的 spawn（ae-bridge.js / communicationProvider.js）。
 *   F3 U+2028 家族       —— 拼 ExtendScript 字符串的 new File("/new Folder(" 必须经转义链
 *                           （_escPath / sdEsc / escapedPath / safePath 且 safePath 定义含 u2028）。
 *   F4 fetch 无超时家族  —— client 代码的 fetch( 必须带超时防护（signal / AbortController /
 *                           Promise.race timeout / _fetchWithTimeout），白名单：bridge.js
 * localhost 端点（心跳+断线页兜底双保险）。
 *   F5 原子写家族        —— 索引/配置类落盘禁止裸写：writeFile( 直接跟 .json 索引路径的
 *                           需走 .tmp→rename 助手（本族以抽查规则实现：检测写目标含
 *                           index/registry/providers/MEMORY 关键字且同文件无 tmp 声明）。
 *   F6 authored 直拼家族 —— evalScript 调用点禁拼 code 类标识符（authored 代码必须经
 *                           __args JSON 数据通道 / executeExtendScript 核，拼接直发即绕过
 *                           门与核双层防线）。白名单：bootstrap.js（固定模板+safeJson 转义
 *                           参数——数据非代码）；热盒 scriptRunner.jsx 在 host/（进程边界）。
 *
 * 用法：
 *   node tools/family-extinct-audit.js     # 扫描，命中 exit 1
 *   npm run audit:family
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');

// ── 收集 client 下全部 .js（vendor 与 node_modules 除外）──
function walkJs(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of entries) {
        if (e.name === 'vendor' || e.name === 'node_modules' || e.name[0] === '.') continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walkJs(p, out);
        else if (e.name.endsWith('.js')) out.push(p);
    }
    return out;
}

const files = walkJs(CLIENT_DIR, []);
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, '/');
const violations = [];

// ── execSync 家族 ──
const F1_EXEMPT = [
    'client/shared/bridge-server.js', // 启动期单次端口探测/旧实例清理（无服务对象期）
];
for (const f of files) {
    if (F1_EXEMPT.includes(rel(f))) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        // 注释里的提及不算（历史注释/姊妹位置说明常见）
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/execSync\(/.test(line)) {
            violations.push({
                family: 'F1 execSync',
                where: `${rel(f)}:${i + 1}`,
                detail: line.trim().slice(0, 120),
                fix: '改用异步 spawn / spawnAsync（参照 stopSingle 模式）'
            });
        }
    });
}

// ── shell:true 家族 ──
const F2_ALLOWED = [
    'client/shared/ae-bridge.js',
    'client/modules/mcp-manager/communicationProvider.js', // 两处均已挂 _buildShellCommand 引号防护
];
for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/shell:\s*true/.test(line) && !F2_ALLOWED.includes(rel(f))) {
            violations.push({
                family: 'F2 shell:true',
                where: `${rel(f)}:${i + 1}`,
                detail: line.trim().slice(0, 120),
                fix: 'Windows 必须经 _shellQuote/_buildShellCommand 单命令串'
            });
        }
    });
}

// ── U+2028 家族（拼 ExtendScript new File/Folder 字面量必须经转义）──
// 已转义变量名约定：sdEsc/parentEsc/srcEsc/dirFwd(链式)/escapedPath/escPath/escName
const F3_ESCAPED_VAR = /(?:sdEsc|parentEsc|srcEsc|dirFwd|escapedPath|escPath|escName|safePath2?)/;
for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        // 命中拼脚本的 new File("/new Folder(" 且拼接变量不在已转义清单
        const m = /new (?:File|Folder)\("\s*\+\s*(\w+)/.exec(line);
        if (m && !F3_ESCAPED_VAR.test(m[1])) {
            violations.push({
                family: 'F3 U+2028',
                where: `${rel(f)}:${i + 1}`,
                detail: `拼接变量 ${m[1]} 不在已转义清单`,
                fix: '对齐 _escPath 完整转义链（\\ " \\n \\r \\t \\0 U+2028 U+2029）'
            });
        }
    });
}

// ── fetch 无超时家族（文件级规则）──
// 粒度说明：逐调用点判定误报率高（超时防护写法多样：fetchOpts.signal 在 fetch 前数行、
// Promise.race 包在 fetch 之后的 promise 变量上、_fetchWithTimeout 封装等），故采用文件级：
// 文件含非注释 fetch( 调用、且全文件无任何超时基建（AbortController/signal/race/timeout）
// 才报警。文件已有超时基建时的新增 fetch 由 review 轮把关——CI 卡口只兜「整个文件零纪律」。
// 豁免（附理由，均本地/捆绑资源，无挂死面）：
//   - bridge.js / ffmpegMovPlayer.js：localhost bridge 端点（心跳 8s 超时 + 断线页双保险）
//   - agent engine/bootstrap.js：捆绑静态资源（相对路径 aeApiReference.txt 等）
//   - aefs.js：file:/// 本地读 + cep.fs 回退；含 readFile 30s 超时基建
const F4_EXEMPT = [
    'client/shared/bridge.js',
    'client/shared/ffmpegMovPlayer.js',
    'client/modules/agent/engine/bootstrap.js',
    'client/shared/aefs.js',
];
const F4_TIMEOUT_MARK = /AbortController|Promise\.race|\.signal\b|_fetchWithTimeout|timeout|AbortError/i;
for (const f of files) {
    if (F4_EXEMPT.includes(rel(f))) continue;
    const src = fs.readFileSync(f, 'utf8');
    const codeLines = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
    const hasFetch = codeLines.some((l) => /fetch\(/.test(l));
    if (hasFetch && !F4_TIMEOUT_MARK.test(src)) {
        violations.push({
            family: 'F4 fetch 无超时',
            where: rel(f),
            detail: '文件含 fetch 调用但全文件无任何超时基建（AbortController/signal/race/timeout）',
            fix: 'AbortController 超时（参照 _fetchWithTimeout 模式）'
        });
    }
}

// ── 原子写家族（索引/配置类落盘抽查）──
// 豁免：agent engine/sessionStore.js——.bak 双写 + corrupt-<时间戳> 备份链 = 等效保护
// （主写中断时上一轮 .bak 可恢复），非裸写。
const F5_EXEMPT = [
    'client/modules/agent/engine/sessionStore.js',
];
const F5_INDEX_KEYS = /(index|registry|providers|MEMORY)\.json|MEMORY\.md/;
for (const f of files) {
    if (F5_EXEMPT.includes(rel(f))) continue;
    const src = fs.readFileSync(f, 'utf8');
    if (!F5_INDEX_KEYS.test(src)) continue;
    const lines = src.split(/\r?\n/);
    const hasAtomic = /(\.tmp|atomicWrite|renameFile)/.test(src);
    if (hasAtomic) continue; // 文件内已有原子写基建，新写点大概率走助手（防误报的粗粒度规则）
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (/writeFile(?:Sync)?\(/.test(line) && F5_INDEX_KEYS.test(src)) {
            violations.push({
                family: 'F5 非原子写',
                where: `${rel(f)}:${i + 1}`,
                detail: '索引/配置类文件且全文件无原子写助手',
                fix: '.tmp→rename 原子写'
            });
        }
    });
}

// ── authored 直拼家族（evalScript 的 authored 代码必须经共享函数数据通道）──
// authored 代码（LLM 生成/用户脚本）不得经字符串拼接
// 直发 evalScript——必须走共享函数数据通道（__args JSON 数据通道 / 门产物经
// executeExtendScript 执行核），拼接过 = 绕过门与核的双层防线（CI 铁律）。
// 检测：evalScript( 调用点同一行出现 code 类标识符拼接（+ code / + emitted /
// + userCode / + gateEmitted 等——精确标识符表，防 encodeURIComponent 类误报）。
// 豁免：bootstrap.js——固定模板 + safeJson 转义参数拼装（数据非代码；authored
// 代码经 args.code/__args JSON 数据通道或门产物 IIFE 模板）；热盒
// scriptRunner.jsx 在 host/（进程边界——不经面板进程，不在 client 扫描面内）。
const F6_EXEMPT = [
    'client/modules/ae-tools/bootstrap.js', // 固定模板+safeJson 转义参数（数据非代码）+ 门产物 IIFE/authored 走 __args 数据通道
];
const F6_CODE_VAR = /^(?:code|emitted|userCode|gateEmitted|editedScript|libEmitted|scriptText|userScript|script|extendScript|emittedCode|productCode)$/;
for (const f of files) {
    if (F6_EXEMPT.includes(rel(f))) continue;
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
        if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
        if (!/evalScript\s*\(/.test(line)) return;
        // 拼接运算符后的标识符（成员形态 args.code 取末段，裸变量取全名）
        const member = /\+\s*[\w$.]+\.([A-Za-z_$][\w$]*)/.exec(line);
        const plain = /\+\s*([A-Za-z_$][\w$]*)/.exec(line);
        const idents = [];
        if (member) idents.push(member[1]);
        if (plain) idents.push(plain[1]);
        for (const id of idents) {
            if (F6_CODE_VAR.test(id)) {
                violations.push({
                    family: 'F6 authored 直拼',
                    where: `${rel(f)}:${i + 1}`,
                    detail: `evalScript 调用点直接拼接 code 类标识符 ${id}（绕过门/核双层防线）`,
                    fix: 'authored 代码走 __args JSON 数据通道（bootstrap 桥 args.code）或 _runSandboxedScript/executeExtendScript 核'
                });
            }
        }
    });
}

// ── 汇总 ──
if (violations.length > 0) {
    console.error(`=== 缺陷家族复活 ${violations.length} 处 ===`);
    for (const v of violations) {
        console.error(`[${v.family}] ${v.where}`);
        console.error(`  ${v.detail}`);
        console.error(`  → ${v.fix}`);
    }
    process.exitCode = 1;
    return;
}
console.log(`家族灭绝审计通过：${files.length} 个文件，六族（execSync/shell:true/U+2028/fetch超时/原子写/authored直拼）无复活`);
