/**
 * release-check.js — Release 出包前只读检查
 *
 * Release 完整包 = 公开源码树 + deploy/Plug-ins/*.aex + vendor/node/ + vendor/node_modules/。
 * 打 zip 前跑一遍，确认「该带的都在、不该带的不在、许可文本随包」。
 *
 * 用法：
 *   node tools/release-check.js                    # 检查仓库是否为可出包状态
 *   node tools/release-check.js --public <目录>    # 额外检查已导出的公开树（零二进制、无 vendor 等）
 *   node tools/release-check.js --public . --public-only   # 只查公开树（公开仓库 CI 用）
 *   npm run release:check
 *
 * 退出码：0 全部通过；1 有 FAIL（WARN 只提示，不阻断）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const results = [];
const PUBLIC_ONLY = process.argv.indexOf('--public-only') !== -1;

function pass(label, detail) { results.push({ level: 'PASS', label: label, detail: detail || '' }); }
function warn(label, detail) { results.push({ level: 'WARN', label: label, detail: detail || '' }); }
function fail(label, detail) { results.push({ level: 'FAIL', label: label, detail: detail || '' }); }

function exists(rel) { return fs.existsSync(path.join(ROOT, rel)); }

function hashFile(absPath) {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
}

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// ── 1. 根证件：再分发时必须随包（公开树声明在 docs/；私有库真源在 overlay docs/）──
if (!PUBLIC_ONLY) {
    if (exists('LICENSE')) { pass('根证件 LICENSE'); }
    else { fail('根证件 LICENSE', '缺失：再分发时 MIT 许可必须随包'); }
    var noticesCandidates = ['docs/THIRD-PARTY-NOTICES.md', 'tools/public-overlay/docs/THIRD-PARTY-NOTICES.md'];
    var noticesHit = noticesCandidates.filter(exists)[0];
    if (noticesHit) { pass('第三方声明 ' + noticesHit); }
    else { fail('第三方声明 docs/THIRD-PARTY-NOTICES.md', '缺失：再分发时第三方声明必须随包'); }
}

// ── 2. 原生组件（.aex）──
if (!PUBLIC_ONLY) {
    ['deploy/Plug-ins/AS_Effect_Host.aex', 'deploy/Plug-ins/AS_Hotbox.aex'].forEach(function (rel) {
        if (exists(rel)) { pass('原生组件 ' + rel); }
        else { fail('原生组件 ' + rel, 'Release 完整包需要它；缺了 GLSL 效果宿主 / Hotbox 不可用'); }
    });
}

// ── 3. Node 运行时 + 官方许可文本 ──
if (!PUBLIC_ONLY) {
    if (exists('vendor/node/node.exe')) { pass('Node 运行时 vendor/node/node.exe'); }
    else { fail('Node 运行时 vendor/node/node.exe', 'Release 包开箱即用需要内置 Node'); }
    if (exists('vendor/node/LICENSE')) { pass('Node 许可 vendor/node/LICENSE'); }
    else { fail('Node 许可 vendor/node/LICENSE', 'MIT 要求随副本带版权与许可声明'); }
}

// ── 4. FFmpeg 不得进包（GPL 二进制本项目不分发；本机存在不等于进包）──
if (!PUBLIC_ONLY) {
    if (exists('vendor/ffmpeg')) {
        warn('FFmpeg 不进包', '本机存在 vendor/ffmpeg：打 Release zip 时必须排除（仅由 check-env/install 从上游下载）');
        var hasLicense = exists('vendor/ffmpeg/LICENSE') || exists('vendor/ffmpeg/LICENSE.md') || exists('vendor/ffmpeg/COPYING.GPLv3');
        if (hasLicense && exists('vendor/ffmpeg/SOURCE.txt')) {
            pass('FFmpeg 许可文本与 SOURCE 已保留在 vendor/ffmpeg/');
        } else {
            warn('FFmpeg 许可文本不全', 'vendor/ffmpeg 缺 LICENSE/COPYING 或 SOURCE.txt：再分发前需补齐（脚本会保留）');
        }
    } else {
        pass('FFmpeg 不进包');
    }
}

// ── 5. npm 依赖：vendor/node_modules 与 package-lock 生产闭包逐包对齐 ──
if (!PUBLIC_ONLY) (function checkDeps() {
    if (!exists('vendor/node_modules')) { fail('依赖目录 vendor/node_modules', '缺失：Bridge 依赖不可用'); return; }
    var lock;
    try { lock = readJson('package-lock.json'); }
    catch (e) { fail('读取 package-lock.json', String(e.message)); return; }

    var pkgs = lock.packages || {};
    var prodKeys = Object.keys(pkgs).filter(function (k) {
        return k.indexOf('node_modules/') === 0 && !pkgs[k].dev && !pkgs[k].devOptional;
    });
    if (prodKeys.length === 0) { fail('生产依赖闭包', 'package-lock.json 里没有生产依赖？'); return; }

    var missing = [];
    var mismatched = [];
    var optional = [];
    prodKeys.forEach(function (key) {
        var dir = path.join(ROOT, 'vendor', key);
        if (!fs.existsSync(path.join(dir, 'package.json'))) {
            if (pkgs[key].optional) { optional.push(key); } else { missing.push(key); }
            return;
        }
        var want = pkgs[key].version;
        var got = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
        if (got !== want) { mismatched.push(key + ' (期望 ' + want + '，实际 ' + got + ')'); }
    });

    if (missing.length) { fail('依赖缺件', '缺：' + missing.join('、')); }
    else { pass('依赖齐套（生产闭包 ' + prodKeys.length + ' 包）'); }
    if (mismatched.length) { fail('依赖版本与 lock 不一致', mismatched.join('；')); }
    else { pass('依赖版本与 package-lock 一致'); }
    if (optional.length) { warn('optional 依赖未装', optional.join('、')); }

    // 已知坑：mammoth 的嵌套依赖 xmlbuilder 曾在 vendor 副本里漏装，单独钉一条
    if (exists('vendor/node_modules/mammoth/node_modules/xmlbuilder/package.json')) {
        pass('mammoth 嵌套依赖 xmlbuilder');
    } else if (exists('vendor/node_modules/mammoth')) {
        fail('mammoth 嵌套依赖 xmlbuilder', '缺：require("mammoth") 会直接报错（docx 解析不可用）');
    }

    // 反向：vendor 顶层只应有生产闭包内的包（deploy/install 的 prune 失败会把 dev 包留在包里）
    function topNameOfKey(key) {
        var rel = key.slice('node_modules/'.length);
        var parts = rel.split('/');
        return parts[0].charAt(0) === '@' ? parts.slice(0, 2).join('/') : parts[0];
    }
    var keepTop = {};
    prodKeys.forEach(function (k) { keepTop[topNameOfKey(k)] = true; });
    var devLeft = [];
    var vendorModules = path.join(ROOT, 'vendor', 'node_modules');
    fs.readdirSync(vendorModules).forEach(function (name) {
        if (name === '.bin' || name === '.package-lock.json') { return; }
        var abs = path.join(vendorModules, name);
        if (!fs.statSync(abs).isDirectory()) { return; }
        if (name.charAt(0) === '@') {
            fs.readdirSync(abs).forEach(function (sub) {
                if (!keepTop[name + '/' + sub]) { devLeft.push(name + '/' + sub); }
            });
        } else if (!keepTop[name]) {
            devLeft.push(name);
        }
    });
    if (devLeft.length) {
        fail('vendor 含非生产包', '清理：node tools/prune-vendor-modules.js（' + devLeft.slice(0, 12).join('、')
            + (devLeft.length > 12 ? ' 等 ' + devLeft.length + ' 个' : '') + '）');
    } else {
        pass('vendor 仅含生产闭包（无 dev 包残留）');
    }
})();

// ── 6. 第三方许可文本随包 ──
if (exists('client/vendor/CSInterface.LICENSE.pdf')) { pass('CSInterface 的 Adobe 协议文本'); }
else { fail('CSInterface 的 Adobe 协议文本', '文件头要求随附 Adobe 许可协议；应为 client/vendor/CSInterface.LICENSE.pdf'); }
if (exists('native/glsl-host/third_party/glad/LICENSE')) { pass('glad 上游 LICENSE'); }
else { fail('glad 上游 LICENSE', 'Khronos Apache-2.0 部分需要许可全文；应为 native/glsl-host/third_party/glad/LICENSE'); }

(function checkNoticesContent() {
    // Release 包里随源码树分发的是导出后的公开树，其 NOTICES 来自 overlay；优先检查 overlay
    var overlayNotices = path.join(ROOT, 'tools', 'public-overlay', 'docs', 'THIRD-PARTY-NOTICES.md');
    var rootNotices = path.join(ROOT, 'docs', 'THIRD-PARTY-NOTICES.md');
    var noticesPath = fs.existsSync(overlayNotices) ? overlayNotices : rootNotices;
    if (!fs.existsSync(noticesPath)) { return; }
    var text = fs.readFileSync(noticesPath, 'utf8');
    var markers = [
        ['第三方依赖表', '| 包 | 版本 | 许可 |'],
        ['npm 依赖表', 'npm 依赖'],
        ['SDK 编译产物披露', 'SDK `Examples/Util`'],
        ['CSInterface 协议指路', 'CSInterface.LICENSE.pdf'],
        ['Apache-2.0 文本说明', 'Apache License, Version 2.0'],
        ['PDF.js 披露（unpdf 内嵌）', 'PDF.js 6.1.200'],
        ['Zlib 补录', 'pako 1.0.11'],
        ['cssfilter 补录', 'cssfilter'],
        ['开箱即用说明', '开箱即用']
    ];
    var lost = markers.filter(function (m) { return text.indexOf(m[1]) === -1; }).map(function (m) { return m[0]; });
    if (lost.length) { fail('NOTICES 关键内容', '缺少：' + lost.join('、') + '（检查文件：' + path.relative(ROOT, noticesPath) + '）'); }
    else { pass('NOTICES 关键内容（依赖表 / SDK 披露 / 协议指路 / Apache / PDF.js / Zlib / cssfilter / 开箱即用）'); }
})();

// ── 7. 桌宠素材（源码树内含，Release 随之分发）──
(function checkSprites() {
    var dir = path.join(ROOT, 'client', 'features', 'deepseekPet', 'sprites');
    if (!fs.existsSync(dir)) { warn('桌宠素材', 'sprites 目录缺失：Release 不含桌宠动画'); return; }
    var files = fs.readdirSync(dir);
    var png = files.filter(function (f) { return /\.png$/i.test(f); }).length;
    var webm = files.filter(function (f) { return /\.webm$/i.test(f); }).length;
    if (png >= 16 && webm >= 1) { pass('桌宠素材（' + png + ' PNG + ' + webm + ' WebM）'); }
    else { fail('桌宠素材', 'PNG ' + png + ' / WebM ' + webm + '，与 manifest 不符（应为 16 + 1）'); }
})();

// ── 8. 可选：检查已导出的公开树 ──
(function checkPublicTree() {
    var idx = process.argv.indexOf('--public');
    if (PUBLIC_ONLY && idx === -1) { fail('--public-only', '需要同时指定 --public <目录>'); return; }
    if (idx === -1) { return; }
    var pub = process.argv[idx + 1];
    if (!pub || !fs.existsSync(pub)) { fail('公开树路径', '--public 指向的目录不存在：' + pub); return; }
    pub = path.resolve(pub);

    ['vendor', 'node_modules', 'deploy'].forEach(function (d) {
        if (fs.existsSync(path.join(pub, d))) { fail('公开树不含 ' + d + '/', '公开源码仓库不应该有该目录'); }
        else { pass('公开树不含 ' + d + '/'); }
    });

    var badExt = /\.(exe|dll|aex|zip|7z|msi|node|wasm|pdb)$/i;
    var dirs = [pub];
    var binaries = [];
    while (dirs.length) {
        var d = dirs.pop();
        fs.readdirSync(d).forEach(function (name) {
            var abs = path.join(d, name);
            var st = fs.statSync(abs);
            if (st.isDirectory()) { dirs.push(abs); }
            else if (badExt.test(name)) { binaries.push(path.relative(pub, abs)); }
        });
    }
    if (binaries.length) { fail('公开树零二进制', binaries.join('、')); }
    else { pass('公开树零二进制'); }

    ['LICENSE', 'docs/THIRD-PARTY-NOTICES.md', 'README.md', 'docs/DEVELOPMENT.md',
        'docs/DEVELOPMENT.en.md', 'docs/DEVELOPMENT.ja.md', 'docs/DEVELOPMENT.de.md',
        'docs/DEVELOPMENT.ko.md', 'docs/DEVELOPMENT.fr.md', 'docs/DEVELOPMENT.ru.md',
        'README.en.md', 'README.ja.md', 'README.de.md', 'README.ko.md', 'README.fr.md', 'README.ru.md',
        'docs/THIRD-PARTY-NOTICES.en.md', 'docs/THIRD-PARTY-NOTICES.ja.md', 'docs/THIRD-PARTY-NOTICES.de.md',
        'docs/THIRD-PARTY-NOTICES.ko.md', 'docs/THIRD-PARTY-NOTICES.fr.md', 'docs/THIRD-PARTY-NOTICES.ru.md'].forEach(function (rel) {
        if (fs.existsSync(path.join(pub, rel))) { pass('公开树 ' + rel); }
        else { fail('公开树 ' + rel, '缺失'); }
    });

    var overlayDocs = ['docs/THIRD-PARTY-NOTICES.md', 'docs/DEVELOPMENT.md', 'docs/DEVELOPMENT.en.md', 'docs/DEVELOPMENT.ja.md',
        'docs/DEVELOPMENT.de.md', 'docs/DEVELOPMENT.ko.md', 'docs/DEVELOPMENT.fr.md', 'docs/DEVELOPMENT.ru.md',
        'README.md', 'README.en.md', 'README.ja.md', 'README.de.md',
        'README.ko.md', 'README.fr.md', 'README.ru.md',
        'docs/THIRD-PARTY-NOTICES.en.md', 'docs/THIRD-PARTY-NOTICES.ja.md', 'docs/THIRD-PARTY-NOTICES.de.md',
        'docs/THIRD-PARTY-NOTICES.ko.md', 'docs/THIRD-PARTY-NOTICES.fr.md', 'docs/THIRD-PARTY-NOTICES.ru.md'];
    var docDiffs = [];
    var docCompared = 0;
    overlayDocs.forEach(function (rel) {
        var a = path.join(ROOT, 'tools', 'public-overlay', rel);
        var b = path.join(pub, rel);
        if (!fs.existsSync(a) || !fs.existsSync(b)) { return; }
        docCompared++;
        if (hashFile(a) !== hashFile(b)) { docDiffs.push(rel); }
    });
    if (docDiffs.length) {
        fail('公开树文档与 overlay 不一致', docDiffs.join('、') + '（重新导出 tools/export-public.js，不要手改公开树）');
    } else if (docCompared) {
        pass('公开树文档与 overlay 逐字节一致（' + docCompared + ' 份）');
    }

    if (fs.existsSync(path.join(pub, 'client', 'vendor', 'CSInterface.LICENSE.pdf'))) {
        pass('公开树含 CSInterface 协议文本');
    } else {
        fail('公开树含 CSInterface 协议文本', '缺失：重新导出后应随 client/vendor 落位');
    }
})();

// ── 9. 随包批处理脚本：纯 ASCII + CRLF ──
// 文件集与导出产物同口径：有版本库元数据时按 tools/export-public.js 的枚举方式
// （git ls-files --cached --others --exclude-standard）再套用其 EXCLUDE_DIRS/EXCLUDE_FILES；
// 安装包/公开树没有版本库元数据，按目录扫描并跳过只存在于私有库与 Release 附加层的目录。
var BATCH_LOCAL_SKIP_DIRS = {
    '.git': true, '.hg': true, '.svn': true,
    node_modules: true, vendor: true, deploy: true
};

function readExportExcludes(root) {
    var toolPath = path.join(root, 'tools', 'export-public.js');
    if (!fs.existsSync(toolPath)) { return null; }
    var src = fs.readFileSync(toolPath, 'utf8');
    function quotedArray(name) {
        var m = src.match(new RegExp('var\\s+' + name + '\\s*=\\s*\\[([\\s\\S]*?)\\];'));
        if (!m) { return []; }
        return (m[1].match(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g) || []).map(function (s) { return s.slice(1, -1); });
    }
    return { dirs: quotedArray('EXCLUDE_DIRS'), files: quotedArray('EXCLUDE_FILES') };
}

function listBatchCandidates(root) {
    var rules = readExportExcludes(root);
    var fileEx = {};
    var dirEx = [];
    if (rules) {
        rules.dirs.forEach(function (p) { dirEx.push(p.replace(/\\/g, '/')); });
        rules.files.forEach(function (p) { fileEx[p.replace(/\\/g, '/')] = true; });
    }
    function excluded(rel) {
        if (fileEx[rel]) { return true; }
        for (var i = 0; i < dirEx.length; i++) {
            if (rel.indexOf(dirEx[i]) === 0 || rel === dirEx[i].replace(/\/$/, '')) { return true; }
        }
        return false;
    }
    var tracked = null;
    if (fs.existsSync(path.join(root, '.git'))) {
        try {
            tracked = require('child_process').execFileSync('git',
                ['-C', root, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
                { maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }
            ).toString('utf8').split('\0').filter(Boolean);
        } catch (e) { tracked = null; }
    }
    var out = [];
    if (tracked) {
        tracked.forEach(function (raw) {
            var rel = String(raw).replace(/\\/g, '/');
            if (!/\.(bat|cmd)$/i.test(rel) || excluded(rel)) { return; }
            out.push(rel);
        });
    } else {
        (function walk(dir, rel) {
            var entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (var i = 0; i < entries.length; i++) {
                var name = entries[i].name;
                var childRel = rel ? rel + '/' + name : name;
                var abs = path.join(dir, name);
                if (entries[i].isDirectory()) {
                    if (BATCH_LOCAL_SKIP_DIRS[name] || excluded(childRel + '/')) { continue; }
                    walk(abs, childRel);
                    continue;
                }
                if (/\.(bat|cmd)$/i.test(name) && !excluded(childRel)) { out.push(childRel); }
            }
        })(root, '');
    }
    out.sort();
    return out;
}

function batchFileProblems(absPath) {
    var buf = fs.readFileSync(absPath);
    function lineAt(idx) {
        var n = 1;
        for (var k = 0; k < idx; k++) { if (buf[k] === 0x0A) { n++; } }
        return n;
    }
    var problems = [];
    var i;
    for (i = 0; i < buf.length; i++) {
        if (buf[i] < 0x80) { continue; }
        var before = buf.slice(0, i).toString('utf8');
        var context = before.slice(-40).replace(/[\r\n]+/g, ' ');
        problems.push(lineAt(i) + ': 首个非 ASCII 字节 0x' + buf[i].toString(16).toUpperCase()
            + '（字节偏移 ' + i + '，其前 40 字符："' + context + '"）');
        break;
    }
    for (i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0A && (i === 0 || buf[i - 1] !== 0x0D)) {
            problems.push(lineAt(i) + ': 行尾是 LF 不是 CRLF');
            break;
        }
    }
    for (i = 0; i < buf.length; i++) {
        if (buf[i] === 0x0D && (i + 1 >= buf.length || buf[i + 1] !== 0x0A)) {
            problems.push(lineAt(i) + ': 行尾是 CR 不是 CRLF');
            break;
        }
    }
    return problems;
}

// 门禁扫描根：私有树（未带 --public-only）+ --public 指向的公开树；同一目录只扫一次。
function gateRoots() {
    var roots = [];
    if (!PUBLIC_ONLY) { roots.push({ label: '', dir: ROOT }); }
    var idx = process.argv.indexOf('--public');
    var pub = (idx !== -1 && process.argv[idx + 1]) ? path.resolve(process.argv[idx + 1]) : null;
    if (PUBLIC_ONLY && !pub) { pub = ROOT; }
    if (pub && fs.existsSync(pub)) {
        var dup = roots.some(function (r) { return path.resolve(r.dir).toLowerCase() === pub.toLowerCase(); });
        if (!dup) { roots.push({ label: '公开树:', dir: pub }); }
    }
    if (!roots.length) { roots.push({ label: '', dir: ROOT }); }
    if (roots.length > 1 && !roots[0].label) { roots[0].label = '私有树:'; }
    return roots;
}

(function checkShippedBatch() {
    var roots = gateRoots();
    var problems = [];
    var counts = [];
    roots.forEach(function (root) {
        var files = listBatchCandidates(root.dir);
        counts.push((root.label ? root.label.replace(/:$/, '') : '当前树') + ' ' + files.length + ' 个');
        files.forEach(function (rel) {
            var probs;
            try { probs = batchFileProblems(path.join(root.dir, rel)); }
            catch (e) { probs = ['读取失败：' + (e && e.message ? e.message : String(e))]; }
            probs.forEach(function (p) { problems.push(root.label + rel + ':' + p); });
        });
    });
    if (problems.length) {
        fail('随包批处理（.bat/.cmd）纯 ASCII + CRLF',
            problems.slice(0, 8).join('；') + (problems.length > 8 ? '；等 ' + problems.length + ' 处' : '')
            + '（注释/echo 改 ASCII，行尾保持 CRLF）');
    } else {
        pass('随包批处理（.bat/.cmd）纯 ASCII + CRLF（' + counts.join('，') + '）');
    }
})();

// ── 10. 仓库地址占位：REPO_OWNER/REPO_NAME 未替换只提示（地址未定，不阻断出包）──
(function checkRepoPlaceholders() {
    var roots = gateRoots();
    var READMES = ['README.md', 'README.en.md', 'README.ja.md', 'README.de.md',
        'README.ko.md', 'README.fr.md', 'README.ru.md'];
    var hits = [];
    roots.forEach(function (root) {
        var candidates = listBatchCandidates(root.dir).slice();
        ['package.json', 'tools/public-overlay/package.json'].forEach(function (rel) { candidates.push(rel); });
        READMES.forEach(function (rel) {
            candidates.push(rel);
            candidates.push('tools/public-overlay/' + rel);
        });
        var seen = {};
        candidates.forEach(function (rel) {
            if (seen[rel]) { return; }
            seen[rel] = true;
            var abs = path.join(root.dir, rel);
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) { return; }
            var text;
            try { text = fs.readFileSync(abs, 'utf8'); } catch (e) { return; }
            text.split(/\r?\n/).forEach(function (line, i) {
                if (/REPO_OWNER|REPO_NAME/.test(line)) { hits.push(root.label + rel + ':' + (i + 1)); }
            });
        });
    });
    if (hits.length) {
        warn('仓库地址占位未替换',
            hits.slice(0, 10).join('、') + (hits.length > 10 ? ' 等 ' + hits.length + ' 处' : '')
            + '（地址未定，不阻断出包；发布前替换 REPO_OWNER/REPO_NAME）');
    } else {
        pass('仓库地址占位已替换');
    }
})();

// ── 输出 ──
var fails = results.filter(function (r) { return r.level === 'FAIL'; });
var warns = results.filter(function (r) { return r.level === 'WARN'; });
results.forEach(function (r) {
    var tag = r.level === 'PASS' ? '[PASS]' : (r.level === 'WARN' ? '[WARN]' : '[FAIL]');
    console.log(tag + ' ' + r.label + (r.detail ? ' :: ' + r.detail : ''));
});
console.log('');
console.log('结果：' + results.length + ' 项，PASS ' + (results.length - fails.length - warns.length) +
    ' / WARN ' + warns.length + ' / FAIL ' + fails.length);
if (fails.length) {
    console.log('出包检查未通过：先修 FAIL 项。');
    process.exit(1);
}
console.log('出包检查通过。');
