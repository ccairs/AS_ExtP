// 面板侧缓存目录清扫器
// =============================================================================
// 背景：两处图片缓存清扫（ae-tools 的 ae_preview_*、agent 的 chat_img_*）都失效了。
// 本机实测证据：
//   · temp/ae-tools 累积 199MB / 22 张（其中两张各 84MB）；
//   · temp/agent 留 9 个 chat_img_*，其中 7 个**零引用**（8 月 11/20 日，早该删）、
//     2 个被会话历史引用（正确保留）。
// 两者的共同点：年龄判定都依赖运行时 stat 能力，取不到就静默跳过全部文件——
//   ae-tools 那条用裸 window.cep.fs.stat（**无回退**：取不到 mtime → mtimeMs=0 →
//   每个文件都 continue）；agent 那条虽走 AEFS.stat（含 ExtendScript 回退）也没删掉
//   孤儿；且两条都把异常吞进空 catch，症状只能靠翻磁盘发现。
//
// 本模块把清扫收敛到一处，做三件事：
//   ① 年龄优先取「文件名内嵌毫秒时间戳」——两个目录的命名都带
//      （ae_preview_<ms>.png、chat_img_<ms>_…），实测与文件 mtime 逐条一致。
//      这一路不依赖任何 stat 能力，是主判据；
//   ② 无内嵌时间戳的名字才回落 io.stat（默认 AEFS.stat，含 ExtendScript 回退）；
//      根因：CEP 10 真机 window.cep.fs.stat 的 mtime 是 **Date 对象**
//      （isFile/isDirectory 还是函数），而 aefs.js 若只认 typeof number → mtimeMs 恒 0
//      → 本回落路径对每个文件都拿不到年龄 → noAge 全保留（temp/transcoded 的 tc_*.webm
//      没有内嵌时间戳，完全依赖这条）。修在 aefs.js statResult 的 _cepMtimeMs。
//   ③ 每轮写一份**覆盖式**报告（体积自限，非追加）到调用方指定路径，把
//      scanned/matched/removed/keptRef/keptFresh/noAge/failed 落盘——
//      下次"没生效"时先读报告定位，不用再翻磁盘猜是哪一段断的。
// 报告文件本身也落在 temp/ 下（白名单命名空间内），只有固定几份、每轮覆盖，
// 不会变成新的无上限增长源。
//
// 增补第二个执行器：retainNewest / retainPreviewFrames —— getPreviewFrame 的预览帧
// 由「读完即删」改为「池内保留最新 N 张（AE_PREVIEW_KEEP = 30），超出才删最旧」（因为
// Agent 可能复读同一张图，即删会让复读拿不到文件）。它与 sweep 同口径保护「拿不到年龄的不删」，
// 但不做 refs 豁免——池上限是硬约束（预览帧无会话引用，消费方读的是注入后的 data URL）。
// =============================================================================

(function (global) {
    'use strict';

    var MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;   // 默认龄阈值（四个缓存目标统一 7 天）
    // 体积预算上限（2GB）：四个缓存目标**合计**，不是各 2GB。
    // 龄阈值单独用不安全——预览图单张实测可达 84MB（见文件头背景），7 天堆积能到几个 GB；
    // 反过来只有预算也不够——新产物会被旧产物挤掉（明明还没过期）。两条叠加才既不误删也不过量。
    var DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
    var MAX_ERRORS = 20;                    // 报告里错误/样例条数上限（防报告自身膨胀）

    // temp/ae-preview 抓帧残片（ComfyUI controller.captureCurrentFrame 的临时 PNG）。
    // 命名与 temp/ae-tools 的产品预览帧同前缀（ae_preview_<ms>.png），但用途不同：
    // 只在写盘 → 读回 Blob 的秒级-分钟级窗口内被使用，读回后 finally 即删。删除失败
    // （面板重载 / 进程退出 / 文件被占）留下的残片单张可达数十 MB，既不在任何龄
    // 清扫目录里、temp 根的匹配也到不了子目录 → 永久占盘。作为独立目标纳入：
    //   · 龄清扫：comfyui bootstrap 按 aePreviewTarget 声明调用 sweep()（启动 + 每小时），
    //     阈值单独给 24h——抓帧产物无会话引用、不需要 7 天回看窗口，24h 已远超其使用
    //     窗口（给足余量），比统一 7 天更早回收这类大文件；
    //   · 体积预算：budgetTargets 同列该目录（2GB 合计口径一并计入）。
    var AE_PREVIEW_DIR = '\\temp\\ae-preview';
    var AE_PREVIEW_MATCH = /^ae_preview_\d+\.png$/i;
    var AE_PREVIEW_MAX_AGE_MS = 24 * 60 * 60 * 1000;

    // 抓帧残片目标声明（与 budgetTargets 同一构造口径）：返回 sweep/enforceBudget
    // 可直接消费的 { dir, match, maxAgeMs }。base 为数据目录，尾反斜杠自动归一。
    function aePreviewTarget(base) {
        var b = String(base || '').replace(/\\+$/, '');
        return { dir: b + AE_PREVIEW_DIR, match: AE_PREVIEW_MATCH, maxAgeMs: AE_PREVIEW_MAX_AGE_MS };
    }

    // getPreviewFrame 预览帧（temp/ae-tools 主目录 + temp 根回退目录）的保留张数。
    // 面板 Agent 调 getPreviewFrame 抓的帧**读完不删**，池内保留最新 N 张，
    // 超出才按最旧先删。理由：Agent 可能复读同一张图（会话里再取一次同一路径），即删会让
    // 复读拿不到文件。两个目录**合计**一个池——它们装的是同一批帧（回退目录只在 AE 侧建不出
    // 主目录时启用，见 aeTools.jsx 三级候选目录），各算一份会得到两倍上限。
    // 20 → 30（单帧 region/zoom 裁切每次调用产两张预览帧：原帧 + 裁切图，
    // 池上限不变时覆盖的调用次数减半）。
    var AE_PREVIEW_KEEP = 30;

    // 内嵌毫秒时间戳：`_<10..16 位数字>`，后面必须是 `_` / `.` / 串尾
    //   ae_preview_1789137474162.png                  → 1789137474162
    //   chat_img_1786434767662_clipboard-image-...png → 1786434767662（取第一段）
    // 下界 10 位：毫秒时间戳在 2001 年后恒 ≥1e12（13 位），10 位留出余量同时
    // 避免把 chat_img_<ts>_<seq> 里的短序号误判成时间。
    function stampFromName(name) {
        if (!name || typeof name !== 'string') return 0;
        var m = /_(\d{10,16})(?:_|\.|$)/.exec(name);
        if (!m) return 0;
        var v = Number(m[1]);
        if (!isFinite(v) || v <= 0) return 0;
        // 量级可信窗——位宽对不上就不能当毫秒用。
        // 病灶：外部 MCP server 常把产物命名成 Unix 秒戳（如 render_1728000000.png）或带编号，
        // 10 位数字被当毫秒 ⇒ 年龄 ≈56 年 ⇒ 启动时被当过期缓存直接删（用户刚生成的东西）；
        // 16 位微秒戳反向（当未来 → 永不删）。这里只接受「2001-09 之后且不超过 now+1 天」的
        // 毫秒戳；不可信的名字交给 mtime 通道（调用方对 stamp=0 的条目会 stat 取 mtime），
        // mtime 也拿不到时归 noAge（只记账不删）。
        var nowMs = Date.now();
        if (v < 1e12 || v > nowMs + 24 * 3600 * 1000) return 0;
        return v;
    }

    // 纯决策：不碰 I/O，便于单测覆盖全部分支。
    // entries: [{ name, stamp, mtimeMs }]；返回 { remove, keepRef, keepFresh, noAge }
    function plan(entries, opts) {
        opts = opts || {};
        var now = (typeof opts.now === 'number') ? opts.now : Date.now();
        var maxAgeMs = (typeof opts.maxAgeMs === 'number') ? opts.maxAgeMs : MIN_AGE_MS;
        var refs = opts.refs || null;
        var out = { remove: [], keepRef: [], keepFresh: [], noAge: [] };
        var list = Array.isArray(entries) ? entries : [];
        for (var i = 0; i < list.length; i++) {
            var e = list[i] || {};
            // 被会话历史引用的先保住（引用判定优先于年龄——引用者才是"在用"的证据）
            if (refs && refs[e.name]) { out.keepRef.push(e.name); continue; }
            var t = e.stamp || 0;
            if (!t && typeof e.mtimeMs === 'number' && e.mtimeMs > 0) t = e.mtimeMs;
            // 两条都取不到时间 → 保守不删（宁可不删，不误删活跃会话刚生成的帧）
            if (!t) { out.noAge.push(e.name); continue; }
            if (now - t >= maxAgeMs) out.remove.push(e.name);
            else out.keepFresh.push(e.name);
        }
        return out;
    }

    // 保留池的纯决策：不碰 I/O。与 plan（按龄回收）分工不同——这里按「留几张」回收：
    // 池内按时间戳新→旧排序，保留最新 keep 个，其余待删。
    // entries: [{ dir, name, stamp, mtimeMs }]；返回 { remove, keep, noAge }（remove 按最旧在前）。
    // 保护口径与 plan/enforceBudget 一致：拿不到时间（stamp 与 mtime 都无）→ 不删、只记账。
    // 与 plan 的差别：**不做 refs 豁免**——池上限是硬约束，预览帧无会话引用
    //（消费方读的是注入后的 data URL，不是文件本身，见 controller.js 视觉钩子）。
    function planRetain(entries, opts) {
        opts = opts || {};
        var keep = (typeof opts.keep === 'number' && opts.keep >= 0) ? Math.floor(opts.keep) : AE_PREVIEW_KEEP;
        var out = { remove: [], keep: [], noAge: [] };
        var src = Array.isArray(entries) ? entries : [];
        var list = [];
        for (var i = 0; i < src.length; i++) {
            var e = src[i] || {};
            var t = e.stamp || 0;
            if (!t && typeof e.mtimeMs === 'number' && e.mtimeMs > 0) t = e.mtimeMs;
            list.push({ e: e, t: t });
        }
        // 新→旧；无时间的排在末尾（既不占保留额度，也不进删除集合）
        list.sort(function (a, b) {
            if (!a.t && !b.t) return 0;
            if (!a.t) return 1;
            if (!b.t) return -1;
            return b.t - a.t;
        });
        var kept = 0;
        for (var k = 0; k < list.length; k++) {
            var it = list[k];
            if (!it.t) { out.noAge.push(it.e); continue; }
            if (kept < keep) { out.keep.push(it.e); kept++; }
            else out.remove.push(it.e);
        }
        // 待删集合倒成「最旧在前」：报告里的样例按真实回收顺序读（先删哪张一目了然）
        out.remove.reverse();
        return out;
    }

    function defaultIo() {
        return global.AEFS || null;
    }

    // 报告写入：必须走**同一个**注入 io（默认 AEFS）——写死 global.AEFS 会让
    // 「注入 io 的调用方」拿不到报告（单测即暴露此点），且报告落盘与删除走同一
    // 通道才保证权限/命名空间判定一致。
    function writeReport(io, path, report) {
        if (!path) return Promise.resolve(false);
        if (!io || typeof io.writeFile !== 'function') return Promise.resolve(false);
        try {
            var p = io.writeFile(path, JSON.stringify(report, null, 2));
            return (p && typeof p.then === 'function')
                ? p.then(function () { return true; }, function () { return false; })
                : Promise.resolve(!!p);
        } catch (_) { return Promise.resolve(false); }
    }

    // 单目录清扫（内部）：返回该目录的结果段，不做报告落盘
    async function sweepOne(dir, options) {
        var io = options.io;
        var seg = {
            dir: dir, scanned: 0, matched: 0, removed: 0,
            keptRef: 0, keptFresh: 0, noAge: 0, failed: 0,
            errors: [], removedSample: []
        };
        if (!dir) { seg.errors.push('空目录参数'); return seg; }
        if (!io || typeof io.listFiles !== 'function') {
            seg.errors.push('AEFS 未就绪或缺少 listFiles');
            return seg;
        }
        var names = [];
        try { names = await io.listFiles(dir); } catch (e) { seg.errors.push('listFiles: ' + e); }
        if (!Array.isArray(names)) names = [];
        seg.scanned = names.length;

        var re = options.match || null;
        if (re && re.global) re = new RegExp(re.source, re.ignoreCase ? 'i' : '');
        var entries = [];
        for (var i = 0; i < names.length; i++) {
            var n = names[i];
            if (typeof n !== 'string') continue;
            if (re && !re.test(n)) continue;
            entries.push({ name: n, stamp: stampFromName(n), mtimeMs: 0 });
        }
        seg.matched = entries.length;

        // 仅对「名字里没有时间戳」的少数文件查 stat（AEFS.stat 含 ExtendScript 回退）
        if (typeof io.stat === 'function') {
            for (var k = 0; k < entries.length; k++) {
                if (entries[k].stamp) continue;
                try {
                    var st = await io.stat(dir + '\\' + entries[k].name);
                    if (st && typeof st.mtimeMs === 'number' && st.mtimeMs > 0) {
                        entries[k].mtimeMs = st.mtimeMs;
                    }
                } catch (_) {}
            }
        }

        var p = plan(entries, {
            now: options.now, maxAgeMs: options.maxAgeMs, refs: options.refs
        });
        seg.keptRef = p.keepRef.length;
        seg.keptFresh = p.keepFresh.length;
        seg.noAge = p.noAge.length;
        if (options.dryRun) {
            seg.candidates = p.remove.length;
            if (seg.candidates) seg.removedSample = p.remove.slice(0, MAX_ERRORS);
            return seg;
        }
        for (var r = 0; r < p.remove.length; r++) {
            var ok = false;
            try {
                ok = (typeof io.deleteFile === 'function')
                    ? await io.deleteFile(dir + '\\' + p.remove[r]) : false;
            } catch (e) {
                if (seg.errors.length < MAX_ERRORS) seg.errors.push('delete ' + p.remove[r] + ': ' + e);
                ok = false;
            }
            if (ok === false) {
                seg.failed++;
            } else {
                seg.removed++;
                if (seg.removedSample.length < MAX_ERRORS) seg.removedSample.push(p.remove[r]);
            }
        }
        return seg;
    }

    /**
     * 清扫入口。
     * @param {object} options
     *   targets      — [{ dir, match }]：目标清单（各目标可带自己的 match；缺省用 options.match）。
     *                  与 dir/dirs+match 二选一。budgetTargets/previewFrameTargets 直接可喂。
     *   dir | dirs   — 目标目录（单个字符串或数组），配 options.match 使用
     *   match        — 文件名正则（非全局；全局会被重建，防 lastIndex 状态）
     *   maxAgeMs     — 年龄阈值，默认 7 天
     *   refs         — { 文件名: true }：被会话历史引用者不删
     *   dryRun       — 只出计划不删（调用方据此决定是否触发昂贵的引用收集）
     *   now          — 注入时钟（测试用）
     *   io           — 注入 { listFiles, stat, deleteFile }（默认 AEFS）
     *   reportPath   — 报告落盘路径（覆盖写；空则跳过）
     * @returns {Promise<object>} 报告对象（同时已落盘）
     */
    async function sweep(options) {
        options = options || {};
        var io = options.io || defaultIo();
        // 目标形态二选一：targets（逐目标可带 match）或 dir/dirs + 统一 match
        var jobs = [];
        if (Array.isArray(options.targets)) {
            for (var t0 = 0; t0 < options.targets.length; t0++) {
                var tg = options.targets[t0] || {};
                jobs.push({ dir: tg.dir, match: tg.match || options.match });
            }
        } else {
            var ds = Array.isArray(options.dirs) ? options.dirs.slice() : (options.dir ? [options.dir] : []);
            for (var d1 = 0; d1 < ds.length; d1++) jobs.push({ dir: ds[d1], match: options.match });
        }
        var report = {
            at: new Date(typeof options.now === 'number' ? options.now : Date.now()).toISOString(),
            dryRun: !!options.dryRun,
            ioReady: !!(io && typeof io.listFiles === 'function'),
            maxAgeMs: (typeof options.maxAgeMs === 'number') ? options.maxAgeMs : MIN_AGE_MS,
            dirs: []
        };
        for (var i = 0; i < jobs.length; i++) {
            var seg = await sweepOne(jobs[i].dir, {
                io: io,
                match: jobs[i].match,
                maxAgeMs: options.maxAgeMs,
                refs: options.refs,
                now: options.now,
                dryRun: options.dryRun
            });
            if (seg.errors && seg.errors.length > MAX_ERRORS) seg.errors = seg.errors.slice(0, MAX_ERRORS);
            report.dirs.push(seg);
        }
        var ok = true;
        for (var j = 0; j < report.dirs.length; j++) {
            if (report.dirs[j].failed > 0 || (report.dirs[j].errors && report.dirs[j].errors.length)) ok = false;
        }
        report.ok = ok;
        await writeReport(io, options.reportPath, report);
        return report;
    }

    /**
     * getPreviewFrame 预览帧池的目标清单（单一真相源）：主目录 temp/ae-tools + temp 根回退目录
     * （AE 侧建不出主目录时 getPreviewFrame 写这里，见 aeTools.jsx 三级候选）。
     * 与 budgetTargets 同源（同一构造口径），防止「保留池只认主目录、回退目录里的帧无限堆积」。
     * base 为空串时返回的是盘根相对路径，**调用方必须先确认数据目录可用**（与 budgetTargets 同约定）。
     * @param {string} base — 数据目录（尾反斜杠自动归一）
     * @returns {Array<{dir:string, match:RegExp}>}
     */
    function previewFrameTargets(base) {
        var b = String(base || '').replace(/\\+$/, '');
        return [
            { dir: b + '\\temp\\ae-tools', match: AE_PREVIEW_MATCH },
            { dir: b + '\\temp', match: AE_PREVIEW_MATCH }
        ];
    }

    /**
     * 保留集执行器：targets 合起来当**一个池**，只留最新 keep 个文件，超出按最旧先删。
     *
     * 与 sweep 的分工：sweep 按「多久没动」回收，本函数按「留几张」回收。
     * 保护口径与 sweep 一致：stamp 为主判据（不依赖 stat），stamp 不可信才回落 stat 的 mtime；
     * 两者都拿不到 → 不删（未知不是「最旧」）。
     *
     * @param {object} options
     *   targets      — [{ dir, match }]（match 为该目录的文件名正则，省略=全收）
     *   dir | dirs + match — 等价写法（单一 match 套用到全部目录）
     *   keep         — 保留张数（默认 AE_PREVIEW_KEEP）
     *   now / io / reportPath — 同 sweep（io 默认 AEFS）
     *   dryRun       — 只出计划不删
     * @returns {Promise<object>} 报告（含 ok / matched / removed / noAge / failed / removedSample）
     */
    async function retainNewest(options) {
        options = options || {};
        var io = options.io || defaultIo();
        var keep = (typeof options.keep === 'number' && options.keep >= 0) ? Math.floor(options.keep) : AE_PREVIEW_KEEP;
        var targets = [];
        if (Array.isArray(options.targets)) targets = options.targets;
        else {
            var ds = Array.isArray(options.dirs) ? options.dirs : (options.dir ? [options.dir] : []);
            for (var d0 = 0; d0 < ds.length; d0++) targets.push({ dir: ds[d0], match: options.match });
        }
        var report = {
            at: new Date(typeof options.now === 'number' ? options.now : Date.now()).toISOString(),
            dryRun: !!options.dryRun,
            ioReady: !!(io && typeof io.listFiles === 'function'),
            keep: keep,
            matched: 0, kept: 0, removed: 0, noAge: 0, failed: 0,
            errors: [], removedSample: [], dirs: []
        };
        if (!report.ioReady) {
            report.errors.push('AEFS 未就绪或缺少 listFiles');
            report.ok = false;
            await writeReport(io, options.reportPath, report);
            return report;
        }

        var entries = [];
        for (var i = 0; i < targets.length; i++) {
            var target = targets[i] || {};
            var dir = target.dir;
            if (!dir) continue;
            var re = target.match || null;
            if (re && re.global) re = new RegExp(re.source, re.ignoreCase ? 'i' : '');
            var names = [];
            var seg = { dir: dir, scanned: 0, matched: 0 };
            try { names = await io.listFiles(dir); } catch (e) {
                if (report.errors.length < MAX_ERRORS) report.errors.push('listFiles ' + dir + ': ' + e);
            }
            if (!Array.isArray(names)) names = [];
            seg.scanned = names.length;
            for (var n = 0; n < names.length; n++) {
                var name = names[n];
                if (typeof name !== 'string' || !name) continue;
                if (re && !re.test(name)) continue;
                seg.matched++;
                entries.push({ dir: dir, name: name, stamp: stampFromName(name), mtimeMs: 0 });
            }
            report.dirs.push(seg);
        }
        report.matched = entries.length;

        // 仅对「名字里没有可信时间戳」的少数文件查 stat 取龄（同 sweepOne 的主次分工）
        if (typeof io.stat === 'function') {
            for (var s = 0; s < entries.length; s++) {
                if (entries[s].stamp) continue;
                try {
                    var st = await io.stat(entries[s].dir + '\\' + entries[s].name);
                    if (st && typeof st.mtimeMs === 'number' && st.mtimeMs > 0) entries[s].mtimeMs = st.mtimeMs;
                } catch (_) {}
            }
        }

        var p = planRetain(entries, { keep: keep });
        report.kept = p.keep.length;
        report.noAge = p.noAge.length;
        if (options.dryRun) {
            report.candidates = p.remove.length;
            report.removedSample = p.remove.slice(0, MAX_ERRORS).map(function (x) { return x.name; });
        } else {
            for (var r = 0; r < p.remove.length; r++) {
                var it = p.remove[r];
                var ok = false;
                try {
                    ok = (typeof io.deleteFile === 'function') ? await io.deleteFile(it.dir + '\\' + it.name) : false;
                } catch (e2) {
                    if (report.errors.length < MAX_ERRORS) report.errors.push('delete ' + it.name + ': ' + e2);
                    ok = false;
                }
                if (ok === false) { report.failed++; continue; }
                report.removed++;
                if (report.removedSample.length < MAX_ERRORS) report.removedSample.push(it.name);
            }
        }
        report.ok = !(report.failed > 0 || (report.errors && report.errors.length > 0));
        await writeReport(io, options.reportPath, report);
        return report;
    }

    // 预览帧池保留入口：调用方只给数据目录，池口径（previewFrameTargets）与张数
    // （AE_PREVIEW_KEEP）由本模块定——各调用点各写一份必然漂移。
    function retainPreviewFrames(base, options) {
        var o = {};
        if (options) {
            for (var k in options) {
                if (Object.prototype.hasOwnProperty.call(options, k)) o[k] = options[k];
            }
        }
        o.targets = previewFrameTargets(base);
        if (typeof o.keep !== 'number') o.keep = AE_PREVIEW_KEEP;
        return retainNewest(o);
    }

    /**
     * 体积预算执行器：把一组目标的**合计**体积压到 maxBytes 之下（最旧优先删）。
     *
     * 与 sweep 的分工：sweep 按「多久没动」回收，本函数按「总共占多少」兜底。
     * 目标异构（各目标文件名模式不同），一次调用覆盖全部目标 —— 预算才是合计语义，
     * 逐目标各算一份会得到 N×maxBytes。
     *
     * 保护口径与 sweep 完全一致（不许在这里放宽）：
     *   · refs 命中（被会话历史引用）不删 —— 删了历史里的图就成死链；
     *   · 拿不到年龄（mtimeMs<=0）不删 —— 「未知 → 保护跳过」，不当 0 岁处理；
     *   · 拿不到体积整轮跳过 —— 不按「0 字节」累加，否则整棵树会被误判超限并开删。
     *
     * @param {object} options
     *   targets      — [{ dir, match }]（match 为该目标的文件名正则，省略=全收）
     *   maxBytes     — 合计上限（默认 DEFAULT_MAX_BYTES）
     *   refs         — { 文件名: true }：被会话历史引用者不删
     *   now / io / reportPath — 同 sweep；io 需 listFilesWithSize(dir)→[{name,size,mtimeMs}]|null
     *   dryRun       — 只算不删（调用方据此决定是否收集引用——引用收集要遍历全部会话，很贵）
     * @returns {Promise<object>} 报告（含 ok / totalBytes / over / removed / freedBytes / keptRef / noAge / unavailable）
     */
    // 报告收口：ok 口径与 sweep 一致（有失败/有错误即 false，且「体积通道不可用」也算 false
    // ——那意味着当前轮没做任何判定，报告读起来不能像「干净跑完」）
    async function _finishBudgetReport(report, io, reportPath) {
        report.ok = !(report.failed > 0 || report.unavailable || (report.errors && report.errors.length > 0));
        await writeReport(io, reportPath, report);
        return report;
    }

    async function enforceBudget(options) {
        options = options || {};
        var io = options.io || defaultIo();
        var targets = Array.isArray(options.targets) ? options.targets : [];
        var now = (typeof options.now === 'number') ? options.now : Date.now();
        var maxBytes = (typeof options.maxBytes === 'number' && options.maxBytes > 0) ? options.maxBytes : DEFAULT_MAX_BYTES;
        var refs = options.refs || null;
        var report = {
            at: new Date(now).toISOString(),
            dryRun: !!options.dryRun,
            maxBytes: maxBytes,
            totalBytes: 0,
            totalBytesAfter: 0,
            over: false,
            removed: 0,
            freedBytes: 0,
            keptRef: 0,
            noAge: 0,
            failed: 0,
            unavailable: false,
            errors: [],
            dirs: []
        };        // 体积通道缺失（旧 AEFS / 测试 mock）→ 整轮跳过：宁可不清，不可按未知体积误删
        if (!io || typeof io.listFilesWithSize !== 'function') {
            report.unavailable = true;
            return await _finishBudgetReport(report, io, options.reportPath);
        }

        var entries = [];   // { dir, name, size, mtimeMs }
        var measuredTargets = 0;   // 真列出体积的目标数（区分「一个都没测到」与「测了但为空」）
        for (var i = 0; i < targets.length; i++) {
            var target = targets[i] || {};
            var dir = target.dir;
            if (!dir) continue;
            var re = target.match || null;
            if (re && re.global) re = new RegExp(re.source, re.ignoreCase ? 'i' : '');
            var listed = null;
            try { listed = await io.listFilesWithSize(dir); } catch (e) {
                if (report.errors.length < MAX_ERRORS) report.errors.push('listFilesWithSize ' + dir + ': ' + e);
                listed = null;
            }
            // 拿不到该目录的体积（目录不存在/通道失败）→ 该目标当前轮跳过，不计入总量也不报错终止
            if (!Array.isArray(listed)) {
                report.dirs.push({ dir: dir, unavailable: true, scanned: 0, matched: 0, bytes: 0 });
                continue;
            }
            var seg = { dir: dir, unavailable: false, scanned: listed.length, matched: 0, bytes: 0 };
            measuredTargets++;
            for (var k = 0; k < listed.length; k++) {
                var e = listed[k] || {};
                var name = e.name;
                if (typeof name !== 'string' || !name) continue;
                if (re && !re.test(name)) continue;
                var size = (typeof e.size === 'number' && e.size > 0) ? e.size : 0;
                var mtimeMs = (typeof e.mtimeMs === 'number' && e.mtimeMs > 0) ? e.mtimeMs : 0;
                seg.matched++;
                seg.bytes += size;
                entries.push({ dir: dir, name: name, size: size, mtimeMs: mtimeMs });
            }
            report.totalBytes += seg.bytes;
            report.dirs.push(seg);
        }
        report.totalBytesAfter = report.totalBytes;
        // 一个目标都没测到（目录都不存在或通道全失败）→ 当前轮无可判定，标注出来
        //（区别于「测了但为空」：后者是合法空态，不该被当成通道故障）
        if (targets.length > 0 && measuredTargets === 0) report.unavailable = true;
        if (report.totalBytes <= maxBytes) {
            return await _finishBudgetReport(report, io, options.reportPath);
        }
        report.over = true;

        // 可删集合：refs 豁免 + 无年龄保护；其余按最旧优先（跨目标统一排序）
        var deletable = [];
        for (var d = 0; d < entries.length; d++) {
            var it = entries[d];
            if (refs && refs[it.name]) { report.keptRef++; continue; }
            if (!it.mtimeMs) { report.noAge++; continue; }
            deletable.push(it);
        }
        deletable.sort(function (a, b) { return a.mtimeMs - b.mtimeMs; });
        if (options.dryRun) {
            report.candidates = deletable.length;
            report.candidatesSample = deletable.slice(0, MAX_ERRORS).map(function (x) { return x.name; });
            return await _finishBudgetReport(report, io, options.reportPath);
        }

        var total = report.totalBytes;
        for (var r = 0; r < deletable.length; r++) {
            if (total <= maxBytes) break;
            var it2 = deletable[r];
            var ok = false;
            try {
                ok = (typeof io.deleteFile === 'function') ? await io.deleteFile(it2.dir + '\\' + it2.name) : false;
            } catch (e2) {
                if (report.errors.length < MAX_ERRORS) report.errors.push('delete ' + it2.name + ': ' + e2);
                ok = false;
            }
            if (ok === false) { report.failed++; continue; }
            total -= it2.size;
            report.removed++;
            report.freedBytes += it2.size;
        }
        report.totalBytesAfter = total;
        return await _finishBudgetReport(report, io, options.reportPath);
    }

    /**
     * 体积预算的目标清单（单一真相源）。调用方只传数据目录与 MCP 服务器目录，不许自己手抄一份
     * ——手抄版与龄清扫的目录集合会漂移（如 ae_preview 在龄清扫里有主目录与回退目录两个，
     * 手抄的预算清单只列了主目录，回退目录里的预览帧能绕过上限无限增长）。
     *
     * 与龄清扫的目录集合逐目标对齐：
     *   · chat_img：temp/agent + 旧目录 agent/temp（历史遗留，仅清不写）
     *   · ae_preview：temp/ae-tools 主目录 + **temp 根回退目录**（AE 侧建不出主目录时
     *     getPreviewFrame 写这里，见 aeTools.jsx 三级候选）
     *   · ae_preview（ComfyUI 抓帧）：temp/ae-preview（captureCurrentFrame 的临时帧，
     *     与上面同命名模式；龄清扫 24h 由 comfyui bootstrap 按 aePreviewTarget 驱动）
     *   · tc_*.webm：temp/transcoded
     *   · MCP 产物：temp/mcp/<serverId> 逐个（服务器自定文件名 → 通吃正则）
     * 刻意不含 temp 下的 logs/bridge/handoff/bg-overlay：那不是缓存，被预算挤掉等于丢用户数据。
     * @param {string} base — 数据目录（尾反斜杠自动归一）
     * @param {string[]} mcpDirs — MCP 服务器输出目录（可空/null）
     * @returns {Array<{dir:string, match:RegExp}>}
     */
    function budgetTargets(base, mcpDirs) {
        var b = String(base || '').replace(/\\+$/, '');
        // ae_preview 的两个目录（主 + 回退）取自 previewFrameTargets——保留池与龄清扫共用同一
        // 构造口径，防「改了一处漏一处」
        var out = [
            { dir: b + '\\temp\\agent', match: /^chat_img_/i },
            { dir: b + '\\agent\\temp', match: /^chat_img_/i }
        ].concat(previewFrameTargets(b), [
            { dir: b + '\\temp\\ae-preview', match: AE_PREVIEW_MATCH },
            { dir: b + '\\temp\\transcoded', match: /^tc_.*\.webm$/i },
            { dir: b + '\\temp\\docx-images', match: /^[0-9a-f]{40}\.(png|jpg)(\.part)?$/i },
            // ComfyUI 出图：计入合计预算与龄清扫目标，因为
            // 只靠 comfyui 自己的「50 文件 + 48h 豁免」滚动裁剪——实测每张 ≈1MB（真机该目录 2 文件
            // 2.06MB），48h 内产出量无兜底，且 dryRun 预算统计不到它。
            { dir: b + '\\temp\\comfyui-output', match: /^ComfyUI_/i }
        ]);
        var list = Array.isArray(mcpDirs) ? mcpDirs : [];
        for (var i = 0; i < list.length; i++) {
            if (typeof list[i] === 'string' && list[i]) out.push({ dir: list[i], match: /./ });
        }
        return out;
    }

    global.AETempSweep = {
        stampFromName: stampFromName,
        plan: plan,
        planRetain: planRetain,
        sweep: sweep,
        retainNewest: retainNewest,
        retainPreviewFrames: retainPreviewFrames,
        previewFrameTargets: previewFrameTargets,
        enforceBudget: enforceBudget,
        budgetTargets: budgetTargets,
        aePreviewTarget: aePreviewTarget,
        AE_PREVIEW_MATCH: AE_PREVIEW_MATCH,
        AE_PREVIEW_KEEP: AE_PREVIEW_KEEP,
        AE_PREVIEW_MAX_AGE_MS: AE_PREVIEW_MAX_AGE_MS,
        MIN_AGE_MS: MIN_AGE_MS,
        DEFAULT_MAX_BYTES: DEFAULT_MAX_BYTES
    };
})(window);
